//! Unlock the daemon's computer credentials without Electron, the way `apps/desktop/electron/computer-unlock.cjs`
//! does. Electron seals the vault's master key with `safeStorage` in `<data dir>/computer-vault-key.json`; on macOS
//! that is Chromium's "v10" format: AES-128-CBC, key PBKDF2-HMAC-SHA1(password, "saltysalt", 1003 rounds, 16 bytes),
//! IV of 16 spaces, where the password is the login Keychain item "Milagre Safe Storage" / "Milagre Key". Reading it
//! from another app shows the macOS Keychain prompt once ("Always Allow" is tied to the app's signature).
//!
//! Keys are only ever held in memory and sent to the daemon with `computers:unlock`. Nothing is logged, printed or
//! written, and a missing wrapper for an existing vault is never replaced with a new key.
use crate::installed_owner::failure;
use crate::{Client, Error, InstalledProject, Result};
use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use std::os::unix::fs::MetadataExt;
use std::path::Path;

type Decryptor = cbc::Decryptor<aes::Aes128>;

const KEYCHAIN_SERVICE: &str = "Milagre Safe Storage";
const KEYCHAIN_ACCOUNT: &str = "Milagre Key";

/// What [`InstalledProject::unlock_computers`] found or did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ComputerUnlock {
    /// Already unlocked (by Electron or an earlier call), or the daemon uses a configured key file.
    AlreadyUnlocked,
    /// Unlocked with Electron's sealed key, plus `imported` pre-vault pairings when the daemon asked for them.
    Unlocked { imported: bool },
    /// No vault and no key existed (a computer without Milagre.app): a new key was made the way Electron makes it,
    /// sealed in Electron's format under the same Keychain item, and the vault unlocked with it.
    Created,
}

impl InstalledProject {
    /// `computers:vault-status`: `{unlocked, configuredFile, hasVault, needsLegacyImport}`.
    pub async fn computers_vault_status(&self, client: &Client) -> Result<Value> {
        if !client.bound_to(&self.authority) {
            return Err(Error::InvalidScope);
        }
        client.read("computers:vault-status", json!([])).await
    }

    /// Unlock the computer vault with Electron's safeStorage key from the login Keychain. Call at launch and after a
    /// re-adoption, before showing computers or calling `computers:add`. May show the macOS Keychain prompt. With no
    /// vault and no key yet, creates both as Electron would (Keychain item included), so Milagre.app installed later
    /// reads the same key.
    /// Refused for any other data directory than the installed profile (`~/Library/Application Support/Milagre`):
    /// the login Keychain item belongs to that profile, and a throwaway or test profile must never read it or seal
    /// keys with it.
    pub async fn unlock_computers(&self, client: &Client) -> Result<ComputerUnlock> {
        let installed = std::env::var_os("HOME")
            .map(|home| std::path::PathBuf::from(home).join("Library/Application Support/Milagre"))
            .and_then(|path| std::fs::canonicalize(path).ok());
        if installed.as_deref() != Some(self.data_dir.as_path()) {
            return Err(failure(
                "KEYCHAIN_OTHER_PROFILE",
                "The Keychain key belongs to the installed Milagre profile; this daemon uses another data directory.",
            ));
        }
        self.unlock_with(client, keychain_password).await
    }

    /// The same flow with a stand-in for the Keychain password, for throwaway and test profiles: nothing reads or
    /// creates a Keychain item. A key sealed with a stand-in only opens with that stand-in.
    pub async fn unlock_computers_with_stand_in(
        &self,
        client: &Client,
        password: &[u8],
    ) -> Result<ComputerUnlock> {
        let password = password.to_vec();
        self.unlock_with(client, move |_| Ok(password.clone()))
            .await
    }

    pub(crate) async fn unlock_with(
        &self,
        client: &Client,
        // `true` when the Keychain item may be created (a first key on this computer).
        password: impl Fn(bool) -> Result<Vec<u8>> + Send + Sync,
    ) -> Result<ComputerUnlock> {
        let status = self.computers_vault_status(client).await?;
        let mut outcome = ComputerUnlock::AlreadyUnlocked;
        if status["configuredFile"] != true && status["unlocked"] != true {
            let file = self.data_dir.join("computer-vault-key.json");
            let existing = private_json(&file)?;
            if existing.is_none() && status["hasVault"] == true {
                // Never replace a missing wrapper for an existing vault with a different key.
                return Err(failure(
                    "VAULT_KEY_MISSING",
                    "The desktop key for existing computer credentials is missing.",
                ));
            }
            let pw = password(existing.is_none())?;
            let saved = match existing {
                Some(saved) => saved,
                None => {
                    outcome = ComputerUnlock::Created;
                    create_sealed_key(&file, &pw)?
                }
            };
            if saved["v"] != 1 || !saved["sealed"].is_string() {
                return Err(failure(
                    "VAULT_KEY_DAMAGED",
                    "The desktop computer key is damaged.",
                ));
            }
            let key = open_v10(&pw, saved["sealed"].as_str().unwrap_or_default())?;
            let key = String::from_utf8(key).map_err(|_| {
                failure("VAULT_KEY_DAMAGED", "The desktop computer key is damaged.")
            })?;
            client
                .read("computers:unlock", json!([{"key": key}]))
                .await?;
            if outcome != ComputerUnlock::Created {
                outcome = ComputerUnlock::Unlocked { imported: false };
            }
        }
        if status["needsLegacyImport"] == true {
            let saved =
                private_json(&self.data_dir.join("computer-keys.json"))?.ok_or_else(|| {
                    failure(
                        "LEGACY_KEYS_MISSING",
                        "The earlier computer pairings file is missing.",
                    )
                })?;
            let value = open_v10(
                &password(false)?,
                saved["sealed"].as_str().unwrap_or_default(),
            )?;
            let value: Value = serde_json::from_slice(&value).map_err(|_| {
                failure(
                    "LEGACY_KEYS_DAMAGED",
                    "The earlier computer pairings are damaged.",
                )
            })?;
            if let Err(error) = client.read("computers:import-keys", json!([value])).await {
                if self.computers_vault_status(client).await?["hasVault"] != true {
                    return Err(error);
                }
            }
            outcome = ComputerUnlock::Unlocked { imported: true };
        }
        Ok(outcome)
    }
}

/// The login Keychain password Electron's safeStorage uses for this app. With `create`, a missing item is made as
/// Chromium makes it (16 random bytes, base64), so Electron reuses it if Milagre.app is installed later.
pub(crate) fn keychain_password(create: bool) -> Result<Vec<u8>> {
    use security_framework::passwords::{get_generic_password, set_generic_password};
    let unavailable = || {
        failure(
            "KEYCHAIN_UNAVAILABLE",
            "Allow access to the \"Milagre Safe Storage\" Keychain item to use your paired computers.",
        )
    };
    match get_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
        Ok(password) => Ok(password),
        // errSecItemNotFound: this computer never had Milagre.app's safeStorage key.
        Err(error) if create && error.code() == -25300 => {
            let password = STANDARD.encode(random::<16>()?).into_bytes();
            set_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, &password)
                .map_err(|_| unavailable())?;
            Ok(password)
        }
        Err(_) => Err(unavailable()),
    }
}

fn random<const N: usize>() -> Result<[u8; N]> {
    let mut bytes = [0u8; N];
    if unsafe { libc::getentropy(bytes.as_mut_ptr().cast(), N) } != 0 {
        return Err(failure(
            "RANDOM_UNAVAILABLE",
            "Could not read secure random bytes",
        ));
    }
    Ok(bytes)
}

/// A new 32-byte vault key, base64 and sealed in Electron's format, written exclusively with mode 0600. Another
/// writer that won the race keeps its key: read that one instead (computer-unlock.cjs does the same).
fn create_sealed_key(file: &Path, password: &[u8]) -> Result<Value> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let key = STANDARD.encode(random::<32>()?);
    let saved = json!({"v": 1, "sealed": seal_v10(password, key.as_bytes())});
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(file)
    {
        Ok(mut out) => {
            out.write_all(saved.to_string().as_bytes())
                .and_then(|()| out.sync_all())
                .map_err(|_| failure("UNSAFE_KEY_FILE", "Could not write the computer key file"))?;
            Ok(saved)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => private_json(file)?
            .ok_or_else(|| failure("UNSAFE_KEY_FILE", "Could not read the computer key file")),
        Err(_) => Err(failure(
            "UNSAFE_KEY_FILE",
            "Could not write the computer key file",
        )),
    }
}

/// A private JSON file of the frontend's (`assertPrivate` in private-files.cjs): a regular file, not a link, owned by
/// this user, mode 0600. `None` when absent.
pub(crate) fn private_json(path: &Path) -> Result<Option<Value>> {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err(failure(
                "UNSAFE_KEY_FILE",
                "Could not read the computer key file",
            ))
        }
    };
    if !meta.is_file()
        || meta.uid() != unsafe { libc::getuid() }
        || meta.mode() & 0o077 != 0
        || meta.len() > 64 * 1024
    {
        return Err(failure(
            "UNSAFE_KEY_FILE",
            "The computer key file must be a private file of yours",
        ));
    }
    let text = std::fs::read(path)
        .map_err(|_| failure("UNSAFE_KEY_FILE", "Could not read the computer key file"))?;
    serde_json::from_slice(&text)
        .map(Some)
        .map_err(|_| failure("VAULT_KEY_DAMAGED", "The desktop computer key is damaged."))
}

fn derive(password: &[u8]) -> [u8; 16] {
    let mut key = [0u8; 16];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password, b"saltysalt", 1003, &mut key);
    key
}

/// Chromium safeStorage "v10" on macOS: base64 of `v10 || AES-128-CBC(PKCS7)`.
pub(crate) fn open_v10(password: &[u8], sealed_base64: &str) -> Result<Vec<u8>> {
    let damaged = || failure("VAULT_KEY_DAMAGED", "The desktop computer key is damaged.");
    let sealed = STANDARD.decode(sealed_base64).map_err(|_| damaged())?;
    let body = sealed.strip_prefix(b"v10").ok_or_else(damaged)?;
    Decryptor::new(&derive(password).into(), &[b' '; 16].into())
        .decrypt_padded_vec_mut::<Pkcs7>(body)
        .map_err(|_| damaged())
}

pub(crate) fn seal_v10(password: &[u8], plain: &[u8]) -> String {
    use aes::cipher::BlockEncryptMut;
    let body = cbc::Encryptor::<aes::Aes128>::new(&derive(password).into(), &[b' '; 16].into())
        .encrypt_padded_vec_mut::<Pkcs7>(plain);
    STANDARD.encode([b"v10".as_slice(), &body].concat())
}

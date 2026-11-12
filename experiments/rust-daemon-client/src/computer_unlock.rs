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
    /// No vault and no key yet: nothing to unlock until a first pairing. Electron creates the key then.
    NoVault,
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
    /// re-adoption, before showing computers or calling `computers:add`. May show the macOS Keychain prompt.
    pub async fn unlock_computers(&self, client: &Client) -> Result<ComputerUnlock> {
        self.unlock_with(client, keychain_password).await
    }

    pub(crate) async fn unlock_with(
        &self,
        client: &Client,
        password: impl Fn() -> Result<Vec<u8>> + Send + Sync,
    ) -> Result<ComputerUnlock> {
        let status = self.computers_vault_status(client).await?;
        let mut outcome = ComputerUnlock::AlreadyUnlocked;
        if status["configuredFile"] != true && status["unlocked"] != true {
            let Some(saved) = private_json(&self.data_dir.join("computer-vault-key.json"))? else {
                if status["hasVault"] == true {
                    return Err(failure(
                        "VAULT_KEY_MISSING",
                        "The desktop key for existing computer credentials is missing.",
                    ));
                }
                return Ok(ComputerUnlock::NoVault);
            };
            if saved["v"] != 1 || !saved["sealed"].is_string() {
                return Err(failure(
                    "VAULT_KEY_DAMAGED",
                    "The desktop computer key is damaged.",
                ));
            }
            let key = open_v10(&password()?, saved["sealed"].as_str().unwrap_or_default())?;
            let key = String::from_utf8(key).map_err(|_| {
                failure("VAULT_KEY_DAMAGED", "The desktop computer key is damaged.")
            })?;
            client
                .read("computers:unlock", json!([{"key": key}]))
                .await?;
            outcome = ComputerUnlock::Unlocked { imported: false };
        }
        if status["needsLegacyImport"] == true {
            let saved =
                private_json(&self.data_dir.join("computer-keys.json"))?.ok_or_else(|| {
                    failure(
                        "LEGACY_KEYS_MISSING",
                        "The earlier computer pairings file is missing.",
                    )
                })?;
            let value = open_v10(&password()?, saved["sealed"].as_str().unwrap_or_default())?;
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

/// The login Keychain password Electron's safeStorage uses for this app.
pub(crate) fn keychain_password() -> Result<Vec<u8>> {
    security_framework::passwords::get_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).map_err(|_| {
        failure(
            "KEYCHAIN_UNAVAILABLE",
            "Allow access to the \"Milagre Safe Storage\" Keychain item to use your paired computers.",
        )
    })
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

#[cfg(test)]
pub(crate) fn seal_v10(password: &[u8], plain: &[u8]) -> String {
    use aes::cipher::BlockEncryptMut;
    let body = cbc::Encryptor::<aes::Aes128>::new(&derive(password).into(), &[b' '; 16].into())
        .encrypt_padded_vec_mut::<Pkcs7>(plain);
    STANDARD.encode([b"v10".as_slice(), &body].concat())
}

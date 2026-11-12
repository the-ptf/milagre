use super::*;
use crate::computer_unlock::{open_v10, seal_v10};
use crate::ComputerUnlock;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

const PASSWORD: &[u8] = b"test-password";

#[test]
fn v10_matches_an_independent_openssl_vector() {
    // printf 'secret vault key 32 bytes base64' | openssl enc -aes-128-cbc -K <pbkdf2-sha1(test-password, saltysalt,
    // 1003, 16)> -iv 20202020202020202020202020202020, with "v10" prepended, base64.
    let sealed = "djEwAua5e+/51e5h5T++qfOrUpMSoknTehAacTUjLp5gKAjJ+COfyX9QZB0N+lE5kHjF";
    assert_eq!(
        open_v10(PASSWORD, sealed).unwrap(),
        b"secret vault key 32 bytes base64"
    );
    assert_eq!(
        open_v10(PASSWORD, &seal_v10(PASSWORD, b"round trip")).unwrap(),
        b"round trip"
    );
    for bad in [
        open_v10(b"wrong", sealed),
        open_v10(PASSWORD, "dGVzdA=="),
        open_v10(PASSWORD, "%%%"),
    ] {
        assert!(matches!(
            bad,
            Err(Error::Launch {
                code: "VAULT_KEY_DAMAGED",
                ..
            })
        ));
    }
}

fn project_in(dir: &Path) -> (crate::InstalledProject, Peer) {
    let (client, server) = UnixStream::pair().unwrap();
    let connection = Mutex::new(Some(client));
    let project = crate::InstalledProject::for_test_in(
        Arc::new(Authority {
            launcher: None,
            project: PROJECT.into(),
            pid: PID,
            connect: Box::new(move || connection.lock().unwrap().take().ok_or(Error::Disconnected)),
        }),
        dir,
    );
    (project, Peer::new(server))
}
fn handshake(peer: &mut Peer) {
    let request = peer.request("daemon:status");
    let mut status = status();
    let methods = status["methods"].as_array_mut().unwrap();
    for method in [
        "computers:vault-status",
        "computers:unlock",
        "computers:import-keys",
    ] {
        methods.push(json!(method));
    }
    peer.reply(&request, status);
}
fn write_private(path: &Path, value: Value, mode: u32) {
    std::fs::write(path, value.to_string()).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
}
fn run(dir: &Path, script: impl FnOnce(&mut Peer) + Send + 'static) -> Result<ComputerUnlock> {
    let (project, mut peer) = project_in(dir);
    let worker = thread::spawn(move || {
        handshake(&mut peer);
        script(&mut peer);
        peer.closed();
    });
    let (client, _, _) = block_on(project.connect(ClientOptions::default())).unwrap();
    let result = block_on(project.unlock_with(&client, || Ok(PASSWORD.to_vec())));
    client.disconnect();
    worker.join().unwrap();
    result
}
fn vault(peer: &mut Peer, status: Value) {
    let request = peer.request("computers:vault-status");
    peer.reply(&request, status);
}

#[test]
fn a_locked_vault_is_unlocked_with_electrons_sealed_key() {
    let dir = tempfile::tempdir().unwrap();
    write_private(
        &dir.path().join("computer-vault-key.json"),
        json!({"v":1,"sealed":seal_v10(PASSWORD, b"master-key-base64")}),
        0o600,
    );
    let outcome = run(dir.path(), |peer| {
        vault(
            peer,
            json!({"unlocked":false,"configuredFile":false,"hasVault":true,"needsLegacyImport":false}),
        );
        let unlock = peer.request("computers:unlock");
        assert_eq!(unlock["args"], json!([{"key":"master-key-base64"}]));
        peer.reply(&unlock, Value::Null);
    });
    assert_eq!(
        outcome.unwrap(),
        ComputerUnlock::Unlocked { imported: false }
    );
}

#[test]
fn an_unlocked_or_file_keyed_vault_is_left_alone() {
    let dir = tempfile::tempdir().unwrap();
    for status in [
        json!({"unlocked":true,"configuredFile":false,"hasVault":true,"needsLegacyImport":false}),
        json!({"unlocked":false,"configuredFile":true,"hasVault":true,"needsLegacyImport":false}),
    ] {
        let outcome = run(dir.path(), move |peer| vault(peer, status));
        assert_eq!(outcome.unwrap(), ComputerUnlock::AlreadyUnlocked);
    }
}

#[test]
fn a_missing_wrapper_is_never_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let outcome = run(dir.path(), |peer| {
        vault(
            peer,
            json!({"unlocked":false,"configuredFile":false,"hasVault":true,"needsLegacyImport":false}),
        )
    });
    assert!(matches!(
        outcome,
        Err(Error::Launch {
            code: "VAULT_KEY_MISSING",
            ..
        })
    ));
    assert!(
        !dir.path().join("computer-vault-key.json").exists(),
        "no new key is written"
    );
    let outcome = run(dir.path(), |peer| {
        vault(
            peer,
            json!({"unlocked":false,"configuredFile":false,"hasVault":false,"needsLegacyImport":false}),
        )
    });
    assert_eq!(outcome.unwrap(), ComputerUnlock::NoVault);
}

#[test]
fn a_key_file_others_can_read_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    write_private(
        &dir.path().join("computer-vault-key.json"),
        json!({"v":1,"sealed":seal_v10(PASSWORD, b"k")}),
        0o644,
    );
    let outcome = run(dir.path(), |peer| {
        vault(
            peer,
            json!({"unlocked":false,"configuredFile":false,"hasVault":true,"needsLegacyImport":false}),
        )
    });
    assert!(matches!(
        outcome,
        Err(Error::Launch {
            code: "UNSAFE_KEY_FILE",
            ..
        })
    ));
}

#[test]
fn earlier_pairings_are_imported_when_the_daemon_asks() {
    let dir = tempfile::tempdir().unwrap();
    write_private(
        &dir.path().join("computer-vault-key.json"),
        json!({"v":1,"sealed":seal_v10(PASSWORD, b"k")}),
        0o600,
    );
    write_private(
        &dir.path().join("computer-keys.json"),
        json!({"sealed":seal_v10(PASSWORD, br#"{"studio":{"secret":"s"}}"#)}),
        0o600,
    );
    let outcome = run(dir.path(), |peer| {
        vault(
            peer,
            json!({"unlocked":false,"configuredFile":false,"hasVault":true,"needsLegacyImport":true}),
        );
        let unlock = peer.request("computers:unlock");
        peer.reply(&unlock, Value::Null);
        let import = peer.request("computers:import-keys");
        assert_eq!(import["args"], json!([{"studio":{"secret":"s"}}]));
        peer.reply(&import, Value::Null);
    });
    assert_eq!(
        outcome.unwrap(),
        ComputerUnlock::Unlocked { imported: true }
    );
}

/// Live, read-only, by hand: opens the installed Milagre's sealed vault key with the real login Keychain item and
/// checks it is a 32-byte key. Shows the macOS Keychain prompt; answer "Allow". Sends nothing, prints no secret.
/// `cargo test --features installed-owner real_keychain -- --ignored --nocapture`
#[test]
#[ignore]
fn real_keychain_opens_the_installed_vault_key() {
    use base64::Engine as _;
    let home = std::env::var_os("HOME").unwrap();
    let file = Path::new(&home).join("Library/Application Support/Milagre/computer-vault-key.json");
    let saved = crate::computer_unlock::private_json(&file)
        .unwrap()
        .expect("vault key file");
    let password = crate::computer_unlock::keychain_password().expect("Keychain access");
    let key = open_v10(&password, saved["sealed"].as_str().unwrap()).expect("decrypts");
    let raw = base64::engine::general_purpose::STANDARD
        .decode(&key)
        .expect("base64 key");
    assert_eq!(raw.len(), 32);
    println!("real Keychain item opened the installed vault key: 32-byte key, not printed");
}

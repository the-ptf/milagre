#![cfg(unix)]
use milagre_accounts::{AccountSandbox, AccountService, Availability, IdentityState, Readiness};
use serde_json::json;
use std::{
    fs,
    os::{
        fd::AsRawFd,
        unix::fs::{symlink, MetadataExt, PermissionsExt},
    },
    path::PathBuf,
};
const ID: &str = "11111111-1111-4111-8111-111111111111";
fn seed() -> String {
    json!({"accounts":[{"id":ID,"provider":"codex","label":"Saved"}],"selected":{},"scopes":{"/project":{"codex":ID}}}).to_string()
}
struct Copy(AccountSandbox);
impl Copy {
    fn new() -> Self {
        Self(AccountSandbox::create(Some(&seed())).unwrap())
    }
    fn file(&self) -> PathBuf {
        self.0.path().join("accounts/accounts.json")
    }
}
impl Drop for Copy {
    fn drop(&mut self) {
        fs::remove_dir_all(self.0.path()).unwrap();
    }
}
fn ready(service: &mut AccountService, provider: &str, id: &str) -> Readiness {
    let request = service.begin_observation(provider, id).unwrap();
    service.observed(request, IdentityState::Ready).unwrap()
}
#[test]
fn writer_lock_is_exclusive_and_close_releases_it_despite_retained_capabilities() {
    let copy = Copy::new();
    let capability = copy.0.clone();
    let mut first = copy.0.open().unwrap();
    let late = first.begin_observation("codex", ID).unwrap();
    let proof = ready(&mut first, "codex", ID);
    let pin = first.pin(Some("/project")).unwrap();
    assert!(capability.open().is_err());
    let second_cap = capability.clone();
    assert!(std::thread::spawn(move || second_cap.open().is_err())
        .join()
        .unwrap());
    first.close();
    let mut second = capability.open().unwrap();
    assert!(first.observed(late, IdentityState::Ready).is_err());
    assert!(second.select("codex", ID, proof).is_err());
    assert_eq!(pin.account_id("codex").unwrap(), ID);
    drop(second);
    drop(first);
    assert!(capability.open().is_ok());
}
#[test]
fn replacing_lock_file_cannot_admit_a_second_writer_or_authorize_the_old_writer() {
    let copy = Copy::new();
    let mut owner = copy.0.open().unwrap();
    let before = fs::read(copy.file()).unwrap();
    let lock = copy.0.path().join("accounts/.metadata-writer.lock");
    let old = lock.with_extension("held");
    fs::rename(&lock, &old).unwrap();
    fs::write(&lock, b"").unwrap();
    fs::set_permissions(&lock, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(copy.0.open().is_err());
    assert!(owner
        .create("claude", "No write", Availability::Installed)
        .is_err());
    assert_eq!(fs::read(copy.file()).unwrap(), before);
    fs::remove_file(&lock).unwrap();
    fs::rename(&old, &lock).unwrap();
    owner
        .create("claude", "Recovered", Availability::Installed)
        .unwrap();
}
#[test]
fn readiness_is_account_owner_generation_and_inspection_specific() {
    let copy = Copy::new();
    let mut owner = copy.0.open().unwrap();
    let wrong = ready(&mut owner, "claude", "default");
    assert!(owner.select("codex", ID, wrong).is_err());
    let old = ready(&mut owner, "codex", ID);
    let later = owner.begin_observation("codex", ID).unwrap();
    assert!(owner.select("codex", ID, old).is_err());
    let old_request = owner.begin_observation("codex", ID).unwrap();
    assert!(owner.observed(later, IdentityState::Ready).is_err());
    let old = owner.observed(old_request, IdentityState::Ready).unwrap();
    owner.assign("/empty", "claude", None, None).unwrap();
    assert!(owner.select("codex", ID, old).is_err());
    let pending = owner.begin_observation("codex", ID).unwrap();
    owner.remove("codex", ID).unwrap();
    assert!(owner.observed(pending, IdentityState::Ready).is_err());
    assert_eq!(
        owner
            .accounts()
            .unwrap()
            .selected("codex", Some("/project"))
            .unwrap(),
        ID
    );
    assert_eq!(
        owner.scope_snapshot("/project").unwrap()["providers"][0]["accounts"][1]["missing"],
        true
    );
}
#[test]
fn unready_and_signing_in_accounts_cannot_be_selected_or_assigned() {
    let copy = Copy::new();
    let mut owner = copy.0.open().unwrap();
    let before = fs::read(copy.file()).unwrap();
    for state in [
        IdentityState::Unknown,
        IdentityState::SignedOut,
        IdentityState::Error,
        IdentityState::SigningIn,
    ] {
        let request = owner.begin_observation("codex", ID).unwrap();
        let proof = owner.observed(request, state).unwrap();
        let error = owner.select("codex", ID, proof).unwrap_err().to_string();
        assert_eq!(
            error,
            if state == IdentityState::SigningIn {
                "Finish signing in before using this account."
            } else {
                "Sign in to this account, then refresh before using it."
            }
        );
    }
    assert_eq!(
        owner
            .create("claude", "New", Availability::Installed)
            .unwrap_err()
            .to_string(),
        "Finish or cancel the current sign-in first."
    );
    assert_eq!(fs::read(copy.file()).unwrap(), before);
    assert!(owner.take_events().unwrap().is_empty());
}
#[test]
fn removal_retains_profile_data_scope_pins_and_captured_selection() {
    let copy = Copy::new();
    let mut owner = copy.0.open().unwrap();
    assert!(owner.pin(Some("")).is_err());
    let pinned = owner.pin(Some("/project")).unwrap();
    let profile = copy.0.path().join("accounts").join(ID);
    fs::create_dir(&profile).unwrap();
    let sentinel = profile.join("synthetic-profile.txt");
    fs::write(&sentinel, b"synthetic content only").unwrap();
    let proof = ready(&mut owner, "codex", ID);
    owner.select("codex", ID, proof).unwrap();
    owner.remove("codex", ID).unwrap();
    assert_eq!(fs::read(&sentinel).unwrap(), b"synthetic content only");
    assert_eq!(
        owner.accounts().unwrap().selected("codex", None).unwrap(),
        "default"
    );
    assert_eq!(pinned.account_id("codex").unwrap(), ID);
    assert!(owner.accounts().unwrap().account("codex", ID).is_err());
}
#[test]
fn external_metadata_edits_and_marker_replacement_fail_without_overwriting() {
    let copy = Copy::new();
    let mut owner = copy.0.open().unwrap();
    let original = fs::read(copy.file()).unwrap();
    let snapshot = owner.accounts().unwrap().saved().clone();
    let changed = seed().replace("Saved", "External");
    fs::write(copy.file(), changed.as_bytes()).unwrap();
    assert!(owner
        .create("claude", "No", Availability::Installed)
        .is_err());
    assert_eq!(fs::read(copy.file()).unwrap(), changed.as_bytes());
    assert!(owner.accounts().is_err());
    assert!(owner.snapshot().is_err());
    fs::write(copy.file(), &original).unwrap();
    assert_eq!(owner.accounts().unwrap().saved(), &snapshot);
    let marker = copy.0.path().join("MILAGRE-ACCOUNT-COPY");
    let saved = fs::read(&marker).unwrap();
    fs::write(&marker, b"synthetic-secret-marker").unwrap();
    let error = owner
        .create("claude", "No", Availability::Installed)
        .unwrap_err()
        .to_string();
    assert!(!error.contains("synthetic-secret"));
    assert_eq!(fs::read(copy.file()).unwrap(), original);
    fs::write(&marker, saved).unwrap();
}
#[test]
fn symlinks_and_hardlinks_anywhere_in_the_copy_are_refused() {
    for link in [false, true] {
        for target in [
            "accounts/accounts.json",
            "accounts/.metadata-writer.lock",
            "MILAGRE-ACCOUNT-COPY",
            "accounts/synthetic-profile",
        ] {
            let copy = Copy::new();
            let mut owner = copy.0.open().unwrap();
            let outside = tempfile::Builder::new()
                .prefix("account-sentinel-")
                .tempdir_in("/tmp")
                .unwrap();
            let sentinel = outside.path().join("sentinel");
            fs::write(&sentinel, b"untouched sentinel").unwrap();
            fs::set_permissions(&sentinel, fs::Permissions::from_mode(0o600)).unwrap();
            let destination = copy.0.path().join(target);
            let saved = fs::read(&destination).ok();
            if destination.exists() {
                fs::remove_file(&destination).unwrap();
            }
            if link {
                symlink(&sentinel, &destination).unwrap();
            } else {
                fs::hard_link(&sentinel, &destination).unwrap();
            }
            assert!(
                owner
                    .create("claude", "No", Availability::Installed)
                    .is_err(),
                "{target}"
            );
            assert_eq!(fs::read(&sentinel).unwrap(), b"untouched sentinel");
            fs::remove_file(&destination).unwrap();
            if let Some(saved) = saved {
                fs::write(&destination, saved).unwrap();
                fs::set_permissions(&destination, fs::Permissions::from_mode(0o600)).unwrap();
            }
        }
    }
}
#[test]
fn renamed_root_and_symlinked_accounts_directory_are_refused() {
    let copy = Copy::new();
    let mut owner = copy.0.open().unwrap();
    let accounts = copy.0.path().join("accounts");
    let saved = copy.0.path().join("held-accounts");
    fs::rename(&accounts, &saved).unwrap();
    symlink(&saved, &accounts).unwrap();
    assert!(owner
        .create("claude", "No", Availability::Installed)
        .is_err());
    fs::remove_file(&accounts).unwrap();
    fs::rename(&saved, &accounts).unwrap();
    let original = copy.0.path().to_owned();
    let renamed = original.with_extension("renamed");
    fs::rename(&original, &renamed).unwrap();
    symlink(&renamed, &original).unwrap();
    assert!(owner
        .create("claude", "No", Availability::Installed)
        .is_err());
    fs::remove_file(&original).unwrap();
    fs::rename(&renamed, &original).unwrap();
}
#[test]
fn atomic_replacements_are_always_complete_json_and_private() {
    let copy = Copy::new();
    let mut owner = copy.0.open().unwrap();
    let path = copy.file();
    let reading = path.clone();
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stopping = stop.clone();
    let reader = std::thread::spawn(move || {
        while !stopping.load(std::sync::atomic::Ordering::Relaxed) {
            let body = fs::read(&reading).unwrap();
            let _: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(fs::metadata(&reading).unwrap().mode() & 0o777, 0o600);
        }
    });
    for _ in 0..20 {
        let proof = ready(&mut owner, "codex", ID);
        owner.select("codex", ID, proof).unwrap();
    }
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    reader.join().unwrap();
    assert!(fs::read_dir(path.parent().unwrap()).unwrap().all(|e| !e
        .unwrap()
        .file_name()
        .to_string_lossy()
        .ends_with(".tmp")));
}
#[test]
fn lock_is_exclusive_across_processes() {
    let copy = Copy::new();
    let _owner = copy.0.open().unwrap();
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--exact", "lock_child"])
        .env_clear()
        .env("MILAGRE_ACCOUNT_LOCK_PROBE", copy.0.path())
        .status()
        .unwrap();
    assert!(status.success());
}
#[test]
#[ignore = "invoked only by lock_is_exclusive_across_processes on its synthetic copy"]
fn lock_child() {
    let path = std::env::var_os("MILAGRE_ACCOUNT_LOCK_PROBE").unwrap();
    let file = fs::File::open(path).unwrap();
    // SAFETY: valid owned descriptor with no pointers; no existing lock is released.
    assert_ne!(
        unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
        0
    );
}

#[test]
fn corrupt_reopen_releases_the_writer_and_preserves_the_corrupt_file() {
    let copy = Copy::new();
    let body = fs::read(copy.file()).unwrap();
    fs::write(copy.file(), b"{invalid").unwrap();
    assert_eq!(
        copy.0.open().unwrap_err().to_string(),
        milagre_accounts::READ_ERROR
    );
    assert_eq!(fs::read(copy.file()).unwrap(), b"{invalid");
    fs::write(copy.file(), body).unwrap();
    assert!(copy.0.open().is_ok());
}
#[test]
fn non_private_modes_and_special_files_fail_without_blocking() {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let copy = Copy::new();
    let mut service = copy.0.open().unwrap();
    let before = fs::read(copy.file()).unwrap();
    fs::set_permissions(copy.file(), fs::Permissions::from_mode(0o644)).unwrap();
    assert!(service
        .create("claude", "No", Availability::Installed)
        .is_err());
    fs::set_permissions(copy.file(), fs::Permissions::from_mode(0o600)).unwrap();
    let marker = copy.0.path().join("MILAGRE-ACCOUNT-COPY");
    let token = fs::read(&marker).unwrap();
    fs::remove_file(&marker).unwrap();
    let c = CString::new(marker.as_os_str().as_bytes()).unwrap();
    // SAFETY: c is a NUL-terminated name inside this newly created private test copy.
    assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
    let start = std::time::Instant::now();
    assert!(service
        .create("claude", "No", Availability::Installed)
        .is_err());
    assert!(start.elapsed() < std::time::Duration::from_secs(1));
    assert_eq!(fs::read(copy.file()).unwrap(), before);
    fs::remove_file(&marker).unwrap();
    fs::write(&marker, token).unwrap();
    fs::set_permissions(&marker, fs::Permissions::from_mode(0o600)).unwrap();
}

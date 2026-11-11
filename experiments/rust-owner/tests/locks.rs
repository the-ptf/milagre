//! Owner lock interoperability with the real Node ownership.cjs, and the Rust owner's refusals.

mod common;

use std::io::{BufRead, BufReader};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime};

use milagre_owner_store::isolation::{Isolation, Policy};
use milagre_owner_store::ownership::{self, RustOwnerLock};
use milagre_owner_store::write::OwnerLock;
use milagre_owner_store::{jsjson, OwnedProject, StoreError};
use serde_json::Value;

fn isolated() -> (tempfile::TempDir, Isolation, std::path::PathBuf) {
    let base = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(&base.path().join("copies"), &Policy::system()).unwrap();
    let project = isolation.project(Path::new("project")).unwrap();
    (base, isolation, project)
}

fn node_try_lock(lock: &Path) -> Value {
    jsjson::parse_bytes(&common::run_node(&["try-lock", lock.to_str().unwrap()]).stdout).unwrap()
}

fn refusal(error: StoreError) -> &'static str {
    match error {
        StoreError::LockRefused { state, .. } => state,
        other => panic!("expected a lock refusal, got {other}"),
    }
}

#[test]
fn a_rust_owner_blocks_node_and_releases_cleanly() {
    if common::node().is_none() {
        return;
    }
    let (_base, isolation, project) = isolated();
    let owner = OwnedProject::open(&isolation, &project, None).unwrap();
    let lock = ownership::project_lock(&project);
    // Node's own format: 0700 directory, 0600 owner.json written like JSON.stringify(owner, null, 2).
    assert_eq!(
        std::fs::metadata(&lock).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        std::fs::metadata(lock.join("owner.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    let record = std::fs::read_to_string(lock.join("owner.json")).unwrap();
    let parsed = jsjson::parse(&record).unwrap();
    let keys: Vec<&String> = parsed.as_object().unwrap().keys().collect();
    assert_eq!(
        keys,
        ["pid", "token", "startedAt", "processStartedAt", "host"]
    );
    assert!(record.starts_with("{\n  \"pid\": "), "{record}");
    assert_eq!(parsed["pid"], Value::from(std::process::id()));
    // Node's acquireOwnership finds this process alive, started no later than the record says: it refuses.
    let node = node_try_lock(&lock);
    assert!(
        node["error"]
            .as_str()
            .is_some_and(|error| error.contains("already owned")),
        "{node}"
    );
    assert!(
        lock.join("owner.json").exists(),
        "Node must not have taken the lock over"
    );
    // A second Rust owner refuses too.
    assert_eq!(
        refusal(
            OwnedProject::open(&isolation, &project, None)
                .err()
                .unwrap()
        ),
        "live"
    );
    owner.release().unwrap();
    assert!(!lock.exists());
    assert_eq!(node_try_lock(&lock)["ok"], Value::Bool(true));
}

#[test]
fn a_node_owner_blocks_rust() {
    if common::node().is_none() {
        return;
    }
    let (_base, isolation, project) = isolated();
    let lock = ownership::project_lock(&project);
    let mut child = Command::new("node")
        .arg(common::driver())
        .args(["hold-lock", lock.to_str().unwrap()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    assert_eq!(lines.next().unwrap().unwrap(), "held");
    assert_eq!(
        refusal(
            OwnedProject::open(&isolation, &project, None)
                .err()
                .unwrap()
        ),
        "live"
    );
    let error = Isolation::open(isolation.root(), &Policy::system())
        .unwrap_err()
        .to_string();
    assert!(error.contains("owner lock"), "{error}");
    drop(child.stdin.take());
    assert_eq!(lines.next().unwrap().unwrap(), "released");
    child.wait().unwrap();
    OwnedProject::open(&isolation, &project, None)
        .unwrap()
        .release()
        .unwrap();
}

#[test]
fn a_dead_owners_lock_is_refused_not_taken_over() {
    if common::node().is_none() {
        return;
    }
    let (_base, isolation, project) = isolated();
    let lock = ownership::project_lock(&project);
    let mut gone = Command::new("true").spawn().unwrap();
    let pid = gone.id();
    gone.wait().unwrap();
    std::fs::create_dir_all(&lock).unwrap();
    let now = ownership::iso(
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64,
    );
    let hostname = ownership::ProcessProbe::hostname(&ownership::SystemProbe);
    let record = format!(
        r#"{{"pid":{pid},"token":"t","startedAt":"{now}","processStartedAt":"{now}","host":{}}}"#,
        jsjson::to_string(&Value::String(hostname))
    );
    std::fs::write(lock.join("owner.json"), &record).unwrap();
    let error = OwnedProject::open(&isolation, &project, None)
        .err()
        .unwrap();
    assert!(
        error.to_string().contains("never takes a lock over"),
        "{error}"
    );
    assert_eq!(refusal(error), "stale");
    assert_eq!(
        std::fs::read_to_string(lock.join("owner.json")).unwrap(),
        record,
        "the lock must stay as it was"
    );
    // Node itself would take this lock over (the deviation the README documents).
    assert_eq!(node_try_lock(&lock)["ok"], Value::Bool(true));
}

#[test]
fn an_abandoned_empty_lock_is_refused() {
    let (_base, isolation, project) = isolated();
    let lock = ownership::project_lock(&project);
    std::fs::create_dir_all(&lock).unwrap();
    let old = SystemTime::now() - Duration::from_secs(120);
    std::fs::File::open(&lock)
        .unwrap()
        .set_modified(old)
        .unwrap();
    assert_eq!(
        refusal(
            OwnedProject::open(&isolation, &project, None)
                .err()
                .unwrap()
        ),
        "abandoned"
    );
    assert!(lock.is_dir());
}

#[test]
fn release_checks_the_token() {
    let base = tempfile::tempdir().unwrap();
    let root = base.path().canonicalize().unwrap();
    let lock = root.join(".milagre/runtime.lock");
    let mut guard = RustOwnerLock.acquire(&root, &lock).unwrap();
    let record = std::fs::read_to_string(lock.join("owner.json")).unwrap();
    std::fs::write(
        lock.join("owner.json"),
        record.replace(guard.token(), "someone-else"),
    )
    .unwrap();
    let error = guard.release().unwrap_err();
    assert!(matches!(error, StoreError::OwnershipChanged(_)), "{error}");
    assert!(
        lock.join("owner.json").exists(),
        "another owner's lock is never removed"
    );
    // A record already gone counts as released and leaves the empty lock for an operator.
    std::fs::remove_file(lock.join("owner.json")).unwrap();
    guard.release().unwrap();
    assert!(lock.is_dir());
}

#[test]
fn writes_outside_an_isolated_copy_are_impossible() {
    let base = tempfile::tempdir().unwrap();
    let plain = base.path().join("plain");
    std::fs::create_dir_all(plain.join("p/.milagre")).unwrap();
    assert!(Isolation::open(&plain, &Policy::system()).is_err());
    let (_other, isolation, _) = isolated();
    let error = OwnedProject::open(&isolation, &plain.join("p"), None)
        .err()
        .unwrap();
    assert!(
        error.to_string().contains("outside the isolated copy"),
        "{error}"
    );
    assert!(!plain.join("p/.milagre/runtime.lock").exists());
}

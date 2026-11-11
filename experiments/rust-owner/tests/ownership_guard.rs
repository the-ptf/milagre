//! Ownership is checked before every write: a lock released, removed or replaced by another owner stops the write,
//! surfaces as an error (never carrying a token) and leaves the Project's files exactly as they were. Disposable
//! temporary copies only.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use milagre_owner_store::isolation::{Isolation, Policy};
use milagre_owner_store::message_store::{Msg, ProjectState};
use milagre_owner_store::ownership::{self, RustOwnerLock};
use milagre_owner_store::states::{Event, ProjectStates, Timing};
use milagre_owner_store::write::{
    MessageStoreWriter, OwnerLock, ProjectStateWriter, SaveOptions, WriteOptions,
};
use milagre_owner_store::{OwnedProject, StoreError};
use serde_json::{json, Value};

/// Every file under the Project but its lock, with its bytes.
fn files(project: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut out = BTreeMap::new();
    let mut stack = vec![project.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).unwrap().flatten() {
            let path = entry.path();
            if path.ends_with(".milagre/runtime.lock") {
                continue;
            }
            if entry.file_type().unwrap().is_dir() {
                stack.push(path);
            } else {
                out.insert(path.clone(), std::fs::read(&path).unwrap());
            }
        }
    }
    out
}

fn tokens_in(lock: &Path) -> String {
    let record: Value =
        serde_json::from_slice(&std::fs::read(lock.join("owner.json")).unwrap()).unwrap();
    record["token"].as_str().unwrap().to_string()
}

fn lost(error: &StoreError, why: &str, secrets: &[&str]) {
    let text = error.to_string();
    assert!(matches!(error, StoreError::OwnershipLost { .. }), "{text}");
    assert!(
        text.contains(why) && text.contains("nothing was written"),
        "{text}"
    );
    for secret in secrets {
        assert!(!text.contains(secret), "the error shows a token: {text}");
    }
}

#[test]
fn verify_follows_the_lock_and_never_shows_its_token() {
    let base = tempfile::tempdir().unwrap();
    let root = base.path().canonicalize().unwrap();
    let lock = root.join(".milagre/runtime.lock");
    let mut guard = RustOwnerLock.acquire(&root, &lock).unwrap();
    guard.verify().unwrap();
    let token = guard.token().to_string();
    let record = std::fs::read_to_string(lock.join("owner.json")).unwrap();

    std::fs::write(
        lock.join("owner.json"),
        record.replace(&token, "another-owners-token"),
    )
    .unwrap();
    lost(
        &guard.verify().unwrap_err(),
        "replaced",
        &[&token, "another-owners-token"],
    );
    std::fs::write(
        lock.join("owner.json"),
        record.replace(&format!("\"pid\": {}", std::process::id()), "\"pid\": 1"),
    )
    .unwrap();
    lost(&guard.verify().unwrap_err(), "another process", &[&token]);
    std::fs::write(lock.join("owner.json"), &record).unwrap();
    guard.verify().unwrap();

    std::fs::remove_file(lock.join("owner.json")).unwrap();
    lost(&guard.verify().unwrap_err(), "record is gone", &[&token]);
    std::fs::remove_dir(&lock).unwrap();
    lost(&guard.verify().unwrap_err(), "lock is gone", &[&token]);
    let elsewhere = base.path().join("elsewhere");
    std::fs::create_dir(&elsewhere).unwrap();
    std::fs::write(elsewhere.join("owner.json"), &record).unwrap();
    std::os::unix::fs::symlink(&elsewhere, &lock).unwrap();
    lost(&guard.verify().unwrap_err(), "symbolic link", &[&token]);
    std::fs::remove_file(&lock).unwrap();

    std::fs::create_dir(&lock).unwrap();
    std::fs::write(lock.join("owner.json"), &record).unwrap();
    guard.release().unwrap();
    lost(&guard.verify().unwrap_err(), "released", &[&token]);
}

#[test]
fn a_lost_lock_stops_every_write() {
    let base = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(&base.path().join("copies"), &Policy::default()).unwrap();
    let mut owner = OwnedProject::open(&isolation, Path::new("project")).unwrap();
    let state = json!({ "next_id": 2, "sessions": { "1": { "id": 1 } }, "messages": [{ "id": 1, "session_id": 1, "role": "user", "body": "first" }] });
    owner
        .save_project_state(&state, &SaveOptions::default())
        .unwrap();
    owner.verify_owned().unwrap();
    let project = owner.root().to_path_buf();
    let lock = ownership::project_lock(&project);
    let token = tokens_in(&lock);
    let record = std::fs::read_to_string(lock.join("owner.json")).unwrap();
    let before = files(&project);
    let changed = json!({ "next_id": 3, "sessions": { "1": { "id": 1 } }, "messages": [
        { "id": 1, "session_id": 1, "role": "user", "body": "first" },
        { "id": 2, "session_id": 1, "role": "assistant", "body": "x".repeat(2000), "steps": [{ "id": "s", "kind": "shell", "detail": "y".repeat(3000), "status": "done" }] }
    ] });

    // Replaced by another owner: no save, no row write, no sidecar.
    std::fs::write(
        lock.join("owner.json"),
        record.replace(&token, "someone-else"),
    )
    .unwrap();
    lost(
        &owner
            .save_project_state(&changed, &SaveOptions::default())
            .unwrap_err(),
        "replaced",
        &[&token, "someone-else"],
    );
    lost(
        &owner
            .write_messages(
                &[json!({ "id": 9, "session_id": 1 })],
                None,
                &WriteOptions::default(),
            )
            .unwrap_err(),
        "replaced",
        &[&token],
    );
    lost(&owner.load().unwrap_err(), "replaced", &[&token]);
    assert_eq!(
        files(&project),
        before,
        "a write happened without ownership"
    );

    // Record removed: the same.
    std::fs::remove_file(lock.join("owner.json")).unwrap();
    lost(
        &owner
            .save_project_state(&changed, &SaveOptions::default())
            .unwrap_err(),
        "record is gone",
        &[&token],
    );
    assert_eq!(files(&project), before);

    // Ours again: the save goes through.
    std::fs::write(lock.join("owner.json"), &record).unwrap();
    owner
        .save_project_state(&changed, &SaveOptions::default())
        .unwrap();
    assert_ne!(files(&project), before);
    owner.release().unwrap();
    assert!(!lock.exists());
}

#[test]
fn project_states_surface_lost_ownership_and_recover_with_retry() {
    let base = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(&base.path().join("copies"), &Policy::default()).unwrap();
    let project = isolation.project(Path::new("project")).unwrap();
    std::fs::create_dir_all(project.join(".milagre")).unwrap();
    std::fs::write(
        project.join(".milagre/coordination.json"),
        r#"{"next_id":1,"sessions":{"1":{"id":1}},"messages":[]}"#,
    )
    .unwrap();
    let mut states = ProjectStates::new(isolation, Timing::default(), 1_000_000);
    states.set_sweep_min_age(Duration::from_secs(60));
    assert!(states.assert_owned(&project).is_err(), "not open yet");
    states.get(&project).unwrap();
    states.assert_owned(&project).unwrap();
    let lock = ownership::project_lock(&project);
    let token = tokens_in(&lock);
    let record = std::fs::read_to_string(lock.join("owner.json")).unwrap();

    states
        .update(&project, Some(&[1]), true, |state: &ProjectState| {
            let mut list = state.message_list().to_vec();
            list.push(Msg::new(
                json!({ "id": 1, "session_id": 1, "role": "user", "body": "kept dirty" }),
            ));
            Some(state.with_messages(list).with_field("next_id", json!(2)))
        })
        .unwrap();
    let before = files(&project);
    std::fs::write(
        lock.join("owner.json"),
        record.replace(&token, "someone-else"),
    )
    .unwrap();
    lost(
        &states.assert_owned(&project).unwrap_err(),
        "replaced",
        &[&token, "someone-else"],
    );
    states.advance(1_000_300);
    let events = states.take_events();
    let failed = events.iter().find_map(|event| match event {
        Event::SaveFailed { error, .. } => Some(error.clone()),
        _ => None,
    });
    let failed = failed.expect("the save failed");
    assert!(
        failed.contains("no longer owns")
            && !failed.contains(&token)
            && !failed.contains("someone-else"),
        "{failed}"
    );
    let persistence = states
        .current(&project)
        .unwrap()
        .rest
        .get("persistence")
        .cloned()
        .unwrap();
    assert!(persistence["error"]
        .as_str()
        .unwrap()
        .contains("no longer owns"));
    assert!(!persistence.to_string().contains(&token));
    assert_eq!(files(&project), before, "a save happened without ownership");

    std::fs::write(lock.join("owner.json"), &record).unwrap();
    states.assert_owned(&project).unwrap();
    states.retry(&project).unwrap();
    assert!(states
        .current(&project)
        .unwrap()
        .rest
        .get("persistence")
        .is_none());
    assert_ne!(files(&project), before);
    states.close().unwrap();
    assert!(!lock.exists());
}

//! Publication reads include unloaded messages without reopening Projects or keeping idle Chats loaded.

use std::path::{Path, PathBuf};

use milagre_owner_store::isolation::{Isolation, Policy};
use milagre_owner_store::message_store::Msg;
use milagre_owner_store::states::{ProjectStates, Timing};
use milagre_owner_store::StoreError;
use serde_json::json;

struct Open {
    _base: tempfile::TempDir,
    states: ProjectStates,
    project: PathBuf,
}

fn open() -> Open {
    let base = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(&base.path().join("copies"), &Policy::default()).unwrap();
    let project = isolation.project(Path::new("p")).unwrap();
    std::fs::create_dir_all(project.join(".milagre")).unwrap();
    std::fs::write(
        project.join(".milagre/coordination.json"),
        r#"{"next_id":4,"sessions":{"1":{"id":1},"2":{"id":2}},"messages":[]}"#,
    )
    .unwrap();
    let mut states = ProjectStates::new(
        isolation,
        Timing {
            debounce_ms: 10,
            idle_ms: 100,
            sweep_ms: 10,
            lazy: true,
        },
        0,
    );
    states
        .update(&project, None, true, |state| {
            Some(state.with_messages(vec![
                Msg::new(json!({"id":1,"session_id":1,"role":"user","body":"question"})),
                Msg::new(json!({"id":2,"session_id":1,"role":"assistant","body":"reply","outcome":"completed"})),
                Msg::new(json!({"id":3,"session_id":2,"role":"user","body":"another Chat"})),
            ]))
        })
        .unwrap();
    states.flush(Some(&project)).unwrap();
    Open {
        _base: base,
        states,
        project,
    }
}

#[test]
fn a_current_whole_read_preserves_idle_unloading_and_the_complete_state() {
    let mut c = open();
    let loaded = c.states.current_whole_state(&c.project).unwrap().unwrap();
    assert_eq!(loaded["messages"].as_array().unwrap().len(), 3);
    c.states.advance(99);
    assert_eq!(
        c.states.current_whole_state(&c.project).unwrap(),
        Some(loaded.clone())
    );
    // The read at 99 must not touch the Chats: both still unload at 100.
    c.states.advance(100);
    let before = c.states.current(&c.project).unwrap();
    assert_eq!(before.unloaded.iter().copied().collect::<Vec<_>>(), [1, 2]);
    assert!(before.message_list().is_empty());
    c.states.take_events();
    assert_eq!(
        c.states.current_whole_state(&c.project).unwrap(),
        Some(loaded)
    );
    let after = c.states.current(&c.project).unwrap();
    assert_eq!(after.unloaded, before.unloaded);
    assert!(after.message_list().is_empty());
    assert!(c.states.take_events().is_empty());
    c.states.close().unwrap();
}

#[test]
fn a_missing_or_forgotten_slot_is_never_opened_by_a_current_whole_read() {
    let mut c = open();
    let missing = c.project.with_file_name("never-opened");
    assert!(c.states.current_whole_state(&missing).unwrap().is_none());
    assert!(!missing.exists());
    assert_eq!(c.states.projects(), [c.project.clone()]);
    c.states.forget(&c.project).unwrap();
    assert!(c.states.current_whole_state(&c.project).unwrap().is_none());
    assert!(c.states.projects().is_empty());
    assert!(!c.project.join(".milagre/runtime.lock").exists());
    assert!(c
        .states
        .take_events()
        .iter()
        .all(|event| !matches!(event, milagre_owner_store::states::Event::Unloaded { .. })));
}

#[test]
fn a_closed_slot_retained_after_a_failed_save_still_has_a_current_whole_state() {
    let mut c = open();
    c.states.advance(100);
    c.states
        .update(&c.project, Some(&[1]), true, |state| {
            Some(state.with_field("pending", json!("kept after failed close")))
        })
        .unwrap();
    let file = c.project.join(".milagre/coordination.json");
    let kept = file.with_extension("saved");
    std::fs::rename(&file, &kept).unwrap();
    std::fs::create_dir(&file).unwrap();
    assert!(c.states.close().is_err());
    assert!(c.states.is_closed());
    c.states.assert_owned(&c.project).unwrap();
    assert!(c.states.whole_state(&c.project).is_err());
    let before = c.states.current(&c.project).unwrap();
    assert!(before.unloaded.contains(&2));
    let whole = c.states.current_whole_state(&c.project).unwrap().unwrap();
    assert_eq!(whole["messages"].as_array().unwrap().len(), 3);
    assert_eq!(whole["pending"], "kept after failed close");
    assert_eq!(whole["persistence"], before.to_value()["persistence"]);
    assert_eq!(
        c.states.current(&c.project).unwrap().unloaded,
        before.unloaded
    );
    std::fs::remove_dir(&file).unwrap();
    std::fs::rename(&kept, &file).unwrap();
    c.states.retry(&c.project).unwrap();
    c.states.close().unwrap();
    assert!(c.states.current_whole_state(&c.project).unwrap().is_none());
}

#[test]
fn a_replaced_root_refuses_a_current_whole_read_without_opening_the_replacement() {
    let mut c = open();
    c.states.advance(100);
    let moved = c.project.with_file_name("moved");
    std::fs::rename(&c.project, &moved).unwrap();
    std::fs::create_dir(&c.project).unwrap();
    assert!(matches!(
        c.states.current_whole_state(&c.project),
        Err(StoreError::OwnershipLost { .. })
    ));
    assert_eq!(std::fs::read_dir(&c.project).unwrap().count(), 0);
    assert!(c
        .states
        .current(&c.project)
        .unwrap()
        .message_list()
        .is_empty());
    std::fs::remove_dir(&c.project).unwrap();
    std::fs::rename(&moved, &c.project).unwrap();
    assert_eq!(
        c.states.current_whole_state(&c.project).unwrap().unwrap()["messages"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    c.states.close().unwrap();
}

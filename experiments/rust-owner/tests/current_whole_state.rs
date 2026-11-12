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

#[test]
fn shared_whole_cache_tracks_identity_flush_unload_and_authority() {
    use std::sync::Arc;
    let mut c = open();
    let first = c
        .states
        .current_whole_state_shared(&c.project)
        .unwrap()
        .unwrap();
    let same = c
        .states
        .current_whole_state_shared(&c.project)
        .unwrap()
        .unwrap();
    assert!(Arc::ptr_eq(&first, &same));
    c.states
        .update(&c.project, Some(&[1]), true, |state| {
            let mut messages = state.message_list().to_vec();
            let index = messages.iter().position(|m| m.value()["id"] == 2).unwrap();
            let mut reply = messages[index].value().clone();
            reply["body"] = json!("edited reply");
            messages[index] = Msg::new(reply);
            Some(state.with_messages(messages))
        })
        .unwrap();
    let edited = c
        .states
        .current_whole_state_shared(&c.project)
        .unwrap()
        .unwrap();
    assert!(!Arc::ptr_eq(&first, &edited));
    assert_eq!(edited["messages"][1]["body"], "edited reply");
    c.states.flush(Some(&c.project)).unwrap();
    // All subsequent comparisons use this now-saved transcript.
    let first = c
        .states
        .current_whole_state_shared(&c.project)
        .unwrap()
        .unwrap();
    c.states.advance(100);
    let unloaded = c
        .states
        .current_whole_state_shared(&c.project)
        .unwrap()
        .unwrap();
    assert!(!Arc::ptr_eq(&first, &unloaded));
    assert_eq!(first, unloaded);
    assert!(c
        .states
        .current(&c.project)
        .unwrap()
        .message_list()
        .is_empty());
    c.states
        .update(&c.project, Some(&[1]), true, |state| {
            Some(state.with_field("new", json!(true)))
        })
        .unwrap();
    let changed = c
        .states
        .current_whole_state_shared(&c.project)
        .unwrap()
        .unwrap();
    assert_eq!(changed["new"], true);
    assert_eq!(changed["messages"].as_array().unwrap().len(), 3);
    c.states.flush(Some(&c.project)).unwrap();
    let flushed = c
        .states
        .current_whole_state_shared(&c.project)
        .unwrap()
        .unwrap();
    assert!(!Arc::ptr_eq(&changed, &flushed));
    assert_eq!(changed, flushed);
    let moved = c.project.with_file_name("moved");
    std::fs::rename(&c.project, &moved).unwrap();
    std::fs::create_dir(&c.project).unwrap();
    assert!(matches!(
        c.states.current_whole_state_shared(&c.project),
        Err(StoreError::OwnershipLost { .. })
    ));
    assert_eq!(std::fs::read_dir(&c.project).unwrap().count(), 0);
    std::fs::remove_dir(&c.project).unwrap();
    std::fs::rename(&moved, &c.project).unwrap();
    let restored = c
        .states
        .current_whole_state_shared(&c.project)
        .unwrap()
        .unwrap();
    assert!(!Arc::ptr_eq(&flushed, &restored));
    assert_eq!(flushed, restored);
    c.states.forget(&c.project).unwrap();
    assert!(c
        .states
        .current_whole_state_shared(&c.project)
        .unwrap()
        .is_none());
}

#[test]
#[ignore = "isolated same-process CPU measurement; no providers or installed apps"]
fn measure_shared_publication_read_cpu() {
    use std::time::Instant;
    fn cpu() -> f64 {
        let mut r = std::mem::MaybeUninit::<libc::rusage>::uninit();
        assert_eq!(
            unsafe { libc::getrusage(libc::RUSAGE_SELF, r.as_mut_ptr()) },
            0
        );
        let r = unsafe { r.assume_init() };
        r.ru_utime.tv_sec as f64
            + r.ru_utime.tv_usec as f64 / 1e6
            + r.ru_stime.tv_sec as f64
            + r.ru_stime.tv_usec as f64 / 1e6
    }
    let mut c = open();
    c.states.update(&c.project, Some(&[1]), true, |state| {
        Some(state.with_messages((1..=200).map(|id| Msg::new(json!({"id":id,"session_id":1,"role":"user","body":"x".repeat(8192)}))).collect()))
    }).unwrap();
    c.states.flush(Some(&c.project)).unwrap();
    c.states.advance(100);
    let expected = c.states.current_whole_state(&c.project).unwrap().unwrap();
    for round in 0..3 {
        for cached in if round % 2 == 0 {
            [false, true]
        } else {
            [true, false]
        } {
            let began = Instant::now();
            let before = cpu();
            for _ in 0..200 {
                if cached {
                    std::hint::black_box(
                        c.states
                            .current_whole_state_shared(&c.project)
                            .unwrap()
                            .unwrap(),
                    );
                } else {
                    std::hint::black_box(
                        c.states.current_whole_state(&c.project).unwrap().unwrap(),
                    );
                }
            }
            println!(
                "round={round} cached={cached} cpu_ms={:.3} wall_ms={:.3}",
                (cpu() - before) * 1000.,
                began.elapsed().as_secs_f64() * 1000.
            );
        }
    }
    assert_eq!(
        *c.states
            .current_whole_state_shared(&c.project)
            .unwrap()
            .unwrap(),
        expected
    );
    assert!(c
        .states
        .current(&c.project)
        .unwrap()
        .message_list()
        .is_empty());
    c.states.close().unwrap();
}

#[test]
#[ignore = "isolated empty-state CPU measurement; no providers or installed apps"]
fn measure_empty_shared_publication_read_cpu() {
    fn cpu() -> f64 {
        let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
        assert_eq!(
            unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) },
            0
        );
        let usage = unsafe { usage.assume_init() };
        usage.ru_utime.tv_sec as f64
            + usage.ru_utime.tv_usec as f64 / 1e6
            + usage.ru_stime.tv_sec as f64
            + usage.ru_stime.tv_usec as f64 / 1e6
    }
    let mut c = open();
    c.states
        .update(&c.project, None, true, |state| {
            Some(state.with_messages(vec![]))
        })
        .unwrap();
    c.states.flush(Some(&c.project)).unwrap();
    let expected = c.states.current_whole_state(&c.project).unwrap().unwrap();
    for round in 0..3 {
        for cached in if round % 2 == 0 {
            [false, true]
        } else {
            [true, false]
        } {
            let before = cpu();
            for _ in 0..2000 {
                if cached {
                    std::hint::black_box(
                        c.states
                            .current_whole_state_shared(&c.project)
                            .unwrap()
                            .unwrap(),
                    );
                } else {
                    std::hint::black_box(
                        c.states.current_whole_state(&c.project).unwrap().unwrap(),
                    );
                }
            }
            println!(
                "empty round={round} cached={cached} cpu_ms={:.3}",
                (cpu() - before) * 1000.
            );
        }
    }
    assert_eq!(
        *c.states
            .current_whole_state_shared(&c.project)
            .unwrap()
            .unwrap(),
        expected
    );
    c.states.close().unwrap();
}

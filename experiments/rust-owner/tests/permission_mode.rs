//! Permission-mode ownership: receipts, retained authority, generation races and project readiness.
//! Scripted provider callbacks only. The companion oracle test checks ordinary behavior against real Node methods.

use std::path::{Path, PathBuf};

use milagre_owner_store::chat_host::{
    AnswerId, ChatHost, MockProvider, ModeChangeId, ModeOutcome, ModeResult, ModeTicket, Notice,
    Provider, ProviderError, ProviderErrorKind, ProviderEvent, TurnId,
};
use milagre_owner_store::isolation::{Isolation, Policy};
use milagre_owner_store::jsjson::{self, RawJson};
use milagre_owner_store::states::{ProjectStates, Timing};
use serde_json::{json, Value};

struct Copy {
    _temp: tempfile::TempDir,
    project: PathBuf,
    host: ChatHost,
    provider: MockProvider,
}

impl Drop for Copy {
    fn drop(&mut self) {
        let _ = self.host.shutdown(true);
    }
}

impl Copy {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let isolation = Isolation::create(&temp.path().join("copies"), &Policy::default()).unwrap();
        let project = isolation.project(Path::new("p")).unwrap();
        std::fs::create_dir_all(project.join(".milagre")).unwrap();
        std::fs::write(
            project.join(".milagre/coordination.json"),
            json!({
                "next_id": 10,
                "worktrees": { "1": { "id": 1, "path": project, "name": "main" } },
                "sessions": { "1": { "id": 1, "worktree_id": 1, "permissionMode": "ask" } },
                "messages": []
            })
            .to_string(),
        )
        .unwrap();
        let mut host = ChatHost::new(ProjectStates::new(isolation, Timing::default(), 0));
        let provider = MockProvider::new("kiro");
        host.register(Box::new(provider.clone()));
        host.open_project(&project).unwrap();
        host.take_notices();
        Self {
            _temp: temp,
            project,
            host,
            provider,
        }
    }

    fn chat(&self) -> String {
        format!("{}#1", self.project.display())
    }

    fn send(&mut self, mode: &str, body: &str) -> TurnId {
        let sent = self
            .host
            .send(&json!({
                "projectPath": self.project, "sessionId": 1, "provider": "kiro", "model": "m",
                "body": body, "permissionMode": mode,
            }))
            .unwrap();
        assert!(self.host.pump().is_empty());
        self.provider.emit(
            &self.chat(),
            json!({ "type": "session-started", "nativeId": "n" }),
        );
        assert!(self.host.pump().is_empty());
        self.host.take_notices();
        sent.turn.unwrap()
    }

    fn hold(&mut self, mode: &str) -> ModeChangeId {
        self.provider.state.lock().unwrap().hold_modes = true;
        match self
            .host
            .set_permission_mode(&json!({ "chatId": self.chat(), "mode": mode }))
            .unwrap()
        {
            ModeTicket::Pending(change) => change,
            ModeTicket::Settled => panic!("expected live receipt"),
        }
    }

    fn mode(&self) -> Value {
        self.host
            .states
            .current(&self.project)
            .unwrap()
            .sessions()
            .unwrap()["1"]["permissionMode"]
            .clone()
    }

    fn turn_mode(&self) -> Value {
        self.host.turn_settings(&self.chat()).unwrap()["permissionMode"].clone()
    }

    fn settle(&mut self, change: ModeChangeId) {
        self.host
            .deliver(ProviderEvent::ModeSettled {
                chat: self.chat(),
                change,
                outcome: ModeOutcome::Applied,
            })
            .unwrap();
    }

    fn end(&mut self, kind: &str) {
        self.provider.emit(&self.chat(), json!({ "type": kind }));
        assert!(self.host.pump().is_empty());
    }
}

#[test]
fn timeout_keeps_authority_until_receipt_and_late_receipt_never_replies_twice() {
    let mut copy = Copy::new();
    copy.send("ask", "first");
    copy.host.mode_grace_ms = 10;
    let change = copy.hold("full");
    assert_eq!(copy.mode(), "ask");
    assert!(copy.host.tick(10).is_empty());
    let notices = copy.host.take_notices();
    assert!(
        matches!(&notices[..], [Notice::ModeSettled { change: id, result: ModeResult::Uncertain(_), .. }] if *id == change)
    );
    assert!(copy.host.tick(20).is_empty());
    assert!(copy.host.take_notices().is_empty());
    assert_eq!(
        copy.host
            .set_permission_mode(&json!({ "chatId": copy.chat(), "mode": "auto" }))
            .unwrap_err()
            .code(),
        Some("MODE_CHANGE_PENDING")
    );
    assert_eq!(copy.provider.state.lock().unwrap().modes.len(), 1);
    assert_eq!(
        copy.mode(),
        "ask",
        "an unconfirmed timeout must not silently become a definitive update"
    );
    copy.settle(change);
    let notices = copy.host.take_notices();
    assert!(notices.iter().any(|notice| matches!(notice, Notice::ModeResolved { change: id, result: ModeResult::Applied, .. } if *id == change)));
    assert!(!notices
        .iter()
        .any(|notice| matches!(notice, Notice::ModeSettled { .. })));
    assert_eq!(copy.mode(), "full");
    assert_eq!(copy.turn_mode(), "full");
    assert!(copy
        .host
        .deliver(ProviderEvent::ModeSettled {
            chat: copy.chat(),
            change,
            outcome: ModeOutcome::Applied
        })
        .is_err());
    let next = copy.hold("auto");
    assert_ne!(change, next);
}

#[test]
fn provider_uncertainty_retains_authority_until_definitive_receipt_or_session_exit() {
    for finish in ["applied", "failed", "exited"] {
        let mut copy = Copy::new();
        let turn = copy.send("ask", "first");
        copy.host.mode_grace_ms = 1;
        let change = copy.hold("full");
        for _ in 0..2 {
            copy.host
                .deliver(ProviderEvent::ModeSettled {
                    chat: copy.chat(),
                    change,
                    outcome: ModeOutcome::Uncertain(ProviderError::new(
                        ProviderErrorKind::Other,
                        "callback cancelled after entry",
                    )),
                })
                .unwrap();
        }
        assert!(copy.host.tick(10).is_empty());
        let notices = copy.host.take_notices();
        assert!(
            matches!(&notices[..], [Notice::ModeSettled { change: id, result: ModeResult::Uncertain(message), .. }]
            if *id == change && message == "callback cancelled after entry")
        );
        assert_eq!(copy.mode(), "ask");
        assert_eq!(copy.turn_mode(), "ask");
        assert_eq!(
            copy.host
                .set_permission_mode(&json!({ "chatId": copy.chat(), "mode": "auto" }))
                .unwrap_err()
                .code(),
            Some("MODE_CHANGE_PENDING")
        );
        match finish {
            "applied" => copy.settle(change),
            "failed" => copy
                .host
                .deliver(ProviderEvent::ModeSettled {
                    chat: copy.chat(),
                    change,
                    outcome: ModeOutcome::Failed(ProviderError::new(
                        ProviderErrorKind::Refused,
                        "update ended",
                    )),
                })
                .unwrap(),
            _ => copy
                .host
                .deliver(ProviderEvent::Exited {
                    chat: copy.chat(),
                    turn,
                    error: ProviderError::new(ProviderErrorKind::Exited, "closed"),
                })
                .unwrap(),
        }
        assert_eq!(copy.mode(), "full");
        let notices = copy.host.take_notices();
        assert!(!notices
            .iter()
            .any(|notice| matches!(notice, Notice::ModeSettled { .. })));
        if finish != "exited" {
            let expected = if finish == "applied" {
                ModeResult::Applied
            } else {
                ModeResult::Failed("update ended".into())
            };
            assert!(notices.iter().any(
                |notice| matches!(notice, Notice::ModeResolved { change: id, result, .. }
                if *id == change && result == &expected)
            ));
        }
        assert!(copy
            .host
            .set_permission_mode(&json!({ "chatId": copy.chat(), "mode": "auto" }))
            .is_ok());
        assert_eq!(
            copy.provider.state.lock().unwrap().modes.len(),
            if finish == "exited" { 1 } else { 2 }
        );
    }
}

#[test]
fn another_chat_cannot_settle_the_receipt_or_free_the_global_capacity() {
    let mut copy = Copy::new();
    copy.send("ask", "first");
    copy.host.mode_capacity = 1;
    let change = copy.hold("full");
    assert!(copy
        .host
        .deliver(ProviderEvent::ModeSettled {
            chat: format!("{}#999", copy.project.display()),
            change,
            outcome: ModeOutcome::Applied
        })
        .is_err());
    assert_eq!(copy.mode(), "ask");
    copy.host
        .states
        .update(&copy.project, Some(&[]), true, |state| {
            let mut sessions = state.sessions().unwrap().clone();
            sessions.insert("2".into(), json!({ "id": 2, "worktree_id": 1 }));
            Some(state.with_field("sessions", Value::Object(sessions)))
        })
        .unwrap();
    copy.host.send(&json!({ "projectPath": copy.project, "sessionId": 2, "provider": "kiro", "model": "m", "body": "other" })).unwrap();
    assert!(copy.host.pump().is_empty());
    let request = json!({ "chatId": format!("{}#2", copy.project.display()), "mode": "auto" });
    assert_eq!(
        copy.host.set_permission_mode(&request).unwrap_err().code(),
        Some("MODES_AT_CAPACITY")
    );
    copy.host.mode_grace_ms = 1;
    assert!(copy.host.tick(30_000).is_empty());
    assert_eq!(
        copy.host.set_permission_mode(&request).unwrap_err().code(),
        Some("MODES_AT_CAPACITY")
    );
    copy.settle(change);
    assert!(matches!(
        copy.host.set_permission_mode(&request),
        Ok(ModeTicket::Pending(_))
    ));
}

#[test]
fn old_completion_persists_preference_but_cannot_rewrite_newer_turn_settings() {
    let mut copy = Copy::new();
    let first = copy.send("ask", "first");
    let change = copy.hold("full");
    copy.end("turn-completed");
    let second = copy.send("auto", "second");
    assert_ne!(first, second);
    assert_eq!(copy.turn_mode(), "auto");
    copy.settle(change);
    assert_eq!(
        copy.mode(),
        "full",
        "Node keeps the preference even if its live update finishes late"
    );
    assert_eq!(
        copy.turn_mode(),
        "auto",
        "generation hardening must protect the newer active turn"
    );
    assert_eq!(copy.host.active_turn(&copy.chat()), Some(second));
    assert_eq!(
        copy.provider.state.lock().unwrap().modes[0]["turn"],
        first.0
    );
}

#[test]
fn replacement_session_exit_cannot_release_an_older_workers_mode_authority() {
    for cleanup_receipt in [false, true] {
        let mut copy = Copy::new();
        let first = copy.send("ask", "first");
        let change = copy.hold("full");
        copy.host
            .deliver(ProviderEvent::ModeSettled {
                chat: copy.chat(),
                change,
                outcome: ModeOutcome::Uncertain(ProviderError::new(
                    ProviderErrorKind::Other,
                    "entered callback lost",
                )),
            })
            .unwrap();
        copy.end("turn-completed");
        let second = copy.send("auto", "replacement worker");
        copy.host
            .deliver(ProviderEvent::Exited {
                chat: copy.chat(),
                turn: second,
                error: ProviderError::new(ProviderErrorKind::Exited, "replacement exited first"),
            })
            .unwrap();
        assert_eq!(copy.mode(), "auto");
        assert_eq!(
            copy.host
                .set_permission_mode(&json!({ "chatId": copy.chat(), "mode": "ask" }))
                .unwrap_err()
                .code(),
            Some("MODE_CHANGE_PENDING")
        );
        if cleanup_receipt {
            copy.host
                .deliver(ProviderEvent::ModeSettled {
                    chat: copy.chat(),
                    change,
                    outcome: ModeOutcome::Failed(ProviderError::new(
                        ProviderErrorKind::Exited,
                        "captured worker cleaned up",
                    )),
                })
                .unwrap();
        } else {
            copy.host
                .deliver(ProviderEvent::Exited {
                    chat: copy.chat(),
                    turn: first,
                    error: ProviderError::new(
                        ProviderErrorKind::Exited,
                        "captured worker cleaned up",
                    ),
                })
                .unwrap();
        }
        assert_eq!(copy.mode(), "full");
        let notices = copy.host.take_notices();
        assert!(!notices
            .iter()
            .any(|notice| matches!(notice, Notice::ModeSettled { .. })));
        if cleanup_receipt {
            assert!(notices.iter().any(|notice| matches!(notice, Notice::ModeResolved { change: id,
                result: ModeResult::Failed(message), .. } if *id == change && message == "captured worker cleaned up")));
        }
        assert_eq!(
            copy.host
                .set_permission_mode(&json!({ "chatId": copy.chat(), "mode": "ask" }))
                .unwrap(),
            ModeTicket::Settled
        );
    }
}

#[test]
fn ended_turn_still_has_a_live_session_and_receipt_changes_its_latest_settings() {
    let mut copy = Copy::new();
    let turn = copy.send("ask", "first");
    let change = copy.hold("full");
    copy.end("turn-cancelled");
    assert_eq!(copy.host.active_turn(&copy.chat()), None);
    assert_eq!(
        copy.host
            .set_permission_mode(&json!({ "chatId": copy.chat(), "mode": "ask" }))
            .unwrap_err()
            .code(),
        Some("MODE_CHANGE_PENDING")
    );
    copy.settle(change);
    assert_eq!(copy.mode(), "full");
    assert_eq!(copy.turn_mode(), "full");
    let next = copy.hold("auto");
    assert_eq!(copy.provider.state.lock().unwrap().modes[1]["turn"], turn.0);
    copy.settle(next);
    assert_eq!(copy.turn_mode(), "auto");
}

#[test]
fn exit_releases_unknown_authority_and_stale_receipts_cannot_undo_a_later_choice() {
    let mut copy = Copy::new();
    let turn = copy.send("ask", "first");
    let change = copy.hold("full");
    copy.host
        .deliver(ProviderEvent::Exited {
            chat: copy.chat(),
            turn,
            error: ProviderError::new(ProviderErrorKind::Exited, "gone"),
        })
        .unwrap();
    assert_eq!(copy.mode(), "full");
    assert_eq!(
        copy.host
            .set_permission_mode(&json!({ "chatId": copy.chat(), "mode": "auto" }))
            .unwrap(),
        ModeTicket::Settled
    );
    assert_eq!(copy.mode(), "auto");
    assert!(copy
        .host
        .deliver(ProviderEvent::ModeSettled {
            chat: copy.chat(),
            change,
            outcome: ModeOutcome::Applied
        })
        .is_err());
    assert_eq!(copy.mode(), "auto");
    assert_eq!(copy.provider.state.lock().unwrap().modes.len(), 1);
}

#[test]
fn queued_turn_keeps_its_captured_mode_and_resets_preference_when_it_starts() {
    let mut copy = Copy::new();
    copy.send("ask", "first");
    let queued = copy.host.send(&json!({ "projectPath": copy.project, "sessionId": 1,
        "provider": "kiro", "model": "m", "body": "queued", "permissionMode": "auto", "delivery": "queue" })).unwrap();
    assert!(queued.queued);
    let change = copy.hold("full");
    copy.settle(change);
    let state = copy.host.states.current(&copy.project).unwrap();
    let session = &state.sessions().unwrap()["1"];
    assert_eq!(session["queued"][0]["turn"]["permissionMode"], "auto");
    assert_eq!(copy.mode(), "full");
    copy.end("turn-completed");
    assert_eq!(
        copy.provider.state.lock().unwrap().turns[1]["permissionMode"],
        "auto"
    );
    assert_eq!(copy.mode(), "auto");
}

#[test]
fn not_ready_invalid_alias_and_closing_projects_never_call_the_adapter() {
    let mut copy = Copy::new();
    copy.send("ask", "first");
    let alias = format!("{}/.#1", copy.project.display());
    assert!(copy
        .host
        .set_permission_mode(&json!({ "chatId": alias, "mode": "full" }))
        .unwrap_err()
        .to_string()
        .contains("isn't how this Project is named"));
    assert!(copy
        .host
        .set_permission_mode(
            &json!({ "chatId": format!("{}#01", copy.project.display()), "mode": "full" })
        )
        .unwrap_err()
        .to_string()
        .contains("isn't how this Chat is named"));
    copy.host.forget(&copy.project, true).unwrap();
    assert_eq!(
        copy.host
            .set_permission_mode(&json!({ "chatId": copy.chat(), "mode": "full" }))
            .unwrap_err()
            .code(),
        Some("PROJECT_NOT_READY")
    );
    assert!(copy.provider.state.lock().unwrap().modes.is_empty());
    copy.host.open_project(&copy.project).unwrap();
    copy.host.shutdown(true).unwrap();
    assert_eq!(
        copy.host
            .set_permission_mode(&json!({ "chatId": copy.chat(), "mode": "full" }))
            .unwrap_err()
            .code(),
        Some("OWNER_CLOSING")
    );
}

#[test]
fn forget_and_quit_settle_pending_once_and_never_reopen_on_a_late_receipt() {
    for quit in [false, true] {
        let mut copy = Copy::new();
        copy.send("ask", "first");
        let change = copy.hold("full");
        if quit {
            copy.host.shutdown(true).unwrap();
        } else {
            copy.host.forget(&copy.project, true).unwrap();
        }
        assert!(!copy.host.is_project_ready(&copy.project));
        let notices = copy.host.take_notices();
        assert_eq!(notices.iter().filter(|notice| matches!(notice,
            Notice::ModeSettled { change: id, result: ModeResult::Uncertain(_), .. } if *id == change)).count(), 1);
        let saved = std::fs::read(copy.project.join(".milagre/coordination.json")).unwrap();
        assert!(copy
            .host
            .deliver(ProviderEvent::ModeSettled {
                chat: copy.chat(),
                change,
                outcome: ModeOutcome::Applied
            })
            .is_ok());
        assert_eq!(
            std::fs::read(copy.project.join(".milagre/coordination.json")).unwrap(),
            saved
        );
        assert!(copy.host.take_notices().is_empty());
        assert!(copy
            .host
            .deliver(ProviderEvent::ModeSettled {
                chat: copy.chat(),
                change,
                outcome: ModeOutcome::Applied
            })
            .is_err());
        assert!(!copy.host.is_project_ready(&copy.project));
    }
}

#[test]
fn failed_or_async_close_retains_mode_authority_until_actual_exit() {
    for fails in [false, true] {
        let mut copy = Copy::new();
        let turn = copy.send("ask", "first");
        copy.host.interrupt_grace_ms = 1;
        let change = copy.hold("full");
        if fails {
            copy.provider.state.lock().unwrap().fail_next_close = Some("close failed".into());
        }
        copy.host.interrupt(&copy.chat()).unwrap();
        assert!(copy.host.tick(10).is_empty());
        assert_eq!(copy.host.active_turn(&copy.chat()), None);
        assert_eq!(
            copy.mode(),
            "ask",
            "a logical close is not a definitive mode receipt"
        );
        assert_eq!(
            copy.host
                .set_permission_mode(&json!({ "chatId": copy.chat(), "mode": "auto" }))
                .unwrap_err()
                .code(),
            Some("MODE_CHANGE_PENDING")
        );
        assert_eq!(copy.provider.state.lock().unwrap().modes.len(), 1);
        let notices = copy.host.take_notices();
        assert_eq!(notices.iter().filter(|notice| matches!(notice,
            Notice::ModeSettled { change: id, result: ModeResult::Uncertain(_), .. } if *id == change)).count(), 1);
        copy.host
            .deliver(ProviderEvent::Exited {
                chat: copy.chat(),
                turn,
                error: ProviderError::new(ProviderErrorKind::Exited, "actually closed"),
            })
            .unwrap();
        assert_eq!(copy.mode(), "full");
        assert_eq!(
            copy.host
                .set_permission_mode(&json!({ "chatId": copy.chat(), "mode": "auto" }))
                .unwrap(),
            ModeTicket::Settled
        );
        assert_eq!(copy.mode(), "auto");
        assert!(copy
            .host
            .deliver(ProviderEvent::ModeSettled {
                chat: copy.chat(),
                change,
                outcome: ModeOutcome::Applied
            })
            .is_err());
    }
}

#[test]
fn reopened_project_keeps_retired_authority_until_cleanup_without_replaying_preference() {
    for receipt in [false, true] {
        let mut copy = Copy::new();
        let turn = copy.send("ask", "first");
        let change = copy.hold("full");
        copy.host.forget(&copy.project, true).unwrap();
        copy.host.open_project(&copy.project).unwrap();
        copy.host.take_notices();
        assert_eq!(copy.mode(), "ask");
        assert_eq!(
            copy.host
                .set_permission_mode(&json!({ "chatId": copy.chat(), "mode": "auto" }))
                .unwrap_err()
                .code(),
            Some("MODE_CHANGE_PENDING")
        );
        if receipt {
            copy.settle(change);
        } else {
            copy.host
                .deliver(ProviderEvent::Exited {
                    chat: copy.chat(),
                    turn,
                    error: ProviderError::new(ProviderErrorKind::Exited, "closed after reopen"),
                })
                .unwrap();
        }
        assert_eq!(
            copy.mode(),
            "ask",
            "an operation from revoked ownership cannot write into a reopened Project"
        );
        assert!(copy.host.take_notices().is_empty());
        assert_eq!(
            copy.host
                .set_permission_mode(&json!({ "chatId": copy.chat(), "mode": "auto" }))
                .unwrap(),
            ModeTicket::Settled
        );
        assert_eq!(copy.mode(), "auto");
    }
}

#[test]
fn provider_error_strings_cross_the_json_boundary_once() {
    let mut copy = Copy::new();
    copy.send("ask", "first");
    let change = copy.hold("full");
    let message = "mode rejected \u{10fffe}undefined";
    copy.host
        .deliver(ProviderEvent::ModeSettled {
            chat: copy.chat(),
            change,
            outcome: ModeOutcome::Failed(ProviderError::new(ProviderErrorKind::Refused, message)),
        })
        .unwrap();
    assert!(copy.host.take_notices().iter().any(|notice| matches!(notice,
        Notice::ModeSettled { result: ModeResult::Failed(text), .. } if text == &jsjson::js_string(message))));
    assert_eq!(copy.mode(), "full");
}

#[test]
fn not_ready_receipt_and_deadline_wait_for_explicit_reopen() {
    let mut copy = Copy::new();
    copy.send("ask", "first");
    copy.host.mode_grace_ms = 1;
    let change = copy.hold("full");
    let moved = copy.project.with_file_name("p-moved");
    std::fs::rename(&copy.project, &moved).unwrap();
    std::os::unix::fs::symlink(&moved, &copy.project).unwrap();
    assert!(copy
        .host
        .set_permission_mode(&json!({ "chatId": copy.chat(), "mode": "ask" }))
        .is_err());
    assert!(!copy.host.is_project_ready(&copy.project));
    copy.host
        .deliver(ProviderEvent::ModeSettled {
            chat: copy.chat(),
            change,
            outcome: ModeOutcome::Applied,
        })
        .unwrap();
    assert!(copy.host.tick(10).is_empty());
    assert!(copy.host.take_notices().is_empty());
    assert_eq!(copy.turn_mode(), "ask");
    assert_eq!(copy.host.parked_for_tests().0, 1);
    std::fs::remove_file(&copy.project).unwrap();
    std::fs::rename(&moved, &copy.project).unwrap();
    copy.host.open_project(&copy.project).unwrap();
    assert_eq!(copy.mode(), "full");
    assert_eq!(copy.turn_mode(), "full");
    assert!(copy
        .host
        .take_notices()
        .iter()
        .any(|notice| matches!(notice,
        Notice::ModeSettled { change: id, result: ModeResult::Applied, .. } if *id == change)));
}

/// Lose readiness, then restore the directory without reopening the Project. Disposal can now close its actual
/// ownership cleanly while provider receipts still wait in the not-ready queue.
fn pause_project(host: &mut ChatHost, project: &Path) {
    let moved = project.with_extension("paused");
    std::fs::rename(project, &moved).unwrap();
    std::os::unix::fs::symlink(&moved, project).unwrap();
    assert!(host.require_project_ready(project).is_err());
    std::fs::remove_file(project).unwrap();
    std::fs::rename(moved, project).unwrap();
    assert!(!host.is_project_ready(project));
}

fn receipt(chat: &str, change: ModeChangeId, kind: &str) -> ProviderEvent {
    ProviderEvent::ModeSettled {
        chat: if kind == "other-chat" {
            format!("{}#999", chat.rsplit_once('#').unwrap().0)
        } else {
            chat.into()
        },
        change: if kind == "other-change" {
            ModeChangeId(change.0 + 100)
        } else {
            change
        },
        outcome: match kind {
            "failed" => ModeOutcome::Failed(ProviderError::new(
                ProviderErrorKind::Refused,
                "native refused",
            )),
            "unknown" => ModeOutcome::Uncertain(ProviderError::new(
                ProviderErrorKind::Other,
                "delivery unknown",
            )),
            _ => ModeOutcome::Applied,
        },
    }
}

#[test]
fn disposing_parked_cleanup_preserves_exact_operation_proof_without_replaying_preferences() {
    for quit in [false, true] {
        for kind in [
            "applied",
            "failed",
            "unknown",
            "other-chat",
            "other-change",
            "exact-exit",
            "later-exit",
        ] {
            let mut copy = Copy::new();
            let first = copy.send("ask", "first");
            let change = copy.hold("full");
            copy.end("turn-completed");
            let second = copy.send("auto", "same worker advanced");
            pause_project(&mut copy.host, &copy.project);
            let event = if kind.ends_with("exit") {
                ProviderEvent::Exited {
                    chat: copy.chat(),
                    turn: if kind == "exact-exit" { first } else { second },
                    error: ProviderError::new(ProviderErrorKind::Exited, "worker cleanup"),
                }
            } else {
                receipt(&copy.chat(), change, kind)
            };
            copy.host.deliver(event).unwrap();
            assert_eq!(copy.host.parked_for_tests().0, 1);
            if quit {
                copy.host.shutdown(true).unwrap();
            } else {
                copy.host.forget(&copy.project, true).unwrap();
            }
            assert_eq!(copy.host.parked_for_tests(), (0, 0));
            assert!(!copy.host.is_project_ready(&copy.project));
            let saved = std::fs::read(copy.project.join(".milagre/coordination.json")).unwrap();
            assert_eq!(
                serde_json::from_slice::<Value>(&saved).unwrap()["sessions"]["1"]["permissionMode"],
                "auto"
            );
            assert!(!copy.host.take_notices().iter().any(|notice| matches!(
                notice,
                Notice::Broadcast { .. } | Notice::ModeResolved { .. }
            )));
            let released = matches!(kind, "applied" | "failed" | "exact-exit");
            if !quit {
                copy.host.open_project(&copy.project).unwrap();
                let result = copy
                    .host
                    .set_permission_mode(&json!({ "chatId": copy.chat(), "mode": "auto" }));
                if released {
                    assert_eq!(result.unwrap(), ModeTicket::Settled, "{kind}");
                } else {
                    assert_eq!(
                        result.unwrap_err().code(),
                        Some("MODE_CHANGE_PENDING"),
                        "{kind}"
                    );
                }
                copy.host.take_notices();
            }
            // A removed slot rejects a duplicate. Otherwise only this exact terminal receipt may free it.
            let cleanup = copy.host.deliver(receipt(&copy.chat(), change, "applied"));
            assert_eq!(cleanup.is_err(), released, "quit={quit}, {kind}");
            assert_eq!(
                std::fs::read(copy.project.join(".milagre/coordination.json")).unwrap(),
                saved
            );
            assert!(copy.host.take_notices().is_empty());
        }
    }
}

#[test]
fn dropping_another_projects_receipt_cannot_release_this_projects_mode() {
    let mut copy = Copy::new();
    copy.send("ask", "first");
    let change = copy.hold("full");
    let other = copy.project.with_file_name("other");
    std::fs::create_dir_all(other.join(".milagre")).unwrap();
    std::fs::write(
        other.join(".milagre/coordination.json"),
        json!({
            "next_id": 2, "worktrees": { "1": { "id": 1, "path": other, "name": "other" } },
            "sessions": { "1": { "id": 1, "worktree_id": 1 } }, "messages": []
        })
        .to_string(),
    )
    .unwrap();
    copy.host.open_project(&other).unwrap();
    pause_project(&mut copy.host, &other);
    copy.host
        .deliver(receipt(
            &format!("{}#1", other.display()),
            change,
            "applied",
        ))
        .unwrap();
    copy.host.forget(&other, true).unwrap();
    assert_eq!(copy.mode(), "ask");
    assert_eq!(
        copy.host
            .set_permission_mode(&json!({ "chatId": copy.chat(), "mode": "auto" }))
            .unwrap_err()
            .code(),
        Some("MODE_CHANGE_PENDING")
    );
    copy.settle(change);
    assert_eq!(copy.mode(), "full");
}

#[test]
fn parked_overflow_consumes_terminal_receipts_in_each_disposal_position_but_retains_unknown() {
    for position in ["retained", "incoming", "already-lost"] {
        for kind in ["applied", "failed", "unknown"] {
            let mut copy = Copy::new();
            copy.send("ask", "first");
            let change = copy.hold("full");
            copy.end("turn-completed");
            let second = copy.send("auto", "same worker advanced");
            pause_project(&mut copy.host, &copy.project);
            copy.host.set_parked_budget_for_tests(
                if position == "retained" { 1 } else { 0 },
                usize::MAX,
            );
            let extra = ProviderEvent::Agent {
                chat: copy.chat(),
                turn: second,
                event: RawJson(json!({ "type": "text-delta", "text": "discarded" })),
            };
            if position == "retained" {
                copy.host
                    .deliver(receipt(&copy.chat(), change, kind))
                    .unwrap();
                assert!(copy.host.deliver(extra).is_err());
            } else {
                if position == "already-lost" {
                    assert!(copy.host.deliver(extra).is_err());
                }
                assert!(copy
                    .host
                    .deliver(receipt(&copy.chat(), change, kind))
                    .is_err());
            }
            assert_eq!(copy.host.parked_for_tests(), (0, 0));
            assert_eq!(copy.turn_mode(), "auto");
            let notices = copy.host.take_notices();
            assert!(!notices.iter().any(|notice| matches!(
                notice,
                Notice::Broadcast { .. } | Notice::ModeResolved { .. }
            )));
            if kind == "unknown" {
                assert!(notices.is_empty());
            } else {
                assert!(
                    matches!(&notices[..], [Notice::ModeSettled { change: id, result: ModeResult::Failed(message), .. }]
                    if *id == change && message.contains("wasn't saved") && (kind != "failed" || message.starts_with("native refused")))
                );
            }
            copy.host.open_project(&copy.project).unwrap();
            assert_eq!(
                copy.mode(),
                "auto",
                "{position}/{kind} replayed the discarded preference"
            );
            let next = copy
                .host
                .set_permission_mode(&json!({ "chatId": copy.chat(), "mode": "auto" }));
            if kind == "unknown" {
                assert_eq!(next.unwrap_err().code(), Some("MODE_CHANGE_PENDING"));
                // Even the new worker's exit cannot stand in for the older operation's exact proof.
                copy.host
                    .deliver(ProviderEvent::Exited {
                        chat: copy.chat(),
                        turn: second,
                        error: ProviderError::new(ProviderErrorKind::Exited, "newer exit"),
                    })
                    .unwrap();
                assert_eq!(
                    copy.host
                        .set_permission_mode(&json!({ "chatId": copy.chat(), "mode": "auto" }))
                        .unwrap_err()
                        .code(),
                    Some("MODE_CHANGE_PENDING")
                );
                copy.host
                    .deliver(receipt(&copy.chat(), change, "failed"))
                    .unwrap();
            } else {
                assert_eq!(next.unwrap(), ModeTicket::Settled);
            }
        }
    }
}

#[test]
fn held_overflow_releases_only_matching_terminal_receipt_without_mutating_the_kept_end() {
    for kind in ["applied", "failed", "unknown", "other-chat", "other-change"] {
        let mut copy = Copy::new();
        copy.send("ask", "first");
        let change = copy.hold("full");
        copy.end("turn-completed");
        let second = copy.send("auto", "same worker advanced");
        copy.host
            .states
            .set_commit_failure_for_tests(Some("end still unsaved"));
        assert!(copy
            .host
            .receive(&copy.chat(), second, &json!({ "type": "turn-completed" }))
            .is_err());
        copy.host.set_parked_budget_for_tests(0, usize::MAX);
        let event = receipt(&copy.chat(), change, kind);
        let result = copy.host.deliver(event);
        assert!(result.is_err());
        assert_eq!(copy.host.stuck_ends(), [copy.chat()]);
        assert_eq!(copy.mode(), "auto");
        assert_eq!(copy.turn_mode(), "auto");
        let notices = copy.host.take_notices();
        assert!(!notices.iter().any(|notice| matches!(
            notice,
            Notice::Broadcast { .. } | Notice::ModeResolved { .. }
        )));
        let released = matches!(kind, "applied" | "failed");
        if released {
            assert!(
                matches!(&notices[..], [Notice::ModeSettled { result: ModeResult::Failed(message), .. }]
                if message.contains("wasn't saved") && (kind != "failed" || message.starts_with("native refused")))
            );
        } else {
            assert!(notices.is_empty());
        }
        copy.host.states.set_commit_failure_for_tests(None);
        assert!(copy.host.pump().is_empty());
        assert_eq!(copy.mode(), "auto");
        let next = copy
            .host
            .set_permission_mode(&json!({ "chatId": copy.chat(), "mode": "ask" }));
        if released {
            assert!(matches!(next, Ok(ModeTicket::Pending(_))));
        } else {
            assert_eq!(next.unwrap_err().code(), Some("MODE_CHANGE_PENDING"));
        }
    }
}

/// An existing adapter without the new capability must inherit explicit refusal, never implicit success.
struct Unsupported(MockProvider);
impl Provider for Unsupported {
    fn name(&self) -> &str {
        self.0.name()
    }
    fn start_turn(&mut self, turn: TurnId, request: &RawJson) -> Result<(), ProviderError> {
        self.0.start_turn(turn, request)
    }
    fn interrupt(&mut self, chat: &str, turn: TurnId) -> Result<(), ProviderError> {
        self.0.interrupt(chat, turn)
    }
    fn respond_permission(
        &mut self,
        chat: &str,
        turn: TurnId,
        answer: AnswerId,
        id: &str,
        decision: &str,
    ) -> Result<(), ProviderError> {
        self.0.respond_permission(chat, turn, answer, id, decision)
    }
    fn answer_question(
        &mut self,
        chat: &str,
        turn: TurnId,
        answer: AnswerId,
        id: &str,
        answers: &RawJson,
    ) -> Result<(), ProviderError> {
        self.0.answer_question(chat, turn, answer, id, answers)
    }
    fn close_chat(&mut self, chat: &str, turn: TurnId) -> Result<(), ProviderError> {
        self.0.close_chat(chat, turn)
    }
    fn shutdown(&mut self) {
        self.0.shutdown();
    }
    fn take_events(&mut self) -> Vec<ProviderEvent> {
        self.0.take_events()
    }
}

#[test]
fn unsupported_adapter_reports_failure_but_still_notes_the_preference() {
    let mut copy = Copy::new();
    copy.host
        .register(Box::new(Unsupported(copy.provider.clone())));
    copy.send("ask", "first");
    let error = copy
        .host
        .set_permission_mode(&json!({ "chatId": copy.chat(), "mode": "full" }))
        .unwrap_err();
    assert!(error.to_string().contains("isn't supported"));
    assert_eq!(copy.mode(), "full");
    assert_eq!(copy.turn_mode(), "full");
    assert!(copy.provider.state.lock().unwrap().modes.is_empty());
}

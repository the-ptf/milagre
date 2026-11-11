//! Compare mode changes against real Node ChatHost and SessionManager methods. The Node fixture scripts only
//! session callbacks and persistence I/O; Rust uses MockProvider and a disposable owned Project. This verifies the
//! host contract, including persisted preferences, not equivalence with a live provider adapter or CLI.

use std::path::{Path, PathBuf};
use std::time::Duration;

use milagre_owner_store::agent_runs;
use milagre_owner_store::changed_files::test_hooks::run_bounded;
use milagre_owner_store::chat_host::{
    ChatHost, MockProvider, ModeOutcome, ModeResult, ModeTicket, Notice, ProviderError,
    ProviderErrorKind, ProviderEvent,
};
use milagre_owner_store::isolation::{Isolation, Policy};
use milagre_owner_store::jsjson;
use milagre_owner_store::states::{ProjectStates, Timing};
use serde_json::{json, Value};

struct Copy {
    host: ChatHost,
    provider: MockProvider,
    project: PathBuf,
    broadcasts: usize,
    _base: tempfile::TempDir,
}

impl Copy {
    fn new() -> Self {
        let base = tempfile::tempdir().unwrap();
        let isolation = Isolation::create(&base.path().join("copies"), &Policy::default()).unwrap();
        let project = isolation.project(Path::new("p")).unwrap();
        std::fs::create_dir_all(project.join(".milagre")).unwrap();
        let state = json!({
            "next_id": 10,
            "worktrees": {"1": {"id": 1, "name": "main", "path": project}},
            "sessions": {"1": {"id": 1, "worktree_id": 1, "permissionMode": "ask"}},
            "messages": []
        });
        std::fs::write(
            project.join(".milagre/coordination.json"),
            state.to_string(),
        )
        .unwrap();
        let mut host = ChatHost::new(ProjectStates::new(isolation, Timing::default(), 0));
        let provider = MockProvider::new("claude");
        host.register(Box::new(provider.clone()));
        host.open_project(&project).unwrap();
        host.send(&json!({
            "projectPath": project,
            "sessionId": 1,
            "provider": "claude",
            "model": "m",
            "permissionMode": "ask",
            "body": "first",
            "clientMessageId": "first"
        }))
        .unwrap();
        assert!(host.pump().is_empty());
        host.states
            .update(&project, Some(&[]), true, |state| {
                let mut session = state.sessions().unwrap()["1"].as_object().unwrap().clone();
                session.insert(
                    "queued".into(),
                    json!([{"id": "queued-1", "turn": {"permissionMode": "auto"}}]),
                );
                Some(agent_runs::with_session(state, 1, session))
            })
            .unwrap();
        host.states.flush(Some(&project)).unwrap();
        host.take_notices();
        Self {
            host,
            provider,
            project,
            broadcasts: 0,
            _base: base,
        }
    }

    fn chat(&self) -> String {
        format!("{}#1", self.project.display())
    }

    fn observe(&mut self) -> Vec<ModeResult> {
        let mut settled = Vec::new();
        for notice in self.host.take_notices() {
            match notice {
                Notice::Broadcast { .. } => self.broadcasts += 1,
                Notice::ModeSettled { result, .. } => settled.push(result),
                Notice::ModeResolved { .. } => panic!("unexpected late settlement"),
                _ => {}
            }
        }
        settled
    }

    fn attempt(&mut self, chat: &str, mode: &str) -> Value {
        match self
            .host
            .set_permission_mode(&json!({"chatId": chat, "mode": mode}))
        {
            Err(error) => json!(error.to_string()),
            Ok(ModeTicket::Settled) => {
                assert!(self.observe().is_empty());
                Value::Null
            }
            Ok(ModeTicket::Pending(_)) => {
                assert!(self.host.pump().is_empty());
                let results = self.observe();
                assert_eq!(results.len(), 1, "the command needs one receipt");
                match &results[0] {
                    ModeResult::Applied => Value::Null,
                    ModeResult::Failed(error) => json!(error),
                    ModeResult::Uncertain(error) => panic!("unexpected uncertain receipt: {error}"),
                }
            }
        }
    }

    fn snapshot(&mut self) -> Value {
        self.host.states.flush(Some(&self.project)).unwrap();
        // Read saved metadata, not only the owner's in-memory state.
        let saved = jsjson::parse(
            &std::fs::read_to_string(self.project.join(".milagre/coordination.json")).unwrap(),
        )
        .unwrap();
        json!({
            "saved": saved["sessions"]["1"]["permissionMode"],
            "turn": self.host.turn_settings(&self.chat()).unwrap()["permissionMode"],
            "queued": saved["sessions"]["1"]["queued"][0]["turn"]["permissionMode"],
            "broadcasts": self.broadcasts
        })
    }

    fn calls(&self) -> usize {
        self.provider.state.lock().unwrap().modes.len()
    }

    fn end(&mut self, exited: bool) {
        let chat = self.chat();
        let turn = self.host.active_turn(&chat).unwrap();
        if exited {
            self.host
                .deliver(ProviderEvent::Exited {
                    chat,
                    turn,
                    error: ProviderError::new(ProviderErrorKind::Exited, "session closed"),
                })
                .unwrap();
        } else {
            // Cancel holds the existing queue. Completing would start it before the idle-mode check.
            self.provider.emit(&chat, json!({"type": "turn-cancelled"}));
            assert!(self.host.pump().is_empty());
        }
        assert!(self.host.active_turn(&self.chat()).is_none());
        self.host.states.flush(Some(&self.project)).unwrap();
        self.host.take_notices();
        self.broadcasts = 0;
    }
}

impl Drop for Copy {
    fn drop(&mut self) {
        // End only this fixture's scripted sessions and release its isolated Project before TempDir removes it.
        let _ = self.host.shutdown(true);
    }
}

fn with_field(mut value: Value, name: &str, field: Value) -> Value {
    value[name] = field;
    value
}

/// Provider-internal mode is observable only in the Node script. Keep all host state and delivery-count fields.
fn host_fields(value: &mut Value) {
    match value {
        Value::Object(fields) => {
            fields.remove("live");
            for nested in fields.values_mut() {
                host_fields(nested);
            }
        }
        Value::Array(items) => {
            for nested in items {
                host_fields(nested);
            }
        }
        _ => {}
    }
}

#[test]
fn permission_mode_state_and_errors_match_real_node_methods() {
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/permission-mode-node.cjs");
    let output = run_bounded(
        "node",
        &[fixture.to_str().unwrap()],
        Duration::from_secs(10),
        64 * 1024,
    )
    .expect("Node 24+ oracle must finish successfully within its deadline and output budget");
    let mut expected: Value = serde_json::from_str(&output).unwrap();
    host_fields(&mut expected);

    let accepted: Vec<Value> = ["ask", "auto", "full"]
        .into_iter()
        .map(|mode| {
            let mut copy = Copy::new();
            assert_eq!(copy.attempt(&copy.chat(), mode), Value::Null);
            assert_eq!(copy.calls(), 1);
            with_field(copy.snapshot(), "mode", json!(mode))
        })
        .collect();

    let delayed = {
        let mut copy = Copy::new();
        copy.provider.state.lock().unwrap().hold_modes = true;
        let ModeTicket::Pending(change) = copy
            .host
            .set_permission_mode(&json!({"chatId": copy.chat(), "mode": "full"}))
            .unwrap()
        else {
            panic!("a queued live update must stay pending");
        };
        assert!(copy.host.pump().is_empty());
        assert!(copy.observe().is_empty());
        let before = with_field(copy.snapshot(), "settled", json!(false));
        copy.host
            .deliver(ProviderEvent::ModeSettled {
                chat: copy.chat(),
                change,
                outcome: ModeOutcome::Applied,
            })
            .unwrap();
        assert_eq!(copy.observe(), [ModeResult::Applied]);
        let after = with_field(copy.snapshot(), "settled", json!(true));
        json!({"before": before, "after": after})
    };

    let live_failure = {
        let mut copy = Copy::new();
        copy.provider.state.lock().unwrap().fail_next_mode = Some("agent refused".into());
        let error = copy.attempt(&copy.chat(), "full");
        with_field(copy.snapshot(), "error", error)
    };

    let missing = {
        let mut copy = Copy::new();
        let result = copy.attempt(&format!("{}#999", copy.project.display()), "full");
        let exists = copy
            .host
            .states
            .current(&copy.project)
            .unwrap()
            .sessions()
            .unwrap()
            .contains_key("999");
        json!({"result": result, "exists": exists, "liveCalls": copy.calls()})
    };

    let no_live = {
        let mut copy = Copy::new();
        copy.end(true);
        let error = copy.attempt(&copy.chat(), "full");
        let mut snapshot = with_field(copy.snapshot(), "error", error);
        snapshot["liveCalls"] = json!(copy.calls());
        snapshot
    };

    let idle = {
        let mut copy = Copy::new();
        copy.end(false);
        let error = copy.attempt(&copy.chat(), "full");
        let mut snapshot = with_field(copy.snapshot(), "error", error);
        snapshot["liveCalls"] = json!(copy.calls());
        snapshot
    };

    let invalid = {
        let mut copy = Copy::new();
        let error = copy.attempt(&copy.chat(), "yolo");
        let mut snapshot = with_field(copy.snapshot(), "error", error);
        snapshot["liveCalls"] = json!(copy.calls());
        snapshot
    };

    let note_failure = {
        let mut copy = Copy::new();
        copy.host.states.fail_next_commit("save failed");
        let error = copy.attempt(&copy.chat(), "full");
        with_field(copy.snapshot(), "error", error)
    };

    let both_fail = {
        let mut copy = Copy::new();
        copy.host.states.fail_next_commit("save failed");
        copy.provider.state.lock().unwrap().fail_next_mode = Some("agent refused".into());
        let error = copy.attempt(&copy.chat(), "full");
        with_field(copy.snapshot(), "error", error)
    };

    let actual = json!({
        "accepted": accepted,
        "delayed": delayed,
        "liveFailure": live_failure,
        "missing": missing,
        "noLive": no_live,
        "idle": idle,
        "invalid": invalid,
        "noteFailure": note_failure,
        "bothFail": both_fail
    });
    assert_eq!(actual, expected);
}

//! ChatHost safety regressions (review of 45427beb): a Project spelled two ways, a lost lock or a failed flush during a
//! send, duplicate client ids, late and unnamed turn ends, Send now whose interrupt fails, a turn end whose fold fails,
//! and a queued message already in the Chat. Each runs in a disposable isolated copy.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use milagre_owner_store::chat_host::{
    ChatHost, MockProvider, Notice, ProviderError, ProviderErrorKind, ProviderEvent, TurnId,
};
use milagre_owner_store::isolation::{Isolation, Policy};
use milagre_owner_store::ownership;
use milagre_owner_store::states::{ProjectStates, Timing};
use milagre_owner_store::StoreError;
use serde_json::{json, Value};

struct Copy {
    _base: tempfile::TempDir,
    project: PathBuf,
    host: ChatHost,
    kiro: MockProvider,
}

impl Copy {
    fn new(sessions: Value, messages: Value) -> Self {
        let base = tempfile::tempdir().unwrap();
        let isolation = Isolation::create(&base.path().join("copies"), &Policy::default()).unwrap();
        let project = isolation.project(Path::new("p")).unwrap();
        std::fs::create_dir_all(project.join(".milagre")).unwrap();
        let state = json!({ "next_id": 10, "worktrees": { "1": { "id": 1, "path": "/tmp/wt", "name": "main" } }, "sessions": sessions, "messages": messages });
        std::fs::write(
            project.join(".milagre/coordination.json"),
            state.to_string(),
        )
        .unwrap();
        let mut host = ChatHost::new(ProjectStates::new(isolation, Timing::default(), 0));
        let kiro = MockProvider::new("kiro");
        host.register(Box::new(kiro.clone()));
        Copy {
            _base: base,
            project,
            host,
            kiro,
        }
    }

    fn plain() -> Self {
        Copy::new(json!({ "1": { "id": 1, "worktree_id": 1 } }), json!([]))
    }

    fn path(&self) -> String {
        self.project.display().to_string()
    }

    fn chat(&self) -> String {
        format!("{}#1", self.path())
    }

    fn send(
        &mut self,
        body: &str,
        client: &str,
        extra: Value,
    ) -> milagre_owner_store::Result<milagre_owner_store::chat_host::Sent> {
        let mut request = json!({ "projectPath": self.path(), "sessionId": 1, "provider": "kiro", "model": "m", "body": body, "clientMessageId": client });
        for (key, value) in extra.as_object().unwrap() {
            request[key] = value.clone();
        }
        self.host.send(&request)
    }

    fn messages(&self) -> Vec<Value> {
        self.host
            .states
            .current(&self.project)
            .map(|state| {
                state
                    .message_list()
                    .iter()
                    .map(|m| m.value().clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    fn session(&self) -> Value {
        self.host
            .states
            .current(&self.project)
            .unwrap()
            .sessions()
            .unwrap()["1"]
            .clone()
    }

    fn started(&self) -> usize {
        self.kiro.state.lock().unwrap().turns.len()
    }

    fn end(&mut self, kind: &str) {
        let chat = self.chat();
        self.kiro.emit(&chat, json!({ "type": kind }));
        let errors = self.host.pump();
        assert!(errors.is_empty(), "{errors:?}");
    }
}

fn user_bodies(messages: &[Value]) -> Vec<String> {
    messages
        .iter()
        .filter(|m| m["role"] == "user")
        .map(|m| m["body"].as_str().unwrap().to_string())
        .collect()
}

/// Review P2.1: `/p/` and `/x/../p` reach the same state as `/p`; they must not make the Chat a second one.
#[test]
fn a_project_spelled_another_way_is_refused() {
    let mut copy = Copy::plain();
    copy.send("first", "c1", json!({})).unwrap();
    copy.host.pump();
    assert!(copy.host.is_busy(&copy.chat()));
    let parent = copy.project.parent().unwrap().display().to_string();
    for alias in [
        format!("{}/", copy.path()),
        format!("{parent}/x/../p"),
        format!("{parent}/./p"),
    ] {
        let error = copy
            .send("second", "c2", json!({ "projectPath": alias }))
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("isn't how this Project is named"),
            "{alias}: {error}"
        );
        let chat = format!("{alias}#1");
        assert!(copy
            .host
            .receive(
                &chat,
                None,
                &json!({ "type": "session-started", "nativeId": "n" })
            )
            .is_err());
        assert!(copy.host.interrupt(&chat).is_err());
    }
    assert_eq!(copy.started(), 1, "a second turn started for the same Chat");
    assert_eq!(user_bodies(&copy.messages()), ["first"]);
    assert_eq!(copy.host.runs().len(), 1);
}

/// Review P2.3/P3.3: a Project whose lock was taken from us stages nothing; a failed flush takes the message back
/// out and leaves the Chat free.
#[test]
fn a_lost_lock_or_failed_flush_leaves_nothing_behind() {
    let mut copy = Copy::plain();
    copy.host.states.get(&copy.project).unwrap();
    let lock = ownership::project_lock(&copy.project);
    let record = std::fs::read_to_string(lock.join("owner.json")).unwrap();
    let token: Value = serde_json::from_str(&record).unwrap();
    let token = token["token"].as_str().unwrap().to_string();
    std::fs::write(
        lock.join("owner.json"),
        record.replace(&token, "someone-else"),
    )
    .unwrap();
    let before = copy.host.states.current(&copy.project).unwrap().to_value();
    let error = copy.send("hi", "c1", json!({})).unwrap_err();
    assert!(matches!(error, StoreError::OwnershipLost { .. }), "{error}");
    assert!(!error.to_string().contains(&token));
    assert_eq!(
        copy.host.states.current(&copy.project).unwrap().to_value(),
        before,
        "a lost lock staged a change"
    );
    assert!(!copy.host.is_busy(&copy.chat()));
    assert_eq!(copy.started(), 0);
    std::fs::write(lock.join("owner.json"), &record).unwrap();

    // The flush fails (its folder can't be written): the message goes back out, the Chat stays free.
    let milagre = copy.project.join(".milagre");
    std::fs::set_permissions(&milagre, std::fs::Permissions::from_mode(0o555)).unwrap();
    copy.host.take_notices();
    let failed = copy.send("hi", "c1", json!({}));
    let rolled_back = copy
        .host
        .take_notices()
        .iter()
        .any(|n| matches!(n, Notice::Broadcast { .. }));
    std::fs::set_permissions(&milagre, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(failed.is_err(), "the flush should have failed");
    assert!(
        rolled_back,
        "the send failed before its flush: {:?}",
        failed.err()
    );
    assert!(
        copy.messages().is_empty(),
        "the message stayed after a failed flush"
    );
    assert!(
        copy.session().get("provider").is_none(),
        "the staged session stayed"
    );
    assert!(!copy.host.is_busy(&copy.chat()));
    assert!(copy.host.runs().is_empty());
    assert_eq!(copy.started(), 0);
    // The same client id goes through once the folder is writable again: nothing kept it as a duplicate.
    let sent = copy.send("hi", "c1", json!({})).unwrap();
    assert!(!sent.duplicate && sent.turn.is_some());
    assert_eq!(user_bodies(&copy.messages()), ["hi"]);
}

/// Review P3.6: the same client id twice, while the first start is still in flight and while it waits in a queue.
#[test]
fn duplicate_client_ids_start_one_turn() {
    let mut copy = Copy::plain();
    let first = copy.send("one", "c1", json!({})).unwrap();
    let again = copy.send("one", "c1", json!({})).unwrap();
    assert!(again.duplicate && again.turn.is_none());
    copy.host.pump();
    let queued = copy.send("two", "c2", json!({})).unwrap();
    assert!(queued.queued);
    let twin = copy.send("two", "c2", json!({})).unwrap();
    assert!(twin.duplicate);
    assert_eq!(copy.started(), 1);
    assert_eq!(user_bodies(&copy.messages()), ["one"]);
    assert_eq!(copy.session()["queued"].as_array().unwrap().len(), 1);
    assert!(first.turn.is_some());
}

/// Review P2.4: a late `turn-cancelled` of the interrupted turn must not end the turn Send now started; a turn end
/// without its turn is refused; a provider that exits fails the running turn.
#[test]
fn late_and_unnamed_turn_ends_are_dropped() {
    let mut copy = Copy::plain();
    let first = copy.send("one", "c1", json!({})).unwrap().turn.unwrap();
    copy.host.pump();
    copy.send("two", "c2", json!({})).unwrap();
    let id = copy.session()["queued"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    copy.host.send_queued_now(&copy.chat(), &id).unwrap();
    assert_eq!(copy.kiro.state.lock().unwrap().interrupts, [copy.chat()]);
    copy.end("turn-cancelled");
    let second = copy
        .host
        .active_turn(&copy.chat())
        .expect("Send now started the next turn");
    assert_ne!(first, second);
    let runs = copy.host.runs().clone();
    let state = copy.host.states.current(&copy.project).unwrap().to_value();

    let chat = copy.chat();
    copy.kiro
        .emit_for(&chat, Some(first), json!({ "type": "turn-cancelled" }));
    copy.kiro.emit_for(
        &chat,
        Some(first),
        json!({ "type": "text-delta", "text": "late" }),
    );
    copy.kiro
        .emit_for(&chat, None, json!({ "type": "turn-completed" }));
    let errors: Vec<String> = copy.host.pump().iter().map(ToString::to_string).collect();
    assert_eq!(errors.len(), 3, "{errors:?}");
    assert!(errors[0].contains("late \"turn-cancelled\""), "{errors:?}");
    assert!(errors[2].contains("must name its turn"), "{errors:?}");
    assert_eq!(
        copy.host.runs(),
        &runs,
        "a late event changed the running turn"
    );
    assert_eq!(
        copy.host.states.current(&copy.project).unwrap().to_value(),
        state
    );
    assert_eq!(copy.host.active_turn(&chat), Some(second));

    // The provider's process ends: the running turn fails, and the Chat is free.
    copy.kiro.push(ProviderEvent::Exited {
        chat: chat.clone(),
        error: ProviderError::new(ProviderErrorKind::Exited, "kiro-cli exited"),
    });
    assert!(copy.host.pump().is_empty());
    assert!(!copy.host.is_busy(&chat));
    let last = copy.messages().last().cloned().unwrap();
    assert_eq!(last["outcome"], "failed");
    assert_eq!(last["body"], "Agent error: kiro-cli exited");
}

/// Review P3.2: Send now whose interrupt fails keeps no pick: the next turn end doesn't start that message.
#[test]
fn send_now_with_a_failed_interrupt_keeps_no_pick() {
    let mut copy = Copy::plain();
    copy.send("one", "c1", json!({})).unwrap();
    copy.host.pump();
    copy.send("two", "c2", json!({})).unwrap();
    copy.send("three", "c3", json!({})).unwrap();
    let picked = copy.session()["queued"][1]["id"]
        .as_str()
        .unwrap()
        .to_string();
    copy.kiro.state.lock().unwrap().fail_next_interrupt = Some("the session is gone".into());
    let error = copy
        .host
        .send_queued_now(&copy.chat(), &picked)
        .unwrap_err()
        .to_string();
    assert!(error.contains("the session is gone"), "{error}");
    // Stopped by the user: the queue holds, and the failed pick doesn't start.
    copy.end("turn-cancelled");
    assert_eq!(copy.started(), 1, "the failed pick started anyway");
    assert_eq!(copy.session()["queueHeld"], true);
}

/// Review P2.2: a turn end whose fold fails (here its Project can't be opened again) is kept, the Chat stays busy,
/// and it is folded once it can be.
#[test]
fn a_turn_end_whose_fold_fails_is_kept_and_retried() {
    let mut copy = Copy::plain();
    copy.send("one", "c1", json!({})).unwrap();
    copy.host.pump();
    let chat = copy.chat();
    assert!(copy
        .host
        .forget(&copy.project.clone())
        .unwrap_err()
        .to_string()
        .contains("has a turn running"));
    // The states lose the Project under the host (as a failed close would), and someone else holds its lock.
    copy.host.states.forget(&copy.project.clone()).unwrap();
    let lock = ownership::project_lock(&copy.project);
    std::fs::create_dir_all(&lock).unwrap();
    std::fs::write(lock.join("owner.json"), r#"{"token":"other","pid":1}"#).unwrap();
    copy.kiro
        .emit(&chat, json!({ "type": "text-delta", "text": "done" }));
    copy.kiro.emit(&chat, json!({ "type": "turn-completed" }));
    let errors = copy.host.pump();
    assert_eq!(errors.len(), 2, "{errors:?}");
    assert_eq!(copy.host.stuck_ends(), std::slice::from_ref(&chat));
    assert!(copy.host.is_busy(&chat), "a lost turn end freed the Chat");
    // A pump with the lock still held tries again and keeps it.
    assert_eq!(copy.host.pump().len(), 1);
    std::fs::remove_dir_all(&lock).unwrap();
    assert!(copy.host.pump().is_empty());
    assert!(copy.host.stuck_ends().is_empty());
    assert!(!copy.host.is_busy(&chat));
    let last = copy.messages().last().cloned().unwrap();
    assert_eq!(last["outcome"], "completed");
}

/// Review P3.2: a queued message whose client id is already in the Chat leaves the queue; the next one starts.
#[test]
fn a_queued_message_already_in_the_chat_leaves_the_queue() {
    let queued = json!([
        { "id": "q1", "body": "again", "provider": "kiro", "model": "m", "clientMessageId": "c0", "queuedAt": 0, "turn": {} },
        { "id": "q2", "body": "next", "provider": "kiro", "model": "m", "clientMessageId": "c5", "queuedAt": 0, "turn": {} }
    ]);
    let mut copy = Copy::new(
        json!({ "1": { "id": 1, "worktree_id": 1, "provider": "kiro", "queued": queued } }),
        json!([{ "id": 1, "session_id": 1, "role": "user", "body": "again", "clientMessageId": "c0", "model": "m" }]),
    );
    copy.send("one", "c1", json!({})).unwrap();
    copy.host.pump();
    let chat = copy.chat();
    copy.kiro.emit(
        &chat,
        json!({ "type": "session-started", "nativeId": "native" }),
    );
    copy.host.pump();
    copy.host.take_notices();
    copy.end("turn-completed");
    let notices = copy.host.take_notices();
    assert!(notices
        .iter()
        .any(|n| matches!(n, Notice::QueueStartedWithoutSender { id, .. } if id == "q1")));
    assert_eq!(
        copy.started(),
        2,
        "the next queued message didn't start: {notices:?} {}",
        copy.session()
    );
    assert!(copy.session().get("queued").is_none(), "{}", copy.session());
    assert_eq!(user_bodies(&copy.messages()), ["again", "one", "next"]);
    assert!(copy
        .host
        .active_turn(&copy.chat())
        .is_some_and(|turn| turn > TurnId(1)));
}

#[test]
fn the_host_and_its_providers_can_move_between_threads() {
    fn sendable<T: Send>() {}
    sendable::<ChatHost>();
    sendable::<MockProvider>();
    let mut copy = Copy::plain();
    copy.send("one", "c1", json!({})).unwrap();
    copy.host.pump();
    assert!(copy
        .host
        .shutdown()
        .unwrap_err()
        .to_string()
        .contains("suspend and resume"));
    copy.end("turn-completed");
    copy.host.shutdown().unwrap();
    assert!(copy.kiro.state.lock().unwrap().shut_down);
}

/// Review P2.3: the saved message is found again by id, whatever copy of it the save kept.
#[test]
fn a_large_message_is_saved_once() {
    let mut copy = Copy::plain();
    let files: Vec<Value> = (0..40)
        .map(|n| json!({ "path": format!("src/file-{n}.rs"), "name": "x".repeat(500) }))
        .collect();
    copy.send(
        "big",
        "c1",
        json!({ "files": files, "context": { "kind": "note", "text": "y".repeat(60_000) } }),
    )
    .unwrap();
    copy.host.pump();
    copy.host.states.flush(Some(&copy.project.clone())).unwrap();
    let saved: Vec<Value> = copy
        .messages()
        .into_iter()
        .filter(|m| m["clientMessageId"] == "c1")
        .collect();
    assert_eq!(saved.len(), 1, "the message was saved twice");
    assert_eq!(saved[0]["files"].as_array().unwrap().len(), 40);
}

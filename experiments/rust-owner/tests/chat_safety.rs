//! ChatHost safety regressions (review of 45427beb): a Project spelled two ways, a lost lock or a failed flush during a
//! send, duplicate client ids, late and unnamed turn ends, Send now whose interrupt fails, a turn end whose fold fails,
//! and a queued message already in the Chat. Each runs in a disposable isolated copy.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use milagre_owner_store::chat_host::{
    AnswerId, AnswerOutcome, AnswerResult, AnswerTicket, ChatHost, MockProvider, Notice,
    ProviderError, ProviderErrorKind, ProviderEvent, SteeringMode, TurnId,
};
use milagre_owner_store::isolation::{Isolation, Policy};
use milagre_owner_store::jsjson::{self, RawJson};
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

    /// The provider names its session, so a later send resumes it (no handoff restore).
    fn native(&mut self) {
        let chat = self.chat();
        self.kiro.emit(
            &chat,
            json!({ "type": "session-started", "nativeId": "native" }),
        );
        assert!(self.host.pump().is_empty());
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
                TurnId(1),
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

/// Review P2.4 / re-review P2-2: a late `turn-cancelled` or text of the interrupted turn must not touch the turn Send
/// now started, nor may the old session's exit; the running session's exit fails its turn.
#[test]
fn late_events_and_exits_of_an_earlier_turn_are_dropped() {
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
        .emit_for(&chat, first, json!({ "type": "turn-cancelled" }));
    copy.kiro.emit_for(
        &chat,
        first,
        json!({ "type": "text-delta", "text": "late" }),
    );
    copy.kiro
        .emit_for(&chat, first, json!({ "type": "session-reset" }));
    copy.kiro.push(ProviderEvent::Exited {
        chat: chat.clone(),
        turn: first,
        error: ProviderError::new(ProviderErrorKind::Exited, "old process exited"),
    });
    let errors: Vec<String> = copy.host.pump().iter().map(ToString::to_string).collect();
    assert_eq!(errors.len(), 3, "{errors:?}");
    assert!(errors[0].contains("late \"turn-cancelled\""), "{errors:?}");
    assert!(errors[2].contains("older session"), "{errors:?}");
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

    // The running session's process ends: its turn fails, and the Chat is free.
    copy.kiro.push(ProviderEvent::Exited {
        chat: chat.clone(),
        turn: second,
        error: ProviderError::new(ProviderErrorKind::Exited, "kiro-cli exited"),
    });
    assert!(copy.host.pump().is_empty());
    assert!(!copy.host.is_busy(&chat));
    let last = copy.messages().last().cloned().unwrap();
    assert_eq!(last["outcome"], "failed");
    assert_eq!(last["body"], "Agent error: kiro-cli exited");
    // That session's late Chat-level events are dropped too.
    copy.kiro.emit_for(
        &chat,
        second,
        json!({ "type": "session-started", "nativeId": "late" }),
    );
    assert_eq!(copy.host.pump().len(), 1);
}

/// Re-review P2-1: a duplicate turn end of a finished turn, with nothing running, is dropped: no phantom end, no
/// queue hold, no sequence number.
#[test]
fn a_duplicate_turn_end_while_idle_is_dropped() {
    let mut copy = Copy::plain();
    let turn = copy.send("one", "c1", json!({})).unwrap().turn.unwrap();
    copy.host.pump();
    copy.native();
    copy.end("turn-completed");
    copy.host.take_notices();
    let state = copy.host.states.current(&copy.project).unwrap().to_value();
    let chat = copy.chat();
    copy.kiro
        .emit_for(&chat, turn, json!({ "type": "turn-cancelled" }));
    let errors: Vec<String> = copy.host.pump().iter().map(ToString::to_string).collect();
    assert_eq!(errors.len(), 1, "{errors:?}");
    assert!(errors[0].contains("nothing runs"), "{errors:?}");
    assert!(
        copy.host.take_notices().is_empty(),
        "a phantom end was told"
    );
    assert_eq!(
        copy.host.states.current(&copy.project).unwrap().to_value(),
        state
    );
    // The next turn still starts at once (the queue wasn't held).
    copy.send("two", "c2", json!({})).unwrap();
    copy.host.pump();
    assert_eq!(copy.started(), 2);
    assert!(copy.session().get("queueHeld").is_none());
}

/// Re-review P2-3: a turn whose provider never ends it after Stop is forced once its grace is over: the session is
/// closed, the turn fails, and that session's late events are dropped. Forced quit ends running turns too.
#[test]
fn an_interrupt_that_never_ends_is_forced_and_quit_can_be_forced() {
    let mut copy = Copy::plain();
    copy.send("one", "c1", json!({})).unwrap();
    copy.host.pump();
    let chat = copy.chat();
    let turn = copy.host.active_turn(&chat).unwrap();
    copy.kiro.emit(
        &chat,
        json!({ "type": "session-started", "nativeId": "native-1" }),
    );
    copy.kiro
        .emit(&chat, json!({ "type": "text-delta", "text": "partial" }));
    copy.host.pump();
    copy.host.interrupt(&chat).unwrap();
    let start = copy.host.states.now();
    assert!(copy
        .host
        .tick(start + copy.host.interrupt_grace_ms - 1)
        .is_empty());
    assert!(copy.host.is_busy(&chat), "forced before its grace");
    assert!(copy
        .host
        .tick(start + copy.host.interrupt_grace_ms)
        .is_empty());
    assert!(!copy.host.is_busy(&chat));
    assert_eq!(
        copy.kiro.state.lock().unwrap().closed,
        std::slice::from_ref(&chat)
    );
    let last = copy.messages().last().cloned().unwrap();
    assert_eq!(last["outcome"], "failed");
    assert_eq!(
        last["body"],
        "partial\n\nThe agent didn't stop in time, so Milagre ended its turn."
    );
    copy.kiro
        .emit_for(&chat, turn, json!({ "type": "turn-cancelled" }));
    copy.kiro
        .emit_for(&chat, turn, json!({ "type": "session-reset" }));
    assert_eq!(copy.host.pump().len(), 2);
    assert_eq!(
        copy.session()["native_session_id"],
        "native-1",
        "a closed session's reset was folded"
    );

    // A turn that never ends blocks a plain quit, not a forced one.
    copy.send("two", "c2", json!({})).unwrap();
    copy.host.pump();
    assert!(copy
        .host
        .shutdown(false)
        .unwrap_err()
        .to_string()
        .contains("suspend and resume"));
    copy.host.shutdown(true).unwrap();
    assert!(copy.kiro.state.lock().unwrap().shut_down);
    let project = copy.project.clone();
    assert!(
        !ownership::project_lock(&project).exists(),
        "the lock outlived a forced quit"
    );
}

/// Re-review P2-4: closing a Project closes its Chats' sessions first; a late Chat-level event of one is dropped and
/// doesn't open (or lock) the Project again. A forced close ends a running turn.
#[test]
fn a_closed_project_stays_closed() {
    let mut copy = Copy::plain();
    copy.send("one", "c1", json!({})).unwrap();
    copy.host.pump();
    let chat = copy.chat();
    let project = copy.project.clone();
    assert!(copy
        .host
        .forget(&project, false)
        .unwrap_err()
        .to_string()
        .contains("has a turn running"));
    copy.native();
    copy.end("turn-completed");
    let turn = copy.kiro.current(&chat).unwrap();
    copy.host.forget(&project, false).unwrap();
    assert_eq!(
        copy.kiro.state.lock().unwrap().closed,
        std::slice::from_ref(&chat)
    );
    copy.kiro.emit_for(
        &chat,
        turn,
        json!({ "type": "context-usage", "used": 1, "size": 2 }),
    );
    copy.kiro.emit_for(
        &chat,
        turn,
        json!({ "type": "session-started", "nativeId": "late" }),
    );
    let errors: Vec<String> = copy.host.pump().iter().map(ToString::to_string).collect();
    assert_eq!(errors.len(), 2, "{errors:?}");
    assert!(errors[0].contains("isn't open here"), "{errors:?}");
    assert!(!copy.host.states.has(&project));
    assert!(
        !ownership::project_lock(&project).exists(),
        "a late event took the lock again"
    );

    // Opened again, a running turn is ended by a forced close.
    copy.send("two", "c2", json!({})).unwrap();
    copy.host.pump();
    copy.host.forget(&project, true).unwrap();
    assert!(!copy.host.is_busy(&chat));
    assert!(!copy.host.states.has(&project));
    // What was saved: the turn ended as failed, said so.
    copy.host.states.get(&project).unwrap();
    let last = copy.messages().last().cloned().unwrap();
    assert_eq!(last["outcome"], "failed");
    assert_eq!(
        last["body"],
        "Milagre closed this Project before the turn ended."
    );
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

/// Review P2.2 / re-review P3-3: a turn end that can't be folded (its Project was closed under the host and is
/// locked by someone else) is kept while its turn runs, through retries that fail before the fold, and folded once
/// the Project is open again.
#[test]
fn a_turn_end_whose_fold_fails_is_kept_and_retried() {
    let mut copy = Copy::plain();
    copy.send("one", "c1", json!({})).unwrap();
    copy.host.pump();
    let chat = copy.chat();
    copy.kiro
        .emit(&chat, json!({ "type": "text-delta", "text": "done" }));
    copy.host.pump();
    let project = copy.project.clone();
    copy.host.states.forget(&project).unwrap();
    let lock = ownership::project_lock(&project);
    std::fs::create_dir_all(&lock).unwrap();
    std::fs::write(lock.join("owner.json"), r#"{"token":"other","pid":1}"#).unwrap();
    copy.kiro.emit(&chat, json!({ "type": "turn-completed" }));
    assert_eq!(copy.host.pump().len(), 1);
    assert_eq!(copy.host.stuck_ends(), std::slice::from_ref(&chat));
    assert!(copy.host.is_busy(&chat), "a lost turn end freed the Chat");
    // Retries that fail before the fold keep it.
    assert_eq!(copy.host.pump().len(), 1);
    assert_eq!(copy.host.stuck_ends(), std::slice::from_ref(&chat));
    assert!(
        copy.host.states.get(&project).is_err(),
        "someone else's lock was taken over"
    );
    std::fs::remove_dir_all(&lock).unwrap();
    copy.host.states.get(&project).unwrap();
    assert!(copy.host.pump().is_empty());
    assert!(copy.host.stuck_ends().is_empty());
    assert!(!copy.host.is_busy(&chat));
    let last = copy.messages().last().cloned().unwrap();
    assert_eq!(last["outcome"], "completed");
    assert_eq!(last["body"], "done");
}

/// Re-review P3-2: notices nobody takes are bounded, and the take says how many were dropped.
#[test]
fn notices_are_bounded() {
    let mut copy = Copy::plain();
    copy.send("one", "c1", json!({})).unwrap();
    copy.host.pump();
    let chat = copy.chat();
    for _ in 0..(milagre_owner_store::chat_host::MAX_NOTICES + 5) {
        copy.kiro
            .emit(&chat, json!({ "type": "text-delta", "text": "x" }));
    }
    copy.host.pump();
    let notices = copy.host.take_notices();
    assert_eq!(
        notices.len(),
        milagre_owner_store::chat_host::MAX_NOTICES + 1
    );
    assert!(
        matches!(notices.last(), Some(Notice::Failed { error, .. }) if error.contains("notices were dropped"))
    );
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
        .shutdown(false)
        .unwrap_err()
        .to_string()
        .contains("suspend and resume"));
    copy.end("turn-completed");
    copy.host.shutdown(false).unwrap();
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

/// Starts turn A, queues B behind it and picks B with Send now; the provider ignores the interrupt.
fn send_now_pending(copy: &mut Copy) -> (TurnId, String) {
    let first = copy.send("one", "c1", json!({})).unwrap().turn.unwrap();
    copy.host.pump();
    copy.native();
    let queued = copy.send("two", "c2", json!({})).unwrap();
    assert!(queued.queued);
    let id = copy.session()["queued"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    copy.host.send_queued_now(&copy.chat(), &id).unwrap();
    (first, id)
}

/// Policy review P2-1: Send now whose interrupt is ignored: the forced end starts the pick, and the pick's session
/// keeps its generation (its `session-started` is folded, so the next turn can resume).
#[test]
fn a_forced_interrupt_keeps_the_send_now_pick_session() {
    let mut copy = Copy::plain();
    let (first, _) = send_now_pending(&mut copy);
    let chat = copy.chat();
    let now = copy.host.states.now();
    assert!(copy
        .host
        .tick(now + copy.host.interrupt_grace_ms)
        .is_empty());
    let second = copy
        .host
        .active_turn(&chat)
        .expect("the Send-now pick started");
    assert_ne!(first, second);
    assert_eq!(copy.started(), 2);
    copy.kiro.emit(
        &chat,
        json!({ "type": "session-started", "nativeId": "native-2" }),
    );
    assert!(
        copy.host.pump().is_empty(),
        "the new session's event was dropped"
    );
    assert_eq!(copy.session()["native_session_id"], "native-2");
}

/// Policy review P2-2: a forced quit with a Send-now pick waiting starts no provider turn; the pick stays queued, its
/// sender hears `null`, and nothing is sent afterwards.
#[test]
fn a_forced_quit_starts_nothing() {
    let mut copy = Copy::plain();
    let (_, id) = send_now_pending(&mut copy);
    copy.host.take_notices();
    copy.host.shutdown(true).unwrap();
    assert_eq!(copy.started(), 1, "a forced quit started the Send-now pick");
    assert!(copy.host.active_turn(&copy.chat()).is_none());
    let notices = copy.host.take_notices();
    assert!(notices.iter().any(|n| matches!(n, Notice::QueueStarted { id: started, result } if *started == id && result.is_null())), "{notices:?}");
    let error = copy.send("three", "c3", json!({})).unwrap_err().to_string();
    assert!(error.contains("quitting"), "{error}");
}

/// Policy review P2-2: a forced close of the Project with a Send-now pick waiting starts nothing either.
#[test]
fn a_forced_close_starts_nothing() {
    let mut copy = Copy::plain();
    let (_, id) = send_now_pending(&mut copy);
    copy.host.take_notices();
    let project = copy.project.clone();
    copy.host.forget(&project, true).unwrap();
    assert_eq!(
        copy.started(),
        1,
        "a forced close started the Send-now pick"
    );
    assert!(!copy.host.is_busy(&copy.chat()));
    assert!(copy.host.active_turn(&copy.chat()).is_none());
    let notices = copy.host.take_notices();
    assert!(notices.iter().any(|n| matches!(n, Notice::QueueStarted { id: started, result } if *started == id && result.is_null())), "{notices:?}");
    // The pick is still queued on disk, and the Project can be opened again.
    copy.host.states.get(&project).unwrap();
    assert_eq!(copy.session()["queued"][0]["id"], id.as_str());
}

/// Policy review P3-3/P3-8: an end that came within the grace but wasn't handled yet counts (the tick handles events
/// before forcing), and a late start of a finished turn is dropped.
#[test]
fn a_tick_handles_events_before_forcing() {
    let mut copy = Copy::plain();
    let turn = copy.send("one", "c1", json!({})).unwrap().turn.unwrap();
    copy.host.pump();
    let chat = copy.chat();
    copy.host.interrupt(&chat).unwrap();
    copy.kiro.emit(&chat, json!({ "type": "turn-cancelled" }));
    let now = copy.host.states.now();
    assert!(copy
        .host
        .tick(now + copy.host.interrupt_grace_ms)
        .is_empty());
    assert!(
        copy.kiro.state.lock().unwrap().closed.is_empty(),
        "a turn that ended in time was forced"
    );
    assert_eq!(copy.messages().last().unwrap()["outcome"], "cancelled");
    copy.host.take_notices();
    copy.kiro.push(ProviderEvent::Started {
        chat,
        turn,
        result: RawJson(json!({ "turnId": "late", "steered": false })),
    });
    assert_eq!(copy.host.pump().len(), 1);
    assert!(copy.host.take_notices().is_empty());
}

fn ask(copy: &mut Copy, request: &str) {
    let chat = copy.chat();
    copy.kiro.emit(
        &chat,
        json!({ "type": "question-request", "requestId": request, "questions": [{ "id": "c", "header": "C", "question": "Which?", "options": [] }] }),
    );
    assert!(copy.host.pump().is_empty());
}

fn answer(copy: &mut Copy, request: &str, body: &str) -> AnswerTicket {
    let request = json!({ "chatId": copy.chat(), "requestId": request, "answers": { "c": [body] }, "summary": body });
    copy.host.answer_question(&request).unwrap()
}

fn settlement(copy: &mut Copy, answer: AnswerId) -> Option<AnswerResult> {
    copy.host
        .take_notices()
        .into_iter()
        .find_map(|notice| match notice {
            Notice::AnswerSettled {
                answer: settled,
                result,
                ..
            } if settled == answer => Some(result),
            _ => None,
        })
}

/// Answers settle asynchronously (the provider queues them and reports back): a failure after queueing takes the
/// answers message back and is told as an error, never as success.
#[test]
fn an_answer_that_fails_after_queueing_is_taken_back() {
    let mut copy = Copy::plain();
    copy.send("one", "c1", json!({})).unwrap();
    copy.host.pump();
    ask(&mut copy, "q1");
    copy.kiro.state.lock().unwrap().fail_next_answer = Some("broken pipe".into());
    let AnswerTicket::Pending(id) = answer(&mut copy, "q1", "Red") else {
        panic!("settled at once")
    };
    assert!(
        user_bodies(&copy.messages()).contains(&"Red".to_string()),
        "the answers weren't shown first"
    );
    copy.host.take_notices();
    assert!(copy.host.pump().is_empty());
    assert_eq!(
        settlement(&mut copy, id),
        Some(AnswerResult::Failed("broken pipe".into()))
    );
    assert!(
        !user_bodies(&copy.messages()).contains(&"Red".to_string()),
        "a failed answer stayed"
    );
    // A second settlement of the same answer is dropped.
    let chat = copy.chat();
    copy.kiro.push(ProviderEvent::AnswerSettled {
        chat,
        answer: id,
        outcome: AnswerOutcome::Accepted,
    });
    assert_eq!(copy.host.pump().len(), 1);
}

fn handed(copy: &Copy) -> usize {
    copy.kiro.state.lock().unwrap().answers.len()
}

/// Delivery unknown (a host deadline, or the adapter saying so): the answers stay shown, a retry of the same request
/// in that session generation is refused before anything is shown or handed over, and a later definitive settlement
/// resolves it (taking the message back only when it proves nothing was delivered).
#[test]
fn uncertain_answers_stay_and_block_retries() {
    let mut copy = Copy::plain();
    copy.send("one", "c1", json!({})).unwrap();
    copy.host.pump();
    ask(&mut copy, "q1");
    copy.kiro.state.lock().unwrap().hold_answers = true;
    let AnswerTicket::Pending(id) = answer(&mut copy, "q1", "Red") else {
        panic!("settled at once")
    };
    copy.host.take_notices();
    // While it is on its way, the same request can't be answered again.
    let request = json!({ "chatId": copy.chat(), "requestId": "q1", "answers": { "c": ["Blue"] }, "summary": "Blue" });
    assert!(matches!(
        copy.host.answer_question(&request),
        Err(StoreError::AnswerDeliveryUnknown(_))
    ));
    let start = copy.host.states.now();
    copy.host.tick(start + copy.host.answer_grace_ms);
    assert_eq!(
        settlement(&mut copy, id),
        Some(AnswerResult::Uncertain(
            "The agent hasn't confirmed the answer.".into()
        ))
    );
    assert!(
        user_bodies(&copy.messages()).contains(&"Red".to_string()),
        "an unknown delivery was taken back"
    );
    let (shown, asked) = (copy.messages().len(), handed(&copy));
    assert!(matches!(
        copy.host.answer_question(&request),
        Err(StoreError::AnswerDeliveryUnknown(_))
    ));
    assert_eq!(
        (copy.messages().len(), handed(&copy)),
        (shown, asked),
        "a blocked retry was shown or handed over"
    );
    // The adapter later proves nothing was delivered: the answers go, and the request can be answered again.
    let chat = copy.chat();
    copy.kiro.push(ProviderEvent::AnswerSettled {
        chat: chat.clone(),
        answer: id,
        outcome: AnswerOutcome::NotWaiting,
    });
    assert!(copy.host.pump().is_empty());
    let notices = copy.host.take_notices();
    assert!(notices.iter().any(|n| matches!(n, Notice::AnswerResolved { answer, result: AnswerResult::NotWaiting, .. } if *answer == id)));
    assert!(!user_bodies(&copy.messages()).contains(&"Red".to_string()));
    copy.kiro.state.lock().unwrap().hold_answers = false;
    copy.kiro.state.lock().unwrap().uncertain_next_answer = Some("pipe broke after writing".into());
    let AnswerTicket::Pending(second) = copy.host.answer_question(&request).unwrap() else {
        panic!("settled at once")
    };
    assert!(copy.host.pump().is_empty());
    assert_eq!(
        settlement(&mut copy, second),
        Some(AnswerResult::Uncertain("pipe broke after writing".into()))
    );
    assert!(user_bodies(&copy.messages()).contains(&"Blue".to_string()));
    // A late acceptance resolves it: it stays.
    copy.kiro.push(ProviderEvent::AnswerSettled {
        chat: chat.clone(),
        answer: second,
        outcome: AnswerOutcome::Accepted,
    });
    assert!(copy.host.pump().is_empty());
    assert!(copy.host.take_notices().iter().any(|n| matches!(
        n,
        Notice::AnswerResolved {
            result: AnswerResult::Accepted,
            ..
        }
    )));
    assert!(user_bodies(&copy.messages()).contains(&"Blue".to_string()));
}

/// A session generation that closes with an answer on its way (forced end, exit): its delivery is unknown, the
/// answers stay, and nothing stays blocked (that session is gone; a new one has no such request).
#[test]
fn a_closing_session_leaves_answers_uncertain_and_unblocked() {
    let mut copy = Copy::plain();
    copy.send("one", "c1", json!({})).unwrap();
    copy.host.pump();
    ask(&mut copy, "q1");
    copy.kiro.state.lock().unwrap().hold_answers = true;
    let AnswerTicket::Pending(id) = answer(&mut copy, "q1", "Red") else {
        panic!("settled at once")
    };
    copy.host.take_notices();
    let chat = copy.chat();
    let turn = copy.host.active_turn(&chat).unwrap();
    copy.kiro.push(ProviderEvent::Exited {
        chat: chat.clone(),
        turn,
        error: ProviderError::new(ProviderErrorKind::Exited, "kiro-cli exited"),
    });
    assert!(copy.host.pump().is_empty());
    assert_eq!(
        settlement(&mut copy, id),
        Some(AnswerResult::Uncertain("kiro-cli exited".into()))
    );
    assert!(user_bodies(&copy.messages()).contains(&"Red".to_string()));
    // No live session: an answer settles `false` at once, unblocked.
    assert_eq!(
        answer(&mut copy, "q1", "Green"),
        AnswerTicket::Settled(false)
    );
}

/// The raw boundary: provider JSON is encoded once, so a real U+10FFFE, the `undefined` marker's text and a PUA
/// character after U+10FFFE come back exactly as the provider sent them.
#[test]
fn provider_strings_cross_the_boundary_once() {
    let mut copy = Copy::plain();
    copy.send("one", "c1", json!({})).unwrap();
    copy.host.pump();
    let chat = copy.chat();
    let marker = "\u{10FFFE}\u{0}undefined";
    let tricky = format!("a\u{10FFFE}\u{F0001}b {marker}");
    copy.kiro.emit(
        &chat,
        json!({ "type": "session-started", "nativeId": "native" }),
    );
    copy.kiro.emit(&chat, json!({ "type": "subagent-update", "agent": { "id": "s1", "title": marker, "status": "running", "startedAt": 1, "updatedAt": 1, "transcript": [] } }));
    copy.kiro
        .emit(&chat, json!({ "type": "text-delta", "text": tricky }));
    copy.kiro.emit(&chat, json!({ "type": "turn-completed" }));
    assert!(copy.host.pump().is_empty());
    let last = copy.messages().last().cloned().unwrap();
    assert_eq!(RawJson::decode(&last["body"]).unwrap().0, json!(tricky));
    let title = copy.session()["subagents"][0]["title"].clone();
    assert!(
        !jsjson::is_undefined(&title),
        "a provider string was read as undefined"
    );
    assert_eq!(RawJson::decode(&title).unwrap().0, json!(marker));
    // And on disk: read back from a fresh open, the same strings.
    let project = copy.project.clone();
    copy.host.states.flush(Some(&project)).unwrap();
    let text = jsjson::to_string(&copy.host.states.current(&project).unwrap().to_value());
    let reread = jsjson::parse(&text).unwrap();
    let body = reread["messages"].as_array().unwrap().last().unwrap()["body"].clone();
    assert_eq!(RawJson::decode(&body).unwrap().0, json!(tricky));
}

/// Remote re-review P2-1: a turn end handled while a quit is checked waits; when the quit is refused (another turn
/// still runs), that Chat's queue moves on.
#[test]
fn a_refused_quit_moves_deferred_queues_on() {
    let mut copy = Copy::new(
        json!({ "1": { "id": 1, "worktree_id": 1 }, "2": { "id": 2, "worktree_id": 1 } }),
        json!([]),
    );
    let path = copy.path();
    let other = format!("{path}#2");
    copy.send("one", "c1", json!({})).unwrap();
    copy.send("long", "c9", json!({ "sessionId": 2 })).unwrap();
    copy.host.pump();
    copy.native();
    copy.send("next", "c2", json!({})).unwrap();
    assert_eq!(copy.started(), 2);
    // Chat 1's end waits in the provider's events; Chat 2 keeps running.
    let chat = copy.chat();
    copy.kiro.emit(&chat, json!({ "type": "turn-completed" }));
    let error = copy.host.shutdown(false).unwrap_err().to_string();
    assert!(error.contains("suspend and resume"), "{error}");
    assert_eq!(
        copy.started(),
        3,
        "the queue behind the ended turn didn't move on"
    );
    assert!(copy.host.active_turn(&chat).is_some());
    assert!(copy.host.active_turn(&other).is_some());
    // The host runs on: sends are taken again.
    copy.send("more", "c3", json!({})).unwrap();
}

/// Remote re-review P3: a forced close holds the queue it left (no auto-send once reopened), and a summary past the
/// bound is refused before anything is shown.
#[test]
fn a_forced_close_holds_and_summaries_are_bounded() {
    let mut copy = Copy::plain();
    copy.send("one", "c1", json!({})).unwrap();
    copy.host.pump();
    copy.native();
    copy.send("two", "c2", json!({})).unwrap();
    let project = copy.project.clone();
    copy.host.forget(&project, true).unwrap();
    copy.host.states.get(&project).unwrap();
    assert_eq!(copy.session()["queueHeld"], true);

    let mut copy = Copy::plain();
    copy.send("one", "c1", json!({})).unwrap();
    copy.host.pump();
    let before = copy.messages().len();
    let summary = "x".repeat(milagre_owner_store::chat_host::MAX_ANSWER_SUMMARY + 1);
    let request = json!({ "chatId": copy.chat(), "requestId": "q1", "answers": { "c": ["x"] }, "summary": summary });
    let error = copy.host.answer_question(&request).unwrap_err().to_string();
    assert!(error.contains("summary is longer"), "{error}");
    assert_eq!(copy.messages().len(), before);
}

/// A Copy whose Chat runs on Claude (which can steer), with steering recorded.
fn claude_copy(mode: SteeringMode) -> (Copy, MockProvider) {
    let mut copy = Copy::plain();
    let claude = MockProvider::sharing("claude", &copy.kiro);
    copy.host.register(Box::new(claude.clone()));
    copy.host.steering = mode;
    copy.send("one", "c1", json!({ "provider": "claude" }))
        .unwrap();
    copy.host.pump();
    let chat = copy.chat();
    claude.emit(
        &chat,
        json!({ "type": "session-started", "nativeId": "native-c" }),
    );
    claude.emit(&chat, json!({ "type": "text-delta", "text": "Working." }));
    assert!(copy.host.pump().is_empty());
    (copy, claude)
}

/// Steering admission: production refuses it; recorded, a steer is saved and split as Node does, tells the request,
/// keeps the running turn (no provider call, no new turn, same generation) and is refused while quitting or closing.
#[test]
fn steering_is_gated_or_recorded_never_sent() {
    let (mut gated, _) = claude_copy(SteeringMode::Gated);
    let error = gated
        .send("steer", "c2", json!({ "provider": "claude" }))
        .unwrap_err()
        .to_string();
    assert!(error.contains("Steering a running turn"), "{error}");

    let (mut copy, claude) = claude_copy(SteeringMode::Recorded);
    let chat = copy.chat();
    let running = copy.host.active_turn(&chat).unwrap();
    copy.host.take_notices();
    let sent = copy
        .send(
            "steer",
            "c2",
            json!({ "provider": "codex", "model": "other" }),
        )
        .unwrap();
    assert!(sent.steering && sent.turn == Some(running));
    assert_eq!(copy.started(), 1, "a steer reached a provider");
    assert_eq!(copy.host.active_turn(&chat), Some(running));
    let notices = copy.host.take_notices();
    let request = notices
        .iter()
        .find_map(|n| match n {
            Notice::SteerRequested { turn, request, .. } if *turn == running => {
                Some(request.clone())
            }
            _ => None,
        })
        .expect("the steer was told");
    assert_eq!(request["provider"], "claude");
    assert_eq!(request["model"], "m");
    assert_eq!(request["prompt"], "steer");
    // The reply so far sits above the steering message; the run goes on, steered.
    let bodies: Vec<String> = copy
        .messages()
        .iter()
        .map(|m| m["body"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(bodies, ["one", "Working.", "steer"]);
    assert_eq!(copy.host.runs()[&chat]["steered"], true);
    assert_eq!(copy.session()["provider"], "claude");
    // The running turn's events still fold, and its end ends it.
    claude.emit(&chat, json!({ "type": "text-delta", "text": "Steered." }));
    claude.emit(&chat, json!({ "type": "turn-completed" }));
    assert!(copy.host.pump().is_empty());
    assert!(!copy.host.is_busy(&chat));
    assert_eq!(copy.messages().last().unwrap()["body"], "Steered.");

    // Send now into a turn that can steer stays gated.
    copy.send("two", "c3", json!({ "provider": "claude" }))
        .unwrap();
    copy.host.pump();
    let queued = copy
        .send(
            "three",
            "c4",
            json!({ "provider": "claude", "delivery": "queue" }),
        )
        .unwrap();
    assert!(queued.queued);
    let id = copy.session()["queued"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let error = copy
        .host
        .send_queued_now(&chat, &id)
        .unwrap_err()
        .to_string();
    assert!(error.contains("running turn that can steer"), "{error}");

    // No steer while closing or quitting.
    copy.host.shutdown(true).unwrap();
    let error = copy
        .send("late", "c5", json!({ "provider": "claude" }))
        .unwrap_err()
        .to_string();
    assert!(error.contains("quitting"), "{error}");
}

/// Answer slots: answers on their way and answers with an unknown delivery share one capacity. At capacity a new
/// answer is refused before anything is shown or handed over; the oldest uncertain answer stays blocked (never
/// evicted); only a definitive settlement or the generation closing frees a slot.
#[test]
fn answer_slots_are_reserved_and_never_evicted() {
    let mut copy = Copy::plain();
    copy.host.answer_capacity = 2;
    copy.send("one", "c1", json!({})).unwrap();
    copy.host.pump();
    for request in ["q1", "q2", "q3"] {
        ask(&mut copy, request);
    }
    copy.kiro.state.lock().unwrap().hold_answers = true;
    let AnswerTicket::Pending(first) = answer(&mut copy, "q1", "Red") else {
        panic!("settled at once")
    };
    let AnswerTicket::Pending(_) = answer(&mut copy, "q2", "Blue") else {
        panic!("settled at once")
    };
    let start = copy.host.states.now();
    copy.host.tick(start + copy.host.answer_grace_ms);
    assert_eq!(
        copy.host.answers_in_flight(),
        2,
        "uncertain answers gave their slots back"
    );
    let (shown, asked) = (copy.messages().len(), handed(&copy));
    let third = json!({ "chatId": copy.chat(), "requestId": "q3", "answers": { "c": ["Green"] }, "summary": "Green" });
    assert!(matches!(
        copy.host.answer_question(&third),
        Err(StoreError::AnswersAtCapacity(_))
    ));
    let permission = json!({ "chatId": copy.chat(), "requestId": "p1", "decision": "allow" });
    assert!(matches!(
        copy.host.respond_permission(&permission),
        Err(StoreError::AnswersAtCapacity(_))
    ));
    assert_eq!(
        (copy.messages().len(), handed(&copy)),
        (shown, asked),
        "a refused answer was shown or handed over"
    );
    // The oldest stays blocked.
    let retry = json!({ "chatId": copy.chat(), "requestId": "q1", "answers": { "c": ["Red"] }, "summary": "Red" });
    assert!(matches!(
        copy.host.answer_question(&retry),
        Err(StoreError::AnswerDeliveryUnknown(_))
    ));
    // A definitive settlement frees its slot.
    let chat = copy.chat();
    copy.kiro.push(ProviderEvent::AnswerSettled {
        chat: chat.clone(),
        answer: first,
        outcome: AnswerOutcome::NotWaiting,
    });
    assert!(copy.host.pump().is_empty());
    assert_eq!(copy.host.answers_in_flight(), 1);
    let AnswerTicket::Pending(_) = copy.host.answer_question(&third).unwrap() else {
        panic!("settled at once")
    };
    assert_eq!(copy.host.answers_in_flight(), 2);
    // The generation closing frees every slot it held; the answers shown stay.
    copy.host.interrupt(&chat).unwrap();
    let now = copy.host.states.now();
    copy.host.tick(now + copy.host.interrupt_grace_ms);
    assert_eq!(copy.host.answers_in_flight(), 0);
    let bodies = user_bodies(&copy.messages());
    assert!(bodies.contains(&"Blue".to_string()) && bodies.contains(&"Green".to_string()));
    assert!(
        !bodies.contains(&"Red".to_string()),
        "a proven non-delivery stayed shown"
    );
}

/// More generations than slots, each closing with an uncertain answer: nothing leaks, each is admitted.
#[test]
fn closed_generations_leak_no_answer_slots() {
    let mut copy = Copy::plain();
    copy.host.answer_capacity = 2;
    let chat = copy.chat();
    for round in 0..5 {
        copy.send(&format!("turn {round}"), &format!("c{round}"), json!({}))
            .unwrap();
        copy.host.pump();
        if round == 0 {
            copy.native();
        }
        ask(&mut copy, "q");
        copy.kiro.state.lock().unwrap().uncertain_next_answer = Some("no confirmation".into());
        let AnswerTicket::Pending(_) = answer(&mut copy, "q", &format!("answer {round}")) else {
            panic!("round {round}: not admitted")
        };
        assert!(copy.host.pump().is_empty());
        assert_eq!(copy.host.answers_in_flight(), 1);
        copy.host.interrupt(&chat).unwrap();
        let now = copy.host.states.now();
        copy.host.tick(now + copy.host.interrupt_grace_ms);
        assert_eq!(
            copy.host.answers_in_flight(),
            0,
            "round {round}: a closed generation kept its slot"
        );
    }
}

/// Every owner caller gets the answer codes from `StoreError::code`, matching the constants the contract names.
#[test]
fn answer_errors_carry_their_codes() {
    use milagre_owner_store::chat_host::{ANSWERS_AT_CAPACITY, ANSWER_DELIVERY_UNKNOWN};
    let mut copy = Copy::plain();
    copy.host.answer_capacity = 1;
    copy.send("one", "c1", json!({})).unwrap();
    copy.host.pump();
    ask(&mut copy, "q1");
    ask(&mut copy, "q2");
    copy.kiro.state.lock().unwrap().hold_answers = true;
    let AnswerTicket::Pending(_) = answer(&mut copy, "q1", "Red") else {
        panic!("settled at once")
    };
    let retry = json!({ "chatId": copy.chat(), "requestId": "q1", "answers": { "c": ["Red"] }, "summary": "Red" });
    let blocked = copy.host.answer_question(&retry).unwrap_err();
    assert_eq!(blocked.code(), Some(ANSWER_DELIVERY_UNKNOWN));
    let other = json!({ "chatId": copy.chat(), "requestId": "q2", "answers": { "c": ["Blue"] }, "summary": "Blue" });
    let full = copy.host.answer_question(&other).unwrap_err();
    assert_eq!(full.code(), Some(ANSWERS_AT_CAPACITY));
    assert_eq!(StoreError::Invalid("x".into()).code(), None);
}

/// Handlers-answers review P2-1: a request lives in its turn. Over more turns than slots in one reused session, with
/// answers that never settle, each turn's end releases its slots (the answers stay shown, uncertain); a late
/// settlement still resolves them; a retry is blocked while its turn runs and goes to the provider after.
#[test]
fn answer_slots_follow_their_turn_in_a_reused_session() {
    let mut copy = Copy::plain();
    copy.host.answer_capacity = 32;
    let chat = copy.chat();
    let mut first = None;
    for round in 0..40 {
        copy.send(&format!("turn {round}"), &format!("c{round}"), json!({}))
            .unwrap();
        copy.host.pump();
        if round == 0 {
            copy.native();
        }
        ask(&mut copy, "q");
        copy.kiro.state.lock().unwrap().hold_answers = true;
        let AnswerTicket::Pending(id) = answer(&mut copy, "q", &format!("answer {round}")) else {
            panic!("round {round}: not admitted")
        };
        first.get_or_insert(id);
        let retry = json!({ "chatId": chat, "requestId": "q", "answers": { "c": ["again"] }, "summary": "again" });
        assert!(matches!(
            copy.host.answer_question(&retry),
            Err(StoreError::AnswerDeliveryUnknown(_))
        ));
        copy.end("turn-completed");
        assert_eq!(
            copy.host.answers_in_flight(),
            0,
            "round {round}: an ended turn kept its answer slot"
        );
    }
    assert!(
        user_bodies(&copy.messages()).contains(&"answer 0".to_string()),
        "an uncertain answer was taken back"
    );
    // A late settlement of the first turn's answer still resolves it: proven undelivered, it goes.
    copy.host.take_notices();
    copy.kiro.push(ProviderEvent::AnswerSettled {
        chat: chat.clone(),
        answer: first.unwrap(),
        outcome: AnswerOutcome::NotWaiting,
    });
    assert!(copy.host.pump().is_empty());
    assert!(copy.host.take_notices().iter().any(|n| matches!(
        n,
        Notice::AnswerResolved {
            result: AnswerResult::NotWaiting,
            ..
        }
    )));
    assert!(!user_bodies(&copy.messages()).contains(&"answer 0".to_string()));
    // After its turn, a request can be answered again: the provider (not a stale slot) says whether anything waits.
    copy.send("turn 40", "c40", json!({})).unwrap();
    copy.host.pump();
    copy.kiro.state.lock().unwrap().hold_answers = false;
    let asked = handed(&copy);
    let AnswerTicket::Pending(_) = answer(&mut copy, "q", "late retry") else {
        panic!("not admitted")
    };
    assert_eq!(handed(&copy), asked + 1);
    // An exit naming the session's latest turn releases what that session still held.
    copy.kiro.state.lock().unwrap().hold_answers = true;
    ask(&mut copy, "q2");
    let AnswerTicket::Pending(_) = answer(&mut copy, "q2", "held") else {
        panic!("not admitted")
    };
    let turn = copy.host.active_turn(&chat).unwrap();
    copy.kiro.push(ProviderEvent::Exited {
        chat: chat.clone(),
        turn,
        error: ProviderError::new(ProviderErrorKind::Exited, "exited"),
    });
    assert!(copy.host.pump().is_empty());
    assert_eq!(copy.host.answers_in_flight(), 0);
    // With no turn running, nothing waits: an answer settles false at once.
    assert_eq!(
        answer(&mut copy, "q2", "idle"),
        AnswerTicket::Settled(false)
    );
}

/// Handlers-answers review P3: provider error text enters the owner's encoding once (an immediate start refusal, an
/// interrupt error), and what the owner hands a provider is plain text (a real U+10FFFE single, an unpaired
/// surrogate from a JavaScript client as U+FFFD).
#[test]
fn provider_text_crosses_both_ways_once() {
    let tricky = "a\u{10FFFE}\u{F0001}b";
    let mut copy = Copy::plain();
    copy.kiro.state.lock().unwrap().refuse_next_start = Some(format!("refused {tricky}"));
    copy.send("one", "c1", json!({})).unwrap();
    let last = copy.messages().last().cloned().unwrap();
    assert_eq!(
        RawJson::decode(&last["body"]).unwrap().0,
        json!(format!("Agent error: refused {tricky}"))
    );

    let request = jsjson::parse(r#"{"body":"x","prompt":"cut \ud83d and 􏿾"}"#).unwrap();
    let mut send = json!({ "projectPath": copy.path(), "sessionId": 1, "provider": "kiro", "model": "m", "clientMessageId": "c2" });
    send["body"] = request["body"].clone();
    send["prompt"] = request["prompt"].clone();
    copy.host.send(&send).unwrap();
    let handed_prompt = copy.kiro.state.lock().unwrap().turns.last().unwrap()["prompt"].clone();
    assert_eq!(handed_prompt, json!("cut \u{FFFD} and \u{10FFFE}"));

    copy.host.pump();
    copy.kiro.state.lock().unwrap().fail_next_interrupt = Some(format!("no {tricky}"));
    let error = copy.host.interrupt(&copy.chat()).unwrap_err().to_string();
    assert_eq!(
        RawJson::decode(&json!(error)).unwrap().0,
        json!(format!("no {tricky}"))
    );
}

/// Outbound identities are strict: request ids, question ids and every non-text field are decoded exactly or refused
/// (two different half-surrogate ids would otherwise both become U+FFFD and alias each other, or a real U+FFFD id).
/// Only free text (the prompt, answer strings) is decoded lossily, and only on the way out: what is saved keeps it.
#[test]
fn outbound_identities_are_strict_and_free_text_lossy() {
    let mut copy = Copy::plain();
    copy.send("one", "c1", json!({})).unwrap();
    copy.host.pump();
    copy.native();
    let chat = copy.chat();
    let wire = |text: &str| jsjson::parse(text).unwrap();
    // Two different half-surrogate request ids, and a real U+FFFD one.
    for (id, real) in [
        (r#""p\ud800""#, false),
        (r#""p\ud801""#, false),
        (r#""p�""#, true),
    ] {
        let request_id = wire(id);
        copy.kiro.emit(&chat, json!({ "type": "question-request", "requestId": RawJson::decode(&request_id).ok().map(|raw| raw.0).unwrap_or(json!("x")), "questions": [] }));
        copy.host.pump();
        copy.host.take_notices();
        let before = (copy.messages().len(), handed(&copy));
        let result = copy.host.answer_question(&json!({ "chatId": chat, "requestId": request_id, "answers": { "c": ["Yes"] }, "summary": "Yes" }));
        if real {
            assert!(matches!(result, Ok(AnswerTicket::Pending(_))), "{result:?}");
            let given =
                copy.kiro.state.lock().unwrap().answers.last().unwrap()["requestId"].clone();
            assert_eq!(given, json!("p\u{FFFD}"));
        } else {
            let error = result.unwrap_err().to_string();
            assert!(error.contains("unpaired UTF-16 surrogate"), "{error}");
            assert_eq!(
                (copy.messages().len(), handed(&copy)),
                before,
                "a refused identity was shown or handed over"
            );
            let notices = copy.host.take_notices();
            assert!(
                !notices.iter().any(
                    |n| matches!(n, Notice::Event { event, .. } if event["type"] == "answers-sent")
                        || matches!(n, Notice::Broadcast { .. })
                ),
                "a refused identity was shown first: {notices:?}"
            );
        }
        copy.host.pump();
        let permission = copy.host.respond_permission(
            &json!({ "chatId": chat, "requestId": wire(id), "decision": "allow" }),
        );
        assert_eq!(permission.is_ok(), real, "{id}: {permission:?}");
        copy.host.pump();
        copy.host.take_notices();
    }
    // A half-surrogate question id (an answers key) is refused too; answer text is lossy.
    let answers = wire(r#"{ "q\udc00": ["fine"] }"#);
    let error = copy
        .host
        .answer_question(
            &json!({ "chatId": chat, "requestId": "k1", "answers": answers, "summary": "fine" }),
        )
        .unwrap_err();
    assert!(error.to_string().contains("unpaired UTF-16 surrogate"));
    let answers = wire(r#"{ "q": ["half \ud83d here"] }"#);
    let AnswerTicket::Pending(_) = copy
        .host
        .answer_question(
            &json!({ "chatId": chat, "requestId": "k2", "answers": answers, "summary": "s" }),
        )
        .unwrap()
    else {
        panic!("settled at once")
    };
    assert_eq!(
        copy.kiro.state.lock().unwrap().answers.last().unwrap()["answers"],
        json!({ "q": ["half \u{FFFD} here"] })
    );
    copy.end("turn-completed");

    // The prompt goes out lossy, and is saved exactly.
    let body = wire(r#""cut \ud83d""#);
    copy.host.send(&json!({ "projectPath": copy.path(), "sessionId": 1, "provider": "kiro", "model": "m", "body": body, "clientMessageId": "c2" })).unwrap();
    assert_eq!(
        copy.kiro.state.lock().unwrap().turns.last().unwrap()["prompt"],
        json!("cut \u{FFFD}")
    );
    let saved = copy
        .messages()
        .iter()
        .rev()
        .find(|m| m["role"] == "user")
        .unwrap()["body"]
        .clone();
    assert_eq!(
        jsjson::to_utf16(saved.as_str().unwrap()).last(),
        Some(&0xD83D),
        "the saved text lost its half surrogate"
    );
    copy.host.pump();
    copy.end("turn-completed");

    // An identity in the turn's request (the model) holding one: the turn fails before any provider is asked.
    let started = copy.started();
    let model = wire(r#""m\ud83d""#);
    copy.host.send(&json!({ "projectPath": copy.path(), "sessionId": 1, "provider": "kiro", "model": model, "body": "x", "clientMessageId": "c3" })).unwrap();
    assert_eq!(
        copy.started(),
        started,
        "a refused identity reached the provider"
    );
    let last = copy.messages().last().cloned().unwrap();
    assert_eq!(last["outcome"], "failed");
    assert!(last["body"]
        .as_str()
        .unwrap()
        .contains("unpaired UTF-16 surrogate"));
}

/// Rollback of folds that change the state and the run together: when the change can't be kept (a load or settle
/// failing after the fold ran), the run is byte-for-byte what it was, nothing is told, and the turn end is kept to fold
/// again. Covers the three turn ends and a steered step split; run-only events can't fail after changing the run.
#[test]
fn a_mixed_fold_that_fails_leaves_the_run_as_it_was() {
    for end in ["turn-completed", "turn-cancelled", "turn-failed"] {
        let mut copy = Copy::plain();
        copy.send("one", "c1", json!({})).unwrap();
        copy.host.pump();
        let chat = copy.chat();
        copy.kiro
            .emit(&chat, json!({ "type": "text-delta", "text": "partial" }));
        copy.kiro.emit(&chat, json!({ "type": "step-started", "step": { "id": "s1", "kind": "shell", "title": "Run", "detail": "$ x\n" } }));
        copy.kiro.emit(
            &chat,
            json!({ "type": "step-completed", "id": "s1", "status": "done" }),
        );
        assert!(copy.host.pump().is_empty());
        copy.host.take_notices();
        let runs = jsjson::to_string(&Value::Object(copy.host.runs().clone()));
        let state = copy.host.states.current(&copy.project).unwrap().to_value();
        copy.host.states.fail_next_commit("injected");
        copy.kiro
            .emit(&chat, json!({ "type": end, "message": "x" }));
        assert_eq!(copy.host.pump().len(), 1, "{end}");
        assert_eq!(
            jsjson::to_string(&Value::Object(copy.host.runs().clone())),
            runs,
            "{end}: the run changed"
        );
        assert_eq!(
            copy.host.states.current(&copy.project).unwrap().to_value(),
            state,
            "{end}: the state changed"
        );
        assert!(
            copy.host.take_notices().is_empty(),
            "{end}: a failed fold was told"
        );
        assert_eq!(copy.host.stuck_ends(), std::slice::from_ref(&chat), "{end}");
        // The kept end folds once the change can be kept.
        assert!(copy.host.pump().is_empty(), "{end}");
        assert!(
            copy.host.runs().is_empty() && copy.host.stuck_ends().is_empty(),
            "{end}"
        );
    }

    // A steered step split (the reply so far saved as its own message, the run split).
    let (mut copy, claude) = claude_copy(SteeringMode::Recorded);
    let chat = copy.chat();
    copy.send("steer", "c2", json!({ "provider": "claude" }))
        .unwrap();
    claude.emit(&chat, json!({ "type": "text-delta", "text": "Sure." }));
    assert!(copy.host.pump().is_empty());
    let runs = jsjson::to_string(&Value::Object(copy.host.runs().clone()));
    let messages = copy.messages().len();
    copy.host.states.fail_next_commit("injected");
    claude.emit(
        &chat,
        json!({ "type": "step-started", "step": { "id": "s2", "kind": "read", "title": "Read" } }),
    );
    assert_eq!(copy.host.pump().len(), 1);
    assert_eq!(
        jsjson::to_string(&Value::Object(copy.host.runs().clone())),
        runs,
        "the steered run changed"
    );
    assert_eq!(copy.messages().len(), messages);
}

/// A quit whose final save fails: `shutdown` returns the error and the host stays quitting (sends refused, providers
/// shut down once); the change and the lock are kept; calling `shutdown` again retries the save and the close only.
#[test]
fn a_failed_close_keeps_the_host_quitting_until_a_retry_saves() {
    let mut copy = Copy::plain();
    copy.send("one", "c1", json!({})).unwrap();
    copy.host.pump();
    copy.kiro.emit(
        &copy.chat(),
        json!({ "type": "text-delta", "text": "unsaved reply" }),
    );
    copy.end("turn-completed");
    let milagre = copy.project.join(".milagre");
    std::fs::set_permissions(&milagre, std::fs::Permissions::from_mode(0o555)).unwrap();
    let failed = copy.host.shutdown(false);
    std::fs::set_permissions(&milagre, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(failed.is_err(), "the save should have failed");
    assert!(copy.host.is_quitting());
    assert!(copy.host.close_pending(), "a retry is owed");
    let error = copy.send("two", "c2", json!({})).unwrap_err().to_string();
    assert!(error.contains("quitting"), "{error}");
    assert_eq!(copy.kiro.state.lock().unwrap().shutdowns, 1);
    assert!(
        ownership::project_lock(&copy.project).exists(),
        "the lock went before the save"
    );
    // The retry saves and closes; providers aren't shut down twice.
    copy.host.shutdown(false).unwrap();
    assert!(!copy.host.close_pending());
    assert_eq!(copy.kiro.state.lock().unwrap().shutdowns, 1);
    assert!(!ownership::project_lock(&copy.project).exists());
    let saved = std::fs::read(copy.project.join(".milagre/chats.db")).unwrap_or_default();
    let coordination =
        std::fs::read_to_string(copy.project.join(".milagre/coordination.json")).unwrap();
    assert!(
        String::from_utf8_lossy(&saved).contains("unsaved reply")
            || coordination.contains("unsaved reply"),
        "the retried close didn't save the reply"
    );
}

/// The history of released answers is bounded and its eviction is told: the oldest goes first, as
/// `Notice::AnswerForgotten`; a late settlement of it is no longer taken and its message stays.
#[test]
fn answer_history_eviction_is_told() {
    let mut copy = Copy::plain();
    copy.host.answer_history = 2;
    let chat = copy.chat();
    let mut ids = Vec::new();
    for round in 0..3 {
        copy.send(&format!("turn {round}"), &format!("c{round}"), json!({}))
            .unwrap();
        copy.host.pump();
        if round == 0 {
            copy.native();
        }
        ask(&mut copy, "q");
        copy.kiro.state.lock().unwrap().hold_answers = true;
        let AnswerTicket::Pending(id) = answer(&mut copy, "q", &format!("answer {round}")) else {
            panic!("not admitted")
        };
        ids.push(id);
        copy.host.take_notices();
        copy.end("turn-completed");
        let forgotten: Vec<AnswerId> = copy
            .host
            .take_notices()
            .into_iter()
            .filter_map(|n| match n {
                Notice::AnswerForgotten { answer, .. } => Some(answer),
                _ => None,
            })
            .collect();
        assert_eq!(
            forgotten,
            if round == 2 { vec![ids[0]] } else { vec![] },
            "round {round}"
        );
    }
    copy.kiro.push(ProviderEvent::AnswerSettled {
        chat: chat.clone(),
        answer: ids[0],
        outcome: AnswerOutcome::NotWaiting,
    });
    assert_eq!(
        copy.host.pump().len(),
        1,
        "a forgotten answer's settlement was taken"
    );
    assert!(user_bodies(&copy.messages()).contains(&"answer 0".to_string()));
    // The two kept ones still resolve.
    copy.kiro.push(ProviderEvent::AnswerSettled {
        chat,
        answer: ids[1],
        outcome: AnswerOutcome::NotWaiting,
    });
    assert!(copy.host.pump().is_empty());
    assert!(!user_bodies(&copy.messages()).contains(&"answer 1".to_string()));
}

/// An answer still on its way when its turn ends is told `Uncertain` then; the provider's acceptance a moment later is
/// told as `AnswerResolved { Accepted }`, after it, and the answers stay shown.
#[test]
fn uncertain_at_turn_end_then_late_accepted_is_told_in_order() {
    let mut copy = Copy::plain();
    copy.send("one", "c1", json!({})).unwrap();
    copy.host.pump();
    ask(&mut copy, "q");
    copy.kiro.state.lock().unwrap().hold_answers = true;
    let AnswerTicket::Pending(id) = answer(&mut copy, "q", "Red") else {
        panic!("not admitted")
    };
    copy.host.take_notices();
    let chat = copy.chat();
    copy.kiro.emit(&chat, json!({ "type": "turn-completed" }));
    copy.kiro.push(ProviderEvent::AnswerSettled {
        chat,
        answer: id,
        outcome: AnswerOutcome::Accepted,
    });
    assert!(copy.host.pump().is_empty());
    let told: Vec<String> = copy
        .host
        .take_notices()
        .into_iter()
        .filter_map(|n| match n {
            Notice::AnswerSettled { answer, result, .. } if answer == id => {
                Some(format!("settled {result:?}"))
            }
            Notice::AnswerResolved { answer, result, .. } if answer == id => {
                Some(format!("resolved {result:?}"))
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        told,
        [
            "settled Uncertain(\"The turn ended before the agent confirmed the answer.\")"
                .to_string(),
            "resolved Accepted".to_string()
        ]
    );
    assert!(user_bodies(&copy.messages()).contains(&"Red".to_string()));
}

/// A quit refused for a running turn shuts nothing down; the forced quit after it shuts the providers down once and
/// finishes (no close owed).
#[test]
fn a_refused_quit_then_a_forced_quit_shuts_providers_down_once() {
    let mut copy = Copy::plain();
    copy.send("one", "c1", json!({})).unwrap();
    copy.host.pump();
    assert!(
        copy.host.shutdown(false).is_err(),
        "a running turn refuses the quit"
    );
    assert!(!copy.host.is_quitting());
    assert!(!copy.host.close_pending());
    assert_eq!(copy.kiro.state.lock().unwrap().shutdowns, 0);
    copy.host.shutdown(true).unwrap();
    assert_eq!(copy.kiro.state.lock().unwrap().shutdowns, 1);
    assert!(copy.host.is_quitting());
    assert!(!copy.host.close_pending());
    copy.host.shutdown(true).unwrap();
    assert_eq!(copy.kiro.state.lock().unwrap().shutdowns, 1);
}

/// A Project whose folder was moved away and replaced by a link can't release its lock on quit: the lock stays in the
/// moved folder, the quit's close fails, and the next take of notices tells the stranded lock (never a token).
#[test]
fn a_lock_left_by_a_replaced_root_is_told() {
    let mut copy = Copy::plain();
    copy.send("one", "c1", json!({})).unwrap();
    copy.host.pump();
    copy.end("turn-completed");
    copy.host.states.flush(Some(&copy.project)).unwrap();
    copy.host.take_notices();
    let moved = copy.project.with_file_name("moved-away");
    std::fs::rename(&copy.project, &moved).unwrap();
    std::os::unix::fs::symlink(&moved, &copy.project).unwrap();
    let token = std::fs::read_to_string(moved.join(".milagre/runtime.lock/owner.json")).unwrap();
    assert!(copy.host.shutdown(false).is_err());
    let stranded: Vec<(String, String)> = copy
        .host
        .take_notices()
        .into_iter()
        .filter_map(|notice| match notice {
            Notice::LockStranded { lock, why } => Some((lock, why)),
            _ => None,
        })
        .collect();
    assert_eq!(stranded.len(), 1, "{stranded:?}");
    assert!(stranded[0].1.contains("Project folder"), "{stranded:?}");
    let record: serde_json::Value = serde_json::from_str(&token).unwrap();
    let token = record["token"].as_str().unwrap();
    assert!(!stranded[0].0.contains(token) && !stranded[0].1.contains(token));
    assert!(
        moved.join(".milagre/runtime.lock/owner.json").exists(),
        "the moved lock was removed"
    );
    assert!(
        copy.host
            .take_notices()
            .iter()
            .all(|n| !matches!(n, Notice::LockStranded { .. })),
        "told once"
    );
    std::fs::remove_file(&copy.project).unwrap();
    std::fs::rename(&moved, &copy.project).unwrap();
}

//! Lifecycle of access-policy checks that run off the session lock. A test policy blocks on an
//! explicit gate, so each race is forced in order rather than timed: turn rollover, mode
//! downgrade/upgrade and Ask -> Full -> Ask, withdrawal saturation, close while blocked and a
//! panicking policy in Full. The fake CLI asserts every reply.
mod common;

use common::*;
use milagre_claude::session::{
    AccessDecision, AccessPolicy, ClaudeSession, SessionEvents, SessionOptions, TurnRequest, ACCESS_FAILED_MESSAGE,
};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

#[derive(Clone)]
enum Step {
    Allow,
    Deny(&'static str),
    Pass,
    Panic,
}

/// Answers from `steps` in order (then `Pass`), each call first waiting for the gate to open.
struct GatedPolicy {
    steps: Mutex<VecDeque<Step>>,
    open: Mutex<bool>,
    opened: Condvar,
    entered: AtomicUsize,
    finished: AtomicUsize,
}

impl GatedPolicy {
    fn new(steps: Vec<Step>, open: bool) -> Arc<Self> {
        Arc::new(Self {
            steps: Mutex::new(steps.into()),
            open: Mutex::new(open),
            opened: Condvar::new(),
            entered: AtomicUsize::new(0),
            finished: AtomicUsize::new(0),
        })
    }
    fn release(&self) {
        *self.open.lock().unwrap() = true;
        self.opened.notify_all();
    }
    async fn wait_entered(&self, n: usize) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while self.entered.load(Ordering::SeqCst) < n {
            assert!(tokio::time::Instant::now() < deadline, "policy entered {} of {n}", self.entered.load(Ordering::SeqCst));
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    }
}

impl AccessPolicy for GatedPolicy {
    fn answer(&self, _kind: &str, _files: &[String], _mode: &str) -> Option<AccessDecision> {
        self.entered.fetch_add(1, Ordering::SeqCst);
        let mut open = self.open.lock().unwrap();
        while !*open {
            open = self.opened.wait(open).unwrap();
        }
        drop(open);
        let step = self.steps.lock().unwrap().pop_front().unwrap_or(Step::Pass);
        self.finished.fetch_add(1, Ordering::SeqCst);
        match step {
            Step::Allow => Some(AccessDecision::Allow { learn: vec![] }),
            Step::Deny(message) => Some(AccessDecision::Deny { message: message.into() }),
            Step::Pass => None,
            Step::Panic => panic!("policy failure under test"),
        }
    }
}

/// Opens the gate when a test ends, passing or failing, so no blocked policy thread outlives it
/// (the runtime would otherwise wait on it forever).
struct ReleaseOnDrop(Arc<GatedPolicy>);
impl Drop for ReleaseOnDrop {
    fn drop(&mut self) {
        self.0.release();
    }
}

/// Waits for `ready` at most five seconds; a timeout fails the test (the gate guard then releases
/// every blocked policy call, so no thread is left behind).
async fn wait_until(what: &str, mut ready: impl FnMut() -> bool) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while !ready() {
        assert!(tokio::time::Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
}

fn handshake() -> Vec<Value> {
    vec![
        json!({"expect":{"subtype":"initialize"}}),
        json!({"reply":{}}),
        json!({"expect":{"subtype":"set_max_thinking_tokens"}}),
        json!({"reply":{}}),
    ]
}
fn init() -> Value {
    json!({"emit":{"type":"system","subtype":"init","session_id":"s"}})
}
fn bash(id: &str) -> Value {
    json!({"request":{"id":id,"request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"},"tool_use_id":format!("tool-{id}")}}})
}
fn reply(id: &str, response: Value) -> Value {
    json!({"expect":{"type":"control_response","fields":{"/response/request_id":id,"/response/response":response}}})
}
fn mode(native: &str) -> [Value; 2] {
    [json!({"expect":{"subtype":"set_permission_mode","fields":{"/request/mode":native}}}), json!({"reply":{}})]
}
fn text(t: &str) -> Value {
    json!({"emit":{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":t}}}})
}
fn result() -> Value {
    json!({"emit":{"type":"result","subtype":"success","num_turns":1,"result":"done"}})
}
fn turn(mode: &str) -> TurnRequest {
    TurnRequest {
        model: "sonnet".into(),
        permission_mode: Some(mode.into()),
        content: vec![json!({"type":"text","text":"go"})],
        ..Default::default()
    }
}
fn open_session(
    script: Vec<Value>,
    policy: &Arc<GatedPolicy>,
    configure: impl FnOnce(&mut SessionOptions),
) -> (ClaudeSession, SessionEvents) {
    let (launch, _) = fake("access-lifecycle", Value::Array(script));
    let mut options = SessionOptions::new(launch);
    options.limits = quick_limits();
    options.access = Some(policy.clone());
    configure(&mut options);
    ClaudeSession::new(options)
}
/// Events up to `kind`; a failed turn (the fake exits 3 on an unexpected reply) fails the test.
async fn until(events: &mut SessionEvents, kind: &str, session: &ClaudeSession) -> Vec<Value> {
    let mut out = vec![];
    loop {
        let event = tokio::time::timeout(Duration::from_secs(5), events.recv()).await.expect("event timed out").expect("ended");
        assert_ne!(event["type"], "turn-failed", "{event}");
        if event["type"] == "permission-request" {
            assert!(session.respond_to_permission(event["requestId"].as_str().unwrap(), "deny"));
        }
        let done = event["type"] == kind;
        out.push(event);
        if done {
            return out;
        }
    }
}
fn cancelled() -> Value {
    json!({"behavior":"deny","message":"The turn was cancelled in Milagre.","interrupt":true})
}

/// A check begun in turn A that finishes after A ended and B started in the same mode is cancelled:
/// it neither authorizes nor publishes a card in B.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn check_from_an_ended_turn_cannot_authorize_the_next_turn() {
    let policy = GatedPolicy::new(vec![Step::Allow], false);
    let _release = ReleaseOnDrop(policy.clone());
    // Turn A ends only once its check is blocked inside the policy (file barrier written by the test).
    let blocked = scratch("access-rollover").join("blocked");
    let mut script = handshake();
    script.extend([json!({"expect":{"type":"user"}}), init(), bash("r1"), json!({"wait_file":blocked}), result()]);
    script.extend([json!({"expect":{"type":"user"}}), init(), reply("r1", cancelled()), result()]);
    let (session, mut events) = open_session(script, &policy, |_| {});
    session.start_turn(turn("ask")).await.unwrap();
    policy.wait_entered(1).await;
    std::fs::write(&blocked, b"blocked").unwrap();
    until(&mut events, "turn-completed", &session).await;
    session.start_turn(turn("ask")).await.unwrap();
    until(&mut events, "turn-started", &session).await;
    policy.release();
    let trace = until(&mut events, "turn-completed", &session).await;
    assert!(trace.iter().all(|e| e["type"] != "permission-request"), "{trace:?}");
    assert_eq!(policy.finished.load(Ordering::SeqCst), 1);
    session.close().await;
}

/// A slow mandatory Deny stands after the user switches to Full: it is not dropped into Full's allow.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deny_survives_a_switch_to_full() {
    let policy = GatedPolicy::new(vec![Step::Deny("blocked by policy")], false);
    let _release = ReleaseOnDrop(policy.clone());
    let mut script = handshake();
    script.extend([json!({"expect":{"type":"user"}}), init(), bash("r1")]);
    script.extend(mode("bypassPermissions"));
    script.extend([reply("r1", json!({"behavior":"deny","message":"blocked by policy"})), result()]);
    let (session, mut events) = open_session(script, &policy, |_| {});
    session.start_turn(turn("ask")).await.unwrap();
    policy.wait_entered(1).await;
    session.set_permission_mode("full").await;
    policy.release();
    until(&mut events, "turn-completed", &session).await;
    session.close().await;
}

/// Ask -> Full -> Ask while an Allow is pending: equal mode strings are still a change (epoch), so
/// the check runs again under the current mode; here it has no answer and the Ask card decides.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ask_full_ask_reevaluates_instead_of_reusing_a_stale_allow() {
    let policy = GatedPolicy::new(vec![Step::Allow, Step::Pass], false);
    let _release = ReleaseOnDrop(policy.clone());
    let mut script = handshake();
    script.extend([json!({"expect":{"type":"user"}}), init(), bash("r1")]);
    script.extend(mode("bypassPermissions"));
    script.extend(mode("default"));
    script.extend([reply("r1", json!({"behavior":"deny","message":"Denied in Milagre"})), result()]);
    let (session, mut events) = open_session(script, &policy, |_| {});
    session.start_turn(turn("ask")).await.unwrap();
    policy.wait_entered(1).await;
    session.set_permission_mode("full").await;
    session.set_permission_mode("ask").await;
    policy.release();
    let trace = until(&mut events, "turn-completed", &session).await;
    assert_eq!(trace.iter().filter(|e| e["type"] == "permission-request").count(), 1);
    assert_eq!(policy.finished.load(Ordering::SeqCst), 2, "re-evaluated once under the new mode");
    session.close().await;
}

/// Upgrade Ask -> Auto re-evaluates (the policy now allows); downgrade Full -> Ask re-evaluates and
/// asks instead of applying Full's allow to a check that had no answer.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mode_upgrade_and_downgrade_re_evaluate_under_the_new_mode() {
    let policy = GatedPolicy::new(vec![Step::Pass, Step::Allow], false);
    let _release = ReleaseOnDrop(policy.clone());
    let mut script = handshake();
    script.extend([json!({"expect":{"type":"user"}}), init(), bash("r1")]);
    script.extend(mode("acceptEdits"));
    script.extend([reply("r1", json!({"behavior":"allow","updatedInput":{"command":"ls"}})), result()]);
    let (session, mut events) = open_session(script, &policy, |_| {});
    session.start_turn(turn("ask")).await.unwrap();
    policy.wait_entered(1).await;
    session.set_permission_mode("auto").await;
    policy.release();
    until(&mut events, "turn-completed", &session).await;
    assert_eq!(policy.finished.load(Ordering::SeqCst), 2);
    session.close().await;

    let policy = GatedPolicy::new(vec![Step::Pass, Step::Pass], false);

    let _release = ReleaseOnDrop(policy.clone());
    let mut script = vec![json!({"expect_launch":{"pairs":[["--permission-mode","bypassPermissions"]]}})];
    script.extend(handshake());
    script.extend([json!({"expect":{"type":"user"}}), init(), bash("r1")]);
    script.extend(mode("default"));
    script.extend([reply("r1", json!({"behavior":"deny","message":"Denied in Milagre"})), result()]);
    let (session, mut events) = open_session(script, &policy, |_| {});
    session.start_turn(turn("full")).await.unwrap();
    policy.wait_entered(1).await;
    session.set_permission_mode("ask").await;
    policy.release();
    let trace = until(&mut events, "turn-completed", &session).await;
    assert_eq!(trace.iter().filter(|e| e["type"] == "permission-request").count(), 1);
    assert_eq!(policy.finished.load(Ordering::SeqCst), 2);
    session.close().await;
}

/// Withdrawn requests keep their inbound slot until their blocked check actually finishes: with two
/// slots, two withdrawn checks still refuse a third request; once both finish, a slot is reused.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn withdrawn_checks_hold_inbound_slots_until_they_finish() {
    let barrier = scratch("access-saturation").join("released");
    let policy = GatedPolicy::new(vec![Step::Allow, Step::Allow], false);
    let _release = ReleaseOnDrop(policy.clone());
    let mut script = handshake();
    // Withdraw only once both checks are blocked inside the policy.
    let blocked = barrier.with_file_name("blocked");
    script.extend([json!({"expect":{"type":"user"}}), init(), bash("r1"), bash("r2"), json!({"wait_file":blocked})]);
    script.extend([json!({"cancel":"r1"}), json!({"cancel":"r2"}), bash("r3")]);
    script.push(json!({"expect":{"type":"control_response","fields":{"/response/request_id":"r3","/response/subtype":"error","/response/error":"Too many control requests in flight"}}}));
    script.push(text("refusal seen"));
    script.extend([
        json!({"wait_file":barrier}),
        bash("r4"),
        reply("r4", json!({"behavior":"deny","message":"Denied in Milagre"})),
        result(),
    ]);
    let (session, mut events) = open_session(script, &policy, |o| o.limits.max_inbound_requests = 2);
    session.start_turn(turn("ask")).await.unwrap();
    policy.wait_entered(2).await;
    std::fs::write(&blocked, b"blocked").unwrap();
    until(&mut events, "text-delta", &session).await;
    let monitor = session.access_monitor();
    assert_eq!(session.live_inbound(), 2, "withdrawn handlers still own their slots");
    assert_eq!((monitor.held(), monitor.entered()), (2, 2));
    policy.release();
    wait_until("withdrawn handlers to finish", || session.live_inbound() == 0 && monitor.held() == 0).await;
    assert_eq!(policy.finished.load(Ordering::SeqCst), 2);
    std::fs::write(&barrier, b"released").unwrap();
    let trace = until(&mut events, "turn-completed", &session).await;
    assert_eq!(trace.iter().filter(|e| e["type"] == "permission-request").count(), 1, "r4 asks after reuse");
    session.close().await;
}

/// close() stops the process at once but returns only after the blocked check finishes; its late
/// answer is discarded.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn close_waits_for_a_blocked_check_and_discards_its_answer() {
    let policy = GatedPolicy::new(vec![Step::Allow], false);
    let _release = ReleaseOnDrop(policy.clone());
    let mut script = handshake();
    script.extend([json!({"expect":{"type":"user"}}), init(), bash("r1"), json!({"sleep_ms":10000})]);
    let (session, _events) = open_session(script, &policy, |_| {});
    session.start_turn(turn("ask")).await.unwrap();
    policy.wait_entered(1).await;
    let pid = session.pid().unwrap();
    let monitor = session.access_monitor();
    assert_eq!((monitor.held(), monitor.entered()), (1, 1));
    let session = Arc::new(session);
    let closing = tokio::spawn({
        let session = session.clone();
        async move { session.close().await }
    });
    wait_until("the session's own child to exit", || !pid_alive(pid as i32)).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!closing.is_finished(), "close must not return while a check it owns is running");
    assert_eq!(policy.finished.load(Ordering::SeqCst), 0);
    policy.release();
    tokio::time::timeout(Duration::from_secs(5), closing).await.expect("close finishes after release").unwrap();
    assert_eq!(policy.finished.load(Ordering::SeqCst), 1);
    assert_eq!((monitor.held(), monitor.entered()), (0, 0));
}

/// A panicking policy refuses in Full instead of falling through to Full's allow.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn policy_panic_refuses_even_in_full() {
    let policy = GatedPolicy::new(vec![Step::Panic], true);
    let _release = ReleaseOnDrop(policy.clone());
    let mut script = vec![json!({"expect_launch":{"pairs":[["--permission-mode","bypassPermissions"]]}})];
    script.extend(handshake());
    script.extend([json!({"expect":{"type":"user"}}), init(), bash("r1")]);
    script.extend([reply("r1", json!({"behavior":"deny","message":ACCESS_FAILED_MESSAGE})), result()]);
    let (session, mut events) = open_session(script, &policy, |_| {});
    session.start_turn(turn("full")).await.unwrap();
    until(&mut events, "turn-completed", &session).await;
    let monitor = session.access_monitor();
    wait_until("the failed check to return its permit", || monitor.held() == 0).await;
    session.close().await;
}

// Eight checks blocked inside the policy (all permits) and a ninth request waiting behind them. Each
// case invalidates the ninth while it waits, then releases the eight: the ninth must never enter the
// policy, whatever the order in which it later gets a permit or a blocking thread.

/// r1..r8 enter and block; only then is r9 sent, so r9 is the one left waiting.
fn saturated_script(blocked: &std::path::Path, tail: Vec<Value>) -> Vec<Value> {
    let mut script = handshake();
    script.extend([json!({"expect":{"type":"user"}}), init()]);
    for i in 1..=8 {
        script.push(bash(&format!("r{i}")));
    }
    script.extend([json!({"wait_file":blocked.with_extension("eight")}), bash("r9")]);
    script.push(json!({"wait_file":blocked}));
    script.extend(tail);
    script
}
fn eight_denials() -> Value {
    json!({"expect_pair": (1..=8).map(|i| json!({"/response/request_id": format!("r{i}"), "/response/response/message": "blocked"})).collect::<Vec<_>>()})
}
async fn saturate(session: &ClaudeSession, policy: &GatedPolicy, blocked: &std::path::Path) {
    session.start_turn(turn("ask")).await.unwrap();
    policy.wait_entered(8).await;
    std::fs::write(blocked.with_extension("eight"), b"eight").unwrap();
    wait_until("the ninth handler to be running", || session.live_inbound() == 9).await;
    let monitor = session.access_monitor();
    assert_eq!((monitor.held(), monitor.entered()), (8, 8), "the ninth holds no permit and has not entered");
    std::fs::write(blocked, b"blocked").unwrap();
}
fn deny_steps() -> Vec<Step> {
    vec![Step::Deny("blocked"); 9]
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn queued_check_withdrawn_while_waiting_never_enters_the_policy() {
    let policy = GatedPolicy::new(deny_steps(), false);
    let _release = ReleaseOnDrop(policy.clone());
    let blocked = scratch("queued-withdrawn").join("blocked");
    let tail = vec![json!({"cancel":"r9"}), text("withdrawn"), eight_denials(), result()];
    let (session, mut events) = open_session(saturated_script(&blocked, tail), &policy, |_| {});
    saturate(&session, &policy, &blocked).await;
    until(&mut events, "text-delta", &session).await;
    policy.release();
    until(&mut events, "turn-completed", &session).await;
    let monitor = session.access_monitor();
    wait_until("all permits back", || monitor.held() == 0).await;
    assert_eq!(policy.entered.load(Ordering::SeqCst), 8, "the withdrawn ninth never entered");
    session.close().await;
    assert_eq!(session.exit_info().and_then(|e| e.code), Some(0), "the fake saw exactly the eight denials");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn close_refuses_the_queued_check_and_returns_once_entered_ones_drain() {
    let policy = GatedPolicy::new(deny_steps(), false);
    let _release = ReleaseOnDrop(policy.clone());
    let blocked = scratch("queued-close").join("blocked");
    let (session, _events) = open_session(saturated_script(&blocked, vec![json!({"sleep_ms":10000})]), &policy, |_| {});
    saturate(&session, &policy, &blocked).await;
    let pid = session.pid().unwrap();
    let monitor = session.access_monitor();
    let session = Arc::new(session);
    let closing = tokio::spawn({
        let session = session.clone();
        async move { session.close().await }
    });
    wait_until("the session's own child to exit", || !pid_alive(pid as i32)).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!closing.is_finished(), "close waits for the eight entered checks");
    policy.release();
    tokio::time::timeout(Duration::from_secs(5), closing).await.expect("close returns once entered checks drain").unwrap();
    wait_until("all permits back", || monitor.held() == 0).await;
    assert_eq!(policy.entered.load(Ordering::SeqCst), 8, "the queued ninth never entered after close");
    assert_eq!(monitor.entered(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropping_the_session_refuses_the_queued_check() {
    let policy = GatedPolicy::new(deny_steps(), false);
    let _release = ReleaseOnDrop(policy.clone());
    let blocked = scratch("queued-drop").join("blocked");
    let (session, events) = open_session(saturated_script(&blocked, vec![json!({"sleep_ms":10000})]), &policy, |_| {});
    saturate(&session, &policy, &blocked).await;
    let pid = session.pid().unwrap();
    let monitor = session.access_monitor();
    drop(session);
    drop(events);
    wait_until("the dropped session's child to exit", || !pid_alive(pid as i32)).await;
    policy.release();
    wait_until("all permits back", || monitor.held() == 0).await;
    assert_eq!(policy.entered.load(Ordering::SeqCst), 8, "the queued ninth never entered after drop");
    assert_eq!(monitor.entered(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn queued_check_from_an_ended_turn_never_enters_the_policy() {
    let policy = GatedPolicy::new(deny_steps(), false);
    let _release = ReleaseOnDrop(policy.clone());
    let blocked = scratch("queued-stale").join("blocked");
    let all_cancelled = json!({"expect_pair": (1..=9).map(|i| json!({"/response/request_id": format!("r{i}"), "/response/response": cancelled()})).collect::<Vec<_>>()});
    let (session, mut events) = open_session(saturated_script(&blocked, vec![result(), all_cancelled]), &policy, |_| {});
    saturate(&session, &policy, &blocked).await;
    until(&mut events, "turn-completed", &session).await;
    policy.release();
    let monitor = session.access_monitor();
    wait_until("all permits back", || monitor.held() == 0).await;
    assert_eq!(policy.entered.load(Ordering::SeqCst), 8, "the ninth, now from an ended turn, never entered");
    session.close().await;
    assert_eq!(session.exit_info().and_then(|e| e.code), Some(0), "the fake saw nine cancelled denials");
}

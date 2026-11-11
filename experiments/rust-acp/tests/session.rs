#![cfg(feature = "fake-session")]
use milagre_acp::queue::EventReceiver;
use milagre_acp::session::*;
use serde_json::{json, Value};
use std::time::Duration;
fn options(scenario: &str) -> FakeOptions {
    FakeOptions {
        scenario: scenario.into(),
        mapper_now_ms: Some(1000),
        limits: SessionLimits {
            startup_timeout: Duration::from_millis(500),
            turn_timeout: Duration::from_secs(3),
            idle_timeout: Duration::from_millis(500),
            permission_timeout: Duration::from_millis(500),
            cancel_grace: Duration::from_millis(100),
            ..SessionLimits::default()
        },
        ..FakeOptions::default()
    }
}
async fn next(events: &mut EventReceiver<SessionEvent>) -> SessionEvent {
    tokio::time::timeout(Duration::from_secs(5), events.recv()).await.expect("session timeout").expect("session ended")
}
fn terminal(event: &Value) -> bool {
    matches!(event["type"].as_str(), Some("turn-completed" | "turn-cancelled" | "turn-failed"))
}
async fn ended(events: &mut EventReceiver<SessionEvent>, id: TurnId) -> Vec<Value> {
    let mut seen = vec![];
    loop {
        if let SessionEvent::Agent { turn_id, event } = next(events).await {
            assert_eq!(turn_id, id);
            let end = terminal(&event);
            seen.push(event);
            if end {
                return seen;
            }
        }
    }
}
#[tokio::test]
async fn streams_two_turns_and_clears_mapper_state() {
    let (s, mut events) = FakeSession::launch(options("reply")).unwrap();
    for n in 1..=2 {
        let id = s.send("hello").unwrap();
        let seen = ended(&mut events, id).await;
        assert_eq!(seen.iter().filter_map(|v| v["text"].as_str()).collect::<String>(), "Hello", "{seen:?}");
        assert_eq!(seen.iter().filter(|e| terminal(e)).count(), 1);
        assert_eq!(seen.iter().filter(|e| e["type"] == "session-started").count(), usize::from(n == 1));
        let state = s.inspect().await.unwrap();
        assert_eq!(state["state"]["calls"], json!([]));
    }
    s.shutdown().await;
}
#[tokio::test]
async fn permission_is_explicit_and_closes_before_terminal() {
    let (s, mut events) = FakeSession::launch(options("permission")).unwrap();
    let turn = s.send("hello").unwrap();
    let id = loop {
        if let SessionEvent::Permission { turn_id, request_id, call, .. } = next(&mut events).await {
            assert_eq!(turn_id, turn);
            assert_eq!(call["kind"], "execute");
            break request_id;
        }
    };
    assert_eq!(s.answer(turn, id.clone(), Answer::Deny).await, Ok(Delivery::WrittenUnacknowledged));
    assert!(matches!(next(&mut events).await, SessionEvent::PermissionClosed { delivery: Delivery::WrittenUnacknowledged, .. }));
    let seen = ended(&mut events, turn).await;
    assert!(seen.iter().any(|e| e["text"] == "picked:deny"));
    assert_eq!(s.answer(turn, id, Answer::AllowOnce).await, Err(SessionError::UnknownPermission));
    s.shutdown().await;
}
#[tokio::test]
async fn loads_without_history_and_negotiates_capabilities() {
    let mut o = options("no-resume");
    o.open = OpenSession::Resume("saved".into());
    let (s, mut events) = FakeSession::launch(o).unwrap();
    let id = s.send("hello").unwrap();
    let seen = ended(&mut events, id).await;
    assert!(!seen.iter().any(|e| e["text"] == "old answer"));
    assert_eq!(seen.iter().filter_map(|e| e["text"].as_str()).collect::<String>(), "Hello");
    assert_eq!(s.inspect().await.unwrap()["nativeId"], "saved");
    s.shutdown().await;
}
#[tokio::test]
async fn stop_cancels_active_and_queued_turns_exactly_once() {
    let (s, mut events) = FakeSession::launch(options("slow")).unwrap();
    let first = s.send("one").unwrap();
    loop {
        if let SessionEvent::Agent { event, .. } = next(&mut events).await {
            if event["text"] == "Working" {
                break;
            }
        }
    }
    let second = s.send("two").unwrap();
    s.cancel();
    let seen = ended(&mut events, first).await;
    assert_eq!(seen.last().unwrap()["type"], "turn-cancelled");
    assert_eq!(ended(&mut events, second).await.last().unwrap()["type"], "turn-cancelled");
    s.shutdown().await;
}

#[tokio::test]
async fn startup_and_capability_errors_finish_once_and_close() {
    for (scenario, open) in [
        ("hang-init", OpenSession::Create),
        ("bad-version", OpenSession::Create),
        ("missing-id", OpenSession::Create),
        ("no-load", OpenSession::Load("saved".into())),
        ("hang-load", OpenSession::Load("saved".into())),
        ("logged-out", OpenSession::Create),
        ("subscription", OpenSession::Create),
        ("prompt-login", OpenSession::Create),
    ] {
        let mut o = options(scenario);
        o.open = open;
        let (s, mut events) = FakeSession::launch(o).unwrap();
        let id = s.send("hello").unwrap();
        let seen = ended(&mut events, id).await;
        assert_eq!(seen.last().unwrap()["type"], "turn-failed", "{scenario} {seen:?}");
        assert!(matches!(next(&mut events).await, SessionEvent::Closed { .. }));
        assert!(s.send("again").is_err());
        assert_eq!(s.answer(id, milagre_acp::RequestId::from("closed"), Answer::AllowOnce).await, Err(SessionError::Closed));
        s.shutdown().await;
    }
}
#[tokio::test]
async fn cancellation_during_initialization_and_replay_submits_no_live_text() {
    for scenario in ["hang-init", "stop-during-load"] {
        let mut o = options(scenario);
        if scenario == "stop-during-load" {
            o.open = OpenSession::Load("saved".into());
        }
        let (s, mut events) = FakeSession::launch(o).unwrap();
        let id = s.send("hello").unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await;
        s.cancel();
        let seen = ended(&mut events, id).await;
        assert_eq!(seen.last().unwrap()["type"], "turn-cancelled");
        assert!(!seen.iter().any(|e| e["type"] == "turn-started" || e["type"] == "text-delta"));
        s.shutdown().await;
    }
}
#[tokio::test]
async fn watchdogs_and_process_exit_have_one_terminal() {
    for (scenario, which) in [("stubborn", "idle"), ("stubborn", "turn"), ("permission-timeout", "permission"), ("crash", "exit")] {
        let mut o = options(scenario);
        match which {
            "idle" => o.limits.idle_timeout = Duration::from_millis(80),
            "turn" => o.limits.turn_timeout = Duration::from_millis(80),
            "permission" => o.limits.permission_timeout = Duration::from_millis(80),
            _ => {}
        }
        let (s, mut events) = FakeSession::launch(o).unwrap();
        let id = s.send("hello").unwrap();
        let seen = ended(&mut events, id).await;
        assert_eq!(seen.last().unwrap()["type"], "turn-failed", "{scenario} {seen:?}");
        assert!(matches!(next(&mut events).await, SessionEvent::Closed { .. }));
        s.shutdown().await;
    }
}
#[tokio::test]
async fn stubborn_cancel_kills_and_clears_open_permissions() {
    for scenario in ["stubborn", "permission-timeout"] {
        let (s, mut events) = FakeSession::launch(options(scenario)).unwrap();
        let id = s.send("hello").unwrap();
        loop {
            match next(&mut events).await {
                SessionEvent::Permission { .. } => break,
                SessionEvent::Agent { event, .. } if event["text"] == "Working" => break,
                _ => {}
            }
        }
        s.cancel();
        let seen = ended(&mut events, id).await;
        assert_eq!(seen.last().unwrap()["type"], "turn-cancelled");
        s.shutdown().await;
    }
}
#[tokio::test]
async fn state_and_permission_limits_fail_closed() {
    for scenario in ["state-flood", "thinking-flood", "permission-flood"] {
        let mut o = options(scenario);
        o.limits.open_calls = 4;
        o.limits.cached_diff_paths = 4;
        o.limits.thinking_bytes = 4096;
        o.limits.permissions = 4;
        let (s, mut events) = FakeSession::launch(o).unwrap();
        let id = s.send("hello").unwrap();
        let seen = ended(&mut events, id).await;
        assert_eq!(seen.last().unwrap()["type"], "turn-failed", "{scenario}");
        assert!(matches!(next(&mut events).await, SessionEvent::Closed { .. }));
        s.shutdown().await;
    }
}
#[tokio::test]
async fn mapper_retention_is_bounded_across_many_turns() {
    let (s, mut events) = FakeSession::launch(options("multi-turn")).unwrap();
    let mut baseline = 0;
    for n in 0..40 {
        let id = s.send("hello").unwrap();
        let seen = ended(&mut events, id).await;
        assert_eq!(seen.last().unwrap()["type"], "turn-completed");
        let snap = s.inspect().await.unwrap();
        let bytes = snap["stateBytes"].as_u64().unwrap();
        if n == 1 {
            baseline = bytes;
        }
        assert_eq!(snap["state"]["calls"], json!([]));
        assert_eq!(snap["state"]["editDiffs"], json!([]));
        assert_eq!(snap["state"]["thinking"], Value::Null);
        assert_eq!(snap["permissions"], 0);
        if n > 1 {
            assert!(bytes <= baseline + 128, "retained {bytes} > {baseline}");
        }
    }
    s.shutdown().await;
}
#[tokio::test]
async fn response_boundary_discards_late_and_wrong_session_updates() {
    for scenario in ["late-update", "wrong-session", "permission-after-end", "reply-then-permission", "exit-after-result"] {
        let (s, mut events) = FakeSession::launch(options(scenario)).unwrap();
        let id = s.send("hello").unwrap();
        let seen = ended(&mut events, id).await;
        assert_eq!(seen.iter().filter_map(|e| e["text"].as_str()).collect::<String>(), "live", "{scenario}");
        assert_eq!(seen.last().unwrap()["type"], "turn-completed");
        tokio::time::sleep(Duration::from_millis(30)).await;
        while let Ok(event) = events.try_recv() {
            assert!(!matches!(event, SessionEvent::Agent { .. } | SessionEvent::Permission { .. }), "post-terminal event {event:?}");
        }
        s.shutdown().await;
    }
}
#[tokio::test]
async fn prompt_end_closes_unanswered_permission_before_terminal() {
    let (s, mut events) = FakeSession::launch(options("stale-permission")).unwrap();
    let id = s.send("hello").unwrap();
    let mut request = None;
    let mut closed = false;
    loop {
        match next(&mut events).await {
            SessionEvent::Permission { request_id, .. } => request = Some(request_id),
            SessionEvent::PermissionClosed { .. } => closed = true,
            SessionEvent::Agent { event, .. } if terminal(&event) => {
                assert!(closed);
                break;
            }
            _ => {}
        }
    }
    assert_eq!(s.answer(id, request.unwrap(), Answer::AllowOnce).await, Err(SessionError::UnknownPermission));
    s.shutdown().await;
}
#[tokio::test]
async fn admission_and_output_budgets_preserve_terminal_for_every_accepted_turn() {
    let mut o = options("slow");
    o.limits.admitted_turns = 2;
    o.limits.output.max_events = 1;
    let (s, mut events) = FakeSession::launch(o).unwrap();
    let first = s.send("one").unwrap();
    let second = s.send("two").unwrap();
    assert_eq!(s.send("three"), Err(SessionError::Busy));
    tokio::time::sleep(Duration::from_millis(100)).await;
    let mut ids = vec![];
    loop {
        match next(&mut events).await {
            SessionEvent::Agent { turn_id, event } if terminal(&event) => ids.push(turn_id),
            SessionEvent::Closed { .. } => break,
            _ => {}
        }
    }
    assert_eq!(ids, vec![first, second]);
    assert_eq!(events.queued(), (0, 0));
    s.shutdown().await;
}
#[tokio::test]
async fn stalled_write_still_closes_after_observer_drop() {
    let (s, mut events) = FakeSession::launch(options("blocked-answer")).unwrap();
    let turn = s.send("hello").unwrap();
    let id = loop {
        if let SessionEvent::Permission { request_id, .. } = next(&mut events).await {
            break request_id;
        }
    };
    let task = tokio::spawn({
        let s = s.clone();
        async move { s.answer(turn, id, Answer::AllowOnce).await }
    });
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if !s.inspect().await.unwrap()["writingPermission"].is_null() {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    task.abort();
    let _ = task.await;
    let mut uncertain = false;
    loop {
        match next(&mut events).await {
            SessionEvent::PermissionClosed { delivery, .. } => {
                assert_eq!(delivery, Delivery::Uncertain);
                uncertain = true;
            }
            SessionEvent::Agent { event, .. } if terminal(&event) => {
                assert_eq!(event["type"], "turn-failed");
                break;
            }
            _ => {}
        }
    }
    assert!(uncertain);
    s.shutdown().await;
}
#[test]
fn unsupported_policies_refused_before_spawn_and_payloads_bounded() {
    for policy in [Policy::Auto, Policy::Full, Policy::Babysit, Policy::Advisor, Policy::Escalation, Policy::AnalysisOnly] {
        let mut o = options("reply");
        o.policy = policy;
        assert!(matches!(FakeSession::launch(o), Err(SessionError::UnsupportedPolicy)));
    }
}

fn normalize(value: &mut Value) {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().unwrap();
    fn visit(value: &mut Value, root: &str) {
        match value {
            Value::String(s) => *s = s.replace(root, "/checkout"),
            Value::Array(a) => {
                for v in a {
                    visit(v, root)
                }
            }
            Value::Object(o) => {
                for v in o.values_mut() {
                    visit(v, root)
                }
            }
            _ => {}
        }
    }
    visit(value, root.to_str().unwrap());
}
#[tokio::test]
async fn actual_node_session_lifecycle_traces_match() {
    let fixtures: Value = serde_json::from_str(include_str!("fixtures/node-session-traces.json")).unwrap();
    for case in fixtures["cases"].as_array().unwrap() {
        let scenario = case["scenario"].as_str().unwrap();
        let mut o = options(scenario);
        if scenario == "no-resume" {
            o.open = OpenSession::Resume("saved".into());
        }
        let (s, mut stream) = FakeSession::launch(o).unwrap();
        let mut events = vec![];
        let mut requests = vec![];
        let mut closed = 0;
        for n in 0..if scenario == "reply" { 2 } else { 1 } {
            let turn = s.send(if n == 0 { "hello" } else { "again" }).unwrap();
            loop {
                match next(&mut stream).await {
                    SessionEvent::Agent { turn_id, event } => {
                        assert_eq!(turn, turn_id);
                        let end = terminal(&event);
                        if scenario == "slow" && event["text"] == "Working" {
                            s.cancel();
                        }
                        events.push(event);
                        if end {
                            break;
                        }
                    }
                    SessionEvent::Permission { turn_id, request_id, params, call } => {
                        requests.push(json!({"id":request_id.to_value(),"method":"session/request_permission","params":params}));
                        if scenario == "kiro-tools" {
                            assert!(call.get("kind").is_some());
                            assert!(call.get("content").is_some() || call.get("rawInput").is_some());
                        }
                        let answer = if ["edit", "question"].contains(&scenario) { Answer::AllowOnce } else { Answer::Deny };
                        assert_eq!(s.answer(turn_id, request_id, answer).await, Ok(Delivery::WrittenUnacknowledged));
                    }
                    SessionEvent::PermissionClosed { delivery, .. } => {
                        assert_eq!(delivery, Delivery::WrittenUnacknowledged);
                        closed += 1;
                    }
                    other => panic!("unexpected {other:?}"),
                }
            }
        }
        let mut events = json!(events);
        normalize(&mut events);
        assert_eq!(events, case["events"], "{scenario} events");
        let mut requests = json!(requests);
        normalize(&mut requests);
        assert_eq!(requests, case["permissionRequests"], "{scenario} requests");
        assert_eq!(closed, requests.as_array().unwrap().len());
        let mut state = s.inspect().await.unwrap()["state"].clone();
        normalize(&mut state);
        assert_eq!(state, case["state"], "{scenario} state");
        s.shutdown().await;
    }
}
#[test]
fn lifecycle_recorder_has_no_source_or_result_drift() {
    let output = std::process::Command::new("node")
        .arg(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("scripts/record-session.cjs"))
        .arg("--check")
        .output()
        .unwrap();
    assert!(output.status.success(), "{} {}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
}

#[tokio::test]
async fn text_preceding_error_or_exit_is_delivered_before_terminal() {
    for scenario in ["error-after-text", "exit-after-text"] {
        let (s, mut events) = FakeSession::launch(options(scenario)).unwrap();
        let id = s.send("hello").unwrap();
        let seen = ended(&mut events, id).await;
        assert!(seen.iter().any(|e| e["type"] == "text-delta"), "{scenario} {seen:?}");
        assert_eq!(seen.last().unwrap()["type"], "turn-failed");
        s.shutdown().await;
    }
}
#[tokio::test]
async fn reused_permission_id_never_accepts_an_old_turn_answer() {
    let (s, mut events) = FakeSession::launch(options("reuse-permission")).unwrap();
    let mut old = None;
    for _ in 0..3 {
        let turn = s.send("hello").unwrap();
        let id = loop {
            if let SessionEvent::Permission { request_id, .. } = next(&mut events).await {
                break request_id;
            }
        };
        if let Some(old) = old {
            assert_eq!(s.answer(old, id.clone(), Answer::AllowOnce).await, Err(SessionError::UnknownPermission));
        }
        assert_eq!(s.answer(turn, id, Answer::Deny).await, Ok(Delivery::WrittenUnacknowledged));
        ended(&mut events, turn).await;
        old = Some(turn);
    }
    s.shutdown().await;
}
#[cfg(unix)]
#[tokio::test]
async fn dropping_last_session_handle_reaps_the_fake_and_finishes_turn() {
    let (s, mut events) = FakeSession::launch(options("slow")).unwrap();
    let id = s.send("hello").unwrap();
    loop {
        if let SessionEvent::Agent { event, .. } = next(&mut events).await {
            if event["text"] == "Working" {
                break;
            }
        }
    }
    let pid = s.inspect().await.unwrap()["pid"].as_u64().unwrap() as i32;
    drop(s);
    assert_eq!(ended(&mut events, id).await.last().unwrap()["type"], "turn-cancelled");
    assert!(matches!(next(&mut events).await, SessionEvent::Closed { .. }));
    // SAFETY: signal 0 only checks whether the fake process remains.
    assert_ne!(unsafe { libc::kill(pid, 0) }, 0);
}

#[tokio::test]
async fn retained_byte_budgets_and_oversized_admission_fail_closed() {
    for scenario in ["metadata-flood", "blocked-answer"] {
        let mut o = options(scenario);
        o.limits.mapper_bytes = 16 * 1024;
        o.limits.permission_bytes = 4096;
        let (s, mut events) = FakeSession::launch(o).unwrap();
        assert_eq!(s.send(&"x".repeat(2 * 1024 * 1024)), Err(SessionError::Busy));
        let id = s.send("hello").unwrap();
        let seen = ended(&mut events, id).await;
        assert_eq!(seen.last().unwrap()["type"], "turn-failed");
        s.shutdown().await;
    }
}

#[tokio::test]
async fn timed_out_or_dropped_receipt_preserves_current_and_queued_turns() {
    let mut o = options("delayed-answer");
    o.limits.cancel_grace = Duration::from_secs(2);
    o.limits.permission_timeout = Duration::from_secs(2);
    let (s, mut events) = FakeSession::launch(o).unwrap();
    let first = s.send("first").unwrap();
    let second = s.send("queued").unwrap();
    for (index, turn) in [first, second].into_iter().enumerate() {
        let id = loop {
            if let SessionEvent::Permission { turn_id, request_id, .. } = next(&mut events).await {
                assert_eq!(turn_id, turn);
                break request_id;
            }
        };
        if index == 0 {
            assert!(tokio::time::timeout(Duration::from_millis(1), s.answer(turn, id.clone(), Answer::AllowOnce)).await.is_err());
        } else {
            // Drop synchronously before the actor can claim the admitted answer.
            drop(s.admit_answer(turn, id.clone(), Answer::AllowOnce).unwrap());
        }
        assert!(matches!(next(&mut events).await, SessionEvent::PermissionClosed { delivery: Delivery::WrittenUnacknowledged, .. }));
        assert_eq!(ended(&mut events, turn).await.last().unwrap()["type"], "turn-completed");
        assert_eq!(s.answer(turn, id, Answer::AllowOnce).await, Err(SessionError::UnknownPermission));
    }
    // An unobserved, already-completed receipt is equally harmless.
    let third = s.send("next").unwrap();
    let id = loop {
        if let SessionEvent::Permission { request_id, .. } = next(&mut events).await {
            break request_id;
        }
    };
    let receipt = s.admit_answer(third, id, Answer::AllowOnce).unwrap();
    assert!(matches!(next(&mut events).await, SessionEvent::PermissionClosed { delivery: Delivery::WrittenUnacknowledged, .. }));
    drop(receipt);
    assert_eq!(ended(&mut events, third).await.last().unwrap()["type"], "turn-completed");
    s.shutdown().await;
}

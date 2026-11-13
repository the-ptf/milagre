mod common;
use common::*;
use milagre_claude::session::{ClaudeSession, IdleClose, SessionError, SessionOptions, TurnRequest};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};

fn script() -> Vec<Value> {
    vec![
        json!({"expect":{"subtype":"initialize"}}),
        json!({"reply":{}}),
        json!({"expect":{"subtype":"set_max_thinking_tokens"}}),
        json!({"reply":{}}),
        json!({"expect":{"type":"user"}}),
        json!({"emit":{"type":"system","subtype":"init","session_id":"retained-session"}}),
        json!({"emit":{"type":"result","subtype":"success","num_turns":1,"result":"done"}}),
    ]
}
fn request() -> TurnRequest {
    TurnRequest { model: "sonnet".into(), content: vec![json!({"type":"text","text":"retention"})], ..Default::default() }
}
fn open(steps: Vec<Value>) -> (Arc<ClaudeSession>, milagre_claude::session::SessionEvents) {
    let (launch, _) = fake("idle-retention", json!(steps));
    let mut options = SessionOptions::new(launch);
    options.limits = quick_limits();
    let (session, events) = ClaudeSession::new(options);
    (Arc::new(session), events)
}

#[tokio::test]
async fn unforwarded_postterminal_activity_prevents_idle_close_and_explicit_close_settles_it() {
    let mut steps = script();
    steps.extend([
        json!({"emit":{"type":"assistant","message":{"content":[{"type":"tool_use","id":"child","name":"Agent","input":{"run_in_background":true}}]}}}),
        json!({"wait_eof":true}),
    ]);
    let (session, mut events) = open(steps);
    session.start_turn(request()).await.unwrap();
    // No owner event is consumed. The native mapper is the retention authority even after terminal.
    tokio::time::timeout(Duration::from_secs(3), async {
        while session.turn_active() || !session.busy_without_turn().unwrap() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let pid = session.pid().unwrap();
    assert_eq!(session.close_if_idle(Some("retained-session")).unwrap(), IdleClose::Busy);
    assert!(!session.is_closed());
    assert_eq!(session.pid(), Some(pid));
    session.close().await;
    assert!(wait_dead(pid as i32).await);
    assert!(matches!(session.busy_without_turn(), Err(SessionError::Closed)));
    assert!(matches!(session.close_if_idle(None), Err(SessionError::Closed)));
    let mut seen = Vec::new();
    while let Some(event) = events.recv().await {
        seen.push(event);
    }
    assert!(seen.iter().any(|event| event["type"] == "subagent-update" && event["agent"]["status"] == "cancelled"));
    assert_eq!(seen.iter().filter(|event| event["type"] == "turn-completed").count(), 1);
}

#[tokio::test]
async fn idle_claim_captures_resume_and_requires_a_runtime_before_any_mutation() {
    let mut steps = script();
    steps.push(json!({"wait_eof":true}));
    let (session, mut events) = open(steps);
    assert!(matches!(session.close_if_idle(None), Err(SessionError::ReplacementUnavailable)));
    session.start_turn(request()).await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), async { while events.recv().await.unwrap()["type"] != "turn-completed" {} })
        .await
        .unwrap();
    let other = session.clone();
    assert!(matches!(std::thread::spawn(move || other.close_if_idle(None)).join().unwrap(), Err(SessionError::ReplacementUnavailable)));
    assert!(!session.is_closed());
    assert!(matches!(session.close_if_idle(Some("foreign-session")), Err(SessionError::ReplacementUnavailable)));
    assert!(!session.is_closed());
    let pid = session.pid().unwrap();
    assert_eq!(session.close_if_idle(Some("retained-session")).unwrap(), IdleClose::Closing { native_id: Some("retained-session".into()) });
    session.close().await;
    assert!(wait_dead(pid as i32).await);
}

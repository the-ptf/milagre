mod common;

use common::*;
use milagre_claude::session::{ClaudeSession, SessionError, SessionEvents, SessionOptions, TurnRequest};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

fn handshake() -> Vec<Value> {
    vec![
        json!({"expect":{"subtype":"initialize"}}),
        json!({"reply":{}}),
        json!({"expect":{"subtype":"set_max_thinking_tokens"}}),
        json!({"reply":{}}),
        json!({"expect":{"type":"user"}}),
        json!({"emit":{"type":"system","subtype":"init","session_id":"mode-session"}}),
    ]
}
fn mode_entered() -> Vec<Value> {
    vec![
        json!({"expect":{"subtype":"set_permission_mode","fields":{"/request/mode":"bypassPermissions"}}}),
        json!({"emit":{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"entered"}}}}),
    ]
}
fn open(script: Vec<Value>) -> (Arc<ClaudeSession>, SessionEvents) {
    let (launch, _) = fake("mode-receipts", Value::Array(script));
    let mut options = SessionOptions::new(launch);
    options.limits = quick_limits();
    let (session, events) = ClaudeSession::new(options);
    (Arc::new(session), events)
}
async fn until(events: &mut SessionEvents, kind: &str) {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if events.recv().await.expect("session ended")["type"] == kind {
                break;
            }
        }
    })
    .await
    .expect("event deadline");
}
async fn start(session: &ClaudeSession) {
    session
        .start_turn(TurnRequest { model: "sonnet".into(), content: vec![json!({"type":"text","text":"hello"})], ..Default::default() })
        .await
        .unwrap();
}

#[tokio::test]
async fn checked_mode_returns_native_rejection_and_closed_refusal() {
    let mut script = handshake();
    script.extend(mode_entered());
    script.push(json!({"reply_error":"native refused"}));
    let (session, mut events) = open(script);
    start(&session).await;
    assert!(matches!(session.set_permission_mode_checked("full").await, Err(SessionError::Send(_))));
    until(&mut events, "turn-failed").await;
    let admitted = AtomicBool::new(false);
    assert!(matches!(
        session
            .set_permission_mode_checked_if("ask", || {
                admitted.store(true, Ordering::SeqCst);
                true
            })
            .await,
        Err(SessionError::Closed)
    ));
    assert!(!admitted.load(Ordering::SeqCst));
    session.close().await;
}

#[tokio::test]
async fn generation_guard_runs_after_the_serialized_operation_wait() {
    let gate = scratch("mode-receipt-generation").join("release");
    let mut script = handshake();
    script.extend(mode_entered());
    script.extend([
        json!({"wait_file":gate}),
        json!({"reply":{}}),
        json!({"expect_none_ms":50}),
        json!({"emit":{"type":"result","subtype":"success","num_turns":1,"result":"done"}}),
    ]);
    let (session, mut events) = open(script);
    start(&session).await;
    let first_session = session.clone();
    let first = tokio::spawn(async move { first_session.set_permission_mode_checked("full").await });
    until(&mut events, "text-delta").await;
    let valid = AtomicBool::new(true);
    let admitted = AtomicBool::new(false);
    let second = session.set_permission_mode_checked_if("ask", || {
        admitted.store(true, Ordering::SeqCst);
        valid.load(Ordering::SeqCst)
    });
    tokio::pin!(second);
    tokio::select! { biased; _ = &mut second => panic!("operation lock was not held"), _ = tokio::task::yield_now() => {} }
    assert!(!admitted.load(Ordering::SeqCst));
    valid.store(false, Ordering::SeqCst);
    std::fs::write(&gate, b"release").unwrap();
    tokio::time::timeout(Duration::from_secs(3), first).await.unwrap().unwrap().unwrap();
    assert!(matches!(second.await, Err(SessionError::ModeNotAdmitted)));
    assert!(admitted.load(Ordering::SeqCst));
    until(&mut events, "turn-completed").await;
    session.close().await;
}

#[tokio::test]
async fn close_rejects_a_mode_waiter_before_its_entry_callback() {
    let mut script = handshake();
    script.extend(mode_entered());
    script.push(json!({"wait_eof":true}));
    let (session, mut events) = open(script);
    start(&session).await;
    let first_session = session.clone();
    let first = tokio::spawn(async move { first_session.set_permission_mode_checked("full").await });
    until(&mut events, "text-delta").await;
    let entered = AtomicBool::new(false);
    let second = session.set_permission_mode_checked_if("ask", || {
        entered.store(true, Ordering::SeqCst);
        true
    });
    tokio::pin!(second);
    tokio::select! { biased; _ = &mut second => panic!("operation lock was not held"), _ = tokio::task::yield_now() => {} }
    session.close().await;
    assert!(tokio::time::timeout(Duration::from_secs(3), first).await.unwrap().unwrap().is_err());
    assert!(matches!(second.await, Err(SessionError::Closed)));
    assert!(!entered.load(Ordering::SeqCst));
}

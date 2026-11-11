mod common;

use common::*;
use milagre_claude::session::{ClaudeSession, SessionEvents, SessionOptions, TurnRequest};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

fn request(text: &str) -> TurnRequest {
    TurnRequest { model: "sonnet".into(), content: vec![json!({"type":"text", "text":text})], ..Default::default() }
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
    json!({"emit":{"type":"system","subtype":"init","session_id":"session-1"}})
}
fn text(s: &str) -> Value {
    json!({"emit":{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":s}}}})
}
fn result() -> Value {
    json!({"emit":{"type":"result","subtype":"success","num_turns":1,"result":"done"}})
}
fn session(steps: Vec<Value>) -> (ClaudeSession, SessionEvents) {
    configured(steps, |_| {})
}
fn configured(steps: Vec<Value>, configure: impl FnOnce(&mut SessionOptions)) -> (ClaudeSession, SessionEvents) {
    let (launch, _) = fake("session", Value::Array(steps));
    let mut options = SessionOptions::new(launch);
    options.limits = quick_limits();
    options.interrupt_grace = Duration::from_millis(60);
    configure(&mut options);
    ClaudeSession::new(options)
}
async fn next(events: &mut SessionEvents) -> Value {
    tokio::time::timeout(Duration::from_secs(3), events.recv()).await.expect("session event timed out").expect("session ended")
}
async fn until(events: &mut SessionEvents, kind: &str) -> Vec<Value> {
    let mut out = vec![];
    loop {
        let e = next(events).await;
        let done = e["type"] == kind;
        out.push(e);
        if done {
            return out;
        }
    }
}
fn kinds(events: &[Value]) -> Vec<&str> {
    events.iter().map(|e| e["type"].as_str().unwrap()).collect()
}

#[tokio::test]
async fn explicit_turns_reuse_process_and_order_events() {
    let mut script = handshake();
    for _ in 0..2 {
        script.extend([json!({"expect":{"type":"user"}}), init(), text("hello"), result()]);
    }
    let (session, mut events) = session(script);
    let first = session.start_turn(request("one")).await.unwrap();
    let trace = until(&mut events, "turn-completed").await;
    assert_eq!(kinds(&trace), ["turn-started", "session-started", "text-delta", "turn-completed"]);
    assert_eq!(trace[2]["messageId"], json!(first.turn_id));
    let pid = session.pid();
    let second = session.start_turn(request("two")).await.unwrap();
    assert_ne!(first.turn_id, second.turn_id);
    assert_eq!(session.pid(), pid);
    assert_eq!(kinds(&until(&mut events, "turn-completed").await), ["turn-started", "text-delta", "turn-completed"]);
    session.close().await;
    assert!(events.recv().await.is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_start_waits_for_initial_message_then_steers() {
    let mut script = handshake();
    script.insert(1, json!({"sleep_ms":50}));
    script.extend([json!({"expect":{"type":"user"}}), init(), json!({"expect":{"type":"user"}}), text("both"), result()]);
    let (session, mut events) = session(script);
    let (first, second) = tokio::join!(session.start_turn(request("first")), session.start_turn(request("second")));
    let (first, second) = (first.unwrap(), second.unwrap());
    assert!(!first.steered);
    assert!(second.steered);
    assert_eq!(first.turn_id, second.turn_id);
    assert_eq!(kinds(&until(&mut events, "turn-completed").await), ["turn-started", "session-started", "text-delta", "turn-completed"]);
    session.close().await;
}

#[tokio::test]
async fn dropped_start_closes_synchronously_and_kills_process() {
    let (session, mut events) = session(vec![json!({"expect":{"subtype":"initialize"}}), json!({"sleep_ms":10000})]);
    let mut start = Box::pin(session.start_turn(request("never sent")));
    tokio::select! { _ = &mut start => panic!("unexpected start"), _ = tokio::time::sleep(Duration::from_millis(50)) => {} }
    let pid = session.pid().unwrap();
    drop(start);
    assert!(session.is_closed());
    assert!(!session.turn_active());
    assert_eq!(next(&mut events).await["type"], "turn-cancelled");
    assert!(events.recv().await.is_none());
    assert!(wait_dead(pid as i32).await);
    assert!(session.start_turn(request("later")).await.is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropping_close_keeps_cleanup_and_one_terminal_event() {
    let mut script = handshake();
    script.extend([json!({"expect":{"type":"user"}}), init(), json!({"sleep_ms":10000})]);
    let (session, mut events) = session(script);
    session.start_turn(request("one")).await.unwrap();
    until(&mut events, "session-started").await;
    let pid = session.pid().unwrap();
    let mut close = Box::pin(session.close());
    tokio::select! { _ = &mut close => {}, _ = tokio::time::sleep(Duration::from_millis(10)) => {} }
    drop(close);
    assert!(session.is_closed());
    assert!(!session.turn_active());
    assert_eq!(next(&mut events).await["type"], "turn-cancelled");
    assert!(events.recv().await.is_none());
    assert!(wait_dead(pid as i32).await);
}

#[tokio::test]
async fn drop_session_with_pending_question_reaps_process() {
    let mut script = handshake();
    script.extend([json!({"expect":{"type":"user"}}), question("q1")]);
    let (session, mut events) = session(script);
    session.start_turn(request("one")).await.unwrap();
    until(&mut events, "question-request").await;
    let pid = session.pid().unwrap();
    drop(session);
    assert!(wait_dead(pid as i32).await);
    assert!(events.recv().await.is_none());
}

fn question(id: &str) -> Value {
    json!({"request":{"id":id,"request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","input":{"questions":[{"question":"Which?","header":"Pick","options":[{"label":"A","description":"First"},{"label":"B","description":"Second"}]}]}}}})
}
fn permission(id: &str) -> Value {
    json!({"request":{"id":id,"request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"echo ok"}}}})
}

#[tokio::test]
async fn steering_dismisses_question_and_suppresses_suggestion() {
    let mut script = handshake();
    script.extend([
        json!({"expect":{"type":"user"}}),
        init(),
        question("q1"),
        json!({"expect_pair":[{"/type":"control_response"},{"/type":"user"}]}),
        result(),
        json!({"emit":{"type":"prompt_suggestion","session_id":"session-1","suggestion":"next?"}}),
    ]);
    let (session, mut events) = session(script);
    let first = session.start_turn(request("one")).await.unwrap();
    until(&mut events, "question-request").await;
    let steered = session.start_turn(request("answer in chat")).await.unwrap();
    assert!(steered.steered);
    assert_eq!(first.turn_id, steered.turn_id);
    let trace = until(&mut events, "turn-completed").await;
    assert_eq!(kinds(&trace), ["question-resolved", "turn-completed"]);
    assert_eq!(trace[0]["outcome"], "dismissed");
    assert!(!session.answer_question("q1", None));
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(events.try_recv().is_none());
    session.close().await;
}

#[tokio::test]
async fn permission_resolution_is_once_and_mode_full_releases_waiters() {
    let mut script = handshake();
    script.extend([json!({"expect":{"type":"user"}}),permission("p1"),
        json!({"expect":{"type":"control_response"}}),permission("p2"),
        // Mode control and permission reply use independent lanes; accept both in either order.
        json!({"expect_pair":[{"/type":"control_request","/request/subtype":"set_permission_mode","/request/mode":"bypassPermissions"},{"/type":"control_response","/response/response/behavior":"allow"}]}),result()]);
    let (session, mut events) = session(script);
    session.start_turn(request("one")).await.unwrap();
    until(&mut events, "permission-request").await;
    assert!(session.respond_to_permission("p1", "allow-for-chat"));
    assert!(!session.respond_to_permission("p1", "deny"));
    until(&mut events, "permission-request").await;
    session.set_permission_mode("full").await;
    let trace = until(&mut events, "turn-completed").await;
    assert_eq!(trace[0], json!({"type":"permission-resolved","requestId":"p2","decision":"allow"}));
    session.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn withdrawn_question_and_permission_resolve_before_turn_end() {
    let mut script = handshake();
    script.extend([
        json!({"expect":{"type":"user"}}),
        permission("p1"),
        json!({"sleep_ms":50}),
        json!({"cancel":"p1"}),
        question("q1"),
        json!({"sleep_ms":50}),
        json!({"cancel":"q1"}),
        json!({"expect_none_ms":50}),
        result(),
    ]);
    let (session, mut events) = session(script);
    session.start_turn(request("one")).await.unwrap();
    let trace = until(&mut events, "turn-completed").await;
    assert_eq!(trace.iter().filter(|e| e["type"] == "permission-resolved" && e["decision"] == "cancelled").count(), 1);
    assert_eq!(trace.iter().filter(|e| e["type"] == "question-resolved" && e["outcome"] == "cancelled").count(), 1);
    assert!(!session.respond_to_permission("p1", "allow"));
    assert!(!session.answer_question("q1", None));
    session.close().await;
}

#[tokio::test]
async fn interrupt_grace_closes_once_even_when_control_never_replies() {
    let mut script = handshake();
    script.extend([json!({"expect":{"type":"user"}}), init(), json!({"expect":{"subtype":"interrupt"}}), json!({"sleep_ms":10000})]);
    let (session, mut events) = session(script);
    session.start_turn(request("one")).await.unwrap();
    until(&mut events, "session-started").await;
    let pid = session.pid().unwrap();
    tokio::time::timeout(Duration::from_secs(3), session.interrupt()).await.unwrap();
    assert_eq!(kinds(&until(&mut events, "turn-cancelled").await), ["turn-cancelled"]);
    assert!(session.is_closed());
    assert!(events.recv().await.is_none());
    assert!(wait_dead(pid as i32).await);
}

#[tokio::test]
async fn stopped_turn_ends_before_next_message_starts() {
    let mut script = handshake();
    script.extend([
        json!({"expect":{"type":"user"}}),
        init(),
        json!({"expect":{"subtype":"interrupt"}}),
        json!({"reply":{}}),
        json!({"sleep_ms":20}),
        result(),
        json!({"expect":{"type":"user"}}),
        text("new"),
        result(),
    ]);
    let (session, mut events) = configured(script, |o| o.interrupt_grace = Duration::from_secs(1));
    let first = session.start_turn(request("one")).await.unwrap();
    until(&mut events, "session-started").await;
    session.interrupt().await;
    let second = session.start_turn(request("two")).await.unwrap();
    assert!(!second.steered);
    assert_ne!(first.turn_id, second.turn_id);
    assert_eq!(kinds(&until(&mut events, "turn-completed").await), ["turn-cancelled", "turn-started", "text-delta", "turn-completed"]);
    session.close().await;
}

#[tokio::test]
async fn resume_missing_and_login_failures_reset_before_failure_and_close() {
    for (resume, login) in [(true, false), (false, true), (true, true)] {
        let mut script = handshake();
        script.push(json!({"expect":{"type":"user"}}));
        script.push(init());
        if login {
            script.push(json!({"emit":{"type":"assistant","error":"authentication_failed","message":{"content":[]}}}));
        }
        script.push(json!({"emit":{"type":"result","subtype":"error_during_execution","errors":[if login {"not logged in"} else {"No conversation found"}]}}));
        let (session, mut events) = configured(script, |o| o.resume_id = resume.then(|| "session-1".into()));
        session.start_turn(request("one")).await.unwrap();
        let trace = until(&mut events, "turn-failed").await;
        assert_eq!(trace.iter().filter(|e| e["type"] == "session-reset").count(), usize::from(!login || !resume));
        assert!(session.is_closed());
        assert!(events.recv().await.is_none());
        session.close().await;
    }
}

#[tokio::test]
async fn failed_initialize_cannot_reuse_half_initialized_process() {
    let (session, mut events) = session(vec![json!({"expect":{"subtype":"initialize"}}), json!({"reply_error":"bad init"})]);
    let start = session.start_turn(request("one")).await.unwrap();
    assert!(start.turn_id.is_none());
    assert_eq!(next(&mut events).await["type"], "turn-failed");
    assert!(session.is_closed());
    assert!(session.start_turn(request("two")).await.is_err());
}

#[tokio::test]
async fn can_start_rechecks_before_any_message_is_sent() {
    let mut script = handshake();
    script.push(json!({"expect_none_ms":50}));
    let (session, mut events) = session(script);
    let mut r = request("obsolete");
    r.can_start = Some(Arc::new(|| false));
    assert!(session.start_turn(r).await.unwrap().cancelled);
    assert!(!session.turn_active());
    assert!(events.try_recv().is_none());
    session.close().await;
}

#[tokio::test]
async fn try_recv_releases_backpressure() {
    let mut script = handshake();
    script.extend([json!({"expect":{"type":"user"}}), init(), text("hello"), result()]);
    let (session, mut events) = configured(script, |o| o.event_capacity = 1);
    session.start_turn(request("one")).await.unwrap();
    let mut trace = vec![];
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Some(event) = events.try_recv() {
                let done = event["type"] == "turn-completed";
                trace.push(event);
                if done {
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(kinds(&trace), ["turn-started", "session-started", "text-delta", "turn-completed"]);
    session.close().await;
}

#[tokio::test]
async fn session_traces_match_node_claude_session() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/conformance/claude-session.json")).unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let mut script = handshake();
        script.push(json!({"expect":{"type":"user"}}));
        script.extend(case["messages"].as_array().unwrap().iter().map(|m| json!({"emit":m})));
        let (session, mut events) = configured(script, |o| {
            o.resume_id = case["resumeId"].as_str().map(str::to_owned);
            o.prompt_suggestions = case["promptSuggestions"] != false;
        });
        session.start_turn(request("hello")).await.unwrap();
        let mut expected = case["events"].as_array().unwrap().clone();
        // Keep the original Node trace in the fixture. The first implicit text's ownership is an
        // intentional correction, not a normalized-away mismatch.
        if case["rustCorrections"] == json!(["implicit-text-owner"]) {
            let mut implicit = None;
            for event in &mut expected {
                if event["type"] == "turn-started" && event.get("continues").is_some() {
                    implicit = Some(event["turnId"].clone());
                }
                if event["type"] == "text-delta" {
                    if let Some(id) = &implicit {
                        event["messageId"] = id.clone();
                    }
                }
            }
        }
        let mut ids = std::collections::HashMap::new();
        let mut trace = vec![];
        for _ in &expected {
            let mut event = next(&mut events).await;
            if event["type"] == "turn-started" {
                ids.insert(event["turnId"].as_str().unwrap().to_owned(), format!("turn-{}", ids.len() + 1));
            }
            for field in ["turnId", "messageId", "continues"] {
                if let Some(normalized) = event[field].as_str().and_then(|id| ids.get(id)).cloned() {
                    event[field] = normalized.into();
                }
            }
            trace.push(event);
        }
        assert_eq!(trace, expected, "{}", case["name"]);
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(events.try_recv().is_none(), "extra event for {}", case["name"]);
        session.close().await;
    }
}

#[tokio::test]
async fn dropped_steer_during_mode_change_preserves_running_turn() {
    let mut script = handshake();
    script.extend([
        json!({"expect":{"type":"user"}}),
        init(),
        question("q1"),
        json!({"expect":{"subtype":"set_permission_mode"}}),
        text("mode pending"),
        json!({"expect":{"type":"control_cancel_request"}}),
        text("still running"),
        json!({"expect":{"subtype":"set_permission_mode"}}),
        json!({"reply":{}}),
        json!({"expect_pair":[{"/type":"user","/message/content/0/text":"delivered"},
            {"/type":"control_response","/response/request_id":"q1"}]}),
        result(),
    ]);
    let (session, mut events) = session(script);
    let first = session.start_turn(request("one")).await.unwrap();
    until(&mut events, "question-request").await;
    let pid = session.pid().unwrap();
    let mut r = request("never sent");
    r.permission_mode = Some("full".into());
    let mut steer = Box::pin(session.start_turn(r.clone()));
    tokio::select! { _=&mut steer=>panic!("unexpected steer"), e=next(&mut events)=>assert_eq!(e["text"], "mode pending") }
    drop(steer);
    assert!(!session.is_closed());
    assert!(session.turn_active());
    assert_eq!(session.pid(), Some(pid));
    assert_eq!(next(&mut events).await["text"], "still running");
    assert!(events.try_recv().is_none()); // No cancellation or question dismissal.
    r.content = request("delivered").content;
    let second = session.start_turn(r).await.unwrap();
    assert_eq!(first.turn_id, second.turn_id);
    assert!(second.steered);
    let trace = until(&mut events, "turn-completed").await;
    assert_eq!(kinds(&trace), ["question-resolved", "turn-completed"]);
    session.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn terminal_during_steer_mode_change_starts_a_new_owned_turn() {
    let mut script = handshake();
    script.extend([
        json!({"expect":{"type":"user"}}),
        init(),
        json!({"expect":{"subtype":"set_permission_mode"}}),
        result(),
        json!({"reply":{}}),
        json!({"expect":{"type":"user"}}),
        text("second"),
        result(),
    ]);
    let (session, mut events) = session(script);
    let first = session.start_turn(request("one")).await.unwrap();
    until(&mut events, "session-started").await;
    let mut r = request("two");
    r.permission_mode = Some("full".into());
    let second = session.start_turn(r).await.unwrap();
    assert!(!second.steered);
    assert_ne!(first.turn_id, second.turn_id);
    let trace = until(&mut events, "turn-completed").await;
    assert_eq!(kinds(&trace), ["turn-completed"]);
    let trace = until(&mut events, "turn-completed").await;
    assert_eq!(kinds(&trace), ["turn-started", "text-delta", "turn-completed"]);
    assert_eq!(trace[1]["messageId"], json!(second.turn_id));
    session.close().await;
}

#[tokio::test]
async fn oversize_messages_report_failure_without_steering_acknowledgement() {
    let mut script = handshake();
    script.extend([json!({"expect":{"type":"user"}}), init()]);
    let (session, mut events) = configured(script, |o| o.limits.max_outgoing_frame_bytes = 1024);
    let rejected = session.start_turn(request(&"x".repeat(2000))).await.unwrap();
    assert!(rejected.turn_id.is_none());
    assert_eq!(kinds(&until(&mut events, "turn-failed").await), ["turn-started", "turn-failed"]);
    session.start_turn(request("small")).await.unwrap();
    until(&mut events, "session-started").await;
    assert!(session.start_turn(request(&"x".repeat(2000))).await.is_err());
    assert!(session.turn_active()); // Failed steering did not end the accepted original turn.
    session.close().await;
}

#[tokio::test]
async fn process_crash_preserves_resume_id_and_reports_once() {
    let mut script = handshake();
    script.extend([json!({"expect":{"type":"user"}}), json!({"exit":7})]);
    let (session, mut events) = configured(script, |o| o.resume_id = Some("saved-session".into()));
    session.start_turn(request("one")).await.unwrap();
    let trace = until(&mut events, "turn-failed").await;
    assert_eq!(kinds(&trace), ["turn-started", "turn-failed"]);
    assert!(trace.last().unwrap()["message"].as_str().unwrap().contains("code 7"));
    assert_eq!(session.native_id().as_deref(), Some("saved-session"));
    assert!(events.recv().await.is_none());
}

#[tokio::test]
async fn turn_settings_apply_in_order_and_task_output_is_shaped() {
    let mut script = handshake();
    script.extend([
        json!({"expect":{"type":"user"}}),
        init(),
        result(),
        json!({"expect":{"subtype":"set_model","fields":{"/request/model":"opus"}}}),
        json!({"reply":{}}),
        json!({"expect":{"subtype":"set_permission_mode","fields":{"/request/mode":"acceptEdits"}}}),
        json!({"reply":{}}),
        json!({"expect":{"subtype":"apply_flag_settings","fields":{"/request/settings":{"effortLevel":"high","ultracode":true}}}}),
        json!({"reply":{}}),
        json!({"expect":{"subtype":"apply_flag_settings","fields":{"/request/settings":{"fastMode":true}}}}),
        json!({"reply":{}}),
        json!({"expect":{"subtype":"apply_flag_settings","fields":{"/request/settings":{"outputStyle":"Concise"}}}}),
        json!({"reply_error":"unsupported style"}),
        json!({"expect":{"type":"user"}}),
        result(),
        json!({"expect":{"subtype":"get_task_output","fields":{"/request/task_id":"task1"}}}),
        json!({"reply":{"output":"tail","total_bytes":9000,"truncated":true}}),
        json!({"expect":{"type":"user"}}),
        result(),
    ]);
    let (session, mut events) = session(script);
    session.start_turn(request("one")).await.unwrap();
    until(&mut events, "turn-completed").await;
    let mut r = request("two");
    r.model = "opus".into();
    r.permission_mode = Some("auto".into());
    r.effort = Some("high".into());
    r.ultracode = true;
    r.fast_mode = true;
    r.replies = Some("concise".into());
    session.start_turn(r.clone()).await.unwrap();
    until(&mut events, "turn-completed").await;
    assert_eq!(session.task_output("task1").await.unwrap(), json!({"output":"tail","totalBytes":9000,"truncated":true}));
    session.start_turn(r).await.unwrap(); // Unsupported style is not retried.
    until(&mut events, "turn-completed").await;
    session.close().await;
}

#[tokio::test]
async fn question_answers_are_filtered_and_full_still_asks() {
    let mut script = handshake();
    script.extend([json!({"expect":{"type":"user"}}),question("q1"),
        json!({"expect":{"type":"control_response","fields":{"/response/response/behavior":"allow","/response/response/updatedInput/answers":{"Which?":"A"}}}}),result()]);
    let (session, mut events) = session(script);
    let mut r = request("one");
    r.permission_mode = Some("full".into());
    session.start_turn(r).await.unwrap();
    let trace = until(&mut events, "question-request").await;
    let card = trace.last().unwrap();
    let question_id = card["questions"][0]["id"].as_str().unwrap();
    let answers = serde_json::Map::from_iter([(question_id.to_owned(), json!(["A"])), ("unknown".into(), json!(["ignored"]))]);
    assert!(session.answer_question("q1", Some(&answers)));
    assert!(!session.answer_question("q1", Some(&answers)));
    let trace = until(&mut events, "turn-completed").await;
    assert_eq!(trace[0]["outcome"], "answered");
    session.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_close_callers_both_wait_for_process_cleanup() {
    let mut script = handshake();
    script.extend([json!({"expect":{"type":"user"}}), init(), json!({"sleep_ms":10000})]);
    let (session, mut events) = session(script);
    session.start_turn(request("one")).await.unwrap();
    until(&mut events, "session-started").await;
    let pid = session.pid().unwrap();
    tokio::join!(
        async {
            session.close().await;
            assert!(!pid_alive(pid as i32));
        },
        async {
            session.close().await;
            assert!(!pid_alive(pid as i32));
        }
    );
    assert_eq!(next(&mut events).await["type"], "turn-cancelled");
    assert!(events.recv().await.is_none());
}

fn background_launch() -> Value {
    json!({"emit":{"type":"assistant","message":{"content":[{"type":"tool_use","id":"child","name":"Agent","input":{"description":"Review","run_in_background":true}}]}}})
}
fn background_shell() -> Value {
    json!({"emit":{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"shell","task_type":"local_bash","description":"Build"}]}})
}
#[tokio::test]
async fn background_work_survives_turn_but_close_settles_once() {
    let mut script = handshake();
    script.extend([json!({"expect":{"type":"user"}}), init(), background_launch(), background_shell(), result()]);
    let (session, mut events) = configured(script, |o| o.clock = Some(Arc::new(|| 1234)));
    session.start_turn(request("one")).await.unwrap();
    let trace = until(&mut events, "turn-completed").await;
    assert_eq!(trace.iter().filter(|e| e["type"] == "subagent-update").count(), 1);
    assert_eq!(trace.iter().find(|e| e["type"] == "subagent-update").unwrap()["agent"]["status"], "running");
    assert!(!session.turn_active());
    session.close().await;
    let child = next(&mut events).await;
    assert_eq!(child["agent"]["id"], "child");
    assert_eq!(child["agent"]["status"], "cancelled");
    assert_eq!(child["agent"]["endedAt"], 1234);
    assert_eq!(next(&mut events).await, json!({"type":"background-tasks","tasks":[]}));
    session.close().await;
    assert!(events.recv().await.is_none());
}
#[tokio::test]
async fn process_crash_settles_children_and_background_before_turn_failure() {
    let mut script = handshake();
    script.extend([json!({"expect":{"type":"user"}}), init(), background_launch(), background_shell(), json!({"exit":7})]);
    let (session, mut events) = session(script);
    session.start_turn(request("one")).await.unwrap();
    let trace = until(&mut events, "turn-failed").await;
    assert_eq!(kinds(&trace[trace.len() - 3..]), ["subagent-update", "background-tasks", "turn-failed"]);
    assert_eq!(trace[trace.len() - 3]["agent"]["status"], "failed");
    assert_eq!(trace[trace.len() - 2]["tasks"], json!([]));
    assert!(events.recv().await.is_none());
}

#[tokio::test]
async fn analysis_sessions_refuse_before_spawn_even_with_preapproved_writes_and_full_mode() {
    for mode in ["ask", "auto", "full"] {
        let (session, mut events) = configured(vec![json!({"exit":99})], |o| {
            o.analysis_only = true;
            o.launch.setting_sources = Some(vec!["user".into(), "project".into()]);
            o.launch.settings = Some(json!({"permissions":{"allow":["Write", "Bash(*)"]}}));
            o.launch.allowed_tools = vec!["Write".into()];
            o.launch.allow_dangerously_skip_permissions = true;
        });
        let mut r = request("write a file");
        r.permission_mode = Some(mode.into());
        assert!(matches!(session.start_turn(r).await, Err(milagre_claude::session::SessionError::UnsupportedAnalysis)));
        assert!(session.pid().is_none());
        assert!(!session.turn_active());
        assert!(events.try_recv().is_none());
        session.close().await;
    }
}

#[tokio::test]
async fn auto_mode_rechecks_pending_edit_paths_and_fails_closed() {
    for case in ["inside", "missing-cwd", "relative-cwd", "empty", "nonstring", "parent", "outside", "blocked", "swapped-link"] {
        let root = scratch("auto-path");
        let cwd = root.join("workspace");
        let outside = root.join("outside");
        std::fs::create_dir_all(cwd.join("nested")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let path = match case {
            "empty" => String::new(),
            "parent" => "nested/../new.txt".into(),
            "outside" => outside.join("new.txt").to_string_lossy().into_owned(),
            _ => "nested/new.txt".into(),
        };
        let mut permission = json!({"request":{"id":"edit", "request":{"subtype":"can_use_tool", "tool_name":"Write", "input":{"file_path":path, "content":"hello"}, "tool_use_id":"write"}}});
        if case == "nonstring" {
            permission["request"]["request"]["input"]["file_path"] = json!(123);
        }
        if case == "blocked" {
            permission["request"]["request"]["blocked_path"] = json!("nested/new.txt");
        }
        let mut script = handshake();
        script.extend([json!({"expect":{"type":"user"}}), permission]);
        if case == "inside" {
            script.push(json!({"expect_pair":[{"/type":"control_request","/request/subtype":"set_permission_mode"}, {"/type":"control_response","/response/response/behavior":"allow"}]}));
        } else {
            script.extend([
                json!({"expect":{"subtype":"set_permission_mode"}}),
                json!({"reply":{}}),
                json!({"expect":{"type":"control_response","fields":{"/response/response/behavior":"deny"}}}),
            ]);
        }
        script.push(result());
        let (session, mut events) = configured(script, |o| {
            o.launch.cwd = match case {
                "missing-cwd" => None,
                "relative-cwd" => Some(".".into()),
                _ => Some(cwd.clone()),
            }
        });
        session.start_turn(request("one")).await.unwrap();
        until(&mut events, "permission-request").await;
        #[cfg(unix)]
        if case == "swapped-link" {
            std::fs::remove_dir(cwd.join("nested")).unwrap();
            std::os::unix::fs::symlink(&outside, cwd.join("nested")).unwrap();
        }
        session.set_permission_mode("auto").await;
        if case != "inside" {
            assert!(events.try_recv().is_none(), "unexpected authorization for {case}");
            assert!(session.respond_to_permission("edit", "deny"), "lost card for {case}");
        }
        let trace = until(&mut events, "turn-completed").await;
        assert_eq!(trace[0]["decision"], if case == "inside" { "allow" } else { "deny" }, "{case}");
        session.close().await;
        std::fs::remove_dir_all(root).unwrap();
    }
}

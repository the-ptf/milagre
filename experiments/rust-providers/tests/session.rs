//! CodexSession lifecycle against the Rust fake and the repository's Node fake.

mod common;

use common::*;
use milagre_providers::codex::approvals::{Decision, QuestionOutcome};
use milagre_providers::codex::client::{CodexClient, ConnectOptions};
use milagre_providers::codex::session::{chat_thread, prompt_input, turn};
use milagre_providers::codex::{
    codex_policy, CodexPolicy, CodexSession, PermissionMode, ResumeError, SessionError, SessionEvent, SessionOptions, SpawnOptions, TurnEnd,
};
use serde_json::json;
use std::time::Duration;
use tokio::sync::mpsc::UnboundedReceiver;

fn policy() -> CodexPolicy {
    codex_policy(PermissionMode::Ask, "/repo", &[], false, false)
}

fn options(spawn: SpawnOptions) -> SessionOptions {
    let mut options = SessionOptions::new(ConnectOptions::new(spawn, "0.0.0-test"), "/repo");
    options.interrupt_grace = Duration::from_millis(400);
    options
}

async fn start(spawn: SpawnOptions) -> (CodexSession, UnboundedReceiver<SessionEvent>) {
    start_with(options(spawn)).await
}

async fn start_with(options: SessionOptions) -> (CodexSession, UnboundedReceiver<SessionEvent>) {
    CodexSession::start(options, chat_thread(Some("gpt-fake".into()), policy())).await.expect("session starts")
}

async fn next<T>(events: &mut UnboundedReceiver<SessionEvent>, mut pick: impl FnMut(&SessionEvent) -> Option<T>) -> T {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = events.recv().await.expect("session events ended");
            if let Some(found) = pick(&event) {
                return found;
            }
        }
    })
    .await
    .expect("timed out waiting for a session event")
}

async fn turn_end(events: &mut UnboundedReceiver<SessionEvent>) -> TurnEnd {
    next(events, |e| match e {
        SessionEvent::TurnEnded { end, .. } => Some(end.clone()),
        _ => None,
    })
    .await
}

async fn deltas_until_end(events: &mut UnboundedReceiver<SessionEvent>) -> (Vec<String>, TurnEnd) {
    let mut deltas = Vec::new();
    loop {
        match next(events, |e| match e {
            SessionEvent::AgentMessageDelta { delta, .. } => Some(Ok(delta.clone())),
            SessionEvent::TurnEnded { end, .. } => Some(Err(end.clone())),
            _ => None,
        })
        .await
        {
            Ok(delta) => deltas.push(delta),
            Err(end) => return (deltas, end),
        }
    }
}

async fn permission(events: &mut UnboundedReceiver<SessionEvent>) -> serde_json::Value {
    next(events, |e| match e {
        SessionEvent::PermissionRequest(card) => Some(card.clone()),
        _ => None,
    })
    .await
}

#[tokio::test]
async fn starts_a_thread_and_streams_a_turn() {
    let (session, mut events) = start(fake("reply")).await;
    let thread = next(&mut events, |e| match e {
        SessionEvent::ThreadStarted { thread_id } => Some(thread_id.clone()),
        _ => None,
    })
    .await;
    assert_eq!(thread, "thread-1");
    assert_eq!(session.client().initialize_result()["userAgent"], "fake-rust/0.167.0");
    let turn_id = session.start_turn(turn(prompt_input("hi", &[]), Some("gpt-fake".into()), policy())).await.unwrap();
    assert_eq!(turn_id.as_deref(), Some("turn-1"));
    let (deltas, end) = deltas_until_end(&mut events).await;
    assert_eq!((deltas.join(""), end), ("Hello".to_string(), TurnEnd::Completed));
    assert!(!session.turn_active());
    // The handshake and thread/start params went out as codex-provider.cjs sends them.
    let frames = session.client().rpc().request("fake/received", json!({})).await.unwrap()["received"].clone();
    let frames = frames.as_array().unwrap();
    assert_eq!(frames[0]["method"], "initialize");
    assert_eq!(
        frames[0]["params"],
        json!({ "clientInfo": { "name": "milagre", "title": "Milagre", "version": "0.0.0-test" }, "capabilities": null })
    );
    assert_eq!(frames[1], json!({ "method": "initialized" }));
    assert_eq!(frames[2]["method"], "account/read");
    assert_eq!(frames[2]["params"], json!({ "refreshToken": false }));
    let start = &frames[3];
    assert_eq!(start["method"], "thread/start");
    assert_eq!(start["params"]["approvalPolicy"], "untrusted");
    assert_eq!(start["params"]["sandbox"], "workspace-write");
    assert_eq!(start["params"]["config"]["features"]["default_mode_request_user_input"], true);
    let turn_start = &frames[4]["params"];
    assert_eq!(turn_start["input"], json!([{ "type": "text", "text": "hi", "text_elements": [] }]));
    assert_eq!((turn_start["summary"].as_str(), turn_start["serviceTierForTurn"].as_str()), (Some("auto"), Some("default")));
    assert_eq!(turn_start["sandboxPolicy"]["writableRoots"], json!(["/repo"]));
    session.close().await;
}

#[tokio::test]
async fn a_command_approval_becomes_a_card_and_is_answered_once() {
    let (session, mut events) = start(fake("approval")).await;
    session.start_turn(turn(prompt_input("clean", &[]), None, policy())).await.unwrap();
    let card = permission(&mut events).await;
    assert_eq!(
        card,
        json!({ "requestId": "srv-1", "kind": "command", "tool": "Shell", "title": "Run this command?", "command": "rm -rf build",
                "cwd": "/repo", "reason": "Clean the build", "allowForChat": true, "stepId": "cmd-1" })
    );
    assert_eq!(session.open_requests(), ["srv-1"]);
    assert!(session.respond_to_permission("srv-1", Decision::Deny).await);
    assert!(!session.respond_to_permission("srv-1", Decision::Allow).await);
    let (deltas, end) = deltas_until_end(&mut events).await;
    assert_eq!((deltas, end), (vec!["decision:decline".to_string()], TurnEnd::Completed));
    session.close().await;
}

#[tokio::test]
async fn a_file_change_approval_carries_the_started_items_diff() {
    let (session, mut events) = start(fake("file-approval")).await;
    session.start_turn(turn(prompt_input("write", &[]), None, policy())).await.unwrap();
    let card = permission(&mut events).await;
    assert_eq!(card["requestId"], "7");
    assert_eq!(card["title"], "Edit notes.txt?");
    assert_eq!(card["diff"], "--- /repo/notes.txt\n+hello\n");
    assert!(session.respond_to_permission("7", Decision::AllowForChat).await);
    let (deltas, _) = deltas_until_end(&mut events).await;
    assert_eq!(deltas, ["decision:acceptForSession"]);
    session.close().await;
}

#[tokio::test]
async fn a_question_is_answered_in_codex_shape() {
    let (session, mut events) = start(fake("question")).await;
    session.start_turn(turn(prompt_input("ask me", &[]), None, policy())).await.unwrap();
    let card = next(&mut events, |e| match e {
        SessionEvent::QuestionRequest(card) => Some(card.clone()),
        _ => None,
    })
    .await;
    assert_eq!(card["requestId"], "srv-q");
    assert_eq!(card["questions"][0]["options"][1], json!({ "label": "Green", "description": "Calm" }));
    // A permission answer can't settle a question.
    assert!(!session.respond_to_permission("srv-q", Decision::Allow).await);
    assert!(session.answer_question("srv-q", QuestionOutcome::Answered(vec![("color".into(), vec!["Red".into()])])).await);
    let (deltas, _) = deltas_until_end(&mut events).await;
    assert_eq!(deltas, [r#"answer:{"answers":{"color":{"answers":["Red"]}}}"#]);
    session.close().await;
}

#[tokio::test]
async fn a_withdrawn_request_is_forgotten() {
    let (session, mut events) = start(fake("withdrawn")).await;
    session.start_turn(turn(prompt_input("go", &[]), None, policy())).await.unwrap();
    let withdrawn = next(&mut events, |e| match e {
        SessionEvent::RequestWithdrawn { request_id } => Some(request_id.clone()),
        _ => None,
    })
    .await;
    assert_eq!(withdrawn, "srv-1");
    assert_eq!(turn_end(&mut events).await, TurnEnd::Completed);
    assert!(session.open_requests().is_empty());
    assert!(!session.respond_to_permission("srv-1", Decision::Allow).await);
    session.close().await;
}

#[tokio::test]
async fn milagre_plan_tools_are_allowed_without_a_card_and_others_ask() {
    let (session, mut events) = start(fake("mcp-plan")).await;
    session.start_turn(turn(prompt_input("plan", &[]), None, policy())).await.unwrap();
    let (deltas, _) = deltas_until_end(&mut events).await;
    assert_eq!(deltas, [r#"answer:{"action":"accept","content":{}}"#]);
    session.close().await;

    let (session, mut events) = start(fake("mcp-gated")).await;
    session.start_turn(turn(prompt_input("delete", &[]), None, policy())).await.unwrap();
    let card = permission(&mut events).await;
    assert_eq!((card["tool"].as_str(), card["allowForChat"].as_bool()), (Some("MCP: milagre"), Some(false)));
    assert_eq!(card["detail"], "{\n  \"id\": \"daily-notes\"\n}");
    session.respond_to_permission("srv-mcp", Decision::Deny).await;
    let (deltas, _) = deltas_until_end(&mut events).await;
    assert_eq!(deltas, [r#"answer:{"action":"decline","content":null}"#]);
    session.close().await;
}

#[tokio::test]
async fn extra_permissions_and_unknown_requests_get_fixed_answers() {
    let (session, mut events) = start(fake("permissions")).await;
    session.start_turn(turn(prompt_input("x", &[]), None, policy())).await.unwrap();
    let (deltas, _) = deltas_until_end(&mut events).await;
    assert_eq!(deltas, [r#"answer:{"permissions":{},"scope":"turn"}"#]);
    session.close().await;

    let (session, mut events) = start(fake("unknown-request")).await;
    session.start_turn(turn(prompt_input("x", &[]), None, policy())).await.unwrap();
    let (deltas, _) = deltas_until_end(&mut events).await;
    assert_eq!(deltas, [r#"answer:{"code":-32601,"message":"Milagre does not support item/somethingNew/request yet."}"#]);
    session.close().await;
}

#[tokio::test]
async fn advisors_refuse_approvals_without_a_card() {
    let mut opts = options(fake("approval"));
    opts.analysis_only = true;
    let (session, mut events) = start_with(opts).await;
    session.start_turn(turn(prompt_input("x", &[]), None, policy())).await.unwrap();
    let (deltas, _) = deltas_until_end(&mut events).await;
    assert_eq!(deltas, ["decision:decline"]);
    session.close().await;
}

#[tokio::test]
async fn interrupt_cancels_open_requests_and_ends_the_turn() {
    let (session, mut events) = start(fake("approval")).await;
    session.start_turn(turn(prompt_input("x", &[]), None, policy())).await.unwrap();
    permission(&mut events).await;
    session.interrupt().await;
    let (deltas, end) = deltas_until_end(&mut events).await;
    assert_eq!((deltas, end), (vec!["decision:cancel".to_string()], TurnEnd::Cancelled));
    assert!(session.client().rpc().is_running(), "an honoured interrupt keeps the process");
    // The next turn starts normally on the same thread.
    assert_eq!(session.start_turn(turn(prompt_input("again", &[]), None, policy())).await.unwrap().as_deref(), Some("turn-2"));
    session.close().await;
}

#[tokio::test]
async fn an_honoured_interrupt_on_a_running_turn() {
    let (session, mut events) = start(fake("slow")).await;
    session.start_turn(turn(prompt_input("x", &[]), None, policy())).await.unwrap();
    assert_eq!(session.start_turn(turn(prompt_input("y", &[]), None, policy())).await.unwrap_err(), SessionError::TurnActive);
    session.steer(prompt_input("more", &[])).await.unwrap();
    let delta = next(&mut events, |e| match e {
        SessionEvent::AgentMessageDelta { delta, .. } => Some(delta.clone()),
        _ => None,
    })
    .await;
    assert_eq!(delta, "steered");
    session.interrupt().await;
    assert_eq!(turn_end(&mut events).await, TurnEnd::Cancelled);
    assert!(session.client().rpc().is_running());
    session.close().await;
}

#[tokio::test]
async fn an_ignored_interrupt_kills_the_process_after_the_grace() {
    let (session, mut events) = start(fake("stubborn")).await;
    let pid = session.client().rpc().pid().unwrap();
    session.start_turn(turn(prompt_input("x", &[]), None, policy())).await.unwrap();
    let started = tokio::time::Instant::now();
    session.interrupt().await;
    assert!(started.elapsed() < Duration::from_secs(3));
    assert_eq!(turn_end(&mut events).await, TurnEnd::Cancelled);
    next(&mut events, |e| matches!(e, SessionEvent::Exited(_)).then_some(())).await;
    assert!(eventually(|| !pid_alive(pid), Duration::from_secs(2)).await);
    assert!(matches!(session.start_turn(turn(prompt_input("y", &[]), None, policy())).await, Err(SessionError::Closed)));
}

#[tokio::test]
async fn a_crash_mid_turn_ends_it_with_stderr() {
    let (session, mut events) = start(fake("crash")).await;
    let _ = session.start_turn(turn(prompt_input("x", &[]), None, policy())).await;
    assert_eq!(turn_end(&mut events).await, TurnEnd::Crashed { detail: "boom: model unavailable".into() });
    let exit = next(&mut events, |e| match e {
        SessionEvent::Exited(exit) => Some(exit.clone()),
        _ => None,
    })
    .await;
    assert_eq!(exit.code, Some(3));
}

#[tokio::test]
async fn a_failed_turn_reports_codexs_message() {
    let (session, mut events) = start(fake("fail")).await;
    session.start_turn(turn(prompt_input("x", &[]), None, policy())).await.unwrap();
    assert_eq!(turn_end(&mut events).await, TurnEnd::Failed { message: "The model gpt-x is not supported.".into() });
    session.close().await;
}

#[tokio::test]
async fn a_logged_out_codex_is_refused_and_stopped() {
    let error = CodexSession::start(options(fake("logged-out")), chat_thread(None, policy())).await.err().unwrap();
    assert_eq!(error, SessionError::LoginRequired);
}

#[tokio::test]
async fn resume_falls_back_to_unarchive_then_reports_failure() {
    let mut opts = options(fake("reply"));
    opts.resume_thread_id = Some("saved-7".into());
    let (session, mut events) = start_with(opts).await;
    let thread = next(&mut events, |e| match e {
        SessionEvent::ThreadStarted { thread_id } => Some(thread_id.clone()),
        _ => None,
    })
    .await;
    assert_eq!(thread, "saved-7");
    session.close().await;

    let mut opts = options(fake("reply"));
    opts.resume_thread_id = Some("missing".into());
    let error = CodexSession::start(opts, chat_thread(None, policy())).await.err().unwrap();
    assert!(matches!(error, SessionError::Resume(ResumeError::ResumeFailed { ref thread_id, .. }) if thread_id == "missing"), "{error:?}");
}

#[tokio::test]
async fn hung_initialize_times_out_and_stops_the_process() {
    let mut connect = ConnectOptions::new(fake("hang-init"), "0");
    connect.initialize_timeout = Some(Duration::from_millis(200));
    let error = CodexClient::connect(connect).await.err().unwrap();
    assert!(error.to_string().contains("did not answer initialize"), "{error}");
}

#[tokio::test]
async fn model_list_follows_cursors_without_looping() {
    let (client, _events) = CodexClient::connect(ConnectOptions::new(fake("reply"), "0")).await.unwrap();
    let ids: Vec<String> = client.list_models().await.unwrap().iter().map(|m| m["id"].as_str().unwrap().to_string()).collect();
    assert_eq!(ids, ["gpt-fake-1", "gpt-fake-2"]);
    let status = client.account_status().await.unwrap();
    assert!(!status.login_required());
    client.close().await;
}

// Same scenarios, against the Node fake the Node provider tests use (skipped without node).

#[tokio::test]
async fn node_fake_approval_and_question_round_trip() {
    let Some(spawn) = node_fake("approval") else { return eprintln!("node not installed; skipped") };
    let (session, mut events) = start(spawn).await;
    session.start_turn(turn(prompt_input("x", &[]), None, policy())).await.unwrap();
    let card = permission(&mut events).await;
    assert_eq!((card["requestId"].as_str(), card["command"].as_str()), (Some("srv-1"), Some("rm -rf build")));
    session.respond_to_permission("srv-1", Decision::Allow).await;
    let (deltas, end) = deltas_until_end(&mut events).await;
    assert_eq!((deltas, end), (vec!["decision:accept".to_string()], TurnEnd::Completed));
    session.close().await;

    let (session, mut events) = start(node_fake("question").unwrap()).await;
    session.start_turn(turn(prompt_input("x", &[]), None, policy())).await.unwrap();
    next(&mut events, |e| matches!(e, SessionEvent::QuestionRequest(_)).then_some(())).await;
    session.answer_question("srv-q", QuestionOutcome::Answered(vec![("color".into(), vec!["Green".into()])])).await;
    let (deltas, _) = deltas_until_end(&mut events).await;
    assert_eq!(deltas, [r#"answer:{"answers":{"color":{"answers":["Green"]}}}"#]);
    session.close().await;
}

#[tokio::test]
async fn node_fake_plan_tool_and_extra_permissions() {
    let Some(spawn) = node_fake("mcp-plan-approval") else { return };
    let (session, mut events) = start(spawn).await;
    session.start_turn(turn(prompt_input("x", &[]), None, policy())).await.unwrap();
    let (deltas, _) = deltas_until_end(&mut events).await;
    assert_eq!(deltas, [r#"answer:{"action":"accept","content":{}}"#]);
    session.close().await;

    let (session, mut events) = start(node_fake("permissions").unwrap()).await;
    session.start_turn(turn(prompt_input("x", &[]), None, policy())).await.unwrap();
    let (deltas, _) = deltas_until_end(&mut events).await;
    assert_eq!(deltas, [r#"answer:{"permissions":{},"scope":"turn"}"#]);
    session.close().await;
}

#[tokio::test]
async fn node_fake_crash_late_approval_and_resume() {
    let Some(spawn) = node_fake("crash") else { return };
    let (session, mut events) = start(spawn).await;
    let _ = session.start_turn(turn(prompt_input("x", &[]), None, policy())).await;
    assert_eq!(turn_end(&mut events).await, TurnEnd::Crashed { detail: "boom: model unavailable".into() });

    // Codex asks for an approval while the turn is stopping: nobody is asked, it is cancelled.
    let (session, mut events) = start(node_fake("late-approval").unwrap()).await;
    session.start_turn(turn(prompt_input("x", &[]), None, policy())).await.unwrap();
    session.interrupt().await;
    assert_eq!(turn_end(&mut events).await, TurnEnd::Cancelled);
    tokio::time::sleep(Duration::from_millis(250)).await;
    while let Ok(event) = events.try_recv() {
        assert!(!matches!(event, SessionEvent::PermissionRequest(_)), "late approval surfaced: {event:?}");
    }
    let frames = session.client().rpc().request("fake/received", json!({})).await.unwrap()["received"].clone();
    assert!(frames.as_array().unwrap().iter().any(|f| f["id"] == "srv-late" && f["result"]["decision"] == "cancel"), "{frames}");
    session.close().await;

    let mut opts = options(node_fake("reply").unwrap());
    opts.resume_thread_id = Some("missing".into());
    assert!(matches!(
        CodexSession::start(opts, chat_thread(None, policy())).await,
        Err(SessionError::Resume(ResumeError::ResumeFailed { .. }))
    ));
}

#[tokio::test]
async fn node_fake_hang_thread_waits_until_closed() {
    let Some(spawn) = node_fake("hang-thread") else { return };
    let (client, _events) = CodexClient::connect(ConnectOptions::new(spawn, "0")).await.unwrap();
    let waiting = tokio::spawn({
        let client = client.clone();
        async move { client.thread_start(json!({})).await }
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!waiting.is_finished());
    client.close().await;
    assert!(waiting.await.unwrap().unwrap_err().to_string().contains("exited"));
}

//! CodexSession lifecycle and mapped Milagre events, against the Rust fake and the repository's Node fake.

mod common;

use common::*;
use milagre_providers::codex::approvals::{Decision, QuestionOutcome};
use milagre_providers::codex::client::{CodexClient, ConnectOptions};
use milagre_providers::codex::events::login_message;
use milagre_providers::codex::session::{chat_thread, prompt_input, recover_codex_subagents, turn, SendOutcome};
use milagre_providers::codex::{
    codex_policy, CodexPolicy, CodexSession, ExitReason, PermissionMode, ResumeError, SessionError, SessionEvent, SessionOptions,
    SpawnOptions, TurnEnd,
};
use milagre_providers::queue::{EventReceiver, QueueLimits};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

type Events = EventReceiver<SessionEvent>;

fn policy() -> CodexPolicy {
    codex_policy(PermissionMode::Ask, "/repo", &[], false, false)
}

fn options(spawn: SpawnOptions) -> SessionOptions {
    let mut options = SessionOptions::new(ConnectOptions::new(spawn, "0.0.0-test"), "/repo");
    options.interrupt_grace = Duration::from_millis(400);
    options.subagent_poll_interval = Duration::from_millis(50);
    options
}

async fn start(spawn: SpawnOptions) -> (CodexSession, Events) {
    start_with(options(spawn)).await
}

async fn start_with(options: SessionOptions) -> (CodexSession, Events) {
    CodexSession::start(options, chat_thread(Some("gpt-fake".into()), policy())).await.expect("session starts")
}

fn send(prompt: &str) -> milagre_providers::codex::TurnSettings {
    turn(prompt_input(prompt, &[]), None, policy())
}

async fn next<T>(events: &mut Events, mut pick: impl FnMut(&SessionEvent) -> Option<T>) -> T {
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

/// The next Milagre event of a type.
async fn agent(events: &mut Events, kind: &str) -> Value {
    next(events, |e| match e {
        SessionEvent::Agent(event) if event["type"] == kind => Some(event.clone()),
        _ => None,
    })
    .await
}

/// Every Milagre event until the turn ends, then the end.
async fn until_end(events: &mut Events) -> (Vec<Value>, TurnEnd, Value) {
    let mut seen = Vec::new();
    loop {
        match next(events, |e| match e {
            // The thread's announcement comes before any turn.
            SessionEvent::Agent(event) if event["type"] == "session-started" => None,
            SessionEvent::Agent(event) => Some(Ok(event.clone())),
            SessionEvent::TurnEnded { end, event, .. } => Some(Err((end.clone(), event.clone()))),
            _ => None,
        })
        .await
        {
            Ok(event) => seen.push(event),
            Err((end, event)) => return (seen, end, event),
        }
    }
}

fn text_of(events: &[Value]) -> Vec<String> {
    events.iter().filter(|e| e["type"] == "text-delta").map(|e| e["text"].as_str().unwrap().to_string()).collect()
}

fn without_type(mut event: Value) -> Value {
    event.as_object_mut().unwrap().remove("type");
    event
}

#[tokio::test]
async fn starts_a_thread_and_streams_a_turn_as_milagre_events() {
    let (session, mut events) = start(fake("reply")).await;
    assert_eq!(agent(&mut events, "session-started").await, json!({ "type": "session-started", "nativeId": "thread-1" }));
    assert_eq!(session.thread_id().as_deref(), Some("thread-1"));
    let outcome = session.send(send("hi")).await.unwrap();
    assert_eq!(outcome, SendOutcome { turn_id: Some("turn-1".into()), steered: false });
    let (seen, end, event) = until_end(&mut events).await;
    assert_eq!(seen[0], json!({ "type": "turn-started", "turnId": "turn-1" }));
    assert_eq!(text_of(&seen), ["Hel", "lo"]);
    assert_eq!(seen[1], json!({ "type": "text-delta", "messageId": "turn-1", "text": "Hel" }));
    assert_eq!((end, event), (TurnEnd::Completed, json!({ "type": "turn-completed" })));
    assert!(!session.turn_active());
    let frames = session.client().rpc().request("fake/received", json!({})).await.unwrap()["received"].clone();
    let frames = frames.as_array().unwrap();
    assert_eq!(
        frames[0]["params"],
        json!({ "clientInfo": { "name": "milagre", "title": "Milagre", "version": "0.0.0-test" }, "capabilities": null })
    );
    assert_eq!(frames[1], json!({ "method": "initialized" }));
    assert_eq!(frames[3]["params"]["config"]["features"]["default_mode_request_user_input"], true);
    let turn_start = &frames[4]["params"];
    assert_eq!(turn_start["input"], json!([{ "type": "text", "text": "hi", "text_elements": [] }]));
    assert_eq!((turn_start["summary"].as_str(), turn_start["serviceTierForTurn"].as_str()), (Some("auto"), Some("default")));
    session.close().await;
}

#[tokio::test]
async fn steps_thinking_usage_and_plan_are_mapped() {
    let (session, mut events) = start(fake("steps")).await;
    session.send(send("test")).await.unwrap();
    let (seen, end, _) = until_end(&mut events).await;
    assert_eq!(end, TurnEnd::Completed);
    let types: Vec<&str> = seen.iter().map(|e| e["type"].as_str().unwrap()).collect();
    assert_eq!(
        types,
        [
            "turn-started",
            "step-started",
            "step-output",
            "step-completed",
            "step-started",
            "step-completed",
            "context-usage",
            "tasks-updated",
            "text-delta"
        ]
    );
    assert_eq!(seen[1]["step"], json!({ "id": "exec-1", "kind": "shell", "title": "Ran `npm test`", "detail": "$ npm test\n" }));
    assert_eq!(seen[3], json!({ "type": "step-completed", "id": "exec-1", "status": "done", "detail": "$ npm test\nok 1\nok 2\n" }));
    assert_eq!(seen[4]["step"], json!({ "id": "rs-1", "kind": "thinking", "title": "Thinking" }));
    assert_eq!(seen[5]["detail"], "Checked tests");
    assert!(seen[5]["title"].as_str().unwrap().starts_with("Thought for "));
    assert_eq!(seen[6], json!({ "type": "context-usage", "used": 1200, "size": 272000 }));
    assert_eq!(seen[7]["tasks"], json!([{ "id": "0", "content": "Run tests", "status": "completed" }]));
    session.close().await;
}

#[tokio::test]
async fn raw_notifications_are_optional() {
    let (session, mut events) = start(fake("reply")).await;
    session.send(send("x")).await.unwrap();
    until_end(&mut events).await;
    while let Ok(event) = events.try_recv() {
        assert!(!matches!(event, SessionEvent::Notification(_)));
    }
    session.close().await;

    let mut opts = options(fake("reply"));
    opts.forward_raw_notifications = true;
    let (session, mut events) = start_with(opts).await;
    session.send(send("x")).await.unwrap();
    let raw = next(&mut events, |e| match e {
        SessionEvent::Notification(n) if n.method == "item/agentMessage/delta" => Some(n.raw.clone()),
        _ => None,
    })
    .await;
    assert_eq!(raw["params"]["delta"], "Hel");
    session.close().await;
}

#[tokio::test]
async fn a_command_approval_becomes_a_card_and_is_answered_once() {
    let (session, mut events) = start(fake("approval")).await;
    session.send(send("clean")).await.unwrap();
    let card = agent(&mut events, "permission-request").await;
    assert_eq!(
        without_type(card),
        json!({ "requestId": "srv-1", "kind": "command", "tool": "Shell", "title": "Run this command?", "command": "rm -rf build",
                "cwd": "/repo", "reason": "Clean the build", "allowForChat": true, "stepId": "cmd-1" })
    );
    assert_eq!(session.open_requests(), ["srv-1"]);
    assert!(session.respond_to_permission("srv-1", Decision::Deny).await.unwrap());
    assert!(!session.respond_to_permission("srv-1", Decision::Allow).await.unwrap());
    let (seen, end, _) = until_end(&mut events).await;
    assert_eq!(seen[0], json!({ "type": "permission-resolved", "requestId": "srv-1", "decision": "deny" }));
    assert_eq!((text_of(&seen), end), (vec!["decision:decline".to_string()], TurnEnd::Completed));
    session.close().await;
}

#[tokio::test]
async fn permission_modes_answer_without_a_card() {
    // Full allows at once.
    let (session, mut events) = start(fake("approval")).await;
    let mut settings = send("x");
    settings.permission_mode = Some(PermissionMode::Full);
    session.send(settings).await.unwrap();
    let (seen, _, _) = until_end(&mut events).await;
    assert!(!seen.iter().any(|e| e["type"] == "permission-request"));
    assert_eq!(text_of(&seen), ["decision:accept"]);
    session.close().await;

    // Auto on a cwd that doesn't exist fails closed: a card (real folders: auto_allows_only_edits_...).
    let (session, mut events) = start(fake("file-approval")).await;
    let mut settings = send("x");
    settings.permission_mode = Some(PermissionMode::Auto);
    session.send(settings).await.unwrap();
    assert_eq!(agent(&mut events, "permission-request").await["requestId"], "7");
    session.close().await;

    // Switching to Full mid-turn allows an open card.
    let (session, mut events) = start(fake("approval")).await;
    session.send(send("x")).await.unwrap();
    agent(&mut events, "permission-request").await;
    session.set_permission_mode(PermissionMode::Full).await;
    let (seen, _, _) = until_end(&mut events).await;
    assert_eq!(seen[0]["decision"], "allow");
    assert_eq!(text_of(&seen), ["decision:accept"]);
    session.close().await;
}

#[tokio::test]
async fn allow_for_chat_is_downgraded_when_the_card_did_not_offer_it() {
    let (session, mut events) = start(fake("mcp-gated")).await;
    session.send(send("x")).await.unwrap();
    let card = agent(&mut events, "permission-request").await;
    assert_eq!(card["allowForChat"], false);
    session.respond_to_permission("srv-mcp", Decision::AllowForChat).await.unwrap();
    let (seen, _, _) = until_end(&mut events).await;
    assert_eq!(seen[0]["decision"], "allow");
    assert_eq!(text_of(&seen), [r#"answer:{"action":"accept","content":{}}"#]);
    session.close().await;
}

#[tokio::test]
async fn a_file_change_approval_carries_the_started_items_diff() {
    let (session, mut events) = start(fake("file-approval")).await;
    session.send(send("write")).await.unwrap();
    let card = agent(&mut events, "permission-request").await;
    assert_eq!((card["requestId"].as_str(), card["title"].as_str()), (Some("7"), Some("Edit notes.txt?")));
    assert_eq!(card["diff"], "--- /repo/notes.txt\n+hello\n");
    session.respond_to_permission("7", Decision::AllowForChat).await.unwrap();
    let (seen, _, _) = until_end(&mut events).await;
    assert_eq!(text_of(&seen), ["decision:acceptForSession"]);
    session.close().await;
}

#[tokio::test]
async fn questions_drop_blank_and_unknown_answers() {
    let (session, mut events) = start(fake("question")).await;
    session.send(send("ask")).await.unwrap();
    let card = agent(&mut events, "question-request").await;
    assert_eq!(card["questions"][0]["options"][1], json!({ "label": "Green", "description": "Calm" }));
    assert!(!session.respond_to_permission("srv-q", Decision::Allow).await.unwrap());
    let answers = vec![("color".into(), vec![" Red ".into(), "  ".into()]), ("nope".into(), vec!["x".into()])];
    assert!(session.answer_question("srv-q", QuestionOutcome::Answered(answers)).await.unwrap());
    let (seen, _, _) = until_end(&mut events).await;
    assert_eq!(seen[0], json!({ "type": "question-resolved", "requestId": "srv-q", "outcome": "answered" }));
    assert_eq!(text_of(&seen), [r#"answer:{"answers":{"color":{"answers":["Red"]}}}"#]);
    session.close().await;

    // Only blank answers: a dismissal.
    let (session, mut events) = start(fake("question")).await;
    session.send(send("ask")).await.unwrap();
    agent(&mut events, "question-request").await;
    session.answer_question("srv-q", QuestionOutcome::Answered(vec![("color".into(), vec![" ".into()])])).await.unwrap();
    let (seen, _, _) = until_end(&mut events).await;
    assert_eq!(seen[0]["outcome"], "dismissed");
    assert_eq!(text_of(&seen), [r#"answer:{"answers":{}}"#]);
    session.close().await;
}

#[tokio::test]
async fn a_withdrawn_request_resolves_as_cancelled() {
    let (session, mut events) = start(fake("withdrawn")).await;
    session.send(send("go")).await.unwrap();
    let (seen, end, _) = until_end(&mut events).await;
    let types: Vec<&str> = seen.iter().map(|e| e["type"].as_str().unwrap()).collect();
    assert_eq!(types, ["turn-started", "permission-request", "permission-resolved"]);
    assert_eq!(seen[2]["decision"], "cancelled");
    assert_eq!(end, TurnEnd::Completed);
    assert!(session.open_requests().is_empty());
    session.close().await;
}

#[tokio::test]
async fn plan_tools_extra_permissions_and_unknown_requests() {
    for (scenario, expected) in [
        ("mcp-plan", r#"answer:{"action":"accept","content":{}}"#),
        ("permissions", r#"answer:{"permissions":{},"scope":"turn"}"#),
        ("unknown-request", r#"answer:{"code":-32601,"message":"Milagre does not support item/somethingNew/request yet."}"#),
    ] {
        let (session, mut events) = start(fake(scenario)).await;
        session.send(send("x")).await.unwrap();
        let (seen, _, _) = until_end(&mut events).await;
        assert!(!seen.iter().any(|e| e["type"] == "permission-request"), "{scenario}");
        assert_eq!(text_of(&seen), [expected], "{scenario}");
        session.close().await;
    }
}

#[tokio::test]
async fn advisors_refuse_approvals_without_a_card() {
    let mut opts = options(fake("approval"));
    opts.analysis_only = true;
    let (session, mut events) = start_with(opts).await;
    session.send(send("x")).await.unwrap();
    let (seen, _, _) = until_end(&mut events).await;
    assert_eq!(text_of(&seen), ["decision:decline"]);
    session.close().await;
}

#[tokio::test]
async fn interrupt_cancels_open_requests_and_ends_the_turn() {
    let (session, mut events) = start(fake("approval")).await;
    session.send(send("x")).await.unwrap();
    agent(&mut events, "permission-request").await;
    session.interrupt().await;
    let (seen, end, event) = until_end(&mut events).await;
    assert_eq!(seen[0]["decision"], "cancelled");
    assert_eq!((end, event), (TurnEnd::Cancelled, json!({ "type": "turn-cancelled" })));
    assert!(session.client().rpc().is_running(), "an honoured interrupt keeps the process");
    assert_eq!(session.send(send("again")).await.unwrap().turn_id.as_deref(), Some("turn-2"));
    session.close().await;
}

#[tokio::test]
async fn a_second_message_steers_the_running_turn() {
    let (session, mut events) = start(fake("slow")).await;
    session.send(send("x")).await.unwrap();
    let outcome = session.send(send("more")).await.unwrap();
    assert_eq!(outcome, SendOutcome { turn_id: Some("turn-1".into()), steered: true });
    let delta = agent(&mut events, "text-delta").await;
    assert_eq!(delta["text"], "steered");
    session.interrupt().await;
    assert_eq!(until_end(&mut events).await.1, TurnEnd::Cancelled);
    session.close().await;
}

#[tokio::test]
async fn a_refused_steer_starts_the_next_turn() {
    let (session, mut events) = start(fake("steer-late")).await;
    session.send(send("x")).await.unwrap();
    let outcome = session.send(send("late")).await.unwrap();
    assert_eq!(outcome, SendOutcome { turn_id: Some("turn-2".into()), steered: false });
    assert_eq!(until_end(&mut events).await.1, TurnEnd::Completed);
    let frames = session.client().rpc().request("fake/received", json!({})).await.unwrap()["received"].clone();
    let starts: Vec<&Value> = frames.as_array().unwrap().iter().filter(|f| f["method"] == "turn/start").collect();
    assert_eq!(starts.len(), 2);
    assert_eq!(starts[1]["params"]["input"][0]["text"], "late");
    session.close().await;
}

#[tokio::test]
async fn an_ignored_interrupt_kills_the_process_after_the_grace() {
    let (session, mut events) = start(fake("stubborn")).await;
    let pid = session.pid().unwrap();
    session.send(send("x")).await.unwrap();
    let started = tokio::time::Instant::now();
    session.interrupt().await;
    assert!(started.elapsed() < Duration::from_secs(3));
    assert_eq!(until_end(&mut events).await.1, TurnEnd::Cancelled);
    next(&mut events, |e| matches!(e, SessionEvent::Exited(_)).then_some(())).await;
    assert!(eventually(|| !pid_alive(pid), Duration::from_secs(2)).await);
    assert_eq!(session.send(send("y")).await.unwrap_err(), SessionError::Closed);
}

#[tokio::test]
async fn a_crash_mid_turn_ends_it_with_milagres_crash_message() {
    let (session, mut events) = start(fake("crash")).await;
    let _ = session.send(send("x")).await;
    let (_, end, event) = until_end(&mut events).await;
    let message = "Codex stopped unexpectedly: boom: model unavailable. Send your message again to continue this chat.";
    assert_eq!(end, TurnEnd::Crashed { message: message.into() });
    assert_eq!(event, json!({ "type": "turn-failed", "message": message, "notice": true }));
    let exit = next(&mut events, |e| match e {
        SessionEvent::Exited(exit) => Some(exit.clone()),
        _ => None,
    })
    .await;
    assert_eq!(exit.code, Some(3));
}

#[tokio::test]
async fn a_failed_turn_and_a_401_login_notice() {
    let (session, mut events) = start(fake("fail")).await;
    session.send(send("x")).await.unwrap();
    let (_, end, event) = until_end(&mut events).await;
    assert_eq!(end, TurnEnd::Failed { message: "The model gpt-x is not supported.".into() });
    assert_eq!(event, json!({ "type": "turn-failed", "message": "The model gpt-x is not supported." }));
    session.close().await;

    // account/read said OpenAI auth is required, so a 401 means "log in"; the stale app-server is stopped.
    let (session, mut events) = start(fake("unauthorized")).await;
    session.send(send("x")).await.unwrap();
    let (_, _, event) = until_end(&mut events).await;
    assert_eq!(event, json!({ "type": "turn-failed", "message": login_message(), "notice": true, "login": true }));
    next(&mut events, |e| matches!(e, SessionEvent::Exited(_)).then_some(())).await;
    assert!(session.pid().is_none());
}

#[tokio::test]
async fn subagents_are_followed_and_polled_until_they_finish() {
    let (session, mut events) = start(fake("subagents")).await;
    session.send(send("spawn")).await.unwrap();
    let (seen, end, _) = until_end(&mut events).await;
    assert_eq!(end, TurnEnd::Completed);
    let spawned: Vec<&Value> = seen.iter().filter(|e| e["type"] == "subagent-update").collect();
    assert_eq!(spawned.last().unwrap()["agent"]["title"], "Review the auth flow");
    assert_eq!(spawned.last().unwrap()["agent"]["status"], "running");
    // The parent turn is over; the child's history arrives through polling, each item once.
    let mut transcript_ids = Vec::new();
    let finished = next(&mut events, |e| match e {
        SessionEvent::Agent(event) if event["type"] == "subagent-update" => {
            for row in event["agent"]["transcript"].as_array().unwrap() {
                let id = row["id"].as_str().unwrap().to_string();
                if !transcript_ids.contains(&id) {
                    transcript_ids.push(id);
                }
            }
            (event["agent"]["status"] == "completed").then(|| event["agent"].clone())
        }
        _ => None,
    })
    .await;
    assert_eq!(transcript_ids, ["cm-1", "cm-2"]);
    assert_eq!(finished["progress"], json!({ "steps": 2, "tools": {}, "said": "Done." }));
    assert!(finished["endedAt"].is_number());
    // Polling stops once the child is finished: no further child reads.
    let reads = || async {
        let frames = session.client().rpc().request("fake/received", json!({})).await.unwrap()["received"].clone();
        frames.as_array().unwrap().iter().filter(|f| f["method"] == "thread/read").count()
    };
    let before = reads().await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(reads().await, before);
    session.close().await;
}

#[tokio::test]
async fn closing_settles_running_subagents() {
    let mut opts = options(fake("subagents"));
    opts.subagent_poll_interval = Duration::from_secs(60);
    let (session, mut events) = start_with(opts).await;
    session.send(send("spawn")).await.unwrap();
    until_end(&mut events).await;
    session.close().await;
    let update = agent(&mut events, "subagent-update").await;
    assert_eq!(update["agent"]["status"], "cancelled");
    assert!(session.subagents().iter().all(|a| a["status"] == "cancelled"));
}

#[tokio::test]
async fn recovery_reads_only_unknown_children_without_replaying_history() {
    let agents = vec![
        json!({ "id": "done-child", "status": "unknown", "updatedAt": 5, "latestActivity": "Session disconnected. Reopen to check." }),
        json!({ "id": "active-child", "status": "unknown", "updatedAt": 5 }),
        json!({ "id": "old-child", "status": "unknown", "updatedAt": 5, "endedAt": 3 }),
        json!({ "id": "archived", "status": "unknown", "archived": true }),
        json!({ "id": "running", "status": "running" }),
    ];
    let events = recover_codex_subagents(ConnectOptions::new(fake("reply"), "0"), &agents).await;
    let agents: Vec<&Value> = events.iter().map(|e| &e["agent"]).collect();
    assert_eq!(agents.len(), 2);
    assert_eq!(
        (agents[0]["id"].as_str(), agents[0]["status"].as_str(), agents[0]["latestActivity"].as_str()),
        (Some("done-child"), Some("completed"), Some("Finished"))
    );
    assert!(agents[0]["endedAt"].as_i64().unwrap() > 5);
    assert_eq!(
        (agents[1]["id"].as_str(), agents[1]["status"].as_str(), agents[1]["endedAt"].as_i64()),
        (Some("old-child"), Some("cancelled"), Some(3))
    );
    assert!(recover_codex_subagents(ConnectOptions::new(fake("reply"), "0"), &[json!({ "id": "x", "status": "running" })])
        .await
        .is_empty());
}

#[tokio::test]
async fn an_unread_session_stops_codex_but_still_reports_the_end() {
    let mut opts = options(fake("chatty"));
    opts.event_queue = QueueLimits { max_events: 20, max_bytes: 1 << 30 };
    let (session, mut events) = start_with(opts).await;
    let _ = session.send(send("x")).await;
    let exit = session.client().rpc().wait_exit().await;
    assert_eq!(exit.reason, ExitReason::Closed);
    let mut agent_events = 0;
    let end = loop {
        match tokio::time::timeout(Duration::from_secs(2), events.recv()).await.unwrap().unwrap() {
            SessionEvent::Agent(_) => agent_events += 1,
            SessionEvent::TurnEnded { end, .. } => break end,
            other => panic!("unexpected {other:?}"),
        }
    };
    assert!(agent_events <= 20);
    // The chatty turn either completed before the stop took effect, or crashed with the stall reason.
    if let TurnEnd::Crashed { message } = &end {
        assert!(message.contains("waiting to be read"), "{message}");
    }
    next(&mut events, |e| matches!(e, SessionEvent::Exited(_)).then_some(())).await;
}

#[tokio::test]
async fn a_logged_out_codex_is_refused_and_stopped() {
    let error = CodexSession::start(options(fake("logged-out")), chat_thread(None, policy())).await.err().unwrap();
    assert_eq!(error, SessionError::LoginRequired);
}

#[tokio::test]
async fn resume_keeps_the_id_or_reports_failure() {
    let mut opts = options(fake("reply"));
    opts.resume_thread_id = Some("saved-7".into());
    let (session, mut events) = start_with(opts).await;
    assert_eq!(session.thread_id().as_deref(), Some("saved-7"));
    // The same id resumed is no new session.
    session.send(send("x")).await.unwrap();
    let (seen, _, _) = until_end(&mut events).await;
    assert!(!seen.iter().any(|e| e["type"] == "session-started"));
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
    assert!(!client.account_status().await.unwrap().login_required());
    client.close().await;
}

// The Node fake the Node provider tests use (skipped without node).

#[tokio::test]
async fn node_fake_steps_scenario_maps_like_node() {
    let Some(spawn) = node_fake("steps") else { return eprintln!("node not installed; skipped") };
    let (session, mut events) = start(spawn).await;
    session.send(send("x")).await.unwrap();
    let (seen, end, _) = until_end(&mut events).await;
    assert_eq!(end, TurnEnd::Completed);
    let steps: Vec<&Value> = seen.iter().filter(|e| e["type"] == "step-started").map(|e| &e["step"]).collect();
    assert_eq!(steps[0]["title"], "Ran `npm test`");
    assert_eq!(steps[2], &json!({ "id": "exec-2", "kind": "edit", "title": "Created `notes.txt`", "file": "/repo/notes.txt" }));
    let edit = seen.iter().find(|e| e["type"] == "step-completed" && e["id"] == "exec-2").unwrap();
    assert_eq!(edit["detail"], "--- /repo/notes.txt\n+hello\n");
    assert_eq!(text_of(&seen), ["Done"]);
    session.close().await;
}

#[tokio::test]
async fn node_fake_approval_question_and_plan_tools() {
    let Some(spawn) = node_fake("approval") else { return };
    let (session, mut events) = start(spawn).await;
    session.send(send("x")).await.unwrap();
    let card = agent(&mut events, "permission-request").await;
    assert_eq!(card["command"], "rm -rf build");
    session.respond_to_permission("srv-1", Decision::Allow).await.unwrap();
    assert_eq!(text_of(&until_end(&mut events).await.0), ["decision:accept"]);
    session.close().await;

    let (session, mut events) = start(node_fake("question").unwrap()).await;
    session.send(send("x")).await.unwrap();
    agent(&mut events, "question-request").await;
    session.answer_question("srv-q", QuestionOutcome::Answered(vec![("color".into(), vec!["Green".into()])])).await.unwrap();
    assert_eq!(text_of(&until_end(&mut events).await.0), [r#"answer:{"answers":{"color":{"answers":["Green"]}}}"#]);
    session.close().await;

    let (session, mut events) = start(node_fake("mcp-plan-approval").unwrap()).await;
    session.send(send("x")).await.unwrap();
    assert_eq!(text_of(&until_end(&mut events).await.0), [r#"answer:{"action":"accept","content":{}}"#]);
    session.close().await;
}

#[tokio::test]
async fn node_fake_unauthorized_and_late_approval() {
    let Some(spawn) = node_fake("unauthorized") else { return };
    let (session, mut events) = start(spawn).await;
    session.send(send("x")).await.unwrap();
    assert_eq!(until_end(&mut events).await.2["login"], true);
    session.close().await;

    let (session, mut events) = start(node_fake("late-approval").unwrap()).await;
    session.send(send("x")).await.unwrap();
    session.interrupt().await;
    assert_eq!(until_end(&mut events).await.1, TurnEnd::Cancelled);
    tokio::time::sleep(Duration::from_millis(250)).await;
    while let Ok(event) = events.try_recv() {
        assert!(!matches!(&event, SessionEvent::Agent(e) if e["type"] == "permission-request"), "late approval surfaced: {event:?}");
    }
    let frames = session.client().rpc().request("fake/received", json!({})).await.unwrap()["received"].clone();
    assert!(frames.as_array().unwrap().iter().any(|f| f["id"] == "srv-late" && f["result"]["decision"] == "cancel"));
    session.close().await;
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

#[tokio::test]
async fn two_messages_at_once_start_one_turn_and_steer_the_other() {
    let (session, mut events) = start(fake("slow")).await;
    let (a, b) = tokio::join!(session.send(send("one")), session.send(send("two")));
    let (a, b) = (a.unwrap(), b.unwrap());
    assert_eq!(a.turn_id.as_deref(), Some("turn-1"));
    assert_eq!(b.turn_id.as_deref(), Some("turn-1"));
    assert_ne!(a.steered, b.steered);
    assert_eq!(agent(&mut events, "text-delta").await["text"], "steered");
    session.close().await;
}

fn with_pid_file(spawn: SpawnOptions) -> (SpawnOptions, std::path::PathBuf) {
    let file = std::env::temp_dir().join(format!("milagre-fake-pid-{}-{}", std::process::id(), rand_suffix()));
    let mut env = spawn.env.clone().unwrap_or_default();
    env.push(("FAKE_PID_FILE".into(), file.clone().into_os_string()));
    (SpawnOptions { env: Some(env), ..spawn }, file)
}

fn rand_suffix() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
}

async fn pid_from(file: &std::path::Path) -> u32 {
    let mut pid = None;
    eventually(
        || {
            pid = std::fs::read_to_string(file).ok().and_then(|s| s.parse().ok());
            pid.is_some()
        },
        Duration::from_secs(3),
    )
    .await;
    let _ = std::fs::remove_file(file);
    pid.expect("fake wrote its pid")
}

#[tokio::test]
async fn dropping_a_session_without_close_kills_codex() {
    let (session, events) = start(fake("reply")).await;
    let pid = session.pid().unwrap();
    drop(session);
    drop(events);
    assert!(eventually(|| !pid_alive(pid), Duration::from_secs(3)).await, "Codex outlived its dropped session");
}

#[tokio::test]
async fn cancelling_start_during_an_untimed_thread_start_kills_codex() {
    let (spawn, file) = with_pid_file(fake("hang-thread"));
    let started = tokio::time::timeout(Duration::from_millis(1500), CodexSession::start(options(spawn), chat_thread(None, policy()))).await;
    assert!(started.is_err(), "thread/start should hang");
    let pid = pid_from(&file).await;
    assert!(eventually(|| !pid_alive(pid), Duration::from_secs(3)).await, "Codex outlived a cancelled start");
}

#[tokio::test]
async fn a_cancelled_send_still_ends_its_turn() {
    let (session, mut events) = start(fake("hang-turn")).await;
    assert!(tokio::time::timeout(Duration::from_millis(100), session.send(send("x"))).await.is_err());
    // The caller gave up; the turn is stopped as Stop would (here by killing, since Codex never gave an id).
    let (_, end, _) = until_end(&mut events).await;
    assert_eq!(end, TurnEnd::Cancelled);
    assert!(!session.turn_active());
    next(&mut events, |e| matches!(e, SessionEvent::Exited(_)).then_some(())).await;
}

#[tokio::test]
async fn a_late_completion_of_a_timed_out_start_does_not_end_the_next_turn() {
    let (session, mut events) = start(fake("late-start")).await;
    let mut first = send("one");
    first.start_timeout = Some(Duration::from_millis(100));
    let first = session.send(first).await.unwrap_err();
    assert!(first.to_string().contains("did not answer turn/start"), "{first}");
    let (_, end, _) = until_end(&mut events).await;
    assert!(matches!(end, TurnEnd::Failed { .. }), "{end:?}");
    // turn-1's late answer, start, text and completion all arrive while turn-2 is starting.
    let outcome = session.send(send("two")).await.unwrap();
    assert_eq!(outcome.turn_id.as_deref(), Some("turn-2"));
    let started = agent(&mut events, "turn-started").await;
    assert_eq!(started["turnId"], "turn-2");
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(session.turn_active(), "turn-1's completion ended turn-2");
    assert_eq!(session.turn_id().as_deref(), Some("turn-2"));
    session.interrupt().await;
    let (seen, end, _) = until_end(&mut events).await;
    assert_eq!(end, TurnEnd::Cancelled);
    assert!(text_of(&seen).is_empty(), "turn-1's text leaked into turn-2: {seen:?}");
    assert!(!seen.iter().any(|e| e["type"] == "turn-started"), "{seen:?}");
    session.close().await;
}

#[tokio::test]
async fn numeric_and_string_server_request_ids_do_not_collide() {
    let mut opts = options(fake("dup-ids"));
    opts.forward_raw_notifications = true;
    let (session, mut events) = start_with(opts).await;
    session.send(send("x")).await.unwrap();
    let permission = agent(&mut events, "permission-request").await;
    let question = agent(&mut events, "question-request").await;
    assert_eq!(permission["requestId"], "5");
    assert_eq!(question["requestId"], "5#2");
    assert!(session.respond_to_permission("5", Decision::Deny).await.unwrap());
    assert!(session.answer_question("5#2", QuestionOutcome::Answered(vec![("q".into(), vec!["A".into()])])).await.unwrap());
    let mut answered = Vec::new();
    while answered.len() < 2 {
        answered.push(
            next(&mut events, |e| match e {
                SessionEvent::Notification(n) if n.method == "fake/answered" => Some(n.params.clone()),
                _ => None,
            })
            .await,
        );
    }
    assert_eq!(answered[0], json!({ "id": 5, "answer": { "decision": "decline" } }));
    assert_eq!(answered[1], json!({ "id": "5", "answer": { "answers": { "q": { "answers": ["A"] } } } }));
    session.close().await;
}

/// A real repo folder and an outside folder, and a session whose fake asks to edit `file`.
async fn auto_session(file: impl Fn(&Path) -> PathBuf) -> (CodexSession, Events, PathBuf) {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let base = std::env::temp_dir().join(format!("milagre-auto-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(base.join("repo/src")).unwrap();
    std::fs::create_dir_all(base.join("outside")).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(base.join("outside"), base.join("repo/out-dir")).unwrap();
    let mut spawn = fake("file-approval");
    let mut env = spawn.env.clone().unwrap();
    env.push(("FAKE_FILE".into(), file(&base).into_os_string()));
    spawn.env = Some(env);
    let mut opts = SessionOptions::new(ConnectOptions::new(spawn, "0"), base.join("repo").to_string_lossy());
    opts.interrupt_grace = Duration::from_millis(400);
    let (session, events) = start_with(opts).await;
    (session, events, base)
}

fn auto(prompt: &str) -> milagre_providers::codex::TurnSettings {
    let mut settings = send(prompt);
    settings.permission_mode = Some(PermissionMode::Auto);
    settings
}

#[tokio::test]
async fn auto_allows_only_edits_that_are_really_inside_the_workspace() {
    // Inside (a new file in a real folder): no card.
    let (session, mut events, base) = auto_session(|b| b.join("repo/src/new.txt")).await;
    session.send(auto("x")).await.unwrap();
    let (seen, _, _) = until_end(&mut events).await;
    assert!(!seen.iter().any(|e| e["type"] == "permission-request"));
    assert_eq!(text_of(&seen), ["decision:accept"]);
    session.close().await;
    let _ = std::fs::remove_dir_all(base);

    // `..` out of the root, a symlink to outside, the root itself, a relative escape: always a card.
    let escapes: Vec<Box<dyn Fn(&Path) -> PathBuf>> = vec![
        Box::new(|b: &Path| b.join("repo/../outside/x.txt")),
        Box::new(|b: &Path| b.join("repo/out-dir/x.txt")),
        Box::new(|b: &Path| b.join("repo")),
        Box::new(|_: &Path| PathBuf::from("../outside/x.txt")),
        Box::new(|_: &Path| PathBuf::from("/repo/notes.txt")),
    ];
    for escape in escapes {
        let (session, mut events, base) = auto_session(escape).await;
        session.send(auto("x")).await.unwrap();
        let card = agent(&mut events, "permission-request").await;
        assert_eq!(card["requestId"], "7", "{card}");
        session.close().await;
        let _ = std::fs::remove_dir_all(base);
    }
}

#[tokio::test]
async fn switching_to_auto_uses_the_same_check() {
    // An open card outside the workspace stays open when Auto is chosen.
    let (session, mut events, base) = auto_session(|b| b.join("repo/out-dir/x.txt")).await;
    session.send(send("x")).await.unwrap();
    agent(&mut events, "permission-request").await;
    session.set_permission_mode(PermissionMode::Auto).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(session.open_requests(), ["7"]);
    session.close().await;
    let _ = std::fs::remove_dir_all(base);

    // One inside is allowed.
    let (session, mut events, base) = auto_session(|b| b.join("repo/src/new.txt")).await;
    session.send(send("x")).await.unwrap();
    agent(&mut events, "permission-request").await;
    session.set_permission_mode(PermissionMode::Auto).await;
    let (seen, _, _) = until_end(&mut events).await;
    assert_eq!(seen[0]["decision"], "allow");
    assert_eq!(text_of(&seen), ["decision:accept"]);
    session.close().await;
    let _ = std::fs::remove_dir_all(base);
}

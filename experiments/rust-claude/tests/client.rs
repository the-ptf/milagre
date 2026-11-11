//! Transport and control-protocol behavior against the scripted fake CLI (src/bin/fake_claude.rs).

mod common;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::*;
use milagre_claude::handlers::{FnHook, FnMcp, FnOther, FnPermission, FnQuestion};
use milagre_claude::milagre::{self, Decision, QuestionOutcome};
use milagre_claude::{
    CancelReason, ClaudeClient, ClaudeEvent, ClientError, Diagnostic, ExitReason, Handlers, HookMatcher, InitializeOptions, Limits,
    PermissionResult,
};
use serde_json::{json, Value};

fn init_reply() -> Value {
    json!({"commands": [], "agents": [], "output_style": "default", "available_output_styles": ["default"], "models": [], "account": {}})
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handshake_streaming_input_and_raw_messages() {
    let (mut options, dir) = fake(
        "handshake",
        json!([
            {"emit_argv": true},
            {"expect": {"type": "control_request", "subtype": "initialize", "echo": true}},
            {"reply": init_reply()},
            {"expect": {"type": "user", "echo": true}},
            {"emit": {"type": "system", "subtype": "init", "session_id": "sess-1", "model": "fake", "capabilities": ["interrupt_receipt_v1"], "future": {"x": 1}}},
            {"emit": {"type": "stream_event", "event": {"type": "content_block_delta"}, "session_id": "sess-1", "parent_tool_use_id": null}},
            {"emit": {"type": "result", "subtype": "success", "result": "ok", "session_id": "sess-1", "uuid": "u"}},
        ]),
    );
    options.env_overrides = vec![("CLAUDE_CODE_ENABLE_TODO_TOOLS".into(), "1".into())];
    options.model = Some("opus".into());
    options.include_partial_messages = true;
    let (client, mut events) = ClaudeClient::spawn(&options, Handlers::default(), quick_limits()).unwrap();

    let argv = next_message(&mut events).await;
    let args: Vec<&str> = argv["argv"].as_array().unwrap().iter().map(|a| a.as_str().unwrap()).collect();
    assert_eq!(&args[..3], ["--output-format", "stream-json", "--verbose"]);
    assert_eq!(&args[args.len() - 2..], ["--input-format", "stream-json"]);
    assert!(args.windows(2).any(|w| w == ["--permission-prompt-tool", "stdio"]));
    assert!(args.windows(2).any(|w| w == ["--model", "opus"]));
    assert!(args.contains(&"--include-partial-messages"));
    assert_eq!(argv["env"]["CLAUDE_CODE_ENTRYPOINT"], "sdk-ts");
    assert_eq!(argv["env"]["CLAUDE_CODE_ENABLE_TODO_TOOLS"], "1");
    assert!(argv["env"].get("CLAUDECODE").is_none());
    assert_eq!(argv["env"]["PWD"], dir.to_str().unwrap());

    let init = InitializeOptions {
        hooks: vec![("PreToolUse".into(), vec![HookMatcher { matcher: None, callback_ids: vec!["guard".into()], timeout: None }])],
        prompt_suggestions: Some(true),
        ..Default::default()
    };
    let client2 = client.clone();
    let initialize = tokio::spawn(async move { client2.initialize(&init).await });
    let echoed = next_message(&mut events).await;
    assert_eq!(echoed["frame"]["request"]["subtype"], "initialize");
    assert_eq!(echoed["frame"]["request"]["hooks"]["PreToolUse"][0]["hookCallbackIds"], json!(["guard"]));
    assert_eq!(echoed["frame"]["request"]["promptSuggestions"], true);
    assert!(echoed["frame"]["request_id"].as_str().unwrap().starts_with("req_"));
    let reply = initialize.await.unwrap().unwrap();
    assert_eq!(reply.payload["output_style"], "default");
    assert_eq!(reply.raw["response"]["subtype"], "success");
    assert_eq!(client.initialization().unwrap().payload, reply.payload);

    let uuid = client.send_user_text("hello").await.unwrap();
    let user = next_message(&mut events).await;
    assert_eq!(
        user["frame"],
        json!({"type": "user", "uuid": uuid, "message": {"role": "user", "content": [{"type": "text", "text": "hello"}]}, "parent_tool_use_id": null})
    );

    let init_message = next_message(&mut events).await;
    assert_eq!(init_message["future"], json!({"x": 1}), "raw fields are preserved");
    assert_eq!(client.session_id().as_deref(), Some("sess-1"));
    assert_eq!(next_message(&mut events).await["type"], "stream_event");
    assert_eq!(next_message(&mut events).await["result"], "ok");

    let exit = client.close().await;
    assert_eq!(exit.reason, ExitReason::Closed);
    assert_eq!(exit.code, Some(0));
    assert!(matches!(drain(&mut events).await.last(), Some(ClaudeEvent::Exit(_))));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn control_requests_correlate_out_of_order_and_report_errors() {
    let (options, _) = fake(
        "correlate",
        json!([
            {"expect": {"subtype": "set_model", "as": "model"}},
            {"expect": {"subtype": "set_permission_mode", "as": "mode"}},
            {"expect": {"subtype": "interrupt", "as": "interrupt"}},
            {"reply_to": {"name": "interrupt", "payload": {"still_queued": ["u1"]}}},
            {"reply_error_to": {"name": "mode", "error": "Cannot set permission mode"}},
            {"reply_to": {"name": "model", "payload": {}}},
            {"expect": {"subtype": "apply_flag_settings", "echo": true}},
            {"reply": {}},
            {"expect": {"subtype": "set_max_thinking_tokens", "echo": true}},
            {"reply": {}},
        ]),
    );
    let (client, mut events) = ClaudeClient::spawn(&options, Handlers::default(), quick_limits()).unwrap();
    let (a, b, c) = (client.clone(), client.clone(), client.clone());
    let model = tokio::spawn(async move { a.set_model(Some("sonnet")).await });
    tokio::time::sleep(Duration::from_millis(50)).await;
    let mode = tokio::spawn(async move { b.set_permission_mode("bypassPermissions").await });
    tokio::time::sleep(Duration::from_millis(50)).await;
    let interrupt = tokio::spawn(async move { c.interrupt(false).await });
    assert_eq!(interrupt.await.unwrap().unwrap().payload, json!({"still_queued": ["u1"]}));
    match mode.await.unwrap() {
        Err(ClientError::Control { subtype, message, .. }) => {
            assert_eq!(subtype, "set_permission_mode");
            assert_eq!(message, "Cannot set permission mode");
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(model.await.unwrap().unwrap().payload, json!({}));

    client.apply_flag_settings(json!({"effortLevel": "high", "ultracode": false})).await.unwrap();
    let echoed = next_message(&mut events).await;
    assert_eq!(
        echoed["frame"]["request"],
        json!({"settings": {"effortLevel": "high", "ultracode": false}, "subtype": "apply_flag_settings"})
    );
    client.set_max_thinking_tokens(None, Some("summarized")).await.unwrap();
    let echoed = next_message(&mut events).await;
    assert_eq!(echoed["frame"]["request"]["max_thinking_tokens"], Value::Null);
    assert_eq!(echoed["frame"]["request"]["thinking_display"], "summarized");
    client.kill().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn timeout_sends_cancel_and_a_late_reply_is_unmatched() {
    let (options, _) = fake(
        "timeout",
        json!([
            {"expect": {"subtype": "mcp_status", "as": "status"}},
            {"expect": {"type": "control_cancel_request", "echo": true}},
            {"reply_to": {"name": "status", "payload": {"late": true}}},
        ]),
    );
    let (client, mut events) = ClaudeClient::spawn(&options, Handlers::default(), quick_limits()).unwrap();
    let result = client.request_with_timeout(json!({"subtype": "mcp_status"}), Some(Duration::from_millis(200))).await;
    assert!(matches!(result, Err(ClientError::Timeout { ref subtype, .. }) if subtype == "mcp_status"), "{result:?}");
    let cancel = next_message(&mut events).await;
    let cancelled_id = cancel["frame"]["request_id"].as_str().unwrap().to_owned();
    loop {
        match tokio::time::timeout(Duration::from_secs(5), events.recv()).await.unwrap() {
            Some(ClaudeEvent::Diagnostic(Diagnostic::UnmatchedResponse { request_id, raw })) => {
                assert_eq!(request_id, cancelled_id);
                assert_eq!(raw["response"]["response"]["late"], true);
                break;
            }
            Some(_) => continue,
            None => panic!("events ended"),
        }
    }
    client.kill().await;
}

fn permission_request(id: &str, tool: &str, input: Value, extra: Value) -> Value {
    let mut request = json!({"subtype": "can_use_tool", "tool_name": tool, "input": input, "tool_use_id": format!("toolu_{id}")});
    for (key, value) in extra.as_object().unwrap() {
        request[key] = value.clone();
    }
    json!({"request": {"id": id, "request": request}})
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn permissions_questions_hooks_and_mcp_round_trip() {
    let suggestion = json!({"type": "addRules", "rules": [{"toolName": "Bash", "ruleContent": "ls"}], "behavior": "allow", "destination": "localSettings"});
    let (options, _) = fake(
        "roundtrip",
        json!([
            permission_request("p1", "Bash", json!({"command": "ls"}), json!({"permission_suggestions": [suggestion], "future_flag": true})),
            {"expect": {"type": "control_response", "echo": true}},
            permission_request("q1", "AskUserQuestion", json!({"questions": [{"question": "Which?", "header": "H", "options": [{"label": "A"}, {"label": "B"}], "multiSelect": true}]}), json!({})),
            {"expect": {"type": "control_response", "echo": true}},
            {"request": {"id": "h1", "request": {"subtype": "hook_callback", "callback_id": "guard", "input": {"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "git push"}}, "tool_use_id": "toolu_h"}}},
            {"expect": {"type": "control_response", "echo": true}},
            {"request": {"id": "m1", "request": {"subtype": "mcp_message", "server_name": "milagre", "message": {"jsonrpc": "2.0", "id": 4, "method": "tools/list"}}}},
            {"expect": {"type": "control_response", "echo": true}},
            {"request": {"id": "m2", "request": {"subtype": "mcp_message", "server_name": "milagre", "message": {"jsonrpc": "2.0", "method": "notifications/initialized"}}}},
            {"expect": {"type": "control_response", "echo": true}},
            {"request": {"id": "m3", "request": {"subtype": "mcp_message", "server_name": "other", "message": {"jsonrpc": "2.0", "id": 9, "method": "tools/list"}}}},
            {"expect": {"type": "control_response", "echo": true}},
            {"request": {"id": "e1", "request": {"subtype": "elicitation", "mcp_server_name": "s", "message": "Sign in?"}}},
            {"expect": {"type": "control_response", "echo": true}},
            {"request": {"id": "d1", "request": {"subtype": "request_user_dialog", "dialog_kind": "unknown_kind", "payload": {}}}},
            {"expect_none_ms": 300},
        ]),
    );
    let seen: Arc<Mutex<Vec<Value>>> = Arc::default();
    let seen_permission = seen.clone();
    let handlers = Handlers {
        permissions: Some(Arc::new(FnPermission(move |request: milagre_claude::PermissionRequest, _cancel| {
            seen_permission.lock().unwrap().push(milagre::permission_card(&request));
            let result = milagre::permission_result(Decision::AllowForChat, &request.input, &request.suggestions);
            Box::pin(async move { Ok(result) }) as milagre_claude::BoxFuture<_>
        }))),
        questions: Some(Arc::new(FnQuestion(|request: milagre_claude::PermissionRequest, _cancel| {
            let card = milagre::question_card(&request).unwrap();
            let (outcome, answers) = milagre::settle_answers(&card, json!({"0": ["A", " B "]}).as_object().unwrap());
            assert_eq!(outcome, QuestionOutcome::Answered);
            let result = milagre::question_result(outcome, &request.input, &answers);
            Box::pin(async move { Ok(result) }) as milagre_claude::BoxFuture<_>
        }))),
        hooks: Some(Arc::new(FnHook(|callback: milagre_claude::HookCallback, _cancel| {
            assert_eq!(callback.callback_id, "guard");
            assert_eq!(callback.tool_use_id.as_deref(), Some("toolu_h"));
            let reason = format!("blocked: {}", callback.input["tool_input"]["command"].as_str().unwrap());
            Box::pin(async move {
                Ok(
                    json!({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason}}),
                )
            }) as milagre_claude::BoxFuture<_>
        }))),
        mcp: Some(Arc::new(FnMcp(|message: milagre_claude::McpMessage, _cancel| {
            Box::pin(async move {
                if message.server_name != "milagre" {
                    return Ok(Some(message.unknown_server()));
                }
                Ok(message.message.get("id").map(|id| json!({"jsonrpc": "2.0", "id": id, "result": {"tools": []}})))
            }) as milagre_claude::BoxFuture<_>
        }))),
        other: Some(Arc::new(FnOther(|subtype: String, _request: Value, _cancel| {
            Box::pin(async move {
                match subtype.as_str() {
                    "elicitation" => Ok(Some(json!({"action": "decline"}))),
                    _ => Ok(None),
                }
            }) as milagre_claude::BoxFuture<_>
        }))),
    };
    let (client, mut events) = ClaudeClient::spawn(&options, handlers, quick_limits()).unwrap();

    let permission = next_message(&mut events).await["frame"].clone();
    let mut expected_rule = suggestion.clone();
    expected_rule["destination"] = "session".into();
    assert_eq!(
        permission,
        json!({"type": "control_response", "response": {"subtype": "success", "request_id": "p1",
               "response": {"behavior": "allow", "updatedInput": {"command": "ls"}, "updatedPermissions": [expected_rule]}}})
    );
    let card = seen.lock().unwrap()[0].clone();
    assert_eq!(
        card,
        json!({"requestId": "p1", "tool": "Bash", "allowForChat": true, "stepId": "toolu_p1", "kind": "command", "title": "Run this command?", "command": "ls"})
    );

    let question = next_message(&mut events).await["frame"].clone();
    assert_eq!(question["response"]["response"]["behavior"], "allow");
    assert_eq!(question["response"]["response"]["updatedInput"]["answers"], json!({"Which?": "A, B"}));
    assert_eq!(question["response"]["response"]["updatedInput"]["questions"][0]["header"], "H");

    let hook = next_message(&mut events).await["frame"].clone();
    assert_eq!(hook["response"]["response"]["hookSpecificOutput"]["permissionDecisionReason"], "blocked: git push");

    let mcp = next_message(&mut events).await["frame"].clone();
    assert_eq!(mcp["response"]["response"], json!({"mcp_response": {"jsonrpc": "2.0", "id": 4, "result": {"tools": []}}}));
    let ack = next_message(&mut events).await["frame"].clone();
    assert_eq!(ack["response"]["response"], json!({"mcp_response": {"jsonrpc": "2.0", "result": {}}}));
    let unknown = next_message(&mut events).await["frame"].clone();
    assert_eq!(unknown["response"]["response"]["mcp_response"]["error"]["code"], -32601);
    let elicitation = next_message(&mut events).await["frame"].clone();
    assert_eq!(elicitation["response"]["response"], json!({"action": "decline"}));

    // The undeclared dialog got no reply (the fake checked); the transport says so.
    let events = drain_until(&mut events, |event| matches!(event, ClaudeEvent::Diagnostic(Diagnostic::Unanswered { .. }))).await;
    assert!(events);
    client.kill().await;
}

async fn drain_until(events: &mut milagre_claude::EventStream, test: impl Fn(&ClaudeEvent) -> bool) -> bool {
    while let Ok(Some(event)) = tokio::time::timeout(Duration::from_secs(5), events.recv()).await {
        if test(&event) {
            return true;
        }
    }
    false
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn missing_handlers_answer_like_the_python_sdk() {
    let (options, _) = fake(
        "missing",
        json!([
            permission_request("p1", "Bash", json!({"command": "ls"}), json!({})),
            {"expect": {"type": "control_response", "echo": true}},
            {"request": {"id": "h1", "request": {"subtype": "hook_callback", "callback_id": "x", "input": {}}}},
            {"expect": {"type": "control_response", "echo": true}},
            {"request": {"id": "m1", "request": {"subtype": "mcp_message", "server_name": "milagre", "message": {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}}}},
            {"expect": {"type": "control_response", "echo": true}},
            {"request": {"id": "z1", "request": {"subtype": "brand_new_thing"}}},
            {"expect": {"type": "control_response", "echo": true}},
            {"emit": {"type": "control_request", "request": {"subtype": "can_use_tool"}}},
            {"emit": {"type": "keep_alive"}},
            {"emit": {"type": "after"}},
        ]),
    );
    let (client, mut events) = ClaudeClient::spawn(&options, Handlers::default(), quick_limits()).unwrap();
    let frame = next_message(&mut events).await["frame"].clone();
    assert_eq!(frame["response"], json!({"subtype": "error", "request_id": "p1", "error": "canUseTool callback is not provided"}));
    let frame = next_message(&mut events).await["frame"].clone();
    assert_eq!(frame["response"]["error"], "No hook callback found for ID: x");
    let frame = next_message(&mut events).await["frame"].clone();
    assert_eq!(frame["response"]["response"]["mcp_response"]["error"]["message"], "Server 'milagre' not found");
    let frame = next_message(&mut events).await["frame"].clone();
    assert_eq!(frame["response"]["error"], "Unsupported control request subtype: brand_new_thing");
    // The malformed request becomes a diagnostic, keep_alive is dropped, the stream goes on.
    let mut malformed = false;
    loop {
        match tokio::time::timeout(Duration::from_secs(5), events.recv()).await.unwrap().unwrap() {
            ClaudeEvent::Diagnostic(Diagnostic::Malformed { .. }) => malformed = true,
            ClaudeEvent::Message(value) => {
                assert_eq!(value["type"], "after");
                break;
            }
            other => panic!("{other:?}"),
        }
    }
    assert!(malformed);
    client.kill().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cli_cancel_withdraws_a_pending_permission_without_a_reply() {
    let (options, _) = fake(
        "cancel",
        json!([
            permission_request("p1", "Write", json!({"file_path": "/x/a.txt", "content": "hi"}), json!({})),
            {"sleep_ms": 100},
            {"cancel": "p1"},
            {"expect_none_ms": 400},
            {"emit": {"type": "done"}},
        ]),
    );
    let reason: Arc<Mutex<Option<CancelReason>>> = Arc::default();
    let recorded = reason.clone();
    let handlers = Handlers {
        permissions: Some(Arc::new(FnPermission(move |_request, mut cancel: milagre_claude::CancelSignal| {
            let recorded = recorded.clone();
            Box::pin(async move {
                let why = cancel.cancelled().await;
                *recorded.lock().unwrap() = Some(why);
                // The answer after a withdrawal is discarded.
                Ok(PermissionResult::Allow { updated_input: None, updated_permissions: None })
            }) as milagre_claude::BoxFuture<_>
        }))),
        ..Handlers::default()
    };
    let (client, mut events) = ClaudeClient::spawn(&options, handlers, quick_limits()).unwrap();
    assert_eq!(next_message(&mut events).await["type"], "done");
    assert_eq!(*reason.lock().unwrap(), Some(CancelReason::Withdrawn));
    client.kill().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exit_fails_waiters_cancels_handlers_and_never_replays() {
    let (options, _) = fake(
        "exit",
        json!([
            permission_request("p1", "Bash", json!({"command": "sleep 1"}), json!({})),
            {"expect": {"subtype": "interrupt"}},
            {"emit": {"type": "last_words"}},
            {"exit": 7},
        ]),
    );
    let reason: Arc<Mutex<Option<CancelReason>>> = Arc::default();
    let recorded = reason.clone();
    let handlers = Handlers {
        permissions: Some(Arc::new(FnPermission(move |_request, mut cancel: milagre_claude::CancelSignal| {
            let recorded = recorded.clone();
            Box::pin(async move {
                *recorded.lock().unwrap() = Some(cancel.cancelled().await);
                Err("gone".into())
            }) as milagre_claude::BoxFuture<_>
        }))),
        ..Handlers::default()
    };
    let (client, mut events) = ClaudeClient::spawn(&options, handlers, quick_limits()).unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    match client.interrupt(false).await {
        Err(ClientError::Exited(info)) => {
            assert_eq!(info.code, Some(7));
            assert_eq!(info.reason, ExitReason::Exited);
            assert!(info.stderr_tail.contains("fake-claude: started"));
        }
        other => panic!("{other:?}"),
    }
    let all = drain(&mut events).await;
    assert!(all.iter().any(|e| matches!(e, ClaudeEvent::Message(v) if v["type"] == "last_words")), "messages before exit are delivered");
    assert!(matches!(all.last(), Some(ClaudeEvent::Exit(info)) if info.code == Some(7)));
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(*reason.lock().unwrap(), Some(CancelReason::Exited));
    assert!(matches!(client.send_user_text("again").await, Err(ClientError::Exited(_))));
    assert!(matches!(client.set_model(None).await, Err(ClientError::Exited(_))));
    assert!(client.pid().is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn oversized_and_corrupt_stdout_are_protocol_violations() {
    let (options, _) = fake("oversize", json!([{"emit": {"type": "big", "text": "x".repeat(5000)}}, {"sleep_ms": 5000}]));
    let limits = Limits { max_frame_bytes: 1024, ..quick_limits() };
    let (client, mut events) = ClaudeClient::spawn(&options, Handlers::default(), limits).unwrap();
    let info = client.wait().await;
    assert!(matches!(info.reason, ExitReason::ProtocolViolation(ref d) if d.contains("1024")), "{info:?}");
    assert_eq!(info.signal, Some(9));
    assert!(matches!(drain(&mut events).await.last(), Some(ClaudeEvent::Exit(_))));

    let (options, _) = fake(
        "corrupt",
        json!([{"emit_raw": "[SandboxDebug] not protocol\n"}, {"emit": {"type": "ok"}}, {"emit_raw": "{\"type\": \"broken\"\n"}, {"sleep_ms": 5000}]),
    );
    let (client, mut events) = ClaudeClient::spawn(&options, Handlers::default(), quick_limits()).unwrap();
    let all = drain(&mut events).await;
    assert!(matches!(&all[0], ClaudeEvent::Diagnostic(Diagnostic::NonJsonLine(t)) if t == "[SandboxDebug] not protocol"));
    assert!(matches!(&all[1], ClaudeEvent::Message(v) if v["type"] == "ok"));
    assert!(matches!(all.last(), Some(ClaudeEvent::Exit(info)) if matches!(info.reason, ExitReason::ProtocolViolation(_))));
    assert!(client.pid().is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn eof_tail_is_parsed_or_reported() {
    let (options, _) = fake("tail", json!([{"emit_raw": "{\"type\":\"complete_tail\"}"}, {"exit": 0}]));
    let (_client, mut events) = ClaudeClient::spawn(&options, Handlers::default(), quick_limits()).unwrap();
    let all = drain(&mut events).await;
    assert!(matches!(&all[0], ClaudeEvent::Message(v) if v["type"] == "complete_tail"));
    assert!(matches!(all.last(), Some(ClaudeEvent::Exit(info)) if info.reason == ExitReason::Exited && info.code == Some(0)));

    let (options, _) = fake("cut", json!([{"emit_raw": "{\"type\":\"cut"}, {"exit": 0}]));
    let (_client, mut events) = ClaudeClient::spawn(&options, Handlers::default(), quick_limits()).unwrap();
    let all = drain(&mut events).await;
    assert!(matches!(&all[0], ClaudeEvent::Diagnostic(Diagnostic::TruncatedTail(_))));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stdout_closed_while_running_is_killed_after_drain_grace() {
    let (options, _) = fake("stdout-closed", json!([{"close_stdout": true}, {"ignore_sigterm": true}, {"sleep_ms": 10000}]));
    let (client, _events) = ClaudeClient::spawn(&options, Handlers::default(), quick_limits()).unwrap();
    let started = std::time::Instant::now();
    let info = client.wait().await;
    assert_eq!(info.reason, ExitReason::StdoutClosed);
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn end_input_lets_the_cli_finish() {
    let (options, _) = fake("eof", json!([{"wait_eof": true}, {"exit": 0}]));
    let (client, mut events) = ClaudeClient::spawn(&options, Handlers::default(), quick_limits()).unwrap();
    client.end_input().await.unwrap();
    assert_eq!(next_message(&mut events).await["type"], "fake_eof");
    assert!(matches!(client.send_user_text("late").await, Err(ClientError::InputEnded) | Err(ClientError::Exited(_))));
    let info = client.wait().await;
    assert_eq!(info.reason, ExitReason::Exited);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn close_escalates_to_sigkill_and_kills_the_group() {
    let dir = scratch("group");
    let pidfile = dir.join("grandchild.pid");
    let (options, _) = fake(
        "close",
        json!([{"spawn_grandchild": pidfile.to_str().unwrap()}, {"ignore_sigterm": true}, {"emit": {"type": "ready"}}, {"sleep_ms": 30000}]),
    );
    let (client, mut events) = ClaudeClient::spawn(&options, Handlers::default(), quick_limits()).unwrap();
    let grandchild = next_message(&mut events).await["pid"].as_i64().unwrap() as i32;
    assert_eq!(next_message(&mut events).await["type"], "ready");
    assert!(pid_alive(grandchild));
    let info = client.close().await;
    assert_eq!(info.reason, ExitReason::Closed);
    assert_eq!(info.signal, Some(9), "SIGTERM was ignored, so SIGKILL ended it");
    assert!(wait_dead(grandchild).await, "the grandchild in the group was stopped");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn natural_exit_and_drop_stop_leftover_group_members() {
    let dir = scratch("leftover");
    let (options, _) = fake("leftover", json!([{"spawn_grandchild": dir.join("a").to_str().unwrap()}, {"exit": 0}]));
    let (client, mut events) = ClaudeClient::spawn(&options, Handlers::default(), quick_limits()).unwrap();
    let grandchild = next_message(&mut events).await["pid"].as_i64().unwrap() as i32;
    client.wait().await;
    assert!(wait_dead(grandchild).await, "left in the group after the leader exited");

    let (options, _) = fake("drop", json!([{"spawn_grandchild": dir.join("b").to_str().unwrap()}, {"sleep_ms": 30000}]));
    let (client, mut events) = ClaudeClient::spawn(&options, Handlers::default(), quick_limits()).unwrap();
    let grandchild = next_message(&mut events).await["pid"].as_i64().unwrap() as i32;
    let leader = client.pid().unwrap() as i32;
    drop(client);
    assert!(wait_dead(grandchild).await, "dropping the last handle kills the group");
    assert!(matches!(drain(&mut events).await.last(), Some(ClaudeEvent::Exit(_))));
    assert!(wait_dead(leader).await);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stdin_backpressure_is_an_explicit_error() {
    let (mut options, _) = fake("backpressure", json!([{"sleep_ms": 30000}]));
    options.env.as_mut().unwrap().push(("FAKE_CLAUDE_NO_STDIN".into(), "1".into()));
    let limits = Limits { write_queue: 1, write_timeout: Duration::from_millis(200), ..quick_limits() };
    let (client, _events) = ClaudeClient::spawn(&options, Handlers::default(), limits).unwrap();
    let chunk = "y".repeat(256 * 1024);
    let mut result = Ok(String::new());
    for _ in 0..20 {
        result = client.send_user_text(&chunk).await;
        if result.is_err() {
            break;
        }
    }
    assert!(matches!(result, Err(ClientError::Backpressure(_))), "{result:?}");
    let before = client.request_with_timeout(json!({"subtype": "mcp_status"}), Some(Duration::from_millis(100))).await;
    assert!(matches!(before, Err(ClientError::Backpressure(_))), "{before:?}");
    client.kill().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn event_backpressure_loses_nothing_and_keeps_order() {
    let (options, _) = fake("events", json!([{"emit_many": {"count": 300, "frame": {"type": "assistant"}}}, {"exit": 0}]));
    let limits = Limits { event_capacity: 4, ..quick_limits() };
    let (_client, mut events) = ClaudeClient::spawn(&options, Handlers::default(), limits).unwrap();
    let mut index = 0;
    loop {
        // Slower than drain_grace in total: the process exits long before the owner catches up.
        tokio::time::sleep(Duration::from_millis(3)).await;
        match events.recv().await.unwrap() {
            ClaudeEvent::Message(value) => {
                assert_eq!(value["index"], index);
                index += 1;
            }
            ClaudeEvent::Exit(info) => {
                assert_eq!(info.code, Some(0));
                break;
            }
            ClaudeEvent::Diagnostic(d) => panic!("{d:?}"),
        }
    }
    assert_eq!(index, 300);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn limits_and_spawn_errors() {
    let (options, _) = fake("limits", json!([{"sleep_ms": 30000}]));
    let limits = Limits { max_outgoing_frame_bytes: 150, max_pending_requests: 1, ..quick_limits() };
    let (client, mut events) = ClaudeClient::spawn(&options, Handlers::default(), limits).unwrap();
    assert!(matches!(client.send_user_text(&"z".repeat(200)).await, Err(ClientError::FrameTooLarge { limit: 150, .. })));
    let first = client.clone();
    let hold = tokio::spawn(async move { first.request_with_timeout(json!({"subtype": "mcp_status"}), None).await });
    tokio::time::sleep(Duration::from_millis(100)).await;
    // The fake never answers; the held request is the one in flight.
    assert!(matches!(client.mcp_status().await, Err(ClientError::TooManyPending(1))));
    client.kill().await;
    assert!(matches!(hold.await.unwrap(), Err(ClientError::Exited(_))));
    drain(&mut events).await;

    let missing = milagre_claude::LaunchOptions::new("/nonexistent/claude");
    match ClaudeClient::spawn(&missing, Handlers::default(), Limits::default()) {
        Err(ClientError::Spawn { not_found, .. }) => assert!(not_found),
        other => panic!("{other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn connect_kills_the_process_when_initialize_fails() {
    let (options, _) =
        fake("init-fail", json!([{"expect": {"subtype": "initialize"}}, {"reply_error": "not logged in"}, {"sleep_ms": 30000}]));
    match ClaudeClient::connect(&options, &InitializeOptions::default(), Handlers::default(), quick_limits()).await {
        Err(ClientError::Control { subtype, message, .. }) => {
            assert_eq!(subtype, "initialize");
            assert_eq!(message, "not logged in");
        }
        other => panic!("{other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn duplicate_ids_are_answered_once_and_panics_become_errors() {
    let (options, _) = fake(
        "duplicate",
        json!([
            permission_request("dup", "Bash", json!({"command": "ls"}), json!({})),
            permission_request("dup", "Bash", json!({"command": "ls"}), json!({})),
            {"expect": {"type": "control_response", "echo": true}},
            {"expect_none_ms": 400},
            {"request": {"id": "h1", "request": {"subtype": "hook_callback", "callback_id": "boom", "input": {}}}},
            {"expect": {"type": "control_response", "echo": true}},
        ]),
    );
    let handlers = Handlers {
        permissions: Some(Arc::new(FnPermission(|_request, _cancel| {
            Box::pin(async move {
                tokio::time::sleep(Duration::from_millis(150)).await;
                Ok(PermissionResult::Deny { message: "no".into(), interrupt: None })
            }) as milagre_claude::BoxFuture<_>
        }))),
        hooks: Some(Arc::new(FnHook(|_callback, _cancel| {
            Box::pin(async move {
                if true {
                    panic!("hook bug");
                }
                Ok(Value::Null)
            }) as milagre_claude::BoxFuture<Result<Value, String>>
        }))),
        ..Handlers::default()
    };
    let (client, mut events) = ClaudeClient::spawn(&options, handlers, quick_limits()).unwrap();
    let mut duplicate_seen = false;
    let first = loop {
        match tokio::time::timeout(Duration::from_secs(5), events.recv()).await.unwrap().unwrap() {
            ClaudeEvent::Diagnostic(Diagnostic::DuplicateRequest { request_id }) => {
                assert_eq!(request_id, "dup");
                duplicate_seen = true;
            }
            ClaudeEvent::Message(value) => break value,
            other => panic!("{other:?}"),
        }
    };
    assert!(duplicate_seen);
    assert_eq!(first["frame"]["response"]["response"], json!({"behavior": "deny", "message": "no"}));
    let hook = next_message(&mut events).await;
    assert_eq!(hook["frame"]["response"]["subtype"], "error");
    assert!(hook["frame"]["response"]["error"].as_str().unwrap().contains("hook_callback failed"));
    client.kill().await;
}

fn deny_now() -> Handlers {
    Handlers {
        permissions: Some(Arc::new(FnPermission(|_request, _cancel| {
            Box::pin(async move { Ok(PermissionResult::Deny { message: "no".into(), interrupt: None }) }) as milagre_claude::BoxFuture<_>
        }))),
        ..Handlers::default()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replies_overtake_a_saturated_user_queue() {
    let (mut options, _) = fake(
        "reply-lane",
        json!([
            {"sleep_ms": 300},
            permission_request("p1", "Bash", json!({"command": "ls"}), json!({})),
            {"expect_skip": {"type": "control_response"}},
        ]),
    );
    options.env.as_mut().unwrap().push(("FAKE_CLAUDE_STDIN_DELAY_MS".into(), "800".into()));
    let limits = Limits { write_queue: 4, write_timeout: Duration::from_millis(100), ..quick_limits() };
    let (client, mut events) = ClaudeClient::spawn(&options, deny_now(), limits).unwrap();
    // The first big frame fills the pipe while the fake is not reading yet; the rest wait in the user queue.
    let big = "u".repeat(256 * 1024);
    let mut queued = 0;
    for _ in 0..8 {
        if client.send_user_text(&big).await.is_ok() {
            queued += 1;
        }
    }
    assert!(queued >= 4, "queued {queued}");
    let received = next_message(&mut events).await;
    assert_eq!(received["frame"]["response"]["request_id"], "p1");
    let skipped = received["skipped"].as_u64().unwrap();
    assert!(skipped <= 1, "the reply waited behind {skipped} of {queued} user frames");
    client.kill().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_reply_that_cannot_be_written_stops_the_process() {
    let (options, _) = fake(
        "reply-lost",
        json!([{"wait_eof": true}, permission_request("p1", "Bash", json!({"command": "ls"}), json!({})), {"sleep_ms": 10000}]),
    );
    let (client, mut events) = ClaudeClient::spawn(&options, deny_now(), quick_limits()).unwrap();
    client.end_input().await.unwrap();
    let info = tokio::time::timeout(Duration::from_secs(5), client.wait()).await.expect("the process was stopped");
    assert_eq!(info.reason, ExitReason::ReplyLost);
    let all = drain(&mut events).await;
    assert!(matches!(all.last(), Some(ClaudeEvent::Exit(info)) if info.reason == ExitReason::ReplyLost));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stalled_stdin_stops_the_process_instead_of_half_writing() {
    let (mut options, _) = fake("stall", json!([{"sleep_ms": 30000}]));
    options.env.as_mut().unwrap().push(("FAKE_CLAUDE_NO_STDIN".into(), "1".into()));
    let limits = Limits { stall_timeout: Duration::from_millis(300), ..quick_limits() };
    let (client, _events) = ClaudeClient::spawn(&options, Handlers::default(), limits).unwrap();
    client.send_user_text(&"s".repeat(1024 * 1024)).await.unwrap();
    let info = tokio::time::timeout(Duration::from_secs(5), client.wait()).await.expect("stalled writer stops the process");
    assert_eq!(info.reason, ExitReason::InputStalled);
    assert!(matches!(client.send_user_text("more").await, Err(ClientError::Exited(_))));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn close_delivers_eof_even_with_a_full_user_queue() {
    let (mut options, _) = fake("close-full", json!([{"wait_eof": true}, {"exit": 0}]));
    options.env.as_mut().unwrap().push(("FAKE_CLAUDE_STDIN_DELAY_MS".into(), "300".into()));
    let limits = Limits { write_queue: 1, write_timeout: Duration::from_millis(50), close_grace: Duration::from_secs(5), ..quick_limits() };
    let (client, mut events) = ClaudeClient::spawn(&options, Handlers::default(), limits).unwrap();
    let big = "c".repeat(256 * 1024);
    let mut refused = false;
    for _ in 0..6 {
        refused |= matches!(client.send_user_text(&big).await, Err(ClientError::Backpressure(_)));
    }
    assert!(refused, "the user queue was full");
    let info = client.close().await;
    assert_eq!((info.reason, info.code, info.signal), (ExitReason::Closed, Some(0), None), "exited on EOF, not on a signal");
    let all = drain(&mut events).await;
    assert!(all.iter().any(|event| matches!(event, ClaudeEvent::Message(v) if v["type"] == "fake_eof")));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn waiters_fail_after_exit_even_when_events_are_not_drained() {
    let (options, _) = fake(
        "undrained",
        json!([{"expect": {"subtype": "mcp_status"}}, {"emit_many": {"count": 20, "frame": {"type": "assistant"}}}, {"exit": 3}]),
    );
    let limits = Limits { event_capacity: 1, ..quick_limits() };
    let (client, mut events) = ClaudeClient::spawn(&options, Handlers::default(), limits).unwrap();
    let result = tokio::time::timeout(Duration::from_secs(5), client.request_with_timeout(json!({"subtype": "mcp_status"}), None))
        .await
        .expect("the waiter failed without anyone draining events");
    assert!(matches!(result, Err(ClientError::Exited(ref info)) if info.code == Some(3)), "{result:?}");
    let all = drain(&mut events).await;
    assert_eq!(all.iter().filter(|e| matches!(e, ClaudeEvent::Message(_))).count(), 20, "nothing lost");
    assert!(matches!(all.last(), Some(ClaudeEvent::Exit(_))));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_handler_that_ignores_cancel_does_not_hold_up_the_exit() {
    let (options, _) =
        fake("stubborn", json!([permission_request("p1", "Bash", json!({"command": "ls"}), json!({})), {"sleep_ms": 200}, {"exit": 0}]));
    let handlers = Handlers {
        permissions: Some(Arc::new(FnPermission(|_request, _cancel| {
            Box::pin(async move {
                std::future::pending::<()>().await;
                Err("never".into())
            }) as milagre_claude::BoxFuture<_>
        }))),
        ..Handlers::default()
    };
    let (client, mut events) = ClaudeClient::spawn(&options, handlers, quick_limits()).unwrap();
    let info = tokio::time::timeout(Duration::from_secs(5), client.wait()).await.unwrap();
    assert_eq!(info.reason, ExitReason::Exited);
    assert!(matches!(drain(&mut events).await.last(), Some(ClaudeEvent::Exit(_))));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn connect_drains_output_that_arrives_before_the_initialize_reply() {
    let (options, _) = fake(
        "connect-drain",
        json!([{"expect": {"subtype": "initialize"}}, {"emit_many": {"count": 50, "frame": {"type": "early"}}}, {"reply": init_reply()}]),
    );
    let limits = Limits { event_capacity: 2, ..quick_limits() };
    let (client, mut events, reply) = tokio::time::timeout(
        Duration::from_secs(5),
        ClaudeClient::connect(&options, &InitializeOptions::default(), Handlers::default(), limits),
    )
    .await
    .expect("initialize did not stall behind a full event channel")
    .unwrap();
    assert_eq!(reply.payload["output_style"], "default");
    for index in 0..50 {
        assert_eq!(next_message(&mut events).await["index"], index);
    }
    client.kill().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn private_argument_files_are_removed_at_exit() {
    let (mut options, _) = fake("argfiles", json!([{"emit_argv": true}, {"exit": 0}]));
    options.system_prompt = milagre_claude::SystemPrompt::Preset { append: Some("secret instructions".into()) };
    options.settings = Some(json!({"fastMode": false}));
    let (client, mut events) = ClaudeClient::spawn(&options, Handlers::default(), quick_limits()).unwrap();
    let argv = next_message(&mut events).await;
    let args: Vec<String> = argv["argv"].as_array().unwrap().iter().map(|a| a.as_str().unwrap().to_owned()).collect();
    assert!(!args.iter().any(|a| a.contains("secret instructions")));
    let at = args.iter().position(|a| a == "--append-system-prompt-file").unwrap();
    let file = std::path::PathBuf::from(&args[at + 1]);
    client.wait().await;
    assert!(!file.exists() && !file.parent().unwrap().exists(), "argument files removed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn close_cancels_handlers_and_late_replies_preserve_flush_grace() {
    let (options, _) = fake(
        "close-handlers",
        json!([
            permission_request("p1", "Bash", json!({"command":"ls"}), json!({})),
            {"wait_eof":true},
            // This request also arrives during close: no new handler should be dispatched.
            permission_request("p2", "Bash", json!({"command":"ls"}), json!({})),
            {"sleep_ms":200}, {"emit":{"type":"flushed"}}, {"exit":0}
        ]),
    );
    let (started_tx, mut started_rx) = tokio::sync::mpsc::unbounded_channel();
    let (cancel_tx, mut cancel_rx) = tokio::sync::mpsc::unbounded_channel();
    let handlers = Handlers {
        permissions: Some(Arc::new(FnPermission(
            move |request: milagre_claude::PermissionRequest, mut cancel: milagre_claude::CancelSignal| {
                let started = started_tx.clone();
                let cancelled = cancel_tx.clone();
                Box::pin(async move {
                    started.send(request.request_id).unwrap();
                    let reason = cancel.cancelled().await;
                    cancelled.send(reason).unwrap();
                    // A callback that completes after the writer has delivered EOF is harmless.
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    Ok(PermissionResult::Allow { updated_input: None, updated_permissions: None })
                }) as milagre_claude::BoxFuture<_>
            },
        ))),
        ..Handlers::default()
    };
    let limits = Limits { close_grace: Duration::from_secs(2), ..quick_limits() };
    let (client, mut events) = ClaudeClient::spawn(&options, handlers, limits).unwrap();
    assert_eq!(tokio::time::timeout(Duration::from_secs(3), started_rx.recv()).await.unwrap().unwrap(), "p1");
    let (info, reason) = tokio::join!(client.close(), async {
        tokio::time::timeout(Duration::from_millis(150), cancel_rx.recv()).await.expect("close cancels before process exit").unwrap()
    });
    assert_eq!(reason, CancelReason::Closed);
    assert_eq!((info.reason, info.code, info.signal), (ExitReason::Closed, Some(0), None));
    assert!(started_rx.try_recv().is_err(), "close must reject new callbacks");
    let trace = drain(&mut events).await;
    assert!(trace.iter().any(|event| matches!(event,ClaudeEvent::Message(v) if v["type"]=="flushed")));
    assert!(!trace.iter().any(|event| matches!(event, ClaudeEvent::Diagnostic(Diagnostic::ReplyNotWritten { .. }))));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn broken_stdin_stops_live_process_and_settles_waiters() {
    for reply in [false, true] {
        let mut script = vec![json!({"close_stdin":true}), json!({"emit":{"type":"stdin_closed"}})];
        if reply {
            script.push(permission_request("p1", "Bash", json!({"command":"ls"}), json!({})));
        }
        script.push(json!({"sleep_ms":10000}));
        let (mut options, _) = fake("broken-stdin", Value::Array(script));
        options.env.as_mut().unwrap().push(("FAKE_CLAUDE_NO_STDIN".into(), "1".into()));
        let (client, mut events) = ClaudeClient::spawn(&options, deny_now(), quick_limits()).unwrap();
        let pid = client.pid().unwrap();
        assert_eq!(next_message(&mut events).await["type"], "stdin_closed");
        if !reply {
            let error = tokio::time::timeout(Duration::from_secs(3), client.request_with_timeout(json!({"subtype":"mcp_status"}), None))
                .await
                .expect("broken stdin must fail an unbounded control waiter")
                .unwrap_err();
            assert!(matches!(error,ClientError::Exited(ref info) if matches!(info.reason,ExitReason::WriteError(_))), "{error:?}");
        }
        let info = tokio::time::timeout(Duration::from_secs(3), client.wait()).await.expect("broken writer must stop live process");
        assert!(matches!(info.reason, ExitReason::WriteError(_)), "{info:?}");
        assert!(matches!(client.send_user_text("later").await, Err(ClientError::Exited(_))));
        assert!(wait_dead(pid as i32).await);
        assert!(matches!(drain(&mut events).await.last(), Some(ClaudeEvent::Exit(_))));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn connect_enforces_event_and_byte_budgets_before_initialize() {
    for byte_limit in [false, true] {
        let (options, _) = fake(
            "connect-budget",
            json!([
                {"expect":{"subtype":"initialize"}},
                {"emit_many":{"count":100,"frame":{"type":"early","text":"a".repeat(256)}}},
                {"sleep_ms":10000}
            ]),
        );
        let limits = Limits {
            max_initialize_events: if byte_limit { 1000 } else { 3 },
            max_initialize_bytes: if byte_limit { 100 } else { 100000 },
            event_capacity: 2,
            ..quick_limits()
        };
        let result = tokio::time::timeout(
            Duration::from_secs(3),
            ClaudeClient::connect(&options, &InitializeOptions::default(), Handlers::default(), limits),
        )
        .await
        .expect("budget must fail before initialize timeout");
        assert!(matches!(result, Err(ClientError::InitializeBufferFull { .. })), "{result:?}");
    }
}

//! CodexRpc against the deterministic Rust fake (src/bin/fake_codex_app_server.rs).

mod common;

use common::*;
use milagre_providers::codex::{CodexRpc, Diagnostic, ExitReason, Limits, RequestId, RpcError, ServerEvent, SpawnError, SpawnOptions};
use serde_json::{json, Value};
use std::time::Duration;

fn spawn(scenario: &str) -> (CodexRpc, milagre_providers::queue::EventReceiver<ServerEvent>) {
    CodexRpc::spawn(fake(scenario)).expect("fake starts")
}

async fn received(rpc: &CodexRpc) -> Vec<Value> {
    rpc.request("fake/received", json!({})).await.unwrap()["received"].as_array().unwrap().clone()
}

#[tokio::test]
async fn handshake_then_notifications_in_order() {
    let (rpc, mut events) = spawn("reply");
    let init = rpc.request("initialize", json!({ "clientInfo": { "name": "milagre" }, "capabilities": null })).await.unwrap();
    assert_eq!(init["userAgent"], "fake-rust/0.167.0");
    rpc.notify("initialized", None).await.unwrap();
    let thread = rpc.request("thread/start", json!({})).await.unwrap();
    let turn = rpc.request("turn/start", json!({ "threadId": thread["thread"]["id"], "input": [] })).await.unwrap();
    assert_eq!(turn["turn"]["id"], "turn-1");
    let mut methods = Vec::new();
    while methods.last().map(String::as_str) != Some("turn/completed") {
        methods.push(
            next_matching(&mut events, |e| match e {
                ServerEvent::Notification(n) => Some(n.method.clone()),
                _ => None,
            })
            .await,
        );
    }
    assert_eq!(methods, ["turn/started", "item/agentMessage/delta", "item/agentMessage/delta", "turn/completed"]);
    // `initialized` went out bare, exactly as codex-rpc.cjs writes it.
    let frames = received(&rpc).await;
    assert!(frames.contains(&json!({ "method": "initialized" })));
    rpc.close().await;
}

#[tokio::test]
async fn concurrent_requests_match_out_of_order_answers() {
    let (rpc, _events) = spawn("reply");
    let mut set = tokio::task::JoinSet::new();
    for n in 0..20u64 {
        let rpc = rpc.clone();
        // Later requests answer first.
        set.spawn(async move { (n, rpc.request("echo", json!({ "value": n, "delayMs": (20 - n) * 10 })).await.unwrap()) });
    }
    let mut seen = 0;
    while let Some(joined) = set.join_next().await {
        let (n, result) = joined.unwrap();
        assert_eq!(result["value"], n);
        seen += 1;
    }
    assert_eq!(seen, 20);
    assert_eq!(rpc.pending_requests(), 0);
    assert_eq!(rpc.stats().responses_matched, 20);
    rpc.close().await;
}

#[tokio::test]
async fn server_errors_are_marked() {
    let (rpc, _events) = spawn("reply");
    let error = rpc.request("thread/nope", json!({})).await.unwrap_err();
    assert!(error.is_server_error());
    assert_eq!(error.to_string(), "unknown method thread/nope");
    assert!(matches!(error, RpcError::Server { code: -32601, .. }));
    rpc.close().await;
}

#[tokio::test]
async fn timed_out_request_is_never_replayed_and_its_late_answer_is_unmatched() {
    let (rpc, mut events) = spawn("reply");
    let error =
        rpc.request_with_timeout("echo", json!({ "value": "late", "delayMs": 300 }), Some(Duration::from_millis(50))).await.unwrap_err();
    assert_eq!(error, RpcError::Timeout { method: "echo".into(), after: Duration::from_millis(50) });
    assert!(!error.is_server_error());
    assert_eq!(rpc.pending_requests(), 0);
    let stray = next_matching(&mut events, |e| match e {
        ServerEvent::Diagnostic(Diagnostic::UnmatchedResponse { id }) => Some(id.clone()),
        _ => None,
    })
    .await;
    assert_eq!(stray, RequestId::Int(1));
    // A later request gets a new id and its own answer, not the stale one.
    assert_eq!(rpc.request("echo", json!({ "value": "fresh" })).await.unwrap()["value"], "fresh");
    let echoes: Vec<Value> = received(&rpc).await.into_iter().filter(|f| f["method"] == "echo").collect();
    assert_eq!(echoes.len(), 2, "each request written exactly once: {echoes:?}");
    assert_ne!(echoes[0]["id"], echoes[1]["id"]);
    assert_eq!(rpc.stats().unmatched_responses, 1);
    rpc.close().await;
}

#[tokio::test]
async fn dropping_a_request_future_cancels_it() {
    let (rpc, _events) = spawn("reply");
    tokio::select! {
        _ = rpc.request_with_timeout("fake/hang", json!({}), None) => panic!("hang answered"),
        _ = tokio::time::sleep(Duration::from_millis(100)) => {}
    }
    assert_eq!(rpc.pending_requests(), 0);
    assert!(rpc.request("echo", json!({ "value": 1 })).await.is_ok());
    rpc.close().await;
}

#[tokio::test]
async fn in_flight_requests_are_bounded() {
    let limits = Limits { max_pending_requests: 2, ..fast_limits() };
    let (rpc, _events) = CodexRpc::spawn(fake("reply").limits(limits)).unwrap();
    let a = tokio::spawn({
        let rpc = rpc.clone();
        async move { rpc.request_with_timeout("fake/hang", json!({}), None).await }
    });
    let b = tokio::spawn({
        let rpc = rpc.clone();
        async move { rpc.request_with_timeout("fake/hang", json!({}), None).await }
    });
    assert!(eventually(|| rpc.pending_requests() == 2, Duration::from_secs(2)).await);
    assert_eq!(rpc.request("echo", json!({})).await.unwrap_err(), RpcError::TooManyPending { limit: 2 });
    rpc.close().await;
    // Closing fails what was waiting rather than leaving it hanging.
    assert!(matches!(a.await.unwrap(), Err(RpcError::Exited { .. })));
    assert!(matches!(b.await.unwrap(), Err(RpcError::Exited { .. })));
}

#[tokio::test]
async fn garbage_and_stderr_never_become_protocol() {
    let (rpc, mut events) = spawn("reply");
    assert_eq!(rpc.request("fake/noise", json!({})).await.unwrap(), json!({ "ok": true }));
    let mut malformed = 0;
    let mut methods = Vec::new();
    let mut unmatched = Vec::new();
    while let Ok(Some(event)) = tokio::time::timeout(Duration::from_millis(200), events.recv()).await {
        match event {
            ServerEvent::Diagnostic(Diagnostic::MalformedFrame { .. }) => malformed += 1,
            ServerEvent::Diagnostic(Diagnostic::UnmatchedResponse { id }) => unmatched.push(id),
            ServerEvent::Notification(n) => methods.push(n.method),
            other => panic!("unexpected {other:?}"),
        }
    }
    // "not json", `[1,2]` and `{"neither":true}`; blank lines are skipped silently.
    assert_eq!(malformed, 3);
    assert_eq!(unmatched, [RequestId::Int(424242)]);
    // The CRLF frame parses; the stderr lines that look like frames are not delivered.
    assert_eq!(methods, ["fake/crlf"]);
    assert!(eventually(|| rpc.stderr_tail().contains("fake/from-stderr"), Duration::from_secs(2)).await);
    rpc.close().await;
}

#[tokio::test]
async fn an_oversized_frame_stops_the_process_and_fails_waiters() {
    let limits = Limits { max_frame_bytes: 1024, ..fast_limits() };
    let (rpc, mut events) = CodexRpc::spawn(fake("reply").limits(limits)).unwrap();
    let pid = rpc.pid().unwrap();
    let waiting = tokio::spawn({
        let rpc = rpc.clone();
        async move { rpc.request_with_timeout("fake/hang", json!({}), None).await }
    });
    assert!(eventually(|| rpc.pending_requests() == 1, Duration::from_secs(2)).await);
    let _ = rpc.request_with_timeout("fake/huge", json!({ "bytes": 64 * 1024 }), Some(Duration::from_secs(5))).await;
    let exit = next_matching(&mut events, |e| match e {
        ServerEvent::Exit(info) => Some(info.clone()),
        _ => None,
    })
    .await;
    assert_eq!(exit.reason, ExitReason::ProtocolViolation);
    assert!(exit.detail.contains("more than 1024 bytes"), "{}", exit.detail);
    assert_eq!(waiting.await.unwrap(), Err(RpcError::Exited { detail: exit.detail.clone() }));
    assert!(eventually(|| !pid_alive(pid), Duration::from_secs(2)).await);
    assert_eq!(rpc.request("echo", json!({})).await.unwrap_err(), RpcError::NotRunning);
}

#[tokio::test]
async fn outgoing_frames_are_bounded_and_not_written() {
    let limits = Limits { max_frame_bytes: 256, ..fast_limits() };
    let (rpc, _events) = CodexRpc::spawn(fake("reply").limits(limits)).unwrap();
    let error = rpc.request("echo", json!({ "value": "x".repeat(1000) })).await.unwrap_err();
    assert!(matches!(error, RpcError::FrameTooLarge { limit: 256, .. }));
    assert_eq!(rpc.stats().requests_sent, 0);
    assert_eq!(rpc.pending_requests(), 0);
    rpc.close().await;
}

#[tokio::test]
async fn a_last_frame_without_newline_is_still_read_at_eof() {
    let (rpc, mut events) = spawn("reply");
    assert_eq!(rpc.request("fake/partial", json!({ "value": 42 })).await.unwrap(), json!({ "value": 42 }));
    let exit = next_matching(&mut events, |e| match e {
        ServerEvent::Exit(info) => Some(info.clone()),
        _ => None,
    })
    .await;
    assert_eq!((exit.code, exit.reason), (Some(0), ExitReason::ProcessEnded));
}

#[tokio::test]
async fn exit_fails_waiters_with_stderr_and_later_calls_are_not_running() {
    let (rpc, mut events) = spawn("reply");
    let waiting = tokio::spawn({
        let rpc = rpc.clone();
        async move { rpc.request_with_timeout("fake/hang", json!({}), None).await }
    });
    assert!(eventually(|| rpc.pending_requests() == 1, Duration::from_secs(2)).await);
    rpc.notify("fake/exit", Some(json!({ "code": 3, "stderr": "boom: model unavailable\n" }))).await.unwrap();
    let exit = next_matching(&mut events, |e| match e {
        ServerEvent::Exit(info) => Some(info.clone()),
        _ => None,
    })
    .await;
    assert_eq!(exit.code, Some(3));
    assert_eq!(exit.detail, "boom: model unavailable");
    assert_eq!(waiting.await.unwrap(), Err(RpcError::Exited { detail: "boom: model unavailable".into() }));
    assert_eq!(rpc.request("initialize", json!({})).await.unwrap_err().to_string(), "Codex is not running.");
    assert_eq!(rpc.pid(), None);
    // Exactly one Exit, and it is the last event.
    assert!(tokio::time::timeout(Duration::from_millis(200), events.recv()).await.is_err());
}

#[tokio::test]
async fn exit_without_stderr_names_the_code() {
    let (rpc, _events) = spawn("reply");
    let _ = rpc.request("fake/exit", json!({ "code": 5 })).await;
    let exit = rpc.wait_exit().await;
    assert_eq!(exit.detail, "Codex exited with code 5.");
}

#[tokio::test]
async fn stderr_floods_are_drained_and_bounded() {
    let (rpc, _events) = spawn("reply");
    // Far past a pipe buffer: a reader that didn't drain stderr would deadlock Codex here.
    assert_eq!(rpc.request("fake/stderr", json!({ "bytes": 2 * 1024 * 1024 })).await.unwrap(), json!({ "ok": true }));
    assert!(eventually(|| rpc.stderr_tail().contains("stderr tail marker"), Duration::from_secs(2)).await);
    assert!(rpc.stderr_tail().len() <= 4000);
    rpc.close().await;
}

#[tokio::test]
async fn closing_stdout_while_alive_stops_the_process() {
    let (rpc, mut events) = spawn("reply");
    let pid = rpc.pid().unwrap();
    assert_eq!(rpc.request("fake/close-stdout", json!({})).await.unwrap(), json!({ "ok": true }));
    let exit = next_matching(&mut events, |e| match e {
        ServerEvent::Exit(info) => Some(info.clone()),
        _ => None,
    })
    .await;
    assert_eq!(exit.reason, ExitReason::ProcessEnded);
    assert!(exit.signal.is_some(), "killed after the drain grace: {exit:?}");
    assert!(eventually(|| !pid_alive(pid), Duration::from_secs(2)).await);
}

#[tokio::test]
async fn close_stops_the_whole_process_group() {
    let (rpc, _events) = spawn("reply");
    let grandchild = rpc.request("fake/spawn-grandchild", json!({})).await.unwrap()["pid"].as_u64().unwrap() as u32;
    assert!(pid_alive(grandchild));
    let exit = rpc.close().await;
    assert_eq!(exit.reason, ExitReason::Closed);
    assert!(eventually(|| !pid_alive(grandchild), Duration::from_secs(3)).await, "grandchild {grandchild} survived");
    // Idempotent.
    assert_eq!(rpc.close().await, exit);
}

#[tokio::test]
async fn dropping_the_last_handle_kills_the_process() {
    let (rpc, events) = spawn("reply");
    let pid = rpc.pid().unwrap();
    rpc.request("echo", json!({})).await.unwrap();
    drop(rpc);
    drop(events);
    assert!(eventually(|| !pid_alive(pid), Duration::from_secs(3)).await);
}

#[tokio::test]
async fn a_missing_cli_is_explained() {
    let error = CodexRpc::spawn(SpawnOptions::new("milagre-definitely-missing-cli")).err().unwrap();
    assert_eq!(error, SpawnError::NotFound { detail: "milagre-definitely-missing-cli isn't installed or isn't on your PATH.".into() });
}

#[tokio::test]
async fn server_requests_are_answered_exactly_once() {
    let (rpc, mut events) = spawn("reply");
    rpc.request("fake/server-request", json!({ "id": "srv-x", "method": "item/tool/requestUserInput", "params": { "questions": [] } }))
        .await
        .unwrap();
    let request = next_matching(&mut events, |e| match e {
        ServerEvent::Request(r) => Some(r.clone()),
        _ => None,
    })
    .await;
    assert_eq!((request.id.clone(), request.method.as_str()), (RequestId::from("srv-x"), "item/tool/requestUserInput"));
    assert_eq!(request.raw["params"]["questions"], json!([]));
    assert_eq!(rpc.open_server_requests(), [RequestId::from("srv-x")]);
    rpc.respond(&request.id, json!({ "answers": {} })).await.unwrap();
    assert_eq!(
        rpc.respond(&request.id, json!({ "answers": {} })).await.unwrap_err(),
        RpcError::UnknownServerRequest { id: "srv-x".into() }
    );
    let answered = next_matching(&mut events, |e| match e {
        ServerEvent::Notification(n) if n.method == "fake/answered" => Some(n.params.clone()),
        _ => None,
    })
    .await;
    assert_eq!(answered, json!({ "id": "srv-x", "answer": { "answers": {} } }));
    let frames = received(&rpc).await;
    assert_eq!(frames.iter().filter(|f| f["id"] == "srv-x").count(), 1);
    rpc.close().await;
}

#[tokio::test]
async fn withdrawn_server_requests_cannot_be_answered() {
    let (rpc, mut events) = spawn("reply");
    rpc.request("fake/server-request", json!({ "id": 12, "method": "item/commandExecution/requestApproval" })).await.unwrap();
    rpc.request("fake/notify", json!({ "method": "serverRequest/resolved", "params": { "requestId": 12 } })).await.unwrap();
    next_matching(&mut events, |e| matches!(e, ServerEvent::Notification(n) if n.method == "serverRequest/resolved").then_some(())).await;
    assert!(rpc.open_server_requests().is_empty());
    assert!(matches!(rpc.respond(&RequestId::Int(12), json!({})).await, Err(RpcError::UnknownServerRequest { .. })));
    // Unsupported methods get a JSON-RPC error.
    rpc.request("fake/server-request", json!({ "id": "srv-u", "method": "item/new" })).await.unwrap();
    rpc.respond_error(&RequestId::from("srv-u"), "Milagre does not support item/new yet.").await.unwrap();
    let answered = next_matching(&mut events, |e| match e {
        ServerEvent::Notification(n) if n.method == "fake/answered" => Some(n.params.clone()),
        _ => None,
    })
    .await;
    assert_eq!(answered["answer"], json!({ "code": -32601, "message": "Milagre does not support item/new yet." }));
    rpc.close().await;
}

#[tokio::test]
async fn a_request_without_a_time_limit_waits_until_exit() {
    let (rpc, _events) = spawn("reply");
    let waiting = tokio::spawn({
        let rpc = rpc.clone();
        async move { rpc.request_with_timeout("fake/hang", json!({}), None).await }
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!waiting.is_finished());
    rpc.close().await;
    assert!(matches!(waiting.await.unwrap(), Err(RpcError::Exited { .. })));
}

#[tokio::test]
async fn an_unread_event_queue_stops_codex_instead_of_growing() {
    let limits = Limits { event_queue: milagre_providers::queue::QueueLimits { max_events: 50, max_bytes: 1 << 30 }, ..fast_limits() };
    let (rpc, mut events) = CodexRpc::spawn(fake("reply").limits(limits)).unwrap();
    let pid = rpc.pid().unwrap();
    // Nobody reads events while Codex floods them; the request still gets its answer or the exit.
    let _ = rpc.request("fake/flood", json!({ "count": 2000, "bytes": 100 })).await;
    let exit = rpc.wait_exit().await;
    assert_eq!(exit.reason, ExitReason::ConsumerStalled, "{exit:?}");
    assert!(exit.detail.contains("waiting to be read"), "{}", exit.detail);
    assert!(eventually(|| !pid_alive(pid), Duration::from_secs(2)).await);
    // What was queued is still delivered, then the exit, nothing past the budget.
    let mut floods = 0;
    loop {
        match tokio::time::timeout(Duration::from_secs(2), events.recv()).await.unwrap().unwrap() {
            ServerEvent::Notification(n) if n.method == "fake/flood" => floods += 1,
            ServerEvent::Exit(_) => break,
            _ => {}
        }
    }
    assert!(floods <= 50, "{floods} queued past the budget");
    assert_eq!(events.queued(), (0, 0));
}

#[tokio::test]
async fn the_event_byte_budget_counts_frame_sizes() {
    let limits =
        Limits { event_queue: milagre_providers::queue::QueueLimits { max_events: 100_000, max_bytes: 64 * 1024 }, ..fast_limits() };
    let (rpc, _events) = CodexRpc::spawn(fake("reply").limits(limits)).unwrap();
    let _ = rpc.request("fake/flood", json!({ "count": 20, "bytes": 8 * 1024 })).await;
    assert_eq!(rpc.wait_exit().await.reason, ExitReason::ConsumerStalled);
}

#[tokio::test]
async fn too_many_open_server_requests_stop_codex() {
    let limits = Limits { max_open_server_requests: 5, ..fast_limits() };
    let (rpc, _events) = CodexRpc::spawn(fake("reply").limits(limits)).unwrap();
    let _ = rpc.request("fake/requests", json!({ "count": 50 })).await;
    let exit = rpc.wait_exit().await;
    assert_eq!(exit.reason, ExitReason::ProtocolViolation);
    assert!(exit.detail.contains("more than 5 requests"), "{}", exit.detail);
}

fn big_params(bytes: usize) -> Value {
    json!({ "blob": "b".repeat(bytes) })
}

#[tokio::test]
async fn a_codex_that_stops_reading_is_stopped_after_the_write_timeout() {
    let limits = Limits { write_timeout: Duration::from_millis(300), ..fast_limits() };
    let (rpc, _events) = CodexRpc::spawn(fake("reply").limits(limits)).unwrap();
    tokio::spawn({
        let rpc = rpc.clone();
        async move { rpc.request_with_timeout("fake/stop-reading", json!({ "ms": 5000 }), None).await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    // Far past the pipe buffer, and with no request time limit: only the write timeout can end it.
    let started = tokio::time::Instant::now();
    let error = rpc.request_with_timeout("fake/big", big_params(4 << 20), None).await.unwrap_err();
    assert!(started.elapsed() < Duration::from_secs(3), "took {:?}", started.elapsed());
    assert!(matches!(error, RpcError::Io(_) | RpcError::Exited { .. }), "{error:?}");
    let exit = rpc.wait_exit().await;
    assert_eq!(exit.reason, ExitReason::InputStalled, "{exit:?}");
}

#[tokio::test]
async fn close_does_not_wait_behind_a_stuck_write() {
    let (rpc, _events) = spawn("reply");
    let pid = rpc.pid().unwrap();
    tokio::spawn({
        let rpc = rpc.clone();
        async move { rpc.request_with_timeout("fake/stop-reading", json!({ "ms": 20000 }), None).await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    let stuck = tokio::spawn({
        let rpc = rpc.clone();
        async move { rpc.request_with_timeout("fake/big", big_params(4 << 20), None).await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    let started = tokio::time::Instant::now();
    let exit = rpc.close().await;
    assert!(started.elapsed() < Duration::from_secs(2), "close took {:?}", started.elapsed());
    assert_eq!(exit.reason, ExitReason::Closed);
    assert!(stuck.await.unwrap().is_err());
    assert!(eventually(|| !pid_alive(pid), Duration::from_secs(2)).await);
}

#[tokio::test]
async fn a_timed_out_write_never_leaves_half_a_frame() {
    let limits = Limits { write_timeout: Duration::from_secs(10), ..fast_limits() };
    let (rpc, _events) = CodexRpc::spawn(fake("reply").limits(limits)).unwrap();
    tokio::spawn({
        let rpc = rpc.clone();
        async move { rpc.request_with_timeout("fake/stop-reading", json!({ "ms": 400 }), None).await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    // Times out mid-write: the frame still goes out whole.
    let big = rpc.request_with_timeout("fake/big", big_params(1 << 20), Some(Duration::from_millis(50))).await.unwrap_err();
    assert!(matches!(big, RpcError::Timeout { .. }), "{big:?}");
    // Times out while queued behind it: never written at all.
    let queued = rpc.request_with_timeout("fake/queued", json!({}), Some(Duration::from_millis(50))).await.unwrap_err();
    assert!(matches!(queued, RpcError::Timeout { .. }), "{queued:?}");
    // The next frame arrives intact once Codex reads again.
    assert_eq!(rpc.request("echo", json!({ "value": "after" })).await.unwrap()["value"], "after");
    let frames = received(&rpc).await;
    let big_frame = frames.iter().find(|f| f["method"] == "fake/big").expect("big frame parsed whole");
    assert_eq!(big_frame["params"]["blob"].as_str().unwrap().len(), 1 << 20);
    assert!(!frames.iter().any(|f| f["method"] == "fake/queued"), "a cancelled queued frame was written");
    assert_eq!(rpc.stats().malformed_frames, 0);
    rpc.close().await;
}

#[tokio::test]
async fn an_answer_that_cannot_be_written_is_reported() {
    let limits = Limits { write_timeout: Duration::from_millis(300), ..fast_limits() };
    let (rpc, mut events) = CodexRpc::spawn(fake("reply").limits(limits)).unwrap();
    rpc.request("fake/server-request", json!({ "id": "srv-a", "method": "item/commandExecution/requestApproval" })).await.unwrap();
    next_matching(&mut events, |e| matches!(e, ServerEvent::Request(_)).then_some(())).await;
    tokio::spawn({
        let rpc = rpc.clone();
        async move { rpc.request_with_timeout("fake/stop-reading", json!({ "ms": 5000 }), None).await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    tokio::spawn({
        let rpc = rpc.clone();
        async move { rpc.notify("fake/big", Some(big_params(4 << 20))).await }
    });
    // The answer queues behind the stuck frame.
    tokio::time::sleep(Duration::from_millis(50)).await;
    let answered = rpc.respond(&RequestId::from("srv-a"), json!({ "decision": "accept" })).await;
    assert!(answered.is_err(), "a lost answer was reported as sent");
}

#[tokio::test]
async fn close_after_the_leader_exited_stops_what_it_left_running() {
    let (rpc, _events) = spawn("reply");
    let grandchild = rpc.request("fake/spawn-grandchild", json!({})).await.unwrap()["pid"].as_u64().unwrap() as u32;
    rpc.notify("fake/exit", Some(json!({ "code": 0 }))).await.unwrap();
    let exit = rpc.wait_exit().await;
    assert_eq!(exit.code, Some(0));
    assert!(pid_alive(grandchild), "the grandchild should outlive its leader until close");
    rpc.close().await;
    assert!(eventually(|| !pid_alive(grandchild), Duration::from_secs(3)).await);
}

#[test]
fn spawn_options_never_print_the_environment() {
    let options = SpawnOptions::new("codex").env([("OPENAI_API_KEY", "sk-secret"), ("HOME", "/Users/me")]);
    let printed = format!("{options:?}");
    assert!(!printed.contains("sk-secret") && !printed.contains("OPENAI_API_KEY"), "{printed}");
    assert!(printed.contains("<2 variables redacted>"), "{printed}");
    let session = milagre_providers::codex::SessionOptions::new(milagre_providers::codex::ConnectOptions::new(options, "0"), "/repo");
    assert!(!format!("{session:?}").contains("sk-secret"));
}

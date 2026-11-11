mod common;
use common::*;
use milagre_claude::{ClaudeClient, ClaudeEvent, ClaudeSession, Diagnostic, ExitReason, Handlers, SessionOptions, TurnRequest};
use serde_json::{json, Value};

#[tokio::test]
async fn display_surrogates_are_repaired_with_diagnostics_and_stream_continues() {
    let lines = [
        r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"a\ud83d"}}}"#,
        r#"{"type":"result","subtype":"success","result":"\udfff"}"#,
        r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"r","content":[{"type":"text","text":"\ud800"}]}]}}"#,
        r#"{"type":"assistant","message":{"content":[{"type":"text","text":"\ud83d\ude00"}]}}"#,
        r#"{"type":"assistant","message":{"content":[{"type":"text","text":"\\ud800"}]}}"#,
    ];
    let (launch, dir) =
        fake("inbound-surrogates", json!(lines.iter().map(|line| json!({"emit_raw":format!("{line}\n")})).collect::<Vec<_>>()));
    let (client, mut events) = ClaudeClient::spawn(&launch, Handlers::default(), quick_limits()).unwrap();
    let mut messages = Vec::new();
    let mut diagnostics = 0;
    while messages.len() < lines.len() {
        match events.recv().await {
            Some(ClaudeEvent::Message(value)) => messages.push(value),
            Some(ClaudeEvent::Diagnostic(Diagnostic::TextReplaced { strings })) => diagnostics += strings,
            Some(ClaudeEvent::Diagnostic(_)) => {}
            other => panic!("{other:?}"),
        }
    }
    assert_eq!(diagnostics, 3);
    assert_eq!(messages[0]["event"]["delta"]["text"], "a\u{fffd}");
    assert_eq!(messages[1]["result"], "\u{fffd}");
    assert_eq!(messages[2]["message"]["content"][0]["content"][0]["text"], "\u{fffd}");
    assert_eq!(messages[3]["message"]["content"][0]["text"], "😀");
    assert_eq!(messages[4]["message"]["content"][0]["text"], r"\ud800");
    assert_eq!(client.close().await.code, Some(0));
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn opaque_ids_keys_and_arguments_stay_strict_and_malformed_json_still_fails() {
    for line in [
        r#"{"type":"control_request","request_id":"same\ud800","request":{"subtype":"ping"}}"#,
        r#"{"type":"control_request","request_id":"same\udfff","request":{"subtype":"ping"}}"#,
        r#"{"type":"control_request","request_id":"valid","result":"\ud800","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"private-value\udfff"}}}"#,
        r#"{"type":"system","subtype":"init","session_id":"same\ud800"}"#,
        r#"{"type":"assistant","message":{"content":[{"type":"text","text":"\ud800","same\udfff":1}]}}"#,
        r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"r","name":"Bash","input":{"command":"\ud800"}}]}}"#,
        r#"{"type":"result","result":"\ud800", broken}"#,
    ] {
        let (launch, dir) = fake("opaque-surrogates", json!([{"emit_raw":format!("{line}\n")},{"sleep_ms":10000}]));
        let (client, mut events) = ClaudeClient::spawn(&launch, Handlers::default(), quick_limits()).unwrap();
        let trace = drain(&mut events).await;
        assert!(!trace.iter().any(|e| matches!(e, ClaudeEvent::Message(_))));
        assert!(matches!(client.wait().await.reason, ExitReason::ProtocolViolation(_)));
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[tokio::test]
async fn half_emoji_output_does_not_end_a_healthy_chat_turn() {
    let raw =
        r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"half \ud83d"}}}"#;
    let output = r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"r","content":"output \udfff"}]}}"#;
    let result = r#"{"type":"result","subtype":"success","num_turns":1,"result":"done \ud800"}"#;
    let (launch, dir) = fake(
        "session-surrogates",
        json!([
            {"expect":{"subtype":"initialize"}},{"reply":{}},{"expect":{"subtype":"set_max_thinking_tokens"}},{"reply":{}},
            {"expect":{"type":"user"}},{"emit_raw":format!("{raw}\n")},
            {"emit":{"type":"assistant","message":{"content":[{"type":"tool_use","id":"r","name":"Read","input":{"file_path":"fixture"}}]}}},
            {"emit_raw":format!("{output}\n")},{"emit_raw":format!("{result}\n")}
        ]),
    );
    let mut options = SessionOptions::new(launch);
    options.limits = quick_limits();
    let (session, mut events) = ClaudeSession::new(options);
    session
        .start_turn(TurnRequest { model: "sonnet".into(), content: vec![json!({"type":"text","text":"fixture"})], ..Default::default() })
        .await
        .unwrap();
    let mut trace = Vec::<Value>::new();
    loop {
        let event = tokio::time::timeout(std::time::Duration::from_secs(3), events.recv()).await.unwrap().unwrap();
        let done = event["type"] == "turn-completed";
        assert_ne!(event["type"], "turn-failed");
        trace.push(event);
        if done {
            break;
        }
    }
    assert!(trace.iter().any(|e| e["type"] == "text-delta" && e["text"] == "half \u{fffd}"));
    assert!(trace.iter().any(|e| e["type"] == "step-completed"));
    assert!(!session.is_closed());
    assert!(session.pid().is_some());
    session.close().await;
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn non_utf8_banners_and_eof_tails_are_diagnostics_but_protocol_lines_stay_strict() {
    for (bytes, tail, expected) in [
        (b"banner \xff\n".to_vec(), false, "banner \u{fffd}"),
        (b"banner \xf0\x9f".to_vec(), true, "banner \u{fffd}"),
        (b"{\"result\":\"cut \xf0\x9f".to_vec(), true, "truncated"),
        (b"{\"session_id\":\"same\xff\"}\n".to_vec(), false, "fatal"),
    ] {
        let mut script = vec![json!({"emit_bytes":bytes})];
        if !tail {
            script.push(json!({"emit":{"type":"still_healthy"}}));
        }
        script.push(json!({"exit":0}));
        let (launch, dir) = fake("non-utf8", json!(script));
        let (client, mut events) = ClaudeClient::spawn(&launch, Handlers::default(), quick_limits()).unwrap();
        let trace = drain(&mut events).await;
        let info = client.wait().await;
        if expected == "fatal" {
            assert!(matches!(info.reason, ExitReason::ProtocolViolation(_)), "{trace:?}");
            assert!(!trace.iter().any(|e| matches!(e, ClaudeEvent::Message(_))));
        } else {
            assert_eq!(info.reason, ExitReason::Exited, "{trace:?}");
            assert_eq!(info.code, Some(0));
            if expected == "truncated" {
                assert!(matches!(&trace[0], ClaudeEvent::Diagnostic(Diagnostic::TruncatedTail(_))));
            } else {
                assert!(matches!(&trace[0], ClaudeEvent::Diagnostic(Diagnostic::NonJsonLine(text)) if text == expected));
            }
            if !tail {
                assert!(trace.iter().any(|e| matches!(e, ClaudeEvent::Message(v) if v["type"] == "still_healthy")));
            }
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[tokio::test]
async fn full_diagnostic_lane_drops_repair_notice_without_blocking_control() {
    let (launch, dir) = fake(
        "full-diagnostic",
        json!([
            {"emit_raw":"banner\n"},
            {"emit_raw":"{\"type\":\"keep_alive\",\"result\":\"\\ud800\"}\n"},
            {"expect":{"subtype":"barrier"}}, {"reply":{}}, {"wait_eof":true}
        ]),
    );
    let mut limits = quick_limits();
    limits.event_capacity = 1;
    let (client, mut events) = ClaudeClient::spawn(&launch, Handlers::default(), limits).unwrap();
    client.control("barrier", Value::Null).await.unwrap();
    // The queued banner occupies the only slot until after the repaired keep-alive/control reply.
    assert!(matches!(events.recv().await, Some(ClaudeEvent::Diagnostic(Diagnostic::NonJsonLine(_)))));
    client.end_input().await.unwrap();
    let trace = drain(&mut events).await;
    assert!(!trace.iter().any(|e| matches!(e, ClaudeEvent::Diagnostic(Diagnostic::TextReplaced { .. }))));
    assert_eq!(client.wait().await.code, Some(0));
    std::fs::remove_dir_all(dir).unwrap();
}

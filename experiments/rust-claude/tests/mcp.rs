mod common;
use common::*;
use milagre_claude::mcp::{DispatchError, FnDispatch, InProcessMcp, McpDispatch, McpLimits, McpTool, RegistrationError};
use milagre_claude::{ClaudeClient, Handlers, SessionOptions};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;

fn tools() -> Vec<McpTool> {
    vec![McpTool { name: "read".into(), read_only: true }, McpTool { name: "write".into(), read_only: false }]
}
fn request(outer: &str, body: Value) -> Value {
    json!({"request":{"id":outer,"request":{"subtype":"mcp_message","server_name":"milagre","message":body}}})
}
fn rpc(id: i32, method: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"method":method})
}
fn expect(id: i32, tail: &str, value: Value) -> Value {
    let mut fields = serde_json::Map::new();
    fields.insert("/response/response/mcp_response/id".into(), json!(id));
    fields.insert(format!("/response/response/mcp_response/{tail}"), value);
    json!({"expect":{"type":"control_response","fields":fields}})
}
async fn run(script: Vec<Value>, handler: Arc<dyn milagre_claude::McpHandler>) {
    let mut script = script;
    script.push(json!({"emit":{"type":"done"}}));
    let (launch, dir) = fake("mcp", json!(script));
    let (client, mut events) = ClaudeClient::spawn(&launch, Handlers { mcp: Some(handler), ..Default::default() }, quick_limits()).unwrap();
    assert_eq!(next_message(&mut events).await["type"], "done");
    assert_eq!(client.close().await.code, Some(0));
    std::fs::remove_dir_all(dir).unwrap();
}
fn echo() -> Arc<dyn McpDispatch> {
    Arc::new(FnDispatch(|frame: Vec<u8>, _| {
        Box::pin(async move {
            let body: Value = serde_json::from_slice(&frame).unwrap();
            if body.get("id").is_none() {
                return Ok(None);
            }
            let result = if body["method"] == "tools/list" {
                json!({"tools":[
                    {"name":"read","inputSchema":{"type":"object"},"annotations":{"readOnlyHint":true}},
                    {"name":"write","inputSchema":{"type":"object"},"annotations":{"readOnlyHint":false}}
                ]})
            } else {
                json!({"ok":true})
            };
            Ok(Some(serde_json::to_vec(&json!({"jsonrpc":"2.0","id":body["id"],"result":result})).unwrap()))
        }) as milagre_claude::handlers::BoxFuture<_>
    }))
}

#[tokio::test]
async fn control_roundtrip_lists_authoritative_effects_and_acks_notifications() {
    let registry = InProcessMcp::new();
    let registration = registry.register("milagre", tools(), echo(), McpLimits::default()).unwrap();
    run(
        vec![
            request("init", rpc(1, "initialize")),
            expect(1, "result/ok", json!(true)),
            request("notify", json!({"jsonrpc":"2.0","method":"notifications/initialized"})),
            json!({"expect":{"type":"control_response","fields":{"/response/response/mcp_response":{"jsonrpc":"2.0","result":{}}}}}),
            request("list", rpc(2, "tools/list")),
            expect(2, "result/tools/0/_meta/anthropic~1alwaysLoad", json!(true)),
            request("call", rpc(3, "tools/call")),
            expect(3, "result/ok", json!(true)),
            request("response", json!({"jsonrpc":"2.0","id":4,"result":{}})),
            json!({"expect":{"type":"control_response","fields":{"/response/response/mcp_response":{"jsonrpc":"2.0","result":{}}}}}),
        ],
        registration.handler(),
    )
    .await;
}

#[test]
fn attach_is_atomic_preserves_external_servers_and_never_preallows_writes() {
    let registry = InProcessMcp::new();
    let registration = registry.register("milagre", tools(), echo(), McpLimits::default()).unwrap();
    assert!(matches!(registry.register("milagre", tools(), echo(), McpLimits::default()), Err(RegistrationError::Duplicate)));
    let mut options = SessionOptions::new(milagre_claude::LaunchOptions::new("/fake"));
    options.launch.mcp_servers.insert("external".into(), json!({"type":"stdio","command":"untouched"}));
    options.launch.allowed_tools.push("Read".into());
    registration.attach(&mut options).unwrap();
    assert_eq!(options.launch.allowed_tools, ["Read", "mcp__milagre__read"]);
    assert_eq!(options.launch.mcp_servers["external"]["command"], "untouched");
    assert_eq!(options.init.sdk_mcp_servers, ["milagre"]);
    let before = options.launch.mcp_servers.clone();
    assert_eq!(registration.attach(&mut options), Err(RegistrationError::ConfigurationConflict));
    assert_eq!(before, options.launch.mcp_servers);
    for conflict in ["server", "handler", "allow", "cache"] {
        let mut options = SessionOptions::new(milagre_claude::LaunchOptions::new("/fake"));
        match conflict {
            "server" => {
                options.launch.mcp_servers.insert("milagre".into(), json!({"command":"keep"}));
            }
            "handler" => options.mcp = Some(registration.handler()),
            "allow" => options.launch.allowed_tools.push("mcp__milagre__write".into()),
            _ => {
                options.init.extra.insert("sdkMcpServerManifests".into(), json!({}));
            }
        }
        assert_eq!(registration.attach(&mut options), Err(RegistrationError::ConfigurationConflict));
        assert!(options.init.sdk_mcp_servers.is_empty());
    }
    registration.revoke();
    assert_eq!(registration.attach(&mut options), Err(RegistrationError::Revoked));
    assert!(matches!(registry.register("bad__name", tools(), echo(), McpLimits::default()), Err(RegistrationError::Invalid)));
    assert!(matches!(registry.register("dup", vec![tools()[0].clone(); 2], echo(), McpLimits::default()), Err(RegistrationError::Invalid)));
}

#[tokio::test]
async fn typed_errors_panics_and_invalid_payloads_never_expose_callback_details() {
    for behavior in ["error", "panic", "invalid", "wrong-id", "none", "misannotated", "extra", "missing"] {
        let callback = Arc::new(FnDispatch(move |frame: Vec<u8>, _| {
            Box::pin(async move {
                let body: Value = serde_json::from_slice(&frame).unwrap();
                match behavior {
                    "error" => Err(DispatchError::Failed),
                    "panic" => panic!("fixture-private-error"),
                    "invalid" => Ok(Some(b"fixture-private-error".to_vec())),
                    "wrong-id" => Ok(Some(br#"{"jsonrpc":"2.0","id":999,"result":{}}"#.to_vec())),
                    "none" => Ok(None),
                    _ => {
                        let list = match behavior {
                            "misannotated" => {
                                json!([{"name":"read","annotations":{"readOnlyHint":false}},{"name":"write","annotations":{"readOnlyHint":false}}])
                            }
                            "extra" => {
                                json!([{"name":"read","annotations":{"readOnlyHint":true}},{"name":"write","annotations":{"readOnlyHint":false}},{"name":"hidden","annotations":{"readOnlyHint":true}}])
                            }
                            _ => json!([]),
                        };
                        Ok(Some(serde_json::to_vec(&json!({"jsonrpc":"2.0","id":body["id"],"result":{"tools":list}})).unwrap()))
                    }
                }
            }) as milagre_claude::handlers::BoxFuture<_>
        }));
        let registry = InProcessMcp::new();
        let registration = registry.register("milagre", tools(), callback, McpLimits::default()).unwrap();
        let message = if ["error", "panic"].contains(&behavior) {
            "Host MCP request failed."
        } else if behavior == "none" {
            "Host MCP returned no response to a request."
        } else {
            "Host MCP returned an invalid response."
        };
        run(vec![request("x", rpc(1, "tools/list")), expect(1, "error", json!({"code":-32603,"message":message}))], registration.handler())
            .await;
    }
}

#[tokio::test]
async fn input_output_and_concurrent_calls_are_bounded() {
    let count = Arc::new(AtomicUsize::new(0));
    let callback = Arc::new(FnDispatch({
        let count = count.clone();
        move |_: Vec<u8>, _| {
            count.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(Some(vec![b'x'; 4096])) }) as milagre_claude::handlers::BoxFuture<_>
        }
    }));
    let registry = InProcessMcp::new();
    let registration =
        registry.register("milagre", tools(), callback, McpLimits { request_bytes: 256, reply_bytes: 1024, ..Default::default() }).unwrap();
    let mut large = rpc(1, "tools/call");
    large["params"] = json!({"text":"x".repeat(1024)});
    run(
        vec![
            request("large", large),
            expect(1, "error/message", json!("MCP request exceeds the bridge byte limit.")),
            request("reply", rpc(2, "tools/call")),
            expect(2, "error/message", json!("MCP reply exceeds the bridge byte limit.")),
        ],
        registration.handler(),
    )
    .await;
    assert_eq!(count.load(Ordering::SeqCst), 1);
    let entered = Arc::new(tokio::sync::Notify::new());
    let dropped = Arc::new(AtomicUsize::new(0));
    struct Dropped(Arc<AtomicUsize>);
    impl Drop for Dropped {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }
    let callback = Arc::new(FnDispatch({
        let entered = entered.clone();
        let dropped = dropped.clone();
        move |_: Vec<u8>, _| {
            let entered = entered.clone();
            let dropped = dropped.clone();
            Box::pin(async move {
                let _guard = Dropped(dropped);
                entered.notify_one();
                std::future::pending().await
            }) as milagre_claude::handlers::BoxFuture<_>
        }
    }));
    let other = registry
        .register("slow", vec![], callback, McpLimits { max_calls: 1, timeout: Duration::from_millis(100), ..Default::default() })
        .unwrap();
    let mut first = request("first", rpc(1, "tools/call"));
    first["request"]["request"]["server_name"] = json!("slow");
    let mut second = request("second", rpc(2, "tools/call"));
    second["request"]["request"]["server_name"] = json!("slow");
    run(
        vec![
            first,
            json!({"sleep_ms":20}),
            second,
            expect(2, "error/message", json!("Too many MCP calls in flight.")),
            expect(1, "error/message", json!("MCP request timed out; execution may have committed.")),
        ],
        other.handler(),
    )
    .await;
    assert_eq!(dropped.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn revoke_and_reregister_cannot_return_old_payload_or_transfer_new_grant() {
    let registry = InProcessMcp::new();
    let committed = Arc::new(AtomicUsize::new(0));
    let entered = Arc::new(tokio::sync::Notify::new());
    let callback = Arc::new(FnDispatch({
        let committed = committed.clone();
        let entered = entered.clone();
        move |_: Vec<u8>, _| {
            let committed = committed.clone();
            let entered = entered.clone();
            Box::pin(async move {
                committed.fetch_add(1, Ordering::SeqCst);
                entered.notify_one();
                std::future::pending().await
            }) as milagre_claude::handlers::BoxFuture<_>
        }
    }));
    let old = registry.register("milagre", tools(), callback, McpLimits::default()).unwrap();
    let old_generation = old.generation();
    let script = vec![
        request("old", rpc(1, "tools/call")),
        expect(1, "error/message", json!("MCP registration was revoked.")),
        request("late", rpc(2, "tools/call")),
        expect(2, "error/message", json!("MCP registration was revoked.")),
    ];
    let run = tokio::spawn(run(script, old.handler()));
    entered.notified().await;
    old.revoke();
    let new = registry.register("milagre", tools(), echo(), McpLimits::default()).unwrap();
    assert_ne!(old_generation, new.generation());
    drop(old);
    run.await.unwrap();
    assert_eq!(committed.load(Ordering::SeqCst), 1);
    run_again(new.handler()).await;
}
async fn run_again(handler: Arc<dyn milagre_claude::McpHandler>) {
    run(vec![request("new", rpc(3, "tools/call")), expect(3, "result/ok", json!(true))], handler).await;
}

#[tokio::test]
async fn outer_withdrawal_drops_work_and_releases_call_slot_without_reply() {
    struct Dropped(Arc<AtomicUsize>);
    impl Drop for Dropped {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }
    let dropped = Arc::new(AtomicUsize::new(0));
    let callback = Arc::new(FnDispatch({
        let dropped = dropped.clone();
        move |frame: Vec<u8>, _| {
            let dropped = dropped.clone();
            Box::pin(async move {
                let body: Value = serde_json::from_slice(&frame).unwrap();
                if body["method"] == "slow" {
                    let _guard = Dropped(dropped);
                    std::future::pending::<()>().await;
                }
                Ok(Some(serde_json::to_vec(&json!({"jsonrpc":"2.0","id":body["id"],"result":{}})).unwrap()))
            }) as milagre_claude::handlers::BoxFuture<_>
        }
    }));
    let registry = InProcessMcp::new();
    let registration = registry.register("milagre", vec![], callback, McpLimits { max_calls: 1, ..Default::default() }).unwrap();
    run(
        vec![
            request("withdrawn", rpc(1, "slow")),
            json!({"sleep_ms":30}),
            json!({"cancel":"withdrawn"}),
            json!({"expect_none_ms":30}),
            request("ping", rpc(2, "ping")),
            expect(2, "result", json!({})),
        ],
        registration.handler(),
    )
    .await;
    assert_eq!(dropped.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn registration_drop_and_transport_close_cancel_pending_callbacks() {
    for action in ["drop", "close"] {
        let entered = Arc::new(tokio::sync::Notify::new());
        let dropped = Arc::new(tokio::sync::Notify::new());
        struct Dropped(Arc<tokio::sync::Notify>);
        impl Drop for Dropped {
            fn drop(&mut self) {
                self.0.notify_one();
            }
        }
        let callback = Arc::new(FnDispatch({
            let entered = entered.clone();
            let dropped = dropped.clone();
            move |_: Vec<u8>, _| {
                let entered = entered.clone();
                let dropped = dropped.clone();
                Box::pin(async move {
                    let _guard = Dropped(dropped);
                    entered.notify_one();
                    std::future::pending().await
                }) as milagre_claude::handlers::BoxFuture<_>
            }
        }));
        let registry = InProcessMcp::new();
        let registration = registry.register("milagre", vec![], callback, McpLimits::default()).unwrap();
        let mut script = vec![request("pending", rpc(1, "slow"))];
        if action == "drop" {
            script.push(expect(1, "error/message", json!("MCP registration was revoked.")));
        } else {
            script.push(json!({"wait_eof":true}));
        }
        script.push(json!({"emit":{"type":"done"}}));
        let (launch, dir) = fake("mcp-drop", json!(script));
        let (client, mut events) =
            ClaudeClient::spawn(&launch, Handlers { mcp: Some(registration.handler()), ..Default::default() }, quick_limits()).unwrap();
        tokio::time::timeout(Duration::from_secs(2), entered.notified()).await.unwrap();
        if action == "drop" {
            drop(registration);
            assert_eq!(next_message(&mut events).await["type"], "done");
            assert_eq!(client.close().await.code, Some(0));
        } else {
            assert_eq!(client.close().await.code, Some(0));
        }
        tokio::time::timeout(Duration::from_secs(2), dropped.notified()).await.unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[tokio::test]
async fn pinned_handler_rejects_other_server_without_dispatch() {
    let registry = InProcessMcp::new();
    let registration = registry.register("milagre", tools(), echo(), McpLimits::default()).unwrap();
    let mut message = request("wrong", rpc(1, "ping"));
    message["request"]["request"]["server_name"] = json!("other");
    run(vec![message, expect(1, "error", json!({"code":-32601,"message":"MCP server is not registered."}))], registration.handler()).await;
}

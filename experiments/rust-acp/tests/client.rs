mod common;
use common::*;
use milagre_acp::{
    client::AcpClient,
    protocol::{self, Decision},
    RpcError, ServerEvent,
};
use serde_json::{json, Value};
use std::time::Duration;

async fn record(event: ServerEvent, client: &AcpClient, seen: &mut Vec<Value>) {
    match event {
        ServerEvent::Notification(n) => seen.push(json!({"type":"notification","method":n.method,"params":n.params})),
        ServerEvent::Request(r) => {
            seen.push(json!({"type":"request","id":r.id.to_value(),"method":r.method,"params":r.params}));
            assert_eq!(r.method, "session/request_permission");
            let options = r.params["options"].as_array().unwrap();
            client.rpc().respond(&r.id, protocol::permission_outcome(options, Decision::Deny, false)).await.unwrap();
        }
        other => panic!("unexpected {other:?}"),
    }
}
#[tokio::test]
async fn replays_node_fake_session_traces_for_both_vendors() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/node-traces.json")).unwrap();
    for case in fixture["scenarios"].as_array().unwrap() {
        let scenario = case["scenario"].as_str().unwrap();
        let spawn = node_fake(scenario).expect("Node is required for the ACP compatibility suite");
        let (client, init, mut events) = AcpClient::connect(spawn, "test").await.unwrap();
        assert_eq!(init, case["init"]);
        let session = client.new_session("/workspace", &[]).await.unwrap();
        assert_eq!(session, case["session"]);
        let id = session["sessionId"].as_str().unwrap();
        if scenario == "no-resume" {
            client.load_session(id, "/workspace", &[]).await.unwrap();
        }
        let blocks = vec![json!({"type":"text","text":"hi"})];
        let prompt = client.prompt(id, &blocks);
        tokio::pin!(prompt);
        let mut seen = vec![];
        let result = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                tokio::select! {
                    result=&mut prompt=>break result.unwrap(),
                    event=events.recv()=>record(event.unwrap(),&client,&mut seen).await,
                }
            }
        })
        .await
        .unwrap();
        while let Ok(event) = events.try_recv() {
            record(event, &client, &mut seen).await;
        }
        assert_eq!(result, case["result"]);
        let mut seen = json!(seen);
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().unwrap();
        normalize_paths(&mut seen, root.to_str().unwrap());
        assert_eq!(seen, case["events"], "{scenario}");
        client.rpc().close().await;
    }
}
#[tokio::test]
async fn explicit_auth_session_and_config_calls_keep_wire_shapes() {
    let (client, _, _events) = AcpClient::connect(fake("reply"), "test").await.unwrap();
    client.authenticate("oauth-personal", Duration::from_secs(1)).await.unwrap();
    let mcp = vec![json!({"type":"http","name":"milagre","url":"http://127.0.0.1:1/mcp","headers":[]})];
    client.new_session("/workspace", &mcp).await.unwrap();
    client.resume_session("saved", "/workspace", &[]).await.unwrap();
    client.load_session("saved", "/workspace", &[]).await.unwrap();
    client.set_config("saved", "autopilot", "on").await.unwrap();
    client.set_mode("saved", "default").await.unwrap();
    client.prompt("saved", &[json!({"type":"text","text":"hi"})]).await.unwrap();
    client.cancel("saved").await.unwrap();
    let received = client.rpc().request("fake/received", json!({})).await.unwrap();
    let frames = received["received"].as_array().unwrap();
    assert!(frames.iter().all(|f| f["jsonrpc"] == "2.0"));
    assert_eq!(frames[0]["params"], protocol::initialize("test"));
    assert_eq!(frames[1]["params"], protocol::authenticate("oauth-personal"));
    assert_eq!(frames[2]["params"], protocol::session("/workspace", &mcp, None));
    for frame in &frames[3..5] {
        assert_eq!(frame["params"], protocol::session("/workspace", &[], Some("saved")));
    }
    assert_eq!(frames[5]["params"], json!({"sessionId":"saved","configId":"autopilot","value":"on"}));
    assert_eq!(frames[6]["params"], json!({"sessionId":"saved","modeId":"default"}));
    assert_eq!(frames[8], protocol::notification_frame("session/cancel", Some(&protocol::cancel("saved"))));
    client.rpc().close().await;
}
async fn wait_prompt(client: &AcpClient) {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let value = client.rpc().request("fake/received", json!({})).await.unwrap();
            if value["received"].as_array().unwrap().iter().any(|f| f["method"] == "session/prompt") {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn cancel_prompt_and_kill_if_ignored() {
    for scenario in ["slow", "stubborn"] {
        let (client, _, _events) = AcpClient::connect(fake(scenario), "test").await.unwrap();
        let copy = client.clone();
        let prompt = tokio::spawn(async move { copy.prompt("session-1", &[]).await });
        wait_prompt(&client).await;
        assert!(matches!(client.prompt("session-1", &[]).await, Err(RpcError::PromptActive)));
        let result = client.cancel_and_wait("session-1", Duration::from_millis(80)).await;
        let ended = prompt.await.unwrap();
        if scenario == "slow" {
            assert!(result.is_ok());
            assert_eq!(ended.unwrap()["stopReason"], "cancelled");
        } else {
            assert!(matches!(result, Err(RpcError::Timeout { .. })));
            assert!(ended.is_err());
        }
        client.rpc().close().await;
    }
}
#[tokio::test]
async fn dropping_prompt_future_stops_the_process() {
    let (client, _, _events) = AcpClient::connect(fake("slow"), "test").await.unwrap();
    let copy = client.clone();
    let prompt = tokio::spawn(async move { copy.prompt("session-1", &[]).await });
    wait_prompt(&client).await;
    prompt.abort();
    let _ = prompt.await;
    tokio::time::timeout(Duration::from_secs(2), client.rpc().wait_exit()).await.unwrap();
}
#[cfg(unix)]
#[tokio::test]
async fn cancelled_initialize_kills_process_without_login_or_profile() {
    let temp = tempfile::tempdir().unwrap();
    let marker = temp.path().join("pid");
    let spec = fake("hang-init").env([("FAKE_SCENARIO", "hang-init".into()), ("FAKE_PID_FILE", marker.as_os_str().to_owned())]);
    let task = tokio::spawn(async move { AcpClient::connect(spec, "test").await });
    assert!(eventually(|| marker.exists(), Duration::from_secs(2)).await);
    let pid = std::fs::read_to_string(marker).unwrap().parse().unwrap();
    task.abort();
    let _ = task.await;
    assert!(eventually(|| !pid_alive(pid), Duration::from_secs(2)).await);
}
#[tokio::test]
async fn session_errors_do_not_trigger_login_retry_or_mcp_fallback() {
    let (client, _, _events) = AcpClient::connect(fake("logged-out"), "test").await.unwrap();
    let error = client.new_session("/workspace", &[json!({"name":"disabled","enabled":false})]).await.unwrap_err();
    assert!(matches!(error, RpcError::Server { code: -32000, .. }));
    let value = client.rpc().request("fake/received", json!({})).await.unwrap();
    let frames = value["received"].as_array().unwrap();
    assert_eq!(frames.iter().filter(|f| f["method"] == "session/new").count(), 1);
    assert!(!frames.iter().any(|f| f["method"] == "authenticate"));
    client.rpc().close().await;
}

fn normalize_paths(value: &mut Value, root: &str) {
    match value {
        Value::String(text) => {
            if let Some(rest) = text.strip_prefix(root) {
                *text = format!("/fixture{rest}");
            }
        }
        Value::Array(items) => {
            for item in items {
                normalize_paths(item, root);
            }
        }
        Value::Object(items) => {
            for item in items.values_mut() {
                normalize_paths(item, root);
            }
        }
        _ => {}
    }
}

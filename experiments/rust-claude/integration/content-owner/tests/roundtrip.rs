//! Actual ContentOwner over the native CLI's mcp_message lane. No network/provider/account access.
use milagre_claude::{
    handlers::BoxFuture,
    mcp::{DispatchError, InProcessMcp, McpDispatch, McpLimits, McpTool},
    CancelSignal, ClaudeClient, ClaudeEvent, Handlers, LaunchOptions, SessionOptions,
};
use milagre_content_store::{Error, SystemRuntime};
use milagre_owner_store::{Isolation, Policy};
use milagre_tools::{
    policy::{HostRole, PolicyOptions, WakeRequest},
    Caller, ContentOwner, DesignScope, Dispatcher,
};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

struct Job {
    frame: Vec<u8>,
    cancel: CancelSignal,
    done: tokio::sync::oneshot::Sender<Option<Vec<u8>>>,
}
/// Fixture owner worker: one thread, bounded mailbox, one existing Dispatcher. Not a provider store.
struct Worker {
    tx: Mutex<Option<std::sync::mpsc::SyncSender<Job>>>,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}
impl Worker {
    fn new(dispatcher: Arc<Dispatcher>) -> Arc<Self> {
        let (tx, rx) = std::sync::mpsc::sync_channel::<Job>(4);
        let thread = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
            while let Ok(mut job) = rx.recv() {
                if job.done.is_closed() || job.cancel.reason().is_some() {
                    continue;
                }
                let result = rt.block_on(async {
                    tokio::select! {biased; _=job.cancel.cancelled()=>None, response=dispatcher.dispatch(&job.frame)=>response}
                });
                let _ = job.done.send(result);
            }
        });
        Arc::new(Self { tx: Mutex::new(Some(tx)), thread: Mutex::new(Some(thread)) })
    }
    fn close(&self) {
        self.tx.lock().unwrap().take();
        if let Some(thread) = self.thread.lock().unwrap().take() {
            thread.join().unwrap();
        }
    }
}
impl McpDispatch for Worker {
    fn dispatch(&self, frame: Vec<u8>, cancel: CancelSignal) -> BoxFuture<Result<Option<Vec<u8>>, DispatchError>> {
        let (done, reply) = tokio::sync::oneshot::channel();
        let sent = self.tx.lock().unwrap().as_ref().is_some_and(|tx| tx.try_send(Job { frame, cancel, done }).is_ok());
        Box::pin(async move {
            if !sent {
                Err(DispatchError::Unavailable)
            } else {
                reply.await.map_err(|_| DispatchError::Unavailable)
            }
        })
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.close();
    }
}
fn caller(active: Arc<AtomicBool>) -> Caller {
    Caller {
        chat_id: "/fixture#1".into(),
        project_id: "/fixture".into(),
        roots: vec![],
        read: true,
        write: true,
        html: true,
        designs: true,
        kits: true,
        design_scope: DesignScope::All,
        bundled_skills: "/fixture/skills".into(),
        assert_active: Arc::new(move || if active.load(Ordering::SeqCst) { Ok(()) } else { Err(Error::new("Fixture caller revoked")) }),
    }
}
fn owner(path: &Path) -> Arc<ContentOwner> {
    ContentOwner::open(
        Isolation::create(path, &Policy::default()).unwrap(),
        "artifacts".into(),
        "kits".into(),
        Arc::new(|chat| if chat == "/fixture#1" { Ok("/fixture".into()) } else { Err(Error::new("Chat not admitted")) }),
        Arc::new(|| Ok(())),
        Arc::new(SystemRuntime),
        None,
    )
    .unwrap()
}
fn rpc(id: i32, method: &str, params: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})
}
fn send(id: &str, body: Value) -> Value {
    json!({"request":{"id":id,"request":{"subtype":"mcp_message","server_name":"milagre","message":body}}})
}
fn expect() -> Value {
    json!({"expect":{"type":"control_response","echo":true}})
}
fn options(temp: &Path, script: Vec<Value>) -> SessionOptions {
    let path = temp.join("fake.json");
    std::fs::write(&path, serde_json::to_vec(&script).unwrap()).unwrap();
    let mut launch = LaunchOptions::new(std::env::var_os("MILAGRE_FAKE_CLAUDE").expect("build fake-claude and set MILAGRE_FAKE_CLAUDE"));
    launch.cwd = Some(temp.into());
    launch.env = Some(vec![("FAKE_CLAUDE_SCRIPT".into(), path.into_os_string())]);
    let mut options = SessionOptions::new(launch);
    options.limits.close_grace = Duration::from_millis(100);
    options.limits.kill_grace = Duration::from_millis(100);
    options
}
async fn reply(events: &mut milagre_claude::EventStream) -> Value {
    loop {
        match tokio::time::timeout(Duration::from_secs(5), events.recv()).await.unwrap() {
            Some(ClaudeEvent::Message(v)) if v["type"] == "fake_received" => {
                return v["frame"]["response"]["response"]["mcp_response"].clone()
            }
            Some(ClaudeEvent::Diagnostic(_)) => {}
            other => panic!("expected reply, got {other:?}"),
        }
    }
}
fn manifest(dispatcher: &Dispatcher) -> Vec<McpTool> {
    dispatcher.provider_manifest().into_iter().map(|t| McpTool { name: t.name, read_only: t.read_only }).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn initialize_list_call_errors_and_shared_renderer_use_one_owner() {
    let temp = tempfile::tempdir().unwrap();
    let owner = owner(temp.path());
    let active = Arc::new(AtomicBool::new(true));
    let dispatcher = Arc::new(owner.session(caller(active)).unwrap());
    let worker = Worker::new(dispatcher.clone());
    let registry = InProcessMcp::new();
    let registration = registry.register("milagre", manifest(&dispatcher), worker.clone(), McpLimits::default()).unwrap();
    let mut script = vec![json!({"expect":{"subtype":"initialize","fields":{"/request/sdkMcpServers":["milagre"]},"as":"cli-init"}})];
    for (id, body) in [
        ("init", rpc(1, "initialize", json!({"protocolVersion":"2025-03-26","capabilities":{}}))),
        ("notify", json!({"jsonrpc":"2.0","method":"notifications/initialized"})),
        ("list", rpc(2, "tools/list", json!({}))),
        ("show", rpc(3, "tools/call", json!({"name":"artifact_show","arguments":{"id":"artifact","title":"Shared","html":"<p>one owner</p>"}}))),
        ("read", rpc(4, "tools/call", json!({"name":"artifact_read","arguments":{"id":"artifact"}}))),
        ("bad-tool", rpc(5, "tools/call", json!({"name":"unavailable","arguments":{}}))),
        ("bad-method", rpc(6, "missing/method", json!({}))),
        ("bad-args", rpc(7, "tools/call", json!({"name":"artifact_show","arguments":{"title":1}}))),
        ("invalid", json!({"jsonrpc":"1.0","id":8,"method":"tools/list"})),
    ] {
        script.extend([send(id, body), expect()]);
    }
    script.push(json!({"reply_to":{"name":"cli-init","payload":{}}}));
    let mut config = options(temp.path(), script);
    registration.attach(&mut config).unwrap();
    assert!(!config.launch.allowed_tools.contains(&"mcp__milagre__artifact_show".into()));
    let (client, mut events) =
        ClaudeClient::spawn(&config.launch, Handlers { mcp: config.mcp.clone(), ..Default::default() }, config.limits.clone()).unwrap();
    let init = {
        let client = client.clone();
        tokio::spawn(async move { client.initialize(&config.init).await })
    };
    assert_eq!(reply(&mut events).await["result"]["protocolVersion"], "2025-03-26");
    assert_eq!(reply(&mut events).await, json!({"jsonrpc":"2.0","result":{}}));
    let listed = reply(&mut events).await;
    let actual = listed["result"]["tools"].as_array().unwrap();
    assert_eq!(actual.len(), 14);
    for tool in actual {
        let name = tool["name"].as_str().unwrap();
        let expected = dispatcher.provider_manifest().into_iter().find(|t| t.name == name).unwrap();
        assert_eq!(tool["annotations"]["readOnlyHint"], expected.read_only);
        assert_eq!(tool["_meta"]["anthropic/alwaysLoad"], true);
    }
    let saved = reply(&mut events).await;
    assert_eq!(saved["result"]["isError"], false, "{saved}");
    let read = reply(&mut events).await;
    assert_eq!(read["result"]["isError"], false, "{read}");
    assert!(read.to_string().contains("one owner"));
    assert_eq!(reply(&mut events).await["result"]["isError"], true);
    assert_eq!(reply(&mut events).await["error"]["code"], -32601);
    assert_eq!(reply(&mut events).await["result"]["isError"], true);
    assert_eq!(reply(&mut events).await["error"]["code"], -32600);
    init.await.unwrap().unwrap();
    // Independent owner read sees the MCP commit; no second store is opened.
    let scope = owner.renderer_scope("/fixture#1", "/fixture", Arc::new(|| Ok(()))).unwrap();
    let read = owner.renderer(&scope, "artifact:get", &json!({"chatId":"/fixture#1","id":"artifact"})).unwrap();
    assert_eq!(read["title"], "Shared");
    assert_eq!(read["version"], 1);
    assert_eq!(client.close().await.code, Some(0));
    worker.close();
    owner.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn host_revocation_and_shutdown_are_checked_on_every_call() {
    let temp = tempfile::tempdir().unwrap();
    let owner = owner(temp.path());
    let active = Arc::new(AtomicBool::new(true));
    let dispatcher = Arc::new(owner.session(caller(active.clone())).unwrap());
    let worker = Worker::new(dispatcher.clone());
    let registry = InProcessMcp::new();
    let registration = registry.register("milagre", manifest(&dispatcher), worker.clone(), McpLimits::default()).unwrap();
    let script = vec![
        send("one", rpc(1, "tools/list", json!({}))),
        expect(),
        json!({"expect":{"type":"user"}}),
        send("two", rpc(2, "tools/list", json!({}))),
        expect(),
        json!({"expect":{"type":"user"}}),
        send("three", rpc(3, "tools/call", json!({"name":"artifact_list","arguments":{}}))),
        expect(),
    ];
    let mut config = options(temp.path(), script);
    registration.attach(&mut config).unwrap();
    let (client, mut events) =
        ClaudeClient::spawn(&config.launch, Handlers { mcp: config.mcp, ..Default::default() }, config.limits).unwrap();
    assert!(reply(&mut events).await["result"]["tools"].is_array());
    active.store(false, Ordering::SeqCst);
    client.send_user_text("fixture barrier").await.unwrap();
    assert_eq!(reply(&mut events).await["error"]["code"], -32000);
    owner.shutdown();
    client.send_user_text("fixture barrier").await.unwrap();
    assert_eq!(reply(&mut events).await["error"]["code"], -32000);
    assert_eq!(client.close().await.code, Some(0));
    worker.close();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn host_role_manifest_and_budget_survive_provider_control_transport() {
    let temp = tempfile::tempdir().unwrap();
    let owner = owner(temp.path());
    let stops = Arc::new(AtomicUsize::new(0));
    let dispatcher = Arc::new(
        owner
            .session_with_policy(
                caller(Arc::new(AtomicBool::new(true))),
                PolicyOptions {
                    role: HostRole::Escalation {
                        wake_id: "fixture-wake".into(),
                        requests: vec![WakeRequest { chat_id: "/child#2".into(), request_id: "q1".into() }],
                    },
                    manifest: None,
                    on_sealed: Some(Arc::new({
                        let stops = stops.clone();
                        move || {
                            stops.fetch_add(1, Ordering::SeqCst);
                        }
                    })),
                },
            )
            .unwrap(),
    );
    let worker = Worker::new(dispatcher.clone());
    let registry = InProcessMcp::new();
    let registration = registry.register("milagre", manifest(&dispatcher), worker.clone(), McpLimits::default()).unwrap();
    let mut script = vec![send("list", rpc(0, "tools/list", json!({}))), expect()];
    for i in 1..=9 {
        script.extend([
            send(&format!("call{i}"), rpc(i, "tools/call", json!({"name":if i==1{"artifact_show"}else{"artifact_list"},"arguments":{}}))),
            expect(),
        ]);
    }
    let mut config = options(temp.path(), script);
    registration.attach(&mut config).unwrap();
    assert!(registration.provider_manifest().iter().all(|t| t.read_only));
    let (client, mut events) =
        ClaudeClient::spawn(&config.launch, Handlers { mcp: config.mcp, ..Default::default() }, config.limits).unwrap();
    assert_eq!(reply(&mut events).await["result"]["tools"].as_array().unwrap().len(), 9);
    for i in 1..=9 {
        let reply = reply(&mut events).await;
        assert_eq!(reply["result"]["isError"], i == 1 || i >= 7, "{i}: {reply}");
    }
    assert_eq!(dispatcher.budget_status().attempts, 9);
    assert!(dispatcher.budget_status().sealed);
    assert_eq!(stops.load(Ordering::SeqCst), 1);
    assert_eq!(client.close().await.code, Some(0));
    worker.close();
    owner.shutdown();
    // Host read-only enforcement does NOT imply native Claude advisor startup is safe.
    let mut config = options(temp.path(), vec![]);
    config.analysis_only = true;
    let (session, _events) = milagre_claude::ClaudeSession::new(config);
    assert!(matches!(
        session.start_turn(milagre_claude::TurnRequest::default()).await,
        Err(milagre_claude::SessionError::UnsupportedAnalysis)
    ));
    assert!(session.pid().is_none());
}

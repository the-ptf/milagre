//! Actual ContentOwner over the native CLI's mcp_message lane. No network/provider/account access.
use milagre_claude::{
    handlers::BoxFuture,
    mcp::{DispatchError, InProcessMcp, McpDispatch, McpLimits, McpTool},
    CancelSignal, ClaudeClient, ClaudeEvent, Handlers, LaunchOptions, SessionOptions,
};
use milagre_content_store::{Error, SystemRuntime};
use milagre_owner_store::{Isolation, Policy};
use milagre_tools::{
    policy::{PolicyOptions, WakeRequest},
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
        (
            "show",
            rpc(3, "tools/call", json!({"name":"artifact_show","arguments":{"id":"artifact","title":"Shared","html":"<p>one owner</p>"}})),
        ),
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
    let caller = caller(Arc::new(AtomicBool::new(true)));
    let wake = owner.issue_wake(&caller, vec![WakeRequest { chat_id: "/child#2".into(), request_id: "q1".into() }]).unwrap();
    let dispatcher = Arc::new(
        owner
            .session_with_policy(
                caller,
                PolicyOptions::escalation(
                    wake.clone(),
                    Arc::new({
                        let stops = stops.clone();
                        move || {
                            stops.fetch_add(1, Ordering::SeqCst);
                        }
                    }),
                ),
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
    script.extend([json!({"expect":{"type":"user"}}), send("released", rpc(10, "tools/list", json!({}))), expect()]);
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
    wake.release();
    client.send_user_text("fixture barrier").await.unwrap();
    assert_eq!(reply(&mut events).await["error"]["code"], -32000);
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

struct Observed(milagre_tools::CallReceipt);
fn delivery(status: milagre_tools::CallStatus) -> milagre_claude::mcp::DeliveryState {
    use milagre_claude::mcp::DeliveryState;
    match status.mutation {
        milagre_tools::MutationOutcome::NotAttempted => DeliveryState::NotAttempted,
        milagre_tools::MutationOutcome::Committed => DeliveryState::Committed,
        milagre_tools::MutationOutcome::Uncertain => DeliveryState::Uncertain,
    }
}
impl milagre_claude::mcp::DispatchReceipt for Observed {
    fn cancel(&self) -> milagre_claude::mcp::DeliveryState {
        delivery(self.0.cancel())
    }
    fn status(&self) -> milagre_claude::mcp::DeliveryState {
        delivery(self.0.status())
    }
}
/// Fixture adapter for the existing owner-issued AcceptedCall. No store or replay in the provider.
struct ReceiptDispatch {
    dispatcher: Arc<Dispatcher>,
    observed: Arc<Mutex<Option<milagre_tools::CallReceipt>>>,
    hold_completed_reply: bool,
    calls: Arc<AtomicUsize>,
}
impl McpDispatch for ReceiptDispatch {
    fn dispatch(&self, frame: Vec<u8>, cancel: CancelSignal) -> BoxFuture<Result<Option<Vec<u8>>, DispatchError>> {
        self.start(frame, cancel).response
    }
    fn start(&self, frame: Vec<u8>, _: CancelSignal) -> milagre_claude::mcp::DispatchCall {
        use milagre_claude::mcp::DispatchCall;
        use milagre_owner_store::jsjson;
        let request = jsjson::parse_bytes(&frame).unwrap();
        let call = self.dispatcher.start_call(request["params"]["name"].as_str().unwrap(), &request["params"]["arguments"]).unwrap();
        self.calls.fetch_add(1, Ordering::SeqCst);
        let receipt = call.receipt();
        *self.observed.lock().unwrap() = Some(receipt.clone());
        let hold = self.hold_completed_reply;
        DispatchCall {
            receipt: Some(Arc::new(Observed(receipt))),
            response: Box::pin(async move {
                let result = call.wait().await;
                if hold {
                    std::future::pending::<()>().await;
                }
                Ok(Some(jsjson::to_string(&json!({"jsonrpc":"2.0","id":request["id"],"result":result})).into_bytes()))
            }),
        }
    }
}
fn external_schema(name: &str, read: bool) -> Value {
    json!({"name":name,"description":"Isolated fixture only","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"annotations":{"readOnlyHint":read}})
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stored_utf16_surrogates_real_noncharacters_and_pua_survive_raw_cli_reply() {
    use milagre_owner_store::jsjson;
    let temp = tempfile::tempdir().unwrap();
    let owner = owner(temp.path());
    let scoped = caller(Arc::new(AtomicBool::new(true)));
    let original_units = [0xd800, 0x61, 0xdfff, 0xdbff, 0xdffe, 0xe000, 0xf8ff]; // lone high/low, real U+10FFFE, PUA
    let title = jsjson::from_utf16(&original_units);
    let seed = owner.session(scoped.clone()).unwrap();
    let saved = seed.call("artifact_show", &json!({"id":"unicode","title":title,"html":"<p>fixture</p>"})).await;
    assert_eq!(saved["isError"], false, "{saved}");
    let scope = owner.renderer_scope("/fixture#1", "/fixture", Arc::new(|| Ok(()))).unwrap();
    let stored = owner.renderer(&scope, "artifact:get", &json!({"chatId":"/fixture#1","id":"unicode"})).unwrap();
    assert_eq!(jsjson::to_utf16(stored["title"].as_str().unwrap()), original_units);
    // A trusted read endpoint returns the actual stored title as text, not nested JSON-as-text.
    let read_owner = owner.clone();
    let tool = milagre_tools::RegisteredTool::new(
        external_schema("fixture_title", true),
        milagre_tools::ToolEffect::Read,
        Arc::new(move |context, _| {
            context.assert_active()?;
            let stored = read_owner.renderer(&scope, "artifact:get", &json!({"chatId":"/fixture#1","id":"unicode"}))?;
            Ok(json!({"content":[{"type":"text","text":stored["title"]}],"isError":false}))
        }),
    )
    .unwrap();
    let dispatcher = Arc::new(owner.host_session(scoped, PolicyOptions::default(), vec![tool]).unwrap());
    let body = rpc(17, "tools/call", json!({"name":"fixture_title","arguments":{}}));
    let expected = dispatcher.dispatch(&serde_json::to_vec(&body).unwrap()).await.unwrap();
    assert!(serde_json::from_slice::<Value>(&expected).is_err(), "fixture must exercise actual lone surrogates");
    let decoded = jsjson::parse_bytes(&expected).unwrap();
    assert_eq!(jsjson::to_utf16(decoded["result"]["content"][0]["text"].as_str().unwrap()), original_units);
    let worker = Worker::new(dispatcher.clone());
    let registry = InProcessMcp::new();
    let registration = registry.register("milagre", manifest(&dispatcher), worker.clone(), McpLimits::default()).unwrap();
    let mut config = options(temp.path(), vec![send("unicode", body), json!({"expect_raw_mcp":String::from_utf8(expected).unwrap()})]);
    registration.attach(&mut config).unwrap();
    let (client, mut events) =
        ClaudeClient::spawn(&config.launch, Handlers { mcp: config.mcp, ..Default::default() }, config.limits).unwrap();
    loop {
        match events.recv().await {
            Some(ClaudeEvent::Message(v)) if v["type"] == "raw_mcp_verified" => break,
            Some(ClaudeEvent::Diagnostic(_)) => {}
            other => panic!("{other:?}"),
        }
    }
    assert_eq!(client.close().await.code, Some(0));
    worker.close();
    owner.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn timed_out_committed_artifact_reports_receipt_without_replay() {
    let temp = tempfile::tempdir().unwrap();
    let owner = owner(temp.path());
    let dispatcher = Arc::new(owner.session(caller(Arc::new(AtomicBool::new(true)))).unwrap());
    let observed = Arc::new(Mutex::new(None));
    let calls = Arc::new(AtomicUsize::new(0));
    let callback = Arc::new(ReceiptDispatch {
        dispatcher: dispatcher.clone(),
        observed: observed.clone(),
        hold_completed_reply: true,
        calls: calls.clone(),
    });
    let registry = InProcessMcp::new();
    let registration = registry
        .register("milagre", manifest(&dispatcher), callback, McpLimits { timeout: Duration::from_millis(300), ..Default::default() })
        .unwrap();
    let mut config = options(
        temp.path(),
        vec![
            send(
                "write",
                rpc(
                    1,
                    "tools/call",
                    json!({"name":"artifact_show","arguments":{"id":"once","title":"Committed once","html":"<p>saved</p>"}}),
                ),
            ),
            expect(),
        ],
    );
    registration.attach(&mut config).unwrap();
    let (client, mut events) =
        ClaudeClient::spawn(&config.launch, Handlers { mcp: config.mcp, ..Default::default() }, config.limits).unwrap();
    let failed = reply(&mut events).await;
    assert_eq!(failed["error"]["data"], json!({"delivery":"committed","retry":"never_automatically"}));
    assert_eq!(observed.lock().unwrap().as_ref().unwrap().status().mutation, milagre_tools::MutationOutcome::Committed);
    let scope = owner.renderer_scope("/fixture#1", "/fixture", Arc::new(|| Ok(()))).unwrap();
    assert_eq!(owner.renderer(&scope, "artifact:get", &json!({"chatId":"/fixture#1","id":"once"})).unwrap()["version"], 1);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(client.close().await.code, Some(0));
    owner.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn late_external_commit_evidence_does_not_rewrite_uncertain_delivery() {
    let temp = tempfile::tempdir().unwrap();
    let owner = owner(temp.path());
    let evidence = temp.path().join("external-write");
    let written = evidence.clone();
    let release = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
    let _release_on_failure = ReleaseWorker(release.clone());
    let waiting = release.clone();
    let tool = milagre_tools::RegisteredTool::new(
        external_schema("fixture_write", false),
        milagre_tools::ToolEffect::Write,
        Arc::new(move |context, _| {
            context.assert_active()?;
            std::fs::write(&written, b"once").map_err(|_| Error::new("Fixture write failed"))?;
            context.confirm_committed()?;
            let (lock, wake) = &*waiting;
            let mut ready = lock.lock().unwrap();
            while !*ready {
                ready = wake.wait(ready).unwrap();
            }
            Ok(json!({"content":[],"isError":false}))
        }),
    )
    .unwrap();
    let dispatcher = Arc::new(owner.host_session(caller(Arc::new(AtomicBool::new(true))), PolicyOptions::default(), vec![tool]).unwrap());
    let observed = Arc::new(Mutex::new(None));
    let calls = Arc::new(AtomicUsize::new(0));
    let callback = Arc::new(ReceiptDispatch {
        dispatcher: dispatcher.clone(),
        observed: observed.clone(),
        hold_completed_reply: false,
        calls: calls.clone(),
    });
    let registry = InProcessMcp::new();
    let registration = registry
        .register("milagre", manifest(&dispatcher), callback, McpLimits { timeout: Duration::from_millis(300), ..Default::default() })
        .unwrap();
    let mut config =
        options(temp.path(), vec![send("write", rpc(1, "tools/call", json!({"name":"fixture_write","arguments":{}}))), expect()]);
    registration.attach(&mut config).unwrap();
    let (client, mut events) =
        ClaudeClient::spawn(&config.launch, Handlers { mcp: config.mcp, ..Default::default() }, config.limits).unwrap();
    let failed = reply(&mut events).await;
    // Always release the owner worker before assertions, including on failure.
    *release.0.lock().unwrap() = true;
    release.1.notify_one();
    assert_eq!(failed["error"]["data"], json!({"delivery":"uncertain","retry":"never_automatically"}));
    let receipt = observed.lock().unwrap().as_ref().unwrap().clone();
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if receipt.status().external == milagre_tools::ExternalCompletion::Finished(milagre_tools::MutationOutcome::Committed) {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(receipt.status().mutation, milagre_tools::MutationOutcome::Uncertain);
    assert_eq!(std::fs::read(evidence).unwrap(), b"once");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(client.close().await.code, Some(0));
    owner.shutdown();
}

struct ReleaseWorker(Arc<(Mutex<bool>, std::sync::Condvar)>);
impl Drop for ReleaseWorker {
    fn drop(&mut self) {
        *self.0 .0.lock().unwrap() = true;
        self.0 .1.notify_all();
    }
}
#[test]
fn queued_accepted_call_cancelled_before_storage_reports_not_attempted() {
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).max_blocking_threads(1).enable_all().build().unwrap();
    runtime.block_on(async {
        let gate = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
        let release = ReleaseWorker(gate.clone());
        let (entered, ready) = tokio::sync::oneshot::channel();
        let blocker = tokio::task::spawn_blocking(move || {
            entered.send(()).unwrap();
            let mut open = gate.0.lock().unwrap();
            while !*open {
                open = gate.1.wait(open).unwrap();
            }
        });
        ready.await.unwrap();
        let temp = tempfile::tempdir().unwrap();
        let owner = owner(temp.path());
        let dispatcher = Arc::new(owner.session(caller(Arc::new(AtomicBool::new(true)))).unwrap());
        let observed = Arc::new(Mutex::new(None));
        let calls = Arc::new(AtomicUsize::new(0));
        let callback = Arc::new(ReceiptDispatch {
            dispatcher: dispatcher.clone(),
            observed: observed.clone(),
            hold_completed_reply: false,
            calls: calls.clone(),
        });
        let registry = InProcessMcp::new();
        let registration = registry
            .register("milagre", manifest(&dispatcher), callback, McpLimits { timeout: Duration::from_millis(100), ..Default::default() })
            .unwrap();
        let mut config = options(
            temp.path(),
            vec![
                send(
                    "queued",
                    rpc(1, "tools/call", json!({"name":"artifact_show","arguments":{"id":"never","title":"Never","html":"<p>never</p>"}})),
                ),
                expect(),
            ],
        );
        registration.attach(&mut config).unwrap();
        let (client, mut events) =
            ClaudeClient::spawn(&config.launch, Handlers { mcp: config.mcp, ..Default::default() }, config.limits).unwrap();
        let failed = reply(&mut events).await;
        drop(release);
        blocker.await.unwrap();
        assert_eq!(failed["error"]["data"], json!({"delivery":"not_attempted","retry":"never_automatically"}));
        let receipt = observed.lock().unwrap().as_ref().unwrap().clone();
        assert_eq!(receipt.status().phase, milagre_tools::CallPhase::CancelledBeforeStart);
        assert_eq!(receipt.status().mutation, milagre_tools::MutationOutcome::NotAttempted);
        let scope = owner.renderer_scope("/fixture#1", "/fixture", Arc::new(|| Ok(()))).unwrap();
        assert_eq!(owner.renderer(&scope, "artifact:list", &json!({"chatId":"/fixture#1"})).unwrap(), json!([]));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(client.close().await.code, Some(0));
        owner.shutdown();
    });
}

#[tokio::test]
async fn compact_child_settlement_preserves_long_title_and_rows_in_actual_owner_reducer() {
    use milagre_claude::{ClaudeSession, TurnRequest};
    use milagre_owner_store::{agent_runs, message_store::ProjectState};
    let temp = tempfile::tempdir().unwrap();
    let title = "Review 😀 ".repeat(100);
    let launch = json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"child","name":"Agent","input":{"description":title,"run_in_background":true}}]}});
    let row = json!({"type":"user","parent_tool_use_id":"child","message":{"content":[{"type":"tool_result","tool_use_id":"read","content":"retained child output"}]}});
    let mut opts = options(
        temp.path(),
        vec![
            json!({"expect":{"subtype":"initialize"}}),
            json!({"reply":{}}),
            json!({"expect":{"subtype":"set_max_thinking_tokens"}}),
            json!({"reply":{}}),
            json!({"expect":{"type":"user"}}),
            json!({"emit":launch}),
            json!({"emit":row}),
            json!({"wait_eof":true}),
        ],
    );
    opts.clock = Some(Arc::new(|| 1000));
    let (session, mut events) = ClaudeSession::new(opts);
    session
        .start_turn(TurnRequest { model: "sonnet".into(), content: vec![json!({"type":"text","text":"fixture"})], ..Default::default() })
        .await
        .unwrap();
    let initial = ProjectState::from_value(&json!({"sessions":{"1":{"id":1}},"messages":[]}));
    let runs = serde_json::Map::new();
    let reduce =
        |state: &ProjectState, event: &Value| agent_runs::apply_agent_event(state, &runs, "/fixture", "/fixture#1", event, 1000).unwrap().0;
    let mut state = initial;
    let mut full = milagre_claude::subagents::Subagents::default();
    full.map(&launch, 1000);
    full.map(&row, 1000);
    loop {
        let event = tokio::time::timeout(Duration::from_secs(3), events.recv()).await.unwrap().unwrap();
        if event["type"] == "subagent-update" {
            state = reduce(&state, &event);
            if !event["agent"]["transcript"].as_array().unwrap().is_empty() {
                break;
            }
        }
    }
    let expected = reduce(&state, &full.settle("cancelled", 1000)[0]);
    session.close().await;
    let mut compact_seen = false;
    while let Some(event) = events.recv().await {
        if event["type"] == "subagent-update" {
            assert_eq!(event["agent"]["transcript"], json!([]));
            assert_eq!(event["agent"]["title"], "Subagent");
            state = reduce(&state, &event);
            compact_seen = true;
        }
    }
    assert!(compact_seen);
    assert_eq!(state.to_value(), expected.to_value());
    let state = state.to_value();
    let child = &state["sessions"]["1"]["subagents"][0];
    assert_eq!(child["title"], title);
    assert_eq!(child["transcript"][0]["text"], "retained child output");
    assert_eq!(child["status"], "cancelled");
}

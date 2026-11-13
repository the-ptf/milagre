//! CP4a: real profile socket and persistence with explicitly injected synthetic providers.
#![cfg(feature = "chat-fixture")]

use milagre_owner_store::{chat_host::MockProvider, Isolation};
use milagre_profile_owner::{policy::owner_policy, start, start_with_providers, Options, Owner};
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant},
};

struct Copy {
    _temp: tempfile::TempDir,
    root: PathBuf,
    options: Options,
    projects: Vec<PathBuf>,
}
impl Copy {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap().join("copy");
        Isolation::create(&root, &owner_policy()).unwrap();
        let data_dir = root.join("profile");
        fs::create_dir(&data_dir).unwrap();
        let projects: Vec<_> = ["alpha", "beta", "empty"]
            .iter()
            .map(|p| root.join(p))
            .collect();
        for (i, project) in projects.iter().enumerate() {
            fs::create_dir(project).unwrap();
            if i == 2 {
                continue;
            }
            fs::create_dir(project.join(".milagre")).unwrap();
            fs::write(project.join(".milagre/coordination.json"), serde_json::to_vec(&json!({
                "next_id":10,
                "worktrees":{"1":{"id":1,"path":project,"name":project.file_name().unwrap().to_str().unwrap()}},
                "sessions":{"1":{"id":1,"worktree_id":1}},
                "messages":[]
            })).unwrap()).unwrap();
        }
        let recent: Vec<_> = projects.iter().map(|p| json!({"path":p,"name":p.file_name().unwrap().to_str().unwrap(),"openedAt":"2026-11-12T00:00:00.000Z"})).collect();
        fs::write(
            data_dir.join("recent-projects.json"),
            serde_json::to_vec(&recent).unwrap(),
        )
        .unwrap();
        Self {
            _temp: temp,
            options: Options {
                data_dir,
                app_version: "cp4-test".into(),
                chats_home: Some(root.join("chats")),
                worktree_root: Some(root.join("worktrees")),
                cwd: None,
            },
            root,
            projects,
        }
    }
    fn start(&self, providers: &[MockProvider]) -> Owner {
        start_with_providers(
            &self.options,
            providers
                .iter()
                .map(|p| Box::new(p.clone()) as Box<dyn milagre_owner_store::chat_host::Provider>)
                .collect(),
        )
        .unwrap()
    }
}
struct Client {
    socket: UnixStream,
    reader: BufReader<UnixStream>,
    next: u64,
    events: Vec<Value>,
}
impl Client {
    fn new(owner: &Owner) -> Self {
        let socket = UnixStream::connect(owner.server.socket_path()).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        Self {
            reader: BufReader::new(socket.try_clone().unwrap()),
            socket,
            next: 0,
            events: vec![],
        }
    }
    fn request(&mut self, method: &str, args: Value) -> Value {
        self.next += 1;
        writeln!(
            self.socket,
            "{}",
            json!({"v":1,"id":self.next,"method":method,"args":args})
        )
        .unwrap();
        loop {
            let mut line = String::new();
            assert!(
                self.reader.read_line(&mut line).unwrap() > 0,
                "socket closed during {method}"
            );
            let value: Value = serde_json::from_str(&line).unwrap();
            if value.get("event").is_some() {
                self.events.push(value["event"].clone());
                continue;
            }
            assert_eq!(value["id"], self.next);
            return value;
        }
    }
    fn call(&mut self, method: &str, args: Value) -> Value {
        let reply = self.request(method, args);
        assert!(reply.get("error").is_none(), "{method}: {reply}");
        reply["result"].clone()
    }
    fn wait(&mut self, mut check: impl FnMut(&mut Self) -> bool) {
        let until = Instant::now() + Duration::from_secs(10);
        while !check(self) {
            assert!(Instant::now() < until, "condition never became true");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}
fn send(project: &Path, provider: &str, model: &str, body: &str, id: &str) -> Value {
    json!([{"projectPath":project,"sessionId":1,"provider":provider,"model":model,"body":body,"clientMessageId":id}])
}
fn stop(owner: Owner, mut client: Client) {
    assert_eq!(
        client.call("daemon:stop", json!([])),
        json!({"stopping":true})
    );
    drop(client);
    owner.finish().unwrap();
}
fn node_state(project: &Path, root: &Path) -> Value {
    let output=Command::new("node").arg("-e").arg("const {readProjectState}=require(process.argv[1]);readProjectState(process.argv[2]).then(v=>process.stdout.write(JSON.stringify(v))).catch(e=>{console.error(e);process.exitCode=1})")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/core/src/project-store.cjs"))
        .arg(project).env("HOME",root).env_remove("ELECTRON_RUN_AS_NODE").env_remove("MILAGRE_DATA_DIR").output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn multi_project_provider_model_stream_queue_persistence_and_node_rollback() {
    let copy = Copy::new();
    let claude = MockProvider::new("claude");
    let codex = MockProvider::new("codex");
    let owner = copy.start(&[claude.clone(), codex.clone()]);
    let mut client = Client::new(&owner);
    let a = &copy.projects[0];
    let b = &copy.projects[1];
    for p in [a, b] {
        client.call("project:read", json!([p,{"state":true}]));
    }
    let a_chat = format!("{}#1", a.display());
    let b_chat = format!("{}#1", b.display());
    assert_eq!(
        client.call(
            "chat:send",
            send(a, "claude", "model-a", "alpha question", "a-1")
        ),
        json!({"sessionId":1})
    );
    assert_eq!(
        client.call(
            "chat:send",
            send(b, "codex", "model-b", "beta question", "b-1")
        ),
        json!({"sessionId":1})
    );
    assert_eq!(claude.state.lock().unwrap().turns.len(), 1);
    assert_eq!(codex.state.lock().unwrap().turns.len(), 1);
    assert_eq!(claude.state.lock().unwrap().turns[0]["model"], "model-a");
    assert_eq!(codex.state.lock().unwrap().turns[0]["model"], "model-b");
    assert_eq!(claude.state.lock().unwrap().turns[0]["chatId"], a_chat);
    assert_eq!(codex.state.lock().unwrap().turns[0]["chatId"], b_chat);
    // Duplicate acknowledgement cannot launch again or append twice.
    client.call(
        "chat:send",
        send(a, "claude", "model-a", "alpha question", "a-1"),
    );
    assert_eq!(claude.state.lock().unwrap().turns.len(), 1);
    let mut queued = send(a, "claude", "model-a", "queued then removed", "a-2");
    queued[0]["delivery"] = json!("queue");
    client.call("chat:send", queued);
    let state = client.call("state:read", json!([a]));
    let queue_id = state["state"]["sessions"]["1"]["queued"][0]["id"].clone();
    assert!(queue_id.is_string(), "{state}");
    assert_eq!(
        client.call("chat:queue-remove", json!([a_chat, queue_id])),
        true
    );
    claude.emit(&a_chat, json!({"type":"text-delta","text":"alpha answer"}));
    codex.emit(&b_chat, json!({"type":"text-delta","text":"beta answer"}));
    claude.emit(&a_chat, json!({"type":"turn-completed"}));
    codex.emit(&b_chat, json!({"type":"turn-completed"}));
    client.wait(|c| {
        c.call("chat:runs", json!([]))["runs"]
            .as_object()
            .is_some_and(|r| r.is_empty())
    });
    let a_state = client.call("state:read", json!([a]));
    let b_state = client.call("state:read", json!([b]));
    for (state, answer, foreign) in [
        (&a_state, "alpha answer", "beta answer"),
        (&b_state, "beta answer", "alpha answer"),
    ] {
        assert!(
            state["state"]["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|m| m["body"] == answer),
            "{state}"
        );
        assert!(!state.to_string().contains(foreign));
    }
    assert!(
        client
            .events
            .iter()
            .any(|e| e.to_string().contains("alpha answer")),
        "no alpha stream event: {:?}",
        client.events
    );
    assert!(
        client
            .events
            .iter()
            .any(|e| e.to_string().contains("beta answer")),
        "no beta stream event"
    );
    stop(owner, client);
    assert!(claude.state.lock().unwrap().shut_down);
    assert!(codex.state.lock().unwrap().shut_down);
    for (p, expected) in [(a, &a_state), (b, &b_state)] {
        assert!(!p.join(".milagre/runtime.lock").exists());
        let reopened = node_state(p, &copy.root);
        assert_eq!(
            reopened["messages"], expected["state"]["messages"],
            "Node rollback messages"
        );
        assert_eq!(
            reopened["sessions"], expected["state"]["sessions"],
            "Node rollback sessions"
        );
    }
    let rollback = Command::new("node")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/chat-node-rollback.cjs"
        ))
        .arg(&copy.root)
        .env_remove("ELECTRON_RUN_AS_NODE")
        .output()
        .unwrap();
    assert!(
        rollback.status.success(),
        "{}",
        String::from_utf8_lossy(&rollback.stderr)
    );
    let states: Vec<Value> = serde_json::from_slice(&rollback.stdout).unwrap();
    for (actual, expected) in states.iter().zip([&a_state, &b_state]) {
        assert_eq!(
            actual["messages"], expected["state"]["messages"],
            "Node daemon rollback messages"
        );
        assert_eq!(
            actual["sessions"], expected["state"]["sessions"],
            "Node daemon rollback sessions"
        );
    }
    let reopened = start(&copy.options).unwrap();
    let mut client = Client::new(&reopened);
    assert_eq!(
        client.call("project:read", json!([a]))["state"]["messages"],
        a_state["state"]["messages"]
    );
    stop(reopened, client);
}

#[test]
fn fresh_project_send_and_active_shutdown_save_and_release() {
    let copy = Copy::new();
    let provider = MockProvider::new("claude");
    let owner = copy.start(std::slice::from_ref(&provider));
    let mut client = Client::new(&owner);
    let p = &copy.projects[2];
    let opened = client.call("project:read", json!([p]));
    let id = opened["state"]["sessions"]
        .as_object()
        .unwrap()
        .values()
        .next()
        .unwrap()["id"]
        .clone();
    let mut request = send(p, "claude", "fresh-model", "fresh send", "fresh");
    request[0]["sessionId"] = id.clone();
    client.call("chat:send", request);
    let chat = format!("{}#{}", p.display(), id);
    provider.emit(&chat, json!({"type":"text-delta","text":"partial answer"}));
    client.wait(|c| {
        c.call("chat:runs", json!([]))
            .to_string()
            .contains("partial answer")
    });
    stop(owner, client);
    assert!(provider.state.lock().unwrap().shut_down);
    assert!(!copy.options.data_dir.join("runtime.lock").exists());
    assert!(!p.join(".milagre/runtime.lock").exists());
    let state = node_state(p, &copy.root);
    assert!(state["messages"]
        .as_array()
        .unwrap()
        .iter()
        .any(|m| m["body"] == "fresh send"));
    assert!(
        state["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["role"] == "assistant"
                && m["outcome"] == "failed"
                && m["body"] == "partial answer\n\nMilagre quit before the turn ended."),
        "{state}"
    );
}

#[test]
fn normal_start_never_advertises_or_executes_chat_mutations() {
    let copy = Copy::new();
    let owner = start(&copy.options).unwrap();
    let mut client = Client::new(&owner);
    let methods = client.call("daemon:status", json!([]))["methods"].clone();
    for method in [
        "chat:send",
        "agent:interrupt",
        "chat:queue-send",
        "chat:queue-remove",
    ] {
        assert!(
            !methods.as_array().unwrap().contains(&json!(method)),
            "{methods}"
        );
    }
    let p = &copy.projects[0];
    let before = fs::read(p.join(".milagre/coordination.json")).unwrap();
    client.call("project:read", json!([p]));
    assert!(
        client.request("chat:send", send(p, "claude", "m", "refused", "no"))["error"].is_object()
    );
    stop(owner, client);
    assert_eq!(
        fs::read(p.join(".milagre/coordination.json")).unwrap(),
        before
    );
}

#[test]
fn replaced_project_and_profile_ownership_refuse_before_provider_or_write() {
    let copy = Copy::new();
    let provider = MockProvider::new("claude");
    let owner = copy.start(std::slice::from_ref(&provider));
    let mut client = Client::new(&owner);
    let p = &copy.projects[0];
    client.call("project:read", json!([p]));
    let moved = copy.root.join("moved-alpha");
    fs::rename(p, &moved).unwrap();
    fs::create_dir(p).unwrap();
    let before = fs::read(moved.join(".milagre/coordination.json")).unwrap();
    assert!(client.request(
        "chat:send",
        send(p, "claude", "m", "refused", "lost-project")
    )["error"]
        .is_object());
    assert!(provider.state.lock().unwrap().turns.is_empty());
    assert_eq!(
        fs::read(moved.join(".milagre/coordination.json")).unwrap(),
        before
    );
    assert!(fs::read_dir(p).unwrap().next().is_none());
    fs::remove_dir(p).unwrap();
    fs::rename(&moved, p).unwrap();
    client.call(
        "chat:send",
        send(p, "claude", "m", "active", "before-profile-loss"),
    );
    let before = fs::read(p.join(".milagre/coordination.json")).unwrap();
    let lock = copy.options.data_dir.join("runtime.lock/owner.json");
    let held = fs::read(&lock).unwrap();
    let mut changed: Value = serde_json::from_slice(&held).unwrap();
    changed["token"] = json!("foreign-owner");
    fs::write(&lock, serde_json::to_vec(&changed).unwrap()).unwrap();
    assert!(client.request(
        "chat:send",
        send(p, "claude", "m", "refused", "lost-profile")
    )["error"]
        .is_object());
    assert_eq!(provider.state.lock().unwrap().turns.len(), 1);
    assert!(client.request("daemon:stop", json!([]))["error"].is_object());
    assert!(!provider.state.lock().unwrap().shut_down);
    assert_eq!(
        fs::read(p.join(".milagre/coordination.json")).unwrap(),
        before
    );
    fs::write(&lock, held).unwrap();
    stop(owner, client);
}

#[test]
fn failed_debounced_save_publishes_persistence_and_recovery() {
    let copy = Copy::new();
    let provider = MockProvider::new("claude");
    let owner = copy.start(std::slice::from_ref(&provider));
    let mut client = Client::new(&owner);
    let p = &copy.projects[0];
    client.call("project:read", json!([p]));
    client.call("chat:send", send(p, "claude", "m", "first", "failure-1"));
    let destination = p.join(".milagre/coordination.json");
    let saved = p.join(".milagre/before-failure.json");
    fs::rename(&destination, &saved).unwrap();
    fs::create_dir(&destination).unwrap();
    provider.emit(
        &format!("{}#1", p.display()),
        json!({"type":"text-delta","text":"retained through failure"}),
    );
    provider.emit(
        &format!("{}#1", p.display()),
        json!({"type":"turn-completed"}),
    );
    let until = Instant::now() + Duration::from_secs(4);
    let mut observed = false;
    while Instant::now() < until {
        client.call("daemon:status", json!([]));
        observed = client.events.iter().any(|event| {
            event.to_string().contains("persistence") && event.to_string().contains("error")
        });
        if observed {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    // Restore the same file even on a failed assertion so teardown can release this test's writer.
    fs::remove_dir(&destination).unwrap();
    fs::rename(&saved, &destination).unwrap();
    let mut next = send(p, "claude", "m", "second", "failure-2");
    next[0]["sessionId"] = Value::Null;
    next[0]["worktreeId"] = json!(1);
    client.call("chat:send", next);
    let state = client.call("state:read", json!([p]));
    assert!(state["state"].get("persistence").is_none(), "{state}");
    stop(owner, client);
    assert!(
        observed,
        "a failed save never published its persistence error"
    );
    let reopened = node_state(p, &copy.root);
    assert!(reopened["messages"]
        .as_array()
        .unwrap()
        .iter()
        .any(|m| m["body"] == "retained through failure"));
}

#[test]
fn queued_send_now_interrupts_only_its_project_and_keeps_saved_receipts() {
    let copy = Copy::new();
    let provider = MockProvider::new("kiro");
    let owner = copy.start(std::slice::from_ref(&provider));
    let mut client = Client::new(&owner);
    let a = &copy.projects[0];
    let b = &copy.projects[1];
    for p in [a, b] {
        client.call("project:read", json!([p]));
        client.call(
            "chat:send",
            send(
                p,
                "kiro",
                "queue-model",
                "first",
                p.file_name().unwrap().to_str().unwrap(),
            ),
        );
    }
    let chat = format!("{}#1", a.display());
    let mut queued = send(a, "kiro", "queue-model", "queued second", "queued-second");
    queued[0]["delivery"] = json!("queue");
    client.call("chat:send", queued);
    let state = client.call("state:read", json!([a]));
    let id = state["state"]["sessions"]["1"]["queued"][0]["id"].clone();
    assert!(id.is_string());
    assert_eq!(
        client.call("chat:queue-send", json!([chat, id])),
        Value::Null
    );
    assert_eq!(
        provider.state.lock().unwrap().interrupts,
        vec![chat.clone()]
    );
    provider.emit(&chat, json!({"type":"turn-cancelled"}));
    client.wait(|c| {
        c.call("daemon:status", json!([]));
        provider.state.lock().unwrap().turns.len() == 3
    });
    assert_eq!(provider.state.lock().unwrap().turns[2]["chatId"], chat);
    client.call("agent:interrupt", json!([chat]));
    assert_eq!(
        provider.state.lock().unwrap().interrupts,
        vec![chat.clone(), chat.clone()]
    );
    provider.emit(&chat, json!({"type":"turn-cancelled"}));
    provider.emit(
        &format!("{}#1", b.display()),
        json!({"type":"turn-completed"}),
    );
    client.wait(|c| {
        c.call("chat:runs", json!([]))["runs"]
            .as_object()
            .is_some_and(|r| r.is_empty())
    });
    let receipt = client.call("chat:send-status", json!([a, "queued-second"]));
    assert_eq!(receipt["sessionId"], 1, "{receipt}");
    assert_eq!(
        client.call("chat:send-status", json!([b, "queued-second"])),
        Value::Null
    );
    let found = client.call("chat:search", json!([a, "queued second", {"limit":5}]));
    assert!(!found.as_array().unwrap().is_empty(), "{found}");
    let messages = client.call("chat:all-messages", json!([a, {}]));
    assert!(messages
        .as_array()
        .unwrap()
        .iter()
        .any(|m| m["body"] == "queued second"));
    stop(owner, client);
}

#[test]
fn ownership_loss_hides_runs_while_another_project_keeps_streaming() {
    let copy = Copy::new();
    let provider = MockProvider::new("claude");
    let owner = copy.start(std::slice::from_ref(&provider));
    let mut client = Client::new(&owner);
    let a = &copy.projects[0];
    let b = &copy.projects[1];
    for p in [a, b] {
        client.call("project:read", json!([p]));
        client.call(
            "chat:send",
            send(
                p,
                "claude",
                "m",
                "first",
                p.file_name().unwrap().to_str().unwrap(),
            ),
        );
    }
    let a_chat = format!("{}#1", a.display());
    let b_chat = format!("{}#1", b.display());
    client.wait(|c| {
        c.call("chat:runs", json!([]))["runs"]
            .get(&a_chat)
            .is_some()
    });
    let moved = copy.root.join("moved-active-alpha");
    fs::rename(a, &moved).unwrap();
    fs::create_dir(a).unwrap();
    let before = fs::read(moved.join(".milagre/coordination.json")).unwrap();
    provider.emit(
        &a_chat,
        json!({"type":"text-delta","text":"must stay parked"}),
    );
    provider.emit(
        &b_chat,
        json!({"type":"text-delta","text":"unaffected reply"}),
    );
    provider.emit(&b_chat, json!({"type":"turn-completed"}));
    client.wait(|c| {
        let runs = c.call("chat:runs", json!([]));
        assert!(
            runs["runs"].get(&a_chat).is_none(),
            "lost Project run was published: {runs}"
        );
        let snapshot = c.call("daemon:snapshot", json!([]));
        assert!(
            snapshot["runs"]["runs"].get(&a_chat).is_none(),
            "lost Project run leaked in snapshot: {snapshot}"
        );
        assert!(
            !snapshot["projects"]
                .as_array()
                .unwrap()
                .iter()
                .any(|project| project["path"] == json!(a)),
            "lost Project state leaked in snapshot: {snapshot}"
        );
        assert!(snapshot["projects"]
            .as_array()
            .unwrap()
            .iter()
            .any(|project| project["path"] == json!(b)));
        c.call("state:read", json!([b]))
            .to_string()
            .contains("unaffected reply")
    });
    assert_eq!(
        fs::read(moved.join(".milagre/coordination.json")).unwrap(),
        before
    );
    assert!(fs::read_dir(a).unwrap().next().is_none());
    fs::remove_dir(a).unwrap();
    fs::rename(&moved, a).unwrap();
    stop(owner, client);
}

#[test]
fn focused_chats_in_two_clients_are_read_until_their_view_disconnects() {
    let copy = Copy::new();
    let provider = MockProvider::new("claude");
    let owner = copy.start(std::slice::from_ref(&provider));
    let mut first = Client::new(&owner);
    let mut second = Client::new(&owner);
    let a = &copy.projects[0];
    let b = &copy.projects[1];
    for (client, p) in [(&mut first, a), (&mut second, b)] {
        client.call("project:read", json!([p, {"state":true}]));
        client.call("daemon:focus", json!([{"focused":true}]));
        client.call("chat:set-open", json!([format!("{}#1", p.display())]));
        client.call("chat:send", send(p, "claude", "m", "first", "first"));
        let chat = format!("{}#1", p.display());
        provider.emit(&chat, json!({"type":"session-started","nativeId":format!("native-{}",p.file_name().unwrap().to_str().unwrap())}));
        provider.emit(&chat, json!({"type":"text-delta","text":"visible answer"}));
        provider.emit(&chat, json!({"type":"turn-completed"}));
    }
    first.wait(|c| {
        c.call("chat:runs", json!([]))["runs"]
            .as_object()
            .is_some_and(|r| r.is_empty())
    });
    for p in [a, b] {
        let state = first.call("state:read", json!([p]));
        assert_ne!(
            state["state"]["sessions"]["1"]["unread"], true,
            "focused Chat marked unread: {state}"
        );
    }
    drop(second);
    // Wait for actual EOF recognition: elapsed time alone is not evidence that the view disconnected.
    first.wait(|_| {
        owner
            .server
            .disconnect_diagnostics()
            .count(milagre_owner_wire::DisconnectReason::PeerEof)
            == 1
    });
    first.call("chat:send", send(b, "claude", "m", "second", "second"));
    provider.emit(
        &format!("{}#1", b.display()),
        json!({"type":"text-delta","text":"unseen answer"}),
    );
    provider.emit(
        &format!("{}#1", b.display()),
        json!({"type":"turn-completed"}),
    );
    first.wait(|c| {
        c.call("chat:runs", json!([]))["runs"]
            .as_object()
            .is_some_and(|r| r.is_empty())
    });
    assert_eq!(
        first.call("state:read", json!([b]))["state"]["sessions"]["1"]["unread"],
        true
    );
    assert_ne!(
        first.call("state:read", json!([a]))["state"]["sessions"]["1"]["unread"],
        true
    );
    stop(owner, first);
}

#[test]
fn rejected_send_does_not_persist_reconciliation_or_initialize_fresh_project() {
    let copy = Copy::new();
    let provider = MockProvider::new("claude");
    let saved = &copy.projects[0];
    let empty = &copy.projects[2];
    let before = fs::read(saved.join(".milagre/coordination.json")).unwrap();
    let owner = copy.start(std::slice::from_ref(&provider));
    let mut client = Client::new(&owner);
    for p in [saved, empty] {
        client.call("project:read", json!([p]));
        let missing = json!([{"projectPath":p,"body":"must not be accepted","clientMessageId":"missing-provider"}]);
        let reply = client.request("chat:send", missing);
        assert!(reply["error"].is_object(), "{reply}");
        assert!(provider.state.lock().unwrap().turns.is_empty());
    }
    stop(owner, client);
    assert_eq!(
        fs::read(saved.join(".milagre/coordination.json")).unwrap(),
        before
    );
    for p in [saved, empty] {
        assert!(
            !p.join(".milagre/chats.db").exists(),
            "rejected send created chats.db in {}",
            p.display()
        );
    }
    assert!(
        !empty.join(".milagre/coordination.json").exists(),
        "rejected send initialized a saved Project"
    );
}

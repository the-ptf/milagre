use super::*;
use crate::TerminalSize;

const ID: &str = "11111111-1111-4111-8111-111111111111";
const TERMINALS: &[&str] = &[
    "terminal:list",
    "terminal:profiles",
    "terminal:open",
    "terminal:read",
    "terminal:input",
    "terminal:resize",
    "terminal:close",
];
fn handshake(peer: &mut Peer) {
    let request = peer.request("daemon:status");
    let mut value = status();
    value["methods"] = json!(METHODS.iter().chain(TERMINALS.iter()).collect::<Vec<_>>());
    peer.reply(&request, value);
}
fn terminal_server(
    run: impl FnOnce(&mut Peer) + Send + 'static,
) -> (FixtureGuard, thread::JoinHandle<()>) {
    let (guard, mut peer) = pair();
    let worker = thread::spawn(move || {
        handshake(&mut peer);
        run(&mut peer);
    });
    (guard, worker)
}
fn open(peer: &mut Peer) {
    let request = peer.request("project:open");
    peer.reply(&request, json!({"path":PROJECT}));
}

#[test]
fn seven_routes_preserve_exact_project_chat_and_reply_shapes_without_caller_runtime() {
    let (guard, worker) = terminal_server(|peer| {
        open(peer);
        for (method, argument) in [
            ("terminal:list", json!({"chatId":format!("{PROJECT}#1")})),
            ("terminal:profiles", json!({})),
            (
                "terminal:open",
                json!({"chatId":format!("{PROJECT}#9007199254740991"),"cols":80,"rows":24}),
            ),
            ("terminal:read", json!({"terminalId":ID,"after":0})),
            (
                "terminal:read",
                json!({"terminalId":ID,"after":9_007_199_254_740_991u64,"limit":1_048_576}),
            ),
            (
                "terminal:input",
                json!({"terminalId":ID,"data":"printf 'λ😀'\n"}),
            ),
            (
                "terminal:resize",
                json!({"terminalId":ID,"cols":1000,"rows":500}),
            ),
            ("terminal:close", json!({"terminalId":ID})),
        ] {
            let request = peer.request(method);
            assert_eq!(request["args"], json!([argument]));
            peer.reply(
                &request,
                json!({"unmodified":method,"offset":2,"reset":true,"ended":false}),
            );
        }
        peer.closed();
    });
    let (client, _, _) = connect(&guard);
    let terminals = client.owned_terminals_for(&guard.authority).unwrap();
    block_on(async {
        client.open_view(PROJECT).await.unwrap();
        for (method, result) in [
            ("terminal:list", terminals.list(1).await),
            ("terminal:profiles", terminals.profiles().await),
            (
                "terminal:open",
                terminals
                    .open(9_007_199_254_740_991, TerminalSize::default())
                    .await,
            ),
            ("terminal:read", terminals.read(ID, 0, None).await),
            (
                "terminal:read",
                terminals
                    .read(ID, 9_007_199_254_740_991, Some(1_048_576))
                    .await,
            ),
            (
                "terminal:input",
                terminals.input(ID, "printf 'λ😀'\n").await,
            ),
            (
                "terminal:resize",
                terminals
                    .resize(
                        ID,
                        TerminalSize {
                            cols: 1000,
                            rows: 500,
                        },
                    )
                    .await,
            ),
            ("terminal:close", terminals.close(ID).await),
        ] {
            assert_eq!(
                result.unwrap(),
                json!({"unmodified":method,"offset":2,"reset":true,"ended":false})
            );
        }
    });
    client.disconnect();
    worker.join().unwrap();
}

#[test]
fn exact_guard_and_explicit_view_are_required_for_every_route() {
    let (guard, worker) = terminal_server(|peer| {
        let current = peer.request("project:current");
        peer.reply(&current, json!({"path":PROJECT}));
        open(peer);
        let request = peer.request("terminal:profiles");
        peer.reply(&request, json!({"shells":[]}));
        peer.closed();
    });
    let (foreign, _) = pair();
    let (client, _, _) = connect(&guard);
    assert!(matches!(
        client.owned_terminals_for(&foreign.authority),
        Err(Error::InvalidScope)
    ));
    let terminals = client.owned_terminals_for(&guard.authority).unwrap();
    block_on(async {
        for result in [
            terminals.list(1).await,
            terminals.profiles().await,
            terminals.open(1, TerminalSize::default()).await,
            terminals.read(ID, 0, None).await,
            terminals.input(ID, "").await,
            terminals.resize(ID, TerminalSize::default()).await,
            terminals.close(ID).await,
        ] {
            assert_eq!(result, Err(Error::ViewNotOpened));
        }
        client.project_current().await.unwrap();
        assert_eq!(terminals.profiles().await, Err(Error::ViewNotOpened));
        client.open_view(PROJECT).await.unwrap();
        terminals.profiles().await.unwrap();
    });
    client.disconnect();
    worker.join().unwrap();
    assert_eq!(block_on(terminals.close(ID)), Err(Error::Disconnected));
    assert!(matches!(
        client.owned_terminals_for(&guard.authority),
        Err(Error::Disconnected)
    ));
}

#[test]
fn bounds_refuse_before_enqueue_and_exact_input_limits_are_accepted() {
    let (guard, worker) = terminal_server(|peer| {
        open(peer);
        for expected in ["", &"\0".repeat(65_536)] {
            let request = peer.request("terminal:input");
            assert_eq!(request["args"][0]["data"], expected);
            peer.reply(&request, json!({"accepted":true}));
        }
        for argument in [
            json!({"chatId":format!("{PROJECT}#1"),"cols":2,"rows":1}),
            json!({"chatId":format!("{PROJECT}#1"),"cols":1000,"rows":500}),
        ] {
            let request = peer.request("terminal:open");
            assert_eq!(request["args"], json!([argument]));
            peer.reply(&request, Value::Null);
        }
        let request = peer.request("terminal:read");
        assert_eq!(request["args"][0]["limit"], 4096);
        peer.reply(&request, Value::Null);
        let request = peer.request("project:current");
        peer.reply(&request, json!({"path":PROJECT}));
        peer.closed();
    });
    let (client, _, _) = connect(&guard);
    let terminals = client.owned_terminals_for(&guard.authority).unwrap();
    block_on(async {
        client.open_view(PROJECT).await.unwrap();
        for chat in [0, 9_007_199_254_740_992] {
            assert!(matches!(
                terminals.list(chat).await,
                Err(Error::InvalidInput { field: "chat", .. })
            ));
            assert!(terminals.open(chat, TerminalSize::default()).await.is_err());
        }
        for size in [
            TerminalSize { cols: 1, rows: 24 },
            TerminalSize {
                cols: 1001,
                rows: 24,
            },
            TerminalSize { cols: 80, rows: 0 },
            TerminalSize {
                cols: 80,
                rows: 501,
            },
        ] {
            assert!(matches!(
                terminals.open(1, size).await,
                Err(Error::InvalidInput { field: "size", .. })
            ));
            assert!(terminals.resize(ID, size).await.is_err());
        }
        for id in [
            "",
            "/tmp/terminal",
            "11111111_1111-4111-8111-111111111111",
            "AAAAAAAA-1111-4111-8111-111111111111",
        ] {
            assert!(matches!(
                terminals.close(id).await,
                Err(Error::InvalidInput {
                    field: "terminal_id",
                    ..
                })
            ));
        }
        assert!(matches!(
            terminals.read(ID, 9_007_199_254_740_992, None).await,
            Err(Error::InvalidInput { field: "after", .. })
        ));
        for limit in [0, 4095, 1_048_577, u64::MAX] {
            assert!(matches!(
                terminals.read(ID, 0, Some(limit)).await,
                Err(Error::InvalidInput { field: "limit", .. })
            ));
        }
        assert!(matches!(
            terminals.input(ID, &"a".repeat(65_537)).await,
            Err(Error::InvalidInput { field: "data", .. })
        ));
        assert!(matches!(
            terminals.input(ID, &"😀".repeat(16_385)).await,
            Err(Error::InvalidInput { field: "data", .. })
        ));
        terminals.input(ID, "").await.unwrap();
        terminals.input(ID, &"\0".repeat(65_536)).await.unwrap();
        terminals
            .open(1, TerminalSize { cols: 2, rows: 1 })
            .await
            .unwrap();
        terminals
            .open(
                1,
                TerminalSize {
                    cols: 1000,
                    rows: 500,
                },
            )
            .await
            .unwrap();
        terminals.read(ID, 0, Some(4096)).await.unwrap();
        drop(terminals.input(ID, "unpolled"));
        client.project_current().await.unwrap();
    });
    drop(client);
    assert_eq!(block_on(terminals.list(1)), Err(Error::Disconnected));
    worker.join().unwrap();
}

#[test]
fn pending_terminal_action_does_not_keep_dropped_client_alive() {
    let (submitted, observed) = mpsc::channel();
    let (guard, worker) = terminal_server(move |peer| {
        open(peer);
        let _ = peer.request("terminal:input");
        submitted.send(()).unwrap();
        peer.closed();
    });
    let (client, _, _) = connect(&guard);
    let terminals = client.owned_terminals_for(&guard.authority).unwrap();
    block_on(client.open_view(PROJECT)).unwrap();
    let mut wait = Box::pin(terminals.input(ID, "submitted once"));
    assert!(wait.as_mut().now_or_never().is_none());
    observed.recv_timeout(Duration::from_secs(3)).unwrap();
    drop(client);
    assert_eq!(block_on(wait), Err(Error::Disconnected));
    assert_eq!(
        block_on(terminals.input(ID, "never replay")),
        Err(Error::Disconnected)
    );
    worker.join().unwrap();
}

#[test]
fn remote_scope_error_and_submitted_timeout_preserve_uncertainty_without_replay() {
    let (release, resume) = mpsc::channel();
    let remote = json!({"code":"TERMINAL_SCOPE","message":"Captured Chat removed","detail":{"generation":7}});
    let expected = remote.clone();
    let (guard, worker) = terminal_server(move |peer| {
        open(peer);
        let request = peer.request("terminal:close");
        peer.send(json!({"v":1,"id":request["id"],"error":remote}));
        let request = peer.request("terminal:input");
        resume.recv_timeout(Duration::from_secs(3)).unwrap();
        peer.reply(&request, json!({"accepted":true}));
        let request = peer.request("terminal:list");
        peer.reply(&request, json!({"terminals":[]}));
        peer.closed();
    });
    let (client, _, _) = block_on(Client::connect(
        guard.endpoint(),
        ClientOptions {
            request_timeout: Duration::from_millis(80),
            ..ClientOptions::default()
        },
    ))
    .unwrap();
    let terminals = client.owned_terminals_for(&guard.authority).unwrap();
    block_on(client.open_view(PROJECT)).unwrap();
    assert_eq!(
        block_on(terminals.close(ID)),
        Err(Error::Remote {
            code: "TERMINAL_SCOPE".into(),
            message: "Captured Chat removed".into(),
            payload: expected
        })
    );
    assert_eq!(
        block_on(terminals.input(ID, "may have run")),
        Err(Error::TimedOut { submitted: true })
    );
    release.send(()).unwrap();
    assert_eq!(
        block_on(terminals.list(1)).unwrap(),
        json!({"terminals":[]})
    );
    client.disconnect();
    worker.join().unwrap();
}

#[test]
fn absent_terminal_method_is_capability_refusal_without_rpc_or_fallback() {
    let (guard, worker) = server(|peer| {
        open(peer);
        let request = peer.request("project:current");
        peer.reply(&request, json!({"path":PROJECT}));
        peer.closed();
    });
    let (client, _, _) = connect(&guard);
    let terminals = client.owned_terminals_for(&guard.authority).unwrap();
    block_on(client.open_view(PROJECT)).unwrap();
    assert_eq!(
        block_on(terminals.profiles()),
        Err(Error::Capability {
            required: "method:terminal:profiles".into()
        })
    );
    block_on(client.project_current()).unwrap();
    client.disconnect();
    worker.join().unwrap();
}

#[test]
fn terminal_events_use_the_same_explicit_snapshot_receipt_barrier() {
    let (guard, worker) = terminal_server(|peer| {
        open(peer);
        for seq in [1, 2] {
            peer.send(json!({"v":1,"event":{"seq":seq,"channel":"terminal:changed","payload":{"chatId":format!("{PROJECT}#1")}}}));
        }
        peer.snapshot(1);
        let request = peer.request("terminal:list");
        peer.reply(&request, json!({"terminals":[]}));
        peer.closed();
    });
    let (client, _, mut notifications) = connect(&guard);
    let terminals = client.owned_terminals_for(&guard.authority).unwrap();
    block_on(client.open_view(PROJECT)).unwrap();
    let snapshot = block_on(client.runtime_snapshot()).unwrap();
    assert!(notifications.next().now_or_never().is_none());
    block_on(client.accept_snapshot(&snapshot)).unwrap();
    assert!(
        matches!(block_on(notifications.next()),Some(Notice::Event{wire_seq:2,channel,..}) if channel == "terminal:changed")
    );
    block_on(terminals.list(1)).unwrap();
    client.disconnect();
    worker.join().unwrap();
}

#[test]
fn explicit_second_connection_keeps_controls_moving_during_a_blocked_read() {
    let (control_stream, control_peer) = UnixStream::pair().unwrap();
    let (read_stream, read_peer) = UnixStream::pair().unwrap();
    let streams = Mutex::new(std::collections::VecDeque::from([
        control_stream,
        read_stream,
    ]));
    let guard = FixtureGuard {
        authority: Arc::new(Authority {
            launcher: None,
            project: PROJECT.into(),
            pid: PID,
            connect: Box::new(move || {
                streams
                    .lock()
                    .unwrap()
                    .pop_front()
                    .ok_or(Error::Disconnected)
            }),
        }),
    };
    let (entered, blocked) = mpsc::channel();
    let (release, resume) = mpsc::channel();
    let reader_worker = thread::spawn(move || {
        let mut peer = Peer::new(read_peer);
        handshake(&mut peer);
        open(&mut peer);
        peer.snapshot(0);
        let request = peer.request("terminal:read");
        entered.send(()).unwrap();
        resume.recv_timeout(Duration::from_secs(3)).unwrap();
        peer.send(json!({"v":1,"event":{"seq":1,"channel":"terminal:changed","payload":{"chatId":format!("{PROJECT}#1")}}}));
        peer.reply(
            &request,
            json!({"offset":2,"data":"ok","reset":false,"ended":false}),
        );
        peer.closed();
    });
    let control_worker = thread::spawn(move || {
        let mut peer = Peer::new(control_peer);
        handshake(&mut peer);
        open(&mut peer);
        peer.snapshot(0);
        let request = peer.request("terminal:input");
        assert_eq!(
            request["args"],
            json!([{"terminalId":ID,"data":"control progresses"}])
        );
        peer.send(json!({"v":1,"event":{"seq":1,"channel":"terminal:changed","payload":{"chatId":format!("{PROJECT}#1")}}}));
        peer.reply(&request, json!({"accepted":true}));
        peer.closed();
    });
    let (controls, _, mut control_events) = connect(&guard);
    let (reader, _, mut read_events) = connect(&guard);
    for client in [&controls, &reader] {
        block_on(client.open_view(PROJECT)).unwrap();
        let snapshot = block_on(client.runtime_snapshot()).unwrap();
        block_on(client.accept_snapshot(&snapshot)).unwrap();
    }
    let read_actions = reader.owned_terminals_for(&guard.authority).unwrap();
    let control_actions = controls.owned_terminals_for(&guard.authority).unwrap();
    let mut read = Box::pin(read_actions.read(ID, 0, None));
    assert!(read.as_mut().now_or_never().is_none());
    blocked.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!(
        block_on(control_actions.input(ID, "control progresses")).unwrap(),
        json!({"accepted":true})
    );
    assert!(
        read.as_mut().now_or_never().is_none(),
        "control must complete before releasing the read"
    );
    assert!(matches!(
        block_on(control_events.next()),
        Some(Notice::Event { wire_seq: 1, .. })
    ));
    release.send(()).unwrap();
    assert_eq!(
        block_on(read).unwrap(),
        json!({"offset":2,"data":"ok","reset":false,"ended":false})
    );
    assert!(matches!(
        block_on(read_events.next()),
        Some(Notice::Event { wire_seq: 1, .. })
    ));
    controls.disconnect();
    reader.disconnect();
    control_worker.join().unwrap();
    reader_worker.join().unwrap();
}

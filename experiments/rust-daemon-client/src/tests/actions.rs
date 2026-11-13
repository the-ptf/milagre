//! Scripted actions use the existing owned connection. These Unix-pair tests
//! advertise writes explicitly; the common read-only METHODS stays unchanged.
use super::*;

const MAX_CHAT: u64 = 9_007_199_254_740_991;
const ACTIONS: &[&str] = &["chat:send", "agent:interrupt"];

fn handshake(peer: &mut Peer, actions: &[&str]) {
    let request = peer.request("daemon:status");
    let mut value = status();
    value["methods"] = json!(METHODS.iter().chain(actions.iter()).collect::<Vec<_>>());
    peer.reply(&request, value);
}

fn action_server(
    run: impl FnOnce(&mut Peer) + Send + 'static,
) -> (FixtureGuard, thread::JoinHandle<()>) {
    let (guard, mut peer) = pair();
    let worker = thread::spawn(move || {
        handshake(&mut peer, ACTIONS);
        run(&mut peer);
    });
    (guard, worker)
}

fn send_args(chat: u64, text: &str, id: &str) -> Value {
    json!([{"projectPath":PROJECT,"sessionId":chat,"provider":"kiro",
        "model":"scripted","permissionMode":"ask","body":text,"clientMessageId":id}])
}

fn invalid(value: Result<Value>, field: &str) {
    assert!(
        matches!(&value, Err(Error::InvalidInput { field: actual, .. }) if *actual == field),
        "expected InvalidInput({field}), got {value:?}"
    );
}

#[test]
fn actions_pin_exact_project_provider_model_policy_and_same_connection() {
    let (guard, worker) = action_server(|peer| {
        let open = peer.request("project:open");
        assert_eq!(open["args"], json!([PROJECT]));
        peer.reply(&open, json!({"path":PROJECT}));
        let sent = peer.request("chat:send");
        assert_eq!(sent["args"], send_args(2, "hello 🧪\n", "client-1"));
        peer.reply(&sent, json!({"accepted":true,"turnId":"t1","unknown":17}));
        let stop = peer.request("agent:interrupt");
        assert_eq!(stop["args"], json!([format!("{PROJECT}#2")]));
        assert_ne!(sent["id"], stop["id"]);
        peer.reply(&stop, json!({"requested":true}));
        peer.closed();
    });
    let (client, _, _) = connect(&guard);
    let actions = guard.scripted_actions(&client).unwrap();
    block_on(async {
        client.open_view(PROJECT).await.unwrap();
        assert_eq!(
            actions.send(2, "hello 🧪\n", "client-1").await.unwrap(),
            json!({"accepted":true,"turnId":"t1","unknown":17})
        );
        assert_eq!(
            actions.interrupt(2).await.unwrap(),
            json!({"requested":true})
        );
    });
    client.disconnect();
    worker.join().unwrap();
}

#[test]
fn equal_path_and_pid_cannot_mint_actions_for_a_foreign_guard() {
    let (guard, worker) = action_server(|peer| peer.closed());
    let (foreign, _unused_peer) = pair();
    assert_eq!(guard.project(), foreign.project());
    assert_eq!(guard.authority.pid, foreign.authority.pid);
    let (client, _, _) = connect(&guard);
    assert!(matches!(
        foreign.scripted_actions(&client),
        Err(Error::InvalidScope)
    ));
    assert!(guard.scripted_actions(&client).is_ok());
    client.disconnect();
    assert!(matches!(
        guard.scripted_actions(&client),
        Err(Error::Disconnected)
    ));
    worker.join().unwrap();
}

#[test]
fn actions_preserve_scope_refusal_and_never_open_a_view_implicitly() {
    let remote = json!({"code":"ISOLATED_SCOPE_ONLY","message":"Open this Project first","detail":{"ready":true}});
    let expected = remote.clone();
    let (guard, worker) = action_server(move |peer| {
        for method in ACTIONS {
            let request = peer.request(method);
            peer.send(json!({"v":1,"id":request["id"],"error":remote}));
        }
        let open = peer.request("project:open");
        peer.reply(&open, json!({"path":PROJECT}));
        let send = peer.request("chat:send");
        peer.reply(&send, json!({"accepted":true}));
        peer.closed();
    });
    let (client, _, _) = connect(&guard);
    let actions = guard.scripted_actions(&client).unwrap();
    let refusal = Err(Error::Remote {
        code: "ISOLATED_SCOPE_ONLY".into(),
        message: "Open this Project first".into(),
        payload: expected,
    });
    assert_eq!(block_on(actions.send(1, "one", "first")), refusal);
    assert_eq!(block_on(actions.interrupt(1)), refusal);
    block_on(client.open_view(PROJECT)).unwrap();
    assert_eq!(
        block_on(actions.send(1, "two", "second")).unwrap(),
        json!({"accepted":true})
    );
    client.disconnect();
    worker.join().unwrap();
}

#[test]
fn absent_action_methods_refuse_without_rpc_or_fallback() {
    for advertised in [&[][..], &ACTIONS[..1], &ACTIONS[1..]] {
        let (guard, mut peer) = pair();
        let worker = thread::spawn(move || {
            handshake(&mut peer, advertised);
            // A subsequent read is the ordered positive barrier. No absent action
            // or implicit project:open can precede it on this socket.
            let request = peer.request("project:current");
            peer.reply(&request, json!({"path":PROJECT}));
            peer.closed();
        });
        let (client, _, _) = connect(&guard);
        let actions = guard.scripted_actions(&client).unwrap();
        for method in ACTIONS.iter().filter(|method| !advertised.contains(method)) {
            let result = if *method == "chat:send" {
                block_on(actions.send(1, "one", "id"))
            } else {
                block_on(actions.interrupt(1))
            };
            assert_eq!(
                result,
                Err(Error::Capability {
                    required: format!("method:{method}")
                })
            );
        }
        assert_eq!(block_on(client.project_current()).unwrap()["path"], PROJECT);
        client.disconnect();
        worker.join().unwrap();
    }
}

#[test]
fn invalid_inputs_are_rejected_before_admission_even_with_a_full_queue() {
    let (received_tx, received_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let (guard, worker) = action_server(move |peer| {
        let held = peer.request("project:current");
        received_tx.send(()).unwrap();
        release_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        peer.reply(&held, json!({"path":PROJECT}));
        peer.closed();
    });
    let (client, _, _) = block_on(Client::connect(
        guard.endpoint(),
        ClientOptions {
            max_pending: 1,
            ..ClientOptions::default()
        },
    ))
    .unwrap();
    let actions = guard.scripted_actions(&client).unwrap();
    let mut held = Box::pin(client.project_current());
    assert!(held.as_mut().now_or_never().is_none());
    received_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    // A valid action really would consume admission and is Busy here.
    assert_eq!(block_on(actions.send(1, "x", "id")), Err(Error::Busy));
    for chat in [0, MAX_CHAT + 1, u64::MAX] {
        invalid(block_on(actions.send(chat, "x", "id")), "chat");
        invalid(block_on(actions.interrupt(chat)), "chat");
    }
    for text in [String::new(), "a".repeat(2049), "é".repeat(1025)] {
        invalid(block_on(actions.send(1, &text, "id")), "text");
    }
    for id in [String::new(), "a".repeat(129), "🧪".repeat(33)] {
        invalid(block_on(actions.send(1, "x", &id)), "client_message_id");
    }
    // UTF-8 size alone fits, but JSON escaping crosses the serialized limit.
    invalid(
        block_on(actions.send(1, &"\0".repeat(600), "id")),
        "payload",
    );
    release_tx.send(()).unwrap();
    assert_eq!(block_on(held).unwrap()["path"], PROJECT);
    client.disconnect();
    worker.join().unwrap();
}

#[test]
fn exact_chat_utf8_and_escaped_serialized_limits_are_admitted() {
    let overhead = send_args(1, "", "edge").to_string().len();
    let remaining = 3072 - overhead;
    let escaped = format!(
        "{}{}",
        "\0".repeat(remaining / 6),
        "x".repeat(remaining % 6)
    );
    assert!(escaped.len() <= 2048);
    assert_eq!(send_args(1, &escaped, "edge").to_string().len(), 3072);
    // The preflight leaves room for the complete protocol wrapper, its largest
    // JSON-safe request ID and the trailing LF under the owner's 4 KiB limit.
    for (method, expected_frame_bytes) in [("chat:send", 3143), ("agent:interrupt", 3149)] {
        let frame = json!({"v":1,"id":MAX_CHAT,"method":method,
            "args":send_args(1, &escaped, "edge"),"pages":true});
        assert_eq!(frame.to_string().len(), expected_frame_bytes);
        assert!(expected_frame_bytes + 1 < 4096);
    }
    let cases = vec![
        (1, "x".into(), "i".into()),
        (MAX_CHAT, "a".repeat(2048), "i".repeat(128)),
        (MAX_CHAT, "é".repeat(1024), "🧪".repeat(32)),
        (1, escaped.clone(), "edge".into()),
    ];
    let expected = cases.clone();
    let (guard, worker) = action_server(move |peer| {
        for (chat, text, id) in expected {
            let request = peer.request("chat:send");
            assert_eq!(request["args"], send_args(chat, &text, &id));
            peer.reply(&request, json!({"accepted":true}));
        }
        let request = peer.request("agent:interrupt");
        assert_eq!(request["args"], json!([format!("{PROJECT}#{MAX_CHAT}")]));
        peer.reply(&request, json!(true));
        peer.closed();
    });
    let (client, _, _) = connect(&guard);
    let actions = guard.scripted_actions(&client).unwrap();
    // The one-byte-over form fits the individual text/id limits. It must not
    // appear before the first expected valid request.
    let too_large = format!("{escaped}x");
    assert_eq!(send_args(1, &too_large, "edge").to_string().len(), 3073);
    invalid(block_on(actions.send(1, &too_large, "edge")), "payload");
    for (chat, text, id) in cases {
        assert_eq!(
            block_on(actions.send(chat, &text, &id)).unwrap(),
            json!({"accepted":true})
        );
    }
    assert_eq!(block_on(actions.interrupt(MAX_CHAT)).unwrap(), json!(true));
    client.disconnect();
    worker.join().unwrap();
}

#[test]
fn dropped_action_waiter_does_not_cancel_or_replay_the_submitted_send() {
    let (received_tx, received_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let (guard, worker) = action_server(move |peer| {
        let send = peer.request("chat:send");
        assert_eq!(send["args"], send_args(1, "submitted", "once"));
        received_tx.send(()).unwrap();
        release_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        peer.reply(&send, json!({"accepted":true}));
        let interrupt = peer.request("agent:interrupt");
        peer.reply(&interrupt, json!({"requested":true}));
        let read = peer.request("project:current");
        peer.reply(&read, json!({"path":PROJECT}));
        peer.closed();
    });
    let (client, _, _) = connect(&guard);
    let actions = guard.scripted_actions(&client).unwrap();
    // An unpolled future submits nothing.
    drop(actions.send(1, "never polled", "none"));
    let mut pending = Box::pin(actions.send(1, "submitted", "once"));
    assert!(pending.as_mut().now_or_never().is_none());
    received_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    drop(pending);
    release_tx.send(()).unwrap();
    assert_eq!(
        block_on(actions.interrupt(1)).unwrap(),
        json!({"requested":true})
    );
    assert_eq!(block_on(client.project_current()).unwrap()["path"], PROJECT);
    client.disconnect();
    worker.join().unwrap();
}

#[test]
fn pending_actions_and_capability_clones_do_not_keep_the_last_client_alive() {
    for explicit_disconnect in [false, true] {
        let (received_tx, received_rx) = mpsc::channel();
        let (guard, worker) = action_server(move |peer| {
            let _send = peer.request("chat:send");
            received_tx.send(()).unwrap();
            peer.closed();
        });
        let (client, _, mut notices) = connect(&guard);
        let actions = guard.scripted_actions(&client).unwrap();
        let cloned_actions = actions.clone();
        let mut pending = Box::pin(actions.send(1, "pending", "id"));
        assert!(pending.as_mut().now_or_never().is_none());
        received_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        if explicit_disconnect {
            client.disconnect();
        }
        drop(client);
        assert_eq!(block_on(pending), Err(Error::Disconnected));
        assert_eq!(
            block_on(notices.next()),
            Some(Notice::Closed(Error::Disconnected))
        );
        assert_eq!(
            block_on(cloned_actions.interrupt(1)),
            Err(Error::Disconnected)
        );
        assert_eq!(
            block_on(cloned_actions.send(1, "again", "id2")),
            Err(Error::Disconnected)
        );
        worker.join().unwrap();
        assert_eq!(
            guard.project(),
            PROJECT,
            "the guard authority outlives the connection"
        );
    }
}

#[test]
fn an_old_action_capability_cannot_follow_an_explicit_reconnection() {
    let (first_client, first_server) = UnixStream::pair().unwrap();
    let (second_client, second_server) = UnixStream::pair().unwrap();
    let connects = Arc::new(AtomicUsize::new(0));
    let calls = connects.clone();
    let streams = Mutex::new(std::collections::VecDeque::from([
        first_client,
        second_client,
    ]));
    let guard = FixtureGuard {
        authority: Arc::new(Authority {
            launcher: None,
            project: PROJECT.into(),
            pid: PID,
            connect: Box::new(move || {
                calls.fetch_add(1, Ordering::AcqRel);
                streams
                    .lock()
                    .unwrap()
                    .pop_front()
                    .ok_or(Error::Disconnected)
            }),
        }),
    };
    let first = thread::spawn(move || {
        let mut peer = Peer::new(first_server);
        handshake(&mut peer, ACTIONS);
        peer.closed();
    });
    let (client, _, _) = connect(&guard);
    let old = guard.scripted_actions(&client).unwrap();
    drop(client);
    first.join().unwrap();
    assert_eq!(
        block_on(old.send(1, "stale", "old")),
        Err(Error::Disconnected)
    );
    assert_eq!(
        connects.load(Ordering::Acquire),
        1,
        "actions never reconnect"
    );
    let second = thread::spawn(move || {
        let mut peer = Peer::new(second_server);
        handshake(&mut peer, ACTIONS);
        let request = peer.request("chat:send");
        assert_eq!(request["args"], send_args(1, "fresh", "new"));
        peer.reply(&request, json!({"accepted":true}));
        peer.closed();
    });
    let (client, _, _) = connect(&guard);
    assert_eq!(block_on(old.interrupt(1)), Err(Error::Disconnected));
    let fresh = guard.scripted_actions(&client).unwrap();
    block_on(fresh.send(1, "fresh", "new")).unwrap();
    assert_eq!(connects.load(Ordering::Acquire), 2);
    client.disconnect();
    second.join().unwrap();
}

use super::*;

fn event(peer: &mut Peer, seq: u64, channel: &str, payload: Value) {
    peer.send(json!({"v":1,"event":{"seq":seq,"channel":channel,"payload":payload}}));
}
fn oversized(peer: &mut Peer, seq: u64) {
    event(
        peer,
        seq,
        "project:state",
        json!({"path":PROJECT,"stateTooLarge":true}),
    );
}
fn accept(client: &Client) {
    block_on(async {
        let snapshot = client.runtime_snapshot().await.unwrap();
        client.accept_snapshot(&snapshot).await.unwrap();
    });
}
fn hydration_read(peer: &mut Peer) -> Value {
    let request = peer.request("project:read");
    assert_eq!(request["args"], json!([PROJECT,{"state":true}]));
    request
}

#[test]
fn covered_oversized_events_need_no_read_and_new_capture_keeps_receipt_barrier() {
    let (guard, worker) = server(|peer| {
        let capture = peer.request("daemon:snapshot");
        oversized(peer, 1);
        peer.reply(&capture, json!({"snapshotId":9,"pageCount":1,"eventSeq":1}));
        let page = peer.request("daemon:snapshot-page");
        oversized(peer, 2);
        peer.reply(&page, json!(json!({"eventSeq":1}).to_string()));
        // Even after capture completes, no hydration runs until its receipt is accepted.
        peer.snapshot(2);
        peer.event(3, json!({"text":"after both captures"}));
        peer.closed();
    });
    let (client, _, mut notices) = connect(&guard);
    let first = block_on(client.runtime_snapshot()).unwrap();
    assert!(notices.next().now_or_never().is_none());
    let second = block_on(client.runtime_snapshot()).unwrap();
    assert_eq!(
        block_on(client.accept_snapshot(&first)),
        Err(Error::StaleSnapshot)
    );
    assert!(notices.next().now_or_never().is_none());
    block_on(client.accept_snapshot(&second)).unwrap();
    assert!(matches!(
        block_on(notices.next()),
        Some(Notice::Event { wire_seq: 3, .. })
    ));
    client.disconnect();
    worker.join().unwrap();
}

#[test]
fn hydration_preserves_global_order_paging_and_rereads_full_states_arriving_during_read() {
    let (second_tx, second_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let (guard, worker) = server(move |peer| {
        peer.snapshot(0);
        let runs = peer.request("chat:runs");
        oversized(peer, 1);
        peer.event(2, json!({"chatId":"/foreign#9","text":"untouched"}));
        event(
            peer,
            3,
            "project:state",
            json!({"path":PROJECT,"state":{"revision":3},"extra":"retained"}),
        );
        peer.send(json!({"v":1,"id":runs["id"],"pages":{"pageId":8,"pageCount":1}}));
        let page = peer.request("daemon:result-page");
        assert_eq!(page["args"], json!([8, 0]));
        event(
            peer,
            4,
            "agent:done",
            json!({"chatId":format!("{PROJECT}#1"),"stateTooLarge":true,"reason":"done","seq":999}),
        );
        event(
            peer,
            5,
            "project:state",
            json!({"path":"/foreign","state":{"revision":5}}),
        );
        peer.reply(&page, json!(json!({"runs":{},"seq":20}).to_string()));
        let read = hydration_read(peer);
        peer.send(json!({"v":1,"id":read["id"],"pages":{"pageId":"hydration","pageCount":2}}));
        let page = peer.request("daemon:result-page");
        assert_eq!(page["args"], json!(["hydration", 0]));
        event(
            peer,
            6,
            "project:state",
            json!({"path":PROJECT,"state":{"revision":6},"extra":"later"}),
        );
        peer.event(7, json!({"text":"last"}));
        let body = json!({"path":PROJECT,"state":{"revision":12}}).to_string();
        let middle = body.len() / 2;
        peer.reply(&page, json!(&body[..middle]));
        let page = peer.request("daemon:result-page");
        assert_eq!(page["args"], json!(["hydration", 1]));
        peer.reply(&page, json!(&body[middle..]));
        let read = hydration_read(peer);
        second_tx.send(()).unwrap();
        release_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        peer.reply(&read, json!({"path":PROJECT,"state":{"revision":13}}));
        peer.closed();
    });
    let (client, _, mut notices) = connect(&guard);
    accept(&client);
    assert_eq!(block_on(client.chat_runs()).unwrap().seq, 20);
    second_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    for seq in 1..=5 {
        let Some(Notice::Event {
            wire_seq,
            scope,
            channel,
            payload,
        }) = block_on(notices.next())
        else {
            panic!("event missing")
        };
        assert_eq!(wire_seq, seq);
        match seq {
            1 | 3 | 4 => {
                assert_eq!(scope.as_deref(), Some(PROJECT));
                assert_eq!(payload["state"]["revision"], 12);
                assert!(payload.get("stateTooLarge").is_none());
                if seq == 3 {
                    assert_eq!(payload["extra"], "retained");
                }
                if seq == 4 {
                    assert_eq!(channel, "agent:done");
                    assert_eq!(payload["reason"], "done");
                    assert_eq!(payload["seq"], 999);
                }
            }
            2 => {
                assert_eq!(payload["text"], "untouched");
                assert!(payload.get("state").is_none());
            }
            5 => assert_eq!(payload["state"]["revision"], 5),
            _ => unreachable!(),
        }
    }
    assert!(notices.next().now_or_never().is_none());
    release_tx.send(()).unwrap();
    assert!(
        matches!(block_on(notices.next()),Some(Notice::Event{wire_seq:6,payload,..}) if payload["state"]["revision"]==13 && payload["extra"]=="later")
    );
    assert!(matches!(
        block_on(notices.next()),
        Some(Notice::Event { wire_seq: 7, .. })
    ));
    client.disconnect();
    worker.join().unwrap();
}

#[test]
fn hydration_failure_is_terminal_and_keeps_original_error() {
    for failure in 0..4 {
        let (guard, worker) = server(move |peer| {
            peer.snapshot(0);
            let runs = peer.request("chat:runs");
            oversized(peer, 1);
            peer.reply(&runs, json!({"runs":{},"seq":0}));
            let read = hydration_read(peer);
            match failure {
                0 => peer.send(json!({"v":1,"id":read["id"],"error":{"code":"READ_FAILED","message":"denied","detail":7}})),
                1 => peer.reply(&read,json!({"path":"/foreign","state":{}})),
                2 => peer.reply(&read,json!({"path":PROJECT,"state":null})),
                3 => {}, // Deadline closes the socket; no retry or late result publication.
                _ => unreachable!(),
            }
            peer.closed();
        });
        let (client, _, mut notices) = block_on(Client::connect(
            guard.endpoint(),
            ClientOptions {
                request_timeout: Duration::from_millis(250),
                ..ClientOptions::default()
            },
        ))
        .unwrap();
        accept(&client);
        block_on(client.chat_runs()).unwrap();
        let Some(Notice::Closed(error)) = block_on(notices.next()) else {
            panic!("terminal notice missing")
        };
        match failure {
            0 => assert!(
                matches!(error,Error::Remote {code,payload,..} if code=="READ_FAILED" && payload["detail"]==7)
            ),
            1 | 2 => assert!(matches!(error, Error::Protocol { .. })),
            3 => assert_eq!(error, Error::TimedOut { submitted: true }),
            _ => unreachable!(),
        }
        assert_eq!(block_on(notices.next()), None);
        assert_eq!(block_on(client.chat_runs()), Err(Error::Disconnected));
        worker.join().unwrap();
    }
}

#[test]
fn hydration_expansion_is_atomic_and_frozen_batch_remains_charged() {
    for incoming_overflow in [false, true] {
        let (guard, worker) = server(move |peer| {
            peer.snapshot(0);
            let runs = peer.request("chat:runs");
            oversized(peer, 1);
            oversized(peer, 2);
            peer.reply(&runs, json!({"runs":{},"seq":0}));
            let read = hydration_read(peer);
            if incoming_overflow {
                peer.event(3, json!({"text":"exceeds frozen count"}));
            } else {
                peer.reply(
                    &read,
                    json!({"path":PROJECT,"state":{"text":"x".repeat(350)}}),
                );
            }
            peer.closed();
        });
        let options = ClientOptions {
            max_notification_events: 2,
            max_notification_bytes: 700,
            ..ClientOptions::default()
        };
        let (client, _, mut notices) =
            block_on(Client::connect(guard.endpoint(), options)).unwrap();
        accept(&client);
        block_on(client.chat_runs()).unwrap();
        assert!(
            matches!(block_on(notices.next()),Some(Notice::Closed(Error::Protocol{message})) if message.contains("overflow"))
        );
        assert_eq!(block_on(notices.next()), None);
        worker.join().unwrap();
    }
}

#[test]
fn unsupported_hydration_scope_closes_without_foreign_read() {
    let (guard, worker) = server(|peer| {
        peer.snapshot(0);
        let runs = peer.request("chat:runs");
        event(
            peer,
            1,
            "link:state",
            json!({"linkId":"foreign","stateTooLarge":true}),
        );
        peer.reply(&runs, json!({"runs":{},"seq":0}));
        peer.closed();
    });
    let (client, _, mut notices) = connect(&guard);
    accept(&client);
    block_on(client.chat_runs()).unwrap();
    assert_eq!(
        block_on(notices.next()),
        Some(Notice::Closed(Error::StateTooLarge {
            hydration: Some(Hydration {
                scope: "milagre-link:foreign".into(),
                method: "project:read".into()
            })
        }))
    );
    worker.join().unwrap();
}

#[test]
fn worker_panic_wakes_notifications_and_closes_socket_once() {
    use std::{
        future::Future,
        task::{Context, Wake, Waker},
    };
    struct PanicWake;
    impl Wake for PanicWake {
        fn wake(self: Arc<Self>) {
            panic!("injected caller wake panic");
        }
    }
    let (release_tx, release_rx) = mpsc::channel();
    let (guard, worker) = server(move |peer| {
        peer.snapshot(0);
        let runs = peer.request("chat:runs");
        release_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        peer.reply(&runs, json!({"runs":{},"seq":0}));
        peer.closed();
    });
    let (client, _, mut notices) = connect(&guard);
    accept(&client);
    let mut read = Box::pin(client.chat_runs());
    let wake = Waker::from(Arc::new(PanicWake));
    assert!(read
        .as_mut()
        .poll(&mut Context::from_waker(&wake))
        .is_pending());
    assert!(notices.next().now_or_never().is_none());
    release_tx.send(()).unwrap();
    assert_eq!(
        block_on(notices.next()),
        Some(Notice::Closed(Error::Disconnected))
    );
    assert_eq!(block_on(notices.next()), None);
    assert_eq!(block_on(client.chat_runs()), Err(Error::Disconnected));
    worker.join().unwrap();
}

#[test]
fn uncovered_capture_marker_waits_for_accept_before_hydration() {
    let (guard, worker) = server(|peer| {
        let capture = peer.request("daemon:snapshot");
        oversized(peer, 1);
        peer.reply(&capture, json!({"snapshotId":9,"pageCount":1,"eventSeq":1}));
        let page = peer.request("daemon:snapshot-page");
        oversized(peer, 2);
        peer.reply(&page, json!(json!({"eventSeq":1}).to_string()));
        // A caller read sent before accepting the receipt still runs first.
        let runs = peer.request("chat:runs");
        peer.reply(&runs, json!({"runs":{},"seq":900}));
        let read = hydration_read(peer);
        peer.reply(&read, json!({"path":PROJECT,"state":{"after":2}}));
        peer.closed();
    });
    let (client, _, mut notices) = connect(&guard);
    let snapshot = block_on(client.runtime_snapshot()).unwrap();
    assert!(notices.next().now_or_never().is_none());
    assert_eq!(block_on(client.chat_runs()).unwrap().seq, 900);
    assert!(notices.next().now_or_never().is_none());
    block_on(client.accept_snapshot(&snapshot)).unwrap();
    assert!(
        matches!(block_on(notices.next()),Some(Notice::Event{wire_seq:2,payload,..}) if payload["state"]["after"]==2)
    );
    client.disconnect();
    worker.join().unwrap();
}

#[test]
fn failed_capture_keeps_oversized_events_held_until_a_fresh_receipt() {
    let (guard, worker) = server(|peer| {
        let capture = peer.request("daemon:snapshot");
        oversized(peer, 1);
        peer.send(json!({"v":1,"id":capture["id"],"error":{"code":"CAPTURE_FAILED","message":"retry explicitly"}}));
        peer.snapshot(1);
        peer.event(2, json!({"text":"after fresh receipt"}));
        peer.closed();
    });
    let (client, _, mut notices) = connect(&guard);
    assert!(matches!(
        block_on(client.runtime_snapshot()),
        Err(Error::Remote { .. })
    ));
    assert!(notices.next().now_or_never().is_none());
    accept(&client);
    assert!(matches!(
        block_on(notices.next()),
        Some(Notice::Event { wire_seq: 2, .. })
    ));
    client.disconnect();
    worker.join().unwrap();
}

#[test]
fn hydration_missing_method_and_paged_timeout_are_terminal() {
    for missing_method in [false, true] {
        let (guard, mut peer) = pair();
        let worker = thread::spawn(move || {
            let hello = peer.request("daemon:status");
            let mut advertised = status();
            if missing_method {
                advertised["methods"]
                    .as_array_mut()
                    .unwrap()
                    .retain(|m| m != "project:read");
            }
            peer.reply(&hello, advertised);
            peer.snapshot(0);
            let runs = peer.request("chat:runs");
            oversized(&mut peer, 1);
            peer.reply(&runs, json!({"runs":{},"seq":0}));
            if !missing_method {
                let read = hydration_read(&mut peer);
                peer.send(json!({"v":1,"id":read["id"],"pages":{"pageId":4,"pageCount":1}}));
                peer.request("daemon:result-page");
            }
            peer.closed();
        });
        let (client, _, mut notices) = block_on(Client::connect(
            guard.endpoint(),
            ClientOptions {
                request_timeout: Duration::from_millis(250),
                ..ClientOptions::default()
            },
        ))
        .unwrap();
        accept(&client);
        block_on(client.chat_runs()).unwrap();
        let expected = if missing_method {
            Error::Capability {
                required: "method:project:read".into(),
            }
        } else {
            Error::TimedOut { submitted: true }
        };
        assert_eq!(block_on(notices.next()), Some(Notice::Closed(expected)));
        assert_eq!(block_on(notices.next()), None);
        worker.join().unwrap();
    }
}

#[test]
fn disconnect_during_hydration_never_releases_its_suffix() {
    let (started_tx, started_rx) = mpsc::channel();
    let (guard, worker) = server(move |peer| {
        peer.snapshot(0);
        let runs = peer.request("chat:runs");
        peer.event(1, json!({"text":"released prefix"}));
        oversized(peer, 2);
        peer.event(3, json!({"text":"blocked suffix"}));
        peer.reply(&runs, json!({"runs":{},"seq":0}));
        hydration_read(peer);
        started_tx.send(()).unwrap();
        peer.closed();
    });
    let (client, _, mut notices) = connect(&guard);
    accept(&client);
    block_on(client.chat_runs()).unwrap();
    started_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    client.disconnect();
    assert!(matches!(
        block_on(notices.next()),
        Some(Notice::Event { wire_seq: 1, .. })
    ));
    assert_eq!(
        block_on(notices.next()),
        Some(Notice::Closed(Error::Disconnected))
    );
    assert_eq!(block_on(notices.next()), None);
    worker.join().unwrap();
}

#[test]
fn hydration_serialized_byte_boundary_counts_replacements_and_escaped_fields_exactly() {
    let state = json!({"quoted\"key":"slash\\\n unicode ä😀", "padding":"x".repeat(128)});
    let payloads = [
        json!({"path":PROJECT,"stateTooLarge":true,"extra\"\\":"line\nquote\""}),
        json!({"path":PROJECT,"state":{"old":"value\"\\"},"extra":"ä😀"}),
    ];
    let mut expected = Vec::new();
    let wire_bytes = |seq, payload: &Value| {
        json!({"seq":seq,"channel":"project:state","payload":payload})
            .to_string()
            .len()
    };
    let limit: usize = payloads
        .iter()
        .enumerate()
        .map(|(index, payload)| {
            let mut payload = payload.clone();
            let object = payload.as_object_mut().unwrap();
            object.remove("stateTooLarge");
            object.remove("state");
            object.insert("state".into(), state.clone());
            let bytes = wire_bytes(index + 1, &payload);
            expected.push(payload);
            bytes
        })
        .sum();
    for fits in [true, false] {
        let options = ClientOptions {
            max_notification_bytes: limit - usize::from(!fits),
            ..ClientOptions::default()
        };
        let queue = notify::Queue::new(&options);
        let mut notices = Notifications {
            queue: queue.clone(),
        };
        for (index, payload) in payloads.iter().enumerate() {
            queue
                .push(
                    Notice::Event {
                        wire_seq: index as u64 + 1,
                        scope: Some(PROJECT.into()),
                        channel: "project:state".into(),
                        payload: payload.clone(),
                    },
                    wire_bytes(index + 1, payload),
                )
                .unwrap();
        }
        queue.release(0);
        let batch = queue.hydration().unwrap();
        let result = queue.hydrated(batch, state.clone());
        if fits {
            result.unwrap();
            for (index, payload) in expected.iter().enumerate() {
                assert_eq!(
                    block_on(notices.next()),
                    Some(Notice::Event {
                        wire_seq: index as u64 + 1,
                        scope: Some(PROJECT.into()),
                        channel: "project:state".into(),
                        payload: payload.clone()
                    })
                );
            }
            // Consuming both expanded envelopes returns every charged byte.
            queue
                .push(
                    Notice::Event {
                        wire_seq: 3,
                        scope: None,
                        channel: "probe".into(),
                        payload: json!(null),
                    },
                    limit,
                )
                .unwrap();
        } else {
            let error = result.unwrap_err();
            assert!(matches!(error, Error::Protocol { .. }));
            assert!(notices.next().now_or_never().is_none());
            queue.close(error.clone());
            assert_eq!(block_on(notices.next()), Some(Notice::Closed(error)));
        }
    }
}

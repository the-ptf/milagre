use super::*;
use futures::{executor::block_on, FutureExt};
use serde_json::json;
use std::{
    io::{BufRead, BufReader, Write},
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc, Mutex,
    },
    thread,
};

const PROJECT: &str = "/synthetic-owned-fixture/fixture";
const PID: u32 = 12345;
const METHODS: &[&str] = &[
    "daemon:status",
    "daemon:snapshot",
    "daemon:snapshot-page",
    "daemon:result-page",
    "project:current",
    "project:read",
    "project:open",
    "state:read",
    "chat:runs",
    "chat:messages",
];

struct Peer {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}
impl Peer {
    fn new(stream: UnixStream) -> Self {
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        Self {
            reader: BufReader::new(stream.try_clone().unwrap()),
            writer: stream,
        }
    }
    fn request(&mut self, method: &str) -> Value {
        let mut line = String::new();
        assert!(self.reader.read_line(&mut line).unwrap() > 0);
        let frame: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(frame["v"], 1);
        assert_eq!(frame["method"], method);
        assert_eq!(frame["pages"], true);
        frame
    }
    fn send(&mut self, frame: Value) {
        writeln!(self.writer, "{frame}").unwrap();
    }
    fn reply(&mut self, request: &Value, value: Value) {
        self.send(json!({"v":1,"id":request["id"],"result":value}));
    }
    fn event(&mut self, seq: u64, payload: Value) {
        self.send(json!({"v":1,"event":{"seq":seq,"channel":"chat:event","payload":payload}}));
    }
    fn handshake(&mut self) {
        let request = self.request("daemon:status");
        assert_eq!(request["args"], json!([]));
        self.reply(&request, status());
    }
    fn snapshot(&mut self, watermark: u64) {
        let request = self.request("daemon:snapshot");
        assert_eq!(request["args"], json!([{"paged":true}]));
        self.reply(
            &request,
            json!({"snapshotId":9,"pageCount":1,"eventSeq":watermark}),
        );
        let page = self.request("daemon:snapshot-page");
        assert_eq!(page["args"], json!([9, 0]));
        self.reply(
            &page,
            json!(json!({"eventSeq":watermark,"runs":{"runs":{},"seq":900}}).to_string()),
        );
    }
    fn closed(&mut self) {
        let mut line = String::new();
        assert_eq!(
            self.reader.read_line(&mut line).unwrap(),
            0,
            "unexpected extra request: {line}"
        );
    }
}
fn status() -> Value {
    json!({"pid":PID,"protocolVersion":1,"closing":false,"capabilities":["snapshot-pages-v1","result-pages-v1"],"methods":METHODS})
}
fn pair() -> (FixtureGuard, Peer) {
    let (client, server) = UnixStream::pair().unwrap();
    let connection = Mutex::new(Some(client));
    let authority = Arc::new(Authority {
        launcher: None,
        project: PROJECT.into(),
        pid: PID,
        connect: Box::new(move || connection.lock().unwrap().take().ok_or(Error::Disconnected)),
    });
    (FixtureGuard { authority }, Peer::new(server))
}
fn server(run: impl FnOnce(&mut Peer) + Send + 'static) -> (FixtureGuard, thread::JoinHandle<()>) {
    let (guard, mut peer) = pair();
    let worker = thread::spawn(move || {
        peer.handshake();
        run(&mut peer);
    });
    (guard, worker)
}
fn connect(guard: &FixtureGuard) -> (Client, Hello, Notifications) {
    block_on(Client::connect(guard.endpoint(), ClientOptions::default())).unwrap()
}

#[test]
fn facade_preserves_exact_read_shapes_and_has_no_caller_runtime() {
    let (guard, worker) = server(|peer| {
        let request = peer.request("project:current");
        assert_eq!(request["args"], json!([]));
        peer.reply(&request, json!({"path":PROJECT,"name":"fixture"}));
        let request = peer.request("project:read");
        assert_eq!(request["args"], json!([PROJECT,{"state":false}]));
        peer.reply(&request, json!({"path":PROJECT}));
        let request = peer.request("state:read");
        assert_eq!(request["args"], json!([PROJECT]));
        peer.reply(
            &request,
            json!({"state":{"sessions":[]},"version":17,"epoch":"e"}),
        );
        let request = peer.request("chat:runs");
        assert_eq!(request["args"], json!([]));
        peer.reply(&request, json!({"runs":{},"seq":91}));
        let request = peer.request("chat:messages");
        assert_eq!(
            request["args"],
            json!([PROJECT,2,{"before":123,"turns":2,"limit":9}])
        );
        peer.reply(&request, json!({"messages":[],"total":17,"hasMore":true,"before":100,"unknownMetadata":"preserved"}));
        let request = peer.request("project:open");
        assert_eq!(request["args"], json!([PROJECT]));
        peer.reply(&request, json!({"path":PROJECT,"recovered":true}));
        peer.closed();
    });
    let (client, hello, _) = connect(&guard);
    assert_eq!(hello.wire, 1);
    assert_eq!(hello.owner["pid"], PID);
    block_on(async {
        assert_eq!(client.project_current().await.unwrap()["name"], "fixture");
        assert!(client
            .project_read(PROJECT, false)
            .await
            .unwrap()
            .get("state")
            .is_none());
        assert_eq!(
            client.state_read(PROJECT).await.unwrap(),
            StateRead {
                state: json!({"sessions":[]}),
                version: json!(17),
                epoch: json!("e")
            }
        );
        assert_eq!(client.chat_runs().await.unwrap().seq, 91);
        let page = client
            .chat_messages(
                PROJECT,
                2,
                ChatPageOptions {
                    before: Some(123),
                    turns: Some(2),
                    limit: Some(9),
                },
            )
            .await
            .unwrap();
        assert_eq!(page["unknownMetadata"], "preserved");
        assert_eq!(page["total"], 17);
        assert_eq!(client.open_view(PROJECT).await.unwrap()["recovered"], true);
        assert_eq!(
            client.project_read("/foreign", true).await,
            Err(Error::InvalidScope)
        );
        assert_eq!(
            client.state_read("milagre-link:foreign").await,
            Err(Error::InvalidScope)
        );
        assert!(matches!(
            client
                .chat_messages(PROJECT, u64::MAX, ChatPageOptions::default())
                .await,
            Err(Error::Protocol { .. })
        ));
    });
    client.disconnect();
    worker.join().unwrap();
}

#[test]
fn result_pages_accept_numeric_and_string_ids_and_keep_metadata() {
    let (guard, worker) = server(|peer| {
        for id in [json!(8), json!("opaque-page")] {
            let request = peer.request("chat:messages");
            assert_eq!(request["args"], json!([PROJECT, 1, {}]));
            peer.send(json!({"v":1,"id":request["id"],"pages":{"pageId":id,"pageCount":2}}));
            for (index, text) in [
                "{\"messages\":[\"a",
                "🧪\u{2028}b\"],\"total\":1,\"cursor\":7}",
            ]
            .into_iter()
            .enumerate()
            {
                let request = peer.request("daemon:result-page");
                assert_eq!(request["args"], json!([id, index]));
                peer.reply(&request, json!(text));
            }
        }
        peer.closed();
    });
    let (client, _, _) = connect(&guard);
    for _ in 0..2 {
        let body = block_on(client.chat_messages(PROJECT, 1, ChatPageOptions::default())).unwrap();
        assert_eq!(
            body,
            json!({"messages":["a🧪\u{2028}b"],"total":1,"cursor":7})
        );
    }
    client.disconnect();
    worker.join().unwrap();
}

#[test]
fn snapshot_ack_is_explicit_and_uses_global_wire_sequence() {
    let (guard, worker) = server(|peer| {
        peer.event(1, json!({"chatId":format!("{PROJECT}#1"),"seq":800}));
        let request = peer.request("daemon:snapshot");
        peer.reply(
            &request,
            json!({"snapshotId":"snapshot","pageCount":2,"eventSeq":5}),
        );
        let page = peer.request("daemon:snapshot-page");
        peer.reply(&page, json!("{\"eventSeq\":5,\"runs\":"));
        peer.event(6, json!({"chatId":format!("{PROJECT}#1"),"seq":2}));
        let page = peer.request("daemon:snapshot-page");
        peer.reply(&page, json!("{\"seq\":900,\"runs\":{}}}"));
        peer.closed();
    });
    let (client, _, mut events) = connect(&guard);
    block_on(async {
        let snapshot = client.runtime_snapshot().await.unwrap();
        assert_eq!(snapshot.body["runs"]["seq"], 900);
        assert!(events.next().now_or_never().is_none());
        let mut altered = snapshot.clone();
        altered.event_seq = 900;
        assert_eq!(
            client.accept_snapshot(&altered).await,
            Err(Error::StaleSnapshot)
        );
        client.accept_snapshot(&snapshot).await.unwrap();
        assert_eq!(
            events.next().await,
            Some(Notice::Event {
                wire_seq: 6,
                scope: Some(PROJECT.into()),
                channel: "chat:event".into(),
                payload: json!({"chatId":format!("{PROJECT}#1"),"seq":2})
            })
        );
        assert_eq!(client.accept_snapshot(&snapshot).await, Ok(()));
    });
    client.disconnect();
    worker.join().unwrap();
}

#[test]
fn newer_and_foreign_snapshot_receipts_cannot_release_an_older_barrier() {
    let (guard, worker) = server(|peer| {
        peer.snapshot(2);
        peer.snapshot(3);
        peer.closed();
    });
    let (other_guard, other_worker) = server(|peer| {
        peer.closed();
    });
    let (client, _, _) = connect(&guard);
    let (other, _, _) = connect(&other_guard);
    block_on(async {
        let first = client.runtime_snapshot().await.unwrap();
        let second = client.runtime_snapshot().await.unwrap();
        assert_eq!(
            client.accept_snapshot(&first).await,
            Err(Error::StaleSnapshot)
        );
        assert_eq!(
            other.accept_snapshot(&second).await,
            Err(Error::StaleSnapshot)
        );
        client.accept_snapshot(&second).await.unwrap();
    });
    client.disconnect();
    other.disconnect();
    worker.join().unwrap();
    other_worker.join().unwrap();
}

#[test]
fn regressing_snapshot_watermark_closes_the_connection() {
    let (guard, worker) = server(|peer| {
        peer.snapshot(9);
        peer.snapshot(8);
        peer.closed();
    });
    let (client, _, mut events) = connect(&guard);
    block_on(async {
        let first = client.runtime_snapshot().await.unwrap();
        client.accept_snapshot(&first).await.unwrap();
        assert!(matches!(
            client.runtime_snapshot().await,
            Err(Error::Protocol { .. })
        ));
        assert!(matches!(
            events.next().await,
            Some(Notice::Closed(Error::Protocol { .. }))
        ));
        assert_eq!(events.next().await, None);
    });
    worker.join().unwrap();
}

#[test]
fn dropping_a_future_keeps_its_submitted_request_and_never_replays() {
    let (received_tx, received_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let (guard, worker) = server(move |peer| {
        let first = peer.request("project:current");
        received_tx.send(()).unwrap();
        release_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        peer.reply(&first, json!({"path":PROJECT}));
        let second = peer.request("chat:runs");
        peer.reply(&second, json!({"runs":{},"seq":7}));
        peer.closed();
    });
    let (client, _, _) = connect(&guard);
    let mut pending = Box::pin(client.project_current());
    assert!(pending.as_mut().now_or_never().is_none());
    received_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    drop(pending);
    release_tx.send(()).unwrap();
    assert_eq!(block_on(client.chat_runs()).unwrap().seq, 7);
    client.disconnect();
    worker.join().unwrap();
}

#[test]
fn request_bound_includes_queued_active_and_abandoned_local_waits() {
    let (received_tx, received_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let (guard, worker) = server(move |peer| {
        let first = peer.request("chat:runs");
        received_tx.send(()).unwrap();
        release_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        peer.reply(&first, json!({"runs":{},"seq":1}));
        let second = peer.request("chat:runs");
        peer.reply(&second, json!({"runs":{},"seq":2}));
        peer.closed();
    });
    let (client, _, _) = block_on(Client::connect(
        guard.endpoint(),
        ClientOptions {
            max_pending: 2,
            ..ClientOptions::default()
        },
    ))
    .unwrap();
    let mut first = Box::pin(client.chat_runs());
    assert!(first.as_mut().now_or_never().is_none());
    received_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    let mut second = Box::pin(client.chat_runs());
    assert!(second.as_mut().now_or_never().is_none());
    assert_eq!(block_on(client.chat_runs()), Err(Error::Busy));
    drop(first);
    assert_eq!(block_on(client.chat_runs()), Err(Error::Busy));
    release_tx.send(()).unwrap();
    assert_eq!(block_on(second).unwrap().seq, 2);
    client.disconnect();
    worker.join().unwrap();
}

#[test]
fn timeout_ignores_the_late_reply_without_replaying_or_cancelling() {
    let (release_tx, release_rx) = mpsc::channel();
    let (guard, worker) = server(move |peer| {
        let first = peer.request("chat:runs");
        release_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        peer.reply(&first, json!({"runs":{},"seq":1}));
        let second = peer.request("chat:runs");
        peer.reply(&second, json!({"runs":{},"seq":2}));
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
    assert_eq!(
        block_on(client.chat_runs()),
        Err(Error::TimedOut { submitted: true })
    );
    release_tx.send(()).unwrap();
    assert_eq!(block_on(client.chat_runs()).unwrap().seq, 2);
    client.disconnect();
    worker.join().unwrap();
}

#[test]
fn remote_errors_keep_code_message_and_payload_without_partial_results() {
    let (guard, worker) = server(|peer| {
        let request = peer.request("chat:runs");
        peer.send(json!({"v":1,"id":request["id"],"error":{"code":"PROJECT_NOT_READY","message":"fixture unavailable","detail":{"retry":false}}}));
        peer.closed();
    });
    let (client, _, _) = connect(&guard);
    assert_eq!(
        block_on(client.chat_runs()),
        Err(Error::Remote {
            code: "PROJECT_NOT_READY".into(),
            message: "fixture unavailable".into(),
            payload: json!({"code":"PROJECT_NOT_READY","message":"fixture unavailable","detail":{"retry":false}})
        })
    );
    client.disconnect();
    worker.join().unwrap();
}

#[test]
fn negotiation_rejects_wrong_owner_and_missing_capabilities() {
    for kind in ["pid", "capabilities", "protocolVersion"] {
        let (guard, mut peer) = pair();
        let worker = thread::spawn(move || {
            let request = peer.request("daemon:status");
            let mut value = status();
            value[kind] = match kind {
                "pid" => json!(PID + 1),
                "capabilities" => json!(["result-pages-v1"]),
                _ => json!(2),
            };
            peer.reply(&request, value);
            peer.closed();
        });
        let result = block_on(Client::connect(guard.endpoint(), ClientOptions::default()));
        assert!(matches!(
            result,
            Err(Error::Capability { .. }) | Err(Error::Protocol { .. })
        ));
        worker.join().unwrap();
    }
}

#[test]
fn absent_method_is_refused_without_sending_an_rpc() {
    let (guard, mut peer) = pair();
    let worker = thread::spawn(move || {
        let request = peer.request("daemon:status");
        let mut value = status();
        value["methods"] = json!(["daemon:snapshot"]);
        peer.reply(&request, value);
        peer.closed();
    });
    let (client, _, _) = connect(&guard);
    assert_eq!(
        block_on(client.chat_runs()),
        Err(Error::Capability {
            required: "method:chat:runs".into()
        })
    );
    client.disconnect();
    worker.join().unwrap();
}

#[test]
fn held_notification_overflow_is_terminal_and_visible() {
    for bytes in [false, true] {
        let (guard, worker) = server(move |peer| {
            let _request = peer.request("chat:runs");
            peer.event(1, json!({"text":"x".repeat(150)}));
            if !bytes {
                peer.event(2, json!({}));
            }
            peer.closed();
        });
        let options = ClientOptions {
            max_notification_events: 1,
            max_notification_bytes: if bytes { 100 } else { 4096 },
            ..ClientOptions::default()
        };
        let (client, _, mut events) = block_on(Client::connect(guard.endpoint(), options)).unwrap();
        assert!(matches!(
            block_on(client.chat_runs()),
            Err(Error::Protocol { .. })
        ));
        assert!(matches!(
            block_on(events.next()),
            Some(Notice::Closed(Error::Protocol { .. }))
        ));
        assert_eq!(block_on(events.next()), None);
        worker.join().unwrap();
    }
}

#[test]
fn oversized_state_event_reports_required_hydration_and_closes() {
    let (guard, worker) = server(|peer| {
        let _request = peer.request("chat:runs");
        peer.send(json!({"v":1,"event":{"seq":1,"channel":"project:state","payload":{"path":PROJECT,"stateTooLarge":true}}}));
        peer.closed();
    });
    let (client, _, mut events) = connect(&guard);
    let expected = Error::StateTooLarge {
        hydration: Some(Hydration {
            scope: PROJECT.into(),
            method: "project:read".into(),
        }),
    };
    assert_eq!(block_on(client.chat_runs()), Err(expected.clone()));
    assert_eq!(block_on(events.next()), Some(Notice::Closed(expected)));
    worker.join().unwrap();
}

#[test]
fn invalid_pages_fail_closed_and_never_return_a_partial_body() {
    for malformed in [
        json!({"pageId":1,"pageCount":0}),
        json!({"pageId":0,"pageCount":1}),
        json!({"pageId":"p","pageCount":1025}),
    ] {
        let (guard, worker) = server(move |peer| {
            let request = peer.request("chat:runs");
            peer.send(json!({"v":1,"id":request["id"],"pages":malformed}));
            peer.closed();
        });
        let (client, _, _) = connect(&guard);
        assert!(matches!(
            block_on(client.chat_runs()),
            Err(Error::Protocol { .. })
        ));
        worker.join().unwrap();
    }
    let (guard, worker) = server(|peer| {
        let request = peer.request("chat:runs");
        peer.send(json!({"v":1,"id":request["id"],"pages":{"pageId":1,"pageCount":2}}));
        let page = peer.request("daemon:result-page");
        peer.reply(&page, json!("{"));
        let page = peer.request("daemon:result-page");
        peer.reply(&page, json!("x".repeat(32)));
        peer.closed();
    });
    let (client, _, _) = block_on(Client::connect(
        guard.endpoint(),
        ClientOptions {
            max_paged_bytes: 16,
            ..ClientOptions::default()
        },
    ))
    .unwrap();
    assert_eq!(
        block_on(client.chat_runs()),
        Err(Error::StateTooLarge { hydration: None })
    );
    worker.join().unwrap();
}

#[test]
fn exact_frame_boundary_and_fragmented_utf8_are_preserved() {
    for extra in [0, 1] {
        let (guard, worker) = server(move |peer| {
            let request = peer.request("project:current");
            let mut response = json!({"v":1,"id":request["id"],"result":{"path":PROJECT,"text":"🧪\u{2028}","padding":""}});
            let initial = response.to_string().len();
            response["result"]["padding"] = json!("x".repeat(1024 + extra - initial));
            let mut bytes = response.to_string().into_bytes();
            assert_eq!(bytes.len(), 1024 + extra);
            bytes.push(b'\n');
            for chunk in bytes.chunks(3) {
                peer.writer.write_all(chunk).unwrap();
            }
            peer.closed();
        });
        let (client, _, _) = block_on(Client::connect(
            guard.endpoint(),
            ClientOptions {
                max_frame_bytes: 1024,
                ..ClientOptions::default()
            },
        ))
        .unwrap();
        let result = block_on(client.project_current());
        if extra == 0 {
            assert_eq!(result.unwrap()["text"], "🧪\u{2028}");
            client.disconnect();
        } else {
            assert_eq!(result, Err(Error::StateTooLarge { hydration: None }));
        }
        worker.join().unwrap();
    }
}

#[test]
fn reconnect_is_explicit_and_uses_the_same_retained_guard() {
    let (first_client, first_server) = UnixStream::pair().unwrap();
    let (second_client, second_server) = UnixStream::pair().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
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
                count.fetch_add(1, Ordering::AcqRel);
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
        peer.handshake();
    });
    let (client, _, mut events) = connect(&guard);
    assert_eq!(
        block_on(events.next()),
        Some(Notice::Closed(Error::Disconnected))
    );
    first.join().unwrap();
    assert_eq!(calls.load(Ordering::Acquire), 1);
    let second = thread::spawn(move || {
        let mut peer = Peer::new(second_server);
        peer.handshake();
        let request = peer.request("project:open");
        peer.reply(&request, json!({"path":PROJECT}));
        peer.snapshot(4);
        peer.closed();
    });
    let (next, _, _) = connect(&guard);
    block_on(async {
        next.open_view(PROJECT).await.unwrap();
        let snapshot = next.runtime_snapshot().await.unwrap();
        next.accept_snapshot(&snapshot).await.unwrap();
    });
    assert_eq!(calls.load(Ordering::Acquire), 2);
    next.disconnect();
    second.join().unwrap();
    drop(client);
}

#[test]
fn live_overflow_keeps_the_released_prefix_then_one_terminal_error() {
    let (guard, worker) = server(|peer| {
        peer.snapshot(0);
        let _request = peer.request("chat:runs");
        peer.event(1, json!({"text":"first"}));
        peer.event(2, json!({"text":"overflow"}));
        peer.closed();
    });
    let (client, _, mut events) = block_on(Client::connect(
        guard.endpoint(),
        ClientOptions {
            max_notification_events: 1,
            ..ClientOptions::default()
        },
    ))
    .unwrap();
    block_on(async {
        let snapshot = client.runtime_snapshot().await.unwrap();
        client.accept_snapshot(&snapshot).await.unwrap();
        assert!(matches!(
            client.chat_runs().await,
            Err(Error::Protocol { .. })
        ));
        assert!(matches!(
            events.next().await,
            Some(Notice::Event { wire_seq: 1, .. })
        ));
        assert!(matches!(
            events.next().await,
            Some(Notice::Closed(Error::Protocol { .. }))
        ));
        assert_eq!(events.next().await, None);
    });
    worker.join().unwrap();
}

#[test]
fn malformed_wire_and_repeated_sequences_close_instead_of_delivering() {
    for kind in ["version", "future-id", "mixed", "sequence"] {
        let (guard, worker) = server(move |peer| {
            let request = peer.request("chat:runs");
            match kind {
                "version" => peer.send(json!({"v":2,"id":request["id"],"result":null})),
                "future-id" => peer.send(json!({"v":1,"id":999,"result":null})),
                "mixed" => peer.send(
                    json!({"v":1,"id":request["id"],"event":{"seq":1,"channel":"x","payload":{}}}),
                ),
                _ => {
                    peer.event(2, json!({}));
                    peer.event(2, json!({}));
                }
            }
            peer.closed();
        });
        let (client, _, mut events) = connect(&guard);
        assert!(matches!(
            block_on(client.chat_runs()),
            Err(Error::Protocol { .. })
        ));
        assert!(matches!(
            block_on(events.next()),
            Some(Notice::Closed(Error::Protocol { .. }))
        ));
        worker.join().unwrap();
    }
}

#[test]
fn terminal_failure_rejects_queued_requests_without_reporting_local_cancellation() {
    let (received_tx, received_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let (guard, worker) = server(move |peer| {
        let request = peer.request("chat:runs");
        received_tx.send(()).unwrap();
        release_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        peer.send(json!({"v":2,"id":request["id"],"result":null}));
        peer.closed();
    });
    let (client, _, _) = connect(&guard);
    let mut first = Box::pin(client.chat_runs());
    assert!(first.as_mut().now_or_never().is_none());
    received_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    let mut second = Box::pin(client.chat_runs());
    assert!(second.as_mut().now_or_never().is_none());
    release_tx.send(()).unwrap();
    assert!(matches!(block_on(first), Err(Error::Protocol { .. })));
    assert!(matches!(block_on(second), Err(Error::Protocol { .. })));
    worker.join().unwrap();
}

#[test]
fn invalid_options_never_enter_the_private_connector() {
    let entered = Arc::new(AtomicUsize::new(0));
    for options in [
        ClientOptions {
            max_pending: 0,
            ..ClientOptions::default()
        },
        ClientOptions {
            max_pending: 33,
            ..ClientOptions::default()
        },
        ClientOptions {
            max_frame_bytes: usize::MAX,
            ..ClientOptions::default()
        },
        ClientOptions {
            request_timeout: Duration::ZERO,
            ..ClientOptions::default()
        },
    ] {
        let counter = entered.clone();
        let guard = FixtureGuard {
            authority: Arc::new(Authority {
                launcher: None,
                project: PROJECT.into(),
                pid: PID,
                connect: Box::new(move || {
                    counter.fetch_add(1, Ordering::AcqRel);
                    Err(Error::Disconnected)
                }),
            }),
        };
        assert!(matches!(
            block_on(Client::connect(guard.endpoint(), options)),
            Err(Error::Protocol { .. })
        ));
    }
    assert_eq!(entered.load(Ordering::Acquire), 0);
}

#[test]
fn page_boundary_timeout_keeps_original_operation_submission_evidence() {
    for snapshot in [false, true] {
        let (guard, worker) = server(move |peer| {
            let request = peer.request(if snapshot {
                "daemon:snapshot"
            } else {
                "project:open"
            });
            if snapshot {
                peer.reply(&request, json!({"snapshotId":1,"pageCount":1,"eventSeq":0}));
            } else {
                peer.send(json!({"v":1,"id":request["id"],"pages":{"pageId":1,"pageCount":1}}));
            }
            // The deterministic expired deadline forbids even the first page request.
            peer.closed();
        });
        let options = ClientOptions::default();
        let notices = notify::Queue::new(&options);
        let stream = (guard.authority.connect)().unwrap();
        let mut engine =
            protocol::Engine::new(stream, guard.authority.clone(), options, notices, 999).unwrap();
        engine.handshake().unwrap();
        engine.page_deadline = Some(std::time::Instant::now());
        let deadline = std::time::Instant::now() + Duration::from_secs(1);
        let result = if snapshot {
            engine.snapshot(deadline).map(|_| ())
        } else {
            engine
                .request("project:open", json!([PROJECT]), deadline)
                .map(|_| ())
        };
        assert_eq!(result, Err(Error::TimedOut { submitted: true }));
        drop(engine);
        worker.join().unwrap();
    }
}

#[test]
fn completed_request_releases_admission_before_waking_the_caller() {
    use std::{
        future::Future,
        task::{Context, Wake, Waker},
    };
    struct Reenter {
        client: Client,
        observed: mpsc::Sender<bool>,
    }
    impl Wake for Reenter {
        fn wake(self: Arc<Self>) {
            // This executes inside reply publication, before the worker can continue.
            // A real new request must be admitted even with max_pending=1.
            let pending = self.client.chat_runs().now_or_never().is_none();
            self.observed.send(pending).unwrap();
        }
    }
    let (received_tx, received_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let (second_tx, second_rx) = mpsc::channel();
    let (guard, worker) = server(move |peer| {
        let first = peer.request("chat:runs");
        received_tx.send(()).unwrap();
        release_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        peer.reply(&first, json!({"runs":{},"seq":1}));
        let second = peer.request("chat:runs");
        peer.reply(&second, json!({"runs":{},"seq":2}));
        second_tx.send(()).unwrap();
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
    let (observed_tx, observed_rx) = mpsc::channel();
    let waker = Waker::from(Arc::new(Reenter {
        client: client.clone(),
        observed: observed_tx,
    }));
    let mut first = Box::pin(client.chat_runs());
    assert!(first
        .as_mut()
        .poll(&mut Context::from_waker(&waker))
        .is_pending());
    received_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    release_tx.send(()).unwrap();
    assert!(observed_rx.recv_timeout(Duration::from_secs(3)).unwrap());
    assert_eq!(block_on(first).unwrap().seq, 1);
    second_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    client.disconnect();
    worker.join().unwrap();
}

#[test]
fn dropping_connect_wait_retains_authority_until_its_worker_closes() {
    struct Dropped(mpsc::Sender<()>);
    impl Drop for Dropped {
        fn drop(&mut self) {
            let _ = self.0.send(());
        }
    }
    let (client_stream, server_stream) = UnixStream::pair().unwrap();
    let stream = Mutex::new(Some(client_stream));
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let release = Mutex::new(release_rx);
    let (dropped_tx, dropped_rx) = mpsc::channel();
    let retained = Dropped(dropped_tx);
    let guard = FixtureGuard {
        authority: Arc::new(Authority {
            launcher: None,
            project: PROJECT.into(),
            pid: PID,
            connect: Box::new(move || {
                let _retained = &retained;
                entered_tx.send(()).unwrap();
                release
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(3))
                    .unwrap();
                Ok(stream.lock().unwrap().take().unwrap())
            }),
        }),
    };
    let worker = thread::spawn(move || {
        let mut peer = Peer::new(server_stream);
        peer.handshake();
        peer.closed();
    });
    let mut connecting = Box::pin(Client::connect(guard.endpoint(), ClientOptions::default()));
    assert!(connecting.as_mut().now_or_never().is_none());
    entered_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    drop(connecting);
    drop(guard);
    assert!(matches!(
        dropped_rx.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));
    release_tx.send(()).unwrap();
    worker.join().unwrap();
    dropped_rx.recv_timeout(Duration::from_secs(3)).unwrap();
}

#[test]
fn dropping_last_client_closes_only_its_connection() {
    let (guard, worker) = server(|peer| {
        peer.closed();
    });
    let (client, _, mut events) = connect(&guard);
    let last = client.clone();
    drop(client);
    assert!(events.next().now_or_never().is_none());
    drop(last);
    assert_eq!(
        block_on(events.next()),
        Some(Notice::Closed(Error::Disconnected))
    );
    worker.join().unwrap();
    assert_eq!(guard.project(), PROJECT);
}

#[test]
fn an_old_accepted_receipt_cannot_release_a_new_capture_hold() {
    let (guard, worker) = server(|peer| {
        peer.snapshot(0);
        peer.event(1, json!({"after":"snapshot"}));
        peer.snapshot(0);
        peer.closed();
    });
    let (client, _, mut events) = connect(&guard);
    block_on(async {
        let old = client.runtime_snapshot().await.unwrap();
        client.accept_snapshot(&old).await.unwrap();
        client.accept_snapshot(&old).await.unwrap();
        let current = client.runtime_snapshot().await.unwrap();
        assert_eq!(
            client.accept_snapshot(&old).await,
            Err(Error::StaleSnapshot)
        );
        assert!(events.next().now_or_never().is_none());
        client.accept_snapshot(&current).await.unwrap();
        assert!(matches!(
            events.next().await,
            Some(Notice::Event { wire_seq: 1, .. })
        ));
        assert!(events.next().now_or_never().is_none());
    });
    client.disconnect();
    worker.join().unwrap();
}

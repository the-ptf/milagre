use super::*;
fn sidebar_server(
    run: impl FnOnce(&mut Peer) + Send + 'static,
) -> (FixtureGuard, thread::JoinHandle<()>) {
    let (guard, mut peer) = pair();
    let worker = thread::spawn(move || {
        let request = peer.request("daemon:status");
        let mut body = status();
        body["methods"] = json!(METHODS
            .iter()
            .copied()
            .chain(["chat:patch"])
            .collect::<Vec<_>>());
        peer.reply(&request, body);
        run(&mut peer);
    });
    (guard, worker)
}
fn open(peer: &mut Peer) {
    let r = peer.request("project:open");
    peer.reply(&r, json!({"path":PROJECT}));
}
#[test]
fn exact_patch_shapes_keep_frontend_pins_and_clocks_out_of_wire() {
    let (guard, worker) = sidebar_server(|peer| {
        open(peer);
        for patch in [
            json!({"title":"  λ😀  "}),
            json!({"title":""}),
            json!({"done":true,"unread":false}),
            json!({"done":false}),
            json!({"kept":true}),
            json!({"archived":false}),
        ] {
            let r = peer.request("chat:patch");
            assert_eq!(r["args"], json!([PROJECT, 1, patch]));
            peer.reply(&r, Value::Null);
        }
        peer.closed();
    });
    let (client, _, _) = connect(&guard);
    let actions = client.owned_sidebar_for(&guard.authority).unwrap();
    block_on(async {
        client.open_view(PROJECT).await.unwrap();
        actions.rename(1, "  λ😀  ").await.unwrap();
        actions.rename(1, "").await.unwrap();
        actions.mark_done(1, true).await.unwrap();
        actions.mark_done(1, false).await.unwrap();
        actions.keep(1).await.unwrap();
        actions.restore(1).await.unwrap();
    });
    client.disconnect();
    worker.join().unwrap();
}
#[test]
fn exact_authority_explicit_open_and_weak_lifetime_are_required() {
    let (guard, worker) = sidebar_server(|peer| {
        let r = peer.request("project:current");
        peer.reply(&r, json!({"path":PROJECT}));
        open(peer);
        let r = peer.request("chat:patch");
        peer.reply(&r, Value::Null);
        peer.closed();
    });
    let (foreign, _) = pair();
    let (client, _, _) = connect(&guard);
    assert!(matches!(
        client.owned_sidebar_for(&foreign.authority),
        Err(Error::InvalidScope)
    ));
    let a = client.owned_sidebar_for(&guard.authority).unwrap();
    block_on(async {
        for result in [
            a.rename(1, "title").await,
            a.mark_done(1, true).await,
            a.keep(1).await,
            a.restore(1).await,
        ] {
            assert_eq!(result, Err(Error::ViewNotOpened));
        }
        client.project_current().await.unwrap();
        assert_eq!(a.keep(1).await, Err(Error::ViewNotOpened));
        client.open_view(PROJECT).await.unwrap();
        a.keep(1).await.unwrap();
    });
    drop(client);
    assert_eq!(block_on(a.keep(1)), Err(Error::Disconnected));
    worker.join().unwrap();
}
#[test]
fn bounds_and_unpolled_futures_do_not_enqueue() {
    let (guard, worker) = sidebar_server(|peer| {
        open(peer);
        let r = peer.request("chat:patch");
        assert_eq!(r["args"][1], 9_007_199_254_740_991u64);
        assert_eq!(r["args"][2]["title"], "😀".repeat(8192));
        peer.reply(&r, Value::Null);
        let r = peer.request("project:current");
        peer.reply(&r, json!({"path":PROJECT}));
        peer.closed();
    });
    let (client, _, _) = connect(&guard);
    let a = client.owned_sidebar_for(&guard.authority).unwrap();
    block_on(async {
        client.open_view(PROJECT).await.unwrap();
        assert!(matches!(
            a.rename(1, &"😀".repeat(8193)).await,
            Err(Error::InvalidInput { field: "title", .. })
        ));
        for chat in [0, 9_007_199_254_740_992] {
            assert!(a.keep(chat).await.is_err());
            assert!(a.mark_done(chat, true).await.is_err());
            assert!(a.rename(chat, "x").await.is_err());
            assert!(a.restore(chat).await.is_err());
        }
        a.rename(9_007_199_254_740_991, &"😀".repeat(8192))
            .await
            .unwrap();
        drop(a.keep(1));
        client.project_current().await.unwrap();
    });
    client.disconnect();
    worker.join().unwrap();
}
#[test]
fn pending_action_does_not_keep_client_alive() {
    let (sent, seen) = mpsc::channel();
    let (guard, worker) = sidebar_server(move |peer| {
        open(peer);
        let _ = peer.request("chat:patch");
        sent.send(()).unwrap();
        peer.closed();
    });
    let (client, _, _) = connect(&guard);
    let a = client.owned_sidebar_for(&guard.authority).unwrap();
    block_on(client.open_view(PROJECT)).unwrap();
    let mut pending = Box::pin(a.mark_done(1, true));
    assert!(pending.as_mut().now_or_never().is_none());
    seen.recv_timeout(Duration::from_secs(3)).unwrap();
    drop(client);
    assert_eq!(block_on(pending), Err(Error::Disconnected));
    worker.join().unwrap();
}
#[test]
fn remote_details_and_submitted_timeout_are_preserved_without_replay() {
    let error = json!({"code":"SYNTHETIC_REMOTE_REFUSAL","message":"Synthetic refusal","details":{"sent":{"sessionId":1},"cause":{"code":"SAVE_FAILED","message":"retained"}}});
    let expected = error.clone();
    let (release, resume) = mpsc::channel();
    let (guard, worker) = sidebar_server(move |peer| {
        open(peer);
        let r = peer.request("chat:patch");
        peer.send(json!({"v":1,"id":r["id"],"error":error}));
        let r = peer.request("chat:patch");
        resume.recv_timeout(Duration::from_secs(3)).unwrap();
        peer.reply(&r, Value::Null);
        let r = peer.request("project:current");
        peer.reply(&r, json!({"path":PROJECT}));
        peer.closed();
    });
    let (client, _, _) = block_on(Client::connect(
        guard.endpoint(),
        ClientOptions {
            request_timeout: Duration::from_millis(80),
            ..Default::default()
        },
    ))
    .unwrap();
    let a = client.owned_sidebar_for(&guard.authority).unwrap();
    block_on(client.open_view(PROJECT)).unwrap();
    assert_eq!(
        block_on(a.rename(1, "name")),
        Err(Error::Remote {
            code: "SYNTHETIC_REMOTE_REFUSAL".into(),
            message: "Synthetic refusal".into(),
            payload: expected
        })
    );
    assert_eq!(
        block_on(a.mark_done(1, true)),
        Err(Error::TimedOut { submitted: true })
    );
    release.send(()).unwrap();
    block_on(client.project_current()).unwrap();
    client.disconnect();
    worker.join().unwrap();
}
#[test]
fn missing_capability_refuses_without_rpc_or_fallback() {
    let (guard, worker) = server(|peer| {
        open(peer);
        let r = peer.request("project:current");
        peer.reply(&r, json!({"path":PROJECT}));
        peer.closed();
    });
    let (client, _, _) = connect(&guard);
    let a = client.owned_sidebar_for(&guard.authority).unwrap();
    block_on(async {
        client.open_view(PROJECT).await.unwrap();
        assert!(matches!(a.keep(1).await, Err(Error::Capability { .. })));
        client.project_current().await.unwrap();
    });
    client.disconnect();
    worker.join().unwrap();
}

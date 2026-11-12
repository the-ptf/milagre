use super::*;
#[test]
fn remote_detail_has_fixed_scope_and_requires_opened_view() {
    let (guard, mut peer) = pair();
    let worker = thread::spawn(move || {
        let request = peer.request("daemon:status");
        let mut body = status();
        body["methods"] = json!(METHODS
            .iter()
            .copied()
            .chain(["pr:detail"])
            .collect::<Vec<_>>());
        peer.reply(&request, body);
        let open = peer.request("project:open");
        peer.reply(&open, json!({"path":PROJECT}));
        let detail = peer.request("pr:detail");
        assert_eq!(detail["args"], json!([{"cwd":PROJECT,"number":12}]));
        peer.reply(&detail, json!({"ok":true,"pr":{"number":12}}));
        peer.closed();
    });
    let (client, _, _) = connect(&guard);
    let (foreign, _unused_peer) = pair();
    assert!(matches!(
        client.owned_pr_details_for(&foreign.authority),
        Err(Error::InvalidScope)
    ));
    let reads = client.owned_pr_details_for(&guard.authority).unwrap();
    block_on(async {
        assert!(matches!(reads.detail(12).await, Err(Error::ViewNotOpened)));
        client.open_view(PROJECT).await.unwrap();
        assert!(matches!(
            reads.detail(0).await,
            Err(Error::InvalidInput { .. })
        ));
        assert!(matches!(
            reads.detail(u64::MAX).await,
            Err(Error::InvalidInput { .. })
        ));
        assert_eq!(
            reads.detail(12).await.unwrap(),
            json!({"ok":true,"pr":{"number":12}})
        );
    });
    drop(client);
    worker.join().unwrap();
    assert!(matches!(
        block_on(reads.detail(12)),
        Err(Error::Disconnected)
    ));
}
#[test]
fn ungranted_remote_detail_is_a_capability_refusal_without_wire_call() {
    let (guard, mut peer) = pair();
    let worker = thread::spawn(move || {
        let request = peer.request("daemon:status");
        peer.reply(&request, status());
        let open = peer.request("project:open");
        peer.reply(&open, json!({"path":PROJECT}));
        peer.closed();
    });
    let (client, _, _) = connect(&guard);
    let reads = client.owned_pr_details_for(&guard.authority).unwrap();
    block_on(async {
        client.open_view(PROJECT).await.unwrap();
        assert!(matches!(
            reads.detail(12).await,
            Err(Error::Capability { .. })
        ));
    });
    drop(client);
    worker.join().unwrap();
}

#[test]
fn pending_detail_future_does_not_retain_the_client_connection() {
    use std::future::Future;
    let (guard, mut peer) = pair();
    let (entered, received) = mpsc::channel();
    let worker = thread::spawn(move || {
        let request = peer.request("daemon:status");
        let mut body = status();
        body["methods"] = json!(METHODS
            .iter()
            .copied()
            .chain(["pr:detail"])
            .collect::<Vec<_>>());
        peer.reply(&request, body);
        let open = peer.request("project:open");
        peer.reply(&open, json!({"path":PROJECT}));
        peer.request("pr:detail");
        entered.send(()).unwrap();
        peer.closed();
    });
    let (client, _, _) = connect(&guard);
    let reads = client.owned_pr_details_for(&guard.authority).unwrap();
    block_on(client.open_view(PROJECT)).unwrap();
    let mut pending = Box::pin(reads.detail(12));
    let mut context = std::task::Context::from_waker(futures::task::noop_waker_ref());
    assert!(pending.as_mut().poll(&mut context).is_pending());
    received.recv_timeout(Duration::from_secs(3)).unwrap();
    drop(client);
    assert_eq!(block_on(pending), Err(Error::Disconnected));
    worker.join().unwrap();
}

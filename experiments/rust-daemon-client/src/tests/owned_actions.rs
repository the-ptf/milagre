use super::*;
use crate::{PermissionDecision, PermissionMode, ReplyStyle, SendOptions, SendTarget};

const ACTIONS: &[&str] = &[
    "chat:send",
    "chat:send-status",
    "agent:interrupt",
    "agent:respond-permission",
    "agent:answer-question",
    "agent:set-permission-mode",
    "chat:queue-send",
    "chat:queue-remove",
    "chat:patch",
];
fn handshake(peer: &mut Peer) {
    let request = peer.request("daemon:status");
    let mut value = status();
    value["methods"] = json!(METHODS.iter().chain(ACTIONS.iter()).collect::<Vec<_>>());
    peer.reply(&request, value);
}
fn action_server(
    run: impl FnOnce(&mut Peer) + Send + 'static,
) -> (FixtureGuard, thread::JoinHandle<()>) {
    let (guard, mut peer) = pair();
    let worker = thread::spawn(move || {
        handshake(&mut peer);
        run(&mut peer);
    });
    (guard, worker)
}

#[test]
fn owned_actions_preserve_all_wire_shapes_and_selected_model() {
    let (guard, worker) = action_server(|peer| {
        let open = peer.request("project:open");
        peer.reply(&open, json!({"path":PROJECT}));
        let new = peer.request("chat:send");
        assert_eq!(
            new["args"],
            json!([{"projectPath":PROJECT,"worktreeId":1,"provider":"claude","model":"selected-model","body":"new text","clientMessageId":"send-1","permissionMode":"ask","replies":"concise","tldrEnabled":true,"ultracode":false,"fastMode":false}])
        );
        peer.reply(&new, json!({"sessionId":1}));
        let queued = peer.request("chat:send");
        assert_eq!(queued["args"][0]["sessionId"], 1);
        assert_eq!(queued["args"][0]["model"], "selected-model");
        assert_eq!(queued["args"][0]["delivery"], "queue");
        assert_eq!(queued["args"][0]["effort"], "high");
        assert_eq!(queued["args"][0]["permissionMode"], "auto");
        assert_eq!(queued["args"][0]["replies"], "normal");
        peer.reply(&queued, json!({"sessionId":1}));
        for (method, expected) in [
            ("chat:send-status", json!([PROJECT, "send-1"])),
            ("agent:interrupt", json!([format!("{PROJECT}#1")])),
            (
                "agent:respond-permission",
                json!([{"chatId":format!("{PROJECT}#1"),"requestId":"permission-1","decision":"allow-for-chat"}]),
            ),
            (
                "agent:answer-question",
                json!([{"chatId":format!("{PROJECT}#1"),"requestId":"question-1","answers":{"q":["yes"]},"summary":"Yes"}]),
            ),
            (
                "agent:set-permission-mode",
                json!([{"chatId":format!("{PROJECT}#1"),"mode":"full"}]),
            ),
            (
                "chat:queue-send",
                json!([format!("{PROJECT}#1"), "queued-1"]),
            ),
            (
                "chat:queue-remove",
                json!([format!("{PROJECT}#1"), "queued-1"]),
            ),
            ("chat:patch", json!([PROJECT,1,{"unread":false}])),
        ] {
            let request = peer.request(method);
            assert_eq!(request["args"], expected);
            peer.reply(&request, json!({"method":method}));
        }
        peer.closed();
    });
    let (client, _, _) = connect(&guard);
    let actions = client
        .owned_actions_for(&guard.authority, "selected-model")
        .unwrap();
    block_on(async {
        client.open_view(PROJECT).await.unwrap();
        assert_eq!(
            actions
                .send(
                    SendTarget::NewProjectChat,
                    "new text",
                    "send-1",
                    SendOptions::default()
                )
                .await
                .unwrap(),
            json!({"sessionId":1})
        );
        actions
            .send(
                SendTarget::Existing(1),
                "queue text",
                "send-2",
                SendOptions {
                    effort: Some("high".into()),
                    permission_mode: PermissionMode::Auto,
                    replies: ReplyStyle::Normal,
                    queue: true,
                    ..SendOptions::default()
                },
            )
            .await
            .unwrap();
        actions.send_status("send-1").await.unwrap();
        actions.interrupt(1).await.unwrap();
        actions
            .respond_permission(1, "permission-1", PermissionDecision::AllowForChat)
            .await
            .unwrap();
        actions
            .answer_question(
                1,
                "question-1",
                Some(std::collections::BTreeMap::from([(
                    "q".into(),
                    vec!["yes".into()],
                )])),
                Some("Yes"),
            )
            .await
            .unwrap();
        actions
            .set_permission_mode(1, PermissionMode::Full)
            .await
            .unwrap();
        actions.send_queued_now(1, "queued-1").await.unwrap();
        actions.remove_queued(1, "queued-1").await.unwrap();
        actions.mark_unread(1, false).await.unwrap();
    });
    client.disconnect();
    worker.join().unwrap();
}

#[test]
fn explicit_open_and_exact_authority_are_required_without_implicit_rpc() {
    let (guard, worker) = action_server(|peer| {
        let current = peer.request("project:current");
        peer.reply(&current, json!({"path":PROJECT}));
        let open = peer.request("project:open");
        peer.reply(&open, json!({"path":PROJECT}));
        let send = peer.request("chat:send");
        peer.reply(&send, json!({"sessionId":1}));
        peer.closed();
    });
    let (foreign, _) = pair();
    let (client, _, _) = connect(&guard);
    assert!(matches!(
        client.owned_actions_for(&foreign.authority, "sonnet"),
        Err(Error::InvalidScope)
    ));
    let actions = client
        .owned_actions_for(&guard.authority, "sonnet")
        .unwrap();
    assert_eq!(block_on(actions.interrupt(1)), Err(Error::ViewNotOpened));
    block_on(client.project_current()).unwrap();
    assert_eq!(
        block_on(actions.send(
            SendTarget::Existing(1),
            "text",
            "id",
            SendOptions::default()
        )),
        Err(Error::ViewNotOpened)
    );
    block_on(client.open_view(PROJECT)).unwrap();
    block_on(actions.send(
        SendTarget::Existing(1),
        "text",
        "id",
        SendOptions::default(),
    ))
    .unwrap();
    client.disconnect();
    worker.join().unwrap();
    assert_eq!(block_on(actions.interrupt(1)), Err(Error::Disconnected));
}

#[test]
fn invalid_or_unpolled_actions_send_nothing_and_hold_no_client() {
    let (guard, worker) = action_server(|peer| {
        let open = peer.request("project:open");
        peer.reply(&open, json!({"path":PROJECT}));
        let current = peer.request("project:current");
        peer.reply(&current, json!({"path":PROJECT}));
        peer.closed();
    });
    let (client, _, _) = connect(&guard);
    let actions = client
        .owned_actions_for(&guard.authority, "sonnet")
        .unwrap();
    block_on(client.open_view(PROJECT)).unwrap();
    assert!(matches!(
        block_on(actions.interrupt(0)),
        Err(Error::InvalidInput { field: "chat", .. })
    ));
    assert!(matches!(
        block_on(actions.send(
            SendTarget::Existing(1),
            &"x".repeat(65537),
            "id",
            SendOptions::default()
        )),
        Err(Error::InvalidInput { field: "text", .. })
    ));
    assert!(matches!(
        block_on(actions.send(
            SendTarget::Existing(1),
            "x",
            "id",
            SendOptions {
                effort: Some("High".into()),
                ..SendOptions::default()
            }
        )),
        Err(Error::InvalidInput {
            field: "effort",
            ..
        })
    ));
    assert!(matches!(
        block_on(actions.respond_permission(1, &"x".repeat(129), PermissionDecision::Deny)),
        Err(Error::InvalidInput {
            field: "request_id",
            ..
        })
    ));
    assert!(matches!(
        block_on(actions.answer_question(1, "id", None, Some(&"x".repeat(65537)))),
        Err(Error::InvalidInput {
            field: "summary",
            ..
        })
    ));
    drop(actions.send(
        SendTarget::Existing(1),
        "never polled",
        "id",
        SendOptions::default(),
    ));
    block_on(client.project_current()).unwrap();
    drop(client);
    assert_eq!(block_on(actions.interrupt(1)), Err(Error::Disconnected));
    worker.join().unwrap();
}

#[test]
fn remote_settlement_error_is_preserved_without_replay() {
    let error = json!({"code":"ANSWER_DELIVERY_UNKNOWN","message":"Keep this answer uncertain","requestId":"p"});
    let expected = error.clone();
    let (guard, worker) = action_server(move |peer| {
        let open = peer.request("project:open");
        peer.reply(&open, json!({"path":PROJECT}));
        let request = peer.request("agent:respond-permission");
        peer.send(json!({"v":1,"id":request["id"],"error":error}));
        let current = peer.request("project:current");
        peer.reply(&current, json!({"path":PROJECT}));
        peer.closed();
    });
    let (client, _, _) = connect(&guard);
    let actions = client
        .owned_actions_for(&guard.authority, "sonnet")
        .unwrap();
    block_on(client.open_view(PROJECT)).unwrap();
    assert_eq!(
        block_on(actions.respond_permission(1, "p", PermissionDecision::AllowOnce)),
        Err(Error::Remote {
            code: "ANSWER_DELIVERY_UNKNOWN".into(),
            message: "Keep this answer uncertain".into(),
            payload: expected
        })
    );
    block_on(client.project_current()).unwrap();
    client.disconnect();
    worker.join().unwrap();
}

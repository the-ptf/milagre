use milagre_content_store::{Error, SystemRuntime};
use milagre_owner_store::{jsjson, Isolation, Policy};
use milagre_tools::{Caller, DesignScope, Dispatcher};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
fn caller(active: Arc<AtomicBool>) -> Caller {
    Caller {
        chat_id: "/fixture#7".into(),
        project_id: "/fixture".into(),
        roots: vec![],
        read: true,
        write: true,
        html: true,
        designs: true,
        kits: true,
        design_scope: DesignScope::All,
        bundled_skills: Path::new("/fixture/skills").into(),
        assert_active: Arc::new(move || {
            if active.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err(Error::new("Caller revoked"))
            }
        }),
    }
}
fn open(isolation: Isolation, caller: Caller) -> Dispatcher {
    Dispatcher::open(
        isolation,
        "artifacts".into(),
        "kits".into(),
        caller,
        Arc::new(SystemRuntime),
        None,
    )
    .unwrap()
}
async fn rpc(dispatcher: &Dispatcher, value: Value) -> Value {
    jsjson::parse_bytes(
        &dispatcher
            .dispatch(jsjson::to_string(&value).as_bytes())
            .await
            .unwrap(),
    )
    .unwrap()
}
#[tokio::test]
async fn protocol_negotiation_notifications_unknown_methods_and_limits() {
    let temp = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(temp.path(), &Policy::default()).unwrap();
    let d = open(isolation, caller(Arc::new(AtomicBool::new(true))));
    for version in ["2025-03-26", "2025-06-18", "future"] {
        let result=rpc(&d,json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":version}})).await;
        assert_eq!(
            result["result"],
            json!({"protocolVersion":if version=="future"{"2025-06-18"}else{version},"capabilities":{"tools":{}},"serverInfo":{"name":"milagre","version":"1"}})
        );
    }
    assert!(d
        .dispatch(br#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#)
        .await
        .is_none());
    assert_eq!(
        rpc(&d, json!({"jsonrpc":"2.0","id":"ping","method":"ping"})).await,
        json!({"jsonrpc":"2.0","id":"ping","result":{}})
    );
    assert_eq!(
        rpc(
            &d,
            json!({"jsonrpc":"2.0","id":4,"method":"resources/list"})
        )
        .await["error"]["code"],
        -32601
    );
    assert_eq!(rpc(&d,json!({"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"design_delete","arguments":{"id":"screen"}}})).await["result"]["isError"],true);
    for value in [
        json!([]),
        json!({"jsonrpc":"2.0","id":null,"method":"ping"}),
        json!({"method":"ping","id":1}),
    ] {
        assert_eq!(rpc(&d, value).await["error"]["code"], -32600);
    }
    assert_eq!(
        jsjson::parse_bytes(&d.dispatch(b"bad").await.unwrap()).unwrap()["error"]["code"],
        -32700
    );
    let large = json!({"jsonrpc":"2.0","id":1,"method":"ping","padding":"x".repeat(1024*1024)});
    assert_eq!(rpc(&d, large).await["error"]["code"], -32000);
    let huge = vec![b'x'; 6_000_000 + 64 * 1024 + 1];
    assert_eq!(
        jsjson::parse_bytes(&d.dispatch(&huge).await.unwrap()).unwrap()["error"]["code"],
        -32000
    );
    let raw = br#"{"jsonrpc":"2.0","id":"\ud83d","method":"ping"}"#;
    let reply = d.dispatch(raw).await.unwrap();
    assert!(String::from_utf8(reply).unwrap().contains("\\ud83d"));
    let names = d.list().unwrap()["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert_eq!(names.len(), 14);
    assert!(!names
        .iter()
        .any(|n| ["design_delete", "browser_open", "voice"].contains(&n.as_str())));
}
#[tokio::test]
async fn immutable_grants_filter_discovery_scope_reads_and_writes() {
    let temp = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(temp.path(), &Policy::default()).unwrap();
    let active = Arc::new(AtomicBool::new(true));
    let d = open(isolation.clone(), caller(active.clone()));
    for id in ["allowed", "outside"] {
        let result=d.call("design_show",&json!({"id":id,"title":id,"document":{"schemaVersion":1,"width":240,"height":240,"nodes":[]}})).await;
        assert_eq!(result["isError"], false);
        assert!(result["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("preview could not be rendered"));
    }
    {
        use sha2::Digest;
        let folder = hex::encode(sha2::Sha256::digest(b"/fixture#7"));
        let comments = json!([
            {"id":"12345678","design":{"id":"allowed","version":1,"title":"Allowed"},"text":"allowed note","createdAt":1000},
            {"id":"87654321","design":{"id":"outside","version":1,"title":"Outside"},"text":"outside note","createdAt":1000}
        ]);
        std::fs::write(
            temp.path()
                .join("artifacts")
                .join(&folder[..32])
                .join("comments"),
            jsjson::to_string(&comments),
        )
        .unwrap();
    }
    drop(d);
    let mut scope = caller(active.clone());
    scope.html = false;
    scope.kits = false;
    scope.write = false;
    scope.design_scope = DesignScope::Ids(BTreeSet::from(["allowed".into()]));
    let d = open(isolation.clone(), scope.clone());
    let tools = d.list().unwrap();
    assert!(tools["tools"]
        .as_array()
        .unwrap()
        .iter()
        .all(|t| t["annotations"]["readOnlyHint"] == true
            && !t["name"].as_str().unwrap().starts_with("design_kit_")));
    let result = d.call("design_list", &json!({})).await;
    let list = jsjson::parse(result["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["id"], "allowed");
    let comments = d.call("artifact_comments", &json!({})).await;
    let comments = jsjson::parse(comments["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(comments.as_array().unwrap().len(), 1);
    assert_eq!(comments[0]["id"], "12345678");

    assert_eq!(
        d.call("design_read", &json!({"id":"outside"})).await["isError"],
        true
    );
    assert_eq!(
        d.call(
            "design_read",
            &json!({"id":"allowed","chatId":"/another#9"})
        )
        .await["isError"],
        true
    );
    assert_eq!(d.call("artifact_list", &json!({})).await["isError"], true);
    assert_eq!(d.call("design_apply", &json!({})).await["isError"], true);
    drop(d);
    scope.write = true;
    let d = open(isolation, scope);
    let result=d.call("design_show",&json!({"id":"allowed","title":"Escaping variant","expectedVersion":1,"from":{"id":"outside"}})).await;
    assert_eq!(result["isError"], true);
    assert!(result["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("outside"));
    assert_eq!(
        d.call(
            "artifact_resolve_comment",
            &json!({"id":"87654321","note":"outside"})
        )
        .await["isError"],
        true
    );
    assert_eq!(
        d.call(
            "artifact_resolve_comment",
            &json!({"id":"12345678","note":"fixed"})
        )
        .await["isError"],
        false
    );
    active.store(false, Ordering::SeqCst);
    assert!(d.list().is_err());
    assert_eq!(
        d.call("design_read", &json!({"id":"allowed"})).await["isError"],
        true
    );
}
#[tokio::test]
async fn corrupt_storage_latches_and_live_or_outside_paths_are_refused() {
    let temp = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(temp.path(), &Policy::default()).unwrap();
    let mut c = caller(Arc::new(AtomicBool::new(true)));
    c.roots.push(std::env::temp_dir());
    assert!(Dispatcher::open(
        isolation.clone(),
        "artifacts".into(),
        "kits".into(),
        c,
        Arc::new(SystemRuntime),
        None
    )
    .is_err());
    let c = caller(Arc::new(AtomicBool::new(true)));
    assert!(Dispatcher::open(
        isolation.clone(),
        "../escape".into(),
        "kits".into(),
        c.clone(),
        Arc::new(SystemRuntime),
        None
    )
    .is_err());
    let d = open(isolation, c);
    assert_eq!(
        d.call(
            "artifact_show",
            &json!({"title":"Report","html":"<p>saved</p>"})
        )
        .await["isError"],
        false
    );
    let folder = std::fs::read_dir(temp.path().join("artifacts"))
        .unwrap()
        .filter_map(Result::ok)
        .find(|e| e.path().is_dir())
        .unwrap()
        .path();
    let page = std::fs::read_dir(folder)
        .unwrap()
        .filter_map(Result::ok)
        .find(|e| e.path().is_dir())
        .unwrap()
        .path();
    std::fs::write(page.join("meta.json"), "broken").unwrap();
    assert_eq!(d.call("artifact_list", &json!({})).await["isError"], true);
    assert!(d.storage_fault().is_some());
    assert!(d.list().is_err());
}
#[cfg(unix)]
#[tokio::test]
async fn swapped_worktree_roots_revoke_calls_before_asset_import() {
    let temp = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(temp.path(), &Policy::default()).unwrap();
    let root = temp.path().join("worktree");
    std::fs::create_dir(&root).unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("private.txt"), "sentinel").unwrap();
    let mut c = caller(Arc::new(AtomicBool::new(true)));
    c.roots = vec![root.clone()];
    let d = open(isolation, c);
    std::fs::remove_dir(&root).unwrap();
    std::os::unix::fs::symlink(outside.path(), &root).unwrap();
    let result=d.call("artifact_show",&json!({"title":"Escape","html":"<a href=\"assets/private.txt\">link</a>","assets":[{"name":"private.txt","path":root.join("private.txt")}]})).await;
    assert_eq!(result["isError"], true);
    assert!(!temp
        .path()
        .join("artifacts")
        .read_dir()
        .unwrap()
        .any(|entry| entry.unwrap().path().is_dir()));
}
#[tokio::test]
async fn dispatcher_future_can_move_to_an_owner_actor() {
    fn send<T: Send>(_: T) {}
    let temp = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(temp.path(), &Policy::default()).unwrap();
    let d = open(isolation, caller(Arc::new(AtomicBool::new(true))));
    send(d.dispatch(br#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#));
}

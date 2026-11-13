//! Real renderer RPC and in-process MCP grants share one native content writer.
use milagre_owner_store::jsjson;
use milagre_rust_runtime::content_fixture::{self, ContentFixture};
use milagre_tools::{ContentOwner, DesignScope};
use serde_json::{json, Value};
use std::{collections::BTreeSet, path::PathBuf, sync::Arc};

fn rpc(fixture: &ContentFixture, method: &str, args: Value) -> Value {
    let output = std::process::Command::new("node")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/content-client.cjs"
        ))
        .arg(fixture.server.profile_path())
        .arg(&fixture.project)
        .arg(method)
        .arg(jsjson::to_string(&args))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    jsjson::parse_bytes(&output.stdout).unwrap()
}
fn text(result: &Value) -> Value {
    assert_ne!(result["isError"], true, "{}", result["content"][0]["text"]);
    let line = result["content"][0]["text"]
        .as_str()
        .unwrap()
        .lines()
        .next()
        .unwrap();
    jsjson::parse(line).unwrap()
}
fn change(version: u64, body: &str) -> Value {
    json!({"id":"welcome","expectedVersion":version,"operations":[{"op":"update","id":"heading","patch":{"text":body}}]})
}
fn for_chat(mut request: Value, chat: &str) -> Value {
    request["chatId"] = json!(chat);
    request
}
fn open() -> ContentFixture {
    let fixture =
        content_fixture::start(PathBuf::from(env!("CARGO_BIN_EXE_milagre-design-raster"))).unwrap();
    assert!(
        fixture.grant(1, true, DesignScope::All).is_err(),
        "an unopened Project has no tool grants"
    );
    assert!(rpc(&fixture, "project:snapshot", json!([fixture.project]))["result"].is_object());
    fixture
}
#[test]
fn renderer_and_mcp_share_one_writer_with_scoped_revocable_grants() {
    let fixture = open();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let chat = format!("{}#1", fixture.project);
    let peer_chat = format!("{}#2", fixture.project);
    let grant = fixture.grant(1, true, DesignScope::All).unwrap();
    let peer = fixture.grant(2, true, DesignScope::All).unwrap();
    let scoped = fixture
        .grant(
            1,
            false,
            DesignScope::Ids(BTreeSet::from(["welcome".into()])),
        )
        .unwrap();
    assert!(fixture.grant(999, true, DesignScope::All).is_err());
    let before = rpc(
        &fixture,
        "artifact:get",
        json!([{"chatId":chat,"id":"welcome","format":"design"}]),
    )["result"]
        .clone();
    let frame = jsjson::to_string(
        &json!({"jsonrpc":"2.0","id":"shared-content","method":"tools/call","params":{"name":"design_read","arguments":{"id":"welcome"}}}),
    );
    let reply = runtime
        .block_on(grant.dispatcher.dispatch(frame.as_bytes()))
        .unwrap();
    let reply = jsjson::parse_bytes(&reply).unwrap();
    assert_eq!(reply["id"], "shared-content");
    let read = reply["result"].clone();
    assert_eq!(text(&read)["document"], before["document"]);
    let edited = runtime.block_on(
        grant
            .dispatcher
            .call("design_apply", &change(1, "MCP shared edit")),
    );
    assert_eq!(text(&edited)["version"], 2);
    assert!(edited["content"]
        .as_array()
        .unwrap()
        .iter()
        .any(|block| block["type"] == "image"
            && block["mimeType"] == "image/png"
            && block["data"]
                .as_str()
                .is_some_and(|data| data.starts_with("iVBOR"))));
    let from_renderer = rpc(
        &fixture,
        "artifact:get",
        json!([{"chatId":chat,"id":"welcome","format":"design"}]),
    )["result"]
        .clone();
    assert_eq!(from_renderer["version"], 2);
    assert!(from_renderer["document"]["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|node| node["text"] == "MCP shared edit"));
    let renderer_edit = rpc(
        &fixture,
        "artifact:apply",
        json!([for_chat(change(2, "Renderer shared edit"), &chat)]),
    );
    assert_eq!(renderer_edit["result"]["version"], 3);
    assert_eq!(
        text(
            &runtime.block_on(
                grant
                    .dispatcher
                    .call("design_read", &json!({"id":"welcome"}))
            )
        )["version"],
        3
    );
    assert_eq!(
        runtime.block_on(
            peer.dispatcher
                .call("design_read", &json!({"id":"welcome"}))
        )["isError"],
        true,
        "other Chat cannot read the first Chat's Design"
    );
    assert_eq!(
        runtime.block_on(
            grant
                .dispatcher
                .call("design_read", &json!({"id":"welcome","chatId":peer_chat}))
        )["isError"],
        true,
        "tool input cannot change its owner supplied Chat"
    );
    assert_eq!(
        runtime.block_on(
            scoped
                .dispatcher
                .call("design_apply", &change(3, "refused"))
        )["isError"],
        true
    );
    assert_eq!(
        runtime.block_on(
            scoped
                .dispatcher
                .call("design_read", &json!({"id":"outside"}))
        )["isError"],
        true
    );
    // A peer Chat can create its own identically named Design without replacing ours.
    let show=runtime.block_on(peer.dispatcher.call("design_show",&json!({"id":"welcome","title":"Peer screen","document":{"schemaVersion":1,"width":320,"height":300,"background":"#ffffff","nodes":[{"id":"peer","type":"text","x":16,"y":16,"width":280,"height":80,"text":"Peer content","fontSize":20,"fill":"#000000"}]}})));
    assert_eq!(text(&show)["version"], 1);
    assert_eq!(
        rpc(
            &fixture,
            "artifact:get",
            json!([{"chatId":peer_chat,"id":"welcome"}])
        )["result"]["title"],
        "Peer screen"
    );
    assert_eq!(
        rpc(
            &fixture,
            "artifact:get",
            json!([{"chatId":chat,"id":"welcome"}])
        )["result"]["version"],
        3
    );
    // Same expected version across renderer and tool: exactly one commit wins.
    let (renderer_race, tool_race) = std::thread::scope(|threads| {
        let renderer = threads.spawn(|| {
            rpc(
                &fixture,
                "artifact:apply",
                json!([for_chat(change(3, "Renderer race"), &chat)]),
            )
        });
        let tool = runtime.block_on(
            grant
                .dispatcher
                .call("design_apply", &change(3, "Tool race")),
        );
        (renderer.join().unwrap(), tool)
    });
    assert_ne!(
        renderer_race.get("error").is_some(),
        tool_race["isError"] == true,
        "exactly one expected-version contender succeeds"
    );
    assert_eq!(
        rpc(
            &fixture,
            "artifact:get",
            json!([{"chatId":chat,"id":"welcome"}])
        )["result"]["version"],
        4
    );
    grant.revoke();
    assert_eq!(
        runtime.block_on(
            grant
                .dispatcher
                .call("design_read", &json!({"id":"welcome"}))
        )["isError"],
        true
    );
    assert_eq!(
        text(
            &runtime.block_on(
                scoped
                    .dispatcher
                    .call("design_read", &json!({"id":"welcome"}))
            )
        )["version"],
        4,
        "revoking one grant leaves another valid grant intact"
    );
    fixture.server.shutdown().unwrap();
    assert_eq!(
        runtime.block_on(
            peer.dispatcher
                .call("design_read", &json!({"id":"welcome"}))
        )["isError"],
        true,
        "shutdown revokes retained session handles"
    );
    // Retained revoked handles must not keep native writer flocks alive.
    let isolation = milagre_owner_store::Isolation::open(
        fixture.server.profile_path(),
        &milagre_owner_store::Policy::system(),
    )
    .unwrap();
    let project = fixture.project.clone();
    let reopened = ContentOwner::open(
        isolation,
        "artifacts".into(),
        "design-kits".into(),
        Arc::new(move |_| Ok(project.clone())),
        Arc::new(|| Ok(())),
        Arc::new(milagre_content_store::SystemRuntime),
        None,
    )
    .unwrap();
    reopened.shutdown();
}

#[test]
fn retained_mcp_grants_cannot_bypass_storage_fault_or_replaced_project_owner() {
    for owner_replaced in [false, true] {
        let fixture = open();
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        let grant = fixture.grant(1, true, DesignScope::All).unwrap();
        let chat = format!("{}#1", fixture.project);
        let file = if owner_replaced {
            PathBuf::from(&fixture.project).join(".milagre/runtime.lock/owner.json")
        } else {
            fixture
                .server
                .profile_path()
                .join("artifacts")
                .join(milagre_content_store::chat_hash(&chat))
                .join("welcome/meta.json")
        };
        let backup = file.with_extension("fixture-backup");
        std::fs::rename(&file, &backup).unwrap();
        std::fs::write(&file, if owner_replaced { "{}" } else { "{broken" }).unwrap();
        let rejected = runtime.block_on(
            grant
                .dispatcher
                .call("design_read", &json!({"id":"welcome"})),
        );
        std::fs::remove_file(&file).unwrap();
        std::fs::rename(&backup, &file).unwrap();
        assert_eq!(rejected["isError"], true);
        assert_eq!(
            runtime.block_on(
                grant
                    .dispatcher
                    .call("design_read", &json!({"id":"welcome"}))
            )["isError"],
            true,
            "restoring a file does not reactivate a faulted owner"
        );
        assert!(
            rpc(
                &fixture,
                "artifact:get",
                json!([{"chatId":chat,"id":"welcome"}])
            )
            .get("error")
            .is_some(),
            "renderer shares the same fault/ownership guard"
        );
        fixture.server.shutdown().unwrap();
    }
}

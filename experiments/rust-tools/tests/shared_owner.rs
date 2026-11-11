use milagre_content_store::{design::raster::RasterRenderer, Error, SystemRuntime};
use milagre_owner_store::{jsjson, Isolation, Policy};
use milagre_tools::{Caller, ContentOwner, DesignScope};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
fn caller(chat: &str, grant: Arc<AtomicBool>) -> Caller {
    Caller {
        chat_id: chat.into(),
        project_id: chat.split('#').next().unwrap().into(),
        roots: vec![],
        read: true,
        write: true,
        html: true,
        designs: true,
        kits: true,
        design_scope: DesignScope::All,
        bundled_skills: Path::new("/fixture/skills").into(),
        assert_active: Arc::new(move || {
            if grant.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err(Error::new("Caller revoked"))
            }
        }),
    }
}
fn owner(
    isolation: Isolation,
    raster: Option<Arc<RasterRenderer>>,
    live: Arc<AtomicBool>,
) -> Arc<ContentOwner> {
    ContentOwner::open(
        isolation,
        "artifacts".into(),
        "kits".into(),
        Arc::new(|chat| match chat {
            "/alpha#1" | "/alpha#2" => Ok("/alpha".into()),
            "/beta#1" => Ok("/beta".into()),
            _ => Err(Error::new("Chat not admitted")),
        }),
        Arc::new(move || {
            if live.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err(Error::coded("OWNERSHIP_LOST", "Owner identity changed"))
            }
        }),
        Arc::new(SystemRuntime),
        raster,
    )
    .unwrap()
}
fn show(title: &str) -> Value {
    json!({"id":"screen","title":title,"document":{"schemaVersion":1,"width":240,"height":240,"nodes":[{"id":"label","type":"text","width":200,"height":60,"text":"Hello"}]}})
}
fn edit(text: &str) -> Value {
    json!({"id":"screen","expectedVersion":1,"operations":[{"op":"update","id":"label","patch":{"text":text}}]})
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_chats_share_one_writer_and_renderer_mcp_version_conflicts_serialize() {
    let temp = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(temp.path(), &Policy::default()).unwrap();
    let active = Arc::new(AtomicBool::new(true));
    let owner = owner(isolation, None, active.clone());
    let a = caller("/alpha#1", active.clone());
    let b = caller("/alpha#2", active.clone());
    let one = Arc::new(owner.session(a.clone()).unwrap());
    let two = Arc::new(owner.session(b.clone()).unwrap());
    let create = |session: Arc<milagre_tools::Dispatcher>, title| {
        tokio::spawn(async move { session.call("design_show", &show(title)).await })
    };
    let (one_result, two_result) =
        tokio::join!(create(one.clone(), "One"), create(two.clone(), "Two"));
    assert_eq!(one_result.unwrap()["isError"], false);
    assert_eq!(two_result.unwrap()["isError"], false);
    for (caller, title) in [(&a, "One"), (&b, "Two")] {
        let read = render(
            &owner,
            caller,
            "artifact:get",
            &json!({"chatId":caller.chat_id,"id":"screen","format":"design"}),
        )
        .unwrap();
        assert_eq!(read["title"], title);
        assert_eq!(read["version"], 1);
    }
    let mcp = tokio::spawn({
        let one = one.clone();
        async move { one.call("design_apply", &edit("MCP")).await }
    });
    let renderer = tokio::spawn({
        let owner = owner.clone();
        let caller = a.clone();
        async move {
            let mut request = edit("Renderer");
            request["chatId"] = json!(caller.chat_id);
            render(&owner, &caller, "artifact:apply", &request)
        }
    });
    let (mcp, renderer) = tokio::join!(mcp, renderer);
    let mcp = mcp.unwrap();
    let renderer = renderer.unwrap();
    assert_ne!(mcp["isError"] == false, renderer.is_ok());
    assert_eq!(
        render(
            &owner,
            &a,
            "artifact:get",
            &json!({"chatId":a.chat_id,"id":"screen","format":"design"})
        )
        .unwrap()["version"],
        2
    );
    assert_eq!(
        render(
            &owner,
            &b,
            "artifact:get",
            &json!({"chatId":b.chat_id,"id":"screen","format":"design"})
        )
        .unwrap()["version"],
        1
    );
    let kit = json!({"expectedVersion":0,"kit":{"title":"Shared","colors":{},"textStyles":{},"spacing":{},"radii":{}}});
    assert_eq!(one.call("design_kit_save", &kit).await["isError"], false);
    let read = two.call("design_kit_read", &json!({})).await;
    assert_eq!(
        jsjson::parse(read["content"][0]["text"].as_str().unwrap()).unwrap()["title"],
        "Shared"
    );
}
#[tokio::test]
async fn grants_projects_and_owner_identity_do_not_cross_sessions() {
    let temp = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(temp.path(), &Policy::default()).unwrap();
    let live = Arc::new(AtomicBool::new(true));
    let owner = owner(isolation, None, live.clone());
    let grant = Arc::new(AtomicBool::new(true));
    let a = caller("/alpha#1", grant.clone());
    let b = caller("/beta#1", Arc::new(AtomicBool::new(true)));
    let one = owner.session(a.clone()).unwrap();
    let two = owner.session(b.clone()).unwrap();
    let mut crossed = a.clone();
    crossed.project_id = "/beta".into();
    assert!(owner.session(crossed).is_err());
    assert!(render(&owner, &a, "artifact:list", &json!({"chatId":b.chat_id})).is_err());
    assert_eq!(
        one.call("artifact_list", &json!({"chatId":b.chat_id}))
            .await["isError"],
        true
    );
    grant.store(false, Ordering::SeqCst);
    assert_eq!(
        one.call("artifact_show", &json!({"title":"No","html":"No"}))
            .await["isError"],
        true
    );
    assert_eq!(
        two.call("artifact_show", &json!({"title":"Yes","html":"<p>Yes</p>"}))
            .await["isError"],
        false
    );
    live.store(false, Ordering::SeqCst);
    assert!(two.list().is_err());
    assert!(render(&owner, &b, "artifact:list", &json!({"chatId":b.chat_id})).is_err());
}
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revocation_during_png_hides_reply_without_undoing_commit_or_blocking_renderer() {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(temp.path(), &Policy::default()).unwrap();
    let entered = temp.path().join("entered");
    let release = temp.path().join("release");
    let helper = temp.path().join("helper");
    std::fs::write(&helper,format!("#!/bin/sh\necho ready > '{}'\nwhile [ ! -e '{}' ]; do /bin/sleep 0.01; done\nexec '{}'\n",entered.display(),release.display(),env!("CARGO_BIN_EXE_milagre-design-raster"))).unwrap();
    std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o700)).unwrap();
    let renderer = Arc::new(RasterRenderer::new(helper).unwrap());
    let live = Arc::new(AtomicBool::new(true));
    let owner = owner(isolation, Some(renderer), live);
    let grant = Arc::new(AtomicBool::new(true));
    let caller = caller("/alpha#1", grant.clone());
    let session = owner.session(caller.clone()).unwrap();
    let accepted = session
        .start_call("design_show", &show("Committed before PNG"))
        .unwrap();
    let receipt = accepted.receipt();
    let task = tokio::spawn(accepted.wait());
    for _ in 0..500 {
        if entered.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(entered.exists());
    assert_eq!(
        receipt.status().mutation,
        milagre_tools::MutationOutcome::Committed
    );
    assert_eq!(receipt.status().phase, milagre_tools::CallPhase::Running);
    let desktop = caller::independent(&caller);
    let read = render(
        &owner,
        &desktop,
        "artifact:get",
        &json!({"chatId":desktop.chat_id,"id":"screen","format":"design"}),
    )
    .unwrap();
    assert_eq!(read["version"], 1);
    grant.store(false, Ordering::SeqCst);
    std::fs::write(release, "").unwrap();
    let response = task.await.unwrap();
    assert_eq!(response["isError"], true);
    assert_eq!(response["content"].as_array().unwrap().len(), 1);
    assert_eq!(response["content"][0]["text"], "Caller revoked");
    assert_eq!(
        render(
            &owner,
            &desktop,
            "artifact:get",
            &json!({"chatId":desktop.chat_id,"id":"screen","format":"design"})
        )
        .unwrap()["version"],
        1
    );
}
mod caller {
    use super::*;
    pub fn independent(caller: &Caller) -> Caller {
        let mut independent = caller.clone();
        independent.assert_active = Arc::new(|| Ok(()));
        independent
    }
}
#[tokio::test]
async fn shutdown_releases_store_locks_even_with_retained_sessions() {
    let temp = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(temp.path(), &Policy::default()).unwrap();
    let live = Arc::new(AtomicBool::new(true));
    let original = owner(isolation.clone(), None, live.clone());
    let caller = caller("/alpha#1", live.clone());
    let retained = original.session(caller.clone()).unwrap();
    assert_eq!(
        retained
            .call(
                "artifact_show",
                &json!({"title":"Saved","html":"<p>Saved</p>"})
            )
            .await["isError"],
        false
    );
    original.shutdown();
    original.shutdown();
    assert!(retained.list().is_err());
    assert!(original.session(caller.clone()).is_err());
    assert!(render(
        &original,
        &caller,
        "artifact:list",
        &json!({"chatId":caller.chat_id})
    )
    .is_err());
    let replacement = owner(isolation, None, live);
    let session = replacement.session(caller).unwrap();
    let list = session.call("artifact_list", &json!({})).await;
    assert_eq!(list["isError"], false);
    assert_eq!(
        jsjson::parse(list["content"][0]["text"].as_str().unwrap()).unwrap()[0]["title"],
        "Saved"
    );
    assert_eq!(
        retained.call("artifact_list", &json!({})).await["isError"],
        true
    );
}
#[tokio::test]
async fn revocation_inside_design_commit_rolls_back_and_restores_the_owner_guard() {
    let temp = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(temp.path(), &Policy::default()).unwrap();
    let live = Arc::new(AtomicBool::new(true));
    let owner = owner(isolation, None, live.clone());
    let desktop = caller("/alpha#1", live);
    let baseline = owner.session(desktop.clone()).unwrap();
    assert_eq!(
        baseline.call("design_show", &show("Original")).await["isError"],
        false
    );
    let html = temp
        .path()
        .join("artifacts")
        .join(milagre_content_store::chat_hash("/alpha#1"))
        .join("screen/v2.html");
    let granted = Arc::new(AtomicBool::new(true));
    let mut revoked = desktop.clone();
    revoked.assert_active = Arc::new({
        let html = html.clone();
        let granted = granted.clone();
        move || {
            if html.exists() {
                granted.store(false, Ordering::SeqCst);
            }
            if granted.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err(Error::new("Grant revoked during commit"))
            }
        }
    });
    let session = owner.session(revoked).unwrap();
    assert_eq!(
        session.call("design_apply", &edit("Must roll back")).await["isError"],
        true
    );
    assert!(!granted.load(Ordering::SeqCst));
    assert!(!html.exists());
    let read = render(
        &owner,
        &desktop,
        "artifact:get",
        &json!({"chatId":desktop.chat_id,"id":"screen","format":"design"}),
    )
    .unwrap();
    assert_eq!(read["version"], 1);
    assert_eq!(read["document"]["nodes"][0]["text"], "Hello");
    assert_eq!(
        baseline
            .call("design_apply", &edit("Independent grant"))
            .await["isError"],
        false
    );
    assert!(owner.storage_fault().is_none());
}
#[tokio::test]
async fn kit_commit_uses_the_call_grant_and_does_not_leak_it_to_another_session() {
    use sha2::Digest;
    let temp = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(temp.path(), &Policy::default()).unwrap();
    let live = Arc::new(AtomicBool::new(true));
    let owner = owner(isolation, None, live.clone());
    let regular = caller("/alpha#1", live);
    let folder = temp
        .path()
        .join("kits")
        .join(hex::encode(sha2::Sha256::digest(b"/alpha")));
    let revoked = Arc::new(AtomicBool::new(false));
    let mut caller = regular.clone();
    caller.assert_active = Arc::new({
        let folder = folder.clone();
        let revoked = revoked.clone();
        move || {
            if std::fs::read_dir(&folder).is_ok_and(|entries| {
                entries
                    .filter_map(Result::ok)
                    .any(|entry| entry.path().extension().is_some_and(|ext| ext == "tmp"))
            }) {
                revoked.store(true, Ordering::SeqCst);
            }
            if revoked.load(Ordering::SeqCst) {
                Err(Error::new("Kit grant revoked before rename"))
            } else {
                Ok(())
            }
        }
    });
    let restricted = owner.session(caller).unwrap();
    let regular = owner.session(regular).unwrap();
    let kit = json!({"expectedVersion":0,"kit":{"title":"Fixture","colors":{},"textStyles":{},"spacing":{},"radii":{}}});
    assert_eq!(
        restricted.call("design_kit_save", &kit).await["isError"],
        true
    );
    assert!(revoked.load(Ordering::SeqCst));
    assert!(!folder.join("project.json").exists());
    assert!(folder.read_dir().unwrap().next().is_none());
    assert_eq!(
        regular.call("design_kit_save", &kit).await["isError"],
        false
    );
}

fn render(
    owner: &Arc<ContentOwner>,
    caller: &Caller,
    method: &str,
    request: &Value,
) -> milagre_content_store::Result<Value> {
    let scope = owner.renderer_scope(
        &caller.chat_id,
        &caller.project_id,
        caller.assert_active.clone(),
    )?;
    owner.renderer(&scope, method, request)
}
#[tokio::test]
async fn renderer_capability_is_bound_to_owner_chat_project_and_revocation() {
    let temp = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(temp.path(), &Policy::default()).unwrap();
    let live = Arc::new(AtomicBool::new(true));
    let owner = owner(isolation.clone(), None, live.clone());
    let grant = Arc::new(AtomicBool::new(true));
    let renderer = owner
        .renderer_scope(
            "/alpha#1",
            "/alpha",
            Arc::new({
                let grant = grant.clone();
                move || {
                    if grant.load(Ordering::SeqCst) {
                        Ok(())
                    } else {
                        Err(Error::new("Renderer revoked"))
                    }
                }
            }),
        )
        .unwrap();
    assert!(owner
        .renderer_scope("/alpha#1", "/beta", Arc::new(|| Ok(())))
        .is_err());
    assert!(owner
        .renderer_scope("/missing#1", "/alpha", Arc::new(|| Ok(())))
        .is_err());
    assert!(owner
        .renderer(&renderer, "artifact:list", &json!({"chatId":"/alpha#2"}))
        .is_err());
    assert!(owner
        .renderer(&renderer, "artifact:list", &json!({"chatId":"/alpha#1"}))
        .is_ok());
    grant.store(false, Ordering::SeqCst);
    assert!(owner
        .renderer(&renderer, "artifact:list", &json!({"chatId":"/alpha#1"}))
        .is_err());
    assert!(owner.storage_fault().is_none());
    owner.shutdown();
    let replacement = super_owner(isolation, live);
    assert!(replacement
        .renderer(&renderer, "artifact:list", &json!({"chatId":"/alpha#1"}))
        .is_err());
    let fresh = replacement
        .renderer_scope("/alpha#1", "/alpha", Arc::new(|| Ok(())))
        .unwrap();
    assert!(replacement
        .renderer(&fresh, "artifact:list", &json!({"chatId":"/alpha#1"}))
        .is_ok());
}
fn super_owner(isolation: Isolation, live: Arc<AtomicBool>) -> Arc<ContentOwner> {
    owner(isolation, None, live)
}
#[cfg(unix)]
#[tokio::test]
async fn caller_root_and_lease_io_failures_during_commit_do_not_fault_other_chats() {
    for root_io in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let isolation = Isolation::create(temp.path(), &Policy::default()).unwrap();
        let root = temp.path().join("worktree");
        std::fs::create_dir(&root).unwrap();
        let live = Arc::new(AtomicBool::new(true));
        let owner = owner(isolation, None, live.clone());
        let regular = caller("/alpha#1", live.clone());
        let baseline = owner.session(regular.clone()).unwrap();
        assert_eq!(
            baseline.call("design_show", &show("Original")).await["isError"],
            false
        );
        let html = temp
            .path()
            .join("artifacts")
            .join(milagre_content_store::chat_hash("/alpha#1"))
            .join("screen/v2.html");
        let tripped = Arc::new(AtomicBool::new(false));
        let mut restricted = regular.clone();
        restricted.roots = vec![root.clone()];
        restricted.assert_active = Arc::new({
            let tripped = tripped.clone();
            let root = root.clone();
            move || {
                if html.exists() && !tripped.swap(true, Ordering::SeqCst) && root_io {
                    std::fs::remove_dir(&root)?;
                    std::os::unix::fs::symlink(&root, &root)?;
                }
                if !root_io && tripped.load(Ordering::SeqCst) {
                    Err(Error::coded("IO_ERROR", "fixture caller lease I/O failure"))
                } else {
                    Ok(())
                }
            }
        });
        let session = owner.session(restricted).unwrap();
        assert_eq!(
            session.call("design_apply", &edit("must roll back")).await["isError"],
            true
        );
        assert!(tripped.load(Ordering::SeqCst));
        assert!(owner.storage_fault().is_none());
        let scope = owner
            .renderer_scope("/alpha#1", "/alpha", Arc::new(|| Ok(())))
            .unwrap();
        assert_eq!(
            owner
                .renderer(
                    &scope,
                    "artifact:get",
                    &json!({"chatId":"/alpha#1","id":"screen","format":"design"})
                )
                .unwrap()["version"],
            1
        );
        let other = owner.session(caller("/alpha#2", live)).unwrap();
        assert_eq!(
            other.call("design_show", &show("Other Chat")).await["isError"],
            false
        );
        assert_eq!(
            baseline
                .call("design_apply", &edit("Allowed independent lease"))
                .await["isError"],
            false
        );
    }
}

// A single executor thread must continue running timers while storage is blocked.
#[tokio::test(flavor = "current_thread")]
async fn accepted_cancellation_keeps_one_writer_and_bounded_receipts_off_executor() {
    use milagre_tools::{CallPhase, MutationOutcome};
    use std::sync::{Condvar, Mutex};
    let temp = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(temp.path(), &Policy::default()).unwrap();
    let live = Arc::new(AtomicBool::new(true));
    let owner = owner(isolation, None, live.clone());
    let desktop = caller("/alpha#1", live.clone());
    let regular = owner.session(desktop.clone()).unwrap();
    assert_eq!(
        regular.call("design_show", &show("First")).await["isError"],
        false
    );
    let html = temp
        .path()
        .join("artifacts")
        .join(milagre_content_store::chat_hash("/alpha#1"))
        .join("screen/v2.html");
    let entered = Arc::new(AtomicBool::new(false));
    let gate = Arc::new((Mutex::new(false), Condvar::new()));
    let mut blocked = desktop.clone();
    blocked.assert_active = Arc::new({
        let entered = entered.clone();
        let gate = gate.clone();
        move || {
            if html.exists() && !entered.swap(true, Ordering::SeqCst) {
                let lock = gate.0.lock().unwrap();
                let (_released, timeout) = gate
                    .1
                    .wait_timeout_while(lock, Duration::from_secs(3), |released| !*released)
                    .unwrap();
                assert!(
                    !timeout.timed_out(),
                    "Executor did not release blocked storage"
                );
            }
            Ok(())
        }
    });
    let slow = owner.session(blocked).unwrap();
    let other = owner.session(caller("/alpha#2", live)).unwrap();
    let accepted = slow
        .start_call("design_apply", &edit("Committed after cancellation"))
        .unwrap();
    let receipt = accepted.receipt();
    tokio::time::timeout(Duration::from_secs(1), async {
        while !entered.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(receipt.status().phase, CallPhase::Running);
    assert_eq!(receipt.status().mutation, MutationOutcome::Uncertain);
    drop(accepted);
    assert!(receipt.status().cancelled);
    // The same owner-wide limit applies across sessions and both Chat scopes.
    let mut queued = Vec::new();
    for _ in 0..15 {
        let call = other
            .start_call(
                "artifact_show",
                &json!({"title":"Must not save","html":"no"}),
            )
            .unwrap();
        queued.push(call.receipt());
        drop(call);
    }
    assert_eq!(
        regular
            .start_call("artifact_list", &json!({}))
            .err()
            .unwrap()
            .code,
        "CONTENT_BUSY"
    );
    for status in &queued {
        assert_eq!(status.status().phase, CallPhase::CancelledBeforeStart);
    }
    *gate.0.lock().unwrap() = true;
    gate.1.notify_all();
    tokio::time::timeout(Duration::from_secs(2), async {
        while receipt.status().phase != CallPhase::Finished {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(receipt.status().mutation, MutationOutcome::Committed);
    let saved = render(
        &owner,
        &desktop,
        "artifact:get",
        &json!({"chatId":"/alpha#1","id":"screen","format":"design"}),
    )
    .unwrap();
    assert_eq!(saved["version"], 2);
    assert_eq!(
        saved["document"]["nodes"][0]["text"],
        "Committed after cancellation"
    );
    let other_scope = owner
        .renderer_scope("/alpha#2", "/alpha", Arc::new(|| Ok(())))
        .unwrap();
    assert_eq!(
        owner
            .renderer(&other_scope, "artifact:list", &json!({"chatId":"/alpha#2"}))
            .unwrap(),
        json!([])
    );
    assert!(queued
        .iter()
        .all(|r| r.status().mutation == MutationOutcome::NotAttempted));
    assert!(owner.storage_fault().is_none());
}

#[test]
fn rpc_does_not_nest_blocking_workers_or_deadlock_a_single_worker_runtime() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()
        .unwrap();
    let temp = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(temp.path(), &Policy::default()).unwrap();
    let live = Arc::new(AtomicBool::new(true));
    let owner = owner(isolation, None, live.clone());
    let session = owner.session(caller("/alpha#1", live)).unwrap();
    runtime.block_on(async {
        let frame=jsjson::to_string(&json!({"jsonrpc":"2.0","id":"single-worker","method":"tools/call","params":{"name":"artifact_show","arguments":{"title":"From RPC","html":"<p>saved</p>"}}}));
        let reply=tokio::time::timeout(Duration::from_secs(2),session.dispatch(frame.as_bytes())).await.unwrap().unwrap();
        let reply=jsjson::parse_bytes(&reply).unwrap();
        assert_eq!(reply["id"],"single-worker");assert_eq!(reply["result"]["isError"],false);
    });
}

#[tokio::test]
async fn receipts_distinguish_validation_read_commit_and_uncertain_mutation_errors() {
    use milagre_tools::{CallPhase, MutationOutcome};
    let temp = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(temp.path(), &Policy::default()).unwrap();
    let live = Arc::new(AtomicBool::new(true));
    let owner = owner(isolation, None, live.clone());
    let session = owner.session(caller("/alpha#1", live)).unwrap();
    let cases = [
        (
            "design_show",
            json!({}),
            true,
            MutationOutcome::NotAttempted,
        ),
        (
            "artifact_list",
            json!({}),
            false,
            MutationOutcome::NotAttempted,
        ),
        (
            "design_show",
            show("Saved"),
            false,
            MutationOutcome::Committed,
        ),
        // Conservative: once a write handler starts, an error is not proof that
        // nothing committed. The adapter reads saved state and never replays.
        (
            "design_apply",
            json!({"id":"screen","expectedVersion":90,"operations":[{"op":"update","id":"label","patch":{"text":"no"}}]}),
            true,
            MutationOutcome::Uncertain,
        ),
    ];
    for (name, args, error, outcome) in cases {
        let accepted = session.start_call(name, &args).unwrap();
        let receipt = accepted.receipt();
        assert_eq!(accepted.wait().await["isError"], error);
        assert_eq!(receipt.status().phase, CallPhase::Finished);
        assert_eq!(receipt.status().mutation, outcome);
        assert!(!receipt.status().cancelled);
    }
}

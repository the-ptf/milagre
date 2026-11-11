use milagre_content_store::SystemRuntime;
use milagre_owner_store::{jsjson, Isolation, Policy};
use milagre_tools::{
    policy::{HostRole, HostTool, PolicyOptions, WakeRequest, REPLY_NOW},
    Caller, ContentOwner, DesignScope,
};
use serde_json::{json, Value};
use std::{
    path::Path,
    process::Command,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};
fn caller() -> Caller {
    Caller {
        chat_id: "/alpha#1".into(),
        project_id: "/alpha".into(),
        roots: vec![],
        read: true,
        write: true,
        html: true,
        designs: true,
        kits: true,
        design_scope: DesignScope::All,
        bundled_skills: Path::new("/fixture/skills").into(),
        assert_active: Arc::new(|| Ok(())),
    }
}
fn owner(temp: &Path) -> Arc<ContentOwner> {
    ContentOwner::open(
        Isolation::create(temp, &Policy::default()).unwrap(),
        "artifacts".into(),
        "kits".into(),
        Arc::new(|chat| {
            if chat == "/alpha#1" {
                Ok("/alpha".into())
            } else {
                Err(milagre_content_store::Error::new("Unknown Chat"))
            }
        }),
        Arc::new(|| Ok(())),
        Arc::new(SystemRuntime),
        None,
    )
    .unwrap()
}
fn escalation(owner: &Arc<ContentOwner>, stops: Arc<AtomicUsize>) -> PolicyOptions {
    let wake = owner
        .issue_wake(
            &caller(),
            vec![WakeRequest {
                chat_id: "/child#2".into(),
                request_id: "request-1".into(),
            }],
        )
        .unwrap();
    PolicyOptions::escalation(
        wake,
        Arc::new(move || {
            stops.fetch_add(1, Ordering::SeqCst);
        }),
    )
}

fn text(value: &Value) -> &str {
    value["content"][0]["text"].as_str().unwrap()
}
#[tokio::test]
async fn trusted_manifest_drives_both_discovery_and_provider_config() {
    let temp = tempfile::tempdir().unwrap();
    let owner = owner(temp.path());
    let ordinary = owner.session(caller()).unwrap();
    let list = ordinary.list().unwrap();
    let manifest = ordinary.provider_manifest();
    assert_eq!(manifest.len(), 14);
    for (tool, entry) in list["tools"].as_array().unwrap().iter().zip(&manifest) {
        assert_eq!(tool["name"], entry.name);
        assert_eq!(tool["annotations"]["readOnlyHint"], entry.read_only);
    }
    // Owner-supplied manifests can narrow capabilities, never relabel handlers.
    for manifest in [
        vec![HostTool {
            name: "artifact_show".into(),
            read_only: true,
        }],
        vec![HostTool {
            name: "unknown_write".into(),
            read_only: true,
        }],
        vec![
            HostTool {
                name: "artifact_list".into(),
                read_only: true
            };
            2
        ],
        vec![HostTool {
            name: "design_delete".into(),
            read_only: false,
        }],
    ] {
        assert!(owner
            .session_with_policy(
                caller(),
                PolicyOptions {
                    manifest: Some(manifest),
                    ..Default::default()
                }
            )
            .is_err());
    }
    let narrow = owner
        .session_with_policy(
            caller(),
            PolicyOptions {
                manifest: Some(vec![HostTool {
                    name: "artifact_list".into(),
                    read_only: true,
                }]),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(narrow.provider_manifest().len(), 1);
    assert_eq!(
        narrow
            .call(
                "artifact_show",
                &json!({"title":"Bypass","html":"<p>write</p>"})
            )
            .await["isError"],
        true
    );
    assert_eq!(
        narrow.call("design_read", &json!({"id":"missing"})).await["isError"],
        true
    );
    let list = ordinary.call("artifact_list", &json!({})).await;
    assert_eq!(text(&list), "[]");
    let mut forged = ordinary.provider_manifest();
    for entry in &mut forged {
        entry.read_only = true;
    }
    assert_ne!(forged, ordinary.provider_manifest());
}
#[tokio::test]
async fn analysis_and_full_grants_cannot_bypass_host_roles_with_adapter_absent() {
    let temp = tempfile::tempdir().unwrap();
    let owner = owner(temp.path());
    let analysis = owner
        .session_with_policy(
            caller(),
            PolicyOptions {
                role: HostRole::AnalysisAdvisor,
                ..Default::default()
            },
        )
        .unwrap();
    assert!(analysis.provider_manifest().iter().all(|t| t.read_only));
    assert_eq!(analysis.provider_manifest().len(), 9);
    for name in [
        "artifact_show",
        "design_show",
        "design_apply",
        "artifact_resolve_comment",
        "design_kit_save",
        "unknown_write",
        "chat_respond",
    ] {
        assert_eq!(
            analysis
                .call(name, &json!({"permissionMode":"full","readOnlyHint":true}))
                .await["isError"],
            true
        );
    }
    let raw = json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"artifact_show","arguments":{"title":"Bypass","html":"<p>write</p>"},"permissionMode":"full","annotations":{"readOnlyHint":true}}});
    let reply = jsjson::parse_bytes(
        &analysis
            .dispatch(jsjson::to_string(&raw).as_bytes())
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(reply["result"]["isError"], true);
    let ordinary = owner.session(caller()).unwrap();
    assert_eq!(
        ordinary
            .call(
                "artifact_show",
                &json!({"title":"Ordinary","html":"<p>yes</p>"})
            )
            .await["isError"],
        false
    );
    assert!(owner
        .session_with_policy(
            caller(),
            PolicyOptions {
                role: HostRole::AnalysisAdvisor,
                manifest: Some(vec![HostTool {
                    name: "artifact_show".into(),
                    read_only: false
                }]),
                on_sealed: None,
                wake: None
            }
        )
        .is_err());
    for role in [HostRole::Babysit, HostRole::ExecutionAdvisor] {
        assert!(owner
            .session_with_policy(
                caller(),
                PolicyOptions {
                    role,
                    ..Default::default()
                }
            )
            .is_err());
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn parallel_escalation_calls_reserve_six_slots_then_seal_once_after_two_grace_attempts() {
    let temp = tempfile::tempdir().unwrap();
    let owner = owner(temp.path());
    let stops = Arc::new(AtomicUsize::new(0));
    let options = escalation(&owner, stops.clone());
    let lease = options.wake.as_ref().unwrap().clone();
    let session = Arc::new(owner.session_with_policy(caller(), options).unwrap());
    let mut tasks = Vec::new();
    for _ in 0..32 {
        let session = session.clone();
        tasks.push(tokio::spawn(async move {
            session.call("artifact_list", &json!({})).await
        }));
    }
    let mut accepted = 0;
    for task in tasks {
        let reply = task.await.unwrap();
        if reply["isError"] == false {
            accepted += 1;
        } else {
            assert_eq!(text(&reply), REPLY_NOW);
        }
    }
    assert_eq!(accepted, 6);
    assert_eq!(stops.load(Ordering::SeqCst), 1);
    assert_eq!(session.budget_status().attempts, 9);
    assert!(session.budget_status().sealed);
    assert!(owner
        .session_with_policy(
            caller(),
            PolicyOptions::escalation(lease.clone(), Arc::new(|| {}))
        )
        .is_err());
    drop(session);
    assert!(owner
        .session_with_policy(
            caller(),
            PolicyOptions::escalation(lease.clone(), Arc::new(|| {}))
        )
        .is_err());
    assert_eq!(
        owner
            .session_with_policy(caller(), escalation(&owner, stops))
            .unwrap()
            .budget_status()
            .attempts,
        0
    );
}
#[tokio::test]
async fn wake_scope_is_immutable_and_unimplemented_responses_fail_closed() {
    let temp = tempfile::tempdir().unwrap();
    let owner = owner(temp.path());
    let stops = Arc::new(AtomicUsize::new(0));
    let mut options = escalation(&owner, stops.clone());
    let original = options.role.clone();
    let session = owner.session_with_policy(caller(), options).unwrap();
    assert_eq!(session.role(), &original);
    for args in [
        json!({"chatId":"/wrong#2","requestId":"request-1"}),
        json!({"chatId":"/child#2","requestId":"wrong"}),
        json!({"chatId":"/child#2","requestId":"request-1"}),
    ] {
        let reply = session.call("chat_respond", &args).await;
        assert_eq!(reply["isError"], true);
    }
    assert!(!session
        .provider_manifest()
        .iter()
        .any(|t| t.name == "chat_respond"));
    assert_eq!(
        session
            .call("artifact_list", &json!({"chatId":"/child#2"}))
            .await["isError"],
        true
    );
    for role in [
        HostRole::Escalation {
            wake_id: "".into(),
            requests: vec![],
        },
        HostRole::Escalation {
            wake_id: "bad".into(),
            requests: vec![WakeRequest {
                chat_id: "".into(),
                request_id: "r".into(),
            }],
        },
    ] {
        assert!(owner
            .session_with_policy(
                caller(),
                PolicyOptions {
                    role,
                    manifest: None,
                    on_sealed: Some(Arc::new(|| {})),
                    wake: None
                }
            )
            .is_err());
    }
    options = escalation(&owner, stops);
    options.on_sealed = None;
    assert!(owner.session_with_policy(caller(), options).is_err());
}
#[tokio::test]
async fn host_budget_matches_node_escalation_turn_without_provider_approvals() {
    let output = Command::new("node")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/host-policy.cjs"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let node: Value = jsjson::parse_bytes(&output.stdout).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let owner = owner(temp.path());
    let stops = Arc::new(AtomicUsize::new(0));
    let session = owner
        .session_with_policy(caller(), escalation(&owner, stops.clone()))
        .unwrap();
    for expected in node["calls"].as_array().unwrap() {
        let reply = session.call("artifact_list", &json!({})).await;
        assert_eq!(reply["isError"], expected["denial"].is_string());
        if let Some(error) = expected["denial"].as_str() {
            assert_eq!(text(&reply), error);
        }
        assert_eq!(
            session.budget_status().attempts,
            expected["calls"].as_u64().unwrap().min(9) as usize
        );
        assert_eq!(
            stops.load(Ordering::SeqCst),
            expected["stops"].as_u64().unwrap() as usize
        );
    }
}
#[tokio::test]
async fn denied_calls_count_and_stop_callback_panics_cannot_unseal_the_host() {
    let temp = tempfile::tempdir().unwrap();
    let owner = owner(temp.path());
    let calls = Arc::new(AtomicUsize::new(0));
    let mut options = escalation(&owner, calls.clone());
    options.on_sealed = Some(Arc::new({
        let calls = calls.clone();
        move || {
            calls.fetch_add(1, Ordering::SeqCst);
            panic!("fixture stop panic");
        }
    }));
    let session = owner.session_with_policy(caller(), options).unwrap();
    for index in 0..12 {
        let response = if index % 2 == 0 {
            session.call("unknown_write", &json!({})).await
        } else {
            session
                .call("artifact_list", &json!({"unexpected":true}))
                .await
        };
        assert_eq!(response["isError"], true);
        if index >= 6 {
            assert_eq!(text(&response), REPLY_NOW);
        }
    }
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(session.budget_status().sealed);
    assert_eq!(
        session.call("artifact_list", &json!({})).await["isError"],
        true
    );
}
#[test]
fn wake_leases_release_without_lifetime_exhaustion_and_cannot_be_rebound() {
    let temp = tempfile::tempdir().unwrap();
    let owner = owner(temp.path());
    let stops = Arc::new(AtomicUsize::new(0));
    let mut previous = None;
    for _ in 0..1024 {
        let options = escalation(&owner, stops.clone());
        let lease = options.wake.as_ref().unwrap().clone();
        if let Some(id) = previous {
            assert_ne!(lease.id(), id);
        }
        previous = Some(lease.id().to_owned());
        let session = owner.session_with_policy(caller(), options).unwrap();
        let endpoint = session.endpoint(&["artifact_list"]).unwrap();
        lease.release();
        assert!(session.list().is_err());
        assert!(endpoint.list().is_err());
        assert!(owner
            .session_with_policy(caller(), PolicyOptions::escalation(lease, Arc::new(|| {})))
            .is_err());
    }
    let mut forged = escalation(&owner, stops.clone());
    if let HostRole::Escalation { requests, .. } = &mut forged.role {
        requests[0].request_id = "other".into();
    }
    assert!(owner.session_with_policy(caller(), forged).is_err());
    let mut forged = escalation(&owner, stops);
    if let HostRole::Escalation { wake_id, .. } = &mut forged.role {
        *wake_id = "made-up".into();
    }
    assert!(owner.session_with_policy(caller(), forged).is_err());
    assert!(owner.session(caller()).is_ok());
}

fn external_schema(name: &str, effect: milagre_tools::ToolEffect) -> Value {
    let input = if effect == milagre_tools::ToolEffect::WakeResponse {
        json!({"type":"object","additionalProperties":false,"properties":{"chatId":{"type":"string"},"requestId":{"type":"string"},"decision":{"type":"string","enum":["allow","deny"]}},"required":["chatId","requestId","decision"]})
    } else {
        json!({"type":"object","additionalProperties":false,"properties":{}})
    };
    json!({"name":name,"description":"Fixture handler only","inputSchema":input,"annotations":{"readOnlyHint":effect==milagre_tools::ToolEffect::Read}})
}
fn external(
    name: &str,
    effect: milagre_tools::ToolEffect,
    calls: Arc<AtomicUsize>,
) -> milagre_tools::RegisteredTool {
    use milagre_tools::RegisteredTool;
    let name = name.to_owned();
    let handler_name = name.clone();
    RegisteredTool::new(
        external_schema(&name, effect),
        effect,
        Arc::new(move |context, args| {
            // This fixture implements the retained handler's own argument checks;
            // matching a wake pair never licenses an arbitrary response payload.
            if handler_name == "chat_respond"
                && !matches!(args["decision"].as_str(), Some("allow" | "deny"))
            {
                return Err(milagre_content_store::Error::new(
                    "Invalid fixture response decision",
                ));
            }
            context.assert_active()?;
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(json!({"content":[{"type":"text","text":"fixture"}],"isError":false}))
        }),
    )
    .unwrap()
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn complete_host_registry_and_endpoints_share_one_budget_and_manifest() {
    use milagre_tools::ToolEffect;
    let temp = tempfile::tempdir().unwrap();
    let shared = owner(temp.path());
    let stops = Arc::new(AtomicUsize::new(0));
    let calls = Arc::new(AtomicUsize::new(0));
    let host = shared
        .host_session(
            caller(),
            escalation(&shared, stops.clone()),
            vec![
                external("chat_read", ToolEffect::Read, calls.clone()),
                external("chat_respond", ToolEffect::WakeResponse, calls.clone()),
            ],
        )
        .unwrap();
    let content = host.endpoint(&["artifact_list"]).unwrap();
    let chat = host.endpoint(&["chat_read", "chat_respond"]).unwrap();
    assert_eq!(host.host_manifest(), content.host_manifest());
    assert_eq!(host.host_manifest(), chat.host_manifest());
    assert_eq!(chat.provider_manifest().len(), 2);
    assert!(chat
        .provider_manifest()
        .iter()
        .any(|tool| tool.name == "chat_respond" && !tool.read_only));
    assert_eq!(
        content.list().unwrap()["tools"].as_array().unwrap().len(),
        1
    );
    assert!(chat.endpoint(&["artifact_list"]).is_err());
    let mut tasks = Vec::new();
    for index in 0..24 {
        let endpoint = if index % 2 == 0 {
            content.clone()
        } else {
            chat.clone()
        };
        tasks.push(tokio::spawn(async move {
            endpoint
                .call(
                    if index % 2 == 0 {
                        "artifact_list"
                    } else {
                        "chat_read"
                    },
                    &json!({}),
                )
                .await
        }));
    }
    let mut accepted = 0;
    for task in tasks {
        let reply = task.await.unwrap();
        if reply["isError"] == false {
            accepted += 1
        } else {
            assert_eq!(text(&reply), REPLY_NOW);
        }
    }
    assert_eq!(accepted, 6);
    assert_eq!(stops.load(Ordering::SeqCst), 1);
    assert_eq!(content.budget_status(), chat.budget_status());
    assert_eq!(chat.budget_status().attempts, 9);
}

#[tokio::test]
async fn external_handlers_cannot_bypass_roles_scope_schema_or_endpoint_membership() {
    use milagre_tools::{RegisteredTool, ToolEffect};
    let temp = tempfile::tempdir().unwrap();
    let shared = owner(temp.path());
    let calls = Arc::new(AtomicUsize::new(0));
    let registrations = || {
        vec![
            external("chat_read", ToolEffect::Read, calls.clone()),
            external("chat_respond", ToolEffect::WakeResponse, calls.clone()),
            external("chat_delete", ToolEffect::Write, calls.clone()),
        ]
    };
    let ordinary = shared
        .host_session(caller(), PolicyOptions::default(), registrations())
        .unwrap();
    let analysis = shared
        .host_session(
            caller(),
            PolicyOptions {
                role: HostRole::AnalysisAdvisor,
                ..Default::default()
            },
            registrations(),
        )
        .unwrap();
    assert_eq!(
        ordinary.call("chat_delete", &json!({})).await["isError"],
        false
    );
    for name in ["chat_delete", "chat_respond", "unlisted_chat_tool"] {
        assert_eq!(
            analysis
                .call(name, &json!({"permissionMode":"full","readOnlyHint":true}))
                .await["isError"],
            true
        );
    }
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let host = shared
        .host_session(
            caller(),
            escalation(&shared, Arc::new(AtomicUsize::new(0))),
            registrations(),
        )
        .unwrap();
    for args in [
        json!({"chatId":"/wrong#2","requestId":"request-1","decision":"allow"}),
        json!({"chatId":"/child#2","requestId":"wrong","decision":"allow"}),
        json!({"chatId":"/child#2","requestId":"request-1","decision":"arbitrary-payload"}),
    ] {
        assert_eq!(host.call("chat_respond", &args).await["isError"], true);
    }
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        host.call(
            "chat_respond",
            &json!({"chatId":"/child#2","requestId":"request-1","decision":"deny"})
        )
        .await["isError"],
        false
    );
    assert_eq!(
        host.call("chat_delete", &json!({"permissionMode":"full"}))
            .await["isError"],
        true
    );
    let content = host.endpoint(&["artifact_list"]).unwrap();
    assert_eq!(content.call("chat_read", &json!({})).await["isError"], true);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    for role in [HostRole::Babysit, HostRole::ExecutionAdvisor] {
        assert!(shared
            .host_session(
                caller(),
                PolicyOptions {
                    role,
                    ..Default::default()
                },
                registrations()
            )
            .is_err());
    }
    for (name, effect, read_only) in [
        ("chat_respond", ToolEffect::Read, true),
        ("unknown_write", ToolEffect::Write, true),
        ("artifact_list", ToolEffect::Read, true),
    ] {
        assert!(RegisteredTool::new(
            json!({"name":name,"inputSchema":{},"annotations":{"readOnlyHint":read_only}}),
            effect,
            Arc::new(|_, _| panic!("unreachable"))
        )
        .is_err());
    }
}

#[tokio::test(flavor = "current_thread")]
async fn release_revokes_inflight_external_commit_and_all_derived_endpoints() {
    use milagre_tools::{RegisteredTool, ToolEffect};
    use std::sync::{Condvar, Mutex};
    let temp = tempfile::tempdir().unwrap();
    let shared = owner(temp.path());
    let other_temp = tempfile::tempdir().unwrap();
    let foreign = owner(other_temp.path());
    let entered = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let gate = Arc::new((Mutex::new(false), Condvar::new()));
    let writes = Arc::new(AtomicUsize::new(0));
    let options = escalation(&shared, Arc::new(AtomicUsize::new(0)));
    let lease = options.wake.as_ref().unwrap().clone();
    assert!(foreign
        .session_with_policy(
            caller(),
            PolicyOptions::escalation(lease.clone(), Arc::new(|| {}))
        )
        .is_err());
    let tool = RegisteredTool::new(
        external_schema("chat_respond", ToolEffect::WakeResponse),
        ToolEffect::WakeResponse,
        Arc::new({
            let gate = gate.clone();
            let entered = entered.clone();
            let writes = writes.clone();
            move |context, args| {
                if args["decision"] != "allow" {
                    return Err(milagre_content_store::Error::new(
                        "Invalid fixture response",
                    ));
                }
                entered.store(true, Ordering::SeqCst);
                let (_guard, timeout) = gate
                    .1
                    .wait_timeout_while(
                        gate.0.lock().unwrap(),
                        std::time::Duration::from_secs(2),
                        |ready| !*ready,
                    )
                    .unwrap();
                assert!(!timeout.timed_out());
                context.assert_active()?;
                writes.fetch_add(1, Ordering::SeqCst);
                Ok(json!({"content":[],"isError":false}))
            }
        }),
    )
    .unwrap();
    let host = shared.host_session(caller(), options, vec![tool]).unwrap();
    let endpoint = host.endpoint(&["chat_respond"]).unwrap();
    let accepted = endpoint
        .start_call(
            "chat_respond",
            &json!({"chatId":"/child#2","requestId":"request-1","decision":"allow"}),
        )
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        while !entered.load(Ordering::SeqCst) {
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    lease.release();
    *gate.0.lock().unwrap() = true;
    gate.1.notify_all();
    assert_eq!(accepted.wait().await["isError"], true);
    assert_eq!(writes.load(Ordering::SeqCst), 0);
    assert!(host.list().is_err());
    assert!(endpoint.list().is_err());
    assert!(shared.storage_fault().is_none());
    assert!(shared
        .session_with_policy(caller(), PolicyOptions::escalation(lease, Arc::new(|| {})))
        .is_err());
}

#[tokio::test(flavor = "current_thread")]
async fn external_actor_wait_does_not_hold_the_renderer_storage_lane() {
    use milagre_tools::{RegisteredTool, ToolEffect};
    use std::sync::{mpsc, Mutex};
    use std::time::Duration;
    let temp = tempfile::tempdir().unwrap();
    let shared = owner(temp.path());
    let (send, receive) = mpsc::sync_channel(1);
    let receive = Mutex::new(receive);
    let entered = Arc::new(AtomicUsize::new(0));
    let tool = RegisteredTool::new(
        external_schema("chat_read", ToolEffect::Read),
        ToolEffect::Read,
        Arc::new({
            let entered = entered.clone();
            move |context, _| {
                entered.store(1, Ordering::SeqCst);
                receive
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(2))
                    .map_err(|_| milagre_content_store::Error::new("Actor reply did not arrive"))?;
                context.assert_active()?;
                Ok(json!({"content":[],"isError":false}))
            }
        }),
    )
    .unwrap();
    let session = shared
        .host_session(caller(), PolicyOptions::default(), vec![tool])
        .unwrap();
    let accepted = session.start_call("chat_read", &json!({})).unwrap();
    tokio::time::timeout(Duration::from_secs(1), async {
        while entered.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    let actor = tokio::task::spawn_blocking(move || {
        let scope = shared
            .renderer_scope("/alpha#1", "/alpha", Arc::new(|| Ok(())))
            .unwrap();
        let value = shared
            .renderer(&scope, "artifact:list", &json!({"chatId":"/alpha#1"}))
            .unwrap();
        send.send(()).unwrap();
        value
    });
    assert_eq!(
        tokio::time::timeout(Duration::from_millis(500), actor)
            .await
            .unwrap()
            .unwrap(),
        json!([])
    );
    assert_eq!(accepted.wait().await["isError"], false);
}

#[tokio::test(flavor = "current_thread")]
async fn external_timeouts_keep_worker_slots_and_refuse_late_commit_without_blocking_content() {
    use milagre_tools::{MutationOutcome, RegisteredTool, ToolEffect};
    use std::sync::{Condvar, Mutex};
    use std::time::Duration;
    let temp = tempfile::tempdir().unwrap();
    let shared = owner(temp.path());
    let gate = Arc::new((Mutex::new(false), Condvar::new()));
    let entered = Arc::new(AtomicUsize::new(0));
    let exited = Arc::new(AtomicUsize::new(0));
    let writes = Arc::new(AtomicUsize::new(0));
    let tool = RegisteredTool::new(
        external_schema("chat_write", ToolEffect::Write),
        ToolEffect::Write,
        Arc::new({
            let gate = gate.clone();
            let entered = entered.clone();
            let exited = exited.clone();
            let writes = writes.clone();
            move |context, _| {
                entered.fetch_add(1, Ordering::SeqCst);
                let (_lock, timeout) = gate
                    .1
                    .wait_timeout_while(gate.0.lock().unwrap(), Duration::from_secs(3), |open| {
                        !*open
                    })
                    .unwrap();
                assert!(!timeout.timed_out());
                let active = context.assert_active();
                exited.fetch_add(1, Ordering::SeqCst);
                active?;
                writes.fetch_add(1, Ordering::SeqCst);
                Ok(json!({"content":[],"isError":false}))
            }
        }),
    )
    .unwrap()
    .with_timeout(Duration::from_millis(100))
    .unwrap();
    let session = shared
        .host_session(caller(), PolicyOptions::default(), vec![tool])
        .unwrap();
    let mut accepted = Vec::new();
    for _ in 0..8 {
        accepted.push(session.start_call("chat_write", &json!({})).unwrap());
    }
    tokio::time::timeout(Duration::from_secs(1), async {
        while entered.load(Ordering::SeqCst) < 8 {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    // One explicit cancellation and seven timeouts use the same scoped commit guard.
    accepted[0].cancel();
    for call in accepted {
        let receipt = call.receipt();
        assert_eq!(call.wait().await["isError"], true);
        assert_eq!(receipt.status().mutation, MutationOutcome::Uncertain);
    }
    let denied = session.call("chat_write", &json!({})).await;
    assert_eq!(denied["isError"], true);
    assert!(text(&denied).contains("capacity"));
    assert_eq!(
        session.call("artifact_list", &json!({})).await["isError"],
        false
    );
    assert_eq!(entered.load(Ordering::SeqCst), 8);
    *gate.0.lock().unwrap() = true;
    gate.1.notify_all();
    tokio::time::timeout(Duration::from_secs(1), async {
        while exited.load(Ordering::SeqCst) < 8 {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(writes.load(Ordering::SeqCst), 0);
    assert!(shared.storage_fault().is_none());
}

#[tokio::test]
async fn registered_schema_rejects_unvalidated_payloads_before_callbacks() {
    use milagre_tools::{RegisteredTool, ToolEffect};
    let temp = tempfile::tempdir().unwrap();
    let shared = owner(temp.path());
    let calls = Arc::new(AtomicUsize::new(0));
    let session = shared
        .host_session(
            caller(),
            PolicyOptions::default(),
            vec![external(
                "chat_respond",
                ToolEffect::WakeResponse,
                calls.clone(),
            )],
        )
        .unwrap();
    for args in [
        json!({}),
        json!({"chatId":3,"requestId":"r","decision":"allow"}),
        json!({"chatId":"c","requestId":"r","decision":"allow","otherChat":"b"}),
        json!({"chatId":"c","requestId":"r","decision":"unsupported"}),
    ] {
        assert_eq!(session.call("chat_respond", &args).await["isError"], true);
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let mut schema = external_schema("chat_read", ToolEffect::Read);
    schema["inputSchema"]["patternProperties"] = json!({".*":{"type":"string"}});
    assert!(RegisteredTool::new(
        schema,
        ToolEffect::Read,
        Arc::new(|_, _| panic!("must not register"))
    )
    .is_err());
}

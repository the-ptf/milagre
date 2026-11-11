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
fn escalation(id: &str, stops: Arc<AtomicUsize>) -> PolicyOptions {
    PolicyOptions {
        role: HostRole::Escalation {
            wake_id: id.into(),
            requests: vec![WakeRequest {
                chat_id: "/child#2".into(),
                request_id: "request-1".into(),
            }],
        },
        manifest: None,
        on_sealed: Some(Arc::new(move || {
            stops.fetch_add(1, Ordering::SeqCst);
        })),
    }
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
                on_sealed: None
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
    let session = Arc::new(
        owner
            .session_with_policy(caller(), escalation("wake-parallel", stops.clone()))
            .unwrap(),
    );
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
        .session_with_policy(caller(), escalation("wake-parallel", stops.clone()))
        .is_err());
    drop(session);
    assert!(owner
        .session_with_policy(caller(), escalation("wake-parallel", stops.clone()))
        .is_err());
    assert_eq!(
        owner
            .session_with_policy(caller(), escalation("new-wake", stops))
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
    let mut options = escalation("scope", stops.clone());
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
                    on_sealed: Some(Arc::new(|| {}))
                }
            )
            .is_err());
    }
    options = escalation("no-stop", stops);
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
        .session_with_policy(caller(), escalation("node", stops.clone()))
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
    let mut options = escalation("denials", calls.clone());
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
fn wake_admission_is_bounded_and_cannot_relabel_an_existing_wake() {
    let temp = tempfile::tempdir().unwrap();
    let owner = owner(temp.path());
    let stops = Arc::new(AtomicUsize::new(0));
    for index in 0..256 {
        owner
            .session_with_policy(
                caller(),
                escalation(&format!("wake-{index}"), stops.clone()),
            )
            .unwrap();
    }
    assert!(owner
        .session_with_policy(caller(), escalation("wake-over-limit", stops.clone()))
        .is_err());
    let mut relabeled = escalation("wake-0", stops);
    if let HostRole::Escalation { requests, .. } = &mut relabeled.role {
        requests[0].request_id = "other-request".into();
    }
    assert!(owner.session_with_policy(caller(), relabeled).is_err());
    assert!(owner.session(caller()).is_ok());
}

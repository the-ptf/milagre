//! Guard enforcement and constrained bootstrap, with Node policy fixtures and a fake app-server.
mod common;
use common::*;
use milagre_providers::codex::{
    guard::*,
    session::{chat_thread, prompt_input, turn},
    *,
};
use milagre_providers::queue::EventReceiver;
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc, time::Duration};

fn fixtures() -> Value {
    serde_json::from_str(include_str!("fixtures/conformance/codex-guards.json")).unwrap()
}
fn wake_requests() -> Vec<WakeRequest> {
    vec![WakeRequest { chat_id: "child".into(), request_id: "request".into() }]
}
fn linked() -> LinkedTools {
    LinkedTools {
        url: "http://127.0.0.1:1234/mcp".into(),
        tools: vec![
            HostTool { name: "read_linked_file".into(), read_only: true },
            HostTool { name: "chat_respond".into(), read_only: false },
        ],
    }
}
fn policy() -> CodexPolicy {
    codex_policy(PermissionMode::Full, "/repo", &[], false, false)
}
fn options(role: SessionRole, scenario: &str) -> SessionOptions {
    let mut options = SessionOptions::new(ConnectOptions::new(fake(scenario), "test"), "/repo");
    options.role = role;
    options.forward_raw_notifications = true;
    options.interrupt_grace = Duration::from_millis(100);
    options
}
fn message() -> TurnSettings {
    let mut settings = turn(prompt_input("hello", &[]), None, policy());
    settings.permission_mode = Some(PermissionMode::Full);
    settings
}
async fn start(options: SessionOptions) -> (CodexSession, EventReceiver<SessionEvent>) {
    CodexSession::start(options, chat_thread(None, policy())).await.unwrap()
}
async fn next(events: &mut EventReceiver<SessionEvent>, pick: impl Fn(&SessionEvent) -> bool) -> SessionEvent {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = events.recv().await.unwrap();
            if pick(&event) {
                return event;
            }
        }
    })
    .await
    .expect("expected session event")
}
async fn ask(session: &CodexSession, events: &mut EventReceiver<SessionEvent>, id: &str, method: &str, params: Value) -> Value {
    session.client().rpc().request("fake/server-request", json!({"id":id,"method":method,"params":params})).await.unwrap();
    match next(events, |e| matches!(e,SessionEvent::Notification(n) if n.method=="fake/answered" && n.params["id"]==id)).await {
        SessionEvent::Notification(n) => n.params["answer"].clone(),
        _ => unreachable!(),
    }
}
fn mcp(tool: &str, input: Value) -> Value {
    json!({"serverName":"milagre","mode":"form","message":format!("Allow the milagre MCP server to run tool \"{tool}\"?"),"requestedSchema":{"type":"object","properties":{}},"_meta":{"codex_approval_kind":"mcp_tool_call","tool_params":input}})
}
async fn frames(session: &CodexSession) -> Vec<Value> {
    session.client().rpc().request("fake/received", json!({})).await.unwrap()["received"].as_array().unwrap().clone()
}

/// Test-only oracle. Production must supply a complete trusted parser; this refuses all other text.
#[derive(Debug)]
struct FixtureClassifier;
impl CommandClassifier for FixtureClassifier {
    fn actions(&self, command: &str) -> Result<Vec<RemoteAction>, String> {
        fixtures()["babysit"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["command"] == command)
            .map(|c| serde_json::from_value(c["actions"].clone()).unwrap())
            .ok_or("unclassified".into())
    }
}

#[test]
fn guard_decisions_and_advisor_config_match_node() {
    let f = fixtures();
    for c in f["babysit"].as_array().unwrap() {
        let actions = serde_json::from_value::<Vec<RemoteAction>>(c["actions"].clone()).unwrap();
        assert_eq!(
            json!(babysit_denial(&actions, c["level"].as_u64().unwrap() as u8, c["resolveThreads"].as_bool().unwrap())),
            c["denial"]
        );
    }
    for c in f["advisors"].as_array().unwrap() {
        assert_eq!(advisor_config(&c["inherited"], c["url"].as_str()).unwrap(), c["expected"]);
        let p = SessionRole::AnalysisAdvisor.policy(&policy());
        assert_eq!(json!({"approvalPolicy":p.approval_policy,"sandbox":p.sandbox,"sandboxPolicy":p.sandbox_policy}), c["policy"]);
    }
    for c in f["escalation"].as_array().unwrap() {
        let call = &c["call"];
        assert_eq!(
            json!(escalation_denial(
                &wake_requests(),
                c["calls"].as_u64().unwrap() as usize,
                call["name"].as_str().unwrap(),
                &call["input"],
                call["readOnly"].as_bool().unwrap_or(false)
            )),
            c["denial"]
        );
        assert_eq!(c["calls"].as_u64().unwrap() as usize > ESCALATION_TOOL_CALLS + ESCALATION_TOOL_GRACE, c["stopped"].as_bool().unwrap());
    }
    assert_eq!(f["toolCalls"], ESCALATION_TOOL_CALLS);
    assert_eq!(f["toolGrace"], ESCALATION_TOOL_GRACE);
}

#[tokio::test]
async fn babysit_full_and_steering_cannot_bypass_node_decisions() {
    for level in [1, 3, 5] {
        let mut opts = options(SessionRole::Babysit { level, resolve_threads: true }, "slow");
        opts.command_classifier = Some(Arc::new(FixtureClassifier));
        let (session, mut events) = start(opts).await;
        session.send(message()).await.unwrap();
        session.set_permission_mode(PermissionMode::Full).await;
        assert!(session.send(message()).await.unwrap().steered);
        for (i, c) in
            fixtures()["babysit"].as_array().unwrap().iter().filter(|c| c["level"] == level && c["resolveThreads"] == true).enumerate()
        {
            let answer = ask(
                &session,
                &mut events,
                &format!("command-{i}"),
                "item/commandExecution/requestApproval",
                json!({"command":c["command"]}),
            )
            .await;
            assert_eq!(answer["decision"], if c["denial"].is_null() { "accept" } else { "decline" }, "{c}");
        }
        assert_eq!(
            ask(&session, &mut events, "unknown", "item/commandExecution/requestApproval", json!({"command":"unrecognized syntax"})).await
                ["decision"],
            "decline"
        );
        assert_eq!(ask(&session, &mut events, "missing", "item/commandExecution/requestApproval", json!({})).await["decision"], "decline");
        assert_eq!(
            ask(&session, &mut events, "mcp", "mcpServer/elicitation/request", mcp("tasks_set", json!({}))).await["action"],
            "decline"
        );
        for frame in frames(&session).await {
            if frame["method"] == "thread/start" || frame["method"] == "turn/start" {
                assert_eq!(frame["params"]["approvalPolicy"], "untrusted");
            }
        }
        session.close().await;
    }
}

#[tokio::test]
async fn advisor_bootstrap_disables_inherited_servers_and_forces_read_only() {
    let (session, mut events) = start(options(SessionRole::AnalysisAdvisor, "slow")).await;
    session.send(message()).await.unwrap();
    session.set_permission_mode(PermissionMode::Full).await;
    let all = frames(&session).await;
    assert!(
        all.iter().position(|f| f["method"] == "config/read").unwrap() < all.iter().position(|f| f["method"] == "thread/start").unwrap()
    );
    for frame in &all {
        if frame["method"] == "initialize" {
            assert_eq!(frame["params"]["capabilities"]["experimentalApi"], true);
        }
        if frame["method"] == "thread/start" {
            let p = &frame["params"];
            assert_eq!(p["sandbox"], "read-only");
            assert_eq!(p["config"]["mcp_servers"]["github"]["enabled"], false);
            assert_eq!(p["config"]["mcp_servers"]["milagre"]["enabled"], false);
            assert_eq!(p["config"]["features"]["shell_tool"], false);
            assert_eq!(p["environments"], json!([]));
        }
        if frame["method"] == "turn/start" {
            assert_eq!(frame["params"]["approvalPolicy"], "never");
            assert_eq!(frame["params"]["sandboxPolicy"], json!({"type":"readOnly","networkAccess":false}));
        }
    }
    for method in ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"] {
        assert_eq!(ask(&session, &mut events, method, method, json!({"command":"git status"})).await["decision"], "decline");
    }
    assert_eq!(ask(&session, &mut events, "mcp", "mcpServer/elicitation/request", mcp("tasks_set", json!({}))).await["action"], "decline");
    assert_eq!(
        ask(&session, &mut events, "question", "item/tool/requestUserInput", json!({"questions":[{"id":"q","question":"Proceed?"}]})).await,
        json!({"answers":{}})
    );
    let mut invalid = message();
    invalid.extra.insert("sandboxPolicy".into(), json!({"type":"dangerFullAccess"}));
    assert!(matches!(session.send(invalid).await, Err(SessionError::UnsupportedPolicy(_))));
    session.close().await;
}

#[tokio::test]
async fn escalation_allows_only_manifest_reads_and_authorized_requests() {
    let mut opts = options(SessionRole::Escalation { requests: wake_requests() }, "slow");
    opts.linked_tools = Some(linked());
    let (session, mut events) = start(opts).await;
    session.send(message()).await.unwrap();
    session.set_permission_mode(PermissionMode::Full).await;
    assert!(session.send(message()).await.unwrap().steered);
    for (i, c) in fixtures()["escalation"].as_array().unwrap().iter().filter(|c| c["calls"] == 0).enumerate() {
        let answer = ask(
            &session,
            &mut events,
            &format!("wake-{i}"),
            "mcpServer/elicitation/request",
            mcp(c["call"]["name"].as_str().unwrap(), c["call"]["input"].clone()),
        )
        .await;
        assert_eq!(answer["action"], if c["denial"].is_null() { "accept" } else { "decline" });
    }
    let mut foreign = mcp("read_linked_file", json!({}));
    foreign["serverName"] = "external".into();
    assert_eq!(ask(&session, &mut events, "foreign", "mcpServer/elicitation/request", foreign).await["action"], "decline");
    assert_eq!(
        ask(&session, &mut events, "cmd", "item/commandExecution/requestApproval", json!({"command":"git status"})).await["decision"],
        "decline"
    );
    assert_eq!(ask(&session, &mut events, "file", "item/fileChange/requestApproval", json!({})).await["decision"], "decline");
    assert_eq!(
        ask(&session, &mut events, "perms", "item/permissions/requestApproval", json!({})).await,
        json!({"permissions":{},"scope":"turn"})
    );
    session.close().await;
}

#[tokio::test]
async fn escalation_budget_deduplicates_current_items_and_interrupts_after_grace() {
    let mut opts = options(SessionRole::Escalation { requests: wake_requests() }, "slow");
    opts.linked_tools = Some(linked());
    let (session, mut events) = start(opts).await;
    session.send(message()).await.unwrap();
    for (thread, turn, id) in [("foreign", "turn-1", "x"), ("thread-1", "old", "y")] {
        session
            .client()
            .rpc()
            .request(
                "fake/notify",
                json!({"method":"item/started","params":{"threadId":thread,"turnId":turn,"item":{"type":"mcpToolCall","id":id}}}),
            )
            .await
            .unwrap();
    }
    for n in 1..=9 {
        // Each notification is duplicated to prove a replay cannot spend the budget twice.
        for _ in 0..2 {
            session.client().rpc().request("fake/notify",json!({"method":"item/started","params":{"threadId":"thread-1","turnId":"turn-1","item":{"type":"mcpToolCall","id":format!("tool-{n}"),"server":"milagre","tool":"read_linked_file"}}})).await.unwrap();
        }
        if n <= 8 {
            let answer =
                ask(&session, &mut events, &format!("call-{n}"), "mcpServer/elicitation/request", mcp("read_linked_file", json!({}))).await;
            assert_eq!(answer["action"], if n <= 6 { "accept" } else { "decline" });
        }
    }
    let ended = next(&mut events, |e| matches!(e, SessionEvent::TurnEnded { .. })).await;
    assert!(matches!(ended, SessionEvent::TurnEnded { end: TurnEnd::Cancelled, .. }));
    session.close().await;
}

fn trace_options(role: SessionRole, scenario: &str) -> (SessionOptions, PathBuf) {
    let path = std::env::temp_dir().join(format!(
        "milagre-guards-{}-{}.jsonl",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    ));
    let mut opts = options(role, scenario);
    opts.connect.spawn.env.as_mut().unwrap().push(("FAKE_TRACE_FILE".into(), path.clone().into_os_string()));
    (opts, path)
}
fn read_trace(path: &PathBuf) -> Vec<Value> {
    std::fs::read_to_string(path).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
}

#[tokio::test]
async fn constrained_discovery_failure_and_config_rejection_never_downgrade() {
    for scenario in ["config-error", "reject-config"] {
        for role in [
            SessionRole::AnalysisAdvisor,
            SessionRole::Escalation { requests: wake_requests() },
            SessionRole::Babysit { level: 3, resolve_threads: false },
        ] {
            let (mut opts, path) = trace_options(role, scenario);
            opts.command_classifier = Some(Arc::new(FixtureClassifier));
            assert!(CodexSession::start(opts, chat_thread(None, policy())).await.is_err());
            let all = read_trace(&path);
            std::fs::remove_file(path).unwrap();
            let attempts: Vec<_> = all.iter().filter(|f| f["method"] == "thread/start").collect();
            assert_eq!(attempts.len(), usize::from(scenario == "reject-config"));
            for attempt in attempts {
                assert_eq!(attempt["params"]["config"]["mcp_servers"]["github"]["enabled"], false);
            }
        }
    }
}

#[tokio::test]
async fn ordinary_fallback_preserves_disabled_servers_and_reports_lost_linked_tools() {
    for resume in [false, true] {
        let mut opts = options(SessionRole::Ordinary, "fallback");
        opts.everywhere_servers = vec!["extra".into(), "off".into()];
        if resume {
            opts.resume_thread_id = Some("saved".into());
        }
        let mut thread = chat_thread(None, policy());
        thread.config = Some(
            json!({"features":{"default_mode_request_user_input":true},"mcp_servers":{"extra":{"url":"http://extra"},"off":{"enabled":false},"milagre":{"url":"http://linked"}}}),
        );
        let (session, _) = CodexSession::start(opts, thread).await.unwrap();
        assert!(!session.linked_tools_available());
        let all = frames(&session).await;
        let attempts: Vec<_> = all.iter().filter(|f| f["method"] == if resume { "thread/resume" } else { "thread/start" }).collect();
        assert_eq!(attempts.len(), 3);
        for attempt in attempts {
            assert_eq!(attempt["params"]["config"]["mcp_servers"]["off"]["enabled"], false);
        }
        session.close().await;
    }
}

#[test]
fn disabled_servers_never_reappear_and_invalid_configs_are_explicit_errors() {
    let params = json!({"config":{"mcp_servers":{"off":{"enabled":false},"milagre":{"enabled":false}}}});
    assert_eq!(config_attempts(&params, &["off".into()], false).unwrap(), vec![params.clone()]);
    assert_eq!(config_attempts(&params, &[], true).unwrap(), vec![params]);
    for config in [json!(null), json!({"mcp_servers":false}), json!({"mcp_servers":{"bad":{"enabled":"false"}}})] {
        assert!(config_attempts(&json!({"config":config}), &[], false).is_err());
    }
    assert!(advisor_config(&json!(null), None).is_err());
    assert!(advisor_config(&json!({"mcp_servers":null}), None).is_err());
}

#[tokio::test]
async fn unsupported_roles_and_missing_classifier_fail_before_spawning() {
    for role in [
        SessionRole::ExecutionAdvisor,
        SessionRole::Babysit { level: 1, resolve_threads: false },
        SessionRole::Babysit { level: 0, resolve_threads: false },
        SessionRole::Escalation { requests: vec![] },
    ] {
        let (mut opts, path) = trace_options(role, "slow");
        opts.connect.spawn.command = "/missing-codex".into();
        assert!(matches!(CodexSession::start(opts, chat_thread(None, policy())).await, Err(SessionError::UnsupportedPolicy(_))));
        assert!(!path.exists());
    }
    let mut opts = options(SessionRole::AnalysisAdvisor, "slow");
    opts.linked_tools = Some(linked());
    assert!(matches!(CodexSession::start(opts, chat_thread(None, policy())).await, Err(SessionError::UnsupportedPolicy(_))));
    let mut thread = chat_thread(None, policy());
    thread.extra.insert("config".into(), json!({}));
    assert!(matches!(
        CodexSession::start(options(SessionRole::AnalysisAdvisor, "slow"), thread).await,
        Err(SessionError::UnsupportedPolicy(_))
    ));
}

#[tokio::test]
async fn remote_write_permissions_cannot_be_persisted_for_the_chat() {
    for role in [SessionRole::Ordinary, SessionRole::Babysit { level: 5, resolve_threads: true }] {
        let babysit = matches!(role, SessionRole::Babysit { .. });
        let mut opts = options(role, "slow");
        opts.command_classifier = Some(Arc::new(FixtureClassifier));
        let (session, mut events) = start(opts).await;
        session.send(message()).await.unwrap();
        session.set_permission_mode(PermissionMode::Ask).await;
        session
            .client()
            .rpc()
            .request(
                "fake/server-request",
                json!({"id":"push","method":"item/commandExecution/requestApproval","params":{"command":"git push origin HEAD"}}),
            )
            .await
            .unwrap();
        let card = next(&mut events, |e| matches!(e,SessionEvent::Agent(v) if v["type"]=="permission-request")).await;
        assert!(matches!(card,SessionEvent::Agent(v) if v["allowForChat"]==false));
        assert!(session.respond_to_permission("push", milagre_providers::codex::approvals::Decision::AllowForChat).await.unwrap());
        let answer =
            next(&mut events, |e| matches!(e,SessionEvent::Notification(n) if n.method=="fake/answered" && n.params["id"]=="push")).await;
        assert!(matches!(answer,SessionEvent::Notification(n) if n.params["answer"]["decision"]=="accept"));
        // A forbidden command is never pending, so a concurrent Full mode switch has nothing to allow.
        session.set_permission_mode(PermissionMode::Ask).await;
        if babysit {
            assert_eq!(
                ask(
                    &session,
                    &mut events,
                    "merge",
                    "item/commandExecution/requestApproval",
                    json!({"command":"gh pr merge 1","itemId":"merge-step"})
                )
                .await["decision"],
                "decline"
            );
            session.set_permission_mode(PermissionMode::Full).await;
            assert!(!session.respond_to_permission("merge", milagre_providers::codex::approvals::Decision::Allow).await.unwrap());
            session.client().rpc().request("fake/notify",json!({"method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-1","item":{"type":"commandExecution","id":"merge-step","command":"gh pr merge 1","status":"declined","exitCode":1}}})).await.unwrap();
            let done =
                next(&mut events, |e| matches!(e,SessionEvent::Agent(v) if v["type"]=="step-completed" && v["id"]=="merge-step")).await;
            assert!(matches!(done,SessionEvent::Agent(v) if v["detail"].as_str().unwrap().contains("Babysitting never merges.")));
        }
        session.close().await;
    }
}

#[tokio::test]
async fn transport_failure_is_never_a_config_retry_and_disabled_servers_prevent_bare_retry() {
    for scenario in ["exit-thread", "reject-config"] {
        let (opts, path) = trace_options(SessionRole::Ordinary, scenario);
        let mut thread = chat_thread(None, policy());
        thread.config = Some(json!({"mcp_servers":{"off":{"enabled":false},"milagre":{"url":"http://linked"}}}));
        assert!(CodexSession::start(opts, thread).await.is_err());
        let all = read_trace(&path);
        std::fs::remove_file(path).unwrap();
        let attempts: Vec<_> = all.iter().filter(|f| f["method"] == "thread/start").collect();
        assert_eq!(attempts.len(), if scenario == "exit-thread" { 1 } else { 2 });
        for attempt in attempts {
            assert_eq!(attempt["params"]["config"]["mcp_servers"]["off"]["enabled"], false);
        }
    }
}

#[tokio::test]
async fn read_only_linked_tools_are_retained_and_unsafe_overrides_are_rejected() {
    let mut opts = options(SessionRole::AnalysisAdvisor, "slow");
    opts.linked_tools = Some(LinkedTools {
        url: "http://127.0.0.1:1234/mcp".into(),
        tools: vec![HostTool { name: "read_linked_file".into(), read_only: true }],
    });
    let (session, _) = start(opts).await;
    assert!(session.linked_tools_available());
    session.close().await;
    for role in [SessionRole::Ordinary, SessionRole::Babysit { level: 3, resolve_threads: false }] {
        let mut opts = options(role, "slow");
        opts.command_classifier = Some(Arc::new(FixtureClassifier));
        let (session, _) = start(opts).await;
        let mut invalid = message();
        invalid.policy = codex_policy(PermissionMode::Full, "/repo", &[], false, true);
        assert!(matches!(session.send(invalid).await, Err(SessionError::UnsupportedPolicy(_))));
        assert!(!session.turn_active());
        assert!(!frames(&session).await.iter().any(|f| f["method"] == "turn/start"));
        session.close().await;
    }
}

#[tokio::test]
async fn budget_timeout_cannot_kill_the_next_turn_but_kills_a_stalled_one() {
    for scenario in ["budget-late-interrupt", "stubborn"] {
        let (session, mut events) = start(options(SessionRole::Escalation { requests: wake_requests() }, scenario)).await;
        session.send(message()).await.unwrap();
        for n in 1..=9 {
            session.client().rpc().request("fake/notify",json!({"method":"item/started","params":{"threadId":"thread-1","turnId":"turn-1","item":{"type":"webSearch","id":format!("tool-{n}")}}})).await.unwrap();
        }
        next(&mut events, |e| matches!(e, SessionEvent::TurnEnded { end: TurnEnd::Cancelled, .. })).await;
        if scenario == "budget-late-interrupt" {
            session.send(message()).await.unwrap();
            tokio::time::sleep(Duration::from_millis(200)).await;
            assert!(session.turn_active());
            assert!(session.client().rpc().is_running());
            assert_eq!(session.turn_id().as_deref(), Some("turn-2"));
        } else {
            assert!(matches!(session.send(message()).await, Err(SessionError::Closed)));
            assert!(!session.client().rpc().is_running());
        }
        session.close().await;
    }
}

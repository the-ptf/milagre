//! Trusted owner policy inputs. These are not provider-controlled JSON or a filesystem sandbox.
use crate::codex::protocol::{codex_policy, CodexPolicy, PermissionMode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum SessionRole {
    #[default]
    Ordinary,
    AnalysisAdvisor,
    Babysit {
        level: u8,
        resolve_threads: bool,
    },
    Escalation {
        requests: Vec<WakeRequest>,
    },
    /// Explicitly refused until execution-advisor host restrictions have been integrated.
    ExecutionAdvisor,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WakeRequest {
    pub chat_id: String,
    pub request_id: String,
}

#[derive(Debug, Clone)]
pub struct HostTool {
    pub name: String,
    pub read_only: bool,
}

/// Only the owner may supply this endpoint and its complete tool manifest. Host dispatch must
/// independently enforce the role: the manifest is not a grant to expose additional tools.
#[derive(Debug, Clone)]
pub struct LinkedTools {
    pub url: String,
    pub tools: Vec<HostTool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RemoteAction {
    Push,
    Reply,
    Rerequest,
    Resolve,
    Merge,
    Close,
    GraphqlFile,
    BodyFile,
}

/// Host-owned shell parser, equivalent to Node babysit-guard.cjs actionsOf. It must inspect
/// wrappers/substitutions/scripts, and return Err for unknown or unsupported syntax. No I/O,
/// blocking, panics or secrets in Debug/errors. Empty actions means a positively classified
/// command with no remote writes, not "couldn't parse". Required to start a Babysit session.
pub trait CommandClassifier: std::fmt::Debug + Send + Sync {
    fn actions(&self, command: &str) -> Result<Vec<RemoteAction>, String>;
}

pub fn babysit_denial(actions: &[RemoteAction], level: u8, resolve_threads: bool) -> Option<String> {
    use RemoteAction::*;
    for (action, reason) in [
        (Merge, "Babysitting never merges."),
        (Close, "Babysitting never closes or reopens the PR."),
        (GraphqlFile, "Babysitting can't check a GraphQL request read from a file, so it's blocked."),
        (BodyFile, "Babysitting can't check a request body read from a file, so it's blocked."),
    ] {
        if actions.contains(&action) {
            return Some(reason.into());
        }
    }
    let title = match level {
        1 => "Report only",
        2 => "Fix, don't push",
        3 => "Fix and push",
        4 => "Fix, push and reply",
        5 => "Fix, push, reply and re-request review",
        _ => return Some("Unsupported babysit level.".into()),
    };
    for (action, allowed, text) in [
        (Push, level >= 3, "pushing to GitHub"),
        (Reply, level >= 4, "replying on GitHub"),
        (Rerequest, level >= 5, "re-requesting review"),
        (Resolve, resolve_threads && level >= 4, "resolving review threads"),
    ] {
        if actions.contains(&action) && !allowed {
            return Some(format!("Babysit level {title} doesn't allow {text}. Change it in Settings › Experimental › Babysit PRs."));
        }
    }
    None
}

pub const ESCALATION_TOOL_CALLS: usize = 6;
pub const ESCALATION_TOOL_GRACE: usize = 2;
pub const ONLY_READS: &str = "This turn only tells the human about a waiting Subchat: you can read, and use chat_respond on the requests you were woken for. Everything else waits for the human's next message.";
pub const REPLY_NOW: &str = "You have used this turn's tool calls: reply to the human now, with what you know and your recommendation.";

pub fn escalation_denial(requests: &[WakeRequest], calls: usize, name: &str, input: &Value, read_only: bool) -> Option<&'static str> {
    if calls > ESCALATION_TOOL_CALLS {
        return Some(REPLY_NOW);
    }
    if read_only {
        return None;
    }
    if name == "chat_respond"
        && requests.iter().any(|r| {
            input.get("chatId").and_then(Value::as_str) == Some(&r.chat_id)
                && input.get("requestId").and_then(Value::as_str) == Some(&r.request_id)
        })
    {
        return None;
    }
    Some(ONLY_READS)
}

impl SessionRole {
    pub fn constrained(&self) -> bool {
        !matches!(self, Self::Ordinary)
    }
    pub fn denies_edits(&self) -> bool {
        matches!(self, Self::AnalysisAdvisor | Self::Escalation { .. })
    }
    pub fn policy(&self, supplied: &CodexPolicy) -> CodexPolicy {
        match self {
            Self::AnalysisAdvisor => CodexPolicy {
                approval_policy: "never",
                sandbox: "read-only",
                sandbox_policy: json!({"type":"readOnly","networkAccess":false}),
            },
            Self::Escalation { .. } => codex_policy(PermissionMode::Ask, "", &[], false, true),
            Self::Babysit { .. } => {
                let mut policy = supplied.clone();
                // Ask in every mode: don't rely on a network-disabled workspace sandbox alone.
                policy.approval_policy = "untrusted";
                policy
            }
            _ => supplied.clone(),
        }
    }
}

pub const EXECUTION_FEATURES: &[&str] = &[
    "shell_tool",
    "unified_exec",
    "multi_agent",
    "multi_agent_v2",
    "code_mode",
    "code_mode_host",
    "code_mode_only",
    "apps",
    "plugins",
    "hooks",
    "browser_use",
    "browser_use_external",
    "computer_use",
    "image_generation",
    "in_app_local_automation",
    "view_image",
    "skill_mcp_dependency_install",
    "default_mode_request_user_input",
    "send_message_to_user_async",
];

/// Node advisorCodexConfig, with validated inherited servers. Discovery failure is fatal; never
/// fall back to ordinary settings. Used for escalation too, with its separately gated host tools.
pub fn advisor_config(inherited: &Value, linked_url: Option<&str>) -> Result<Value, String> {
    if !inherited.is_object() {
        return Err("Codex inherited config must be an object.".into());
    }
    let mut servers = serde_json::Map::new();
    if let Some(raw) = inherited.get("mcp_servers") {
        let map = raw.as_object().ok_or("Codex inherited MCP servers must be an object.")?;
        for name in map.keys() {
            servers.insert(name.clone(), json!({"enabled":false}));
        }
    }
    if let Some(url) = linked_url {
        servers.insert("milagre".into(), json!({"url":url,"enabled":true,"tool_timeout_sec":60}));
    }
    let mut features = serde_json::Map::new();
    for name in EXECUTION_FEATURES {
        features.insert((*name).into(), false.into());
    }
    features.insert("skip_host_skill_discovery".into(), true.into());
    Ok(
        json!({"features":features,"mcp_servers":servers,"web_search":"disabled","agents":{"enabled":false},"tools":{"view_image":false,"web_search":false}}),
    )
}

/// Ordinary-session fallback. Disabled entries survive EVERY stage. If any exist, a bare config
/// attempt is forbidden. Only explicit Everywhere names can be removed at the first reduction.
pub fn config_attempts(params: &Value, everywhere: &[String], constrained: bool) -> Result<Vec<Value>, String> {
    let mut attempts = vec![params.clone()];
    if constrained {
        return Ok(attempts);
    }
    let Some(config) = params.get("config") else {
        return Ok(attempts);
    };
    let config = config.as_object().ok_or("Codex config must be an object.")?;
    let mut off = serde_json::Map::new();
    if let Some(servers) = config.get("mcp_servers") {
        let servers = servers.as_object().ok_or("Codex MCP servers must be an object.")?;
        for (name, value) in servers {
            if !value.is_object() || value.get("enabled").is_some_and(|v| !v.is_boolean()) {
                return Err("Codex MCP server definitions and enabled flags are malformed.".into());
            }
            if value.get("enabled") == Some(&Value::Bool(false)) {
                off.insert(name.clone(), value.clone());
            }
        }
        let without_everywhere: serde_json::Map<_, _> = servers
            .iter()
            .filter(|(name, _)| !everywhere.contains(name) || off.contains_key(*name))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        let mut linked_only = off.clone();
        if let Some(linked) = servers.get("milagre") {
            linked_only.insert("milagre".into(), linked.clone());
        }
        for map in [without_everywhere, linked_only, off.clone()] {
            let mut attempt = params.clone();
            let cfg = attempt["config"].as_object_mut().unwrap();
            if map.is_empty() {
                cfg.remove("mcp_servers");
            } else {
                cfg.insert("mcp_servers".into(), Value::Object(map));
            }
            if !attempts.contains(&attempt) {
                attempts.push(attempt);
            }
        }
    }
    if off.is_empty() {
        let mut bare = params.clone();
        bare.as_object_mut().ok_or("Codex params must be an object.")?.remove("config");
        if !attempts.contains(&bare) {
            attempts.push(bare);
        }
    }
    Ok(attempts)
}

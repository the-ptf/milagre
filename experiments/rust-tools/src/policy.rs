//! Independent host role enforcement. No provider permission mode is consulted.
use crate::*;
use std::sync::atomic::AtomicUsize;

pub const ONLY_READS:&str="This turn only tells the human about a waiting Subchat: you can read, and use chat_respond on the requests you were woken for. Everything else waits for the human's next message.";
pub const REPLY_NOW:&str="You have used this turn's tool calls: reply to the human now, with what you know and your recommendation.";
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostTool {
    pub name: String,
    pub read_only: bool,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WakeRequest {
    pub chat_id: String,
    pub request_id: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HostRole {
    Ordinary,
    AnalysisAdvisor,
    Escalation {
        wake_id: String,
        requests: Vec<WakeRequest>,
    },
    Babysit,
    ExecutionAdvisor,
}
/// This is owner configuration, never a tool input. A supplied manifest can only
/// narrow registered handlers and must match their authoritative effect metadata.
pub struct PolicyOptions {
    pub role: HostRole,
    pub manifest: Option<Vec<HostTool>>,
    pub on_sealed: Option<Arc<dyn Fn() + Send + Sync>>,
}
impl Default for PolicyOptions {
    fn default() -> Self {
        Self {
            role: HostRole::Ordinary,
            manifest: None,
            on_sealed: None,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BudgetStatus {
    pub attempts: usize,
    pub sealed: bool,
}
pub(crate) struct HostPolicy {
    role: HostRole,
    manifest: Vec<HostTool>,
    attempts: AtomicUsize,
    on_sealed: Option<Arc<dyn Fn() + Send + Sync>>,
}
/// Handler effects are part of the native registry. Source annotations are
/// checked against them, never accepted as authority from a provider/request.
pub(crate) fn read_only(name: &str) -> Option<bool> {
    Some(match name {
        "design_show"
        | "design_apply"
        | "design_kit_save"
        | "artifact_show"
        | "artifact_resolve_comment" => false,
        "design_read" | "design_inspect" | "design_validate" | "design_export" | "design_list"
        | "design_kit_read" | "artifact_read" | "artifact_list" | "artifact_comments" => true,
        _ => return None,
    })
}
fn invalid(message: &str) -> Error {
    Error::coded("UNSUPPORTED_POLICY", message)
}
fn valid_id(value: &str, limit: usize) -> bool {
    !value.is_empty()
        && value.len() <= limit
        && value.trim() == value
        && !value.chars().any(char::is_control)
}
impl HostPolicy {
    pub(crate) fn new(caller: &Caller, options: PolicyOptions) -> Result<Self> {
        match &options.role {
            HostRole::Babysit | HostRole::ExecutionAdvisor => {
                return Err(invalid(
                    "This content host does not implement that constrained role.",
                ))
            }
            HostRole::Escalation { wake_id, requests } => {
                if !valid_id(wake_id, 128)
                    || requests.is_empty()
                    || requests.len() > 128
                    || requests
                        .iter()
                        .any(|r| !valid_id(&r.chat_id, 4096) || !valid_id(&r.request_id, 128))
                {
                    return Err(invalid(
                        "Escalation requires an explicit wake and valid Chat/request pairs.",
                    ));
                }
                let unique = requests
                    .iter()
                    .map(|r| (&r.chat_id, &r.request_id))
                    .collect::<BTreeSet<_>>();
                if unique.len() != requests.len() {
                    return Err(invalid("Escalation request pairs must be unique."));
                }
                if options.on_sealed.is_none() {
                    return Err(invalid("Escalation requires an owner stop callback."));
                }
            }
            HostRole::Ordinary | HostRole::AnalysisAdvisor => {}
        }
        let mut trusted = Vec::new();
        for tool in contract()["tools"].as_array().unwrap() {
            let name = tool["name"].as_str().unwrap();
            let Some(read_only) = read_only(name) else {
                continue;
            };
            if tool["annotations"]["readOnlyHint"].as_bool() != Some(read_only) {
                return Err(invalid(
                    "Tool annotation differs from its native handler effect.",
                ));
            }
            if available(caller, tool) {
                trusted.push(HostTool {
                    name: name.into(),
                    read_only,
                });
            }
        }
        let constrained = !matches!(options.role, HostRole::Ordinary);
        let manifest = if let Some(requested) = options.manifest {
            let mut seen = BTreeSet::new();
            for tool in &requested {
                if !seen.insert(&tool.name) || !trusted.contains(tool) {
                    return Err(invalid(
                        "Host manifest contains an unavailable or misannotated tool.",
                    ));
                }
                if constrained && !tool.read_only {
                    return Err(invalid(
                        "This constrained content session only supports read tools.",
                    ));
                }
            }
            // Preserve authoritative registry order for both discovery and provider config.
            trusted
                .into_iter()
                .filter(|tool| requested.contains(tool))
                .collect()
        } else {
            trusted
                .into_iter()
                .filter(|tool| !constrained || tool.read_only)
                .collect()
        };
        Ok(Self {
            role: options.role,
            manifest,
            attempts: AtomicUsize::new(0),
            on_sealed: options.on_sealed,
        })
    }
    pub(crate) fn manifest(&self) -> &[HostTool] {
        &self.manifest
    }
    pub(crate) fn wake_id(&self) -> Option<&str> {
        match &self.role {
            HostRole::Escalation { wake_id, .. } => Some(wake_id),
            _ => None,
        }
    }
    pub(crate) fn role(&self) -> &HostRole {
        &self.role
    }
    pub(crate) fn status(&self) -> BudgetStatus {
        let attempts = self.attempts.load(Ordering::Acquire);
        BudgetStatus {
            attempts,
            sealed: attempts >= 9,
        }
    }
    pub(crate) fn authorize(&self, name: &str, args: &Value) -> Result<()> {
        if matches!(self.role, HostRole::Escalation { .. }) {
            // Reserve before validation/execution. Every attempted tool call consumes a
            // slot; parallel callers cannot each observe the sixth slot as free.
            let mut previous = self.attempts.load(Ordering::Acquire);
            loop {
                match self.attempts.compare_exchange_weak(
                    previous,
                    (previous + 1).min(9),
                    Ordering::AcqRel,
                    Ordering::Acquire,
                ) {
                    Ok(_) => break,
                    Err(current) => previous = current,
                }
            }
            if previous == 8 {
                if let Some(stop) = &self.on_sealed {
                    // A faulty trusted callback must not unwind the MCP dispatcher or unseal it.
                    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| stop()));
                }
            }
            if previous >= 6 {
                return Err(Error::coded("ESCALATION_BUDGET", REPLY_NOW));
            }
            if name == "chat_respond" && !self.wake_allows(args) {
                return Err(Error::coded("ROLE_DENIED", ONLY_READS));
            }
        }
        let Some(tool) = self.manifest.iter().find(|tool| tool.name == name) else {
            return Err(Error::coded(
                "TOOL_UNAVAILABLE",
                "Tool unavailable for this connection",
            ));
        };
        if !matches!(self.role, HostRole::Ordinary) && !tool.read_only {
            return Err(Error::coded("ROLE_DENIED", ONLY_READS));
        }
        Ok(())
    }
    fn wake_allows(&self, args: &Value) -> bool {
        match &self.role {
            HostRole::Escalation { requests, .. } => requests.iter().any(|r| {
                args["chatId"].as_str() == Some(&r.chat_id)
                    && args["requestId"].as_str() == Some(&r.request_id)
            }),
            _ => false,
        }
    }
}

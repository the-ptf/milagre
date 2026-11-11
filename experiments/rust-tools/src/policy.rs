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
/// One-use owner-issued wake identity. Releasing it invalidates every endpoint
/// that retains the wake; it never makes the identity available for admission again.
#[derive(Clone)]
pub struct WakeLease(Arc<WakeState>);
struct WakeState {
    owner: Weak<ContentOwner>,
    id: String,
    claimed: AtomicBool,
    released: AtomicBool,
    chat_id: String,
    project_id: String,
    requests: Vec<WakeRequest>,
}
impl WakeLease {
    pub(crate) fn new(
        owner: &Arc<ContentOwner>,
        id: String,
        caller: &Caller,
        requests: Vec<WakeRequest>,
    ) -> Self {
        Self(Arc::new(WakeState {
            owner: Arc::downgrade(owner),
            id,
            claimed: AtomicBool::new(false),
            released: AtomicBool::new(false),
            chat_id: caller.chat_id.clone(),
            project_id: caller.project_id.clone(),
            requests,
        }))
    }
    pub fn id(&self) -> &str {
        &self.0.id
    }
    pub fn release(&self) {
        self.0.released.store(true, Ordering::Release);
    }
    pub(crate) fn claim(&self, owner: &Arc<ContentOwner>, caller: &Caller) -> Result<()> {
        if self.0.chat_id != caller.chat_id
            || self.0.project_id != caller.project_id
            || !std::ptr::eq(self.0.owner.as_ptr(), Arc::as_ptr(owner))
            || self.0.released.load(Ordering::Acquire)
            || self.0.claimed.swap(true, Ordering::AcqRel)
        {
            return Err(invalid(
                "Wake lease is foreign, released or already admitted.",
            ));
        }
        Ok(())
    }
    pub(crate) fn active(&self) -> Result<()> {
        if self.0.released.load(Ordering::Acquire) {
            Err(invalid("Wake lease has been released."))
        } else {
            Ok(())
        }
    }
}
/// This is owner configuration, never a tool input. A supplied manifest can only
/// narrow registered handlers and must match their authoritative effect metadata.
pub struct PolicyOptions {
    pub wake: Option<WakeLease>,
    pub role: HostRole,
    pub manifest: Option<Vec<HostTool>>,
    pub on_sealed: Option<Arc<dyn Fn() + Send + Sync>>,
}
impl PolicyOptions {
    pub fn escalation(wake: WakeLease, on_sealed: Arc<dyn Fn() + Send + Sync>) -> Self {
        Self {
            role: HostRole::Escalation {
                wake_id: wake.id().into(),
                requests: wake.0.requests.clone(),
            },
            wake: Some(wake),
            manifest: None,
            on_sealed: Some(on_sealed),
        }
    }
}
impl Default for PolicyOptions {
    fn default() -> Self {
        Self {
            wake: None,
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
    wake: Option<WakeLease>,
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
    pub(crate) fn new(
        caller: &Caller,
        options: PolicyOptions,
        external: &[RegisteredTool],
    ) -> Result<Self> {
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
                if options
                    .wake
                    .as_ref()
                    .is_none_or(|lease| lease.id() != wake_id || &lease.0.requests != requests)
                {
                    return Err(invalid("Escalation requires its owner-issued wake lease."));
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
            HostRole::Ordinary | HostRole::AnalysisAdvisor => {
                if options.wake.is_some() {
                    return Err(invalid("Only escalation can carry a wake lease."));
                }
            }
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
        trusted.extend(
            external
                .iter()
                .filter(|tool| {
                    if tool.effect == ToolEffect::Read {
                        caller.read
                    } else {
                        caller.write
                    }
                })
                .map(RegisteredTool::manifest),
        );
        let permitted = |tool: &HostTool| match options.role {
            HostRole::Ordinary => true,
            HostRole::Escalation { .. } => tool.read_only || tool.name == "chat_respond",
            _ => tool.read_only,
        };
        let manifest = if let Some(requested) = options.manifest {
            let mut seen = BTreeSet::new();
            for tool in &requested {
                if !seen.insert(&tool.name) || !trusted.contains(tool) {
                    return Err(invalid(
                        "Host manifest contains an unavailable or misannotated tool.",
                    ));
                }
                if !permitted(tool) {
                    return Err(invalid(
                        "This constrained host session does not permit that handler.",
                    ));
                }
            }
            // Preserve authoritative registry order for both discovery and provider config.
            trusted
                .into_iter()
                .filter(|tool| requested.contains(tool))
                .collect()
        } else {
            trusted.into_iter().filter(permitted).collect()
        };
        Ok(Self {
            wake: options.wake,
            role: options.role,
            manifest,
            attempts: AtomicUsize::new(0),
            on_sealed: options.on_sealed,
        })
    }
    pub(crate) fn manifest(&self) -> &[HostTool] {
        &self.manifest
    }
    pub(crate) fn claim(&self, owner: &Arc<ContentOwner>, caller: &Caller) -> Result<()> {
        if let Some(wake) = &self.wake {
            wake.claim(owner, caller)?;
        }
        Ok(())
    }
    pub(crate) fn active(&self) -> Result<()> {
        if let Some(wake) = &self.wake {
            wake.active()?;
        }
        Ok(())
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
        self.active()?;
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
        if !matches!(self.role, HostRole::Ordinary)
            && !tool.read_only
            && !(matches!(self.role, HostRole::Escalation { .. }) && name == "chat_respond")
        {
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

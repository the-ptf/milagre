//! Pure, untrusted launch proposals from synthetic observations. No I/O, credentials, leases,
//! spawn conversion or policy enforcement. Enabling this module enables no provider.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;
#[path = "planning_models.rs"]
mod models;

pub const MAX_INPUT_BYTES: usize = 64 * 1024;
pub const MAX_OUTPUT_BYTES: usize = 32 * 1024;
pub const MAX_PATH_BYTES: usize = 4096;
pub const MAX_ENV_ENTRIES: usize = 12;
pub const MAX_MODELS: usize = 32;
pub const MAX_MCP: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Vendor {
    Kiro,
    Antigravity,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Platform {
    Mac,
    Linux,
    Windows,
    Unsupported,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Policy {
    Ask,
    Auto,
    Full,
    Babysit,
    Advisor,
    Escalation,
    AnalysisOnly,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EnvKey {
    Path,
    Lang,
    Term,
    GeminiHome,
    Tmpdir,
    Temp,
    Tmp,
    AntigravityHarnessPath,
    AgyAcpForceFileStorage,
    Pythonunbuffered,
}
impl EnvKey {
    fn name(self) -> &'static str {
        match self {
            Self::Path => "PATH",
            Self::Lang => "LANG",
            Self::Term => "TERM",
            Self::GeminiHome => "GEMINI_HOME",
            Self::Tmpdir => "TMPDIR",
            Self::Temp => "TEMP",
            Self::Tmp => "TMP",
            Self::AntigravityHarnessPath => "ANTIGRAVITY_HARNESS_PATH",
            Self::AgyAcpForceFileStorage => "AGY_ACP_FORCE_FILE_STORAGE",
            Self::Pythonunbuffered => "PYTHONUNBUFFERED",
        }
    }
}
/// Presence markers only: this API cannot receive the credential/browser values to be scrubbed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AmbientMarker {
    GoogleCredentials,
    GoogleProject,
    Browser,
    ElectronRunAsNode,
}

macro_rules! opaque_debug { ($($t:ty),+) => { $(impl fmt::Debug for $t {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str(concat!(stringify!($t), " { synthetic values redacted }")) }
})+ }; }
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AccountRef {
    pub id: String,
    pub scope: String,
    pub generation: u64,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AccountObservation {
    pub vendor: Vendor,
    pub selected: AccountRef,
    pub ready: bool,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Candidate {
    pub path: String,
    pub executable: bool,
}
/// Candidate slots are already-derived synthetic probe results, not filesystem evidence.
#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "vendor", rename_all = "kebab-case", deny_unknown_fields)]
pub enum InstallObservation {
    Kiro {
        override_candidate: Option<Candidate>,
        real_sibling: Option<Candidate>,
        launcher_sibling: Option<Candidate>,
        mac_app: Option<Candidate>,
    },
    Antigravity {
        agent: Candidate,
        harness: Option<Candidate>,
        pair_matches: bool,
    },
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Resources {
    pub cwd: String,
    pub profile: Option<String>,
    pub scratch: Option<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EnvEntry {
    pub key: EnvKey,
    pub value: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ModelOption {
    pub value: String,
    pub name: String,
    pub efforts: Vec<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ModelRequest {
    pub model: String,
    pub effort: Option<String>,
    pub offered: Vec<ModelOption>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct McpObservation {
    pub id: String,
    pub enabled: bool,
    pub required: bool,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LaunchObservation {
    pub vendor: Vendor,
    pub platform: Platform,
    pub expected_account: AccountRef,
    pub account: Option<AccountObservation>,
    pub install: InstallObservation,
    pub resources: Resources,
    pub environment: Vec<EnvEntry>,
    pub ambient: Vec<AmbientMarker>,
    pub policy: Policy,
    /// No guard implementation can be supplied to this pure API. A requirement is refused.
    pub requires_host_guard: bool,
    pub requires_mcp_guard: bool,
    pub models: ModelRequest,
    pub mcp: Vec<McpObservation>,
}
#[derive(Serialize)]
pub struct LaunchPlan {
    vendor: Vendor,
    platform: Platform,
    account: AccountRef,
    command: String,
    cwd: String,
    args: Vec<String>,
    environment: BTreeMap<String, String>,
    model: String,
    effort: Option<String>,
    mode_option: &'static str,
    mode_value: &'static str,
    mcp: Vec<McpObservation>,
    /// Always false. Serialization is for review; this is not an executable capability.
    authorized: bool,
}
opaque_debug!(
    AccountRef,
    AccountObservation,
    Candidate,
    InstallObservation,
    Resources,
    EnvEntry,
    ModelOption,
    ModelRequest,
    McpObservation,
    LaunchObservation,
    LaunchPlan
);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, thiserror::Error)]
#[serde(rename_all = "kebab-case")]
pub enum Refusal {
    #[error("Synthetic observation exceeds a fixed bound.")]
    InputLimit,
    #[error("Review plan exceeds the output bound.")]
    OutputLimit,
    #[error("Unsupported platform observation.")]
    Platform,
    #[error("Missing account observation.")]
    MissingAccount,
    #[error("Account observation does not match the requested scope.")]
    AccountMismatch,
    #[error("Account generation is absent or stale.")]
    Generation,
    #[error("Account observation is not ready.")]
    AccountNotReady,
    #[error("Kiro supports only the connected default account.")]
    KiroAccount,
    #[error("Vendor and install observations disagree.")]
    InstallMismatch,
    #[error("No executable candidate observed.")]
    MissingExecutable,
    #[error("Missing executable harness observation.")]
    MissingHarness,
    #[error("Agent and harness were not observed as a matching pair.")]
    InstallPair,
    #[error("A required resource path is missing or malformed.")]
    Path,
    #[error("Environment observations conflict with the managed plan.")]
    EnvironmentConflict,
    #[error("Unsupported policy requirement.")]
    Policy,
    #[error("MCP IDs are duplicate or a required server is disabled.")]
    Mcp,
    #[error("Unsupported model observation shape.")]
    Model,
    #[error("Synthetic identifier is malformed.")]
    Identifier,
}
fn bounded(s: &str, max: usize, total: &mut usize) -> Result<(), Refusal> {
    if s.len() > max {
        return Err(Refusal::InputLimit);
    }
    *total = total.checked_add(s.len()).filter(|n| *n <= MAX_INPUT_BYTES).ok_or(Refusal::InputLimit)?;
    Ok(())
}
fn id(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
}
fn path(s: &str, platform: Platform) -> bool {
    let absolute = if platform == Platform::Windows {
        s.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
            && s.as_bytes().get(1) == Some(&b':')
            && matches!(s.as_bytes().get(2), Some(b'/' | b'\\'))
    } else {
        s.starts_with('/') && !s.contains('\\')
    };
    absolute && !s.chars().any(char::is_control) && !s.split(['/', '\\']).any(|p| matches!(p, "." | ".."))
}
fn candidates(i: &InstallObservation) -> Vec<&Candidate> {
    match i {
        InstallObservation::Kiro { override_candidate, real_sibling, launcher_sibling, mac_app } => {
            [override_candidate, real_sibling, launcher_sibling, mac_app].into_iter().filter_map(Option::as_ref).collect()
        }
        InstallObservation::Antigravity { agent, harness, .. } => std::iter::once(agent).chain(harness.iter()).collect(),
    }
}
fn preflight(o: &LaunchObservation) -> Result<(), Refusal> {
    if o.environment.len() > MAX_ENV_ENTRIES || o.ambient.len() > 4 || o.models.offered.len() > MAX_MODELS || o.mcp.len() > MAX_MCP {
        return Err(Refusal::InputLimit);
    }
    let mut total = 0;
    for a in std::iter::once(&o.expected_account).chain(o.account.iter().map(|a| &a.selected)) {
        bounded(&a.id, 128, &mut total)?;
        bounded(&a.scope, 128, &mut total)?;
    }
    for c in candidates(&o.install) {
        bounded(&c.path, MAX_PATH_BYTES, &mut total)?;
    }
    for p in std::iter::once(&o.resources.cwd).chain(o.resources.profile.iter()).chain(o.resources.scratch.iter()) {
        bounded(p, MAX_PATH_BYTES, &mut total)?;
    }
    for e in &o.environment {
        bounded(&e.value, MAX_PATH_BYTES, &mut total)?;
    }
    bounded(&o.models.model, 128, &mut total)?;
    if let Some(e) = &o.models.effort {
        bounded(e, 32, &mut total)?;
    }
    for m in &o.models.offered {
        if m.efforts.len() > 8 {
            return Err(Refusal::InputLimit);
        }
        bounded(&m.value, 128, &mut total)?;
        bounded(&m.name, 256, &mut total)?;
        for e in &m.efforts {
            bounded(e, 32, &mut total)?;
        }
    }
    for m in &o.mcp {
        bounded(&m.id, 128, &mut total)?;
    }
    Ok(())
}
/// Validates all input counts/bytes before copying anything into a plan. Caller-owned input memory
/// and JSON decoding are outside this API. No ambient state is consulted and no authority is issued.
pub fn plan_vendor_launch(o: &LaunchObservation) -> Result<LaunchPlan, Refusal> {
    preflight(o)?;
    if o.platform == Platform::Unsupported {
        return Err(Refusal::Platform);
    }
    if o.policy != Policy::Ask || o.requires_host_guard || o.requires_mcp_guard {
        return Err(Refusal::Policy);
    }
    let account = o.account.as_ref().ok_or(Refusal::MissingAccount)?;
    if !id(&o.expected_account.id) || !id(&o.expected_account.scope) || !id(&account.selected.id) || !id(&account.selected.scope) {
        return Err(Refusal::Identifier);
    }
    if account.vendor != o.vendor || account.selected.id != o.expected_account.id || account.selected.scope != o.expected_account.scope {
        return Err(Refusal::AccountMismatch);
    }
    if o.expected_account.generation == 0 || account.selected.generation != o.expected_account.generation {
        return Err(Refusal::Generation);
    }
    if !account.ready {
        return Err(Refusal::AccountNotReady);
    }
    if o.vendor == Vendor::Kiro && account.selected.id != "default" {
        return Err(Refusal::KiroAccount);
    }
    for p in std::iter::once(&o.resources.cwd)
        .chain(o.resources.profile.iter())
        .chain(o.resources.scratch.iter())
        .chain(candidates(&o.install).into_iter().map(|c| &c.path))
    {
        if !path(p, o.platform) {
            return Err(Refusal::Path);
        }
    }
    let (command, harness) = match (&o.install, o.vendor) {
        (InstallObservation::Kiro { override_candidate, real_sibling, launcher_sibling, mac_app }, Vendor::Kiro) => {
            let selected = [
                override_candidate.as_ref(),
                real_sibling.as_ref(),
                launcher_sibling.as_ref(),
                if o.platform == Platform::Mac { mac_app.as_ref() } else { None },
            ]
            .into_iter()
            .flatten()
            .find(|c| c.executable)
            .ok_or(Refusal::MissingExecutable)?;
            (&selected.path, None)
        }
        (InstallObservation::Antigravity { agent, harness, pair_matches }, Vendor::Antigravity) => {
            if !agent.executable {
                return Err(Refusal::MissingExecutable);
            }
            let harness = harness.as_ref().filter(|c| c.executable).ok_or(Refusal::MissingHarness)?;
            if !pair_matches {
                return Err(Refusal::InstallPair);
            }
            (&agent.path, Some(&harness.path))
        }
        _ => return Err(Refusal::InstallMismatch),
    };
    let mut env = BTreeMap::new();
    for e in &o.environment {
        if e.value.chars().any(char::is_control) || env.insert(e.key.name().to_string(), e.value.clone()).is_some() {
            return Err(Refusal::EnvironmentConflict);
        }
    }
    let mut markers = Vec::new();
    for marker in &o.ambient {
        if markers.contains(marker) {
            return Err(Refusal::EnvironmentConflict);
        }
        markers.push(*marker);
    }
    if o.vendor == Vendor::Kiro {
        if !o.ambient.is_empty()
            || o.environment.iter().any(|e| !matches!(e.key, EnvKey::Path | EnvKey::Lang | EnvKey::Term))
            || o.resources.profile.is_some()
            || o.resources.scratch.is_some()
        {
            return Err(Refusal::EnvironmentConflict);
        }
    } else {
        let profile = o.resources.profile.as_ref().ok_or(Refusal::Path)?;
        let scratch = o.resources.scratch.as_ref().ok_or(Refusal::Path)?;
        let mut managed = vec![
            ("GEMINI_HOME", profile.as_str()),
            ("TMPDIR", scratch.as_str()),
            ("ANTIGRAVITY_HARNESS_PATH", harness.unwrap().as_str()),
            ("AGY_ACP_FORCE_FILE_STORAGE", "1"),
            ("PYTHONUNBUFFERED", "1"),
        ];
        if o.platform == Platform::Windows {
            managed.extend([("TEMP", scratch.as_str()), ("TMP", scratch.as_str())]);
        }
        for (key, value) in managed {
            if env.get(key).is_some_and(|v| v != value) {
                return Err(Refusal::EnvironmentConflict);
            }
            env.insert(key.to_string(), value.to_string());
        }
        if o.platform != Platform::Windows && (env.contains_key("TEMP") || env.contains_key("TMP")) {
            return Err(Refusal::EnvironmentConflict);
        }
    }
    for (index, m) in o.mcp.iter().enumerate() {
        if !id(&m.id) {
            return Err(Refusal::Identifier);
        }
        if o.mcp[..index].iter().any(|p| p.id == m.id) || (m.required && !m.enabled) {
            return Err(Refusal::Mcp);
        }
    }
    let (model, effort) = models::resolve(o.vendor, &o.models)?;
    let plan = LaunchPlan {
        vendor: o.vendor,
        platform: o.platform,
        account: account.selected.clone(),
        command: command.clone(),
        cwd: o.resources.cwd.clone(),
        args: if o.vendor == Vendor::Kiro {
            crate::launch::KIRO_ARGS.iter().map(|s| s.to_string()).collect()
        } else if o.platform == Platform::Linux {
            vec!["--uid=".into()]
        } else {
            vec![]
        },
        environment: env,
        model,
        effort,
        mode_option: if o.vendor == Vendor::Kiro { "autopilot" } else { "mode" },
        mode_value: if o.vendor == Vendor::Kiro { "on" } else { "default" },
        mcp: o.mcp.clone(),
        authorized: false,
    };
    if serde_json::to_vec(&plan).map_err(|_| Refusal::OutputLimit)?.len() > MAX_OUTPUT_BYTES {
        return Err(Refusal::OutputLimit);
    }
    Ok(plan)
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FailureObservation {
    pub rpc_error: bool,
    pub code: i64,
    pub message: String,
    pub data_text: Option<String>,
}
opaque_debug!(FailureObservation);
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FailureClass {
    Transport,
    Authentication,
    Subscription,
    Server,
}
/// Only string-valued RPC data is represented. Structured data must be flattened by a separately
/// reviewed bounded adapter; this helper neither logs messages nor decides retries.
pub fn classify_failure(vendor: Vendor, f: &FailureObservation) -> Result<FailureClass, Refusal> {
    let mut total = 0;
    bounded(&f.message, 4096, &mut total)?;
    if let Some(d) = &f.data_text {
        bounded(d, 4096, &mut total)?;
    }
    if !f.rpc_error {
        return Ok(FailureClass::Transport);
    }
    let text = format!("{} {}", f.message, f.data_text.as_deref().unwrap_or(""));
    if vendor == Vendor::Antigravity && text.contains("SUBSCRIPTION_REQUIRED") {
        return Ok(FailureClass::Subscription);
    }
    let text = text.to_ascii_lowercase();
    let common = ["signin", "sign in", "sign-in", "authenticat", "not logged in"];
    let own: &[&str] = if vendor == Vendor::Kiro {
        &["kiro-cli login", "token expired", "token has expired", "unauthorized", "unauthorised"]
    } else {
        &["api key is missing", "unauthenticated", "login required"]
    };
    Ok(if f.code == -32000 || common.iter().chain(own.iter()).any(|s| text.contains(s)) {
        FailureClass::Authentication
    } else {
        FailureClass::Server
    })
}

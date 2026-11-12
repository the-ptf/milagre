//! Nonblocking Claude owner adapter. Fixture constructors select checked-in scripts; the
//! crate-internal configured constructor accepts only a captured owner launch and owned Project.
//! RPC requests never supply an executable, environment, account directory, role or MCP endpoint.
use crate::instructions::{self, Bundle, HostNetwork};
use milagre_claude::{
    ordinary::{node_trace, OrdinaryLaunch, OrdinaryTurn},
    prompt_images::{self, PromptImage},
    session::IdleClose,
    ClaudeSession, LaunchOptions, SessionOptions,
};
use milagre_owner_store::{
    chat_host::{
        AnswerId, AnswerOutcome, ImageInput, ModeChangeId, ModeOutcome, Provider, ProviderError,
        ProviderErrorKind, ProviderEvent, TurnId,
    },
    jsjson::RawJson,
    Isolation, Policy,
};
use milagre_owner_wire::IsolatedProfile;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc, Condvar, Mutex, Weak,
    },
    time::Duration,
};
use tokio::sync::{mpsc, watch};

const CHATS: usize = 16;
const ANSWERS: usize = 32;
const MODES: usize = 32;
const EVENTS: usize = 256;
const BYTES: usize = 4 * 1024 * 1024;
// This bounded fixture admits at most 1 MiB per request and per expanded native user frame.
// A repeated image token cannot multiply retained Start content up to the transport's 64 MiB.
const IMAGE_FRAME_BYTES: usize = 1024 * 1024;
#[derive(Clone, Copy, Debug)]
pub enum Scenario {
    Reply,
    Permission,
    Question,
    Stop,
    Crash,
    HangInitialize,
    QuestionDelayedReceipt,
    AnswerSaturation,
    Subagent,
    Unicode,
    Content,
    ContentAllow,
    ContentDeny,
    Design,
    Queue,
    /// Three ordinary turns checked against the recorded Node launch options and control order.
    Ordinary,
    /// Full, Auto and Ask turns in one process, checked against the recorded Node launch mode,
    /// mode-switch order and each `can_use_tool` answer.
    Modes,
    /// Ask -> Full -> Ask within one turn, then Auto -> Ask while idle, from the Node oracle.
    LiveModes,
    /// Background children/tasks retain a session across TLDR changes until they settle.
    BackgroundRetention,
    /// Typed image sends, then a queued image turn, against actual Node user-content blocks.
    Images,
    /// A native mode control that deliberately never acknowledges, for cancellation receipts.
    ModeStalled,
    /// A native mode control that refuses, for truthful failure receipts.
    ModeRejected,
}
/// The Node ordinary trace (actual SessionManager/ClaudeSession over an explicit synthetic
/// bundle, `rust-claude/scripts/generate-session.cjs`). Its bundle and host are this fixture's
/// explicit instruction inputs; its recorded options become the fake child's launch assertions.
const ORDINARY_TRACE: &str =
    include_str!("../../rust-claude/tests/fixtures/conformance/claude-ordinary.json");
/// The Node permission-mode trace (same explicit bundle and host), `generate-session.cjs`.
const MODES_TRACE: &str =
    include_str!("../../rust-claude/tests/fixtures/conformance/claude-modes.json");
const LIVE_MODES_TRACE: &str =
    include_str!("../../rust-claude/tests/fixtures/conformance/claude-live-modes.json");
/// Explicit ordinary instruction inputs. Nothing is discovered from the install or host.
struct OrdinaryFacts {
    bundle: Bundle,
    agents: serde_json::Map<String, Value>,
    host: HostNetwork,
}
/// Immutable instruction inputs captured by the standalone owner, never discovered from HOME.
#[cfg(any(test, feature = "chat-runtime"))]
pub(crate) struct ClaudeInstructionInputs {
    facts: OrdinaryFacts,
    prompt_suggestions: bool,
}
#[cfg(any(test, feature = "chat-runtime"))]
impl ClaudeInstructionInputs {
    /// Load only the actual bundled TLDR/QA assets under the explicitly selected directory.
    /// No settings, credentials, install lookup or provider process is read or started here.
    pub(crate) fn bundled(
        skills_directory: &Path,
        host: HostNetwork,
        prompt_suggestions: bool,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let directory = skills_directory.canonicalize()?;
        let skills = directory
            .to_str()
            .ok_or("The bundled skills path must be UTF-8")?;
        let tldr = std::fs::read_to_string(directory.join("tldr/default.md"))?;
        let rules = std::fs::read_to_string(directory.join("qa-fleet/agent.md"))?;
        let mut files = std::fs::read_dir(directory.join("qa-fleet/personas"))?
            .map(|entry| entry.map(|entry| entry.path()))
            .collect::<Result<Vec<_>, _>>()?;
        files.sort();
        let mut personas = Vec::new();
        for file in files {
            if file.extension().is_some_and(|extension| extension == "md") {
                let name = file
                    .file_name()
                    .and_then(|name| name.to_str())
                    .ok_or("Invalid QA persona filename")?;
                personas.push((name.to_owned(), std::fs::read_to_string(file)?));
            }
        }
        let borrowed: Vec<_> = personas
            .iter()
            .map(|(name, text)| (name.as_str(), text.as_str()))
            .collect();
        let agents = instructions::bundled_agents(&rules, &borrowed)?;
        if agents.is_empty() {
            return Err("The bundled QA agent definitions are empty".into());
        }
        Ok(Self {
            facts: OrdinaryFacts {
                bundle: Bundle::new(skills, &tldr)?,
                agents,
                host,
            },
            prompt_suggestions,
        })
    }
}
/// Owner-only launch authority. The selected CLI/configuration and environment are captured once;
/// request JSON cannot replace them. The caller owns persistent data and performs authentication.
#[cfg(any(test, feature = "chat-runtime"))]
pub(crate) struct ClaudeLaunchContext {
    pub(crate) isolation: Isolation,
    pub(crate) project: PathBuf,
    pub(crate) launch: LaunchOptions,
    pub(crate) ordinary: ClaudeInstructionInputs,
    /// Opaque owner lease (for example the durable root lock). Each captured worker keeps it
    /// until its session and retained executor tasks finish, even after the outer owner drops.
    pub(crate) lifetime: Option<Arc<dyn Send + Sync>>,
}
enum LaunchSource {
    Fixture {
        profile: Arc<IsolatedProfile>,
        program: PathBuf,
        scripts: Vec<PathBuf>,
        scenario: Scenario,
    },
    #[cfg(any(test, feature = "chat-runtime"))]
    Captured {
        launch: Box<LaunchOptions>,
        prompt_suggestions: bool,
        lifetime: Option<Arc<dyn Send + Sync>>,
    },
}
struct WorkerLaunch {
    options: LaunchOptions,
    profile: Option<Arc<IsolatedProfile>>,
    scenario: Option<Scenario>,
    prompt_suggestions: Option<bool>,
    lifetime: Option<Arc<dyn Send + Sync>>,
}
impl LaunchSource {
    fn capture(&self, index: usize) -> WorkerLaunch {
        match self {
            #[cfg(any(test, feature = "chat-runtime"))]
            Self::Captured {
                launch,
                prompt_suggestions,
                lifetime,
            } => WorkerLaunch {
                options: (**launch).clone(),
                profile: None,
                scenario: None,
                prompt_suggestions: Some(*prompt_suggestions),
                lifetime: lifetime.clone(),
            },
            Self::Fixture {
                profile,
                program,
                scripts,
                scenario,
            } => {
                let mut launch = LaunchOptions::new(program);
                launch.env = Some(vec![
                    ("HOME".into(), profile.path().join("home").into_os_string()),
                    (
                        "CLAUDE_CONFIG_DIR".into(),
                        profile.path().join("home").into_os_string(),
                    ),
                    (
                        "FAKE_CLAUDE_SCRIPT".into(),
                        scripts[index.min(scripts.len() - 1)]
                            .clone()
                            .into_os_string(),
                    ),
                ]);
                launch.no_session_persistence = true;
                launch.strict_mcp_config = true;
                WorkerLaunch {
                    options: launch,
                    profile: Some(profile.clone()),
                    scenario: Some(*scenario),
                    prompt_suggestions: None,
                    lifetime: None,
                }
            }
        }
    }
}
impl OrdinaryFacts {
    fn from_trace(trace: &Value) -> Result<Self, Box<dyn std::error::Error>> {
        let b = &trace["bundle"];
        let text = |v: &Value| v.as_str().map(str::to_owned).ok_or("trace text");
        let personas: Vec<(String, String)> = b["personas"]
            .as_array()
            .ok_or("trace personas")?
            .iter()
            .map(|p| Ok((text(&p[0])?, text(&p[1])?)))
            .collect::<Result<_, &str>>()?;
        let personas: Vec<(&str, &str)> = personas
            .iter()
            .map(|(f, t)| (f.as_str(), t.as_str()))
            .collect();
        let addresses: Vec<String> = trace["host"]["addresses"]
            .as_array()
            .ok_or("trace host")?
            .iter()
            .map(text)
            .collect::<Result<_, _>>()?;
        Ok(Self {
            bundle: Bundle::new(&text(&b["skillsDir"])?, &text(&b["tldrDefault"])?)?,
            agents: instructions::bundled_agents(&text(&b["agentMd"])?, &personas)?,
            host: HostNetwork {
                name: trace["host"]["name"].as_str().map(str::to_owned),
                addresses,
            },
        })
    }
}
fn refused(text: &str) -> ProviderError {
    ProviderError::new(ProviderErrorKind::Refused, text)
}
fn failed() -> ProviderError {
    ProviderError::new(
        ProviderErrorKind::Other,
        "The isolated Claude fixture session stopped",
    )
}
fn uncertain() -> ProviderError {
    ProviderError::new(
        ProviderErrorKind::Other,
        "The agent has not confirmed delivery of this answer.",
    )
}
fn terminal(event: &Value) -> bool {
    matches!(
        event["type"].as_str(),
        Some("turn-completed" | "turn-cancelled" | "turn-failed")
    )
}
struct Queue {
    events: VecDeque<ProviderEvent>,
    bytes: usize,
}
struct RetainedMode {
    worker: Arc<AtomicBool>,
    uncertain: bool,
}
struct Shared {
    queue: Mutex<Queue>,
    failed: AtomicBool,
    cleanup_failed: AtomicBool,
    peak_reply_tasks: AtomicUsize,
    workers: Mutex<usize>,
    drained: Condvar,
    pending: Mutex<HashSet<(String, AnswerId)>>,
    pending_modes: Mutex<HashMap<(String, ModeChangeId), RetainedMode>>,
    pids: Mutex<HashMap<String, u32>>,
}
impl Shared {
    /// Called only after this captured session has closed and reaped its process. Failed means
    /// the operation has definitively ended with an error, not that it had no earlier effects.
    fn settle_closed_modes(&self, worker: &Arc<AtomicBool>) {
        let completed: Vec<_> = self
            .pending_modes
            .lock()
            .unwrap()
            .iter_mut()
            .filter_map(|(id, retained)| {
                if retained.uncertain && Arc::ptr_eq(&retained.worker, worker) {
                    retained.uncertain = false;
                    Some(id.clone())
                } else {
                    None
                }
            })
            .collect();
        for (chat, change) in completed {
            self.emit(ProviderEvent::ModeSettled {
                chat, change,
                outcome: ModeOutcome::Failed(ProviderError::new(ProviderErrorKind::Other,
                    "The Claude session ended before confirming the permission-mode change. Earlier effects may have occurred.")),
            }, true);
        }
    }
    fn emit(&self, event: ProviderEvent, reserved: bool) -> bool {
        let size = match &event {
            ProviderEvent::Agent { event, .. } => event.0.to_string().len() + 1024,
            _ => 1024,
        };
        let mut q = self.queue.lock().unwrap();
        if (!reserved
            && (self.failed.load(Ordering::Acquire)
                || q.events.len() >= EVENTS
                || q.bytes.saturating_add(size) > BYTES))
            || q.events.len() >= EVENTS + CHATS * 3 + ANSWERS + MODES * 2
        {
            self.failed.store(true, Ordering::Release);
            return false;
        }
        q.bytes += size;
        q.events.push_back(event);
        true
    }
}
#[derive(Clone)]
pub struct FixtureMonitor {
    content: Option<Arc<crate::claude_content::SharedContent>>,
    shared: Arc<Shared>,
    _profile: Option<Arc<IsolatedProfile>>,
}
impl FixtureMonitor {
    /// Bounded actual MCP PNG replies from the fixed private Design scenario.
    pub fn design_feedback(&self) -> Vec<Value> {
        self.content
            .as_ref()
            .map(|content| content.feedback())
            .unwrap_or_default()
    }
    pub fn peak_reply_tasks(&self) -> usize {
        self.shared.peak_reply_tasks.load(Ordering::Acquire)
    }
    pub fn workers(&self) -> usize {
        *self.shared.workers.lock().unwrap()
    }
    pub fn cleanup_failed(&self) -> bool {
        self.shared.cleanup_failed.load(Ordering::Acquire)
    }
    pub fn pid(&self, chat: &str) -> Option<u32> {
        self.shared.pids.lock().unwrap().get(chat).copied()
    }
    pub fn wait_stopped(&self, timeout: Duration) -> bool {
        let n = self.shared.workers.lock().unwrap();
        *self
            .shared
            .drained
            .wait_timeout_while(n, timeout, |n| *n != 0 && !self.cleanup_failed())
            .unwrap()
            .0
            == 0
    }
    /// Wait for actual worker cleanup, including after a cleanup deadline has reported failure.
    /// Unlike `wait_stopped`, this cannot return early merely because that failure latched.
    pub fn wait_drained(&self, timeout: Duration) -> bool {
        let n = self.shared.workers.lock().unwrap();
        *self
            .shared
            .drained
            .wait_timeout_while(n, timeout, |n| *n != 0)
            .unwrap()
            .0
            == 0
    }
}
struct Start {
    id: TurnId,
    content: Vec<Value>,
    request: Value,
    turn: OrdinaryTurn,
}
enum Answer {
    Permission(String),
    Question(Value),
}
struct Reply {
    turn: TurnId,
    request: String,
    answer: Answer,
    guard: ReplyGuard,
}
struct ReplyGuard {
    shared: Arc<Shared>,
    chat: String,
    id: Option<AnswerId>,
    entered: bool,
}
impl ReplyGuard {
    fn settle(mut self, outcome: AnswerOutcome) {
        if let Some(answer) = self.id.take() {
            self.shared.emit(
                ProviderEvent::AnswerSettled {
                    chat: self.chat.clone(),
                    answer,
                    outcome,
                },
                true,
            );
        }
    }
    fn refuse(mut self) {
        if let Some(id) = self.id.take() {
            self.shared
                .pending
                .lock()
                .unwrap()
                .remove(&(self.chat.clone(), id));
        }
    }
}
impl Drop for ReplyGuard {
    fn drop(&mut self) {
        if let Some(answer) = self.id.take() {
            self.shared.emit(
                ProviderEvent::AnswerSettled {
                    chat: self.chat.clone(),
                    answer,
                    outcome: if self.entered {
                        AnswerOutcome::Uncertain(uncertain())
                    } else {
                        AnswerOutcome::Failed(failed())
                    },
                },
                true,
            );
        }
    }
}
/// Admission remains reserved until its receipt is drained, including cancelled work.
struct ModeGuard {
    shared: Arc<Shared>,
    chat: String,
    id: Option<ModeChangeId>,
    entered: bool,
}
impl ModeGuard {
    fn settle(mut self, outcome: ModeOutcome) {
        if let Some(change) = self.id.take() {
            self.shared.emit(
                ProviderEvent::ModeSettled {
                    chat: self.chat.clone(),
                    change,
                    outcome,
                },
                true,
            );
        }
    }
    fn refuse(mut self) {
        if let Some(change) = self.id.take() {
            self.shared
                .pending_modes
                .lock()
                .unwrap()
                .remove(&(self.chat.clone(), change));
        }
    }
    fn error(&self) -> ProviderError {
        if self.entered {
            ProviderError::new(
                ProviderErrorKind::Other,
                "Claude has not confirmed the permission-mode change.",
            )
        } else {
            refused(
                "The fixture session generation closed before the permission-mode change entered",
            )
        }
    }
}
impl Drop for ModeGuard {
    fn drop(&mut self) {
        if let Some(change) = self.id.take() {
            if self.entered {
                if let Some(retained) = self
                    .shared
                    .pending_modes
                    .lock()
                    .unwrap()
                    .get_mut(&(self.chat.clone(), change))
                {
                    retained.uncertain = true;
                }
            }
            self.shared.emit(
                ProviderEvent::ModeSettled {
                    chat: self.chat.clone(),
                    change,
                    outcome: if self.entered {
                        ModeOutcome::Uncertain(self.error())
                    } else {
                        ModeOutcome::Failed(self.error())
                    },
                },
                true,
            );
        }
    }
}
struct ModeChange {
    turn: TurnId,
    mode: String,
    guard: ModeGuard,
}
/// Paired once by the captured worker; no chat-key lookup can redirect an idle-close claim.
struct SessionHandle {
    session: Weak<ClaudeSession>,
    runtime: tokio::runtime::Handle,
}
struct Slot {
    session: Arc<Mutex<Option<SessionHandle>>>,
    content_scope: Arc<crate::claude_content::SessionContent>,
    start: mpsc::Sender<Start>,
    answers: mpsc::Sender<Reply>,
    modes: mpsc::Sender<ModeChange>,
    close: watch::Sender<bool>,
    interrupt: watch::Sender<u64>,
    active: Arc<AtomicBool>,
    done: Arc<AtomicBool>,
    latest: Arc<AtomicU64>,
    native_id: Arc<Mutex<Option<String>>>,
    /// The TLDR setting this session's instructions were built with (fixed per session).
    tldr: bool,
}
struct Worker {
    session: Arc<Mutex<Option<SessionHandle>>>,
    content_scope: Arc<crate::claude_content::SessionContent>,
    shared: Arc<Shared>,
    _profile: Option<Arc<IsolatedProfile>>,
    _lifetime: Option<Arc<dyn Send + Sync>>,
    project: PathBuf,
    launch: LaunchOptions,
    chat: String,
    scenario: Option<Scenario>,
    prompt_suggestions: Option<bool>,
    active: Arc<AtomicBool>,
    done: Arc<AtomicBool>,
    latest: Arc<AtomicU64>,
    native_id: Arc<Mutex<Option<String>>>,
    content: Option<Arc<crate::claude_content::SharedContent>>,
    facts: Arc<OrdinaryFacts>,
    tldr: bool,
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.content_scope.revoke();
        self.active.store(false, Ordering::Release);
        self.done.store(true, Ordering::Release);
        // Completion is also the owner's reopen barrier. Release captured leases before the
        // worker count reaches zero, rather than leaving them for implicit field destruction.
        drop(self.content.take());
        drop(self._lifetime.take());
        drop(self._profile.take());
        *self.shared.workers.lock().unwrap() -= 1;
        self.shared.drained.notify_all();
    }
}
/// Shared worker/lifecycle implementation for fixed fixtures and explicitly configured owners.
pub struct ClaudeProvider {
    pub(crate) content: Option<Arc<crate::claude_content::SharedContent>>,
    isolation: Isolation,
    project: PathBuf,
    launch: LaunchSource,
    launches: usize,
    shared: Arc<Shared>,
    slots: HashMap<String, Slot>,
    closed: bool,
    facts: Arc<OrdinaryFacts>,
}
/// Existing fixture API. Only `create` is public; configured launch authority stays crate-internal.
pub type ClaudeFixture = ClaudeProvider;
impl ClaudeProvider {
    pub fn create(scenario: Scenario) -> Result<Self, Box<dyn std::error::Error>> {
        let profile = Arc::new(IsolatedProfile::create()?);
        let isolation = Isolation::create(profile.path(), &Policy::system())?;
        let project = isolation.project(Path::new("fixture"))?;
        std::fs::create_dir(project.join(".milagre"))?;
        std::fs::write(project.join(".milagre/coordination.json"),json!({"next_id":10,"name":"Claude fixture","worktrees":{"1":{"id":1,"path":project,"name":"main"}},"sessions":{"1":{"id":1,"worktree_id":1},"2":{"id":2,"worktree_id":1}},"messages":[]}).to_string())?;
        std::fs::create_dir(profile.path().join("home"))?;
        let exe = std::env::current_exe()?;
        let mut dir = exe.parent().ok_or("Missing fixture executable parent")?;
        if dir.file_name().is_some_and(|n| n == "deps") {
            dir = dir.parent().ok_or("Missing Cargo target directory")?;
        }
        let program = dir.join("runtime-fake-claude").canonicalize()?;
        let trace: Value = serde_json::from_str(ORDINARY_TRACE)?;
        let facts = Arc::new(OrdinaryFacts::from_trace(&trace)?);
        let mut scripts = Vec::new();
        let bodies = match scenario {
            Scenario::Ordinary => ordinary_scripts(&trace)?,
            Scenario::BackgroundRetention => background_retention_scripts(&trace)?,
            Scenario::Images => vec![images_script(&profile.path().join("images-release"))?],
            Scenario::Modes => vec![modes_script(&serde_json::from_str(MODES_TRACE)?)?],
            Scenario::LiveModes => {
                vec![live_modes_script(&serde_json::from_str(LIVE_MODES_TRACE)?)?]
            }
            _ => vec![script_for(scenario, &profile.path().join("queue-release"))],
        };
        for (index, body) in bodies.into_iter().enumerate() {
            let script = profile.path().join(format!("claude-script-{index}.json"));
            std::fs::write(&script, body.to_string())?;
            scripts.push(script);
        }
        let content = if matches!(scenario, Scenario::Design) {
            let helper = dir.join("milagre-design-raster").canonicalize()?;
            let raster = Arc::new(milagre_content_store::design::raster::RasterRenderer::new(
                helper,
            )?);
            Some(crate::claude_content::SharedContent::with_raster(
                isolation.clone(),
                project.clone(),
                Some(raster),
            )?)
        } else if matches!(
            scenario,
            Scenario::Content | Scenario::ContentAllow | Scenario::ContentDeny
        ) {
            Some(crate::claude_content::SharedContent::new(
                isolation.clone(),
                project.clone(),
            )?)
        } else {
            None
        };
        Ok(Self {
            content,
            isolation,
            project,
            launch: LaunchSource::Fixture {
                profile,
                program,
                scripts,
                scenario,
            },
            launches: 0,
            facts,
            shared: Arc::new(Shared {
                queue: Mutex::new(Queue {
                    events: VecDeque::new(),
                    bytes: 0,
                }),
                failed: AtomicBool::new(false),
                cleanup_failed: AtomicBool::new(false),
                peak_reply_tasks: AtomicUsize::new(0),
                workers: Mutex::new(0),
                drained: Condvar::new(),
                pending: Mutex::new(HashSet::new()),
                pending_modes: Mutex::new(HashMap::new()),
                pids: Mutex::new(HashMap::new()),
            }),
            slots: HashMap::new(),
            closed: false,
        })
    }
    /// Attach a selected executable to an existing owned Project. No directory is seeded,
    /// no credential is read, and no process starts until the owner admits a turn.
    #[cfg(any(test, feature = "chat-runtime"))]
    pub(crate) fn configured(
        context: ClaudeLaunchContext,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let ClaudeLaunchContext {
            isolation,
            project,
            mut launch,
            ordinary,
            lifetime,
        } = context;
        let project = isolation.resolve(&project)?;
        if !project.is_dir()
            || launch.cwd.as_ref() != Some(&project)
            || !launch.program.is_absolute()
        {
            return Err(
                "Claude requires an existing owned Project, matching cwd and absolute executable"
                    .into(),
            );
        }
        if launch.env.is_none() {
            return Err("Claude requires an explicitly captured environment".into());
        }
        let environment = launch.environment();
        for key in ["HOME", "CLAUDE_CONFIG_DIR"] {
            if !environment
                .iter()
                .rev()
                .find(|(name, _)| name == key)
                .is_some_and(|(_, path)| Path::new(path).is_absolute())
            {
                return Err("Claude requires explicit absolute HOME and CLAUDE_CONFIG_DIR".into());
            }
        }
        if !launch.mcp_servers.is_empty()
            || !launch.extra_args.is_empty()
            || launch.resume.is_some()
            || launch.session_id.is_some()
        {
            return Err("Configured Claude does not accept MCP extras, extra flags or launch-level session identities".into());
        }
        launch.no_session_persistence = false;
        launch.private_files = true;
        launch.strict_mcp_config = true;
        Ok(Self {
            content: None,
            isolation,
            project,
            launch: LaunchSource::Captured {
                launch: Box::new(launch),
                prompt_suggestions: ordinary.prompt_suggestions,
                lifetime,
            },
            launches: 0,
            shared: Arc::new(Shared {
                queue: Mutex::new(Queue {
                    events: VecDeque::new(),
                    bytes: 0,
                }),
                failed: AtomicBool::new(false),
                cleanup_failed: AtomicBool::new(false),
                peak_reply_tasks: AtomicUsize::new(0),
                workers: Mutex::new(0),
                drained: Condvar::new(),
                pending: Mutex::new(HashSet::new()),
                pending_modes: Mutex::new(HashMap::new()),
                pids: Mutex::new(HashMap::new()),
            }),
            slots: HashMap::new(),
            closed: false,
            facts: Arc::new(ordinary.facts),
        })
    }
    pub fn project(&self) -> &Path {
        &self.project
    }
    pub fn isolation(&self) -> Isolation {
        self.isolation.clone()
    }
    pub fn monitor(&self) -> FixtureMonitor {
        FixtureMonitor {
            content: self.content.clone(),
            shared: self.shared.clone(),
            _profile: match &self.launch {
                LaunchSource::Fixture { profile, .. } => Some(profile.clone()),
                #[cfg(any(test, feature = "chat-runtime"))]
                LaunchSource::Captured { .. } => None,
            },
        }
    }
    fn open(&self) -> Result<(), ProviderError> {
        if self.closed || self.shared.failed.load(Ordering::Acquire) {
            Err(refused("The fixture provider is closed"))
        } else {
            Ok(())
        }
    }
    fn answer(
        &mut self,
        chat: &str,
        turn: TurnId,
        id: AnswerId,
        request: &str,
        answer: Answer,
    ) -> Result<(), ProviderError> {
        self.open()?;
        let slot = self
            .slots
            .get(chat)
            .filter(|s| {
                !s.done.load(Ordering::Acquire) && s.latest.load(Ordering::Acquire) == turn.0
            })
            .ok_or_else(|| refused("The fixture session generation is gone"))?;
        if request.encode_utf16().count() > 4096 {
            return Err(refused("Invalid fixture identity"));
        }
        let request = request.to_owned();
        let mut pending = self.shared.pending.lock().unwrap();
        if pending.len() >= ANSWERS || !pending.insert((chat.into(), id)) {
            return Err(refused("The fixture answer lane is full or duplicated"));
        }
        drop(pending);
        let reply = Reply {
            turn,
            request,
            answer,
            guard: ReplyGuard {
                shared: self.shared.clone(),
                chat: chat.into(),
                id: Some(id),
                entered: false,
            },
        };
        if let Err(e) = slot.answers.try_send(reply) {
            e.into_inner().guard.refuse();
            return Err(refused("The fixture answer lane is full or closed"));
        }
        Ok(())
    }
}
fn native_request(request: &Value, project: &Path) -> Result<(Value, OrdinaryTurn), ProviderError> {
    if request.to_string().len() > 1024 * 1024 {
        return Err(refused("Oversized fixture turn"));
    }
    let fields = request
        .as_object()
        .ok_or_else(|| refused("Expected a turn object"))?;
    for key in fields.keys() {
        if ![
            "provider",
            "model",
            "permissionMode",
            "effort",
            "ultracode",
            "fastMode",
            "replies",
            "tldrEnabled",
            "prompt",
            "chatId",
            "cwd",
            "images",
            "resumeId",
        ]
        .contains(&key.as_str())
        {
            return Err(refused("Unsupported fixture turn configuration"));
        }
    }
    if request["provider"] != "claude" || request["cwd"].as_str() != project.to_str() {
        return Err(refused(
            "Only this isolated Claude fixture Project is admitted",
        ));
    }
    // Typed ordinary settings: mode, model, effort, ultracode, fastMode, replies and tldrEnabled.
    // `ask`/`auto`/`full` are admitted; unknown modes and mistyped values are refused, never coerced
    // as Node would (Node turns an unknown mode into Ask).
    let turn = OrdinaryTurn::parse(request).map_err(|e| match e {
        milagre_claude::ordinary::OrdinaryError::Mode => {
            refused("Only the ask, auto and full permission modes are implemented")
        }
        _ => refused("Invalid fixture turn setting"),
    })?;
    if request
        .get("images")
        .is_some_and(|v| !v.is_null() && v.as_array().is_none_or(|a| !a.is_empty()))
    {
        return Err(refused("Only typed owner image inputs are admitted"));
    }
    if !request["prompt"].is_string() {
        return Err(refused("Expected text prompt"));
    }
    let native = request.clone();
    native["chatId"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 4096)
        .ok_or_else(|| refused("Invalid Chat identity"))?;
    if native
        .get("resumeId")
        .is_some_and(|v| !v.is_null() && !v.is_string())
    {
        return Err(refused("Invalid fixture turn setting"));
    }
    Ok((native, turn))
}
/// Keep the historical 1 MiB fixture request ceiling after images move out of raw JSON.
/// Count their canonical dataURL representation, including per-image objects and separators;
/// caller paths/metadata are never inputs to native prompt assembly.
fn typed_images<'a>(
    request: &Value,
    images: &'a [ImageInput],
) -> Result<Vec<PromptImage<'a>>, ProviderError> {
    let mut size = request.to_string().len();
    for (index, image) in images.iter().enumerate() {
        size = size
            .checked_add(
                "{\"dataUrl\":\"data:;base64,\"}".len()
                    + image.mime().len()
                    + image.bytes().len().div_ceil(3) * 4
                    + usize::from(index > 0),
            )
            .ok_or_else(|| refused("Oversized fixture image turn"))?;
        if size > 1024 * 1024 {
            return Err(refused("Oversized fixture image turn"));
        }
    }
    images
        .iter()
        .map(|image| PromptImage::new(image.mime(), image.bytes()).map_err(refused))
        .collect()
}
impl Provider for ClaudeFixture {
    fn name(&self) -> &str {
        "claude"
    }
    fn supports_image_inputs(&self) -> bool {
        true
    }
    fn validate_image_turn(
        &self,
        request: &RawJson,
        images: &[ImageInput],
    ) -> Result<(), ProviderError> {
        self.open()?;
        native_request(&request.0, &self.project)?;
        let images = typed_images(&request.0, images)?;
        prompt_images::validate_content(
            request.0["prompt"].as_str().unwrap(),
            &images,
            IMAGE_FRAME_BYTES.min(milagre_claude::Limits::default().max_outgoing_frame_bytes),
        )
        .map_err(refused)?;
        Ok(())
    }
    fn start_turn(&mut self, id: TurnId, request: &RawJson) -> Result<(), ProviderError> {
        self.start_turn_with_images(id, request, &[])
    }
    fn start_turn_with_images(
        &mut self,
        id: TurnId,
        request: &RawJson,
        images: &[ImageInput],
    ) -> Result<(), ProviderError> {
        let request = &request.0;
        self.open()?;
        if id.0 == 0 {
            return Err(refused("Invalid turn generation"));
        }
        let (mut native, turn) = native_request(request, &self.project)?;
        let images = typed_images(request, images)?;
        let content = prompt_images::user_content(
            request["prompt"].as_str().unwrap(),
            &images,
            IMAGE_FRAME_BYTES.min(milagre_claude::Limits::default().max_outgoing_frame_bytes),
        )
        .map_err(refused)?;
        let chat = request["chatId"].as_str().unwrap().to_owned();
        if let Some(content) = &self.content {
            // The owner constructs this outbound identity after saving the Chat and rechecking
            // readiness. Raw renderer requests never call the provider or this admission seam.
            content
                .admit_owner_chat(&chat)
                .map_err(|error| refused(&error.message))?;
        }
        self.slots
            .retain(|_, slot| !slot.done.load(Ordering::Acquire));
        self.shared
            .pids
            .lock()
            .unwrap()
            .retain(|chat, _| self.slots.contains_key(chat));
        // SessionManager.currentEntry: instructions are fixed per session, so an idle session whose
        // TLDR setting changed is closed and its native id resumed by a fresh one. The detached
        // worker reaps on its own and reports Exited for its own last turn only.
        if let Some(slot) = self
            .slots
            .get(&chat)
            .filter(|slot| slot.tldr != turn.tldr_enabled && !slot.active.load(Ordering::Acquire))
        {
            let (session, runtime) = {
                let captured = slot.session.lock().unwrap();
                let captured = captured
                    .as_ref()
                    .ok_or_else(|| refused("The fixture session activity is unavailable"))?;
                (
                    captured
                        .session
                        .upgrade()
                        .ok_or_else(|| refused("The fixture session activity is unavailable"))?,
                    captured.runtime.clone(),
                )
            };
            let admission = if *self.shared.workers.lock().unwrap() >= CHATS {
                // Reuse needs no worker permit. An idle or unknown session is never closed when
                // no replacement permit is available; no check-then-close race is introduced.
                if session
                    .busy_without_turn()
                    .map_err(|_| refused("The fixture session activity is unavailable"))?
                {
                    IdleClose::Busy
                } else {
                    return Err(refused("The fixture Chat limit was reached"));
                }
            } else {
                let _entered = runtime.enter();
                session
                    .close_if_idle(native["resumeId"].as_str())
                    .map_err(|_| refused("The fixture session cannot safely be replaced"))?
            };
            if let IdleClose::Closing { native_id } = admission {
                let slot = self.slots.remove(&chat).expect("captured above");
                slot.content_scope.revoke();
                slot.close.send_replace(true);
                if let Some(current) = native_id {
                    native["resumeId"] = json!(current);
                }
            }
        }
        if !self.slots.contains_key(&chat) {
            if *self.shared.workers.lock().unwrap() >= CHATS {
                return Err(refused("The fixture Chat limit was reached"));
            }
            let (start, rx) = mpsc::channel(1);
            let (answers, answers_rx) = mpsc::channel(8);
            let (modes, modes_rx) = mpsc::channel(8);
            let (close, close_rx) = watch::channel(false);
            let (interrupt, interrupt_rx) = watch::channel(0);
            let active = Arc::new(AtomicBool::new(false));
            let done = Arc::new(AtomicBool::new(false));
            let latest = Arc::new(AtomicU64::new(0));
            let native_id = Arc::new(Mutex::new(None));
            let session = Arc::new(Mutex::new(None));
            let content_scope = match &self.content {
                Some(content) => content
                    .capture_session(&chat)
                    .map_err(|error| refused(&error.message))?,
                None => crate::claude_content::SessionContent::new(),
            };
            let captured = self.launch.capture(self.launches);
            let worker = Worker {
                session: session.clone(),
                content_scope: content_scope.clone(),
                shared: self.shared.clone(),
                _profile: captured.profile,
                _lifetime: captured.lifetime,
                project: self.project.clone(),
                launch: captured.options,
                chat: chat.clone(),
                scenario: captured.scenario,
                prompt_suggestions: captured.prompt_suggestions,
                facts: self.facts.clone(),
                tldr: turn.tldr_enabled,
                active: active.clone(),
                done: done.clone(),
                latest: latest.clone(),
                native_id: native_id.clone(),
                content: self.content.clone(),
            };
            *self.shared.workers.lock().unwrap() += 1;
            std::thread::Builder::new()
                .name("claude-owner".into())
                .spawn(move || {
                    match tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                    {
                        Ok(runtime) => runtime.block_on(async {
                            worker
                                .run(rx, answers_rx, modes_rx, close_rx, interrupt_rx)
                                .await;
                            crate::executor::drain(&runtime, Duration::from_secs(3), || {
                                worker.shared.failed.store(true, Ordering::Release);
                                let _n = worker.shared.workers.lock().unwrap();
                                worker.shared.cleanup_failed.store(true, Ordering::Release);
                                worker.shared.drained.notify_all();
                            })
                            .await;
                        }),
                        Err(_) => {
                            drop(answers_rx);
                            drop(modes_rx);
                            let mut rx = rx;
                            if let Some(start) = rx.blocking_recv() {
                                worker.shared.emit(
                                    ProviderEvent::StartFailed {
                                        chat: worker.chat.clone(),
                                        turn: start.id,
                                        error: failed(),
                                    },
                                    true,
                                );
                                worker.exit(start.id);
                            }
                        }
                    }
                })
                .map_err(|_| failed())?;
            self.slots.insert(
                chat.clone(),
                Slot {
                    session,
                    content_scope,
                    start,
                    answers,
                    modes,
                    close,
                    interrupt,
                    active,
                    done,
                    latest,
                    native_id,
                    tldr: turn.tldr_enabled,
                },
            );
            self.launches += 1;
        }
        let slot = self.slots.get(&chat).unwrap();
        if let Some(resume) = native["resumeId"].as_str() {
            if slot
                .native_id
                .lock()
                .unwrap()
                .as_deref()
                .is_some_and(|current| current != resume)
            {
                return Err(refused(
                    "Close the previous fixture session before resuming another native session",
                ));
            }
        }
        if *slot.close.borrow() {
            return Err(refused("The fixture session is closing"));
        }
        if slot.active.swap(true, Ordering::AcqRel) {
            return Err(refused(
                "Steering is not implemented by this fixture adapter",
            ));
        }
        slot.latest.store(id.0, Ordering::Release);
        if slot
            .start
            .try_send(Start {
                id,
                content,
                request: native,
                turn,
            })
            .is_err()
        {
            slot.active.store(false, Ordering::Release);
            return Err(failed());
        }
        Ok(())
    }
    fn set_mode(
        &mut self,
        chat: &str,
        turn: TurnId,
        change: ModeChangeId,
        mode: &str,
    ) -> Result<(), ProviderError> {
        self.open()?;
        if !["ask", "auto", "full"].contains(&mode) {
            return Err(refused(
                "Only the ask, auto and full permission modes are implemented",
            ));
        }
        let slot = self
            .slots
            .get(chat)
            .filter(|slot| {
                !slot.done.load(Ordering::Acquire)
                    && !*slot.close.borrow()
                    && slot.latest.load(Ordering::Acquire) == turn.0
            })
            .ok_or_else(|| refused("The fixture session generation is gone"))?;
        let mut pending = self.shared.pending_modes.lock().unwrap();
        if pending.len() >= MODES || pending.contains_key(&(chat.into(), change)) {
            return Err(refused("The fixture mode lane is full or duplicated"));
        }
        pending.insert(
            (chat.into(), change),
            RetainedMode {
                worker: slot.done.clone(),
                uncertain: false,
            },
        );
        drop(pending);
        let command = ModeChange {
            turn,
            mode: mode.into(),
            guard: ModeGuard {
                shared: self.shared.clone(),
                chat: chat.into(),
                id: Some(change),
                entered: false,
            },
        };
        if let Err(error) = slot.modes.try_send(command) {
            error.into_inner().guard.refuse();
            return Err(refused("The fixture mode lane is full or closed"));
        }
        Ok(())
    }
    fn interrupt(&mut self, chat: &str, turn: TurnId) -> Result<(), ProviderError> {
        let s = self
            .slots
            .get(chat)
            .filter(|s| {
                s.latest.load(Ordering::Acquire) == turn.0 && !s.done.load(Ordering::Acquire)
            })
            .ok_or_else(|| refused("The fixture session generation is gone"))?;
        s.interrupt.send_replace(turn.0);
        Ok(())
    }
    fn close_chat(&mut self, chat: &str, turn: TurnId) -> Result<(), ProviderError> {
        if self
            .slots
            .get(chat)
            .is_none_or(|slot| slot.latest.load(Ordering::Acquire) != turn.0)
        {
            return Err(refused("The fixture session generation is gone"));
        }
        // Detach the captured slot at admission. Its worker retains the profile and
        // reaps independently; a new turn gets a fresh session and MCP registration.
        let slot = self.slots.remove(chat).expect("generation checked");
        slot.content_scope.revoke();
        slot.close.send_replace(true);
        Ok(())
    }
    fn respond_permission(
        &mut self,
        chat: &str,
        turn: TurnId,
        answer: AnswerId,
        request: &str,
        decision: &str,
    ) -> Result<(), ProviderError> {
        if !["allow", "deny", "allow-for-chat"].contains(&decision) {
            return Err(refused("Invalid permission decision"));
        }
        self.answer(
            chat,
            turn,
            answer,
            request,
            Answer::Permission(decision.into()),
        )
    }
    fn answer_question(
        &mut self,
        chat: &str,
        turn: TurnId,
        answer: AnswerId,
        request: &str,
        answers: &RawJson,
    ) -> Result<(), ProviderError> {
        let answers = &answers.0;
        if answers.to_string().len() > 1024 * 1024 {
            return Err(refused("Oversized question answer"));
        }
        if answers.is_null() {
            return self.answer(chat, turn, answer, request, Answer::Question(Value::Null));
        }
        let mut native = serde_json::Map::new();
        for (key, value) in answers
            .as_object()
            .ok_or_else(|| refused("Expected question answer map"))?
        {
            let key = key.clone();
            let values = value
                .as_array()
                .ok_or_else(|| refused("Expected answer list"))?;
            let mut out = Vec::new();
            for value in values {
                let text = value
                    .as_str()
                    .ok_or_else(|| refused("Expected answer text"))?;
                out.push(json!(text));
            }
            native.insert(key, json!(out));
        }
        self.answer(
            chat,
            turn,
            answer,
            request,
            Answer::Question(Value::Object(native)),
        )
    }
    fn shutdown(&mut self) {
        self.closed = true;
        if let Some(content) = &self.content {
            content.revoke();
        }
        for slot in self.slots.values() {
            slot.content_scope.revoke();
            slot.close.send_replace(true);
        }
    }
    fn take_events(&mut self) -> Vec<ProviderEvent> {
        let mut q = self.shared.queue.lock().unwrap();
        let events: Vec<_> = q.events.drain(..).collect();
        q.bytes = 0;
        drop(q);
        let mut pending = self.shared.pending.lock().unwrap();
        for e in &events {
            if let ProviderEvent::AnswerSettled { chat, answer, .. } = e {
                pending.remove(&(chat.clone(), *answer));
            }
        }
        let mut pending_modes = self.shared.pending_modes.lock().unwrap();
        for event in &events {
            if let ProviderEvent::ModeSettled {
                chat,
                change,
                outcome,
            } = event
            {
                if !matches!(outcome, ModeOutcome::Uncertain(_)) {
                    pending_modes.remove(&(chat.clone(), *change));
                }
            }
        }
        events
    }
}
impl Drop for ClaudeFixture {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(test)]
mod configured_tests {
    use super::*;

    #[cfg(feature = "chat-runtime")]
    #[test]
    fn configured_new_chat_attaches_mcp_before_any_actor_membership_refresh() {
        use milagre_owner_store::{
            chat_host::ChatHost,
            states::{ProjectStates, Timing},
        };
        use std::time::Instant;
        let mut fixture = ClaudeFixture::create(Scenario::Content).unwrap();
        fixture.content.take().unwrap().shutdown();
        let mut launch = fixture.launch.capture(0).options;
        launch.cwd = Some(fixture.project.clone());
        let content = crate::claude_content::SharedContent::configured(
            fixture.isolation(),
            fixture.project.clone(),
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/core/src/bundled-skills"),
            Arc::new(|| Ok(())),
        )
        .unwrap();
        let mut provider = ClaudeProvider::configured(ClaudeLaunchContext {
            isolation: fixture.isolation(),
            project: fixture.project.clone(),
            launch,
            ordinary: inputs(),
            lifetime: None,
        })
        .unwrap();
        provider.content = Some(content.clone());
        let monitor = provider.monitor();
        let mut host = ChatHost::new(ProjectStates::new(
            fixture.isolation(),
            Timing::default(),
            0,
        ));
        host.register(Box::new(provider));
        host.open_project(&fixture.project).unwrap();
        host.states
            .update(&fixture.project, Some(&[]), true, |state| {
                Some(state.with_field("sessions", json!({})))
            })
            .unwrap();
        content
            .reconcile(host.states.current(&fixture.project).unwrap().sessions())
            .unwrap();
        content.opened(true);
        let sent = host.send(&json!({"projectPath":fixture.project,"worktreeId":1,"provider":"claude","model":"sonnet","body":"fixture input","permissionMode":"ask"})).unwrap();
        let chat = format!("{}#{}", fixture.project.display(), sent.session_id);
        assert!(sent.session_id.as_i64().unwrap() > 2);
        assert!(host
            .states
            .current(&fixture.project)
            .unwrap()
            .has_session(sent.session_id.as_i64().unwrap()));
        // Deliberately never reconcile the new owner state. The captured worker's MCP attach
        // must succeed from the committed Provider admission before any actor publication.
        let deadline = Instant::now() + Duration::from_secs(5);
        while !host.runs().is_empty() {
            assert!(host.pump().is_empty());
            assert!(
                Instant::now() < deadline,
                "new Chat MCP turn did not finish"
            );
            std::thread::sleep(Duration::from_millis(2));
        }
        let artifacts = content
            .renderer("artifact:list", &json!({"chatId":chat}))
            .unwrap();
        assert_eq!(artifacts.as_array().unwrap().len(), 1);
        let saved = content
            .renderer(
                "artifact:get",
                &json!({"chatId":chat,"id":artifacts[0]["id"]}),
            )
            .unwrap();
        assert!(saved.to_string().contains("Native shared content"));
        assert!(content
            .renderer(
                "artifact:list",
                &json!({"chatId":format!("{}#1",fixture.project.display())})
            )
            .is_err());
        host.shutdown(false).unwrap();
        assert!(monitor.wait_drained(Duration::from_secs(5)));
        content.shutdown();
    }

    fn inputs() -> ClaudeInstructionInputs {
        ClaudeInstructionInputs::bundled(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/core/src/bundled-skills"),
            HostNetwork::default(),
            false,
        )
        .unwrap()
    }

    #[test]
    fn configured_refuses_ambient_environment_and_foreign_working_directory() {
        let fixture = ClaudeFixture::create(Scenario::Reply).unwrap();
        for kind in [
            "ambient",
            "foreign-cwd",
            "relative-program",
            "missing-config",
        ] {
            let mut launch = fixture.launch.capture(0).options;
            launch.cwd = Some(fixture.project.clone());
            match kind {
                "ambient" => launch.env = None,
                "foreign-cwd" => launch.cwd = Some(PathBuf::from("/foreign")),
                "relative-program" => launch.program = PathBuf::from("claude"),
                "missing-config" => launch
                    .env
                    .as_mut()
                    .unwrap()
                    .retain(|(name, _)| name != "CLAUDE_CONFIG_DIR"),
                _ => unreachable!(),
            }
            assert!(
                ClaudeProvider::configured(ClaudeLaunchContext {
                    isolation: fixture.isolation(),
                    project: fixture.project.clone(),
                    launch,
                    ordinary: inputs(),
                    lifetime: None,
                })
                .is_err(),
                "{kind}"
            );
        }
        assert_eq!(fixture.monitor().workers(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn configured_core_uses_captured_environment_actual_bundle_and_persistent_launch() {
        use std::os::fd::AsRawFd;
        // Fixed child evidence only. This executes the same configured constructor/worker used by
        // a selected real CLI, without reading a real account or starting a model request.
        let fixture = ClaudeFixture::create(Scenario::Reply).unwrap();
        let mut launch = fixture.launch.capture(0).options;
        launch.cwd = Some(fixture.project.clone());
        launch
            .env
            .as_mut()
            .unwrap()
            .push(("CAPTURED_SETTING".into(), "selected-once".into()));
        let ordinary = inputs();
        let expected_prompt = ordinary
            .facts
            .bundle
            .milagre_instructions(true, None, false);
        let expected_agents = ordinary.facts.agents.clone();
        let script = launch
            .env
            .as_ref()
            .unwrap()
            .iter()
            .find(|(name, _)| name == "FAKE_CLAUDE_SCRIPT")
            .unwrap()
            .1
            .clone();
        let proof = fixture.project.parent().unwrap().join("configured-eof");
        let lock_path = fixture
            .project
            .parent()
            .unwrap()
            .join("configured-root.lock");
        let lease = Arc::new(
            std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .open(&lock_path)
                .unwrap(),
        );
        assert_eq!(
            unsafe { libc::flock(lease.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
        let contender = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&lock_path)
            .unwrap();
        std::fs::write(Path::new(&script), json!([
            { "expect_launch": { "absent": ["--no-session-persistence"], "env": { "CAPTURED_SETTING": "selected-once" }, "files": { "--append-system-prompt-file": expected_prompt } } },
            { "expect": { "subtype": "initialize", "fields": { "/request/agents": expected_agents, "/request/promptSuggestions": false } } },
            { "reply": {} },
            { "expect": { "subtype": "set_max_thinking_tokens" } },
            { "reply": {} },
            { "expect": { "type": "user", "fields": { "/message/content": [{ "type": "text", "text": "configured turn" }] } } },
            { "emit": { "type": "system", "subtype": "init", "session_id": "configured-native" } },
            { "emit": { "type": "result", "subtype": "success", "num_turns": 1, "result": "done" } },
            { "expect_eof": proof },
        ]).to_string()).unwrap();
        let mut provider = ClaudeProvider::configured(ClaudeLaunchContext {
            isolation: fixture.isolation(),
            project: fixture.project.clone(),
            launch,
            ordinary,
            lifetime: Some(lease.clone()),
        })
        .unwrap();
        let monitor = provider.monitor();
        let request = RawJson(
            json!({ "provider": "claude", "chatId": "configured", "cwd": provider.project(), "prompt": "configured turn", "permissionMode": "ask", "model": "sonnet" }),
        );
        provider.start_turn(TurnId(1), &request).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut completed = false;
        while !completed && std::time::Instant::now() < deadline {
            for event in provider.take_events() {
                match event {
                    ProviderEvent::Agent {
                        event: RawJson(value),
                        ..
                    } if value["type"] == "turn-completed" => completed = true,
                    ProviderEvent::StartFailed { error, .. } => {
                        panic!("configured start failed: {error:?}")
                    }
                    ProviderEvent::Agent {
                        event: RawJson(value),
                        ..
                    } if value["type"] == "turn-failed" => {
                        panic!("configured turn failed: {value}")
                    }
                    _ => {}
                }
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(
            completed,
            "fixed child must accept the configured native launch and payload"
        );
        let captured_runtime = provider.slots["configured"]
            .session
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .runtime
            .clone();
        let (release, blocked) = tokio::sync::oneshot::channel::<()>();
        let (entered, observed) = std::sync::mpsc::channel();
        captured_runtime.spawn(async move {
            entered.send(()).unwrap();
            let _ = blocked.await;
        });
        observed.recv_timeout(Duration::from_secs(2)).unwrap();
        drop(provider);
        drop(lease);
        assert_eq!(
            unsafe { libc::flock(contender.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            -1,
            "a dropped outer owner cannot release the root while its captured worker retains tasks"
        );
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::EWOULDBLOCK)
        );
        monitor.shared.cleanup_failed.store(true, Ordering::Release);
        let before_wait = std::time::Instant::now();
        assert!(!monitor.wait_drained(Duration::from_millis(25)));
        assert!(
            before_wait.elapsed() >= Duration::from_millis(25),
            "cleanup failure must not cause a busy-spin wait"
        );
        release.send(()).unwrap();
        assert!(monitor.wait_drained(Duration::from_secs(5)));
        assert_eq!(
            unsafe { libc::flock(contender.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0,
            "wait_drained success is an immediate root-lease release barrier"
        );
        assert!(
            proof.is_file(),
            "same core closes and reaps the captured child"
        );
        assert!(
            fixture.project().is_dir(),
            "provider cleanup does not delete caller-owned data"
        );
    }
}
impl Worker {
    /// Ordinary instructions from captured bundle/host inputs. Configured owners supply the
    /// prompt-suggestion choice; only fixtures read their own temporary settings file.
    fn plan(
        &self,
        options: &mut SessionOptions,
        registration: Option<&milagre_claude::mcp::McpRegistration>,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let design = registration.is_some_and(|r| {
            r.provider_manifest()
                .iter()
                .any(|tool| tool.name == "design_show")
        });
        let host = self.facts.host.instructions();
        let workspace = instructions::session_workspace(None, &host);
        let prompt_suggestions = match self.prompt_suggestions {
            Some(enabled) => enabled,
            None => {
                let profile = self._profile.as_ref().ok_or("Missing fixture profile")?;
                let settings = match std::fs::read(profile.path().join("home/settings.json")) {
                    Ok(bytes) => Some(bytes),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                    Err(e) => return Err(e.into()),
                };
                instructions::prompt_suggestions_enabled(settings.as_deref(), None)
            }
        };
        OrdinaryLaunch {
            system_append: self.facts.bundle.milagre_instructions(
                self.tldr,
                workspace.as_deref(),
                false,
            ),
            subagent_context: self.facts.bundle.subagent_context(design),
            agents: self.facts.agents.clone(),
            prompt_suggestions,
            additional_directories: vec![],
            // The skills read allowance names exactly the same captured directory as instructions.
            // Fixture traces use a nonexistent synthetic directory, so those grant no extra reads.
            skills_directory: PathBuf::from(self.facts.bundle.skills_dir()),
        }
        .apply(options)?;
        Ok(())
    }
    fn agent(&self, id: TurnId, event: Value, reserved: bool) -> bool {
        self.shared.emit(
            ProviderEvent::Agent {
                chat: self.chat.clone(),
                turn: id,
                event: RawJson(event),
            },
            reserved,
        )
    }
    fn exit(&self, id: TurnId) {
        self.shared.emit(
            ProviderEvent::Exited {
                chat: self.chat.clone(),
                turn: id,
                error: failed(),
            },
            true,
        );
    }
    async fn run(
        &self,
        mut starts: mpsc::Receiver<Start>,
        mut answers: mpsc::Receiver<Reply>,
        mut modes: mpsc::Receiver<ModeChange>,
        mut close: watch::Receiver<bool>,
        mut interrupt: watch::Receiver<u64>,
    ) {
        let Some(first) = starts.recv().await else {
            return;
        };
        let mut latest = first.id;
        let mut pending = Some(first);
        let mut running = false;
        let mut launch = self.launch.clone();
        launch.cwd = Some(self.project.clone());
        let mut options = SessionOptions::new(launch);
        options.resume_id = pending
            .as_ref()
            .and_then(|s| s.request["resumeId"].as_str().map(str::to_owned));
        if self.scenario.is_some() {
            options.interrupt_grace = Duration::from_millis(150);
            options.limits.close_grace = Duration::from_millis(150);
            options.limits.kill_grace = Duration::from_millis(500);
        }
        options.event_capacity = 256;
        options.event_bytes = BYTES;
        let _registration = match &self.content {
            Some(content) => match content.attach(&self.chat, &mut options, &self.content_scope) {
                Ok(registration) => Some(registration),
                Err(_) => {
                    self.shared.emit(
                        ProviderEvent::StartFailed {
                            chat: self.chat.clone(),
                            turn: latest,
                            error: failed(),
                        },
                        true,
                    );
                    self.exit(latest);
                    return;
                }
            },
            None => None,
        };
        if self.plan(&mut options, _registration.as_deref()).is_err() {
            self.shared.emit(
                ProviderEvent::StartFailed {
                    chat: self.chat.clone(),
                    turn: latest,
                    error: failed(),
                },
                true,
            );
            self.exit(latest);
            return;
        }
        let (session, mut events) = ClaudeSession::new(options);
        let session = Arc::new(session);
        *self.session.lock().unwrap() = Some(SessionHandle {
            session: Arc::downgrade(&session),
            runtime: tokio::runtime::Handle::current(),
        });
        let mut replies = tokio::task::JoinSet::new();
        let mut mode_tasks = tokio::task::JoinSet::new();
        loop {
            if *close.borrow() || self.shared.failed.load(Ordering::Acquire) {
                break;
            }
            if let Some(start) = pending.take() {
                latest = start.id;
                let request = start.turn.request(start.content);
                let result = tokio::select! {result=session.start_turn(request)=>Some(result),_=close.changed()=>None,_=interrupt.changed()=>None};
                if let Some(pid) = session.pid() {
                    self.shared
                        .pids
                        .lock()
                        .unwrap()
                        .insert(self.chat.clone(), pid);
                }
                *self.native_id.lock().unwrap() = session.native_id();
                match result {
                    Some(Ok(start)) if !start.cancelled && !start.steered => {
                        running = true;
                        self.shared.emit(
                            ProviderEvent::Started {
                                chat: self.chat.clone(),
                                turn: latest,
                                result: RawJson(json!({"turnId":start.turn_id})),
                            },
                            false,
                        );
                    }
                    _ => {
                        self.shared.emit(
                            ProviderEvent::StartFailed {
                                chat: self.chat.clone(),
                                turn: latest,
                                error: failed(),
                            },
                            true,
                        );
                        break;
                    }
                }
            }
            tokio::select! {
             biased;
             _=close.changed()=>break,
             _=interrupt.changed()=>{if running&&*interrupt.borrow()==latest.0 {session.interrupt().await;}},
             event=events.recv()=>match event {
              Some(event)=>{*self.native_id.lock().unwrap() = session.native_id();let is_end=terminal(&event);if is_end{if !running{continue;}running=false;self.active.store(false,Ordering::Release);}else if event["type"]=="turn-started"&&!running{break;}
               // Forward compact subagent deltas unchanged. The owner merges transcript rows by id.
               if !self.agent(latest,event,is_end){break;}
              },None=>break
             },
             reply=answers.recv(), if replies.len()<8=>if let Some(mut reply)=reply{
              if reply.turn!=latest{drop(reply);continue;}
              let session=session.clone();let delay=match self.scenario{Some(Scenario::QuestionDelayedReceipt)=>400,Some(Scenario::AnswerSaturation)=>10000,_=>0};
              replies.spawn(async move{reply.guard.entered=true;let accepted=match reply.answer{Answer::Permission(decision)=>session.respond_to_permission(&reply.request,&decision),Answer::Question(value)=>session.answer_question(&reply.request,value.as_object())};if accepted&&delay>0{tokio::time::sleep(Duration::from_millis(delay)).await;}reply.guard.settle(if accepted{AnswerOutcome::Accepted}else{AnswerOutcome::NotWaiting});});
              self.shared.peak_reply_tasks.fetch_max(replies.len(),Ordering::AcqRel);
             },
             _=replies.join_next(),if !replies.is_empty()=>{},
             command=modes.recv(), if mode_tasks.is_empty()=>if let Some(mut command)=command{
                if command.turn != latest || self.latest.load(Ordering::Acquire) != command.turn.0 { drop(command); continue; }
                let session=session.clone();
                let generation=self.latest.clone();
                let close=close.clone();
                mode_tasks.spawn(async move {
                    let result=session.set_permission_mode_checked_if(&command.mode, || {
                        if generation.load(Ordering::Acquire) != command.turn.0 || *close.borrow() { return false; }
                        command.guard.entered=true;
                        true
                    }).await;
                    let outcome=match result {
                        Ok(())=>ModeOutcome::Applied,
                        Err(_)=>ModeOutcome::Failed(if command.guard.entered {
                            ProviderError::new(ProviderErrorKind::Other, "Claude could not apply the requested permission mode.")
                        } else { command.guard.error() }),
                    };
                    command.guard.settle(outcome);
                });
             },
             _=mode_tasks.join_next(),if !mode_tasks.is_empty()=>{},
             start=starts.recv()=>match start{Some(start)=>pending=Some(start),None=>break}
            }
        }
        if let Some(start) = pending.take() {
            self.shared.emit(
                ProviderEvent::StartFailed {
                    chat: self.chat.clone(),
                    turn: start.id,
                    error: failed(),
                },
                true,
            );
        }
        modes.close();
        while let Ok(command) = modes.try_recv() {
            drop(command);
        }
        mode_tasks.abort_all();
        while mode_tasks.join_next().await.is_some() {}
        answers.close();
        while let Ok(reply) = answers.try_recv() {
            drop(reply);
        }
        replies.abort_all();
        while replies.join_next().await.is_some() {}
        session.close().await;
        // Finish exact operations for this worker, including those from an earlier turn. A newer
        // replacement's Exited must never release these reservations. The definitive receipts
        // follow actual native cleanup and precede this worker's final Exited event.
        self.shared.settle_closed_modes(&self.done);
        // Close settles background children with compact transcript patches. Preserve
        // those deltas before the final host terminal and process-exit notification.
        while let Some(event) = events.try_recv() {
            let end = terminal(&event);
            if end {
                if !running {
                    continue;
                }
                running = false;
            }
            if event["type"] != "turn-started" {
                self.agent(latest, event, end);
            }
        }
        if running {
            self.agent(latest, json!({"type":"turn-cancelled"}), true);
        }
        self.exit(latest);
    }
}
/// One fake script per native process from the Node trace: launch assertions (argv, TODO env
/// flag, private prompt/settings bytes, `initialize`), then Node's control and user order. The
/// first process also answers both hooks exactly as Node's did, ignores SIGTERM and lingers after
/// EOF, so its Exited arrives after the replacement process has started (late generation).
fn ordinary_scripts(trace: &Value) -> Result<Vec<Value>, Box<dyn std::error::Error>> {
    let mut scripts = Vec::new();
    for (index, query) in trace["queries"]
        .as_array()
        .ok_or("trace queries")?
        .iter()
        .enumerate()
    {
        let mut steps = Vec::new();
        if index == 0 {
            steps.push(json!({"ignore_sigterm":true}));
        }
        steps.extend(node_trace::launch_steps(query)?);
        let hooks = node_trace::hook_steps(query)?;
        let controls = query["controls"].as_array().ok_or("trace controls")?;
        steps.extend(node_trace::control_steps(controls, |turn| {
            let mut frames = vec![json!({"emit":{"type":"system","subtype":"init","session_id":"fixture-session"}})];
            if turn == 0 {
                frames.extend(hooks.clone());
            }
            frames.push(json!({"emit":{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Claude fixture hello"}}}}));
            frames.push(json!({"emit":{"type":"result","subtype":"success","num_turns":1,"result":"done"}}));
            frames
        })?);
        if index == 0 {
            steps.extend([json!({"wait_eof":true}), json!({"sleep_ms":10000})]);
        }
        scripts.push(Value::Array(steps));
    }
    Ok(scripts)
}
/// The Node mode trace as one fake process: launch in Full (bypassPermissions), then per turn Node's
/// mode/effort controls, the user message and one Bash `can_use_tool` whose answer must equal the
/// recorded Node answer (Full allows without a card; Auto/Ask wait for the owner's answer).
fn modes_script(trace: &Value) -> Result<Value, Box<dyn std::error::Error>> {
    let query = &trace["queries"][0];
    let permissions = trace["permissions"]
        .as_array()
        .ok_or("trace permissions")?
        .clone();
    let mut steps = node_trace::launch_steps(query)?;
    steps.extend(node_trace::control_steps(query["controls"].as_array().ok_or("trace controls")?, |turn| {
        let p = &permissions[turn];
        let id = p["request"]["requestId"].clone();
        vec![
            json!({"emit":{"type":"system","subtype":"init","session_id":"fixture-session"}}),
            json!({"request":{"id":id,"request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"},"tool_use_id":p["request"]["toolUseID"]}}}),
            json!({"expect":{"type":"control_response","fields":{"/response/request_id":id,"/response/response":p["result"]}}}),
            json!({"emit":{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Claude fixture hello"}}}}),
            json!({"emit":{"type":"result","subtype":"success","num_turns":1,"result":"done"}}),
        ]
    })?);
    Ok(Value::Array(steps))
}
/// Same-turn and idle controls from the actual Node live-mode trace. Mode control and released
/// permission response use independent native lanes; only their pair, not an invented order, is asserted.
fn live_modes_script(trace: &Value) -> Result<Value, Box<dyn std::error::Error>> {
    let query = &trace["queries"][0];
    let controls = query["controls"].as_array().ok_or("trace controls")?;
    let user = controls
        .iter()
        .position(|c| c.get("user").is_some())
        .ok_or("trace user")?;
    let permissions = trace["permissions"].as_array().ok_or("trace permissions")?;
    let request = |p: &Value| json!({"request":{"id":p["request"]["requestId"],"request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"},"tool_use_id":p["request"]["toolUseID"]}}});
    let mut steps = node_trace::launch_steps(query)?;
    steps.extend(node_trace::control_steps(&controls[..=user], |_| {
        vec![
            json!({"emit":{"type":"system","subtype":"init","session_id":"fixture-session"}}),
            request(&permissions[0]),
        ]
    })?);
    steps.push(json!({"expect_pair":[
        {"/type":"control_request","/request/subtype":"set_permission_mode","/request/mode":controls[user+1]["setPermissionMode"][0]},
        {"/type":"control_response","/response/request_id":permissions[0]["request"]["requestId"],"/response/response":permissions[0]["result"]}
    ]}));
    steps.extend(node_trace::control_steps(
        &controls[user + 2..user + 3],
        |_| vec![],
    )?);
    steps.push(request(&permissions[1]));
    steps.extend([
        json!({"expect":{"type":"control_response","fields":{"/response/request_id":permissions[1]["request"]["requestId"],"/response/response":permissions[1]["result"]}}}),
        json!({"emit":{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Claude fixture hello"}}}}),
        json!({"emit":{"type":"result","subtype":"success","num_turns":1,"result":"done"}}),
    ]);
    steps.extend(node_trace::control_steps(
        &controls[user + 3..],
        |_| vec![],
    )?);
    Ok(Value::Array(steps))
}
/// Two exact ordinary launches: the first keeps its original instructions through four turns
/// with changing native activity; only the fully settled session is replaced for turn five.
fn background_retention_scripts(trace: &Value) -> Result<Vec<Value>, Box<dyn std::error::Error>> {
    let child = |id: &str, background: bool| json!({"emit":{"type":"assistant","message":{"content":[{"type":"tool_use","id":id,"name":"Agent","input":{"description":"Retention child","run_in_background":background}}]}}});
    let complete = |id: &str| json!({"emit":{"type":"system","subtype":"task_notification","tool_use_id":id,"task_id":format!("task-{id}"),"status":"completed"}});
    let tasks = |id: Option<&str>| json!({"emit":{"type":"system","subtype":"background_tasks_changed","tasks":id.map(|id|vec![json!({"task_id":id,"task_type":"local_bash","description":"Retention command"})]).unwrap_or_default()}});
    let mut scripts = Vec::new();
    for (launch, turns) in [vec![1, 2, 3, 4], vec![5]].into_iter().enumerate() {
        let query = &trace["queries"][launch];
        let mut steps = node_trace::launch_steps(query)?;
        // Normal reply style throughout. Both recorded launches initialize summarized thinking.
        steps.extend(node_trace::control_steps(
            &[query["controls"][0].clone()],
            |_| vec![],
        )?);
        for turn in turns {
            steps.extend([
                json!({"expect":{"type":"user","fields":{"/message/content/0/text":format!("retention {turn}")}}}),
                json!({"emit":{"type":"system","subtype":"init","session_id":"fixture-session"}}),
            ]);
            match turn {
                1 => steps.extend([
                    child("retained-child", true),
                    tasks(Some("retained-command")),
                ]),
                2 => steps.push(complete("retained-child")),
                3 => steps.extend([tasks(None), child("foreground-child", false)]),
                4 => steps.push(complete("foreground-child")),
                5 => steps.extend([child("closing-child", true), tasks(Some("closing-command"))]),
                _ => unreachable!(),
            }
            steps.extend([
                json!({"emit":{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Claude fixture hello"}}}}),
                json!({"emit":{"type":"result","subtype":"success","num_turns":1,"result":"done"}}),
            ]);
        }
        steps.push(json!({"wait_eof":true}));
        scripts.push(Value::Array(steps));
    }
    Ok(scripts)
}
fn images_script(release: &Path) -> Result<Value, Box<dyn std::error::Error>> {
    let oracle: Value = serde_json::from_str(include_str!(
        "../../rust-claude/tests/fixtures/conformance/claude-prompt-images.json"
    ))?;
    let cases = oracle["cases"].as_array().ok_or("image cases")?;
    let mut steps = vec![
        json!({"expect":{"subtype":"initialize"}}),
        json!({"reply":{}}),
        json!({"expect":{"subtype":"set_max_thinking_tokens"}}),
        json!({"reply":{}}),
    ];
    for (index, name) in ["inline-order", "queued-image"].into_iter().enumerate() {
        let case = cases
            .iter()
            .find(|case| case["name"] == name)
            .ok_or("image case")?;
        steps.push(json!({"expect":{"type":"user","fields":{"/message/content":case["content"]}}}));
        steps.push(
            json!({"emit":{"type":"system","subtype":"init","session_id":"fixture-session"}}),
        );
        if index == 0 {
            steps.push(json!({"wait_file":release}));
        }
        steps.push(json!({"emit":{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Claude fixture hello"}}}}));
        steps.push(
            json!({"emit":{"type":"result","subtype":"success","num_turns":1,"result":"done"}}),
        );
    }
    steps.push(json!({"wait_eof":true}));
    Ok(Value::Array(steps))
}
fn script_for(scenario: Scenario, queue_release: &Path) -> Value {
    let mut steps = vec![json!({"expect":{"subtype":"initialize"}})];
    if matches!(scenario, Scenario::HangInitialize) {
        steps.push(json!({"sleep_ms":10000}));
        return json!(steps);
    }
    steps.extend([
        json!({"reply":{}}),
        json!({"expect":{"subtype":"set_max_thinking_tokens"}}),
        json!({"reply":{}}),
    ]);
    for turn in 0..4 {
        steps.extend([
            json!({"expect":{"type":"user"}}),
            json!({"emit":{"type":"system","subtype":"init","session_id":"fixture-session"}}),
        ]);
        match scenario {
   Scenario::ModeStalled | Scenario::ModeRejected => {
    steps.push(json!({"expect":{"subtype":"set_permission_mode","fields":{"/request/mode":"bypassPermissions"}}}));
    steps.push(json!({"emit":{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"mode entered"}}}}));
    if matches!(scenario, Scenario::ModeRejected) { steps.push(json!({"reply_error":"mode refused by native fixture"})); }
    steps.push(json!({"wait_eof":true}));
    break;
   },
   Scenario::Permission=>steps.extend([json!({"request":{"id":"p1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"echo fixture"}}}}),json!({"expect":{"type":"control_response","fields":{"/response/request_id":"p1"}}})]),
   Scenario::Question|Scenario::QuestionDelayedReceipt|Scenario::Unicode=>steps.extend([json!({"request":{"id":"q1","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","input":{"questions":[{"question":"Which?","header":"Pick","options":[{"label":"A","description":"First"},{"label":"B","description":"Second"}]}]}}}}),json!({"expect":{"type":"control_response","fields":{"/response/request_id":"q1"}}})]),
   Scenario::AnswerSaturation => {
    let mut expected = Vec::new();
    for id in 0..8 {
     let id = format!("q{id}");
     steps.push(json!({"request":{"id":id,"request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","input":{"questions":[{"question":"Which?","header":"Pick","options":[{"label":"A","description":"First"},{"label":"B","description":"Second"}]}]}}}}));
     expected.push(json!({"/type":"control_response","/response/request_id":id}));
    }
    expected.push(json!({"/type":"control_request","/request/subtype":"interrupt"}));
    steps.push(json!({"expect_pair":expected}));
    steps.push(json!({"emit":{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Eight answers and Stop received"}}}}));
    steps.push(json!({"wait_eof":true}));
    break;
   },
   Scenario::Design => { steps.extend(design_steps()); },
   Scenario::Queue => { if turn==0 {steps.push(json!({"wait_file":queue_release}));} },
   Scenario::Content | Scenario::ContentAllow | Scenario::ContentDeny => {
    if matches!(scenario, Scenario::ContentAllow | Scenario::ContentDeny) {
     let behavior=if matches!(scenario, Scenario::ContentDeny){"deny"}else{"allow"};
     steps.push(json!({"request":{"id":"content-permission","request":{"subtype":"can_use_tool","tool_name":"mcp__milagre__artifact_show","input":{"title":"Native Claude artifact","html":"<main>Native shared content</main>"}}}}));
     steps.push(json!({"expect":{"type":"control_response","fields":{"/response/request_id":"content-permission","/response/response/behavior":behavior}}}));
    }
    if !matches!(scenario, Scenario::ContentDeny) {steps.extend([
     json!({"request":{"id":"content-show","request":{"subtype":"mcp_message","server_name":"milagre","message":{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"artifact_show","arguments":{"title":"Native Claude artifact","html":"<main>Native shared content</main>"}}}}}}),
     json!({"expect":{"type":"control_response","fields":{"/response/response/mcp_response/id":1,"/response/response/mcp_response/result/isError":false}}})
    ]);}
   },
   Scenario::Subagent => {
    steps.extend([
      json!({"emit":{"type":"assistant","message":{"content":[{"type":"tool_use","id":"child","name":"Agent","input":{"description":"Review","run_in_background":true}}]}}}),
      json!({"emit":{"type":"user","parent_tool_use_id":"child","message":{"content":[{"type":"tool_result","tool_use_id":"read-1","content":"retained child result"}]}}}),
      json!({"expect":{"subtype":"interrupt"}}),json!({"reply":{}})
    ]);continue;
   },
   Scenario::Stop=>{steps.extend([json!({"expect":{"subtype":"interrupt"}}),json!({"reply":{}})]);continue;},
   Scenario::Crash=>{steps.push(json!({"exit":7}));break;},_=>{}
  }
        steps.extend([json!({"emit":{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Claude fixture hello"}}}}),json!({"emit":{"type":"result","subtype":"success","num_turns":1,"result":"done"}})]);
    }
    if matches!(scenario, Scenario::Queue) {
        let mut turn = 0;
        for step in &mut steps {
            if step["expect"]["type"] == "user" {
                step["expect"]["fields"] = json!({"/message/content/0/text": if turn==0 {"fixture input"} else {"second queued input"}});
                turn += 1;
            }
        }
    }
    if matches!(scenario, Scenario::Unicode) {
        let native = "native \u{10fffe} \u{e123} \u{fffd}";
        for step in &mut steps {
            if step["expect"]["type"] == "user" {
                step["expect"]["fields"] = json!({"/message/content/0/text": native});
            }
            if step["expect"]["type"] == "control_response" {
                step["expect"]["fields"]["/response/response/updatedInput/answers/Which?"] =
                    json!(native);
            }
            if step["emit"]["type"] == "stream_event" {
                step["emit"]["event"]["delta"]["text"] = json!(native);
            }
        }
    }
    json!(steps)
}

fn design_steps() -> Vec<Value> {
    let show = json!({"id":"native-screen","title":"Native Design","document":{"schemaVersion":1,"width":240,"height":240,"nodes":[{"id":"paint","type":"frame","width":240,"height":240,"fill":"#ff0000"}]}});
    let apply = json!({"id":"native-screen","expectedVersion":1,"operations":[{"op":"update","id":"paint","patch":{"fill":"#0000ff"}}]});
    let mut steps = Vec::new();
    for (number, name, args) in [(1, "design_show", show), (2, "design_apply", apply)] {
        let tool = format!("mcp__milagre__{name}");
        let id = format!("design-tool-{number}");
        steps.push(json!({"emit":{"type":"assistant","message":{"content":[{"type":"tool_use","id":id,"name":tool,"input":args}]}}}));
        steps.push(json!({"request":{"id":id,"request":{"subtype":"mcp_message","server_name":"milagre","message":{"jsonrpc":"2.0","id":number,"method":"tools/call","params":{"name":name,"arguments":args}}}}}));
        steps.push(json!({"expect":{"type":"control_response","fields":{"/response/response/mcp_response/id":number,"/response/response/mcp_response/result/isError":false,"/response/response/mcp_response/result/content/1/type":"image","/response/response/mcp_response/result/content/1/mimeType":"image/png"}}}));
        // Native CLI fixture reports a normal tool completion after consuming its real MCP response.
        // PNG itself remains model feedback; no fabricated transcript-image event is emitted.
        let text=json!({"id":"native-screen","title":"Native Design","version":number,"format":"design"}).to_string();
        steps.push(json!({"emit":{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":id,"content":[{"type":"text","text":text}]}]}}}));
    }
    steps
}

#[cfg(test)]
mod content_close_tests {
    use super::*;
    use milagre_content_store::{Runtime, SystemRuntime};
    struct PausedClock {
        once: AtomicBool,
        entered: std::sync::mpsc::SyncSender<()>,
        release: Mutex<std::sync::mpsc::Receiver<()>>,
    }
    impl Runtime for PausedClock {
        fn now_ms(&self) -> u64 {
            if self.once.swap(false, Ordering::AcqRel) {
                self.entered.send(()).unwrap();
                let _ = self.release.lock().unwrap().recv();
            }
            SystemRuntime.now_ms()
        }
        fn uuid(&self) -> String {
            SystemRuntime.uuid()
        }
    }
    #[test]
    fn closing_slot_revokes_paused_write_and_replacement_uses_the_same_writer_once() {
        let mut provider = ClaudeFixture::create(Scenario::Content).unwrap();
        // Replace only the trusted clock inside this private fixture, after releasing its first writer.
        provider.content.take().unwrap().shutdown();
        let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(1);
        let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
        let content = crate::claude_content::SharedContent::with_runtime(
            provider.isolation(),
            provider.project().to_path_buf(),
            None,
            Arc::new(PausedClock {
                once: AtomicBool::new(true),
                entered: entered_tx,
                release: Mutex::new(release_rx),
            }),
        )
        .unwrap();
        content.opened(true);
        provider.content = Some(content.clone());
        let chat = format!("{}#1", provider.project().display());
        let request = RawJson(
            json!({"provider":"claude","chatId":chat,"cwd":provider.project(),"prompt":"fixture input","permissionMode":"ask","model":"sonnet"}),
        );
        provider.start_turn(TurnId(1), &request).unwrap();
        entered_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        let closing = provider.slots.get(&chat).unwrap().content_scope.clone();
        provider.close_chat(&chat, TurnId(1)).unwrap();
        assert!(
            closing.check().is_err(),
            "close revokes before the paused commit is released"
        );
        provider.start_turn(TurnId(2), &request).unwrap();
        assert!(!Arc::ptr_eq(
            &closing,
            &provider.slots.get(&chat).unwrap().content_scope
        ));
        release_tx.send(()).unwrap();
        let until = std::time::Instant::now() + Duration::from_secs(5);
        let mut events = Vec::new();
        loop {
            events.extend(provider.take_events());
            if events.iter().any(|e|matches!(e,ProviderEvent::Agent{turn:TurnId(2),event:RawJson(v),..}if v["type"]=="turn-completed")){break;}
            assert!(std::time::Instant::now() < until, "{events:?}");
            std::thread::sleep(Duration::from_millis(2));
        }
        let artifacts = content
            .renderer("artifact:list", &json!({"chatId":chat}))
            .unwrap();
        assert_eq!(artifacts.as_array().unwrap().len(), 1);
        assert_eq!(
            artifacts[0]["version"], 1,
            "the revoked write is not replayed into the replacement"
        );
        let page = content
            .renderer(
                "artifact:get",
                &json!({"chatId":chat,"id":artifacts[0]["id"]}),
            )
            .unwrap();
        assert!(page.to_string().contains("Native shared content"));
        assert!(closing.check().is_err());
        provider.shutdown();
        assert!(provider.monitor().wait_stopped(Duration::from_secs(3)));
        content.shutdown();
    }
}

#[cfg(test)]
mod mode_receipt_tests {
    use super::*;

    /// A replacement worker's cleanup must never refund an older worker's uncertain operation,
    /// even when their chat identity is identical. Completed and unentered operations settle once.
    #[test]
    fn captured_worker_cleanup_settles_only_its_uncertain_mode_ids() {
        let mut fixture = ClaudeFixture::create(Scenario::Reply).unwrap();
        let older = Arc::new(AtomicBool::new(false));
        let replacement = Arc::new(AtomicBool::new(false));
        let admit = |id, worker: &Arc<AtomicBool>, entered| {
            fixture.shared.pending_modes.lock().unwrap().insert(
                ("fixture".into(), ModeChangeId(id)),
                RetainedMode {
                    worker: worker.clone(),
                    uncertain: false,
                },
            );
            ModeGuard {
                shared: fixture.shared.clone(),
                chat: "fixture".into(),
                id: Some(ModeChangeId(id)),
                entered,
            }
        };
        drop(admit(1, &older, true));
        drop(admit(2, &replacement, true));
        drop(admit(3, &older, false));
        admit(4, &older, true).settle(ModeOutcome::Applied);
        assert_eq!(fixture.take_events().len(), 4);
        assert_eq!(
            fixture.shared.pending_modes.lock().unwrap().len(),
            2,
            "uncertainty retains admission"
        );

        fixture.shared.settle_closed_modes(&replacement);
        let events = fixture.take_events();
        assert!(matches!(
            events.as_slice(),
            [ProviderEvent::ModeSettled {
                change: ModeChangeId(2),
                outcome: ModeOutcome::Failed(_),
                ..
            }]
        ));
        assert!(fixture
            .shared
            .pending_modes
            .lock()
            .unwrap()
            .contains_key(&("fixture".into(), ModeChangeId(1))));
        older.store(true, Ordering::Release);
        assert!(fixture.take_events().is_empty());
        assert_eq!(
            fixture.shared.pending_modes.lock().unwrap().len(),
            1,
            "a done flag cannot silently refund an uncertain receipt"
        );

        fixture.shared.settle_closed_modes(&older);
        let events = fixture.take_events();
        assert!(matches!(
            events.as_slice(),
            [ProviderEvent::ModeSettled {
                change: ModeChangeId(1),
                outcome: ModeOutcome::Failed(_),
                ..
            }]
        ));
        assert!(fixture.shared.pending_modes.lock().unwrap().is_empty());
        fixture.shared.settle_closed_modes(&older);
        fixture.shared.settle_closed_modes(&replacement);
        assert!(
            fixture.take_events().is_empty(),
            "cleanup cannot duplicate a definitive receipt"
        );
    }
}

#[cfg(test)]
mod retention_tests {
    use super::*;
    fn request(provider: &ClaudeFixture, chat: &str, turn: u64) -> RawJson {
        RawJson(
            json!({"provider":"claude","chatId":chat,"cwd":provider.project(),"prompt":format!("retention {turn}"),
            "model":"sonnet","permissionMode":"ask","effort":"high","replies":"normal","tldrEnabled":turn==1}),
        )
    }
    fn complete(provider: &mut ClaudeFixture, turn: u64) {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let events = provider.take_events();
            assert!(
                !events
                    .iter()
                    .any(|event| matches!(event, ProviderEvent::StartFailed { .. })),
                "{events:?}"
            );
            if events.iter().any(|event|matches!(event,ProviderEvent::Agent{turn:actual,event:RawJson(v),..} if actual.0==turn && v["type"]=="turn-completed")){return;}
            assert!(
                std::time::Instant::now() < deadline,
                "turn {turn}: {events:?}"
            );
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    #[test]
    fn busy_session_reuses_its_worker_at_capacity() {
        let mut provider = ClaudeFixture::create(Scenario::BackgroundRetention).unwrap();
        // Every private Chat runs the same checked-in first-launch script in this capacity test.
        let LaunchSource::Fixture { scripts, .. } = &mut provider.launch else {
            unreachable!()
        };
        scripts.truncate(1);
        for index in 0..CHATS {
            let chat = format!("retention-{index}");
            let request = request(&provider, &chat, 1);
            provider
                .start_turn(TurnId(index as u64 + 1), &request)
                .unwrap();
            complete(&mut provider, index as u64 + 1);
        }
        assert_eq!(provider.monitor().workers(), CHATS);
        let pid = provider.monitor().pid("retention-0");
        let request = request(&provider, "retention-0", 2);
        provider.start_turn(TurnId(100), &request).unwrap();
        complete(&mut provider, 100);
        assert_eq!(provider.monitor().pid("retention-0"), pid);
        provider.shutdown();
        assert!(provider.monitor().wait_stopped(Duration::from_secs(3)));
    }
    #[test]
    fn unavailable_captured_session_refuses_replacement_without_closing() {
        let mut provider = ClaudeFixture::create(Scenario::BackgroundRetention).unwrap();
        provider
            .start_turn(TurnId(1), &request(&provider, "fixture", 1))
            .unwrap();
        complete(&mut provider, 1);
        let pid = provider.monitor().pid("fixture");
        let captured = provider.slots["fixture"].session.lock().unwrap().take();
        assert!(provider
            .start_turn(TurnId(2), &request(&provider, "fixture", 2))
            .is_err());
        assert_eq!(provider.monitor().pid("fixture"), pid);
        assert_eq!(provider.monitor().workers(), 1);
        *provider.slots["fixture"].session.lock().unwrap() = captured;
        provider
            .start_turn(TurnId(2), &request(&provider, "fixture", 2))
            .unwrap();
        complete(&mut provider, 2);
        assert_eq!(provider.monitor().pid("fixture"), pid);
        provider.shutdown();
        assert!(provider.monitor().wait_stopped(Duration::from_secs(3)));
    }
}

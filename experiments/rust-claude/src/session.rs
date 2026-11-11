//! One Chat's Claude provider session, ported from `ClaudeSession` in
//! `packages/core/src/agents/claude-provider.cjs`, with `PendingPermissions` (permissions.cjs) and
//! `PendingQuestions` (questions.cjs). It drives a [`ClaudeClient`] (the CLI directly, no SDK) and emits
//! Milagre `AgentEvent` JSON in the order the Node session does.
//!
//! Turns: `start_turn` starts the CLI on first use (spawn, `initialize`, MCP toggles, summarized
//! thinking), applies model / mode / effort / fast mode / reply style changes, then sends the message;
//! a message sent while a turn runs is steered into it. A `system/init` while idle is a turn the CLI
//! started by itself (an implicit turn, `continues` the last one). Exactly one terminal event ends
//! each turn. Interrupt asks the CLI and closes it after `interrupt_grace`. A process that ends fails
//! the turn with Milagre's crash, resume or login message; the session is then closed, as in Node.
//!
//! Ownership: the session owns the process. Dropping the session (or a `start_turn` future still
//! starting the CLI) stops it; every task the session starts holds only a weak reference.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use serde_json::{json, Map, Value};
use tokio::sync::{oneshot, watch, Mutex as AsyncMutex, Notify};

use crate::client::{ClaudeClient, ClaudeEvent, ClientError, EventStream, ExitInfo, ExitReason, Limits};
use crate::events::{crash_message, failed_with, is_terminal, missing_cli_message, ClaudeMapper, Clock, RESUME_FAILED_MESSAGE};
use crate::handlers::{BoxFuture, CancelSignal, Handlers, HookHandler, McpHandler, PermissionHandler, QuestionHandler};
use crate::launch::{HookMatcher, InitializeOptions, LaunchOptions};
use crate::milagre::{self, Decision, QuestionOutcome};
use crate::protocol::{HookCallback, PermissionRequest, PermissionResult};
use crate::text::Obj;

pub const PRE_TOOL_USE_HOOK: &str = "milagre_pre_tool_use";
pub const SUBAGENT_START_HOOK: &str = "milagre_subagent_start";
const CONCISE_STYLE: &str = "Concise";
/// Concurrent access-policy evaluations a session runs on the blocking pool. Each holds a permit
/// until its blocking work actually finishes (queued or running); `close` waits for all of them.
pub const ACCESS_WORKERS: u32 = 8;
/// An access check that failed (panic, lost task, closed session) refuses in every mode.
pub const ACCESS_FAILED_MESSAGE: &str = "Milagre could not check this request's access, so it was refused.";
/// The mode kept changing while every re-evaluation ran.
pub const ACCESS_UNSETTLED_MESSAGE: &str = "The permission mode changed while Milagre checked this request, so it was refused.";
const ACCESS_ATTEMPTS: usize = 3;

/// Admission of access-policy callbacks, serialized against close and drop. A callback is admitted
/// at its actual entry (after the permit wait and any blocking-pool queueing), under this lock and
/// only while the session lives, is open, its turn is the one it was asked in and it was not
/// withdrawn. Once `shut`, nothing more is admitted; `close` waits only for admitted callbacks.
/// Lock order: this gate, then the session state.
#[derive(Default)]
struct AccessGate {
    state: Mutex<GateState>,
    drained: Notify,
}

#[derive(Default)]
struct GateState {
    closed: bool,
    entered: usize,
}

/// One admitted callback; leaving (also by panic) may wake `close`.
struct EnteredAccess(Arc<AccessGate>);

impl Drop for EnteredAccess {
    fn drop(&mut self) {
        let mut gate = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        gate.entered -= 1;
        if gate.entered == 0 {
            self.0.drained.notify_waiters();
        }
    }
}

impl AccessGate {
    fn shut(&self) {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).closed = true;
    }

    fn enter(self: &Arc<Self>, valid: impl FnOnce() -> bool) -> Option<EnteredAccess> {
        let mut gate = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if gate.closed || !valid() {
            return None;
        }
        gate.entered += 1;
        Some(EnteredAccess(self.clone()))
    }

    fn entered(&self) -> usize {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).entered
    }

    async fn drained(&self) {
        loop {
            let notified = self.drained.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.entered() == 0 {
                return;
            }
            notified.await;
        }
    }
}

/// Whether a request bound to `turn_epoch` no longer has a turn to answer in.
fn stale_turn(state: &State, turn_epoch: u64, cancel: &CancelSignal) -> bool {
    state.turn_epoch != turn_epoch || !state.turn_active || state.cancel_requested || state.closed || cancel.reason().is_some()
}
const EXECUTION_QUESTION_DENIAL: &str = "Report questions or blockers to the parent Chat; execution agents cannot ask the human.";

/// A PreToolUse guard (babysit level, wake escalation): a reason denies the call, in every mode.
pub trait PreToolUseGuard: Send + Sync + 'static {
    fn deny_reason(&self, input: &Value) -> Option<String>;
}

/// `WorkspaceAccess.answer`: a request decided before anyone is asked.
pub enum AccessDecision {
    Allow { learn: Vec<String> },
    Deny { message: String },
}

pub trait AccessPolicy: Send + Sync + 'static {
    /// `kind` is "read", "edit", "command" or "other"; `mode` the Chat's Milagre mode.
    fn answer(&self, kind: &str, files: &[String], mode: &str) -> Option<AccessDecision>;
}

pub struct SessionOptions {
    /// Program, cwd, environment, setting sources, system prompt, MCP servers, tools. The session sets
    /// model, permission mode, effort, settings, resume and the flags every Chat uses.
    pub launch: LaunchOptions,
    pub limits: Limits,
    /// Agents, skills and the like. The session adds hooks, prompt suggestions, subagent text and
    /// SDK MCP server names.
    pub init: InitializeOptions,
    pub resume_id: Option<String>,
    /// Unsupported until the full advisor tool/settings/MCP policy is available. Start fails before spawn.
    pub analysis_only: bool,
    pub execution_advisor: bool,
    pub prompt_suggestions: bool,
    pub interrupt_grace: Duration,
    /// MCP servers switched off once the CLI has started (Settings › MCP).
    pub mcp_off: Vec<String>,
    pub pre_tool_use: Option<Arc<dyn PreToolUseGuard>>,
    /// `SubagentStart` additional context (subagent plan/design instructions).
    pub subagent_context: Option<String>,
    pub access: Option<Arc<dyn AccessPolicy>>,
    pub mcp: Option<Arc<dyn McpHandler>>,
    pub clock: Option<Clock>,
    /// Owner-selected image persistence. None disables image writes, but keeps Read tool rows.
    pub image_store: Option<Arc<dyn crate::images::ToolImageStore>>,
    /// Total queued events, including one reserved failure slot (minimum 2).
    pub event_capacity: usize,
    /// Conservative JSON heap estimate, including 1024 bytes reserved for failure (minimum 2048).
    pub event_bytes: usize,
    pub max_subagents: usize,
    pub subagent_snapshot_bytes: usize,
}

impl SessionOptions {
    pub fn new(launch: LaunchOptions) -> Self {
        Self {
            launch,
            limits: Limits { close_grace: Duration::from_secs(1), kill_grace: Duration::from_secs(2), ..Limits::default() },
            init: InitializeOptions::default(),
            resume_id: None,
            analysis_only: false,
            execution_advisor: false,
            prompt_suggestions: true,
            interrupt_grace: Duration::from_secs(3),
            mcp_off: Vec::new(),
            pre_tool_use: None,
            subagent_context: None,
            access: None,
            mcp: None,
            clock: None,
            image_store: None,
            event_capacity: 1024,
            event_bytes: 8 * 1024 * 1024,
            max_subagents: 128,
            subagent_snapshot_bytes: 256 * 1024,
        }
    }
}

/// A user message for a turn.
#[derive(Clone, Default)]
pub struct TurnRequest {
    /// Message content blocks (`milagre::user_content`).
    pub content: Vec<Value>,
    pub model: String,
    /// Milagre mode: "ask", "auto" or "full".
    pub permission_mode: Option<String>,
    pub effort: Option<String>,
    pub ultracode: bool,
    pub fast_mode: bool,
    /// "concise" applies Claude Code's Concise output style.
    pub replies: Option<String>,
    /// Recheck delivery eligibility after initialization, before emitting or sending the turn.
    pub can_start: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnStart {
    pub turn_id: Option<String>,
    pub steered: bool,
    pub cancelled: bool,
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum SessionError {
    #[error("Analysis-only Claude sessions require an advisor policy that is not implemented.")]
    UnsupportedAnalysis,
    #[error("This Claude session is closed.")]
    Closed,
    #[error("The agent session closed before this message was sent.")]
    ClosedBeforeSend,
    #[error("{0}")]
    Send(ClientError),
}

/// Opens once; waiters before or after see it open.
#[derive(Clone)]
struct Gate(Arc<watch::Sender<bool>>);

impl Gate {
    fn new() -> Self {
        Gate(Arc::new(watch::channel(false).0))
    }
    fn open_now() -> Self {
        let gate = Self::new();
        gate.open();
        gate
    }
    fn open(&self) {
        self.0.send_replace(true);
    }
    async fn wait(&self) {
        let mut rx = self.0.subscribe();
        let _ = rx.wait_for(|open| *open).await;
    }
}

/// All producers share one budget. Overflow seals the queue with a reserved terminal error;
/// a process watcher kills the CLI without needing the consumer to drain or the state lock.
struct QueueState {
    events: VecDeque<(Value, usize)>,
    bytes: usize,
    closed: bool,
}
struct EventQueue {
    state: Mutex<QueueState>,
    added: Notify,
    capacity: usize,
    bytes: usize,
    // 0 = open, 1 = overflow, 2 = receiver dropped, 3 = ordinary closure.
    status: watch::Sender<u8>,
}
impl EventQueue {
    fn push(&self, event: Value) {
        let bytes = crate::budget::weight(&event);
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return;
        }
        if state.events.len() >= self.capacity - 1 || bytes > (self.bytes - 1024).saturating_sub(state.bytes) {
            drop(state);
            self.fail(crate::budget::BudgetFailure::Queue);
            return;
        }
        state.bytes += bytes;
        state.events.push_back((event, bytes));
        drop(state);
        self.added.notify_one();
    }
    fn fail(&self, failure: crate::budget::BudgetFailure) {
        let event = failure.event();
        let bytes = crate::budget::weight(&event);
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return;
        }
        // Only internal, fixed-size failure messages enter the reserved slot.
        state.bytes += bytes;
        state.events.push_back((event, bytes));
        state.closed = true;
        self.status.send_replace(1);
        drop(state);
        self.added.notify_waiters();
        self.added.notify_one();
    }
    fn close(&self) {
        self.state.lock().unwrap().closed = true;
        self.status.send_if_modified(|s| {
            if *s == 0 {
                *s = 3;
                true
            } else {
                false
            }
        });
        self.added.notify_waiters();
        self.added.notify_one();
    }
    fn receiver_dropped(&self) {
        let mut state = self.state.lock().unwrap();
        state.events.clear();
        state.bytes = 0;
        state.closed = true;
        self.status.send_replace(2);
        drop(state);
        self.added.notify_waiters();
        self.added.notify_one();
    }
    fn closed(&self) -> bool {
        self.state.lock().unwrap().closed
    }
    fn pop(&self) -> Option<Value> {
        let mut state = self.state.lock().unwrap();
        let (event, bytes) = state.events.pop_front()?;
        state.bytes -= bytes;
        Some(event)
    }
    async fn recv(&self) -> Option<Value> {
        loop {
            let notified = self.added.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let mut state = self.state.lock().unwrap();
                if let Some((event, bytes)) = state.events.pop_front() {
                    state.bytes -= bytes;
                    return Some(event);
                }
                if state.closed {
                    return None;
                }
            }
            notified.await;
        }
    }
}
/// The session's ordered events. Dropping the sole receiver stops its CLI and rejects future starts.
pub struct SessionEvents(Arc<EventQueue>);
impl SessionEvents {
    pub async fn recv(&mut self) -> Option<Value> {
        self.0.recv().await
    }
    pub fn try_recv(&mut self) -> Option<Value> {
        self.0.pop()
    }
}
impl Drop for SessionEvents {
    fn drop(&mut self) {
        self.0.receiver_dropped();
    }
}

struct PendingPermission {
    id: String,
    token: String,
    tx: Option<oneshot::Sender<String>>,
    allow_for_chat: bool,
    /// Recheck at resolution: an ancestor may become a symlink while the card is pending.
    auto_files: Vec<String>,
}

struct PendingQuestion {
    id: String,
    token: String,
    tx: Option<oneshot::Sender<(QuestionOutcome, Map<String, Value>)>>,
    card: Value,
}

struct State {
    mapper: ClaudeMapper,
    client: Option<ClaudeClient>,
    generation: u64,
    model: Option<String>,
    mode: Option<String>,
    effort: Option<String>,
    ultracode: bool,
    fast_mode: bool,
    output_style: Option<String>,
    style_failed: bool,
    turn_active: bool,
    cancel_requested: bool,
    closed: bool,
    implicit_turn: bool,
    steered_turn: bool,
    announced_id: bool,
    last_turn_id: Option<String>,
    permission_mode: String,
    /// Bumped on every permission-mode assignment (so Ask -> Full -> Ask is a change).
    mode_epoch: u64,
    /// Bumped whenever a turn starts or ends: a decision begun in one turn never serves another.
    turn_epoch: u64,
    permissions: Vec<PendingPermission>,
    questions: Vec<PendingQuestion>,
    turn_ready: Gate,
    delivery_ready: Gate,
    turn_ended: Gate,
    interrupt_timer: Option<tokio::task::JoinHandle<()>>,
    exit: Option<ExitInfo>,
    cleanup: Option<watch::Receiver<Option<ExitInfo>>>,
    mcp_off: Vec<String>,
    background: Vec<tokio::task::JoinHandle<()>>,
}

struct Inner {
    options: SessionOptions,
    state: Mutex<State>,
    queue: Arc<EventQueue>,
    operations: AsyncMutex<()>,
    /// Permits for access-policy work on the blocking pool (`ACCESS_WORKERS`).
    access_slots: Arc<tokio::sync::Semaphore>,
    access_gate: Arc<AccessGate>,
}

impl Drop for Inner {
    fn drop(&mut self) {
        // No queued access check may enter its policy for a dropped session.
        self.access_gate.shut();
        self.access_slots.close();
        self.queue.close();
        if let Ok(state) = self.state.get_mut() {
            if let Some(timer) = state.interrupt_timer.take() {
                timer.abort();
            }
            for task in state.background.drain(..) {
                task.abort();
            }
        }
        // The client goes with the state: its last handle SIGKILLs the process group.
    }
}

pub struct ClaudeSession {
    inner: Arc<Inner>,
}

impl Drop for ClaudeSession {
    fn drop(&mut self) {
        self.inner.stop();
    }
}

impl std::fmt::Debug for ClaudeSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClaudeSession").field("native_id", &self.native_id()).finish_non_exhaustive()
    }
}

fn uuid() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let random = || {
        let mut hasher = RandomState::new().build_hasher();
        hasher.write_u64(COUNTER.fetch_add(1, Ordering::SeqCst));
        hasher.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        hasher.finish()
    };
    let (a, b) = (random(), random());
    let a = (a & 0xffff_ffff_ffff_0fff) | 0x4000;
    let b = (b & 0x3fff_ffff_ffff_ffff) | 0x8000_0000_0000_0000;
    format!("{:08x}-{:04x}-{:04x}-{:04x}-{:012x}", a >> 32, (a >> 16) & 0xffff, a & 0xffff, b >> 48, b & 0xffff_ffff_ffff)
}

/// The error a process end becomes, as the TS SDK words it, or `None` for a clean exit.
fn exit_error(info: &ExitInfo) -> Option<String> {
    match &info.reason {
        ExitReason::ProtocolViolation(detail) => Some(format!("Claude Code sent output Milagre could not read: {detail}")),
        ExitReason::ReadError(detail) => Some(format!("Claude Code's output could not be read: {detail}")),
        ExitReason::WriteError(detail) => Some(format!("Claude Code could not read its input: {detail}")),
        ExitReason::InputStalled => Some("Claude Code stopped reading its input".into()),
        ExitReason::ReplyLost => Some("Claude Code could not be sent an answer".into()),
        ExitReason::StdoutClosed => Some("Claude Code closed its output".into()),
        ExitReason::Exited | ExitReason::Closed => match (info.code, info.signal) {
            (Some(0), _) => None,
            (Some(code), _) => Some(format!("Claude Code process exited with code {code}")),
            (None, Some(signal)) => Some(format!("Claude Code process terminated by signal {}", signal_name(signal))),
            (None, None) => None,
        },
    }
}

fn signal_name(signal: i32) -> String {
    match signal {
        1 => "SIGHUP".into(),
        2 => "SIGINT".into(),
        6 => "SIGABRT".into(),
        9 => "SIGKILL".into(),
        11 => "SIGSEGV".into(),
        13 => "SIGPIPE".into(),
        15 => "SIGTERM".into(),
        other => format!("signal {other}"),
    }
}

fn missing_conversation(text: &str) -> bool {
    text.to_lowercase().contains("no conversation found")
}

fn kind_of(card: &Value) -> String {
    card["kind"].as_str().unwrap_or("other").to_owned()
}

fn files_of(card: &Value) -> Vec<String> {
    card.get("files")
        .and_then(Value::as_array)
        .map(|files| files.iter().filter_map(Value::as_str).map(str::to_owned).collect())
        .unwrap_or_default()
}

/// Auto authorization uses the same canonical ancestor check as rust-providers 40425d7a.
/// Missing/relative cwd, malformed paths, parent components and resolution errors fail closed.
fn inside_root(root: Option<&std::path::Path>, files: &[String]) -> bool {
    use std::path::{Component, Path, PathBuf};
    fn resolve(path: &Path) -> std::io::Result<PathBuf> {
        match std::fs::canonicalize(path) {
            Ok(real) => Ok(real),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if std::fs::symlink_metadata(path).is_ok() {
                    return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "unresolvable link"));
                }
                let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else { return Err(error) };
                Ok(resolve(parent)?.join(name))
            }
            Err(error) => Err(error),
        }
    }
    let Some(root) = root.filter(|root| root.is_absolute()) else { return false };
    #[cfg(windows)]
    if root.components().any(|c| c == Component::ParentDir) {
        return false;
    }
    // Canonicalize the supplied cwd before any folding, including symlink/.. pairs.
    let Ok(root) = std::fs::canonicalize(root) else { return false };
    !files.is_empty()
        && files.iter().all(|file| {
            let file = Path::new(file);
            !file.as_os_str().is_empty()
                && !file.components().any(|c| c == Component::ParentDir)
                && resolve(&root.join(file)).is_ok_and(|path| path != root && path.starts_with(&root))
        })
}

/// Read-only view of a session's access-policy work (diagnostics and tests).
#[derive(Clone)]
pub struct AccessMonitor {
    slots: Arc<tokio::sync::Semaphore>,
    gate: Arc<AccessGate>,
}

impl AccessMonitor {
    /// Permits held by spawned checks: waiting in the blocking pool, deciding admission or running.
    /// Nothing else holds these permits.
    pub fn held(&self) -> usize {
        ACCESS_WORKERS as usize - self.slots.available_permits()
    }

    /// Policy callbacks admitted and still inside `AccessPolicy::answer`.
    pub fn entered(&self) -> usize {
        self.gate.entered()
    }
}

impl ClaudeSession {
    pub fn new(options: SessionOptions) -> (Self, SessionEvents) {
        let queue = Arc::new(EventQueue {
            state: Mutex::new(QueueState { events: VecDeque::new(), bytes: 0, closed: false }),
            added: Notify::new(),
            capacity: options.event_capacity.max(2),
            bytes: options.event_bytes.max(2048),
            status: watch::channel(0).0,
        });
        let mapper = {
            let mut mapper = ClaudeMapper::new(options.clock.clone());
            mapper.session_id = options.resume_id.clone();
            mapper.set_event_limits(
                crate::EventBudget { count: queue.capacity - 1, bytes: queue.bytes - 1024 },
                options.max_subagents,
                options.subagent_snapshot_bytes,
            );
            if let Some(store) = &options.image_store {
                mapper.set_image_store(store.clone());
            }
            mapper
        };
        let state = State {
            mapper,
            client: None,
            generation: 0,
            model: None,
            mode: None,
            effort: None,
            ultracode: false,
            fast_mode: false,
            output_style: None,
            style_failed: false,
            turn_active: false,
            cancel_requested: false,
            closed: false,
            implicit_turn: false,
            steered_turn: false,
            announced_id: false,
            last_turn_id: None,
            permission_mode: "ask".into(),
            mode_epoch: 0,
            turn_epoch: 0,
            permissions: Vec::new(),
            questions: Vec::new(),
            turn_ready: Gate::open_now(),
            delivery_ready: Gate::open_now(),
            turn_ended: Gate::open_now(),
            interrupt_timer: None,
            exit: None,
            cleanup: None,
            mcp_off: options.mcp_off.clone(),
            background: Vec::new(),
        };
        let inner = Arc::new(Inner {
            options,
            state: Mutex::new(state),
            queue: queue.clone(),
            operations: AsyncMutex::new(()),
            access_slots: Arc::new(tokio::sync::Semaphore::new(ACCESS_WORKERS as usize)),
            access_gate: Arc::new(AccessGate::default()),
        });
        (Self { inner }, SessionEvents(queue))
    }

    /// The Claude session id (`nativeId`): the resumed one until `system/init` reports one.
    pub fn native_id(&self) -> Option<String> {
        self.inner.state.lock().unwrap().mapper.session_id.clone()
    }

    /// Inbound control-request handlers still running for the session's current client, withdrawn ones
    /// included. Diagnostic only: 0 when there is no client (before start, or once close removed it),
    /// even if handlers of an earlier client have not finished.
    pub fn live_inbound(&self) -> usize {
        self.inner.state.lock().unwrap().client.as_ref().map_or(0, ClaudeClient::live_inbound)
    }

    /// Observes this session's access-policy work; usable after the session is closed or dropped.
    pub fn access_monitor(&self) -> AccessMonitor {
        AccessMonitor { slots: self.inner.access_slots.clone(), gate: self.inner.access_gate.clone() }
    }

    pub fn pid(&self) -> Option<u32> {
        let state = self.inner.state.lock().unwrap();
        if state.closed {
            return None;
        }
        state.client.as_ref().and_then(ClaudeClient::pid)
    }

    /// Available after process cleanup; includes exit code/signal/reason and the bounded stderr tail.
    pub fn exit_info(&self) -> Option<ExitInfo> {
        let state = self.inner.state.lock().unwrap();
        state
            .exit
            .clone()
            .or_else(|| state.cleanup.as_ref().and_then(|rx| rx.borrow().clone()))
            .or_else(|| state.client.as_ref().and_then(ClaudeClient::exit_info))
    }

    pub fn is_closed(&self) -> bool {
        self.inner.queue.closed() || self.inner.state.lock().unwrap().closed
    }

    pub fn turn_active(&self) -> bool {
        self.inner.state.lock().unwrap().turn_active
    }

    /// Start a turn, or steer the running one. A future dropped while the CLI is still starting closes
    /// the session (and its process) rather than leaving a turn that never ends. A steer is admitted
    /// only after eligibility and frame-size validation. The session then owns its mode change and
    /// delivery even if the receipt future is dropped. Cancellation while waiting for admission has
    /// no effect. A successful receipt means queued to stdin, not CLI execution acknowledgement.
    pub async fn start_turn(&self, request: TurnRequest) -> Result<TurnStart, SessionError> {
        if self.inner.options.analysis_only {
            return Err(SessionError::UnsupportedAnalysis);
        }
        let _operation = self.inner.operations.lock().await;
        let delivery = self.inner.state.lock().unwrap().delivery_ready.clone();
        delivery.wait().await;
        if self.inner.queue.closed() {
            return Err(SessionError::Closed);
        }
        Inner::start_turn(self.inner.clone(), request).await
    }

    pub async fn interrupt(&self) {
        self.inner.interrupt().await
    }

    pub async fn close(&self) {
        self.inner.close().await
    }

    pub async fn set_permission_mode(&self, mode: &str) {
        let _operation = self.inner.operations.lock().await;
        let delivery = self.inner.state.lock().unwrap().delivery_ready.clone();
        delivery.wait().await;
        self.inner.set_permission_mode(mode).await
    }

    /// `respondToPermission`: "allow", "allow-for-chat" or "deny". False when the card is gone.
    pub fn respond_to_permission(&self, request_id: &str, decision: &str) -> bool {
        let mut state = self.inner.state.lock().unwrap();
        self.inner.resolve_permission(&mut state, request_id, decision)
    }

    /// `answerQuestion`: answers by question id, or `None` to dismiss.
    pub fn answer_question(&self, request_id: &str, answers: Option<&Map<String, Value>>) -> bool {
        let mut state = self.inner.state.lock().unwrap();
        let Some(card) = state.questions.iter().find(|q| q.id == request_id).map(|q| q.card.clone()) else { return false };
        let (outcome, kept) = milagre::settle_answers(&card, answers.unwrap_or(&Map::new()));
        self.inner.settle_question(&mut state, request_id, outcome, kept)
    }

    /// `taskOutput`: the tail of a background shell or Monitor task's output.
    pub async fn task_output(&self, task_id: &str) -> Result<Value, String> {
        let client = {
            let state = self.inner.state.lock().unwrap();
            if state.closed {
                None
            } else {
                state.client.clone()
            }
        };
        let client = client.ok_or_else(|| "That background task has ended.".to_owned())?;
        let reply = client.get_task_output(task_id).await.map_err(|error| error.to_string())?;
        let payload = reply.payload;
        Ok(json!({
            "output": payload.get("output").and_then(Value::as_str).unwrap_or(""),
            "totalBytes": payload.get("total_bytes").and_then(Value::as_f64).unwrap_or(0.0) as u64,
            "truncated": payload.get("truncated").is_some_and(|v| !matches!(v, Value::Null | Value::Bool(false))),
        }))
    }
}

/// Closes the session if a `start_turn` future is dropped before the turn's message is sent.
struct AbandonGuard {
    weak: Weak<Inner>,
    ready: Gate,
    armed: bool,
}

impl Drop for AbandonGuard {
    fn drop(&mut self) {
        self.ready.open();
        if !self.armed {
            return;
        }
        if let Some(inner) = self.weak.upgrade() {
            // Mark closed synchronously before another sender can acquire the operation lock.
            inner.stop();
        }
    }
}

impl Inner {
    fn emit_mapped(&self, events: crate::budget::Mapped) {
        match events {
            Ok(events) => {
                for event in events {
                    self.emit(event);
                }
            }
            Err(failure) => self.queue.fail(failure),
        }
    }
    fn emit(&self, event: Value) {
        self.queue.push(event);
    }

    fn native_mode(&self, mode: &str) -> &'static str {
        milagre::native_mode(mode, self.options.analysis_only, false)
    }

    fn start_turn(self: Arc<Self>, request: TurnRequest) -> BoxFuture<Result<TurnStart, SessionError>> {
        Box::pin(async move {
            enum Next {
                Steer,
                Begin(Gate),
            }
            if request.can_start.as_ref().is_some_and(|check| !check()) {
                return Ok(TurnStart { turn_id: None, steered: false, cancelled: true });
            }
            let next = {
                let mut state = self.state.lock().unwrap();
                if state.closed || self.queue.closed() {
                    return Err(SessionError::Closed);
                }
                if state.turn_active {
                    Next::Steer
                } else {
                    state.turn_active = true;
                    state.turn_epoch += 1;
                    state.implicit_turn = false;
                    state.steered_turn = false;
                    state.announced_id = false;
                    state.cancel_requested = false;
                    state.turn_ended = Gate::new();
                    state.turn_ready = Gate::new();
                    Next::Begin(state.turn_ready.clone())
                }
            };
            let ready = match next {
                Next::Steer => return self.steer(request).await,
                Next::Begin(ready) => ready,
            };
            let mut guard = AbandonGuard { weak: Arc::downgrade(&self), ready, armed: true };
            let result = self.begin_turn(request).await;
            guard.armed = false;
            Ok(result)
        })
    }

    async fn begin_turn(self: &Arc<Self>, request: TurnRequest) -> TurnStart {
        let turn_id = uuid();
        let mode = request.permission_mode.clone().unwrap_or_else(|| "ask".into());
        // Without an eligibility check, follow Node's beginTurn order: the mode is the session's at once
        // (`permissions.setMode`), the CLI launches in it, and a running CLI switches right after the model.
        // With one, the mode waits for the recheck below so an obsolete turn never raises it.
        // Local only (no card is pending between turns): the CLI hears the mode at launch or after set_model.
        if request.can_start.is_none() && !self.options.analysis_only {
            let mut state = self.state.lock().unwrap();
            state.permission_mode = mode.clone();
            state.mode_epoch += 1;
        }
        let needs_start = {
            let mut state = self.state.lock().unwrap();
            state.mapper.turn_id = Some(turn_id.clone());
            state.mapper.has_text = false;
            state.mapper.suggestion_turn_id = None;
            state.mapper.local_command_error = None;
            state.client.is_none()
        };
        if let Err(error) = self.prepare(&request, &mode, needs_start).await {
            match error {
                // The process ended while starting: its end fails the turn (handle_end), as in Node.
                ClientError::Exited(_) => {
                    let ended = self.state.lock().unwrap().turn_ended.clone();
                    ended.wait().await;
                }
                ClientError::Spawn { not_found: true, .. } => {
                    let mut state = self.state.lock().unwrap();
                    state.closed = true;
                    self.finish_turn(&mut state, Some(failed_with(&missing_cli_message(), Map::new())));
                    self.queue.close();
                }
                other => {
                    {
                        let mut state = self.state.lock().unwrap();
                        self.finish_turn(&mut state, Some(json!({ "type": "turn-failed", "message": other.to_string() })));
                    }
                    // Failed initialization must never leave a reusable, uninitialized client.
                    self.stop();
                }
            }
            return TurnStart { turn_id: None, steered: false, cancelled: false };
        }
        // close() or interrupt() may have landed while the CLI was starting.
        let closed = self.state.lock().unwrap().closed;
        if closed {
            self.close().await;
            let mut state = self.state.lock().unwrap();
            self.finish_turn(&mut state, Some(json!({ "type": "turn-cancelled" })));
            return TurnStart { turn_id: None, steered: false, cancelled: false };
        }
        let eligible = request.can_start.as_ref().is_none_or(|check| check());
        if eligible {
            let client = self.state.lock().unwrap().client.clone();
            if let Some(client) = client {
                if let Err(error) = client.validate_user_message(&request.content) {
                    self.finish_turn(&mut self.state.lock().unwrap(), Some(json!({"type":"turn-failed","message":error.to_string()})));
                    return TurnStart { turn_id: None, steered: false, cancelled: false };
                }
            }
            self.set_permission_mode(&mode).await;
        }
        let client = {
            let mut state = self.state.lock().unwrap();
            if !state.turn_active || state.mapper.turn_id.as_deref() != Some(&turn_id) {
                return TurnStart { turn_id: None, steered: false, cancelled: true };
            }
            if !eligible {
                self.finish_turn(&mut state, None);
                return TurnStart { turn_id: None, steered: false, cancelled: true };
            }
            if state.cancel_requested {
                self.finish_turn(&mut state, Some(json!({ "type": "turn-cancelled" })));
                return TurnStart { turn_id: None, steered: false, cancelled: true };
            }
            // Before the message goes out, so nothing the CLI answers can come first.
            self.emit(json!({ "type": "turn-started", "turnId": turn_id }));
            if self.queue.closed() {
                return TurnStart { turn_id: None, steered: false, cancelled: true };
            }
            state.client.clone()
        };
        if let Some(client) = client {
            if let Err(error) = client.send_user_message(request.content).await {
                if !matches!(error, ClientError::Exited(_)) {
                    let mut state = self.state.lock().unwrap();
                    self.finish_turn(&mut state, Some(json!({ "type": "turn-failed", "message": error.to_string() })));
                }
                return TurnStart { turn_id: None, steered: false, cancelled: false };
            }
        }
        TurnStart { turn_id: Some(turn_id), steered: false, cancelled: false }
    }

    /// Start the CLI if needed, then bring model, mode, effort, fast mode and reply style up to date.
    async fn prepare(self: &Arc<Self>, request: &TurnRequest, mode: &str, needs_start: bool) -> Result<(), ClientError> {
        if needs_start {
            let current = self.state.lock().unwrap().permission_mode.clone();
            self.start(request, self.native_mode(&current)).await?;
        }
        let client = {
            let state = self.state.lock().unwrap();
            if state.closed {
                return Ok(());
            }
            state.client.clone()
        };
        let Some(client) = client else { return Ok(()) };
        if self.state.lock().unwrap().model.as_deref() != Some(request.model.as_str()) {
            client.set_model(Some(&request.model)).await?;
            self.state.lock().unwrap().model = Some(request.model.clone());
        }
        // The user may have switched modes while Claude Code was starting (Node: after setModel).
        if request.can_start.is_none() {
            self.set_permission_mode(mode).await;
            if self.state.lock().unwrap().closed {
                return Ok(());
            }
        }
        // A new effort level alone turns ultracode off, so both keys always travel together.
        let effort_change = {
            let state = self.state.lock().unwrap();
            (request.effort.is_some() && request.effort != state.effort) || request.ultracode != state.ultracode
        };
        if effort_change {
            let mut settings = Map::new();
            if let Some(effort) = &request.effort {
                settings.insert("effortLevel".into(), effort.clone().into());
            }
            settings.insert("ultracode".into(), request.ultracode.into());
            client.apply_flag_settings(Value::Object(settings)).await?;
            let mut state = self.state.lock().unwrap();
            state.effort = request.effort.clone();
            state.ultracode = request.ultracode;
        }
        if request.fast_mode != self.state.lock().unwrap().fast_mode {
            client.apply_flag_settings(json!({ "fastMode": request.fast_mode })).await?;
            self.state.lock().unwrap().fast_mode = request.fast_mode;
        }
        // A CLI that rejects the style costs only the style: dropped for this session, never retried.
        let style = {
            let state = self.state.lock().unwrap();
            let wanted = (request.replies.as_deref() == Some("concise") && !state.style_failed).then(|| CONCISE_STYLE.to_owned());
            (wanted != state.output_style).then_some(wanted)
        };
        if let Some(wanted) = style {
            match client.apply_flag_settings(json!({ "outputStyle": wanted })).await {
                Ok(_) => self.state.lock().unwrap().output_style = wanted,
                Err(ClientError::Exited(info)) => return Err(ClientError::Exited(info)),
                Err(_) => self.state.lock().unwrap().style_failed = true,
            }
        }
        Ok(())
    }

    async fn start(self: &Arc<Self>, request: &TurnRequest, mode: &str) -> Result<(), ClientError> {
        let options = &self.options;
        let mut launch = options.launch.clone();
        launch.env_overrides.push(("CLAUDE_CODE_ENABLE_TODO_TOOLS".into(), "1".into()));
        launch.model = Some(request.model.clone());
        launch.permission_mode = Some(mode.into());
        launch.effort = request.effort.clone();
        let mut settings = Map::new();
        settings.insert("fastMode".into(), request.fast_mode.into());
        if request.ultracode {
            settings.insert("ultracode".into(), true.into());
        }
        launch.settings = Some(Value::Object(settings));
        launch.allow_dangerously_skip_permissions = true;
        launch.include_partial_messages = true;
        launch.resume = options.resume_id.clone();
        if options.execution_advisor {
            for tool in ["AskUserQuestion", "Agent", "Task"] {
                if !launch.disallowed_tools.iter().any(|t| t == tool) {
                    launch.disallowed_tools.push(tool.into());
                }
            }
        }
        let prompt_suggestions = options.prompt_suggestions && !options.analysis_only && !options.execution_advisor;
        let mut init = options.init.clone();
        init.forward_subagent_text = Some(true);
        init.prompt_suggestions = Some(prompt_suggestions);
        init.sdk_mcp_servers = launch.sdk_mcp_server_names();
        if !options.analysis_only && !options.execution_advisor && options.subagent_context.is_some() {
            init.hooks.push((
                "SubagentStart".into(),
                vec![HookMatcher { matcher: None, callback_ids: vec![SUBAGENT_START_HOOK.into()], timeout: None }],
            ));
        }
        // Every Chat gets the hook (hooks are fixed for the session); it lets everything through unless guarded.
        if !options.analysis_only {
            init.hooks.push((
                "PreToolUse".into(),
                vec![HookMatcher { matcher: None, callback_ids: vec![PRE_TOOL_USE_HOOK.into()], timeout: None }],
            ));
        }
        let weak = Arc::downgrade(self);
        let handlers = Handlers {
            permissions: Some(Arc::new(SessionHandler(weak.clone()))),
            questions: Some(Arc::new(SessionHandler(weak.clone()))),
            hooks: Some(Arc::new(SessionHandler(weak.clone()))),
            mcp: options.mcp.clone(),
            other: None,
        };
        // At most one decoded transport message waits behind mapping. Frame size remains separately bounded.
        let mut limits = options.limits.clone();
        limits.event_capacity = 1;
        let (client, events) = ClaudeClient::spawn(&launch, handlers, limits)?;
        let mut status = self.queue.status.subscribe();
        let watched = client.clone();
        let owner = weak.clone();
        tokio::spawn(async move {
            let reason = loop {
                let reason = *status.borrow_and_update();
                if reason != 0 {
                    break reason;
                }
                if status.changed().await.is_err() {
                    return;
                }
            };
            if reason == 1 || reason == 2 {
                // Kill independently of state-lock contention (e.g. a trusted policy callback).
                watched.kill().await;
                if let Some(inner) = owner.upgrade() {
                    inner.stop();
                }
            }
        });
        let generation = {
            let mut state = self.state.lock().unwrap();
            if state.closed {
                None
            } else {
                state.client = Some(client.clone());
                state.generation += 1;
                state.model = Some(request.model.clone());
                state.mode = Some(mode.into());
                state.effort = request.effort.clone();
                state.ultracode = request.ultracode;
                state.fast_mode = request.fast_mode;
                state.output_style = None;
                Some(state.generation)
            }
        };
        let Some(generation) = generation else {
            client.kill().await;
            return Ok(());
        };
        tokio::spawn(pump(weak, generation, events, self.queue.clone()));
        client.initialize(&init).await?;
        // Switch the off servers off before the first message; the init pass tries once more.
        let off = self.state.lock().unwrap().mcp_off.clone();
        for name in off {
            let _ = client.mcp_toggle(&name, false).await;
        }
        // Thinking arrives as readable summaries; null keeps the model's own budget.
        let _ = client.set_max_thinking_tokens(None, Some("summarized")).await;
        Ok(())
    }

    async fn steer(self: &Arc<Self>, request: TurnRequest) -> Result<TurnStart, SessionError> {
        let ready = self.state.lock().unwrap().turn_ready.clone();
        ready.wait().await;
        enum Next {
            AfterEnd(Gate),
            Start,
            Steer(ClaudeClient, Option<String>),
        }
        let next = {
            let state = self.state.lock().unwrap();
            if state.cancel_requested {
                // A turn asked to stop takes no more messages; this one starts the next turn.
                Next::AfterEnd(state.turn_ended.clone())
            } else if !state.turn_active || state.client.is_none() || state.closed {
                Next::Start
            } else {
                Next::Steer(state.client.clone().unwrap(), state.mapper.turn_id.clone())
            }
        };
        let (client, turn_id) = match next {
            Next::AfterEnd(ended) => {
                ended.wait().await;
                if self.state.lock().unwrap().closed {
                    return Err(SessionError::ClosedBeforeSend);
                }
                return self.clone().start_turn(request).await;
            }
            Next::Start => return self.clone().start_turn(request).await,
            Next::Steer(client, turn_id) => (client, turn_id),
        };
        if request.can_start.as_ref().is_some_and(|check| !check()) {
            return Ok(TurnStart { turn_id: None, steered: false, cancelled: true });
        }
        // Admission is side-effect free until this point, including oversized messages.
        client.validate_user_message(&request.content).map_err(SessionError::Send)?;
        let (done, result) = oneshot::channel();
        let ready = Gate::new();
        {
            let mut state = self.state.lock().unwrap();
            if state.closed || self.queue.closed() {
                return Err(SessionError::Closed);
            }
            state.delivery_ready = ready.clone();
            let weak = Arc::downgrade(self);
            state.background.retain(|task| !task.is_finished());
            state.background.push(tokio::spawn(async move {
                struct OpenOnDrop(Gate);
                impl Drop for OpenOnDrop {
                    fn drop(&mut self) {
                        self.0.open();
                    }
                }
                let _release = OpenOnDrop(ready);
                if let Some(inner) = weak.upgrade() {
                    // Accepted delivery belongs to the session, not to the caller awaiting its receipt.
                    let accepted = inner.deliver_steer(request, client, turn_id).await;
                    if let Err(error) = &accepted {
                        let mut state = inner.state.lock().unwrap();
                        if !state.closed && !inner.queue.closed() {
                            inner.finish_turn(&mut state, Some(json!({"type":"turn-failed","message":format!("Claude could not deliver an accepted message: {error}")})));
                            inner.stop_locked(&mut state);
                        }
                    }
                    let _ = done.send(accepted);
                }
            }));
        }
        result.await.unwrap_or(Err(SessionError::ClosedBeforeSend))
    }

    async fn deliver_steer(
        self: &Arc<Self>,
        mut request: TurnRequest,
        client: ClaudeClient,
        turn_id: Option<String>,
    ) -> Result<TurnStart, SessionError> {
        // Admission has committed. Eligibility cannot revoke an accepted message later.
        request.can_start = None;
        let mode = request.permission_mode.clone().unwrap_or_else(|| self.state.lock().unwrap().permission_mode.clone());
        self.set_permission_mode(&mode).await;
        let retry = {
            let state = self.state.lock().unwrap();
            state.closed || self.queue.closed() || state.cancel_requested || !state.turn_active || state.mapper.turn_id != turn_id
        };
        if retry {
            return self.clone().start_turn(request).await;
        }
        client.send_user_message(request.content).await.map_err(SessionError::Send)?;
        let mut state = self.state.lock().unwrap();
        if state.turn_active && state.mapper.turn_id == turn_id {
            let ids: Vec<String> = state.questions.iter().map(|q| q.id.clone()).collect();
            for id in ids {
                self.settle_question(&mut state, &id, QuestionOutcome::Dismissed, Map::new());
            }
            state.steered_turn = true;
        }
        Ok(TurnStart { turn_id, steered: true, cancelled: false })
    }

    async fn interrupt(self: &Arc<Self>) {
        let client = {
            let mut state = self.state.lock().unwrap();
            if !state.turn_active {
                return;
            }
            state.cancel_requested = true;
            if let Some(timer) = state.interrupt_timer.take() {
                timer.abort();
            }
            // If Claude never confirms, stop the process; the turn then ends as cancelled.
            let weak = Arc::downgrade(self);
            let grace = self.options.interrupt_grace;
            let turn_id = state.mapper.turn_id.clone();
            state.interrupt_timer = Some(tokio::spawn(async move {
                tokio::time::sleep(grace).await;
                if let Some(inner) = weak.upgrade() {
                    let mut state = inner.state.lock().unwrap();
                    if state.turn_active && state.cancel_requested && state.mapper.turn_id == turn_id {
                        // Detach our own handle before finish_turn aborts the previous timer.
                        state.interrupt_timer.take();
                        inner.stop_locked(&mut state);
                    }
                }
            }));
            self.cancel_all(&mut state);
            state.client.clone()
        };
        if let Some(client) = client {
            let _ = client.interrupt(false).await;
        }
    }

    // The state transition happens before any await; cleanup owns only the client and continues if
    // a caller drops close(). Dropping the runtime also drops that last client and kills its group.
    fn stop_locked(&self, state: &mut State) -> Option<watch::Receiver<Option<ExitInfo>>> {
        self.emit_mapped(state.mapper.settle_compact("cancelled"));
        state.closed = true;
        state.cancel_requested |= state.turn_active;
        state.generation += 1;
        for task in state.background.drain(..) {
            task.abort();
        }
        let client = state.client.take();
        self.finish_turn(state, Some(json!({ "type": "turn-cancelled" })));
        self.cancel_all(state);
        state.turn_ready.open();
        state.delivery_ready.open();
        self.queue.close();
        if let Some(client) = client {
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                let (done, receiver) = watch::channel(None);
                state.cleanup = Some(receiver);
                runtime.spawn(async move {
                    done.send_replace(Some(client.close().await));
                });
            }
        }
        state.cleanup.clone()
    }

    fn stop(&self) -> Option<watch::Receiver<Option<ExitInfo>>> {
        self.stop_locked(&mut self.state.lock().unwrap())
    }

    async fn close(self: &Arc<Self>) {
        if let Some(mut cleanup) = self.stop() {
            loop {
                if let Some(info) = cleanup.borrow_and_update().clone() {
                    self.state.lock().unwrap().exit = Some(info);
                    break;
                }
                if cleanup.changed().await.is_err() {
                    break;
                }
            }
        }
        // No further access callback is admitted (queued ones, including permit waiters, refuse at
        // entry); close returns once every callback admitted before this point has left the policy.
        // Their late results are discarded (closed state).
        self.access_gate.shut();
        self.access_slots.close();
        self.access_gate.drained().await;
    }

    async fn set_permission_mode(self: &Arc<Self>, mode: &str) {
        if self.options.analysis_only {
            return;
        }
        // Snapshot identities under lock; filesystem work runs on the blocking pool.
        let candidates = {
            let mut state = self.state.lock().unwrap();
            if state.closed || self.queue.closed() {
                return;
            }
            state.permission_mode = mode.into();
            state.mode_epoch += 1;
            state.permissions.iter().map(|p| (p.id.clone(), p.token.clone(), p.auto_files.clone())).collect::<Vec<_>>()
        };
        let allowed = if mode == "auto" {
            let cwd = self.options.launch.cwd.clone();
            let mut status = self.queue.status.subscribe();
            if *status.borrow() != 0 {
                return;
            }
            let check = tokio::task::spawn_blocking(move || {
                candidates.into_iter().filter(|(_, _, files)| inside_root(cwd.as_deref(), files)).collect::<Vec<_>>()
            });
            tokio::select! { result = check => result.unwrap_or_default(), _ = status.changed() => return }
        } else if mode == "full" {
            candidates
        } else {
            vec![]
        };
        let (client, native) = {
            let mut state = self.state.lock().unwrap();
            if state.closed || self.queue.closed() || state.permission_mode != mode {
                return;
            }
            for (id, token, _) in allowed {
                if state.permissions.iter().any(|p| p.id == id && p.token == token) {
                    self.resolve_permission(&mut state, &id, "allow");
                }
            }
            let native = self.native_mode(mode);
            if state.client.is_none() || state.mode.as_deref() == Some(native) {
                return;
            }
            state.mode = None;
            (state.client.clone().unwrap(), native)
        };
        match client.set_permission_mode(native).await {
            Ok(_) => {
                let mut state = self.state.lock().unwrap();
                if !state.closed && state.permission_mode == mode {
                    state.mode = Some(native.into());
                }
            }
            Err(_) => {
                let mut state = self.state.lock().unwrap();
                if !state.closed && !self.queue.closed() {
                    self.finish_turn(
                        &mut state,
                        Some(json!({"type":"turn-failed","message":"Claude could not apply the requested permission mode."})),
                    );
                    self.stop_locked(&mut state);
                }
            }
        }
    }

    fn resolve_permission(&self, state: &mut State, request_id: &str, decision: &str) -> bool {
        let Some(index) = state.permissions.iter().position(|p| p.id == request_id) else { return false };
        let mut pending = state.permissions.remove(index);
        // A card that didn't offer "always allow" can't grant it.
        let given = if decision == "allow-for-chat" && !pending.allow_for_chat { "allow" } else { decision };
        if let Some(tx) = pending.tx.take() {
            let _ = tx.send(given.to_owned());
        }
        self.emit(json!({ "type": "permission-resolved", "requestId": request_id, "decision": given }));
        true
    }

    fn settle_question(&self, state: &mut State, request_id: &str, outcome: QuestionOutcome, answers: Map<String, Value>) -> bool {
        let Some(index) = state.questions.iter().position(|q| q.id == request_id) else { return false };
        let mut pending = state.questions.remove(index);
        if let Some(tx) = pending.tx.take() {
            let _ = tx.send((outcome, answers));
        }
        let outcome = match outcome {
            QuestionOutcome::Answered => "answered",
            QuestionOutcome::Dismissed => "dismissed",
            QuestionOutcome::Cancelled => "cancelled",
            QuestionOutcome::Unshown => "unshown",
        };
        self.emit(json!({ "type": "question-resolved", "requestId": request_id, "outcome": outcome }));
        true
    }

    fn cancel_all(&self, state: &mut State) {
        let ids: Vec<String> = state.permissions.iter().map(|p| p.id.clone()).collect();
        for id in ids {
            self.resolve_permission(state, &id, "cancelled");
        }
        let ids: Vec<String> = state.questions.iter().map(|q| q.id.clone()).collect();
        for id in ids {
            self.settle_question(state, &id, QuestionOutcome::Cancelled, Map::new());
        }
    }

    // --- Turn ends ---

    fn finish_turn(&self, state: &mut State, event: Option<Value>) {
        if !state.turn_active {
            return;
        }
        let completed = event.as_ref().and_then(|e| e["type"].as_str()) == Some("turn-completed");
        state.mapper.suggestion_turn_id = if completed && !state.steered_turn { state.mapper.turn_id.clone() } else { None };
        state.turn_active = false;
        state.turn_epoch += 1;
        state.last_turn_id = state.mapper.turn_id.clone();
        if let Some(timer) = state.interrupt_timer.take() {
            timer.abort();
        }
        self.cancel_all(state);
        state.mapper.end_turn();
        if let Some(event) = event {
            self.emit(event);
        }
        state.turn_ended.open();
    }

    fn begin_implicit_turn(&self, state: &mut State, turn_id: String) {
        state.turn_active = true;
        state.turn_epoch += 1;
        state.announced_id = false;
        state.cancel_requested = false;
        state.mapper.turn_id = Some(turn_id.clone());
        state.mapper.has_text = false;
        state.mapper.local_command_error = None;
        state.turn_ready = Gate::open_now();
        state.turn_ended = Gate::new();
        let mut event = Obj::new().set("type", "turn-started").set("turnId", turn_id);
        if let Some(last) = &state.last_turn_id {
            event = event.set("continues", last.clone());
        }
        self.emit(event.build());
    }

    fn resume_gone(&self, state: &State, text: &str) -> bool {
        let stderr = state.exit.as_ref().map(|e| e.stderr_tail.as_str()).unwrap_or("");
        self.options.resume_id.is_some() && missing_conversation(&format!("{text}\n{stderr}"))
    }

    fn resume_failed(self: &Arc<Self>, state: &mut State) {
        if !state.turn_active {
            return;
        }
        self.emit(json!({ "type": "session-reset" }));
        self.finish_turn(state, Some(failed_with(RESUME_FAILED_MESSAGE, Map::new())));
        self.stop_locked(state);
    }

    fn on_message(self: &Arc<Self>, generation: u64, message: &Value, images: &std::collections::HashMap<String, Vec<Value>>) {
        let mut state = self.state.lock().unwrap();
        if generation != state.generation || self.queue.closed() {
            return;
        }
        let kind = message["type"].as_str().unwrap_or("");
        let init = kind == "system" && message["subtype"] == "init";
        if kind == "prompt_suggestion" {
            let prompt_suggestions = self.options.prompt_suggestions && !self.options.analysis_only && !self.options.execution_advisor;
            if prompt_suggestions && !state.closed && !state.turn_active && !state.cancel_requested && !state.implicit_turn {
                self.emit_mapped(state.mapper.map_prepared(message, Some(images)));
            }
            return;
        }
        if init && !state.turn_active && !state.closed {
            state.implicit_turn = true;
        }
        if init && !state.mcp_off.is_empty() {
            let off = std::mem::take(&mut state.mcp_off);
            if let Some(client) = state.client.clone() {
                state.background.retain(|task| !task.is_finished());
                state.background.push(tokio::spawn(async move {
                    for name in off {
                        let _ = client.mcp_toggle(&name, false).await;
                    }
                }));
            }
        }
        let events = if state.implicit_turn && !state.turn_active && !state.closed {
            // Node maps before beginImplicitTurn and attributes the first text to the previous turn.
            // Stage the mapper with the new id, but announce nothing for invisible notifications.
            let mut candidate = state.mapper.clone();
            let turn_id = uuid();
            candidate.turn_id = Some(turn_id.clone());
            candidate.has_text = false;
            candidate.local_command_error = None;
            let events = candidate.map_prepared(message, Some(images));
            if events.as_ref().is_ok_and(|v| v.is_empty()) {
                candidate.turn_id = state.mapper.turn_id.clone();
                candidate.has_text = state.mapper.has_text;
            } else {
                self.begin_implicit_turn(&mut state, turn_id);
            }
            state.mapper = candidate;
            events
        } else {
            state.mapper.map_prepared(message, Some(images))
        };
        let events = match events {
            Ok(events) => events,
            Err(failure) => {
                self.queue.fail(failure);
                return;
            }
        };
        for event in events {
            state.implicit_turn = false;
            if event["type"] == "session-started" {
                state.announced_id = true;
            }
            if !is_terminal(&event) {
                self.emit(event);
            } else if state.cancel_requested {
                self.finish_turn(&mut state, Some(json!({ "type": "turn-cancelled" })));
            } else if event["type"] == "turn-failed"
                && self.resume_gone(
                    &state,
                    &format!(
                        "{}\n{}\n{}",
                        event["message"].as_str().unwrap_or(""),
                        message.get("errors").map(crate::text::js_string).unwrap_or_default(),
                        message.get("result").map(crate::text::js_string).unwrap_or_default()
                    ),
                )
            {
                self.resume_failed(&mut state);
            } else {
                // A logged-out Claude Code keeps answering "not logged in" until restarted: the session closes.
                // The Chat forgets the id only when this very turn's init created it.
                let login = event["login"] == true;
                if login && state.announced_id {
                    self.emit(json!({ "type": "session-reset" }));
                }
                self.finish_turn(&mut state, Some(event));
                if login {
                    self.stop_locked(&mut state);
                }
            }
        }
        if kind == "result" {
            state.implicit_turn = false;
        }
    }

    fn handle_end(self: &Arc<Self>, generation: u64, info: Option<ExitInfo>) {
        let mut state = self.state.lock().unwrap();
        if generation != state.generation {
            return;
        }
        state.client = None;
        state.closed = true;
        let status = if state.cancel_requested { "cancelled" } else { "failed" };
        self.emit_mapped(state.mapper.settle_compact(status));
        if let Some(info) = &info {
            state.exit = Some(info.clone());
        }
        if !state.turn_active {
            self.queue.close();
            return;
        }
        let error = info.as_ref().and_then(exit_error);
        let stderr = info.as_ref().map(|i| i.stderr_tail.clone()).unwrap_or_default();
        if state.cancel_requested {
            self.finish_turn(&mut state, Some(json!({ "type": "turn-cancelled" })));
        } else if self.resume_gone(&state, error.as_deref().unwrap_or("")) {
            self.resume_failed(&mut state);
        } else {
            let detail = error.unwrap_or(stderr);
            let signal = info.as_ref().and_then(|i| i.signal).map(signal_name);
            self.finish_turn(&mut state, Some(failed_with(&crash_message(&detail, signal.as_deref()), Map::new())));
        }
        self.queue.close();
    }
}

/// Reads the CLI for one process generation. Holds the session weakly: a dropped session ends it.
async fn pump(weak: Weak<Inner>, generation: u64, mut events: EventStream, queue: Arc<EventQueue>) {
    while let Some(event) = events.recv().await {
        let Some(inner) = weak.upgrade() else { return };
        match event {
            ClaudeEvent::Message(message) => {
                let jobs = inner.state.lock().unwrap().mapper.image_jobs(&message);
                drop(inner);
                let budget = crate::EventBudget { count: queue.capacity - 1, bytes: queue.bytes - 1024 };
                if jobs.len() > budget.count {
                    queue.fail(crate::budget::BudgetFailure::Images);
                    return;
                }
                let images = if jobs.is_empty() {
                    std::collections::HashMap::new()
                } else {
                    let mut status = queue.status.subscribe();
                    if *status.borrow() != 0 {
                        return;
                    }
                    let save = tokio::task::spawn_blocking(move || {
                        let mut images = std::collections::HashMap::new();
                        let mut remaining = budget;
                        for (id, call, result, store) in jobs {
                            let events = crate::images::read_images(&call, &result, store.as_ref(), remaining)?;
                            remaining.count = remaining.count.saturating_sub(events.len());
                            remaining.bytes = remaining.bytes.saturating_sub(events.iter().map(crate::budget::weight).sum::<usize>());
                            images.insert(id, events);
                        }
                        Ok::<_, crate::budget::BudgetFailure>(images)
                    });
                    match tokio::select! { result = save => result.unwrap_or(Err(crate::budget::BudgetFailure::Images)), _ = status.changed() => return }
                    {
                        Ok(images) => images,
                        Err(failure) => {
                            queue.fail(failure);
                            return;
                        }
                    }
                };
                let Some(inner) = weak.upgrade() else {
                    return;
                };
                inner.on_message(generation, &message, &images);
            }
            ClaudeEvent::Diagnostic(_) => {}
            ClaudeEvent::Exit(info) => {
                inner.handle_end(generation, Some(info));
                return;
            }
        }
        if queue.closed() {
            return;
        }
    }
    if let Some(inner) = weak.upgrade() {
        inner.handle_end(generation, None);
    }
}

/// The session's answers to the CLI's requests.
struct SessionHandler(Weak<Inner>);

fn cancelled_result() -> PermissionResult {
    milagre::permission_result(Decision::Cancelled, &Value::Null, &[])
}

impl PermissionHandler for SessionHandler {
    fn can_use_tool(&self, request: PermissionRequest, mut cancel: CancelSignal) -> BoxFuture<Result<PermissionResult, String>> {
        let weak = self.0.clone();
        Box::pin(async move {
            let input = request.input.clone();
            let cancelled = || Ok(milagre::permission_result(Decision::Cancelled, &input, &[]));
            let allowed = |learn: Vec<String>| PermissionResult::Allow {
                updated_input: Some(input.clone()),
                updated_permissions: (!learn.is_empty())
                    .then(|| vec![json!({ "type": "addDirectories", "directories": learn, "destination": "session" })]),
            };
            let deny = |message: &str| Ok(PermissionResult::Deny { message: message.into(), interrupt: None });
            // `WorkspaceAccess.answer` runs before any card (Node decides it synchronously). Here it may touch
            // the filesystem, so it runs on the blocking pool under a session permit, bound to the turn and
            // mode it was asked for. A Deny always stands; an answer from another turn is cancelled; a mode
            // change since the check re-evaluates it; a failed check refuses in every mode.
            // Registers the card (or Full's allow) under the caller's lock, the one that validated the request.
            let register = |inner: &Inner, state: &mut State, card: Value| {
                let (tx, rx) = oneshot::channel::<String>();
                let token = uuid();
                let id = card["requestId"].as_str().unwrap_or_default().to_owned();
                if state.permission_mode == "full" {
                    let _ = tx.send("allow".into());
                } else {
                    let allow_for_chat = card["allowForChat"] == true;
                    state.permissions.push(PendingPermission {
                        id: id.clone(),
                        token: token.clone(),
                        tx: Some(tx),
                        allow_for_chat,
                        auto_files: if card["kind"] == "edit" && request.blocked_path.is_none() {
                            // Display cards coerce malformed JSON; authorization uses the raw path.
                            input
                                .get("file_path")
                                .or_else(|| input.get("notebook_path"))
                                .and_then(Value::as_str)
                                .map(|file| vec![file.to_owned()])
                                .unwrap_or_default()
                        } else {
                            vec![]
                        },
                    });
                    let mut event = Map::new();
                    event.insert("type".into(), "permission-request".into());
                    event.extend(card.as_object().cloned().unwrap_or_default());
                    inner.emit(Value::Object(event));
                }
                (id, token, rx)
            };
            let mut attempts = 0;
            // The turn the request arrived in; every re-evaluation stays bound to it.
            let mut origin: Option<u64> = None;
            let rx = loop {
                // Only a weak reference is kept across the awaits: a blocked check never keeps a dropped session.
                let Some(inner) = weak.upgrade() else { return cancelled() };
                // Scoped so no guard is held across the awaits below.
                let step = {
                    let mut state = inner.state.lock().unwrap();
                    // A request that arrives once its turn has stopped has nobody to ask.
                    if !state.turn_active
                        || state.cancel_requested
                        || state.closed
                        || cancel.reason().is_some()
                        || origin.is_some_and(|turn| turn != state.turn_epoch)
                    {
                        return cancelled();
                    }
                    origin = Some(state.turn_epoch);
                    let card = milagre::permission_card(&request);
                    // A command the guard refuses (a Claude Code that skipped the hook).
                    if card["kind"] == "command" {
                        if let Some(reason) = inner
                            .options
                            .pre_tool_use
                            .as_ref()
                            .and_then(|guard| guard.deny_reason(&json!({ "tool_name": request.tool_name, "tool_input": input })))
                        {
                            return Ok(PermissionResult::Deny { message: reason, interrupt: None });
                        }
                    }
                    let Some(access) = inner.options.access.clone() else {
                        break register(&inner, &mut state, card);
                    };
                    let read_file = ["Read", "Grep", "Glob"]
                        .contains(&request.tool_name.as_str())
                        .then(|| {
                            // `input?.file_path ?? input?.path`: null falls through, any other value is kept.
                            input
                                .get("file_path")
                                .filter(|v| !v.is_null())
                                .or_else(|| input.get("path"))
                                .and_then(Value::as_str)
                                .filter(|f| !f.is_empty())
                        })
                        .flatten();
                    let (kind, files) = match read_file {
                        Some(file) => ("read".to_owned(), vec![file.to_owned()]),
                        None => (kind_of(&card), files_of(&card)),
                    };
                    (access, kind, files, card, state.permission_mode.clone(), state.mode_epoch, state.turn_epoch)
                };
                let (access, kind, files, card, mode, mode_epoch, turn_epoch) = step;
                let slots = inner.access_slots.clone();
                let gate = inner.access_gate.clone();
                drop(inner);
                if attempts == ACCESS_ATTEMPTS {
                    return deny(ACCESS_UNSETTLED_MESSAGE);
                }
                attempts += 1;
                // The permit moves into the blocking closure: it is released only when that work finishes
                // (queued or running), even if this future is dropped first. A closed session refuses checks.
                let Ok(permit) = slots.acquire_owned().await else { return cancelled() };
                let (owner, signal) = (weak.clone(), cancel.clone());
                let work = tokio::task::spawn_blocking(move || {
                    let _permit = permit;
                    // Admission at actual entry, after the permit wait and blocking-pool queueing. The strong
                    // reference is taken outside the gate lock and released before the policy runs, so a
                    // last-reference drop never runs under the gate.
                    let session = owner.upgrade()?;
                    let entered = gate.enter(|| !stale_turn(&session.state.lock().unwrap_or_else(|e| e.into_inner()), turn_epoch, &signal));
                    drop(session);
                    let _entered = entered?;
                    Some(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| access.answer(&kind, &files, &mode))))
                });
                let answer = match work.await {
                    Ok(Some(Ok(answer))) => answer,
                    // Not admitted: the session closed or dropped, the turn moved on, or the request was withdrawn.
                    Ok(None) => return cancelled(),
                    // Panic or lost task: refuse, whatever the mode (never fall through to Full's allow).
                    _ => return deny(ACCESS_FAILED_MESSAGE),
                };
                let Some(inner) = weak.upgrade() else { return cancelled() };
                let mut state = inner.state.lock().unwrap();
                if stale_turn(&state, turn_epoch, &cancel) {
                    return cancelled();
                }
                match answer {
                    // A refusal stands in every mode the user may have switched to since.
                    Some(AccessDecision::Deny { message }) => return Ok(PermissionResult::Deny { message, interrupt: None }),
                    // Asked under a mode the user has since left (including Ask -> Full -> Ask): ask again.
                    _ if state.mode_epoch != mode_epoch => continue,
                    Some(AccessDecision::Allow { learn }) => return Ok(allowed(learn)),
                    // No access answer for this turn and mode: the card path decides under this same lock.
                    None => break register(&inner, &mut state, card),
                }
            };
            let (id, token, mut rx) = rx;
            let decision = tokio::select! {
                decision = &mut rx => decision.unwrap_or_else(|_| "cancelled".into()),
                _ = cancel.cancelled() => {
                    if let Some(inner) = weak.upgrade() {
                        let mut state = inner.state.lock().unwrap();
                        if state.permissions.iter().any(|p| p.id == id && p.token == token) {
                            inner.resolve_permission(&mut state, &id, "cancelled");
                        }
                    }
                    "cancelled".into()
                }
            };
            let decision = Decision::parse(&decision).unwrap_or(Decision::Deny);
            Ok(milagre::permission_result(decision, &input, &request.suggestions))
        })
    }
}

impl QuestionHandler for SessionHandler {
    fn ask(&self, request: PermissionRequest, mut cancel: CancelSignal) -> BoxFuture<Result<PermissionResult, String>> {
        let weak = self.0.clone();
        Box::pin(async move {
            let Some(inner) = weak.upgrade() else { return Ok(cancelled_result()) };
            let input = request.input.clone();
            if inner.options.execution_advisor {
                return Ok(PermissionResult::Deny { message: EXECUTION_QUESTION_DENIAL.into(), interrupt: None });
            }
            let (id, token, mut rx) = {
                let mut state = inner.state.lock().unwrap();
                if !state.turn_active || state.cancel_requested || state.closed || cancel.reason().is_some() {
                    return Ok(milagre::question_result(QuestionOutcome::Cancelled, &input, &Map::new()));
                }
                let Some(card) = milagre::question_card(&request) else {
                    return Ok(milagre::question_result(QuestionOutcome::Unshown, &input, &Map::new()));
                };
                let id = card["requestId"].as_str().unwrap_or_default().to_owned();
                let (tx, rx) = oneshot::channel();
                let token = uuid();
                state.questions.push(PendingQuestion { id: id.clone(), token: token.clone(), tx: Some(tx), card: card.clone() });
                let mut event = Map::new();
                event.insert("type".into(), "question-request".into());
                event.extend(card.as_object().cloned().unwrap_or_default());
                inner.emit(Value::Object(event));
                (id, token, rx)
            };
            drop(inner);
            let (outcome, answers) = tokio::select! {
                settled = &mut rx => settled.unwrap_or((QuestionOutcome::Cancelled, Map::new())),
                _ = cancel.cancelled() => {
                    if let Some(inner) = weak.upgrade() {
                        let mut state = inner.state.lock().unwrap();
                        if state.questions.iter().any(|q| q.id == id && q.token == token) {
                            inner.settle_question(&mut state, &id, QuestionOutcome::Cancelled, Map::new());
                        }
                    }
                    (QuestionOutcome::Cancelled, Map::new())
                }
            };
            Ok(milagre::question_result(outcome, &input, &answers))
        })
    }
}

impl HookHandler for SessionHandler {
    fn call(&self, callback: HookCallback, _cancel: CancelSignal) -> BoxFuture<Result<Value, String>> {
        let weak = self.0.clone();
        Box::pin(async move {
            let Some(inner) = weak.upgrade() else { return Ok(json!({})) };
            match callback.callback_id.as_str() {
                PRE_TOOL_USE_HOOK => Ok(inner
                    .options
                    .pre_tool_use
                    .as_ref()
                    .and_then(|guard| guard.deny_reason(&callback.input))
                    .map(|reason| {
                        json!({ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason } })
                    })
                    .unwrap_or_else(|| json!({}))),
                SUBAGENT_START_HOOK => Ok(json!({ "hookSpecificOutput": { "hookEventName": "SubagentStart",
                    "additionalContext": inner.options.subagent_context.clone().unwrap_or_default() } })),
                other => Err(format!("No hook callback found for ID: {other}")),
            }
        })
    }
}

#[cfg(test)]
mod workspace_tests {
    use super::inside_root;
    use std::path::Path;

    #[test]
    fn invalid_or_unresolved_paths_never_authorize() {
        let root = std::env::temp_dir().join(format!("claude-paths-{}-{}", std::process::id(), super::uuid()));
        std::fs::create_dir_all(root.join("nested")).unwrap();
        let check = |file: &str| inside_root(Some(&root), &[file.into()]);
        assert!(check("nested/missing/leaf"));
        assert!(!inside_root(None, &["a".into()]));
        assert!(!inside_root(Some(Path::new(".")), &["a".into()]));
        assert!(!inside_root(Some(&root.join("missing")), &["a".into()]));
        assert!(!inside_root(Some(&root), &[]));
        for file in ["", ".", "..", "nested/../leaf", "a\0b"] {
            assert!(!check(file), "{file:?}");
        }
        std::fs::write(root.join("file"), b"x").unwrap();
        assert!(!check("file/child"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_and_raw_cwd_parent_components_follow_filesystem_semantics() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!("claude-links-{}-{}", std::process::id(), super::uuid()));
        let workspace = root.join("workspace");
        let outside = root.join("outside");
        std::fs::create_dir_all(workspace.join("dir")).unwrap();
        std::fs::create_dir_all(outside.join("dir")).unwrap();
        symlink(&outside, workspace.join("escape")).unwrap();
        symlink(workspace.join("dir"), workspace.join("inside")).unwrap();
        symlink(outside.join("missing"), workspace.join("dangling")).unwrap();
        symlink("loop", workspace.join("loop")).unwrap();
        let check = |file: &str| inside_root(Some(&workspace), &[file.into()]);
        for file in ["escape/new", "escape/../new", "dangling/new", "loop/new"] {
            assert!(!check(file), "{file}");
        }
        assert!(check("inside/new"));
        symlink(outside.join("dir"), workspace.join("cwd-link")).unwrap();
        let raw_cwd = workspace.join("cwd-link/.."); // Kernel cwd is outside, not workspace.
        assert!(inside_root(Some(&raw_cwd), &[outside.join("new").to_string_lossy().into_owned()]));
        assert!(!inside_root(Some(&raw_cwd), &[workspace.join("new").to_string_lossy().into_owned()]));
        assert!(!inside_root(Some(&workspace.join("missing/..")), &["new".into()]));
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod event_queue_tests {
    use super::*;
    #[test]
    fn payload_code_cannot_enter_the_reserved_failure_slot() {
        let queue = EventQueue {
            state: Mutex::new(QueueState { events: VecDeque::new(), bytes: 0, closed: false }),
            added: Notify::new(),
            capacity: 4,
            bytes: 8192,
            status: watch::channel(0).0,
        };
        queue.push(json!({"code":"claude_event_limit","text":"x".repeat(5000)}));
        assert!(!queue.closed());
        assert_eq!(queue.pop().unwrap()["text"].as_str().unwrap().len(), 5000);
        queue.push(json!({"code":"claude_event_limit","text":"x".repeat(9000)}));
        assert!(queue.closed());
        assert_eq!(queue.pop().unwrap(), crate::budget::BudgetFailure::Queue.event());
    }
    #[test]
    fn concurrent_producers_cannot_exceed_either_budget_or_duplicate_failure() {
        for (capacity, bytes) in [(4, 8192), (100, 2048)] {
            let queue = Arc::new(EventQueue {
                state: Mutex::new(QueueState { events: VecDeque::new(), bytes: 0, closed: false }),
                added: Notify::new(),
                capacity,
                bytes,
                status: watch::channel(0).0,
            });
            let threads: Vec<_> = (0..8)
                .map(|_| {
                    let queue = queue.clone();
                    std::thread::spawn(move || {
                        for _ in 0..100 {
                            queue.push(json!({"type":"permission-request","text":"x".repeat(200)}));
                        }
                    })
                })
                .collect();
            for thread in threads {
                thread.join().unwrap();
            }
            {
                let state = queue.state.lock().unwrap();
                assert!(state.events.len() <= capacity);
                assert!(state.bytes <= bytes);
                assert_eq!(state.bytes, state.events.iter().map(|(v, _)| crate::budget::weight(v)).sum::<usize>());
                assert_eq!(state.events.iter().filter(|(v, _)| v["code"] == "claude_event_limit").count(), 1);
            }
            while queue.pop().is_some() {}
            assert_eq!(queue.state.lock().unwrap().bytes, 0);
            assert_eq!(*queue.status.borrow(), 1);
        }
    }
}

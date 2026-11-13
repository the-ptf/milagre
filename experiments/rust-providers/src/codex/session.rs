//! One Codex thread and its turns: codex-provider.cjs `CodexSession` with opt-in host image I/O. It starts or
//! resumes the thread, starts / steers / interrupts turns, maps notifications to Milagre agent events
//! (events.rs), routes server requests into Milagre permission and question requests with
//! `PendingPermissions` / `PendingQuestions` semantics, and polls native subagent threads.
//!
//! Every Milagre event comes out as [`SessionEvent::Agent`] (the `AgentEvent` JSON contract), except
//! the one terminal event of each turn, which comes as [`SessionEvent::TurnEnded`] with that JSON in
//! `event`. Raw notifications are forwarded only with [`SessionOptions::forward_raw_notifications`].
//!
//! Host/owner work still required: the babysit CommandClassifier, host MCP dispatch guards,
//! WorkspaceAccess read-only/dynamic roots, MCP extras discovery, image retention/serving and instructions.
//! Session roles, constrained bootstrap and disabled-server-preserving retries live here.

use crate::codex::approvals::{self, Decision, QuestionOutcome};
use crate::codex::client::{CodexClient, ConnectError, ConnectOptions, ResumeError};
use crate::codex::events::{crash_message, failed_with, is_terminal, map_codex_notification, CodexEventState};
use crate::codex::guard::{self, CommandClassifier, LinkedTools, SessionRole};
use crate::codex::protocol::{methods, CodexPolicy, PermissionMode, RequestId};
use crate::codex::rpc::{signal_name, ExitInfo, Notification, RpcError, ServerEvent, ServerRequest};
use crate::codex::subagents::{active as subagent_active, settle_subagents};
use crate::images::{self, ImageBudget, ImageStore, PreparedImages};
use crate::queue::{self, EventReceiver, EventSender, QueueLimits};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;
use tokio::sync::watch;

#[derive(Debug, Clone)]
pub struct SessionOptions {
    pub connect: ConnectOptions,
    /// Opt-in host output persistence, compatible with Claude ToolImageStore.
    pub image_store: Option<ImageStore>,
    /// Maximum wait for a blocking store batch. At most one batch runs per session.
    pub image_save_timeout: Duration,
    pub cwd: String,
    /// Other roots the session owns; edits inside them are allowed without a card in Auto.
    pub workspace_roots: Vec<String>,
    /// Resume this thread instead of starting one.
    pub resume_thread_id: Option<String>,
    /// codex-provider.cjs `interruptGraceMs`.
    pub interrupt_grace: Duration,
    /// milagre MCP tools whose Codex approval is answered "allow" without a card.
    pub ungated_milagre_tools: Vec<String>,
    /// Compatibility alias for AnalysisAdvisor, including its enforced constrained bootstrap.
    pub analysis_only: bool,
    /// Immutable for this session, including all steering and mode changes.
    pub role: SessionRole,
    /// Trusted owner shell parser; required for Babysit, optional for ordinary persistence checks.
    pub command_classifier: Option<Arc<dyn CommandClassifier>>,
    /// Constrained host endpoint and complete manifest. Not provider-supplied.
    pub linked_tools: Option<LinkedTools>,
    /// Names of ordinary Everywhere MCP servers eligible for the first config reduction.
    pub everywhere_servers: Vec<String>,
    /// Skip the `account/read` login check.
    pub skip_login_check: bool,
    /// Also emit every notification raw as [`SessionEvent::Notification`].
    pub forward_raw_notifications: bool,
    /// How often subagent threads are read while one is active (codex-provider.cjs: 1.5 s).
    pub subagent_poll_interval: Duration,
    /// Budget for session events not yet received; past it Codex is stopped.
    pub event_queue: QueueLimits,
    /// How long `turn/start` may take (codex-provider.cjs: 90 s).
    pub turn_start_timeout: Duration,
}

impl SessionOptions {
    pub fn new(connect: ConnectOptions, cwd: impl Into<String>) -> Self {
        SessionOptions {
            connect,
            image_store: None,
            image_save_timeout: Duration::from_secs(2),
            cwd: cwd.into(),
            workspace_roots: Vec::new(),
            resume_thread_id: None,
            interrupt_grace: Duration::from_secs(3),
            ungated_milagre_tools: approvals::MILAGRE_UNGATED_TOOLS.iter().map(|s| s.to_string()).collect(),
            analysis_only: false,
            role: SessionRole::Ordinary,
            command_classifier: None,
            linked_tools: None,
            everywhere_servers: Vec::new(),
            skip_login_check: false,
            forward_raw_notifications: false,
            subagent_poll_interval: Duration::from_millis(1500),
            event_queue: QueueLimits::default(),
            turn_start_timeout: crate::codex::client::TURN_START_TIMEOUT,
        }
    }
}

/// `thread/start` / `thread/resume` params besides cwd and the thread id.
#[derive(Debug, Clone)]
pub struct ThreadSettings {
    pub model: Option<String>,
    pub policy: CodexPolicy,
    pub developer_instructions: Option<String>,
    /// Thread config (`features`, `mcp_servers`); [`crate::codex::protocol::thread_config`] is the base.
    pub config: Option<Value>,
    /// Reserved for future validated parameters. Nonempty maps are explicitly refused.
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone)]
pub struct TurnSettings {
    pub input: Vec<Value>,
    /// Retained through the turn. Use with_images to set both input and ownership.
    pub input_images: Option<PreparedImages>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub policy: CodexPolicy,
    /// The Chat's mode, for answering approvals (Full allows, Auto allows workspace edits).
    pub permission_mode: Option<PermissionMode>,
    /// `serviceTierForTurn`; codex-provider.cjs sends `"default"` unless fast mode is on.
    pub service_tier: String,
    /// Overrides [`SessionOptions::turn_start_timeout`] for this turn.
    pub start_timeout: Option<Duration>,
    /// Reserved for future validated parameters. Nonempty maps are explicitly refused.
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum SessionError {
    #[error(transparent)]
    Connect(#[from] ConnectError),
    /// `account/read` says no account while OpenAI auth is required. The Milagre message is
    /// [`crate::codex::events::login_message`].
    #[error("Codex needs you to log in (codex login).")]
    LoginRequired,
    #[error(transparent)]
    Resume(#[from] ResumeError),
    #[error(transparent)]
    Rpc(#[from] RpcError),
    #[error("Unsupported Codex policy: {0}")]
    UnsupportedPolicy(String),
    #[error("Input image budget exceeded.")]
    ImageBudget,
    #[error("No turn is running.")]
    NoTurn,
    #[error("The agent session closed before this message was sent.")]
    Closed,
}

/// How a turn ended, from its terminal Milagre event.
#[derive(Debug, Clone, PartialEq)]
pub enum TurnEnd {
    Completed,
    Failed {
        message: String,
    },
    /// Interrupted by Codex or stopped by Milagre (interrupt, close, the grace-period kill).
    Cancelled,
    /// The process exited mid-turn; `message` is Milagre's crash message.
    Crashed {
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum SessionEvent {
    /// A Milagre agent event (`text-delta`, `step-started`, `permission-request`, `subagent-update`, …).
    Agent(Value),
    /// The one terminal event of a turn (`turn-completed` / `turn-failed` / `turn-cancelled`).
    TurnEnded { turn_id: Option<String>, end: TurnEnd, event: Value },
    /// A notification as received, with [`SessionOptions::forward_raw_notifications`].
    Notification(Notification),
    /// Always the last event.
    Exited(ExitInfo),
}

/// What [`CodexSession::send`] did with a message.
#[derive(Debug, Clone, PartialEq)]
pub struct SendOutcome {
    pub turn_id: Option<String>,
    /// Joined the running turn instead of starting one.
    pub steered: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PendingKind {
    Approval,
    McpApproval,
    Question,
}

struct Pending {
    rpc_id: RequestId,
    kind: PendingKind,
    allow_for_chat: bool,
    /// An edit approval's files (not a `grantRoot` one): Auto may allow it without a card when they
    /// are all inside the workspace, checked again at the moment Auto is chosen.
    workspace_files: Option<Vec<String>>,
    /// Question ids, for dropping answers to questions that weren't asked.
    question_ids: Vec<String>,
}

#[derive(Default)]
struct State {
    turn_active: bool,
    turn_generation: u64,
    cancel_requested: bool,
    closed: bool,
    ready: bool,
    /// turn/start is in flight.
    starting: bool,
    mode: Option<PermissionMode>,
    /// By Milagre request id (`String(id)`, made unique when Codex mixes `5` and `"5"`), in arrival order.
    pending: indexmap::IndexMap<String, Pending>,
    /// A turn/start timed out: that turn may still run, so while the next turn/start is in flight
    /// its turn-scoped notifications wait in `held` until the new turn's id is known.
    stale_start: bool,
    held: Vec<Notification>,
    /// fileChange items from item/started; their approval requests carry no diff of their own.
    file_changes: HashMap<String, Vec<Value>>,
    /// Why the session stopped Codex itself, for the crash message.
    stop_detail: Option<String>,
    refused: HashMap<String, (String, String)>,
    escalation_items: std::collections::HashSet<String>,
    linked_tools_available: bool,
    input_images: Vec<PreparedImages>,
    input_budget: ImageBudget,
    output_budget: ImageBudget,
}

/// Per subagent thread: what the last poll saw (codex-provider.cjs `childHistory`).
#[derive(Default, Clone)]
struct ChildHistory {
    cursor: Option<String>,
    /// `turn:item` -> the item while its turn runs, `None` once the turn finished.
    items: HashMap<String, Option<Value>>,
    outcome: Option<Value>,
    agent_status: Option<Value>,
    finished: bool,
}

struct Inner {
    client: CodexClient,
    image_worker: Arc<tokio::sync::Semaphore>,
    options: SessionOptions,
    state: Mutex<State>,
    mapper: Mutex<CodexEventState>,
    events: EventSender<SessionEvent>,
    /// Bumped whenever a turn ends; and whenever turn/start settles.
    turn_ended: watch::Sender<u64>,
    turn_ready: watch::Sender<u64>,
    poll_scheduled: AtomicBool,
    polling: tokio::sync::Mutex<HashMap<String, ChildHistory>>,
    /// Held while one notification is handled, so held-back ones are replayed in order.
    notifications: tokio::sync::Mutex<()>,
}

#[derive(Clone)]
pub struct CodexSession {
    inner: Arc<Inner>,
}

impl CodexSession {
    /// Connects, checks login, starts or resumes the thread. Every failure stops the process.
    pub async fn start(
        mut options: SessionOptions,
        thread: ThreadSettings,
    ) -> Result<(CodexSession, EventReceiver<SessionEvent>), SessionError> {
        if options.analysis_only {
            if !matches!(options.role, SessionRole::Ordinary | SessionRole::AnalysisAdvisor) {
                return Err(SessionError::UnsupportedPolicy("analysis_only conflicts with session role".into()));
            }
            options.role = SessionRole::AnalysisAdvisor;
        }
        validate_options(&options, &thread)?;
        if options.role.constrained() {
            options.connect.experimental_api = true;
        }
        let (client, rpc_events) = CodexClient::connect(options.connect.clone()).await?;
        let (events, events_rx) = queue::channel(options.event_queue);
        let mapper = CodexEventState::new(options.resume_thread_id.clone());
        let inner = Arc::new(Inner {
            client,
            image_worker: Arc::new(tokio::sync::Semaphore::new(1)),
            options,
            state: Mutex::new(State::default()),
            mapper: Mutex::new(mapper),
            events,
            turn_ended: watch::channel(0).0,
            turn_ready: watch::channel(0).0,
            poll_scheduled: AtomicBool::new(false),
            polling: tokio::sync::Mutex::new(HashMap::new()),
            notifications: tokio::sync::Mutex::new(()),
        });
        // The pump holds no strong reference: dropping every CodexSession (or a `start` that is
        // cancelled) drops the client, which kills the process tree.
        tokio::spawn(pump(Arc::downgrade(&inner), rpc_events));
        let session = CodexSession { inner };
        match session.open_thread(thread).await {
            Ok(()) => Ok((session, events_rx)),
            Err(error) => {
                session.close().await;
                Err(error)
            }
        }
    }

    async fn open_thread(&self, thread: ThreadSettings) -> Result<(), SessionError> {
        let inner = &self.inner;
        if !inner.options.skip_login_check {
            if let Some(status) = inner.client.account_status().await {
                inner.mapper.lock().unwrap().requires_openai_auth = Some(status.requires_openai_auth);
                if status.login_required() {
                    return Err(SessionError::LoginRequired);
                }
            }
        }
        let policy = inner.options.role.policy(&thread.policy);
        let config = if inner.options.role.constrained() {
            let inherited = inner.client.read_config(&inner.options.cwd).await?;
            let inherited = inherited.get("config").ok_or_else(|| SessionError::UnsupportedPolicy("missing inherited config".into()))?;
            let linked_url = inner.options.linked_tools.as_ref().map(|linked| linked.url.as_str());
            let mut config = guard::advisor_config(inherited, linked_url).map_err(SessionError::UnsupportedPolicy)?;
            if matches!(inner.options.role, SessionRole::Babysit { .. }) {
                // Keep native shell/files for babysit, but prevent native subagents, external MCP,
                // code-mode and plugins from routing around this session's command gate.
                config["features"]["shell_tool"] = true.into();
                config["features"]["unified_exec"] = true.into();
            }
            Some(config)
        } else {
            thread.config.clone()
        };
        let mut params = serde_json::Map::new();
        params.insert("cwd".into(), inner.options.cwd.clone().into());
        if let Some(model) = &thread.model {
            params.insert("model".into(), model.clone().into());
        }
        params.insert("approvalPolicy".into(), policy.approval_policy.into());
        params.insert("sandbox".into(), policy.sandbox.into());
        if let Some(instructions) = &thread.developer_instructions {
            params.insert("developerInstructions".into(), instructions.clone().into());
        }
        if let Some(config) = &config {
            params.insert("config".into(), config.clone());
        }
        params.extend(thread.extra.clone());
        if inner.options.role.constrained() {
            params.insert("environments".into(), json!([]));
        }
        let params = Value::Object(params);
        let result = match &inner.options.resume_thread_id {
            Some(id) => {
                let mut params = params;
                params["threadId"] = id.clone().into();
                match inner.request_thread(methods::THREAD_RESUME, &params).await {
                    Ok(result) => result,
                    Err(SessionError::Rpc(first)) if first.is_server_error() => {
                        let retry = async {
                            inner.client.rpc().request(methods::THREAD_UNARCHIVE, json!({"threadId":id})).await?;
                            inner.request_thread(methods::THREAD_RESUME, &params).await
                        }
                        .await;
                        match retry {
                            Ok(result) => result,
                            Err(SessionError::Rpc(second)) if second.is_server_error() => {
                                return Err(ResumeError::ResumeFailed { thread_id: id.clone(), first, second }.into())
                            }
                            Err(error) => return Err(error),
                        }
                    }
                    Err(error) => return Err(error),
                }
            }
            None => inner.request_thread(methods::THREAD_START, &params).await?,
        };
        // A new id (a fresh thread, or a resume that moved) is announced as session-started.
        if let Some(id) = result.pointer("/thread/id").and_then(Value::as_str).filter(|id| !id.is_empty()) {
            let changed = {
                let mut mapper = inner.mapper.lock().unwrap();
                let changed = mapper.thread_id.as_deref() != Some(id);
                mapper.thread_id = Some(id.to_string());
                changed
            };
            if changed {
                inner.emit(SessionEvent::Agent(json!({ "type": "session-started", "nativeId": id })));
            }
        }
        inner.state.lock().unwrap().ready = true;
        Ok(())
    }

    pub fn client(&self) -> &CodexClient {
        &self.inner.client
    }

    /// Codex's thread id (Milagre's `nativeId`).
    pub fn thread_id(&self) -> Option<String> {
        self.inner.mapper.lock().unwrap().thread_id.clone()
    }

    pub fn turn_id(&self) -> Option<String> {
        self.inner.mapper.lock().unwrap().turn_id.clone()
    }

    /// Whether the successful thread configuration retained an enabled Milagre MCP endpoint.
    pub fn linked_tools_available(&self) -> bool {
        self.inner.state.lock().unwrap().linked_tools_available
    }

    pub fn turn_active(&self) -> bool {
        self.inner.state.lock().unwrap().turn_active
    }

    /// The app-server's pid while it runs; the ports its commands open belong to the Chat.
    pub fn pid(&self) -> Option<u32> {
        if self.inner.state.lock().unwrap().closed {
            None
        } else {
            self.inner.client.rpc().pid()
        }
    }

    /// Milagre request ids still waiting for an answer.
    pub fn open_requests(&self) -> Vec<String> {
        self.inner.state.lock().unwrap().pending.keys().cloned().collect()
    }

    /// Subagent agent objects as last reported.
    pub fn subagents(&self) -> Vec<Value> {
        self.inner.mapper.lock().unwrap().subagents.values().cloned().collect()
    }

    /// A message: starts a turn, or joins the running one through `turn/steer` (codex-provider.cjs
    /// `startTurn`). A message for a turn that is stopping, has no id yet, or that Codex refuses to
    /// steer (it already ended) starts the next turn once this one ends.
    pub async fn send(&self, turn: TurnSettings) -> Result<SendOutcome, SessionError> {
        validate_turn(&self.inner.options.role, &turn)?;
        loop {
            let (active, cancel, closed) = {
                let state = self.inner.state.lock().unwrap();
                (state.turn_active, state.cancel_requested, state.closed)
            };
            if closed {
                return Err(SessionError::Closed);
            }
            if !active {
                return self.start_turn(turn).await;
            }
            // Wait for turn/start to settle before deciding.
            self.wait_turn_ready().await;
            let mut ended = self.inner.turn_ended.subscribe();
            let turn_id = self.turn_id();
            if cancel || turn_id.is_none() || !self.turn_active() {
                if self.turn_active() {
                    wait_turn_end(&self.inner, &mut ended).await;
                }
                continue;
            }
            match self.steer_with(&turn).await {
                Ok(()) => return Ok(SendOutcome { turn_id, steered: true }),
                Err(SessionError::Rpc(error)) if error.is_server_error() => {
                    wait_turn_end(&self.inner, &mut ended).await;
                    continue;
                }
                Err(error) => return Err(error),
            }
        }
    }

    /// Waits while turn/start is in flight.
    async fn wait_turn_ready(&self) {
        let mut ready = self.inner.turn_ready.subscribe();
        while self.inner.state.lock().unwrap().starting {
            if ready.changed().await.is_err() {
                return;
            }
        }
    }

    async fn steer_with(&self, turn: &TurnSettings) -> Result<(), SessionError> {
        if let Some(mode) = turn.permission_mode {
            self.set_permission_mode(mode).await;
        }
        self.steer_images(turn.input.clone(), turn.input_images.as_ref()).await
    }

    /// Starts a turn (a running one is steered instead, as [`CodexSession::send`]). Returns the
    /// turn id when Codex gave one. On failure the turn has already ended (`turn-failed` or
    /// `turn-cancelled`).
    pub async fn start_turn(&self, turn: TurnSettings) -> Result<SendOutcome, SessionError> {
        validate_turn(&self.inner.options.role, &turn)?;
        let policy = self.inner.options.role.policy(&turn.policy);
        let inner = &self.inner;
        // One lock decides: two messages at once start one turn and steer the other into it.
        let busy = {
            let mut state = inner.state.lock().unwrap();
            if state.closed {
                return Err(SessionError::Closed);
            }
            if state.turn_active {
                true
            } else {
                state.input_budget = ImageBudget::default();
                retain_images(&mut state, turn.input_images.as_ref())?;
                state.output_budget = ImageBudget::default();
                state.turn_active = true;
                state.turn_generation = state.turn_generation.wrapping_add(1);
                state.escalation_items.clear();
                state.refused.clear();
                state.cancel_requested = false;
                state.starting = true;
                if let Some(mode) = turn.permission_mode {
                    state.mode = Some(mode);
                }
                false
            }
        };
        if busy {
            return Box::pin(self.send(turn)).await;
        }
        let thread_id = {
            let mut mapper = inner.mapper.lock().unwrap();
            mapper.start_turn();
            mapper.thread_id.clone()
        };
        let mut params = serde_json::Map::new();
        params.insert("threadId".into(), thread_id.into());
        params.insert("input".into(), Value::Array(turn.input));
        if let Some(model) = turn.model {
            params.insert("model".into(), model.into());
        }
        if let Some(effort) = turn.effort {
            params.insert("effort".into(), effort.into());
        }
        params.insert("summary".into(), "auto".into());
        params.insert("serviceTierForTurn".into(), turn.service_tier.into());
        params.insert("approvalPolicy".into(), policy.approval_policy.into());
        params.insert("sandboxPolicy".into(), policy.sandbox_policy);
        params.extend(turn.extra);
        if inner.options.role.constrained() {
            params.insert("environments".into(), json!([]));
        }
        let start_timeout = turn.start_timeout.unwrap_or(inner.options.turn_start_timeout);
        // A caller that stops waiting (a timeout, an aborted task) must not leave the turn open
        // forever: the guard stops it the way Stop would.
        let mut guard = StartGuard { inner: Some(inner.clone()) };
        let result = inner.client.rpc().request_with_timeout(methods::TURN_START, Value::Object(params), Some(start_timeout)).await;
        if matches!(result, Err(RpcError::Timeout { .. })) {
            inner.state.lock().unwrap().stale_start = true;
        }
        let confirmed = result.as_ref().ok().and_then(|r| r.pointer("/turn/id")).and_then(Value::as_str).map(str::to_string);
        // Still guarded: release_held waits on the notification lock, and a caller dropped there must
        // not leave `starting` set.
        inner.release_held(confirmed).await;
        guard.inner = None;
        match result {
            Ok(_) => {
                let turn_id = inner.mapper.lock().unwrap().turn_id.clone();
                let cancel = {
                    let state = inner.state.lock().unwrap();
                    state.cancel_requested && state.turn_active
                };
                // Stop was pressed while turn/start was in flight.
                if cancel {
                    let session = self.clone();
                    tokio::spawn(async move { session.interrupt().await });
                }
                Ok(SendOutcome { turn_id, steered: false })
            }
            Err(error) => {
                let event = if inner.state.lock().unwrap().cancel_requested {
                    json!({ "type": "turn-cancelled" })
                } else {
                    json!({ "type": "turn-failed", "message": error.to_string() })
                };
                inner.finish_turn(vec![event], false).await;
                Err(error.into())
            }
        }
    }

    /// Adds input to the running turn (`turn/steer`). An open question is dismissed first: the
    /// message is the user's reply. A server error means the turn already ended ([`CodexSession::send`]
    /// then starts the next one).
    pub async fn steer(&self, input: Vec<Value>) -> Result<(), SessionError> {
        self.steer_images(input, None).await
    }

    async fn steer_images(&self, input: Vec<Value>, images: Option<&PreparedImages>) -> Result<(), SessionError> {
        let (thread_id, turn_id) = {
            let mut state = self.inner.state.lock().unwrap();
            if !state.turn_active || state.cancel_requested {
                return Err(SessionError::NoTurn);
            }
            let mapper = self.inner.mapper.lock().unwrap();
            match (&mapper.thread_id, &mapper.turn_id) {
                (Some(thread), Some(turn)) => {
                    retain_images(&mut state, images)?;
                    (thread.clone(), turn.clone())
                }
                _ => return Err(SessionError::NoTurn),
            }
        };
        self.inner.settle_questions(QuestionOutcome::Dismissed).await;
        self.inner.client.turn_steer(&thread_id, &turn_id, input).await?;
        Ok(())
    }

    /// Stops the running turn: open requests are cancelled, `turn/interrupt` is sent, and if Codex
    /// doesn't end the turn within the grace period (or refuses), the process is stopped and the
    /// turn ends as `turn-cancelled`. Returns once the turn has ended.
    pub async fn interrupt(&self) {
        self.inner.state.lock().unwrap().cancel_requested = true;
        self.interrupt_requested().await;
    }

    async fn interrupt_requested(&self) {
        let inner = &self.inner;
        let mut ended = inner.turn_ended.subscribe();
        {
            let state = inner.state.lock().unwrap();
            if !state.turn_active {
                return;
            }
        }
        inner.cancel_all().await;
        let (thread_id, turn_id) = {
            let mapper = inner.mapper.lock().unwrap();
            (mapper.thread_id.clone(), mapper.turn_id.clone())
        };
        let grace = inner.options.interrupt_grace;
        let deadline = tokio::time::Instant::now() + grace;
        if let (Some(thread_id), Some(turn_id)) = (thread_id, turn_id) {
            if inner.client.turn_interrupt(&thread_id, &turn_id, grace).await.is_err() {
                self.stop_now().await;
                return;
            }
        }
        if tokio::time::timeout_at(deadline, wait_turn_end(inner, &mut ended)).await.is_err() {
            self.stop_now().await;
        }
    }

    /// Fallback for an interrupt Codex doesn't honour.
    async fn stop_now(&self) {
        self.close().await;
        self.inner.finish_turn(vec![json!({ "type": "turn-cancelled" })], false).await;
    }

    /// Answers a permission request (`PendingPermissions.resolve`). `Ok(false)` when it is unknown
    /// or already settled. "allow-for-chat" on a card that didn't offer it is "allow". When the answer
    /// could not be written but Codex still waits, the card stays open and the error is returned so
    /// the answer can be given again.
    pub async fn respond_to_permission(&self, request_id: &str, decision: Decision) -> Result<bool, SessionError> {
        let pending = {
            let mut state = self.inner.state.lock().unwrap();
            match state.pending.get(request_id) {
                Some(p) if p.kind != PendingKind::Question => state.pending.shift_remove(request_id),
                _ => None,
            }
        };
        let Some(pending) = pending else { return Ok(false) };
        self.inner.answer_permission(request_id, pending, decision).await?;
        Ok(true)
    }

    /// Answers a question (`PendingQuestions.answer`): answers to questions it didn't ask and blank
    /// answers are dropped; nothing left is a dismissal. `Dismissed` dismisses. Errors as
    /// [`CodexSession::respond_to_permission`].
    pub async fn answer_question(&self, request_id: &str, outcome: QuestionOutcome) -> Result<bool, SessionError> {
        let pending = {
            let mut state = self.inner.state.lock().unwrap();
            match state.pending.get(request_id) {
                Some(p) if p.kind == PendingKind::Question => state.pending.shift_remove(request_id),
                _ => None,
            }
        };
        let Some(pending) = pending else { return Ok(false) };
        let outcome = match outcome {
            QuestionOutcome::Answered(answers) => {
                let given: Vec<(String, Vec<String>)> = answers
                    .into_iter()
                    .filter(|(id, _)| pending.question_ids.contains(id))
                    .map(|(id, values)| (id, values.iter().map(|v| v.trim().to_string()).filter(|v| !v.is_empty()).collect::<Vec<_>>()))
                    .filter(|(_, values)| !values.is_empty())
                    .collect();
                if given.is_empty() {
                    QuestionOutcome::Dismissed
                } else {
                    QuestionOutcome::Answered(given)
                }
            }
            other => other,
        };
        self.inner.answer_question(request_id, pending, outcome).await?;
        Ok(true)
    }

    /// Codex fixes its approval policy when a turn starts, so a switch mid-turn is applied to open
    /// cards here (`PendingPermissions.setMode`): Full allows them all, Auto allows workspace edits.
    pub async fn set_permission_mode(&self, mode: PermissionMode) {
        if self.inner.options.role.denies_edits() {
            return;
        }
        let candidates: Vec<(String, Option<Vec<String>>)> = {
            let mut state = self.inner.state.lock().unwrap();
            state.mode = Some(mode);
            state
                .pending
                .iter()
                .filter(|(_, p)| p.kind != PendingKind::Question && (mode == PermissionMode::Full || p.workspace_files.is_some()))
                .map(|(id, p)| (id.clone(), p.workspace_files.clone()))
                .collect()
        };
        // The same check a new request gets, against the filesystem as it is now.
        let mut chosen = Vec::new();
        for (id, files) in candidates {
            let allowed = match (mode, files) {
                (PermissionMode::Full, _) => true,
                (PermissionMode::Auto, Some(files)) => self.inner.in_workspace(files).await,
                _ => false,
            };
            if allowed {
                chosen.push(id);
            }
        }
        let allowed: Vec<(String, Pending)> = {
            let mut state = self.inner.state.lock().unwrap();
            // A card answered or cancelled meanwhile is gone; Auto only applies while it still is the mode.
            if state.mode != Some(mode) {
                return;
            }
            chosen.into_iter().filter_map(|id| state.pending.shift_remove(&id).map(|p| (id, p))).collect()
        };
        for (id, pending) in allowed {
            self.inner.resolve_permission(&id, pending, Decision::Allow);
        }
    }

    /// Stops the process tree. Running subagents are settled as cancelled; a running turn ends as
    /// `turn-cancelled` when the exit is seen.
    pub async fn close(&self) -> ExitInfo {
        let inner = &self.inner;
        let settled = settle_subagents(&mut inner.mapper.lock().unwrap(), "cancelled");
        for event in settled {
            inner.emit(SessionEvent::Agent(event));
        }
        inner.cancel_all().await;
        {
            let mut state = inner.state.lock().unwrap();
            if state.turn_active {
                state.cancel_requested = true;
            }
            state.closed = true;
        }
        let exit = inner.client.close().await;
        // The pump ends the turn on the exit; wait for it so callers see a settled session.
        let mut ended = inner.turn_ended.subscribe();
        let _ = tokio::time::timeout(Duration::from_secs(1), wait_turn_end(inner, &mut ended)).await;
        exit
    }
}

async fn wait_turn_end(inner: &Inner, ended: &mut watch::Receiver<u64>) {
    loop {
        if !inner.state.lock().unwrap().turn_active {
            return;
        }
        if ended.changed().await.is_err() {
            return;
        }
    }
}

/// A cheap size estimate for the event queue budget.
fn approx_size(value: &Value) -> usize {
    match value {
        Value::String(s) => s.len() + 2,
        Value::Array(items) => 2 + items.iter().map(approx_size).sum::<usize>(),
        Value::Object(map) => 2 + map.iter().map(|(k, v)| k.len() + 4 + approx_size(v)).sum::<usize>(),
        _ => 8,
    }
}

impl Inner {
    async fn request_thread(&self, method: &str, params: &Value) -> Result<Value, SessionError> {
        let attempts = guard::config_attempts(params, &self.options.everywhere_servers, self.options.role.constrained())
            .map_err(SessionError::UnsupportedPolicy)?;
        let count = attempts.len();
        for (index, attempt) in attempts.into_iter().enumerate() {
            match self.client.rpc().request_with_timeout(method, attempt.clone(), None).await {
                Ok(value) => {
                    let linked = attempt.pointer("/config/mcp_servers/milagre");
                    self.state.lock().unwrap().linked_tools_available =
                        linked.is_some_and(|v| v.get("enabled") != Some(&Value::Bool(false)));
                    return Ok(value);
                }
                Err(error) if error.is_server_error() && index + 1 < count => {}
                Err(error) => return Err(error.into()),
            }
        }
        unreachable!("there is always an initial attempt")
    }

    fn emit(&self, event: SessionEvent) {
        let bytes = match &event {
            SessionEvent::Agent(value) | SessionEvent::TurnEnded { event: value, .. } => approx_size(value),
            SessionEvent::Notification(n) => approx_size(&n.raw),
            SessionEvent::Exited(_) => 0,
        };
        // A turn's end and the exit are one each per turn / session: they always get through.
        if matches!(event, SessionEvent::Exited(_) | SessionEvent::TurnEnded { .. }) {
            return self.events.force(event, bytes);
        }
        if let Err(overflow) = self.events.send(event, bytes) {
            // Nobody reads: stop Codex rather than buffer without limit. The exit still reaches the reader.
            let mut state = self.state.lock().unwrap();
            if state.stop_detail.is_none() {
                state.stop_detail = Some(format!(
                    "Milagre stopped Codex: {} session events ({} bytes) were waiting to be read.",
                    overflow.queued_events, overflow.queued_bytes
                ));
                let client = self.client.clone();
                tokio::spawn(async move {
                    client.close().await;
                });
            }
        }
    }

    fn emit_agent(&self, mut event: Value) {
        if event["type"] == "step-completed" {
            let refused = event["id"].as_str().and_then(|id| self.state.lock().unwrap().refused.remove(id));
            if let Some((command, reason)) = refused {
                event["detail"] = format!("$ {command}\n{reason}").into();
            }
        }
        self.emit(SessionEvent::Agent(event));
    }

    /// Ends the running turn once (codex-provider.cjs `finishTurn`): cancels open requests, clears
    /// per-turn state, then emits the events, the terminal one as `TurnEnded`.
    async fn finish_turn(&self, events: Vec<Value>, crashed: bool) {
        let images = {
            let mut state = self.state.lock().unwrap();
            if !state.turn_active {
                return;
            }
            state.turn_active = false;
            state.file_changes.clear();
            std::mem::take(&mut state.input_images)
        };
        drop(images);
        self.cancel_all().await;
        let turn_id = {
            let mut mapper = self.mapper.lock().unwrap();
            mapper.end_turn();
            mapper.turn_id.clone()
        };
        let mut terminal = None;
        for event in events {
            if is_terminal(&event) && terminal.is_none() {
                terminal = Some(event);
            } else if !is_terminal(&event) {
                self.emit_agent(event);
            }
        }
        let event = terminal.unwrap_or_else(|| json!({ "type": "turn-completed" }));
        let end = turn_end(&event, crashed);
        self.emit(SessionEvent::TurnEnded { turn_id, end, event });
        self.turn_ended.send_modify(|n| *n += 1);
    }

    /// Cancels every open card. Answers are queued, not awaited: a stalled pipe can't delay the
    /// turn's end, an interrupt or a close (Node's replies are fire-and-forget too).
    async fn cancel_all(&self) {
        let open: Vec<(String, Pending)> = {
            let mut state = self.state.lock().unwrap();
            state.pending.drain(..).collect()
        };
        for (id, pending) in open {
            if pending.kind == PendingKind::Question {
                self.settle_question(&id, pending, QuestionOutcome::Cancelled);
            } else {
                self.resolve_permission(&id, pending, Decision::Cancelled);
            }
        }
    }

    async fn settle_questions(&self, outcome: QuestionOutcome) {
        let open: Vec<(String, Pending)> = {
            let mut state = self.state.lock().unwrap();
            let ids: Vec<String> =
                state.pending.iter().filter(|(_, p)| p.kind == PendingKind::Question).map(|(id, _)| id.clone()).collect();
            ids.into_iter().filter_map(|id| state.pending.shift_remove(&id).map(|p| (id, p))).collect()
        };
        for (id, pending) in open {
            self.settle_question(&id, pending, outcome.clone());
        }
    }

    fn permission_reply(pending: &Pending, decision: Decision) -> (Decision, Value) {
        let given = if decision == Decision::AllowForChat && !pending.allow_for_chat { Decision::Allow } else { decision };
        let reply = match pending.kind {
            PendingKind::McpApproval => approvals::mcp_response(given),
            _ => approvals::approval_response(given),
        };
        (given, reply)
    }

    /// A decision Milagre makes itself (cancel, a mode switch): queued, and resolved at once.
    fn resolve_permission(&self, request_id: &str, pending: Pending, decision: Decision) {
        let (given, reply) = Self::permission_reply(&pending, decision);
        // Codex may already have exited or withdrawn it; then there is nobody left to answer.
        let _ = self.client.rpc().respond_nowait(&pending.rpc_id, reply);
        self.emit_agent(json!({ "type": "permission-resolved", "requestId": request_id, "decision": decision_name(given) }));
    }

    /// The user's decision: written before the card resolves. If nothing reached Codex and it still
    /// waits, the card stays open and the error is returned.
    async fn answer_permission(&self, request_id: &str, pending: Pending, decision: Decision) -> Result<(), SessionError> {
        let (given, reply) = Self::permission_reply(&pending, decision);
        if let Err(error) = self.client.rpc().respond(&pending.rpc_id, reply).await {
            return Err(self.restore_after_failed_answer(request_id, pending, error));
        }
        self.emit_agent(json!({ "type": "permission-resolved", "requestId": request_id, "decision": decision_name(given) }));
        Ok(())
    }

    async fn answer_question(&self, request_id: &str, pending: Pending, outcome: QuestionOutcome) -> Result<(), SessionError> {
        if let Err(error) = self.client.rpc().respond(&pending.rpc_id, approvals::question_response(&outcome)).await {
            return Err(self.restore_after_failed_answer(request_id, pending, error));
        }
        self.emit_question_resolved(request_id, &outcome);
        Ok(())
    }

    fn restore_after_failed_answer(&self, request_id: &str, pending: Pending, error: RpcError) -> SessionError {
        let waiting = self.client.rpc().open_server_requests().contains(&pending.rpc_id);
        if waiting {
            self.state.lock().unwrap().pending.insert(request_id.to_string(), pending);
        }
        SessionError::Rpc(error)
    }

    fn settle_question(&self, request_id: &str, pending: Pending, outcome: QuestionOutcome) {
        let _ = self.client.rpc().respond_nowait(&pending.rpc_id, approvals::question_response(&outcome));
        self.emit_question_resolved(request_id, &outcome);
    }

    fn emit_question_resolved(&self, request_id: &str, outcome: &QuestionOutcome) {
        let name = match outcome {
            QuestionOutcome::Answered(_) => "answered",
            QuestionOutcome::Dismissed => "dismissed",
            QuestionOutcome::Cancelled => "cancelled",
        };
        self.emit_agent(json!({ "type": "question-resolved", "requestId": request_id, "outcome": name }));
    }

    fn accepting(&self) -> bool {
        let state = self.state.lock().unwrap();
        state.turn_active && !state.cancel_requested && !state.closed
    }

    /// An answer Milagre gives without asking anyone; queued so the pump never waits on the pipe.
    async fn reply(&self, id: &RequestId, result: Value) {
        let _ = self.client.rpc().respond_nowait(id, result);
    }

    /// The id cards carry: `String(id)` as in Node, made unique if Codex sends both `5` and `"5"`.
    fn public_id(state: &State, id: &RequestId) -> String {
        let base = id.to_string();
        let taken = |key: &str| state.pending.get(key).is_some_and(|p| &p.rpc_id != id);
        if !taken(&base) {
            return base;
        }
        (2..).map(|n| format!("{base}#{n}")).find(|key| !taken(key)).expect("an unused id")
    }

    /// Holds a turn-scoped notification while a turn/start is in flight after an earlier one timed
    /// out, so the abandoned turn's events can't be taken for the new one's.
    fn hold(&self, notification: &Notification) -> bool {
        let mut state = self.state.lock().unwrap();
        if !(state.starting && state.stale_start) {
            return false;
        }
        let params = &notification.params;
        let own = params.get("threadId").and_then(Value::as_str) == self.mapper.lock().unwrap().thread_id.as_deref();
        let scoped = notification.method.starts_with("turn/") || params.get("turnId").is_some_and(|t| !t.is_null());
        if own && scoped {
            state.held.push(notification.clone());
            return true;
        }
        false
    }

    /// turn/start settled: adopt the turn id it confirmed, then replay what was held in order.
    async fn release_held(self: &Arc<Self>, confirmed: Option<String>) {
        let _order = self.notifications.lock().await;
        if let Some(id) = confirmed {
            self.mapper.lock().unwrap().turn_id = Some(id);
        }
        let held = {
            let mut state = self.state.lock().unwrap();
            state.starting = false;
            std::mem::take(&mut state.held)
        };
        self.turn_ready.send_modify(|n| *n += 1);
        for notification in held {
            self.handle_notification_now(notification).await;
        }
    }

    /// permissions.cjs `insideWorkspace` over cwd and the workspace roots: canonical paths, nearest
    /// existing ancestor for new files, fails closed. Off the async threads, since it touches the disk.
    async fn in_workspace(&self, files: Vec<String>) -> bool {
        let cwd = PathBuf::from(&self.options.cwd);
        let roots: Vec<PathBuf> =
            std::iter::once(self.options.cwd.clone()).chain(self.options.workspace_roots.iter().cloned()).map(PathBuf::from).collect();
        tokio::task::spawn_blocking(move || crate::workspace::inside_workspace(&roots, &files, &cwd)).await.unwrap_or(false)
    }

    /// `PendingPermissions.add`: Full answers at once; otherwise a card.
    async fn add_permission(&self, id: RequestId, card: Value, kind: PendingKind, workspace_files: Option<Vec<String>>) {
        let allow_for_chat = card.get("allowForChat") == Some(&Value::Bool(true));
        let mut card = card;
        let decision = loop {
            let mode = self.state.lock().unwrap().mode;
            let in_workspace = match (&workspace_files, mode) {
                (Some(files), Some(PermissionMode::Auto)) => self.in_workspace(files.clone()).await,
                _ => false,
            };
            let mut state = self.state.lock().unwrap();
            // Mode changes can finish while the filesystem check awaits, before this card exists.
            // Retry under the new mode; the decision and insertion share this lock.
            if state.mode != mode {
                continue;
            }
            if !state.turn_active || state.cancel_requested || state.closed {
                break Some(Decision::Cancelled);
            }
            if mode == Some(PermissionMode::Full) || (mode == Some(PermissionMode::Auto) && in_workspace) {
                break Some(Decision::Allow);
            }
            let request_id = Self::public_id(&state, &id);
            card["requestId"] = request_id.clone().into();
            state.pending.insert(request_id, Pending { rpc_id: id.clone(), kind, allow_for_chat, workspace_files, question_ids: vec![] });
            break None;
        };
        if let Some(decision) = decision {
            let reply =
                if kind == PendingKind::McpApproval { approvals::mcp_response(decision) } else { approvals::approval_response(decision) };
            return self.reply(&id, reply).await;
        }
        let mut event = json!({ "type": "permission-request" });
        if let (Some(target), Value::Object(fields)) = (event.as_object_mut(), card) {
            target.extend(fields);
        }
        self.emit_agent(event);
    }

    async fn handle_request(&self, request: ServerRequest) {
        let ServerRequest { id, method, params, .. } = request;
        let analysis = self.options.role == SessionRole::AnalysisAdvisor;
        let escalation = matches!(self.options.role, SessionRole::Escalation { .. });
        match method.as_str() {
            methods::MCP_ELICITATION => {
                let card = approvals::mcp_request(&id, &params);
                let ungated: Vec<&str> = self.options.ungated_milagre_tools.iter().map(String::as_str).collect();
                if !self.accepting() {
                    self.reply(&id, approvals::mcp_response(Decision::Cancelled)).await;
                } else if analysis || card.is_none() {
                    self.reply(&id, approvals::mcp_response(Decision::Deny)).await;
                } else if let SessionRole::Escalation { requests } = &self.options.role {
                    let tool = approvals::milagre_mcp_tool(&params).unwrap_or_default();
                    let tools = self.options.linked_tools.as_ref().map(|l| l.tools.as_slice()).unwrap_or(&[]);
                    let known = tools.iter().find(|t| t.name == tool);
                    let is_milagre = params.get("serverName").and_then(Value::as_str) == Some("milagre");
                    let calls = self.state.lock().unwrap().escalation_items.len();
                    let denial = guard::escalation_denial(
                        requests,
                        calls,
                        &tool,
                        &params["_meta"]["tool_params"],
                        known.is_some_and(|t| t.read_only),
                    );
                    let allow = is_milagre && known.is_some() && denial.is_none();
                    self.reply(&id, approvals::mcp_response(if allow { Decision::Allow } else { Decision::Deny })).await;
                } else if matches!(self.options.role, SessionRole::Babysit { .. }) {
                    // This checkpoint supports babysit shell gates only, no MCP write classifier.
                    self.reply(&id, approvals::mcp_response(Decision::Deny)).await;
                } else if approvals::is_ungated_milagre_tool_approval(&params, &ungated) {
                    self.reply(&id, approvals::mcp_response(Decision::Allow)).await;
                } else if let Some(card) = card {
                    self.add_permission(id, card, PendingKind::McpApproval, None).await;
                }
            }
            methods::COMMAND_APPROVAL | methods::FILE_CHANGE_APPROVAL => {
                if analysis || escalation {
                    return self.reply(&id, approvals::approval_response(Decision::Deny)).await;
                }
                if !self.accepting() {
                    return self.reply(&id, approvals::approval_response(Decision::Cancelled)).await;
                }
                if method == methods::COMMAND_APPROVAL {
                    let command = params.get("command").and_then(Value::as_str).filter(|s| !s.trim().is_empty());
                    let actions = command.and_then(|command| {
                        self.options.command_classifier.as_ref().map(|classifier| guard::classify_command(classifier.as_ref(), command))
                    });
                    let writes_remote = !matches!(&actions, Some(Ok(actions)) if actions.is_empty());
                    if let SessionRole::Babysit { level, resolve_threads } = self.options.role {
                        let denial = match &actions {
                            Some(Ok(actions)) => guard::babysit_denial(actions, level, resolve_threads),
                            _ => Some("Babysitting cannot classify this command; it was refused.".into()),
                        };
                        if let Some(reason) = denial {
                            if let Some(item) = params.get("itemId").and_then(Value::as_str) {
                                let mut state = self.state.lock().unwrap();
                                // Denials still work after the annotation budget fills. Keep an
                                // endless stream of refused commands from growing session memory.
                                if state.refused.len() < 1024 {
                                    state.refused.insert(item.into(), (approvals::cap_text(command.unwrap_or_default()), reason));
                                }
                            }
                            return self.reply(&id, approvals::approval_response(Decision::Deny)).await;
                        }
                    }
                    let card = approvals::command_request(&id, &params, |_| writes_remote);
                    self.add_permission(id, card, PendingKind::Approval, None).await;
                } else {
                    let item = params.get("itemId").and_then(Value::as_str).unwrap_or_default();
                    let changes = self.state.lock().unwrap().file_changes.get(item).cloned().unwrap_or_default();
                    let card = approvals::file_request(&id, &params, &changes);
                    // Never authorize display-coerced paths or a request to grant a new root.
                    let workspace_files =
                        if crate::codex::js::truthy(params.get("grantRoot")) { None } else { approvals::workspace_files(&changes) };
                    self.add_permission(id, card, PendingKind::Approval, workspace_files).await;
                }
            }
            methods::REQUEST_USER_INPUT => {
                let card = approvals::question_request(&id, &params);
                match card {
                    Some(mut card) if !analysis && !escalation && self.accepting() => {
                        let question_ids = card["questions"]
                            .as_array()
                            .map(|qs| qs.iter().filter_map(|q| q["id"].as_str().map(str::to_string)).collect())
                            .unwrap_or_default();
                        let mut state = self.state.lock().unwrap();
                        let request_id = Self::public_id(&state, &id);
                        card["requestId"] = request_id.clone().into();
                        state.pending.insert(
                            request_id,
                            Pending { rpc_id: id, kind: PendingKind::Question, allow_for_chat: false, workspace_files: None, question_ids },
                        );
                        drop(state);
                        let mut event = json!({ "type": "question-request" });
                        if let (Some(target), Value::Object(fields)) = (event.as_object_mut(), card) {
                            target.extend(fields);
                        }
                        self.emit_agent(event);
                    }
                    _ if analysis || escalation => self.reply(&id, approvals::question_response(&QuestionOutcome::Dismissed)).await,
                    _ => self.reply(&id, approvals::question_response(&QuestionOutcome::Cancelled)).await,
                }
            }
            methods::PERMISSIONS_APPROVAL => self.reply(&id, approvals::no_extra_permissions_response()).await,
            other => {
                let _ = self.client.rpc().respond_error(&id, &format!("Milagre does not support {other} yet.")).await;
            }
        }
    }

    async fn handle_notification(self: &Arc<Self>, notification: Notification) {
        let _order = self.notifications.lock().await;
        if self.hold(&notification) {
            return;
        }
        self.handle_notification_now(notification).await;
    }

    async fn handle_notification_now(self: &Arc<Self>, notification: Notification) {
        if self.options.forward_raw_notifications {
            self.emit(SessionEvent::Notification(notification.clone()));
        }
        let method = notification.method.as_str();
        let params = &notification.params;
        if matches!(self.options.role, SessionRole::Escalation { .. }) && method == methods::ITEM_STARTED {
            let current = {
                let mapper = self.mapper.lock().unwrap();
                params.get("threadId").and_then(Value::as_str) == mapper.thread_id.as_deref()
                    && mapper.turn_id.is_some()
                    && params.get("turnId").and_then(Value::as_str) == mapper.turn_id.as_deref()
            };
            let tool = params.pointer("/item/type").and_then(Value::as_str).is_some_and(|kind| {
                matches!(
                    kind,
                    "commandExecution"
                        | "fileChange"
                        | "mcpToolCall"
                        | "dynamicToolCall"
                        | "webSearch"
                        | "imageView"
                        | "collabAgentToolCall"
                )
            });
            if current && tool {
                if let Some(id) = params.pointer("/item/id").and_then(Value::as_str) {
                    let stop = {
                        let mut state = self.state.lock().unwrap();
                        let stop = state.turn_active
                            && !state.cancel_requested
                            && state.escalation_items.insert(id.into())
                            && state.escalation_items.len() == guard::ESCALATION_TOOL_CALLS + guard::ESCALATION_TOOL_GRACE + 1;
                        if stop {
                            state.cancel_requested = true;
                            Some(state.turn_generation)
                        } else {
                            None
                        }
                    };
                    if let Some(generation) = stop {
                        // Bind interruption to this turn. A delayed task must not cancel its successor.
                        let thread = params["threadId"].as_str().unwrap().to_string();
                        let turn = params["turnId"].as_str().unwrap().to_string();
                        let mut ended = self.turn_ended.subscribe();
                        let inner = self.clone();
                        tokio::spawn(async move {
                            {
                                let state = inner.state.lock().unwrap();
                                if !state.turn_active || state.turn_generation != generation {
                                    return;
                                }
                            }
                            let deadline = tokio::time::Instant::now() + inner.options.interrupt_grace;
                            let result = inner.client.turn_interrupt(&thread, &turn, inner.options.interrupt_grace).await;
                            if result.is_ok() && tokio::time::timeout_at(deadline, ended.changed()).await.is_ok() {
                                return;
                            }
                            let stop = {
                                let mut state = inner.state.lock().unwrap();
                                if state.turn_active && state.turn_generation == generation {
                                    state.closed = true;
                                    true
                                } else {
                                    false
                                }
                            };
                            if stop {
                                CodexSession { inner }.stop_now().await;
                            }
                        });
                    }
                }
            }
        }

        if method == methods::ITEM_STARTED && params.pointer("/item/type").and_then(Value::as_str) == Some("fileChange") {
            if let Some(id) = params.pointer("/item/id") {
                let changes = params.pointer("/item/changes").and_then(Value::as_array).cloned().unwrap_or_default();
                self.state.lock().unwrap().file_changes.insert(crate::codex::js::js_string(Some(id)), changes);
            }
        }
        if method == methods::SERVER_REQUEST_RESOLVED {
            if let Some(id) = params.get("requestId").and_then(RequestId::from_value) {
                let removed = {
                    let mut state = self.state.lock().unwrap();
                    let key = state.pending.iter().find(|(_, p)| p.rpc_id == id).map(|(key, _)| key.clone());
                    key.and_then(|key| state.pending.shift_remove(&key).map(|p| (key, p)))
                };
                if let Some((request_id, pending)) = removed {
                    self.emit_agent(if pending.kind == PendingKind::Question {
                        json!({ "type": "question-resolved", "requestId": request_id, "outcome": "cancelled" })
                    } else {
                        json!({ "type": "permission-resolved", "requestId": request_id, "decision": "cancelled" })
                    });
                }
            }
        }
        if method == methods::TURN_STARTED {
            let thread = params.get("threadId").and_then(Value::as_str).unwrap_or_default().to_string();
            let active = self.state.lock().unwrap().turn_active;
            let mut mapper = self.mapper.lock().unwrap();
            // A turn this session isn't running (its start acknowledgement timed out) would open a run nothing ends.
            if !active && !mapper.subagents.contains_key(&thread) {
                return;
            }
            let started = params.pointer("/turn/id").and_then(Value::as_str);
            if mapper.thread_id.as_deref() == Some(thread.as_str()) {
                match (&mapper.turn_id, started) {
                    (None, _) => mapper.turn_id = started.map(str::to_string),
                    // Another turn of this thread (one whose start timed out) is not this turn's start.
                    (Some(current), Some(started)) if current != started => return,
                    _ => {}
                }
            }
        }
        let (mut events, recheck) = {
            let mut mapper = self.mapper.lock().unwrap();
            let events = map_codex_notification(method, params, &mut mapper);
            (events, mapper.recheck_pending())
        };
        if method == "item/completed" {
            if let Some(item) = params.get("item") {
                let id = crate::codex::js::js_string(item.get("id"));
                if events.iter().any(|e| e["type"] == "step-completed" && e["id"] == id) {
                    self.save_images(item, &mut events).await;
                }
            }
        }
        if recheck || events.iter().any(|e| e["type"] == "subagent-update") {
            self.schedule_subagents();
        }
        if !events.iter().any(is_terminal) {
            for event in events {
                self.emit_agent(event);
            }
            return;
        }
        let cancel = self.state.lock().unwrap().cancel_requested;
        let logged_out = !cancel && events.iter().any(|e| e.get("login") == Some(&Value::Bool(true)));
        let events = if cancel {
            events.into_iter().map(|e| if is_terminal(&e) { json!({ "type": "turn-cancelled" }) } else { e }).collect()
        } else {
            events
        };
        self.finish_turn(events, false).await;
        // An app-server that answered 401 holds the old credentials; the owner starts a fresh session.
        if logged_out {
            let client = self.client.clone();
            self.state.lock().unwrap().closed = true;
            tokio::spawn(async move {
                client.close().await;
            });
        }
    }

    async fn save_images(&self, item: &Value, events: &mut Vec<Value>) {
        let Some(store) = self.options.image_store.clone() else { return };
        let Ok(permit) = self.image_worker.clone().try_acquire_owned() else { return };
        let (generation, jobs) = {
            let mut state = self.state.lock().unwrap();
            if !state.turn_active || state.cancel_requested || state.closed {
                return;
            }
            (state.turn_generation, images::image_jobs(item, &mut state.output_budget))
        };
        if jobs.is_empty() {
            return;
        }
        // The callback cannot retain the session/process. On timeout the permit stays with it,
        // preventing unbounded detached blocking work even when a host callback never returns.
        let worker = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            images::save_jobs(jobs, store.0.as_ref())
        });
        let Ok(Ok(saved)) = tokio::time::timeout(self.options.image_save_timeout, worker).await else { return };
        let state = self.state.lock().unwrap();
        if state.turn_active && state.turn_generation == generation && !state.cancel_requested && !state.closed {
            images::apply_saved(events, saved);
        }
    }

    fn should_poll(&self, agent: &Value, mapper: &mut CodexEventState) -> bool {
        let id = agent.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
        let now = mapper.now();
        subagent_active(agent) || mapper.subagent_recheck_until.get(&id).is_some_and(|until| *until > now)
    }

    /// Polls subagent threads every interval while one is active (codex-provider.cjs `scheduleSubagents`).
    fn schedule_subagents(self: &Arc<Self>) {
        if self.state.lock().unwrap().closed || self.poll_scheduled.swap(true, Ordering::AcqRel) {
            return;
        }
        let inner = Arc::downgrade(self);
        let interval = self.options.subagent_poll_interval;
        tokio::spawn(async move {
            tokio::time::sleep(interval).await;
            let Some(inner) = inner.upgrade() else { return };
            inner.poll_scheduled.store(false, Ordering::Release);
            inner.poll_subagents().await;
            let again = {
                let mut mapper = inner.mapper.lock().unwrap();
                let agents: Vec<Value> = mapper.subagents.values().cloned().collect();
                agents.iter().any(|agent| inner.should_poll(agent, &mut mapper))
            };
            if again {
                inner.schedule_subagents();
            }
        });
    }

    async fn read_subagent_thread(
        &self,
        thread_id: &str,
        previous: Option<&ChildHistory>,
    ) -> Result<(Value, Vec<Value>, Option<String>), RpcError> {
        let thread = self.client.thread_read(thread_id, false).await?.get("thread").cloned().unwrap_or(Value::Null);
        let cursor = previous.and_then(|p| p.cursor.clone());
        let newest = self
            .client
            .thread_turns_list(json!({ "threadId": thread_id, "limit": if cursor.is_some() { 1 } else { 20 }, "sortDirection": "desc", "itemsView": "full" }))
            .await?;
        let backwards = newest.get("backwardsCursor").and_then(Value::as_str).map(str::to_string);
        let Some(mut cursor) = cursor else {
            let mut turns = newest.get("data").and_then(Value::as_array).cloned().unwrap_or_default();
            turns.reverse();
            return Ok((thread, turns, backwards));
        };
        let start = cursor.clone();
        let mut turns = Vec::new();
        let mut seen = std::collections::HashSet::new();
        // The opposite-direction cursor includes its anchor turn, so an active item can grow without getting lost.
        while seen.insert(cursor.clone()) {
            let page = self
                .client
                .thread_turns_list(
                    json!({ "threadId": thread_id, "cursor": cursor, "limit": 20, "sortDirection": "asc", "itemsView": "full" }),
                )
                .await?;
            turns.extend(page.get("data").and_then(Value::as_array).cloned().unwrap_or_default());
            match page.get("nextCursor").and_then(Value::as_str) {
                Some(next) if !next.is_empty() => cursor = next.to_string(),
                _ => break,
            }
        }
        Ok((thread, turns, backwards.or(Some(start))))
    }

    /// Reads each subagent thread that may have changed and maps new or changed items through the
    /// same mapper, never replaying finished history (codex-provider.cjs `pollSubagents`).
    async fn poll_subagents(&self) {
        let mut histories = self.polling.lock().await;
        let agents: Vec<Value> = self.mapper.lock().unwrap().subagents.values().cloned().collect();
        for agent in agents {
            if self.state.lock().unwrap().closed {
                return;
            }
            let id = agent.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
            let previous = histories.get(&id).cloned();
            let poll = self.should_poll(&agent, &mut self.mapper.lock().unwrap());
            if !poll && previous.as_ref().is_some_and(|p| p.finished) {
                continue;
            }
            // A live child may not have flushed its history yet: retry from the last cursor next time.
            let Ok((thread, turns, cursor)) = self.read_subagent_thread(&id, previous.as_ref()).await else { continue };
            if self.state.lock().unwrap().closed {
                return;
            }
            let mut items = HashMap::new();
            let mut events = Vec::new();
            {
                let mut mapper = self.mapper.lock().unwrap();
                for turn in &turns {
                    let done = matches!(turn.get("status").and_then(Value::as_str), Some("completed" | "failed" | "interrupted"));
                    for item in turn.get("items").and_then(Value::as_array).cloned().unwrap_or_default() {
                        let key =
                            format!("{}:{}", crate::codex::js::js_string(turn.get("id")), crate::codex::js::js_string(item.get("id")));
                        let old = previous.as_ref().and_then(|p| p.items.get(&key).cloned());
                        items.insert(key, if done { None } else { Some(item.clone()) });
                        match old {
                            Some(None) => continue,
                            Some(Some(old)) if old == item => continue,
                            _ => {}
                        }
                        events.extend(map_codex_notification("item/completed", &json!({ "threadId": id, "item": item }), &mut mapper));
                    }
                }
                let last = turns.last();
                let outcome = json!({ "status": thread.get("status"), "turnId": last.and_then(|t| t.get("id")), "turnStatus": last.and_then(|t| t.get("status")) });
                let agent_status = mapper.subagents.get(&id).and_then(|a| a.get("status")).cloned();
                let changed = previous.as_ref().and_then(|p| p.outcome.as_ref()) != Some(&outcome)
                    || previous.as_ref().and_then(|p| p.agent_status.clone()) != agent_status;
                if changed {
                    let status_type = thread.pointer("/status/type").and_then(Value::as_str);
                    let last_status = last.and_then(|t| t.get("status")).and_then(Value::as_str);
                    if matches!(status_type, Some("active" | "systemError")) {
                        events.extend(map_codex_notification(
                            "thread/status/changed",
                            &json!({ "threadId": id, "status": thread["status"] }),
                            &mut mapper,
                        ));
                    } else if last_status == Some("inProgress") {
                        events.extend(map_codex_notification("turn/started", &json!({ "threadId": id, "turn": last }), &mut mapper));
                    } else if matches!(last_status, Some("completed" | "failed" | "interrupted")) {
                        events.extend(map_codex_notification("turn/completed", &json!({ "threadId": id, "turn": last }), &mut mapper));
                    }
                }
                let current = mapper.subagents.get(&id).cloned().unwrap_or(Value::Null);
                histories.insert(
                    id.clone(),
                    ChildHistory {
                        cursor,
                        items,
                        outcome: Some(outcome),
                        agent_status: current.get("status").cloned(),
                        finished: !subagent_active(&current),
                    },
                );
            }
            for event in events {
                self.emit_agent(event);
            }
        }
    }
}

fn decision_name(decision: Decision) -> &'static str {
    match decision {
        Decision::Allow => "allow",
        Decision::AllowForChat => "allow-for-chat",
        Decision::Deny => "deny",
        Decision::Cancelled => "cancelled",
    }
}

fn turn_end(event: &Value, crashed: bool) -> TurnEnd {
    let message = event.get("message").and_then(Value::as_str).unwrap_or_default().to_string();
    match event.get("type").and_then(Value::as_str) {
        Some("turn-cancelled") => TurnEnd::Cancelled,
        Some("turn-failed") if crashed => TurnEnd::Crashed { message },
        Some("turn-failed") => TurnEnd::Failed { message },
        _ => TurnEnd::Completed,
    }
}

/// Ends a turn whose `turn/start` caller stopped waiting: replays anything held, then stops the
/// turn as Stop would (interrupt once its id is known, else kill after the grace).
struct StartGuard {
    inner: Option<Arc<Inner>>,
}

impl Drop for StartGuard {
    fn drop(&mut self) {
        let Some(inner) = self.inner.take() else { return };
        inner.state.lock().unwrap().cancel_requested = true;
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                inner.release_held(None).await;
                CodexSession { inner }.interrupt_requested().await;
            });
        }
    }
}

async fn pump(inner: Weak<Inner>, mut events: EventReceiver<ServerEvent>) {
    while let Some(event) = events.recv().await {
        // Every CodexSession is gone: the client went with it and the process is being killed.
        let Some(inner) = inner.upgrade() else { return };
        match event {
            ServerEvent::Notification(notification) => inner.handle_notification(notification).await,
            ServerEvent::Request(request) => inner.handle_request(request).await,
            ServerEvent::Diagnostic(_) => {}
            ServerEvent::Exit(exit) => {
                let (cancelled, stop_detail) = {
                    let mut state = inner.state.lock().unwrap();
                    state.closed = true;
                    (state.cancel_requested, state.stop_detail.clone())
                };
                let settled = settle_subagents(&mut inner.mapper.lock().unwrap(), if cancelled { "cancelled" } else { "failed" });
                for event in settled {
                    inner.emit_agent(event);
                }
                let terminal = if cancelled {
                    json!({ "type": "turn-cancelled" })
                } else {
                    let detail = stop_detail.unwrap_or_else(|| exit.detail.clone());
                    let signal = exit.signal.map(signal_name);
                    failed_with(&crash_message(&detail, signal.as_deref()), &[])
                };
                inner.finish_turn(vec![terminal], !cancelled).await;
                // Shells and MCP servers left in the group outlive the leader unless stopped here.
                inner.client.close().await;
                inner.emit(SessionEvent::Exited(exit));
                return;
            }
        }
    }
}

/// Reopening an idle Chat need not start or resume an agent: only its saved subagents with status
/// "unknown" are checked, and history items are never replayed (codex-provider.cjs
/// `recoverCodexSubagents`). Returns `subagent-update` events for the ones that finished.
pub async fn recover_codex_subagents(connect: ConnectOptions, agents: &[Value]) -> Vec<Value> {
    let unknown: Vec<&Value> = agents
        .iter()
        .filter(|a| a.get("status").and_then(Value::as_str) == Some("unknown") && a.get("archived") != Some(&Value::Bool(true)))
        .collect();
    if unknown.is_empty() {
        return vec![];
    }
    let mut connect = connect;
    connect.initialize_timeout = Some(Duration::from_secs(5));
    let Ok((client, _events)) = CodexClient::connect(connect).await else { return vec![] };
    let mut results = Vec::new();
    for agent in &unknown {
        let id = agent.get("id").and_then(Value::as_str).unwrap_or_default();
        results.push(read_latest_child_turn(&client, id).await.ok());
    }
    client.close().await;
    let now = crate::codex::events::system_millis();
    unknown
        .into_iter()
        .zip(results)
        .filter_map(|(agent, thread)| {
            let thread = thread?;
            if thread.pointer("/status/type").and_then(Value::as_str) == Some("active") {
                return None;
            }
            let last = thread.get("turns").and_then(Value::as_array).and_then(|t| t.last())?;
            let status = match last.get("status").and_then(Value::as_str) {
                Some("completed") => "completed",
                Some("failed") => "failed",
                Some("interrupted") => "cancelled",
                _ => return None,
            };
            let time = now.max(agent.get("updatedAt").and_then(Value::as_i64).unwrap_or(0));
            let mut updated = agent.clone();
            updated["status"] = status.into();
            updated["updatedAt"] = time.into();
            if updated.get("endedAt").is_none_or(Value::is_null) {
                updated["endedAt"] = time.into();
            }
            if agent.get("latestActivity").and_then(Value::as_str).is_some_and(|a| a.starts_with("Session disconnected.")) {
                updated["latestActivity"] = match status {
                    "completed" => "Finished",
                    "failed" => "Failed",
                    _ => "Cancelled",
                }
                .into();
            }
            Some(json!({ "type": "subagent-update", "agent": updated }))
        })
        .collect()
}

async fn read_latest_child_turn(client: &CodexClient, thread_id: &str) -> Result<Value, RpcError> {
    let thread = client.thread_read(thread_id, false).await?.get("thread").cloned().unwrap_or(Value::Null);
    if thread.pointer("/status/type").and_then(Value::as_str) == Some("active") {
        return Ok(thread);
    }
    match client.thread_turns_list(json!({ "threadId": thread_id, "limit": 1, "sortDirection": "desc", "itemsView": "notLoaded" })).await {
        Ok(page) => {
            let mut thread = thread;
            let first: Vec<Value> =
                page.get("data").and_then(Value::as_array).map(|d| d.iter().take(1).cloned().collect()).unwrap_or_default();
            thread["turns"] = Value::Array(first);
            Ok(thread)
        }
        // Older providers do not have the paginated endpoint.
        Err(error) if error.is_server_error() => {
            Ok(client.thread_read(thread_id, true).await?.get("thread").cloned().unwrap_or(Value::Null))
        }
        Err(error) => Err(error),
    }
}

/// Node promptImageBlocks ordering for existing host-owned paths. Does not manage their lifetime.
pub fn prompt_input(prompt: &str, image_paths: &[String]) -> Vec<Value> {
    images::prompt_input(prompt, image_paths)
}

impl TurnSettings {
    pub fn with_images(mut self, images: PreparedImages) -> Self {
        self.input = images.input().to_vec();
        self.input_images = Some(images);
        self
    }
}

fn retain_images(state: &mut State, images: Option<&PreparedImages>) -> Result<(), SessionError> {
    if let Some(images) = images {
        if images.paths().is_empty() {
            return Ok(());
        }
        if !state.input_budget.reserve(images.paths().len(), images.byte_len()) {
            return Err(SessionError::ImageBudget);
        }
        state.input_images.push(images.clone());
    }
    Ok(())
}

/// Default `ThreadSettings` for a Chat: Milagre's `THREAD_CONFIG`.
pub fn chat_thread(model: Option<String>, policy: CodexPolicy) -> ThreadSettings {
    ThreadSettings {
        model,
        policy,
        developer_instructions: None,
        config: Some(crate::codex::protocol::thread_config()),
        extra: Default::default(),
    }
}

/// Default `TurnSettings`.
pub fn turn(input: Vec<Value>, model: Option<String>, policy: CodexPolicy) -> TurnSettings {
    TurnSettings {
        input,
        input_images: None,
        model,
        effort: None,
        policy,
        permission_mode: None,
        service_tier: "default".into(),
        start_timeout: None,
        extra: Default::default(),
    }
}

#[allow(dead_code)]
fn _assert_send() {
    fn is_send<T: Send + Sync>() {}
    is_send::<CodexSession>();
}

fn validate_options(options: &SessionOptions, thread: &ThreadSettings) -> Result<(), SessionError> {
    let fail = |text: &str| SessionError::UnsupportedPolicy(text.into());
    if !thread.extra.is_empty() {
        return Err(fail("unvalidated thread extra parameters"));
    }
    if matches!(options.role, SessionRole::ExecutionAdvisor) {
        return Err(fail("execution advisors are not implemented"));
    }
    if let SessionRole::Babysit { level, .. } = options.role {
        if !(1..=5).contains(&level) {
            return Err(fail("babysit level must be 1 through 5"));
        }
        if options.command_classifier.is_none() {
            return Err(fail("babysit requires an owner CommandClassifier"));
        }
        if options.linked_tools.is_some() {
            return Err(fail("babysit MCP tools require an unimplemented MCP write guard"));
        }
    }
    if let SessionRole::Escalation { requests } = &options.role {
        if requests.is_empty() || requests.iter().any(|r| r.chat_id.is_empty() || r.request_id.is_empty()) {
            return Err(fail("escalation requires nonempty authorized chat/request IDs"));
        }
    }
    if options.role.constrained() && thread.config.as_ref().is_some_and(|c| c != &crate::codex::protocol::thread_config()) {
        return Err(fail("constrained config is constructed by the adapter, not caller overrides"));
    }
    if let Some(linked) = &options.linked_tools {
        if options.role == SessionRole::Ordinary {
            return Err(fail("ordinary linked tools must be supplied in ThreadSettings.config"));
        }
        if linked.url.trim().is_empty() {
            return Err(fail("linked MCP URL is empty"));
        }
        let mut names = std::collections::HashSet::new();
        for tool in &linked.tools {
            if tool.name.is_empty() || !names.insert(&tool.name) {
                return Err(fail("linked tool manifest has empty or duplicate names"));
            }
            if !tool.read_only && !(matches!(options.role, SessionRole::Escalation { .. }) && tool.name == "chat_respond") {
                return Err(fail("constrained host tools must be read-only except escalation chat_respond"));
            }
        }
    }
    validate_policy(&options.role, &thread.policy)?;
    // Validate ordinary config before spawning even if the provider would accept malformed fields.
    let params = thread.config.as_ref().map(|c| json!({"config":c})).unwrap_or(json!({}));
    guard::config_attempts(&params, &options.everywhere_servers, false).map_err(SessionError::UnsupportedPolicy)?;
    Ok(())
}

fn validate_policy(role: &SessionRole, policy: &CodexPolicy) -> Result<(), SessionError> {
    // Constrained read-only roles replace every supplied sandbox/approval field.
    if role.denies_edits() {
        return Ok(());
    }
    let valid = match policy.sandbox {
        "danger-full-access" => {
            policy.sandbox_policy == json!({"type":"dangerFullAccess"})
                && (policy.approval_policy == "never"
                    || (matches!(role, SessionRole::Babysit { .. }) && policy.approval_policy == "untrusted"))
        }
        "workspace-write" => {
            let roots = policy.sandbox_policy.get("writableRoots").and_then(Value::as_array);
            matches!(policy.approval_policy, "untrusted" | "on-request")
                && roots.is_some_and(|roots| roots.iter().all(Value::is_string))
                && policy.sandbox_policy
                    == json!({
                        "type":"workspaceWrite", "writableRoots":roots, "networkAccess":false,
                        "excludeTmpdirEnvVar":false, "excludeSlashTmp":false,
                    })
        }
        _ => false,
    };
    if !valid {
        return Err(SessionError::UnsupportedPolicy("sandbox/approval policy requires an explicit supported session role".into()));
    }
    Ok(())
}

fn validate_turn(role: &SessionRole, turn: &TurnSettings) -> Result<(), SessionError> {
    if !turn.extra.is_empty() {
        return Err(SessionError::UnsupportedPolicy("unvalidated turn extra parameters".into()));
    }
    validate_policy(role, &turn.policy)
}

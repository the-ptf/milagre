//! One Codex thread and its turns: codex-provider.cjs `CodexSession` without host I/O. It starts or
//! resumes the thread, starts / steers / interrupts turns, maps notifications to Milagre agent events
//! (events.rs), routes server requests into Milagre permission and question requests with
//! `PendingPermissions` / `PendingQuestions` semantics, and polls native subagent threads.
//!
//! Every Milagre event comes out as [`SessionEvent::Agent`] (the `AgentEvent` JSON contract), except
//! the one terminal event of each turn, which comes as [`SessionEvent::TurnEnded`] with that JSON in
//! `event`. Raw notifications are forwarded only with [`SessionOptions::forward_raw_notifications`].
//!
//! Not here (host or owner work, see README): babysit guards and wake escalation, WorkspaceAccess
//! auto-answers beyond "auto allows edits inside the workspace", MCP extras and the config retry
//! ladder, image files (turn input, generated and tool images), session instructions.

use crate::codex::approvals::{self, Decision, QuestionOutcome};
use crate::codex::client::{CodexClient, ConnectError, ConnectOptions, ResumeError};
use crate::codex::events::{crash_message, failed_with, is_terminal, map_codex_notification, CodexEventState};
use crate::codex::protocol::{methods, CodexPolicy, PermissionMode, RequestId};
use crate::codex::rpc::{signal_name, ExitInfo, Notification, RpcError, ServerEvent, ServerRequest};
use crate::codex::subagents::{active as subagent_active, settle_subagents};
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
    pub cwd: String,
    /// Other roots the session owns; edits inside them are allowed without a card in Auto.
    pub workspace_roots: Vec<String>,
    /// Resume this thread instead of starting one.
    pub resume_thread_id: Option<String>,
    /// codex-provider.cjs `interruptGraceMs`.
    pub interrupt_grace: Duration,
    /// milagre MCP tools whose Codex approval is answered "allow" without a card.
    pub ungated_milagre_tools: Vec<String>,
    /// Advisors: every approval is refused and questions are dismissed.
    pub analysis_only: bool,
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
            cwd: cwd.into(),
            workspace_roots: Vec::new(),
            resume_thread_id: None,
            interrupt_grace: Duration::from_secs(3),
            ungated_milagre_tools: approvals::MILAGRE_UNGATED_TOOLS.iter().map(|s| s.to_string()).collect(),
            analysis_only: false,
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
    /// Any further top-level params, merged last (e.g. `environments: []` for advisors).
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone)]
pub struct TurnSettings {
    pub input: Vec<Value>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub policy: CodexPolicy,
    /// The Chat's mode, for answering approvals (Full allows, Auto allows workspace edits).
    pub permission_mode: Option<PermissionMode>,
    /// `serviceTierForTurn`; codex-provider.cjs sends `"default"` unless fast mode is on.
    pub service_tier: String,
    /// Overrides [`SessionOptions::turn_start_timeout`] for this turn.
    pub start_timeout: Option<Duration>,
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
        options: SessionOptions,
        thread: ThreadSettings,
    ) -> Result<(CodexSession, EventReceiver<SessionEvent>), SessionError> {
        let (client, rpc_events) = CodexClient::connect(options.connect.clone()).await?;
        let (events, events_rx) = queue::channel(options.event_queue);
        let mapper = CodexEventState::new(options.resume_thread_id.clone());
        let inner = Arc::new(Inner {
            client,
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
        let mut params = serde_json::Map::new();
        params.insert("cwd".into(), inner.options.cwd.clone().into());
        if let Some(model) = &thread.model {
            params.insert("model".into(), model.clone().into());
        }
        params.insert("approvalPolicy".into(), thread.policy.approval_policy.into());
        params.insert("sandbox".into(), thread.policy.sandbox.into());
        if let Some(instructions) = &thread.developer_instructions {
            params.insert("developerInstructions".into(), instructions.clone().into());
        }
        if let Some(config) = &thread.config {
            params.insert("config".into(), config.clone());
        }
        params.extend(thread.extra.clone());
        let result = match &inner.options.resume_thread_id {
            Some(id) => inner.client.thread_resume(id, Value::Object(params)).await?,
            None => inner.client.thread_start(Value::Object(params)).await?,
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
        self.steer(turn.input.clone()).await
    }

    /// Starts a turn (a running one is steered instead, as [`CodexSession::send`]). Returns the
    /// turn id when Codex gave one. On failure the turn has already ended (`turn-failed` or
    /// `turn-cancelled`).
    pub async fn start_turn(&self, turn: TurnSettings) -> Result<SendOutcome, SessionError> {
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
                state.turn_active = true;
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
        params.insert("approvalPolicy".into(), turn.policy.approval_policy.into());
        params.insert("sandboxPolicy".into(), turn.policy.sandbox_policy);
        params.extend(turn.extra);
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
        let (thread_id, turn_id) = {
            let state = self.inner.state.lock().unwrap();
            if !state.turn_active || state.cancel_requested {
                return Err(SessionError::NoTurn);
            }
            let mapper = self.inner.mapper.lock().unwrap();
            match (&mapper.thread_id, &mapper.turn_id) {
                (Some(thread), Some(turn)) => (thread.clone(), turn.clone()),
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
        if self.inner.options.analysis_only {
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

    fn emit_agent(&self, event: Value) {
        self.emit(SessionEvent::Agent(event));
    }

    /// Ends the running turn once (codex-provider.cjs `finishTurn`): cancels open requests, clears
    /// per-turn state, then emits the events, the terminal one as `TurnEnded`.
    async fn finish_turn(&self, events: Vec<Value>, crashed: bool) {
        {
            let mut state = self.state.lock().unwrap();
            if !state.turn_active {
                return;
            }
            state.turn_active = false;
            state.file_changes.clear();
        }
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
        let mode = self.state.lock().unwrap().mode;
        let in_workspace = match (&workspace_files, mode) {
            (Some(files), Some(PermissionMode::Auto)) => self.in_workspace(files.clone()).await,
            _ => false,
        };
        if mode == Some(PermissionMode::Full) || (mode == Some(PermissionMode::Auto) && in_workspace) {
            let reply = if kind == PendingKind::McpApproval {
                approvals::mcp_response(Decision::Allow)
            } else {
                approvals::approval_response(Decision::Allow)
            };
            return self.reply(&id, reply).await;
        }
        let allow_for_chat = card.get("allowForChat") == Some(&Value::Bool(true));
        let mut card = card;
        {
            let mut state = self.state.lock().unwrap();
            let request_id = Self::public_id(&state, &id);
            card["requestId"] = request_id.clone().into();
            state.pending.insert(request_id, Pending { rpc_id: id, kind, allow_for_chat, workspace_files, question_ids: vec![] });
        }
        let mut event = json!({ "type": "permission-request" });
        if let (Some(target), Value::Object(fields)) = (event.as_object_mut(), card) {
            target.extend(fields);
        }
        self.emit_agent(event);
    }

    async fn handle_request(&self, request: ServerRequest) {
        let ServerRequest { id, method, params, .. } = request;
        let analysis = self.options.analysis_only;
        match method.as_str() {
            methods::MCP_ELICITATION => {
                let card = approvals::mcp_request(&id, &params);
                let ungated: Vec<&str> = self.options.ungated_milagre_tools.iter().map(String::as_str).collect();
                if !self.accepting() {
                    self.reply(&id, approvals::mcp_response(Decision::Cancelled)).await;
                } else if analysis || card.is_none() {
                    self.reply(&id, approvals::mcp_response(Decision::Deny)).await;
                } else if approvals::is_ungated_milagre_tool_approval(&params, &ungated) {
                    self.reply(&id, approvals::mcp_response(Decision::Allow)).await;
                } else if let Some(card) = card {
                    self.add_permission(id, card, PendingKind::McpApproval, None).await;
                }
            }
            methods::COMMAND_APPROVAL | methods::FILE_CHANGE_APPROVAL => {
                if analysis {
                    return self.reply(&id, approvals::approval_response(Decision::Deny)).await;
                }
                if !self.accepting() {
                    return self.reply(&id, approvals::approval_response(Decision::Cancelled)).await;
                }
                if method == methods::COMMAND_APPROVAL {
                    let card = approvals::command_request(&id, &params, |_| false);
                    self.add_permission(id, card, PendingKind::Approval, None).await;
                } else {
                    let item = params.get("itemId").and_then(Value::as_str).unwrap_or_default();
                    let changes = self.state.lock().unwrap().file_changes.get(item).cloned().unwrap_or_default();
                    let card = approvals::file_request(&id, &params, &changes);
                    let files: Vec<String> = card
                        .get("files")
                        .and_then(Value::as_array)
                        .map(|f| f.iter().filter_map(Value::as_str).map(str::to_string).collect())
                        .unwrap_or_default();
                    // Writing a new root is never a workspace edit.
                    let workspace_files = (!crate::codex::js::truthy(params.get("grantRoot"))).then_some(files);
                    self.add_permission(id, card, PendingKind::Approval, workspace_files).await;
                }
            }
            methods::REQUEST_USER_INPUT => {
                let card = approvals::question_request(&id, &params);
                match card {
                    Some(mut card) if !analysis && self.accepting() => {
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
                    _ if analysis => self.reply(&id, approvals::question_response(&QuestionOutcome::Dismissed)).await,
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
        let (events, recheck) = {
            let mut mapper = self.mapper.lock().unwrap();
            let events = map_codex_notification(method, params, &mut mapper);
            (events, mapper.recheck_pending())
        };
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

/// `turn/start` input from a prompt and image paths (codex-provider.cjs `turnInput` without the
/// inline-image splitting of `promptImageBlocks`).
pub fn prompt_input(prompt: &str, image_paths: &[String]) -> Vec<Value> {
    let mut input = vec![crate::codex::protocol::text_input(prompt)];
    input.extend(image_paths.iter().map(|path| crate::codex::protocol::local_image_input(path)));
    input
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

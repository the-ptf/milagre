//! One Codex thread and its turns: the lifecycle subset of codex-provider.cjs `CodexSession` that
//! touches the process. It starts or resumes the thread, starts / steers / interrupts turns, routes
//! server requests into Milagre permission and question requests, and answers them exactly once,
//! cancelling whatever is still open when a turn ends.
//!
//! Not here (owner/host policy, see the crate README): mapping item notifications to Milagre steps
//! (events.cjs `mapCodexNotification`), subagent polling, babysit guards and wake escalation,
//! WorkspaceAccess auto-answers, permission-mode auto-allow, MCP extras and the config retry ladder,
//! image files, session instructions. Every notification is forwarded raw as
//! [`SessionEvent::Notification`] so the owner can map the rest.

use crate::codex::approvals::{self, Decision, QuestionOutcome};
use crate::codex::client::{CodexClient, ConnectError, ConnectOptions, ResumeError};
use crate::codex::protocol::{methods, CodexPolicy, RequestId};
use crate::codex::rpc::{ExitInfo, Notification, RpcError, ServerEvent, ServerRequest};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, watch};

#[derive(Debug, Clone)]
pub struct SessionOptions {
    pub connect: ConnectOptions,
    pub cwd: String,
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
}

impl SessionOptions {
    pub fn new(connect: ConnectOptions, cwd: impl Into<String>) -> Self {
        SessionOptions {
            connect,
            cwd: cwd.into(),
            resume_thread_id: None,
            interrupt_grace: Duration::from_secs(3),
            ungated_milagre_tools: approvals::MILAGRE_UNGATED_TOOLS.iter().map(|s| s.to_string()).collect(),
            analysis_only: false,
            skip_login_check: false,
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
    /// `serviceTierForTurn`; codex-provider.cjs sends `"default"` unless fast mode is on.
    pub service_tier: String,
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum SessionError {
    #[error(transparent)]
    Connect(#[from] ConnectError),
    /// `account/read` says no account while OpenAI auth is required.
    #[error("Codex needs you to log in (codex login).")]
    LoginRequired,
    #[error(transparent)]
    Resume(#[from] ResumeError),
    #[error(transparent)]
    Rpc(#[from] RpcError),
    #[error("A turn is already running; steer it or interrupt it first.")]
    TurnActive,
    #[error("No turn is running.")]
    NoTurn,
    #[error("The session is closed.")]
    Closed,
}

#[derive(Debug, Clone, PartialEq)]
pub enum TurnEnd {
    Completed,
    Failed {
        message: String,
    },
    /// Codex reported `interrupted` without Milagre asking.
    Interrupted,
    /// Milagre stopped it (interrupt, close, or the grace-period kill).
    Cancelled,
    /// The process exited mid-turn.
    Crashed {
        detail: String,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum SessionEvent {
    /// Every notification, raw, own thread or not.
    Notification(Notification),
    ThreadStarted {
        thread_id: String,
    },
    TurnStarted {
        turn_id: String,
    },
    AgentMessageDelta {
        item_id: Option<String>,
        delta: String,
    },
    /// Milagre's `permission-request` shape (requestId, kind, tool, title, …).
    PermissionRequest(Value),
    /// Milagre's `question-request` shape (requestId, questions).
    QuestionRequest(Value),
    /// Codex took a request back (`serverRequest/resolved`) before Milagre answered.
    RequestWithdrawn {
        request_id: String,
    },
    /// Exactly once per started turn. `raw` is the `turn/completed` params when Codex sent them.
    TurnEnded {
        turn_id: Option<String>,
        end: TurnEnd,
        raw: Option<Value>,
    },
    Exited(ExitInfo),
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
}

#[derive(Default)]
struct State {
    thread_id: Option<String>,
    turn_id: Option<String>,
    turn_active: bool,
    cancel_requested: bool,
    closed: bool,
    /// By Milagre request id (`String(id)`).
    pending: HashMap<String, Pending>,
    /// fileChange items from item/started; their approval requests carry no diff of their own.
    file_changes: HashMap<String, Vec<Value>>,
}

struct Inner {
    client: CodexClient,
    options: SessionOptions,
    state: Mutex<State>,
    events: mpsc::UnboundedSender<SessionEvent>,
    /// Bumped whenever a turn ends.
    turn_ended: watch::Sender<u64>,
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
    ) -> Result<(CodexSession, mpsc::UnboundedReceiver<SessionEvent>), SessionError> {
        let (client, rpc_events) = CodexClient::connect(options.connect.clone()).await?;
        let (events, events_rx) = mpsc::unbounded_channel();
        let (turn_ended, _) = watch::channel(0);
        let inner = Arc::new(Inner { client, options, state: Mutex::new(State::default()), events, turn_ended });
        tokio::spawn(pump(inner.clone(), rpc_events));
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
        let thread_id =
            result.pointer("/thread/id").and_then(Value::as_str).map(str::to_string).or_else(|| inner.options.resume_thread_id.clone());
        if let Some(id) = &thread_id {
            inner.state.lock().unwrap().thread_id = Some(id.clone());
            inner.emit(SessionEvent::ThreadStarted { thread_id: id.clone() });
        }
        Ok(())
    }

    pub fn client(&self) -> &CodexClient {
        &self.inner.client
    }

    pub fn thread_id(&self) -> Option<String> {
        self.inner.state.lock().unwrap().thread_id.clone()
    }

    pub fn turn_id(&self) -> Option<String> {
        self.inner.state.lock().unwrap().turn_id.clone()
    }

    pub fn turn_active(&self) -> bool {
        self.inner.state.lock().unwrap().turn_active
    }

    /// Milagre request ids still waiting for an answer.
    pub fn open_requests(&self) -> Vec<String> {
        self.inner.state.lock().unwrap().pending.keys().cloned().collect()
    }

    /// Starts a turn. Returns its id when Codex gave one (a turn without an id still ends through
    /// `turn/completed`). On failure the turn has already ended with [`TurnEnd::Failed`] or
    /// [`TurnEnd::Cancelled`].
    pub async fn start_turn(&self, turn: TurnSettings) -> Result<Option<String>, SessionError> {
        let inner = &self.inner;
        let thread_id = {
            let mut state = inner.state.lock().unwrap();
            if state.closed {
                return Err(SessionError::Closed);
            }
            if state.turn_active {
                return Err(SessionError::TurnActive);
            }
            state.turn_active = true;
            state.cancel_requested = false;
            state.turn_id = None;
            state.thread_id.clone()
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
        match inner.client.turn_start(Value::Object(params)).await {
            Ok(result) => {
                let (turn_id, cancel) = {
                    let mut state = inner.state.lock().unwrap();
                    if state.turn_id.is_none() {
                        state.turn_id = result.pointer("/turn/id").and_then(Value::as_str).map(str::to_string);
                    }
                    (state.turn_id.clone(), state.cancel_requested && state.turn_active)
                };
                // Stop was pressed while turn/start was in flight.
                if cancel {
                    let session = self.clone();
                    tokio::spawn(async move { session.interrupt().await });
                }
                Ok(turn_id)
            }
            Err(error) => {
                let end = if inner.state.lock().unwrap().cancel_requested {
                    TurnEnd::Cancelled
                } else {
                    TurnEnd::Failed { message: error.to_string() }
                };
                inner.finish_turn(end, None).await;
                Err(error.into())
            }
        }
    }

    /// Adds input to the running turn (`turn/steer`). An open question is dismissed first: the
    /// message is the user's reply. A server error means the turn already ended.
    pub async fn steer(&self, input: Vec<Value>) -> Result<(), SessionError> {
        let (thread_id, turn_id) = {
            let state = self.inner.state.lock().unwrap();
            if !state.turn_active || state.cancel_requested {
                return Err(SessionError::NoTurn);
            }
            match (&state.thread_id, &state.turn_id) {
                (Some(thread), Some(turn)) => (thread.clone(), turn.clone()),
                _ => return Err(SessionError::NoTurn),
            }
        };
        self.inner.settle_pending(Some(PendingKind::Question), QuestionOutcome::Dismissed, Decision::Cancelled).await;
        self.inner.client.turn_steer(&thread_id, &turn_id, input).await?;
        Ok(())
    }

    /// Stops the running turn: open requests are cancelled, `turn/interrupt` is sent, and if Codex
    /// doesn't end the turn within the grace period (or refuses), the process is stopped and the
    /// turn ends as [`TurnEnd::Cancelled`]. Returns once the turn has ended.
    pub async fn interrupt(&self) {
        let inner = &self.inner;
        let mut ended = inner.turn_ended.subscribe();
        let (thread_id, turn_id) = {
            let mut state = inner.state.lock().unwrap();
            if !state.turn_active {
                return;
            }
            state.cancel_requested = true;
            (state.thread_id.clone(), state.turn_id.clone())
        };
        inner.settle_pending(None, QuestionOutcome::Cancelled, Decision::Cancelled).await;
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
        self.inner.client.close().await;
        self.inner.finish_turn(TurnEnd::Cancelled, None).await;
    }

    /// Answers a permission request. `false` when it is unknown or already settled (Node's
    /// `PendingPermissions.resolve`).
    pub async fn respond_to_permission(&self, request_id: &str, decision: Decision) -> bool {
        let pending = {
            let mut state = self.inner.state.lock().unwrap();
            match state.pending.get(request_id) {
                Some(p) if p.kind != PendingKind::Question => state.pending.remove(request_id),
                _ => None,
            }
        };
        let Some(pending) = pending else { return false };
        self.inner.answer(pending, decision, &QuestionOutcome::Cancelled).await;
        true
    }

    /// Answers (or with [`QuestionOutcome::Dismissed`] dismisses) a question.
    pub async fn answer_question(&self, request_id: &str, outcome: QuestionOutcome) -> bool {
        let pending = {
            let mut state = self.inner.state.lock().unwrap();
            match state.pending.get(request_id) {
                Some(p) if p.kind == PendingKind::Question => state.pending.remove(request_id),
                _ => None,
            }
        };
        let Some(pending) = pending else { return false };
        self.inner.answer(pending, Decision::Cancelled, &outcome).await;
        true
    }

    /// Stops the process tree. A running turn ends as [`TurnEnd::Cancelled`].
    pub async fn close(&self) -> ExitInfo {
        {
            let mut state = self.inner.state.lock().unwrap();
            if state.turn_active {
                state.cancel_requested = true;
            }
            state.closed = true;
        }
        self.inner.settle_pending(None, QuestionOutcome::Cancelled, Decision::Cancelled).await;
        let exit = self.inner.client.close().await;
        self.inner.finish_turn(TurnEnd::Cancelled, None).await;
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

impl Inner {
    fn emit(&self, event: SessionEvent) {
        let _ = self.events.send(event);
    }

    /// Ends the running turn once: cancels open requests and emits `TurnEnded`.
    async fn finish_turn(&self, end: TurnEnd, raw: Option<Value>) {
        let turn_id = {
            let mut state = self.state.lock().unwrap();
            if !state.turn_active {
                return;
            }
            state.turn_active = false;
            state.file_changes.clear();
            state.turn_id.clone()
        };
        self.settle_pending(None, QuestionOutcome::Cancelled, Decision::Cancelled).await;
        self.emit(SessionEvent::TurnEnded { turn_id, end, raw });
        self.turn_ended.send_modify(|n| *n += 1);
    }

    /// Answers every open request (of one kind, or all) with the given outcome.
    async fn settle_pending(&self, only: Option<PendingKind>, question: QuestionOutcome, decision: Decision) {
        let settled: Vec<Pending> = {
            let mut state = self.state.lock().unwrap();
            let ids: Vec<String> =
                state.pending.iter().filter(|(_, p)| only.is_none_or(|k| p.kind == k)).map(|(id, _)| id.clone()).collect();
            ids.into_iter().filter_map(|id| state.pending.remove(&id)).collect()
        };
        for pending in settled {
            self.answer(pending, decision, &question).await;
        }
    }

    async fn answer(&self, pending: Pending, decision: Decision, question: &QuestionOutcome) {
        let reply = match pending.kind {
            PendingKind::Approval => approvals::approval_response(decision),
            PendingKind::McpApproval => approvals::mcp_response(decision),
            PendingKind::Question => approvals::question_response(question),
        };
        // Codex may already have exited or withdrawn it; then there is nobody left to answer.
        let _ = self.client.rpc().respond(&pending.rpc_id, reply).await;
    }

    fn accepting(&self) -> bool {
        let state = self.state.lock().unwrap();
        state.turn_active && !state.cancel_requested && !state.closed
    }

    async fn reply(&self, id: &RequestId, result: Value) {
        let _ = self.client.rpc().respond(id, result).await;
    }

    async fn handle_request(&self, request: ServerRequest) {
        let ServerRequest { id, method, params, .. } = request;
        let request_id = id.to_string();
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
                    self.track(request_id, id, PendingKind::McpApproval);
                    self.emit(SessionEvent::PermissionRequest(card));
                }
            }
            methods::COMMAND_APPROVAL | methods::FILE_CHANGE_APPROVAL => {
                if analysis {
                    return self.reply(&id, approvals::approval_response(Decision::Deny)).await;
                }
                if !self.accepting() {
                    return self.reply(&id, approvals::approval_response(Decision::Cancelled)).await;
                }
                let card = if method == methods::COMMAND_APPROVAL {
                    approvals::command_request(&id, &params, |_| false)
                } else {
                    let item = params.get("itemId").and_then(Value::as_str).unwrap_or_default();
                    let changes = self.state.lock().unwrap().file_changes.get(item).cloned().unwrap_or_default();
                    approvals::file_request(&id, &params, &changes)
                };
                self.track(request_id, id, PendingKind::Approval);
                self.emit(SessionEvent::PermissionRequest(card));
            }
            methods::REQUEST_USER_INPUT => {
                let card = approvals::question_request(&id, &params);
                match card {
                    Some(card) if !analysis && self.accepting() => {
                        self.track(request_id, id, PendingKind::Question);
                        self.emit(SessionEvent::QuestionRequest(card));
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

    fn track(&self, request_id: String, rpc_id: RequestId, kind: PendingKind) {
        self.state.lock().unwrap().pending.insert(request_id, Pending { rpc_id, kind });
    }

    async fn handle_notification(&self, notification: Notification) {
        let params = &notification.params;
        let own_thread = {
            let state = self.state.lock().unwrap();
            let thread = params.get("threadId").and_then(Value::as_str);
            thread.is_none() || thread == state.thread_id.as_deref()
        };
        match notification.method.as_str() {
            methods::ITEM_STARTED if params.pointer("/item/type").and_then(Value::as_str) == Some("fileChange") => {
                if let Some(id) = params.pointer("/item/id").and_then(Value::as_str) {
                    let changes = params.pointer("/item/changes").and_then(Value::as_array).cloned().unwrap_or_default();
                    self.state.lock().unwrap().file_changes.insert(id.to_string(), changes);
                }
            }
            methods::SERVER_REQUEST_RESOLVED => {
                if let Some(id) = params.get("requestId").and_then(RequestId::from_value) {
                    let removed = self.state.lock().unwrap().pending.remove(&id.to_string()).is_some();
                    if removed {
                        self.emit(SessionEvent::RequestWithdrawn { request_id: id.to_string() });
                    }
                }
            }
            _ => {}
        }
        self.emit(SessionEvent::Notification(notification.clone()));
        if !own_thread {
            return;
        }
        match notification.method.as_str() {
            methods::TURN_STARTED => {
                let turn_id = params.pointer("/turn/id").and_then(Value::as_str).map(str::to_string);
                let announce = {
                    let mut state = self.state.lock().unwrap();
                    // A turn this session isn't running (its start acknowledgement timed out) would open a run nothing ends.
                    if !state.turn_active {
                        None
                    } else {
                        if state.turn_id.is_none() {
                            state.turn_id = turn_id.clone();
                        }
                        turn_id
                    }
                };
                if let Some(turn_id) = announce {
                    self.emit(SessionEvent::TurnStarted { turn_id });
                }
            }
            methods::AGENT_MESSAGE_DELTA => {
                if let Some(delta) = params.get("delta").and_then(Value::as_str) {
                    let item_id = params.get("itemId").and_then(Value::as_str).map(str::to_string);
                    self.emit(SessionEvent::AgentMessageDelta { item_id, delta: delta.to_string() });
                }
            }
            methods::TURN_COMPLETED => {
                let (current, cancel) = {
                    let state = self.state.lock().unwrap();
                    (state.turn_id.clone(), state.cancel_requested)
                };
                let completed = params.pointer("/turn/id").and_then(Value::as_str);
                // A stale turn's completion (an earlier turn) does not end this one.
                if current.is_some() && completed.is_some() && completed != current.as_deref() {
                    return;
                }
                let end = if cancel {
                    TurnEnd::Cancelled
                } else {
                    match params.pointer("/turn/status").and_then(Value::as_str) {
                        Some("failed") => TurnEnd::Failed {
                            message: params
                                .pointer("/turn/error/message")
                                .and_then(Value::as_str)
                                .unwrap_or("The turn failed.")
                                .to_string(),
                        },
                        Some("interrupted") => TurnEnd::Interrupted,
                        _ => TurnEnd::Completed,
                    }
                };
                self.finish_turn(end, Some(params.clone())).await;
            }
            _ => {}
        }
    }
}

async fn pump(inner: Arc<Inner>, mut events: mpsc::UnboundedReceiver<ServerEvent>) {
    while let Some(event) = events.recv().await {
        match event {
            ServerEvent::Notification(notification) => inner.handle_notification(notification).await,
            ServerEvent::Request(request) => inner.handle_request(request).await,
            ServerEvent::Diagnostic(_) => {}
            ServerEvent::Exit(exit) => {
                let cancelled = {
                    let mut state = inner.state.lock().unwrap();
                    state.closed = true;
                    state.pending.clear();
                    state.cancel_requested
                };
                let end = if cancelled { TurnEnd::Cancelled } else { TurnEnd::Crashed { detail: exit.detail.clone() } };
                inner.finish_turn(end, None).await;
                inner.emit(SessionEvent::Exited(exit));
                return;
            }
        }
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
    TurnSettings { input, model, effort: None, policy, service_tier: "default".into(), extra: Default::default() }
}

#[allow(dead_code)]
fn _assert_send() {
    fn is_send<T: Send + Sync>() {}
    is_send::<CodexSession>();
}

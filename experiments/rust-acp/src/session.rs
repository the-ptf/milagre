//! Fake-only lifecycle experiment. Built only with `fake-session`; no configurable executable,
//! environment, authentication, vendor bootstrap, MCP dispatch or owner runtime constructor.
use crate::events::{self, AcpEventState};
use crate::protocol::{self, Decision};
use crate::queue::{self, EventReceiver, EventSender, QueueLimits};
use crate::rpc::value_weight;
use crate::{AcpRpc, RequestId, RpcError, ServerEvent, SpawnOptions};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, watch, OwnedSemaphorePermit, Semaphore};
use tokio::time::Instant;

type RequestFuture = Pin<Box<dyn Future<Output = Result<Value, RpcError>> + Send>>;
type WriteFuture = Pin<Box<dyn Future<Output = Result<(), RpcError>> + Send>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TurnId(pub u64);
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Policy {
    Ask,
    Auto,
    Full,
    Babysit,
    Advisor,
    Escalation,
    AnalysisOnly,
}
#[derive(Debug, Clone)]
pub enum OpenSession {
    Create,
    Load(String),
    Resume(String),
}
#[derive(Debug, Clone)]
pub struct SessionLimits {
    pub admitted_turns: usize,
    pub command_count: usize,
    pub command_bytes: usize,
    pub output: QueueLimits,
    pub mapper_bytes: usize,
    pub open_calls: usize,
    pub cached_diff_paths: usize,
    pub thinking_bytes: usize,
    pub permissions: usize,
    pub permission_bytes: usize,
    pub startup_timeout: Duration,
    pub turn_timeout: Duration,
    pub idle_timeout: Duration,
    pub permission_timeout: Duration,
    pub cancel_grace: Duration,
}
impl Default for SessionLimits {
    fn default() -> Self {
        Self {
            admitted_turns: 8,
            command_count: 32,
            command_bytes: 1024 * 1024,
            output: QueueLimits { max_events: 1024, max_bytes: 8 * 1024 * 1024 },
            mapper_bytes: 2 * 1024 * 1024,
            open_calls: 256,
            cached_diff_paths: 256,
            thinking_bytes: 256 * 1024,
            permissions: 16,
            permission_bytes: 1024 * 1024,
            startup_timeout: Duration::from_secs(120),
            turn_timeout: Duration::from_secs(1800),
            idle_timeout: Duration::from_secs(120),
            permission_timeout: Duration::from_secs(600),
            cancel_grace: Duration::from_secs(3),
        }
    }
}
#[derive(Debug, Clone)]
pub struct FakeOptions {
    /// Only a fixed list of repository fake scenarios is accepted.
    pub scenario: String,
    pub open: OpenSession,
    pub policy: Policy,
    pub limits: SessionLimits,
    /// Explicit fixture clock for presentation durations. Watchdogs always use monotonic time.
    pub mapper_now_ms: Option<i64>,
}
impl Default for FakeOptions {
    fn default() -> Self {
        Self {
            scenario: "reply".into(),
            open: OpenSession::Create,
            policy: Policy::Ask,
            limits: SessionLimits::default(),
            mapper_now_ms: None,
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SessionError {
    #[error("Session closed.")]
    Closed,
    #[error("Session admission budget exceeded.")]
    Busy,
    #[error("Unsupported ACP policy: guards are not implemented.")]
    UnsupportedPolicy,
    #[error("Invalid fake session configuration.")]
    Configuration,
    #[error("Permission request is no longer open for this turn.")]
    UnknownPermission,
    #[error("Permission reply delivery is uncertain; do not replay it.")]
    UncertainDelivery,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Delivery {
    NotSent,
    WrittenUnacknowledged,
    Uncertain,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Answer {
    AllowOnce,
    Deny,
    Cancelled,
}
#[derive(Debug, Clone, PartialEq)]
pub enum SessionEvent {
    Agent {
        turn_id: TurnId,
        event: Value,
    },
    /// Original request plus merged tool context. Display metadata is not authorization.
    Permission {
        turn_id: TurnId,
        request_id: RequestId,
        params: Value,
        call: Value,
    },
    PermissionClosed {
        turn_id: TurnId,
        request_id: RequestId,
        delivery: Delivery,
    },
    Closed {
        last_turn: Option<TurnId>,
    },
}
fn event_weight(event: &SessionEvent) -> usize {
    256usize.saturating_add(match event {
        SessionEvent::Agent { event, .. } => value_weight(event),
        SessionEvent::Permission { request_id, params, call, .. } => {
            value_weight(&request_id.to_value()).saturating_add(value_weight(params)).saturating_add(value_weight(call))
        }
        SessionEvent::PermissionClosed { request_id, .. } => value_weight(&request_id.to_value()),
        SessionEvent::Closed { .. } => 0,
    })
}
#[derive(Clone)]
pub struct FakeSession {
    handle: Arc<Handle>,
}
struct Handle {
    commands: mpsc::Sender<Command>,
    slots: Arc<Semaphore>,
    bytes: Arc<Semaphore>,
    next: AtomicU64,
    epoch: AtomicU64,
    stops: watch::Sender<u64>,
    shutdown: watch::Sender<bool>,
    closed: Arc<AtomicBool>,
    done: watch::Receiver<bool>,
}
impl Drop for Handle {
    fn drop(&mut self) {
        self.closed.store(true, Ordering::Release);
        let _ = self.shutdown.send(true);
    }
}
struct Turn {
    id: TurnId,
    epoch: u64,
    queued_at: Instant,
    blocks: Vec<Value>,
    _slot: OwnedSemaphorePermit,
    _bytes: OwnedSemaphorePermit,
}
enum Command {
    Send(Turn),
    Answer {
        turn: TurnId,
        id: RequestId,
        answer: Answer,
        reply: oneshot::Sender<Result<Delivery, SessionError>>,
    },
    Inspect(oneshot::Sender<Value>),
    /// Fixed fake method, never arbitrary provider RPC.
    FinishFake(oneshot::Sender<Result<(), SessionError>>),
}
impl FakeSession {
    /// Launches only repository-owned fake scripts, with an empty environment except scenario.
    /// No generic launch/from-RPC constructor exists in this feature.
    pub fn launch(options: FakeOptions) -> Result<(Self, EventReceiver<SessionEvent>), SessionError> {
        if options.policy != Policy::Ask {
            return Err(SessionError::UnsupportedPolicy);
        }
        if matches!(&options.open, OpenSession::Load(id)|OpenSession::Resume(id) if id.is_empty() || id.len()>4096) {
            return Err(SessionError::Configuration);
        }
        let l = &options.limits;
        if l.admitted_turns == 0
            || l.admitted_turns > 64
            || l.command_count == 0
            || l.command_count > 256
            || l.command_bytes > u32::MAX as usize
            || l.permissions > 256
            || [l.startup_timeout, l.turn_timeout, l.idle_timeout, l.permission_timeout, l.cancel_grace]
                .iter()
                .any(|d| d.is_zero() || *d > Duration::from_secs(86_400))
        {
            return Err(SessionError::Configuration);
        }
        let normal = [
            "reply",
            "thinking",
            "command",
            "failing-command",
            "permission",
            "edit",
            "question",
            "plan",
            "kiro",
            "kiro-tools",
            "slow",
            "stubborn",
            "crash",
            "logged-out",
            "subscription",
            "prompt-login",
            "no-resume",
        ];
        let faults = [
            "hang-init",
            "bad-version",
            "no-load",
            "missing-id",
            "permission-after-end",
            "permission-timeout",
            "permission-flood",
            "state-flood",
            "thinking-flood",
            "late-update",
            "wrong-session",
            "exit-after-result",
            "stale-permission",
            "hang-load",
            "stop-during-load",
            "reply-then-permission",
            "multi-turn",
            "blocked-answer",
            "error-after-text",
            "exit-after-text",
            "reuse-permission",
            "metadata-flood",
        ];
        let script = if normal.contains(&options.scenario.as_str()) {
            "../../packages/core/src/agents/fixtures/fake-acp-agent.cjs"
        } else if faults.contains(&options.scenario.as_str()) {
            "scripts/fake-session-agent.cjs"
        } else {
            return Err(SessionError::Configuration);
        };
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let node = std::env::var_os("PATH")
            .and_then(|paths| std::env::split_paths(&paths).map(|p| p.join("node")).find(|p| p.is_file()))
            .ok_or(SessionError::Configuration)?;
        let mut spawn = SpawnOptions::new(node)
            .args([root.join(script).into_os_string()])
            .cwd(root.join("../.."))
            .env([("FAKE_SCENARIO", options.scenario.as_str())])
            .owned_server_methods(["session/request_permission"]);
        spawn.response_boundaries = true;
        // Bound individual session inputs before mapping; image handling is a later checkpoint.
        spawn.limits.max_frame_bytes = 512 * 1024;
        spawn.limits.max_open_server_requests = l.permissions.max(1);
        spawn.limits.write_timeout = l.cancel_grace;
        let (tx, rx) = mpsc::channel(l.command_count);
        let (output, events) = queue::channel(l.output);
        let (stops, stop_rx) = watch::channel(0);
        let (shutdown, shutdown_rx) = watch::channel(false);
        let (done, done_rx) = watch::channel(false);
        let closed = Arc::new(AtomicBool::new(false));
        let handle = Arc::new(Handle {
            commands: tx,
            slots: Arc::new(Semaphore::new(l.admitted_turns)),
            bytes: Arc::new(Semaphore::new(l.command_bytes)),
            next: AtomicU64::new(1),
            epoch: AtomicU64::new(0),
            stops,
            shutdown,
            closed: closed.clone(),
            done: done_rx,
        });
        tokio::spawn(Actor::new(options, spawn, rx, output, stop_rx, shutdown_rx, closed, done).run());
        Ok((Self { handle }, events))
    }
    /// Admission is synchronous and bounded. Every accepted ID gets exactly one terminal event,
    /// including queued turns discarded by Stop. It is never provider steering.
    pub fn send(&self, text: &str) -> Result<TurnId, SessionError> {
        if self.handle.closed.load(Ordering::Acquire) {
            return Err(SessionError::Closed);
        }
        if text.len() > self.handle.bytes.available_permits() {
            return Err(SessionError::Busy);
        }
        let slot = self.handle.slots.clone().try_acquire_owned().map_err(|_| SessionError::Busy)?;
        let blocks = vec![json!({"type":"text","text":text})];
        let weight = value_weight(&json!(&blocks)).saturating_add(256);
        let bytes = self
            .handle
            .bytes
            .clone()
            .try_acquire_many_owned(u32::try_from(weight).map_err(|_| SessionError::Busy)?)
            .map_err(|_| SessionError::Busy)?;
        let id =
            self.handle.next.try_update(Ordering::AcqRel, Ordering::Acquire, |n| n.checked_add(1)).map_err(|_| SessionError::Closed)?;
        let turn = Turn {
            id: TurnId(id),
            epoch: self.handle.epoch.load(Ordering::Acquire),
            queued_at: Instant::now(),
            blocks,
            _slot: slot,
            _bytes: bytes,
        };
        self.handle.commands.try_send(Command::Send(turn)).map_err(|e| {
            if matches!(e, mpsc::error::TrySendError::Closed(_)) {
                SessionError::Closed
            } else {
                SessionError::Busy
            }
        })?;
        Ok(TurnId(id))
    }
    pub fn cancel(&self) {
        let epoch = self.handle.epoch.fetch_add(1, Ordering::AcqRel).saturating_add(1);
        let _ = self.handle.stops.send(epoch);
    }
    /// Success confirms a pipe write only. If this future is dropped after the reply is claimed, the actor
    /// stops the process when it observes that abandonment; delivery may already have occurred.
    pub async fn answer(&self, turn: TurnId, id: RequestId, answer: Answer) -> Result<Delivery, SessionError> {
        if self.handle.closed.load(Ordering::Acquire) {
            return Err(SessionError::Closed);
        }
        if id.to_string().len() > 4096 {
            return Err(SessionError::UnknownPermission);
        }
        let (reply, rx) = oneshot::channel();
        self.handle.commands.try_send(Command::Answer { turn, id, answer, reply }).map_err(|e| match e {
            mpsc::error::TrySendError::Full(_) => SessionError::Busy,
            mpsc::error::TrySendError::Closed(_) => SessionError::Closed,
        })?;
        rx.await.unwrap_or(Err(SessionError::Closed))
    }
    pub async fn inspect(&self) -> Result<Value, SessionError> {
        let (tx, rx) = oneshot::channel();
        self.handle.commands.try_send(Command::Inspect(tx)).map_err(|_| SessionError::Closed)?;
        rx.await.map_err(|_| SessionError::Closed)
    }
    pub async fn finish_fake(&self) -> Result<(), SessionError> {
        let (tx, rx) = oneshot::channel();
        self.handle.commands.try_send(Command::FinishFake(tx)).map_err(|_| SessionError::Busy)?;
        rx.await.unwrap_or(Err(SessionError::Closed))
    }
    pub async fn shutdown(&self) {
        self.handle.closed.store(true, Ordering::Release);
        let _ = self.handle.shutdown.send(true);
        let mut done = self.handle.done.clone();
        while !*done.borrow_and_update() {
            if done.changed().await.is_err() {
                break;
            }
        }
    }
}
struct Operation {
    method: &'static str,
    future: Option<RequestFuture>,
    result: Option<Result<Value, RpcError>>,
    boundary: bool,
}
struct Permission {
    turn: TurnId,
    id: RequestId,
    params: Value,
    created: Instant,
    claimed: bool,
}
struct Write {
    id: Option<RequestId>,
    turn: Option<TurnId>,
    result: Value,
    reply: Option<oneshot::Sender<Result<Delivery, SessionError>>>,
}
struct Writing {
    work: Write,
    future: WriteFuture,
}
struct Actor {
    options: FakeOptions,
    spawn: SpawnOptions,
    commands: mpsc::Receiver<Command>,
    output: EventSender<SessionEvent>,
    stops: watch::Receiver<u64>,
    shutdown: watch::Receiver<bool>,
    closed: Arc<AtomicBool>,
    done: watch::Sender<bool>,
    rpc: Option<AcpRpc>,
    incoming: Option<EventReceiver<ServerEvent>>,
    operation: Option<Operation>,
    queue: VecDeque<Turn>,
    active: Option<Turn>,
    last: Option<TurnId>,
    epoch: u64,
    state: AcpEventState,
    native: Option<String>,
    capabilities: Value,
    ready: bool,
    permissions: Vec<Permission>,
    writes: VecDeque<Write>,
    writing: Option<Writing>,
    terminal: Option<Value>,
    stopping: bool,
    cancelled: bool,
    stage_deadline: Instant,
    turn_deadline: Instant,
    progress: Instant,
    origin: Instant,
}
impl Actor {
    #[allow(clippy::too_many_arguments)]
    fn new(
        options: FakeOptions,
        spawn: SpawnOptions,
        commands: mpsc::Receiver<Command>,
        output: EventSender<SessionEvent>,
        stops: watch::Receiver<u64>,
        shutdown: watch::Receiver<bool>,
        closed: Arc<AtomicBool>,
        done: watch::Sender<bool>,
    ) -> Self {
        let now = Instant::now();
        let native = match &options.open {
            OpenSession::Create => None,
            OpenSession::Load(id) | OpenSession::Resume(id) => Some(id.clone()),
        };
        Self {
            options,
            spawn,
            commands,
            output,
            stops,
            shutdown,
            closed,
            done,
            rpc: None,
            incoming: None,
            operation: None,
            queue: VecDeque::new(),
            active: None,
            last: None,
            epoch: 0,
            state: AcpEventState::default(),
            native,
            capabilities: json!({}),
            ready: false,
            permissions: vec![],
            writes: VecDeque::new(),
            writing: None,
            terminal: None,
            stopping: false,
            cancelled: false,
            stage_deadline: now,
            turn_deadline: now,
            progress: now,
            origin: now,
        }
    }
    fn now(&self) -> i64 {
        self.options.mapper_now_ms.unwrap_or_else(|| self.origin.elapsed().as_millis().min(i64::MAX as u128) as i64)
    }
    fn emit(&mut self, event: SessionEvent) -> bool {
        let weight = event_weight(&event);
        if self.output.send(event, weight).is_err() {
            self.stopping = true;
            self.closed.store(true, Ordering::Release);
            if let Some(rpc) = &self.rpc {
                rpc.abort();
            }
            false
        } else {
            true
        }
    }
    fn reserved(&mut self, event: SessionEvent) {
        let weight = event_weight(&event);
        self.output.force(event, weight);
    }
    fn agent(&mut self, event: Value) -> bool {
        let Some(turn) = self.active.as_ref().map(|t| t.id) else { return true };
        self.emit(SessionEvent::Agent { turn_id: turn, event })
    }
    fn start_request(&mut self, method: &'static str, params: Value) {
        let rpc = self.rpc.as_ref().unwrap().clone();
        let timeout = if method == "session/prompt" { None } else { Some(self.options.limits.startup_timeout) };
        self.operation = Some(Operation {
            method,
            future: Some(Box::pin(async move { rpc.request_with_timeout(method, params, timeout).await })),
            result: None,
            boundary: false,
        });
        if method != "session/prompt" {
            self.stage_deadline = Instant::now() + self.options.limits.startup_timeout;
        }
    }
    fn begin(&mut self, turn: Turn) {
        self.last = Some(turn.id);
        self.state.begin_turn(&format!("turn-{}", turn.id.0));
        self.active = Some(turn);
        self.cancelled = false;
        self.progress = Instant::now();
        self.turn_deadline = self.progress + self.options.limits.turn_timeout;
        if self.ready {
            self.prompt();
            return;
        }
        match AcpRpc::spawn(self.spawn.clone()) {
            Ok((rpc, events)) => {
                self.rpc = Some(rpc);
                self.incoming = Some(events);
                self.start_request("initialize", protocol::initialize("fake-session"));
            }
            Err(e) => self.fail(&e.to_string()),
        }
    }
    fn prompt(&mut self) {
        if !self.agent(json!({"type":"turn-started","turnId":format!("turn-{}",self.active.as_ref().unwrap().id.0)})) {
            self.fail("Session consumer stalled.");
            return;
        }
        let params = protocol::prompt(self.native.as_ref().unwrap(), &self.active.as_ref().unwrap().blocks);
        self.start_request("session/prompt", params);
    }
    fn setup_session(&mut self, method: &'static str) {
        self.start_request(method, protocol::session("/fixture", &[], if method == "session/new" { None } else { self.native.as_deref() }));
    }
    fn load(&mut self) {
        if self.capabilities["loadSession"] == true {
            self.setup_session("session/load");
        } else {
            self.fail("ACP agent does not support loading this session.");
        }
    }
    fn operation_done(&mut self, method: &str, result: Result<Value, RpcError>) {
        match result {
            Err(RpcError::Server { code: -32601 | -32002, .. }) if method == "session/resume" => self.load(),
            Err(error) => self.fail(&error.to_string()),
            Ok(value) => match method {
                "initialize" => {
                    if value["protocolVersion"] != 1 {
                        self.fail("ACP protocol version 1 was not negotiated.");
                        return;
                    }
                    self.capabilities = value.get("agentCapabilities").cloned().unwrap_or(json!({}));
                    if value_weight(&self.capabilities) > self.options.limits.mapper_bytes {
                        self.fail("ACP capability state budget exceeded.");
                        return;
                    }
                    match &self.options.open {
                        OpenSession::Create => self.setup_session("session/new"),
                        OpenSession::Load(_) => self.load(),
                        OpenSession::Resume(_) => {
                            if crate::events_js::truthy(self.capabilities.pointer("/sessionCapabilities/resume")) {
                                self.setup_session("session/resume");
                            } else {
                                self.load();
                            }
                        }
                    }
                }
                "session/new" | "session/load" | "session/resume" => {
                    let id = value["sessionId"].as_str().filter(|s| !s.is_empty()).map(str::to_owned).or_else(|| self.native.clone());
                    let Some(id) = id.filter(|s| s.len() <= 4096) else {
                        self.fail("ACP did not return a valid session ID.");
                        return;
                    };
                    if self.native.as_ref() != Some(&id) && !self.agent(json!({"type":"session-started","nativeId":id})) {
                        self.fail("Session consumer stalled.");
                        return;
                    }
                    self.native = Some(id);
                    let now = self.now();
                    if let Some(mode) = value.pointer("/modes/currentModeId") {
                        events::map_acp_update(&json!({"sessionUpdate":"current_mode_update","currentModeId":mode}), &mut self.state, now);
                    }
                    events::read_config_options(&value["configOptions"], &mut self.state);
                    if !self.state_fits() {
                        self.fail("ACP mapper state budget exceeded.");
                        return;
                    }
                    self.ready = true;
                    self.prompt();
                }
                "session/prompt" => {
                    let mut terminal = if self.cancelled {
                        json!({"type":"turn-cancelled"})
                    } else {
                        events::stop_reason_event(&value["stopReason"], "Fake ACP")
                    };
                    if terminal["type"] == "turn-completed" {
                        if let Some(credits) = self.state.field("turnCredits").filter(|v| v.is_number()) {
                            terminal["credits"] = credits.clone();
                        }
                    }
                    self.finish(terminal);
                }
                _ => {}
            },
        }
    }
    fn state_fits(&self) -> bool {
        let l = &self.options.limits;
        self.state.retained_weight().saturating_add(value_weight(&self.capabilities)) <= l.mapper_bytes
            && self.state.field("calls").and_then(Value::as_array).is_none_or(|v| v.len() <= l.open_calls)
            && self.state.field("editDiffs").and_then(Value::as_array).is_none_or(|v| v.len() <= l.cached_diff_paths)
            && self.state.field("thinking").and_then(|v| v["text"].as_str()).is_none_or(|v| v.len() <= l.thinking_bytes)
    }
    fn fail(&mut self, message: &str) {
        self.stopping = true;
        self.closed.store(true, Ordering::Release);
        if let Some(rpc) = &self.rpc {
            rpc.abort();
        }
        self.operation = None;
        if self.active.is_some() {
            self.terminal = Some(if self.cancelled {
                json!({"type":"turn-cancelled"})
            } else {
                json!({"type":"turn-failed","message":crate::events_js::head(message,2048)})
            });
        }
        self.close_permissions();
    }
    fn close_permissions(&mut self) {
        let writing = self.writing.take();
        if let Some(w) = writing {
            if let Some(reply) = w.work.reply {
                let _ = reply.send(Err(SessionError::UncertainDelivery));
            }
        }
        for work in self.writes.drain(..) {
            if let Some(reply) = work.reply {
                let _ = reply.send(Err(SessionError::Closed));
            }
        }
        let pending = std::mem::take(&mut self.permissions);
        for p in pending {
            let event = SessionEvent::PermissionClosed {
                turn_id: p.turn,
                request_id: p.id,
                delivery: if p.claimed { Delivery::Uncertain } else { Delivery::NotSent },
            };
            if self.stopping {
                self.reserved(event);
            } else {
                self.emit(event);
            }
        }
    }
    fn cancel_permissions(&mut self) {
        for p in &mut self.permissions {
            if !p.claimed {
                p.claimed = true;
                self.writes.push_back(Write {
                    id: Some(p.id.clone()),
                    turn: Some(p.turn),
                    result: json!({"outcome":{"outcome":"cancelled"}}),
                    reply: None,
                });
            }
        }
    }
    fn finish(&mut self, terminal: Value) {
        if self.terminal.is_some() {
            return;
        }
        if self.writing.as_ref().is_some_and(|w| w.work.reply.is_some()) {
            self.fail("Turn ended with an uncertain permission write.");
            return;
        }
        // Never start a queued allow after the prompt's response boundary.
        let mut cleanup = VecDeque::new();
        for work in self.writes.drain(..) {
            if let Some(reply) = work.reply {
                let _ = reply.send(Err(SessionError::Closed));
                if let Some(p) = self.permissions.iter_mut().find(|p| Some(&p.id) == work.id.as_ref() && Some(p.turn) == work.turn) {
                    p.claimed = false;
                }
            } else {
                cleanup.push_back(work);
            }
        }
        self.writes = cleanup;
        self.operation = None;
        self.terminal = Some(terminal);
        self.stage_deadline = Instant::now() + self.options.limits.cancel_grace;
        self.cancel_permissions();
    }
    fn finalize_turn(&mut self) {
        let Some(terminal) = self.terminal.take() else {
            return;
        };
        let now = self.now();
        for event in events::close_thinking(&mut self.state, now) {
            self.agent(event);
        }
        self.state.clear_turn();
        let turn = self.active.take().unwrap();
        let event = SessionEvent::Agent { turn_id: turn.id, event: terminal };
        if self.stopping || !self.emit(event.clone()) {
            self.reserved(event);
        }
    }
    fn stop(&mut self, epoch: u64) {
        self.epoch = epoch;
        if self.terminal.is_some() {
            return;
        }
        if self.active.as_ref().is_some_and(|t| t.epoch < epoch) && !self.cancelled {
            self.cancelled = true;
            self.stage_deadline = Instant::now() + self.options.limits.cancel_grace;
            if !self.ready || self.writing.as_ref().is_some_and(|w| w.work.reply.is_some()) {
                self.fail("Cancelled with uncertain pending write.");
                return;
            }
            // Drop queued explicit answers before they enter the transport, then cancel every request.
            for work in self.writes.drain(..) {
                if let Some(reply) = work.reply {
                    let _ = reply.send(Err(SessionError::Closed));
                }
            }
            for p in &mut self.permissions {
                p.claimed = false;
            }
            self.writes.push_back(Write { id: None, turn: None, result: Value::Null, reply: None });
            self.cancel_permissions();
        }
    }
    fn notification(&mut self, method: &str, params: &Value) {
        if method != "session/update" || !self.ready || self.terminal.is_some() {
            return;
        }
        if crate::events_js::truthy(params.get("sessionId")) && params["sessionId"].as_str() != self.native.as_deref() {
            return;
        }
        let update = &params["update"];
        let kind = update["sessionUpdate"].as_str().unwrap_or("");
        if self.active.is_none()
            && !["usage_update", "current_mode_update", "config_option_update", "available_commands_update"].contains(&kind)
        {
            return;
        }
        if self.cancelled && kind == "agent_message_chunk" {
            return;
        }
        // Native child attribution must be implemented by an owner, never folded into the parent.
        if update.pointer("/_meta/parentToolCallId").is_some() {
            return;
        }
        let l = &self.options.limits;
        if value_weight(update) > l.mapper_bytes
            || update["content"].as_array().is_some_and(|items| items.len() > l.cached_diff_paths.max(1))
            || (kind == "agent_thought_chunk"
                && update.pointer("/content/text").and_then(Value::as_str).is_some_and(|text| {
                    let old = self.state.field("thinking").and_then(|t| t["text"].as_str()).map(str::len).unwrap_or(0);
                    text.len() > l.thinking_bytes.saturating_sub(old)
                }))
        {
            self.fail("ACP mapper input budget exceeded.");
            return;
        }
        let now = self.now();
        let mapped = events::map_acp_update(update, &mut self.state, now);
        if !self.state_fits() {
            self.fail("ACP mapper state budget exceeded.");
            return;
        }
        if !mapped.is_empty() {
            self.progress = Instant::now();
        }
        for event in mapped {
            if !self.agent(event) {
                self.fail("Session consumer stalled.");
                break;
            }
        }
    }
    fn server_request(&mut self, request: crate::rpc::ServerRequest) {
        let turn = self.active.as_ref().map(|t| t.id);
        let valid = self.ready
            && turn.is_some()
            && !self.cancelled
            && self.terminal.is_none()
            && request.params.get("sessionId").is_none_or(|id| id.as_str() == self.native.as_deref());
        if !valid {
            if self.writes.len() >= self.options.limits.permissions {
                self.fail("ACP permission cleanup budget exceeded.");
                return;
            }
            self.writes.push_back(Write {
                id: Some(request.id),
                turn: None,
                result: json!({"outcome":{"outcome":"cancelled"}}),
                reply: None,
            });
            return;
        }
        let turn = turn.unwrap();
        let call = self.state.merged_call(&request.params["toolCall"]);
        let weight = self
            .permissions
            .iter()
            .fold(value_weight(&request.params).saturating_add(value_weight(&call)), |sum, p| sum.saturating_add(value_weight(&p.params)));
        if self.permissions.len() >= self.options.limits.permissions || weight > self.options.limits.permission_bytes {
            self.fail("ACP permission state budget exceeded.");
            return;
        }
        self.permissions.push(Permission {
            turn,
            id: request.id.clone(),
            params: request.params.clone(),
            created: Instant::now(),
            claimed: false,
        });
        if !self.emit(SessionEvent::Permission { turn_id: turn, request_id: request.id, params: request.params, call }) {
            self.fail("Session consumer stalled.");
        }
    }
    fn incoming(&mut self, event: ServerEvent) {
        match event {
            ServerEvent::Notification(n) => self.notification(&n.method, &n.params),
            ServerEvent::Request(r) => self.server_request(r),
            ServerEvent::ResponseBoundary { method } => {
                if let Some(op) = self.operation.as_mut() {
                    if op.method == method {
                        op.boundary = true;
                    }
                }
            }
            ServerEvent::Exit(info) => {
                self.fail(&info.detail);
                self.incoming = None;
            }
            // Raw logs are not transcript events; bounded transport drains them without surfacing URLs.
            _ => {}
        }
    }
    fn command(&mut self, cmd: Command) {
        match cmd {
            Command::Send(turn) => self.queue.push_back(turn),
            Command::Inspect(reply) => {
                let _=reply.send(json!({"nativeId":self.native,"capabilities":self.capabilities,"state":self.state.snapshot(),"stateBytes":self.state.retained_weight(),"permissions":self.permissions.len(),"ready":self.ready,"writingPermission":self.writing.as_ref().and_then(|w|w.work.id.as_ref()).map(RequestId::to_value),"pid":self.rpc.as_ref().and_then(AcpRpc::pid)}));
            }
            Command::FinishFake(reply) => {
                let Some(rpc) = self.rpc.clone() else {
                    let _ = reply.send(Err(SessionError::Closed));
                    return;
                };
                // Fake-only control uses the same single auxiliary operation slot.
                if self.writing.is_some() || !self.writes.is_empty() {
                    let _ = reply.send(Err(SessionError::Busy));
                } else {
                    self.writing = Some(Writing {
                        work: Write { id: None, turn: None, result: json!("fake/finish"), reply: None },
                        future: Box::pin(async move {
                            let result = rpc.request("fake/finish", json!({})).await;
                            let _ = reply.send(result.as_ref().map(|_| ()).map_err(|_| SessionError::Closed));
                            result.map(|_| ())
                        }),
                    });
                }
            }
            Command::Answer { turn, id, answer, reply } => {
                let prompt_ended =
                    self.operation.as_ref().is_some_and(|op| op.method == "session/prompt" && (op.boundary || op.result.is_some()));
                let entry = self.permissions.iter_mut().find(|p| p.turn == turn && p.id == id && !p.claimed);
                if self.cancelled || self.terminal.is_some() || self.stopping || prompt_ended || entry.is_none() {
                    let _ = reply.send(Err(SessionError::UnknownPermission));
                    return;
                }
                if reply.is_closed() {
                    return;
                }
                let p = entry.unwrap();
                p.claimed = true;
                let options = p.params["options"].as_array().map(Vec::as_slice).unwrap_or(&[]);
                let decision = match answer {
                    Answer::AllowOnce => Decision::Allow,
                    Answer::Deny => Decision::Deny,
                    Answer::Cancelled => Decision::Cancelled,
                };
                self.writes.push_back(Write {
                    id: Some(id),
                    turn: Some(turn),
                    result: protocol::permission_outcome(options, decision, true),
                    reply: Some(reply),
                });
            }
        }
    }
    fn start_write(&mut self) {
        if self.writing.is_some() {
            return;
        }
        let Some(work) = self.writes.pop_front() else {
            return;
        };
        if work.reply.as_ref().is_some_and(oneshot::Sender::is_closed) {
            self.fail("Permission answer abandoned; delivery uncertain.");
            return;
        }
        let rpc = self.rpc.as_ref().unwrap().clone();
        let id = work.id.clone();
        let result = work.result.clone();
        let native = self.native.clone();
        let future = Box::pin(async move {
            if let Some(id) = id {
                rpc.respond(&id, result).await
            } else {
                rpc.notify("session/cancel", Some(protocol::cancel(native.as_deref().unwrap_or("")))).await
            }
        });
        self.writing = Some(Writing { work, future });
    }
    fn write_done(&mut self, result: Result<(), RpcError>) {
        let Some(w) = self.writing.take() else {
            return;
        };
        let abandoned = w.work.reply.as_ref().is_some_and(oneshot::Sender::is_closed);
        let delivery = if result.is_ok() && !abandoned { Delivery::WrittenUnacknowledged } else { Delivery::Uncertain };
        if let Some(id) = w.work.id {
            if let Some(i) = self.permissions.iter().position(|p| p.id == id && Some(p.turn) == w.work.turn) {
                let p = self.permissions.remove(i);
                let event = SessionEvent::PermissionClosed { turn_id: p.turn, request_id: p.id, delivery };
                if !self.emit(event.clone()) {
                    self.reserved(event);
                }
            }
        }
        if let Some(reply) = w.work.reply {
            let _ = reply.send(if result.is_ok() { Ok(delivery) } else { Err(SessionError::UncertainDelivery) });
        }
        self.progress = Instant::now();
        if result.is_err() || abandoned {
            self.fail("Permission/control write failed or was abandoned; delivery uncertain.");
        }
    }
    fn watchdog(&mut self) {
        if self.writing.as_ref().is_some_and(|w| w.work.reply.as_ref().is_some_and(oneshot::Sender::is_closed)) {
            self.fail("Permission answer abandoned; delivery uncertain.");
            return;
        }
        if self.active.is_none() {
            if self.queue.front().is_some_and(|t| t.queued_at.elapsed() >= self.options.limits.startup_timeout) {
                self.fail("ACP idle stream did not become quiescent.");
            }
            return;
        }
        let now = Instant::now();
        if (self.cancelled || self.terminal.is_some() || !self.ready) && now >= self.stage_deadline {
            self.fail("ACP cancellation/startup deadline exceeded.");
        } else if now >= self.turn_deadline {
            self.fail("ACP turn deadline exceeded.");
        } else if self.permissions.iter().any(|p| now.duration_since(p.created) >= self.options.limits.permission_timeout) {
            self.fail("ACP permission watchdog expired.");
        } else if self.ready
            && !self.cancelled
            && self.terminal.is_none()
            && self.permissions.is_empty()
            && now.duration_since(self.progress) >= self.options.limits.idle_timeout
        {
            self.fail("ACP progress watchdog expired.");
        }
    }
    async fn run(mut self) {
        let mut ticks = tokio::time::interval(Duration::from_millis(5));
        loop {
            if *self.shutdown.borrow() {
                self.cancelled = true;
                self.fail("Session shutdown.");
            }
            let epoch = *self.stops.borrow_and_update();
            if epoch != self.epoch {
                self.stop(epoch);
            }
            self.watchdog();
            // One bounded command per iteration prevents a chatty peer starving Stop/answers.
            if let Ok(command) = self.commands.try_recv() {
                self.command(command);
            }
            if self.stopping {
                self.closed.store(true, Ordering::Release);
                self.commands.close();
                while let Ok(cmd) = self.commands.try_recv() {
                    match cmd {
                        Command::Send(t) => self.queue.push_back(t),
                        Command::Answer { reply, .. } => {
                            let _ = reply.send(Err(SessionError::Closed));
                        }
                        _ => {}
                    }
                }
                self.close_permissions();
                if self.active.is_some() && self.terminal.is_none() {
                    self.fail("Session closed.");
                }
            }
            if self.terminal.is_some() && self.permissions.is_empty() && self.writing.is_none() && self.writes.is_empty() {
                self.finalize_turn();
            }
            while self.active.is_none() && self.queue.front().is_some_and(|t| self.stopping || t.epoch < self.epoch) {
                let turn = self.queue.pop_front().unwrap();
                let event = SessionEvent::Agent { turn_id: turn.id, event: json!({"type":"turn-cancelled"}) };
                if self.stopping || !self.emit(event.clone()) {
                    self.reserved(event);
                }
            }
            if self.stopping && self.active.is_none() {
                break;
            }
            // Drain ready wire events before starting another turn. The transport's response
            // boundary prevents replay/late frames queued after a reply from entering that turn.
            if self.active.is_none() {
                if let Some(events) = &mut self.incoming {
                    if let Ok(event) = events.try_recv() {
                        self.incoming(event);
                        tokio::task::yield_now().await;
                        continue;
                    }
                }
                if let Some(turn) = self.queue.pop_front() {
                    self.begin(turn);
                    continue;
                }
            }
            if self.operation.as_ref().is_some_and(|op| {
                matches!(op.result.as_ref(), Some(Err(error)) if !error.is_server_error() && !matches!(error, RpcError::Exited{..}))
                    || (op.boundary && op.result.is_some())
            }) {
                let op = self.operation.take().unwrap();
                self.operation_done(op.method, op.result.unwrap());
                continue;
            }
            self.start_write();
            tokio::select! {
                biased;
                _=self.shutdown.changed()=>{self.cancelled=true;self.fail("Session shutdown.");},
                changed=self.stops.changed()=>{if changed.is_ok(){let epoch=*self.stops.borrow_and_update();self.stop(epoch);}else{self.cancelled=true;self.fail("Session handle dropped.");}},
                _=ticks.tick()=>self.watchdog(),
                result=async {self.writing.as_mut().unwrap().future.as_mut().await}, if self.writing.is_some()=>self.write_done(result),
                result=async {self.operation.as_mut().unwrap().future.as_mut().unwrap().as_mut().await}, if self.operation.as_ref().is_some_and(|o|o.future.is_some())=>{let op=self.operation.as_mut().unwrap();op.future=None;op.result=Some(result);},
                event=async {self.incoming.as_mut().unwrap().recv().await}, if self.incoming.is_some() && !self.operation.as_ref().is_some_and(|o|o.boundary)=>{if let Some(event)=event{self.incoming(event);}else{self.fail("ACP event stream ended.");self.incoming=None;}},
                command=self.commands.recv()=>{if let Some(cmd)=command{self.command(cmd);}else{self.cancelled=true;self.fail("Session handle dropped.");}},
            }
        }
        self.operation = None;
        self.writing = None;
        if let Some(rpc) = &self.rpc {
            rpc.close().await;
        }
        self.reserved(SessionEvent::Closed { last_turn: self.last });
        let _ = self.done.send(true);
    }
}

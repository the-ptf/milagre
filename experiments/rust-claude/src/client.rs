//! One Claude Code CLI process speaking the stream-json control protocol.
//!
//! A `ClaudeClient` is bound to exactly one process. Nothing is replayed: when the process exits every
//! waiter fails with [`ClientError::Exited`], handlers are cancelled, one final [`ClaudeEvent::Exit`] is
//! delivered and later calls fail. Continuing a conversation means spawning a new client with
//! `LaunchOptions::resume` set to the saved session id; messages and control requests that were in
//! flight are not resent.
//!
//! Backpressure: stdout messages go through a bounded event channel. When the owner stops draining it,
//! the reader stops reading stdout and the CLI blocks on its own writes. Control responses and the
//! CLI's control requests are routed before a message is queued, but they share stdout with messages,
//! so an owner that awaits a control reply must keep draining events concurrently. Writes go through a
//! bounded stdin queue; enqueueing waits at most `Limits::write_timeout`, then fails with
//! [`ClientError::Backpressure`] without writing.

use std::collections::hash_map::RandomState;
use std::collections::HashMap;
use std::fmt;
use std::hash::{BuildHasher, Hasher};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::timeout;

use crate::frame::{self, Frame, FrameError, Line, LineReader};
use crate::handlers::{cancel_pair, CancelReason, CancelSignal, CancelTrigger, Handlers};
use crate::launch::{InitializeOptions, LaunchOptions};
use crate::process::{group_alive, signal_group, Signal, StderrTail};
use crate::protocol::{self, ControlResponse, HookCallback, Inbound, IncomingRequest, McpMessage, PermissionRequest};
use std::collections::VecDeque;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Limits {
    /// Largest stdout frame accepted. Over it, the process is stopped (`ExitReason::ProtocolViolation`).
    pub max_frame_bytes: usize,
    /// Largest frame written to stdin; over it the call fails with `FrameTooLarge`, nothing written.
    pub max_outgoing_frame_bytes: usize,
    /// Control requests this side may have in flight.
    pub max_pending_requests: usize,
    /// CLI-originated requests handled at once; more are answered with an error.
    pub max_inbound_requests: usize,
    pub event_capacity: usize,
    pub write_queue: usize,
    pub write_timeout: Duration,
    /// A single stdin write blocked this long means the CLI stopped reading: the process is stopped
    /// (`ExitReason::InputStalled`) rather than leaving a frame half written.
    pub stall_timeout: Duration,
    /// Default per-request timeout (`None` waits until exit). The Python SDK's default is 60 s.
    pub request_timeout: Option<Duration>,
    pub initialize_timeout: Duration,
    /// `connect()` buffers at most this many events while waiting for initialize.
    pub max_initialize_events: usize,
    /// Maximum serialized payload bytes held by `connect()` before initialize completes.
    pub max_initialize_bytes: usize,
    /// stdout closed but the process still runs: kill it after this long. Also how long the reader
    /// may lag behind an exited process (a descendant holding stdout open).
    pub drain_grace: Duration,
    /// `close()`: after stdin EOF, how long the CLI gets to flush its session file before SIGTERM.
    pub close_grace: Duration,
    /// `close()`: SIGTERM to SIGKILL.
    pub kill_grace: Duration,
    pub stderr_tail_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_frame_bytes: 64 * 1024 * 1024,
            max_outgoing_frame_bytes: 64 * 1024 * 1024,
            max_pending_requests: 256,
            max_inbound_requests: 256,
            event_capacity: 1024,
            write_queue: 64,
            write_timeout: Duration::from_secs(10),
            stall_timeout: Duration::from_secs(30),
            request_timeout: Some(Duration::from_secs(60)),
            initialize_timeout: Duration::from_secs(60),
            max_initialize_events: 1024,
            max_initialize_bytes: 8 * 1024 * 1024,
            drain_grace: Duration::from_secs(2),
            close_grace: Duration::from_secs(5),
            kill_grace: Duration::from_secs(5),
            stderr_tail_bytes: 4000,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExitReason {
    /// The process ended on its own (or after stdin EOF from `end_input`).
    Exited,
    /// `close()` or `kill()` ended it.
    Closed,
    /// Oversized or corrupt stdout; the process was killed.
    ProtocolViolation(String),
    /// stdout could not be read; the process was killed.
    ReadError(String),
    /// stdout reached EOF and the process did not exit within `drain_grace`; it was killed.
    StdoutClosed,
    /// A stdin write blocked for `stall_timeout`; the process was killed.
    InputStalled,
    /// stdin write/flush failed while the process was still running; it was killed.
    WriteError(String),
    /// A handler's reply to the CLI could not be written (stdin closed, or the reply lane full); the
    /// process was killed rather than left waiting on an answer that will never come.
    ReplyLost,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExitInfo {
    pub reason: ExitReason,
    pub code: Option<i32>,
    pub signal: Option<i32>,
    pub stderr_tail: String,
}

impl fmt::Display for ExitInfo {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}", self.reason)?;
        if let Some(code) = self.code {
            write!(f, ", exit code {code}")?;
        }
        if let Some(signal) = self.signal {
            write!(f, ", signal {signal}")?;
        }
        let tail = self.stderr_tail.trim();
        if !tail.is_empty() {
            write!(f, ": {}", tail.lines().last().unwrap_or(tail))?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum ClientError {
    #[error("could not start the Claude CLI at {program}: {message}")]
    Spawn { program: String, message: String, not_found: bool },
    #[error("the Claude process ended ({0})")]
    Exited(ExitInfo),
    #[error("stdin was already closed")]
    InputEnded,
    #[error("outgoing frame of {size} bytes exceeds the {limit} byte limit")]
    FrameTooLarge { size: usize, limit: usize },
    #[error("stdin queue stayed full for {0:?}; nothing was written")]
    Backpressure(Duration),
    #[error("{0} control requests already in flight")]
    TooManyPending(usize),
    #[error("initialize output exceeded its buffer budget ({events} events, {bytes} bytes)")]
    InitializeBufferFull { events: usize, bytes: usize },
    #[error("control request {subtype} got no reply within {after:?}")]
    Timeout { subtype: String, after: Duration },
    #[error("control request {subtype} failed: {message}")]
    Control { subtype: String, message: String, raw: Value },
}

/// Something the transport noticed that is not a message. Never fatal.
#[derive(Debug, Clone, PartialEq)]
pub enum Diagnostic {
    NonJsonLine(String),
    /// Bytes after the last newline at EOF that did not parse (a write cut off mid-frame).
    TruncatedTail(String),
    /// A control_response for an id nobody waits on (timed out, dropped or never sent).
    UnmatchedResponse {
        request_id: String,
        raw: Value,
    },
    /// A cancel for a request that is not in flight (already answered).
    UnknownCancel {
        request_id: String,
    },
    /// A request id already being handled arrived again; the duplicate was ignored.
    DuplicateRequest {
        request_id: String,
    },
    Malformed {
        reason: String,
        raw: Value,
    },
    /// A handler's reply could not be written (process gone or stdin full).
    ReplyNotWritten {
        request_id: String,
        error: String,
    },
    /// A request was left unanswered on purpose (an undeclared `request_user_dialog`).
    Unanswered {
        request_id: String,
        subtype: String,
    },
}

#[derive(Debug, Clone)]
pub enum ClaudeEvent {
    /// A stdout frame that is not control traffic, exactly as written (all fields kept).
    Message(Value),
    Diagnostic(Diagnostic),
    /// The last event.
    Exit(ExitInfo),
}

/// A successful control reply: the `response` payload and the whole frame (which can carry
/// envelope-level fields such as `pending_permission_requests` on `initialize`).
#[derive(Debug, Clone, PartialEq)]
pub struct ControlReply {
    pub payload: Value,
    pub raw: Value,
}

/// Serialized payload size, without allocating a second copy of a potentially large frame.
fn event_bytes(event: &ClaudeEvent) -> usize {
    struct Counter(usize);
    impl std::io::Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 = self.0.saturating_add(bytes.len());
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let json_bytes = |value: &Value| {
        let mut counter = Counter(0);
        serde_json::to_writer(&mut counter, value).expect("JSON values serialize");
        counter.0
    };
    match event {
        ClaudeEvent::Message(value) => json_bytes(value),
        ClaudeEvent::Exit(info) => info.stderr_tail.len().saturating_add(128),
        ClaudeEvent::Diagnostic(diagnostic) => match diagnostic {
            Diagnostic::NonJsonLine(text) | Diagnostic::TruncatedTail(text) => text.len(),
            Diagnostic::UnmatchedResponse { request_id, raw } => request_id.len().saturating_add(json_bytes(raw)),
            Diagnostic::UnknownCancel { request_id } | Diagnostic::DuplicateRequest { request_id } => request_id.len(),
            Diagnostic::Malformed { reason, raw } => reason.len().saturating_add(json_bytes(raw)),
            Diagnostic::ReplyNotWritten { request_id, error } => request_id.len().saturating_add(error.len()),
            Diagnostic::Unanswered { request_id, subtype } => request_id.len().saturating_add(subtype.len()),
        },
    }
}

enum WriterCmd {
    Frame(Vec<u8>),
    /// A control request: skipped when its caller gave up before it was written.
    Request {
        id: String,
        bytes: Vec<u8>,
        written: Arc<AtomicBool>,
    },
    /// A reply to a CLI request (reserved lane). Losing one is fatal.
    Reply(Vec<u8>),
    End,
}

struct Pending {
    waiters: HashMap<String, (String, oneshot::Sender<ControlResponse>)>,
    exit: Option<ExitInfo>,
}

struct Inflight {
    triggers: HashMap<String, CancelTrigger>,
    closed: bool,
}

struct Shared {
    writer: mpsc::Sender<WriterCmd>,
    /// Reserved lane, written before the user lane: replies, request withdrawals and close()'s EOF.
    control: mpsc::Sender<WriterCmd>,
    pending: Mutex<Pending>,
    inflight: Mutex<Inflight>,
    session_id: Mutex<Option<String>>,
    initialize: Mutex<Option<ControlReply>>,
    input_ended: AtomicBool,
    closing: AtomicBool,
    /// The reader is waiting for room in the event channel (not for stdout).
    emitting: AtomicBool,
    /// A stdin write stalled and the process was killed for it.
    stalled: AtomicBool,
    /// A reply could not be delivered and the process was killed for it.
    reply_lost: AtomicBool,
    write_error: Mutex<Option<String>>,
    /// The leader was reaped; the group id is only signalled while members remain.
    reaped: AtomicBool,
    /// The group is known empty: its id may belong to someone else and is never signalled again.
    group_gone: AtomicBool,
    exit_rx: watch::Receiver<Option<ExitInfo>>,
    limits: Limits,
    pgid: Option<u32>,
    counter: AtomicU64,
    random: RandomState,
    events: mpsc::Sender<ClaudeEvent>,
}

impl Shared {
    /// The group id while it may still hold processes we started. Once the leader is reaped and the
    /// group is empty, the id may be reused by someone else and is never signalled again.
    fn group(&self) -> Option<u32> {
        let pgid = self.pgid?;
        if self.group_gone.load(Ordering::Acquire) {
            return None;
        }
        if self.reaped.load(Ordering::Acquire) && !group_alive(pgid) {
            self.group_gone.store(true, Ordering::Release);
            return None;
        }
        Some(pgid)
    }

    fn signal(&self, signal: Signal) {
        if let Some(pgid) = self.group() {
            signal_group(pgid, signal);
        }
    }

    /// Stop the process because the protocol can no longer be kept (a lost reply).
    fn fail_reply(&self) {
        // Serialize failure with close's transition: a late reply cannot interrupt session flush.
        let _inflight = self.inflight.lock().unwrap();
        if !self.closing.load(Ordering::SeqCst) {
            self.reply_lost.store(true, Ordering::SeqCst);
            self.signal(Signal::Kill);
        }
    }

    fn fail_write(&self, error: std::io::Error) {
        let _inflight = self.inflight.lock().unwrap();
        if !self.closing.load(Ordering::SeqCst) {
            *self.write_error.lock().unwrap() = Some(error.to_string());
            self.signal(Signal::Kill);
        }
    }

    fn cancel_handlers(&self, reason: CancelReason) {
        let triggers = {
            let mut inflight = self.inflight.lock().unwrap();
            if reason == CancelReason::Closed {
                self.closing.store(true, Ordering::SeqCst);
            }
            inflight.closed = true;
            std::mem::take(&mut inflight.triggers)
        };
        for trigger in triggers.values() {
            trigger.fire(reason);
        }
    }
}

/// SIGKILLs the group when the last client handle is dropped while the process still runs.
struct KillGuard {
    shared: Arc<Shared>,
}

impl Drop for KillGuard {
    fn drop(&mut self) {
        if self.shared.exit_rx.borrow().is_none() {
            self.shared.signal(Signal::Kill);
        }
    }
}

/// The events of one client. `connect` returns the events that arrived during `initialize` first.
#[derive(Debug)]
pub struct EventStream {
    buffered: VecDeque<ClaudeEvent>,
    rx: mpsc::Receiver<ClaudeEvent>,
}

impl EventStream {
    pub async fn recv(&mut self) -> Option<ClaudeEvent> {
        match self.buffered.pop_front() {
            Some(event) => Some(event),
            None => self.rx.recv().await,
        }
    }

    pub fn try_recv(&mut self) -> Option<ClaudeEvent> {
        self.buffered.pop_front().or_else(|| self.rx.try_recv().ok())
    }
}

#[derive(Clone)]
pub struct ClaudeClient {
    shared: Arc<Shared>,
    _guard: Arc<KillGuard>,
}

impl fmt::Debug for ClaudeClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ClaudeClient").field("pid", &self.shared.pgid).finish_non_exhaustive()
    }
}

impl ClaudeClient {
    /// Start the CLI. The owner must drain the returned events (see module docs), then call
    /// [`ClaudeClient::initialize`] before sending user messages.
    pub fn spawn(options: &LaunchOptions, handlers: Handlers, limits: Limits) -> Result<(Self, EventStream), ClientError> {
        let spawn_error = |error: std::io::Error| ClientError::Spawn {
            program: options.program.display().to_string(),
            not_found: error.kind() == std::io::ErrorKind::NotFound,
            message: error.to_string(),
        };
        // Prompt, settings and MCP config go in private files the supervisor removes at exit.
        let arg_dir = if options.private_files { Some(crate::launch::private_dir().map_err(spawn_error)?) } else { None };
        let args = match &arg_dir {
            Some(dir) => options.args_in(dir),
            None => Ok(options.args()),
        };
        let args = match args {
            Ok(args) => args,
            Err(error) => {
                remove_dir(&arg_dir);
                return Err(spawn_error(error));
            }
        };
        let mut command = Command::new(&options.program);
        command.args(args).env_clear().envs(options.environment());
        if let Some(cwd) = &options.cwd {
            command.current_dir(cwd);
        }
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                remove_dir(&arg_dir);
                return Err(spawn_error(error));
            }
        };
        let pgid = child.id();
        let stdin = child.stdin.take().expect("stdin piped");
        let stdout = child.stdout.take().expect("stdout piped");
        let stderr = child.stderr.take().expect("stderr piped");

        let (events_tx, events_rx) = mpsc::channel(limits.event_capacity.max(1));
        let (writer_tx, writer_rx) = mpsc::channel(limits.write_queue.max(1));
        // Room for every reply and withdrawal that can be outstanding at once, plus close()'s EOF.
        let (control_tx, control_rx) = mpsc::channel(limits.max_inbound_requests + limits.max_pending_requests + 8);
        let (exit_tx, exit_rx) = watch::channel(None);
        let shared = Arc::new(Shared {
            writer: writer_tx,
            control: control_tx,
            pending: Mutex::new(Pending { waiters: HashMap::new(), exit: None }),
            inflight: Mutex::new(Inflight { triggers: HashMap::new(), closed: false }),
            session_id: Mutex::new(options.resume.clone()),
            initialize: Mutex::new(None),
            input_ended: AtomicBool::new(false),
            closing: AtomicBool::new(false),
            emitting: AtomicBool::new(false),
            stalled: AtomicBool::new(false),
            reply_lost: AtomicBool::new(false),
            write_error: Mutex::new(None),
            reaped: AtomicBool::new(false),
            group_gone: AtomicBool::new(false),
            exit_rx: exit_rx.clone(),
            limits: limits.clone(),
            pgid,
            counter: AtomicU64::new(0),
            random: RandomState::new(),
            events: events_tx,
        });
        let tail = StderrTail::default();
        let stderr_task = tokio::spawn(tail.clone().drain(stderr, limits.stderr_tail_bytes));
        tokio::spawn(writer_loop(shared.clone(), stdin, writer_rx, control_rx));
        let reader = tokio::spawn(reader_loop(shared.clone(), handlers, stdout));
        tokio::spawn(supervise(shared.clone(), child, reader, stderr_task, tail, exit_tx, arg_dir));
        let _ = exit_rx;
        let guard = Arc::new(KillGuard { shared: shared.clone() });
        Ok((Self { shared, _guard: guard }, EventStream { buffered: VecDeque::new(), rx: events_rx }))
    }

    /// Spawn, then `initialize`, while forwarding events into the returned receiver.
    pub async fn connect(
        options: &LaunchOptions,
        init: &InitializeOptions,
        handlers: Handlers,
        limits: Limits,
    ) -> Result<(Self, EventStream, ControlReply), ClientError> {
        let max_events = limits.max_initialize_events;
        let max_bytes = limits.max_initialize_bytes;
        let (client, mut events) = Self::spawn(options, handlers, limits)?;
        // Drain while waiting, so output before the reply can never stall the reader behind a full channel.
        let result = {
            let initialize = client.initialize(init);
            tokio::pin!(initialize);
            let mut open = true;
            let mut buffered_bytes = 0usize;
            loop {
                tokio::select! {
                    result = &mut initialize => break result,
                    event = events.rx.recv(), if open => match event {
                        Some(event) => {
                            buffered_bytes = buffered_bytes.saturating_add(event_bytes(&event));
                            if events.buffered.len() >= max_events || buffered_bytes > max_bytes {
                                break Err(ClientError::InitializeBufferFull { events: max_events, bytes: max_bytes });
                            }
                            events.buffered.push_back(event);
                        },
                        None => open = false,
                    },
                }
            }
        };
        match result {
            Ok(reply) => Ok((client, events, reply)),
            Err(error) => {
                client.kill().await;
                Err(error)
            }
        }
    }

    pub fn pid(&self) -> Option<u32> {
        self.exit_info().is_none().then_some(self.shared.pgid).flatten()
    }

    /// The conversation id: the resumed id until the CLI's `system/init` reports one.
    pub fn session_id(&self) -> Option<String> {
        self.shared.session_id.lock().unwrap().clone()
    }

    /// The `initialize` reply (commands, models, account, output styles, pending prompts), once received.
    pub fn initialization(&self) -> Option<ControlReply> {
        self.shared.initialize.lock().unwrap().clone()
    }

    pub fn exit_info(&self) -> Option<ExitInfo> {
        self.shared.exit_rx.borrow().clone()
    }

    /// Resolves with the exit, however it happens.
    pub async fn wait(&self) -> ExitInfo {
        let mut rx = self.shared.exit_rx.clone();
        loop {
            if let Some(info) = rx.borrow_and_update().clone() {
                return info;
            }
            if rx.changed().await.is_err() {
                return rx.borrow().clone().expect("supervisor sets the exit before dropping the sender");
            }
        }
    }

    pub async fn initialize(&self, options: &InitializeOptions) -> Result<ControlReply, ClientError> {
        let reply = self.request_with_timeout(options.request(), Some(self.shared.limits.initialize_timeout)).await?;
        *self.shared.initialize.lock().unwrap() = Some(reply.clone());
        Ok(reply)
    }

    /// Send a user message (streaming input). Returns its uuid, which the CLI echoes on the turn's result.
    pub async fn send_user_message(&self, content: Vec<Value>) -> Result<String, ClientError> {
        let uuid = self.uuid();
        self.send_raw(&protocol::user_message(&uuid, content)).await?;
        Ok(uuid)
    }

    pub async fn send_user_text(&self, text: &str) -> Result<String, ClientError> {
        self.send_user_message(vec![protocol::text_block(text)]).await
    }

    /// Write any frame to stdin as is.
    pub async fn send_raw(&self, frame: &Value) -> Result<(), ClientError> {
        let bytes = self.encode(frame)?;
        self.enqueue(WriterCmd::Frame(bytes)).await
    }

    /// Close stdin. The CLI finishes and exits; no more frames can be written (control replies included).
    pub async fn end_input(&self) -> Result<(), ClientError> {
        if self.shared.input_ended.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        self.enqueue_unchecked(WriterCmd::End).await
    }

    /// A control request with the default timeout. `request` must carry `subtype`.
    pub async fn request(&self, request: Value) -> Result<ControlReply, ClientError> {
        self.request_with_timeout(request, self.shared.limits.request_timeout).await
    }

    pub async fn request_with_timeout(&self, request: Value, wait: Option<Duration>) -> Result<ControlReply, ClientError> {
        let subtype = request.get("subtype").and_then(Value::as_str).unwrap_or("").to_owned();
        let id = format!("req_{}_{:08x}", self.shared.counter.fetch_add(1, Ordering::SeqCst) + 1, self.random_u64() as u32);
        let bytes = self.encode(&protocol::control_request(&id, request))?;
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.shared.pending.lock().unwrap();
            if let Some(info) = &pending.exit {
                return Err(ClientError::Exited(info.clone()));
            }
            if pending.waiters.len() >= self.shared.limits.max_pending_requests {
                return Err(ClientError::TooManyPending(pending.waiters.len()));
            }
            pending.waiters.insert(id.clone(), (subtype.clone(), tx));
        }
        let written = Arc::new(AtomicBool::new(false));
        let mut guard = PendingGuard { shared: &self.shared, id: id.clone(), armed: true, written: written.clone() };
        self.enqueue(WriterCmd::Request { id: id.clone(), bytes, written }).await?;
        let outcome = match wait {
            Some(after) => match timeout(after, rx).await {
                Ok(result) => result,
                Err(_) => return Err(ClientError::Timeout { subtype, after }),
            },
            None => rx.await,
        };
        guard.armed = false;
        match outcome {
            Ok(ControlResponse { outcome: Ok(payload), raw, .. }) => Ok(ControlReply { payload, raw }),
            Ok(ControlResponse { outcome: Err(message), raw, .. }) => Err(ClientError::Control { subtype, message, raw }),
            // The supervisor dropped the sender: the process ended.
            Err(_) => Err(ClientError::Exited(self.wait().await)),
        }
    }

    /// Send a control request by subtype with extra fields.
    pub async fn control(&self, subtype: &str, fields: Value) -> Result<ControlReply, ClientError> {
        let mut request = match fields {
            Value::Object(map) => map,
            Value::Null => Default::default(),
            other => return Err(ClientError::Control { subtype: subtype.into(), message: "fields must be an object".into(), raw: other }),
        };
        request.insert("subtype".into(), subtype.into());
        self.request(Value::Object(request)).await
    }

    /// Stop the running turn. The reply lists queued message uuids that survive (`still_queued`).
    pub async fn interrupt(&self, cancel_queued: bool) -> Result<ControlReply, ClientError> {
        self.control("interrupt", if cancel_queued { json!({ "cancel_queued": true }) } else { Value::Null }).await
    }

    /// `None` resets to the session default model.
    pub async fn set_model(&self, model: Option<&str>) -> Result<ControlReply, ClientError> {
        self.control("set_model", json!({ "model": model })).await
    }

    pub async fn set_permission_mode(&self, mode: &str) -> Result<ControlReply, ClientError> {
        self.control("set_permission_mode", json!({ "mode": mode })).await
    }

    /// Flag-layer settings for the running session (`effortLevel`, `fastMode`, `outputStyle`, `ultracode`...).
    pub async fn apply_flag_settings(&self, settings: Value) -> Result<ControlReply, ClientError> {
        self.control("apply_flag_settings", json!({ "settings": settings })).await
    }

    /// `max_thinking_tokens: None` sends null (session default); `display` is sent only when given.
    pub async fn set_max_thinking_tokens(&self, max: Option<u64>, display: Option<&str>) -> Result<ControlReply, ClientError> {
        let mut fields = json!({ "max_thinking_tokens": max });
        if let Some(display) = display {
            fields["thinking_display"] = display.into();
        }
        self.control("set_max_thinking_tokens", fields).await
    }

    pub async fn mcp_toggle(&self, server_name: &str, enabled: bool) -> Result<ControlReply, ClientError> {
        self.control("mcp_toggle", json!({ "serverName": server_name, "enabled": enabled })).await
    }

    pub async fn mcp_status(&self) -> Result<ControlReply, ClientError> {
        self.control("mcp_status", Value::Null).await
    }

    pub async fn get_task_output(&self, task_id: &str) -> Result<ControlReply, ClientError> {
        self.control("get_task_output", json!({ "task_id": task_id })).await
    }

    pub async fn stop_task(&self, task_id: &str) -> Result<ControlReply, ClientError> {
        self.control("stop_task", json!({ "task_id": task_id })).await
    }

    pub async fn cancel_async_message(&self, message_uuid: &str) -> Result<ControlReply, ClientError> {
        self.control("cancel_async_message", json!({ "message_uuid": message_uuid })).await
    }

    /// Close stdin, give the CLI `close_grace` to exit, then SIGTERM the group, then SIGKILL it.
    pub async fn close(&self) -> ExitInfo {
        self.shared.cancel_handlers(CancelReason::Closed);
        if self.exit_info().is_none() && !self.shared.input_ended.swap(true, Ordering::SeqCst) {
            // The reserved lane always has room; user frames still queued behind it are dropped.
            let _ = self.shared.control.try_send(WriterCmd::End);
        }
        let limits = &self.shared.limits;
        if let Ok(info) = timeout(limits.close_grace, self.wait()).await {
            return info;
        }
        self.shared.signal(Signal::Term);
        if let Ok(info) = timeout(limits.kill_grace, self.wait()).await {
            return info;
        }
        self.kill().await
    }

    /// SIGKILL the group now and wait for the exit.
    pub async fn kill(&self) -> ExitInfo {
        self.shared.cancel_handlers(CancelReason::Closed);
        if self.exit_info().is_none() {
            self.shared.signal(Signal::Kill);
        }
        self.wait().await
    }

    /// A random v4 UUID (not cryptographic; ids only).
    pub fn uuid(&self) -> String {
        let (a, b) = (self.random_u64(), self.random_u64());
        let a = (a & 0xffff_ffff_ffff_0fff) | 0x0000_0000_0000_4000;
        let b = (b & 0x3fff_ffff_ffff_ffff) | 0x8000_0000_0000_0000;
        format!("{:08x}-{:04x}-{:04x}-{:04x}-{:012x}", a >> 32, (a >> 16) & 0xffff, a & 0xffff, b >> 48, b & 0xffff_ffff_ffff)
    }

    fn random_u64(&self) -> u64 {
        let mut hasher = self.shared.random.build_hasher();
        hasher.write_u64(self.shared.counter.fetch_add(1, Ordering::SeqCst));
        hasher.write_u128(SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        hasher.finish()
    }

    fn encode(&self, frame: &Value) -> Result<Vec<u8>, ClientError> {
        let limit = self.shared.limits.max_outgoing_frame_bytes;
        frame::encode(frame, limit).map_err(|size| ClientError::FrameTooLarge { size, limit })
    }

    async fn enqueue(&self, command: WriterCmd) -> Result<(), ClientError> {
        if self.shared.input_ended.load(Ordering::SeqCst) {
            return Err(self.exit_info().map(ClientError::Exited).unwrap_or(ClientError::InputEnded));
        }
        self.enqueue_unchecked(command).await
    }

    async fn enqueue_unchecked(&self, command: WriterCmd) -> Result<(), ClientError> {
        if let Some(info) = self.exit_info() {
            return Err(ClientError::Exited(info));
        }
        enqueue(&self.shared, command).await
    }
}

async fn enqueue(shared: &Shared, command: WriterCmd) -> Result<(), ClientError> {
    match shared.writer.send_timeout(command, shared.limits.write_timeout).await {
        Ok(()) => Ok(()),
        Err(mpsc::error::SendTimeoutError::Timeout(_)) => Err(ClientError::Backpressure(shared.limits.write_timeout)),
        Err(mpsc::error::SendTimeoutError::Closed(_)) => {
            // The writer stopped (stdin broken or the process gone): report the exit once it is known.
            let mut rx = shared.exit_rx.clone();
            let info = timeout(shared.limits.drain_grace + shared.limits.kill_grace, async {
                loop {
                    if let Some(info) = rx.borrow_and_update().clone() {
                        return Some(info);
                    }
                    if rx.changed().await.is_err() {
                        return rx.borrow().clone();
                    }
                }
            })
            .await
            .ok()
            .flatten();
            Err(info.map(ClientError::Exited).unwrap_or(ClientError::InputEnded))
        }
    }
}

/// Forgets a request whose caller timed out or dropped the future, and tells the CLI it no longer
/// needs the answer (`control_cancel_request`, which either side may send for its own request).
struct PendingGuard<'a> {
    shared: &'a Shared,
    id: String,
    armed: bool,
    written: Arc<AtomicBool>,
}

impl Drop for PendingGuard<'_> {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let removed = self.shared.pending.lock().unwrap().waiters.remove(&self.id).is_some();
        // A request still queued is skipped by the writer; only one the CLI has seen needs withdrawing.
        if removed && self.written.load(Ordering::SeqCst) && !self.shared.input_ended.load(Ordering::SeqCst) {
            if let Ok(bytes) = frame::encode(&protocol::cancel_request(&self.id), usize::MAX) {
                let _ = self.shared.control.try_send(WriterCmd::Frame(bytes));
            }
        }
    }
}

async fn writer_loop(shared: Arc<Shared>, stdin: ChildStdin, mut user: mpsc::Receiver<WriterCmd>, mut control: mpsc::Receiver<WriterCmd>) {
    let mut stdin = Some(stdin);
    let mut exit = shared.exit_rx.clone();
    loop {
        let command = tokio::select! {
            biased;
            command = control.recv() => command,
            command = user.recv() => command,
            // The process is gone: nothing more can be written, and the task must not outlive it.
            _ = exit.changed() => return,
        };
        let Some(command) = command else { return };
        let bytes = match command {
            WriterCmd::Frame(bytes) => bytes,
            WriterCmd::Request { id, bytes, written } => {
                if !shared.pending.lock().unwrap().waiters.contains_key(&id) {
                    continue;
                }
                written.store(true, Ordering::SeqCst);
                bytes
            }
            WriterCmd::Reply(bytes) => {
                if shared.closing.load(Ordering::SeqCst) {
                    continue;
                }
                if stdin.is_none() {
                    // stdin was closed first: the CLI would wait on this answer forever.
                    shared.fail_reply();
                    return;
                }
                bytes
            }
            WriterCmd::End => {
                if let Some(mut pipe) = stdin.take() {
                    let _ = timeout(shared.limits.stall_timeout, pipe.shutdown()).await;
                }
                continue;
            }
        };
        let Some(pipe) = stdin.as_mut() else { continue };
        // A frame is written whole or the process is stopped: nothing ever follows half a line.
        match timeout(shared.limits.stall_timeout, async {
            pipe.write_all(&bytes).await?;
            pipe.flush().await
        })
        .await
        {
            Ok(Ok(())) => {}
            // A CLI may close stdin and keep stdout/process alive. Stop it so accepted frames and
            // control waiters cannot disappear into a dead writer while the process hangs forever.
            Ok(Err(error)) => {
                shared.fail_write(error);
                return;
            }
            Err(_) => {
                shared.stalled.store(true, Ordering::SeqCst);
                shared.signal(Signal::Kill);
                return;
            }
        }
    }
}

fn remove_dir(dir: &Option<PathBuf>) {
    if let Some(dir) = dir {
        let _ = std::fs::remove_dir_all(dir);
    }
}

enum ReaderEnd {
    Eof,
    Violation(String),
    ReadError(String),
}

async fn emit(shared: &Shared, event: ClaudeEvent) {
    // A dropped receiver means nobody listens; control traffic still flows.
    let _ = shared.events.send(event).await;
}

fn diagnose(shared: &Shared, diagnostic: Diagnostic) {
    // Diagnostics never block the reader or a handler.
    let _ = shared.events.try_send(ClaudeEvent::Diagnostic(diagnostic));
}

async fn reader_loop(shared: Arc<Shared>, handlers: Handlers, stdout: ChildStdout) -> ReaderEnd {
    let mut lines = LineReader::new(BufReader::with_capacity(64 * 1024, stdout), shared.limits.max_frame_bytes);
    loop {
        let (bytes, is_tail) = match lines.next().await {
            Ok(Some(Frame::Line(bytes))) => (bytes, false),
            Ok(Some(Frame::Tail(bytes))) => (bytes, true),
            Ok(None) => return ReaderEnd::Eof,
            Err(FrameError::Read(error)) => return ReaderEnd::ReadError(error),
            Err(error) => return ReaderEnd::Violation(error.to_string()),
        };
        let value = match frame::parse_line(&bytes) {
            Ok(Line::Json(value)) => value,
            Ok(Line::Blank) => continue,
            Ok(Line::NonJson(text)) => {
                diagnose(&shared, Diagnostic::NonJsonLine(text));
                continue;
            }
            Err(error) if is_tail => {
                diagnose(&shared, Diagnostic::TruncatedTail(error.to_string()));
                continue;
            }
            Err(error) => return ReaderEnd::Violation(error.to_string()),
        };
        match protocol::classify(value) {
            Inbound::Response(response) => {
                let waiter = shared.pending.lock().unwrap().waiters.remove(&response.request_id);
                match waiter {
                    Some((_, tx)) => {
                        let _ = tx.send(response);
                    }
                    None => diagnose(&shared, Diagnostic::UnmatchedResponse { request_id: response.request_id, raw: response.raw }),
                }
            }
            Inbound::Request(request) => dispatch(&shared, &handlers, request),
            Inbound::Cancel { request_id, .. } => {
                let trigger = shared.inflight.lock().unwrap().triggers.remove(&request_id);
                match trigger {
                    Some(trigger) => trigger.fire(CancelReason::Withdrawn),
                    None => diagnose(&shared, Diagnostic::UnknownCancel { request_id }),
                }
            }
            Inbound::KeepAlive(_) => {}
            Inbound::Malformed { reason, raw } => diagnose(&shared, Diagnostic::Malformed { reason, raw }),
            Inbound::Message(value) => {
                if let (Some("system"), Some("init")) = protocol::message_kind(&value) {
                    if let Some(id) = value.get("session_id").and_then(Value::as_str) {
                        *shared.session_id.lock().unwrap() = Some(id.to_owned());
                    }
                }
                shared.emitting.store(true, Ordering::SeqCst);
                emit(&shared, ClaudeEvent::Message(value)).await;
                shared.emitting.store(false, Ordering::SeqCst);
            }
        }
    }
}

fn dispatch(shared: &Arc<Shared>, handlers: &Handlers, request: IncomingRequest) {
    let id = request.request_id.clone();
    let signal: CancelSignal = {
        let mut inflight = shared.inflight.lock().unwrap();
        if inflight.closed {
            return;
        }
        if inflight.triggers.contains_key(&id) {
            drop(inflight);
            diagnose(shared, Diagnostic::DuplicateRequest { request_id: id });
            return;
        }
        if inflight.triggers.len() >= shared.limits.max_inbound_requests {
            drop(inflight);
            let shared = shared.clone();
            tokio::spawn(async move {
                write_reply(&shared, &id, Some(Err("Too many control requests in flight".into()))).await;
            });
            return;
        }
        let (trigger, signal) = cancel_pair();
        inflight.triggers.insert(id.clone(), trigger);
        signal
    };
    let handlers = handlers.clone();
    let shared = shared.clone();
    tokio::spawn(async move {
        let subtype = request.subtype.clone();
        let work = tokio::spawn(handle(handlers, request, signal.clone()));
        let reply = match work.await {
            Ok(reply) => reply,
            Err(error) => Some(Err(format!("Milagre's handler for {subtype} failed: {error}"))),
        };
        // Withdrawn, exited or closed: the entry is gone and the reply is discarded.
        let still_open = shared.inflight.lock().unwrap().triggers.remove(&id).is_some();
        if !still_open || signal.reason().is_some() {
            return;
        }
        if reply.is_none() {
            diagnose(&shared, Diagnostic::Unanswered { request_id: id.clone(), subtype });
        }
        write_reply(&shared, &id, reply).await;
    });
}

/// `None`: no reply at all.
async fn handle(handlers: Handlers, request: IncomingRequest, cancel: CancelSignal) -> Option<Result<Value, String>> {
    let IncomingRequest { request_id, subtype, request, .. } = request;
    match subtype.as_str() {
        "can_use_tool" => {
            let parsed = match PermissionRequest::from_request(&request_id, &request) {
                Ok(parsed) => parsed,
                Err(error) => return Some(Err(error)),
            };
            let input = parsed.input.clone();
            let result = match (&handlers.questions, &handlers.permissions) {
                (Some(questions), _) if parsed.is_question() => questions.ask(parsed, cancel).await,
                (_, Some(permissions)) => permissions.can_use_tool(parsed, cancel).await,
                _ => Err("canUseTool callback is not provided".into()),
            };
            Some(result.map(|result| result.to_payload(&input)))
        }
        "hook_callback" => {
            let parsed = match HookCallback::from_request(&request_id, &request) {
                Ok(parsed) => parsed,
                Err(error) => return Some(Err(error)),
            };
            match &handlers.hooks {
                Some(hooks) => Some(hooks.call(parsed, cancel).await),
                None => Some(Err(format!("No hook callback found for ID: {}", parsed.callback_id))),
            }
        }
        "mcp_message" => {
            let parsed = match McpMessage::from_request(&request_id, &request) {
                Ok(parsed) => parsed,
                Err(error) => return Some(Err(error)),
            };
            let reply = match &handlers.mcp {
                None => parsed.unknown_server(),
                Some(mcp) => match mcp.message(parsed.clone(), cancel).await {
                    Ok(Some(reply)) => reply,
                    Ok(None) => protocol::mcp_notification_ack(),
                    Err(error) => parsed.internal_error(&error),
                },
            };
            Some(Ok(json!({ "mcp_response": reply })))
        }
        _ => match &handlers.other {
            Some(other) => other.request(subtype, request, cancel).await.transpose(),
            None if subtype == "request_user_dialog" => None,
            None => Some(Err(format!("Unsupported control request subtype: {subtype}"))),
        },
    }
}

/// Queue a reply on the reserved lane. A reply that cannot be delivered stops the process: the CLI
/// would otherwise wait on it forever.
async fn write_reply(shared: &Shared, request_id: &str, reply: Option<Result<Value, String>>) {
    if shared.closing.load(Ordering::SeqCst) {
        return;
    }
    let frame = match reply {
        None => return,
        Some(Ok(payload)) => protocol::success_response(request_id, payload),
        Some(Err(error)) => protocol::error_response(request_id, &error),
    };
    let bytes = frame::encode(&frame, shared.limits.max_outgoing_frame_bytes).unwrap_or_else(|size| {
        // Too large to send as is: answer with an error so the CLI is not left waiting.
        let fallback = protocol::error_response(request_id, &format!("reply of {size} bytes exceeds the frame limit"));
        frame::encode(&fallback, usize::MAX).expect("small frame")
    });
    if shared.exit_rx.borrow().is_some() {
        return;
    }
    let error = match shared.control.try_send(WriterCmd::Reply(bytes)) {
        Ok(()) => return,
        Err(mpsc::error::TrySendError::Full(_)) => "the reply lane is full",
        Err(mpsc::error::TrySendError::Closed(_)) => "stdin is gone",
    };
    shared.fail_reply();
    diagnose(shared, Diagnostic::ReplyNotWritten { request_id: request_id.into(), error: error.into() });
}

async fn supervise(
    shared: Arc<Shared>,
    mut child: Child,
    mut reader: tokio::task::JoinHandle<ReaderEnd>,
    stderr_task: tokio::task::JoinHandle<()>,
    tail: StderrTail,
    exit_tx: watch::Sender<Option<ExitInfo>>,
    arg_dir: Option<PathBuf>,
) {
    let grace = shared.limits.drain_grace;
    let kill = |shared: &Shared| shared.signal(Signal::Kill);
    let mut forced: Option<ExitReason> = None;
    let status = tokio::select! {
        end = &mut reader => {
            match end.unwrap_or(ReaderEnd::ReadError("reader task failed".into())) {
                ReaderEnd::Violation(detail) => {
                    forced = Some(ExitReason::ProtocolViolation(detail));
                    kill(&shared);
                }
                ReaderEnd::ReadError(detail) => {
                    forced = Some(ExitReason::ReadError(detail));
                    kill(&shared);
                }
                ReaderEnd::Eof => {}
            }
            let status = match timeout(grace, child.wait()).await {
                Ok(status) => status.ok(),
                Err(_) => {
                    if forced.is_none() {
                        forced = Some(ExitReason::StdoutClosed);
                    }
                    kill(&shared);
                    let _ = child.start_kill();
                    child.wait().await.ok()
                }
            };
            shared.reaped.store(true, Ordering::Release);
            status
        }
        status = child.wait() => {
            shared.reaped.store(true, Ordering::Release);
            // Messages written before the exit are still delivered (see below). A descendant holding
            // stdout open gets `drain_grace`, then the group is killed.
            if timeout(grace, &mut reader).await.is_err() && !shared.emitting.load(Ordering::SeqCst) {
                kill(&shared);
            }
            status.ok()
        }
    };
    // Whatever the leader left in its group (background shells, MCP servers) goes with it. `group()`
    // re-checks membership before each signal, so an emptied group's id is never signalled.
    if shared.group().is_some() {
        shared.signal(Signal::Term);
        tokio::time::sleep(Duration::from_millis(100)).await;
        shared.signal(Signal::Kill);
    }
    remove_dir(&arg_dir);
    let _ = timeout(Duration::from_millis(500), stderr_task).await;
    let write_error = shared.write_error.lock().unwrap().clone();
    let reason = match forced {
        _ if shared.stalled.load(Ordering::SeqCst) => ExitReason::InputStalled,
        _ if shared.reply_lost.load(Ordering::SeqCst) => ExitReason::ReplyLost,
        _ if write_error.is_some() => ExitReason::WriteError(write_error.unwrap()),
        Some(reason) => reason,
        None if shared.closing.load(Ordering::SeqCst) => ExitReason::Closed,
        None => ExitReason::Exited,
    };
    #[cfg(unix)]
    let signal = status.and_then(|status| std::os::unix::process::ExitStatusExt::signal(&status));
    #[cfg(not(unix))]
    let signal = None;
    let info = ExitInfo { reason, code: status.and_then(|status| status.code()), signal, stderr_tail: tail.text() };

    // The process is gone: new calls fail, `wait`/`close`/`kill` return, nobody can answer a handler.
    shared.pending.lock().unwrap().exit = Some(info.clone());
    shared.input_ended.store(true, Ordering::SeqCst);
    let _ = exit_tx.send(Some(info.clone()));
    shared.cancel_handlers(CancelReason::Exited);

    // Replies already in the pipe get `drain_grace` to reach their waiters; after that every waiter
    // fails, even when the owner has stopped draining events.
    if !reader.is_finished() {
        let _ = timeout(grace, &mut reader).await;
    }
    drop(std::mem::take(&mut shared.pending.lock().unwrap().waiters));

    // Let the reader deliver what the process wrote before it ended, however slowly the owner drains.
    // It is only abandoned when it is blocked reading a pipe that a process outside the group keeps open.
    if !reader.is_finished() {
        loop {
            match timeout(grace, &mut reader).await {
                Ok(_) => break,
                Err(_) if shared.emitting.load(Ordering::SeqCst) => continue,
                Err(_) => {
                    reader.abort();
                    break;
                }
            }
        }
    }

    // No replay: control requests still waiting fail with the exit, nothing is resent. A reply the
    // reader routed above already reached its waiter.
    let waiters = std::mem::take(&mut shared.pending.lock().unwrap().waiters);
    drop(waiters);
    emit(&shared, ClaudeEvent::Exit(info)).await;
}

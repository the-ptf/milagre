//! Process transport for an ACP agent. Rust port of packages/core/src/agents/acp-rpc.cjs
//! plus the parts of process-tree.cjs it relies on, with explicit bounds:
//!
//! - **Frames** are newline-delimited JSON. An incoming frame over [`Limits::max_frame_bytes`] is a
//!   protocol violation: the process tree is stopped and every pending request fails, rather than
//!   silently dropping what might be a response somebody waits on. Outgoing frames are capped too.
//! - **Requests** in flight are capped by [`Limits::max_pending_requests`]; past it a request fails
//!   at once with [`RpcError::TooManyPending`].
//! - **Timeouts** are per request; `None` waits until ACP agent answers or exits (thread/start).
//! - **Cancellation**: dropping a request future forgets its id. A late answer is reported as a
//!   [`Diagnostic::UnmatchedResponse`] and never delivered to a later request.
//! - **No replay**: ids are never reused, nothing is resent after a timeout, cancellation or exit,
//!   and a closed transport never respawns. A new process needs a new [`AcpRpc`].
//! - **Server requests** are tracked until answered or the process exits, with duplicate IDs
//!   refused while unanswered or being answered. Cancelled answer futures stop the process.
//! - **stderr** is drained on its own task into a bounded tail, never parsed as protocol, and
//!   emits bounded line events (including sign-in URLs) as in Node.
//! - **EOF / failure**: stdout EOF, a read error, a dead process or an oversized frame all end in one
//!   [`ExitInfo`]: pending requests fail with the exit detail, the process group is reaped, and an
//!   EOF on stdout with the process still alive stops it.

use crate::protocol::{self, classify, Incoming, RequestId};
use crate::queue::{EventReceiver, EventSender, QueueLimits};
use serde_json::Value;
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, oneshot, watch};

/// acp-rpc.cjs's default request timeout.
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone)]
pub struct Limits {
    /// Frame ceiling in either direction, newline excluded. Inline base64 content also has to fit
    /// the independent parsed event heap budget, which charges both raw and params copies.
    pub max_frame_bytes: usize,
    /// Structural tokens before JSON allocation; strings remain bounded by frame bytes.
    pub max_json_tokens: usize,
    /// Queued plus currently-writing frames and bytes. Reservation never waits.
    pub writer_queue: QueueLimits,
    /// Requests from Milagre awaiting an answer at once.
    pub max_pending_requests: usize,
    /// Bytes of stderr kept for the exit detail (acp-rpc.cjs keeps 8000 UTF-16 units; Rust caps bytes).
    pub stderr_tail_bytes: usize,
    /// process-tree.cjs `graceMs`: SIGTERM, then SIGKILL after this, then give up after it again.
    pub kill_grace: Duration,
    /// How long stdout and stderr may stay open after the process exited (a grandchild holding the
    /// pipe), and how long a process may live after closing stdout, before it is cut off.
    pub drain_grace: Duration,
    /// Timeout for writing a notification or a server-request answer into a stalled stdin pipe.
    pub write_timeout: Duration,
    /// Budget for events not yet received. Past it ACP agent is stopped ([`ExitReason::ConsumerStalled`])
    /// instead of buffering without limit or blocking the reader that answers requests.
    pub event_queue: QueueLimits,
    /// Server requests ACP agent may leave open at once before it is stopped as misbehaving.
    pub max_open_server_requests: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            max_frame_bytes: 8 * 1024 * 1024,
            max_json_tokens: 65_536,
            writer_queue: QueueLimits { max_events: 128, max_bytes: 16 * 1024 * 1024 },
            max_pending_requests: 64,
            stderr_tail_bytes: 8000,
            kill_grace: Duration::from_secs(2),
            drain_grace: Duration::from_millis(500),
            write_timeout: Duration::from_secs(10),
            event_queue: QueueLimits::default(),
            max_open_server_requests: 1024,
        }
    }
}

#[derive(Clone)]
pub struct SpawnOptions {
    pub command: OsString,
    /// Explicit arguments. Never defaults to a vendor command.
    pub args: Vec<OsString>,
    pub cwd: Option<PathBuf>,
    /// `Some` replaces the environment entirely (Node's `env` option); `None` inherits it.
    pub env: Option<Vec<(OsString, OsString)>>,
    pub limits: Limits,
    /// Exact server methods deliberately handled by the event consumer. Others get -32601.
    pub owned_server_methods: Vec<String>,
    /// Emit ordered response boundaries before completing client request futures.
    pub response_boundaries: bool,
}

/// Never prints the environment: it holds API keys and tokens.
impl std::fmt::Debug for SpawnOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SpawnOptions")
            .field("command", &"<redacted>")
            .field("args", &format!("<{} arguments redacted>", self.args.len()))
            .field("cwd", &self.cwd.as_ref().map(|_| "<redacted>"))
            .field("env", &self.env.as_ref().map(|vars| format!("<{} variables redacted>", vars.len())))
            .field("limits", &self.limits)
            .finish()
    }
}

impl SpawnOptions {
    pub fn new(command: impl Into<OsString>) -> Self {
        SpawnOptions {
            command: command.into(),
            args: Vec::new(),
            cwd: None,
            env: Some(Vec::new()),
            limits: Limits::default(),
            owned_server_methods: Vec::new(),
            response_boundaries: false,
        }
    }

    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        self.args = args.into_iter().map(Into::into).collect();
        self
    }

    pub fn cwd(mut self, cwd: impl Into<PathBuf>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }

    pub fn env<I, K, V>(mut self, env: I) -> Self
    where
        I: IntoIterator<Item = (K, V)>,
        K: Into<OsString>,
        V: Into<OsString>,
    {
        self.env = Some(env.into_iter().map(|(k, v)| (k.into(), v.into())).collect());
        self
    }

    pub fn owned_server_methods(mut self, methods: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.owned_server_methods = methods.into_iter().map(Into::into).collect();
        self
    }

    pub fn limits(mut self, limits: Limits) -> Self {
        self.limits = limits;
        self
    }
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum RpcError {
    /// ACP agent answered with an error. The only variant that means "ACP agent itself refused"
    /// (Node's `error.rpcError`); the provider retries or falls back only on this one.
    #[error("{message}")]
    Server { method: String, code: i64, message: String, data: Option<Box<Value>> },
    #[error("ACP agent did not answer {method} within {} s.", .after.as_secs_f64().round())]
    Timeout { method: String, after: Duration },
    /// The process exited (or was stopped) while the request waited.
    #[error("{detail}")]
    Exited { detail: String },
    /// The transport had already exited when the call was made.
    #[error("ACP agent is not running.")]
    NotRunning,
    #[error("Too many ACP agent requests in flight (limit {limit}).")]
    TooManyPending { limit: usize },
    #[error("A ACP agent message of {size} bytes exceeds the {limit}-byte limit.")]
    FrameTooLarge { size: usize, limit: usize },
    /// Answering a server request that is unknown, already answered or from a dead process.
    #[error("ACP agent is not waiting on server request {id}.")]
    UnknownServerRequest { id: String },
    /// The request was cancelled before any byte of it was written.
    #[error("An ACP prompt is already running.")]
    PromptActive,
    #[error("ACP writer queue is full.")]
    WriterFull,
    #[error("ACP request ID space exhausted.")]
    IdExhausted,
    #[error("The ACP agent request was cancelled before it was sent.")]
    Cancelled,
    #[error("Writing to ACP agent failed: {0}")]
    Io(String),
}

impl RpcError {
    /// Node's `Boolean(error.rpcError)`.
    pub fn is_server_error(&self) -> bool {
        matches!(self, RpcError::Server { .. })
    }
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum SpawnError {
    /// Same text as acp-rpc.cjs for ENOENT.
    #[error("{detail}")]
    NotFound { detail: String },
    #[error("ACP agent could not be started: {0}")]
    Io(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Notification {
    pub method: String,
    pub params: Value,
    /// The frame exactly as received, for events not normalized yet.
    pub raw: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ServerRequest {
    pub id: RequestId,
    pub method: String,
    pub params: Value,
    pub raw: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitReason {
    /// The process ended (or closed stdout) on its own.
    ProcessEnded,
    /// [`AcpRpc::close`] or drop stopped it.
    Closed,
    /// ACP agent broke the framing contract (an oversized frame, too many open requests); Milagre stopped it.
    ProtocolViolation,
    /// Nobody read the events within [`Limits::event_queue`]; Milagre stopped ACP agent.
    ConsumerStalled,
    /// ACP agent stopped reading its input for [`Limits::write_timeout`]; Milagre stopped it.
    InputStalled,
    /// ACP agent closed its input while still running; nothing could be answered, so Milagre stopped it.
    InputClosed,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExitInfo {
    pub code: Option<i32>,
    /// Signal number on Unix.
    pub signal: Option<i32>,
    /// What acp-rpc.cjs puts in its exit event: stderr tail, or "ACP agent exited with code N (SIG)."
    pub detail: String,
    pub reason: ExitReason,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Diagnostic {
    /// An answer to an id nobody waits on any more (timed out, cancelled) or never sent.
    UnmatchedResponse { id: RequestId },
    /// The method was not claimed by the consumer; a -32601 answer was queued.
    UnsupportedRequest { id: RequestId, method: String },
}

#[derive(Debug, Clone, PartialEq)]
pub enum ServerEvent {
    Notification(Notification),
    Request(ServerRequest),
    Diagnostic(Diagnostic),
    /// Opt-in wire-order marker for a matched response; its future resolves after this is queued.
    ResponseBoundary {
        method: String,
    },
    /// Nonblank stdout/stderr lines, including sign-in URLs. Sensitive diagnostic data.
    Line {
        stream: Stream,
        line: String,
    },
    /// Always the last event.
    Exit(ExitInfo),
}

// Retained-allocation charge, not wire size or an RSS measurement. Saturating arithmetic
// fails closed. Arrays use allocated capacity; the map allowance covers indexmap buckets,
// growth slack and allocation headers. Every node includes a generous fixed allowance.
pub(crate) fn value_weight(value: &Value) -> usize {
    let dynamic = match value {
        Value::String(s) => s.capacity(),
        Value::Number(n) => n.to_string().len().saturating_mul(4),
        Value::Array(a) => {
            a.iter().fold(a.capacity().saturating_mul(std::mem::size_of::<Value>()), |sum, v| sum.saturating_add(value_weight(v)))
        }
        Value::Object(o) => {
            o.iter().fold(o.len().saturating_mul(256), |sum, (k, v)| sum.saturating_add(k.capacity()).saturating_add(value_weight(v)))
        }
        _ => 0,
    };
    64usize.saturating_add(dynamic)
}
fn event_weight(event: &ServerEvent) -> usize {
    let dynamic = match event {
        ServerEvent::Notification(n) => n.method.capacity().saturating_add(value_weight(&n.params)).saturating_add(value_weight(&n.raw)),
        ServerEvent::Request(r) => r
            .method
            .capacity()
            .saturating_add(value_weight(&r.id.to_value()))
            .saturating_add(value_weight(&r.params))
            .saturating_add(value_weight(&r.raw)),
        ServerEvent::Diagnostic(Diagnostic::UnmatchedResponse { id }) => value_weight(&id.to_value()),
        ServerEvent::Diagnostic(Diagnostic::UnsupportedRequest { id, method }) => {
            value_weight(&id.to_value()).saturating_add(method.capacity())
        }
        ServerEvent::ResponseBoundary { method } => method.capacity(),
        ServerEvent::Line { line, .. } => line.capacity(),
        ServerEvent::Exit(info) => info.detail.capacity(),
    };
    256usize.saturating_add(dynamic)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stream {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RpcStats {
    pub requests_sent: u64,
    pub responses_matched: u64,
    pub unmatched_responses: u64,
    pub malformed_frames: u64,
    pub notifications: u64,
    pub server_requests: u64,
}

struct Waiter {
    method: String,
    tx: oneshot::Sender<Result<Value, RpcError>>,
}

#[derive(Default)]
struct Counters {
    requests_sent: AtomicU64,
    responses_matched: AtomicU64,
    unmatched_responses: AtomicU64,
    malformed_frames: AtomicU64,
    notifications: AtomicU64,
    server_requests: AtomicU64,
}

/// State shared by the handle, the reader and the supervisor.
struct Shared {
    limits: Limits,
    pending: Mutex<HashMap<i64, Waiter>>,
    /// Server requests awaiting Milagre's answer: id -> answer in progress.
    server_requests: Mutex<HashMap<RequestId, bool>>,
    exited: Mutex<Option<ExitInfo>>,
    exit_tx: watch::Sender<Option<ExitInfo>>,
    events: EventSender<ServerEvent>,
    /// Why Milagre stopped the process itself, when it did.
    stopped: Mutex<Option<StopCause>>,
    pid: Option<u32>,
    kill_tx: mpsc::Sender<KillRequest>,
    /// The leader has been waited for; its pid may be reused once its group is empty.
    reaped: AtomicBool,
    /// The group was seen empty after the leader was reaped: never signal that id again.
    group_gone: AtomicBool,
    stderr: Mutex<Vec<u8>>,
    closing: AtomicBool,
    writer_closed: AtomicBool,
    counters: Counters,
    command_name: String,
    owned_server_methods: Vec<String>,
    response_boundaries: bool,
    writer: mpsc::UnboundedSender<WriterMsg>,
    writer_slots: Arc<tokio::sync::Semaphore>,
    writer_bytes: Arc<tokio::sync::Semaphore>,
}

impl Shared {
    /// Queues an event of about `bytes` bytes. A full queue stops ACP agent: memory stays bounded and no
    /// event is silently lost.
    fn emit(&self, event: ServerEvent, bytes: usize) {
        let bytes = bytes.max(event_weight(&event));
        if let Err(overflow) = self.events.send(event, bytes) {
            self.stop(StopCause::ConsumerStalled { events: overflow.queued_events, bytes: overflow.queued_bytes });
        }
    }

    /// Stops the process tree from the reader; the supervisor reports the exit with this cause.
    fn stop(&self, cause: StopCause) {
        {
            let mut stopped = self.stopped.lock().unwrap();
            if stopped.is_some() {
                return;
            }
            *stopped = Some(cause);
        }
        self.signal(SIGKILL_OR_KILL);
        let _ = self.kill_tx.try_send(KillRequest::Kill);
    }

    /// Whether the process group may still have members we started. Once the leader is reaped and
    /// the group is empty, the id may belong to someone else: it is never signalled again.
    #[cfg(unix)]
    fn group_signallable(&self) -> Option<u32> {
        let pid = self.pid?;
        if self.group_gone.load(Ordering::Acquire) {
            return None;
        }
        if self.reaped.load(Ordering::Acquire) && !group_alive(pid) {
            self.group_gone.store(true, Ordering::Release);
            return None;
        }
        Some(pid)
    }

    #[cfg(unix)]
    fn signal(&self, signal: libc::c_int) {
        if let Some(pid) = self.group_signallable() {
            signal_group(pid, signal);
        }
    }

    #[cfg(not(unix))]
    fn signal(&self, _signal: i32) {}

    fn is_exited(&self) -> bool {
        self.exited.lock().unwrap().is_some()
    }

    fn dispatch_line(&self, line: &[u8]) {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if line.iter().all(u8::is_ascii_whitespace) {
            return;
        }
        if !json_tokens_fit(line, self.limits.max_json_tokens) {
            return self.stop(StopCause::ComplexJson);
        }
        let parsed: Value = match serde_json::from_slice(line) {
            Ok(value) => value,
            Err(_) => return self.malformed(line),
        };
        // Bound IDs/methods retained outside the frame/event buffers too.
        if parsed.get("id").is_some_and(|id| id.to_string().len() > 4096)
            || parsed.get("method").and_then(Value::as_str).is_some_and(|m| m.len() > 4096)
        {
            return self.stop(StopCause::ComplexJson);
        }
        match classify(&parsed) {
            Incoming::Request { id, method, params } => {
                self.counters.server_requests.fetch_add(1, Ordering::Relaxed);
                {
                    let mut open = self.server_requests.lock().unwrap();
                    if open.len() >= self.limits.max_open_server_requests {
                        drop(open);
                        return self.stop(StopCause::TooManyServerRequests);
                    }
                    if open.contains_key(&id) {
                        drop(open);
                        return self.stop(StopCause::DuplicateServerId);
                    }
                    open.insert(id.clone(), !self.owned_server_methods.contains(&method));
                }
                if !self.owned_server_methods.contains(&method) {
                    // No task per request and no wait in the reader. Refusals share the bounded
                    // single writer; saturation stops the peer instead of leaving it hanging.
                    if self.reject_unsupported(id.clone()).is_err() {
                        self.stop(StopCause::InputStalled);
                    } else {
                        self.emit(ServerEvent::Diagnostic(Diagnostic::UnsupportedRequest { id, method }), 0);
                    }
                    return;
                }
                self.emit(ServerEvent::Request(ServerRequest { id, method, params, raw: parsed }), line.len());
            }
            Incoming::Notification { method, params } => {
                self.counters.notifications.fetch_add(1, Ordering::Relaxed);
                self.emit(ServerEvent::Notification(Notification { method, params, raw: parsed }), line.len());
            }
            Incoming::Response { id, outcome } => {
                let waiter = id.integer().and_then(|n| self.pending.lock().unwrap().remove(&n));
                let Some(waiter) = waiter else {
                    self.counters.unmatched_responses.fetch_add(1, Ordering::Relaxed);
                    return self.emit(ServerEvent::Diagnostic(Diagnostic::UnmatchedResponse { id }), 64);
                };
                self.counters.responses_matched.fetch_add(1, Ordering::Relaxed);
                if self.response_boundaries {
                    self.emit(ServerEvent::ResponseBoundary { method: waiter.method.clone() }, 0);
                }
                let result = outcome.map_err(|error| RpcError::Server {
                    message: if error.message.is_empty() { format!("ACP agent {} failed.", waiter.method) } else { error.message },
                    method: waiter.method,
                    code: error.code,
                    data: error.data.map(Box::new),
                });
                // The requester may have been cancelled between the lookup and now; nothing to do then.
                let _ = waiter.tx.send(result);
            }
            Incoming::Invalid { reason: "invalid request id" } => self.stop(StopCause::InvalidId),
            Incoming::Invalid { .. } if parsed.is_object() || parsed.is_array() => {}
            Incoming::Invalid { .. } => self.malformed(line),
        }
    }

    fn reject_unsupported(&self, id: RequestId) -> Result<(), ()> {
        let bytes =
            encode(&protocol::error_frame(&id, protocol::METHOD_NOT_FOUND, "Unsupported ACP client method"), self.limits.max_frame_bytes)
                .map_err(|_| ())?;
        let slots = self.writer_slots.clone().try_acquire_owned().map_err(|_| ())?;
        let space = self.writer_bytes.clone().try_acquire_many_owned(u32::try_from(bytes.len()).map_err(|_| ())?).map_err(|_| ())?;
        self.writer
            .send(WriterMsg::Frame(Outgoing { _reservation: (slots, space), bytes, cancelled: None, done: None, auto_answer: Some(id) }))
            .map_err(|_| ())
    }

    fn malformed(&self, line: &[u8]) {
        self.counters.malformed_frames.fetch_add(1, Ordering::Relaxed);
        self.emit(ServerEvent::Line { stream: Stream::Stdout, line: String::from_utf8_lossy(line).into_owned() }, line.len());
    }

    fn stderr_tail(&self) -> String {
        String::from_utf8_lossy(&self.stderr.lock().unwrap()).into_owned()
    }

    /// Runs once: fails every waiter with the exit detail and emits the final event.
    fn finalize(&self, code: Option<i32>, signal: Option<i32>, end: &ReadEnd) {
        let info = {
            let mut exited = self.exited.lock().unwrap();
            if exited.is_some() {
                return;
            }
            let stderr = self.stderr_tail();
            let stopped = self.stopped.lock().unwrap().clone();
            let reason = match (&stopped, end) {
                (Some(StopCause::ConsumerStalled { .. }), _) => ExitReason::ConsumerStalled,
                (Some(StopCause::InputStalled), _) => ExitReason::InputStalled,
                (Some(StopCause::InputClosed), _) => ExitReason::InputClosed,
                (Some(StopCause::ComplexJson | StopCause::InvalidId), _)
                | (Some(StopCause::TooLongLog), _)
                | (Some(StopCause::DuplicateServerId), _)
                | (Some(StopCause::TooManyServerRequests), _)
                | (_, ReadEnd::FrameTooLarge(_)) => ExitReason::ProtocolViolation,
                _ if self.closing.load(Ordering::SeqCst) => ExitReason::Closed,
                _ => ExitReason::ProcessEnded,
            };
            let detail = match (&stopped, end) {
                (Some(StopCause::ConsumerStalled { events, bytes }), _) => {
                    format!("Milagre stopped ACP agent: {events} of its events ({bytes} bytes) were waiting to be read.")
                }
                (Some(StopCause::InputStalled), _) => {
                    format!("ACP agent stopped reading its input for {} s; Milagre stopped it.", self.limits.write_timeout.as_secs_f64())
                }
                (Some(StopCause::InputClosed), _) => "ACP agent closed its input while running; Milagre stopped it.".to_string(),
                (Some(StopCause::ComplexJson), _) => "ACP JSON token budget exceeded; Milagre stopped it.".into(),
                (Some(StopCause::InvalidId), _) => "ACP request ID is not a number or string; Milagre stopped it.".into(),
                (Some(StopCause::TooLongLog), _) => "ACP stderr line exceeded the frame budget; Milagre stopped it.".into(),
                (Some(StopCause::DuplicateServerId), _) => "ACP agent reused an unanswered request ID; Milagre stopped it.".into(),
                (Some(StopCause::TooManyServerRequests), _) => format!(
                    "ACP agent left more than {} requests unanswered at once; Milagre stopped it.",
                    self.limits.max_open_server_requests
                ),
                (_, ReadEnd::FrameTooLarge(size)) => {
                    format!(
                        "ACP agent sent a message of more than {} bytes ({size} read); Milagre stopped it.",
                        self.limits.max_frame_bytes
                    )
                }
                _ if !stderr.trim().is_empty() => stderr.trim().to_string(),
                _ => format!(
                    "ACP agent exited with code {}{}.",
                    code.map(|c| c.to_string()).unwrap_or_else(|| "null".into()),
                    signal.map(|s| format!(" ({})", signal_name(s))).unwrap_or_default()
                ),
            };
            let info = ExitInfo { code, signal, detail, reason };
            *exited = Some(info.clone());
            info
        };
        let waiters: Vec<Waiter> = self.pending.lock().unwrap().drain().map(|(_, w)| w).collect();
        for waiter in waiters {
            let _ = waiter.tx.send(Err(RpcError::Exited { detail: info.detail.clone() }));
        }
        self.server_requests.lock().unwrap().clear();
        // The final event goes in past the budget.
        self.events.force(ServerEvent::Exit(info.clone()), 0);
        let _ = self.exit_tx.send(Some(info));
    }
}

/// A Unix signal's name, as Node reports it ("SIGTERM").
pub fn signal_name(signal: i32) -> String {
    match signal {
        1 => "SIGHUP".into(),
        2 => "SIGINT".into(),
        3 => "SIGQUIT".into(),
        6 => "SIGABRT".into(),
        9 => "SIGKILL".into(),
        11 => "SIGSEGV".into(),
        13 => "SIGPIPE".into(),
        15 => "SIGTERM".into(),
        other => format!("signal {other}"),
    }
}

#[derive(Debug, Clone, PartialEq)]
enum StopCause {
    ConsumerStalled { events: usize, bytes: usize },
    TooManyServerRequests,
    DuplicateServerId,
    TooLongLog,
    ComplexJson,
    InvalidId,
    InputStalled,
    InputClosed,
}

#[derive(Debug)]
enum ReadEnd {
    Eof,
    Io,
    FrameTooLarge(usize),
    /// The process was gone and stdout stayed open past the drain grace.
    Abandoned,
}

/// Handle to one running an ACP agent. Cheap to clone; the process tree is stopped when the
/// last clone is dropped without [`AcpRpc::close`].
#[derive(Clone)]
pub struct AcpRpc {
    handle: Arc<Handle>,
}

struct Handle {
    shared: Arc<Shared>,
    /// Frames for the writer task, which owns stdin: a frame is written whole or not at all, and
    /// nobody but the writer ever waits on the pipe.
    writer: mpsc::UnboundedSender<WriterMsg>,
    next_id: AtomicI64,
    writer_slots: Arc<tokio::sync::Semaphore>,
    writer_bytes: Arc<tokio::sync::Semaphore>,
    pid: Option<u32>,
    kill_tx: mpsc::Sender<KillRequest>,
    exit_rx: watch::Receiver<Option<ExitInfo>>,
}

#[derive(Debug, Clone, Copy)]
enum KillRequest {
    /// Non-Unix only: ask the supervisor to kill the child it owns.
    Kill,
}

impl Drop for Handle {
    fn drop(&mut self) {
        // Also stop same-group descendants after the leader exited.
        self.shared.closing.store(true, Ordering::SeqCst);
        self.shared.signal(SIGKILL_OR_KILL);
        let _ = self.kill_tx.try_send(KillRequest::Kill);
    }
}

#[cfg(unix)]
const SIGKILL_OR_KILL: libc::c_int = libc::SIGKILL;
#[cfg(not(unix))]
const SIGKILL_OR_KILL: i32 = 9;

enum WriterMsg {
    Frame(Outgoing),
    /// Close stdin once the frame being written (if any) is done.
    Close,
}

struct Outgoing {
    _reservation: (tokio::sync::OwnedSemaphorePermit, tokio::sync::OwnedSemaphorePermit),
    bytes: Vec<u8>,
    /// Set when the caller gave up; checked before the first byte is written.
    cancelled: Option<Arc<AtomicBool>>,
    done: Option<oneshot::Sender<WriteOutcome>>,
    auto_answer: Option<RequestId>,
}

#[derive(Debug)]
enum WriteOutcome {
    Written,
    /// Nothing of it reached the pipe.
    NotWritten(RpcError),
    /// The pipe broke or stalled; the transport is stopping.
    Failed(RpcError),
}

async fn write_frames(mut stdin: ChildStdin, mut rx: mpsc::UnboundedReceiver<WriterMsg>, shared: Arc<Shared>) {
    let timeout = shared.limits.write_timeout;
    let mut exited = shared.exit_tx.subscribe();
    loop {
        let message = tokio::select! {
            biased;
            _ = exited.changed() => break,
            message = rx.recv() => match message {Some(message)=>message,None=>break},
        };
        let WriterMsg::Frame(outgoing) = message else { break };
        let reply = |outcome: WriteOutcome| {
            if let Some(done) = outgoing.done {
                let _ = done.send(outcome);
            }
        };
        if outgoing.cancelled.as_ref().is_some_and(|c| c.load(Ordering::Acquire)) {
            reply(WriteOutcome::NotWritten(RpcError::Cancelled));
            continue;
        }
        if shared.is_exited() {
            reply(WriteOutcome::NotWritten(RpcError::NotRunning));
            continue;
        }
        let written = async {
            stdin.write_all(&outgoing.bytes).await?;
            stdin.flush().await
        };
        match tokio::time::timeout(timeout, written).await {
            Ok(Ok(())) => {
                if let Some(id) = &outgoing.auto_answer {
                    shared.server_requests.lock().unwrap().remove(id);
                }
                reply(WriteOutcome::Written)
            }
            Ok(Err(error)) => {
                // A broken pipe: either the process is going away (the supervisor reports how) or it
                // closed stdin and lives on, unable to hear any answer. Stop it either way.
                let exited = shared.is_exited();
                if !exited && !shared.closing.load(Ordering::SeqCst) {
                    shared.stop(StopCause::InputClosed);
                }
                reply(WriteOutcome::Failed(if exited { RpcError::NotRunning } else { RpcError::Io(error.to_string()) }));
                break;
            }
            Err(_) => {
                // A frame cut short would corrupt every later one: stop ACP agent instead.
                shared.stop(StopCause::InputStalled);
                reply(WriteOutcome::Failed(RpcError::Io(format!("ACP agent did not read its input within {} s.", timeout.as_secs_f64()))));
                break;
            }
        }
    }
    drop(stdin);
    rx.close();
    while let Some(message) = rx.recv().await {
        if let WriterMsg::Frame(Outgoing { done: Some(done), .. }) = message {
            let _ = done.send(WriteOutcome::NotWritten(RpcError::NotRunning));
        }
    }
}

impl AcpRpc {
    /// Starts the process. Returns the handle and the event stream (notifications, server requests,
    /// diagnostics, then exactly one [`ServerEvent::Exit`]). The stream never blocks the reader, so a
    /// consumer that awaits a request while events pile up can't deadlock the reader that would answer
    /// it; its memory is bounded by [`Limits::event_queue`] instead.
    pub fn spawn(options: SpawnOptions) -> Result<(AcpRpc, EventReceiver<ServerEvent>), SpawnError> {
        let command_name = PathBuf::from(&options.command)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| options.command.to_string_lossy().into_owned());
        let mut command = Command::new(&options.command);
        command.args(&options.args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(false);
        if let Some(cwd) = &options.cwd {
            command.current_dir(cwd);
        }
        if let Some(env) = &options.env {
            command.env_clear();
            command.envs(env.iter().map(|(k, v)| (k, v)));
        }
        // Lead a process group of its own (Node's `detached: true`), so shells and MCP servers ACP agent
        // starts are stopped with it.
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command.spawn().map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => {
                SpawnError::NotFound { detail: format!("{command_name} isn't installed or isn't on your PATH.") }
            }
            _ => SpawnError::Io(error.to_string()),
        })?;
        let pid = child.id();
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().expect("stdout is piped");
        let stderr = child.stderr.take().expect("stderr is piped");
        let (events_tx, events_rx) = crate::queue::channel(options.limits.event_queue);
        let (exit_tx, exit_rx) = watch::channel(None);
        let (kill_tx, kill_rx) = mpsc::channel(1);
        let (writer, writer_rx) = mpsc::unbounded_channel();
        let writer_slots =
            Arc::new(tokio::sync::Semaphore::new(options.limits.writer_queue.max_events.min(tokio::sync::Semaphore::MAX_PERMITS)));
        let writer_bytes = Arc::new(tokio::sync::Semaphore::new(
            options.limits.writer_queue.max_bytes.min(u32::MAX as usize).min(tokio::sync::Semaphore::MAX_PERMITS),
        ));
        let shared = Arc::new(Shared {
            limits: options.limits.clone(),
            pending: Mutex::new(HashMap::new()),
            server_requests: Mutex::new(HashMap::new()),
            exited: Mutex::new(None),
            exit_tx,
            events: events_tx,
            stopped: Mutex::new(None),
            pid,
            kill_tx: kill_tx.clone(),
            reaped: AtomicBool::new(false),
            group_gone: AtomicBool::new(false),
            stderr: Mutex::new(Vec::new()),
            closing: AtomicBool::new(false),
            writer_closed: AtomicBool::new(false),
            counters: Counters::default(),
            command_name,
            owned_server_methods: options.owned_server_methods,
            response_boundaries: options.response_boundaries,
            writer: writer.clone(),
            writer_slots: writer_slots.clone(),
            writer_bytes: writer_bytes.clone(),
        });
        if let Some(stdin) = stdin {
            tokio::spawn(write_frames(stdin, writer_rx, shared.clone()));
        }
        tokio::spawn(supervise(child, stdout, stderr, shared.clone(), kill_rx));
        let handle = Handle { shared, writer, next_id: AtomicI64::new(1), pid, kill_tx, exit_rx, writer_slots, writer_bytes };
        Ok((AcpRpc { handle: Arc::new(handle) }, events_rx))
    }

    /// The process id while it runs (the process group id on Unix).
    /// Immediate process-group stop, safe from a cancellation/drop path. Supervisor reaps it.
    pub fn abort(&self) {
        self.handle.shared.closing.store(true, Ordering::SeqCst);
        self.handle.shared.signal(SIGKILL_OR_KILL);
        let _ = self.handle.kill_tx.try_send(KillRequest::Kill);
    }

    pub fn pid(&self) -> Option<u32> {
        if self.handle.shared.is_exited() {
            None
        } else {
            self.handle.pid
        }
    }

    pub fn command_name(&self) -> &str {
        &self.handle.shared.command_name
    }

    pub fn is_running(&self) -> bool {
        !self.handle.shared.is_exited()
    }

    pub fn exit_info(&self) -> Option<ExitInfo> {
        self.handle.shared.exited.lock().unwrap().clone()
    }

    /// Resolves once the process has exited and every waiter has been failed.
    pub async fn wait_exit(&self) -> ExitInfo {
        let mut rx = self.handle.exit_rx.clone();
        loop {
            if let Some(info) = rx.borrow_and_update().clone() {
                return info;
            }
            if rx.changed().await.is_err() {
                // The supervisor is gone without finalizing; cannot happen while `shared` lives.
                return self.exit_info().expect("supervisor finalizes before dropping its sender");
            }
        }
    }

    pub fn stderr_tail(&self) -> String {
        self.handle.shared.stderr_tail()
    }

    pub fn stats(&self) -> RpcStats {
        let c = &self.handle.shared.counters;
        RpcStats {
            requests_sent: c.requests_sent.load(Ordering::Relaxed),
            responses_matched: c.responses_matched.load(Ordering::Relaxed),
            unmatched_responses: c.unmatched_responses.load(Ordering::Relaxed),
            malformed_frames: c.malformed_frames.load(Ordering::Relaxed),
            notifications: c.notifications.load(Ordering::Relaxed),
            server_requests: c.server_requests.load(Ordering::Relaxed),
        }
    }

    /// Writer reservations include the frame currently being written.
    pub fn writer_queued(&self) -> (usize, usize) {
        let limits = self.handle.shared.limits.writer_queue;
        (
            limits.max_events.min(tokio::sync::Semaphore::MAX_PERMITS) - self.handle.writer_slots.available_permits(),
            limits.max_bytes.min(u32::MAX as usize).min(tokio::sync::Semaphore::MAX_PERMITS) - self.handle.writer_bytes.available_permits(),
        )
    }

    /// Requests in flight from Milagre.
    pub fn pending_requests(&self) -> usize {
        self.handle.shared.pending.lock().unwrap().len()
    }

    /// Server requests still waiting for Milagre's answer.
    pub fn open_server_requests(&self) -> Vec<RequestId> {
        self.handle.shared.server_requests.lock().unwrap().keys().cloned().collect()
    }

    /// [`AcpRpc::request_with_timeout`] with the 30 s default.
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        self.request_with_timeout(method, params, Some(DEFAULT_REQUEST_TIMEOUT)).await
    }

    /// Sends one request and waits for its answer. `None` waits however long ACP agent takes; the
    /// request still fails when ACP agent exits. Dropping the future cancels the wait: the id is
    /// forgotten and a late answer becomes a [`Diagnostic::UnmatchedResponse`]. ACP agent itself is not
    /// told (it has no generic cancel); use `session/cancel` for turns.
    pub async fn request_with_timeout(&self, method: &str, params: Value, timeout: Option<Duration>) -> Result<Value, RpcError> {
        let shared = &self.handle.shared;
        if shared.is_exited() || shared.closing.load(Ordering::Acquire) {
            return Err(RpcError::NotRunning);
        }
        // Stay in the exact integer range of Node providers and never wrap/reuse IDs.
        let id = self
            .handle
            .next_id
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |id| (id < 9_007_199_254_740_991).then_some(id + 1))
            .map_err(|_| RpcError::IdExhausted)?;
        let frame = encode(&protocol::request_frame(id, method, &params), shared.limits.max_frame_bytes)?;
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = shared.pending.lock().unwrap();
            if pending.len() >= shared.limits.max_pending_requests {
                return Err(RpcError::TooManyPending { limit: shared.limits.max_pending_requests });
            }
            // Re-checked under the lock finalize drains: no waiter is left behind after an exit.
            if shared.is_exited() {
                return Err(RpcError::NotRunning);
            }
            pending.insert(id, Waiter { method: method.to_string(), tx });
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        let guard = PendingGuard { shared, id, cancelled: cancelled.clone() };
        let exchange = async {
            self.write(frame, Some(cancelled)).await?;
            shared.counters.requests_sent.fetch_add(1, Ordering::Relaxed);
            match rx.await {
                Ok(result) => result,
                // finalize drains waiters by sending; a dropped sender without a send cannot happen.
                Err(_) => Err(RpcError::Exited { detail: self.exit_info().map(|i| i.detail).unwrap_or_default() }),
            }
        };
        let result = match timeout {
            Some(after) => match tokio::time::timeout(after, exchange).await {
                Ok(result) => result,
                Err(_) => Err(RpcError::Timeout { method: method.to_string(), after }),
            },
            None => exchange.await,
        };
        drop(guard);
        result
    }

    /// A notification; ACP agent sends no answer. `None` params writes `{ method }` alone.
    pub async fn notify(&self, method: &str, params: Option<Value>) -> Result<(), RpcError> {
        if self.handle.shared.is_exited() || self.handle.shared.closing.load(Ordering::Acquire) {
            return Err(RpcError::NotRunning);
        }
        let frame = encode(&protocol::notification_frame(method, params.as_ref()), self.handle.shared.limits.max_frame_bytes)?;
        self.write(frame, None).await
    }

    /// Answers a server request. Fails without writing when ACP agent no longer waits on it.
    /// Success means pipe write completed, not provider acknowledgement. Cancellation or a write
    /// failure may occur after partial or complete delivery. Killing the process cannot retract a
    /// delivered permission or prove the tool did not execute; never replay an uncertain answer.
    pub async fn respond(&self, id: &RequestId, result: Value) -> Result<(), RpcError> {
        self.answer(id, protocol::response_frame(id, &result)).await
    }

    /// Refuses a server request (method not found), as acp-rpc.cjs `respondError`.
    pub async fn respond_error(&self, id: &RequestId, message: &str) -> Result<(), RpcError> {
        self.answer(id, protocol::error_frame(id, protocol::METHOD_NOT_FOUND, message)).await
    }

    async fn answer(&self, id: &RequestId, frame: Value) -> Result<(), RpcError> {
        let shared = &self.handle.shared;
        if shared.is_exited() || shared.closing.load(Ordering::Acquire) {
            return Err(RpcError::NotRunning);
        }
        let frame = encode(&frame, shared.limits.max_frame_bytes)?;
        {
            let mut open = shared.server_requests.lock().unwrap();
            match open.get_mut(id) {
                Some(answering) if !*answering => *answering = true,
                _ => return Err(RpcError::UnknownServerRequest { id: id.to_string() }),
            }
        }
        let mut guard = AnswerGuard { rpc: self, finished: false };
        let result = match self.write_outcome(frame, None).await {
            WriteOutcome::Written => {
                shared.server_requests.lock().unwrap().remove(id);
                Ok(())
            }
            WriteOutcome::NotWritten(error) => {
                if let Some(answering) = shared.server_requests.lock().unwrap().get_mut(id) {
                    *answering = false;
                }
                Err(error)
            }
            WriteOutcome::Failed(error) => Err(error),
        };
        guard.finished = true;
        result
    }

    async fn write(&self, frame: Vec<u8>, cancelled: Option<Arc<AtomicBool>>) -> Result<(), RpcError> {
        match self.write_outcome(frame, cancelled).await {
            WriteOutcome::Written => Ok(()),
            WriteOutcome::NotWritten(error) | WriteOutcome::Failed(error) => Err(error),
        }
    }

    async fn write_outcome(&self, bytes: Vec<u8>, cancelled: Option<Arc<AtomicBool>>) -> WriteOutcome {
        let Ok(slots) = self.handle.writer_slots.clone().try_acquire_owned() else {
            return WriteOutcome::NotWritten(RpcError::WriterFull);
        };
        let Ok(size) = u32::try_from(bytes.len()) else {
            return WriteOutcome::NotWritten(RpcError::WriterFull);
        };
        let Ok(space) = self.handle.writer_bytes.clone().try_acquire_many_owned(size) else {
            return WriteOutcome::NotWritten(RpcError::WriterFull);
        };
        let (done, written) = oneshot::channel();
        if self
            .handle
            .writer
            .send(WriterMsg::Frame(Outgoing { _reservation: (slots, space), bytes, cancelled, done: Some(done), auto_answer: None }))
            .is_err()
        {
            return WriteOutcome::NotWritten(RpcError::NotRunning);
        }
        written.await.unwrap_or(WriteOutcome::NotWritten(RpcError::NotRunning))
    }

    /// Stops the process tree: closes stdin, SIGTERMs the process group, SIGKILLs it after
    /// [`Limits::kill_grace`], and waits for the exit to be reported. Idempotent; also stops what
    /// is left of the group after the leader already exited (process-tree.cjs `killTree`).
    pub async fn close(&self) -> ExitInfo {
        let shared = &self.handle.shared;
        if !shared.is_exited() {
            shared.closing.store(true, Ordering::SeqCst);
        }
        // Closing stdin lets an idle agent exit on its own. Never waited on: a stalled write
        // can't hold up the kill below.
        if !shared.writer_closed.swap(true, Ordering::SeqCst) {
            let _ = self.handle.writer.send(WriterMsg::Close);
        }
        let grace = shared.limits.kill_grace;
        #[cfg(unix)]
        {
            let alive = || shared.group_signallable().is_some() || !shared.is_exited();
            if alive() {
                shared.signal(libc::SIGTERM);
                if !wait_until(|| !alive(), grace).await {
                    shared.signal(libc::SIGKILL);
                    wait_until(|| !alive(), grace).await;
                }
            }
        }
        #[cfg(not(unix))]
        {
            let _ = self.handle.kill_tx.try_send(KillRequest::Kill);
        }
        match tokio::time::timeout(grace * 2, self.wait_exit()).await {
            Ok(info) => info,
            // The supervisor could not reap it (should not happen after SIGKILL); report what we know.
            Err(_) => self.exit_info().unwrap_or(ExitInfo {
                code: None,
                signal: None,
                detail: "ACP agent did not exit after SIGKILL.".into(),
                reason: ExitReason::Closed,
            }),
        }
    }
}

// An answer already being written cannot be recalled. If its owner disappears, stop the process
// rather than expose a second answer or accept a reused ID while the first is still in transit.
struct AnswerGuard<'a> {
    rpc: &'a AcpRpc,
    finished: bool,
}
impl Drop for AnswerGuard<'_> {
    fn drop(&mut self) {
        if !self.finished {
            self.rpc.abort();
        }
    }
}

/// Forgets a request's id when its future ends for any reason (answer, timeout, drop), and keeps
/// its frame from being written if it hasn't started yet.
struct PendingGuard<'a> {
    shared: &'a Shared,
    id: i64,
    cancelled: Arc<AtomicBool>,
}

impl Drop for PendingGuard<'_> {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Release);
        self.shared.pending.lock().unwrap().remove(&self.id);
    }
}

fn encode(frame: &Value, limit: usize) -> Result<Vec<u8>, RpcError> {
    let mut bytes = serde_json::to_vec(frame).map_err(|e| RpcError::Io(e.to_string()))?;
    if bytes.len() > limit {
        return Err(RpcError::FrameTooLarge { size: bytes.len(), limit });
    }
    bytes.push(b'\n');
    Ok(bytes)
}

async fn wait_until(mut done: impl FnMut() -> bool, within: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + within;
    loop {
        if done() {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[cfg(unix)]
fn signal_group(pgid: u32, signal: libc::c_int) {
    // SAFETY: killpg only sends a signal; a stale group id fails with ESRCH.
    unsafe {
        libc::killpg(pgid as libc::pid_t, signal);
    }
}

#[cfg(unix)]
fn group_alive(pgid: u32) -> bool {
    // SAFETY: signal 0 only checks for existence and permission.
    let result = unsafe { libc::killpg(pgid as libc::pid_t, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

async fn read_frames(stdout: ChildStdout, shared: Arc<Shared>) -> ReadEnd {
    let limit = shared.limits.max_frame_bytes;
    let mut reader = BufReader::with_capacity(64 * 1024, stdout);
    let mut line: Vec<u8> = Vec::new();
    loop {
        let chunk = match reader.fill_buf().await {
            Ok(chunk) => chunk,
            Err(_) => return ReadEnd::Io,
        };
        if chunk.is_empty() {
            // Node's readline emits a last unterminated line on close; so does this.
            if !line.is_empty() {
                shared.dispatch_line(&line);
            }
            return ReadEnd::Eof;
        }
        let (take, complete) = match chunk.iter().position(|&b| b == b'\n') {
            Some(at) => (at, true),
            None => (chunk.len(), false),
        };
        if line.len() + take > limit {
            return ReadEnd::FrameTooLarge(line.len() + take);
        }
        line.extend_from_slice(&chunk[..take]);
        reader.consume(if complete { take + 1 } else { take });
        if complete {
            shared.dispatch_line(&line);
            line.clear();
            if line.capacity() > 1024 * 1024 {
                line.shrink_to(64 * 1024);
            }
        }
    }
}

async fn drain_stderr(mut stderr: ChildStderr, shared: Arc<Shared>) {
    let keep = shared.limits.stderr_tail_bytes;
    let mut buf = vec![0u8; 8192];
    let mut line = Vec::new();
    loop {
        let n = stderr.read(&mut buf).await.unwrap_or_default();
        if n == 0 {
            if !line.is_empty() {
                emit_stderr(&shared, &line);
            }
            return;
        }
        {
            let mut tail = shared.stderr.lock().unwrap();
            tail.extend_from_slice(&buf[..n]);
            if tail.len() > keep {
                let cut = tail.len() - keep;
                tail.drain(..cut);
            }
        }
        for &byte in &buf[..n] {
            if byte == b'\n' {
                emit_stderr(&shared, &line);
                line.clear();
            } else if line.len() < shared.limits.max_frame_bytes {
                line.push(byte);
            } else {
                shared.stop(StopCause::TooLongLog);
                return;
            }
        }
    }
}
fn emit_stderr(shared: &Shared, bytes: &[u8]) {
    let bytes = bytes.strip_suffix(b"\r").unwrap_or(bytes);
    if !bytes.iter().all(u8::is_ascii_whitespace) {
        shared.emit(ServerEvent::Line { stream: Stream::Stderr, line: String::from_utf8_lossy(bytes).into_owned() }, bytes.len());
    }
}

fn status_parts(status: &std::io::Result<std::process::ExitStatus>) -> (Option<i32>, Option<i32>) {
    match status {
        Ok(status) => {
            #[cfg(unix)]
            {
                use std::os::unix::process::ExitStatusExt;
                (status.code(), status.signal())
            }
            #[cfg(not(unix))]
            {
                (status.code(), None)
            }
        }
        Err(_) => (None, None),
    }
}

/// Upper bound for reading what an exited process left in its stdout pipe when no other process
/// of its group could still hold the pipe open.
const RELEASED_PIPE_DRAIN: Duration = Duration::from_secs(10);

async fn supervise(
    mut child: Child,
    stdout: ChildStdout,
    stderr: ChildStderr,
    shared: Arc<Shared>,
    mut kill_rx: mpsc::Receiver<KillRequest>,
) {
    let grace = shared.limits.drain_grace;
    let pid = child.id();
    let stderr_task = tokio::spawn(drain_stderr(stderr, shared.clone()));
    let mut reader = tokio::spawn(read_frames(stdout, shared.clone()));
    let mut status = None;
    let mut end = None;
    loop {
        tokio::select! {
            read = &mut reader => { end = Some(read.unwrap_or(ReadEnd::Io)); break; }
            exit = child.wait() => { status = Some(exit); break; }
            Some(KillRequest::Kill) = kill_rx.recv() => { let _ = child.start_kill(); }
        }
    }
    if status.is_some() {
        shared.reaped.store(true, Ordering::Release);
        // A naturally exited leader must not orphan the commands it left in our process group.
        shared.signal(SIGKILL_OR_KILL);
    }
    match end {
        Some(read_end) => {
            // stdout ended first. A process that closed its protocol pipe (or broke framing) is
            // useless: give it the drain grace to exit, then stop it.
            let violation = matches!(read_end, ReadEnd::FrameTooLarge(_));
            if !violation {
                if let Ok(exit) = tokio::time::timeout(grace, child.wait()).await {
                    status = Some(exit);
                }
            }
            if status.is_none() {
                kill_now(&mut child);
                status = Some(child.wait().await);
            }
            end = Some(read_end);
        }
        None => {
            // The process exited first: let stdout drain what it already wrote. With nothing left in
            // its process group nobody else holds the pipe, so EOF is only a scheduling delay away;
            // otherwise a grandchild may keep it open forever and the drain grace applies.
            #[cfg(unix)]
            let pipe_released = pid.is_none_or(|pid| !group_alive(pid));
            #[cfg(not(unix))]
            let pipe_released = false;
            let wait = if pipe_released { RELEASED_PIPE_DRAIN.max(grace) } else { grace };
            end = Some(match tokio::time::timeout(wait, &mut reader).await {
                Ok(read) => read.unwrap_or(ReadEnd::Io),
                Err(_) => {
                    reader.abort();
                    let _ = reader.await;
                    ReadEnd::Abandoned
                }
            });
        }
    }
    // stderr may be held open by a grandchild; its tail so far is enough.
    let mut stderr_task = stderr_task;
    if tokio::time::timeout(grace, &mut stderr_task).await.is_err() {
        stderr_task.abort();
        let _ = stderr_task.await;
    }
    shared.reaped.store(true, Ordering::Release);
    let status = status.expect("set on every path");
    let (code, signal) = status_parts(&status);
    shared.finalize(code, signal, end.as_ref().expect("set on every path"));
}

fn kill_now(child: &mut Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        signal_group(pid, libc::SIGKILL);
    }
    let _ = child.start_kill();
}

/// Cheap conservative token bound before serde allocation; serde still checks syntax and depth.
fn json_tokens_fit(bytes: &[u8], limit: usize) -> bool {
    let (mut quoted, mut escape, mut atom, mut count) = (false, false, false, 0usize);
    for &byte in bytes {
        if quoted {
            if escape {
                escape = false;
            } else if byte == b'\\' {
                escape = true;
            } else if byte == b'"' {
                quoted = false;
            }
            continue;
        }
        if byte.is_ascii_whitespace() {
            atom = false;
            continue;
        }
        if byte == b'"' {
            quoted = true;
            atom = false;
            count += 1;
        } else if b"{}[],:".contains(&byte) {
            atom = false;
            count += 1;
        } else if !atom {
            atom = true;
            count += 1;
        }
        if count > limit {
            return false;
        }
    }
    true
}

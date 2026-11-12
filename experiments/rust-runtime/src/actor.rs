//! Shared owner actor for fresh fixtures and the explicitly configured dedicated Chat runtime.
use milagre_owner_store::{
    agent_runs,
    chat_host::{
        AnswerId, AnswerOutcome, AnswerResult, ChatHost, ModeChangeId, ModeResult, Notice,
        Provider, ProviderError, ProviderErrorKind, ProviderEvent, QuitState, TurnId,
    },
    jsjson::{self, RawJson},
    states::{Event, ProjectStates, Timing},
    Isolation, Policy,
};
use milagre_owner_wire::{
    ClientContext, Config, EventSink, Handler, IsolatedProfile, ProfileLease, Publication,
    RpcError, RpcResult, Server, ShutdownError,
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const TICK: Duration = Duration::from_millis(20);
const READINESS_CHECK: Duration = Duration::from_millis(250);
const QUEUE: usize = 64;
const BYTES: usize = 8 * 1024 * 1024;
const DESIGN_SETTINGS: &[&str] = &["designs:enabled:read", "designs:enabled:save"];
const TERMINAL_METHODS: &[&str] = &[
    "terminal:list",
    "terminal:profiles",
    "terminal:open",
    "terminal:read",
    "terminal:input",
    "terminal:resize",
    "terminal:close",
];
const CLAUDE_METHODS: &[&str] = &["agent:set-permission-mode"];
const METHODS: &[&str] = &[
    "project:open",
    "project:switch",
    "project:current",
    "project:snapshot",
    "project:forget",
    "state:read",
    "chat:send",
    "chat:send-status",
    "chat:messages",
    "chat:message",
    "chat:all-messages",
    "chat:search",
    "chat:subagent",
    "agent:interrupt",
    "agent:respond-permission",
    "agent:answer-question",
    "chat:queue-send",
    "chat:queue-remove",
];

fn app_methods(enabled: bool) -> &'static [&'static str] {
    #[cfg(feature = "app-fixture")]
    if enabled {
        return crate::app_fixture::METHODS;
    }
    let _ = enabled;
    &[]
}

fn configured_methods(enabled: bool) -> &'static [&'static str] {
    #[cfg(feature = "chat-runtime")]
    if enabled {
        return crate::chat_runtime::METHODS;
    }
    let _ = enabled;
    &[]
}

fn configured_service_methods(enabled: bool) -> Vec<&'static str> {
    if enabled {
        #[allow(unused_mut)]
        let mut methods: Vec<_> = TERMINAL_METHODS
            .iter()
            .chain(milagre_git_read::METHODS.iter())
            .copied()
            .collect();
        #[cfg(feature = "chat-runtime")]
        methods.extend(crate::configured_routines::METHODS);
        methods
    } else {
        vec![]
    }
}

fn configured_routine_flags(enabled: bool, method: &str) -> bool {
    #[cfg(feature = "chat-runtime")]
    if enabled {
        return crate::configured_routines::FLAGS.contains(&method);
    }
    let _ = (enabled, method);
    false
}

enum Command {
    Call(String, Vec<Value>),
    Shutdown {
        force: bool,
        refused: Arc<AtomicBool>,
    },
}
impl Command {
    fn shutdown(force: bool) -> Self {
        Self::Shutdown {
            force,
            refused: Arc::new(AtomicBool::new(false)),
        }
    }
}
struct Request {
    command: Command,
    reply: SyncSender<RpcResult>,
    bytes: usize,
}
struct Shared {
    snapshot: Mutex<Value>,
    events: Mutex<Option<EventSink>>,
    bytes: AtomicUsize,
    closing: AtomicBool,
    stop: AtomicBool,
    failure: Mutex<Option<String>>,
    delivery_failed: AtomicBool,
    forgotten_answers: AtomicU64,
    stranded_lock_notices: AtomicU64,
    late_cleanup_refusals: AtomicU64,
    #[cfg(test)]
    observed_quit: Mutex<Option<QuitState>>,
    #[cfg(test)]
    ready_notices: AtomicUsize,
    #[cfg(test)]
    parked_events: AtomicUsize,
    #[cfg(test)]
    observed_ticks: AtomicUsize,
    #[cfg(test)]
    fail_commits: AtomicBool,
    #[cfg(test)]
    injected_commits: AtomicUsize,
    #[cfg(test)]
    stuck_ends: AtomicUsize,
}
struct Actor {
    send: SyncSender<Request>,
    shared: Arc<Shared>,
    thread: Mutex<Option<JoinHandle<()>>>,
    project: String,
    content: bool,
    app_fixture: bool,
    configured: bool,
    claude_modes: bool,
    #[cfg(feature = "chat-runtime")]
    terminals: Option<Arc<crate::configured_terminals::ConfiguredTerminals>>,
}
impl Actor {
    fn call(&self, command: Command) -> RpcResult {
        let shutdown = matches!(command, Command::Shutdown { .. });
        if self.shared.stop.load(Ordering::Acquire) {
            return Err(closed());
        }
        if !shutdown && self.shared.closing.load(Ordering::Acquire) {
            return Err(closed());
        }
        let bytes = match &command {
            Command::Call(method, args) => method.len() + jsjson::to_string(&json!(args)).len(),
            Command::Shutdown { .. } => 0,
        };
        if self
            .shared
            .bytes
            .try_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                current.checked_add(bytes).filter(|total| *total <= BYTES)
            })
            .is_err()
        {
            return Err(RpcError::new(
                "OWNER_BUSY",
                "The isolated owner request queue is full",
            ));
        }
        let (reply, response) = mpsc::sync_channel(1);
        if let Err(error) = self.send.try_send(Request {
            command,
            reply,
            bytes,
        }) {
            self.shared.bytes.fetch_sub(bytes, Ordering::AcqRel);
            return Err(match error {
                TrySendError::Full(_) => {
                    RpcError::new("OWNER_BUSY", "The isolated owner request queue is full")
                }
                TrySendError::Disconnected(_) => closed(),
            });
        }
        // Once accepted, a disconnected viewer does not cancel a durable owner transition.
        response.recv().unwrap_or_else(|_| Err(closed()))
    }
}
impl Drop for Actor {
    fn drop(&mut self) {
        if !self.shared.stop.swap(true, Ordering::AcqRel) {
            eprintln!("isolated owner forced teardown: pending state may be unsaved; this is not graceful shutdown");
        }
        if let Some(thread) = self.thread.lock().unwrap().take() {
            let _ = thread.join();
        }
    }
}
impl Handler for Actor {
    fn decode_request(&self, frame: &[u8]) -> Result<Value, RpcError> {
        jsjson::parse_bytes(frame)
            .map_err(|_| RpcError::new("INVALID_REQUEST", "Expected a JSON frame"))
    }
    fn encode_request_id(&self, value: &Value) -> Result<String, RpcError> {
        Ok(jsjson::to_string(value))
    }
    fn encode_result(&self, value: &Value) -> Result<String, RpcError> {
        Ok(jsjson::to_string(value))
    }
    fn string_len(&self, text: &str) -> usize {
        jsjson::utf16_len(text)
    }
    fn methods(&self) -> Vec<String> {
        METHODS
            .iter()
            .copied()
            .chain(
                if self.claude_modes {
                    CLAUDE_METHODS
                } else {
                    &[]
                }
                .iter()
                .copied(),
            )
            .chain(
                if self.content {
                    crate::artifacts::METHODS
                } else {
                    &[]
                }
                .iter()
                .copied(),
            )
            .chain(app_methods(self.app_fixture).iter().copied())
            .chain(configured_methods(self.configured).iter().copied())
            .chain(configured_service_methods(self.configured))
            .chain(
                if self.content && (self.app_fixture || self.configured) {
                    DESIGN_SETTINGS
                } else {
                    &[]
                }
                .iter()
                .copied(),
            )
            .map(str::to_owned)
            .collect()
    }
    fn invoke(&self, method: &str, args: &[Value], context: &ClientContext) -> RpcResult {
        if !METHODS.contains(&method)
            && !(self.claude_modes && CLAUDE_METHODS.contains(&method))
            && !app_methods(self.app_fixture).contains(&method)
            && !configured_methods(self.configured).contains(&method)
            && !configured_service_methods(self.configured).contains(&method)
            && !(self.content
                && (crate::artifacts::METHODS.contains(&method)
                    || ((self.app_fixture || self.configured)
                        && DESIGN_SETTINGS.contains(&method))))
        {
            return Err(RpcError::new(
                "UNSUPPORTED_MUTATION",
                "This isolated actor exposes only scripted Chat commands",
            ));
        }
        if !matches!(
            method,
            "project:open" | "project:switch" | "project:current"
        ) && !app_methods(self.app_fixture).contains(&method)
            && !(method != "chat:patch" && configured_methods(self.configured).contains(&method))
            && !configured_routine_flags(self.configured, method)
            && context.view().project_path.as_deref() != Some(&self.project)
        {
            return Err(RpcError::new(
                "ISOLATED_SCOPE_ONLY",
                "Open the fixture Project on this connection first",
            ));
        }
        #[cfg(feature = "chat-runtime")]
        if self.configured && TERMINAL_METHODS.contains(&method) {
            let terminals = self.terminals.as_ref().ok_or_else(closed)?;
            let invocation = terminals.capture(method, args)?;
            self.call(Command::Call("__terminal:check".into(), vec![]))?;
            let result = invocation.invoke(context.client_id());
            self.call(Command::Call("__terminal:check".into(), vec![]))?;
            return result;
        }
        self.call(Command::Call(method.into(), args.to_vec()))
    }
    fn snapshot(&self, _: &ClientContext) -> RpcResult {
        // The wire server already holds the publication lock. Never enqueue to the
        // actor here: it could be waiting for that same lock behind a prior command.
        if self.shared.delivery_failed.load(Ordering::Acquire) {
            return Err(delivery_failed());
        }
        diagnostic_snapshot(&self.shared)
    }
    fn shutdown(&self) -> RpcResult {
        self.call(Command::shutdown(false))
    }
    fn shutdown_attempt(&self) -> Result<(), ShutdownError> {
        let refused = Arc::new(AtomicBool::new(false));
        self.call(Command::Shutdown {
            force: false,
            refused: refused.clone(),
        })
        .map(|_| ())
        .map_err(|error| {
            if refused.load(Ordering::Acquire) {
                ShutdownError::Refused(error)
            } else {
                ShutdownError::Incomplete(error)
            }
        })
    }
}
fn record_forgotten_answer(shared: &Shared) {
    // Saturating constant-space audit. Never write to a potentially blocked stderr pipe.
    let _ = shared
        .forgotten_answers
        .try_update(Ordering::AcqRel, Ordering::Acquire, |count| {
            Some(count.saturating_add(1))
        });
}
fn diagnostic_snapshot(shared: &Shared) -> RpcResult {
    let mut snapshot = shared.snapshot.lock().unwrap().clone();
    let conflict = || {
        RpcError::new(
            "DIAGNOSTIC_SCHEMA_CONFLICT",
            "Owner snapshot diagnostics must use an object namespace",
        )
    };
    let snapshot_object = snapshot.as_object_mut().ok_or_else(conflict)?;
    let diagnostics = snapshot_object
        .entry("diagnostics")
        .or_insert_with(|| json!({}));
    let diagnostics = diagnostics.as_object_mut().ok_or_else(conflict)?;
    let audit = diagnostics
        .entry("rustOwnerAudit")
        .or_insert_with(|| json!({}));
    let audit = audit.as_object_mut().ok_or_else(conflict)?;
    let stranded = shared.stranded_lock_notices.load(Ordering::Acquire);
    // Only these audit fields belong to this actor. Every unrelated field survives.
    audit.insert(
        "answerHistoryForgotten".into(),
        json!(shared.forgotten_answers.load(Ordering::Acquire)),
    );
    audit.insert("ownerLockStrandedNotices".into(), json!(stranded));
    audit.insert("ownerLockStranded".into(), json!(stranded > 0));
    audit.insert(
        "lateCleanupRefusals".into(),
        json!(shared.late_cleanup_refusals.load(Ordering::Acquire)),
    );
    Ok(snapshot)
}

fn record_failure(shared: &Shared, error: String) {
    let bounded: String = error.chars().take(4096).collect();
    let mut previous = shared.failure.lock().unwrap();
    if previous.as_deref() != Some(&bounded) {
        eprintln!("isolated owner transition failed: {bounded}");
        *previous = Some(bounded);
    }
}
fn delivery_failed() -> RpcError {
    RpcError::new(
        "OWNER_EVENT_FAILED",
        "Owner event delivery failed; stop and restart this isolated fixture",
    )
}
fn closed() -> RpcError {
    RpcError::new("OWNER_CLOSING", "The isolated owner is closing")
}
/// Retry only the owner's pending-job result, from outside its actor. The
/// caller retains the Server on timeout; a pending result is never a stop ack.
pub fn shutdown_pending(server: &Server, budget: Duration) -> Result<(), RpcError> {
    let deadline = Instant::now() + budget;
    loop {
        match server.shutdown() {
            Err(error) if error.code == "QUIT_PENDING" => {
                if Instant::now() >= deadline {
                    return Err(error);
                }
                thread::sleep(TICK.min(deadline.saturating_duration_since(Instant::now())));
            }
            result => return result,
        }
    }
}

/// Fixture executable EOF driver. A pending owner remains retained and ticked;
/// failed saves and busy refusal are reported, not silently forced or retried.
pub fn stop_on_stdin(server: std::sync::Weak<Server>) {
    thread::spawn(move || {
        let _ = std::io::stdin().read_line(&mut String::new());
        let Some(server) = server.upgrade() else {
            return;
        };
        let mut reported = false;
        loop {
            match shutdown_pending(&server, Duration::from_secs(1)) {
                Err(error) if error.code == "QUIT_PENDING" => {
                    if !reported {
                        eprintln!("QUIT_PENDING: retaining the isolated owner until transcript cleanup completes");
                        reported = true;
                    }
                }
                Err(error) => {
                    let message: String = error.message.chars().take(256).collect();
                    eprintln!("{}: {message}. Shutdown did not finish; the fixture socket remains available. Resolve this condition, then retry daemon:stop. No forced shutdown was performed.", error.code);
                    return;
                }
                Ok(()) => return,
            }
        }
    });
}
fn convert(error: milagre_owner_store::StoreError) -> RpcError {
    let code = match &error {
        milagre_owner_store::StoreError::AnswerDeliveryUnknown(_) => "ANSWER_DELIVERY_UNKNOWN",
        milagre_owner_store::StoreError::AnswersAtCapacity(_) => "ANSWERS_AT_CAPACITY",
        _ => error.code().unwrap_or("COMMAND_FAILED"),
    };
    let message = if code == "ANSWER_DELIVERY_UNKNOWN" {
        "The agent has not confirmed delivery of this answer.".into()
    } else {
        error.to_string()
    };
    RpcError::new(code, message)
}

struct State {
    host: ChatHost,
    jobs: crate::jobs::Workers,
    provider: &'static str,
    content: Option<Arc<crate::claude_content::SharedContent>>,
    project: PathBuf,
    opened: bool,
    version: u64,
    publication_epoch: Option<String>,
    last: Value,
    run_seq: u64,
    next_readiness_check: Instant,
    pending: VecDeque<(String, Value)>,
    // Actor-owned edits publish only after their explicit durability boundary.
    project_changed: bool,
    answers: HashMap<AnswerId, SyncSender<RpcResult>>,
    modes: HashMap<ModeChangeId, SyncSender<RpcResult>>,
    settled_replies: Vec<(SyncSender<RpcResult>, RpcResult)>,
    // Drop after jobs join and the host releases its locks, even on forced teardown.
    #[cfg(feature = "app-fixture")]
    bootstrap: Option<crate::app_fixture::Bootstrap>,
    #[cfg(feature = "chat-runtime")]
    configured: Option<crate::chat_runtime::Bootstrap>,
    #[cfg(feature = "chat-runtime")]
    terminals: Option<Arc<crate::configured_terminals::ConfiguredTerminals>>,
    #[cfg(feature = "chat-runtime")]
    git: Option<crate::configured_git::ConfiguredGit>,
    #[cfg(feature = "chat-runtime")]
    routines: Option<crate::configured_routines::ConfiguredRoutines>,
    _profile: ProfileLease,
}
impl Drop for State {
    fn drop(&mut self) {
        // A forced actor drop is still a crash boundary, but its job workers must
        // finish before host locks and the private profile can be destroyed.
        #[cfg(feature = "chat-runtime")]
        if let Some(terminals) = &self.terminals {
            terminals.drain_before_owner_drop();
        }
        #[cfg(feature = "chat-runtime")]
        if let Some(routines) = &mut self.routines {
            // Unknown routine persistence/cleanup cannot release this owner's Project lock.
            while routines.close().is_err() {
                thread::sleep(Duration::from_millis(20));
            }
        }
        self.jobs.join();
    }
}
impl State {
    fn open_content(&self) -> Result<(), RpcError> {
        if let Some(content) = &self.content {
            let state = self.host.states.current(&self.project).ok_or_else(closed)?;
            content
                .reconcile(state.sessions())
                .map_err(|error| RpcError::new(error.code, error.message))?;
            content.opened(true);
        }
        Ok(())
    }
    fn sync_readiness(&mut self) {
        if !self.host.is_project_ready(&self.project) {
            #[cfg(feature = "chat-runtime")]
            if let Some(terminals) = &self.terminals {
                terminals.stop();
            }
            #[cfg(feature = "chat-runtime")]
            if let Some(routines) = &mut self.routines {
                routines.revoke();
            }
            self.project_changed = false;
            if self.opened {
                self.opened = false;
                if let Some(content) = &self.content {
                    content.opened(false);
                }
            }
            self.pending
                .retain(|(channel, _)| channel != "project:state");
        }
    }
    fn epoch(&self) -> String {
        self.publication_epoch
            .clone()
            .unwrap_or_else(|| format!("isolated-actor:{}", self.project.display()))
    }
    fn stamp(&self, value: &mut Value) {
        if let Some(epoch) = &self.publication_epoch {
            value["epoch"] = json!(epoch);
            value["version"] = json!(self.version);
        }
    }
    fn project_name(&self) -> &'static str {
        #[cfg(feature = "app-fixture")]
        if self.bootstrap.is_some() {
            return "fixture";
        }
        if self.publication_epoch.is_some() {
            return "Rust Chat";
        }
        "actor"
    }
    #[cfg(feature = "chat-runtime")]
    fn reopen_routines(&mut self) -> Result<(), RpcError> {
        if let Some(routines) = &mut self.routines {
            return routines.reopen(self.host.states.now());
        }
        if self.configured.is_none() {
            return Ok(());
        }
        let configured = self.configured.as_ref().ok_or_else(closed)?;
        self.routines = Some(crate::configured_routines::ConfiguredRoutines::open(
            configured.data_root(),
            self.project.clone(),
            configured.retained_check(),
            self.host.states.now(),
        )?);
        Ok(())
    }
    fn project_git(&self) -> Result<bool, RpcError> {
        #[cfg(feature = "chat-runtime")]
        if let Some(git) = &self.git {
            return git.is_repository();
        }
        Ok(false)
    }
    fn project(&mut self) -> RpcResult {
        self.host
            .require_project_ready(&self.project)
            .map_err(convert)?;
        let mut value = json!({"path":self.project,"name":self.project_name(),"git":self.project_git()?,"state":self.host.states.whole_state(&self.project).map_err(convert)?});
        self.stamp(&mut value);
        Ok(value)
    }
    fn cache(&mut self, shared: &Shared) -> Result<(), RpcError> {
        #[cfg(test)]
        shared
            .parked_events
            .store(self.host.parked_for_tests().0, Ordering::Release);
        #[cfg(test)]
        shared
            .stuck_ends
            .store(self.host.stuck_ends().len(), Ordering::Release);
        self.sync_readiness();
        let ready = self.host.is_project_ready(&self.project);
        let state = if ready {
            // This transport has not negotiated chat-pages-v1. Node's whole
            // clients receive unloaded messages hydrated from chats.db too.
            // Publishing current() here silently replaced a visible Chat with
            // an empty transcript when its idle messages left owner memory.
            match self.host.states.current_whole_state(&self.project) {
                Ok(Some(state)) => state,
                Ok(None) => {
                    // A release can remove the slot and then fail, before the
                    // host clears ready. Revoke that stale view without masking
                    // the release error or dropping its LockStranded notice.
                    let _ = self.host.require_project_ready(&self.project);
                    self.sync_readiness();
                    Value::Null
                }
                Err(error) => {
                    // Ownership loss remains recoverable by an explicit open,
                    // just like the readiness check on commands and ticks.
                    // Other hydration failures latch publication closed instead
                    // of exposing an incomplete or stale whole-state result.
                    if self.host.require_project_ready(&self.project).is_err() {
                        record_failure(shared, error.to_string());
                        self.sync_readiness();
                        Value::Null
                    } else {
                        return Err(convert(error));
                    }
                }
            }
        } else {
            Value::Null
        };
        if ready && !state.is_null() {
            #[cfg(feature = "chat-runtime")]
            if let Some(terminals) = &self.terminals {
                terminals.refresh(&state)?;
            }
            if let Some(content) = &self.content {
                content
                    .reconcile(state["sessions"].as_object())
                    .map_err(|error| RpcError::new(error.code, error.message))?;
            }
        }
        if state != self.last {
            self.version += 1;
            self.last = state.clone();
        }
        let projects = if self.opened {
            let mut value = json!({"path":self.project,"name":self.project_name(),"git":self.project_git()?,"state":state});
            self.stamp(&mut value);
            vec![value]
        } else {
            vec![]
        };
        let runs = if self.host.is_project_ready(&self.project) {
            json!(self.host.runs())
        } else {
            json!({})
        };
        *shared.snapshot.lock().unwrap() = json!({"projects":projects,"links":[],"runs":{"runs":runs,"seq":self.run_seq},"ports":{}});
        Ok(())
    }
    fn call(&mut self, method: &str, args: &[Value]) -> RpcResult {
        #[cfg(feature = "chat-runtime")]
        if let Some(configured) = &self.configured {
            configured.check()?;
            if crate::configured_routines::METHODS.contains(&method) {
                if crate::configured_routines::FLAGS.contains(&method) {
                    return Ok(json!({"enabled":true,"executionSupported":false}));
                }
                self.host
                    .require_project_ready(&self.project)
                    .map_err(convert)?;
                let state = self
                    .host
                    .states
                    .current(&self.project)
                    .ok_or_else(closed)?
                    .to_value();
                let (value, emit) = self.routines.as_mut().ok_or_else(closed)?.invoke(
                    method,
                    args,
                    &state,
                    self.host.states.now(),
                )?;
                if let Err(error) = self.host.require_project_ready(&self.project) {
                    self.routines.as_mut().ok_or_else(closed)?.revoke();
                    return Err(RpcError::new("ROUTINE_TARGET_UNCERTAIN",format!("Routine state may have been saved; reopen and inspect before retrying: {error}")));
                }
                if emit {
                    self.queue_event("routines:changed", json!({}))?;
                }
                return Ok(value);
            }
            if method == "__terminal:check" {
                self.host
                    .require_project_ready(&self.project)
                    .map_err(convert)?;
                let state = self.host.states.current(&self.project).ok_or_else(closed)?;
                self.terminals
                    .as_ref()
                    .ok_or_else(closed)?
                    .refresh(&state.to_value())?;
                return Ok(Value::Null);
            }
            if milagre_git_read::METHODS.contains(&method) {
                let service = self.git.take().ok_or_else(closed)?;
                let result = service.invoke(method, args, || {
                    self.configured.as_ref().ok_or_else(closed)?.check()?;
                    self.host
                        .require_project_ready(&self.project)
                        .map_err(convert)
                });
                self.git = Some(service);
                return result;
            }
            if crate::chat_runtime::METHODS.contains(&method) {
                self.host
                    .require_project_ready(&self.project)
                    .map_err(convert)?;
                if method == "project:read" {
                    configured.require_project(args.first())?;
                    let mut result = self.project()?;
                    result["version"] = json!(self.version);
                    result["epoch"] = json!(self.epoch());
                    if args.get(1).is_some_and(|v| v["state"] == false) {
                        result.as_object_mut().unwrap().remove("state");
                    }
                    return Ok(result);
                }
                if method == "chat:runs" {
                    return Ok(json!({"runs":self.host.runs(),"seq":self.run_seq}));
                }
                if method == "chat:patch" {
                    configured.require_project(args.first())?;
                    return self.patch_unread(args);
                }
                let state = if method == "canvas:snapshot" {
                    self.host
                        .states
                        .whole_state(&self.project)
                        .map_err(convert)?
                } else {
                    Value::Null
                };
                return configured.call_with_git(method, args, state, self.project_git()?);
            }
            if method == "chat:send" {
                configured.validate_send(args.first().unwrap_or(&Value::Null))?;
                self.host
                    .require_project_ready(&self.project)
                    .map_err(convert)?;
                self.open_content()?;
            }
            if self.content.is_some() && DESIGN_SETTINGS.contains(&method) {
                self.host
                    .require_project_ready(&self.project)
                    .map_err(convert)?;
                return Ok(json!({"enabled":true}));
            }
        }
        #[cfg(feature = "app-fixture")]
        if self.bootstrap.is_some() && crate::app_fixture::METHODS.contains(&method) {
            self.host
                .require_project_ready(&self.project)
                .map_err(convert)?;
            self.bootstrap.as_ref().unwrap().check()?;
            if method == "project:read" {
                if args.first().and_then(Value::as_str) != self.project.to_str() {
                    return Err(RpcError::new(
                        "ISOLATED_SCOPE_ONLY",
                        "Choose this generated Project",
                    ));
                }
                let mut result = self.project()?;
                result["version"] = json!(self.version);
                result["epoch"] = json!(self.epoch());
                if args.get(1).is_some_and(|v| v["state"] == false) {
                    result.as_object_mut().unwrap().remove("state");
                }
                return Ok(result);
            }
            if method == "chat:runs" {
                return Ok(json!({"runs":self.host.runs(),"seq":self.run_seq}));
            }
            let state = if method == "canvas:snapshot" {
                self.host
                    .states
                    .whole_state(&self.project)
                    .map_err(convert)?
            } else {
                Value::Null
            };
            return self
                .bootstrap
                .as_ref()
                .unwrap()
                .call(method, args, &self.project, state);
        }

        if crate::artifacts::METHODS.contains(&method) {
            self.host
                .require_project_ready(&self.project)
                .map_err(convert)?;
            self.open_content()?;
            return self
                .content
                .as_ref()
                .ok_or_else(closed)?
                .renderer(method, args.first().unwrap_or(&Value::Null));
        }
        #[cfg(feature = "app-fixture")]
        if self.bootstrap.is_some() && self.content.is_some() && DESIGN_SETTINGS.contains(&method) {
            self.host
                .require_project_ready(&self.project)
                .map_err(convert)?;
            // Node permanently enables Designs; old clients cannot turn the retired switch off.
            return Ok(json!({"enabled": true}));
        }
        let path = self.project.to_string_lossy();
        match method {
            "project:current" => self.project(),
            "project:open" | "project:switch" | "project:snapshot" | "state:read" => {
                if args.first().and_then(Value::as_str) != Some(&path) {
                    return Err(RpcError::new(
                        "ISOLATED_SCOPE_ONLY",
                        "Only this actor's copied fixture Project is admitted",
                    ));
                }
                if matches!(method, "project:open" | "project:switch") {
                    #[cfg(feature = "chat-runtime")]
                    if let Some(terminals) = &self.terminals {
                        terminals.before_open()?;
                    }
                    self.host.open_project(&self.project).map_err(convert)?;
                    #[cfg(feature = "chat-runtime")]
                    self.reopen_routines()?;
                }
                let project = self.project()?;
                if matches!(method, "project:open" | "project:switch") {
                    self.opened = true;
                    self.open_content()?;
                    #[cfg(feature = "chat-runtime")]
                    if let Some(terminals) = &self.terminals {
                        let state = self.host.states.current(&self.project).ok_or_else(closed)?;
                        terminals.reopen(&state.to_value())?;
                    }
                }
                if method == "state:read" {
                    Ok(
                        json!({"state":project["state"],"version":self.version,"epoch":self.epoch()}),
                    )
                } else {
                    Ok(project)
                }
            }
            "project:forget" => {
                if args.first().and_then(Value::as_str) != Some(&path) {
                    return Err(RpcError::new(
                        "ISOLATED_SCOPE_ONLY",
                        "Choose the fixture Project",
                    ));
                }
                #[cfg(feature = "chat-runtime")]
                if self
                    .terminals
                    .as_ref()
                    .is_some_and(|terminals| !terminals.stop())
                {
                    return Err(RpcError::new(
                        "QUIT_PENDING",
                        "Terminal cleanup must finish before forgetting this Project",
                    ));
                }
                self.host.forget(&self.project, false).map_err(convert)?;
                self.opened = false;
                if let Some(content) = &self.content {
                    content.opened(false);
                }
                Ok(Value::Null)
            }
            "chat:send" => {
                let request = args.first().cloned().unwrap_or(Value::Null);
                #[cfg(feature = "app-fixture")]
                if let Some(bootstrap) = &self.bootstrap {
                    bootstrap.validate_send(&request)?;
                }
                if request["projectPath"].as_str() != Some(&path)
                    || request["provider"] != self.provider
                {
                    return Err(RpcError::new(
                        "ISOLATED_SCOPE_ONLY",
                        "Only the scripted fixture provider and Project are admitted",
                    ));
                }
                #[cfg(feature = "chat-runtime")]
                self.admit_content_send(&request)?;
                self.host.call(method, args).map_err(convert)
            }
            "agent:respond-permission" | "agent:answer-question" | "agent:set-permission-mode" => {
                if method == "agent:set-permission-mode" && self.provider != "claude" {
                    return Err(RpcError::new(
                        "UNSUPPORTED_MUTATION",
                        "Live permission changes require the Claude fixture",
                    ));
                }
                let chat = args
                    .first()
                    .and_then(|v| v["chatId"].as_str())
                    .unwrap_or("");
                if agent_runs::project_of_key(chat) != path {
                    return Err(RpcError::new(
                        "ISOLATED_SCOPE_ONLY",
                        "Choose a Chat in the fixture Project",
                    ));
                }
                self.host.call(method, args).map_err(convert)
            }
            "agent:interrupt" | "chat:queue-send" | "chat:queue-remove" => {
                let chat = args.first().and_then(Value::as_str).unwrap_or("");
                if agent_runs::project_of_key(chat) != path {
                    return Err(RpcError::new(
                        "ISOLATED_SCOPE_ONLY",
                        "Choose a Chat in the fixture Project",
                    ));
                }
                self.host.call(method, args).map_err(convert)
            }
            _ => {
                if args.first().and_then(Value::as_str) != Some(&path) {
                    return Err(RpcError::new(
                        "ISOLATED_SCOPE_ONLY",
                        "Choose the fixture Project",
                    ));
                }
                self.host
                    .require_project_ready(&self.project)
                    .map_err(convert)?;
                self.host.call(method, args).map_err(convert)
            }
        }
    }
    /// A new Chat must fit the configured content owner before ChatHost persists it. The
    /// actor serializes this check with send. Existing ids (including invalid ones) remain
    /// the owner's responsibility, and duplicates return the owner's original receipt.
    #[cfg(feature = "chat-runtime")]
    fn admit_content_send(&mut self, request: &Value) -> Result<(), RpcError> {
        let Some(limit) = self
            .content
            .as_ref()
            .and_then(|content| content.chat_limit())
        else {
            return Ok(());
        };
        let state = self.host.states.current(&self.project).ok_or_else(closed)?;
        let sessions = state.sessions().ok_or_else(closed)?;
        if sessions.len() < limit || request.get("sessionId").is_some_and(|id| !id.is_null()) {
            return Ok(());
        }
        if let Some(id) = request
            .get("clientMessageId")
            .filter(|id| id.as_str().is_some_and(|id| !id.is_empty()))
        {
            if !self
                .host
                .send_status(&self.project, id)
                .map_err(convert)?
                .is_null()
            {
                // No receipt is synthesized here: send still performs its own validation
                // and deduplication. A queued fromQueue request cannot create a new Chat,
                // because a newly created Chat has no matching queue entry.
                return Ok(());
            }
        }
        let Some(worktree) = state
            .get("worktrees")
            .and_then(Value::as_object)
            .and_then(|worktrees| worktrees.get(&jsjson::property_key(request.get("worktreeId"))))
            .and_then(Value::as_object)
        else {
            // The owner refuses an unknown Worktree without creating a Chat.
            return Ok(());
        };
        // Keep this identical to ChatHost::send's starterChat predicate, including
        // the presence (not truthiness) check for handoverDraft and strict id matches.
        let reusable = jsjson::js_entries(sessions).into_iter().any(|(_, item)| {
            item.get("worktree_id").is_some_and(|id| {
                worktree
                    .get("id")
                    .is_some_and(|wid| jsjson::strict_equals(id, wid))
            }) && !jsjson::truthy(item.get("handoverPending"))
                && item.get("handoverDraft").is_none()
                && !jsjson::truthy(item.get("routine"))
                && !(item
                    .get("summary")
                    .and_then(|s| s.get("count"))
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0)
                    > 0.0
                    || state.message_list().iter().any(|message| {
                        message.get("session_id").is_some_and(|id| {
                            jsjson::strict_equals(id, item.get("id").unwrap_or(&Value::Null))
                        })
                    }))
        });
        if reusable {
            return Ok(());
        }
        Err(RpcError::new(
            "CONTENT_CHAT_LIMIT",
            "Configured content Chat admission is full",
        ))
    }
    /// Narrow configured-runtime subset of runtime.cjs patchChat / project-edits.patchSession.
    /// False removes the field. All other patch fields remain unsupported, including mixed patches.
    #[cfg(feature = "chat-runtime")]
    fn patch_unread(&mut self, args: &[Value]) -> RpcResult {
        if args.first().and_then(Value::as_str) != self.project.to_str() {
            return Err(RpcError::new(
                "ISOLATED_SCOPE_ONLY",
                "Choose this configured Project",
            ));
        }
        self.host
            .require_project_ready(&self.project)
            .map_err(convert)?;
        let invalid = || {
            RpcError::new(
                "INVALID_CHAT_PATCH",
                "Expected an existing positive Chat ID and only {unread: boolean}",
            )
        };
        if args.len() != 3 {
            return Err(invalid());
        }
        let session = args[1]
            .as_f64()
            .filter(|id| id.fract() == 0.0 && *id >= 1.0 && *id <= 9_007_199_254_740_991.0)
            .ok_or_else(invalid)? as i64;
        let patch = args[2]
            .as_object()
            .filter(|patch| patch.len() == 1)
            .ok_or_else(invalid)?;
        let unread = patch
            .get("unread")
            .and_then(Value::as_bool)
            .ok_or_else(invalid)?;
        let mut exists = false;
        let (_, changed) = self
            .host
            .states
            .update(&self.project, Some(&[]), true, |current| {
                let mut next = current
                    .sessions()?
                    .get(&session.to_string())?
                    .as_object()?
                    .clone();
                exists = true;
                if unread {
                    if next.get("unread") == Some(&Value::Bool(true)) {
                        return None;
                    }
                    next.insert("unread".into(), Value::Bool(true));
                } else if next.shift_remove("unread").is_none() {
                    return None;
                }
                Some(agent_runs::with_session(current, session, next))
            })
            .map_err(convert)?;
        if !exists {
            return Err(RpcError::new("CHAT_NOT_FOUND", "Choose an existing Chat"));
        }
        // A failed save retains the owner's dirty state and persistence error. It cannot
        // produce a success reply; ordinary persistence publication reports the failure.
        self.host
            .states
            .flush(Some(&self.project))
            .map_err(convert)?;
        self.project_changed |= changed;
        Ok(Value::Null)
    }
    fn audit_cleanup_refusal(
        &self,
        shared: &Shared,
        error: &milagre_owner_store::StoreError,
    ) -> bool {
        // Once this owner has closed, exact captured worker events cannot reopen it.
        // Keep their refusal as an audit count, not an active-owner transition failure.
        // Foreign scopes, save/release failures and pre-Done refusals keep their errors.
        if self.host.quit_state() == QuitState::Done
            && self.host.states.is_closed()
            && matches!(error, milagre_owner_store::StoreError::ProjectNotReady(message)
                if message == &format!("{} isn't open and ready here; nothing was saved or started.", self.project.display()))
        {
            let _ =
                shared
                    .late_cleanup_refusals
                    .try_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                        Some(n.saturating_add(1))
                    });
            true
        } else {
            false
        }
    }
    fn tick(&mut self, now: i64, shared: &Shared) -> Result<(), RpcError> {
        // Live ownership/root/store checks are bounded independently of renderer traffic.
        // Revoke grants before driving the host. Deferring events and gating launches
        // remain owner responsibilities, not properties of this periodic sampling check.
        let mut readiness_error = None;
        if Instant::now() >= self.next_readiness_check {
            self.next_readiness_check = Instant::now() + READINESS_CHECK;
            if self.host.is_project_ready(&self.project) && !self.host.states.is_closed() {
                readiness_error = self
                    .host
                    .require_project_ready(&self.project)
                    .err()
                    .map(convert);
            }
            self.sync_readiness();
        }
        let errors = if self.host.states.is_closed() {
            self.host.pump()
        } else {
            self.host.tick(now)
        };
        if let Some(error) = readiness_error {
            return Err(error);
        }
        let mut first_failure = None;
        for error in errors {
            if !self.audit_cleanup_refusal(shared, &error) && first_failure.is_none() {
                first_failure = Some(error);
            }
        }
        if let Some(error) = first_failure {
            return Err(convert(error));
        }
        Ok(())
    }
    fn publish(&mut self, shared: &Shared, publication: &Publication<'_>) -> Result<(), RpcError> {
        self.sync_readiness();
        let notices = self.host.take_notices();
        let state_events = self.host.states.take_events();
        // Audit does not require a hydrated snapshot or a working wire. In
        // particular, shutdown can strand a lock after removing its state slot.
        // Consume these once before either fallible publication boundary.
        for notice in &notices {
            match notice {
                Notice::AnswerForgotten { .. } => record_forgotten_answer(shared),
                Notice::LockStranded { .. } => {
                    let _ = shared.stranded_lock_notices.try_update(
                        Ordering::AcqRel,
                        Ordering::Acquire,
                        |count| Some(count.saturating_add(1)),
                    );
                }
                Notice::Failed { error, .. } | Notice::Gap { what: error, .. } => {
                    record_failure(shared, error.clone());
                }
                _ => {}
            }
        }
        for event in &state_events {
            if let Event::SaveFailed { error, .. } = event {
                record_failure(shared, error.clone());
            }
        }
        if shared.delivery_failed.load(Ordering::Acquire) {
            // The original delivery fault stays authoritative, even if a later
            // best-effort hidden-cache refresh cannot hydrate saved messages.
            let _ = self.cache(shared);
            return Err(delivery_failed());
        }
        for notice in &notices {
            if let Notice::ProjectReady { project } = notice {
                if project == &self.project && self.host.is_project_ready(project) {
                    #[cfg(test)]
                    shared.ready_notices.fetch_add(1, Ordering::AcqRel);
                    self.opened = true;
                    self.open_content()?;
                }
            }
        }
        // Cache and events are committed under one publication lock. No state is
        // read via the actor from Handler::snapshot, including during shutdown.
        self.cache(shared)?;
        let mut state_queued = false;
        if self.project_changed {
            self.queue_event(
                "project:state",
                json!({"path":self.project,"state":self.last}),
            )?;
            self.project_changed = false;
            state_queued = true;
        }
        for notice in notices {
            match notice {
                Notice::Event {
                    chat,
                    event,
                    seq,
                    with_state,
                } => {
                    if !self.host.is_project_ready(&self.project) {
                        continue;
                    }
                    let mut payload = json!({"chatId":chat,"event":event});
                    if let Some(seq) = seq {
                        payload["seq"] = json!(seq);
                    }
                    if with_state {
                        payload["state"] = self.last.clone();
                    }
                    self.queue_event("agent:event", payload)?;
                }
                Notice::Broadcast { project } | Notice::ProjectReady { project } => {
                    if project != self.project || !self.host.is_project_ready(&project) {
                        continue;
                    }
                    if !state_queued {
                        self.queue_event(
                            "project:state",
                            json!({"path":project,"state":self.last}),
                        )?;
                        state_queued = true;
                    }
                }
                Notice::SteerRequested { .. } => {
                    // This executable keeps SteeringMode::Gated. If that contract changes,
                    // close admission instead of dropping a durably accepted steering request.
                    return Err(RpcError::new(
                        "UNSUPPORTED_STEERING",
                        "The isolated actor has no steering adapter",
                    ));
                }
                Notice::AnswerSettled { answer, result, .. } => {
                    if let Some(reply) = self.answers.remove(&answer) {
                        self.settled_replies.push((
                            reply,
                            match result {
                                AnswerResult::Accepted => Ok(Value::Bool(true)),
                                AnswerResult::NotWaiting => Ok(Value::Bool(false)),
                                AnswerResult::Failed(message) => Err(RpcError::new(
                                    "ANSWER_FAILED",
                                    String::from_utf16_lossy(&jsjson::to_utf16(&message)),
                                )),
                                AnswerResult::Uncertain(_) => Err(RpcError::new(
                                    "ANSWER_DELIVERY_UNKNOWN",
                                    "The agent has not confirmed delivery of this answer.",
                                )),
                            },
                        ));
                    }
                }
                // The original command already settled as unknown. Any rollback/state
                // changes are published through the owner's ordinary notices, never a second reply.
                Notice::AnswerResolved { .. } => {}
                Notice::ModeSettled { change, result, .. } => {
                    if let Some(reply) = self.modes.remove(&change) {
                        self.settled_replies.push((
                            reply,
                            match result {
                                ModeResult::Applied => Ok(Value::Null),
                                ModeResult::Failed(message) => Err(RpcError::new(
                                    "MODE_CHANGE_FAILED",
                                    String::from_utf16_lossy(&jsjson::to_utf16(&message)),
                                )),
                                ModeResult::Uncertain(_) => Err(RpcError::new(
                                    "MODE_DELIVERY_UNKNOWN",
                                    "The agent has not confirmed the permission change.",
                                )),
                            },
                        ));
                    }
                }
                // The original uncertain command already replied. A late receipt only
                // publishes the saved preference through ordinary owner notices.
                Notice::ModeResolved { .. } => {}
                Notice::AnswerForgotten { .. }
                | Notice::LockStranded { .. }
                | Notice::Failed { .. }
                | Notice::Gap { .. } => {} // audited before snapshot hydration
                // Naming and sender-local queue replies are not implemented by this fixture.
                Notice::NameChat { .. }
                | Notice::QueueStarted { .. }
                | Notice::QueueStartedWithoutSender { .. }
                | Notice::QueueRemovedWithoutSender { .. }
                | Notice::Started { .. } => {}
            }
        }
        for event in state_events {
            match event {
                Event::Persistence { project, .. } | Event::Unloaded { project } => {
                    if project != self.project || !self.host.is_project_ready(&project) {
                        continue;
                    }
                    if !state_queued {
                        self.queue_event(
                            "project:state",
                            json!({"path":project,"state":self.last}),
                        )?;
                        state_queued = true;
                    }
                }
                Event::SaveFailed { .. } | Event::Saved { .. } => {}
            }
        }
        #[cfg(feature = "chat-runtime")]
        if let Some(terminals) = &self.terminals {
            let events = terminals.events()?;
            for (channel, payload) in events {
                self.queue_event(&channel, payload)?;
            }
        }
        while let Some((channel, payload)) = self.pending.front() {
            if let Err(error) = publication.emit(channel, payload.clone()) {
                self.cache_run_sequence(shared);
                return Err(error);
            }
            if channel == "agent:event" {
                if let Some(seq) = payload.get("seq").and_then(Value::as_u64) {
                    self.run_seq = self.run_seq.max(seq);
                }
            }
            self.pending.pop_front();
        }
        self.cache_run_sequence(shared);
        for (reply, result) in self.settled_replies.drain(..) {
            let _ = reply.send(result);
        }
        Ok(())
    }
    fn cache_run_sequence(&self, shared: &Shared) {
        // The Project snapshot was already built under this publication lock. Only
        // the successful event watermark changed; avoid cloning the whole Project again.
        shared.snapshot.lock().unwrap()["runs"]["seq"] = json!(self.run_seq);
    }
    fn queue_event(&mut self, channel: &str, mut payload: Value) -> Result<(), RpcError> {
        if channel == "project:state" {
            self.stamp(&mut payload);
        }
        if self.pending.len() >= 256 {
            return Err(RpcError::new(
                "OWNER_EVENT_OVERFLOW",
                "The isolated owner event queue is full",
            ));
        }
        // Same threshold as this fixture's wire server. Avoid retaining large state
        // clones when production clients will reread the state through paging.
        if payload
            .get("state")
            .is_some_and(|state| jsjson::to_string(state).len() > 1024)
        {
            payload.as_object_mut().unwrap().remove("state");
            payload["stateTooLarge"] = json!(true);
        }
        self.pending.push_back((channel.into(), payload));
        Ok(())
    }
    fn publish_or_latch(
        &mut self,
        shared: &Shared,
        publication: &Publication<'_>,
    ) -> Result<(), RpcError> {
        self.publish(shared, publication).inspect_err(|error| {
            shared.delivery_failed.store(true, Ordering::Release);
            shared.closing.store(true, Ordering::Release);
            record_failure(shared, error.message.clone());
            for (_, reply) in self.answers.drain() {
                let _ = reply.send(Err(delivery_failed()));
            }
            for (_, reply) in self.modes.drain() {
                let _ = reply.send(Err(delivery_failed()));
            }
            for (reply, _) in self.settled_replies.drain(..) {
                let _ = reply.send(Err(delivery_failed()));
            }
        })
    }
    fn shutdown(
        &mut self,
        shared: &Shared,
        publication: &Publication<'_>,
        force: bool,
        refused: &mut bool,
    ) -> RpcResult {
        // This fixture explicitly cancels its synthetic turns. Production quit-time
        // suspend/resume remains unported and must not reuse this policy.
        let chats: Vec<_> = self.host.runs().keys().cloned().collect();
        for chat in chats {
            self.host.interrupt(&chat).map_err(convert)?;
        }
        // As on a normal tick and in ChatHost::shutdown, a refused late event is diagnostic, not a veto on
        // closing. Deliver still refuses it without reopening or mutating its Project. Audit every error here;
        // the actual owner shutdown below remains responsible for busy, save and ownership failures.
        for error in self.host.pump() {
            if !self.audit_cleanup_refusal(shared, &error) {
                record_failure(shared, error.to_string());
            }
        }
        // Keep cancellation state in the cached snapshot before close releases its slots.
        if !shared.delivery_failed.load(Ordering::Acquire) {
            self.publish_or_latch(shared, publication)?;
        }
        #[cfg(feature = "chat-runtime")]
        if self
            .terminals
            .as_ref()
            .is_some_and(|terminals| !terminals.stop())
        {
            return Err(RpcError::new(
                "QUIT_PENDING",
                "Terminal process cleanup is still pending",
            ));
        }
        #[cfg(feature = "chat-runtime")]
        if let Some(routines) = &mut self.routines {
            routines.close()?;
        }
        let was_running = self.host.quit_state() == QuitState::Running;
        let closed = self.host.shutdown(force);
        #[cfg(test)]
        {
            *shared.observed_quit.lock().unwrap() = Some(self.host.quit_state());
        }
        // Only the owner's actual busy gate, before shutdown starts, permits
        // reopening. Diagnostic pump refusals never turn a failed save or release into a busy refusal.
        *refused = was_running
            && matches!(&closed, Err(milagre_owner_store::StoreError::Invalid(_)))
            && self.host.quit_state() == QuitState::Running;
        let closed = closed.map_err(convert);
        // Closing may produce stranded-lock or failure notices on every retry,
        // including the final one. Drain them before returning any close result.
        let already_failed = shared.delivery_failed.load(Ordering::Acquire);
        let publication = self.publish_or_latch(shared, publication);
        // Publication still drains audit and latches its own failure, but cannot
        // replace the error that prevented the actual owner shutdown.
        closed?;
        if !already_failed {
            publication?;
        }
        if self.host.quit_state() != QuitState::Done || !self.jobs.is_empty() {
            return Err(RpcError::new(
                "QUIT_PENDING",
                "Transcript worker cleanup is still pending",
            ));
        }
        if let Some(content) = &self.content {
            if !content.native_drained() {
                return Err(RpcError::new(
                    "QUIT_PENDING",
                    "Native content session cleanup is still pending",
                ));
            }
            content.shutdown();
        }
        self.host.states.take_events();
        Ok(Value::Null)
    }
}
#[cfg(test)]
fn inject_commit_fault(state: &mut State, shared: &Shared) {
    let fail = shared.fail_commits.load(Ordering::Acquire);
    state
        .host
        .states
        .set_commit_failure_for_tests(fail.then_some("fixed retained-completion fold failure"));
    if fail {
        shared.injected_commits.fetch_add(1, Ordering::AcqRel);
    }
}
fn run(
    mut state: State,
    shared: Arc<Shared>,
    requests: Receiver<Request>,
    started: Instant,
    epoch: i64,
) {
    let mut next = Instant::now() + TICK;
    while !shared.stop.load(Ordering::Acquire) {
        state.jobs.drive(&mut state.host);
        let request = match requests.recv_timeout(next.saturating_duration_since(Instant::now())) {
            Ok(request) => Some(request),
            Err(RecvTimeoutError::Timeout) => None,
            Err(RecvTimeoutError::Disconnected) => break,
        };
        let sink = shared.events.lock().unwrap().clone();
        let Some(sink) = sink else {
            if let Some(request) = request {
                shared.bytes.fetch_sub(request.bytes, Ordering::AcqRel);
                let _ = request.reply.send(Err(closed()));
            }
            next = Instant::now() + TICK;
            continue;
        };
        if let Some(request) = request {
            shared.bytes.fetch_sub(request.bytes, Ordering::AcqRel);
            let shutdown = matches!(request.command, Command::Shutdown { .. });
            let state_read = matches!(&request.command,Command::Call(method,_) if method=="state:read" || method=="project:read");
            let refusal = match &request.command {
                Command::Shutdown { refused, .. } => Some(refused.clone()),
                _ => None,
            };
            let mut began_open = false;
            let mut refused = false;
            let mut reply = Some(request.reply);
            let answer_call = matches!(&request.command,Command::Call(method,_) if matches!(method.as_str(),"agent:respond-permission"|"agent:answer-question"));
            let mode_call = matches!(&request.command,Command::Call(method,_) if method == "agent:set-permission-mode");
            let result = sink.transaction(|publication| {
                let mut result = match request.command {
                    Command::Call(method, args) => {
                        #[cfg(test)]
                        if matches!(method.as_str(), "project:open" | "project:switch") {
                            inject_commit_fault(&mut state, &shared);
                        }
                        if shared.closing.load(Ordering::Acquire) {
                            Err(closed())
                        } else {
                            state.call(&method, &args)
                        }
                    }
                    Command::Shutdown { force, .. } => {
                        began_open = !shared.closing.swap(true, Ordering::AcqRel);
                        state.shutdown(&shared, publication, force, &mut refused)
                    }
                };
                if answer_call {
                    if let Ok(value) = &result {
                        if let Some(id) = value["pendingAnswer"].as_u64() {
                            state.answers.insert(AnswerId(id), reply.take().unwrap());
                        }
                    }
                }
                if mode_call {
                    if let Ok(value) = &result {
                        if let Some(id) = value["pendingMode"].as_u64() {
                            state.modes.insert(ModeChangeId(id), reply.take().unwrap());
                        }
                    }
                }
                if !(shutdown && shared.delivery_failed.load(Ordering::Acquire)) {
                    let published = state.publish_or_latch(&shared, publication);
                    if !shutdown || result.is_ok() {
                        published?;
                    }
                }
                if state_read {
                    if let Ok(value) = &mut result {
                        value["version"] = json!(state.version);
                    }
                }
                result
            });
            if shutdown
                && result.is_err()
                && began_open
                && refused
                && state.host.quit_state() == QuitState::Running
                && !shared.delivery_failed.load(Ordering::Acquire)
            {
                shared.closing.store(false, Ordering::Release);
                if let Some(refusal) = refusal {
                    refusal.store(true, Ordering::Release);
                }
            }
            if shutdown && result.is_ok() {
                shared.stop.store(true, Ordering::Release);
            }
            if let Some(reply) = reply {
                let _ = reply.send(result);
            }
        }
        if Instant::now() >= next {
            next = Instant::now() + TICK; // coalesce elapsed ticks, never queue timer messages
            {
                // Closed admission does not stop asynchronous cancellation/event
                // settlement. A failed states.close only stops persistence timers.
                let result = sink.transaction(|publication| {
                    #[cfg(test)]
                    if state.host.is_project_ready(&state.project) {
                        inject_commit_fault(&mut state, &shared);
                    }
                    let result = state.tick(
                        epoch.saturating_add(
                            started.elapsed().as_millis().min(i64::MAX as u128) as i64
                        ),
                        &shared,
                    );
                    state.publish_or_latch(&shared, publication)?;
                    result
                });
                if let Err(error) = result {
                    record_failure(&shared, error.message);
                }
                #[cfg(test)]
                shared.observed_ticks.fetch_add(1, Ordering::AcqRel);
            }
        }
    }
}

/// Fresh fixture only. No caller-supplied path, policy, provider executable or environment.
pub fn start() -> Result<(Server, Value), RpcError> {
    let profile = IsolatedProfile::create()?;
    let isolation = Isolation::create(profile.path(), &Policy::system()).map_err(convert)?;
    let project = isolation
        .project(std::path::Path::new("fixture"))
        .map_err(convert)?;
    fs::create_dir(project.join(".milagre"))?;
    fs::write(project.join(".milagre/coordination.json"),json!({"next_id":10,"name":"actor","worktrees":{"1":{"id":1,"path":project,"name":"main"}},"sessions":{"1":{"id":1,"worktree_id":1},"2":{"id":2,"worktree_id":1}},"messages":[]}).to_string())?;
    start_provider(
        profile,
        isolation,
        project,
        Box::new(Scripted::default()),
        "kiro",
        None,
        #[cfg(feature = "app-fixture")]
        None,
        #[cfg(feature = "chat-runtime")]
        None,
    )
}

#[cfg(feature = "app-fixture")]
pub(crate) fn start_app_fixture(populated: bool) -> Result<(Server, Value), RpcError> {
    let profile = IsolatedProfile::create()?;
    let isolation = Isolation::create(profile.path(), &Policy::system()).map_err(convert)?;
    let project = isolation
        .project(std::path::Path::new("fixture"))
        .map_err(convert)?;
    fs::create_dir(project.join(".milagre"))?;
    let fixture = crate::app_fixture::generated(&project);
    fs::write(
        project.join(".milagre/coordination.json"),
        fixture["seed"].to_string(),
    )?;
    let mut bootstrap = crate::app_fixture::Bootstrap::new(isolation.clone(), &project)?;
    bootstrap.populate_transcript = populated;
    let content = crate::claude_content::SharedContent::new(isolation.clone(), project.clone())
        .map_err(|error| RpcError::new(error.code, error.message))?;
    let (server, mut metadata) = start_provider(
        profile,
        isolation,
        project,
        Box::new(Scripted::default()),
        "kiro",
        Some(content),
        Some(bootstrap),
        #[cfg(feature = "chat-runtime")]
        None,
    )?;
    metadata["appFixture"] = json!(true);
    metadata["handoff"] = json!("gated");
    metadata["steering"] = json!("gated");
    if populated {
        metadata["transcriptPreset"] = json!("three-turns");
    }
    Ok((server, metadata))
}

/// Separate fake-CLI owner fixture. It never adopts the wire profile or a production account.
pub fn start_claude(
    scenario: crate::claude_fixture::Scenario,
) -> Result<(Server, Value, crate::claude_fixture::FixtureMonitor), RpcError> {
    let provider = crate::claude_fixture::ClaudeFixture::create(scenario).map_err(|_| {
        RpcError::new(
            "FIXTURE_FAILED",
            "Could not create the private Claude fixture",
        )
    })?;
    let monitor = provider.monitor();
    let content = provider.content.clone();
    let (server, metadata) = start_provider(
        IsolatedProfile::create()?,
        provider.isolation(),
        provider.project().to_path_buf(),
        Box::new(provider),
        "claude",
        content,
        #[cfg(feature = "app-fixture")]
        None,
        #[cfg(feature = "chat-runtime")]
        None,
    )?;
    Ok((server, metadata, monitor))
}
#[cfg(feature = "acp-fixture")]
pub fn start_acp(
    scenario: crate::acp_fixture::Scenario,
) -> Result<(Server, Value, crate::acp_fixture::Monitor), RpcError> {
    let provider = crate::acp_fixture::AcpFixture::create(scenario)
        .map_err(|_| RpcError::new("FIXTURE_FAILED", "Could not create isolated ACP fixture"))?;
    let monitor = provider.monitor();
    let (server, mut metadata) = start_provider(
        IsolatedProfile::create()?,
        provider.isolation(),
        provider.project().to_path_buf(),
        Box::new(provider),
        "kiro",
        None,
        #[cfg(feature = "app-fixture")]
        None,
        #[cfg(feature = "chat-runtime")]
        None,
    )?;
    metadata["scriptedProvider"] = json!(false);
    metadata["fakeAcp"] = json!(true);
    Ok((server, metadata, monitor))
}
/// One explicit dedicated Project and captured provider configuration, using the same owner/publication lifecycle
/// as the fixture executables. The caller retains the persistent root lease until provider cleanup finishes.
#[cfg(feature = "chat-runtime")]
pub(crate) fn start_configured(
    profile: IsolatedProfile,
    isolation: Isolation,
    project: PathBuf,
    provider: Box<dyn Provider>,
    content: Arc<crate::claude_content::SharedContent>,
    configured: crate::chat_runtime::Bootstrap,
) -> Result<(Server, Value), RpcError> {
    start_provider(
        profile,
        isolation,
        project,
        provider,
        "claude",
        Some(content),
        #[cfg(feature = "app-fixture")]
        None,
        Some(configured),
    )
}

fn start_provider(
    profile: IsolatedProfile,
    isolation: Isolation,
    project: PathBuf,
    provider: Box<dyn Provider>,
    provider_name: &'static str,
    content: Option<Arc<crate::claude_content::SharedContent>>,
    #[cfg(feature = "app-fixture")] bootstrap: Option<crate::app_fixture::Bootstrap>,
    #[cfg(feature = "chat-runtime")] configured: Option<crate::chat_runtime::Bootstrap>,
) -> Result<(Server, Value), RpcError> {
    #[cfg(feature = "chat-runtime")]
    let persistent = configured.is_some();
    #[cfg(not(feature = "chat-runtime"))]
    let persistent = false;
    let epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let started = Instant::now();
    let mut host = ChatHost::new(ProjectStates::new(
        isolation,
        if persistent {
            Timing::default()
        } else {
            Timing {
                debounce_ms: 100,
                idle_ms: 350,
                sweep_ms: 100,
                lazy: true,
            }
        },
        epoch,
    ));
    if !persistent {
        host.interrupt_grace_ms = 250;
        host.answer_grace_ms = 250;
    }
    let interrupt_grace = host.interrupt_grace_ms;
    host.answer_capacity = 32;
    host.register(provider);
    // This fixed fixture Project is admitted by trusted setup, never a saved path.
    host.open_project(&project).map_err(convert)?;
    #[cfg(feature = "app-fixture")]
    let initial_run_seq = if bootstrap.as_ref().is_some_and(|b| b.populate_transcript) {
        populate_transcript(&mut host, &project, epoch, started)?
    } else {
        0
    };
    #[cfg(not(feature = "app-fixture"))]
    let initial_run_seq = 0;
    if let Some(content) = &content {
        let state = host.states.current(&project).ok_or_else(closed)?;
        content
            .reconcile(state.sessions())
            .map_err(|error| RpcError::new(error.code, error.message))?;
        content.opened(true);
        #[cfg(feature = "app-fixture")]
        if bootstrap.is_some() {
            crate::app_content::initialize(content, &project)?;
        }
    }
    let shared = Arc::new(Shared {
        snapshot: Mutex::new(
            json!({"projects":[],"links":[],"runs":{"runs":{},"seq":0},"ports":{}}),
        ),
        events: Mutex::new(None),
        bytes: AtomicUsize::new(0),
        closing: AtomicBool::new(false),
        stop: AtomicBool::new(false),
        failure: Mutex::new(None),
        delivery_failed: AtomicBool::new(false),
        forgotten_answers: AtomicU64::new(0),
        stranded_lock_notices: AtomicU64::new(0),
        late_cleanup_refusals: AtomicU64::new(0),
        #[cfg(test)]
        observed_quit: Mutex::new(None),
        #[cfg(test)]
        ready_notices: AtomicUsize::new(0),
        #[cfg(test)]
        parked_events: AtomicUsize::new(0),
        #[cfg(test)]
        observed_ticks: AtomicUsize::new(0),
        #[cfg(test)]
        fail_commits: AtomicBool::new(false),
        #[cfg(test)]
        injected_commits: AtomicUsize::new(0),
        #[cfg(test)]
        stuck_ends: AtomicUsize::new(0),
    });
    #[cfg(feature = "chat-runtime")]
    let terminals = configured
        .as_ref()
        .map(|config| {
            crate::configured_terminals::ConfiguredTerminals::new(
                project.clone(),
                config.retained_check(),
            )
            .map(Arc::new)
        })
        .transpose()?;
    #[cfg(feature = "chat-runtime")]
    let git = if persistent {
        Some(crate::configured_git::ConfiguredGit::new(project.clone())?)
    } else {
        None
    };
    #[cfg(feature = "chat-runtime")]
    let routines = configured
        .as_ref()
        .map(|config| {
            crate::configured_routines::ConfiguredRoutines::open(
                config.data_root(),
                project.clone(),
                config.retained_check(),
                epoch,
            )
        })
        .transpose()?;
    let (send, requests) = mpsc::sync_channel(QUEUE);
    let actor = Arc::new(Actor {
        send,
        shared: shared.clone(),
        thread: Mutex::new(None),
        project: project.to_string_lossy().into_owned(),
        content: content.is_some(),
        configured: persistent,
        claude_modes: provider_name == "claude",
        #[cfg(feature = "chat-runtime")]
        terminals: terminals.clone(),
        app_fixture: {
            #[cfg(feature = "app-fixture")]
            {
                bootstrap.is_some()
            }
            #[cfg(not(feature = "app-fixture"))]
            {
                false
            }
        },
    });
    let profile_lease = profile.lease();
    let mut state = State {
        host,
        jobs: crate::jobs::Workers::default(),
        provider: provider_name,
        content,
        project,
        opened: true,
        version: 0,
        publication_epoch: persistent.then(|| format!("rust-chat:{}", profile.path().display())),
        last: Value::Null,
        run_seq: initial_run_seq,
        next_readiness_check: Instant::now(),
        pending: VecDeque::new(),
        project_changed: false,
        answers: HashMap::new(),
        modes: HashMap::new(),
        settled_replies: Vec::new(),
        #[cfg(feature = "app-fixture")]
        bootstrap,
        #[cfg(feature = "chat-runtime")]
        configured,
        #[cfg(feature = "chat-runtime")]
        terminals,
        #[cfg(feature = "chat-runtime")]
        git,
        #[cfg(feature = "chat-runtime")]
        routines,
        _profile: profile_lease,
    };
    state.cache(&shared)?;
    let server = Server::bind(
        profile,
        actor.clone(),
        if persistent {
            Config::default()
        } else {
            Config {
                max_frame_bytes: 4096,
                // Tiny frames exercise paging; the independent bounded reply budget
                // accommodates the fixture's concurrent requests without enlarging frames.
                outgoing_budget_bytes: Some(128 * 1024),
                ..Config::default()
            }
        },
    )?;
    *shared.events.lock().unwrap() = Some(server.events());
    *actor.thread.lock().unwrap() = Some(thread::spawn(move || {
        run(state, shared, requests, started, epoch)
    }));
    let metadata = json!({"project":actor.project,"scriptedProvider":provider_name == "kiro","provider":provider_name,"tickMs":20,"debounceMs":if persistent { 250 } else { 100 },"idleMs":if persistent { 600000 } else { 350 },"interruptGraceMs":interrupt_grace});
    Ok((server, metadata))
}

/// Populate only the explicitly selected app preset through the real owner/provider fold.
/// No client can connect until all turns finish and the owned stores flush successfully.
#[cfg(feature = "app-fixture")]
fn populate_transcript(
    host: &mut ChatHost,
    project: &std::path::Path,
    epoch: i64,
    started: Instant,
) -> Result<u64, RpcError> {
    let deadline = Instant::now() + Duration::from_secs(2);
    for (session, body) in [
        (1, "Fixture history: first turn"),
        (1, "Fixture history: second turn"),
        (2, "Fixture history: another Chat"),
    ] {
        let request = json!({"projectPath": project, "sessionId": session,
            "worktreeId": 1, "body": body, "provider": "kiro",
            "model": "scripted", "permissionMode": "ask"});
        let sent = host.send(&request).map_err(convert)?;
        if sent.turn.is_none() || sent.queued || sent.duplicate {
            return Err(RpcError::new(
                "FIXTURE_POPULATION_FAILED",
                "Scripted turn was not started",
            ));
        }
        let chat = agent_runs::chat_key(&project.to_string_lossy(), &json!(session));
        while host.active_turn(&chat).is_some() {
            if Instant::now() >= deadline {
                return Err(RpcError::new(
                    "FIXTURE_POPULATION_FAILED",
                    "Scripted history deadline expired",
                ));
            }
            let errors = host.tick(epoch.saturating_add(started.elapsed().as_millis() as i64));
            if let Some(error) = errors.into_iter().next() {
                return Err(convert(error));
            }
            thread::sleep(Duration::from_millis(5));
        }
    }
    host.states.flush(Some(project)).map_err(convert)?;
    // Startup is represented in the initial snapshot, not streamed as new work
    // after a snapshot-first client has accepted that already-completed state.
    let mut run_seq = 0;
    for notice in host.take_notices() {
        match notice {
            Notice::Event { seq: Some(seq), .. } => run_seq = run_seq.max(seq),
            Notice::Failed { error, .. } | Notice::Gap { what: error, .. } => {
                return Err(RpcError::new("FIXTURE_POPULATION_FAILED", error));
            }
            Notice::LockStranded { .. } => {
                return Err(RpcError::new(
                    "FIXTURE_POPULATION_FAILED",
                    "Startup stranded an owner lock",
                ));
            }
            _ => {}
        }
    }
    for event in host.states.take_events() {
        if let Event::SaveFailed { error, .. } = event {
            return Err(RpcError::new("FIXTURE_POPULATION_FAILED", error));
        }
    }
    Ok(run_seq)
}

#[derive(Default)]
struct Scripted {
    events: VecDeque<(Instant, ProviderEvent)>,
    active: HashMap<String, TurnId>,
    delayed_stop: HashSet<TurnId>,
    ignored_stop: HashSet<TurnId>,
}
impl Provider for Scripted {
    fn name(&self) -> &str {
        "kiro"
    }
    fn start_turn(&mut self, turn: TurnId, request: &RawJson) -> Result<(), ProviderError> {
        let request = &request.0;
        if self.active.len() >= 8 || self.events.len() > 55 {
            return Err(ProviderError::new(
                ProviderErrorKind::Refused,
                "Scripted provider is full",
            ));
        }
        let chat = request["chatId"].as_str().unwrap_or("").to_owned();
        self.active.insert(chat.clone(), turn);
        self.events.push_back((
            Instant::now(),
            ProviderEvent::Agent {
                chat: chat.clone(),
                turn,
                event: RawJson(
                    json!({"type":"session-started","nativeId":format!("fixture-{chat}")}),
                ),
            },
        ));
        if request["prompt"] == "fixture:ignore-stop" {
            self.ignored_stop.insert(turn);
        }
        if request["prompt"] == "fixture:delayed-stop" {
            self.delayed_stop.insert(turn);
        }
        if request["prompt"] == "fixture:blocked-start"
            || request["prompt"] == "fixture:delayed-stop"
            || request["prompt"] == "fixture:ignore-stop"
        {
            return Ok(());
        }
        let now = Instant::now();
        self.events.push_back((
            now,
            ProviderEvent::Started {
                chat: chat.clone(),
                turn,
                result: RawJson(json!({"turnId":format!("fixture-{}",turn.0),"steered":false})),
            },
        ));
        for (delay, event) in [
            (20, json!({"type":"message-sent"})),
            (
                50,
                json!({"type":"text-delta","text":"Scripted isolated reply"}),
            ),
            (140, json!({"type":"turn-completed"})),
        ] {
            self.events.push_back((
                now + Duration::from_millis(delay),
                ProviderEvent::Agent {
                    chat: chat.clone(),
                    turn,
                    event: RawJson(event),
                },
            ));
        }
        if request["prompt"] == "fixture:late-events" {
            self.events.push_back((
                now + Duration::from_millis(200),
                ProviderEvent::Agent {
                    chat: chat.clone(),
                    turn,
                    event: RawJson(json!({"type":"turn-completed"})),
                },
            ));
            self.events.push_back((
                now + Duration::from_millis(230),
                ProviderEvent::Exited {
                    chat: chat.clone(),
                    turn,
                    error: ProviderError::new(
                        ProviderErrorKind::Exited,
                        "Old fixture session exited",
                    ),
                },
            ));
            self.events.push_back((
                now + Duration::from_millis(260),
                ProviderEvent::Agent {
                    chat: chat.clone(),
                    turn,
                    event: RawJson(json!({"type":"session-reset"})),
                },
            ));
            self.events.push_back((
                now + Duration::from_millis(300),
                ProviderEvent::Agent {
                    chat,
                    turn,
                    event: RawJson(json!({"type":"text-delta","text":"late text must not appear"})),
                },
            ));
        }
        Ok(())
    }
    fn interrupt(&mut self, chat: &str, turn: TurnId) -> Result<(), ProviderError> {
        if self.ignored_stop.contains(&turn) {
            return Ok(());
        }
        self.events.retain(|(_,event)| !matches!(event,ProviderEvent::Agent{chat:target,turn:id,..}|ProviderEvent::Started{chat:target,turn:id,..} if target==chat && *id==turn));
        let at = Instant::now()
            + if self.delayed_stop.remove(&turn) {
                Duration::from_millis(100)
            } else {
                Duration::ZERO
            };
        self.events.push_front((
            at,
            ProviderEvent::Agent {
                chat: chat.into(),
                turn,
                event: RawJson(json!({"type":"turn-cancelled"})),
            },
        ));
        Ok(())
    }
    fn respond_permission(
        &mut self,
        chat: &str,
        _turn: TurnId,
        answer: AnswerId,
        request: &str,
        _: &str,
    ) -> Result<(), ProviderError> {
        if request.starts_with("fixture:hang") {
            return Ok(());
        }
        let outcome = match request {
            "fixture:accept" => AnswerOutcome::Accepted,
            "fixture:fail" => AnswerOutcome::Failed(ProviderError::new(
                ProviderErrorKind::Other,
                "Scripted answer failed",
            )),
            _ => AnswerOutcome::NotWaiting,
        };
        self.events.push_back((
            Instant::now() + Duration::from_millis(80),
            ProviderEvent::AnswerSettled {
                chat: chat.into(),
                answer,
                outcome,
            },
        ));
        Ok(())
    }
    fn answer_question(
        &mut self,
        chat: &str,
        turn: TurnId,
        answer: AnswerId,
        request: &str,
        _: &RawJson,
    ) -> Result<(), ProviderError> {
        self.respond_permission(chat, turn, answer, request, "deny")
    }
    fn close_chat(&mut self, chat: &str, turn: TurnId) -> Result<(), ProviderError> {
        if self.active.get(chat) == Some(&turn) {
            self.active.remove(chat);
        }
        Ok(())
    }
    fn shutdown(&mut self) {
        self.active.clear();
        self.events.clear();
    }
    fn take_events(&mut self) -> Vec<ProviderEvent> {
        let mut ready = Vec::new();
        let now = Instant::now();
        self.events.retain(|(at, event)| {
            if *at > now {
                return true;
            }
            if let ProviderEvent::Agent { chat, turn, event } = event {
                if agent_runs::is_turn_end(&event.0) && self.active.get(chat) == Some(turn) {
                    self.active.remove(chat);
                }
            }
            ready.push(event.clone());
            false
        });
        ready
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn dormant() -> (Actor, Receiver<Request>) {
        let (send, receive) = mpsc::sync_channel(QUEUE);
        let shared = Arc::new(Shared {
            snapshot: Mutex::new(json!({})),
            events: Mutex::new(None),
            bytes: AtomicUsize::new(0),
            closing: AtomicBool::new(false),
            stop: AtomicBool::new(false),
            failure: Mutex::new(None),
            delivery_failed: AtomicBool::new(false),
            forgotten_answers: AtomicU64::new(0),
            stranded_lock_notices: AtomicU64::new(0),
            late_cleanup_refusals: AtomicU64::new(0),
            #[cfg(test)]
            observed_quit: Mutex::new(None),
            #[cfg(test)]
            ready_notices: AtomicUsize::new(0),
            #[cfg(test)]
            parked_events: AtomicUsize::new(0),
            #[cfg(test)]
            observed_ticks: AtomicUsize::new(0),
            #[cfg(test)]
            fail_commits: AtomicBool::new(false),
            #[cfg(test)]
            injected_commits: AtomicUsize::new(0),
            #[cfg(test)]
            stuck_ends: AtomicUsize::new(0),
        });
        (
            Actor {
                send,
                shared,
                thread: Mutex::new(None),
                project: "fixture".into(),
                content: false,
                app_fixture: false,
                configured: false,
                claude_modes: false,
                #[cfg(feature = "chat-runtime")]
                terminals: None,
            },
            receive,
        )
    }
    #[test]
    fn live_permission_capability_is_explicitly_claude_only() {
        let (mut actor, _receive) = dormant();
        assert!(!actor
            .methods()
            .iter()
            .any(|method| method == CLAUDE_METHODS[0]));
        actor.claude_modes = true;
        assert!(actor
            .methods()
            .iter()
            .any(|method| method == CLAUDE_METHODS[0]));
    }
    #[cfg(feature = "chat-runtime")]
    #[test]
    fn unread_patch_is_advertised_only_by_configured_runtime() {
        let (mut actor, _receive) = dormant();
        assert!(!actor.methods().iter().any(|method| method == "chat:patch"));
        actor.configured = true;
        assert!(actor.methods().iter().any(|method| method == "chat:patch"));
    }
    #[test]
    fn admission_never_waits_for_full_or_oversized_queue() {
        let (actor, _receive) = dormant();
        let result = actor.call(Command::Call(
            "large".into(),
            vec![json!("x".repeat(BYTES))],
        ));
        assert_eq!(result.unwrap_err().code, "OWNER_BUSY");
        assert_eq!(actor.shared.bytes.load(Ordering::Acquire), 0);
        for _ in 0..QUEUE {
            let (reply, _) = mpsc::sync_channel(1);
            actor
                .send
                .try_send(Request {
                    command: Command::shutdown(false),
                    reply,
                    bytes: 0,
                })
                .unwrap();
        }
        assert_eq!(
            actor
                .call(Command::Call("bounded".into(), vec![]))
                .unwrap_err()
                .code,
            "OWNER_BUSY"
        );
        assert_eq!(actor.shared.bytes.load(Ordering::Acquire), 0);
    }
    #[test]
    fn forgotten_answer_audit_is_bounded_and_snapshot_visible_without_rpc_work() {
        let (actor, receive) = dormant();
        for _ in 0..10000 {
            record_forgotten_answer(&actor.shared);
        }
        assert_eq!(
            diagnostic_snapshot(&actor.shared).unwrap()["diagnostics"]["rustOwnerAudit"]
                ["answerHistoryForgotten"],
            10000
        );
        assert!(receive.try_recv().is_err());
        actor
            .shared
            .stranded_lock_notices
            .store(2, Ordering::Release);
        let diagnostics =
            diagnostic_snapshot(&actor.shared).unwrap()["diagnostics"]["rustOwnerAudit"].clone();
        assert_eq!(diagnostics["ownerLockStrandedNotices"], 2);
        assert_eq!(diagnostics["ownerLockStranded"], true);
        actor
            .shared
            .forgotten_answers
            .store(u64::MAX - 1, Ordering::Release);
        record_forgotten_answer(&actor.shared);
        record_forgotten_answer(&actor.shared);
        assert_eq!(
            diagnostic_snapshot(&actor.shared).unwrap()["diagnostics"]["rustOwnerAudit"]
                ["answerHistoryForgotten"],
            json!(u64::MAX)
        );
    }
    #[test]
    fn audit_namespace_preserves_diagnostics_and_refuses_type_collisions() {
        let (actor, _receive) = dormant();
        let original = json!({"projects":[],"diagnostics":{"renderer":{"warnings":7},"answerHistoryForgotten":"another service","rustOwnerAudit":{"extension":"retained","ownerLockStranded":false}}});
        *actor.shared.snapshot.lock().unwrap() = original.clone();
        actor
            .shared
            .stranded_lock_notices
            .store(1, Ordering::Release);
        let result = diagnostic_snapshot(&actor.shared).unwrap();
        assert_eq!(
            result["diagnostics"]["renderer"],
            original["diagnostics"]["renderer"]
        );
        assert_eq!(
            result["diagnostics"]["answerHistoryForgotten"],
            "another service"
        );
        assert_eq!(
            result["diagnostics"]["rustOwnerAudit"]["extension"],
            "retained"
        );
        assert_eq!(
            result["diagnostics"]["rustOwnerAudit"]["ownerLockStranded"],
            true
        );
        assert_eq!(
            *actor.shared.snapshot.lock().unwrap(),
            original,
            "snapshot augmentation does not rewrite stored diagnostics"
        );
        for original in [
            json!({"diagnostics":"occupied"}),
            json!({"diagnostics":{"rustOwnerAudit":["occupied"]}}),
        ] {
            *actor.shared.snapshot.lock().unwrap() = original.clone();
            assert_eq!(
                diagnostic_snapshot(&actor.shared).unwrap_err().code,
                "DIAGNOSTIC_SCHEMA_CONFLICT"
            );
            assert_eq!(*actor.shared.snapshot.lock().unwrap(), original);
        }
    }
    #[test]
    fn closing_refuses_mutation_before_queueing() {
        let (actor, receive) = dormant();
        actor.shared.closing.store(true, Ordering::Release);
        assert_eq!(
            actor
                .call(Command::Call("chat:send".into(), vec![]))
                .unwrap_err()
                .code,
            "OWNER_CLOSING"
        );
        assert!(receive.try_recv().is_err());
    }
    #[test]
    fn scripted_provider_has_a_finite_event_budget() {
        let mut provider = Scripted::default();
        for turn in 1..=8 {
            provider
                .start_turn(
                    TurnId(turn),
                    &RawJson(json!({"chatId":format!("fixture#{turn}"),"prompt":"run"})),
                )
                .unwrap();
        }
        assert!(provider
            .start_turn(
                TurnId(9),
                &RawJson(json!({"chatId":"fixture#9","prompt":"run"}))
            )
            .is_err());
        assert!(provider.events.len() <= 64);
    }
    #[cfg(feature = "app-fixture")]
    #[test]
    fn populated_history_is_audited_before_snapshot_admission() {
        let profile = IsolatedProfile::create().unwrap();
        let isolation = Isolation::create(profile.path(), &Policy::system()).unwrap();
        let project = isolation.project(std::path::Path::new("fixture")).unwrap();
        fs::create_dir(project.join(".milagre")).unwrap();
        fs::write(
            project.join(".milagre/coordination.json"),
            crate::app_fixture::generated(&project)["seed"].to_string(),
        )
        .unwrap();
        let mut host = ChatHost::new(ProjectStates::new(isolation, Timing::default(), 1000));
        host.register(Box::new(Scripted::default()));
        host.open_project(&project).unwrap();
        let seq = populate_transcript(&mut host, &project, 1000, Instant::now()).unwrap();
        assert!(seq > 0);
        // Deterministic regression: no actor/timer can drain these on our behalf.
        assert!(host.take_notices().is_empty());
        assert!(host.states.take_events().is_empty());
        let state = host.states.current_whole_state(&project).unwrap().unwrap();
        assert_eq!(state["messages"].as_array().unwrap().len(), 6);
        assert_eq!(state["sessions"]["1"]["summary"]["count"], 4);
        assert_eq!(state["sessions"]["2"]["summary"]["count"], 2);
        host.shutdown(false).unwrap();
    }
}

#[cfg(test)]
mod publication_tests {
    use super::*;
    struct Empty;
    impl Handler for Empty {
        fn methods(&self) -> Vec<String> {
            vec![]
        }
        fn invoke(&self, _: &str, _: &[Value], _: &ClientContext) -> RpcResult {
            Ok(Value::Null)
        }
        fn snapshot(&self, _: &ClientContext) -> RpcResult {
            Ok(Value::Null)
        }
    }
    fn fixture() -> (IsolatedProfile, State, Shared) {
        let profile = IsolatedProfile::create().unwrap();
        let isolation = Isolation::create(profile.path(), &Policy::default()).unwrap();
        let shared = Shared {
            snapshot: Mutex::new(json!({})),
            events: Mutex::new(None),
            bytes: AtomicUsize::new(0),
            closing: AtomicBool::new(false),
            stop: AtomicBool::new(false),
            failure: Mutex::new(None),
            delivery_failed: AtomicBool::new(false),
            forgotten_answers: AtomicU64::new(0),
            stranded_lock_notices: AtomicU64::new(0),
            late_cleanup_refusals: AtomicU64::new(0),
            #[cfg(test)]
            observed_quit: Mutex::new(None),
            #[cfg(test)]
            ready_notices: AtomicUsize::new(0),
            #[cfg(test)]
            parked_events: AtomicUsize::new(0),
            #[cfg(test)]
            observed_ticks: AtomicUsize::new(0),
            #[cfg(test)]
            fail_commits: AtomicBool::new(false),
            #[cfg(test)]
            injected_commits: AtomicUsize::new(0),
            #[cfg(test)]
            stuck_ends: AtomicUsize::new(0),
        };
        let state = State {
            host: ChatHost::new(ProjectStates::new(isolation, Timing::default(), 0)),
            jobs: crate::jobs::Workers::default(),
            provider: "kiro",
            content: None,
            project: profile.path().join("fixture"),
            opened: false,
            version: 0,
            publication_epoch: None,
            last: Value::Null,
            run_seq: 0,
            next_readiness_check: Instant::now(),
            pending: VecDeque::new(),
            project_changed: false,
            answers: HashMap::new(),
            modes: HashMap::new(),
            settled_replies: Vec::new(),
            #[cfg(feature = "app-fixture")]
            bootstrap: None,
            #[cfg(feature = "chat-runtime")]
            configured: None,
            #[cfg(feature = "chat-runtime")]
            terminals: None,
            #[cfg(feature = "chat-runtime")]
            git: None,
            #[cfg(feature = "chat-runtime")]
            routines: None,
            _profile: profile.lease(),
        };
        (profile, state, shared)
    }

    fn shutdown_fixture() -> (
        IsolatedProfile,
        State,
        Shared,
        milagre_owner_store::chat_host::MockProvider,
        TurnId,
    ) {
        let (profile, mut state, shared) = fixture();
        fs::create_dir_all(state.project.join(".milagre")).unwrap();
        fs::write(state.project.join(".milagre/coordination.json"), json!({
            "next_id": 10, "worktrees": { "1": { "id": 1, "name": "main", "path": state.project } },
            "sessions": { "1": { "id": 1, "worktree_id": 1 } }, "messages": []
        }).to_string()).unwrap();
        let provider = milagre_owner_store::chat_host::MockProvider::new("kiro");
        state.host.register(Box::new(provider.clone()));
        state.host.open_project(&state.project).unwrap();
        let sent = state
            .host
            .send(&json!({ "projectPath": state.project, "sessionId": 1,
            "provider": "kiro", "model": "fixture", "body": "synthetic first turn" }))
            .unwrap();
        assert!(state.host.pump().is_empty());
        let chat = format!("{}#1", state.project.display());
        provider.emit(&chat, json!({ "type": "turn-completed" }));
        assert!(state.host.pump().is_empty());
        state.host.states.flush(Some(&state.project)).unwrap();
        state.host.take_notices();
        state.host.states.take_events();
        state.opened = true;
        (profile, state, shared, provider, sent.turn.unwrap())
    }

    #[cfg(feature = "chat-runtime")]
    fn attach_routine_store(profile: &IsolatedProfile, state: &mut State) {
        use std::os::unix::fs::PermissionsExt;
        let manifest = profile.path().join("rust-chat-runtime.json");
        fs::write(
            &manifest,
            json!({"schema":1,"kind":"milagre-rust-chat","root":profile.path(),"fixture":true})
                .to_string(),
        )
        .unwrap();
        fs::set_permissions(&manifest, fs::Permissions::from_mode(0o600)).unwrap();
        state.routines = Some(
            crate::configured_routines::ConfiguredRoutines::open(
                profile.path(),
                state.project.clone(),
                Arc::new(|| Ok(())),
                state.host.states.now(),
            )
            .unwrap(),
        );
    }

    #[cfg(feature = "chat-runtime")]
    fn configured_capacity_fixture() -> (
        IsolatedProfile,
        State,
        Shared,
        milagre_owner_store::chat_host::MockProvider,
    ) {
        let (profile, mut state, shared) = fixture();
        let isolation = state.host.states.isolation().clone();
        let skills = isolation
            .project(std::path::Path::new("capacity-skills"))
            .unwrap();
        let content = crate::claude_content::SharedContent::configured(
            isolation,
            state.project.clone(),
            skills,
            Arc::new(|| Ok(())),
        )
        .unwrap();
        let limit = content.chat_limit().unwrap();
        assert_eq!(limit, 1024);
        let mut sessions = serde_json::Map::new();
        for id in 1..=limit {
            sessions.insert(
                id.to_string(),
                json!({"id":id,"worktree_id":1,"routine":true}),
            );
        }
        sessions
            .get_mut("1")
            .unwrap()
            .as_object_mut()
            .unwrap()
            .shift_remove("routine");
        fs::create_dir_all(state.project.join(".milagre")).unwrap();
        fs::write(state.project.join(".milagre/coordination.json"), json!({
            "next_id":10000,"worktrees":{"1":{"id":1,"name":"main","path":state.project}},
            "sessions":sessions,
            "messages":[{"id":9000,"session_id":1,"role":"user","body":"kept","clientMessageId":"capacity-first"}]
        }).to_string()).unwrap();
        let provider = milagre_owner_store::chat_host::MockProvider::new("kiro");
        state.host.register(Box::new(provider.clone()));
        state.host.open_project(&state.project).unwrap();
        state.host.states.flush(Some(&state.project)).unwrap();
        state.content = Some(content);
        state.opened = true;
        state.open_content().unwrap();
        state.cache(&shared).unwrap();
        (profile, state, shared, provider)
    }

    #[cfg(feature = "chat-runtime")]
    fn capacity_request(state: &State) -> Value {
        json!({"projectPath":state.project,"worktreeId":1,"provider":"kiro","model":"fixture","body":"capacity turn"})
    }

    #[cfg(feature = "chat-runtime")]
    #[test]
    fn configured_content_limit_refuses_new_chats_before_writes_and_reopens() {
        let (_profile, mut state, shared, provider) = configured_capacity_fixture();
        let before = state.host.states.whole_state(&state.project).unwrap();
        let coordination = state.project.join(".milagre/coordination.json");
        let saved = fs::read(&coordination).unwrap();
        let version = state.version;
        for session in [None, Some(Value::Null)] {
            let mut request = capacity_request(&state);
            if let Some(session) = session {
                request["sessionId"] = session;
            }
            let refused = state.call("chat:send", &[request]).unwrap_err();
            assert_eq!(refused.code, "CONTENT_CHAT_LIMIT");
            assert_eq!(
                state.host.states.whole_state(&state.project).unwrap(),
                before
            );
            assert_eq!(fs::read(&coordination).unwrap(), saved);
            assert_eq!(before["next_id"], 10000);
            assert!(provider.state.lock().unwrap().turns.is_empty());
            state.cache(&shared).unwrap();
            assert_eq!(state.version, version);
        }
        for session in [
            json!(0),
            json!(-1),
            json!(10000),
            json!("missing"),
            json!(false),
            json!([]),
            json!({}),
        ] {
            let mut request = capacity_request(&state);
            request["sessionId"] = session;
            let refused = state.call("chat:send", &[request]).unwrap_err();
            assert_eq!(refused.code, "COMMAND_FAILED");
            assert_eq!(refused.message, "That chat is no longer in the project.");
            assert_eq!(
                state.host.states.whole_state(&state.project).unwrap(),
                before
            );
            assert_eq!(fs::read(&coordination).unwrap(), saved);
        }
        let isolation = state.host.states.isolation().clone();
        let project = state.project.clone();
        state.host.shutdown(false).unwrap();
        state.content.take().unwrap().shutdown();
        drop(state);
        let skills = isolation.root().join("capacity-skills");
        let content = crate::claude_content::SharedContent::configured(
            isolation.clone(),
            project.clone(),
            skills,
            Arc::new(|| Ok(())),
        )
        .unwrap();
        let mut reopened = ChatHost::new(ProjectStates::new(isolation, Timing::default(), 0));
        reopened.open_project(&project).unwrap();
        let after = reopened.states.whole_state(&project).unwrap();
        assert_eq!(after, before);
        content.reconcile(after["sessions"].as_object()).unwrap();
        content.opened(true);
        assert_eq!(
            content
                .renderer(
                    "artifact:list",
                    &json!({"chatId":format!("{}#1", project.display())})
                )
                .unwrap(),
            json!([])
        );
        reopened.shutdown(false).unwrap();
        content.shutdown();
    }

    #[cfg(feature = "chat-runtime")]
    #[test]
    fn configured_content_limit_keeps_existing_and_duplicate_sends() {
        let (_profile, mut state, shared, provider) = configured_capacity_fixture();
        state.host.states.update(&state.project, Some(&[]), true, |current| {
            let mut sessions = current.get("sessions").unwrap().clone();
            sessions["2"]["queued"] = json!([{"id":"queued-row","clientMessageId":"capacity-queued","body":"queued"}]);
            Some(current.with_field("sessions", sessions))
        }).unwrap();
        state.host.states.flush(Some(&state.project)).unwrap();
        let before = state.host.states.whole_state(&state.project).unwrap();
        for (id, session) in [("capacity-first", 1), ("capacity-queued", 2)] {
            let mut request = capacity_request(&state);
            request["clientMessageId"] = json!(id);
            assert_eq!(
                state.call("chat:send", &[request]).unwrap(),
                json!({"sessionId":session})
            );
            assert_eq!(
                state.host.states.whole_state(&state.project).unwrap(),
                before
            );
            assert!(provider.state.lock().unwrap().turns.is_empty());
        }
        let mut request = capacity_request(&state);
        request["clientMessageId"] = json!("capacity-queued");
        request["fromQueue"] = json!("queued-row");
        assert_eq!(
            state.call("chat:send", &[request]).unwrap_err().message,
            "That queued message was already sent or removed."
        );
        assert_eq!(
            state.host.states.whole_state(&state.project).unwrap(),
            before
        );
        let mut request = capacity_request(&state);
        request["sessionId"] = json!(1);
        request["clientMessageId"] = json!("capacity-existing");
        assert_eq!(
            state.call("chat:send", &[request]).unwrap(),
            json!({"sessionId":1})
        );
        assert_eq!(provider.state.lock().unwrap().turns.len(), 1);
        assert!(state.host.pump().is_empty());
        provider.emit(
            &format!("{}#1", state.project.display()),
            json!({"type":"turn-completed"}),
        );
        assert!(state.host.pump().is_empty());
        state.cache(&shared).unwrap();
        assert_eq!(state.last["sessions"].as_object().unwrap().len(), 1024);
        assert_eq!(state.last["messages"].as_array().unwrap().len(), 3);
        state.host.shutdown(true).unwrap();
        state.content.take().unwrap().shutdown();
    }

    #[cfg(feature = "chat-runtime")]
    #[test]
    fn configured_content_limit_preserves_the_owner_starter_predicate() {
        let (_profile, mut state, shared, provider) = configured_capacity_fixture();
        for extra in [
            json!({"worktree_id":"1"}),
            json!({"handoverPending":true}),
            json!({"handoverDraft":null}),
            json!({"routine":true}),
            json!({"summary":{"count":1}}),
        ] {
            state
                .host
                .states
                .update(&state.project, Some(&[]), true, |current| {
                    let mut sessions = current.get("sessions").unwrap().clone();
                    let mut candidate = json!({"id":2,"worktree_id":1,"summary":{"count":0}});
                    candidate
                        .as_object_mut()
                        .unwrap()
                        .extend(extra.as_object().unwrap().clone());
                    sessions["2"] = candidate;
                    Some(current.with_field("sessions", sessions))
                })
                .unwrap();
            let before = state.host.states.whole_state(&state.project).unwrap();
            assert_eq!(
                state
                    .call("chat:send", &[capacity_request(&state)])
                    .unwrap_err()
                    .code,
                "CONTENT_CHAT_LIMIT",
                "{extra}"
            );
            assert_eq!(
                state.host.states.whole_state(&state.project).unwrap(),
                before
            );
        }
        state.host.states.update(&state.project, Some(&[]), true, |current| {
            let mut sessions = current.get("sessions").unwrap().clone();
            sessions["2"] = json!({"id":2,"worktree_id":1,"handoverPending":false,"routine":false,"summary":{"count":0}});
            Some(current.with_field("sessions", sessions))
        }).unwrap();
        let mut request = capacity_request(&state);
        request["sessionId"] = Value::Null;
        assert_eq!(
            state.call("chat:send", &[request]).unwrap(),
            json!({"sessionId":2})
        );
        assert_eq!(provider.state.lock().unwrap().turns.len(), 1);
        assert!(state.host.pump().is_empty());
        provider.emit(
            &format!("{}#2", state.project.display()),
            json!({"type":"turn-completed"}),
        );
        assert!(state.host.pump().is_empty());
        state.cache(&shared).unwrap();
        assert_eq!(state.last["sessions"].as_object().unwrap().len(), 1024);
        assert_eq!(
            state.last["next_id"], 10002,
            "only the two message ids were consumed"
        );
        assert_eq!(state.last["messages"].as_array().unwrap().len(), 3);
        state.host.shutdown(true).unwrap();
        state.content.take().unwrap().shutdown();
    }

    #[cfg(feature = "chat-runtime")]
    #[test]
    fn unread_patch_saves_before_publication_and_refuses_invalid_edits() {
        let (profile, mut state, shared, _, _) = shutdown_fixture();
        state.publication_epoch = Some("unread-test".into());
        state.cache(&shared).unwrap();
        let before = state.last.clone();
        let version = state.version;
        let coordination = state.project.join(".milagre/coordination.json");
        let saved = fs::read(&coordination).unwrap();
        for args in [
            vec![],
            vec![json!(state.project), json!(1)],
            vec![
                json!(state.project),
                json!(1),
                json!({"unread":false}),
                Value::Null,
            ],
            vec![
                json!(state.project.with_file_name("foreign")),
                json!(1),
                json!({"unread":false}),
            ],
            vec![json!(state.project), json!(0), json!({"unread":false})],
            vec![json!(state.project), json!(-1), json!({"unread":false})],
            vec![json!(state.project), json!(1.5), json!({"unread":false})],
            vec![
                json!(state.project),
                json!(9_007_199_254_740_992_u64),
                json!({"unread":false}),
            ],
            vec![json!(state.project), json!("1"), json!({"unread":false})],
            vec![json!(state.project), json!(999), json!({"unread":false})],
            vec![json!(state.project), json!(1), json!({})],
            vec![json!(state.project), json!(1), json!({"unread":0})],
            vec![json!(state.project), json!(1), json!({"unread":null})],
            vec![
                json!(state.project),
                json!(1),
                json!({"title":"unsupported"}),
            ],
            vec![
                json!(state.project),
                json!(1),
                json!({"unread":false,"archived":true}),
            ],
        ] {
            assert!(state.patch_unread(&args).is_err(), "{args:?}");
            assert_eq!(
                state.host.states.whole_state(&state.project).unwrap(),
                before
            );
            assert_eq!(fs::read(&coordination).unwrap(), saved);
            assert!(!state.project_changed);
        }
        let args = [json!(state.project), json!(1), json!({"unread":false})];
        assert_eq!(state.patch_unread(&args).unwrap(), Value::Null);
        let mut expected = before;
        expected["sessions"]["1"]
            .as_object_mut()
            .unwrap()
            .shift_remove("unread");
        assert_eq!(
            state.host.states.whole_state(&state.project).unwrap(),
            expected
        );
        let disk: Value = serde_json::from_slice(&fs::read(&coordination).unwrap()).unwrap();
        assert!(disk["sessions"]["1"].get("unread").is_none());
        assert_eq!(state.version, version, "publication has not run yet");
        let server = Server::bind(profile, Arc::new(Empty), Config::default()).unwrap();
        server
            .events()
            .transaction(|publication| state.publish(&shared, publication))
            .unwrap();
        assert_eq!(state.version, version + 1);
        assert_eq!(
            shared.snapshot.lock().unwrap()["projects"][0]["state"],
            expected
        );
        assert!(!state.project_changed);
        assert_eq!(state.patch_unread(&args).unwrap(), Value::Null);
        assert!(
            !state.project_changed,
            "an unchanged read mark needs no new publication"
        );
        state.host.forget(&state.project, false).unwrap();
        assert_eq!(
            state.patch_unread(&args).unwrap_err().code,
            "PROJECT_NOT_READY"
        );
        assert!(!state.host.states.has(&state.project));
        state.host.shutdown(true).unwrap();
        server.shutdown().unwrap();
    }

    #[cfg(feature = "chat-runtime")]
    #[test]
    fn unread_patch_reports_update_and_flush_failures_without_success() {
        let (_profile, mut state, _, _, _) = shutdown_fixture();
        state
            .patch_unread(&[json!(state.project), json!(1), json!({"unread":false})])
            .unwrap();
        state.project_changed = false;
        let before = state.host.states.whole_state(&state.project).unwrap();
        let coordination = state.project.join(".milagre/coordination.json");
        let saved = fs::read(&coordination).unwrap();
        let args = [json!(state.project), json!(1), json!({"unread":true})];
        state
            .host
            .states
            .fail_next_commit("injected unread commit failure");
        assert!(state
            .patch_unread(&args)
            .unwrap_err()
            .message
            .contains("injected unread"));
        assert_eq!(
            state.host.states.whole_state(&state.project).unwrap(),
            before
        );
        assert_eq!(fs::read(&coordination).unwrap(), saved);
        assert!(!state.project_changed);
        let backup = coordination.with_extension("saved");
        fs::rename(&coordination, &backup).unwrap();
        fs::create_dir(&coordination).unwrap();
        assert!(state
            .patch_unread(&args)
            .unwrap_err()
            .message
            .contains("coordination.json"));
        let failed = state.host.states.whole_state(&state.project).unwrap();
        assert_eq!(failed["sessions"]["1"]["unread"], true);
        assert!(failed["persistence"]["error"].is_string());
        assert!(!state.project_changed);
        assert!(state
            .host
            .states
            .take_events()
            .iter()
            .any(|event| matches!(event, Event::SaveFailed { .. })));
        fs::remove_dir(&coordination).unwrap();
        fs::rename(backup, &coordination).unwrap();
        // Retrying the same mark must still flush the retained dirty owner state.
        assert_eq!(state.patch_unread(&args).unwrap(), Value::Null);
        let disk: Value = serde_json::from_slice(&fs::read(&coordination).unwrap()).unwrap();
        assert_eq!(disk["sessions"]["1"]["unread"], true);
        assert!(state
            .host
            .states
            .whole_state(&state.project)
            .unwrap()
            .get("persistence")
            .is_none());
        state.host.shutdown(true).unwrap();
    }

    #[test]
    fn shutdown_alone_drains_forgotten_and_foreign_events_as_refused_diagnostics() {
        let (profile, mut state, shared, provider, turn) = shutdown_fixture();
        let chat = format!("{}#1", state.project.display());
        state
            .call("project:forget", &[json!(state.project)])
            .unwrap();
        state.cache(&shared).unwrap();
        let before = shared.snapshot.lock().unwrap().clone();
        let version = state.version;
        let coordination = state.project.join(".milagre/coordination.json");
        let saved = fs::read(&coordination).unwrap();
        let foreign = state.project.with_file_name("foreign-unopened");
        // No actor thread or timer runs in this test. The shutdown below is the first and only drain of these
        // captured cleanup events, followed by an unrelated refusal whose different message proves all are audited.
        provider.emit_for(
            &chat,
            turn,
            json!({ "type": "subagent-update", "agent": { "id": "child", "status": "completed" } }),
        );
        provider.emit_for(
            &chat,
            turn,
            json!({ "type": "background-tasks", "tasks": [] }),
        );
        provider.push(ProviderEvent::Exited {
            chat,
            turn,
            error: ProviderError::new(ProviderErrorKind::Exited, "captured worker closed"),
        });
        provider.emit_for(
            &format!("{}#999", foreign.display()),
            TurnId(999),
            json!({ "type": "text-delta", "text": "must never be written" }),
        );
        assert_eq!(provider.state.lock().unwrap().events.len(), 4);
        let server = Server::bind(profile, Arc::new(Empty), Config::default()).unwrap();
        let mut refused = false;
        let result = server
            .events()
            .transaction(|publication| state.shutdown(&shared, publication, false, &mut refused));
        assert_eq!(result.unwrap(), Value::Null);
        assert!(!refused);
        assert_eq!(state.host.quit_state(), QuitState::Done);
        assert_eq!(shared.observed_ticks.load(Ordering::Acquire), 0);
        assert!(provider.state.lock().unwrap().events.is_empty());
        assert!(shared
            .failure
            .lock()
            .unwrap()
            .as_deref()
            .unwrap()
            .contains(foreign.to_str().unwrap()));
        assert!(!shared.delivery_failed.load(Ordering::Acquire));
        assert_eq!(*shared.snapshot.lock().unwrap(), before);
        assert_eq!(
            state.version, version,
            "refused events cannot publish state changes"
        );
        assert!(state.pending.is_empty());
        assert_eq!(fs::read(coordination).unwrap(), saved);
        assert!(!state.host.states.has(&state.project));
        assert!(!state.host.is_project_ready(&state.project));
        assert!(!state.project.join(".milagre/runtime.lock").exists());
        assert!(!foreign.exists());
        let rejected = state
            .host
            .deliver(ProviderEvent::Agent {
                chat: format!("{}#1", foreign.display()),
                turn,
                event: RawJson(json!({ "type": "background-tasks", "tasks": [] })),
            })
            .unwrap_err();
        assert_eq!(
            rejected.code(),
            Some("PROJECT_NOT_READY"),
            "deliver remains strict after graceful shutdown"
        );
        server.shutdown().unwrap();
    }

    #[cfg(feature = "chat-runtime")]
    #[test]
    fn configured_content_shutdown_retains_store_until_native_workers_drain() {
        let (profile, mut state, shared, provider, turn) = shutdown_fixture();
        let isolation = state.host.states.isolation().clone();
        let content =
            crate::claude_content::SharedContent::new(isolation.clone(), state.project.clone())
                .unwrap();
        let drained = Arc::new(AtomicBool::new(false));
        let check = drained.clone();
        content.retain_native_drain(Arc::new(move || check.load(Ordering::Acquire)));
        content.opened(true);
        state.content = Some(content.clone());
        let server = Server::bind(profile, Arc::new(Empty), Config::default()).unwrap();
        let mut refused = false;
        let pending = server
            .events()
            .transaction(|publication| state.shutdown(&shared, publication, false, &mut refused))
            .unwrap_err();
        assert_eq!(pending.code, "QUIT_PENDING");
        assert!(!refused, "a pending close cannot reopen actor admission");
        assert_eq!(
            state.host.quit_state(),
            QuitState::Done,
            "owner completion alone is not the native drain barrier"
        );
        assert!(
            crate::claude_content::SharedContent::new(isolation.clone(), state.project.clone())
                .is_err(),
            "the one content writer remains retained"
        );
        // The native worker has not drained yet and can still report its captured
        // cleanup events after owner Done. They remain refused and audited, with
        // neither reopening nor an erroneous active-transition failure.
        let saved = fs::read(state.project.join(".milagre/coordination.json")).unwrap();
        let chat = format!("{}#1", state.project.display());
        provider.emit_for(&chat, turn, json!({"type":"background-tasks","tasks":[]}));
        provider.push(ProviderEvent::Exited {
            chat,
            turn,
            error: ProviderError::new(ProviderErrorKind::Exited, "closed worker"),
        });
        state.tick(state.host.states.now(), &shared).unwrap();
        assert_eq!(shared.late_cleanup_refusals.load(Ordering::Acquire), 2);
        assert!(shared.failure.lock().unwrap().is_none());
        assert!(!state.host.states.has(&state.project));
        assert!(!state.host.is_project_ready(&state.project));
        assert!(!state.project.join(".milagre/runtime.lock").exists());
        assert_eq!(
            fs::read(state.project.join(".milagre/coordination.json")).unwrap(),
            saved
        );
        let foreign = milagre_owner_store::StoreError::ProjectNotReady(
            "/foreign isn't open and ready here; nothing was saved or started.".into(),
        );
        assert!(!state.audit_cleanup_refusal(&shared, &foreign));
        let failed = milagre_owner_store::StoreError::Invalid("real failure".into());
        assert!(!state.audit_cleanup_refusal(&shared, &failed));
        drained.store(true, Ordering::Release);
        assert_eq!(
            server
                .events()
                .transaction(|publication| state.shutdown(
                    &shared,
                    publication,
                    false,
                    &mut refused
                ))
                .unwrap(),
            Value::Null
        );
        let replacement =
            crate::claude_content::SharedContent::new(isolation, state.project.clone()).unwrap();
        replacement.shutdown();
        server.shutdown().unwrap();
    }

    #[test]
    fn shutdown_pump_diagnostics_cannot_hide_actual_save_failure_or_release_its_lock() {
        let (profile, mut state, shared, provider, turn) = shutdown_fixture();
        #[cfg(feature = "chat-runtime")]
        attach_routine_store(&profile, &mut state);
        state
            .host
            .states
            .update(&state.project, Some(&[]), true, |current| {
                Some(current.with_field("unsaved", json!(true)))
            })
            .unwrap();
        let coordination = state.project.join(".milagre/coordination.json");
        let saved = coordination.with_extension("saved");
        fs::rename(&coordination, &saved).unwrap();
        fs::create_dir(&coordination).unwrap();
        provider.emit_for(
            &format!(
                "{}#1",
                state.project.with_file_name("foreign-unopened").display()
            ),
            turn,
            json!({ "type": "background-tasks", "tasks": [] }),
        );
        let server = Server::bind(profile, Arc::new(Empty), Config::default()).unwrap();
        let mut refused = false;
        let error = server
            .events()
            .transaction(|publication| state.shutdown(&shared, publication, false, &mut refused))
            .unwrap_err();
        assert_ne!(
            error.code, "PROJECT_NOT_READY",
            "a refused provider event must not replace the save failure"
        );
        assert!(error.message.contains("coordination.json"), "{error:?}");
        assert_eq!(state.host.quit_state(), QuitState::ClosePending);
        assert!(!refused);
        assert!(!shared.delivery_failed.load(Ordering::Acquire));
        assert!(state.project.join(".milagre/runtime.lock").exists());
        assert!(state.host.states.has(&state.project));
        // Restore only this fixture's injected failure for disposal; the tested shutdown above failed once.
        fs::remove_dir(&coordination).unwrap();
        fs::rename(saved, coordination).unwrap();
        #[cfg(feature = "chat-runtime")]
        {
            let whole = state
                .host
                .states
                .current(&state.project)
                .unwrap()
                .to_value();
            assert_eq!(
                state
                    .routines
                    .as_mut()
                    .unwrap()
                    .invoke("routines:list", &[], &whole, state.host.states.now())
                    .unwrap_err()
                    .code,
                "ROUTINE_STORE_CLOSED"
            );
            assert!(
                state.call("project:open", &[json!(state.project)]).is_err(),
                "a closing host does not reopen normal admission"
            );
            server
                .events()
                .transaction(|publication| state.shutdown(&shared, publication, true, &mut refused))
                .unwrap();
        }
        state.host.shutdown(true).unwrap();
        server.shutdown().unwrap();
    }

    #[test]
    fn shutdown_pump_diagnostics_do_not_bypass_a_persistently_stuck_turn() {
        let (profile, mut state, shared, provider, _) = shutdown_fixture();
        #[cfg(feature = "chat-runtime")]
        attach_routine_store(&profile, &mut state);
        let chat = format!("{}#1", state.project.display());
        provider.emit(
            &chat,
            json!({ "type": "session-started", "nativeId": "synthetic-native" }),
        );
        assert!(state.host.pump().is_empty());
        let turn = state
            .host
            .send(&json!({ "projectPath": state.project, "sessionId": 1,
            "provider": "kiro", "model": "fixture", "body": "synthetic active turn" }))
            .unwrap()
            .turn
            .unwrap();
        assert!(state.host.pump().is_empty());
        state
            .host
            .states
            .set_commit_failure_for_tests(Some("persistent synthetic fold failure"));
        provider.emit_for(&chat, turn, json!({ "type": "turn-completed" }));
        let server = Server::bind(profile, Arc::new(Empty), Config::default()).unwrap();
        let mut refused = false;
        let error = server
            .events()
            .transaction(|publication| state.shutdown(&shared, publication, false, &mut refused))
            .unwrap_err();
        assert!(
            error.message.contains("Quitting while a turn runs"),
            "{error:?}"
        );
        assert!(refused);
        assert_eq!(state.host.quit_state(), QuitState::Running);
        assert_eq!(state.host.active_turn(&chat), Some(turn));
        assert_eq!(state.host.stuck_ends(), [chat]);
        assert!(state.project.join(".milagre/runtime.lock").exists());
        assert!(shared
            .failure
            .lock()
            .unwrap()
            .as_deref()
            .unwrap()
            .contains("persistent synthetic fold failure"));
        assert!(!shared.delivery_failed.load(Ordering::Acquire));
        #[cfg(feature = "chat-runtime")]
        {
            let whole = state
                .host
                .states
                .current(&state.project)
                .unwrap()
                .to_value();
            assert_eq!(
                state
                    .routines
                    .as_mut()
                    .unwrap()
                    .invoke("routines:list", &[], &whole, state.host.states.now())
                    .unwrap_err()
                    .code,
                "ROUTINE_STORE_CLOSED"
            );
            state.call("project:open", &[json!(state.project)]).unwrap();
            assert_eq!(
                state
                    .routines
                    .as_mut()
                    .unwrap()
                    .invoke("routines:list", &[], &whole, state.host.states.now())
                    .unwrap()
                    .0,
                json!({"routines":[]})
            );
        }
        state.host.states.set_commit_failure_for_tests(None);
        state.host.shutdown(true).unwrap();
        server.shutdown().unwrap();
    }

    #[test]
    fn idle_unload_keeps_whole_client_cache_without_reloading_owner_messages() {
        let (_profile, mut state, shared) = fixture();
        fs::create_dir(&state.project).unwrap();
        fs::create_dir(state.project.join(".milagre")).unwrap();
        fs::write(
            state.project.join(".milagre/coordination.json"),
            json!({"next_id":3,"sessions":{"1":{"id":1}},"worktrees":{},"messages":[
                {"id":1,"session_id":1,"role":"user","body":"Keep this transcript"},
                {"id":2,"session_id":1,"role":"assistant","body":"Saved reply","outcome":"completed"}
            ]}).to_string(),
        ).unwrap();
        state.host.open_project(&state.project).unwrap();
        // A kept change settles legacy coordination messages into chats.db;
        // unloading refuses messages that have not been saved there yet.
        state
            .host
            .states
            .update(&state.project, None, true, |current| {
                Some(current.with_field("saved", json!(true)))
            })
            .unwrap();
        state.host.states.flush(Some(&state.project)).unwrap();
        state.opened = true;
        state.cache(&shared).unwrap();
        let before = state.last.clone();
        let version = state.version;
        assert_eq!(before["messages"].as_array().unwrap().len(), 2);
        assert!(state.host.tick(10 * 60 * 1000 + 1).is_empty());
        let unloaded = state.host.states.current(&state.project).unwrap();
        assert!(unloaded.message_list().is_empty());
        assert!(unloaded.unloaded.contains(&1));
        assert!(state
            .host
            .states
            .take_events()
            .iter()
            .any(|event| matches!(event, Event::Unloaded { .. })));
        state.cache(&shared).unwrap();
        assert_eq!(state.last, before);
        assert_eq!(
            shared.snapshot.lock().unwrap()["projects"][0]["state"],
            before
        );
        assert_eq!(
            state.version, version,
            "storage unloading is not a visible content change"
        );
        assert!(
            state
                .host
                .states
                .current(&state.project)
                .unwrap()
                .message_list()
                .is_empty(),
            "publication must not reload or touch the owner Chat"
        );
        state.host.shutdown(true).unwrap();
    }

    #[test]
    fn failed_publication_retains_unsent_events_and_closes_admission() {
        let (profile, mut state, shared) = fixture();
        let (pending_mode, pending_mode_result) = mpsc::sync_channel(1);
        state.modes.insert(ModeChangeId(1), pending_mode);
        let (settled_mode, settled_mode_result) = mpsc::sync_channel(1);
        state.settled_replies.push((settled_mode, Ok(Value::Null)));
        state.pending.push_back((
            "agent:event".into(),
            json!({"seq":7,"event":{"type":"text","text":"published"}}),
        ));
        state.pending.push_back((
            "agent:event".into(),
            json!({"seq":9,"text":"x".repeat(8192)}),
        ));
        state
            .pending
            .push_back(("agent:event".into(), json!({"type":"turn-completed"})));
        let server = Server::bind(
            profile,
            Arc::new(Empty),
            Config {
                max_frame_bytes: 4096,
                ..Config::default()
            },
        )
        .unwrap();
        let failed = server
            .events()
            .transaction(|publication| state.publish_or_latch(&shared, publication))
            .unwrap_err();
        assert_eq!(failed.code, "FRAME_TOO_LARGE");
        for result in [&pending_mode_result, &settled_mode_result] {
            assert_eq!(
                result.try_recv().unwrap().unwrap_err().code,
                "OWNER_EVENT_FAILED"
            );
            assert!(matches!(
                result.try_recv(),
                Err(mpsc::TryRecvError::Disconnected)
            ));
        }
        assert!(state.modes.is_empty());
        assert!(state.settled_replies.is_empty());
        assert_eq!(
            state.run_seq, 7,
            "failed and unsent events do not advance the watermark"
        );
        assert_eq!(shared.snapshot.lock().unwrap()["runs"]["seq"], 7);
        assert_eq!(state.pending.len(), 2);
        assert!(shared.closing.load(Ordering::Acquire));
        assert!(shared.delivery_failed.load(Ordering::Acquire));
        assert_eq!(
            server
                .events()
                .transaction(|publication| state.publish_or_latch(&shared, publication))
                .unwrap_err()
                .code,
            "OWNER_EVENT_FAILED"
        );
        assert_eq!(state.pending.len(), 2);
        server.shutdown().unwrap();
    }
}

#[cfg(test)]
mod job_tests {
    use super::*;
    use milagre_owner_store::{
        handover::{Clock, Zone},
        transcripts::TranscriptSource,
    };
    use std::sync::Condvar;

    fn prepare(host: &mut ChatHost, project: &std::path::Path, count: u64) {
        let state = host.states.whole_state(project).unwrap();
        for session in 1..=count {
            host.test_prepare_transcript(
                project,
                &format!("{}#{session}", project.display()),
                TranscriptSource {
                    state: (&state).into(),
                    session,
                    before: None,
                    provider: Some("kiro"),
                    catch_up_after: None,
                    changed: None,
                    clock: Clock {
                        zone: Zone::Utc,
                        now_ms: 0.0,
                    },
                },
            )
            .unwrap();
        }
    }
    fn seeded() -> (IsolatedProfile, PathBuf, ChatHost) {
        let (profile, project, mut host) = seeded_unopened();
        host.open_project(&project).unwrap();
        (profile, project, host)
    }
    fn seeded_unopened() -> (IsolatedProfile, PathBuf, ChatHost) {
        let profile = IsolatedProfile::create().unwrap();
        let isolation = Isolation::create(profile.path(), &Policy::default()).unwrap();
        let project = isolation.project(std::path::Path::new("fixture")).unwrap();
        fs::create_dir(project.join(".milagre")).unwrap();
        let mut sessions = serde_json::Map::new();
        for id in 1..=5 {
            sessions.insert(
                id.to_string(),
                json!({"id":id,"worktree_id":1,"title":"Jobs","provider":"kiro"}),
            );
        }
        fs::write(project.join(".milagre/coordination.json"), json!({"next_id":10,"worktrees":{"1":{"id":1,"path":project}},"sessions":sessions,"messages":[{"id":1,"session_id":1,"role":"user","body":"Transcript input"},{"id":2,"session_id":1,"role":"assistant","body":"Prior reply","outcome":"completed"}]}).to_string()).unwrap();
        let host = ChatHost::new(ProjectStates::new(isolation, Timing::default(), 0));
        (profile, project, host)
    }
    struct Gate {
        released: Mutex<bool>,
        signal: Condvar,
    }
    impl Gate {
        fn release(&self) {
            *self.released.lock().unwrap() = true;
            self.signal.notify_all();
        }
    }
    struct ReleaseOnDrop(Arc<Gate>);
    impl Drop for ReleaseOnDrop {
        fn drop(&mut self) {
            self.0.release();
        }
    }
    fn workers(mode: u8) -> (crate::jobs::Workers, Arc<Gate>, Receiver<()>) {
        let gate = Arc::new(Gate {
            released: Mutex::new(false),
            signal: Condvar::new(),
        });
        let held = gate.clone();
        let (entered, receive) = mpsc::sync_channel(4);
        let mut worker = crate::jobs::Workers::default();
        worker.before_run = Some(Arc::new(move || {
            entered.send(()).unwrap();
            let mut released = held.released.lock().unwrap();
            while !*released {
                released = held.signal.wait(released).unwrap();
            }
            drop(released);
            if mode == 1 {
                panic!("fixture transcript worker panic");
            }
            mode != 2
        }));
        (worker, gate, receive)
    }
    #[test]
    fn forced_forget_retains_project_until_each_job_returns_including_panic_and_drop() {
        for mode in 0..=2 {
            let (_profile, project, mut host) = seeded();
            prepare(&mut host, &project, 1);
            let (mut workers, gate, entered) = workers(mode);
            let _release = ReleaseOnDrop(gate.clone());
            workers.drive(&mut host);
            entered.recv_timeout(Duration::from_secs(2)).unwrap();
            assert_eq!(
                host.forget(&project, true).unwrap_err().code(),
                Some("QUIT_PENDING")
            );
            assert!(project.join(".milagre/runtime.lock").exists());
            assert!(host.states.current(&project).is_some());
            assert!(host.pump().is_empty());
            gate.release();
            workers.join();
            assert!(host.pump().is_empty());
            host.forget(&project, true).unwrap();
            assert!(!project.join(".milagre/runtime.lock").exists());
            assert!(host.take_jobs().is_empty());
            host.shutdown(true).unwrap();
        }
    }
    fn running(
        profile: IsolatedProfile,
        project: &std::path::Path,
        host: ChatHost,
        workers: crate::jobs::Workers,
    ) -> (Arc<Server>, Arc<Actor>) {
        running_content(profile, project, host, workers, None)
    }
    fn running_content(
        profile: IsolatedProfile,
        project: &std::path::Path,
        host: ChatHost,
        workers: crate::jobs::Workers,
        content: Option<Arc<crate::claude_content::SharedContent>>,
    ) -> (Arc<Server>, Arc<Actor>) {
        let opened = host.is_project_ready(project);
        if let Some(content) = &content {
            content.opened(opened);
        }
        let shared = Arc::new(Shared {
            snapshot: Mutex::new(json!({})),
            events: Mutex::new(None),
            bytes: AtomicUsize::new(0),
            closing: AtomicBool::new(false),
            stop: AtomicBool::new(false),
            failure: Mutex::new(None),
            delivery_failed: AtomicBool::new(false),
            forgotten_answers: AtomicU64::new(0),
            stranded_lock_notices: AtomicU64::new(0),
            late_cleanup_refusals: AtomicU64::new(0),
            #[cfg(test)]
            observed_quit: Mutex::new(None),
            #[cfg(test)]
            ready_notices: AtomicUsize::new(0),
            #[cfg(test)]
            parked_events: AtomicUsize::new(0),
            #[cfg(test)]
            observed_ticks: AtomicUsize::new(0),
            #[cfg(test)]
            fail_commits: AtomicBool::new(false),
            #[cfg(test)]
            injected_commits: AtomicUsize::new(0),
            #[cfg(test)]
            stuck_ends: AtomicUsize::new(0),
        });
        let (send, requests) = mpsc::sync_channel(QUEUE);
        let actor = Arc::new(Actor {
            send,
            shared: shared.clone(),
            thread: Mutex::new(None),
            project: project.to_string_lossy().into(),
            content: content.is_some(),
            app_fixture: false,
            configured: false,
            claude_modes: false,
            #[cfg(feature = "chat-runtime")]
            terminals: None,
        });
        let profile_lease = profile.lease();
        let mut state = State {
            host,
            jobs: workers,
            provider: "kiro",
            content,
            project: project.to_path_buf(),
            opened,
            version: 0,
            publication_epoch: None,
            last: Value::Null,
            run_seq: 0,
            next_readiness_check: Instant::now(),
            pending: VecDeque::new(),
            project_changed: false,
            answers: HashMap::new(),
            modes: HashMap::new(),
            settled_replies: vec![],
            #[cfg(feature = "app-fixture")]
            bootstrap: None,
            #[cfg(feature = "chat-runtime")]
            configured: None,
            #[cfg(feature = "chat-runtime")]
            terminals: None,
            #[cfg(feature = "chat-runtime")]
            git: None,
            #[cfg(feature = "chat-runtime")]
            routines: None,
            _profile: profile_lease,
        };
        state.cache(&shared).unwrap();
        let server = Arc::new(Server::bind(profile, actor.clone(), Config::default()).unwrap());
        *shared.events.lock().unwrap() = Some(server.events());
        *actor.thread.lock().unwrap() = Some(thread::spawn(move || {
            run(state, shared, requests, Instant::now(), 0)
        }));
        (server, actor)
    }
    #[test]
    fn quit_keeps_socket_profile_and_locks_until_four_workers_are_joined() {
        let (profile, project, mut host) = seeded();
        prepare(&mut host, &project, 4);
        let state = host.states.whole_state(&project).unwrap();
        assert_eq!(
            host.test_prepare_transcript(
                &project,
                &format!("{}#5", project.display()),
                TranscriptSource {
                    state: (&state).into(),
                    session: 5,
                    before: None,
                    provider: None,
                    catch_up_after: None,
                    changed: None,
                    clock: Clock {
                        zone: Zone::Utc,
                        now_ms: 0.0
                    },
                }
            )
            .unwrap_err()
            .code(),
            Some("TRANSCRIPTS_AT_CAPACITY")
        );
        let (workers, gate, entered) = workers(0);
        let (server, actor) = running(profile, &project, host, workers);
        let _release = ReleaseOnDrop(gate.clone());
        for _ in 0..4 {
            entered.recv_timeout(Duration::from_secs(2)).unwrap();
        }
        // Ordinary busy quit refuses; only this explicit test force cancels staging.
        assert!(server.shutdown().is_err());
        assert_eq!(
            actor.call(Command::shutdown(true)).unwrap_err().code,
            "QUIT_PENDING"
        );
        for _ in 0..2 {
            assert_eq!(
                shutdown_pending(&server, Duration::from_millis(30))
                    .unwrap_err()
                    .code,
                "QUIT_PENDING"
            );
            assert!(!server.is_stopped());
            assert!(server.socket_path().exists());
            assert!(server.profile_path().exists());
            assert!(project.join(".milagre/runtime.lock").exists());
        }
        let node = std::process::Command::new("node")
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/jobs-stop-compat.cjs"
            ))
            .arg(server.profile_path())
            .arg(&project)
            .output()
            .unwrap();
        assert!(
            node.status.success(),
            "{}",
            String::from_utf8_lossy(&node.stderr)
        );
        assert!(String::from_utf8_lossy(&node.stdout).contains("conformance passed"));
        gate.release();
        shutdown_pending(&server, Duration::from_secs(3)).unwrap();
        assert!(server.is_stopped());
        assert!(!project.join(".milagre/runtime.lock").exists());
        server.shutdown().unwrap();
        drop(actor);
        Server::finish(server).unwrap();
    }

    #[test]
    fn preparing_quit_refusal_reopens_commands_then_explicit_stop_can_finish() {
        let (profile, project, mut host) = seeded();
        prepare(&mut host, &project, 1);
        let (workers, gate, entered) = workers(0);
        let (server, actor) = running(profile, &project, host, workers);
        let _release = ReleaseOnDrop(gate.clone());
        entered.recv_timeout(Duration::from_secs(2)).unwrap();
        let error = shutdown_pending(&server, Duration::from_millis(30)).unwrap_err();
        assert!(error.message.contains("turn runs"));
        assert!(!actor.shared.closing.load(Ordering::Acquire));
        assert!(actor
            .call(Command::Call("project:current".into(), vec![]))
            .is_ok());
        let node = std::process::Command::new("node")
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/jobs-stop-compat.cjs"
            ))
            .arg(server.profile_path())
            .arg(&project)
            .arg("refused")
            .output()
            .unwrap();
        assert!(
            node.status.success(),
            "{}",
            String::from_utf8_lossy(&node.stderr)
        );
        assert!(
            actor.shared.closing.load(Ordering::Acquire),
            "interrupt then pending quit stays closed"
        );
        assert_eq!(
            actor
                .call(Command::Call("project:current".into(), vec![]))
                .unwrap_err()
                .code,
            "OWNER_CLOSING"
        );
        gate.release();
        shutdown_pending(&server, Duration::from_secs(3)).unwrap();
        assert!(server.is_stopped());
        drop(actor);
        Server::finish(server).unwrap();
    }

    #[test]
    fn real_restore_send_is_cancelled_by_fixture_quit_without_start_or_replay() {
        use milagre_owner_store::chat_host::{HandoffMode, MockProvider};
        let (profile, project, mut host) = seeded();
        assert_eq!(host.handoff_mode(), HandoffMode::Gated);
        host.enable_restore_for_tests().unwrap(); // Opt-in only in this cfg(test) fixture.
        let provider = MockProvider::new("kiro");
        host.register(Box::new(provider.clone()));
        let (workers, gate, entered) = workers(0);
        let (server, actor) = running(profile, &project, host, workers);
        let _release = ReleaseOnDrop(gate.clone());
        let node = std::process::Command::new("node")
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/jobs-stop-compat.cjs"
            ))
            .arg(server.profile_path())
            .arg(&project)
            .arg("restore")
            .output()
            .unwrap();
        assert!(
            node.status.success(),
            "{}",
            String::from_utf8_lossy(&node.stderr)
        );
        entered.recv_timeout(Duration::from_secs(2)).unwrap();
        let snapshot = actor.shared.snapshot.lock().unwrap().clone();
        assert!(snapshot["runs"]["runs"]
            .get(format!("{}#1", project.display()))
            .is_none());
        let messages = snapshot["projects"][0]["state"]["messages"]
            .as_array()
            .unwrap();
        assert_eq!(
            messages
                .iter()
                .filter(|message| message["clientMessageId"] == "restore-stop")
                .count(),
            1
        );
        let divider = messages
            .iter()
            .find(|message| message["context"]["kind"] == "handoff")
            .unwrap();
        assert_eq!(divider["context"]["status"], "failed");
        assert!(
            provider.state.lock().unwrap().turns.is_empty(),
            "no native turn started while transcript was held"
        );
        assert!(!server.is_stopped());
        gate.release();
        shutdown_pending(&server, Duration::from_secs(3)).unwrap();
        assert!(
            provider.state.lock().unwrap().turns.is_empty(),
            "late transcript result cannot start or replay the cancelled restore"
        );
        assert!(
            provider.state.lock().unwrap().closed.is_empty(),
            "never-started restore has no native session to close"
        );
        assert!(server.is_stopped());
        assert_eq!(
            *actor.shared.observed_quit.lock().unwrap(),
            Some(QuitState::Done)
        );
        assert_eq!(
            actor.shared.stranded_lock_notices.load(Ordering::Acquire),
            0
        );
        let handovers = server.profile_path().join(".owner/handovers");
        assert!(
            handovers.is_dir(),
            "the real restore acquired its handover store"
        );
        let mut folders = vec![handovers];
        while let Some(folder) = folders.pop() {
            for entry in fs::read_dir(folder).unwrap() {
                let entry = entry.unwrap();
                if entry.file_type().unwrap().is_dir() {
                    folders.push(entry.path());
                } else {
                    let name = entry.file_name();
                    let name = name.to_string_lossy();
                    assert!(
                        !name.ends_with(".tmp"),
                        "cancelled job left temporary transcript {name}"
                    );
                    assert!(
                        !name.ends_with(".md"),
                        "cancelled job committed a session transcript {name}"
                    );
                }
            }
        }
        use milagre_owner_store::{ProjectRepository, ProjectStore};
        let saved = ProjectStore::new(project.clone())
            .read_project_state()
            .unwrap()
            .state;
        let messages = saved["messages"].as_array().unwrap();
        assert_eq!(
            messages
                .iter()
                .filter(|message| message["clientMessageId"] == "restore-stop")
                .count(),
            1
        );
        assert_eq!(
            messages
                .iter()
                .find(|message| message["context"]["kind"] == "handoff")
                .unwrap()["context"]["status"],
            "failed"
        );
        drop(actor);
        Server::finish(server).unwrap();
    }

    fn node_readiness(server: &Server, project: &std::path::Path, mode: &str) {
        let node = std::process::Command::new("node")
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/readiness-compat.cjs"
            ))
            .arg(server.profile_path())
            .arg(project)
            .arg(mode)
            .output()
            .unwrap();
        assert!(
            node.status.success(),
            "{}",
            String::from_utf8_lossy(&node.stderr)
        );
        assert!(String::from_utf8_lossy(&node.stdout).contains("Readiness conformance passed"));
    }
    #[test]
    fn node_open_busy_keeps_partial_state_private_until_explicit_durable_retry() {
        use milagre_owner_store::transcripts::TranscriptJobs;
        let (profile, project, host) = seeded_unopened();
        let file = project.join(".milagre/coordination.json");
        let mut state: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        state["sessions"]["1"]["handoverPending"] = json!(true);
        state["messages"].as_array_mut().unwrap().push(json!({"id":3,"session_id":1,"role":"assistant","body":"","context":{"kind":"handoff","status":"preparing","from":{"provider":"kiro"},"to":{"provider":"kiro"}}}));
        fs::write(&file, state.to_string()).unwrap();
        let held = TranscriptJobs::new(host.states.isolation()).unwrap();
        let (server, actor) = running(profile, &project, host, Default::default());
        node_readiness(&server, &project, "busy");
        assert_eq!(actor.shared.ready_notices.load(Ordering::Acquire), 0);
        for method in ["project:snapshot", "state:read"] {
            assert_eq!(
                actor
                    .call(Command::Call(method.into(), vec![json!(project)]))
                    .unwrap_err()
                    .code,
                "PROJECT_NOT_READY"
            );
        }
        assert_eq!(actor.call(Command::Call("chat:send".into(),vec![json!({"projectPath":project,"sessionId":1,"provider":"kiro","body":"refused"})])).unwrap_err().code,"PROJECT_NOT_READY");
        let chat = format!("{}#1", project.display());
        for (method, args) in [
            ("chat:queue-send", vec![json!(chat), json!("missing")]),
            ("chat:queue-remove", vec![json!(chat), json!("missing")]),
            (
                "agent:respond-permission",
                vec![json!({"chatId":chat,"requestId":"missing","decision":"deny"})],
            ),
            (
                "agent:answer-question",
                vec![json!({"chatId":chat,"requestId":"missing","answers":{}})],
            ),
        ] {
            assert_eq!(
                actor
                    .call(Command::Call(method.into(), args))
                    .unwrap_err()
                    .code,
                "PROJECT_NOT_READY",
                "{method}"
            );
        }
        assert_eq!(
            actor
                .call(Command::Call("agent:interrupt".into(), vec![json!(chat)]))
                .unwrap(),
            Value::Null,
            "trusted idle Stop remains available without reopening"
        );
        drop(held);
        node_readiness(&server, &project, "recover");
        assert_eq!(
            actor.shared.ready_notices.load(Ordering::Acquire),
            1,
            "repeated ready open is silent"
        );
        server.shutdown().unwrap();
        drop(actor);
        Server::finish(server).unwrap();
    }

    #[test]
    fn failed_recovery_save_exposes_no_partial_project_or_content_until_retry() {
        let (profile, project, mut host) = seeded_unopened();
        let file = project.join(".milagre/coordination.json");
        let backup = project.join(".milagre/coordination.fixture-backup");
        let mut state: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        state["sessions"]["1"]["handoverPending"] = json!(true);
        state["messages"].as_array_mut().unwrap().push(json!({"id":3,"session_id":1,"role":"assistant","body":"","context":{"kind":"handoff","status":"preparing","from":{"provider":"kiro"},"to":{"provider":"kiro"}}}));
        fs::write(&file, state.to_string()).unwrap();
        // Deliberate preloaded state is not a ready bypass. Break only the final
        // coordination rename so recovery can change memory before its flush fails.
        host.states.get(&project).unwrap();
        assert!(!host.is_project_ready(&project));
        let content = crate::claude_content::SharedContent::new(
            host.states.isolation().clone(),
            project.clone(),
        )
        .unwrap();
        fs::rename(&file, &backup).unwrap();
        fs::create_dir(&file).unwrap();
        let (server, actor) = running_content(
            profile,
            &project,
            host,
            Default::default(),
            Some(content.clone()),
        );
        node_readiness(&server, &project, "save-failed");
        assert_eq!(actor.shared.ready_notices.load(Ordering::Acquire), 0);
        assert_eq!(actor.shared.snapshot.lock().unwrap()["projects"], json!([]));
        assert!(content
            .renderer(
                "artifact:list",
                &json!({"chatId":format!("{}#1",project.display())})
            )
            .is_err());
        fs::remove_dir(&file).unwrap();
        fs::rename(&backup, &file).unwrap();
        assert_eq!(
            actor
                .call(Command::Call("project:current".into(), vec![]))
                .unwrap_err()
                .code,
            "PROJECT_NOT_READY"
        );
        node_readiness(&server, &project, "recover");
        assert_eq!(actor.shared.ready_notices.load(Ordering::Acquire), 1);
        server.shutdown().unwrap();
        drop(actor);
        Server::finish(server).unwrap();
    }
    #[test]
    fn failed_ready_store_check_revokes_content_and_retained_grants_until_explicit_open() {
        let (profile, project, host) = seeded();
        let store = profile.path().join(".owner/handovers");
        let held = profile.path().join(".owner/held-handovers");
        let content = crate::claude_content::SharedContent::new(
            host.states.isolation().clone(),
            project.clone(),
        )
        .unwrap();
        let (server, actor) = running_content(
            profile,
            &project,
            host,
            Default::default(),
            Some(content.clone()),
        );
        actor
            .call(Command::Call("project:current".into(), vec![]))
            .unwrap();
        let chat = format!("{}#1", project.display());
        let retained = content.dispatcher(&chat).unwrap();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        assert_eq!(
            rt.block_on(retained.call("artifact_list", &json!({})))["isError"],
            false
        );
        fs::rename(&store, &held).unwrap();
        fs::create_dir(&store).unwrap();
        let refused = actor
            .call(Command::Call(
                "project:snapshot".into(),
                vec![json!(project)],
            ))
            .unwrap_err();
        assert!(
            matches!(
                refused.code.as_str(),
                "COMMAND_FAILED" | "PROJECT_NOT_READY"
            ),
            "a tick may detect ownership loss before the command"
        );
        assert_eq!(
            actor
                .call(Command::Call("project:current".into(), vec![]))
                .unwrap_err()
                .code,
            "PROJECT_NOT_READY"
        );
        assert_eq!(actor.shared.snapshot.lock().unwrap()["projects"], json!([]));
        assert_eq!(
            rt.block_on(retained.call("artifact_list", &json!({})))["isError"],
            true
        );
        assert!(content
            .renderer("artifact:list", &json!({"chatId":chat}))
            .is_err());
        fs::remove_dir(&store).unwrap();
        fs::rename(&held, &store).unwrap();
        assert_eq!(
            actor
                .call(Command::Call("state:read".into(), vec![json!(project)]))
                .unwrap_err()
                .code,
            "PROJECT_NOT_READY",
            "restoring the folder is not a retry"
        );
        actor
            .call(Command::Call("project:open".into(), vec![json!(project)]))
            .unwrap();
        assert_eq!(actor.shared.ready_notices.load(Ordering::Acquire), 2);
        assert_eq!(
            rt.block_on(retained.call("artifact_list", &json!({})))["isError"],
            true,
            "old generation never revives"
        );
        assert_eq!(
            rt.block_on(
                content
                    .dispatcher(&chat)
                    .unwrap()
                    .call("artifact_list", &json!({}))
            )["isError"],
            false
        );
        assert_eq!(
            content
                .renderer("artifact:list", &json!({"chatId":chat}))
                .unwrap(),
            json!([])
        );
        server.shutdown().unwrap();
        drop(actor);
        Server::finish(server).unwrap();
    }
    #[test]
    fn tick_revokes_retained_content_without_commands_even_after_publication_failure() {
        for failed_publication in [false, true] {
            let (profile, project, host) = seeded();
            let store = profile.path().join(".owner/handovers");
            let held = profile.path().join(".owner/held-handovers");
            let content = crate::claude_content::SharedContent::new(
                host.states.isolation().clone(),
                project.clone(),
            )
            .unwrap();
            let (server, actor) = running_content(
                profile,
                &project,
                host,
                Default::default(),
                Some(content.clone()),
            );
            assert_eq!(
                actor.shared.snapshot.lock().unwrap()["projects"][0]["path"],
                json!(project)
            );
            let chat = format!("{}#1", project.display());
            let retained = content.dispatcher(&chat).unwrap();
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            assert_eq!(
                runtime.block_on(retained.call("artifact_list", &json!({})))["isError"],
                false
            );
            if failed_publication {
                actor.shared.delivery_failed.store(true, Ordering::Release);
            }
            fs::rename(&store, &held).unwrap();
            fs::create_dir(&store).unwrap();
            let deadline = Instant::now() + Duration::from_secs(2);
            while content
                .renderer("artifact:list", &json!({"chatId":chat}))
                .is_ok()
                || actor.shared.snapshot.lock().unwrap()["projects"] != json!([])
            {
                assert!(
                    Instant::now() < deadline,
                    "tick failed to revoke content within its bound"
                );
                thread::sleep(Duration::from_millis(5));
            }
            assert_eq!(
                runtime.block_on(retained.call("artifact_list", &json!({})))["isError"],
                true
            );
            // Inspect the cache directly: no renderer/actor command causes the revalidation.
            assert_eq!(actor.shared.snapshot.lock().unwrap()["projects"], json!([]));
            fs::remove_dir(&store).unwrap();
            fs::rename(&held, &store).unwrap();
            assert!(
                content
                    .renderer("artifact:list", &json!({"chatId":chat}))
                    .is_err(),
                "repair is not explicit recovery"
            );
            drop(retained);
            drop(content);
            // Publication failure is latched. Forced drop is a crash boundary, not a graceful stop claim.
            drop(server);
            drop(actor);
        }
    }
    #[test]
    fn forced_server_drop_retains_profile_until_actor_joins_paused_job() {
        let (profile, project, mut host) = seeded();
        let path = profile.path().to_path_buf();
        prepare(&mut host, &project, 1);
        let (mut workers, gate, entered) = workers(0);
        let (joining, joined_entry) = mpsc::sync_channel(1);
        workers.join_entered = Some(joining);
        let (server, actor) = running(profile, &project, host, workers);
        let _release = ReleaseOnDrop(gate.clone());
        entered.recv_timeout(Duration::from_secs(2)).unwrap();
        // Deliberately abandon graceful quit. The retained Actor and paused job
        // must outlive wire Inner and its original IsolatedProfile handle.
        drop(server);
        assert!(path.exists());
        assert!(project.join(".milagre/runtime.lock").exists());
        let (completed, receive) = mpsc::sync_channel(1);
        let dropping = thread::spawn(move || {
            drop(actor);
            completed.send(()).unwrap();
        });
        joined_entry.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(receive.try_recv().is_err(), "drop joins the held worker");
        assert!(path.exists());
        assert!(project.join(".milagre/runtime.lock").exists());
        gate.release();
        receive.recv_timeout(Duration::from_secs(3)).unwrap();
        dropping.join().unwrap();
        assert!(
            !path.exists(),
            "last lease follows worker and host destruction"
        );
    }
    include!("actor_restore_tests.rs");
    include!("actor_shutdown_tests.rs");
}

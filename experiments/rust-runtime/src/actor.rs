//! One owner actor, exercised only against a fresh scripted fixture. No external paths or CLIs.
use milagre_owner_store::{
    agent_runs,
    chat_host::{
        AnswerId, AnswerOutcome, AnswerResult, ChatHost, Notice, Provider, ProviderError,
        ProviderErrorKind, ProviderEvent, QuitState, TurnId,
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
                if self.content {
                    crate::artifacts::METHODS
                } else {
                    &[]
                }
                .iter()
                .copied(),
            )
            .chain(app_methods(self.app_fixture).iter().copied())
            .chain(
                if self.content && self.app_fixture {
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
            && !app_methods(self.app_fixture).contains(&method)
            && !(self.content
                && (crate::artifacts::METHODS.contains(&method)
                    || (self.app_fixture && DESIGN_SETTINGS.contains(&method))))
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
            && context.view().project_path.as_deref() != Some(&self.project)
        {
            return Err(RpcError::new(
                "ISOLATED_SCOPE_ONLY",
                "Open the fixture Project on this connection first",
            ));
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
    // Only these three fields belong to this actor. Every unrelated field survives.
    audit.insert(
        "answerHistoryForgotten".into(),
        json!(shared.forgotten_answers.load(Ordering::Acquire)),
    );
    audit.insert("ownerLockStrandedNotices".into(), json!(stranded));
    audit.insert("ownerLockStranded".into(), json!(stranded > 0));
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
    last: Value,
    run_seq: u64,
    next_readiness_check: Instant,
    pending: VecDeque<(String, Value)>,
    answers: HashMap<AnswerId, SyncSender<RpcResult>>,
    settled_answers: Vec<(SyncSender<RpcResult>, RpcResult)>,
    // Drop after jobs join and the host releases its locks, even on forced teardown.
    #[cfg(feature = "app-fixture")]
    bootstrap: Option<crate::app_fixture::Bootstrap>,
    _profile: ProfileLease,
}
impl Drop for State {
    fn drop(&mut self) {
        // A forced actor drop is still a crash boundary, but its job workers must
        // finish before host locks and the private profile can be destroyed.
        self.jobs.join();
    }
}
impl State {
    fn sync_readiness(&mut self) {
        if !self.host.is_project_ready(&self.project) {
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
    fn project_name(&self) -> &'static str {
        #[cfg(feature = "app-fixture")]
        if self.bootstrap.is_some() {
            return "fixture";
        }
        "actor"
    }
    fn project(&mut self) -> RpcResult {
        self.host
            .require_project_ready(&self.project)
            .map_err(convert)?;
        Ok(
            json!({"path":self.project,"name":self.project_name(),"git":false,"state":self.host.states.whole_state(&self.project).map_err(convert)?}),
        )
    }
    fn cache(&mut self, shared: &Shared) {
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
            self.host
                .states
                .current(&self.project)
                .map(|state| state.to_value())
                .unwrap_or_else(|| self.last.clone())
        } else {
            Value::Null
        };
        if state != self.last {
            self.version += 1;
            self.last = state.clone();
        }
        let projects = if self.opened {
            vec![json!({"path":self.project,"name":self.project_name(),"git":false,"state":state})]
        } else {
            vec![]
        };
        let runs = if ready {
            json!(self.host.runs())
        } else {
            json!({})
        };
        *shared.snapshot.lock().unwrap() = json!({"projects":projects,"links":[],"runs":{"runs":runs,"seq":self.run_seq},"ports":{}});
    }
    fn call(&mut self, method: &str, args: &[Value]) -> RpcResult {
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
                result["epoch"] = json!(format!("isolated-actor:{}", self.project.display()));
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
                    self.host.open_project(&self.project).map_err(convert)?;
                }
                let project = self.project()?;
                if matches!(method, "project:open" | "project:switch") {
                    self.opened = true;
                    if let Some(content) = &self.content {
                        content.opened(true);
                    }
                }
                if method == "state:read" {
                    Ok(
                        json!({"state":project["state"],"version":self.version,"epoch":format!("isolated-actor:{}",self.project.display())}),
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
                self.host.call(method, args).map_err(convert)
            }
            "agent:respond-permission" | "agent:answer-question" => {
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
    fn tick(&mut self, now: i64) -> Result<(), RpcError> {
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
        if let Some(error) = errors.into_iter().next() {
            return Err(convert(error));
        }
        Ok(())
    }
    fn publish(&mut self, shared: &Shared, publication: &Publication<'_>) -> Result<(), RpcError> {
        self.sync_readiness();
        if shared.delivery_failed.load(Ordering::Acquire) {
            self.cache(shared);
            return Err(delivery_failed());
        }
        let notices = self.host.take_notices();
        for notice in &notices {
            if let Notice::ProjectReady { project } = notice {
                if project == &self.project && self.host.is_project_ready(project) {
                    #[cfg(test)]
                    shared.ready_notices.fetch_add(1, Ordering::AcqRel);
                    self.opened = true;
                    if let Some(content) = &self.content {
                        content.opened(true);
                    }
                }
            }
        }
        // Cache and events are committed under one publication lock. No state is
        // read via the actor from Handler::snapshot, including during shutdown.
        self.cache(shared);
        let mut state_queued = false;
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
                        self.settled_answers.push((
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
                Notice::AnswerForgotten { .. } => record_forgotten_answer(shared),
                Notice::LockStranded { .. } => {
                    // Signal stranded ownership without retaining path/reason strings or any lock token.
                    let _ = shared.stranded_lock_notices.try_update(
                        Ordering::AcqRel,
                        Ordering::Acquire,
                        |count| Some(count.saturating_add(1)),
                    );
                }
                Notice::Failed { error, .. } | Notice::Gap { what: error, .. } => {
                    record_failure(shared, error);
                }
                // Naming and sender-local queue replies are not implemented by this fixture.
                Notice::NameChat { .. }
                | Notice::QueueStarted { .. }
                | Notice::QueueStartedWithoutSender { .. }
                | Notice::QueueRemovedWithoutSender { .. }
                | Notice::Started { .. } => {}
            }
        }
        for event in self.host.states.take_events() {
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
                Event::SaveFailed { error, .. } => {
                    record_failure(shared, error);
                }
                Event::Saved { .. } => {}
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
        for (reply, result) in self.settled_answers.drain(..) {
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
            for (reply, _) in self.settled_answers.drain(..) {
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
        if let Some(error) = self.host.pump().into_iter().next() {
            return Err(convert(error));
        }
        // Keep cancellation state in the cached snapshot before close releases its slots.
        if !shared.delivery_failed.load(Ordering::Acquire) {
            self.publish_or_latch(shared, publication)?;
        }
        let was_running = self.host.quit_state() == QuitState::Running;
        let closed = self.host.shutdown(force);
        #[cfg(test)]
        {
            *shared.observed_quit.lock().unwrap() = Some(self.host.quit_state());
        }
        // Only the owner's actual busy gate, before shutdown starts, permits
        // reopening. Earlier interrupt/pump errors never reach this branch.
        *refused = was_running
            && matches!(&closed, Err(milagre_owner_store::StoreError::Invalid(_)))
            && self.host.quit_state() == QuitState::Running;
        let closed = closed.map_err(convert);
        // Closing may produce stranded-lock or failure notices on every retry,
        // including the final one. Drain them before returning any close result.
        if !shared.delivery_failed.load(Ordering::Acquire) {
            self.publish_or_latch(shared, publication)?;
        }
        closed?;
        if self.host.quit_state() != QuitState::Done || !self.jobs.is_empty() {
            return Err(RpcError::new(
                "QUIT_PENDING",
                "Transcript worker cleanup is still pending",
            ));
        }
        if let Some(content) = &self.content {
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
                if !(shutdown && shared.delivery_failed.load(Ordering::Acquire)) {
                    state.publish_or_latch(&shared, publication)?;
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
                    let result =
                        state.tick(epoch.saturating_add(
                            started.elapsed().as_millis().min(i64::MAX as u128) as i64,
                        ));
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
    )
}

#[cfg(feature = "app-fixture")]
pub(crate) fn start_app_fixture() -> Result<(Server, Value), RpcError> {
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
    let bootstrap = crate::app_fixture::Bootstrap::new(isolation.clone(), &project)?;
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
    )?;
    metadata["appFixture"] = json!(true);
    metadata["handoff"] = json!("gated");
    metadata["steering"] = json!("gated");
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
    )?;
    metadata["scriptedProvider"] = json!(false);
    metadata["fakeAcp"] = json!(true);
    Ok((server, metadata, monitor))
}
fn start_provider(
    profile: IsolatedProfile,
    isolation: Isolation,
    project: PathBuf,
    provider: Box<dyn Provider>,
    provider_name: &'static str,
    content: Option<Arc<crate::claude_content::SharedContent>>,
    #[cfg(feature = "app-fixture")] bootstrap: Option<crate::app_fixture::Bootstrap>,
) -> Result<(Server, Value), RpcError> {
    let epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let started = Instant::now();
    let mut host = ChatHost::new(ProjectStates::new(
        isolation,
        Timing {
            debounce_ms: 100,
            idle_ms: 350,
            sweep_ms: 100,
            lazy: true,
        },
        epoch,
    ));
    host.interrupt_grace_ms = 250;
    host.answer_grace_ms = 250;
    host.answer_capacity = 32;
    host.register(provider);
    // This fixed fixture Project is admitted by trusted setup, never a saved path.
    host.open_project(&project).map_err(convert)?;
    if let Some(content) = &content {
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
        project: project.to_string_lossy().into_owned(),
        content: content.is_some(),
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
        last: Value::Null,
        run_seq: 0,
        next_readiness_check: Instant::now(),
        pending: VecDeque::new(),
        answers: HashMap::new(),
        settled_answers: Vec::new(),
        #[cfg(feature = "app-fixture")]
        bootstrap,
        _profile: profile_lease,
    };
    state.cache(&shared);
    let server = Server::bind(
        profile,
        actor.clone(),
        Config {
            max_frame_bytes: 4096,
            // Tiny frames exercise paging; the independent bounded reply budget
            // accommodates the fixture's concurrent requests without enlarging frames.
            outgoing_budget_bytes: Some(128 * 1024),
            ..Config::default()
        },
    )?;
    *shared.events.lock().unwrap() = Some(server.events());
    *actor.thread.lock().unwrap() = Some(thread::spawn(move || {
        run(state, shared, requests, started, epoch)
    }));
    let metadata = json!({"project":actor.project,"scriptedProvider":provider_name == "kiro","provider":provider_name,"tickMs":20,"debounceMs":100,"idleMs":350,"interruptGraceMs":250});
    Ok((server, metadata))
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
            },
            receive,
        )
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
    #[test]
    fn failed_publication_retains_unsent_events_and_closes_admission() {
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
        let mut state = State {
            host: ChatHost::new(ProjectStates::new(isolation, Timing::default(), 0)),
            jobs: crate::jobs::Workers::default(),
            provider: "kiro",
            content: None,
            project: profile.path().join("fixture"),
            opened: false,
            version: 0,
            last: Value::Null,
            run_seq: 0,
            next_readiness_check: Instant::now(),
            pending: VecDeque::new(),
            answers: HashMap::new(),
            settled_answers: Vec::new(),
            #[cfg(feature = "app-fixture")]
            bootstrap: None,
            _profile: profile.lease(),
        };
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
            last: Value::Null,
            run_seq: 0,
            next_readiness_check: Instant::now(),
            pending: VecDeque::new(),
            answers: HashMap::new(),
            settled_answers: vec![],
            #[cfg(feature = "app-fixture")]
            bootstrap: None,
            _profile: profile_lease,
        };
        state.cache(&shared);
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
}

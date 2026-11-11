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
    ClientContext, Config, EventSink, Handler, IsolatedProfile, Publication, RpcError, RpcResult,
    Server,
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
const QUEUE: usize = 64;
const BYTES: usize = 8 * 1024 * 1024;
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

enum Command {
    Call(String, Vec<Value>),
    Shutdown { force: bool },
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
}
struct Actor {
    send: SyncSender<Request>,
    shared: Arc<Shared>,
    thread: Mutex<Option<JoinHandle<()>>>,
    project: String,
    content: bool,
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
            .map(str::to_owned)
            .collect()
    }
    fn invoke(&self, method: &str, args: &[Value], context: &ClientContext) -> RpcResult {
        if !METHODS.contains(&method)
            && !(self.content && crate::artifacts::METHODS.contains(&method))
        {
            return Err(RpcError::new(
                "UNSUPPORTED_MUTATION",
                "This isolated actor exposes only scripted Chat commands",
            ));
        }
        if !matches!(
            method,
            "project:open" | "project:switch" | "project:current"
        ) && context.view().project_path.as_deref() != Some(&self.project)
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
        self.call(Command::Shutdown { force: false })
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
                    eprintln!("{}: isolated owner shutdown refused", error.code);
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
    pending: VecDeque<(String, Value)>,
    answers: HashMap<AnswerId, SyncSender<RpcResult>>,
    settled_answers: Vec<(SyncSender<RpcResult>, RpcResult)>,
}
impl Drop for State {
    fn drop(&mut self) {
        // A forced actor drop is still a crash boundary, but its job workers must
        // finish before host locks and the private profile can be destroyed.
        self.jobs.join();
    }
}
impl State {
    fn project(&mut self) -> RpcResult {
        Ok(
            json!({"path":self.project,"name":"actor","git":false,"state":self.host.states.whole_state(&self.project).map_err(convert)?}),
        )
    }
    fn cache(&mut self, shared: &Shared) {
        let state = self
            .host
            .states
            .current(&self.project)
            .map(|state| state.to_value())
            .unwrap_or_else(|| self.last.clone());
        if state != self.last {
            self.version += 1;
            self.last = state.clone();
        }
        let projects = if self.opened {
            vec![json!({"path":self.project,"name":"actor","git":false,"state":state})]
        } else {
            vec![]
        };
        *shared.snapshot.lock().unwrap() = json!({"projects":projects,"links":[],"runs":{"runs":self.host.runs(),"seq":self.run_seq},"ports":{}});
    }
    fn call(&mut self, method: &str, args: &[Value]) -> RpcResult {
        if crate::artifacts::METHODS.contains(&method) {
            return self
                .content
                .as_ref()
                .ok_or_else(closed)?
                .renderer(method, args.first().unwrap_or(&Value::Null));
        }
        let path = self.project.to_string_lossy();
        match method {
            "project:current" => {
                let project = self.project()?;
                self.opened = true;
                if let Some(content) = &self.content {
                    content.opened(true);
                }
                Ok(project)
            }
            "project:open" | "project:switch" | "project:snapshot" | "state:read" => {
                if args.first().and_then(Value::as_str) != Some(&path) {
                    return Err(RpcError::new(
                        "ISOLATED_SCOPE_ONLY",
                        "Only this actor's copied fixture Project is admitted",
                    ));
                }
                let project = self.project()?;
                self.opened = true;
                if let Some(content) = &self.content {
                    content.opened(true);
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
                self.host.call(method, args).map_err(convert)
            }
        }
    }
    fn tick(&mut self, now: i64) -> Result<(), RpcError> {
        let errors = if self.host.states.is_closed() {
            self.host.pump()
        } else {
            self.host.tick(now)
        };
        if let Some(error) = errors.into_iter().next() {
            return Err(convert(error));
        }
        Ok(())
    }
    fn publish(&mut self, shared: &Shared, publication: &Publication<'_>) -> Result<(), RpcError> {
        if shared.delivery_failed.load(Ordering::Acquire) {
            return Err(delivery_failed());
        }
        let notices = self.host.take_notices();
        for notice in &notices {
            if let Notice::Event { seq: Some(seq), .. } = notice {
                self.run_seq = self.run_seq.max(*seq);
            }
        }
        // Cache and events are committed under one publication lock. No state is
        // read via the actor from Handler::snapshot, including during shutdown.
        self.cache(shared);
        for notice in notices {
            match notice {
                Notice::Event {
                    chat,
                    event,
                    seq,
                    with_state,
                } => {
                    let mut payload = json!({"chatId":chat,"event":event});
                    if let Some(seq) = seq {
                        payload["seq"] = json!(seq);
                    }
                    if with_state {
                        payload["state"] = self.last.clone();
                    }
                    self.queue_event("agent:event", payload)?;
                }
                Notice::Broadcast { project } => {
                    self.queue_event("project:state", json!({"path":project,"state":self.last}))?;
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
                    self.queue_event("project:state", json!({"path":project,"state":self.last}))?;
                }
                Event::SaveFailed { error, .. } => {
                    record_failure(shared, error);
                }
                Event::Saved { .. } => {}
            }
        }
        while let Some((channel, payload)) = self.pending.front() {
            publication.emit(channel, payload.clone())?;
            self.pending.pop_front();
        }
        for (reply, result) in self.settled_answers.drain(..) {
            let _ = reply.send(result);
        }
        Ok(())
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
        let closed = self.host.shutdown(force).map_err(convert);
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
            let state_read =
                matches!(&request.command,Command::Call(method,_) if method=="state:read");
            let mut reply = Some(request.reply);
            let answer_call = matches!(&request.command,Command::Call(method,_) if matches!(method.as_str(),"agent:respond-permission"|"agent:answer-question"));
            let result = sink.transaction(|publication| {
                let mut result = match request.command {
                    Command::Call(method, args) => {
                        if shared.closing.load(Ordering::Acquire) {
                            Err(closed())
                        } else {
                            state.call(&method, &args)
                        }
                    }
                    Command::Shutdown { force } => {
                        shared.closing.store(true, Ordering::Release);
                        state.shutdown(&shared, publication, force)
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
    )
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
    });
    let (send, requests) = mpsc::sync_channel(QUEUE);
    let actor = Arc::new(Actor {
        send,
        shared: shared.clone(),
        thread: Mutex::new(None),
        project: project.to_string_lossy().into_owned(),
        content: content.is_some(),
    });
    let server = Server::bind(
        profile,
        actor.clone(),
        Config {
            max_frame_bytes: 4096,
            ..Config::default()
        },
    )?;
    *shared.events.lock().unwrap() = Some(server.events());
    *actor.thread.lock().unwrap() = Some(thread::spawn(move || {
        run(
            State {
                host,
                jobs: crate::jobs::Workers::default(),
                provider: provider_name,
                content,
                project,
                opened: false,
                version: 0,
                last: Value::Null,
                run_seq: 0,
                pending: VecDeque::new(),
                answers: HashMap::new(),
                settled_answers: Vec::new(),
            },
            shared,
            requests,
            started,
            epoch,
        )
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
        });
        (
            Actor {
                send,
                shared,
                thread: Mutex::new(None),
                project: "fixture".into(),
                content: false,
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
                    command: Command::Shutdown { force: false },
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
            pending: VecDeque::new(),
            answers: HashMap::new(),
            settled_answers: Vec::new(),
        };
        state
            .pending
            .push_back(("agent:event".into(), json!({"text":"x".repeat(8192)})));
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
                    state: &state,
                    session,
                    before: None,
                    provider: Some("kiro"),
                    catch_up_after: None,
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
        let profile = IsolatedProfile::create().unwrap();
        let isolation = Isolation::create(profile.path(), &Policy::default()).unwrap();
        let project = isolation.project(std::path::Path::new("fixture")).unwrap();
        fs::create_dir(project.join(".milagre")).unwrap();
        let mut sessions = serde_json::Map::new();
        for id in 1..=5 {
            sessions.insert(
                id.to_string(),
                json!({"id":id,"worktree_id":1,"title":"Jobs"}),
            );
        }
        fs::write(project.join(".milagre/coordination.json"), json!({"next_id":10,"worktrees":{"1":{"id":1,"path":project}},"sessions":sessions,"messages":[{"id":1,"session_id":1,"role":"user","body":"Transcript input"}]}).to_string()).unwrap();
        let mut host = ChatHost::new(ProjectStates::new(isolation, Timing::default(), 0));
        host.states.get(&project).unwrap();
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
                    state: &state,
                    session: 5,
                    before: None,
                    provider: None,
                    catch_up_after: None,
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
        });
        let (send, requests) = mpsc::sync_channel(QUEUE);
        let actor = Arc::new(Actor {
            send,
            shared: shared.clone(),
            thread: Mutex::new(None),
            project: project.to_string_lossy().into(),
            content: false,
        });
        let server = Arc::new(Server::bind(profile, actor.clone(), Config::default()).unwrap());
        *shared.events.lock().unwrap() = Some(server.events());
        let state = State {
            host,
            jobs: workers,
            provider: "kiro",
            content: None,
            project: project.clone(),
            opened: true,
            version: 0,
            last: Value::Null,
            run_seq: 0,
            pending: VecDeque::new(),
            answers: HashMap::new(),
            settled_answers: vec![],
        };
        *actor.thread.lock().unwrap() = Some(thread::spawn(move || {
            run(state, shared, requests, Instant::now(), 0)
        }));
        let _release = ReleaseOnDrop(gate.clone());
        for _ in 0..4 {
            entered.recv_timeout(Duration::from_secs(2)).unwrap();
        }
        // Ordinary busy quit refuses; only this explicit test force cancels staging.
        assert!(server.shutdown().is_err());
        assert_eq!(
            actor
                .call(Command::Shutdown { force: true })
                .unwrap_err()
                .code,
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
}

//! One owner actor, exercised only against a fresh scripted fixture. No external paths or CLIs.
use milagre_owner_store::{
    agent_runs,
    chat_host::{
        ChatHost, Notice, Provider, ProviderError, ProviderErrorKind, ProviderEvent, TurnId,
    },
    jsjson,
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
        atomic::{AtomicBool, AtomicUsize, Ordering},
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
    "state:read",
    "chat:send",
    "chat:send-status",
    "chat:messages",
    "chat:message",
    "chat:all-messages",
    "chat:search",
    "chat:subagent",
    "agent:interrupt",
    "chat:queue-send",
    "chat:queue-remove",
];

enum Command {
    Call(String, Vec<Value>),
    Shutdown,
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
}
struct Actor {
    send: SyncSender<Request>,
    shared: Arc<Shared>,
    thread: Mutex<Option<JoinHandle<()>>>,
    project: String,
}
impl Actor {
    fn call(&self, command: Command) -> RpcResult {
        let shutdown = matches!(command, Command::Shutdown);
        if self.shared.stop.load(Ordering::Acquire) {
            return Err(closed());
        }
        if !shutdown && self.shared.closing.load(Ordering::Acquire) {
            return Err(closed());
        }
        let bytes = match &command {
            Command::Call(method, args) => method.len() + jsjson::to_string(&json!(args)).len(),
            Command::Shutdown => 0,
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
        METHODS.iter().map(|method| (*method).into()).collect()
    }
    fn invoke(&self, method: &str, args: &[Value], context: &ClientContext) -> RpcResult {
        if !METHODS.contains(&method) {
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
        Ok(self.shared.snapshot.lock().unwrap().clone())
    }
    fn shutdown(&self) -> RpcResult {
        self.call(Command::Shutdown)
    }
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
fn convert(error: milagre_owner_store::StoreError) -> RpcError {
    RpcError::new(error.code().unwrap_or("COMMAND_FAILED"), error.to_string())
}

struct State {
    host: ChatHost,
    project: PathBuf,
    opened: bool,
    version: u64,
    last: Value,
    run_seq: u64,
    pending: VecDeque<(String, Value)>,
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
        let path = self.project.to_string_lossy();
        match method {
            "project:current" => {
                self.opened = true;
                self.project()
            }
            "project:open" | "project:switch" | "project:snapshot" | "state:read" => {
                if args.first().and_then(Value::as_str) != Some(&path) {
                    return Err(RpcError::new(
                        "ISOLATED_SCOPE_ONLY",
                        "Only this actor's copied fixture Project is admitted",
                    ));
                }
                self.opened = true;
                let project = self.project()?;
                if method == "state:read" {
                    Ok(
                        json!({"state":project["state"],"version":self.version,"epoch":format!("isolated-actor:{}",self.project.display())}),
                    )
                } else {
                    Ok(project)
                }
            }
            "chat:send" => {
                let request = args.first().cloned().unwrap_or(Value::Null);
                if request["projectPath"].as_str() != Some(&path) || request["provider"] != "kiro" {
                    return Err(RpcError::new(
                        "ISOLATED_SCOPE_ONLY",
                        "Only the scripted fixture provider and Project are admitted",
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
        if !self.host.states.is_closed() {
            self.host.states.advance(now);
        }
        let errors = self.host.pump();
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
        })
    }
    fn shutdown(&mut self, shared: &Shared, publication: &Publication<'_>) -> RpcResult {
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
        self.host.shutdown().map_err(convert)?;
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
            let shutdown = matches!(request.command, Command::Shutdown);
            let state_read =
                matches!(&request.command,Command::Call(method,_) if method=="state:read");
            let result = sink.transaction(|publication| {
                let mut result = match request.command {
                    Command::Call(method, args) => {
                        if shared.closing.load(Ordering::Acquire) {
                            Err(closed())
                        } else {
                            state.call(&method, &args)
                        }
                    }
                    Command::Shutdown => {
                        shared.closing.store(true, Ordering::Release);
                        state.shutdown(&shared, publication)
                    }
                };
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
            let _ = request.reply.send(result);
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
    host.register(Box::new(Scripted::default()));
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
    });
    let (send, requests) = mpsc::sync_channel(QUEUE);
    let actor = Arc::new(Actor {
        send,
        shared: shared.clone(),
        thread: Mutex::new(None),
        project: project.to_string_lossy().into_owned(),
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
                project,
                opened: false,
                version: 0,
                last: Value::Null,
                run_seq: 0,
                pending: VecDeque::new(),
            },
            shared,
            requests,
            started,
            epoch,
        )
    }));
    let metadata = json!({"project":actor.project,"scriptedProvider":true,"tickMs":20,"debounceMs":100,"idleMs":350});
    Ok((server, metadata))
}

#[derive(Default)]
struct Scripted {
    events: VecDeque<(Instant, ProviderEvent)>,
    active: HashMap<String, TurnId>,
    delayed_stop: HashSet<TurnId>,
}
impl Provider for Scripted {
    fn name(&self) -> &str {
        "kiro"
    }
    fn start_turn(&mut self, turn: TurnId, request: &Value) -> Result<(), ProviderError> {
        if self.active.len() >= 8 || self.events.len() >= 60 {
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
                turn: Some(turn),
                event: json!({"type":"session-started","nativeId":format!("fixture-{chat}")}),
            },
        ));
        if request["prompt"] == "fixture:delayed-stop" {
            self.delayed_stop.insert(turn);
        }
        if request["prompt"] == "fixture:blocked-start"
            || request["prompt"] == "fixture:delayed-stop"
        {
            return Ok(());
        }
        let now = Instant::now();
        self.events.push_back((
            now,
            ProviderEvent::Started {
                chat: chat.clone(),
                turn,
                result: json!({"turnId":format!("fixture-{}",turn.0),"steered":false}),
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
                    turn: Some(turn),
                    event,
                },
            ));
        }
        Ok(())
    }
    fn interrupt(&mut self, chat: &str, turn: TurnId) -> Result<(), ProviderError> {
        self.events.retain(|(_,event)| !matches!(event,ProviderEvent::Agent{chat:target,turn:Some(id),..}|ProviderEvent::Started{chat:target,turn:id,..} if target==chat && *id==turn));
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
                turn: Some(turn),
                event: json!({"type":"turn-cancelled"}),
            },
        ));
        Ok(())
    }
    fn respond_permission(&mut self, _: &str, _: &str, _: &str) -> Result<bool, ProviderError> {
        Ok(false)
    }
    fn answer_question(&mut self, _: &str, _: &str, _: &Value) -> Result<bool, ProviderError> {
        Ok(false)
    }
    fn close_chat(&mut self, chat: &str) -> Result<(), ProviderError> {
        self.active.remove(chat);
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
            if let ProviderEvent::Agent { chat, event, .. } = event {
                if agent_runs::is_turn_end(event) {
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
            snapshot: Mutex::new(Value::Null),
            events: Mutex::new(None),
            bytes: AtomicUsize::new(0),
            closing: AtomicBool::new(false),
            stop: AtomicBool::new(false),
            failure: Mutex::new(None),
            delivery_failed: AtomicBool::new(false),
        });
        (
            Actor {
                send,
                shared,
                thread: Mutex::new(None),
                project: "fixture".into(),
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
                    command: Command::Shutdown,
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
        for turn in 0..8 {
            provider
                .start_turn(
                    TurnId(turn),
                    &json!({"chatId":format!("fixture#{turn}"),"prompt":"run"}),
                )
                .unwrap();
        }
        assert!(provider
            .start_turn(TurnId(9), &json!({"chatId":"fixture#9","prompt":"run"}))
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
            snapshot: Mutex::new(Value::Null),
            events: Mutex::new(None),
            bytes: AtomicUsize::new(0),
            closing: AtomicBool::new(false),
            stop: AtomicBool::new(false),
            failure: Mutex::new(None),
            delivery_failed: AtomicBool::new(false),
        };
        let mut state = State {
            host: ChatHost::new(ProjectStates::new(isolation, Timing::default(), 0)),
            project: profile.path().join("fixture"),
            opened: false,
            version: 0,
            last: Value::Null,
            run_seq: 0,
            pending: VecDeque::new(),
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

//! Nonblocking Codex/ChatHost bridge, restricted to the repository's Node fake app-server.
//! No constructor accepts an executable, profile, environment, role or MCP endpoint.
use milagre_owner_store::{
    chat_host::{Provider, ProviderError, ProviderErrorKind, ProviderEvent, TurnId},
    jsjson, Isolation, Policy,
};
use milagre_owner_wire::IsolatedProfile;
use milagre_providers::codex::{
    self,
    session::{chat_thread, prompt_input, turn},
    CodexSession, SessionEvent,
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Condvar, Mutex,
    },
    time::Duration,
};
use tokio::sync::{mpsc, watch};

const CHATS: usize = 16;
const EVENTS: usize = 256;
const BYTES: usize = 4 * 1024 * 1024;
const REQUEST_BYTES: usize = 1024 * 1024;

#[derive(Clone, Copy, Debug)]
pub enum Scenario {
    Reply,
    Slow,
    Stubborn,
    HangInitialize,
    HangThread,
    ResumeExit,
    Crash,
    Approval,
    Question,
    SlowStop,
    LateApproval,
    Steps,
}
impl Scenario {
    fn name(self) -> &'static str {
        match self {
            Self::Reply => "reply",
            Self::Slow => "slow",
            Self::Stubborn => "stubborn",
            Self::HangInitialize => "hang-init",
            Self::HangThread => "hang-thread",
            Self::ResumeExit => "resume-exit",
            Self::Crash => "crash",
            Self::Approval => "approval",
            Self::Question => "question",
            Self::SlowStop => "slow-stop",
            Self::LateApproval => "late-approval",
            Self::Steps => "steps",
        }
    }
}
fn refused(message: &str) -> ProviderError {
    ProviderError::new(ProviderErrorKind::Refused, message)
}
fn failed() -> ProviderError {
    ProviderError::new(
        ProviderErrorKind::Other,
        "The isolated Codex fixture session failed",
    )
}

struct Queue {
    items: VecDeque<ProviderEvent>,
    bytes: usize,
}
type NativeObservation = (String, Option<u32>, Option<String>);
struct Shared {
    queue: Mutex<Queue>,
    failed: AtomicBool,
    workers: Mutex<usize>,
    observations: Mutex<VecDeque<NativeObservation>>,
    drained: Condvar,
}
impl Shared {
    fn emit(&self, event: ProviderEvent, terminal: bool) -> bool {
        let bytes = match &event {
            ProviderEvent::Agent { event, .. } => event.to_string().len() + 1024,
            _ => 1024,
        };
        let mut q = self.queue.lock().unwrap();
        if !terminal
            && (self.failed.load(Ordering::Acquire)
                || q.items.len() >= EVENTS
                || q.bytes.saturating_add(bytes) > BYTES)
        {
            self.failed.store(true, Ordering::Release);
            return false;
        }
        // Only one final event plus one exit per worker use this bounded reserve. Once overflow
        // latches, admission is closed. Existing workers also terminate on their next event.
        if q.items.len() >= EVENTS + CHATS * 3 {
            self.failed.store(true, Ordering::Release);
            return false;
        }
        q.bytes += bytes;
        q.items.push_back(event);
        true
    }
}
#[derive(Clone)]
pub struct FixtureMonitor {
    shared: Arc<Shared>,
    _profile: Arc<IsolatedProfile>,
}
impl FixtureMonitor {
    /// Test-only blocking join. Never called by the owner actor or Provider methods.
    pub fn wait_stopped(&self, timeout: Duration) -> bool {
        let count = self.shared.workers.lock().unwrap();
        *self
            .shared
            .drained
            .wait_timeout_while(count, timeout, |n| *n != 0)
            .unwrap()
            .0
            == 0
    }
    /// Last observed fixture session; bounded to 32 entries, contains no request or environment.
    pub fn native_session(&self, chat: &str) -> Option<(Option<u32>, Option<String>)> {
        self.shared
            .observations
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|v| v.0 == chat)
            .map(|v| (v.1, v.2.clone()))
    }
    pub fn workers(&self) -> usize {
        *self.shared.workers.lock().unwrap()
    }
}
struct Slot {
    commands: mpsc::Sender<Start>,
    close: watch::Sender<bool>,
    interrupt: watch::Sender<u64>,
    active: Arc<AtomicBool>,
    done: Arc<AtomicBool>,
    latest: Arc<AtomicU64>,
    native_thread: Arc<Mutex<Option<String>>>,
}
struct Start {
    id: TurnId,
    request: Value,
}
struct Worker {
    shared: Arc<Shared>,
    profile: Arc<IsolatedProfile>,
    project: PathBuf,
    node: PathBuf,
    scenario: Scenario,
    chat: String,
    active: Arc<AtomicBool>,
    done: Arc<AtomicBool>,
    native_thread: Arc<Mutex<Option<String>>>,
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
        self.done.store(true, Ordering::Release);
        *self.shared.workers.lock().unwrap() -= 1;
        self.shared.drained.notify_all();
    }
}
/// Fixture capability: owns its fresh profile until every process task has stopped.
pub struct CodexFixture {
    profile: Arc<IsolatedProfile>,
    isolation: Isolation,
    project: PathBuf,
    node: PathBuf,
    scenario: Scenario,
    shared: Arc<Shared>,
    slots: HashMap<String, Slot>,
    closed: bool,
}
impl CodexFixture {
    pub fn create(scenario: Scenario) -> Result<Self, Box<dyn std::error::Error>> {
        let profile = Arc::new(IsolatedProfile::create()?);
        let isolation = Isolation::create(profile.path(), &Policy::system())?;
        let project = isolation.project(Path::new("fixture"))?;
        std::fs::create_dir(project.join(".milagre"))?;
        std::fs::write(project.join(".milagre/coordination.json"),json!({"next_id":10,"worktrees":{"1":{"id":1,"path":project,"name":"main"}},"sessions":{"1":{"id":1,"worktree_id":1},"2":{"id":2,"worktree_id":1}},"messages":[]}).to_string())?;
        std::fs::create_dir(profile.path().join("home"))?;
        let node = std::env::var_os("PATH")
            .and_then(|paths| {
                std::env::split_paths(&paths)
                    .map(|p| p.join("node"))
                    .find(|p| p.is_file())
            })
            .ok_or("Node is required for the fixture")?
            .canonicalize()?;
        Ok(Self {
            profile,
            isolation,
            project,
            node,
            scenario,
            shared: Arc::new(Shared {
                queue: Mutex::new(Queue {
                    items: VecDeque::new(),
                    bytes: 0,
                }),
                failed: AtomicBool::new(false),
                workers: Mutex::new(0),
                observations: Mutex::new(VecDeque::new()),
                drained: Condvar::new(),
            }),
            slots: HashMap::new(),
            closed: false,
        })
    }
    pub fn project(&self) -> &Path {
        &self.project
    }
    pub fn isolation(&self) -> Isolation {
        self.isolation.clone()
    }
    pub fn monitor(&self) -> FixtureMonitor {
        FixtureMonitor {
            shared: self.shared.clone(),
            _profile: self.profile.clone(),
        }
    }
    fn validate(&self, id: TurnId, request: &Value) -> Result<String, ProviderError> {
        if self.closed || self.shared.failed.load(Ordering::Acquire) {
            return Err(refused("The fixture provider is closed"));
        }
        if id.0 == 0 || request.to_string().len() > REQUEST_BYTES {
            return Err(refused("Invalid or oversized fixture turn"));
        }
        let map = request
            .as_object()
            .ok_or_else(|| refused("Expected a turn object"))?;
        for key in map.keys() {
            if ![
                "provider",
                "model",
                "permissionMode",
                "effort",
                "ultracode",
                "fastMode",
                "replies",
                "tldrEnabled",
                "prompt",
                "chatId",
                "cwd",
                "images",
                "resumeId",
            ]
            .contains(&key.as_str())
            {
                return Err(refused("Unsupported fixture turn configuration"));
            }
        }
        let chat = request["chatId"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 4096)
            .ok_or_else(|| refused("Invalid fixture Chat identity"))?;
        if request["cwd"].as_str() != self.project.to_str()
            || request["provider"].as_str() != Some("codex")
        {
            return Err(refused(
                "Only this isolated Codex fixture Project is admitted",
            ));
        }
        if request
            .get("permissionMode")
            .is_some_and(|v| !v.is_null() && v != "ask")
        {
            return Err(refused(
                "Only ordinary Ask mode is implemented by the fixture bridge",
            ));
        }
        for key in ["ultracode", "fastMode", "tldrEnabled"] {
            if request.get(key).is_some_and(|v| !v.is_null() && v != false) {
                return Err(refused(
                    "Instruction and policy assembly is not implemented by the fixture bridge",
                ));
            }
        }
        for key in ["images", "replies"] {
            if request
                .get(key)
                .is_some_and(|v| !v.is_null() && v.as_array().is_none_or(|v| !v.is_empty()))
            {
                return Err(refused(
                    "Images and reply assembly are not implemented by the fixture bridge",
                ));
            }
        }
        if !request["prompt"].is_string() {
            return Err(refused("The fixture prompt must be text"));
        }
        for key in ["model", "effort", "resumeId"] {
            if request
                .get(key)
                .is_some_and(|v| !v.is_null() && !v.is_string())
            {
                return Err(refused("Invalid fixture turn setting"));
            }
        }
        Ok(chat.into())
    }
}
impl Provider for CodexFixture {
    fn name(&self) -> &str {
        "codex"
    }
    fn start_turn(&mut self, id: TurnId, request: &Value) -> Result<(), ProviderError> {
        let chat = self.validate(id, request)?;
        let native_request: Value =
            serde_json::from_str(&jsjson::to_string(request)).map_err(|_| {
                refused("Lone UTF-16 units are not supported by the Codex fixture bridge")
            })?;
        self.slots
            .retain(|_, slot| !slot.done.load(Ordering::Acquire));
        let existing = self.slots.contains_key(&chat);
        if !existing {
            if *self.shared.workers.lock().unwrap() >= CHATS {
                return Err(refused("The fixture session limit is full"));
            }
            let (commands, rx) = mpsc::channel(1);
            let (close, close_rx) = watch::channel(false);
            let (interrupt, interrupt_rx) = watch::channel(0);
            let active = Arc::new(AtomicBool::new(false));
            let done = Arc::new(AtomicBool::new(false));
            let latest = Arc::new(AtomicU64::new(0));
            let native_thread = Arc::new(Mutex::new(None));
            let worker = Worker {
                shared: self.shared.clone(),
                profile: self.profile.clone(),
                project: self.project.clone(),
                node: self.node.clone(),
                scenario: self.scenario,
                chat: chat.clone(),
                active: active.clone(),
                done: done.clone(),
                native_thread: native_thread.clone(),
            };
            *self.shared.workers.lock().unwrap() += 1;
            std::thread::Builder::new()
                .name("codex-fixture".into())
                .spawn(move || {
                    if let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                    {
                        runtime.block_on(worker.run(rx, close_rx, interrupt_rx));
                    }
                })
                .map_err(|_| failed())?;
            self.slots.insert(
                chat.clone(),
                Slot {
                    commands,
                    close,
                    interrupt,
                    active,
                    done,
                    latest,
                    native_thread,
                },
            );
        }
        let slot = &self.slots[&chat];
        if let Some(resume) = native_request["resumeId"].as_str().filter(|_| existing) {
            if slot
                .native_thread
                .lock()
                .unwrap()
                .as_deref()
                .is_some_and(|current| current != resume)
            {
                return Err(refused(
                    "Close the previous fixture session before resuming another thread",
                ));
            }
        }
        if slot.active.swap(true, Ordering::AcqRel) {
            return Err(refused(
                "Steering is not integrated with the owner yet; queue this message",
            ));
        }
        slot.latest.store(id.0, Ordering::Release);
        if slot
            .commands
            .try_send(Start {
                id,
                request: native_request,
            })
            .is_err()
        {
            slot.active.store(false, Ordering::Release);
            return Err(refused("The fixture session command queue is closed"));
        }
        Ok(())
    }
    fn interrupt(&mut self, chat: &str, turn: TurnId) -> Result<(), ProviderError> {
        if let Some(slot) = self.slots.get(chat) {
            if slot.latest.load(Ordering::Acquire) == turn.0 {
                slot.interrupt.send_replace(turn.0);
            }
        }
        Ok(())
    }
    fn respond_permission(&mut self, _: &str, _: &str, _: &str) -> Result<bool, ProviderError> {
        Err(refused(
            "Async permission settlement is not integrated with the owner yet",
        ))
    }
    fn answer_question(&mut self, _: &str, _: &str, _: &Value) -> Result<bool, ProviderError> {
        Err(refused(
            "Async question settlement is not integrated with the owner yet",
        ))
    }
    fn close_chat(&mut self, chat: &str) -> Result<(), ProviderError> {
        if let Some(slot) = self.slots.remove(chat) {
            slot.close.send_replace(true);
        }
        Ok(())
    }
    fn shutdown(&mut self) {
        self.closed = true;
        for (_, slot) in self.slots.drain() {
            slot.close.send_replace(true);
        }
    }
    fn take_events(&mut self) -> Vec<ProviderEvent> {
        let mut q = self.shared.queue.lock().unwrap();
        q.bytes = 0;
        q.items.drain(..).collect()
    }
}
impl Drop for CodexFixture {
    fn drop(&mut self) {
        self.shutdown();
    }
}

impl Worker {
    fn agent(&self, id: TurnId, event: Value, terminal: bool) -> bool {
        // Provider values hold native Unicode; the owner stores escaped UTF-16 markers.
        let event =
            jsjson::parse(&event.to_string()).expect("serialized Unicode JSON is valid owner JSON");
        self.shared.emit(
            ProviderEvent::Agent {
                chat: self.chat.clone(),
                turn: id,
                event,
            },
            terminal,
        )
    }
    fn exit(&self, id: TurnId) {
        self.shared.emit(
            ProviderEvent::Exited {
                chat: self.chat.clone(),
                turn: id,
                error: ProviderError::new(
                    ProviderErrorKind::Exited,
                    "The isolated Codex fixture session exited",
                ),
            },
            true,
        );
    }
    async fn run(
        self,
        mut commands: mpsc::Receiver<Start>,
        mut close: watch::Receiver<bool>,
        mut interrupt: watch::Receiver<u64>,
    ) {
        let first = tokio::select! { biased;
            _=close.changed()=> {
                if let Ok(start)=commands.try_recv() {
                    self.shared.emit(ProviderEvent::StartFailed{chat:self.chat.clone(),turn:start.id,error:failed()},true);
                    self.exit(start.id);
                }
                return;
            },
            command=commands.recv()=>match command {Some(c)=>c,None=>return}
        };
        let mut latest = first.id;
        let home = self.profile.path().join("home");
        let spawn = codex::SpawnOptions::new(&self.node)
            .args([Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../packages/core/src/agents/fixtures/fake-app-server.cjs")])
            .cwd(&self.project)
            .env(vec![
                ("HOME", home.clone().into_os_string()),
                ("CODEX_HOME", home.into_os_string()),
                ("FAKE_SCENARIO", self.scenario.name().into()),
                ("LANG", "en_US.UTF-8".into()),
            ])
            .limits(codex::Limits {
                kill_grace: Duration::from_millis(150),
                drain_grace: Duration::from_millis(100),
                ..Default::default()
            });
        let cwd = self.project.to_string_lossy().to_string();
        let policy = codex::codex_policy(codex::PermissionMode::Ask, &cwd, &[], false, false);
        let mut options =
            codex::SessionOptions::new(codex::ConnectOptions::new(spawn, "fixture"), cwd);
        options.resume_thread_id = first.request["resumeId"].as_str().map(str::to_owned);
        options.interrupt_grace = Duration::from_millis(200);
        options.event_queue = milagre_providers::queue::QueueLimits {
            max_events: 128,
            max_bytes: BYTES,
        };
        let startup = CodexSession::start(
            options,
            chat_thread(
                first.request["model"].as_str().map(str::to_owned),
                policy.clone(),
            ),
        );
        let result = tokio::select! { biased; _=close.changed()=>None, _=interrupt.changed()=>None, result=startup=>Some(result) };
        let (session, mut events) = match result {
            Some(Ok(value)) => value,
            _ => {
                self.shared.emit(
                    ProviderEvent::StartFailed {
                        chat: self.chat.clone(),
                        turn: latest,
                        error: failed(),
                    },
                    true,
                );
                self.exit(latest);
                return;
            }
        };
        {
            let mut observations = self.shared.observations.lock().unwrap();
            if observations.len() == 32 {
                observations.pop_front();
            }
            observations.push_back((self.chat.clone(), session.pid(), session.thread_id()));
        }
        *self.native_thread.lock().unwrap() = session.thread_id();
        let mut pending = Some(first);
        let mut running = false;
        let mut native: Option<String> = None;
        loop {
            if let Some(start) = pending.take() {
                latest = start.id;
                if *close.borrow() || *interrupt.borrow() == latest.0 {
                    self.shared.emit(
                        ProviderEvent::StartFailed {
                            chat: self.chat.clone(),
                            turn: latest,
                            error: failed(),
                        },
                        true,
                    );
                    break;
                }
                let mut settings = turn(
                    prompt_input(start.request["prompt"].as_str().unwrap(), &[]),
                    start.request["model"].as_str().map(str::to_owned),
                    policy.clone(),
                );
                settings.effort = start.request["effort"].as_str().map(str::to_owned);
                settings.permission_mode = Some(codex::PermissionMode::Ask);
                let result = tokio::select! { biased; _=close.changed()=>None, _=interrupt.changed()=>None, result=session.send(settings)=>Some(result) };
                match result {
                    Some(Ok(outcome)) => {
                        native = outcome.turn_id.clone();
                        running = true;
                        if !self.shared.emit(
                            ProviderEvent::Started {
                                chat: self.chat.clone(),
                                turn: latest,
                                result: json!({"turnId":outcome.turn_id,"steered":outcome.steered}),
                            },
                            false,
                        ) {
                            break;
                        }
                        if !self.agent(latest, json!({"type":"message-sent"}), false) {
                            break;
                        }
                    }
                    _ => {
                        self.shared.emit(
                            ProviderEvent::StartFailed {
                                chat: self.chat.clone(),
                                turn: latest,
                                error: failed(),
                            },
                            true,
                        );
                        break;
                    }
                }
            }
            tokio::select! { biased;
                _=close.changed()=>break,
                _=interrupt.changed()=> {
                    if *interrupt.borrow()==latest.0 && running {
                        tokio::select! { biased; _=close.changed()=>break, _=session.interrupt()=>{} }
                    }
                }
                event=events.recv()=>match event {
                    Some(SessionEvent::Agent(event))=> {
                        if !self.agent(latest,event,false) { break; }
                    }
                    Some(SessionEvent::TurnEnded{turn_id,event,..})=> {
                        if running && (native.is_none() || native==turn_id) {
                            self.agent(latest,event,true); running=false;
                            self.active.store(false,Ordering::Release);
                        }
                    }
                    Some(SessionEvent::Exited(_))|None=>break,
                    Some(SessionEvent::Notification(_))=>{}
                },
                command=commands.recv()=>match command { Some(command)=>pending=Some(command),None=>break }
            }
        }
        if running {
            self.agent(latest,json!({"type":"turn-failed","message":"The isolated Codex fixture session stopped"}),true);
        }
        session.close().await;
        self.exit(latest);
    }
}

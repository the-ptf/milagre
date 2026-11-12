//! Nonblocking Codex/ChatHost bridge. The public constructor uses only the repository Node fake.
//! The private configured constructor requires a dedicated owner launch capability and retained root lease.
use milagre_owner_store::{
    chat_host::{
        AnswerId, AnswerOutcome, Provider, ProviderError, ProviderErrorKind, ProviderEvent, TurnId,
    },
    jsjson::RawJson,
    Isolation, Policy,
};
use milagre_owner_wire::IsolatedProfile;
use milagre_providers::codex::{
    self,
    session::{chat_thread, prompt_input, turn},
    CodexSession, SessionEvent,
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Condvar, Mutex,
    },
    time::Duration,
};
use tokio::sync::{mpsc, watch};

const CHATS: usize = 16;
const ANSWERS: usize = 32;
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
    QuestionDelayedReceipt,
    QuestionInputProbe,
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
            Self::QuestionDelayedReceipt => "question",
            Self::QuestionInputProbe => "question",
            Self::Steps => "steps",
        }
    }
}
fn refused(message: &str) -> ProviderError {
    ProviderError::new(ProviderErrorKind::Refused, message)
}
fn unknown() -> ProviderError {
    ProviderError::new(
        ProviderErrorKind::Other,
        "The agent has not confirmed delivery of this answer.",
    )
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
    answers: Mutex<HashSet<(String, AnswerId)>>,
    workers: Mutex<usize>,
    observations: Mutex<VecDeque<NativeObservation>>,
    input_probe: Mutex<Option<Value>>,
    drained: Condvar,
    cleanup_failed: AtomicBool,
}
impl Shared {
    fn emit(&self, event: ProviderEvent, terminal: bool) -> bool {
        let bytes = match &event {
            ProviderEvent::Agent { event, .. } => event.0.to_string().len() + 1024,
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
        if q.items.len() >= EVENTS + CHATS * 3 + ANSWERS {
            self.failed.store(true, Ordering::Release);
            return false;
        }
        q.bytes += bytes;
        q.items.push_back(event);
        if q.items.len() >= EVENTS || q.bytes >= BYTES {
            self.failed.store(true, Ordering::Release);
        }
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
            .wait_timeout_while(count, timeout, |n| {
                *n != 0 && !self.shared.cleanup_failed.load(Ordering::Acquire)
            })
            .unwrap()
            .0
            == 0
    }
    /// Wait for actual worker drainage even after cleanup failure was reported.
    pub(crate) fn wait_drained(&self, timeout: Duration) -> bool {
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
    /// Selected frames reported by the Node fake itself; only QuestionInputProbe records them.
    /// At most one snapshot, capped at 4 MiB, is retained. Never enabled for a real provider.
    pub fn native_input_probe(&self) -> Option<Value> {
        self.shared.input_probe.lock().unwrap().clone()
    }
    /// A cleanup deadline was exceeded. Resources remain owned until reaping completes.
    /// This latch is distinct from `workers() == 0`; a timeout never means stopped.
    pub fn cleanup_failed(&self) -> bool {
        self.shared.cleanup_failed.load(Ordering::Acquire)
    }
    pub fn workers(&self) -> usize {
        *self.shared.workers.lock().unwrap()
    }
}
struct Slot {
    commands: mpsc::Sender<Start>,
    answers: mpsc::Sender<Reply>,
    close: watch::Sender<bool>,
    interrupt: watch::Sender<u64>,
    active: Arc<AtomicBool>,
    done: Arc<AtomicBool>,
    latest: Arc<AtomicU64>,
    native_thread: Arc<Mutex<Option<String>>>,
}
enum ReplyKind {
    Permission(codex::approvals::Decision),
    Question(codex::approvals::QuestionOutcome),
}
struct Reply {
    turn: TurnId,
    request_id: String,
    kind: ReplyKind,
    guard: ReplyGuard,
}
struct ReplyGuard {
    shared: Arc<Shared>,
    chat: String,
    id: Option<AnswerId>,
    entered: bool,
}
impl ReplyGuard {
    fn settle(mut self, outcome: AnswerOutcome) {
        if let Some(answer) = self.id.take() {
            self.shared.emit(
                ProviderEvent::AnswerSettled {
                    chat: self.chat.clone(),
                    answer,
                    outcome,
                },
                true,
            );
        }
    }
    fn refuse(mut self) {
        if let Some(id) = self.id.take() {
            self.shared
                .answers
                .lock()
                .unwrap()
                .remove(&(self.chat.clone(), id));
        }
    }
}
impl Drop for ReplyGuard {
    fn drop(&mut self) {
        if let Some(answer) = self.id.take() {
            self.shared.emit(
                ProviderEvent::AnswerSettled {
                    chat: self.chat.clone(),
                    answer,
                    outcome: if self.entered {
                        AnswerOutcome::Uncertain(unknown())
                    } else {
                        AnswerOutcome::Failed(failed())
                    },
                },
                true,
            );
        }
    }
}
struct Start {
    id: TurnId,
    request: Value,
}
struct Worker {
    _root_lifetime: Option<Arc<dyn Send + Sync>>,
    shared: Arc<Shared>,
    profile: Arc<IsolatedProfile>,
    project: PathBuf,
    node: PathBuf,
    configured: Option<Arc<crate::configured_codex::CodexLaunchContext>>,
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
    configured: Option<Arc<crate::configured_codex::CodexLaunchContext>>,
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
            configured: None,
            scenario,
            shared: Arc::new(Shared {
                queue: Mutex::new(Queue {
                    items: VecDeque::new(),
                    bytes: 0,
                }),
                failed: AtomicBool::new(false),
                answers: Mutex::new(HashSet::new()),
                workers: Mutex::new(0),
                observations: Mutex::new(VecDeque::new()),
                input_probe: Mutex::new(None),
                drained: Condvar::new(),
                cleanup_failed: AtomicBool::new(false),
            }),
            slots: HashMap::new(),
            closed: false,
        })
    }
    /// Attach the existing bounded bridge to an explicitly owned persistent Project.
    /// Nothing is seeded and no provider process starts before an admitted turn.
    #[allow(dead_code)] // Connected by the dedicated owner entrypoint, never public wire input.
    pub(crate) fn configured(
        context: crate::configured_codex::CodexLaunchContext,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        context.validate()?;
        let profile = Arc::new(IsolatedProfile::create()?);
        Ok(Self {
            profile,
            isolation: context.isolation.clone(),
            project: context.project.clone(),
            node: context.program.clone(),
            configured: Some(Arc::new(context)),
            scenario: Scenario::Reply,
            shared: Arc::new(Shared {
                queue: Mutex::new(Queue {
                    items: VecDeque::new(),
                    bytes: 0,
                }),
                failed: AtomicBool::new(false),
                answers: Mutex::new(HashSet::new()),
                workers: Mutex::new(0),
                observations: Mutex::new(VecDeque::new()),
                input_probe: Mutex::new(None),
                drained: Condvar::new(),
                cleanup_failed: AtomicBool::new(false),
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
    fn enqueue_answer(
        &self,
        chat: &str,
        turn: TurnId,
        answer: AnswerId,
        request_id: &str,
        kind: ReplyKind,
    ) -> Result<(), ProviderError> {
        if self.closed || self.shared.failed.load(Ordering::Acquire) {
            return Err(refused("The fixture provider is closed"));
        }
        if let Some(context) = &self.configured {
            context
                .validate()
                .map_err(|_| refused("Codex launch authority was revoked"))?;
        }
        let slot = self
            .slots
            .get(chat)
            .filter(|s| {
                !s.done.load(Ordering::Acquire) && s.latest.load(Ordering::Acquire) == turn.0
            })
            .ok_or_else(|| refused("The fixture session generation is gone"))?;
        if request_id.len() > 4096 {
            return Err(refused("Invalid fixture request identity"));
        }
        {
            let mut pending = self.shared.answers.lock().unwrap();
            if pending.len() >= ANSWERS || !pending.insert((chat.into(), answer)) {
                return Err(refused("The fixture answer queue is full or duplicated"));
            }
        }
        let native_id = request_id.to_owned();
        let reply = Reply {
            turn,
            request_id: native_id,
            kind,
            guard: ReplyGuard {
                shared: self.shared.clone(),
                chat: chat.into(),
                id: Some(answer),
                entered: false,
            },
        };
        if let Err(error) = slot.answers.try_send(reply) {
            error.into_inner().guard.refuse();
            return Err(refused("The fixture answer lane is full or closed"));
        }
        Ok(())
    }
    fn validate(&self, id: TurnId, request: &Value) -> Result<String, ProviderError> {
        if self.closed || self.shared.failed.load(Ordering::Acquire) {
            return Err(refused("The fixture provider is closed"));
        }
        if id.0 == 0 || request.to_string().len() > REQUEST_BYTES {
            return Err(refused("Invalid or oversized fixture turn"));
        }
        if let Some(context) = &self.configured {
            context
                .validate()
                .map_err(|_| refused("Codex launch authority was revoked"))?;
            // React forwards its Claude reply preference to every provider. Node's
            // Codex beginTurn has no replies parameter; contract-valid styles have
            // no Codex-native effect (pinned by the actual Node turn oracle).
            if request.get("replies").is_some_and(|value| {
                !value.is_null() && !matches!(value.as_str(), Some("concise" | "normal"))
            }) {
                return Err(refused("Codex reply preference must be concise or normal"));
            }
            if request
                .get("tldrEnabled")
                .is_some_and(|v| !v.is_null() && !v.is_boolean())
            {
                return Err(refused("Codex TLDR selection must be boolean"));
            }
            if request["model"] != context.model
                || request
                    .get("tldrEnabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(true)
                    != context.tldr_enabled
            {
                return Err(refused(
                    "Codex model/instruction selection differs from captured launch",
                ));
            }
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
        if request.get("permissionMode").is_some_and(|v| {
            !v.is_null()
                && (!matches!(v.as_str(), Some("ask" | "auto" | "full"))
                    || (self.configured.is_none() && v != "ask"))
        }) {
            return Err(refused("Unsupported or mistyped Codex permission mode"));
        }
        for key in ["ultracode", "fastMode", "tldrEnabled"] {
            if key == "tldrEnabled" && self.configured.is_some() {
                continue;
            }
            if request.get(key).is_some_and(|v| !v.is_null() && v != false) {
                return Err(refused(
                    "Instruction and policy assembly is not implemented by the fixture bridge",
                ));
            }
        }
        for key in ["images", "replies"] {
            if key == "replies" && self.configured.is_some() {
                continue;
            }
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
    fn start_turn(&mut self, id: TurnId, request: &RawJson) -> Result<(), ProviderError> {
        let request = &request.0;
        let chat = self.validate(id, request)?;
        let native_request = request.clone();
        let existing = self.slots.contains_key(&chat);
        if !existing {
            if *self.shared.workers.lock().unwrap() >= CHATS {
                return Err(refused("The fixture session limit is full"));
            }
            let (commands, rx) = mpsc::channel(1);
            let (answers, answers_rx) = mpsc::channel(8);
            let (close, close_rx) = watch::channel(false);
            let (interrupt, interrupt_rx) = watch::channel(0);
            let active = Arc::new(AtomicBool::new(false));
            let done = Arc::new(AtomicBool::new(false));
            let latest = Arc::new(AtomicU64::new(0));
            let native_thread = Arc::new(Mutex::new(None));
            let worker = Worker {
                _root_lifetime: self
                    .configured
                    .as_ref()
                    .map(|context| context.lifetime.clone()),
                shared: self.shared.clone(),
                profile: self.profile.clone(),
                project: self.project.clone(),
                node: self.node.clone(),
                configured: self.configured.clone(),
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
                    match tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                    {
                        Ok(runtime) => {
                            runtime.block_on(async {
                                worker.run(rx, answers_rx, close_rx, interrupt_rx).await;
                                // Dropping a cancelled startup signals its process, but the
                                // detached supervisor still owns wait/reaping. Keep this private
                                // executor and profile alive until its tasks really drain.
                                crate::executor::drain(&runtime, Duration::from_secs(3), || {
                                    worker.shared.failed.store(true, Ordering::Release);
                                    let _count = worker.shared.workers.lock().unwrap();
                                    worker.shared.cleanup_failed.store(true, Ordering::Release);
                                    worker.shared.drained.notify_all();
                                })
                                .await;
                            });
                        }
                        Err(_) => {
                            // Construction can fail after synchronous admission. Settle that
                            // accepted request instead of leaving the owner's starting run open.
                            drop(answers_rx);
                            let mut rx = rx;
                            if let Some(start) = rx.blocking_recv() {
                                worker.shared.emit(
                                    ProviderEvent::StartFailed {
                                        chat: worker.chat.clone(),
                                        turn: start.id,
                                        error: failed(),
                                    },
                                    true,
                                );
                                worker.exit(start.id);
                            }
                        }
                    }
                })
                .map_err(|_| failed())?;
            self.slots.insert(
                chat.clone(),
                Slot {
                    commands,
                    answers,
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
    fn respond_permission(
        &mut self,
        chat: &str,
        turn: TurnId,
        answer: AnswerId,
        request_id: &str,
        decision: &str,
    ) -> Result<(), ProviderError> {
        let decision = codex::approvals::Decision::parse(decision)
            .ok_or_else(|| refused("Invalid permission decision"))?;
        if matches!(decision, codex::approvals::Decision::Cancelled) {
            return Err(refused("Invalid permission decision"));
        }
        self.enqueue_answer(
            chat,
            turn,
            answer,
            request_id,
            ReplyKind::Permission(decision),
        )
    }
    fn answer_question(
        &mut self,
        chat: &str,
        turn: TurnId,
        answer: AnswerId,
        request_id: &str,
        answers: &RawJson,
    ) -> Result<(), ProviderError> {
        let answers = &answers.0;
        if answers.to_string().len() > REQUEST_BYTES {
            return Err(refused("Oversized fixture answer"));
        }
        let outcome = if answers.is_null() {
            codex::approvals::QuestionOutcome::Dismissed
        } else {
            let map = answers
                .as_object()
                .filter(|m| m.len() <= 10)
                .ok_or_else(|| refused("Invalid fixture answers"))?;
            let mut values = Vec::new();
            for (id, items) in map {
                let items = items
                    .as_array()
                    .filter(|v| v.len() <= 20)
                    .ok_or_else(|| refused("Invalid fixture answers"))?;
                let mut strings = Vec::new();
                for value in items {
                    let text = value
                        .as_str()
                        .filter(|v| v.encode_utf16().count() <= 10000)
                        .ok_or_else(|| refused("Invalid fixture answer text"))?;
                    strings.push(text.to_owned());
                }
                let native_id = id.clone();
                values.push((native_id, strings));
            }
            codex::approvals::QuestionOutcome::Answered(values)
        };
        self.enqueue_answer(chat, turn, answer, request_id, ReplyKind::Question(outcome))
    }
    fn close_chat(&mut self, chat: &str, turn: TurnId) -> Result<(), ProviderError> {
        if self
            .slots
            .get(chat)
            .is_some_and(|slot| slot.latest.load(Ordering::Acquire) == turn.0)
        {
            if let Some(slot) = self.slots.remove(chat) {
                slot.close.send_replace(true);
            }
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
        let events: Vec<_> = q.items.drain(..).collect();
        let mut answers = self.shared.answers.lock().unwrap();
        for event in &events {
            if let ProviderEvent::AnswerSettled { chat, answer, .. } = event {
                answers.remove(&(chat.clone(), *answer));
            }
        }
        events
    }
}
impl Drop for CodexFixture {
    fn drop(&mut self) {
        self.shutdown();
    }
}

impl Worker {
    fn agent(&self, id: TurnId, event: Value, terminal: bool) -> bool {
        if !terminal
            && self
                .configured
                .as_ref()
                .is_some_and(|c| c.validate().is_err())
        {
            return false;
        }
        self.shared.emit(
            ProviderEvent::Agent {
                chat: self.chat.clone(),
                turn: id,
                event: RawJson(event),
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
        &self,
        mut commands: mpsc::Receiver<Start>,
        mut answers: mpsc::Receiver<Reply>,
        mut close: watch::Receiver<bool>,
        mut interrupt: watch::Receiver<u64>,
    ) {
        let first = tokio::select! { biased;
            _=close.changed()=> {
                drop(answers);
                if let Ok(start)=commands.try_recv() {
                    self.shared.emit(ProviderEvent::StartFailed{chat:self.chat.clone(),turn:start.id,error:failed()},true);
                    self.exit(start.id);
                }
                return;
            },
            command=commands.recv()=>match command {Some(c)=>c,None=>return}
        };
        let mut latest = first.id;
        if self
            .configured
            .as_ref()
            .is_some_and(|c| c.validate().is_err())
        {
            self.shared.emit(
                ProviderEvent::StartFailed {
                    chat: self.chat.clone(),
                    turn: latest,
                    error: refused("Codex launch authority was revoked"),
                },
                true,
            );
            self.exit(latest);
            return;
        }
        let home = self.profile.path().join("home");
        let fixture_spawn = codex::SpawnOptions::new(&self.node)
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
        let spawn = match &self.configured {
            Some(context) => match context.spawn() {
                Ok(spawn) => spawn,
                Err(_) => {
                    self.shared.emit(
                        ProviderEvent::StartFailed {
                            chat: self.chat.clone(),
                            turn: latest,
                            error: refused("Codex launch authority was revoked"),
                        },
                        true,
                    );
                    self.exit(latest);
                    return;
                }
            },
            None => fixture_spawn,
        };
        let cwd = self.project.to_string_lossy().to_string();
        let first_mode = permission_mode(&first.request);
        let policy = codex::codex_policy(first_mode, &cwd, &[], false, false);
        let mut options =
            codex::SessionOptions::new(codex::ConnectOptions::new(spawn, "fixture"), cwd);
        options.resume_thread_id = first.request["resumeId"].as_str().map(str::to_owned);
        options.interrupt_grace = if self.configured.is_some() {
            Duration::from_secs(3)
        } else {
            Duration::from_millis(200)
        };
        options.event_queue = milagre_providers::queue::QueueLimits {
            max_events: 128,
            max_bytes: BYTES,
        };
        let mut thread = chat_thread(
            first.request["model"].as_str().map(str::to_owned),
            policy.clone(),
        );
        if let Some(context) = &self.configured {
            thread.developer_instructions = Some(context.developer_instructions.clone());
        }
        let startup = CodexSession::start(options, thread);
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
                drop(answers);
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
        let mut reply_tasks = tokio::task::JoinSet::new();
        let mut pending = Some(first);
        let mut running = false;
        let mut native: Option<String> = None;
        loop {
            if let Some(start) = pending.take() {
                latest = start.id;
                if *close.borrow()
                    || *interrupt.borrow() == latest.0
                    || self
                        .configured
                        .as_ref()
                        .is_some_and(|c| c.validate().is_err())
                {
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
                    codex::codex_policy(
                        permission_mode(&start.request),
                        &self.project.to_string_lossy(),
                        &[],
                        false,
                        false,
                    ),
                );
                settings.effort = start.request["effort"].as_str().map(str::to_owned);
                settings.permission_mode = Some(permission_mode(&start.request));
                let result = tokio::select! { biased; _=close.changed()=>None, _=interrupt.changed()=>None, result=session.send(settings)=>Some(result) };
                match result {
                    Some(Ok(outcome)) => {
                        if self
                            .configured
                            .as_ref()
                            .is_some_and(|c| c.validate().is_err())
                        {
                            break;
                        }
                        native = outcome.turn_id.clone();
                        running = true;
                        if matches!(self.scenario, Scenario::QuestionInputProbe) {
                            tokio::select! {biased; _=close.changed()=>break, _=probe_inputs(&session,&self.shared,&self.chat)=>{}}
                        }
                        if !self.shared.emit(
                            ProviderEvent::Started {
                                chat: self.chat.clone(),
                                turn: latest,
                                result: RawJson(
                                    json!({"turnId":outcome.turn_id,"steered":outcome.steered}),
                                ),
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
                event=events.recv()=>match event.filter(|_|self.configured.as_ref().is_none_or(|context|context.validate().is_ok())) {
                    Some(SessionEvent::Agent(event))=> {
                        if !self.agent(latest,event,false) { break; }
                    }
                    Some(SessionEvent::TurnEnded{turn_id,event,..})=> {
                        if running && (native.is_none() || native==turn_id) {
                            self.agent(latest,event,true); running=false;
                            self.active.store(false,Ordering::Release);
                            if self.shared.failed.load(Ordering::Acquire) {break;}
                        }
                    }
                    Some(SessionEvent::Exited(_))|None=>break,
                    Some(SessionEvent::Notification(_))=>{}
                },
                reply=answers.recv(), if reply_tasks.len()<8=> if let Some(reply)=reply {
                    if reply.turn!=latest {reply.guard.settle(AnswerOutcome::NotWaiting);} else {
                        let session=session.clone();
                        let configured=self.configured.clone();
                        let delayed_receipt=matches!(self.scenario,Scenario::QuestionDelayedReceipt);
                        let probe=matches!(self.scenario,Scenario::QuestionInputProbe).then(||(self.shared.clone(),self.chat.clone()));
                        reply_tasks.spawn(async move {
                            let mut guard=reply.guard;
                            if configured.as_ref().is_some_and(|context|context.validate().is_err()) { guard.settle(AnswerOutcome::Failed(refused("Codex launch authority was revoked"))); return; }
                            guard.entered=true;
                            let result=match reply.kind {
                                ReplyKind::Permission(decision)=>session.respond_to_permission(&reply.request_id,decision).await,
                                ReplyKind::Question(outcome)=>session.answer_question(&reply.request_id,outcome).await,
                            };
                            if let Some((shared,chat))=probe {probe_inputs(&session,&shared,&chat).await;}
                            // Deterministic fixture: the native frame is written before receipt
                            // publication is delayed. Cancellation here must retain uncertainty.
                            if delayed_receipt && matches!(result,Ok(true)) {tokio::time::sleep(Duration::from_millis(400)).await;}
                            guard.settle(match result {Ok(true)=>AnswerOutcome::Accepted,Ok(false)=>AnswerOutcome::NotWaiting,Err(_)=>AnswerOutcome::Uncertain(unknown())});
                        });
                    }
                },
                _=reply_tasks.join_next(), if !reply_tasks.is_empty()=>{},
                command=commands.recv()=>match command { Some(command)=>pending=Some(command),None=>break }
            }
        }
        answers.close();
        while let Ok(reply) = answers.try_recv() {
            drop(reply);
        }
        reply_tasks.abort_all();
        while reply_tasks.join_next().await.is_some() {}
        if running {
            self.agent(latest,json!({"type":"turn-failed","message":"The isolated Codex fixture session stopped"}),true);
        }
        session.close().await;
        self.exit(latest);
    }
}

/// This endpoint exists only in the checked-in Node fake. Record selected native frames,
/// never the whole growing transcript or environment, and retain at most one bounded snapshot.
async fn probe_inputs(session: &CodexSession, shared: &Shared, chat: &str) {
    let Ok(result) = session
        .client()
        .rpc()
        .request_with_timeout("fake/received", json!({}), Some(Duration::from_millis(500)))
        .await
    else {
        return;
    };
    let Some(received) = result["received"].as_array() else {
        return;
    };
    let input = received
        .iter()
        .rev()
        .find(|frame| frame["method"] == "turn/start")
        .map(|frame| frame["params"]["input"].clone());
    let answer = received
        .iter()
        .rev()
        .find(|frame| frame.get("method").is_none() && frame.get("result").is_some())
        .cloned();
    let selected = json!({"chat":chat,"input":input,"answer":answer});
    if selected.to_string().len() <= BYTES {
        *shared.input_probe.lock().unwrap() = Some(selected);
    }
}

// Requests are typed before enqueue. Null/absent uses Node's ordinary Ask default.
fn permission_mode(request: &Value) -> codex::PermissionMode {
    request["permissionMode"]
        .as_str()
        .and_then(codex::PermissionMode::parse)
        .unwrap_or(codex::PermissionMode::Ask)
}

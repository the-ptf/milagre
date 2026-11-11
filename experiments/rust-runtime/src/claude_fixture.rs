//! Nonblocking owner adapter restricted to the checked-in scripted Claude CLI.
//! There is no public executable, environment, live profile, role or MCP configuration.
use milagre_claude::{ClaudeSession, LaunchOptions, SessionOptions, TurnRequest};
use milagre_owner_store::{
    chat_host::{
        AnswerId, AnswerOutcome, Provider, ProviderError, ProviderErrorKind, ProviderEvent, TurnId,
    },
    jsjson::RawJson,
    Isolation, Policy,
};
use milagre_owner_wire::IsolatedProfile;
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
#[derive(Clone, Copy, Debug)]
pub enum Scenario {
    Reply,
    Permission,
    Question,
    Stop,
    Crash,
    HangInitialize,
    QuestionDelayedReceipt,
    Subagent,
    Unicode,
}
fn refused(text: &str) -> ProviderError {
    ProviderError::new(ProviderErrorKind::Refused, text)
}
fn failed() -> ProviderError {
    ProviderError::new(
        ProviderErrorKind::Other,
        "The isolated Claude fixture session stopped",
    )
}
fn uncertain() -> ProviderError {
    ProviderError::new(
        ProviderErrorKind::Other,
        "The agent has not confirmed delivery of this answer.",
    )
}
fn terminal(event: &Value) -> bool {
    matches!(
        event["type"].as_str(),
        Some("turn-completed" | "turn-cancelled" | "turn-failed")
    )
}
struct Queue {
    events: VecDeque<ProviderEvent>,
    bytes: usize,
}
struct Shared {
    queue: Mutex<Queue>,
    failed: AtomicBool,
    cleanup_failed: AtomicBool,
    workers: Mutex<usize>,
    drained: Condvar,
    pending: Mutex<HashSet<(String, AnswerId)>>,
    pids: Mutex<HashMap<String, u32>>,
}
impl Shared {
    fn emit(&self, event: ProviderEvent, reserved: bool) -> bool {
        let size = match &event {
            ProviderEvent::Agent { event, .. } => event.0.to_string().len() + 1024,
            _ => 1024,
        };
        let mut q = self.queue.lock().unwrap();
        if (!reserved
            && (self.failed.load(Ordering::Acquire)
                || q.events.len() >= EVENTS
                || q.bytes.saturating_add(size) > BYTES))
            || q.events.len() >= EVENTS + CHATS * 3 + ANSWERS
        {
            self.failed.store(true, Ordering::Release);
            return false;
        }
        q.bytes += size;
        q.events.push_back(event);
        true
    }
}
#[derive(Clone)]
pub struct FixtureMonitor {
    shared: Arc<Shared>,
    _profile: Arc<IsolatedProfile>,
}
impl FixtureMonitor {
    pub fn workers(&self) -> usize {
        *self.shared.workers.lock().unwrap()
    }
    pub fn cleanup_failed(&self) -> bool {
        self.shared.cleanup_failed.load(Ordering::Acquire)
    }
    pub fn pid(&self, chat: &str) -> Option<u32> {
        self.shared.pids.lock().unwrap().get(chat).copied()
    }
    pub fn wait_stopped(&self, timeout: Duration) -> bool {
        let n = self.shared.workers.lock().unwrap();
        *self
            .shared
            .drained
            .wait_timeout_while(n, timeout, |n| *n != 0 && !self.cleanup_failed())
            .unwrap()
            .0
            == 0
    }
}
struct Start {
    id: TurnId,
    request: Value,
}
enum Answer {
    Permission(String),
    Question(Value),
}
struct Reply {
    turn: TurnId,
    request: String,
    answer: Answer,
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
                .pending
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
                        AnswerOutcome::Uncertain(uncertain())
                    } else {
                        AnswerOutcome::Failed(failed())
                    },
                },
                true,
            );
        }
    }
}
struct Slot {
    start: mpsc::Sender<Start>,
    answers: mpsc::Sender<Reply>,
    close: watch::Sender<bool>,
    interrupt: watch::Sender<u64>,
    active: Arc<AtomicBool>,
    done: Arc<AtomicBool>,
    latest: Arc<AtomicU64>,
    native_id: Arc<Mutex<Option<String>>>,
}
struct Worker {
    shared: Arc<Shared>,
    _profile: Arc<IsolatedProfile>,
    project: PathBuf,
    program: PathBuf,
    script: PathBuf,
    chat: String,
    scenario: Scenario,
    active: Arc<AtomicBool>,
    done: Arc<AtomicBool>,
    native_id: Arc<Mutex<Option<String>>>,
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
        self.done.store(true, Ordering::Release);
        *self.shared.workers.lock().unwrap() -= 1;
        self.shared.drained.notify_all();
    }
}
/// The only constructor creates a private fixture copy and locates a fixed Cargo helper sibling.
pub struct ClaudeFixture {
    profile: Arc<IsolatedProfile>,
    isolation: Isolation,
    project: PathBuf,
    program: PathBuf,
    script: PathBuf,
    scenario: Scenario,
    shared: Arc<Shared>,
    slots: HashMap<String, Slot>,
    closed: bool,
}
impl ClaudeFixture {
    pub fn create(scenario: Scenario) -> Result<Self, Box<dyn std::error::Error>> {
        let profile = Arc::new(IsolatedProfile::create()?);
        let isolation = Isolation::create(profile.path(), &Policy::system())?;
        let project = isolation.project(Path::new("fixture"))?;
        std::fs::create_dir(project.join(".milagre"))?;
        std::fs::write(project.join(".milagre/coordination.json"),json!({"next_id":10,"name":"Claude fixture","worktrees":{"1":{"id":1,"path":project,"name":"main"}},"sessions":{"1":{"id":1,"worktree_id":1},"2":{"id":2,"worktree_id":1}},"messages":[]}).to_string())?;
        std::fs::create_dir(profile.path().join("home"))?;
        let exe = std::env::current_exe()?;
        let mut dir = exe.parent().ok_or("Missing fixture executable parent")?;
        if dir.file_name().is_some_and(|n| n == "deps") {
            dir = dir.parent().ok_or("Missing Cargo target directory")?;
        }
        let program = dir.join("runtime-fake-claude").canonicalize()?;
        let script = profile.path().join("claude-script.json");
        std::fs::write(&script, script_for(scenario).to_string())?;
        Ok(Self {
            profile,
            isolation,
            project,
            program,
            script,
            scenario,
            shared: Arc::new(Shared {
                queue: Mutex::new(Queue {
                    events: VecDeque::new(),
                    bytes: 0,
                }),
                failed: AtomicBool::new(false),
                cleanup_failed: AtomicBool::new(false),
                workers: Mutex::new(0),
                drained: Condvar::new(),
                pending: Mutex::new(HashSet::new()),
                pids: Mutex::new(HashMap::new()),
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
    fn open(&self) -> Result<(), ProviderError> {
        if self.closed || self.shared.failed.load(Ordering::Acquire) {
            Err(refused("The fixture provider is closed"))
        } else {
            Ok(())
        }
    }
    fn answer(
        &mut self,
        chat: &str,
        turn: TurnId,
        id: AnswerId,
        request: &str,
        answer: Answer,
    ) -> Result<(), ProviderError> {
        self.open()?;
        let slot = self
            .slots
            .get(chat)
            .filter(|s| {
                !s.done.load(Ordering::Acquire) && s.latest.load(Ordering::Acquire) == turn.0
            })
            .ok_or_else(|| refused("The fixture session generation is gone"))?;
        if request.encode_utf16().count() > 4096 {
            return Err(refused("Invalid fixture identity"));
        }
        let request = request.to_owned();
        let mut pending = self.shared.pending.lock().unwrap();
        if pending.len() >= ANSWERS || !pending.insert((chat.into(), id)) {
            return Err(refused("The fixture answer lane is full or duplicated"));
        }
        drop(pending);
        let reply = Reply {
            turn,
            request,
            answer,
            guard: ReplyGuard {
                shared: self.shared.clone(),
                chat: chat.into(),
                id: Some(id),
                entered: false,
            },
        };
        if let Err(e) = slot.answers.try_send(reply) {
            e.into_inner().guard.refuse();
            return Err(refused("The fixture answer lane is full or closed"));
        }
        Ok(())
    }
}
fn native_request(request: &Value, project: &Path) -> Result<Value, ProviderError> {
    if request.to_string().len() > 1024 * 1024 {
        return Err(refused("Oversized fixture turn"));
    }
    let fields = request
        .as_object()
        .ok_or_else(|| refused("Expected a turn object"))?;
    for key in fields.keys() {
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
    if request["provider"] != "claude" || request["cwd"].as_str() != project.to_str() {
        return Err(refused(
            "Only this isolated Claude fixture Project is admitted",
        ));
    }
    if request
        .get("permissionMode")
        .is_some_and(|v| !v.is_null() && v != "ask")
    {
        return Err(refused("Only ordinary Ask mode is implemented"));
    }
    for key in ["ultracode", "fastMode", "tldrEnabled"] {
        if request.get(key).is_some_and(|v| !v.is_null() && v != false) {
            return Err(refused("Instruction and policy assembly is unsupported"));
        }
    }
    for key in ["images", "replies"] {
        if request
            .get(key)
            .is_some_and(|v| !v.is_null() && v.as_array().is_none_or(|a| !a.is_empty()))
        {
            return Err(refused("Images and replies are unsupported"));
        }
    }
    if !request["prompt"].is_string() {
        return Err(refused("Expected text prompt"));
    }
    let native = request.clone();
    let chat = native["chatId"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 4096)
        .ok_or_else(|| refused("Invalid Chat identity"))?;
    let _ = chat;
    for key in ["model", "effort", "resumeId"] {
        if native
            .get(key)
            .is_some_and(|v| !v.is_null() && !v.is_string())
        {
            return Err(refused("Invalid fixture turn setting"));
        }
    }
    Ok(native)
}
impl Provider for ClaudeFixture {
    fn name(&self) -> &str {
        "claude"
    }
    fn start_turn(&mut self, id: TurnId, request: &RawJson) -> Result<(), ProviderError> {
        let request = &request.0;
        self.open()?;
        if id.0 == 0 {
            return Err(refused("Invalid turn generation"));
        }
        let native = native_request(request, &self.project)?;
        let chat = request["chatId"].as_str().unwrap().to_owned();
        self.slots
            .retain(|_, slot| !slot.done.load(Ordering::Acquire));
        self.shared
            .pids
            .lock()
            .unwrap()
            .retain(|chat, _| self.slots.contains_key(chat));
        if !self.slots.contains_key(&chat) {
            if *self.shared.workers.lock().unwrap() >= CHATS {
                return Err(refused("The fixture Chat limit was reached"));
            }
            let (start, rx) = mpsc::channel(1);
            let (answers, answers_rx) = mpsc::channel(8);
            let (close, close_rx) = watch::channel(false);
            let (interrupt, interrupt_rx) = watch::channel(0);
            let active = Arc::new(AtomicBool::new(false));
            let done = Arc::new(AtomicBool::new(false));
            let latest = Arc::new(AtomicU64::new(0));
            let native_id = Arc::new(Mutex::new(None));
            let worker = Worker {
                shared: self.shared.clone(),
                _profile: self.profile.clone(),
                project: self.project.clone(),
                program: self.program.clone(),
                script: self.script.clone(),
                chat: chat.clone(),
                scenario: self.scenario,
                active: active.clone(),
                done: done.clone(),
                native_id: native_id.clone(),
            };
            *self.shared.workers.lock().unwrap() += 1;
            std::thread::Builder::new()
                .name("claude-fixture".into())
                .spawn(move || {
                    match tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                    {
                        Ok(runtime) => runtime.block_on(async {
                            worker.run(rx, answers_rx, close_rx, interrupt_rx).await;
                            crate::executor::drain(&runtime, Duration::from_secs(3), || {
                                worker.shared.failed.store(true, Ordering::Release);
                                let _n = worker.shared.workers.lock().unwrap();
                                worker.shared.cleanup_failed.store(true, Ordering::Release);
                                worker.shared.drained.notify_all();
                            })
                            .await;
                        }),
                        Err(_) => {
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
                    start,
                    answers,
                    close,
                    interrupt,
                    active,
                    done,
                    latest,
                    native_id,
                },
            );
        }
        let slot = self.slots.get(&chat).unwrap();
        if let Some(resume) = native["resumeId"].as_str() {
            if slot
                .native_id
                .lock()
                .unwrap()
                .as_deref()
                .is_some_and(|current| current != resume)
            {
                return Err(refused(
                    "Close the previous fixture session before resuming another native session",
                ));
            }
        }
        if *slot.close.borrow() {
            return Err(refused("The fixture session is closing"));
        }
        if slot.active.swap(true, Ordering::AcqRel) {
            return Err(refused(
                "Steering is not implemented by this fixture adapter",
            ));
        }
        slot.latest.store(id.0, Ordering::Release);
        if slot
            .start
            .try_send(Start {
                id,
                request: native,
            })
            .is_err()
        {
            slot.active.store(false, Ordering::Release);
            return Err(failed());
        }
        Ok(())
    }
    fn interrupt(&mut self, chat: &str, turn: TurnId) -> Result<(), ProviderError> {
        let s = self
            .slots
            .get(chat)
            .filter(|s| {
                s.latest.load(Ordering::Acquire) == turn.0 && !s.done.load(Ordering::Acquire)
            })
            .ok_or_else(|| refused("The fixture session generation is gone"))?;
        s.interrupt.send_replace(turn.0);
        Ok(())
    }
    fn close_chat(&mut self, chat: &str, turn: TurnId) -> Result<(), ProviderError> {
        let s = self
            .slots
            .get(chat)
            .filter(|s| s.latest.load(Ordering::Acquire) == turn.0)
            .ok_or_else(|| refused("The fixture session generation is gone"))?;
        s.close.send_replace(true);
        Ok(())
    }
    fn respond_permission(
        &mut self,
        chat: &str,
        turn: TurnId,
        answer: AnswerId,
        request: &str,
        decision: &str,
    ) -> Result<(), ProviderError> {
        if !["allow", "deny", "allow-for-chat"].contains(&decision) {
            return Err(refused("Invalid permission decision"));
        }
        self.answer(
            chat,
            turn,
            answer,
            request,
            Answer::Permission(decision.into()),
        )
    }
    fn answer_question(
        &mut self,
        chat: &str,
        turn: TurnId,
        answer: AnswerId,
        request: &str,
        answers: &RawJson,
    ) -> Result<(), ProviderError> {
        let answers = &answers.0;
        if answers.to_string().len() > 1024 * 1024 {
            return Err(refused("Oversized question answer"));
        }
        if answers.is_null() {
            return self.answer(chat, turn, answer, request, Answer::Question(Value::Null));
        }
        let mut native = serde_json::Map::new();
        for (key, value) in answers
            .as_object()
            .ok_or_else(|| refused("Expected question answer map"))?
        {
            let key = key.clone();
            let values = value
                .as_array()
                .ok_or_else(|| refused("Expected answer list"))?;
            let mut out = Vec::new();
            for value in values {
                let text = value
                    .as_str()
                    .ok_or_else(|| refused("Expected answer text"))?;
                out.push(json!(text));
            }
            native.insert(key, json!(out));
        }
        self.answer(
            chat,
            turn,
            answer,
            request,
            Answer::Question(Value::Object(native)),
        )
    }
    fn shutdown(&mut self) {
        self.closed = true;
        for slot in self.slots.values() {
            slot.close.send_replace(true);
        }
    }
    fn take_events(&mut self) -> Vec<ProviderEvent> {
        let mut q = self.shared.queue.lock().unwrap();
        let events: Vec<_> = q.events.drain(..).collect();
        q.bytes = 0;
        drop(q);
        let mut pending = self.shared.pending.lock().unwrap();
        for e in &events {
            if let ProviderEvent::AnswerSettled { chat, answer, .. } = e {
                pending.remove(&(chat.clone(), *answer));
            }
        }
        events
    }
}
impl Drop for ClaudeFixture {
    fn drop(&mut self) {
        self.shutdown();
    }
}
impl Worker {
    fn agent(&self, id: TurnId, event: Value, reserved: bool) -> bool {
        self.shared.emit(
            ProviderEvent::Agent {
                chat: self.chat.clone(),
                turn: id,
                event: RawJson(event),
            },
            reserved,
        )
    }
    fn exit(&self, id: TurnId) {
        self.shared.emit(
            ProviderEvent::Exited {
                chat: self.chat.clone(),
                turn: id,
                error: failed(),
            },
            true,
        );
    }
    async fn run(
        &self,
        mut starts: mpsc::Receiver<Start>,
        mut answers: mpsc::Receiver<Reply>,
        mut close: watch::Receiver<bool>,
        mut interrupt: watch::Receiver<u64>,
    ) {
        let Some(first) = starts.recv().await else {
            return;
        };
        let mut latest = first.id;
        let mut pending = Some(first);
        let mut running = false;
        let mut launch = LaunchOptions::new(&self.program);
        launch.cwd = Some(self.project.clone());
        launch.env = Some(vec![
            (
                "HOME".into(),
                self._profile.path().join("home").into_os_string(),
            ),
            (
                "CLAUDE_CONFIG_DIR".into(),
                self._profile.path().join("home").into_os_string(),
            ),
            (
                "FAKE_CLAUDE_SCRIPT".into(),
                self.script.clone().into_os_string(),
            ),
        ]);
        launch.no_session_persistence = true;
        launch.strict_mcp_config = true;
        launch.setting_sources = Some(vec![]);
        let mut options = SessionOptions::new(launch);
        options.resume_id = pending
            .as_ref()
            .and_then(|s| s.request["resumeId"].as_str().map(str::to_owned));
        options.interrupt_grace = Duration::from_millis(150);
        options.limits.close_grace = Duration::from_millis(150);
        options.limits.kill_grace = Duration::from_millis(500);
        options.event_capacity = 256;
        options.event_bytes = BYTES;
        let (session, mut events) = ClaudeSession::new(options);
        let session = Arc::new(session);
        let mut replies = tokio::task::JoinSet::new();
        loop {
            if *close.borrow() || self.shared.failed.load(Ordering::Acquire) {
                break;
            }
            if let Some(start) = pending.take() {
                latest = start.id;
                let request = TurnRequest {
                    content: vec![json!({"type":"text","text":start.request["prompt"]})],
                    model: start.request["model"].as_str().unwrap_or("sonnet").into(),
                    permission_mode: Some("ask".into()),
                    effort: start.request["effort"].as_str().map(str::to_owned),
                    ..Default::default()
                };
                let result = tokio::select! {result=session.start_turn(request)=>Some(result),_=close.changed()=>None,_=interrupt.changed()=>None};
                if let Some(pid) = session.pid() {
                    self.shared
                        .pids
                        .lock()
                        .unwrap()
                        .insert(self.chat.clone(), pid);
                }
                *self.native_id.lock().unwrap() = session.native_id();
                match result {
                    Some(Ok(start)) if !start.cancelled && !start.steered => {
                        running = true;
                        self.shared.emit(
                            ProviderEvent::Started {
                                chat: self.chat.clone(),
                                turn: latest,
                                result: RawJson(json!({"turnId":start.turn_id})),
                            },
                            false,
                        );
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
            tokio::select! {
             biased;
             _=close.changed()=>break,
             _=interrupt.changed()=>{if running&&*interrupt.borrow()==latest.0 {session.interrupt().await;}},
             event=events.recv()=>match event {
              Some(event)=>{*self.native_id.lock().unwrap() = session.native_id();let is_end=terminal(&event);if is_end{if !running{continue;}running=false;self.active.store(false,Ordering::Release);}else if event["type"]=="turn-started"&&!running{break;}
               // Forward compact subagent deltas unchanged. The owner merges transcript rows by id.
               if !self.agent(latest,event,is_end){break;}
              },None=>break
             },
             reply=answers.recv()=>if let Some(mut reply)=reply{
              if reply.turn!=latest{drop(reply);continue;}
              let session=session.clone();let delayed=matches!(self.scenario,Scenario::QuestionDelayedReceipt);
              replies.spawn(async move{reply.guard.entered=true;let accepted=match reply.answer{Answer::Permission(decision)=>session.respond_to_permission(&reply.request,&decision),Answer::Question(value)=>session.answer_question(&reply.request,value.as_object())};if accepted&&delayed{tokio::time::sleep(Duration::from_millis(400)).await;}reply.guard.settle(if accepted{AnswerOutcome::Accepted}else{AnswerOutcome::NotWaiting});});
             },
             _=replies.join_next(),if !replies.is_empty()=>{},
             start=starts.recv()=>match start{Some(start)=>pending=Some(start),None=>break}
            }
        }
        if let Some(start) = pending.take() {
            self.shared.emit(
                ProviderEvent::StartFailed {
                    chat: self.chat.clone(),
                    turn: start.id,
                    error: failed(),
                },
                true,
            );
        }
        answers.close();
        while let Ok(reply) = answers.try_recv() {
            drop(reply);
        }
        replies.abort_all();
        while replies.join_next().await.is_some() {}
        session.close().await;
        // Close settles background children with compact transcript patches. Preserve
        // those deltas before the final host terminal and process-exit notification.
        while let Some(event) = events.try_recv() {
            let end = terminal(&event);
            if end {
                if !running {
                    continue;
                }
                running = false;
            }
            if event["type"] != "turn-started" {
                self.agent(latest, event, end);
            }
        }
        if running {
            self.agent(latest, json!({"type":"turn-cancelled"}), true);
        }
        self.exit(latest);
    }
}
fn script_for(scenario: Scenario) -> Value {
    let mut steps = vec![json!({"expect":{"subtype":"initialize"}})];
    if matches!(scenario, Scenario::HangInitialize) {
        steps.push(json!({"sleep_ms":10000}));
        return json!(steps);
    }
    steps.extend([
        json!({"reply":{}}),
        json!({"expect":{"subtype":"set_max_thinking_tokens"}}),
        json!({"reply":{}}),
    ]);
    for _ in 0..4 {
        steps.extend([
            json!({"expect":{"type":"user"}}),
            json!({"emit":{"type":"system","subtype":"init","session_id":"fixture-session"}}),
        ]);
        match scenario {
   Scenario::Permission=>steps.extend([json!({"request":{"id":"p1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"echo fixture"}}}}),json!({"expect":{"type":"control_response","fields":{"/response/request_id":"p1"}}})]),
   Scenario::Question|Scenario::QuestionDelayedReceipt|Scenario::Unicode=>steps.extend([json!({"request":{"id":"q1","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","input":{"questions":[{"question":"Which?","header":"Pick","options":[{"label":"A","description":"First"},{"label":"B","description":"Second"}]}]}}}}),json!({"expect":{"type":"control_response","fields":{"/response/request_id":"q1"}}})]),
   Scenario::Subagent => {
    steps.extend([
      json!({"emit":{"type":"assistant","message":{"content":[{"type":"tool_use","id":"child","name":"Agent","input":{"description":"Review","run_in_background":true}}]}}}),
      json!({"emit":{"type":"user","parent_tool_use_id":"child","message":{"content":[{"type":"tool_result","tool_use_id":"read-1","content":"retained child result"}]}}}),
      json!({"expect":{"subtype":"interrupt"}}),json!({"reply":{}})
    ]);continue;
   },
   Scenario::Stop=>{steps.extend([json!({"expect":{"subtype":"interrupt"}}),json!({"reply":{}})]);continue;},
   Scenario::Crash=>{steps.push(json!({"exit":7}));break;},_=>{}
  }
        steps.extend([json!({"emit":{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Claude fixture hello"}}}}),json!({"emit":{"type":"result","subtype":"success","num_turns":1,"result":"done"}})]);
    }
    if matches!(scenario, Scenario::Unicode) {
        let native = "native \u{10fffe} \u{e123} \u{fffd}";
        for step in &mut steps {
            if step["expect"]["type"] == "user" {
                step["expect"]["fields"] = json!({"/message/content/0/text": native});
            }
            if step["expect"]["type"] == "control_response" {
                step["expect"]["fields"]["/response/response/updatedInput/answers/Which?"] =
                    json!(native);
            }
            if step["emit"]["type"] == "stream_event" {
                step["emit"]["event"]["delta"]["text"] = json!(native);
            }
        }
    }
    json!(steps)
}

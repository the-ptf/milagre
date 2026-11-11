//! Nonblocking owner adapter restricted to the checked-in scripted Claude CLI.
//! There is no public executable, environment, live profile, role or MCP configuration.
use crate::instructions::{self, Bundle, HostNetwork};
use milagre_claude::{
    ordinary::{node_trace, OrdinaryLaunch, OrdinaryTurn},
    ClaudeSession, LaunchOptions, SessionOptions,
};
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
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
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
    AnswerSaturation,
    Subagent,
    Unicode,
    Content,
    ContentAllow,
    ContentDeny,
    Design,
    Queue,
    /// Three ordinary turns checked against the recorded Node launch options and control order.
    Ordinary,
}
/// The Node ordinary trace (actual SessionManager/ClaudeSession over an explicit synthetic
/// bundle, `rust-claude/scripts/generate-session.cjs`). Its bundle and host are this fixture's
/// explicit instruction inputs; its recorded options become the fake child's launch assertions.
const ORDINARY_TRACE: &str =
    include_str!("../../rust-claude/tests/fixtures/conformance/claude-ordinary.json");
/// Explicit ordinary instruction inputs. Nothing is discovered from the install or host.
struct OrdinaryFacts {
    bundle: Bundle,
    agents: serde_json::Map<String, Value>,
    host: HostNetwork,
}
impl OrdinaryFacts {
    fn from_trace(trace: &Value) -> Result<Self, Box<dyn std::error::Error>> {
        let b = &trace["bundle"];
        let text = |v: &Value| v.as_str().map(str::to_owned).ok_or("trace text");
        let personas: Vec<(String, String)> = b["personas"]
            .as_array()
            .ok_or("trace personas")?
            .iter()
            .map(|p| Ok((text(&p[0])?, text(&p[1])?)))
            .collect::<Result<_, &str>>()?;
        let personas: Vec<(&str, &str)> = personas
            .iter()
            .map(|(f, t)| (f.as_str(), t.as_str()))
            .collect();
        let addresses: Vec<String> = trace["host"]["addresses"]
            .as_array()
            .ok_or("trace host")?
            .iter()
            .map(text)
            .collect::<Result<_, _>>()?;
        Ok(Self {
            bundle: Bundle::new(&text(&b["skillsDir"])?, &text(&b["tldrDefault"])?)?,
            agents: instructions::bundled_agents(&text(&b["agentMd"])?, &personas)?,
            host: HostNetwork {
                name: trace["host"]["name"].as_str().map(str::to_owned),
                addresses,
            },
        })
    }
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
    peak_reply_tasks: AtomicUsize,
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
    content: Option<Arc<crate::claude_content::SharedContent>>,
    shared: Arc<Shared>,
    _profile: Arc<IsolatedProfile>,
}
impl FixtureMonitor {
    /// Bounded actual MCP PNG replies from the fixed private Design scenario.
    pub fn design_feedback(&self) -> Vec<Value> {
        self.content
            .as_ref()
            .map(|content| content.feedback())
            .unwrap_or_default()
    }
    pub fn peak_reply_tasks(&self) -> usize {
        self.shared.peak_reply_tasks.load(Ordering::Acquire)
    }
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
    turn: OrdinaryTurn,
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
    content_scope: Arc<crate::claude_content::SessionContent>,
    start: mpsc::Sender<Start>,
    answers: mpsc::Sender<Reply>,
    close: watch::Sender<bool>,
    interrupt: watch::Sender<u64>,
    active: Arc<AtomicBool>,
    done: Arc<AtomicBool>,
    latest: Arc<AtomicU64>,
    native_id: Arc<Mutex<Option<String>>>,
    /// The TLDR setting this session's instructions were built with (fixed per session).
    tldr: bool,
}
struct Worker {
    content_scope: Arc<crate::claude_content::SessionContent>,
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
    content: Option<Arc<crate::claude_content::SharedContent>>,
    facts: Arc<OrdinaryFacts>,
    tldr: bool,
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.content_scope.revoke();
        self.active.store(false, Ordering::Release);
        self.done.store(true, Ordering::Release);
        *self.shared.workers.lock().unwrap() -= 1;
        self.shared.drained.notify_all();
    }
}
/// The only constructor creates a private fixture copy and locates a fixed Cargo helper sibling.
pub struct ClaudeFixture {
    pub(crate) content: Option<Arc<crate::claude_content::SharedContent>>,
    profile: Arc<IsolatedProfile>,
    isolation: Isolation,
    project: PathBuf,
    program: PathBuf,
    /// Fake CLI scripts by launch: the last one serves every later launch.
    scripts: Vec<PathBuf>,
    launches: usize,
    scenario: Scenario,
    shared: Arc<Shared>,
    slots: HashMap<String, Slot>,
    closed: bool,
    facts: Arc<OrdinaryFacts>,
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
        let trace: Value = serde_json::from_str(ORDINARY_TRACE)?;
        let facts = Arc::new(OrdinaryFacts::from_trace(&trace)?);
        let mut scripts = Vec::new();
        let bodies = match scenario {
            Scenario::Ordinary => ordinary_scripts(&trace)?,
            _ => vec![script_for(scenario, &profile.path().join("queue-release"))],
        };
        for (index, body) in bodies.into_iter().enumerate() {
            let script = profile.path().join(format!("claude-script-{index}.json"));
            std::fs::write(&script, body.to_string())?;
            scripts.push(script);
        }
        let content = if matches!(scenario, Scenario::Design) {
            let helper = dir.join("milagre-design-raster").canonicalize()?;
            let raster = Arc::new(milagre_content_store::design::raster::RasterRenderer::new(
                helper,
            )?);
            Some(crate::claude_content::SharedContent::with_raster(
                isolation.clone(),
                project.clone(),
                Some(raster),
            )?)
        } else if matches!(
            scenario,
            Scenario::Content | Scenario::ContentAllow | Scenario::ContentDeny
        ) {
            Some(crate::claude_content::SharedContent::new(
                isolation.clone(),
                project.clone(),
            )?)
        } else {
            None
        };
        Ok(Self {
            content,
            profile,
            isolation,
            project,
            program,
            scripts,
            launches: 0,
            scenario,
            facts,
            shared: Arc::new(Shared {
                queue: Mutex::new(Queue {
                    events: VecDeque::new(),
                    bytes: 0,
                }),
                failed: AtomicBool::new(false),
                cleanup_failed: AtomicBool::new(false),
                peak_reply_tasks: AtomicUsize::new(0),
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
            content: self.content.clone(),
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
fn native_request(request: &Value, project: &Path) -> Result<(Value, OrdinaryTurn), ProviderError> {
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
    // Typed ordinary Ask settings: model, effort, ultracode, fastMode, replies and tldrEnabled.
    // Auto/Full and mistyped values are refused, never coerced as Node would.
    let turn = OrdinaryTurn::parse(request).map_err(|e| match e {
        milagre_claude::ordinary::OrdinaryError::Mode => {
            refused("Only ordinary Ask mode is implemented")
        }
        _ => refused("Invalid fixture turn setting"),
    })?;
    if request
        .get("images")
        .is_some_and(|v| !v.is_null() && v.as_array().is_none_or(|a| !a.is_empty()))
    {
        return Err(refused("Images are unsupported"));
    }
    if !request["prompt"].is_string() {
        return Err(refused("Expected text prompt"));
    }
    let native = request.clone();
    native["chatId"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 4096)
        .ok_or_else(|| refused("Invalid Chat identity"))?;
    if native
        .get("resumeId")
        .is_some_and(|v| !v.is_null() && !v.is_string())
    {
        return Err(refused("Invalid fixture turn setting"));
    }
    Ok((native, turn))
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
        let (mut native, turn) = native_request(request, &self.project)?;
        let chat = request["chatId"].as_str().unwrap().to_owned();
        self.slots
            .retain(|_, slot| !slot.done.load(Ordering::Acquire));
        self.shared
            .pids
            .lock()
            .unwrap()
            .retain(|chat, _| self.slots.contains_key(chat));
        // SessionManager.currentEntry: instructions are fixed per session, so an idle session whose
        // TLDR setting changed is closed and its native id resumed by a fresh one. The detached
        // worker reaps on its own and reports Exited for its own last turn only.
        if let Some(slot) = self
            .slots
            .get(&chat)
            .filter(|slot| slot.tldr != turn.tldr_enabled && !slot.active.load(Ordering::Acquire))
        {
            if *self.shared.workers.lock().unwrap() >= CHATS {
                return Err(refused("The fixture Chat limit was reached"));
            }
            let current = slot.native_id.lock().unwrap().clone();
            if let (Some(requested), Some(current)) = (native["resumeId"].as_str(), &current) {
                if requested != current {
                    return Err(refused(
                        "Close the previous fixture session before resuming another native session",
                    ));
                }
            }
            let slot = self.slots.remove(&chat).expect("checked above");
            slot.content_scope.revoke();
            slot.close.send_replace(true);
            if let Some(current) = current {
                native["resumeId"] = json!(current);
            }
        }
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
            let content_scope = crate::claude_content::SessionContent::new();
            let worker = Worker {
                content_scope: content_scope.clone(),
                shared: self.shared.clone(),
                _profile: self.profile.clone(),
                project: self.project.clone(),
                program: self.program.clone(),
                script: self.scripts[self.launches.min(self.scripts.len() - 1)].clone(),
                chat: chat.clone(),
                scenario: self.scenario,
                facts: self.facts.clone(),
                tldr: turn.tldr_enabled,
                active: active.clone(),
                done: done.clone(),
                native_id: native_id.clone(),
                content: self.content.clone(),
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
                    content_scope,
                    start,
                    answers,
                    close,
                    interrupt,
                    active,
                    done,
                    latest,
                    native_id,
                    tldr: turn.tldr_enabled,
                },
            );
            self.launches += 1;
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
                turn,
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
        if self
            .slots
            .get(chat)
            .is_none_or(|slot| slot.latest.load(Ordering::Acquire) != turn.0)
        {
            return Err(refused("The fixture session generation is gone"));
        }
        // Detach the captured slot at admission. Its worker retains the profile and
        // reaps independently; a new turn gets a fresh session and MCP registration.
        let slot = self.slots.remove(chat).expect("generation checked");
        slot.content_scope.revoke();
        slot.close.send_replace(true);
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
        if let Some(content) = &self.content {
            content.revoke();
        }
        for slot in self.slots.values() {
            slot.content_scope.revoke();
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
    /// The Node ordinary launch for this session: instructions for its TLDR setting with the
    /// explicit synthetic host, SubagentStart context (design section only with `design_show`),
    /// QA agents and the prompt-suggestion default read from this private profile only.
    fn plan(
        &self,
        options: &mut SessionOptions,
        registration: Option<&milagre_claude::mcp::McpRegistration>,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let design = registration.is_some_and(|r| {
            r.provider_manifest()
                .iter()
                .any(|tool| tool.name == "design_show")
        });
        let host = self.facts.host.instructions();
        let workspace = instructions::session_workspace(None, &host);
        let settings = match std::fs::read(self._profile.path().join("home/settings.json")) {
            Ok(bytes) => Some(bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.into()),
        };
        OrdinaryLaunch {
            system_append: self.facts.bundle.milagre_instructions(
                self.tldr,
                workspace.as_deref(),
                false,
            ),
            subagent_context: self.facts.bundle.subagent_context(design),
            agents: self.facts.agents.clone(),
            prompt_suggestions: instructions::prompt_suggestions_enabled(settings.as_deref(), None),
            additional_directories: vec![],
        }
        .apply(options)?;
        Ok(())
    }
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
        // Fixture-only isolation flags Node does not pass; they add restrictions and are recorded
        // in CLAUDE-FIXTURE.md. Setting sources stay Node's (planned below) over the private home.
        launch.no_session_persistence = true;
        launch.strict_mcp_config = true;
        let mut options = SessionOptions::new(launch);
        options.resume_id = pending
            .as_ref()
            .and_then(|s| s.request["resumeId"].as_str().map(str::to_owned));
        options.interrupt_grace = Duration::from_millis(150);
        options.limits.close_grace = Duration::from_millis(150);
        options.limits.kill_grace = Duration::from_millis(500);
        options.event_capacity = 256;
        options.event_bytes = BYTES;
        let _registration = match &self.content {
            Some(content) => match content.attach(&self.chat, &mut options, &self.content_scope) {
                Ok(registration) => Some(registration),
                Err(_) => {
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
            },
            None => None,
        };
        if self.plan(&mut options, _registration.as_deref()).is_err() {
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
        let (session, mut events) = ClaudeSession::new(options);
        let session = Arc::new(session);
        let mut replies = tokio::task::JoinSet::new();
        loop {
            if *close.borrow() || self.shared.failed.load(Ordering::Acquire) {
                break;
            }
            if let Some(start) = pending.take() {
                latest = start.id;
                let request = start
                    .turn
                    .request(vec![json!({"type":"text","text":start.request["prompt"]})]);
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
             reply=answers.recv(), if replies.len()<8=>if let Some(mut reply)=reply{
              if reply.turn!=latest{drop(reply);continue;}
              let session=session.clone();let delay=match self.scenario{Scenario::QuestionDelayedReceipt=>400,Scenario::AnswerSaturation=>10000,_=>0};
              replies.spawn(async move{reply.guard.entered=true;let accepted=match reply.answer{Answer::Permission(decision)=>session.respond_to_permission(&reply.request,&decision),Answer::Question(value)=>session.answer_question(&reply.request,value.as_object())};if accepted&&delay>0{tokio::time::sleep(Duration::from_millis(delay)).await;}reply.guard.settle(if accepted{AnswerOutcome::Accepted}else{AnswerOutcome::NotWaiting});});
              self.shared.peak_reply_tasks.fetch_max(replies.len(),Ordering::AcqRel);
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
/// One fake script per native process from the Node trace: launch assertions (argv, TODO env
/// flag, private prompt/settings bytes, `initialize`), then Node's control and user order. The
/// first process also answers both hooks exactly as Node's did, ignores SIGTERM and lingers after
/// EOF, so its Exited arrives after the replacement process has started (late generation).
fn ordinary_scripts(trace: &Value) -> Result<Vec<Value>, Box<dyn std::error::Error>> {
    let mut scripts = Vec::new();
    for (index, query) in trace["queries"]
        .as_array()
        .ok_or("trace queries")?
        .iter()
        .enumerate()
    {
        let mut steps = Vec::new();
        if index == 0 {
            steps.push(json!({"ignore_sigterm":true}));
        }
        steps.extend(node_trace::launch_steps(query)?);
        let hooks = node_trace::hook_steps(query)?;
        let controls = query["controls"].as_array().ok_or("trace controls")?;
        steps.extend(node_trace::control_steps(controls, |turn| {
            let mut frames = vec![json!({"emit":{"type":"system","subtype":"init","session_id":"fixture-session"}})];
            if turn == 0 {
                frames.extend(hooks.clone());
            }
            frames.push(json!({"emit":{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Claude fixture hello"}}}}));
            frames.push(json!({"emit":{"type":"result","subtype":"success","num_turns":1,"result":"done"}}));
            frames
        })?);
        if index == 0 {
            steps.extend([json!({"wait_eof":true}), json!({"sleep_ms":10000})]);
        }
        scripts.push(Value::Array(steps));
    }
    Ok(scripts)
}
fn script_for(scenario: Scenario, queue_release: &Path) -> Value {
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
    for turn in 0..4 {
        steps.extend([
            json!({"expect":{"type":"user"}}),
            json!({"emit":{"type":"system","subtype":"init","session_id":"fixture-session"}}),
        ]);
        match scenario {
   Scenario::Permission=>steps.extend([json!({"request":{"id":"p1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"echo fixture"}}}}),json!({"expect":{"type":"control_response","fields":{"/response/request_id":"p1"}}})]),
   Scenario::Question|Scenario::QuestionDelayedReceipt|Scenario::Unicode=>steps.extend([json!({"request":{"id":"q1","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","input":{"questions":[{"question":"Which?","header":"Pick","options":[{"label":"A","description":"First"},{"label":"B","description":"Second"}]}]}}}}),json!({"expect":{"type":"control_response","fields":{"/response/request_id":"q1"}}})]),
   Scenario::AnswerSaturation => {
    let mut expected = Vec::new();
    for id in 0..8 {
     let id = format!("q{id}");
     steps.push(json!({"request":{"id":id,"request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","input":{"questions":[{"question":"Which?","header":"Pick","options":[{"label":"A","description":"First"},{"label":"B","description":"Second"}]}]}}}}));
     expected.push(json!({"/type":"control_response","/response/request_id":id}));
    }
    expected.push(json!({"/type":"control_request","/request/subtype":"interrupt"}));
    steps.push(json!({"expect_pair":expected}));
    steps.push(json!({"emit":{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Eight answers and Stop received"}}}}));
    steps.push(json!({"wait_eof":true}));
    break;
   },
   Scenario::Design => { steps.extend(design_steps()); },
   Scenario::Queue => { if turn==0 {steps.push(json!({"wait_file":queue_release}));} },
   Scenario::Content | Scenario::ContentAllow | Scenario::ContentDeny => {
    if matches!(scenario, Scenario::ContentAllow | Scenario::ContentDeny) {
     let behavior=if matches!(scenario, Scenario::ContentDeny){"deny"}else{"allow"};
     steps.push(json!({"request":{"id":"content-permission","request":{"subtype":"can_use_tool","tool_name":"mcp__milagre__artifact_show","input":{"title":"Native Claude artifact","html":"<main>Native shared content</main>"}}}}));
     steps.push(json!({"expect":{"type":"control_response","fields":{"/response/request_id":"content-permission","/response/response/behavior":behavior}}}));
    }
    if !matches!(scenario, Scenario::ContentDeny) {steps.extend([
     json!({"request":{"id":"content-show","request":{"subtype":"mcp_message","server_name":"milagre","message":{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"artifact_show","arguments":{"title":"Native Claude artifact","html":"<main>Native shared content</main>"}}}}}}),
     json!({"expect":{"type":"control_response","fields":{"/response/response/mcp_response/id":1,"/response/response/mcp_response/result/isError":false}}})
    ]);}
   },
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
    if matches!(scenario, Scenario::Queue) {
        let mut turn = 0;
        for step in &mut steps {
            if step["expect"]["type"] == "user" {
                step["expect"]["fields"] = json!({"/message/content/0/text": if turn==0 {"fixture input"} else {"second queued input"}});
                turn += 1;
            }
        }
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

fn design_steps() -> Vec<Value> {
    let show = json!({"id":"native-screen","title":"Native Design","document":{"schemaVersion":1,"width":240,"height":240,"nodes":[{"id":"paint","type":"frame","width":240,"height":240,"fill":"#ff0000"}]}});
    let apply = json!({"id":"native-screen","expectedVersion":1,"operations":[{"op":"update","id":"paint","patch":{"fill":"#0000ff"}}]});
    let mut steps = Vec::new();
    for (number, name, args) in [(1, "design_show", show), (2, "design_apply", apply)] {
        let tool = format!("mcp__milagre__{name}");
        let id = format!("design-tool-{number}");
        steps.push(json!({"emit":{"type":"assistant","message":{"content":[{"type":"tool_use","id":id,"name":tool,"input":args}]}}}));
        steps.push(json!({"request":{"id":id,"request":{"subtype":"mcp_message","server_name":"milagre","message":{"jsonrpc":"2.0","id":number,"method":"tools/call","params":{"name":name,"arguments":args}}}}}));
        steps.push(json!({"expect":{"type":"control_response","fields":{"/response/response/mcp_response/id":number,"/response/response/mcp_response/result/isError":false,"/response/response/mcp_response/result/content/1/type":"image","/response/response/mcp_response/result/content/1/mimeType":"image/png"}}}));
        // Native CLI fixture reports a normal tool completion after consuming its real MCP response.
        // PNG itself remains model feedback; no fabricated transcript-image event is emitted.
        let text=json!({"id":"native-screen","title":"Native Design","version":number,"format":"design"}).to_string();
        steps.push(json!({"emit":{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":id,"content":[{"type":"text","text":text}]}]}}}));
    }
    steps
}

#[cfg(test)]
mod content_close_tests {
    use super::*;
    use milagre_content_store::{Runtime, SystemRuntime};
    struct PausedClock {
        once: AtomicBool,
        entered: std::sync::mpsc::SyncSender<()>,
        release: Mutex<std::sync::mpsc::Receiver<()>>,
    }
    impl Runtime for PausedClock {
        fn now_ms(&self) -> u64 {
            if self.once.swap(false, Ordering::AcqRel) {
                self.entered.send(()).unwrap();
                let _ = self.release.lock().unwrap().recv();
            }
            SystemRuntime.now_ms()
        }
        fn uuid(&self) -> String {
            SystemRuntime.uuid()
        }
    }
    #[test]
    fn closing_slot_revokes_paused_write_and_replacement_uses_the_same_writer_once() {
        let mut provider = ClaudeFixture::create(Scenario::Content).unwrap();
        // Replace only the trusted clock inside this private fixture, after releasing its first writer.
        provider.content.take().unwrap().shutdown();
        let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(1);
        let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
        let content = crate::claude_content::SharedContent::with_runtime(
            provider.isolation(),
            provider.project().to_path_buf(),
            None,
            Arc::new(PausedClock {
                once: AtomicBool::new(true),
                entered: entered_tx,
                release: Mutex::new(release_rx),
            }),
        )
        .unwrap();
        content.opened(true);
        provider.content = Some(content.clone());
        let chat = format!("{}#1", provider.project().display());
        let request = RawJson(
            json!({"provider":"claude","chatId":chat,"cwd":provider.project(),"prompt":"fixture input","permissionMode":"ask","model":"sonnet"}),
        );
        provider.start_turn(TurnId(1), &request).unwrap();
        entered_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        let closing = provider.slots.get(&chat).unwrap().content_scope.clone();
        provider.close_chat(&chat, TurnId(1)).unwrap();
        assert!(
            closing.check().is_err(),
            "close revokes before the paused commit is released"
        );
        provider.start_turn(TurnId(2), &request).unwrap();
        assert!(!Arc::ptr_eq(
            &closing,
            &provider.slots.get(&chat).unwrap().content_scope
        ));
        release_tx.send(()).unwrap();
        let until = std::time::Instant::now() + Duration::from_secs(5);
        let mut events = Vec::new();
        loop {
            events.extend(provider.take_events());
            if events.iter().any(|e|matches!(e,ProviderEvent::Agent{turn:TurnId(2),event:RawJson(v),..}if v["type"]=="turn-completed")){break;}
            assert!(std::time::Instant::now() < until, "{events:?}");
            std::thread::sleep(Duration::from_millis(2));
        }
        let artifacts = content
            .renderer("artifact:list", &json!({"chatId":chat}))
            .unwrap();
        assert_eq!(artifacts.as_array().unwrap().len(), 1);
        assert_eq!(
            artifacts[0]["version"], 1,
            "the revoked write is not replayed into the replacement"
        );
        let page = content
            .renderer(
                "artifact:get",
                &json!({"chatId":chat,"id":artifacts[0]["id"]}),
            )
            .unwrap();
        assert!(page.to_string().contains("Native shared content"));
        assert!(closing.check().is_err());
        provider.shutdown();
        assert!(provider.monitor().wait_stopped(Duration::from_secs(3)));
        content.shutdown();
    }
}

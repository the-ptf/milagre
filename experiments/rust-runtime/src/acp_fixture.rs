//! Opt-in fixed ACP fake only. Each host turn owns one process; native reuse is refused.
use milagre_acp::{
    session::{Answer, Delivery, FakeOptions, FakeSession, SessionError, SessionEvent},
    RequestId,
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
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Condvar, Mutex,
    },
    time::Duration,
};
use tokio::sync::{mpsc, watch};

#[derive(Clone, Copy, Debug)]
pub enum Scenario {
    Reply,
    Permission,
    Stop,
    StartFailure,
    LateUpdate,
    BlockedAnswer,
    Watchdog,
    #[cfg(test)]
    PanicBeforeSpawn,
    #[cfg(test)]
    PanicActive,
    #[cfg(test)]
    PanicAnswer,
    #[cfg(test)]
    PanicDrain,
    #[cfg(test)]
    PanicBeforePublication,
}
impl Scenario {
    fn name(self) -> &'static str {
        match self {
            Self::Reply => "reply",
            Self::Permission => "permission",
            Self::Stop => "slow",
            Self::StartFailure => "missing-id",
            Self::LateUpdate => "late-update",
            Self::BlockedAnswer => "blocked-answer",
            Self::Watchdog => "stubborn",
            #[cfg(test)]
            Self::PanicBeforeSpawn => "reply",
            #[cfg(test)]
            Self::PanicActive => "slow",
            #[cfg(test)]
            Self::PanicAnswer => "permission",
            #[cfg(test)]
            Self::PanicDrain | Self::PanicBeforePublication => "reply",
        }
    }
}
fn error(message: &str) -> ProviderError {
    ProviderError::new(ProviderErrorKind::Refused, message)
}
fn stopped() -> ProviderError {
    error("The isolated ACP process stopped")
}
fn answer_outcome(result: Result<Delivery, SessionError>) -> AnswerOutcome {
    match result {
        Ok(Delivery::WrittenUnacknowledged) => AnswerOutcome::Accepted,
        Ok(Delivery::NotSent) | Err(SessionError::UnknownPermission) => AnswerOutcome::NotWaiting,
        Err(
            SessionError::Closed
            | SessionError::Busy
            | SessionError::PromptTooLarge
            | SessionError::UnsupportedPolicy
            | SessionError::Configuration,
        ) => AnswerOutcome::Failed(stopped()),
        Ok(Delivery::Uncertain) | Err(SessionError::UncertainDelivery) => {
            AnswerOutcome::Uncertain(stopped())
        }
    }
}
fn terminal(v: &Value) -> bool {
    matches!(
        v["type"].as_str(),
        Some("turn-completed" | "turn-failed" | "turn-cancelled")
    )
}
struct Output {
    events: VecDeque<ProviderEvent>,
    bytes: usize,
}
struct Shared {
    output: Mutex<Output>,
    failed: AtomicBool,
    cleanup_failed: AtomicBool,
    workers: Mutex<usize>,
    drained: Condvar,
    answers: Mutex<HashSet<(String, u64)>>,
    turns: AtomicUsize,
    answers_entered: AtomicUsize,
    pids: Mutex<Vec<(u64, u32)>>,
}
impl Shared {
    fn emit(&self, event: ProviderEvent, reserved: bool) -> bool {
        let bytes = match &event {
            ProviderEvent::Agent { event, .. } => event.0.to_string().len() + 512,
            _ => 1024,
        };
        let mut output = self
            .output
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if !reserved && (output.events.len() >= 256 || output.bytes + bytes > 4 * 1024 * 1024) {
            self.failed.store(true, Ordering::Release);
            return false;
        }
        output.bytes += bytes;
        output.events.push_back(event);
        true
    }
}
#[derive(Clone)]
pub struct Monitor(Arc<Shared>);
impl Monitor {
    pub fn answers_entered(&self) -> usize {
        self.0.answers_entered.load(Ordering::Acquire)
    }
    pub fn workers(&self) -> usize {
        *self
            .0
            .workers
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }
    pub fn pids(&self) -> Vec<(u64, u32)> {
        self.0
            .pids
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }
    pub fn cleanup_failed(&self) -> bool {
        self.0.cleanup_failed.load(Ordering::Acquire)
    }
    pub fn wait_stopped(&self, timeout: Duration) -> bool {
        let count = self
            .0
            .workers
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let (count, _) = self
            .0
            .drained
            .wait_timeout_while(count, timeout, |n| *n != 0 && !self.cleanup_failed())
            .unwrap_or_else(|error| error.into_inner());
        *count == 0 && !self.cleanup_failed()
    }
}
struct Receipt {
    shared: Arc<Shared>,
    chat: String,
    id: AnswerId,
    entered: bool,
    settled: bool,
}
impl Receipt {
    fn settle(mut self, outcome: AnswerOutcome) {
        self.settled = true;
        self.shared.emit(
            ProviderEvent::AnswerSettled {
                chat: self.chat.clone(),
                answer: self.id,
                outcome,
            },
            true,
        );
    }
}
impl Drop for Receipt {
    fn drop(&mut self) {
        if !self.settled {
            let outcome = if self.entered {
                AnswerOutcome::Uncertain(stopped())
            } else {
                AnswerOutcome::Failed(stopped())
            };
            self.shared.emit(
                ProviderEvent::AnswerSettled {
                    chat: self.chat.clone(),
                    answer: self.id,
                    outcome,
                },
                true,
            );
        }
    }
}
struct Reply {
    request: String,
    answer: Answer,
    receipt: Receipt,
}
struct Slot {
    turn: TurnId,
    done: Arc<AtomicBool>,
    stop: watch::Sender<u8>,
    answers: mpsc::Sender<Reply>,
}
pub struct AcpFixture {
    profile: Arc<IsolatedProfile>,
    isolation: Isolation,
    project: PathBuf,
    scenario: Scenario,
    shared: Arc<Shared>,
    slots: HashMap<String, Slot>,
    closed: bool,
}
impl AcpFixture {
    pub fn create(scenario: Scenario) -> Result<Self, Box<dyn std::error::Error>> {
        let profile = Arc::new(IsolatedProfile::create()?);
        let isolation = Isolation::create(profile.path(), &Policy::system())?;
        let project = isolation.project(Path::new("fixture"))?;
        std::fs::create_dir(project.join(".milagre"))?;
        std::fs::write(project.join(".milagre/coordination.json"),json!({"next_id":10,"name":"ACP fixture","worktrees":{"1":{"id":1,"path":project,"name":"main"}},"sessions":{"1":{"id":1,"worktree_id":1},"2":{"id":2,"worktree_id":1}},"messages":[]}).to_string())?;
        Ok(Self {
            profile,
            isolation,
            project,
            scenario,
            shared: Arc::new(Shared {
                output: Mutex::new(Output {
                    events: VecDeque::new(),
                    bytes: 0,
                }),
                failed: AtomicBool::new(false),
                cleanup_failed: AtomicBool::new(false),
                workers: Mutex::new(0),
                drained: Condvar::new(),
                answers: Mutex::new(HashSet::new()),
                turns: AtomicUsize::new(0),
                answers_entered: AtomicUsize::new(0),
                pids: Mutex::new(Vec::new()),
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
    pub fn monitor(&self) -> Monitor {
        Monitor(self.shared.clone())
    }
    fn slot(&self, chat: &str, turn: TurnId) -> Result<&Slot, ProviderError> {
        self.slots
            .get(chat)
            .filter(|s| s.turn == turn && !s.done.load(Ordering::Acquire))
            .ok_or_else(stopped)
    }
}
impl Provider for AcpFixture {
    fn name(&self) -> &str {
        "kiro"
    }
    fn start_turn(&mut self, turn: TurnId, request: &RawJson) -> Result<(), ProviderError> {
        let r = &request.0;
        if self.closed || self.shared.failed.load(Ordering::Acquire) {
            return Err(stopped());
        }
        if turn.0 == 0
            || r["provider"] != "kiro"
            || r["cwd"].as_str() != self.project.to_str()
            || r["permissionMode"].as_str().unwrap_or("ask") != "ask"
        {
            return Err(error(
                "Only the fixed isolated ACP Ask fixture is supported",
            ));
        }
        for (k, v) in r.as_object().ok_or_else(stopped)? {
            match k.as_str(){"provider"|"cwd"|"chatId"|"prompt"|"permissionMode"=>{},"model" if v.is_null()=>{},"images" if v.as_array().is_some_and(Vec::is_empty)=>{},_=>return Err(error("ACP fixture resume, models, policy, images and extra configuration are unsupported"))}
        }
        let chat = r["chatId"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() < 4096)
            .ok_or_else(stopped)?
            .to_owned();
        let prompt = r["prompt"]
            .as_str()
            .filter(|s| s.len() <= 16384)
            .ok_or_else(stopped)?
            .to_owned();
        self.slots.retain(|_, s| !s.done.load(Ordering::Acquire));
        if self.slots.contains_key(&chat)
            || *self
                .shared
                .workers
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                >= 16
        {
            return Err(error("An ACP fixture turn is active or capacity is full"));
        }
        if self
            .shared
            .turns
            .try_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < 16).then_some(n + 1)
            })
            .is_err()
        {
            return Err(error("ACP fixture output turn capacity exceeded"));
        }
        let (done, (stop, stop_rx), (answers, answers_rx)) = (
            Arc::new(AtomicBool::new(false)),
            watch::channel(0u8),
            mpsc::channel(8),
        );
        let worker = Worker {
            started: AtomicBool::new(false),
            shared: self.shared.clone(),
            _profile: self.profile.clone(),
            chat: chat.clone(),
            turn,
            done: done.clone(),
            scenario: self.scenario,
        };
        *self
            .shared
            .workers
            .lock()
            .unwrap_or_else(|error| error.into_inner()) += 1;
        std::thread::Builder::new()
            .name("acp-fixture".into())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .ok();
                // Created before the caught work. Drop owns cleanup and completion, including
                // unwinds after run returns. The runtime is dropped only after this guard.
                let mut completion = Completion {
                    worker: &worker,
                    runtime: runtime.as_ref(),
                    end: json!({"type":"turn-failed","error":"The isolated ACP executor failed"}),
                };
                if let Some(runtime) = runtime.as_ref() {
                    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        let result = runtime.block_on(worker.run(prompt, answers_rx, stop_rx));
                        #[cfg(test)]
                        if matches!(worker.scenario, Scenario::PanicBeforePublication) {
                            panic!("fixed ACP pre-publication panic");
                        }
                        result
                    }));
                    match outcome {
                        Ok((_, end)) => completion.end = end,
                        Err(_) => completion.panicked(),
                    }
                }
                drop(completion);
            })
            .map_err(|_| {
                self.shared.turns.fetch_sub(1, Ordering::AcqRel);
                error("Could not start the private ACP fixture worker")
            })?;
        self.slots.insert(
            chat,
            Slot {
                turn,
                done,
                stop,
                answers,
            },
        );
        Ok(())
    }
    fn interrupt(&mut self, chat: &str, turn: TurnId) -> Result<(), ProviderError> {
        self.slot(chat, turn)?.stop.send_replace(1);
        Ok(())
    }
    fn close_chat(&mut self, chat: &str, turn: TurnId) -> Result<(), ProviderError> {
        self.slot(chat, turn)?.stop.send_replace(2);
        Ok(())
    }
    fn respond_permission(
        &mut self,
        chat: &str,
        turn: TurnId,
        id: AnswerId,
        request: &str,
        decision: &str,
    ) -> Result<(), ProviderError> {
        let answer = match decision {
            "allow" => Answer::AllowOnce,
            "deny" => Answer::Deny,
            _ => return Err(error("ACP fixture persistent approval is unsupported")),
        };
        let slot = self.slot(chat, turn)?;
        {
            let mut pending = self
                .shared
                .answers
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if request.len() > 4096 || pending.len() >= 32 || !pending.insert((chat.into(), id.0)) {
                return Err(error(
                    "ACP fixture answer capacity exceeded or duplicate receipt",
                ));
            }
        }
        let reply = Reply {
            request: request.into(),
            answer,
            receipt: Receipt {
                shared: self.shared.clone(),
                chat: chat.into(),
                id,
                entered: false,
                settled: false,
            },
        };
        if let Err(e) = slot.answers.try_send(reply) {
            let mut reply = e.into_inner();
            reply.receipt.settled = true;
            self.shared
                .answers
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&(chat.into(), id.0));
            return Err(error("ACP fixture answer lane is full or closed"));
        }
        Ok(())
    }
    fn answer_question(
        &mut self,
        _: &str,
        _: TurnId,
        _: AnswerId,
        _: &str,
        _: &RawJson,
    ) -> Result<(), ProviderError> {
        Err(error("ACP fixture question selection is unsupported"))
    }
    fn shutdown(&mut self) {
        self.closed = true;
        for slot in self.slots.values() {
            slot.stop.send_replace(2);
        }
    }
    fn take_events(&mut self) -> Vec<ProviderEvent> {
        let mut output = self
            .shared
            .output
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        output.bytes = 0;
        let events: Vec<_> = output.events.drain(..).collect();
        for e in &events {
            if matches!(e, ProviderEvent::Exited { .. }) {
                self.shared.turns.fetch_sub(1, Ordering::AcqRel);
            }
            if let ProviderEvent::AnswerSettled { chat, answer, .. } = e {
                self.shared
                    .answers
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .remove(&(chat.clone(), answer.0));
            }
        }
        events
    }
}
impl Drop for AcpFixture {
    fn drop(&mut self) {
        self.shutdown();
    }
}
struct Completion<'a> {
    worker: &'a Worker,
    runtime: Option<&'a tokio::runtime::Runtime>,
    end: Value,
}
impl Completion<'_> {
    fn panicked(&mut self) {
        self.worker.shared.failed.store(true, Ordering::Release);
        self.end = json!({"type":"turn-failed","error":"The isolated ACP supervisor panicked; its process was stopped"});
    }
}
impl Drop for Completion<'_> {
    fn drop(&mut self) {
        if let Some(runtime) = self.runtime {
            #[cfg(test)]
            let mut inject = matches!(self.worker.scenario, Scenario::PanicDrain);
            let mut retry_delay = Duration::from_millis(10);
            loop {
                let cleanup = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    #[cfg(test)]
                    if std::mem::take(&mut inject) {
                        panic!("fixed ACP drain panic");
                    }
                    runtime.block_on(crate::executor::drain(
                        runtime,
                        Duration::from_secs(3),
                        || {
                            self.worker.shared.failed.store(true, Ordering::Release);
                            self.worker
                                .shared
                                .cleanup_failed
                                .store(true, Ordering::Release);
                            self.worker.shared.drained.notify_all();
                        },
                    ));
                }));
                if cleanup.is_ok() {
                    break;
                }
                // Keep this thread, executor, worker and profile alive. A failed cleanup
                // attempt is not evidence of process exit; drive supervisors again.
                self.panicked();
                if !self
                    .worker
                    .shared
                    .cleanup_failed
                    .swap(true, Ordering::AcqRel)
                {
                    self.worker.shared.drained.notify_all();
                }
                std::thread::sleep(retry_delay);
                retry_delay = (retry_delay * 2).min(Duration::from_secs(1));
            }
        }
        self.worker.done.store(true, Ordering::Release);
        if self.worker.started.load(Ordering::Acquire) {
            self.worker.emit(std::mem::take(&mut self.end), true);
        } else {
            self.worker.shared.emit(
                ProviderEvent::StartFailed {
                    chat: self.worker.chat.clone(),
                    turn: self.worker.turn,
                    error: stopped(),
                },
                true,
            );
        }
        self.worker.shared.emit(
            ProviderEvent::Exited {
                chat: self.worker.chat.clone(),
                turn: self.worker.turn,
                error: stopped(),
            },
            true,
        );
    }
}

struct Worker {
    started: AtomicBool,
    shared: Arc<Shared>,
    _profile: Arc<IsolatedProfile>,
    chat: String,
    turn: TurnId,
    done: Arc<AtomicBool>,
    scenario: Scenario,
}
impl Drop for Worker {
    fn drop(&mut self) {
        *self
            .shared
            .workers
            .lock()
            .unwrap_or_else(|error| error.into_inner()) -= 1;
        self.shared.drained.notify_all();
    }
}
impl Worker {
    fn emit(&self, event: Value, reserved: bool) -> bool {
        self.shared.emit(
            ProviderEvent::Agent {
                chat: self.chat.clone(),
                turn: self.turn,
                event: RawJson(event),
            },
            reserved,
        )
    }
    async fn run(
        &self,
        prompt: String,
        mut answers: mpsc::Receiver<Reply>,
        mut stop: watch::Receiver<u8>,
    ) -> (bool, Value) {
        #[cfg(test)]
        if matches!(self.scenario, Scenario::PanicBeforeSpawn) {
            panic!("fixed ACP startup panic");
        }
        let mut options = FakeOptions {
            scenario: self.scenario.name().into(),
            ..Default::default()
        };
        options.limits.admitted_turns = 1;
        options.limits.startup_timeout = Duration::from_millis(500);
        options.limits.cancel_grace = Duration::from_millis(150);
        options.limits.idle_timeout = Duration::from_secs(3);
        options.limits.turn_timeout = Duration::from_secs(5);
        let Ok((session, mut events)) = FakeSession::launch(options) else {
            return (false, json!({"type":"turn-failed"}));
        };
        let Ok(local) = session.send(&prompt) else {
            session.shutdown().await;
            return (false, json!({"type":"turn-failed"}));
        };
        let (mut started, mut end) = (
            false,
            json!({"type":"turn-failed","error":"The ACP fixture process stopped"}),
        );
        let mut permissions = HashMap::<String, RequestId>::new();
        let mut serial = 0u64;
        let mut answering: Option<std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>> =
            None;
        loop {
            if self.shared.failed.load(Ordering::Acquire) {
                break;
            }
            tokio::select! {biased;
             _=stop.changed()=>{if *stop.borrow()>=2{end=json!({"type":"turn-cancelled"});break;}session.cancel();},
             _=async{if let Some(future)=answering.as_mut(){future.await}},if answering.is_some()=>{answering=None;},
             event=events.recv()=>match event{
              Some(SessionEvent::Agent{turn_id,event})=>{
               if turn_id!=local{break;}
               if event["type"]=="session-started"{
                if !started{started=true;self.started.store(true,Ordering::Release);self.shared.emit(ProviderEvent::Started{chat:self.chat.clone(),turn:self.turn,result:RawJson(json!({}))},true);
                 if let Ok(Ok(info))=tokio::time::timeout(Duration::from_millis(100),session.inspect()).await{if let Some(pid)=info["pid"].as_u64(){let mut pids=self.shared.pids.lock().unwrap_or_else(|error|error.into_inner());if pids.len()==16{pids.remove(0);}pids.push((self.turn.0,pid as u32));}}
                }
                // Native ids cannot be persisted as resumable state: this fixture never reuses a process.
                continue;
               }
               #[cfg(test)]
              if matches!(self.scenario,Scenario::PanicActive)&&event["text"]=="Working"{panic!("fixed ACP active panic");}
              if terminal(&event){end=event;break;}
               if !self.emit(event,false){break;}
              },
              Some(SessionEvent::Permission{turn_id,request_id,call,..})=>{
               if turn_id!=local||permissions.len()>=16{break;}serial+=1;let token=format!("acp-{}-{serial}",self.turn.0);permissions.insert(token.clone(),request_id);
               // Explicit fixture card, not the unported vendor card/policy implementation.
               if !self.emit(json!({"type":"permission-request","requestId":token,"kind":"command","tool":"Shell","title":"Allow this fixture command?","command":call["rawInput"]["command"].as_str().or_else(||call["rawInput"]["CommandLine"].as_str()).unwrap_or("fixture-only"),"allowForChat":false}),false){break;}
              },
              Some(SessionEvent::PermissionClosed{request_id,..})=>{permissions.retain(|_,id|id!=&request_id);},
              Some(SessionEvent::Closed{..})|None=>break,
             },
             reply=answers.recv(),if answering.is_none()=>if let Some(mut reply)=reply{
              if let Some(id)=permissions.remove(&reply.request){
               let receipt=match session.admit_answer(local,id.clone(),reply.answer){
                Ok(receipt)=>receipt,
                Err(_)=>{permissions.insert(reply.request.clone(),id);reply.receipt.settle(AnswerOutcome::Failed(stopped()));continue;}
               };
               // The session owns the admitted answer. This receipt observes it independently
               // of the daemon RPC or its caller disconnecting; dropping it never retracts delivery.
               reply.receipt.entered=true;
               self.shared.answers_entered.fetch_add(1,Ordering::AcqRel);
               #[cfg(test)]
               if matches!(self.scenario,Scenario::PanicAnswer){panic!("fixed ACP answer panic");}
               let token=reply.request.clone();let shared=self.shared.clone();let chat=self.chat.clone();let turn=self.turn;
               answering=Some(Box::pin(async move{
                let result=receipt.wait().await;
                if matches!(result,Ok(Delivery::WrittenUnacknowledged)){
                    shared.emit(ProviderEvent::Agent{chat,turn,event:RawJson(json!({"type":"permission-resolved","requestId":token,"decision":if reply.answer==Answer::AllowOnce{"allow"}else{"deny"}}))},true);
                }
                reply.receipt.settle(answer_outcome(result));
               }));
              }else{reply.receipt.settle(AnswerOutcome::NotWaiting);}
             },
            }
        }
        // Drop a claimed reply conservatively; process death does not prove it was not delivered.
        drop(answering);
        answers.close();
        while let Ok(reply) = answers.try_recv() {
            drop(reply);
        }
        session.shutdown().await;
        drop(session);
        (started, end)
    }
}

#[cfg(test)]
mod panic_tests {
    use super::*;
    #[test]
    fn panic_before_spawn_after_start_and_after_answer_settles_and_reaps() {
        for scenario in [
            Scenario::PanicBeforeSpawn,
            Scenario::PanicActive,
            Scenario::PanicAnswer,
            Scenario::PanicDrain,
            Scenario::PanicBeforePublication,
        ] {
            let mut provider = AcpFixture::create(scenario).unwrap();
            let monitor = provider.monitor();
            let request = RawJson(
                json!({"provider":"kiro","chatId":"fixture","cwd":provider.project(),"prompt":"fixture","permissionMode":"ask"}),
            );
            provider.start_turn(TurnId(1), &request).unwrap();
            let until = std::time::Instant::now() + Duration::from_secs(5);
            let mut events = Vec::new();
            let mut answered = false;
            loop {
                events.extend(provider.take_events());
                if matches!(scenario, Scenario::PanicAnswer) && !answered {
                    if let Some(id) = events.iter().find_map(|event| match event {
                        ProviderEvent::Agent {
                            event: RawJson(v), ..
                        } if v["type"] == "permission-request" => v["requestId"].as_str(),
                        _ => None,
                    }) {
                        provider
                            .respond_permission("fixture", TurnId(1), AnswerId(1), id, "allow")
                            .unwrap();
                        answered = true;
                    }
                }
                if events
                    .iter()
                    .any(|event| matches!(event, ProviderEvent::Exited { .. }))
                {
                    break;
                }
                assert!(
                    std::time::Instant::now() < until,
                    "{scenario:?}: {events:?}"
                );
                std::thread::sleep(Duration::from_millis(2));
            }
            assert_eq!(
                events
                    .iter()
                    .filter(|event| matches!(
                        event,
                        ProviderEvent::Exited {
                            turn: TurnId(1),
                            ..
                        }
                    ))
                    .count(),
                1
            );
            let starts = events
                .iter()
                .filter(|event| matches!(event, ProviderEvent::StartFailed { .. }))
                .count();
            let ends = events
                .iter()
                .filter(
                    |event| matches!(event,ProviderEvent::Agent{event:RawJson(v),..}if terminal(v)),
                )
                .count();
            if matches!(scenario, Scenario::PanicBeforeSpawn) {
                assert_eq!((starts, ends), (1, 0));
                assert!(monitor.pids().is_empty());
            } else {
                assert_eq!((starts, ends), (0, 1));
                assert_eq!(monitor.pids().len(), 1);
            }
            if matches!(scenario, Scenario::PanicAnswer) {
                assert_eq!(
                    events
                        .iter()
                        .filter(|event| matches!(
                            event,
                            ProviderEvent::AnswerSettled {
                                answer: AnswerId(1),
                                outcome: AnswerOutcome::Uncertain(_),
                                ..
                            }
                        ))
                        .count(),
                    1
                );
            }
            for (_, pid) in monitor.pids() {
                assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1);
                assert_eq!(
                    std::io::Error::last_os_error().raw_os_error(),
                    Some(libc::ESRCH)
                );
            }
            if matches!(scenario, Scenario::PanicDrain) {
                assert!(monitor.cleanup_failed());
                let until = std::time::Instant::now() + Duration::from_secs(2);
                while monitor.workers() != 0 {
                    assert!(std::time::Instant::now() < until);
                    std::thread::sleep(Duration::from_millis(1));
                }
                assert!(
                    !monitor.wait_stopped(Duration::from_secs(2)),
                    "cleanup failure remains visible after eventual reaping"
                );
            } else {
                assert!(monitor.wait_stopped(Duration::from_secs(2)));
            }
            assert_eq!(monitor.workers(), 0);
            assert!(
                provider.start_turn(TurnId(2), &request).is_err(),
                "panic seals further admission"
            );
            assert!(
                provider.take_events().is_empty(),
                "no duplicate terminal or answer later"
            );
        }
    }
}

#[cfg(test)]
mod delivery_tests {
    use super::*;
    #[test]
    fn stop_maps_two_distinct_native_permission_receipts_without_replay() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let mut options = FakeOptions {
                scenario: "blocked-two-answers".into(),
                ..Default::default()
            };
            options.limits.cancel_grace = Duration::from_secs(5);
            let (session, mut events) = FakeSession::launch(options).unwrap();
            let turn = session.send("fixture").unwrap();
            let mut requests = Vec::new();
            while requests.len() < 2 {
                if let SessionEvent::Permission {
                    turn_id,
                    request_id,
                    ..
                } = tokio::time::timeout(Duration::from_secs(2), events.recv())
                    .await
                    .unwrap()
                    .unwrap()
                {
                    assert_eq!(turn_id, turn);
                    requests.push(request_id);
                }
            }
            assert_eq!(requests[0].to_value(), json!("permission"));
            assert_eq!(requests[1].to_value(), json!("permission-2"));
            assert_ne!(requests[0], requests[1]);
            let first = session
                .admit_answer(turn, requests[0].clone(), Answer::AllowOnce)
                .unwrap();
            let second = session
                .admit_answer(turn, requests[1].clone(), Answer::AllowOnce)
                .unwrap();
            tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    let state = session.inspect().await.unwrap();
                    if state["writingPermission"] == "permission"
                        && state["queuedPermissionWrites"] == json!(["permission-2"])
                    {
                        assert_eq!(state["permissions"], 2);
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect(
                "both distinct writes must be claimed; the second must remain queued before Stop",
            );
            session.cancel();
            let first_result = first.wait().await;
            let second_result = second.wait().await;
            assert_eq!(first_result, Err(SessionError::UncertainDelivery));
            assert_eq!(second_result, Err(SessionError::Closed));
            assert!(matches!(
                answer_outcome(first_result),
                AnswerOutcome::Uncertain(_)
            ));
            assert!(matches!(
                answer_outcome(second_result),
                AnswerOutcome::Failed(_)
            ));
            let mut closed = Vec::new();
            let mut ends = 0;
            loop {
                match tokio::time::timeout(Duration::from_secs(3), events.recv())
                    .await
                    .unwrap()
                    .unwrap()
                {
                    SessionEvent::PermissionClosed {
                        turn_id,
                        request_id,
                        delivery,
                    } => {
                        assert_eq!(turn_id, turn);
                        closed.push((request_id, delivery));
                    }
                    SessionEvent::Agent { turn_id, event } if terminal(&event) => {
                        assert_eq!(turn_id, turn);
                        assert_eq!(event["type"], "turn-cancelled");
                        ends += 1;
                    }
                    SessionEvent::Closed { .. } => break,
                    _ => {}
                }
            }
            assert_eq!(
                closed,
                vec![
                    (requests[0].clone(), Delivery::Uncertain),
                    (requests[1].clone(), Delivery::NotSent)
                ]
            );
            assert_eq!(ends, 1);
            assert!(
                events.recv().await.is_none(),
                "no repeated closure or replay event"
            );
            assert!(
                matches!(
                    session.admit_answer(turn, requests[1].clone(), Answer::AllowOnce),
                    Err(SessionError::Closed)
                ),
                "the stopped queued answer cannot be replayed"
            );
            session.shutdown().await;
        });
    }
}

#[cfg(test)]
mod poison_tests {
    use super::*;
    #[test]
    fn poisoned_shared_locks_preserve_owner_and_worker_cleanup() {
        let mut provider = AcpFixture::create(Scenario::Permission).unwrap();
        for which in 0..4 {
            let shared = provider.shared.clone();
            assert!(std::thread::spawn(move || {
                match which {
                    0 => {
                        let _guard = shared
                            .output
                            .lock()
                            .unwrap_or_else(|error| error.into_inner());
                        panic!("fixed output poison");
                    }
                    1 => {
                        let _guard = shared
                            .answers
                            .lock()
                            .unwrap_or_else(|error| error.into_inner());
                        panic!("fixed answers poison");
                    }
                    2 => {
                        let _guard = shared
                            .workers
                            .lock()
                            .unwrap_or_else(|error| error.into_inner());
                        panic!("fixed workers poison");
                    }
                    _ => {
                        let _guard = shared
                            .pids
                            .lock()
                            .unwrap_or_else(|error| error.into_inner());
                        panic!("fixed pids poison");
                    }
                }
            })
            .join()
            .is_err());
        }
        let monitor = provider.monitor();
        let request = RawJson(
            json!({"provider":"kiro","chatId":"fixture","cwd":provider.project(),"prompt":"fixture","permissionMode":"ask"}),
        );
        provider.start_turn(TurnId(1), &request).unwrap();
        let until = std::time::Instant::now() + Duration::from_secs(5);
        let mut events = vec![];
        let mut answered = false;
        loop {
            events.extend(provider.take_events());
            if !answered {
                if let Some(id) = events.iter().find_map(|event| match event {
                    ProviderEvent::Agent {
                        event: RawJson(v), ..
                    } if v["type"] == "permission-request" => v["requestId"].as_str(),
                    _ => None,
                }) {
                    provider
                        .respond_permission("fixture", TurnId(1), AnswerId(1), id, "deny")
                        .unwrap();
                    answered = true;
                }
            }
            if events
                .iter()
                .any(|event| matches!(event, ProviderEvent::Exited { .. }))
            {
                break;
            }
            assert!(std::time::Instant::now() < until, "{events:?}");
            std::thread::sleep(Duration::from_millis(2));
        }
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, ProviderEvent::AnswerSettled { .. }))
                .count(),
            1
        );
        assert_eq!(
            events
                .iter()
                .filter(
                    |event| matches!(event,ProviderEvent::Agent{event:RawJson(v),..}if terminal(v))
                )
                .count(),
            1
        );
        assert!(monitor.wait_stopped(Duration::from_secs(2)));
        for (_, pid) in monitor.pids() {
            assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1);
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::ESRCH)
            );
        }
    }
}

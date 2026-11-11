//! Private retained executor core. No egress, queue, scheduler or caller-owned worker.
use super::*;
use crate::{budget::Reservation, registry::claim::Permit, supervisor::Clock};
use std::sync::{atomic::AtomicBool, Condvar, Mutex};
use std::thread::{self, JoinHandle};

pub(crate) const STACK_BYTES: usize = 2 * 1024 * 1024;
pub(crate) const EXECUTION_BYTES: usize = STACK_BYTES + 4096;
pub(crate) const METADATA_BYTES: usize = 2048;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Id {
    authority: [u8; 16],
    serial: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Fault {
    Full,
    Stale,
    Expired,
    Clock,
    Spawn,
    Worker,
    State,
}
#[derive(Clone, Copy)]
pub(crate) enum Outcome {
    Success,
    Unavailable,
    Timeout,
    #[cfg(test)]
    PanicBeforeBegin,
    #[cfg(test)]
    PanicAfterBegin,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum State {
    Claimed,
    Running,
    Ready,
    Cancelled,
    TimedOut,
    Failed,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Execution {
    NotStarted,
    MayHaveRun,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Observation {
    pub state: State,
    pub execution: Execution,
    pub status: Option<u16>,
    pub joined: bool,
}
#[derive(Default)]
struct Gate {
    begin: bool,
    cancel: bool,
    finish: bool,
}
struct Signal {
    gate: Mutex<Gate>,
    wake: Condvar,
    calls: AtomicUsize,
    poisoned: AtomicBool,
}
impl Signal {
    fn cancel(&self) {
        let mut g = self.gate.lock().unwrap_or_else(|e| {
            self.poisoned.store(true, Ordering::SeqCst);
            e.into_inner()
        });
        g.cancel = true;
        self.wake.notify_all();
    }
}
struct Joined(std::result::Result<Option<u16>, ()>);
struct Worker {
    signal: Arc<Signal>,
    thread: Option<JoinHandle<Option<u16>>>,
    execution: Option<Reservation>,
    pid: u32,
    #[cfg(test)]
    joins: Arc<AtomicUsize>,
}
impl Worker {
    fn finished(&self) -> bool {
        self.thread.as_ref().is_some_and(JoinHandle::is_finished)
    }
    fn join(&mut self) -> Joined {
        // No gate, epoch, Registry or observer lock is held across this join.
        let result = self
            .thread
            .take()
            .expect("single join")
            .join()
            .map_err(|_| ());
        drop(self.execution.take());
        #[cfg(test)]
        self.joins.fetch_add(1, Ordering::SeqCst);
        Joined(result)
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        if self.pid != std::process::id() {
            // Fork continuation cannot touch inherited synchronization objects.
            std::mem::forget(self.thread.take());
            std::mem::forget(self.execution.take());
            return;
        }
        if self.thread.is_some() {
            self.signal.cancel();
            let _ = self.join();
        }
    }
}
struct Entry {
    id: Id,
    device: String,
    permit: Permit,
    worker: Worker,
    joined: Option<Joined>,
    observation: Observation,
    http_deadline: u64,
    completion_deadline: u64,
    timeout: bool,
    _metadata: Reservation,
}
impl Entry {
    fn cancel(&mut self, state: State) {
        self.worker.signal.cancel();
        if !matches!(
            self.observation.state,
            State::Cancelled | State::TimedOut | State::Failed
        ) {
            self.observation.state = state;
        }
    }
    fn join(&mut self) -> bool {
        if self.joined.is_none() {
            self.joined = Some(self.worker.join());
        }
        self.observation.joined = true;
        self.joined.as_ref().unwrap().0.is_ok()
            && !self.worker.signal.poisoned.load(Ordering::SeqCst)
    }
}
#[derive(Default)]
pub(super) struct Core {
    entries: [Option<Entry>; 2],
    next: u64,
    last_time: u64,
    failed: bool,
    #[cfg(test)]
    failed_install: Option<(usize, usize)>,
}
impl Core {
    pub(super) fn cancel_device(&mut self, key: &str) {
        for e in self
            .entries
            .iter_mut()
            .flatten()
            .filter(|e| e.device == key)
        {
            e.cancel(State::Cancelled);
        }
    }
    fn entry(&self, id: Id) -> Option<&Entry> {
        self.entries.iter().flatten().find(|e| e.id == id)
    }
    fn entry_mut(&mut self, id: Id) -> Option<&mut Entry> {
        self.entries.iter_mut().flatten().find(|e| e.id == id)
    }
    pub(super) fn cancel_closed(&mut self) {
        for e in self.entries.iter_mut().flatten() {
            if matches!(
                e.permit.handle().status(),
                registry::CarrierStatus::Closed(_)
            ) {
                e.cancel(State::Cancelled);
            }
        }
    }
    pub(super) fn cancel_all(&mut self) {
        for e in self.entries.iter_mut().flatten() {
            e.cancel(State::Cancelled);
        }
    }
    pub(super) fn drain(&mut self) -> bool {
        self.cancel_all();
        // Keep ownership in the authority's table through every join.
        for slot in &mut self.entries {
            if let Some(e) = slot {
                if !e.join() {
                    self.failed = true;
                }
            }
            drop(slot.take());
        }
        !self.failed
    }
}
#[derive(Default, Clone)]
pub(super) struct Hooks {
    #[cfg(test)]
    pub hold: bool,
    #[cfg(test)]
    pub defer_begin: bool,
    #[cfg(test)]
    pub fail_installed: bool,
    #[cfg(test)]
    pub refuse_after_spawn: bool,
    #[cfg(test)]
    pub exit: Option<Arc<ExitGate>>,
}
fn admission(e: registry::claim::AdmissionError) -> Fault {
    match e {
        registry::claim::AdmissionError::Expired => Fault::Expired,
        registry::claim::AdmissionError::Registry(registry::RegistryError::Time) => Fault::Clock,
        registry::claim::AdmissionError::Registry(registry::RegistryError::Protocol(
            crate::Error::Budget,
        )) => Fault::Full,
        _ => Fault::Stale,
    }
}
fn run(signal: Arc<Signal>, outcome: Outcome, hold: bool) -> Option<u16> {
    #[cfg(test)]
    if matches!(outcome, Outcome::PanicBeforeBegin) {
        panic!("synthetic pre-Begin worker panic");
    }
    let mut gate = signal.gate.lock().unwrap_or_else(|e| {
        signal.poisoned.store(true, Ordering::SeqCst);
        e.into_inner()
    });
    while !gate.begin && !gate.cancel && !signal.poisoned.load(Ordering::SeqCst) {
        gate = signal.wake.wait(gate).unwrap_or_else(|e| {
            signal.poisoned.store(true, Ordering::SeqCst);
            e.into_inner()
        });
    }
    if gate.cancel || signal.poisoned.load(Ordering::SeqCst) {
        return None;
    }
    signal.calls.fetch_add(1, Ordering::SeqCst);
    while hold && !gate.finish && !gate.cancel && !signal.poisoned.load(Ordering::SeqCst) {
        gate = signal.wake.wait(gate).unwrap_or_else(|e| {
            signal.poisoned.store(true, Ordering::SeqCst);
            e.into_inner()
        });
    }
    if gate.cancel || signal.poisoned.load(Ordering::SeqCst) {
        return None;
    }
    drop(gate);
    match outcome {
        Outcome::Success => Some(200),
        Outcome::Unavailable => Some(502),
        Outcome::Timeout => Some(504),
        #[cfg(test)]
        Outcome::PanicAfterBegin => panic!("synthetic post-Begin worker panic"),
        #[cfg(test)]
        Outcome::PanicBeforeBegin => unreachable!(),
    }
}
impl PersistentAuthority {
    pub(crate) fn start_fixed(
        &mut self,
        token: WorkToken,
        outcome: Outcome,
        clock: &Clock,
    ) -> std::result::Result<Id, Fault> {
        self.start_fixed_inner(token, outcome, clock, Hooks::default())
    }
    pub(super) fn start_fixed_inner(
        &mut self,
        token: WorkToken,
        outcome: Outcome,
        clock: &Clock,
        hooks: Hooks,
    ) -> std::result::Result<Id, Fault> {
        self.check_registry().map_err(|_| Fault::Stale)?;
        let now = clock.now();
        self.poll_fixed(now)?;
        let index = self
            .fixed
            .entries
            .iter()
            .position(Option::is_none)
            .ok_or(Fault::Full)?;
        let serial = self.fixed.next.checked_add(1).ok_or(Fault::Full)?;
        let budget = self
            .registry
            .as_mut()
            .unwrap()
            .inspect_claim(&token, now)
            .map_err(admission)?;
        let metadata = budget.reserve(METADATA_BYTES).map_err(|_| Fault::Full)?;
        let device = self
            .registry
            .as_mut()
            .unwrap()
            .claim_device_key(&token, now)
            .map_err(|_| Fault::Stale)?;
        if self
            .fixed
            .entries
            .iter()
            .flatten()
            .any(|e| e.device == device)
        {
            return Err(Fault::Full);
        }
        now.checked_add(345_000).ok_or(Fault::Expired)?;
        let execution = budget.reserve(EXECUTION_BYTES).map_err(|_| Fault::Full)?;
        let signal = Arc::new(Signal {
            gate: Mutex::new(Gate::default()),
            wake: Condvar::new(),
            calls: AtomicUsize::new(0),
            poisoned: AtomicBool::new(false),
        });
        #[cfg(test)]
        let hold = hooks.hold;
        #[cfg(not(test))]
        let hold = {
            let _ = hooks;
            false
        };
        let s = signal.clone();
        #[cfg(test)]
        let exit = hooks.exit.clone();
        let thread = thread::Builder::new()
            .stack_size(STACK_BYTES)
            .spawn(move || {
                let result = run(s, outcome, hold);
                #[cfg(test)]
                if let Some(exit) = exit {
                    exit.wait();
                }
                result
            })
            .map_err(|_| Fault::Spawn)?;
        // This private construction guard joins if admission fails before table installation.
        let worker = Worker {
            signal,
            thread: Some(thread),
            execution: Some(execution),
            pid: self.pid,
            #[cfg(test)]
            joins: Arc::new(AtomicUsize::new(0)),
        };
        #[cfg(test)]
        if hooks.refuse_after_spawn {
            return Err(self.refuse_fixed_worker(worker, Fault::Spawn));
        }
        let admission = (|| {
            let now = clock.now();
            let http = now.checked_add(340_000).ok_or(Fault::Expired)?;
            let completion = now.checked_add(345_000).ok_or(Fault::Expired)?;
            let permit = self
                .registry
                .as_mut()
                .unwrap()
                .claim_work(&token, now)
                .map_err(admission)?;
            Ok((now, http, completion, permit))
        })();
        let (_claim_at, http_deadline, completion_deadline, permit) = match admission {
            Ok(admitted) => admitted,
            Err(fault) => return Err(self.refuse_fixed_worker(worker, fault)),
        };
        let id = Id {
            authority: self.core.as_ref().unwrap().instance,
            serial,
        };
        self.fixed.next = serial;
        self.fixed.entries[index] = Some(Entry {
            id,
            device,
            permit,
            worker,
            joined: None,
            http_deadline,
            completion_deadline,
            timeout: false,
            _metadata: metadata,
            observation: Observation {
                state: State::Claimed,
                execution: Execution::NotStarted,
                status: None,
                joined: false,
            },
        });
        #[cfg(test)]
        if hooks.fail_installed {
            let signal = self.fixed.entry(id).unwrap().worker.signal.clone();
            let probe = self.fixed_probe(id);
            self.abort_in_place();
            self.fixed.drain();
            self.fixed.failed_install = Some((signal.calls.load(Ordering::SeqCst), probe.joins()));
            return Err(Fault::Worker);
        }
        #[cfg(test)]
        if hooks.defer_begin {
            return Ok(id);
        }
        self.begin_fixed(id, clock.now())?;
        Ok(id)
    }
    fn refuse_fixed_worker(&mut self, mut worker: Worker, fault: Fault) -> Fault {
        worker.signal.cancel();
        let joined = worker.join();
        #[cfg(test)]
        {
            self.fixed.failed_install = Some((
                worker.signal.calls.load(Ordering::SeqCst),
                worker.joins.load(Ordering::SeqCst),
            ));
        }
        if joined.0.is_err() || worker.signal.poisoned.load(Ordering::SeqCst) {
            self.abort_in_place();
            Fault::Worker
        } else {
            fault
        }
    }
    fn begin_fixed(&mut self, id: Id, now: u64) -> std::result::Result<(), Fault> {
        self.check_registry().map_err(|_| Fault::Stale)?;
        let entry = self.fixed.entry_mut(id).ok_or(Fault::Stale)?;
        if entry.observation.state != State::Claimed {
            return Err(Fault::State);
        }
        if now >= entry.http_deadline {
            entry.cancel(State::TimedOut);
            return Err(Fault::Expired);
        }
        let result = self
            .registry
            .as_mut()
            .unwrap()
            .claim_barrier(&entry.permit, now, || {
                let mut gate = entry
                    .worker
                    .signal
                    .gate
                    .lock()
                    .map_err(|_| crate::Error::Unauthorized)?;
                if gate.cancel {
                    return Err(crate::Error::Unauthorized);
                }
                entry.observation.execution = Execution::MayHaveRun;
                entry.observation.state = State::Running;
                gate.begin = true;
                entry.worker.signal.wake.notify_all();
                Ok(())
            });
        if result.is_err() {
            entry.cancel(State::Cancelled);
            if entry.worker.signal.gate.is_poisoned() {
                self.abort_in_place();
                return Err(Fault::Worker);
            }
            return Err(Fault::Stale);
        }
        Ok(())
    }
    pub(crate) fn observe_fixed(&self, id: Id) -> Option<Observation> {
        if self.pid != std::process::id() {
            return None;
        }
        self.fixed.entry(id).map(|e| e.observation)
    }
    pub(crate) fn cancel_fixed(&mut self, id: Id) -> std::result::Result<(), Fault> {
        if self.pid != std::process::id() {
            return Err(Fault::Stale);
        }
        self.fixed
            .entry_mut(id)
            .ok_or(Fault::Stale)?
            .cancel(State::Cancelled);
        Ok(())
    }
    /// No completed flag is accepted as join evidence; unfinished handles remain owned.
    pub(crate) fn poll_fixed(&mut self, now: u64) -> std::result::Result<(), Fault> {
        if self.pid != std::process::id() {
            return Err(Fault::Stale);
        }
        if now < self.fixed.last_time {
            self.abort_in_place();
            return Err(Fault::Clock);
        }
        self.fixed.last_time = now;
        if self.check_registry().is_err() {
            self.abort_in_place();
            return Err(Fault::Stale);
        }
        let registry = self.registry.as_mut().unwrap();
        for entry in self.fixed.entries.iter_mut().flatten() {
            if entry.worker.signal.gate.is_poisoned()
                || entry.worker.signal.poisoned.load(Ordering::SeqCst)
            {
                self.fixed.failed = true;
                entry.cancel(State::Failed);
            }
            if now >= entry.completion_deadline {
                entry.cancel(State::TimedOut);
            } else if !registry.claim_read_allowed(&entry.permit, now) {
                entry.cancel(State::Cancelled);
            } else if now >= entry.http_deadline
                && matches!(entry.observation.state, State::Claimed | State::Running)
            {
                entry.timeout = true;
                entry.worker.signal.cancel();
            }
            if entry.joined.is_none() && entry.worker.finished() {
                if !entry.join() {
                    entry.observation.state = State::Failed;
                    self.fixed.failed = true;
                } else if matches!(entry.observation.state, State::Claimed | State::Running) {
                    entry.observation.status = if entry.timeout {
                        Some(504)
                    } else {
                        entry
                            .joined
                            .as_ref()
                            .unwrap()
                            .0
                            .as_ref()
                            .unwrap()
                            .to_owned()
                    };
                    entry.observation.state = if entry.observation.status.is_some() {
                        State::Ready
                    } else {
                        State::Cancelled
                    };
                }
            }
            if entry.joined.is_some()
                && matches!(
                    entry.observation.state,
                    State::Cancelled | State::TimedOut | State::Failed
                )
            {
                registry.end_claim(
                    &entry.permit,
                    if entry.observation.state == State::TimedOut {
                        registry::WorkStatus::TimedOut
                    } else {
                        registry::WorkStatus::Cancelled
                    },
                    now,
                );
            }
        }
        if self.fixed.failed {
            self.abort_in_place();
            return Err(Fault::Worker);
        }
        Ok(())
    }
    /// Explicitly discard this core-only result; it cannot be transmitted or replayed.
    pub(crate) fn discard_fixed(&mut self, id: Id, now: u64) -> std::result::Result<(), Fault> {
        self.cancel_fixed(id)?;
        self.poll_fixed(now)?;
        let index = self
            .fixed
            .entries
            .iter()
            .position(|e| e.as_ref().is_some_and(|e| e.id == id))
            .ok_or(Fault::Stale)?;
        if self.fixed.entries[index].as_ref().unwrap().joined.is_none() {
            return Err(Fault::Full);
        }
        drop(self.fixed.entries[index].take());
        Ok(())
    }
}

#[cfg(test)]
pub(super) struct Probe {
    signal: std::sync::Weak<Signal>,
    joined: Arc<AtomicUsize>,
}
#[cfg(test)]
impl Probe {
    pub fn calls(&self) -> usize {
        self.signal
            .upgrade()
            .map_or(0, |s| s.calls.load(Ordering::SeqCst))
    }
    pub fn joins(&self) -> usize {
        self.joined.load(Ordering::SeqCst)
    }
    pub fn cancelled(&self) -> bool {
        self.signal
            .upgrade()
            .is_none_or(|s| s.gate.lock().unwrap_or_else(|e| e.into_inner()).cancel)
    }
    pub fn finish(&self) {
        if let Some(s) = self.signal.upgrade() {
            s.gate.lock().unwrap().finish = true;
            s.wake.notify_all();
        }
    }
    pub fn poison(&self) {
        let s = self.signal.upgrade().unwrap();
        let _ = std::panic::catch_unwind(|| {
            let _lock = s.gate.lock().unwrap();
            panic!("synthetic fixed signal poison");
        });
        s.wake.notify_all();
    }
}
#[cfg(test)]
impl PersistentAuthority {
    pub(super) fn fixed_probe(&self, id: Id) -> Probe {
        let e = self.fixed.entry(id).unwrap();
        Probe {
            signal: Arc::downgrade(&e.worker.signal),
            joined: e.worker.joins.clone(),
        }
    }
    pub(super) fn fixed_thread_finished(&self, id: Id) -> bool {
        self.fixed.entry(id).unwrap().worker.finished()
    }
    pub(super) fn fixed_test_begin(&mut self, id: Id, now: u64) -> std::result::Result<(), Fault> {
        self.begin_fixed(id, now)
    }
}

#[cfg(test)]
#[derive(Default)]
pub(super) struct ExitGate {
    entered: AtomicBool,
    open: Mutex<bool>,
    wake: Condvar,
}
#[cfg(test)]
impl ExitGate {
    fn wait(&self) {
        let open = self.open.lock().unwrap();
        self.entered.store(true, Ordering::SeqCst);
        drop(self.wake.wait_while(open, |open| !*open).unwrap());
    }
    pub fn entered(&self) -> bool {
        self.entered.load(Ordering::SeqCst)
    }
    pub fn release(&self) {
        *self.open.lock().unwrap() = true;
        self.wake.notify_all();
    }
}
#[cfg(test)]
impl PersistentAuthority {
    pub(super) fn fixed_failed_install_stats(&self) -> Option<(usize, usize)> {
        self.fixed.failed_install
    }
}

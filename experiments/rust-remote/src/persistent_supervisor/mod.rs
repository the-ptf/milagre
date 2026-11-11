//! Joined thread ownership over a fresh synthetic profile. No network or imported store.
#![allow(
    clippy::result_large_err,
    reason = "typed faults retain profile and exact writer locks"
)]
use crate::{
    budget::{GlobalBudget, Reservation},
    persistent::{
        CleanStop, OpenedAuthority, PersistentAuthority, PersistentLimits, Quarantine,
        RejectedAuthority, RetiredProfile, RetiredStop, StoppedAuthority,
    },
    supervisor::{Clock, Limits, CONTROL_RESERVE_BYTES},
    synthetic_store::{StoreDiagnostics, StoreFault, SyntheticProfile},
};
use rand_core::OsRng;
use std::{
    panic::{catch_unwind, AssertUnwindSafe},
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering},
        mpsc, Arc, Condvar, Mutex, MutexGuard,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum WorkerFault {
    Panic = 1,
    Poisoned,
    Clock,
    InvalidExit,
    Aborted,
    EventOverflow,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StartFault {
    InvalidLimits,
    Store(StoreFault),
    Quarantined,
    Retired,
    Reservation,
    Spawn(std::io::ErrorKind),
    Worker(WorkerFault),
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseFault {
    Store(StoreFault),
    Worker(WorkerFault),
}
#[derive(Clone, Copy, Debug)]
pub struct ServiceDiagnostics {
    pub store: Option<StoreDiagnostics>,
    pub worker_joined: bool,
}
#[allow(clippy::large_enum_variant)]
enum Guard {
    Rejected(RejectedAuthority),
    Quarantine(Quarantine),
    Retired(RetiredProfile),
    Stopped(StoppedAuthority),
}
pub struct StoppedService {
    profile: SyntheticProfile,
    guard: Option<Guard>,
    joined: bool,
}
pub struct PersistentStartFailure {
    fault: StartFault,
    stopped: StoppedService,
}
pub struct PersistentCloseFailure {
    fault: CloseFault,
    stopped: StoppedService,
}
pub struct PersistentReleaseFailure {
    fault: StoreFault,
    stopped: StoppedService,
}
pub struct CleanServiceStop {
    receipt: CleanStop,
    profile: SyntheticProfile,
}
pub struct RetiredServiceStop {
    receipt: RetiredStop,
    profile: SyntheticProfile,
}
impl CleanServiceStop {
    pub fn into_parts(self) -> (CleanStop, SyntheticProfile) {
        (self.receipt, self.profile)
    }
}
impl RetiredServiceStop {
    pub fn into_parts(self) -> (RetiredStop, SyntheticProfile) {
        (self.receipt, self.profile)
    }
}
impl PersistentStartFailure {
    pub fn into_parts(self) -> (StartFault, StoppedService) {
        (self.fault, self.stopped)
    }
}
impl PersistentCloseFailure {
    pub fn into_parts(self) -> (CloseFault, StoppedService) {
        (self.fault, self.stopped)
    }
}
impl PersistentReleaseFailure {
    pub fn into_parts(self) -> (StoreFault, StoppedService) {
        (self.fault, self.stopped)
    }
}
impl StoppedService {
    pub fn diagnostics(&self) -> ServiceDiagnostics {
        let store = self.guard.as_ref().map(|g| match g {
            Guard::Rejected(g) => g.diagnostics(),
            Guard::Quarantine(g) => g.diagnostics(),
            Guard::Retired(g) => g.diagnostics(),
            Guard::Stopped(g) => g.diagnostics(),
        });
        ServiceDiagnostics {
            store,
            worker_joined: self.joined,
        }
    }
    pub fn release(mut self) -> Result<SyntheticProfile, PersistentReleaseFailure> {
        match self.guard.take() {
            Some(Guard::Rejected(g)) => {
                if let Err(e) = g.release() {
                    let (fault, guard) = e.into_parts();
                    self.guard = Some(Guard::Quarantine(guard));
                    return Err(PersistentReleaseFailure {
                        fault,
                        stopped: self,
                    });
                }
            }
            Some(Guard::Quarantine(g)) => {
                g.release();
            }
            Some(Guard::Retired(g)) => {
                g.release();
            }
            Some(Guard::Stopped(g)) => {
                g.release();
            }
            None => (),
        }
        Ok(self.profile)
    }
}
const RUNNING: u8 = 0;
const REQUESTED: u8 = 1;
const ABORT: u8 = 2;
struct Queues {
    reserve: Option<Reservation>,
}
struct Shared {
    queues: Mutex<Queues>,
    wake: Condvar,
    stop: AtomicU8,
    fatal: AtomicU8,
    finished: AtomicBool,
    ticks: AtomicU64,
    global: GlobalBudget,
    limits: Limits,
}
impl Shared {
    fn new(global: GlobalBudget, limits: Limits) -> crate::Result<Self> {
        let reserve = global
            .connection(CONTROL_RESERVE_BYTES)?
            .reserve(CONTROL_RESERVE_BYTES)?;
        Ok(Self {
            queues: Mutex::new(Queues {
                reserve: Some(reserve),
            }),
            wake: Condvar::new(),
            stop: AtomicU8::new(RUNNING),
            fatal: AtomicU8::new(0),
            finished: AtomicBool::new(false),
            ticks: AtomicU64::new(0),
            global,
            limits,
        })
    }
    fn fail(&self, fault: WorkerFault) {
        let _ = self
            .fatal
            .compare_exchange(0, fault as u8, Ordering::SeqCst, Ordering::SeqCst);
        self.stop.fetch_max(ABORT, Ordering::SeqCst);
        self.wake.notify_all();
    }
    fn fault(&self) -> Option<WorkerFault> {
        match self.fatal.load(Ordering::SeqCst) {
            0 => None,
            1 => Some(WorkerFault::Panic),
            2 => Some(WorkerFault::Poisoned),
            3 => Some(WorkerFault::Clock),
            4 => Some(WorkerFault::InvalidExit),
            5 => Some(WorkerFault::Aborted),
            _ => Some(WorkerFault::EventOverflow),
        }
    }
    fn queues(&self) -> MutexGuard<'_, Queues> {
        self.queues.lock().unwrap_or_else(|e| {
            self.fail(WorkerFault::Poisoned);
            e.into_inner()
        })
    }
    fn request_stop(&self, abort: bool) {
        let _q = self.queues(); // Same synchronization as admission in the next service layer.
        self.stop
            .fetch_max(if abort { ABORT } else { REQUESTED }, Ordering::SeqCst);
        self.wake.notify_all();
    }
    fn drain(&self) {
        self.queues().reserve.take();
    }
}
struct Runtime {
    authority: PersistentAuthority,
    clock: Clock,
}
impl Runtime {
    fn run(&mut self, shared: &Shared) {
        while shared.stop.load(Ordering::SeqCst) == RUNNING {
            if self.authority.tick(self.clock.now()).is_err() {
                shared.fail(WorkerFault::Clock);
                break;
            }
            shared.ticks.fetch_add(1, Ordering::SeqCst);
            let q = shared.queues();
            let _wait = shared
                .wake
                .wait_timeout_while(q, Duration::from_millis(shared.limits.tick_ms), |_| {
                    shared.stop.load(Ordering::SeqCst) == RUNNING
                })
                .unwrap_or_else(|e| {
                    shared.fail(WorkerFault::Poisoned);
                    e.into_inner()
                });
        }
    }
    fn finish(&mut self, shared: &Shared) -> bool {
        if shared.stop.load(Ordering::SeqCst) != REQUESTED || shared.fault().is_some() {
            self.authority.abort_in_place();
            shared.drain();
            return false;
        }
        let healthy = self.authority.quiesce_for_join().is_ok();
        if !healthy {
            shared.fail(WorkerFault::InvalidExit);
            self.authority.abort_in_place();
        }
        shared.drain();
        healthy && shared.fault().is_none()
    }
}
struct Slot {
    runtime: Option<Runtime>,
    quiesced: bool,
}
fn slot<'a>(slot: &'a Mutex<Slot>, shared: &Shared) -> MutexGuard<'a, Slot> {
    slot.lock().unwrap_or_else(|e| {
        shared.fail(WorkerFault::Poisoned);
        e.into_inner()
    })
}
#[derive(Clone, Copy, Default)]
struct Hooks {
    #[cfg(test)]
    reserve_failure: bool,
    #[cfg(test)]
    spawn_failure: bool,
    #[cfg(test)]
    startup_panic: bool,
    #[cfg(test)]
    poison_slot: bool,
}
/// Owns the broker capability and JoinHandle before startup is advertised.
/// Drop always aborts and joins; it never calls a consuming terminal write.
pub struct PersistentSupervisor {
    profile: Option<SyntheticProfile>,
    retained: Arc<Mutex<Slot>>,
    shared: Arc<Shared>,
    worker: Option<JoinHandle<()>>,
}
fn validate(l: Limits) -> bool {
    PersistentLimits {
        policy: l.authority,
        registry: l.registry,
    }
    .validate()
    .is_ok()
        && (1..=256).contains(&l.commands)
        && (1..=1024).contains(&l.events)
        && (1024..=64 * 1024 * 1024).contains(&l.command_bytes)
        && (1..=256).contains(&l.carrier_frames)
        && (1..=64 * 1024 * 1024).contains(&l.carrier_bytes)
        && (1..=100).contains(&l.tick_ms)
}
impl PersistentSupervisor {
    pub fn start(
        profile: SyntheticProfile,
        limits: Limits,
        clock: Clock,
    ) -> Result<Self, PersistentStartFailure> {
        Self::start_inner(profile, limits, clock, Hooks::default())
    }
    fn start_inner(
        mut profile: SyntheticProfile,
        limits: Limits,
        clock: Clock,
        hooks: Hooks,
    ) -> Result<Self, PersistentStartFailure> {
        let reject = |profile, fault, guard| PersistentStartFailure {
            fault,
            stopped: StoppedService {
                profile,
                guard,
                joined: false,
            },
        };
        if !validate(limits) {
            return Err(reject(profile, StartFault::InvalidLimits, None));
        }
        let pool = match profile.service_pool() {
            Ok(pool) => pool,
            Err(fault) => return Err(reject(profile, StartFault::Store(fault), None)),
        };
        let shared = match Shared::new(pool, limits) {
            Ok(shared) => Arc::new(shared),
            Err(_) => return Err(reject(profile, StartFault::Reservation, None)),
        };
        let writer = match profile.acquire_writer() {
            Ok(w) => w,
            Err(e) => return Err(reject(profile, StartFault::Store(e), None)),
        };
        let authority = match PersistentAuthority::resume(
            writer,
            PersistentLimits {
                policy: limits.authority,
                registry: limits.registry,
            },
            &mut OsRng,
        ) {
            OpenedAuthority::Ready(a) => a,
            OpenedAuthority::Rejected(g) => {
                return Err(reject(
                    profile,
                    StartFault::InvalidLimits,
                    Some(Guard::Rejected(g)),
                ))
            }
            OpenedAuthority::Quarantined(g) => {
                return Err(reject(
                    profile,
                    StartFault::Quarantined,
                    Some(Guard::Quarantine(g)),
                ))
            }
            OpenedAuthority::Retired(g) => {
                return Err(reject(
                    profile,
                    StartFault::Retired,
                    Some(Guard::Retired(g)),
                ))
            }
        };
        #[cfg(test)]
        if hooks.reserve_failure {
            // A later fallible startup step after Running must never restore Clean.
            assert!(shared.global.connection(1).unwrap().reserve(2).is_err());
            return Err(reject(
                profile,
                StartFault::Reservation,
                Some(Guard::Stopped(authority.abort_without_commit())),
            ));
        }
        let retained = Arc::new(Mutex::new(Slot {
            runtime: Some(Runtime { authority, clock }),
            quiesced: false,
        }));
        let mut owner = Self {
            profile: Some(profile),
            retained: retained.clone(),
            shared: shared.clone(),
            worker: None,
        };
        #[cfg(test)]
        if hooks.spawn_failure {
            let stopped = owner.stopped(true);
            return Err(PersistentStartFailure {
                fault: StartFault::Spawn(std::io::ErrorKind::WouldBlock),
                stopped,
            });
        }
        let (startup, ready) = mpsc::sync_channel(1);
        let launched = thread::Builder::new()
            .name("synthetic-persistent-remote".into())
            .spawn(move || worker_main(retained, shared, startup, hooks));
        match launched {
            Ok(handle) => owner.worker = Some(handle),
            Err(e) => {
                let stopped = owner.stopped(true);
                return Err(PersistentStartFailure {
                    fault: StartFault::Spawn(e.kind()),
                    stopped,
                });
            }
        }
        if ready.recv().is_err() || owner.shared.fault().is_some() {
            let stopped = owner.stopped(true);
            return Err(PersistentStartFailure {
                fault: StartFault::Worker(owner.shared.fault().unwrap_or(WorkerFault::InvalidExit)),
                stopped,
            });
        }
        Ok(owner)
    }
    pub fn retained_bytes(&self) -> usize {
        self.shared.global.used()
    }
    pub fn ticks(&self) -> u64 {
        self.shared.ticks.load(Ordering::SeqCst)
    }
    fn join(&mut self, abort: bool) {
        self.shared.request_stop(abort);
        if let Some(worker) = self.worker.take() {
            if worker.join().is_err() {
                self.shared.fail(WorkerFault::Panic);
            }
        }
    }
    fn take_runtime(&mut self) -> Runtime {
        // Called only after join. No queue or retained-slot mutex is held while joining.
        let mut retained = slot(&self.retained, &self.shared);
        let mut runtime = retained.runtime.take().expect("single terminal owner");
        if !retained.quiesced
            || self.shared.fault().is_some()
            || self.shared.stop.load(Ordering::SeqCst) == ABORT
        {
            runtime.authority.abort_in_place();
        }
        runtime
    }
    fn stopped(&mut self, abort: bool) -> StoppedService {
        let joined = self.worker.is_some();
        self.join(abort);
        let runtime = self.take_runtime();
        self.shared.drain();
        StoppedService {
            profile: self.profile.take().unwrap(),
            guard: Some(Guard::Stopped(runtime.authority.abort_without_commit())),
            joined,
        }
    }
    pub fn abort(mut self) -> StoppedService {
        self.stopped(true)
    }
    pub fn close_for_restart(mut self) -> Result<CleanServiceStop, PersistentCloseFailure> {
        self.join(false);
        let runtime = self.take_runtime();
        let profile = self.profile.take().unwrap();
        if let Some(fault) = self.shared.fault().or_else(|| {
            (self.shared.stop.load(Ordering::SeqCst) == ABORT).then_some(WorkerFault::Aborted)
        }) {
            return Err(PersistentCloseFailure {
                fault: CloseFault::Worker(fault),
                stopped: StoppedService {
                    profile,
                    guard: Some(Guard::Stopped(runtime.authority.abort_without_commit())),
                    joined: true,
                },
            });
        }
        match runtime.authority.close_for_restart() {
            Ok(receipt) => Ok(CleanServiceStop { receipt, profile }),
            Err(e) => {
                let (fault, guard) = e.into_parts();
                Err(PersistentCloseFailure {
                    fault: CloseFault::Store(fault),
                    stopped: StoppedService {
                        profile,
                        guard: Some(Guard::Stopped(guard)),
                        joined: true,
                    },
                })
            }
        }
    }
    pub fn retire_identity(mut self) -> Result<RetiredServiceStop, PersistentCloseFailure> {
        self.join(false);
        let runtime = self.take_runtime();
        let profile = self.profile.take().unwrap();
        if let Some(fault) = self.shared.fault().or_else(|| {
            (self.shared.stop.load(Ordering::SeqCst) == ABORT).then_some(WorkerFault::Aborted)
        }) {
            return Err(PersistentCloseFailure {
                fault: CloseFault::Worker(fault),
                stopped: StoppedService {
                    profile,
                    guard: Some(Guard::Stopped(runtime.authority.abort_without_commit())),
                    joined: true,
                },
            });
        }
        match runtime.authority.retire_identity() {
            Ok(receipt) => Ok(RetiredServiceStop { receipt, profile }),
            Err(e) => {
                let (fault, guard) = e.into_parts();
                Err(PersistentCloseFailure {
                    fault: CloseFault::Store(fault),
                    stopped: StoppedService {
                        profile,
                        guard: Some(Guard::Stopped(guard)),
                        joined: true,
                    },
                })
            }
        }
    }
}
impl Drop for PersistentSupervisor {
    fn drop(&mut self) {
        if self.profile.is_some() {
            drop(self.stopped(true));
        }
    }
}
fn worker_main(
    retained: Arc<Mutex<Slot>>,
    shared: Arc<Shared>,
    startup: mpsc::SyncSender<()>,
    _hooks: Hooks,
) {
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        let mut slot = slot(&retained, &shared);
        #[cfg(test)]
        if _hooks.poison_slot {
            panic!("synthetic retained-slot poison");
        }
        let runtime = slot.runtime.as_mut().unwrap();
        let ran = catch_unwind(AssertUnwindSafe(|| {
            #[cfg(test)]
            if _hooks.startup_panic {
                panic!("synthetic startup panic");
            }
            if shared.fault().is_some() {
                return;
            }
            let _ = startup.try_send(());
            runtime.run(&shared);
        }));
        if ran.is_err() {
            shared.fail(WorkerFault::Panic);
        }
        slot.quiesced = runtime.finish(&shared);
    }));
    if outcome.is_err() {
        shared.fail(WorkerFault::Panic);
    }
    // Includes poison discovered while recovering after the outer unwind.
    if shared.fault().is_some() {
        let mut slot = slot(&retained, &shared);
        slot.quiesced = false;
        if let Some(runtime) = &mut slot.runtime {
            runtime.authority.abort_in_place();
        }
        shared.drain();
    }
    shared.finished.store(true, Ordering::SeqCst);
    shared.wake.notify_all();
}
#[cfg(all(test, target_os = "macos"))]
mod tests;

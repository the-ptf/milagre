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
#[allow(dead_code)]
pub(crate) mod fixed;
mod service;
pub(crate) mod wake;
use crate::budget::ConnectionBudget;
use rand_core::OsRng;
pub use service::{
    ApprovalRefusal, ApprovalRejection, Event, PersistentApproval, PersistentCarrierClient,
    PersistentCommand, PersistentOwnerClient, Receipt, Reply,
};
use service::{Carrier, Pending};
use std::collections::{BTreeMap, VecDeque};
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
    WakeOverflow,
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
#[derive(Default)]
struct Queues {
    reserve: Option<Reservation>,
    commands: VecDeque<service::Envelope>,
    controls: VecDeque<service::Envelope>,
    events: VecDeque<service::Notification>,
    work_ready: bool,
    fixed: Option<Box<fixed::State>>,
}
struct Shared {
    queues: Mutex<Queues>,
    wake: Condvar,
    stop: AtomicU8,
    fatal: AtomicU8,
    finished: AtomicBool,
    ticks: AtomicU64,
    global: GlobalBudget,
    ingress: ConnectionBudget,
    events: ConnectionBudget,
    scope: Arc<()>,
    clock: Clock,
    changed: Condvar,
    closed_dropped: AtomicU64,
    limits: Limits,
    fixed_wake: Option<wake::WakeAccess>,
}
impl Shared {
    fn new(
        global: GlobalBudget,
        limits: Limits,
        clock: Clock,
        fixed_fixture: bool,
    ) -> crate::Result<Self> {
        let reserve = global
            .connection(CONTROL_RESERVE_BYTES)?
            .reserve(CONTROL_RESERVE_BYTES)?;
        let mut fixed = if fixed_fixture {
            Some(fixed::State::new(&global)?)
        } else {
            None
        };
        let fixed_wake = if let Some(state) = fixed.as_mut() {
            let access = wake::WakeAccess::new(state.split_wake_charge()?);
            if Some(access.held_bytes()) != wake::wake_charge() {
                return Err(crate::Error::Budget);
            }
            Some(access)
        } else {
            None
        };
        Ok(Self {
            queues: Mutex::new(Queues {
                reserve: Some(reserve),
                fixed,
                ..Default::default()
            }),
            wake: Condvar::new(),
            stop: AtomicU8::new(RUNNING),
            fatal: AtomicU8::new(0),
            finished: AtomicBool::new(false),
            ticks: AtomicU64::new(0),
            ingress: global.connection(limits.command_bytes)?,
            events: global.connection(limits.events * 2048)?,
            scope: Arc::new(()),
            clock,
            changed: Condvar::new(),
            closed_dropped: AtomicU64::new(0),
            global,
            limits,
            fixed_wake,
        })
    }
    fn overflowed(&self) -> bool {
        self.fixed_wake
            .as_ref()
            .and_then(wake::WakeAccess::hub)
            .is_some_and(|hub| hub.overflowed())
    }
    fn running(&self) -> bool {
        self.stop.load(Ordering::SeqCst) == RUNNING && !self.overflowed()
    }
    fn notify_work(&self) {
        if let Some(hub) = self.fixed_wake.as_ref().and_then(wake::WakeAccess::hub) {
            hub.wake();
        } else {
            self.wake.notify_all();
        }
    }
    fn fail(&self, fault: WorkerFault) {
        self.fail_atomic(fault);
        self.notify_work();
        self.changed.notify_all();
    }
    fn fail_atomic(&self, fault: WorkerFault) {
        let _ = self
            .fatal
            .compare_exchange(0, fault as u8, Ordering::SeqCst, Ordering::SeqCst);
        self.stop.fetch_max(ABORT, Ordering::SeqCst);
    }
    fn fault(&self) -> Option<WorkerFault> {
        match self.fatal.load(Ordering::SeqCst) {
            0 => None,
            1 => Some(WorkerFault::Panic),
            2 => Some(WorkerFault::Poisoned),
            3 => Some(WorkerFault::Clock),
            4 => Some(WorkerFault::InvalidExit),
            5 => Some(WorkerFault::Aborted),
            7 => Some(WorkerFault::WakeOverflow),
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
        let _q = self.queues(); // Same synchronization as command and approval admission.
        self.stop
            .fetch_max(if abort { ABORT } else { REQUESTED }, Ordering::SeqCst);
        self.notify_work();
        self.changed.notify_all();
    }
    fn drain(&self, _drained: &crate::persistent::composition::RunDrained) {
        let mut q = self.queues();
        for e in q.controls.drain(..) {
            e.reject();
        }
        for e in q.commands.drain(..) {
            e.reject();
        }
        q.events.clear();
        q.work_ready = false;
        q.reserve.take();
        q.fixed.take();
        self.changed.notify_all();
    }
}
struct Runtime {
    authority: PersistentAuthority,
    clock: Clock,
    carriers: BTreeMap<u64, Carrier>,
    pending: BTreeMap<u64, Pending>,
    serial: u64,
    fixed: Option<Box<fixed::RuntimeFixed>>,
    #[cfg(test)]
    after_apply: Option<Box<dyn FnOnce() + Send>>,
}
impl Runtime {
    fn drain_owned(&mut self, shared: &Shared) -> bool {
        let drained = match self.authority.drain_fixed_for_owner() {
            Ok(drained) => drained,
            Err(_) => {
                shared.fail(WorkerFault::InvalidExit);
                return false;
            }
        };
        if !drained.healthy() {
            shared.fail(WorkerFault::InvalidExit);
        }
        #[cfg(test)]
        if let Some(hub) = self.fixed.as_ref().and_then(|fixed| fixed.hub.as_ref()) {
            assert_eq!(
                Arc::weak_count(hub),
                1,
                "worker/Packet wake tokens must be gone before run references drop"
            );
        }
        self.clear_owned(&drained);
        shared.drain(&drained);
        drained.healthy()
    }
    fn finish(&mut self, shared: &Shared) -> bool {
        if shared.stop.load(Ordering::SeqCst) == RUNNING {
            shared.fail(if shared.overflowed() {
                WorkerFault::WakeOverflow
            } else {
                WorkerFault::InvalidExit
            });
        }
        if shared.stop.load(Ordering::SeqCst) != REQUESTED || shared.fault().is_some() {
            self.authority.abort_in_place();
            self.drain_owned(shared);
            return false;
        }
        let healthy = self.authority.quiesce_for_join().is_ok();
        if !healthy {
            shared.fail(WorkerFault::InvalidExit);
            self.authority.abort_in_place();
        }
        self.drain_owned(shared);
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
    fixed_fixture: bool,
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
/// ```compile_fail
/// use milagre_remote::persistent_supervisor::fixed::FixedFixture;
/// ```
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
        if !validate(limits)
            || (hooks.fixed_fixture
                && (limits.carrier_bytes < 1024
                    || limits.carrier_bytes > 32 * 1024 * 1024
                    || limits.registry.outbound_bytes < 1024))
        {
            return Err(reject(profile, StartFault::InvalidLimits, None));
        }
        let pool = match profile.service_pool() {
            Ok(pool) => pool,
            Err(fault) => return Err(reject(profile, StartFault::Store(fault), None)),
        };
        let shared = match Shared::new(pool, limits, clock.clone(), hooks.fixed_fixture) {
            Ok(shared) => Arc::new(shared),
            Err(_) => return Err(reject(profile, StartFault::Reservation, None)),
        };
        let fixed = if hooks.fixed_fixture {
            let hub = wake::WakeHub::new(&shared);
            shared
                .fixed_wake
                .as_ref()
                .unwrap()
                .install(&hub)
                .expect("single fixed wake installation");
            shared.queues().fixed.as_mut().unwrap().hub = Some(hub.clone());
            let mut runtime = fixed::RuntimeFixed::default();
            runtime.hub = Some(hub);
            Some(Box::new(runtime))
        } else {
            None
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
            runtime: Some(Runtime {
                authority,
                clock,
                carriers: BTreeMap::new(),
                pending: BTreeMap::new(),
                serial: 0,
                fixed,
                #[cfg(test)]
                after_apply: None,
            }),
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
    pub fn owner(&self) -> PersistentOwnerClient {
        PersistentOwnerClient(self.shared.clone())
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
        drop(retained);
        // Final owner-side drainage also covers an unexpected top-level worker unwind.
        runtime.drain_owned(&self.shared);
        if self.shared.fault().is_some() {
            runtime.authority.abort_in_place();
        }
        runtime
    }
    fn stopped(&mut self, abort: bool) -> StoppedService {
        let joined = self.worker.is_some();
        self.join(abort);
        let mut runtime = self.take_runtime();
        runtime.drain_owned(&self.shared);
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
            if let Some(hub) = runtime.fixed.as_ref().and_then(|fixed| fixed.hub.as_ref()) {
                if hub.install_thread(thread::current()).is_err() {
                    shared.fail(WorkerFault::InvalidExit);
                    return;
                }
            }
            #[cfg(test)]
            if _hooks.startup_panic {
                panic!("synthetic startup panic");
            }
            if shared.fault().is_some() || !shared.running() {
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
            runtime.drain_owned(&shared);
        }
    }
    shared.finished.store(true, Ordering::SeqCst);
    shared.notify_work();
    shared.changed.notify_all();
}
#[cfg(all(test, target_os = "macos"))]
mod tests;

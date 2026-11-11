//! Compiled exactly once by either the feature wrapper or the standalone fixture.
//! All launch authority stays within that private composition, never a public RPC.
use std::{
    future::poll_fn,
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc, Mutex,
    },
    task::{Poll, Waker},
    time::{Duration, Instant},
};
#[path = "types.rs"]
mod types;
pub use types::{Error, Execution, FixtureCase, Report};
#[cfg(target_os = "macos")]
#[path = "files.rs"]
mod files;
#[cfg(target_os = "macos")]
#[path = "process.rs"]
mod process;
#[path = "wire.rs"]
mod wire;
#[cfg(target_os = "macos")]
#[path = "worker.rs"]
mod worker;

static ACTIVE: AtomicBool = AtomicBool::new(false);
struct Slot;
impl Drop for Slot {
    fn drop(&mut self) {
        ACTIVE.store(false, Ordering::Release);
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Pending,
    Committed,
    Revoked,
}
struct Gate {
    phase: Phase,
    epoch: u64,
    prepared: bool,
    validated: Option<u64>,
    cleanup_consumed: bool,
}
/// Captured before exclusive service validation. Private identity prevents a stamp
/// from another fixture from authorizing this worker. No caller proof booleans.
pub(super) struct Capture {
    shared: Arc<Shared>,
    epoch: u64,
}
/// Private coordinator authority. No service validation is implemented by this
/// mechanism: the future exclusive coordinator must validate before stamp().
pub(super) struct Control {
    shared: Arc<Shared>,
}
impl Control {
    pub(super) fn capture(&self) -> Result<Capture, Error> {
        let gate = self.shared.gate.lock().unwrap_or_else(|p| p.into_inner());
        if gate.phase != Phase::Pending {
            return Err(Error::Revoked);
        }
        self.shared.before_deadline()?;
        Ok(Capture { shared: self.shared.clone(), epoch: gate.epoch })
    }
    pub(super) fn stamp(&self, capture: Capture) -> Result<(), Error> {
        let mut gate = self.shared.gate.lock().unwrap_or_else(|p| p.into_inner());
        if !Arc::ptr_eq(&self.shared, &capture.shared)
            || capture.epoch != gate.epoch
            || gate.phase != Phase::Pending
            || !gate.prepared
            || gate.validated.is_some()
        {
            return Err(Error::Revoked);
        }
        self.shared.before_deadline()?;
        gate.validated = Some(capture.epoch);
        Ok(())
    }
    /// Called before the exclusive owner's mutation, even when that mutation fails.
    pub(super) fn invalidate(&self) {
        self.shared.revoke();
    }
}
impl Drop for Control {
    fn drop(&mut self) {
        self.invalidate();
    }
}

/// Fixed-size cumulative state. Consumed input is evidence, not a successful turn.
/// A final CleanupUncertain snapshot can retain process/resources for their lifetime.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Progress {
    pub revision: u64,
    pub prepared: bool,
    pub consumed: Option<Execution>,
    pub report: Option<Report>,
    pub finished: bool,
}
struct Completion {
    progress: Progress,
    waker: Option<Waker>,
}
pub(super) struct Shared {
    identity: Arc<()>,
    deadline: Instant,
    gate: Mutex<Gate>,
    revoked: AtomicBool,
    completion: Mutex<Completion>,
    pid: AtomicU32,
    parsed: AtomicBool,
    #[cfg(test)]
    before_commit: Mutex<Option<Arc<std::sync::Barrier>>>,
    #[cfg(test)]
    after_commit: Mutex<Option<Arc<std::sync::Barrier>>>,
    #[cfg(test)]
    before_return: Mutex<Option<Arc<std::sync::Barrier>>>,
}
impl Shared {
    #[cfg(test)]
    fn new() -> Arc<Self> {
        Self::until(Instant::now() + Duration::from_secs(5))
    }
    fn until(deadline: Instant) -> Arc<Self> {
        Arc::new(Self {
            identity: Arc::new(()),
            deadline,
            gate: Mutex::new(Gate { phase: Phase::Pending, epoch: 0, prepared: false, validated: None, cleanup_consumed: false }),
            revoked: AtomicBool::new(false),
            completion: Mutex::new(Completion {
                progress: Progress { revision: 0, prepared: false, consumed: None, report: None, finished: false },
                waker: None,
            }),
            pid: AtomicU32::new(0),
            parsed: AtomicBool::new(false),
            #[cfg(test)]
            before_commit: Mutex::new(None),
            #[cfg(test)]
            after_commit: Mutex::new(None),
            #[cfg(test)]
            before_return: Mutex::new(None),
        })
    }
    fn before_deadline(&self) -> Result<(), Error> {
        if Instant::now() >= self.deadline {
            Err(Error::Deadline)
        } else {
            Ok(())
        }
    }
    fn revoke(&self) {
        let mut gate = self.gate.lock().unwrap_or_else(|p| p.into_inner());
        gate.phase = Phase::Revoked;
        gate.validated = None;
        gate.epoch = gate.epoch.saturating_add(1); // Exhaustion stays revoked, never reusable.
        self.revoked.store(true, Ordering::Release);
    }
    fn active(&self) -> Result<(), Error> {
        if self.revoked.load(Ordering::Acquire) {
            Err(Error::Revoked)
        } else {
            Ok(())
        }
    }
    fn prepared(&self) -> Result<(), Error> {
        {
            let mut gate = self.gate.lock().unwrap_or_else(|p| p.into_inner());
            if gate.phase != Phase::Pending {
                return Err(Error::Revoked);
            }
            self.before_deadline()?;
            gate.prepared = true;
        }
        self.update(|state| state.prepared = true);
        Ok(())
    }
    fn stamped(&self) -> Result<bool, Error> {
        let gate = self.gate.lock().unwrap_or_else(|p| p.into_inner());
        if gate.phase != Phase::Pending {
            return Err(Error::Revoked);
        }
        Ok(gate.validated == Some(gate.epoch))
    }
    fn commit(&self) -> Result<(), Error> {
        let mut gate = self.gate.lock().unwrap_or_else(|p| p.into_inner());
        if gate.phase != Phase::Pending || !gate.prepared || gate.validated != Some(gate.epoch) {
            return Err(Error::Revoked);
        }
        self.before_deadline()?;
        gate.phase = Phase::Committed;
        gate.validated = None;
        Ok(())
    }
    fn update(&self, change: impl FnOnce(&mut Progress)) {
        let wake = {
            let mut state = self.completion.lock().unwrap_or_else(|p| p.into_inner());
            if state.progress.finished {
                return;
            }
            let previous = state.progress.clone();
            change(&mut state.progress);
            if state.progress == previous {
                return;
            }
            // There are at most Prepared, Consumed, initial report, reaped and removed
            // transitions. Identical retained-cleanup reports do not increase revision.
            state.progress.revision = previous.revision.checked_add(1).expect("bounded fixture revisions");
            state.waker.take()
        };
        if let Some(wake) = wake {
            wake.wake();
        }
    }
    fn consumed(&self, execution: Execution) {
        self.update(|state| {
            if state.report.is_none() && state.consumed.is_none() {
                state.consumed = Some(execution);
            }
        });
    }
    fn publish(&self, mut report: Report, finished: bool) {
        // An unstamped worker may finish on its preparation deadline. Its retained
        // Control must not mint a stamp after the worker has gone away.
        if finished {
            self.revoke();
        }
        self.update(|state| {
            if let Some(previous) = &state.report {
                if let Err(error) = previous.result {
                    report.result = Err(error);
                }
                report.reaped |= previous.reaped;
                report.resources_removed |= previous.resources_removed;
                report.exit_code = previous.exit_code.or(report.exit_code);
            }
            state.report = Some(report);
            state.finished = finished;
        });
    }
}

/// Cancellation may be held separately from the single waiting observer.
#[derive(Clone)]
pub struct CancelHandle {
    shared: Arc<Shared>,
}
impl CancelHandle {
    pub fn cancel(&self) {
        self.shared.revoke();
    }
}

pub(super) struct Observer {
    pub(super) shared: Arc<Shared>,
    revision: u64,
}
impl Observer {
    pub(super) fn cancel_handle(&self) -> CancelHandle {
        CancelHandle { shared: self.shared.clone() }
    }
    pub(super) async fn wait(&mut self) -> Report {
        poll_fn(|cx| {
            let mut state = self.shared.completion.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(report) = &state.progress.report {
                return Poll::Ready(report.clone());
            }
            state.waker = Some(cx.waker().clone());
            Poll::Pending
        })
        .await
    }
    pub(super) async fn next(&mut self) -> Option<Progress> {
        poll_fn(|cx| {
            let mut state = self.shared.completion.lock().unwrap_or_else(|p| p.into_inner());
            if state.progress.revision > self.revision {
                self.revision = state.progress.revision;
                return Poll::Ready(Some(state.progress.clone()));
            }
            if state.progress.finished {
                return Poll::Ready(None);
            }
            state.waker = Some(cx.waker().clone());
            Poll::Pending
        })
        .await
    }
}
impl Drop for Observer {
    fn drop(&mut self) {
        self.shared.revoke();
    }
}

// Crate-private composition seam. The feature wrapper exposes none of these inputs.
#[cfg(target_os = "macos")]
#[allow(dead_code)]
pub(super) struct RegisteredWorkspace(files::Workspace);
#[cfg(target_os = "macos")]
#[allow(dead_code)]
impl RegisteredWorkspace {
    /// The exclusive coordinator supplies duplicates of its already registered
    /// directory descriptors. Paths are derived from those descriptors internally.
    /// This checks structure/identity only; registry authority belongs to that owner.
    pub(super) fn from_descriptors(project: std::fs::File, home: std::fs::File, tmp: std::fs::File) -> Result<Self, Error> {
        Ok(Self(files::Workspace::from_descriptors(project, home, tmp)?))
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[allow(dead_code)]
pub(super) enum Disposal {
    NoChild,
    Reaped { pid: u32, exit_code: Option<i32>, natural_zero: bool },
}
/// No Clone, public constructor, descriptor, path or resource-owning destructor.
#[allow(dead_code)]
pub(super) struct CleanupAck {
    identity: Arc<()>,
    disposition: Disposal,
}
#[allow(dead_code)]
impl Control {
    /// A foreign acknowledgment is returned intact, never consumed for this flight.
    pub(super) fn accept_cleanup(&self, ack: CleanupAck) -> Result<Disposal, CleanupAck> {
        let mut gate = self.shared.gate.lock().unwrap_or_else(|p| p.into_inner());
        if !Arc::ptr_eq(&ack.identity, &self.shared.identity) || gate.cleanup_consumed {
            return Err(ack);
        }
        gate.cleanup_consumed = true;
        Ok(ack.disposition)
    }
}
#[cfg(target_os = "macos")]
struct Input {
    case: FixtureCase,
    text: String,
    workspace: Option<RegisteredWorkspace>,
    slot: Slot,
}
#[cfg(target_os = "macos")]
#[allow(dead_code)]
pub(super) struct Reservation {
    shared: Arc<Shared>,
    input: Option<Input>,
}
/// Holds exactly the worker created by this reservation. Progress is not a join.
#[cfg(target_os = "macos")]
#[allow(dead_code)]
pub(super) struct Running {
    shared: Arc<Shared>,
    worker: Option<std::thread::JoinHandle<Option<Disposal>>>,
    unstarted: Option<CleanupAck>,
    taken: bool,
}
#[cfg(target_os = "macos")]
#[allow(dead_code)]
impl Running {
    pub(super) fn is_finished(&self) -> bool {
        self.worker.as_ref().is_none_or(|worker| worker.is_finished())
    }
    /// None means pending. Once joined/taken, further calls refuse.
    pub(super) fn try_join(&mut self) -> Result<Option<CleanupAck>, Error> {
        if self.taken {
            return Err(Error::Revoked);
        }
        if !self.is_finished() {
            return Ok(None);
        }
        self.taken = true;
        if let Some(ack) = self.unstarted.take() {
            return Ok(Some(ack));
        }
        match self.worker.take().ok_or(Error::CleanupUncertain)?.join() {
            Ok(Some(disposition)) => Ok(Some(CleanupAck { identity: self.shared.identity.clone(), disposition })),
            Ok(None) => Err(Error::CleanupUncertain),
            Err(_) => {
                self.shared
                    .publish(Report { result: Err(Error::WorkerPanic), reaped: false, exit_code: None, resources_removed: false }, true);
                Err(Error::WorkerPanic)
            }
        }
    }
}
#[cfg(target_os = "macos")]
impl Drop for Running {
    fn drop(&mut self) {
        if !self.taken {
            self.shared.revoke();
        }
        // A dropped JoinHandle detaches; the worker keeps child/resources/ACTIVE.
        // A composed owner must retain its services when no joined Ack was obtained.
    }
}
#[cfg(target_os = "macos")]
#[allow(dead_code)]
impl Reservation {
    fn no_worker(&mut self, error: Error) -> CleanupAck {
        drop(self.input.take()); // All descriptor copies and capacity, before proof.
        self.shared.publish(Report { result: Err(error), reaped: false, exit_code: None, resources_removed: true }, true);
        CleanupAck { identity: self.shared.identity.clone(), disposition: Disposal::NoChild }
    }
    pub(super) fn abandon(mut self) -> CleanupAck {
        self.no_worker(Error::Revoked)
    }
    pub(super) fn activate(self) -> Running {
        self.activate_with(None, worker::Fault::None)
    }
    fn activate_with(mut self, automatic: Option<Control>, fault: worker::Fault) -> Running {
        let active = self.shared.active().and_then(|()| self.shared.before_deadline());
        if let Err(error) = active {
            let ack = self.no_worker(error);
            return Running { shared: self.shared.clone(), worker: None, unstarted: Some(ack), taken: false };
        }
        let input = self.input.take().expect("one-shot reservation");
        let shared = self.shared.clone();
        let work = move || worker::run_in(shared, input.case, input.text, input.slot, fault, automatic, input.workspace);
        #[cfg(test)]
        let started = if matches!(fault, worker::Fault::ThreadSpawnFailure) {
            drop(work); // Same owned-input destruction as std::thread::spawn's error.
            Err(std::io::Error::from(std::io::ErrorKind::WouldBlock))
        } else {
            std::thread::Builder::new().name("milagre-acp-copy-fixture".into()).spawn(work)
        };
        #[cfg(not(test))]
        let started = std::thread::Builder::new().name("milagre-acp-copy-fixture".into()).spawn(work);
        match started {
            Ok(worker) => Running { shared: self.shared.clone(), worker: Some(worker), unstarted: None, taken: false },
            Err(_) => {
                // std::thread::spawn dropped its unexecuted closure and owned Input.
                let ack = self.no_worker(Error::Spawn);
                Running { shared: self.shared.clone(), worker: None, unstarted: Some(ack), taken: false }
            }
        }
    }
}
#[cfg(target_os = "macos")]
impl Drop for Reservation {
    fn drop(&mut self) {
        if self.input.is_some() {
            let _ = self.no_worker(Error::Revoked);
        }
    }
}
#[cfg(target_os = "macos")]
#[allow(dead_code)]
pub(super) fn reserve(
    case: FixtureCase,
    text: &str,
    workspace: Option<RegisteredWorkspace>,
    deadline: Instant,
) -> Result<(Control, Observer, Reservation), Error> {
    if text.len() > wire::TEXT_LIMIT {
        return Err(Error::Bounds);
    }
    ACTIVE.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).map_err(|_| Error::Busy)?;
    let slot = Slot;
    let shared = Shared::until(deadline);
    let input = Input { case, text: text.to_owned(), workspace, slot };
    Ok((Control { shared: shared.clone() }, Observer { shared: shared.clone(), revision: 0 }, Reservation { shared, input: Some(input) }))
}
#[cfg(target_os = "macos")]
fn start(case: FixtureCase, text: &str, automatic: bool) -> Result<(Option<Control>, Observer), Error> {
    let (control, observer, reservation) = reserve(case, text, None, Instant::now() + Duration::from_secs(5))?;
    let mut control = Some(control);
    let mut running = reservation.activate_with(if automatic { control.take() } else { None }, worker::Fault::None);
    if running.worker.is_none() {
        return Err(observer
            .shared
            .completion
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .progress
            .report
            .as_ref()
            .expect("unstarted report")
            .result
            .clone()
            .unwrap_err());
    }
    // Existing observer-only wrapper intentionally detaches its worker. Its resource
    // owner remains unchanged; only the private coordinator obtains a joined Ack.
    running.worker.take();
    running.taken = true;
    Ok((control, observer))
}
pub(super) fn automatic(case: FixtureCase, text: &str) -> Result<Observer, Error> {
    #[cfg(target_os = "macos")]
    {
        Ok(start(case, text, true)?.1)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = case;
        Err(if text.len() > wire::TEXT_LIMIT { Error::Bounds } else { Error::UnsupportedPlatform })
    }
}
/// Used by the separate compile context; absent from the public feature wrapper.
#[cfg(target_os = "macos")]
#[allow(dead_code)]
pub(super) fn prepare(case: FixtureCase, text: &str) -> Result<(Control, Observer), Error> {
    let (control, observer) = start(case, text, false)?;
    Ok((control.expect("coordinator owns admission"), observer))
}

#[cfg(all(test, target_os = "macos"))]
#[path = "core_tests.rs"]
mod tests;

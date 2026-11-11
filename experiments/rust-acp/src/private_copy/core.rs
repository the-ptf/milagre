//! Compiled exactly once by either the feature wrapper or the standalone fixture.
//! All launch authority stays within that private composition, never a public RPC.
use std::{
    future::poll_fn,
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc, Mutex,
    },
    task::{Poll, Waker},
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
    gate: Mutex<Gate>,
    revoked: AtomicBool,
    completion: Mutex<Completion>,
    pid: AtomicU32,
    parsed: AtomicBool,
    #[cfg(test)]
    before_commit: Mutex<Option<Arc<std::sync::Barrier>>>,
    #[cfg(test)]
    after_commit: Mutex<Option<Arc<std::sync::Barrier>>>,
}
impl Shared {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            gate: Mutex::new(Gate { phase: Phase::Pending, epoch: 0, prepared: false, validated: None }),
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
        })
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

#[cfg(target_os = "macos")]
fn start(case: FixtureCase, text: &str, automatic: bool) -> Result<(Option<Control>, Observer), Error> {
    if text.len() > wire::TEXT_LIMIT {
        return Err(Error::Bounds);
    }
    ACTIVE.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).map_err(|_| Error::Busy)?;
    let slot = Slot;
    let shared = Shared::new();
    let mut control = Some(Control { shared: shared.clone() });
    let worker_control = if automatic { control.take() } else { None };
    let retained = shared.clone();
    let text = text.to_owned();
    std::thread::Builder::new()
        .name("milagre-acp-copy-fixture".into())
        .spawn(move || worker::run(retained, case, text, slot, worker::Fault::None, worker_control))
        .map_err(|_| Error::Spawn)?;
    Ok((control, Observer { shared, revision: 0 }))
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

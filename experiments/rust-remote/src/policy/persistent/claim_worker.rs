//! Private single-claim composition, exclusively borrowing a fresh synthetic authority.
//! Real joins and leased ciphertext, but only fixed in-memory outcomes. No HTTP adapter.
use super::*;
mod output_credit;
use crate::{
    budget::Reservation, http_dispatch, phone, registry::claim::Permit, supervisor::Clock,
};
use output_credit::{Packet, ReturnReceiver, ReturnSender, ReturnedCredit};
use std::cell::Cell;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Condvar, Mutex,
};
use std::thread::{self, JoinHandle};

const STACK: usize = 2 * 1024 * 1024;
const OUTPUT: usize = 64 * 1024;
// Retains the bounded receipt channel and signal after packet/execution leases return.
const METADATA: usize = 2048;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Fault {
    Full,
    Stale,
    Expired,
    State,
    Spawn,
    Worker,
    Clock,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Outcome {
    Success,
    Unavailable,
    Timeout,
    Panic,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Execution {
    NotStarted,
    MayHaveRun,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Delivery {
    None,
    MaySend,
    Returned,
    Discarded,
    Unknown,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Phase {
    Claimed,
    Running,
    Ready,
    Completed,
    Discarded,
    Cancelled,
    TimedOut,
    Failed,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Observation {
    pub phase: Phase,
    pub execution: Execution,
    pub delivery: Delivery,
    pub status: Option<u16>,
}
/// Borrowing the authority prevents close/restart or competing dispatch while prepared.
/// Dropping this unsubmitted permit releases only its metadata lease.
pub(crate) struct Prepared<'a> {
    authority: &'a mut PersistentAuthority,
    token: WorkToken,
    clock: Clock,
    _metadata: Reservation,
}
pub(crate) struct Rejected<'a> {
    pub fault: Fault,
    pub permit: Prepared<'a>,
}
#[derive(Default)]
struct Gate {
    begin: bool,
    cancel: bool,
    finish: bool,
    started: bool,
    completed: bool,
}
struct Signal {
    gate: Mutex<Gate>,
    wake: Condvar,
    calls: AtomicUsize,
}
struct WorkerResult {
    status: Option<u16>,
}
/// Constructed only by consuming JoinHandle::join, including the panic outcome.
struct Joined(std::result::Result<Option<u16>, ()>);
struct OwnedWorker {
    signal: Arc<Signal>,
    thread: Option<JoinHandle<WorkerResult>>,
    execution: Option<Reservation>,
    #[cfg(test)]
    joined_probe: Arc<std::sync::atomic::AtomicBool>,
}
impl OwnedWorker {
    fn cancel(&self) {
        let mut g = self.signal.gate.lock().unwrap_or_else(|e| e.into_inner());
        g.cancel = true;
        self.signal.wake.notify_all();
    }
    fn join(&mut self) -> Joined {
        let result = self
            .thread
            .take()
            .expect("join once")
            .join()
            .map(|result| result.status)
            .map_err(|_| ());
        // Retain the stack/execution charge through join, including worker unwind.
        drop(self.execution.take());
        #[cfg(test)]
        self.joined_probe.store(true, Ordering::SeqCst);
        Joined(result)
    }
}
impl Drop for OwnedWorker {
    fn drop(&mut self) {
        if self.thread.is_some() {
            self.cancel();
            let _ = self.join();
        }
    }
}
pub(crate) struct Claim<'a> {
    authority: &'a mut PersistentAuthority,
    permit: Permit,
    clock: Clock,
    worker: OwnedWorker,
    joined: Option<Joined>,
    output: Option<Packet>,
    returned: Option<ReturnedCredit>,
    return_sender: Option<ReturnSender>,
    return_receiver: ReturnReceiver,
    packet_issued: bool,
    exposed: Cell<bool>,
    prepaid: Option<Reservation>,
    _metadata: Reservation,
    http_deadline: u64,
    completion_deadline: u64,
    observation: Observation,
}
/// This borrow prevents authority teardown while an output reader owns the bytes.
pub(crate) struct OutputLoan<'b, 'a> {
    claim: &'b mut Claim<'a>,
}
impl OutputLoan<'_, '_> {
    pub fn bytes(&self) -> std::result::Result<&[u8], Fault> {
        if self.claim.clock.now() >= self.claim.completion_deadline {
            return Err(Fault::Expired);
        }
        if !self
            .claim
            .authority
            .registry
            .as_ref()
            .unwrap()
            .claim_read_allowed(&self.claim.permit, self.claim.clock.now())
        {
            return Err(Fault::Stale);
        }
        self.claim.exposed.set(true);
        Ok(self.claim.output.as_ref().unwrap().bytes())
    }
}
impl Drop for OutputLoan<'_, '_> {
    fn drop(&mut self) {
        // A reader unwind cannot attest to ordered handoff, even after bytes().
        if std::thread::panicking() {
            self.claim.stop_output(Phase::Cancelled);
            return;
        }
        if self.claim.clock.now() >= self.claim.completion_deadline {
            self.claim.stop_output(Phase::TimedOut);
            self.claim.authority.registry.as_mut().unwrap().end_claim(
                &self.claim.permit,
                registry::WorkStatus::TimedOut,
                self.claim.clock.now(),
            );
            return;
        }
        if !self
            .claim
            .authority
            .registry
            .as_ref()
            .unwrap()
            .claim_read_allowed(&self.claim.permit, self.claim.clock.now())
        {
            self.claim.stop_output(Phase::Cancelled);
            self.claim.authority.registry.as_mut().unwrap().end_claim(
                &self.claim.permit,
                registry::WorkStatus::Cancelled,
                self.claim.clock.now(),
            );
            return;
        }
        self.claim.release_packet();
        let exposed = self.claim.exposed.get();
        self.claim.observation.delivery = if exposed {
            Delivery::Returned
        } else {
            Delivery::Discarded
        };
        self.claim.observation.phase = if exposed {
            Phase::Completed
        } else {
            Phase::Discarded
        };
        if !exposed {
            self.claim
                .close_lost_output(registry::WorkStatus::Cancelled);
            return;
        }
        self.claim.authority.registry.as_mut().unwrap().end_claim(
            &self.claim.permit,
            if exposed {
                registry::WorkStatus::Completed
            } else {
                registry::WorkStatus::Cancelled
            },
            self.claim.clock.now(),
        );
    }
}
fn refused(error: registry::RegistryError) -> Fault {
    match error {
        registry::RegistryError::Protocol(crate::Error::Budget) => Fault::Full,
        registry::RegistryError::Time => Fault::Clock,
        _ => Fault::Stale,
    }
}
fn admission_refused(error: registry::claim::AdmissionError) -> Fault {
    match error {
        registry::claim::AdmissionError::Expired => Fault::Expired,
        registry::claim::AdmissionError::Registry(error) => refused(error),
    }
}
impl<'a> Prepared<'a> {
    pub fn new(
        authority: &'a mut PersistentAuthority,
        token: WorkToken,
        clock: Clock,
    ) -> std::result::Result<Self, Fault> {
        authority.check_registry().map_err(|_| Fault::Stale)?;
        let budget = authority
            .registry
            .as_mut()
            .unwrap()
            .inspect_claim(&token, clock.now())
            .map_err(admission_refused)?;
        let metadata = budget.reserve(METADATA).map_err(|_| Fault::Full)?;
        Ok(Self {
            authority,
            token,
            clock,
            _metadata: metadata,
        })
    }
    pub fn required_bytes(&self) -> usize {
        STACK + OUTPUT + 4096
    }
    /// Keep ownership of the worker/output in this stack frame. The callback receives
    /// only a reborrow; forgetting it or an output loan cannot forget the owning Claim.
    #[allow(clippy::result_large_err)]
    pub fn with_claim<T>(
        self,
        outcome: Outcome,
        action: impl for<'scope> FnOnce(&'scope mut Claim<'a>) -> T,
    ) -> std::result::Result<T, Rejected<'a>> {
        let mut claim = self.start(outcome)?;
        Ok(action(&mut claim))
    }
    #[allow(clippy::result_large_err)]
    fn start(self, outcome: Outcome) -> std::result::Result<Claim<'a>, Rejected<'a>> {
        let now = self.clock.now();
        let budget = match self
            .authority
            .registry
            .as_mut()
            .unwrap()
            .inspect_claim(&self.token, now)
        {
            Ok(b) => b,
            Err(e) => {
                return Err(Rejected {
                    fault: admission_refused(e),
                    permit: self,
                })
            }
        };
        let (Some(_), Some(_)) = (now.checked_add(340_000), now.checked_add(345_000)) else {
            return Err(Rejected {
                fault: Fault::Expired,
                permit: self,
            });
        };
        // One fixed response, stack, synchronization and both final ciphertext/scratch.
        // All fallible resource admission happens before claim or invocation.
        let mut prepaid = match budget.reserve(self.required_bytes()) {
            Ok(l) => l,
            Err(_) => {
                return Err(Rejected {
                    fault: Fault::Full,
                    permit: self,
                })
            }
        };
        let execution = prepaid.split(STACK + 2048).unwrap();
        // Allocate the bounded receipt channel before claim/Begin, under prepaid credit.
        let (return_sender, return_receiver) = output_credit::channel();
        let signal = Arc::new(Signal {
            gate: Mutex::new(Gate::default()),
            wake: Condvar::new(),
            calls: AtomicUsize::new(0),
        });
        let s = signal.clone();
        let thread = match thread::Builder::new().stack_size(STACK).spawn(move || {
            let mut g = s.gate.lock().unwrap_or_else(|e| e.into_inner());
            while !g.begin && !g.cancel {
                g = s.wake.wait(g).unwrap_or_else(|e| e.into_inner());
            }
            if g.cancel {
                g.completed = true;
                s.wake.notify_all();
                return WorkerResult { status: None };
            }
            s.calls.fetch_add(1, Ordering::SeqCst);
            g.started = true;
            s.wake.notify_all();
            while !g.finish && !g.cancel {
                g = s.wake.wait(g).unwrap_or_else(|e| e.into_inner());
            }
            if g.cancel {
                g.completed = true;
                s.wake.notify_all();
                return WorkerResult { status: None };
            }
            g.completed = true;
            s.wake.notify_all();
            drop(g); // A fixture panic never poisons the cancellation signal.
            let status = match outcome {
                Outcome::Success => 200,
                Outcome::Unavailable => 502,
                Outcome::Timeout => 504,
                Outcome::Panic => panic!("synthetic worker fault"),
            };
            WorkerResult {
                status: Some(status),
            }
        }) {
            Ok(h) => h,
            Err(_) => {
                return Err(Rejected {
                    fault: Fault::Spawn,
                    permit: self,
                })
            }
        };
        let worker = OwnedWorker {
            signal,
            thread: Some(thread),
            execution: Some(execution),
            #[cfg(test)]
            joined_probe: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        };
        let claim_at = self.clock.now();
        let (Some(http_deadline), Some(completion_deadline)) =
            (claim_at.checked_add(340_000), claim_at.checked_add(345_000))
        else {
            drop(worker);
            return Err(Rejected {
                fault: Fault::Expired,
                permit: self,
            });
        };
        let permit = match self
            .authority
            .registry
            .as_mut()
            .unwrap()
            .claim_work(&self.token, claim_at)
        {
            Ok(p) => p,
            Err(e) => {
                drop(worker);
                return Err(Rejected {
                    fault: admission_refused(e),
                    permit: self,
                });
            }
        };
        Ok(Claim {
            authority: self.authority,
            permit,
            clock: self.clock,
            worker,
            joined: None,
            output: None,
            returned: None,
            return_sender: Some(return_sender),
            return_receiver,
            packet_issued: false,
            exposed: Cell::new(false),
            prepaid: Some(prepaid),
            _metadata: self._metadata,
            http_deadline,
            completion_deadline,
            observation: Observation {
                phase: Phase::Claimed,
                execution: Execution::NotStarted,
                delivery: Delivery::None,
                status: None,
            },
        })
    }
}
impl<'a> Claim<'a> {
    pub fn observe(&self) -> Observation {
        self.observation
    }
    pub fn invocations(&self) -> usize {
        self.worker.signal.calls.load(Ordering::SeqCst)
    }
    pub fn begin(&mut self) -> std::result::Result<(), Fault> {
        self.maintain()?;
        if self.observation.phase != Phase::Claimed {
            return Err(Fault::State);
        }
        let mut gate = self.worker.signal.gate.lock().map_err(|_| Fault::Worker)?;
        self.authority
            .registry
            .as_mut()
            .unwrap()
            .claim_barrier(&self.permit, self.clock.now(), || {
                if gate.cancel {
                    return Err(crate::Error::Unauthorized);
                }
                self.observation.execution = Execution::MayHaveRun;
                self.observation.phase = Phase::Running;
                gate.begin = true;
                self.worker.signal.wake.notify_all();
                Ok(())
            })
            .map_err(refused)
    }
    /// Controls only this fixed fixture's completion timing; it is not cleanup evidence.
    pub fn finish_fixture(&self) {
        let mut g = self
            .worker
            .signal
            .gate
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        g.finish = true;
        self.worker.signal.wake.notify_all();
    }
    fn join(&mut self) -> std::result::Result<(), Fault> {
        if self.joined.is_none() {
            self.joined = Some(self.worker.join());
        }
        if self.joined.as_ref().unwrap().0.is_err() {
            self.authority.abort_in_place();
            self.observation.phase = Phase::Failed;
            return Err(Fault::Worker);
        }
        Ok(())
    }
    pub fn collect(&mut self) -> std::result::Result<(), Fault> {
        self.maintain()?;
        if self.observation.phase != Phase::Running {
            return Err(Fault::State);
        }
        if !self
            .worker
            .signal
            .gate
            .lock()
            .map_err(|_| Fault::Worker)?
            .completed
        {
            return Err(Fault::Full);
        }
        self.join()?; // JoinHandle consumption, never a caller-provided joined flag.
        self.maintain()?;
        if self.observation.phase != Phase::Running {
            return Err(Fault::State);
        }
        let status = self
            .joined
            .as_ref()
            .unwrap()
            .0
            .as_ref()
            .unwrap()
            .ok_or(Fault::State)?;
        self.observation.status = Some(status);
        self.observation.phase = Phase::Ready;
        Ok(())
    }
    fn release_packet(&mut self) {
        drop(self.output.take());
        if self.returned.is_none() {
            self.returned = self.return_receiver.try_recv().ok();
        }
        debug_assert!(!self.packet_issued || self.returned.is_some());
    }
    fn close_lost_output(&mut self, status: registry::WorkStatus) {
        self.authority
            .registry
            .as_mut()
            .unwrap()
            .discard_claim_output(&self.permit, status);
    }
    fn stop_output(&mut self, phase: Phase) {
        if self.observation.delivery == Delivery::MaySend {
            self.observation.delivery = Delivery::Unknown;
            self.close_lost_output(if phase == Phase::TimedOut {
                registry::WorkStatus::TimedOut
            } else {
                registry::WorkStatus::Cancelled
            });
        }
        self.release_packet();
        drop(self.prepaid.take());
        self.observation.phase = phase;
    }
    pub fn cancel(&mut self) {
        self.worker.cancel();
        self.stop_output(Phase::Cancelled);
        self.authority.registry.as_mut().unwrap().end_claim(
            &self.permit,
            registry::WorkStatus::Cancelled,
            self.clock.now(),
        );
    }
    pub fn remove_device(&mut self, key: &str) -> std::result::Result<(), Fault> {
        let result = self
            .authority
            .remove_device(key, self.clock.now())
            .map_err(|_| Fault::Stale);
        // Registry epoch revocation is authoritative; even a persistence fault cannot resume.
        if result.is_err()
            || self
                .authority
                .registry
                .as_mut()
                .unwrap()
                .claim_barrier(&self.permit, self.clock.now(), || Ok(()))
                .is_err()
        {
            self.worker.cancel();
            self.stop_output(Phase::Cancelled);
        }
        result
    }
    pub fn keepalive(&mut self, encrypted: &[u8]) -> std::result::Result<(), Fault> {
        self.authority
            .receive_request(self.permit.handle(), encrypted, self.clock.now())
            .map(|_| ())
            .map_err(refused)
    }
    pub fn maintain(&mut self) -> std::result::Result<(), Fault> {
        let now = self.clock.now();
        if self.authority.tick(now).is_err() {
            self.worker.cancel();
            self.stop_output(Phase::Failed);
            return Err(Fault::Clock);
        }
        if matches!(
            self.observation.phase,
            Phase::Completed
                | Phase::Discarded
                | Phase::Cancelled
                | Phase::TimedOut
                | Phase::Failed
        ) {
            return Ok(());
        }
        if now >= self.completion_deadline {
            self.worker.cancel();
            self.stop_output(Phase::TimedOut);
            return Err(Fault::Expired);
        }
        if self
            .authority
            .registry
            .as_mut()
            .unwrap()
            .claim_barrier(&self.permit, now, || Ok(()))
            .is_err()
        {
            self.worker.cancel();
            self.stop_output(Phase::Cancelled);
            return Err(Fault::Stale);
        }
        if now >= self.http_deadline
            && matches!(self.observation.phase, Phase::Claimed | Phase::Running)
        {
            self.worker.cancel();
            self.join()?;
            self.observation.status = Some(504);
            self.observation.phase = Phase::Ready;
        }
        Ok(())
    }
    /// Last authorization/MaySend barrier precedes the first encrypted frame allocation/handoff.
    pub fn may_send(&mut self) -> std::result::Result<(), Fault> {
        self.maintain()?;
        if self.observation.phase != Phase::Ready || self.observation.delivery != Delivery::None {
            return Err(Fault::State);
        }
        let status = self.observation.status.unwrap();
        let outcome = match status {
            200 => http_dispatch::Outcome::Response {
                status,
                headers: phone::Headers::new(),
                body: Vec::new(),
            },
            502 => http_dispatch::Outcome::Unavailable,
            _ => http_dispatch::Outcome::Timeout,
        };
        let response =
            http_dispatch::response(self.permit.id(), outcome).map_err(|_| Fault::State)?;
        let mut parts = phone::response_parts(&response).map_err(|_| Fault::State)?;
        let plain = parts.pop().ok_or(Fault::State)?;
        if !parts.is_empty() {
            return Err(Fault::State);
        }
        let prepaid = self.prepaid.take().ok_or(Fault::State)?;
        let result = self.authority.registry.as_mut().unwrap().emit_claim(
            &self.permit,
            &plain,
            prepaid,
            self.clock.now(),
            || {
                self.observation.delivery = Delivery::MaySend;
                Ok(())
            },
        );
        if let Err(e) = result {
            self.cancel();
            return Err(refused(e));
        }
        let mut packet = None;
        let result = self.authority.take_output_owned(
            self.permit.handle(),
            self.clock.now(),
            |bytes, lease| {
                packet = Some(Packet::new(
                    bytes,
                    lease,
                    self.return_sender.take().unwrap(), // MaySend is single-shot.
                ));
                self.packet_issued = true;
                Ok(())
            },
        );
        match result {
            Ok(true) => {
                self.output = packet;
                Ok(())
            }
            _ => {
                self.cancel();
                Err(Fault::Stale)
            }
        }
    }
    pub fn receive<'b>(&'b mut self) -> std::result::Result<OutputLoan<'b, 'a>, Fault> {
        self.maintain()?;
        if self.output.is_none() || self.observation.delivery != Delivery::MaySend {
            return Err(Fault::State);
        }
        Ok(OutputLoan { claim: self })
    }
    /// Owned resources can only finish after a real join and actual packet/lease return.
    pub fn cleanup_complete(&self) -> bool {
        self.joined.is_some()
            && (!self.packet_issued || self.returned.is_some())
            && self.output.is_none()
            && self.prepaid.is_none()
    }
}
impl Drop for Claim<'_> {
    fn drop(&mut self) {
        self.worker.cancel();
        let _ = self.join();
        if !matches!(self.observation.phase, Phase::Completed | Phase::Discarded) {
            self.cancel();
        }
        self.release_packet();
        self.prepaid.take();
        // The mutable authority borrow ends only after this joined, drained Drop.
    }
}

#[cfg(test)]
impl Claim<'_> {
    pub(crate) fn packet_receipt_for_test(&self) -> bool {
        self.returned.is_some()
    }
    pub(crate) fn joined_probe_for_test(&self) -> Arc<std::sync::atomic::AtomicBool> {
        self.worker.joined_probe.clone()
    }
    pub(crate) fn wait_thread_finished_for_test(&self) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while !self.worker.thread.as_ref().unwrap().is_finished() {
            assert!(std::time::Instant::now() < deadline, "worker did not exit");
            std::thread::yield_now();
        }
    }
    pub(crate) fn wait_worker_for_test(&self, finished: bool) {
        let gate = self.worker.signal.gate.lock().unwrap();
        let (gate, timeout) = self
            .worker
            .signal
            .wake
            .wait_timeout_while(gate, std::time::Duration::from_secs(3), |g| {
                if finished {
                    !g.completed
                } else {
                    !g.started
                }
            })
            .unwrap();
        assert!(!timeout.timed_out());
        assert!(if finished {
            gate.completed
        } else {
            gate.started
        });
    }
}

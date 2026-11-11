use super::*;
use crate::{
    admission::{Source, Status as AdmissionStatus},
    channel::{DeviceKind, MAX_HELLO_BYTES, MAX_PLAIN_BYTES},
    persistent::composition::{CarrierDecision, CarrierTicket},
    registry::{CarrierStatus, CloseReason, Handle, WorkCursor, WorkPage, WorkToken},
    supervisor::{CarrierCommand, Error, EventStats, MemoryCarrier, Result},
};
use std::time::Instant;

const LIVE: u8 = 0;
const QUEUED: u8 = 1;
const CONSUMED: u8 = 2;
const CANCELLED: u8 = 3;
const CONTROL_SLOTS: usize = 8;
const CONTROL_SLOT_BYTES: usize = 2048;
/// Non-Clone owner permit. Dropping it cancels only its exact pending decision.
pub struct PersistentApproval {
    handle: Handle,
    serial: u64,
    deadline: u64,
    state: Arc<AtomicU8>,
    scope: Arc<()>,
    wake: std::sync::Weak<Shared>,
}
impl Drop for PersistentApproval {
    fn drop(&mut self) {
        if self
            .state
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |s| {
                (s < CONSUMED).then_some(CANCELLED)
            })
            .is_ok()
        {
            if let Some(shared) = self.wake.upgrade() {
                shared.notify_work();
            }
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApprovalRefusal {
    Stopped,
    Expired,
    Replaced,
    Revoked,
}
pub enum ApprovalRejection {
    Full(PersistentApproval),
    Unavailable(ApprovalRefusal),
}
pub enum Event {
    Approval {
        permit: PersistentApproval,
        device_key: String,
        deadline: u64,
    },
    WorkAvailable,
    Closed(Handle),
}
pub enum PersistentCommand {
    Attach {
        id: u64,
        carrier: MemoryCarrier,
    },
    Hello {
        handle: Handle,
        source: Source,
        bytes: Vec<u8>,
    },
    Request {
        handle: Handle,
        bytes: Vec<u8>,
    },
    Send {
        handle: Handle,
        encoded: Vec<u8>,
    },
    Disconnect(Handle),
    OpenPairing,
    EnableDesktop,
    RemoveDevice(String),
    HostPublicKey,
    PairingInvitation,
    AdmissionStatus(Source),
    DrainWork {
        cursor: Option<WorkCursor>,
        limit: usize,
    },
    Finish {
        token: WorkToken,
        response: Vec<u8>,
    },
    DispatchSynthetic {
        token: WorkToken,
        http: crate::http_dispatch::MemoryHttp,
    },
    #[cfg(test)]
    Probe(Probe),
}
#[cfg(test)]
pub enum Probe {
    Park {
        entered: mpsc::SyncSender<()>,
        release: Arc<(Mutex<bool>, Condvar)>,
    },
    AfterApply(Box<dyn FnOnce() + Send>),
    Panic,
    PoisonQueue,
    BeforeCommit(Box<dyn FnOnce() + Send>),
}
impl PersistentCommand {
    fn cost(&self) -> Option<usize> {
        let bytes = match self {
            Self::Hello { bytes, .. } if bytes.len() <= MAX_HELLO_BYTES => bytes.capacity(),
            Self::Request { bytes, .. } if bytes.len() <= crate::envelope::MAX_PAYLOAD => {
                bytes.capacity()
            }
            Self::Send { encoded, .. } if encoded.len() <= MAX_PLAIN_BYTES => encoded.capacity(),
            Self::Finish { response, .. } if response.len() <= MAX_PLAIN_BYTES => {
                response.capacity()
            }
            Self::RemoveDevice(k) if k.len() <= 128 => k.capacity(),
            Self::DispatchSynthetic { http, .. } => http.retained_capacity(),
            Self::Hello { .. }
            | Self::Request { .. }
            | Self::Send { .. }
            | Self::Finish { .. }
            | Self::RemoveDevice(_) => return None,
            _ => 0,
        };
        bytes.checked_add(1024)
    }
    fn target(&self) -> Option<Handle> {
        match self {
            Self::Hello { handle, .. }
            | Self::Request { handle, .. }
            | Self::Send { handle, .. } => Some(handle.clone()),
            Self::Finish { token, .. } | Self::DispatchSynthetic { token, .. } => {
                Some(token.handle().clone())
            }
            _ => None,
        }
    }
}
pub enum Reply {
    Done,
    Attached(Handle),
    Work(WorkPage),
    Dispatched(crate::http_dispatch::DispatchRecord),
    HostPublicKey(crate::PublicKey),
    PairingInvitation(String),
    AdmissionStatus(AdmissionStatus),
}
pub struct Receipt(mpsc::Receiver<Result<Reply>>);
impl Receipt {
    /// Timeout or a lost reply means unknown outcome, never permission to replay.
    pub fn wait(&self, timeout: Duration) -> Result<Reply> {
        self.0
            .recv_timeout(timeout)
            .unwrap_or(Err(Error::UnknownOutcome))
    }
}
enum Queued {
    Command(PersistentCommand),
    Approve(PersistentApproval),
}
pub(super) struct Envelope {
    origin: Option<(Handle, Source)>,
    cost: usize,
    command: Queued,
    reply: mpsc::SyncSender<Result<Reply>>,
    lease: Option<Reservation>,
}
impl Envelope {
    pub(super) fn reject(self) {
        self.reject_after(|| {});
    }
    fn reject_after(self, after: impl FnOnce()) {
        if let Queued::Command(PersistentCommand::Attach { carrier, .. }) = &self.command {
            carrier.close();
        }
        drop(self.command);
        drop(self.lease);
        let _ = self.reply.try_send(Err(Error::NotExecuted));
        after();
    }
}
pub(super) struct Notification {
    event: Event,
    created: Instant,
    _lease: Reservation,
}
#[derive(Clone)]
pub struct PersistentOwnerClient(pub(super) Arc<Shared>);
/// Source and handle are bound by a trusted owner. No policy or event access.
/// ```compile_fail
/// use milagre_remote::persistent_supervisor::{PersistentCarrierClient, PersistentCommand};
/// fn escalate(c: PersistentCarrierClient) { c.submit(PersistentCommand::OpenPairing); }
/// ```
#[derive(Clone)]
pub struct PersistentCarrierClient {
    owner: PersistentOwnerClient,
    handle: Handle,
    source: Source,
}
impl PersistentCarrierClient {
    pub fn status(&self) -> CarrierStatus {
        self.handle.status()
    }
    pub fn submit(&self, c: CarrierCommand) -> Result<Receipt> {
        let handle = self.handle.clone();
        let command = match c {
            CarrierCommand::Hello(bytes) => PersistentCommand::Hello {
                handle,
                source: self.source,
                bytes,
            },
            CarrierCommand::Request(bytes) => PersistentCommand::Request { handle, bytes },
            CarrierCommand::Disconnect => PersistentCommand::Disconnect(handle),
        };
        self.owner
            .enqueue(command, Some((self.handle.clone(), self.source)))
    }
}
impl PersistentOwnerClient {
    pub fn carrier(&self, handle: Handle, source: Source) -> PersistentCarrierClient {
        PersistentCarrierClient {
            owner: self.clone(),
            handle,
            source,
        }
    }
    pub fn submit(&self, command: PersistentCommand) -> Result<Receipt> {
        let origin = match &command {
            PersistentCommand::Hello { handle, source, .. } => Some((handle.clone(), *source)),
            PersistentCommand::Request { handle, .. } | PersistentCommand::Disconnect(handle) => {
                Some((handle.clone(), Source::Relay))
            }
            _ => None,
        };
        self.enqueue(command, origin)
    }
    fn enqueue(
        &self,
        command: PersistentCommand,
        origin: Option<(Handle, Source)>,
    ) -> Result<Receipt> {
        let cost = command.cost().ok_or(Error::Full)?;
        let control = matches!(
            command,
            PersistentCommand::RemoveDevice(_) | PersistentCommand::DrainWork { .. }
        );
        let mut q = self.0.queues();
        if !self.0.running() {
            return Err(Error::NotExecuted);
        }
        let lease = if control {
            if cost > CONTROL_SLOT_BYTES || q.controls.len() >= CONTROL_SLOTS {
                return Err(Error::Full);
            }
            None
        } else {
            if q.commands.len() >= self.0.limits.commands {
                return Err(Error::Full);
            }
            if let Some((h, source)) = &origin {
                let mut carrier_count = 0;
                let mut carrier_bytes = cost;
                let mut source_count = 0;
                let mut source_bytes = cost;
                let mut total_count = 0;
                let mut total_bytes = cost;
                for pending in &q.commands {
                    if let Some((other, src)) = &pending.origin {
                        total_count += 1;
                        total_bytes += pending.cost;
                        if other.same(h) {
                            carrier_count += 1;
                            carrier_bytes += pending.cost;
                        }
                        if src == source {
                            source_count += 1;
                            source_bytes += pending.cost;
                        }
                    }
                }
                if carrier_count >= 8
                    || carrier_bytes > 2 * 1024 * 1024
                    || source_count >= 32
                    || source_bytes > 16 * 1024 * 1024
                    || total_count >= (self.0.limits.commands / 2).max(1)
                    || total_bytes > self.0.limits.command_bytes / 2
                {
                    return Err(Error::Full);
                }
            }
            Some(self.0.ingress.reserve(cost).map_err(|_| Error::Full)?)
        };
        let (reply, rx) = mpsc::sync_channel(1);
        if !self.0.running() {
            return Err(Error::NotExecuted);
        }
        let e = Envelope {
            origin,
            cost,
            command: Queued::Command(command),
            reply,
            lease,
        };
        if control {
            q.controls.push_back(e);
        } else {
            q.commands.push_back(e);
        }
        self.0.notify_work();
        Ok(Receipt(rx))
    }
    pub fn approve(
        &self,
        permit: PersistentApproval,
    ) -> std::result::Result<Receipt, ApprovalRejection> {
        let mut q = self.0.queues();
        let refusal = if !self.0.running() {
            Some(ApprovalRefusal::Stopped)
        } else if !Arc::ptr_eq(&self.0.scope, &permit.scope) {
            Some(ApprovalRefusal::Replaced)
        } else if self.0.clock.now() >= permit.deadline {
            Some(ApprovalRefusal::Expired)
        } else if permit.handle.status() == CarrierStatus::Closed(CloseReason::Replaced) {
            Some(ApprovalRefusal::Replaced)
        } else if permit.handle.status() != CarrierStatus::Pending
            || permit.state.load(Ordering::SeqCst) != LIVE
        {
            Some(ApprovalRefusal::Revoked)
        } else {
            None
        };
        if let Some(why) = refusal {
            drop(permit);
            self.0.notify_work();
            return Err(ApprovalRejection::Unavailable(why));
        }
        if q.controls.len() >= CONTROL_SLOTS {
            return Err(ApprovalRejection::Full(permit));
        }
        let (reply, rx) = mpsc::sync_channel(1);
        if !self.0.running() {
            return Err(ApprovalRejection::Unavailable(ApprovalRefusal::Stopped));
        }
        if permit
            .state
            .compare_exchange(LIVE, QUEUED, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err(ApprovalRejection::Unavailable(ApprovalRefusal::Revoked));
        }
        q.controls.push_back(Envelope {
            origin: None,
            cost: 1024,
            command: Queued::Approve(permit),
            reply,
            lease: None,
        });
        self.0.notify_work();
        Ok(Receipt(rx))
    }
    pub fn next_event(&self, timeout: Duration) -> Option<Event> {
        let q = self.0.queues();
        let (mut q, _) = self
            .0
            .changed
            .wait_timeout_while(q, timeout, |q| {
                q.events.is_empty()
                    && !q.work_ready
                    && self.0.stop.load(Ordering::SeqCst) == RUNNING
            })
            .unwrap_or_else(|e| {
                self.0.fail(WorkerFault::Poisoned);
                e.into_inner()
            });
        if !self.0.running() {
            return None;
        }
        if let Some(index) = q
            .events
            .iter()
            .position(|n| matches!(n.event, Event::Approval { .. }))
        {
            return q.events.remove(index).map(|n| n.event);
        }
        if q.work_ready {
            return Some(Event::WorkAvailable);
        }
        q.events.pop_front().map(|n| n.event)
    }
    pub fn event_stats(&self) -> EventStats {
        let q = self.0.queues();
        let advisory = q
            .events
            .iter()
            .filter(|n| matches!(n.event, Event::Closed(_)))
            .count();
        EventStats {
            authoritative: q.events.len() - advisory + usize::from(q.work_ready),
            advisory,
            closed_dropped: self.0.closed_dropped.load(Ordering::SeqCst),
            oldest_advisory_age_ms: q
                .events
                .iter()
                .filter(|n| matches!(n.event, Event::Closed(_)))
                .map(|n| n.created.elapsed().as_millis().min(u64::MAX as u128) as u64)
                .max(),
        }
    }
    /// Requests abort only; cannot acknowledge Clean or consume the owning service.
    pub fn request_abort(&self) {
        self.0.request_stop(true);
    }
    pub fn is_finished(&self) -> bool {
        self.0.finished.load(Ordering::SeqCst)
    }
    pub fn ticks(&self) -> u64 {
        self.0.ticks.load(Ordering::SeqCst)
    }
    pub fn retained_bytes(&self) -> usize {
        self.0.global.used()
    }
    pub fn failure(&self) -> Option<WorkerFault> {
        self.0.fault()
    }
}
pub(super) struct Carrier {
    pub(super) handle: Handle,
    pub(super) memory: MemoryCarrier,
}
pub(super) struct Pending {
    ticket: CarrierTicket,
    serial: u64,
    state: Arc<AtomicU8>,
}

impl From<crate::persistent::PersistentError> for Error {
    fn from(e: crate::persistent::PersistentError) -> Self {
        match e {
            crate::persistent::PersistentError::Policy(e) => Self::Policy(e),
            crate::persistent::PersistentError::Registry(e) => Self::Registry(e),
        }
    }
}
impl Runtime {
    pub(super) fn clear_owned(&mut self, _drained: &crate::persistent::composition::RunDrained) {
        for (_, c) in std::mem::take(&mut self.carriers) {
            c.memory.close();
        }
        for (_, p) in std::mem::take(&mut self.pending) {
            p.state.store(CANCELLED, Ordering::SeqCst);
        }
        drop(self.fixed.take());
    }
    pub(super) fn work_available(shared: &Shared, started: Vec<WorkToken>) {
        if started.is_empty() {
            return;
        }
        Self::mark_work_available(shared);
    }
    fn mark_work_available(shared: &Shared) {
        let mut q = shared.queues();
        if shared.stop.load(Ordering::SeqCst) == RUNNING {
            q.work_ready = true;
            shared.changed.notify_all();
        }
    }
    pub(super) fn publish_fixed_readiness(&mut self, shared: &Shared) {
        if self.authority.take_fixed_readiness() {
            Self::mark_work_available(shared);
        }
    }
    fn emit(shared: &Shared, event: Event) -> bool {
        let mut q = shared.queues();
        if !shared.running() {
            return false;
        }
        let advisory = matches!(event, Event::Closed(_));
        if advisory {
            let count = q
                .events
                .iter()
                .filter(|n| matches!(n.event, Event::Closed(_)))
                .count();
            if count >= shared.limits.events / 2 || q.events.len() >= shared.limits.events {
                shared.closed_dropped.fetch_add(1, Ordering::SeqCst);
                return false;
            }
        } else if q.events.len() >= shared.limits.events {
            if let Some(index) = q
                .events
                .iter()
                .position(|n| matches!(n.event, Event::Closed(_)))
            {
                q.events.remove(index);
                shared.closed_dropped.fetch_add(1, Ordering::SeqCst);
            } else {
                return false;
            }
        }
        let mut reservation = shared.events.reserve(2048);
        while reservation.is_err() && !advisory {
            let Some(index) = q
                .events
                .iter()
                .position(|n| matches!(n.event, Event::Closed(_)))
            else {
                break;
            };
            q.events.remove(index);
            shared.closed_dropped.fetch_add(1, Ordering::SeqCst);
            reservation = shared.events.reserve(2048);
        }
        let emitted = match reservation {
            Ok(lease) => {
                q.events.push_back(Notification {
                    event,
                    created: Instant::now(),
                    _lease: lease,
                });
                true
            }
            Err(_) if advisory => {
                shared.closed_dropped.fetch_add(1, Ordering::SeqCst);
                false
            }
            Err(_) => false,
        };
        shared.changed.notify_all();
        emitted
    }
    pub(super) fn current(&self, h: &Handle) -> Result<()> {
        if self
            .carriers
            .get(&h.carrier())
            .is_some_and(|c| c.handle.same(h))
            && !matches!(h.status(), CarrierStatus::Closed(_))
        {
            Ok(())
        } else {
            Err(Error::Stale)
        }
    }
    pub(super) fn reconcile(&mut self, shared: &Shared) {
        let stale: Vec<_> = self
            .pending
            .iter()
            .filter(|(_, p)| {
                p.state.load(Ordering::SeqCst) == CANCELLED
                    || self.authority.pending_for_carrier(&p.ticket).is_err()
            })
            .map(|(id, _)| *id)
            .collect();
        for id in stale {
            if let Some(p) = self.pending.remove(&id) {
                p.state.store(CANCELLED, Ordering::SeqCst);
                self.authority
                    .cancel_carrier_ticket(p.ticket, CloseReason::HelloTimeout);
            }
        }
        let closed: Vec<_> = self
            .carriers
            .iter()
            .filter(|(_, c)| matches!(c.handle.status(), CarrierStatus::Closed(_)))
            .map(|(id, _)| *id)
            .collect();
        for id in closed {
            let c = self.carriers.remove(&id).unwrap();
            c.memory.close();
            if let Some(p) = self.pending.remove(&id) {
                p.state.store(CANCELLED, Ordering::SeqCst);
                self.authority
                    .cancel_carrier_ticket(p.ticket, CloseReason::Disconnected);
            }
            Self::emit(shared, Event::Closed(c.handle));
        }
    }
    pub(super) fn maintain(&mut self, shared: &Shared) -> Result<()> {
        self.fixed_cancel_requests(shared)?;
        let result = self.authority.tick(self.clock.now());
        self.publish_fixed_readiness(shared);
        let started = result?;
        Self::work_available(shared, started);
        self.reconcile(shared);
        self.fixed_maintain(shared);
        self.fixed_copy_progress(shared)?;
        self.fixed_deliver(shared)?;
        shared.ticks.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    fn flush(&mut self, shared: &Shared) -> Vec<Handle> {
        let mut failed = Vec::new();
        for c in self
            .carriers
            .values()
            .filter(|c| c.handle.status() == CarrierStatus::Active)
        {
            if self.fixed.is_some() {
                match self.authority.fixed_egress(&c.handle, self.clock.now()) {
                    Ok(crate::registry::FixedEgress::TrackedFence) => continue,
                    Ok(crate::registry::FixedEgress::Ordinary) => (),
                    Err(_) => {
                        failed.push(c.handle.clone());
                        continue;
                    }
                }
            }
            loop {
                if !shared.running() {
                    break;
                }
                let result = self.authority.take_output_owned(
                    &c.handle,
                    self.clock.now(),
                    |bytes, lease| c.memory.deliver(bytes, lease, shared.limits),
                );
                if !matches!(result, Ok(true)) {
                    if result.is_err() {
                        failed.push(c.handle.clone());
                    }
                    break;
                }
            }
        }
        self.reconcile(shared);
        failed
    }
    fn complete(
        &mut self,
        h: &Handle,
        ticket: CarrierTicket,
        decision: CarrierDecision,
    ) -> Result<()> {
        let result = (|| {
            let access = self
                .authority
                .complete_for_carrier(ticket, decision, || self.clock.now())?;
            self.current(h)?;
            self.carriers[&h.carrier()].memory.bind_access(access)?;
            Ok(())
        })();
        if result.is_err() {
            self.authority.close_carrier(h, CloseReason::Protocol);
        }
        result
    }
    fn accept(&mut self, shared: &Shared, h: Handle, ticket: CarrierTicket) -> Result<()> {
        let prepared = (|| {
            self.current(&h)?;
            let d = self.authority.pending_for_carrier(&ticket)?;
            if !d.first_pairing || d.kind != DeviceKind::Desktop {
                return Ok(None);
            }
            self.serial = self.serial.checked_add(1).ok_or(Error::Configuration)?;
            Ok(Some(
                self.authority
                    .prepare_pending_approval(&ticket, self.clock.now())?,
            ))
        })();
        match prepared {
            Err(e) => {
                self.authority
                    .cancel_carrier_ticket(ticket, CloseReason::Protocol);
                Err(e)
            }
            Ok(None) => self.complete(&h, ticket, CarrierDecision::PhoneOrKnown),
            Ok(Some(metadata)) => {
                let state = Arc::new(AtomicU8::new(LIVE));
                self.pending.insert(
                    h.carrier(),
                    Pending {
                        ticket,
                        serial: self.serial,
                        state: state.clone(),
                    },
                );
                let emitted = Self::emit(
                    shared,
                    Event::Approval {
                        permit: PersistentApproval {
                            handle: h.clone(),
                            serial: self.serial,
                            deadline: metadata.deadline,
                            state,
                            scope: shared.scope.clone(),
                            wake: shared
                                .fixed_wake
                                .as_ref()
                                .and_then(wake::WakeAccess::hub)
                                .map_or_else(std::sync::Weak::new, |hub| hub.shared_token()),
                        },
                        device_key: metadata.device_key,
                        deadline: metadata.deadline,
                    },
                );
                if !emitted {
                    // A resource refusal is local, never a dirty-profile stop.
                    let p = self.pending.remove(&h.carrier()).unwrap();
                    p.state.store(CANCELLED, Ordering::SeqCst);
                    self.authority
                        .cancel_carrier_ticket(p.ticket, CloseReason::Limit);
                    return Err(Error::Full);
                }
                Ok(())
            }
        }
    }
    fn apply(&mut self, shared: &Shared, command: Queued) -> Result<Reply> {
        let now = self.clock.now();
        let command = match command {
            Queued::Approve(permit) => {
                self.current(&permit.handle)?;
                if now >= permit.deadline
                    || !self.pending.get(&permit.handle.carrier()).is_some_and(|p| {
                        p.serial == permit.serial && Arc::ptr_eq(&p.state, &permit.state)
                    })
                {
                    return Err(Error::Stale);
                }
                let p = self.pending.remove(&permit.handle.carrier()).unwrap();
                if permit
                    .state
                    .compare_exchange(QUEUED, CONSUMED, Ordering::SeqCst, Ordering::SeqCst)
                    .is_err()
                {
                    self.authority
                        .cancel_carrier_ticket(p.ticket, CloseReason::Protocol);
                    return Err(Error::Stale);
                }
                self.complete(&permit.handle, p.ticket, CarrierDecision::ApprovedDesktop)?;
                return Ok(Reply::Done);
            }
            Queued::Command(command) => command,
        };
        use PersistentCommand as C;
        match command {
            C::OpenPairing => self.authority.open_pairing(now)?,
            C::EnableDesktop => self.authority.enable_desktop()?,
            C::HostPublicKey => return Ok(Reply::HostPublicKey(self.authority.host_public_key())),
            C::PairingInvitation => {
                return Ok(Reply::PairingInvitation(
                    self.authority.with_pairing_invitation(now, str::to_owned)?,
                ))
            }
            C::AdmissionStatus(source) => {
                return Ok(Reply::AdmissionStatus(
                    self.authority.admission_status(source, now)?,
                ))
            }
            C::Attach { id, carrier } => {
                carrier.bind()?;
                let h = match self.authority.open_carrier(id, now) {
                    Ok(h) => h,
                    Err(e) => {
                        carrier.close();
                        return Err(e.into());
                    }
                };
                if let Err(error) = carrier.bind_service(&h, shared.scope.clone()) {
                    carrier.close();
                    self.authority.close_carrier(&h, CloseReason::Protocol);
                    return Err(error.into());
                }
                self.reconcile(shared);
                self.carriers.insert(
                    id,
                    Carrier {
                        handle: h.clone(),
                        memory: carrier,
                    },
                );
                return Ok(Reply::Attached(h));
            }
            C::Hello {
                handle,
                source,
                bytes,
            } => {
                self.current(&handle)?;
                let t = self
                    .authority
                    .begin_for_carrier(&handle, source, &bytes, now, &mut OsRng)?;
                self.reconcile(shared);
                self.accept(shared, handle, t)?;
            }
            C::Disconnect(h) => {
                self.current(&h)?;
                self.authority.close_carrier(&h, CloseReason::Disconnected);
            }
            C::RemoveDevice(key) => self.authority.remove_device(&key, now)?,
            C::DrainWork { cursor, limit } => {
                let result = self.authority.drain_work(cursor.as_ref(), limit, now);
                self.publish_fixed_readiness(shared);
                let page = result?;
                if cursor.is_none() {
                    shared.queues().work_ready = false;
                }
                return Ok(Reply::Work(page));
            }
            C::Request { handle, bytes } => {
                self.current(&handle)?;
                let started = self.authority.receive_request(&handle, &bytes, now)?;
                Self::work_available(shared, started);
            }
            C::Send { handle, encoded } => {
                self.current(&handle)?;
                self.fixed_peer_outbound(&handle)?;
                self.authority.send_for_carrier(&handle, &encoded, now)?;
            }
            C::Finish { token, response } => {
                self.fixed_peer_outbound(token.handle())?;
                let started = self.authority.finish_request(&token, &response, now)?;
                Self::work_available(shared, started);
            }
            C::DispatchSynthetic { token, http } => {
                self.fixed_peer_outbound(token.handle())?;
                let (record, started) = self.authority.dispatch_synthetic(&token, &http, now)?;
                Self::work_available(shared, started);
                return Ok(Reply::Dispatched(record));
            }
            #[cfg(test)]
            C::Probe(probe) => match probe {
                Probe::Park { entered, release } => {
                    let _ = entered.try_send(());
                    let (lock, cv) = &*release;
                    let g = lock.lock().unwrap();
                    drop(cv.wait_while(g, |open| !*open).unwrap());
                }
                Probe::Panic => panic!("synthetic command panic"),
                Probe::PoisonQueue => {
                    let _held = shared.queues.lock().unwrap();
                    panic!("synthetic queue poison");
                }
                Probe::BeforeCommit(callback) => self.authority.before_commit_for_test(callback),
                Probe::AfterApply(callback) => self.after_apply = Some(callback),
            },
        }
        Ok(Reply::Done)
    }
    fn execute(&mut self, shared: &Shared, command: Queued) -> Result<Reply> {
        let target = match &command {
            Queued::Command(c) => c.target(),
            Queued::Approve(p) => Some(p.handle.clone()),
        };
        #[cfg(test)]
        let run_probe = !matches!(command, Queued::Command(PersistentCommand::Probe(_)));
        let mut result = self.apply(shared, command);
        #[cfg(test)]
        if run_probe {
            if let Some(callback) = self.after_apply.take() {
                callback();
            }
        }
        if self.authority.global_pool().is_err() {
            shared.fail(WorkerFault::InvalidExit);
        }
        self.reconcile(shared);
        let failed = self.flush(shared);
        self.publish_fixed_readiness(shared);
        if result.is_ok() && target.is_some_and(|h| failed.iter().any(|other| other.same(&h))) {
            result = Err(Error::DeliveryUnknown);
        }
        if result.is_ok() && !shared.running() {
            result = Err(Error::UnknownOutcome);
        }
        result
    }
    pub(super) fn run(&mut self, shared: &Arc<Shared>) {
        if self.fixed.is_some() {
            self.run_fixed(shared);
            return;
        }
        loop {
            if !shared.running() {
                break;
            }
            if self.maintain(shared).is_err() {
                shared.fail(WorkerFault::Clock);
                break;
            }
            let occupied = self.authority.fixed_owner_occupancy();
            let envelope = {
                let q = shared.queues();
                let (mut q, _) = shared
                    .wake
                    .wait_timeout_while(q, Duration::from_millis(shared.limits.tick_ms), |q| {
                        q.commands.is_empty()
                            && q.controls.is_empty()
                            && !q.fixed.as_ref().is_some_and(|f| f.has_operations())
                            && !q.fixed.as_ref().is_some_and(|f| f.can_start(&occupied))
                            && shared.stop.load(Ordering::SeqCst) == RUNNING
                    })
                    .unwrap_or_else(|e| {
                        shared.fail(WorkerFault::Poisoned);
                        e.into_inner()
                    });
                if !shared.running() {
                    break;
                }
                q.controls.pop_front().or_else(|| q.commands.pop_front())
            };
            if let Some(envelope) = envelope {
                if self.maintain(shared).is_err() {
                    envelope.reject();
                    shared.fail(WorkerFault::Clock);
                    break;
                }
                if !shared.running() {
                    envelope.reject();
                    break;
                }
                let result = self.execute(shared, envelope.command);
                drop(envelope.lease); // A receipt observes released ingress accounting.
                let _ = envelope.reply.try_send(result);
            }
            self.fixed_prepare_one(shared);
            self.fixed_start_one(shared);
        }
    }
    fn run_fixed(&mut self, shared: &Arc<Shared>) {
        let hub = self.fixed.as_ref().unwrap().hub.as_ref().unwrap().clone();
        loop {
            let generation = hub.generation();
            if !shared.running() {
                break;
            }
            #[cfg(test)]
            let fair = shared
                .queues()
                .fixed
                .as_ref()
                .and_then(|f| f.park_hooks())
                .and_then(|h| h.fair.clone());
            #[cfg(test)]
            if let Some(fair) = fair {
                fair.before_round();
            }
            if !shared.running() {
                break;
            }
            if self.maintain(shared).is_err() {
                shared.fail(WorkerFault::Clock);
                break;
            }
            // Extract the ordinary envelope only after the control command resolves.
            for control in [true, false] {
                if !shared.running() {
                    break;
                }
                let envelope = {
                    let mut q = shared.queues();
                    if control {
                        q.controls.pop_front()
                    } else {
                        q.commands.pop_front()
                    }
                };
                if let Some(envelope) = envelope {
                    if self.maintain(shared).is_err() {
                        envelope.reject();
                        shared.fail(WorkerFault::Clock);
                        break;
                    }
                    if !shared.running() {
                        envelope.reject();
                        break;
                    }
                    let result = self.execute(shared, envelope.command);
                    drop(envelope.lease);
                    let _ = envelope.reply.try_send(result);
                }
            }
            self.fixed_prepare_one(shared);
            self.fixed_start_one(shared);
            let occupied = self.authority.fixed_owner_occupancy();
            let runnable = {
                let q = shared.queues();
                !q.commands.is_empty()
                    || !q.controls.is_empty()
                    || q.fixed
                        .as_ref()
                        .is_some_and(|f| f.has_operations() || f.can_start(&occupied))
            };
            #[cfg(test)]
            let test = shared
                .queues()
                .fixed
                .as_ref()
                .and_then(|state| state.park_hooks());
            #[cfg(test)]
            if let Some(test) = &test {
                test.rounds.fetch_add(1, Ordering::SeqCst);
                if !runnable {
                    if let Some(gate) = &test.before_check {
                        gate.wait();
                    }
                }
            }
            if !shared.running() {
                break;
            }
            if !runnable && hub.generation() == generation {
                #[cfg(test)]
                if let Some(test) = &test {
                    if let Some(gate) = &test.after_check {
                        gate.wait();
                    }
                    test.parks.fetch_add(1, Ordering::SeqCst);
                }
                #[cfg(test)]
                if let Some(test) = test
                    .as_ref()
                    .filter(|test| test.no_timeout && !test.entered.load(Ordering::SeqCst))
                {
                    let _ = test.actor.set(thread::current());
                    thread::park_timeout(Duration::ZERO); // Drain old tokens before the test's atomic gap.
                    test.entered.store(true, Ordering::SeqCst);
                    while !test.release.load(Ordering::SeqCst) {
                        thread::yield_now();
                    }
                    if !shared.running() {
                        continue;
                    }
                    thread::park();
                    continue;
                }
                thread::park_timeout(Duration::from_millis(shared.limits.tick_ms));
            } else {
                #[cfg(test)]
                if !runnable {
                    if let Some(test) = &test {
                        test.skipped.fetch_add(1, Ordering::SeqCst);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod rejection_tests {
    use super::*;
    #[test]
    fn rejected_receipt_releases_ingress_before_envelope_scope_ends() {
        let global = crate::budget::GlobalBudget::new(1024).unwrap();
        let budget = global.connection(1024).unwrap();
        let memory = MemoryCarrier::new();
        let (reply, receipt) = mpsc::sync_channel(1);
        let envelope = Envelope {
            origin: None,
            cost: 1024,
            command: Queued::Command(PersistentCommand::Attach {
                id: 1,
                carrier: memory.clone(),
            }),
            reply,
            lease: Some(budget.reserve(1024).unwrap()),
        };
        let (published, observed) = mpsc::sync_channel(1);
        let (resume, paused) = mpsc::sync_channel(1);
        let worker = std::thread::spawn(move || {
            envelope.reject_after(|| {
                published.send(()).unwrap();
                let _ = paused.recv_timeout(Duration::from_secs(3));
            })
        });
        let result = receipt.recv_timeout(Duration::from_secs(3)).unwrap();
        observed.recv_timeout(Duration::from_secs(3)).unwrap();
        let used = budget.used();
        let reusable = budget.reserve(1024);
        let closed = memory.is_closed();
        resume.send(()).unwrap();
        worker.join().unwrap();
        assert!(matches!(result, Err(Error::NotExecuted)));
        assert!(closed);
        assert_eq!(used, 0);
        assert!(reusable.is_ok());
        drop(reusable);
        assert_eq!(global.used(), 0);
    }
}

//! One joined synthetic worker; no sockets, imported stores, callback executors or task runtime.
use crate::{
    admission::Source,
    budget::{ConnectionBudget, GlobalBudget, Reservation},
    channel::{DesktopAccess, DeviceKind, MAX_HELLO_BYTES, MAX_PLAIN_BYTES},
    policy::{self, TemporaryAuthority, Ticket},
    registry::{
        self, CarrierStatus, CloseReason, Handle, Registry, WorkCursor, WorkPage, WorkToken,
    },
    SecretKey,
};
use rand_core::OsRng;
use std::{
    collections::{BTreeMap, VecDeque},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering},
        mpsc, Arc, Condvar, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("command was not admitted; queue or byte bound reached")]
    Full,
    #[error("command was not executed; supervisor is stopped")]
    NotExecuted,
    #[error("command outcome is unknown; do not replay")]
    UnknownOutcome,
    #[error("carrier, approval or work generation is stale")]
    Stale,
    #[error("carrier delivery outcome is unknown or incomplete; carrier closed, do not replay")]
    DeliveryUnknown,
    #[error("invalid supervisor configuration")]
    Configuration,
    #[error(transparent)]
    Policy(#[from] policy::PolicyError),
    #[error(transparent)]
    Registry(#[from] registry::RegistryError),
    #[error(transparent)]
    Protocol(#[from] crate::Error),
    #[error(transparent)]
    Spawn(#[from] std::io::Error),
}
pub type Result<T> = std::result::Result<T, Error>;

/// Values must be synthetic. There is deliberately no path or existing-store parameter.
pub struct SyntheticIdentity {
    pub host: SecretKey,
    pub token: String,
    pub desktop: DesktopAccess,
}
#[derive(Clone, Copy)]
pub struct Limits {
    pub authority: policy::Limits,
    pub registry: registry::Limits,
    pub commands: usize,
    pub command_bytes: usize,
    pub events: usize,
    pub carrier_bytes: usize,
    pub carrier_frames: usize,
    pub tick_ms: u64,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            authority: Default::default(),
            registry: Default::default(),
            commands: 64,
            command_bytes: 32 * 1024 * 1024,
            events: 128,
            carrier_bytes: 32 * 1024 * 1024,
            carrier_frames: 256,
            tick_ms: 10,
        }
    }
}
/// A trusted test clock, not a peer timestamp. Advancing it never drives the worker.
#[derive(Clone, Default)]
pub struct ManualClock(Arc<AtomicU64>);
impl ManualClock {
    pub fn advance_to(&self, now: u64) -> Result<()> {
        self.0
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |old| {
                (now >= old).then_some(now)
            })
            .map(|_| ())
            .map_err(|_| Error::Configuration)
    }
}
#[derive(Clone)]
pub enum Clock {
    Manual(ManualClock),
    Monotonic(Instant),
}
impl Clock {
    pub fn monotonic() -> Self {
        Self::Monotonic(Instant::now())
    }
    pub(crate) fn now(&self) -> u64 {
        match self {
            Self::Manual(c) => c.0.load(Ordering::SeqCst),
            Self::Monotonic(t) => t.elapsed().as_millis().min(u64::MAX as u128) as u64,
        }
    }
}
struct Packet {
    bytes: Vec<u8>,
    _lease: Reservation,
}
struct ServiceMailboxBinding {
    scope: Arc<()>,
    handle: Handle,
}
#[derive(Default)]
struct Mailbox {
    access: Option<policy::Access>,
    fixed_target: Option<crate::tracked_output::TargetId>,
    fixed_fence: Option<Arc<crate::tracked_output::Fence>>,
    fixed_packet: Option<crate::tracked_output::Packet>,
    #[cfg(test)]
    fixed_unwind: u8,
    bound: bool,
    service_binding: Option<ServiceMailboxBinding>,
    closed: bool,
    bytes: usize,
    packets: VecDeque<Packet>,
    unknown_next: bool,
    attempts: u64,
}
/// Injected fake carrier. No arbitrary callback can block the supervisor's worker.
#[derive(Clone, Default)]
pub struct MemoryCarrier(Arc<Mutex<Mailbox>>);
impl MemoryCarrier {
    pub fn new() -> Self {
        Self::default()
    }
    /// Move a delivered copy to the test consumer. Its subsequent memory is caller-owned.
    pub fn receive(&self) -> Option<Vec<u8>> {
        // Clone the opaque guard without holding the mailbox lock while acquiring
        // it: delivery takes the epoch guard before the mailbox in the same order.
        let access = self
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .access
            .clone()?;
        access
            .with(|| {
                let mut m = self.0.lock().unwrap_or_else(|e| e.into_inner());
                if m.closed || m.fixed_fence.as_ref().is_some_and(|f| f.active()) {
                    return Ok(None);
                }
                let Some(packet) = m.packets.pop_front() else {
                    return Ok(None);
                };
                m.bytes -= packet.bytes.len();
                Ok(Some(packet.bytes))
            })
            .ok()
            .flatten()
    }
    pub fn is_closed(&self) -> bool {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).closed
    }
    pub fn delivery_attempts(&self) -> u64 {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).attempts
    }
    /// Pretend the next send may have reached the peer, but its acknowledgement was lost.
    pub fn inject_unknown_delivery(&self) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .unknown_next = true;
    }
    pub(crate) fn bind(&self) -> Result<()> {
        let mut m = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if m.bound || m.closed {
            return Err(Error::Stale);
        }
        m.bound = true;
        Ok(())
    }
    /// Install once, before transferring replies. Epoch lock always precedes mailbox lock.
    pub(crate) fn bind_access(&self, access: policy::Access) -> crate::Result<()> {
        access.with(|| {
            let mut m = self.0.lock().unwrap_or_else(|e| e.into_inner());
            if !m.bound || m.closed || m.access.is_some() {
                return Err(crate::Error::Unauthorized);
            }
            m.access = Some(access.clone());
            Ok(())
        })
    }
    pub(crate) fn close(&self) {
        let mut m = self.0.lock().unwrap_or_else(|e| e.into_inner());
        m.closed = true;
        m.access = None;
        m.packets.clear();
        drop(m.fixed_packet.take());
        m.bytes = 0;
    }
    pub(crate) fn deliver(
        &self,
        bytes: Vec<u8>,
        lease: Reservation,
        limits: Limits,
    ) -> crate::Result<()> {
        let mut m = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if m.closed {
            return Err(crate::Error::Unauthorized);
        }
        if m.fixed_fence.as_ref().is_some_and(|f| f.active()) {
            return Err(crate::Error::Budget);
        }
        if m.packets.len() >= limits.carrier_frames
            || bytes.len() > limits.carrier_bytes.saturating_sub(m.bytes)
        {
            return Err(crate::Error::Budget);
        }
        m.attempts = m.attempts.saturating_add(1);
        if m.unknown_next {
            m.unknown_next = false;
            return Err(crate::Error::Unauthorized);
        }
        m.bytes += bytes.len();
        m.packets.push_back(Packet {
            bytes,
            _lease: lease,
        });
        Ok(())
    }
}
/// Consuming owner decision capability; the real authority ticket never leaves its worker.
pub struct Approval {
    handle: Handle,
    serial: u64,
}
pub enum Event {
    Approval {
        permit: Approval,
        device_key: String,
    },
    WorkAvailable,
    Closed(Handle),
}
pub enum Command {
    DispatchSynthetic {
        token: WorkToken,
        http: crate::http_dispatch::MemoryHttp,
    },
    DrainWork {
        cursor: Option<WorkCursor>,
        limit: usize,
    },
    OpenPairing,
    Attach {
        id: u64,
        carrier: MemoryCarrier,
    },
    Hello {
        handle: Handle,
        source: Source,
        bytes: Vec<u8>,
    },
    Approve(Approval),
    Disconnect(Handle),
    RemoveDevice(String),
    Retire,
    Replace(SyntheticIdentity),
    Request {
        handle: Handle,
        bytes: Vec<u8>,
    },
    Finish {
        token: WorkToken,
        response: Vec<u8>,
    },
    Send {
        handle: Handle,
        encoded: Vec<u8>,
    },
}
impl Command {
    fn delivery_target(&self) -> Option<Handle> {
        match self {
            Self::Hello { handle, .. }
            | Self::Request { handle, .. }
            | Self::Send { handle, .. } => Some(handle.clone()),
            Self::Approve(permit) => Some(permit.handle.clone()),
            Self::Finish { token, .. } | Self::DispatchSynthetic { token, .. } => {
                Some(token.handle().clone())
            }
            _ => None,
        }
    }
    fn cost(&self) -> Option<usize> {
        let payload = match self {
            Self::DispatchSynthetic { http, .. } => http.retained_capacity(),
            Self::Hello { bytes, .. } if bytes.len() <= MAX_HELLO_BYTES => bytes.capacity(),
            Self::Request { bytes, .. } if bytes.len() <= crate::envelope::MAX_PAYLOAD => {
                bytes.capacity()
            }
            Self::Finish { response, .. } if response.len() <= MAX_PLAIN_BYTES => {
                response.capacity()
            }
            Self::Send { encoded, .. } if encoded.len() <= MAX_PLAIN_BYTES => encoded.capacity(),
            Self::RemoveDevice(key) if key.len() <= 128 => key.capacity(),
            Self::Replace(id) if id.token.len() <= 1024 => id.token.capacity(),
            Self::Hello { .. }
            | Self::Request { .. }
            | Self::Finish { .. }
            | Self::Send { .. }
            | Self::RemoveDevice(_)
            | Self::Replace(_) => return None,
            _ => 0,
        };
        payload.checked_add(1024)
    }
}
pub enum Reply {
    Dispatched(crate::http_dispatch::DispatchRecord),
    Work(WorkPage),
    Done,
    Attached(Handle),
}
/// Drop does not cancel an accepted mutation. Retain this receipt to observe its result.
/// An observed result releases this command's ingress lease, not other queued/event/output leases.
pub struct Receipt(mpsc::Receiver<Result<Reply>>);
impl Receipt {
    pub fn wait(&self, timeout: Duration) -> Result<Reply> {
        match self.0.recv_timeout(timeout) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => Err(Error::UnknownOutcome),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(Error::UnknownOutcome),
        }
    }
}
pub const CONTROL_RESERVE_BYTES: usize = 18 * 1024;
const CONTROL_SLOT_BYTES: usize = 2048;
const CONTROL_SLOTS: usize = 8;
const CARRIER_COMMANDS: usize = 8;
const CARRIER_BYTES: usize = 2 * 1024 * 1024;
const SOURCE_COMMANDS: usize = 32;
const SOURCE_BYTES: usize = 16 * 1024 * 1024;
struct Envelope {
    origin: Option<(Handle, Source)>,
    cost: usize,
    command: Command,
    reply: mpsc::SyncSender<Result<Reply>>,
    _lease: Option<Reservation>,
}
impl Envelope {
    fn publish(
        reply: mpsc::SyncSender<Result<Reply>>,
        lease: Option<Reservation>,
        result: Result<Reply>,
    ) {
        drop(lease);
        let _ = reply.try_send(result);
    }
    fn reject(self) {
        if let Command::Attach { carrier, .. } = &self.command {
            carrier.close();
        }
        drop(self.command);
        Self::publish(self.reply, self._lease, Err(Error::NotExecuted));
    }
}
struct Notification {
    event: Event,
    created: Instant,
    _lease: Reservation,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum StopReason {
    Running,
    Requested,
    EventOverflow,
    ClockFailure,
    WorkerFailure,
}
struct Queues {
    commands: VecDeque<Envelope>,
    controls: VecDeque<Envelope>,
    control_reserve: Option<Reservation>,
    events: VecDeque<Notification>,
    work_ready: bool,
}
struct Shared {
    queues: Mutex<Queues>,
    wake: Condvar,
    changed: Condvar,
    stop: AtomicU8,
    finished: AtomicBool,
    retired: AtomicBool,
    ticks: AtomicU64,
    closed_dropped: AtomicU64,
    ingress: ConnectionBudget,
    events: ConnectionBudget,
    global: GlobalBudget,
    limits: Limits,
}
impl Shared {
    fn dropped_closure(&self) {
        let _ = self
            .closed_dropped
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                Some(n.saturating_add(1))
            });
    }
    fn stop(&self, why: StopReason) {
        let _ = self
            .stop
            .compare_exchange(0, why as u8, Ordering::SeqCst, Ordering::SeqCst);
        self.wake.notify_all();
        self.changed.notify_all();
    }
}
struct Completion(Arc<Shared>);
impl Drop for Completion {
    fn drop(&mut self) {
        self.0.finished.store(true, Ordering::SeqCst);
        self.0.changed.notify_all();
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EventStats {
    pub authoritative: usize,
    pub advisory: usize,
    pub closed_dropped: u64,
    pub oldest_advisory_age_ms: Option<u64>,
}
#[derive(Clone)]
pub struct OwnerClient(Arc<Shared>);
/// Compatibility name for the full trusted owner capability.
pub type Client = OwnerClient;
/// Commands accepted by a capability bound to one carrier generation and source.
pub enum CarrierCommand {
    Hello(Vec<u8>),
    Request(Vec<u8>),
    Disconnect,
}
/// A transport capability cannot change identity/approval policy or read owner work.
/// ```compile_fail
/// use milagre_remote::supervisor::{CarrierClient,Command};
/// fn escalate(c:CarrierClient) { c.submit(Command::Retire); }
/// ```
/// ```compile_fail
/// use milagre_remote::supervisor::CarrierClient;
/// fn steal(c:CarrierClient) { c.next_event(std::time::Duration::ZERO); }
/// ```
#[derive(Clone)]
pub struct CarrierClient {
    owner: OwnerClient,
    handle: Handle,
    source: Source,
}
impl CarrierClient {
    pub fn submit(&self, command: CarrierCommand) -> Result<Receipt> {
        let handle = self.handle.clone();
        let command = match command {
            CarrierCommand::Hello(bytes) => Command::Hello {
                handle,
                source: self.source,
                bytes,
            },
            CarrierCommand::Request(bytes) => Command::Request { handle, bytes },
            CarrierCommand::Disconnect => Command::Disconnect(handle),
        };
        self.owner
            .enqueue(command, Some((self.handle.clone(), self.source)))
    }
    pub fn status(&self) -> CarrierStatus {
        self.handle.status()
    }
}
impl OwnerClient {
    /// Mint only after the trusted carrier router assigned the handle and origin.
    pub fn carrier(&self, handle: Handle, source: Source) -> CarrierClient {
        CarrierClient {
            owner: self.clone(),
            handle,
            source,
        }
    }
    pub fn submit(&self, command: Command) -> Result<Receipt> {
        let origin = match &command {
            Command::Hello { handle, source, .. } => Some((handle.clone(), *source)),
            Command::Request { handle, .. } | Command::Disconnect(handle) => {
                Some((handle.clone(), Source::Relay))
            }
            _ => None,
        };
        self.enqueue(command, origin)
    }
    fn enqueue(&self, command: Command, origin: Option<(Handle, Source)>) -> Result<Receipt> {
        let cost = command.cost().ok_or(Error::Full)?;
        let control = matches!(
            command,
            Command::Retire
                | Command::RemoveDevice(_)
                | Command::Approve(_)
                | Command::DrainWork { .. }
        );
        let mut q = self.0.queues.lock().unwrap_or_else(|e| e.into_inner());
        if self.0.stop.load(Ordering::SeqCst) != 0 {
            return Err(Error::NotExecuted);
        }
        let lease = if control {
            // Precharged at construction, so data/global saturation cannot consume it.
            if cost > CONTROL_SLOT_BYTES || q.controls.len() >= CONTROL_SLOTS {
                return Err(Error::Full);
            }
            None
        } else {
            if q.commands.len() >= self.0.limits.commands {
                return Err(Error::Full);
            }
            if let Some((handle, source)) = &origin {
                let mut carrier_count = 0;
                let mut carrier_bytes = cost;
                let mut source_count = 0;
                let mut source_bytes = cost;
                let mut total_count = 0;
                let mut total_bytes = cost;
                for pending in &q.commands {
                    if let Some((h, src)) = &pending.origin {
                        total_count += 1;
                        total_bytes += pending.cost;
                        if h.same(handle) {
                            carrier_count += 1;
                            carrier_bytes += pending.cost;
                        }
                        if src == source {
                            source_count += 1;
                            source_bytes += pending.cost;
                        }
                    }
                }
                if carrier_count >= CARRIER_COMMANDS
                    || carrier_bytes > CARRIER_BYTES
                    || source_count >= SOURCE_COMMANDS
                    || source_bytes > SOURCE_BYTES
                    || total_count >= (self.0.limits.commands / 2).max(1)
                    || total_bytes > self.0.limits.command_bytes / 2
                {
                    return Err(Error::Full);
                }
            }
            Some(self.0.ingress.reserve(cost).map_err(|_| Error::Full)?)
        };
        let (tx, rx) = mpsc::sync_channel(1);
        let envelope = Envelope {
            origin,
            cost,
            command,
            reply: tx,
            _lease: lease,
        };
        if control {
            q.controls.push_back(envelope);
        } else {
            q.commands.push_back(envelope);
        }
        self.0.wake.notify_one();
        Ok(Receipt(rx))
    }
    pub fn next_event(&self, timeout: Duration) -> Option<Event> {
        let q = self.0.queues.lock().unwrap_or_else(|e| e.into_inner());
        let (mut q, _) = self
            .0
            .changed
            .wait_timeout_while(q, timeout, |q| {
                q.events.is_empty() && !q.work_ready && !self.0.finished.load(Ordering::SeqCst)
            })
            .unwrap_or_else(|e| e.into_inner());
        // Approvals cannot be starved by repeated readiness observations.
        if let Some(index) = q
            .events
            .iter()
            .position(|n| matches!(n.event, Event::Approval { .. }))
        {
            return q.events.remove(index).map(|n| n.event);
        }
        // A readiness observation is acknowledged only by a successful initial drain.
        if q.work_ready {
            return Some(Event::WorkAvailable);
        }
        q.events.pop_front().map(|n| n.event)
    }
    pub fn event_stats(&self) -> EventStats {
        let q = self.0.queues.lock().unwrap_or_else(|e| e.into_inner());
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
    pub fn stop_reason(&self) -> StopReason {
        match self.0.stop.load(Ordering::SeqCst) {
            0 => StopReason::Running,
            1 => StopReason::Requested,
            2 => StopReason::EventOverflow,
            3 => StopReason::ClockFailure,
            _ => StopReason::WorkerFailure,
        }
    }
    /// Identity admission is retired, independently of whether the worker is running.
    pub fn is_retired(&self) -> bool {
        self.0.retired.load(Ordering::SeqCst)
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
}
pub struct Supervisor {
    client: OwnerClient,
    worker: Option<JoinHandle<()>>,
    initial_directory: PathBuf,
}
impl Supervisor {
    pub fn spawn_synthetic(
        identity: SyntheticIdentity,
        limits: Limits,
        clock: Clock,
    ) -> Result<Self> {
        if limits.commands == 0
            || limits.commands > 256
            || limits.events == 0
            || limits.events > 1024
            || limits.command_bytes < 1024
            || limits.command_bytes > 64 * 1024 * 1024
            || limits.carrier_frames == 0
            || limits.carrier_frames > 256
            || limits.carrier_bytes == 0
            || limits.carrier_bytes > 64 * 1024 * 1024
            || !(1..=100).contains(&limits.tick_ms)
        {
            return Err(Error::Configuration);
        }
        let global = GlobalBudget::new(256 * 1024 * 1024)?;
        let authority = make_authority(identity, limits, global.clone())?;
        let initial_directory = authority.temporary_directory().to_owned();
        let registry = Registry::new(limits.registry, &mut OsRng)?;
        let shared = Arc::new(Shared {
            queues: Mutex::new(Queues {
                commands: VecDeque::new(),
                controls: VecDeque::new(),
                control_reserve: Some(
                    global
                        .connection(CONTROL_RESERVE_BYTES)?
                        .reserve(CONTROL_RESERVE_BYTES)?,
                ),
                events: VecDeque::new(),
                work_ready: false,
            }),
            wake: Condvar::new(),
            changed: Condvar::new(),
            stop: AtomicU8::new(0),
            finished: AtomicBool::new(false),
            retired: AtomicBool::new(false),
            ticks: AtomicU64::new(0),
            closed_dropped: AtomicU64::new(0),
            ingress: global.connection(limits.command_bytes)?,
            events: global.connection(limits.events * 2048)?,
            global,
            limits,
        });
        let client = OwnerClient(shared.clone());
        let worker = thread::Builder::new()
            .name("synthetic-remote".into())
            .spawn(move || {
                let completion = Completion(shared.clone());
                let mut actor = Actor {
                    shared,
                    clock,
                    authority,
                    registry,
                    carriers: BTreeMap::new(),
                    pending: BTreeMap::new(),
                    serial: 0,
                    #[cfg(test)]
                    after_reply: None,
                };
                actor.run();
                drop(actor);
                drop(completion);
            })?;
        Ok(Self {
            client,
            worker: Some(worker),
            initial_directory,
        })
    }
    pub fn owner(&self) -> OwnerClient {
        self.client.clone()
    }
    pub fn client(&self) -> OwnerClient {
        self.client.clone()
    }
    /// Test artifact observation only. No import/adoption API exists.
    pub fn initial_directory(&self) -> &std::path::Path {
        &self.initial_directory
    }
    pub fn shutdown(mut self) {
        self.stop_and_join();
    }
    fn stop_and_join(&mut self) {
        self.client.0.stop(StopReason::Requested);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
impl Drop for Supervisor {
    fn drop(&mut self) {
        self.stop_and_join();
    }
}
// Callers replacing an identity must retire the old authority/registry first.
// Failure leaves that old identity retired; success alone re-enables admission.
fn make_authority(
    identity: SyntheticIdentity,
    limits: Limits,
    global: GlobalBudget,
) -> Result<TemporaryAuthority> {
    if identity.token.capacity() > 1024 {
        return Err(Error::Configuration);
    }
    Ok(TemporaryAuthority::create_synthetic_in_pool(
        identity.host,
        identity.token,
        identity.desktop,
        limits.authority,
        &mut OsRng,
        global,
    )?)
}
struct Carrier {
    handle: Handle,
    memory: MemoryCarrier,
}
struct Pending {
    ticket: Ticket,
    serial: u64,
}
struct Actor {
    shared: Arc<Shared>,
    clock: Clock,
    authority: TemporaryAuthority,
    registry: Registry,
    carriers: BTreeMap<u64, Carrier>,
    pending: BTreeMap<u64, Pending>,
    serial: u64,
    #[cfg(test)]
    after_reply: Option<Box<dyn FnOnce() + Send>>,
}
impl Actor {
    fn work_available(&self, started: Vec<WorkToken>) {
        if started.is_empty() {
            return;
        }
        let mut q = self.shared.queues.lock().unwrap_or_else(|e| e.into_inner());
        if self.shared.stop.load(Ordering::SeqCst) == 0 {
            q.work_ready = true;
            self.shared.changed.notify_all();
        }
    }
    fn emit(&self, event: Event) {
        let mut q = self.shared.queues.lock().unwrap_or_else(|e| e.into_inner());
        if self.shared.stop.load(Ordering::SeqCst) != 0 {
            return;
        }
        let advisory = matches!(event, Event::Closed(_));
        if advisory {
            let closures = q
                .events
                .iter()
                .filter(|n| matches!(n.event, Event::Closed(_)))
                .count();
            // Reserve at least half the configured slots for Approval/Work. A
            // single-slot queue holds authoritative events only.
            if closures >= self.shared.limits.events / 2
                || q.events.len() >= self.shared.limits.events
            {
                self.shared.dropped_closure();
                return;
            }
        } else if q.events.len() >= self.shared.limits.events {
            if let Some(index) = q
                .events
                .iter()
                .position(|n| matches!(n.event, Event::Closed(_)))
            {
                q.events.remove(index);
                self.shared.dropped_closure();
            } else {
                self.shared.stop(StopReason::EventOverflow);
                return;
            }
        }
        let mut reservation = self.shared.events.reserve(2048);
        while reservation.is_err() && !advisory {
            let Some(index) = q
                .events
                .iter()
                .position(|n| matches!(n.event, Event::Closed(_)))
            else {
                break;
            };
            q.events.remove(index);
            self.shared.dropped_closure();
            reservation = self.shared.events.reserve(2048);
        }
        match reservation {
            Ok(lease) => q.events.push_back(Notification {
                event,
                created: Instant::now(),
                _lease: lease,
            }),
            Err(_) if advisory => self.shared.dropped_closure(),
            Err(_) => self.shared.stop(StopReason::EventOverflow),
        }
        self.shared.changed.notify_all();
    }
    fn current(&self, h: &Handle) -> Result<()> {
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
    fn reconcile(&mut self) {
        let stale: Vec<_> = self
            .pending
            .iter()
            .filter(|(_, p)| self.authority.pending_device(&p.ticket).is_err())
            .map(|(id, _)| *id)
            .collect();
        for id in stale {
            if let Some(c) = self.carriers.get(&id) {
                self.registry.close(&c.handle, CloseReason::HelloTimeout);
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
                let _ = self.authority.cancel(p.ticket);
            }
            self.emit(Event::Closed(c.handle));
        }
    }
    fn retire(&mut self) {
        self.shared.retired.store(true, Ordering::SeqCst);
        self.registry.retire();
        self.authority.retire();
        self.reconcile();
    }
    fn maintain(&mut self) -> Result<()> {
        let now = self.clock.now();
        self.authority.expire(now)?;
        let started = self.registry.tick(now)?;
        self.work_available(started);
        self.reconcile();
        self.shared.ticks.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    fn flush(&mut self) -> Vec<Handle> {
        let mut failed = Vec::new();
        let handles: Vec<_> = self
            .carriers
            .values()
            .filter(|c| c.handle.status() == CarrierStatus::Active)
            .map(|c| c.handle.clone())
            .collect();
        for h in handles {
            let c = &self.carriers[&h.carrier()];
            loop {
                if self.shared.stop.load(Ordering::SeqCst) != 0 {
                    break;
                }
                let result =
                    self.registry
                        .take_output_owned(&h, self.clock.now(), |bytes, lease| {
                            c.memory.deliver(bytes, lease, self.shared.limits)
                        });
                if !matches!(result, Ok(true)) {
                    if result.is_err() {
                        failed.push(h.clone());
                    }
                    break;
                }
            }
        }
        self.reconcile();
        failed
    }
    fn complete(&mut self, h: &Handle, p: Pending, approve: bool) -> Result<()> {
        let mut ticket = Some(p.ticket);
        let result = (|| {
            self.current(h)?;
            if approve {
                self.authority
                    .approve_desktop(ticket.as_ref().unwrap(), self.clock.now())?;
            }
            let session = self
                .authority
                .complete(ticket.take().unwrap(), || self.clock.now())?;
            let access = session.access();
            self.registry.establish(h, session, self.clock.now())?;
            let carrier = self.carriers.get_mut(&h.carrier()).unwrap();
            carrier.memory.bind_access(access)?;
            Ok(())
        })();
        if result.is_err() {
            if let Some(ticket) = ticket {
                let _ = self.authority.cancel(ticket);
            }
            self.registry.close(h, CloseReason::Protocol);
        }
        result
    }
    fn accept_ticket(&mut self, handle: Handle, ticket: Ticket) -> Result<()> {
        let prepared = (|| {
            self.current(&handle)?;
            let d = self.authority.pending_device(&ticket)?;
            let desktop = d.first_pairing && d.kind == DeviceKind::Desktop;
            let key = d.key.clone();
            self.serial = self.serial.checked_add(1).ok_or(Error::Configuration)?;
            if desktop {
                self.registry.wait_approval(
                    &handle,
                    self.authority.pending_deadline(&ticket)?,
                    self.clock.now(),
                )?;
            }
            Ok((desktop, key))
        })();
        let (desktop, key) = match prepared {
            Ok(value) => value,
            Err(error) => {
                let _ = self.authority.cancel(ticket);
                self.registry.close(&handle, CloseReason::Protocol);
                return Err(error);
            }
        };
        let p = Pending {
            ticket,
            serial: self.serial,
        };
        if desktop {
            self.pending.insert(handle.carrier(), p);
            self.emit(Event::Approval {
                permit: Approval {
                    handle,
                    serial: self.serial,
                },
                device_key: key,
            });
            Ok(())
        } else {
            self.complete(&handle, p, false)
        }
    }
    fn apply(&mut self, command: Command) -> Result<Reply> {
        let now = self.clock.now();
        match command {
            Command::DispatchSynthetic { token, http } => {
                let (record, started) = self.registry.dispatch_synthetic(&token, &http, now)?;
                self.work_available(started);
                return Ok(Reply::Dispatched(record));
            }
            Command::DrainWork { cursor, limit } => {
                let page = self.registry.drain_work(cursor.as_ref(), limit, now)?;
                if cursor.is_none() {
                    self.shared
                        .queues
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .work_ready = false;
                }
                return Ok(Reply::Work(page));
            }
            Command::OpenPairing => self.authority.open_pairing(now)?,
            Command::Attach { id, carrier } => {
                carrier.bind()?;
                let h = match self.registry.open_carrier(id, now) {
                    Ok(h) => h,
                    Err(e) => {
                        carrier.close();
                        return Err(e.into());
                    }
                };
                self.reconcile();
                self.carriers.insert(
                    id,
                    Carrier {
                        handle: h.clone(),
                        memory: carrier,
                    },
                );
                return Ok(Reply::Attached(h));
            }
            Command::Hello {
                handle,
                source,
                bytes,
            } => {
                self.current(&handle)?;
                if handle.status() != CarrierStatus::Pending
                    || self.pending.contains_key(&handle.carrier())
                {
                    return Err(Error::Stale);
                }
                let ticket = match self.authority.begin(source, &bytes, now, &mut OsRng) {
                    Ok(t) => t,
                    Err(e) => {
                        self.registry.close(&handle, CloseReason::Protocol);
                        return Err(e.into());
                    }
                };
                self.accept_ticket(handle, ticket)?;
            }
            Command::Approve(permit) => {
                self.current(&permit.handle)?;
                if !self
                    .pending
                    .get(&permit.handle.carrier())
                    .is_some_and(|p| p.serial == permit.serial)
                {
                    return Err(Error::Stale);
                }
                let p = self.pending.remove(&permit.handle.carrier()).unwrap();
                self.complete(&permit.handle, p, true)?;
            }
            Command::Disconnect(h) => {
                self.current(&h)?;
                self.registry.close(&h, CloseReason::Disconnected);
            }
            Command::RemoveDevice(key) => {
                // Revocation precedes filesystem IO. A failed mutation cannot leave access live.
                self.authority.remove(&mut self.registry, &key, now)?;
            }
            Command::Retire => self.retire(),
            Command::Replace(identity) => {
                self.retire();
                let authority =
                    make_authority(identity, self.shared.limits, self.shared.global.clone())?;
                let registry = Registry::new(self.shared.limits.registry, &mut OsRng)?;
                self.authority = authority;
                self.registry = registry;
                self.shared.retired.store(false, Ordering::SeqCst);
            }
            Command::Request { handle, bytes } => {
                self.current(&handle)?;
                let started = self.registry.receive_request(&handle, &bytes, now)?;
                self.work_available(started);
            }
            Command::Finish { token, response } => {
                let started = self.registry.finish_request(&token, &response, now)?;
                self.work_available(started);
            }
            Command::Send { handle, encoded } => {
                self.current(&handle)?;
                self.registry.send_encoded(&handle, &encoded, now)?;
            }
        }
        Ok(Reply::Done)
    }
    fn execute(&mut self, command: Command) -> Result<Reply> {
        let target = command.delivery_target();
        let mut result = self.apply(command);
        if self.authority.is_retired() {
            self.shared.retired.store(true, Ordering::SeqCst);
            self.registry.retire();
        }
        self.reconcile();
        let failed = self.flush();
        if result.is_ok() && target.is_some_and(|target| failed.iter().any(|h| h.same(&target))) {
            result = Err(Error::DeliveryUnknown);
        }
        if self.shared.stop.load(Ordering::SeqCst) != 0 && result.is_ok() {
            result = Err(Error::UnknownOutcome);
        }
        result
    }
    fn run(&mut self) {
        loop {
            if self.shared.stop.load(Ordering::SeqCst) != 0 {
                break;
            }
            if self.maintain().is_err() {
                self.shared.stop(StopReason::ClockFailure);
                break;
            }
            if self.shared.stop.load(Ordering::SeqCst) != 0 {
                break;
            }
            let envelope = {
                let q = self.shared.queues.lock().unwrap_or_else(|e| e.into_inner());
                let (mut q, _) = self
                    .shared
                    .wake
                    .wait_timeout_while(q, Duration::from_millis(self.shared.limits.tick_ms), |q| {
                        q.controls.is_empty()
                            && q.commands.is_empty()
                            && self.shared.stop.load(Ordering::SeqCst) == 0
                    })
                    .unwrap_or_else(|e| e.into_inner());
                if self.shared.stop.load(Ordering::SeqCst) != 0 {
                    break;
                }
                q.controls.pop_front().or_else(|| q.commands.pop_front())
            };
            if let Some(envelope) = envelope {
                // Recheck idle deadlines after sleeping and before executing any queued continuation.
                if self.maintain().is_err() {
                    envelope.reject();
                    self.shared.stop(StopReason::ClockFailure);
                    break;
                }
                if self.shared.stop.load(Ordering::SeqCst) != 0 {
                    envelope.reject();
                    break;
                }
                let result = self.execute(envelope.command);
                Envelope::publish(envelope.reply, envelope._lease, result);
                #[cfg(test)]
                if let Some(after_reply) = self.after_reply.take() {
                    after_reply();
                }
            }
        }
    }
}
impl Drop for Actor {
    fn drop(&mut self) {
        self.shared.stop(if thread::panicking() {
            StopReason::WorkerFailure
        } else {
            StopReason::Requested
        });
        self.retire();
        let mut q = self.shared.queues.lock().unwrap_or_else(|e| e.into_inner());
        for envelope in q.controls.drain(..) {
            envelope.reject();
        }
        q.control_reserve.take();
        for envelope in q.commands.drain(..) {
            envelope.reject();
        }
        q.events.clear();
        q.work_ready = false;
        self.shared.changed.notify_all();
    }
}

impl MemoryCarrier {
    /// Caller holds this exact session access guard before taking the mailbox lock.
    pub(crate) fn inspect_fixed_peer(
        &self,
        target: crate::tracked_output::TargetId,
        access: &policy::Access,
    ) -> crate::Result<()> {
        let m = self.0.lock().map_err(|_| crate::Error::Unauthorized)?;
        if m.closed
            || m.fixed_target != Some(target)
            || !m.access.as_ref().is_some_and(|a| a.same(access))
        {
            return Err(crate::Error::Unauthorized);
        }
        if !m.packets.is_empty()
            || m.bytes != 0
            || m.fixed_packet.is_some()
            || m.fixed_fence.as_ref().is_some_and(|f| f.active())
        {
            return Err(crate::Error::Budget);
        }
        Ok(())
    }
    pub(crate) fn bind_fixed(
        &self,
        access: policy::Access,
        target: crate::tracked_output::TargetId,
    ) -> crate::Result<()> {
        access.with(|| {
            let mut m = self.0.lock().map_err(|_| crate::Error::Unauthorized)?;
            if m.bound || m.closed || m.access.is_some() || !m.packets.is_empty() || m.bytes != 0 {
                return Err(crate::Error::Unauthorized);
            }
            m.bound = true;
            m.access = Some(access.clone());
            m.fixed_target = Some(target);
            Ok(())
        })
    }
    pub(crate) fn bind_service(&self, handle: &Handle, scope: Arc<()>) -> crate::Result<()> {
        let mut m = self.0.lock().map_err(|_| crate::Error::Unauthorized)?;
        if !m.bound || m.closed || m.access.is_some() || m.service_binding.is_some() {
            return Err(crate::Error::Unauthorized);
        }
        m.service_binding = Some(ServiceMailboxBinding {
            scope,
            handle: handle.clone(),
        });
        Ok(())
    }
    pub(crate) fn adopt_fixed(
        &self,
        access: policy::Access,
        target: crate::tracked_output::TargetId,
        handle: &Handle,
        scope: &Arc<()>,
    ) -> crate::Result<()> {
        access.with(|| {
            let mut m = self.0.lock().map_err(|_| crate::Error::Unauthorized)?;
            if !m.bound
                || m.closed
                || m.fixed_target.is_some()
                || !m.access.as_ref().is_some_and(|a| a.same(&access))
                || !m
                    .service_binding
                    .as_ref()
                    .is_some_and(|b| Arc::ptr_eq(&b.scope, scope) && b.handle.same(handle))
            {
                return Err(crate::Error::Unauthorized);
            }
            if !m.packets.is_empty() || m.bytes != 0 || m.fixed_packet.is_some() {
                return Err(crate::Error::Budget);
            }
            m.fixed_target = Some(target);
            Ok(())
        })
    }
    pub(crate) fn reserve_fixed(
        &self,
        fence: Arc<crate::tracked_output::Fence>,
        limits: Limits,
    ) -> crate::Result<()> {
        let mut m = self.0.lock().map_err(|_| crate::Error::Unauthorized)?;
        if m.closed || m.fixed_target != Some(fence.target) {
            return Err(crate::Error::Unauthorized);
        }
        if limits.carrier_frames == 0
            || limits.carrier_bytes < crate::tracked_output::FRAME_BYTES
            || !m.packets.is_empty()
            || m.bytes != 0
            || m.fixed_fence.as_ref().is_some_and(|f| f.active())
        {
            return Err(crate::Error::Budget);
        }
        m.fixed_fence = Some(fence);
        Ok(())
    }
    pub(crate) fn fixed_cleanup_healthy(&self) -> bool {
        !self.0.is_poisoned()
    }
}

pub(crate) fn fixed_mailbox_bookkeeping() -> usize {
    std::mem::size_of::<Mailbox>() + 2 * std::mem::size_of::<usize>()
}

impl MemoryCarrier {
    pub(crate) fn deliver_fixed(
        &self,
        fence: &crate::tracked_output::Fence,
        packet: crate::tracked_output::Packet,
    ) -> crate::Result<()> {
        let mut m = self.0.lock().map_err(|_| crate::Error::Unauthorized)?;
        if m.closed
            || m.fixed_target != Some(fence.target)
            || !fence.active()
            || !m
                .fixed_fence
                .as_ref()
                .is_some_and(|f| f.active() && f.same(fence))
            || m.fixed_packet.is_some()
            || !m.packets.is_empty()
        {
            return Err(crate::Error::Unauthorized);
        }
        if packet.wire_len() > crate::tracked_output::FRAME_BYTES {
            return Err(crate::Error::TooLarge);
        }
        m.attempts = m.attempts.saturating_add(1);
        if m.unknown_next {
            m.unknown_next = false;
            return Err(crate::Error::Unauthorized);
        }
        m.fixed_packet = Some(packet);
        Ok(())
    }
    // Caller holds the exact session access guard. Release the mailbox lock before
    // verification; a panic still drops the locally owned packet and publishes credit.
    pub(crate) fn consume_fixed(
        &self,
        fence: &crate::tracked_output::Fence,
        peer: &mut crate::channel::Channel,
        expected: &[u8],
        clock: &Clock,
        deadline: u64,
    ) -> crate::Result<()> {
        let mut m = self.0.lock().map_err(|_| crate::Error::Unauthorized)?;
        if m.closed
            || m.fixed_target != Some(fence.target)
            || !fence.active()
            || !m
                .fixed_fence
                .as_ref()
                .is_some_and(|f| f.active() && f.same(fence))
        {
            return Err(crate::Error::Unauthorized);
        }
        let mut packet = m.fixed_packet.take().ok_or(crate::Error::Unauthorized)?;
        #[cfg(test)]
        let unwind = std::mem::take(&mut m.fixed_unwind);
        drop(m);
        #[cfg(test)]
        if unwind == 1 {
            panic!("synthetic unwind before verification");
        }
        packet.verify(peer, expected, clock, deadline)?;
        #[cfg(test)]
        if unwind == 2 {
            panic!("synthetic unwind after verification");
        }
        drop(packet);
        Ok(())
    }
    #[cfg(test)]
    pub(crate) fn inject_fixed_unwind(&self, at: u8) {
        self.0.lock().unwrap().fixed_unwind = at;
    }
    #[cfg(test)]
    pub(crate) fn poison_fixed_mailbox(&self) {
        let _ = std::panic::catch_unwind(|| {
            let _guard = self.0.lock().unwrap();
            panic!("synthetic mailbox poison");
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // A test-only launch gate makes queue and cancellation order deterministic.
    // Production has no pausing API or arbitrary worker callbacks.
    fn fixture(limits: Limits) -> (Actor, OwnerClient, ManualClock, PathBuf) {
        let global = GlobalBudget::new(256 * 1024 * 1024).unwrap();
        let authority = make_authority(
            SyntheticIdentity {
                host: SecretKey::from([1; 32]),
                token: "synthetic".into(),
                desktop: DesktopAccess::Enabled,
            },
            limits,
            global.clone(),
        )
        .unwrap();
        let initial_directory = authority.temporary_directory().to_owned();
        let registry = Registry::new(limits.registry, &mut OsRng).unwrap();
        let shared = Arc::new(Shared {
            queues: Mutex::new(Queues {
                commands: VecDeque::new(),
                controls: VecDeque::new(),
                control_reserve: Some(
                    global
                        .connection(CONTROL_RESERVE_BYTES)
                        .unwrap()
                        .reserve(CONTROL_RESERVE_BYTES)
                        .unwrap(),
                ),
                events: VecDeque::new(),
                work_ready: false,
            }),
            wake: Condvar::new(),
            changed: Condvar::new(),
            stop: AtomicU8::new(0),
            finished: AtomicBool::new(false),
            retired: AtomicBool::new(false),
            ticks: AtomicU64::new(0),
            closed_dropped: AtomicU64::new(0),
            ingress: global.connection(limits.command_bytes).unwrap(),
            events: global.connection(limits.events * 2048).unwrap(),
            global,
            limits,
        });
        let client = OwnerClient(shared.clone());
        let clock = ManualClock::default();
        let actor = Actor {
            shared,
            clock: Clock::Manual(clock.clone()),
            authority,
            registry,
            carriers: BTreeMap::new(),
            pending: BTreeMap::new(),
            serial: 0,
            after_reply: None,
        };
        (actor, client, clock, initial_directory)
    }
    fn gated(limits: Limits) -> (Supervisor, OwnerClient, ManualClock, mpsc::SyncSender<()>) {
        let (actor, client, clock, initial_directory) = fixture(limits);
        let (release, gate) = mpsc::sync_channel(1);
        let done_shared = actor.shared.clone();
        let worker = thread::spawn(move || {
            let completion = Completion(done_shared);
            let mut actor = actor;
            gate.recv_timeout(Duration::from_secs(3)).unwrap();
            actor.run();
            drop(actor);
            drop(completion);
        });
        let supervisor = Supervisor {
            client: client.clone(),
            worker: Some(worker),
            initial_directory,
        };
        (supervisor, client, clock, release)
    }
    #[test]
    fn observed_receipt_releases_ingress_before_worker_continues_for_success_and_error() {
        for success in [true, false] {
            let (mut actor, client, _, initial_directory) = fixture(Limits {
                command_bytes: 1028,
                events: 1, // Advisory closures cannot add an unrelated event lease.
                ..Default::default()
            });
            let command = if success {
                Command::OpenPairing
            } else {
                let (h, _) = attach_direct(&mut actor, 1);
                actor.registry.close(&h, CloseReason::Disconnected);
                Command::Send {
                    handle: h,
                    encoded: b"null".to_vec(),
                }
            };
            let (published, observed) = mpsc::sync_channel(1);
            let (resume, paused) = mpsc::sync_channel(1);
            actor.after_reply = Some(Box::new(move || {
                published.try_send(()).unwrap();
                let _ = paused.recv_timeout(Duration::from_secs(3));
            }));
            let first = client.submit(command).unwrap();
            // Observe admitted bytes before the worker can pop this envelope.
            assert_eq!(client.0.ingress.used(), if success { 1024 } else { 1028 });
            let done_shared = actor.shared.clone();
            let worker = thread::spawn(move || {
                let _completion = Completion(done_shared);
                actor.run();
            });
            let service = Supervisor {
                client: client.clone(),
                worker: Some(worker),
                initial_directory,
            };
            let outcome = first.wait(Duration::from_secs(3));
            observed.recv_timeout(Duration::from_secs(3)).unwrap();
            // Worker is parked after publishing, before envelope scope exit.
            let ingress = client.0.ingress.used();
            let retained = client.retained_bytes();
            let second = client.submit(Command::OpenPairing);
            client.0.stop(StopReason::Requested);
            resume.try_send(()).unwrap();
            service.shutdown(); // Always join before assertions, even on regression.
            assert_eq!(outcome.is_ok(), success);
            assert_eq!(ingress, 0);
            assert_eq!(retained, CONTROL_RESERVE_BYTES);
            let second = second.expect("completed ingress must be reusable at receipt observation");
            assert!(matches!(
                second.wait(Duration::from_secs(3)),
                Err(Error::NotExecuted)
            ));
            assert_eq!(client.retained_bytes(), 0);
        }
    }
    #[test]
    fn full_command_queue_does_not_block_shutdown_or_orphan_receipts() {
        let (s, c, _, release) = gated(Limits {
            commands: 1,
            ..Default::default()
        });
        let path = s.initial_directory().to_owned();
        let carrier = MemoryCarrier::new();
        let receipt = c
            .submit(Command::Attach {
                id: 1,
                carrier: carrier.clone(),
            })
            .unwrap();
        assert!(matches!(c.submit(Command::OpenPairing), Err(Error::Full)));
        c.0.stop(StopReason::Requested);
        release.send(()).unwrap();
        s.shutdown();
        assert!(matches!(
            receipt.wait(Duration::from_secs(1)),
            Err(Error::NotExecuted)
        ));
        assert!(carrier.is_closed());
        assert!(c.is_finished());
        assert_eq!(c.retained_bytes(), 0);
        assert!(!path.exists());
    }
    #[test]
    fn timed_out_then_dropped_receipt_does_not_replay_or_leak_accepted_carrier() {
        let (s, c, clock, release) = gated(Limits::default());
        let carrier = MemoryCarrier::new();
        let receipt = c
            .submit(Command::Attach {
                id: 1,
                carrier: carrier.clone(),
            })
            .unwrap();
        assert!(matches!(
            receipt.wait(Duration::ZERO),
            Err(Error::UnknownOutcome)
        ));
        drop(receipt);
        let barrier = c.submit(Command::OpenPairing).unwrap();
        release.send(()).unwrap();
        barrier.wait(Duration::from_secs(3)).unwrap();
        assert!(!carrier.is_closed());
        assert!(carrier.0.lock().unwrap().bound);
        clock.advance_to(15000).unwrap();
        assert!(matches!(
            c.next_event(Duration::from_secs(3)),
            Some(Event::Closed(_))
        ));
        assert!(carrier.is_closed());
        drop(s);
        assert_eq!(c.retained_bytes(), 0);
    }
    #[test]
    fn aggregate_command_bytes_bound_many_small_commands_and_release_on_stop() {
        let (s, c, _, release) = gated(Limits {
            commands: 64,
            command_bytes: 2048,
            ..Default::default()
        });
        let first = c.submit(Command::OpenPairing).unwrap();
        let second = c.submit(Command::OpenPairing).unwrap();
        assert!(matches!(c.submit(Command::OpenPairing), Err(Error::Full)));
        assert_eq!(c.retained_bytes(), CONTROL_RESERVE_BYTES + 2048);
        c.0.stop(StopReason::Requested);
        release.send(()).unwrap();
        drop(s);
        for receipt in [first, second] {
            assert!(matches!(
                receipt.wait(Duration::from_secs(1)),
                Err(Error::NotExecuted)
            ));
        }
        assert_eq!(c.retained_bytes(), 0);
    }
    fn attach_direct(actor: &mut Actor, id: u64) -> (Handle, MemoryCarrier) {
        let memory = MemoryCarrier::new();
        match actor
            .execute(Command::Attach {
                id,
                carrier: memory.clone(),
            })
            .unwrap()
        {
            Reply::Attached(h) => (h, memory),
            _ => panic!(),
        }
    }
    fn synthetic_hello(seed: u8, kind: DeviceKind) -> (Vec<u8>, crate::channel::PendingHello) {
        crate::channel::phone_hello(
            &SecretKey::from([seed; 32]),
            &SecretKey::from([1; 32]).public_key(),
            "synthetic",
            crate::channel::HelloOptions {
                kind: Some(kind),
                ..Default::default()
            },
            &mut OsRng,
        )
        .unwrap()
    }
    #[test]
    fn expired_desktop_setup_cancels_ticket_and_closes_carrier_after_begin() {
        let limits = Limits {
            authority: policy::Limits {
                pending: 1,
                pending_desktops: 1,
                pairing_window_ms: 10,
                ..Default::default()
            },
            ..Default::default()
        };
        let (mut actor, c, clock, _) = fixture(limits);
        clock.advance_to(1).unwrap();
        actor.execute(Command::OpenPairing).unwrap();
        let (h, m) = attach_direct(&mut actor, 1);
        let (bytes, _) = synthetic_hello(2, DeviceKind::Desktop);
        let ticket = actor
            .authority
            .begin(Source::Relay, &bytes, 1, &mut OsRng)
            .unwrap();
        clock.advance_to(11).unwrap(); // deterministic expiry between begin and wait_approval
        assert!(actor.accept_ticket(h.clone(), ticket).is_err());
        actor.reconcile();
        assert_eq!(actor.authority.expire(11).unwrap(), 0); // cancelled already, not waiting for expiry
        assert!(actor.pending.is_empty());
        assert_eq!(actor.registry.carriers(), 0);
        assert!(m.is_closed());
        assert_eq!(h.status(), CarrierStatus::Closed(CloseReason::Protocol));
        assert_eq!(m.delivery_attempts(), 0);
        drop(actor);
        assert_eq!(c.retained_bytes(), 0);
    }
    #[test]
    fn approval_failure_before_complete_cancels_taken_ticket_and_protected_carrier() {
        let (mut actor, c, clock, _) = fixture(Limits::default());
        clock.advance_to(1).unwrap();
        actor.execute(Command::OpenPairing).unwrap();
        let (h, m) = attach_direct(&mut actor, 1);
        let (bytes, _) = synthetic_hello(2, DeviceKind::Desktop);
        actor
            .execute(Command::Hello {
                handle: h.clone(),
                source: Source::Relay,
                bytes,
            })
            .unwrap();
        let permit = match c.next_event(Duration::ZERO).unwrap() {
            Event::Approval { permit, .. } => permit,
            _ => panic!(),
        };
        clock.advance_to(2).unwrap();
        actor.authority.open_pairing(2).unwrap(); // invalidate without running reconcile yet
        assert!(actor.execute(Command::Approve(permit)).is_err());
        assert!(actor.pending.is_empty());
        assert_eq!(actor.registry.carriers(), 0);
        assert!(m.is_closed());
        assert_eq!(m.delivery_attempts(), 0);
        drop(actor);
        assert_eq!(c.retained_bytes(), 0);
    }
    #[test]
    fn unrelated_delivery_failure_does_not_change_finish_or_owner_command_result() {
        let (mut actor, c, _, _) = fixture(Limits::default());
        actor.execute(Command::OpenPairing).unwrap();
        let (a, ma) = attach_direct(&mut actor, 1);
        let (bytes, pa) = synthetic_hello(2, DeviceKind::Phone);
        actor
            .execute(Command::Hello {
                handle: a.clone(),
                source: Source::Relay,
                bytes,
            })
            .unwrap();
        let mut ca = pa.finish(&ma.receive().unwrap()).unwrap();
        let (b, mb) = attach_direct(&mut actor, 2);
        let (bytes, pb) = synthetic_hello(3, DeviceKind::Phone);
        actor
            .execute(Command::Hello {
                handle: b.clone(),
                source: Source::Relay,
                bytes,
            })
            .unwrap();
        pb.finish(&mb.receive().unwrap()).unwrap();
        let request=br#"{"t":"req","id":1,"method":"GET","path":"/rpc","headers":{},"chunk":"","more":false}"#;
        actor
            .execute(Command::Request {
                handle: a.clone(),
                bytes: ca.seal_encoded(request).unwrap(),
            })
            .unwrap();
        let token = match c.next_event(Duration::ZERO).unwrap() {
            Event::WorkAvailable => match actor
                .execute(Command::DrainWork {
                    cursor: None,
                    limit: 1,
                })
                .unwrap()
            {
                Reply::Work(mut page) => page.tokens.pop().unwrap(),
                _ => panic!(),
            },
            _ => panic!(),
        };
        actor.registry.send_encoded(&b, b"null", 0).unwrap();
        mb.inject_unknown_delivery();
        assert!(matches!(
            actor.execute(Command::Finish {
                token,
                response: b"null".to_vec()
            }),
            Ok(Reply::Done)
        ));
        assert_eq!(ca.open_encoded(&ma.receive().unwrap()).unwrap(), b"null");
        assert_eq!(
            b.status(),
            CarrierStatus::Closed(CloseReason::CarrierFailure)
        );
        actor.registry.send_encoded(&a, b"null", 0).unwrap();
        ma.inject_unknown_delivery();
        assert!(matches!(
            actor.execute(Command::OpenPairing),
            Ok(Reply::Done)
        ));
        assert_eq!(
            a.status(),
            CarrierStatus::Closed(CloseReason::CarrierFailure)
        );
        assert_eq!(c.stop_reason(), StopReason::Running);
        drop(actor);
        assert_eq!(c.retained_bytes(), 0);
    }
    #[test]
    fn sixteen_failed_approvals_leave_no_protected_registry_carriers() {
        let limits = Limits {
            authority: policy::Limits {
                records: 1,
                admission: crate::admission::Limits {
                    enrollment_crypto_units: 64,
                    ..Default::default()
                },
                ..Default::default()
            },
            ..Default::default()
        };
        let (mut actor, c, _, _) = fixture(limits);
        actor.execute(Command::OpenPairing).unwrap();
        let (phone, _) = attach_direct(&mut actor, 1);
        let (bytes, _) = synthetic_hello(2, DeviceKind::Phone);
        actor
            .execute(Command::Hello {
                handle: phone,
                source: Source::Relay,
                bytes,
            })
            .unwrap();
        for seed in 3..19 {
            let (h, m) = attach_direct(&mut actor, u64::from(seed));
            let (bytes, _) = synthetic_hello(seed, DeviceKind::Desktop);
            actor
                .execute(Command::Hello {
                    handle: h,
                    source: Source::Relay,
                    bytes,
                })
                .unwrap();
            let permit = match c.next_event(Duration::ZERO).unwrap() {
                Event::Approval { permit, .. } => permit,
                _ => panic!(),
            };
            assert!(actor.execute(Command::Approve(permit)).is_err());
            assert_eq!(actor.registry.carriers(), 1);
            assert!(actor.pending.is_empty());
            assert!(m.is_closed());
        }
        drop(actor);
        assert_eq!(c.retained_bytes(), 0);
    }
    #[test]
    fn approval_serial_exhaustion_cancels_ticket_instead_of_wrapping() {
        let (mut actor, c, _, _) = fixture(Limits::default());
        actor.execute(Command::OpenPairing).unwrap();
        let (h, m) = attach_direct(&mut actor, 1);
        let (bytes, _) = synthetic_hello(2, DeviceKind::Desktop);
        actor.serial = u64::MAX;
        assert!(matches!(
            actor.execute(Command::Hello {
                handle: h,
                source: Source::Relay,
                bytes
            }),
            Err(Error::Configuration)
        ));
        assert_eq!(actor.registry.carriers(), 0);
        assert!(m.is_closed());
        assert_eq!(actor.authority.expire(600000).unwrap(), 0);
        drop(actor);
        assert_eq!(c.retained_bytes(), 0);
    }
    #[test]
    fn flood_cannot_block_owner_revocation_or_another_carrier_hello() {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
        for remove in [false, true] {
            let (mut actor, c, clock, _) = fixture(Limits::default());
            clock.advance_to(1).unwrap();
            actor.execute(Command::OpenPairing).unwrap();
            let (h, memory) = attach_direct(&mut actor, 1);
            let (hello, _) = synthetic_hello(2, DeviceKind::Phone);
            actor
                .execute(Command::Hello {
                    handle: h.clone(),
                    source: Source::Relay,
                    bytes: hello,
                })
                .unwrap();
            let (other, _) = attach_direct(&mut actor, 2);
            let carrier = c.carrier(h.clone(), Source::Relay);
            let mut admitted = 0;
            for _ in 0..64 {
                if carrier
                    .submit(CarrierCommand::Request(vec![0; 100]))
                    .is_ok()
                {
                    admitted += 1;
                }
            }
            assert_eq!(admitted, CARRIER_COMMANDS);
            let (hello, _) = synthetic_hello(3, DeviceKind::Phone);
            assert!(c
                .carrier(other, Source::Relay)
                .submit(CarrierCommand::Hello(hello))
                .is_ok());
            // Exhaust general owner ingress too, then all remaining global bytes.
            while c.submit(Command::OpenPairing).is_ok() {}
            let remaining = 256 * 1024 * 1024 - c.retained_bytes();
            let held = actor
                .shared
                .global
                .connection(256 * 1024 * 1024)
                .unwrap()
                .reserve(remaining)
                .unwrap();
            let key = URL_SAFE_NO_PAD.encode(SecretKey::from([2; 32]).public_key().as_bytes());
            let receipt = c
                .submit(if remove {
                    Command::RemoveDevice(key)
                } else {
                    Command::Retire
                })
                .unwrap();
            let worker = thread::spawn(move || actor.run());
            receipt.wait(Duration::from_secs(3)).unwrap();
            assert!(matches!(h.status(), CarrierStatus::Closed(_)));
            assert!(memory.is_closed());
            c.0.stop(StopReason::Requested);
            worker.join().unwrap();
            drop(held);
            assert_eq!(c.retained_bytes(), 0);
        }
    }
    #[test]
    fn per_carrier_and_source_byte_count_limits_are_bounded() {
        let (mut actor, c, _, _) = fixture(Limits {
            commands: 128,
            ..Default::default()
        });
        for id in 0..5 {
            let (h, _) = attach_direct(&mut actor, id + 1);
            let carrier = c.carrier(h, Source::Relay);
            for _ in 0..8 {
                let result = carrier.submit(CarrierCommand::Request(vec![0; 1]));
                assert_eq!(result.is_ok(), id < 4);
            }
        }
        assert_eq!(c.0.queues.lock().unwrap().commands.len(), 32);
        let (direct, _) = attach_direct(&mut actor, 6);
        assert!(c
            .carrier(direct, Source::Direct(7))
            .submit(CarrierCommand::Hello(vec![0]))
            .is_ok());
        drop(actor);
        assert_eq!(c.retained_bytes(), 0);
        let (mut actor, c, _, _) = fixture(Limits::default());
        let (h, _) = attach_direct(&mut actor, 1);
        let carrier = c.carrier(h, Source::Direct(1));
        let mut bytes = Vec::with_capacity(CARRIER_BYTES / 2);
        bytes.push(0);
        assert!(carrier
            .submit(CarrierCommand::Request({
                let mut first = Vec::with_capacity(CARRIER_BYTES / 2);
                first.push(0);
                first
            }))
            .is_ok());
        assert!(matches!(
            carrier.submit(CarrierCommand::Request(bytes)),
            Err(Error::Full)
        ));
    }
    #[test]
    fn readiness_survives_refused_or_invalid_drain_and_approval_wins() {
        let (mut actor, c, _, _) = fixture(Limits::default());
        c.0.queues.lock().unwrap().work_ready = true;
        assert!(matches!(
            c.next_event(Duration::ZERO),
            Some(Event::WorkAvailable)
        ));
        for _ in 0..CONTROL_SLOTS {
            c.submit(Command::Retire).unwrap();
        }
        assert!(matches!(
            c.submit(Command::DrainWork {
                cursor: None,
                limit: 1
            }),
            Err(Error::Full)
        ));
        assert!(matches!(
            c.next_event(Duration::ZERO),
            Some(Event::WorkAvailable)
        ));
        assert!(actor
            .apply(Command::DrainWork {
                cursor: None,
                limit: 0
            })
            .is_err());
        assert!(c.0.queues.lock().unwrap().work_ready);
        let (h, _) = attach_direct(&mut actor, 1);
        actor.emit(Event::Approval {
            permit: Approval {
                handle: h,
                serial: 1,
            },
            device_key: "synthetic".into(),
        });
        assert!(matches!(
            c.next_event(Duration::ZERO),
            Some(Event::Approval { .. })
        ));
        assert!(matches!(
            c.next_event(Duration::ZERO),
            Some(Event::WorkAvailable)
        ));
        actor
            .apply(Command::DrainWork {
                cursor: None,
                limit: 1,
            })
            .unwrap();
        assert!(!c.0.queues.lock().unwrap().work_ready);
    }
    #[test]
    fn prepaid_ciphertext_moves_to_mailbox_without_a_second_budget_charge() {
        let (mut actor, c, clock, _) = fixture(Limits::default());
        clock.advance_to(1).unwrap();
        actor.execute(Command::OpenPairing).unwrap();
        let (h, memory) = attach_direct(&mut actor, 1);
        let (hello, pending) = synthetic_hello(2, DeviceKind::Phone);
        actor
            .execute(Command::Hello {
                handle: h.clone(),
                source: Source::Relay,
                bytes: hello,
            })
            .unwrap();
        let mut phone = pending.finish(&memory.receive().unwrap()).unwrap();
        let request = crate::phone::Request {
            id: 1,
            method: crate::phone::Method::GET,
            path: "/rpc".into(),
            headers: Default::default(),
            body: vec![],
        };
        let frame = crate::phone::request_parts(&request)
            .unwrap()
            .pop()
            .unwrap();
        let work = actor
            .registry
            .receive_request(&h, &phone.seal_encoded(&frame).unwrap(), 1)
            .unwrap()
            .pop()
            .unwrap();
        let http =
            crate::http_dispatch::MemoryHttp::new(crate::http_dispatch::Outcome::Timeout).unwrap();
        actor.registry.dispatch_synthetic(&work, &http, 1).unwrap();
        let held = actor
            .shared
            .global
            .connection(256 * 1024 * 1024)
            .unwrap()
            .reserve(256 * 1024 * 1024 - c.retained_bytes())
            .unwrap();
        assert!(actor.flush().is_empty());
        let bytes = phone.open_encoded(&memory.receive().unwrap()).unwrap();
        let response: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(response["status"], 504);
        assert_eq!(http.calls(), 1);
        drop(held);
        drop(actor);
        assert_eq!(c.retained_bytes(), 0);
    }
}

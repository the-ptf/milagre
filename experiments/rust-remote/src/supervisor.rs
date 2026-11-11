//! One joined synthetic worker; no sockets, imported stores, callback executors or task runtime.
use crate::{
    admission::Source,
    budget::{ConnectionBudget, GlobalBudget, Reservation},
    channel::{DesktopAccess, DeviceKind, MAX_HELLO_BYTES, MAX_PLAIN_BYTES},
    policy::{self, TemporaryAuthority, Ticket},
    registry::{self, CarrierStatus, CloseReason, Handle, Registry, WorkToken},
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
    fn now(&self) -> u64 {
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
#[derive(Default)]
struct Mailbox {
    access: Option<policy::Access>,
    bound: bool,
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
                if m.closed {
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
    fn bind(&self) -> Result<()> {
        let mut m = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if m.bound || m.closed {
            return Err(Error::Stale);
        }
        m.bound = true;
        Ok(())
    }
    fn close(&self) {
        let mut m = self.0.lock().unwrap_or_else(|e| e.into_inner());
        m.closed = true;
        m.access = None;
        m.packets.clear();
        m.bytes = 0;
    }
    fn deliver(
        &self,
        bytes: &[u8],
        budget: &ConnectionBudget,
        limits: Limits,
    ) -> crate::Result<()> {
        let mut m = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if m.closed {
            return Err(crate::Error::Unauthorized);
        }
        if m.packets.len() >= limits.carrier_frames
            || bytes.len() > limits.carrier_bytes.saturating_sub(m.bytes)
        {
            return Err(crate::Error::Budget);
        }
        let lease = budget.reserve(bytes.len() + 256)?;
        m.attempts = m.attempts.saturating_add(1);
        if m.unknown_next {
            m.unknown_next = false;
            return Err(crate::Error::Unauthorized);
        }
        m.bytes += bytes.len();
        m.packets.push_back(Packet {
            bytes: bytes.to_vec(),
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
    Work(WorkToken),
    Closed(Handle),
}
pub enum Command {
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
            Self::Hello { handle, .. } | Self::Send { handle, .. } => Some(handle.clone()),
            Self::Approve(permit) => Some(permit.handle.clone()),
            Self::Finish { token, .. } => Some(token.handle().clone()),
            _ => None,
        }
    }
    fn cost(&self) -> Option<usize> {
        let payload = match self {
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
    Done,
    Attached(Handle),
}
/// Drop does not cancel an accepted mutation. Retain this receipt to observe its result.
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
struct Envelope {
    command: Command,
    reply: mpsc::SyncSender<Result<Reply>>,
    _lease: Reservation,
}
impl Envelope {
    fn reject(self) {
        if let Command::Attach { carrier, .. } = &self.command {
            carrier.close();
        }
        let _ = self.reply.try_send(Err(Error::NotExecuted));
    }
}
struct Notification {
    event: Event,
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
    events: VecDeque<Notification>,
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
}
#[derive(Clone)]
pub struct Client(Arc<Shared>);
impl Client {
    pub fn submit(&self, command: Command) -> Result<Receipt> {
        let cost = command.cost().ok_or(Error::Full)?;
        let mut q = self.0.queues.lock().unwrap_or_else(|e| e.into_inner());
        if self.0.stop.load(Ordering::SeqCst) != 0 {
            return Err(Error::NotExecuted);
        }
        if q.commands.len() >= self.0.limits.commands {
            return Err(Error::Full);
        }
        let lease = self.0.ingress.reserve(cost).map_err(|_| Error::Full)?;
        let (tx, rx) = mpsc::sync_channel(1);
        q.commands.push_back(Envelope {
            command,
            reply: tx,
            _lease: lease,
        });
        self.0.wake.notify_one();
        Ok(Receipt(rx))
    }
    pub fn next_event(&self, timeout: Duration) -> Option<Event> {
        let q = self.0.queues.lock().unwrap_or_else(|e| e.into_inner());
        let (mut q, _) = self
            .0
            .changed
            .wait_timeout_while(q, timeout, |q| {
                q.events.is_empty() && !self.0.finished.load(Ordering::SeqCst)
            })
            .unwrap_or_else(|e| e.into_inner());
        // Authoritative FIFO has priority over lossy closure diagnostics.
        let index = q
            .events
            .iter()
            .position(|n| !matches!(n.event, Event::Closed(_)))
            .unwrap_or(0);
        q.events.remove(index).map(|n| n.event)
    }
    pub fn event_stats(&self) -> EventStats {
        let q = self.0.queues.lock().unwrap_or_else(|e| e.into_inner());
        let advisory = q
            .events
            .iter()
            .filter(|n| matches!(n.event, Event::Closed(_)))
            .count();
        EventStats {
            authoritative: q.events.len() - advisory,
            advisory,
            closed_dropped: self.0.closed_dropped.load(Ordering::SeqCst),
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
    client: Client,
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
                events: VecDeque::new(),
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
        let client = Client(shared.clone());
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
    pub fn client(&self) -> Client {
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
    budget: Option<ConnectionBudget>,
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
}
impl Actor {
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
        for token in self.registry.tick(now)? {
            self.emit(Event::Work(token));
        }
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
            let budget = c.budget.as_ref().unwrap();
            loop {
                if self.shared.stop.load(Ordering::SeqCst) != 0 {
                    break;
                }
                let result = self.registry.take_output(&h, self.clock.now(), |bytes| {
                    c.memory.deliver(bytes, budget, self.shared.limits)
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
            let budget = session.budget();
            let access = session.access();
            self.registry.establish(h, session, self.clock.now())?;
            let carrier = self.carriers.get_mut(&h.carrier()).unwrap();
            carrier
                .memory
                .0
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .access = Some(access);
            carrier.budget = Some(budget);
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
                        budget: None,
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
                for token in self.registry.receive_request(&handle, &bytes, now)? {
                    self.emit(Event::Work(token));
                }
            }
            Command::Finish { token, response } => {
                for next in self.registry.finish_request(&token, &response, now)? {
                    self.emit(Event::Work(next));
                }
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
                        q.commands.is_empty() && self.shared.stop.load(Ordering::SeqCst) == 0
                    })
                    .unwrap_or_else(|e| e.into_inner());
                if self.shared.stop.load(Ordering::SeqCst) != 0 {
                    break;
                }
                q.commands.pop_front()
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
                let _ = envelope.reply.try_send(result);
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
        for envelope in q.commands.drain(..) {
            envelope.reject();
        }
        q.events.clear();
        self.shared.changed.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // A test-only launch gate makes queue and cancellation order deterministic.
    // Production has no pausing API or arbitrary worker callbacks.
    fn fixture(limits: Limits) -> (Actor, Client, ManualClock, PathBuf) {
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
                events: VecDeque::new(),
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
        let client = Client(shared.clone());
        let clock = ManualClock::default();
        let actor = Actor {
            shared,
            clock: Clock::Manual(clock.clone()),
            authority,
            registry,
            carriers: BTreeMap::new(),
            pending: BTreeMap::new(),
            serial: 0,
        };
        (actor, client, clock, initial_directory)
    }
    fn gated(limits: Limits) -> (Supervisor, Client, ManualClock, mpsc::SyncSender<()>) {
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
        assert_eq!(c.retained_bytes(), 2048);
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
            Event::Work(token) => token,
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
}

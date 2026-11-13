//! Private, synthetic claim state machine. No Registry authority, executor, HTTP or frames.
//! Fixed tables and a serialized Begin barrier model the future service boundary.
use crate::budget::{ConnectionBudget, DeviceBudget, GlobalBudget, Reservation};
use std::sync::{Arc, Mutex, MutexGuard, Weak};

const STATUS_SLOTS: usize = 512;
const DEVICE_SLOTS: usize = 16;
const PER_DEVICE: usize = 32;
const QUEUE: usize = 16;
const BLOCK: usize = 64 * 1024;
const BLOCKS: usize = 1024;
const STATUS_BYTES: usize = 512;
const OUTPUT_BYTES: usize = 2 * 1024 * 1024;
const SCRATCH_BYTES: usize = 2 * 1024 * 1024;
const CONNECTION_BYTES: usize = 128 * 1024 * 1024;
const SCHEDULE_MS: u64 = 20_000;
const HTTP_MS: u64 = 340_000;
const COMPLETION_MS: u64 = 345_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Fault {
    Full,
    Budget,
    Stopped,
    Stale,
    Expired,
    Overflow,
    Time,
    State,
    TooLarge,
}
type Result<T> = std::result::Result<T, Fault>;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Evidence {
    NotStarted,
    MayHaveRun,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Delivery {
    None,
    MaySend,
    Complete,
    Unknown,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Terminal {
    NotClaimed(Fault),
    Cancelled,
    TimedOut,
    Completed,
    DeliveryUnknown,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Phase {
    Prepared,
    Submitted,
    Claimed,
    Dispatching,
    ResponseReady(u16),
    Terminal(Terminal),
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Observation {
    pub phase: Phase,
    pub execution: Evidence,
    pub delivery: Delivery,
    pub status: Option<u16>,
}
struct Scope {
    _lease: Reservation,
}
#[derive(Clone)]
pub(crate) struct Id {
    scope: Arc<Scope>,
    serial: u64,
}
#[derive(Clone)]
pub(crate) struct Carrier {
    scope: Arc<Scope>,
    device: u64,
    generation: u64,
}
#[derive(Clone)]
pub(crate) struct WorkToken {
    scope: Arc<Scope>,
    serial: u64,
}
struct Device {
    key: u64,
    generation: u64,
    active: bool,
    budget: DeviceBudget,
    connection: ConnectionBudget,
}
struct Work {
    serial: u64,
    device: u64,
    generation: u64,
    deadline: u64,
    claim: Option<u64>,
}
/// Every allocation has a fixed object size. No Vec reserve/growth or body copy.
/// Allocator/process abort is outside the typed failure contract.
struct Body {
    blocks: [Option<Box<[u8; BLOCK]>>; BLOCKS],
    limit: usize,
    len: usize,
}
impl Body {
    fn new(blocks: usize) -> Self {
        Self {
            blocks: std::array::from_fn(|i| (i < blocks).then(|| Box::new([0; BLOCK]))),
            limit: blocks * BLOCK,
            len: 0,
        }
    }
    fn append(&mut self, bytes: &[u8]) -> Result<()> {
        if bytes.len() > self.limit - self.len {
            return Err(Fault::TooLarge);
        }
        for part in bytes.chunks(BLOCK) {
            let mut rest = part;
            while !rest.is_empty() {
                let index = self.len / BLOCK;
                let offset = self.len % BLOCK;
                let n = rest.len().min(BLOCK - offset);
                self.blocks[index].as_mut().unwrap()[offset..offset + n]
                    .copy_from_slice(&rest[..n]);
                self.len += n;
                rest = &rest[n..];
            }
        }
        Ok(())
    }
}
struct Resources {
    body: Body,
    http_deadline: u64,
    completion_deadline: u64,
    cancel_requested: bool,
    executor_done: bool,
    output_done: bool,
    _lease: Reservation,
}
struct Slot {
    serial: u64,
    work: u64,
    device: u64,
    observation: Observation,
    acknowledged: bool,
    resources: Option<Box<Resources>>,
    _lease: Reservation,
}
struct Core {
    scope: Arc<Scope>,
    global: GlobalBudget,
    devices: [Option<Device>; DEVICE_SLOTS],
    works: [Option<Work>; STATUS_SLOTS],
    slots: [Option<Slot>; STATUS_SLOTS],
    queue: [Option<u64>; QUEUE],
    head: usize,
    queued: usize,
    next: u64,
    now: u64,
    stopped: bool,
    invocations: usize,
    body_blocks: usize,
    _lease: Reservation,
}
pub(crate) struct Machine(Arc<Mutex<Core>>);
/// Only an unsubmitted attempt may be returned on Full or cancelled by Drop.
pub(crate) struct Attempt {
    core: Weak<Mutex<Core>>,
    id: Id,
    owned: bool,
}
pub(crate) struct Rejection {
    pub fault: Fault,
    pub attempt: Option<Attempt>,
}
/// Observation only. Drop has no effect on the accepted operation.
pub(crate) struct Receipt(pub Id);
impl Attempt {
    pub fn id(&self) -> Id {
        self.id.clone()
    }
}
impl Drop for Attempt {
    fn drop(&mut self) {
        if self.owned {
            if let Some(core) = self.core.upgrade() {
                let mut c = core.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(i) = c.slot_index(self.id.serial) {
                    // The only owner of a Prepared slot is this consuming attempt.
                    c.slots[i].as_mut().unwrap().acknowledged = true;
                    c.reap(i);
                }
            }
        }
    }
}
impl Core {
    fn serial(&mut self) -> Result<u64> {
        self.next = self.next.checked_add(1).ok_or(Fault::Overflow)?;
        Ok(self.next)
    }
    fn clock(&mut self, now: u64) -> Result<()> {
        if now < self.now {
            return Err(Fault::Time);
        }
        self.now = now;
        Ok(())
    }
    fn slot_index(&self, id: u64) -> Option<usize> {
        self.slots
            .iter()
            .position(|s| s.as_ref().is_some_and(|s| s.serial == id))
    }
    fn work_index(&self, id: u64) -> Option<usize> {
        self.works
            .iter()
            .position(|w| w.as_ref().is_some_and(|w| w.serial == id))
    }
    fn device_index(&self, key: u64) -> Option<usize> {
        self.devices
            .iter()
            .position(|d| d.as_ref().is_some_and(|d| d.key == key))
    }
    fn current(&self, work: &Work) -> bool {
        !self.stopped
            && self.device_index(work.device).is_some_and(|i| {
                let d = self.devices[i].as_ref().unwrap();
                d.active && d.generation == work.generation
            })
    }
    fn work_valid(&self, id: u64) -> Result<usize> {
        let i = self.work_index(id).ok_or(Fault::Stale)?;
        let work = self.works[i].as_ref().unwrap();
        if !self.current(work) {
            return Err(Fault::Stale);
        }
        if work.claim.is_some() {
            return Err(Fault::State);
        }
        if self.now >= work.deadline {
            return Err(Fault::Expired);
        }
        Ok(i)
    }
    fn terminate(&mut self, i: usize, terminal: Terminal) {
        let s = self.slots[i].as_mut().unwrap();
        if !matches!(s.observation.phase, Phase::Terminal(_)) {
            s.observation.phase = Phase::Terminal(terminal);
            if s.observation.delivery == Delivery::MaySend {
                s.observation.delivery = Delivery::Unknown;
            }
        }
        if let Some(r) = &mut s.resources {
            r.cancel_requested = true;
        }
    }
    fn reap(&mut self, i: usize) {
        let s = self.slots[i].as_mut().unwrap();
        let device = s.device;
        let work = s.work;
        let serial = s.serial;
        let cleaned = s
            .resources
            .as_ref()
            .is_some_and(|r| r.executor_done && r.output_done);
        if cleaned {
            s.resources = None;
        }
        if s.acknowledged && s.resources.is_none() {
            self.slots[i] = None;
        }
        if cleaned {
            if let Some(w) = self.work_index(work) {
                if self.works[w].as_ref().unwrap().claim == Some(serial) {
                    self.works[w] = None;
                }
            }
        }
        if let Some(d) = self.device_index(device) {
            if !self.devices[d].as_ref().unwrap().active
                && !self.slots.iter().flatten().any(|s| s.device == device)
            {
                self.devices[d] = None;
            }
        }
    }
    fn invalidate(&mut self, device: u64) {
        for i in 0..STATUS_SLOTS {
            if self.slots[i].as_ref().is_some_and(|s| s.device == device) {
                self.terminate(i, Terminal::Cancelled);
            }
            if self.works[i].as_ref().is_some_and(|w| w.device == device) {
                self.works[i] = None;
            }
        }
    }
}
impl Machine {
    pub fn new(global: GlobalBudget) -> Result<Self> {
        Self::with_blocks(global, BLOCKS)
    }
    fn with_blocks(global: GlobalBudget, body_blocks: usize) -> Result<Self> {
        let budget = global.connection(1024 * 1024).map_err(|_| Fault::Budget)?;
        // Fixed tables are paid for before allocating Scope or Core.
        let mut lease = budget
            .reserve(std::mem::size_of::<Core>() + DEVICE_SLOTS * 512 + 1024)
            .map_err(|_| Fault::Budget)?;
        let scope = Arc::new(Scope {
            _lease: lease.split(256).map_err(|_| Fault::Budget)?,
        });
        Ok(Self(Arc::new(Mutex::new(Core {
            scope,
            global,
            devices: std::array::from_fn(|_| None),
            works: std::array::from_fn(|_| None),
            slots: std::array::from_fn(|_| None),
            queue: [None; QUEUE],
            head: 0,
            queued: 0,
            next: 0,
            now: 0,
            stopped: false,
            invocations: 0,
            body_blocks,
            _lease: lease,
        }))))
    }
    fn core(&self) -> Result<MutexGuard<'_, Core>> {
        self.0.lock().map_err(|_| Fault::Stopped)
    }
    fn scope(c: &Core, scope: &Arc<Scope>) -> Result<()> {
        if Arc::ptr_eq(&c.scope, scope) {
            Ok(())
        } else {
            Err(Fault::Stale)
        }
    }
    /// Fixture-only connection creation, not an authorization decision.
    pub fn connect(&self, device: u64) -> Result<Carrier> {
        let mut c = self.core()?;
        if c.stopped {
            return Err(Fault::Stopped);
        }
        let i = c
            .device_index(device)
            .or_else(|| c.devices.iter().position(Option::is_none))
            .ok_or(Fault::Full)?;
        let generation = c.serial()?;
        c.invalidate(device);
        let budget = match &c.devices[i] {
            Some(d) => d.budget.clone(),
            None => c
                .global
                .device(CONNECTION_BYTES)
                .map_err(|_| Fault::Budget)?,
        };
        let connection = budget
            .connection(CONNECTION_BYTES)
            .map_err(|_| Fault::Budget)?;
        c.devices[i] = Some(Device {
            key: device,
            generation,
            active: true,
            budget,
            connection,
        });
        Ok(Carrier {
            scope: c.scope.clone(),
            device,
            generation,
        })
    }
    pub fn remove(&self, device: u64) -> Result<()> {
        let mut c = self.core()?;
        if let Some(i) = c.device_index(device) {
            c.devices[i].as_mut().unwrap().active = false;
            c.invalidate(device);
            // Keep the device budget while old resource/status leases exist.
            if !c.slots.iter().flatten().any(|s| s.device == device) {
                c.devices[i] = None;
            }
        }
        Ok(())
    }
    pub fn admit(&self, carrier: &Carrier, now: u64) -> Result<WorkToken> {
        let mut c = self.core()?;
        Self::scope(&c, &carrier.scope)?;
        c.clock(now)?;
        if c.stopped {
            return Err(Fault::Stopped);
        }
        let d = c.device_index(carrier.device).ok_or(Fault::Stale)?;
        let device = c.devices[d].as_ref().unwrap();
        if !device.active || device.generation != carrier.generation {
            return Err(Fault::Stale);
        }
        let deadline = now.checked_add(SCHEDULE_MS).ok_or(Fault::Overflow)?;
        let i = c
            .works
            .iter()
            .position(Option::is_none)
            .ok_or(Fault::Full)?;
        let serial = c.serial()?;
        c.works[i] = Some(Work {
            serial,
            device: carrier.device,
            generation: carrier.generation,
            deadline,
            claim: None,
        });
        Ok(WorkToken {
            scope: c.scope.clone(),
            serial,
        })
    }
    pub fn prepare_claim(&self, work: &WorkToken) -> Result<Attempt> {
        let mut c = self.core()?;
        Self::scope(&c, &work.scope)?;
        if c.stopped {
            return Err(Fault::Stopped);
        }
        let w = c.work_valid(work.serial)?;
        let device = c.works[w].as_ref().unwrap().device;
        if c.slots
            .iter()
            .flatten()
            .filter(|s| s.device == device)
            .count()
            >= PER_DEVICE
        {
            return Err(Fault::Full);
        }
        let i = c
            .slots
            .iter()
            .position(Option::is_none)
            .ok_or(Fault::Full)?;
        let d = c.device_index(device).unwrap();
        let lease = c.devices[d]
            .as_ref()
            .unwrap()
            .connection
            .reserve(STATUS_BYTES)
            .map_err(|_| Fault::Budget)?;
        let serial = c.serial()?;
        c.slots[i] = Some(Slot {
            serial,
            work: work.serial,
            device,
            observation: Observation {
                phase: Phase::Prepared,
                execution: Evidence::NotStarted,
                delivery: Delivery::None,
                status: None,
            },
            acknowledged: false,
            resources: None,
            _lease: lease,
        });
        Ok(Attempt {
            core: Arc::downgrade(&self.0),
            id: Id {
                scope: c.scope.clone(),
                serial,
            },
            owned: true,
        })
    }
    pub fn submit_claim(&self, mut attempt: Attempt) -> std::result::Result<Receipt, Rejection> {
        let mut c = match self.core() {
            Ok(c) => c,
            Err(fault) => {
                return Err(Rejection {
                    fault,
                    attempt: None,
                })
            }
        };
        let check = Self::scope(&c, &attempt.id.scope).and_then(|_| {
            if c.stopped {
                return Err(Fault::Stopped);
            }
            let i = c.slot_index(attempt.id.serial).ok_or(Fault::Stale)?;
            let s = c.slots[i].as_ref().unwrap();
            if s.observation.phase != Phase::Prepared {
                return Err(Fault::Stale);
            }
            c.work_valid(s.work)?;
            Ok(i)
        });
        let i = match check {
            Ok(i) => i,
            Err(fault) => {
                drop(c);
                return Err(Rejection {
                    fault,
                    attempt: None,
                });
            }
        };
        if c.queued == QUEUE {
            drop(c);
            return Err(Rejection {
                fault: Fault::Full,
                attempt: Some(attempt),
            });
        }
        let tail = (c.head + c.queued) % QUEUE;
        c.queue[tail] = Some(attempt.id.serial);
        c.queued += 1;
        c.slots[i].as_mut().unwrap().observation.phase = Phase::Submitted;
        attempt.owned = false;
        Ok(Receipt(attempt.id.clone()))
    }
    pub fn required_bytes(&self) -> Result<usize> {
        let c = self.core()?;
        // Fixed block/pointer overhead plus prepaid model scratch/output/completion.
        c.body_blocks
            .checked_mul(BLOCK + 64)
            .and_then(|n| {
                n.checked_add(
                    std::mem::size_of::<Resources>() + OUTPUT_BYTES + SCRATCH_BYTES + 4096,
                )
            })
            .ok_or(Fault::Overflow)
    }
    /// Serialized fixture worker step. No adapter is invoked by claiming.
    pub fn process_next(&self, now: u64) -> Result<Option<Id>> {
        let required = self.required_bytes()?;
        let mut c = self.core()?;
        c.clock(now)?;
        // Cancelled/acknowledged entries cannot hide eligible work behind them.
        let (serial, i) = loop {
            if c.queued == 0 {
                return Ok(None);
            }
            let head = c.head;
            let serial = c.queue[head].take().unwrap();
            c.head = (head + 1) % QUEUE;
            c.queued -= 1;
            if let Some(i) = c.slot_index(serial) {
                if c.slots[i].as_ref().unwrap().observation.phase == Phase::Submitted {
                    break (serial, i);
                }
            }
        };
        let id = Id {
            scope: c.scope.clone(),
            serial,
        };
        let work = c.slots[i].as_ref().unwrap().work;
        let claim = (|| {
            if c.stopped {
                return Err(Fault::Stopped);
            }
            let w = c.work_valid(work)?;
            let http_deadline = now.checked_add(HTTP_MS).ok_or(Fault::Overflow)?;
            let completion_deadline = now.checked_add(COMPLETION_MS).ok_or(Fault::Overflow)?;
            let device = c.works[w].as_ref().unwrap().device;
            if c.slots
                .iter()
                .flatten()
                .filter(|s| s.resources.is_some())
                .count()
                >= 2
                || c.slots
                    .iter()
                    .flatten()
                    .any(|s| s.device == device && s.resources.is_some())
            {
                return Err(Fault::Full);
            }
            let d = c.device_index(device).unwrap();
            let lease = c.devices[d]
                .as_ref()
                .unwrap()
                .connection
                .reserve(required)
                .map_err(|_| Fault::Budget)?;
            let resources = Box::new(Resources {
                body: Body::new(c.body_blocks),
                http_deadline,
                completion_deadline,
                cancel_requested: false,
                executor_done: false,
                output_done: false,
                _lease: lease,
            });
            c.works[w].as_mut().unwrap().claim = Some(serial);
            let slot = c.slots[i].as_mut().unwrap();
            slot.resources = Some(resources);
            slot.observation.phase = Phase::Claimed;
            Ok(())
        })();
        if let Err(fault) = claim {
            c.terminate(i, Terminal::NotClaimed(fault));
        }
        Ok(Some(id))
    }
    fn index(c: &Core, id: &Id) -> Result<usize> {
        Self::scope(c, &id.scope)?;
        c.slot_index(id.serial).ok_or(Fault::Stale)
    }
    pub fn observe(&self, id: &Id) -> Option<Observation> {
        let c = self.core().ok()?;
        let i = Self::index(&c, id).ok()?;
        let s = c.slots[i].as_ref()?;
        (!s.acknowledged).then_some(s.observation)
    }
    /// Cancellation and Begin share this mutex: no check-then-invoke gap in the model.
    pub fn begin(&self, id: &Id, now: u64) -> Result<()> {
        let mut c = self.core()?;
        c.clock(now)?;
        let i = Self::index(&c, id)?;
        let s = c.slots[i].as_ref().unwrap();
        if s.observation.phase != Phase::Claimed {
            return Err(Fault::State);
        }
        if now >= s.resources.as_ref().unwrap().http_deadline {
            c.terminate(i, Terminal::TimedOut);
            return Err(Fault::Expired);
        }
        let w = c.work_index(s.work).ok_or(Fault::Stale)?;
        if !c.current(c.works[w].as_ref().unwrap()) {
            return Err(Fault::Stale);
        }
        c.invocations = c.invocations.checked_add(1).ok_or(Fault::Overflow)?;
        let s = c.slots[i].as_mut().unwrap();
        s.observation.execution = Evidence::MayHaveRun;
        s.observation.phase = Phase::Dispatching;
        Ok(())
    }
    pub fn cancel(&self, id: &Id) -> Result<()> {
        let mut c = self.core()?;
        let i = Self::index(&c, id)?;
        c.terminate(i, Terminal::Cancelled);
        Ok(())
    }
    pub fn append(&self, id: &Id, bytes: &[u8], now: u64) -> Result<()> {
        self.tick(now)?;
        let mut c = self.core()?;
        let i = Self::index(&c, id)?;
        let s = c.slots[i].as_mut().unwrap();
        if s.observation.phase != Phase::Dispatching {
            return Err(Fault::State);
        }
        if s.resources.as_mut().unwrap().body.append(bytes).is_err() {
            s.observation.phase = Phase::ResponseReady(502);
            s.observation.status = Some(502);
            s.resources.as_mut().unwrap().cancel_requested = true;
            return Err(Fault::TooLarge);
        }
        Ok(())
    }
    pub fn complete(&self, id: &Id, now: u64) -> Result<()> {
        self.tick(now)?;
        let mut c = self.core()?;
        let i = Self::index(&c, id)?;
        let s = c.slots[i].as_mut().unwrap();
        if s.observation.phase != Phase::Dispatching {
            return Err(Fault::State);
        }
        s.observation.phase = Phase::ResponseReady(200);
        s.observation.status = Some(200);
        Ok(())
    }
    pub fn may_send(&self, id: &Id, now: u64) -> Result<()> {
        self.tick(now)?;
        let mut c = self.core()?;
        let i = Self::index(&c, id)?;
        let slot = c.slots[i].as_ref().unwrap();
        if !matches!(slot.observation.phase, Phase::ResponseReady(_))
            || slot.observation.delivery != Delivery::None
        {
            return Err(Fault::State);
        }
        let w = c.work_index(slot.work).ok_or(Fault::Stale)?;
        if !c.current(c.works[w].as_ref().unwrap()) {
            return Err(Fault::Stale);
        }
        c.slots[i].as_mut().unwrap().observation.delivery = Delivery::MaySend;
        Ok(())
    }
    pub fn deliver(&self, id: &Id, known: bool, now: u64) -> Result<()> {
        self.tick(now)?;
        let mut c = self.core()?;
        let i = Self::index(&c, id)?;
        let s = c.slots[i].as_mut().unwrap();
        if !matches!(s.observation.phase, Phase::ResponseReady(_))
            || s.observation.delivery != Delivery::MaySend
        {
            return Err(Fault::State);
        }
        if !known {
            s.resources.as_mut().unwrap().cancel_requested = true;
        }
        s.observation.delivery = if known {
            Delivery::Complete
        } else {
            Delivery::Unknown
        };
        s.observation.phase = Phase::Terminal(if known {
            Terminal::Completed
        } else {
            Terminal::DeliveryUnknown
        });
        Ok(())
    }
    /// Internal executor signal remains visible after status acknowledgment.
    pub fn cancellation_requested(&self, id: &Id) -> Result<bool> {
        let c = self.core()?;
        let i = Self::index(&c, id)?;
        Ok(c.slots[i]
            .as_ref()
            .unwrap()
            .resources
            .as_ref()
            .is_none_or(|r| r.cancel_requested))
    }
    pub fn ack_terminal(&self, id: &Id) -> Result<()> {
        let mut c = self.core()?;
        let i = Self::index(&c, id)?;
        if !matches!(
            c.slots[i].as_ref().unwrap().observation.phase,
            Phase::Terminal(_)
        ) {
            return Err(Fault::State);
        }
        c.slots[i].as_mut().unwrap().acknowledged = true;
        c.reap(i);
        Ok(())
    }
    /// Fixture cleanup acknowledgment, NOT a real thread join or carrier receipt.
    pub fn cleanup(&self, id: &Id, executor_done: bool, output_done: bool) -> Result<()> {
        let mut c = self.core()?;
        let i = Self::index(&c, id)?;
        let s = c.slots[i].as_mut().unwrap();
        if !matches!(s.observation.phase, Phase::Terminal(_)) {
            return Err(Fault::State);
        }
        if let Some(r) = &mut s.resources {
            r.executor_done |= executor_done;
            r.output_done |= output_done;
        }
        c.reap(i);
        Ok(())
    }
    pub fn tick(&self, now: u64) -> Result<()> {
        let mut c = self.core()?;
        c.clock(now)?;
        for i in 0..STATUS_SLOTS {
            let scheduling_expired = c.slots[i].as_ref().is_some_and(|s| {
                c.works
                    .iter()
                    .flatten()
                    .any(|w| w.serial == s.work && now >= w.deadline)
            });
            if let Some(s) = c.slots[i].as_mut() {
                if let Some(r) = &mut s.resources {
                    if now >= r.completion_deadline {
                        if !matches!(s.observation.phase, Phase::Terminal(_)) {
                            s.observation.phase = Phase::Terminal(Terminal::TimedOut);
                            if s.observation.delivery == Delivery::MaySend {
                                s.observation.delivery = Delivery::Unknown;
                            }
                            r.cancel_requested = true;
                        }
                    } else if now >= r.http_deadline
                        && matches!(s.observation.phase, Phase::Claimed | Phase::Dispatching)
                    {
                        s.observation.phase = Phase::ResponseReady(504);
                        s.observation.status = Some(504);
                        r.cancel_requested = true;
                    }
                } else if !matches!(s.observation.phase, Phase::Terminal(_)) && scheduling_expired {
                    s.observation.phase = Phase::Terminal(Terminal::NotClaimed(Fault::Expired));
                }
            }
        }
        for work in &mut c.works {
            if work
                .as_ref()
                .is_some_and(|w| w.claim.is_none() && now >= w.deadline)
            {
                *work = None;
            }
        }
        Ok(())
    }
    pub fn stop(&self) -> Result<()> {
        let mut c = self.core()?;
        c.stopped = true;
        for i in 0..STATUS_SLOTS {
            if c.slots[i].is_some() {
                c.terminate(i, Terminal::Cancelled);
            }
            c.works[i] = None;
        }
        Ok(())
    }
    /// Discards observation/queue state only after every modeled executor/output cleanup.
    /// This is not a persistent Clean receipt or evidence of a real joined worker.
    pub fn finish_stop(&self) -> Result<()> {
        let mut c = self.core()?;
        if !c.stopped || c.slots.iter().flatten().any(|s| s.resources.is_some()) {
            return Err(Fault::State);
        }
        c.queue = [None; QUEUE];
        c.queued = 0;
        c.head = 0;
        for i in 0..STATUS_SLOTS {
            c.slots[i] = None;
            c.works[i] = None;
        }
        for d in &mut c.devices {
            *d = None;
        }
        Ok(())
    }
    pub fn quiescent(&self) -> Result<bool> {
        let c = self.core()?;
        Ok(c.stopped && c.queued == 0 && c.slots.iter().all(Option::is_none))
    }
}

#[cfg(test)]
mod tests;

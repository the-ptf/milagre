//! Service-owned, in-memory carrier registry. No listener, persistence or restart.
//! Handles carry no channel or payload ownership; all late operations recheck generation.
use crate::{
    budget::{ConnectionBudget, Reservation},
    channel::MAX_PLAIN_BYTES,
    envelope::MAX_PAYLOAD,
    peer::{Direction, FrameReader, FrameWriter},
    phone::{AssemblyLimits, LeasedRequest, Request, RequestAssembler},
    policy::Session,
    raw_json, Error,
};
use rand_core::{CryptoRng, RngCore};
use serde::Deserialize;
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{
        atomic::{AtomicU8, Ordering},
        Arc,
    },
};
#[derive(Debug, thiserror::Error)]
pub enum RegistryError {
    #[error("carrier was revoked, replaced, or is not established")]
    Revoked,
    #[error("clock moved backwards")]
    Time,
    #[error(transparent)]
    Protocol(#[from] Error),
}
pub type Result<T> = std::result::Result<T, RegistryError>;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum CloseReason {
    Disconnected = 2,
    Replaced,
    Removed,
    Retired,
    HelloTimeout,
    IdleTimeout,
    FragmentTimeout,
    Protocol,
    Limit,
    CarrierFailure,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CarrierStatus {
    Pending,
    Active,
    Closed(CloseReason),
}
#[derive(Clone)]
pub struct Handle {
    owner: [u8; 16],
    carrier: u64,
    generation: u64,
    state: Arc<AtomicU8>,
}
impl Handle {
    pub(crate) fn same(&self, other: &Self) -> bool {
        self.owner == other.owner
            && self.carrier == other.carrier
            && self.generation == other.generation
    }
    pub(crate) fn carrier(&self) -> u64 {
        self.carrier
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }
    pub fn status(&self) -> CarrierStatus {
        match self.state.load(Ordering::SeqCst) {
            0 => CarrierStatus::Pending,
            1 => CarrierStatus::Active,
            2 => CarrierStatus::Closed(CloseReason::Disconnected),
            3 => CarrierStatus::Closed(CloseReason::Replaced),
            4 => CarrierStatus::Closed(CloseReason::Removed),
            5 => CarrierStatus::Closed(CloseReason::Retired),
            6 => CarrierStatus::Closed(CloseReason::HelloTimeout),
            7 => CarrierStatus::Closed(CloseReason::IdleTimeout),
            8 => CarrierStatus::Closed(CloseReason::FragmentTimeout),
            9 => CarrierStatus::Closed(CloseReason::Protocol),
            10 => CarrierStatus::Closed(CloseReason::Limit),
            _ => CarrierStatus::Closed(CloseReason::CarrierFailure),
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum WorkStatus {
    Queued,
    InFlight,
    Completed,
    Cancelled,
    TimedOut,
}
/// Cancellation/continuation token only. It contains no request bytes or memory lease.
#[derive(Clone)]
pub struct WorkToken {
    handle: Handle,
    id: i64,
    serial: u64,
    state: Arc<AtomicU8>,
}
impl WorkToken {
    pub fn id(&self) -> i64 {
        self.id
    }
    pub fn status(&self) -> WorkStatus {
        match self.state.load(Ordering::SeqCst) {
            0 => WorkStatus::Queued,
            1 => WorkStatus::InFlight,
            2 => WorkStatus::Completed,
            3 => WorkStatus::Cancelled,
            _ => WorkStatus::TimedOut,
        }
    }
}
#[derive(Clone, Copy)]
pub struct Limits {
    pub carriers: usize,
    pub pending_carriers: usize,
    pub hello_ms: u64,
    pub idle_ms: u64,
    pub inflight: usize,
    pub queued: usize,
    pub queue_wait_ms: u64,
    pub request_ms: u64,
    pub request_bytes: usize,
    pub outbound_bytes: usize,
    pub outbound_frames: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            carriers: 16,
            pending_carriers: 8,
            hello_ms: 15_000,
            idle_ms: 45_000,
            inflight: 16,
            queued: 64,
            queue_wait_ms: 20_000,
            request_ms: 340_000,
            request_bytes: 16 * 1024 * 1024,
            outbound_bytes: 32 * 1024 * 1024,
            outbound_frames: 256,
        }
    }
}
struct Bytes {
    bytes: Vec<u8>,
    _lease: Reservation,
}
struct Job {
    request: LeasedRequest,
    token: WorkToken,
    deadline: u64,
    _lease: Reservation,
}
impl Drop for Job {
    fn drop(&mut self) {
        if matches!(
            self.token.status(),
            WorkStatus::Queued | WorkStatus::InFlight
        ) {
            self.token
                .state
                .store(WorkStatus::Cancelled as u8, Ordering::SeqCst);
        }
    }
}
struct Active {
    session: Session,
    reader: FrameReader,
    writer: FrameWriter,
    assembler: RequestAssembler,
    outbound: VecDeque<Bytes>,
    outbound_bytes: usize,
    jobs: BTreeMap<i64, Job>,
    queue: VecDeque<i64>,
    queued_bytes: usize,
    inflight: usize,
    next_work: u64,
    idle_deadline: u64,
    _lease: Reservation,
}
impl Active {
    fn budget(&self) -> ConnectionBudget {
        self.session.budget()
    }
    fn push(&mut self, bytes: &[u8], limits: Limits, seal: bool) -> crate::Result<()> {
        let length = bytes
            .len()
            .checked_add(if seal { 25 } else { 0 })
            .ok_or(Error::TooLarge)?;
        if self.outbound.len() >= limits.outbound_frames
            || length > limits.outbound_bytes.saturating_sub(self.outbound_bytes)
        {
            return Err(Error::TooLarge);
        }
        let lease = self.budget().reserve(length + 512)?;
        let _scratch = self.budget().reserve(if seal { length + 128 } else { 0 })?;
        let bytes = if seal {
            self.session.seal_encoded(bytes)?
        } else {
            bytes.to_vec()
        };
        self.outbound_bytes += bytes.len();
        self.outbound.push_back(Bytes {
            bytes,
            _lease: lease,
        });
        Ok(())
    }
    fn decrypt(&mut self, frame: &[u8]) -> crate::Result<Bytes> {
        if frame.len() > MAX_PAYLOAD {
            return Err(Error::TooLarge);
        }
        let lease = self.budget().reserve(frame.len() * 2 + 256)?;
        let bytes = self.session.open_encoded(frame)?;
        Ok(Bytes {
            bytes,
            _lease: lease,
        })
    }
    fn remove_job(&mut self, id: i64, status: WorkStatus) {
        if let Some(job) = self.jobs.remove(&id) {
            match job.token.status() {
                WorkStatus::InFlight => self.inflight -= 1,
                WorkStatus::Queued => {
                    self.queued_bytes -= job.request.request().body.len();
                    self.queue.retain(|other| *other != id);
                }
                _ => {}
            }
            job.token.state.store(status as u8, Ordering::SeqCst);
        }
    }
    fn promote(&mut self, now: u64, limits: Limits) -> crate::Result<Vec<WorkToken>> {
        let mut started = Vec::new();
        while self.inflight < limits.inflight {
            let Some(id) = self.queue.pop_front() else {
                break;
            };
            if now >= self.jobs[&id].deadline {
                self.remove_job(id, WorkStatus::TimedOut);
                continue;
            }
            let deadline = now.checked_add(limits.request_ms).ok_or(Error::Exhausted)?;
            let job = self.jobs.get_mut(&id).unwrap();
            self.queued_bytes -= job.request.request().body.len();
            self.inflight += 1;
            job.deadline = deadline;
            job.token
                .state
                .store(WorkStatus::InFlight as u8, Ordering::SeqCst);
            started.push(job.token.clone());
        }
        Ok(started)
    }
}
impl Drop for Active {
    fn drop(&mut self) {
        self.session.revoke();
        self.assembler.disconnect();
    }
}
enum State {
    Pending { deadline: u64, approval: bool },
    Active(Box<Active>),
}
struct Entry {
    handle: Handle,
    state: State,
}
/// All mutation is exclusive. A production owner must drive tick while idle and
/// serialize its trusted removal/retirement/connection events through this registry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stats {
    pub inflight: usize,
    pub queued: usize,
    pub uploads: usize,
    pub outbound_frames: usize,
    pub outbound_bytes: usize,
}
pub struct Registry {
    owner: [u8; 16],
    limits: Limits,
    next: u64,
    now: u64,
    retired: bool,
    entries: BTreeMap<u64, Entry>,
}
impl Registry {
    pub fn new(limits: Limits, rng: &mut (impl RngCore + CryptoRng)) -> Result<Self> {
        if limits.carriers == 0
            || limits.carriers > 16
            || limits.pending_carriers == 0
            || limits.pending_carriers > 16
            || limits.hello_ms == 0
            || limits.idle_ms == 0
            || limits.inflight == 0
            || limits.inflight > 16
            || limits.queued > 64
            || limits.queue_wait_ms == 0
            || limits.request_ms == 0
            || limits.request_bytes == 0
            || limits.request_bytes > 16 * 1024 * 1024
            || limits.outbound_bytes == 0
            || limits.outbound_bytes > 32 * 1024 * 1024
            || limits.outbound_frames == 0
            || limits.outbound_frames > 256
        {
            return Err(Error::TooLarge.into());
        }
        let mut owner = [0; 16];
        rng.fill_bytes(&mut owner);
        Ok(Self {
            owner,
            limits,
            next: 0,
            now: 0,
            retired: false,
            entries: BTreeMap::new(),
        })
    }
    fn clock(&mut self, now: u64) -> Result<()> {
        if now < self.now {
            return Err(RegistryError::Time);
        }
        self.now = now;
        Ok(())
    }
    fn current(&self, h: &Handle) -> bool {
        h.owner == self.owner
            && self
                .entries
                .get(&h.carrier)
                .is_some_and(|e| e.handle.generation == h.generation)
    }
    pub fn stats(&self, h: &Handle) -> Option<Stats> {
        if !self.current(h) {
            return None;
        }
        match &self.entries[&h.carrier].state {
            State::Active(a) => Some(Stats {
                inflight: a.inflight,
                queued: a.queue.len(),
                uploads: a.assembler.pending(),
                outbound_frames: a.outbound.len(),
                outbound_bytes: a.outbound_bytes,
            }),
            _ => None,
        }
    }
    pub fn carriers(&self) -> usize {
        self.entries.len()
    }
    /// OPEN replaces first, before any async authorization. A late establish can only
    /// use its original opaque handle and cannot recreate a removed generation.
    pub fn open_carrier(&mut self, carrier: u64, now: u64) -> Result<Handle> {
        self.clock(now)?;
        if self.retired || carrier == 0 {
            return Err(RegistryError::Revoked);
        }
        let generation = self.next.checked_add(1).ok_or(Error::Exhausted)?;
        let deadline = now
            .checked_add(self.limits.hello_ms)
            .ok_or(Error::Exhausted)?;
        if let Some(old) = self.entries.get(&carrier) {
            self.close(&old.handle.clone(), CloseReason::Replaced);
        }
        let pending = self
            .entries
            .values()
            .filter(|e| {
                matches!(
                    e.state,
                    State::Pending {
                        approval: false,
                        ..
                    }
                )
            })
            .count();
        if pending >= self.limits.pending_carriers || self.entries.len() >= self.limits.carriers {
            let oldest = self
                .entries
                .values()
                .filter(|e| {
                    matches!(
                        e.state,
                        State::Pending {
                            approval: false,
                            ..
                        }
                    )
                })
                .min_by_key(|e| e.handle.generation)
                .map(|e| e.handle.clone());
            if let Some(old) = oldest {
                self.close(&old, CloseReason::Replaced);
            } else {
                return Err(Error::TooLarge.into());
            }
        }
        self.next = generation;
        let handle = Handle {
            owner: self.owner,
            carrier,
            generation,
            state: Arc::new(AtomicU8::new(0)),
        };
        self.entries.insert(
            carrier,
            Entry {
                handle: handle.clone(),
                state: State::Pending {
                    deadline,
                    approval: false,
                },
            },
        );
        Ok(handle)
    }
    pub(crate) fn wait_approval(&mut self, h: &Handle, until: u64, now: u64) -> Result<()> {
        self.clock(now)?;
        if !self.current(h) {
            return Err(RegistryError::Revoked);
        }
        match &mut self.entries.get_mut(&h.carrier).unwrap().state {
            State::Pending { deadline, approval } if now < *deadline && now < until => {
                *deadline = until;
                *approval = true;
                Ok(())
            }
            _ => Err(RegistryError::Revoked),
        }
    }
    pub fn establish(&mut self, h: &Handle, session: Session, now: u64) -> Result<()> {
        self.clock(now)?;
        if !self.current(h) {
            return Err(RegistryError::Revoked);
        }
        let deadline = match self.entries[&h.carrier].state {
            State::Pending { deadline, .. } => deadline,
            State::Active(_) => return Err(RegistryError::Revoked),
        };
        if now >= deadline {
            self.close(h, CloseReason::HelloTimeout);
            return Err(RegistryError::Revoked);
        }
        if self.retired || session.is_revoked() {
            self.close(h, CloseReason::Removed);
            return Err(RegistryError::Revoked);
        }
        let limits = self.limits;
        let create = (|| -> crate::Result<Active> {
            let lease = session.budget().reserve(4096)?;
            let reader = session.reader(Direction::Rpc)?;
            let writer = session.writer(Direction::Evt)?;
            let assembler = RequestAssembler::with_budget(
                AssemblyLimits {
                    pending: limits.inflight + limits.queued,
                    body_bytes: crate::phone::MAX_UPLOAD.min(limits.request_bytes),
                    total_bytes: limits.request_bytes,
                    timeout_ms: limits.queue_wait_ms,
                },
                session.budget(),
            )?;
            let reply = session.reply()?.to_vec(); // bounded HELLO reply, covered by baseline lease
            let mut active = Active {
                session,
                reader,
                writer,
                assembler,
                outbound: VecDeque::new(),
                outbound_bytes: 0,
                jobs: BTreeMap::new(),
                queue: VecDeque::new(),
                queued_bytes: 0,
                inflight: 0,
                next_work: 0,
                idle_deadline: now.checked_add(limits.idle_ms).ok_or(Error::Exhausted)?,
                _lease: lease,
            };
            active.push(&reply, limits, false)?;
            Ok(active)
        })();
        match create {
            Ok(active) => {
                self.entries.get_mut(&h.carrier).unwrap().state = State::Active(Box::new(active));
                h.state.store(1, Ordering::SeqCst);
                Ok(())
            }
            Err(error) => {
                self.close(h, CloseReason::Limit);
                Err(error.into())
            }
        }
    }
    /// Removes the map entry BEFORE dropping keys, requests and output leases.
    pub fn close(&mut self, h: &Handle, reason: CloseReason) -> bool {
        if !self.current(h) {
            return false;
        }
        let entry = self.entries.remove(&h.carrier).unwrap();
        entry.handle.state.store(reason as u8, Ordering::SeqCst);
        drop(entry);
        true
    }
    /// Only the authority's composed remove operation calls this; revocation is in Session epochs.
    pub(crate) fn close_device(&mut self, key: &str) -> usize {
        let handles: Vec<_> = self
            .entries
            .values()
            .filter(|e| matches!(&e.state,State::Active(a) if a.session.device().key==key))
            .map(|e| e.handle.clone())
            .collect();
        for h in &handles {
            self.close(h, CloseReason::Removed);
        }
        handles.len()
    }
    pub fn retire(&mut self) {
        self.retired = true;
        let handles: Vec<_> = self.entries.values().map(|e| e.handle.clone()).collect();
        for h in handles {
            self.close(&h, CloseReason::Retired);
        }
    }
    fn active(&mut self, h: &Handle, now: u64) -> Result<&mut Active> {
        self.clock(now)?;
        if !self.current(h) {
            return Err(RegistryError::Revoked);
        }
        let reason = match &self.entries[&h.carrier].state {
            State::Pending { .. } => return Err(RegistryError::Revoked),
            State::Active(a) if a.session.is_revoked() => Some(CloseReason::Removed),
            State::Active(a) if now >= a.idle_deadline => Some(CloseReason::IdleTimeout),
            State::Active(a) if a.reader.deadline_ms().is_some_and(|d| now >= d) => {
                Some(CloseReason::FragmentTimeout)
            }
            _ => None,
        };
        if let Some(reason) = reason {
            self.close(h, reason);
            return Err(RegistryError::Revoked);
        }
        match &mut self.entries.get_mut(&h.carrier).unwrap().state {
            State::Active(a) => Ok(a),
            _ => unreachable!(),
        }
    }
    pub fn heard(&mut self, h: &Handle, now: u64) -> Result<()> {
        let until = now
            .checked_add(self.limits.idle_ms)
            .ok_or(Error::Exhausted)?;
        self.active(h, now)?.idle_deadline = until;
        Ok(())
    }
    fn failure<T>(&mut self, h: &Handle, result: crate::Result<T>) -> Result<T> {
        match result {
            Ok(v) => Ok(v),
            Err(e) => {
                self.close(
                    h,
                    if matches!(e, Error::Budget | Error::TooLarge) {
                        CloseReason::Limit
                    } else {
                        CloseReason::Protocol
                    },
                );
                Err(e.into())
            }
        }
    }
    pub fn send_encoded(&mut self, h: &Handle, bytes: &[u8], now: u64) -> Result<()> {
        let limits = self.limits;
        let a = self.active(h, now)?;
        let result = (|| {
            if bytes.len() > MAX_PLAIN_BYTES {
                return Err(Error::TooLarge);
            }
            raw_json::validate(bytes)?;
            a.push(bytes, limits, true)
        })();
        self.failure(h, result)
    }
    pub fn send_peer(&mut self, h: &Handle, json: &str, now: u64) -> Result<()> {
        let limits = self.limits;
        let a = self.active(h, now)?;
        let result = (|| {
            if a.session.device().kind != crate::channel::DeviceKind::Desktop {
                return Err(Error::Schema);
            }
            let frames = a.writer.write(json)?;
            for frame in frames.iter() {
                a.push(frame, limits, true)?;
            }
            Ok(())
        })();
        self.failure(h, result)
    }
    /// Borrow one owned ciphertext for an in-memory carrier. Failure closes the carrier;
    /// no leased buffer escapes, so close releases every registry-owned byte.
    pub fn take_output(
        &mut self,
        h: &Handle,
        now: u64,
        consume: impl FnOnce(&[u8]) -> crate::Result<()>,
    ) -> Result<bool> {
        let a = self.active(h, now)?;
        let Some(buffer) = a.outbound.pop_front() else {
            return Ok(false);
        };
        a.outbound_bytes -= buffer.bytes.len();
        let result = a.session.with_access(|| consume(&buffer.bytes));
        drop(buffer);
        match result {
            Ok(()) => Ok(true),
            Err(e) => {
                self.close(h, CloseReason::CarrierFailure);
                Err(e.into())
            }
        }
    }
    pub fn receive_peer(
        &mut self,
        h: &Handle,
        encrypted: &[u8],
        now: u64,
        consume: impl FnOnce(&[u8]),
    ) -> Result<bool> {
        let idle = self.limits.idle_ms;
        let a = self.active(h, now)?;
        let result = (|| {
            if a.session.device().kind != crate::channel::DeviceKind::Desktop {
                return Err(Error::Schema);
            }
            let plain = a.decrypt(encrypted)?;
            let frame = a.reader.read(&plain.bytes, now)?;
            a.idle_deadline = now.checked_add(idle).ok_or(Error::Exhausted)?;
            if let Some(frame) = frame {
                a.session.with_access(|| {
                    consume(frame.as_bytes());
                    Ok(())
                })?;
                Ok(true)
            } else {
                Ok(false)
            }
        })();
        self.failure(h, result)
    }
    pub fn receive_request(
        &mut self,
        h: &Handle,
        encrypted: &[u8],
        now: u64,
    ) -> Result<Vec<WorkToken>> {
        let limits = self.limits;
        let a = self.active(h, now)?;
        let result = (|| {
            if a.session.device().kind != crate::channel::DeviceKind::Phone {
                return Err(Error::Schema);
            }
            let plain = a.decrypt(encrypted)?;
            raw_json::validate(&plain.bytes)?;
            #[derive(Deserialize)]
            struct Id {
                id: i64,
            }
            let id: Id = serde_json::from_slice(&plain.bytes).map_err(|_| Error::Schema)?;
            if a.jobs.contains_key(&id.id)
                || (!a.assembler.accepts_tail(id.id)
                    && a.jobs.len() + a.assembler.pending() >= limits.inflight + limits.queued)
            {
                return Err(Error::TooLarge);
            }
            let request = a.assembler.receive_budgeted(&plain.bytes, now)?;
            a.idle_deadline = now.checked_add(limits.idle_ms).ok_or(Error::Exhausted)?;
            if let Some(request) = request {
                let size = request.request().body.len();
                let id = request.request().id;
                if a.inflight >= limits.inflight
                    && (a.queue.len() >= limits.queued
                        || size > limits.request_bytes.saturating_sub(a.queued_bytes))
                {
                    return Err(Error::TooLarge);
                }
                let serial = a.next_work.checked_add(1).ok_or(Error::Exhausted)?;
                let deadline = now
                    .checked_add(limits.queue_wait_ms)
                    .ok_or(Error::Exhausted)?;
                let lease = a.budget().reserve(512)?;
                let token = WorkToken {
                    handle: h.clone(),
                    id,
                    serial,
                    state: Arc::new(AtomicU8::new(WorkStatus::Queued as u8)),
                };
                a.next_work = serial;
                a.queued_bytes += size;
                a.queue.push_back(id);
                a.jobs.insert(
                    id,
                    Job {
                        request,
                        token,
                        deadline,
                        _lease: lease,
                    },
                );
            }
            a.promote(now, limits)
        })();
        self.failure(h, result)
    }
    /// Token lookup is only for test/adapter observation; no work bytes escape ownership.
    pub fn work_token(&self, h: &Handle, id: i64) -> Result<WorkToken> {
        if !self.current(h) {
            return Err(RegistryError::Revoked);
        }
        match &self.entries[&h.carrier].state {
            State::Active(a) => a
                .jobs
                .get(&id)
                .map(|j| j.token.clone())
                .ok_or(RegistryError::Revoked),
            _ => Err(RegistryError::Revoked),
        }
    }
    fn work(&mut self, t: &WorkToken, now: u64) -> Result<&mut Active> {
        let a = self.active(&t.handle, now)?;
        let valid = a.jobs.get(&t.id).is_some_and(|j| {
            j.token.serial == t.serial && j.token.status() == WorkStatus::InFlight
        });
        if !valid {
            return Err(RegistryError::Revoked);
        }
        if now >= a.jobs[&t.id].deadline {
            a.remove_job(t.id, WorkStatus::TimedOut);
            return Err(RegistryError::Revoked);
        }
        Ok(a)
    }
    pub fn with_request<T>(
        &mut self,
        t: &WorkToken,
        now: u64,
        read: impl FnOnce(&Request) -> T,
    ) -> Result<T> {
        let a = self.work(t, now)?;
        Ok(a.session
            .with_access(|| Ok(read(a.jobs[&t.id].request.request())))?)
    }
    /// Trusted serialized response from a fake bridge. Domain HTTP forwarding/schema
    /// mapping is separate. Late callbacks are rejected before parsing or sealing bytes.
    pub fn finish_request(
        &mut self,
        t: &WorkToken,
        response: &[u8],
        now: u64,
    ) -> Result<Vec<WorkToken>> {
        let limits = self.limits;
        let a = self.work(t, now)?;
        let result = (|| {
            if response.len() > MAX_PLAIN_BYTES {
                return Err(Error::TooLarge);
            }
            raw_json::validate(response)?;
            a.push(response, limits, true)?;
            a.remove_job(t.id, WorkStatus::Completed);
            a.promote(now, limits)
        })();
        self.failure(&t.handle, result)
    }
    /// Drive periodically even with NO incoming frames. Returns newly started work;
    /// cancelled/timed-out tokens are observable without retaining request payloads.
    pub fn tick(&mut self, now: u64) -> Result<Vec<WorkToken>> {
        self.clock(now)?;
        let handles: Vec<_> = self.entries.values().map(|e| e.handle.clone()).collect();
        let mut started = Vec::new();
        for h in handles {
            let reason = match &self.entries[&h.carrier].state {
                State::Pending { deadline, .. } if now >= *deadline => {
                    Some(CloseReason::HelloTimeout)
                }
                State::Active(a) if a.session.is_revoked() => Some(CloseReason::Removed),
                State::Active(a) if now >= a.idle_deadline => Some(CloseReason::IdleTimeout),
                State::Active(a) if a.reader.deadline_ms().is_some_and(|d| now >= d) => {
                    Some(CloseReason::FragmentTimeout)
                }
                _ => None,
            };
            if let Some(reason) = reason {
                self.close(&h, reason);
                continue;
            }
            if let State::Active(a) = &mut self.entries.get_mut(&h.carrier).unwrap().state {
                let result = (|| -> crate::Result<Vec<WorkToken>> {
                    a.assembler.expire(now)?;
                    let expired: Vec<_> = a
                        .jobs
                        .iter()
                        .filter(|(_, j)| now >= j.deadline)
                        .map(|(id, _)| *id)
                        .collect();
                    for id in expired {
                        a.remove_job(id, WorkStatus::TimedOut)
                    }
                    a.promote(now, self.limits)
                })();
                match result {
                    Ok(items) => started.extend(items),
                    Err(_) => {
                        self.close(&h, CloseReason::Protocol);
                    }
                }
            }
        }
        Ok(started)
    }
    pub fn next_deadline_ms(&self) -> Option<u64> {
        self.entries
            .values()
            .map(|e| match &e.state {
                State::Pending { deadline, .. } => *deadline,
                State::Active(a) => a
                    .reader
                    .deadline_ms()
                    .into_iter()
                    .chain(a.assembler.deadline_ms())
                    .chain(a.jobs.values().map(|j| j.deadline))
                    .chain([a.idle_deadline])
                    .min()
                    .unwrap(),
            })
            .min()
    }
}
impl Drop for Registry {
    fn drop(&mut self) {
        self.retire();
    }
}

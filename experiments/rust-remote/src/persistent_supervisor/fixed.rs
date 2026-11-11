//! Private owner admission only. No submission scheduler or delivery pump in this stage.
use super::*;
use crate::persistent::fixed_executor::TargetId;
use crate::{
    registry::{self, Handle, WorkStatus, WorkToken},
    supervisor::MemoryCarrier,
};
use std::sync::Weak;

pub(crate) const STATUS_SLOTS: usize = 512;
pub(crate) const DEVICE_STATUSES: usize = 32;
pub(crate) const QUEUE_SLOTS: usize = 16;
pub(crate) const STATUS_BYTES: usize = 2048;

pub(crate) struct FixedFixture;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct FixedId {
    scope: [u8; 16],
    slot: u16,
    generation: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FixedOutcome {
    Success,
    Unavailable,
    Timeout,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PrepareRefusal {
    Full,
    Stopped,
    Expired,
    Stale,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WaitFault {
    Timeout,
    Refused(PrepareRefusal),
}
impl From<PrepareRefusal> for WaitFault {
    fn from(f: PrepareRefusal) -> Self {
        Self::Refused(f)
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SubmitRefusal {
    Stopped,
    Expired,
    Replaced,
    Revoked,
}
pub(crate) enum SubmitRejection {
    Full(FixedAttempt),
    Unavailable(SubmitRefusal),
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StatusRefusal {
    Stopped,
    Forgotten,
    NotTerminal,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NotClaimed {
    Cancelled,
    Expired,
    Stale,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Phase {
    Prepared,
    Queued,
    Terminal(NotClaimed),
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Observation {
    Stopped,
    Forgotten,
    Present {
        phase: Phase,
        cancel_requested: bool,
    },
}
#[derive(Clone)]
pub(crate) struct FixedOwnerClient(Weak<Shared>);
pub(crate) struct FixedAttempt {
    id: FixedId,
    shared: Weak<Shared>,
    armed: bool,
}
impl FixedAttempt {
    pub(crate) fn id(&self) -> FixedId {
        self.id
    }
}
pub(crate) struct FixedReceipt {
    id: FixedId,
}
impl FixedReceipt {
    pub(crate) fn id(&self) -> FixedId {
        self.id
    }
}
pub(crate) struct PrepareReceipt(ReplyHandle);
pub(crate) struct AdoptReceipt(ReplyHandle);
struct ReplyHandle {
    shared: Weak<Shared>,
    slot: usize,
    generation: u64,
    armed: bool,
}

pub(crate) struct BoundMailbox {
    handle: Handle,
    memory: MemoryCarrier,
    scope: Arc<()>,
}
impl BoundMailbox {
    pub(crate) fn into_parts(self) -> (Handle, MemoryCarrier, Arc<()>) {
        (self.handle, self.memory, self.scope)
    }
}
#[derive(Default)]
pub(super) struct RuntimeFixed {
    targets: [Option<(Handle, TargetId)>; 16],
}
struct Row {
    id: FixedId,
    token: WorkToken,
    device: [u8; 64],
    deadline: u64,
    target: TargetId,
    phase: Phase,
    cancel: bool,
    hidden: bool,
    // Only admission exists in this stage. This private proof is constructed while
    // no core start has occurred, and cannot be supplied by a caller or acknowledgment.
    disposal: Unclaimed,
    _lease: Reservation,
}
struct Unclaimed;
struct ReplyCell {
    generation: u64,
    result: Option<Result<PreparedReply, PrepareRefusal>>,
}
enum PreparedReply {
    Attempt(FixedId),
    Adopted(TargetId),
}
enum Operation {
    Prepare(WorkToken),
    Adopt(Handle),
}
struct Pending {
    slot: usize,
    generation: u64,
    operation: Operation,
}
struct Submission {
    id: FixedId,
    outcome: FixedOutcome,
}
struct Ring<T, const N: usize> {
    values: [Option<T>; N],
    head: usize,
    len: usize,
}
impl<T, const N: usize> Default for Ring<T, N> {
    fn default() -> Self {
        Self {
            values: std::array::from_fn(|_| None),
            head: 0,
            len: 0,
        }
    }
}
impl<T, const N: usize> Ring<T, N> {
    fn push(&mut self, value: T) {
        assert!(self.len < N);
        let i = (self.head + self.len) % N;
        self.values[i] = Some(value);
        self.len += 1;
    }
    fn pop(&mut self) -> Option<T> {
        if self.len == 0 {
            return None;
        }
        let v = self.values[self.head].take();
        self.head = (self.head + 1) % N;
        self.len -= 1;
        v
    }
    fn contains(&self, id: FixedId, get: impl Fn(&T) -> FixedId) -> bool {
        self.values.iter().flatten().any(|v| get(v) == id)
    }
}
pub(super) struct State {
    scope: [u8; 16],
    next: u64,
    next_reply: u64,
    rows: [Option<Row>; STATUS_SLOTS],
    operations: Ring<Pending, QUEUE_SLOTS>,
    replies: [Option<ReplyCell>; QUEUE_SLOTS],
    submissions: Ring<Submission, QUEUE_SLOTS>,
    _lease: Reservation,
}
impl State {
    pub(super) fn new(global: &GlobalBudget) -> crate::Result<Box<Self>> {
        let bytes = backing_bytes().ok_or(crate::Error::Budget)?;
        let lease = global.connection(bytes)?.reserve(bytes)?;
        let mut scope = [0; 16];
        rand_core::RngCore::fill_bytes(&mut OsRng, &mut scope);
        Ok(Box::new(Self {
            scope,
            next: 0,
            next_reply: 0,
            rows: std::array::from_fn(|_| None),
            operations: Ring::default(),
            replies: std::array::from_fn(|_| None),
            submissions: Ring::default(),
            _lease: lease,
        }))
    }
    pub(super) fn has_operations(&self) -> bool {
        self.operations.len != 0
    }
    fn row(&self, id: FixedId) -> Option<&Row> {
        self.rows
            .get(usize::from(id.slot))?
            .as_ref()
            .filter(|r| r.id == id)
    }
    fn row_mut(&mut self, id: FixedId) -> Option<&mut Row> {
        self.rows
            .get_mut(usize::from(id.slot))?
            .as_mut()
            .filter(|r| r.id == id)
    }
    fn reply(&self, slot: usize, generation: u64) -> Option<&ReplyCell> {
        self.replies
            .get(slot)?
            .as_ref()
            .filter(|r| r.generation == generation)
    }
    fn reap(&mut self) {
        for slot in &mut self.rows {
            let Some(row) = slot else {
                continue;
            };
            let Unclaimed = row.disposal;
            if row.hidden
                && matches!(row.phase, Phase::Terminal(_))
                && !self.submissions.contains(row.id, |s| s.id)
                && !self.replies.iter().flatten().any(
                    |r| matches!(&r.result, Some(Ok(PreparedReply::Attempt(id))) if *id == row.id),
                )
            {
                drop(slot.take());
            }
        }
    }
}
pub(crate) fn backing_bytes() -> Option<usize> {
    std::mem::size_of::<State>()
        .checked_add(std::mem::size_of::<RuntimeFixed>())?
        .checked_add(4096)
}
impl FixedOwnerClient {
    fn shared(&self) -> Result<Arc<Shared>, PrepareRefusal> {
        self.0.upgrade().ok_or(PrepareRefusal::Stopped)
    }
    fn enqueue(&self, operation: Operation) -> Result<ReplyHandle, PrepareRefusal> {
        let shared = self.shared()?;
        let mut q = shared.queues();
        if shared.stop.load(Ordering::SeqCst) != RUNNING {
            return Err(PrepareRefusal::Stopped);
        }
        let fixed = q.fixed.as_mut().ok_or(PrepareRefusal::Stopped)?;
        if fixed.operations.len == QUEUE_SLOTS {
            return Err(PrepareRefusal::Full);
        }
        let slot = fixed
            .replies
            .iter()
            .position(Option::is_none)
            .ok_or(PrepareRefusal::Full)?;
        let generation = fixed
            .next_reply
            .checked_add(1)
            .ok_or(PrepareRefusal::Full)?;
        fixed.replies[slot] = Some(ReplyCell {
            generation,
            result: None,
        });
        fixed.operations.push(Pending {
            slot,
            generation,
            operation,
        });
        fixed.next_reply = generation;
        shared.wake.notify_one();
        Ok(ReplyHandle {
            shared: Arc::downgrade(&shared),
            slot,
            generation,
            armed: true,
        })
    }
    pub(crate) fn prepare(&self, token: WorkToken) -> Result<PrepareReceipt, PrepareRefusal> {
        self.enqueue(Operation::Prepare(token)).map(PrepareReceipt)
    }
    pub(crate) fn adopt(&self, handle: Handle) -> Result<AdoptReceipt, PrepareRefusal> {
        self.enqueue(Operation::Adopt(handle)).map(AdoptReceipt)
    }
    pub(crate) fn submit(
        &self,
        mut attempt: FixedAttempt,
        outcome: FixedOutcome,
    ) -> Result<FixedReceipt, SubmitRejection> {
        let shared = self
            .0
            .upgrade()
            .ok_or(SubmitRejection::Unavailable(SubmitRefusal::Stopped))?;
        let mut q = shared.queues();
        let refusal = if shared.stop.load(Ordering::SeqCst) != RUNNING {
            Some(SubmitRefusal::Stopped)
        } else if !Weak::ptr_eq(&self.0, &attempt.shared) {
            Some(SubmitRefusal::Replaced)
        } else {
            None
        };
        if let Some(refusal) = refusal {
            drop(q);
            return Err(SubmitRejection::Unavailable(refusal));
        }
        let Some(fixed) = q.fixed.as_mut() else {
            drop(q);
            return Err(SubmitRejection::Unavailable(SubmitRefusal::Stopped));
        };
        let Some(row) = fixed.row(attempt.id) else {
            drop(q);
            return Err(SubmitRejection::Unavailable(SubmitRefusal::Revoked));
        };
        let refusal = if shared.clock.now() >= row.deadline {
            Some(SubmitRefusal::Expired)
        } else if row.token.handle().status()
            == registry::CarrierStatus::Closed(registry::CloseReason::Replaced)
        {
            Some(SubmitRefusal::Replaced)
        } else if row.cancel
            || row.hidden
            || row.phase != Phase::Prepared
            || row.token.handle().status() != registry::CarrierStatus::Active
            || row.token.status() != WorkStatus::InFlight
        {
            Some(SubmitRefusal::Revoked)
        } else {
            None
        };
        if let Some(refusal) = refusal {
            drop(q);
            return Err(SubmitRejection::Unavailable(refusal));
        }
        let device = row.device;
        if fixed.submissions.len == QUEUE_SLOTS
            || fixed
                .submissions
                .values
                .iter()
                .flatten()
                .any(|s| fixed.row(s.id).is_some_and(|r| r.device == device))
        {
            return Err(SubmitRejection::Full(attempt));
        }
        let id = attempt.id;
        fixed.row_mut(id).unwrap().phase = Phase::Queued;
        fixed.submissions.push(Submission { id, outcome });
        attempt.armed = false;
        shared.wake.notify_one();
        Ok(FixedReceipt { id })
    }
    pub(crate) fn observe(&self, id: FixedId) -> Observation {
        let Some(shared) = self.0.upgrade() else {
            return Observation::Stopped;
        };
        let q = shared.queues();
        if shared.stop.load(Ordering::SeqCst) != RUNNING {
            return Observation::Stopped;
        }
        let Some(fixed) = &q.fixed else {
            return Observation::Stopped;
        };
        let Some(row) = fixed.row(id).filter(|r| !r.hidden) else {
            return Observation::Forgotten;
        };
        Observation::Present {
            phase: row.phase,
            cancel_requested: row.cancel,
        }
    }
    pub(crate) fn cancel(&self, id: FixedId) -> Result<(), StatusRefusal> {
        self.change(id, false)
    }
    pub(crate) fn ack_terminal(&self, id: FixedId) -> Result<(), StatusRefusal> {
        self.change(id, true)
    }
    fn change(&self, id: FixedId, ack: bool) -> Result<(), StatusRefusal> {
        let shared = self.0.upgrade().ok_or(StatusRefusal::Stopped)?;
        let mut q = shared.queues();
        if shared.stop.load(Ordering::SeqCst) != RUNNING {
            return Err(StatusRefusal::Stopped);
        }
        let fixed = q.fixed.as_mut().ok_or(StatusRefusal::Stopped)?;
        let row = fixed
            .row_mut(id)
            .filter(|r| !r.hidden)
            .ok_or(StatusRefusal::Forgotten)?;
        if ack {
            if !matches!(row.phase, Phase::Terminal(_)) {
                return Err(StatusRefusal::NotTerminal);
            }
            row.hidden = true;
        } else {
            row.cancel = true;
        }
        fixed.reap();
        shared.wake.notify_one();
        Ok(())
    }
}
impl Drop for FixedAttempt {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        if let Some(shared) = self.shared.upgrade() {
            let mut q = shared.queues();
            if let Some(row) = q.fixed.as_mut().and_then(|f| f.row_mut(self.id)) {
                row.cancel = true;
                row.hidden = true;
            }
            shared.wake.notify_one();
        }
    }
}
impl ReplyHandle {
    fn wait(&mut self, timeout: Duration) -> Result<PreparedReply, WaitFault> {
        let shared = self.shared.upgrade().ok_or(PrepareRefusal::Stopped)?;
        let q = shared.queues();
        let (mut q, _) = shared
            .changed
            .wait_timeout_while(q, timeout, |q| {
                q.fixed
                    .as_ref()
                    .and_then(|f| f.reply(self.slot, self.generation))
                    .is_some_and(|r| r.result.is_none())
                    && shared.stop.load(Ordering::SeqCst) == RUNNING
            })
            .unwrap_or_else(|e| {
                shared.fail(WorkerFault::Poisoned);
                e.into_inner()
            });
        if shared.stop.load(Ordering::SeqCst) != RUNNING {
            return Err(PrepareRefusal::Stopped.into());
        }
        let fixed = q.fixed.as_mut().ok_or(PrepareRefusal::Stopped)?;
        let reply = fixed
            .reply(self.slot, self.generation)
            .ok_or(PrepareRefusal::Stale)?;
        if reply.result.is_none() {
            return Err(WaitFault::Timeout);
        } // Observation timeout, handle remains live.
        let result = fixed.replies[self.slot].take().unwrap().result.unwrap();
        self.armed = false;
        result.map_err(Into::into)
    }
}
impl PrepareReceipt {
    pub(crate) fn wait(&mut self, timeout: Duration) -> Result<FixedAttempt, WaitFault> {
        match self.0.wait(timeout)? {
            PreparedReply::Attempt(id) => Ok(FixedAttempt {
                id,
                shared: self.0.shared.clone(),
                armed: true,
            }),
            _ => Err(PrepareRefusal::Stale.into()),
        }
    }
}
impl AdoptReceipt {
    pub(crate) fn wait(&mut self, timeout: Duration) -> Result<TargetId, WaitFault> {
        match self.0.wait(timeout)? {
            PreparedReply::Adopted(id) => Ok(id),
            _ => Err(PrepareRefusal::Stale.into()),
        }
    }
}
impl Drop for ReplyHandle {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        if let Some(shared) = self.shared.upgrade() {
            let mut q = shared.queues();
            if let Some(fixed) = q.fixed.as_mut() {
                if fixed.reply(self.slot, self.generation).is_some() {
                    let reply = fixed.replies[self.slot].take().unwrap();
                    if let Some(Ok(PreparedReply::Attempt(id))) = reply.result {
                        if let Some(row) = fixed.row_mut(id) {
                            row.cancel = true;
                            row.hidden = true;
                        }
                    }
                }
            }
            shared.wake.notify_one();
        }
    }
}
impl PersistentSupervisor {
    #[allow(
        clippy::needless_update,
        reason = "default initializes test-only startup fault hooks"
    )]
    pub(crate) fn start_fixed_fixture(
        profile: SyntheticProfile,
        limits: Limits,
        clock: Clock,
        _fixture: FixedFixture,
    ) -> Result<Self, PersistentStartFailure> {
        Self::start_inner(
            profile,
            limits,
            clock,
            Hooks {
                fixed_fixture: true,
                ..Default::default()
            },
        )
    }
    pub(crate) fn fixed_owner(&self) -> Option<FixedOwnerClient> {
        self.shared
            .queues()
            .fixed
            .as_ref()
            .map(|_| FixedOwnerClient(Arc::downgrade(&self.shared)))
    }
}
impl Runtime {
    pub(super) fn fixed_maintain(&mut self, shared: &Shared) {
        let now = self.clock.now();
        let mut q = shared.queues();
        let Some(fixed) = q.fixed.as_mut() else {
            return;
        };
        for row in fixed.rows.iter_mut().flatten() {
            if matches!(row.phase, Phase::Terminal(_)) {
                continue;
            }
            let terminal = if row.cancel {
                Some(NotClaimed::Cancelled)
            } else if now >= row.deadline {
                Some(NotClaimed::Expired)
            } else if row.token.handle().status() != registry::CarrierStatus::Active
                || row.token.status() != WorkStatus::InFlight
            {
                Some(NotClaimed::Stale)
            } else {
                None
            };
            if let Some(terminal) = terminal {
                row.phase = Phase::Terminal(terminal);
            }
        }
        let len = fixed.submissions.len;
        for _ in 0..len {
            let submission = fixed.submissions.pop().unwrap();
            if fixed
                .row(submission.id)
                .is_some_and(|r| r.phase == Phase::Queued)
            {
                fixed.submissions.push(submission);
            }
        }
        fixed.reap();
        shared.changed.notify_all();
        for target in &mut self.fixed.as_mut().unwrap().targets {
            if target
                .as_ref()
                .is_some_and(|(h, _)| h.status() != registry::CarrierStatus::Active)
            {
                *target = None;
            }
        }
    }
    pub(super) fn fixed_prepare_one(&mut self, shared: &Shared) {
        let pending = {
            let mut q = shared.queues();
            q.fixed.as_mut().and_then(|f| f.operations.pop())
        };
        let Some(pending) = pending else {
            return;
        };
        {
            let q = shared.queues();
            if shared.stop.load(Ordering::SeqCst) != RUNNING
                || q.fixed
                    .as_ref()
                    .and_then(|f| f.reply(pending.slot, pending.generation))
                    .is_none()
            {
                return;
            }
        }
        if self.maintain(shared).is_err() {
            shared.fail(WorkerFault::Clock);
            return;
        }
        let result = match pending.operation {
            Operation::Adopt(handle) => self
                .fixed_adopt(shared, &handle)
                .map(PreparedReply::Adopted),
            Operation::Prepare(token) => self
                .fixed_prepare(shared, token)
                .map(PreparedReply::Attempt),
        };
        self.reconcile(shared);
        if self.authority.global_pool().is_err() {
            shared.fail(WorkerFault::InvalidExit);
        }
        let mut q = shared.queues();
        let Some(fixed) = q.fixed.as_mut() else {
            return;
        };
        if fixed.reply(pending.slot, pending.generation).is_some() {
            fixed.replies[pending.slot].as_mut().unwrap().result = Some(result);
        } else if let Ok(PreparedReply::Attempt(id)) = result {
            if let Some(row) = fixed.row_mut(id) {
                row.cancel = true;
                row.hidden = true;
            }
        }
        shared.changed.notify_all();
    }
    fn fixed_adopt(
        &mut self,
        shared: &Shared,
        handle: &Handle,
    ) -> Result<TargetId, PrepareRefusal> {
        self.current(handle).map_err(|_| PrepareRefusal::Stale)?;
        if self
            .fixed
            .as_ref()
            .unwrap()
            .targets
            .iter()
            .flatten()
            .any(|(h, _)| h.same(handle))
        {
            return Err(PrepareRefusal::Stale);
        }
        let index = self
            .fixed
            .as_ref()
            .unwrap()
            .targets
            .iter()
            .position(Option::is_none)
            .ok_or(PrepareRefusal::Full)?;
        let bound = BoundMailbox {
            handle: handle.clone(),
            memory: self.carriers[&handle.carrier()].memory.clone(),
            scope: shared.scope.clone(),
        };
        let target = self
            .authority
            .adopt_fixed_carrier(bound, shared.limits)
            .map_err(|e| {
                if e == crate::persistent::fixed_executor::Fault::Full {
                    PrepareRefusal::Full
                } else {
                    PrepareRefusal::Stale
                }
            })?;
        self.fixed.as_mut().unwrap().targets[index] = Some((handle.clone(), target));
        Ok(target)
    }
    fn fixed_prepare(
        &mut self,
        shared: &Shared,
        token: WorkToken,
    ) -> Result<FixedId, PrepareRefusal> {
        self.current(token.handle())
            .map_err(|_| PrepareRefusal::Stale)?;
        let target = self
            .fixed
            .as_ref()
            .unwrap()
            .targets
            .iter()
            .flatten()
            .find(|(h, _)| h.same(token.handle()))
            .map(|(_, t)| *t)
            .ok_or(PrepareRefusal::Stale)?;
        let inspection = self
            .authority
            .inspect_fixed_candidate(&token, self.clock.now());
        Self::work_available(shared, inspection.promoted);
        let ready = inspection.candidate.map_err(|e| match e {
            registry::claim::AdmissionError::Expired => PrepareRefusal::Expired,
            _ => PrepareRefusal::Stale,
        })?;
        let lease = ready
            .budget
            .reserve(STATUS_BYTES)
            .map_err(|_| PrepareRefusal::Full)?;
        let mut q = shared.queues();
        if shared.stop.load(Ordering::SeqCst) != RUNNING {
            return Err(PrepareRefusal::Stopped);
        }
        let fixed = q.fixed.as_mut().ok_or(PrepareRefusal::Stopped)?;
        if fixed
            .rows
            .iter()
            .flatten()
            .filter(|r| r.device == ready.device)
            .count()
            >= DEVICE_STATUSES
        {
            return Err(PrepareRefusal::Full);
        }
        let slot = fixed
            .rows
            .iter()
            .position(Option::is_none)
            .ok_or(PrepareRefusal::Full)?;
        let generation = fixed.next.checked_add(1).ok_or(PrepareRefusal::Full)?;
        let id = FixedId {
            scope: fixed.scope,
            slot: u16::try_from(slot).map_err(|_| PrepareRefusal::Full)?,
            generation,
        };
        fixed.rows[slot] = Some(Row {
            id,
            token,
            device: ready.device,
            deadline: ready.deadline,
            target,
            phase: Phase::Prepared,
            cancel: false,
            hidden: false,
            disposal: Unclaimed,
            _lease: lease,
        });
        fixed.next = generation;
        Ok(id)
    }
}

#[cfg(test)]
impl FixedOwnerClient {
    pub(crate) fn counts(&self) -> (usize, usize, usize, usize) {
        let Some(shared) = self.0.upgrade() else {
            return (0, 0, 0, 0);
        };
        let q = shared.queues();
        q.fixed.as_ref().map_or((0, 0, 0, 0), |f| {
            (
                f.rows.iter().flatten().count(),
                f.submissions.len,
                f.replies.iter().flatten().count(),
                f.operations.len,
            )
        })
    }
}
impl std::fmt::Debug for FixedAttempt {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("FixedAttempt").field(&self.id).finish()
    }
}
impl std::fmt::Debug for SubmitRejection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Full(a) => f.debug_tuple("Full").field(&a.id).finish(),
            Self::Unavailable(e) => f.debug_tuple("Unavailable").field(e).finish(),
        }
    }
}

#[cfg(test)]
impl FixedOwnerClient {
    pub(crate) fn budget_for_test(&self, id: FixedId) -> ConnectionBudget {
        let shared = self.0.upgrade().unwrap();
        let q = shared.queues();
        q.fixed
            .as_ref()
            .unwrap()
            .row(id)
            .unwrap()
            ._lease
            .budget_for_test()
    }
}

#[cfg(test)]
mod layout_tests {
    use super::*;
    #[test]
    fn fixed_admission_layout_fits_prepaid_bounds() {
        let sizes = [
            std::mem::size_of::<State>(),
            std::mem::size_of::<RuntimeFixed>(),
            std::mem::size_of::<Row>(),
            std::mem::size_of::<ReplyCell>(),
            std::mem::size_of::<Pending>(),
            std::mem::size_of::<Submission>(),
        ];
        #[cfg(target_pointer_width = "64")]
        {
            assert_eq!(sizes, [155_232, 2048, 296, 48, 136, 40]);
            assert_eq!(backing_bytes(), Some(161_376));
        }
        assert!(sizes[2] <= STATUS_BYTES);
    }
}

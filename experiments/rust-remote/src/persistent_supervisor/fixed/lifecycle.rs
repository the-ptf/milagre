//! Concrete owner identity and short queue-synchronized core commits.
use super::*;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum OutputCommit {
    MaySend,
    Acceptance,
    Completed,
}

#[derive(Clone)]
pub(crate) struct OwnerBinding {
    id: FixedId,
    shared: Weak<Shared>,
    #[cfg(test)]
    before: Option<Arc<executor::ExitGate>>,
    #[cfg(test)]
    output: Option<Arc<OutputHooks>>,
}
impl OwnerBinding {
    fn new(id: FixedId, shared: &Arc<Shared>) -> Self {
        #[cfg(test)]
        let (before, output) = {
            let q = shared.queues();
            let test = q
                .fixed
                .as_ref()
                .and_then(|f| f.row(id))
                .and_then(|r| r.test.as_ref());
            (
                test.and_then(|t| t.before_begin.clone()),
                test.and_then(|t| t.output.clone()),
            )
        };
        Self {
            id,
            shared: Arc::downgrade(shared),
            #[cfg(test)]
            before,
            #[cfg(test)]
            output,
        }
    }
    pub(crate) fn wake_token(&self) -> Option<wake::WakeToken> {
        self.shared
            .upgrade()?
            .fixed_wake
            .as_ref()?
            .hub()
            .map(|hub| hub.token())
    }
    pub(crate) fn id(&self) -> FixedId {
        self.id
    }
    pub(crate) fn install(&self, core: executor::Id) -> bool {
        let Some(shared) = self.shared.upgrade() else {
            return false;
        };
        let mut q = shared.queues();
        let Some(row) = q.fixed.as_mut().and_then(|f| f.row_mut(self.id)) else {
            return false;
        };
        if !matches!(row.ownership, RowOwnership::Starting) {
            return false;
        }
        row.ownership = RowOwnership::Retained(core);
        row.phase = Phase::Claimed;
        true
    }
    /// Called only by the core while it holds session access and the real gate.
    /// `commit` changes only that gate and the core's inline observation.
    pub(crate) fn commit_begin(
        &self,
        core: executor::Id,
        sampled_at: u64,
        deadline: u64,
        commit: impl FnOnce(),
    ) -> Result<(), executor::Fault> {
        let shared = self.shared.upgrade().ok_or(executor::Fault::State)?;
        let mut q = shared.queues();
        if shared.fault().is_some() {
            return Err(executor::Fault::Worker);
        }
        if !shared.running() {
            return Err(executor::Fault::Stale);
        }
        let now = shared.clock.now();
        if now < sampled_at {
            return Err(executor::Fault::Clock);
        }
        if now >= deadline {
            return Err(executor::Fault::Expired);
        }
        let row = q
            .fixed
            .as_mut()
            .and_then(|f| f.row_mut(self.id))
            .ok_or(executor::Fault::State)?;
        if !matches!(row.ownership, RowOwnership::Retained(id) if id == core)
            || row.phase != Phase::Claimed
        {
            return Err(executor::Fault::State);
        }
        if row.cancel {
            return Err(executor::Fault::Stale);
        }
        if !shared.running() {
            return Err(executor::Fault::Stale);
        }
        row.execution = executor::Execution::MayHaveRun;
        row.phase = Phase::Running;
        commit();
        shared.changed.notify_all();
        drop(q);
        #[cfg(test)]
        if let Some(gate) = self.output.as_ref().and_then(|h| h.after_begin.as_ref()) {
            gate.wait();
        }
        Ok(())
    }
    pub(crate) fn settle(&self, proof: executor::Disposed) -> bool {
        let Some(shared) = self.shared.upgrade() else {
            return false;
        };
        settle(&shared, self.id, proof)
    }
    /// Registry holds exact session access; only bounded evidence changes run here.
    pub(crate) fn commit_output(
        &self,
        core: executor::Id,
        sampled_at: u64,
        deadline: u64,
        kind: OutputCommit,
        status: Option<u16>,
        commit: impl FnOnce(),
    ) -> Result<(), executor::Fault> {
        #[cfg(test)]
        if let Some(gate) = self
            .output
            .as_ref()
            .and_then(|h| h.before[kind as usize].as_ref())
        {
            gate.wait();
        }
        let shared = self.shared.upgrade().ok_or(executor::Fault::State)?;
        let mut q = shared.queues();
        if shared.fault().is_some() {
            return Err(executor::Fault::Worker);
        }
        if !shared.running() {
            return Err(executor::Fault::Stale);
        }
        let now = shared.clock.now();
        if now < sampled_at {
            return Err(executor::Fault::Clock);
        }
        if now >= deadline {
            return Err(executor::Fault::Expired);
        }
        let row = q
            .fixed
            .as_mut()
            .and_then(|f| f.row_mut(self.id))
            .ok_or(executor::Fault::State)?;
        if !matches!(row.ownership,RowOwnership::Retained(id) if id==core)
            || row.execution != executor::Execution::MayHaveRun
            || matches!(row.phase, Phase::Terminal(_))
        {
            return Err(executor::Fault::State);
        }
        if row.cancel {
            return Err(executor::Fault::Stale);
        }
        if kind != OutputCommit::MaySend && row.delivery != executor::Delivery::MaySend {
            return Err(executor::Fault::State);
        }
        if !shared.running() {
            return Err(executor::Fault::Stale);
        }
        match kind {
            OutputCommit::MaySend => {
                row.phase = Phase::MaySend;
                row.delivery = executor::Delivery::MaySend;
                row.status = status;
            }
            OutputCommit::Acceptance => (),
            OutputCommit::Completed => {
                row.phase = Phase::Terminal(Terminal::Completed);
                row.delivery = executor::Delivery::Returned;
                row.status = status;
            }
        }
        commit();
        shared.changed.notify_all();
        drop(q);
        #[cfg(test)]
        if let Some(gate) = self
            .output
            .as_ref()
            .and_then(|h| h.after[kind as usize].as_ref())
        {
            gate.wait();
        }
        Ok(())
    }
}
fn settle(shared: &Shared, id: FixedId, proof: executor::Disposed) -> bool {
    let mut q = shared.queues();
    let Some(fixed) = q.fixed.as_mut() else {
        return false;
    };
    let Some(row) = fixed.row_mut(id) else {
        return false;
    };
    let RowOwnership::Retained(core) = row.ownership else {
        return false;
    };
    if !proof.matches(id, core) {
        return false;
    }
    record(row, proof.observation());
    row.ownership = RowOwnership::Disposed(proof);
    fixed.reap();
    shared.changed.notify_all();
    true
}

fn record(row: &mut Row, observation: executor::Observation) {
    row.execution = observation.execution;
    row.delivery = observation.delivery;
    row.status = observation.status;
    row.phase = match observation.state {
        executor::State::Claimed => Phase::Claimed,
        executor::State::Running => Phase::Running,
        executor::State::Ready => {
            if observation.delivery == executor::Delivery::MaySend {
                Phase::MaySend
            } else {
                Phase::Ready
            }
        }
        executor::State::Cancelled => {
            Phase::Terminal(if observation.failure == Some(executor::Fault::Delivery) {
                Terminal::DeliveryUnknown
            } else {
                Terminal::Cancelled
            })
        }
        executor::State::TimedOut => Phase::Terminal(Terminal::TimedOut),
        executor::State::Failed => Phase::Terminal(Terminal::Failed),
        executor::State::Completed => Phase::Terminal(Terminal::Completed),
    };
}

impl State {
    pub(in crate::persistent_supervisor) fn can_start(
        &self,
        occupied: &[Option<[u8; 64]>; 2],
    ) -> bool {
        #[cfg(test)]
        if self.pause_dispatch {
            return false;
        }
        occupied.iter().any(Option::is_none)
            && self.submissions.entries().any(|entry| {
                self.row(entry.submission.id).is_some_and(|r| {
                    r.phase == Phase::Queued
                        && !r.cancel
                        && !occupied.iter().flatten().any(|device| *device == r.device)
                })
            })
    }
}
impl Runtime {
    pub(in crate::persistent_supervisor) fn fixed_cancel_requests(
        &mut self,
        shared: &Shared,
    ) -> crate::supervisor::Result<()> {
        let mut ids = [None; 2];
        {
            let mut q = shared.queues();
            if let Some(fixed) = q.fixed.as_mut() {
                let mut n = 0;
                for row in fixed.rows.iter_mut().flatten() {
                    if let RowOwnership::Retained(id) = row.ownership {
                        if row.cancel && !row.cancel_applied {
                            if n == ids.len() {
                                shared.fail(WorkerFault::InvalidExit);
                                return Err(crate::supervisor::Error::NotExecuted);
                            }
                            row.cancel_applied = true;
                            ids[n] = Some(id);
                            n += 1;
                        }
                    }
                }
            }
        }
        for id in ids.into_iter().flatten() {
            let result = self.authority.cancel_fixed(id);
            self.publish_fixed_readiness(shared);
            if result.is_err() {
                self.authority.abort_in_place();
                shared.fail(WorkerFault::InvalidExit);
                return Err(crate::supervisor::Error::NotExecuted);
            }
        }
        Ok(())
    }
    pub(in crate::persistent_supervisor) fn fixed_copy_progress(
        &mut self,
        shared: &Shared,
    ) -> crate::supervisor::Result<()> {
        let mut entries = [None; 2];
        {
            let q = shared.queues();
            if let Some(fixed) = &q.fixed {
                let mut n = 0;
                for row in fixed.rows.iter().flatten() {
                    if let RowOwnership::Retained(core) = row.ownership {
                        if n == entries.len() {
                            shared.fail(WorkerFault::InvalidExit);
                            return Err(crate::supervisor::Error::NotExecuted);
                        }
                        entries[n] = Some((row.id, core));
                        n += 1;
                    }
                }
            }
        }
        for (id, core) in entries.into_iter().flatten() {
            let Some(observation) = self.authority.observe_fixed(core) else {
                self.authority.abort_in_place();
                shared.fail(WorkerFault::InvalidExit);
                return Err(crate::supervisor::Error::NotExecuted);
            };
            {
                let mut q = shared.queues();
                if let Some(row) = q.fixed.as_mut().and_then(|f| f.row_mut(id)) {
                    record(row, observation);
                }
                shared.changed.notify_all();
            }
            if matches!(
                observation.state,
                executor::State::Cancelled
                    | executor::State::TimedOut
                    | executor::State::Failed
                    | executor::State::Completed
            ) {
                let result = self.authority.dispose_fixed_owned(core, self.clock.now());
                self.publish_fixed_readiness(shared);
                match result {
                    Ok(executor::Disposal::Pending) => (),
                    Ok(executor::Disposal::Done(proof)) => {
                        if !settle(shared, id, proof) {
                            self.authority.abort_in_place();
                            shared.fail(WorkerFault::InvalidExit);
                            return Err(crate::supervisor::Error::NotExecuted);
                        }
                    }
                    _ => {
                        self.authority.abort_in_place();
                        shared.fail(WorkerFault::InvalidExit);
                        return Err(crate::supervisor::Error::NotExecuted);
                    }
                }
            }
        }
        Ok(())
    }
    pub(in crate::persistent_supervisor) fn fixed_start_one(&mut self, shared: &Arc<Shared>) {
        let occupied = self.authority.fixed_owner_occupancy();
        let selected = {
            let mut q = shared.queues();
            if !shared.running() {
                return;
            }
            let Some(fixed) = q.fixed.as_mut() else {
                return;
            };
            let ticket = fixed.submissions.visit();
            let entry = fixed.submissions.get(ticket).copied();
            #[cfg(test)]
            if let Some(fair) = fixed.park_hooks().and_then(|h| h.fair.clone()) {
                fair.record(ticket.slot, entry.map(|e| e.submission.id));
            }
            #[cfg(test)]
            if fixed.pause_dispatch {
                return;
            }
            let Some(entry) = entry else { return };
            let Some(row) = fixed.row(entry.submission.id) else {
                fixed.submissions.take(ticket, entry.submission.id);
                return;
            };
            if row.phase != Phase::Queued {
                fixed.submissions.take(ticket, entry.submission.id);
                return;
            }
            if row.cancel
                || occupied.iter().all(Option::is_some)
                || occupied
                    .iter()
                    .flatten()
                    .any(|device| *device == entry.device)
            {
                return;
            }
            let selected = (
                row.id,
                row.token.clone(),
                row.target,
                entry.submission.outcome,
            );
            // Exact ticket and row ID are checked before either row mutation or removal.
            if fixed.submissions.take(ticket, row.id).is_none() {
                shared.fail(WorkerFault::InvalidExit);
                return;
            }
            let row = fixed.row_mut(selected.0).unwrap();
            row.phase = Phase::Starting;
            row.ownership = RowOwnership::Starting;
            Some(selected)
        };
        let Some((id, token, target, outcome)) = selected else {
            return;
        };
        let outcome = match outcome {
            FixedOutcome::Success => executor::Outcome::Success,
            FixedOutcome::Unavailable => executor::Outcome::Unavailable,
            FixedOutcome::Timeout => executor::Outcome::Timeout,
        };
        let binding = OwnerBinding::new(id, shared);
        #[cfg(test)]
        let test = shared
            .queues()
            .fixed
            .as_mut()
            .and_then(|f| f.row_mut(id))
            .and_then(|r| r.test.take())
            .unwrap_or_default();
        #[cfg(test)]
        let result = self.authority.start_fixed_owned_test(
            token,
            target,
            test.outcome.unwrap_or(outcome),
            &self.clock,
            binding,
            test.core,
        );
        #[cfg(not(test))]
        let result = self
            .authority
            .start_fixed_owned(token, target, outcome, &self.clock, binding);
        self.publish_fixed_readiness(shared);
        self.reconcile(shared);
        match result {
            Ok(_) | Err(executor::StartFailure::BeginRefused { .. }) => (),
            Err(executor::StartFailure::NotClaimed(fault)) => {
                let reason = match fault {
                    executor::Fault::Full => NotClaimed::Full,
                    executor::Fault::Spawn => NotClaimed::Spawn,
                    executor::Fault::Expired => NotClaimed::Expired,
                    _ => NotClaimed::Stale,
                };
                let mut q = shared.queues();
                if let Some(fixed) = q.fixed.as_mut() {
                    if let Some(row) = fixed.row_mut(id) {
                        row.phase = Phase::Terminal(Terminal::NotClaimed(if row.cancel {
                            NotClaimed::Cancelled
                        } else {
                            reason
                        }));
                        row.ownership = RowOwnership::Unclaimed(Unclaimed);
                    }
                    fixed.reap();
                }
            }
            Err(executor::StartFailure::Dirty(_)) => {
                {
                    let mut q = shared.queues();
                    if let Some(row) = q.fixed.as_mut().and_then(|f| f.row_mut(id)) {
                        row.phase = Phase::Terminal(Terminal::Failed);
                        row.ownership = RowOwnership::DirtyPending;
                    }
                }
                self.authority.abort_in_place();
                shared.fail(WorkerFault::InvalidExit);
            }
        }
        shared.changed.notify_all();
    }
}

#[cfg(test)]
#[derive(Default)]
pub(crate) struct TestHooks {
    pub core: executor::Hooks,
    pub before_begin: Option<Arc<executor::ExitGate>>,
    pub outcome: Option<executor::Outcome>,
    pub output: Option<Arc<OutputHooks>>,
}
#[cfg(test)]
#[derive(Default)]
pub(crate) struct OutputHooks {
    pub before: [Option<Arc<executor::ExitGate>>; 3],
    pub after: [Option<Arc<executor::ExitGate>>; 3],
    pub hold_emit: AtomicBool,
    pub hold_consume: AtomicBool,
    pub delay_return: AtomicBool,
    pub fail_seal: bool,
    pub fragment: bool,
    pub verification_peer: Mutex<Option<crate::channel::Channel>>,
    pub maintenance: [Option<Arc<executor::ExitGate>>; 2],
    pub after_begin: Option<Arc<executor::ExitGate>>,
}
#[cfg(test)]
impl OwnerBinding {
    pub(crate) fn output_hooks(&self) -> Option<&OutputHooks> {
        self.output.as_deref()
    }

    pub(crate) fn wait_before_begin(&self) {
        if let Some(gate) = &self.before {
            gate.wait();
        }
    }
    pub(crate) fn record_probe(&self, probe: executor::Probe) {
        if let Some(shared) = self.shared.upgrade() {
            if let Some(row) = shared
                .queues()
                .fixed
                .as_mut()
                .and_then(|f| f.row_mut(self.id))
            {
                row.probe = Some(probe);
            }
        }
    }
}
#[cfg(test)]
impl FixedOwnerClient {
    pub(crate) fn pause_dispatch(&self, paused: bool) {
        let shared = self.0.upgrade().unwrap();
        shared.queues().fixed.as_mut().unwrap().pause_dispatch = paused;
        shared.notify_work();
    }
    pub(crate) fn configure(&self, id: FixedId, test: TestHooks) {
        let shared = self.0.upgrade().unwrap();
        let mut q = shared.queues();
        let row = q.fixed.as_mut().unwrap().row_mut(id).unwrap();
        assert_eq!(row.phase, Phase::Prepared);
        row.test = Some(test);
    }
    pub(crate) fn probe(&self, id: FixedId) -> executor::Probe {
        let shared = self.0.upgrade().unwrap();
        let q = shared.queues();
        q.fixed
            .as_ref()
            .unwrap()
            .row(id)
            .unwrap()
            .probe
            .as_ref()
            .unwrap()
            .clone()
    }
}

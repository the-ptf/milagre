//! Authority-owned registration and atomic pre-Begin output preparation.
use super::*;
pub(crate) use crate::tracked_output::TargetId;
use crate::{
    http_dispatch, phone,
    supervisor::{Limits as MailboxLimits, MemoryCarrier},
    tracked_output::Grant,
};
pub(super) const REGISTRATION_BYTES: usize = 4096;
pub(super) const SCRATCH_BYTES: usize = 65_536;
pub(super) const PACKET_BYTES: usize = 1536;
pub(super) const RECEIPT_BYTES: usize = 2048;
pub(super) const TRACKED_BYTES: usize =
    EXECUTION_BYTES + METADATA_BYTES + SCRATCH_BYTES + PACKET_BYTES + RECEIPT_BYTES;
pub(super) struct Target {
    id: TargetId,
    pub(super) handle: Handle,
    pub(super) memory: MemoryCarrier,
    limits: MailboxLimits,
    _lease: Reservation,
}
impl Drop for Target {
    fn drop(&mut self) {
        self.memory.close();
    }
}
pub(super) struct Tracked {
    pub(super) grant: Option<Grant>,
    memory: MemoryCarrier,
    clock: Clock,
    encoded: [Vec<u8>; 3],
    scratch: Option<Reservation>,
    packet: Option<Reservation>,
    _receipt: Reservation,
    sender: Option<crate::tracked_output::ReturnSender>,
    receiver: crate::tracked_output::ReturnReceiver,
    returned: Option<crate::tracked_output::ReturnedCredit>,
    may_send: bool,
    packet_issued: bool,
    consume_attempted: bool,
    wake: Option<crate::persistent_supervisor::wake::WakeToken>,
    #[cfg(test)]
    fail_seal: bool,
    #[cfg(test)]
    delay_receipt: bool,
}
fn encode(id: i64, status: u16) -> std::result::Result<Vec<u8>, Fault> {
    let outcome = match status {
        200 => http_dispatch::Outcome::Response {
            status,
            headers: phone::Headers::new(),
            body: Vec::new(),
        },
        502 => http_dispatch::Outcome::Unavailable,
        _ => http_dispatch::Outcome::Timeout,
    };
    let response = http_dispatch::response(id, outcome).map_err(|_| Fault::State)?;
    let mut parts = phone::response_parts(&response).map_err(|_| Fault::State)?;
    let plain = parts.pop().ok_or(Fault::State)?;
    if !parts.is_empty() || plain.len() > 999 {
        return Err(Fault::Full);
    }
    Ok(plain)
}
impl PersistentAuthority {
    pub(crate) fn inspect_fixed_peer(
        &mut self,
        target: TargetId,
        handle: &Handle,
    ) -> std::result::Result<crate::budget::ConnectionBudget, Fault> {
        let result = (|| {
            self.check_registry().map_err(|_| Fault::Stale)?;
            let registered = self
                .fixed
                .targets
                .iter()
                .flatten()
                .find(|t| t.id == target && t.handle.same(handle))
                .ok_or(Fault::Stale)?;
            if !registered.memory.fixed_cleanup_healthy() {
                return Err(Fault::Worker);
            }
            if self
                .fixed
                .entries
                .iter()
                .flatten()
                .any(|e| e.permit.handle().same(handle))
            {
                return Err(Fault::Full);
            }
            let map = |e| {
                if e == crate::Error::Budget {
                    Fault::Full
                } else {
                    Fault::Stale
                }
            };
            let (budget, access) = self
                .registry
                .as_mut()
                .unwrap()
                .fixed_peer_budget(handle)
                .map_err(|e| match e {
                    registry::RegistryError::Protocol(e) => map(e),
                    _ => Fault::Stale,
                })?;
            access
                .with(|| registered.memory.inspect_fixed_peer(target, &access))
                .map_err(map)?;
            Ok(budget)
        })();
        let poisoned = self
            .fixed
            .targets
            .iter()
            .flatten()
            .any(|t| t.id == target && !t.memory.fixed_cleanup_healthy());
        self.reconcile_bound();
        if poisoned || matches!(result, Err(Fault::Worker)) || self.fixed.failed {
            self.abort_in_place();
            return Err(Fault::Worker);
        }
        result
    }
    pub(crate) fn register_fixed_carrier(
        &mut self,
        handle: &Handle,
        memory: MemoryCarrier,
        limits: MailboxLimits,
    ) -> std::result::Result<TargetId, Fault> {
        let result = self.register_fixed_target(handle, memory, limits, None);
        self.reconcile_bound();
        result
    }
    pub(crate) fn adopt_fixed_carrier(
        &mut self,
        bound: crate::persistent_supervisor::fixed::BoundMailbox,
        limits: MailboxLimits,
    ) -> std::result::Result<TargetId, Fault> {
        let (handle, memory, scope) = bound.into_parts();
        let result = self.register_fixed_target(&handle, memory, limits, Some(scope));
        self.reconcile_bound();
        result
    }
    fn register_fixed_target(
        &mut self,
        handle: &Handle,
        memory: MemoryCarrier,
        limits: MailboxLimits,
        service_scope: Option<Arc<()>>,
    ) -> std::result::Result<TargetId, Fault> {
        self.check_registry().map_err(|_| Fault::Stale)?;
        self.fixed.cancel_closed();
        if self.fixed.failed {
            return Err(Fault::Worker);
        }
        if limits.carrier_frames == 0
            || limits.carrier_bytes < 1024
            || limits.carrier_frames > 256
            || limits.carrier_bytes > 32 * 1024 * 1024
        {
            return Err(Fault::Full);
        }
        if self
            .fixed
            .targets
            .iter()
            .flatten()
            .any(|t| t.handle.same(handle))
        {
            return Err(Fault::Stale);
        }
        let index = self
            .fixed
            .targets
            .iter()
            .position(Option::is_none)
            .ok_or(Fault::Full)?;
        let serial = self.fixed.next_target.checked_add(1).ok_or(Fault::Full)?;
        let registry = self.registry.as_mut().unwrap();
        let (budget, access) = if service_scope.is_some() {
            registry.fixed_registration_empty(handle)
        } else {
            registry.fixed_registration(handle)
        }
        .map_err(|e| {
            if matches!(e, registry::RegistryError::Protocol(crate::Error::Budget)) {
                Fault::Full
            } else {
                Fault::Stale
            }
        })?;
        let lease = budget
            .reserve(REGISTRATION_BYTES)
            .map_err(|_| Fault::Full)?;
        // Inline entries, mailbox/Arc and fence ledger must fit the fixed registration allowance.
        if std::mem::size_of::<Target>() + crate::supervisor::fixed_mailbox_bookkeeping() + 256
            > REGISTRATION_BYTES
        {
            return Err(Fault::Full);
        }
        let id = TargetId {
            authority: self.core.as_ref().unwrap().instance,
            generation: handle.generation(),
            serial,
        };
        let bound = if let Some(scope) = service_scope {
            memory.adopt_fixed(access, id, handle, &scope)
        } else {
            memory.bind_fixed(access, id)
        };
        bound.map_err(|e| {
            if e == crate::Error::Budget {
                Fault::Full
            } else {
                Fault::Stale
            }
        })?;
        self.fixed.targets[index] = Some(Target {
            id,
            handle: handle.clone(),
            memory,
            limits,
            _lease: lease,
        });
        self.fixed.next_target = serial;
        Ok(id)
    }
    pub(crate) fn start_fixed_tracked(
        &mut self,
        token: WorkToken,
        target: TargetId,
        outcome: Outcome,
        clock: &Clock,
    ) -> std::result::Result<Id, Fault> {
        self.start_fixed_prepared(token, outcome, clock, Hooks::default(), Some(target))
    }
    pub(super) fn prepare_fixed_output(
        &mut self,
        token: &WorkToken,
        target: TargetId,
        serial: u64,
        clock: &Clock,
        mut prepaid: Reservation,
        wake: Option<crate::persistent_supervisor::wake::WakeToken>,
    ) -> std::result::Result<Tracked, Fault> {
        let target = self
            .fixed
            .targets
            .iter()
            .flatten()
            .find(|t| t.id == target && t.handle.same(token.handle()))
            .ok_or(Fault::Stale)?;
        let encoded = [
            encode(token.id(), 200)?,
            encode(token.id(), 502)?,
            encode(token.id(), 504)?,
        ];
        let capacity = encoded
            .iter()
            .try_fold(0usize, |n, v| n.checked_add(v.capacity()))
            .ok_or(Fault::Full)?;
        // Leave explicit headroom for codec containers, crypto and verification temporaries.
        if capacity.checked_add(16 * 1024).ok_or(Fault::Full)? > SCRATCH_BYTES {
            return Err(Fault::Full);
        }
        let grant = Grant::new(target.id, serial);
        target
            .memory
            .reserve_fixed(grant.0.clone(), target.limits)
            .map_err(|e| {
                if e == crate::Error::Budget {
                    Fault::Full
                } else {
                    Fault::Stale
                }
            })?;
        self.registry
            .as_mut()
            .unwrap()
            .reserve_fixed_output(token, grant.0.clone(), clock.now())
            .map_err(|_| Fault::Full)?;
        let scratch = prepaid.split(SCRATCH_BYTES).map_err(|_| Fault::Full)?;
        let packet = prepaid.split(PACKET_BYTES).map_err(|_| Fault::Full)?;
        let (sender, receiver) = crate::tracked_output::receipt_cell();
        Ok(Tracked {
            grant: Some(grant),
            memory: target.memory.clone(),
            clock: clock.clone(),
            encoded,
            scratch: Some(scratch),
            packet: Some(packet),
            _receipt: prepaid,
            sender: Some(sender),
            receiver,
            returned: None,
            may_send: false,
            packet_issued: false,
            consume_attempted: false,
            wake,
            #[cfg(test)]
            fail_seal: false,
            #[cfg(test)]
            delay_receipt: false,
        })
    }
}

impl Tracked {
    fn plain_index(status: u16) -> usize {
        match status {
            200 => 0,
            502 => 1,
            _ => 2,
        }
    }
    fn collect_return(&mut self, force: bool) {
        #[cfg(test)]
        if self.delay_receipt && !force {
            return;
        }
        #[cfg(not(test))]
        let _ = force;
        if self.returned.is_none() {
            self.returned = self.receiver.try_recv().ok();
        }
    }
    fn release_output(&mut self) {
        self.encoded = Default::default();
        drop(self.scratch.take());
        drop(self.packet.take());
        drop(self.sender.take());
        drop(self.wake.take());
        drop(self.grant.take());
    }
    pub(super) fn cancel_output(&mut self) -> bool {
        if self.may_send {
            self.memory.close();
        }
        self.collect_return(true);
        let healthy =
            self.memory.fixed_cleanup_healthy() && (!self.packet_issued || self.returned.is_some());
        self.release_output();
        healthy
    }
}
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Accepted {
    pub(crate) request_id: i64,
    pub(crate) status: u16,
}
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum OutputProgress {
    AwaitingReturn,
    Completed(Accepted),
}
fn registry_fault(
    registry: &registry::Registry,
    permit: &Permit,
    at: u64,
    error: registry::RegistryError,
) -> Fault {
    if matches!(error, registry::RegistryError::Revoked) && registry.claim_expired(permit, at) {
        return Fault::Expired;
    }

    match error {
        registry::RegistryError::Protocol(crate::Error::Timeout) => Fault::Expired,
        registry::RegistryError::Revoked => Fault::Stale,
        registry::RegistryError::Time => Fault::Clock,
        _ => Fault::Delivery,
    }
}
fn wire_fault(fault: Fault) -> crate::Error {
    if fault == Fault::Expired {
        crate::Error::Timeout
    } else {
        crate::Error::Unauthorized
    }
}
fn fail_output(observation: &mut Observation, signal: &Signal, fault: Fault) {
    if observation.state == State::Completed {
        return;
    }
    signal.cancel();
    if !matches!(
        observation.state,
        State::Cancelled | State::TimedOut | State::Failed
    ) {
        observation.state = match fault {
            Fault::Expired => State::TimedOut,
            Fault::Worker | Fault::Clock | Fault::State => State::Failed,
            _ => State::Cancelled,
        };
        observation.failure = Some(fault);
    }
    if observation.delivery == Delivery::MaySend {
        observation.delivery = Delivery::Unknown;
    }
}
impl PersistentAuthority {
    pub(super) fn reconcile_fixed_output(&mut self, now: u64) {
        let Some(registry) = self.registry.as_mut() else {
            return;
        };
        for entry in self.fixed.entries.iter_mut().flatten() {
            let Some(t) = &mut entry.tracked else {
                continue;
            };
            if t.grant.is_none() {
                continue;
            }
            let at = now.max(t.clock.now());
            if !matches!(
                entry.observation.state,
                State::Cancelled | State::TimedOut | State::Failed
            ) {
                #[cfg(test)]
                let delayed = entry
                    .owner
                    .as_ref()
                    .and_then(OwnerBinding::output_hooks)
                    .is_some_and(|h| h.delay_return.load(Ordering::SeqCst));
                #[cfg(not(test))]
                let delayed = false;
                if !delayed {
                    t.collect_return(false);
                }
                if let Some(receipt) = &t.returned {
                    let mut precise = None;
                    let result = if receipt.accepted()
                        && entry.joined.is_some()
                        && entry.observation.state == State::Ready
                    {
                        registry
                            .claim_deadline_barrier(&entry.permit, at, |deadline| {
                                let deadline = deadline.min(entry.completion_deadline);
                                let mut commit = || {
                                    entry.observation.state = State::Completed;
                                    entry.observation.delivery = Delivery::Returned;
                                };
                                if let Some(owner) = &entry.owner {
                                    owner
                                        .commit_output(
                                            entry.id,
                                            at,
                                            deadline,
                                            crate::persistent_supervisor::fixed::OutputCommit::Completed,
                                            entry.observation.status,
                                            commit,
                                        )
                                        .map_err(|fault| {
                                            precise = Some(fault);
                                            wire_fault(fault)
                                        })
                                } else if t.clock.now() >= deadline {
                                    Err(crate::Error::Timeout)
                                } else {
                                    commit();
                                    Ok(())
                                }
                            })
                            .map_err(|error| registry_fault(registry, &entry.permit, t.clock.now(), error))
                    } else {
                        Err(Fault::Delivery)
                    };
                    match result {
                        Ok(()) => {
                            registry.end_claim(
                                &entry.permit,
                                registry::WorkStatus::Completed,
                                t.clock.now(),
                            );
                            t.release_output();
                            continue;
                        }
                        Err(fault) => fail_output(
                            &mut entry.observation,
                            &entry.worker.signal,
                            precise.unwrap_or(fault),
                        ),
                    }
                }
            }
            if matches!(
                entry.observation.state,
                State::Cancelled | State::TimedOut | State::Failed
            ) {
                if matches!(
                    entry.observation.failure,
                    Some(Fault::Worker | Fault::Clock | Fault::State)
                ) {
                    self.fixed.failed = true;
                }
                if t.may_send {
                    registry.discard_claim_output(
                        &entry.permit,
                        if entry.observation.state == State::TimedOut {
                            registry::WorkStatus::TimedOut
                        } else {
                            registry::WorkStatus::Cancelled
                        },
                    );
                }
                if !t.cancel_output() {
                    self.fixed.failed = true;
                }
            }
        }
        self.fixed.cancel_closed();
    }
    pub(crate) fn fixed_delivery_entries(&self) -> [Option<(Id, TargetId)>; 2] {
        std::array::from_fn(|i| {
            self.fixed.entries[i].as_ref().and_then(|e| {
                let t = e.tracked.as_ref()?;
                (e.owner.is_some() && e.observation.state == State::Ready)
                    .then(|| (e.id, t.grant.as_ref().unwrap().0.target))
            })
        })
    }
    #[cfg(test)]
    pub(crate) fn fixed_output_held(&self, id: Id, consume: bool) -> bool {
        self.fixed
            .entry(id)
            .and_then(|e| e.owner.as_ref())
            .and_then(OwnerBinding::output_hooks)
            .is_some_and(|h| {
                if consume {
                    h.hold_consume.load(Ordering::SeqCst)
                } else {
                    h.hold_emit.load(Ordering::SeqCst)
                }
            })
    }
    #[cfg(test)]
    pub(crate) fn fixed_test_peer(&self, id: Id) -> Option<crate::channel::Channel> {
        self.fixed
            .entry(id)
            .and_then(|e| e.owner.as_ref())
            .and_then(OwnerBinding::output_hooks)
            .and_then(|h| h.verification_peer.lock().unwrap().take())
    }
    pub(crate) fn emit_fixed(&mut self, id: Id) -> std::result::Result<(), Fault> {
        let now = self
            .fixed
            .entry(id)
            .and_then(|e| e.tracked.as_ref())
            .ok_or(Fault::Stale)?
            .clock
            .now();
        self.poll_fixed(now)?;
        let now = self
            .fixed
            .entry(id)
            .and_then(|e| e.tracked.as_ref())
            .ok_or(Fault::Stale)?
            .clock
            .now();
        let entry = self.fixed.entry_mut(id).ok_or(Fault::Stale)?;
        if entry.joined.is_none() || entry.observation.state != State::Ready {
            return Err(Fault::State);
        }
        let t = entry.tracked.as_mut().ok_or(Fault::State)?;
        if t.may_send || t.grant.is_none() {
            return Err(Fault::State);
        }
        let registry = self.registry.as_mut().unwrap();
        let mut precise = None;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let grant = &t.grant.as_ref().unwrap().0;
            let plain = &t.encoded[Tracked::plain_index(entry.observation.status.unwrap())];
            registry.emit_fixed_claim(
                &entry.permit,
                grant,
                plain,
                t.packet.take().unwrap(),
                t.sender.take().unwrap(),
                t.wake.take(),
                now,
                |deadline| {
                    let deadline = deadline.min(entry.completion_deadline);
                    let mut commit = || {
                        t.may_send = true;
                        entry.observation.delivery = Delivery::MaySend;
                    };
                    if let Some(owner) = &entry.owner {
                        owner
                            .commit_output(
                                entry.id,
                                now,
                                deadline,
                                crate::persistent_supervisor::fixed::OutputCommit::MaySend,
                                entry.observation.status,
                                commit,
                            )
                            .map_err(|fault| {
                                precise = Some(fault);
                                wire_fault(fault)
                            })?;
                    } else if t.clock.now() >= deadline {
                        return Err(crate::Error::Timeout);
                    } else {
                        commit();
                    }
                    #[cfg(test)]
                    if t.fail_seal
                        || entry
                            .owner
                            .as_ref()
                            .and_then(OwnerBinding::output_hooks)
                            .is_some_and(|h| h.fail_seal)
                    {
                        return Err(crate::Error::Authentication);
                    }
                    Ok(())
                },
            )?;
            t.packet_issued = true;
            registry.transfer_fixed_claim(&entry.permit, grant, &t.memory, t.clock.now())
        }));
        let fault = match result {
            Ok(Ok(())) => return Ok(()),
            Ok(Err(error)) => precise
                .unwrap_or_else(|| registry_fault(registry, &entry.permit, t.clock.now(), error)),
            Err(_) => {
                if entry.owner.is_some() {
                    Fault::Worker
                } else {
                    Fault::Delivery
                }
            }
        };
        fail_output(&mut entry.observation, &entry.worker.signal, fault);
        self.reconcile_fixed_output(now);
        if self.fixed.failed {
            self.abort_in_place();
            return Err(Fault::Worker);
        }
        Err(if fault == Fault::Delivery {
            Fault::State
        } else {
            fault
        })
    }
    pub(crate) fn consume_fixed_progress(
        &mut self,
        id: Id,
        peer: &mut crate::channel::Channel,
    ) -> std::result::Result<OutputProgress, Fault> {
        let now = self
            .fixed
            .entry(id)
            .and_then(|e| e.tracked.as_ref())
            .ok_or(Fault::Stale)?
            .clock
            .now();
        self.poll_fixed(now)?;
        let now = self
            .fixed
            .entry(id)
            .and_then(|e| e.tracked.as_ref())
            .ok_or(Fault::Stale)?
            .clock
            .now();
        let entry = self.fixed.entry_mut(id).ok_or(Fault::Stale)?;
        if entry.observation.state == State::Completed {
            return Ok(OutputProgress::Completed(Accepted {
                request_id: entry.permit.id(),
                status: entry.observation.status.unwrap(),
            }));
        }
        if entry.joined.is_none() || entry.observation.state != State::Ready {
            return Err(Fault::State);
        }
        let t = entry.tracked.as_mut().ok_or(Fault::State)?;
        if t.consume_attempted {
            return Ok(OutputProgress::AwaitingReturn);
        }
        if !t.packet_issued || t.grant.is_none() {
            return Err(Fault::State);
        }
        // This prepaid bit is consumed before taking/decrypting the one packet.
        t.consume_attempted = true;
        let mut precise = None;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.registry
                .as_mut()
                .unwrap()
                .claim_deadline_barrier(&entry.permit, now, |deadline| {
                    let mut acceptance = Acceptance::new(
                        entry.owner.as_ref(),
                        entry.id,
                        now,
                        deadline.min(entry.completion_deadline),
                    );
                    let result = t.memory.consume_fixed(
                        &t.grant.as_ref().unwrap().0,
                        peer,
                        &t.encoded[Tracked::plain_index(entry.observation.status.unwrap())],
                        &t.clock,
                        &mut acceptance,
                    );
                    precise = acceptance.fault();
                    result
                })
        }));
        let fault = match result {
            Ok(Ok(())) => None,
            Ok(Err(error)) => Some(precise.unwrap_or_else(|| {
                registry_fault(
                    self.registry.as_ref().unwrap(),
                    &entry.permit,
                    t.clock.now(),
                    error,
                )
            })),
            Err(_) => Some(if entry.owner.is_some() {
                Fault::Worker
            } else {
                Fault::Delivery
            }),
        };
        if let Some(fault) = fault {
            fail_output(&mut entry.observation, &entry.worker.signal, fault);
        }
        self.reconcile_fixed_output(now);
        if self.fixed.failed {
            self.abort_in_place();
            return Err(Fault::Worker);
        }
        let entry = self.fixed.entry(id).unwrap();
        if entry.observation.state == State::Completed {
            Ok(OutputProgress::Completed(Accepted {
                request_id: entry.permit.id(),
                status: entry.observation.status.unwrap(),
            }))
        } else if entry.observation.state == State::Ready {
            Ok(OutputProgress::AwaitingReturn)
        } else {
            Err(fault
                .filter(|f| *f != Fault::Delivery)
                .unwrap_or(Fault::State))
        }
    }
    pub(crate) fn consume_fixed(
        &mut self,
        id: Id,
        peer: &mut crate::channel::Channel,
    ) -> std::result::Result<Accepted, Fault> {
        if self
            .fixed
            .entry(id)
            .is_some_and(|e| e.observation.state == State::Completed)
        {
            return Err(Fault::State);
        }
        match self.consume_fixed_progress(id, peer)? {
            OutputProgress::Completed(accepted) => Ok(accepted),
            OutputProgress::AwaitingReturn => Err(Fault::State),
        }
    }
}

#[cfg(test)]
impl PersistentAuthority {
    pub(in crate::policy::persistent) fn fixed_target_slots(&self) -> usize {
        self.fixed.targets.iter().flatten().count()
    }
    pub(in crate::policy::persistent) fn fixed_scoped_emit(
        &mut self,
        id: Id,
        prepaid: Reservation,
    ) -> registry::Result<()> {
        let e = self.fixed.entry(id).unwrap();
        self.registry
            .as_mut()
            .unwrap()
            .emit_claim(&e.permit, b"null", prepaid, 2, || {
                panic!("competing scoped emission crossed fence")
            })
    }
    pub(in crate::policy::persistent) fn fixed_tracked_hooks(
        &mut self,
        token: WorkToken,
        target: TargetId,
        outcome: Outcome,
        clock: &Clock,
        hooks: Hooks,
    ) -> std::result::Result<Id, Fault> {
        self.start_fixed_prepared(token, outcome, clock, hooks, Some(target))
    }
    pub(in crate::policy::persistent) fn fixed_fail_seal(&mut self, id: Id) {
        self.fixed
            .entry_mut(id)
            .unwrap()
            .tracked
            .as_mut()
            .unwrap()
            .fail_seal = true;
    }
    pub(in crate::policy::persistent) fn fixed_delay_receipt(&mut self, id: Id, delay: bool) {
        self.fixed
            .entry_mut(id)
            .unwrap()
            .tracked
            .as_mut()
            .unwrap()
            .delay_receipt = delay;
    }
    pub(in crate::policy::persistent) fn fixed_returned(&self, id: Id) -> bool {
        self.fixed
            .entry(id)
            .unwrap()
            .tracked
            .as_ref()
            .unwrap()
            .returned
            .is_some()
    }
    pub(in crate::policy::persistent) fn fixed_granted(&self, id: Id) -> bool {
        self.fixed
            .entry(id)
            .unwrap()
            .tracked
            .as_ref()
            .unwrap()
            .grant
            .is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixed_inline_and_arc_bookkeeping_fit_the_pinned_allowances() {
        assert_eq!(TRACKED_BYTES, 2_172_416);
        assert_eq!(TRACKED_BYTES + REGISTRATION_BYTES, 2_176_512);
        assert!(
            std::mem::size_of::<Entry>() + std::mem::size_of::<Signal>() + 128 <= METADATA_BYTES
        );
        assert!(std::mem::size_of::<crate::tracked_output::Packet>() <= 512);
        assert!(
            std::mem::size_of::<Tracked>()
                + std::mem::size_of::<crate::tracked_output::Fence>()
                + 512
                <= RECEIPT_BYTES
        );
        assert!(
            std::mem::size_of::<Target>() + crate::supervisor::fixed_mailbox_bookkeeping() + 256
                <= REGISTRATION_BYTES
        );
    }
}

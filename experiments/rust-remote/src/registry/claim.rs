//! Exclusive work permit for the private fixed-response worker fixture.
use super::*;
pub(crate) const FIXTURE_FRAME: usize = 1024;
#[derive(Debug)]
pub(crate) enum AdmissionError {
    Expired,
    Registry(RegistryError),
}
impl From<RegistryError> for AdmissionError {
    fn from(error: RegistryError) -> Self {
        Self::Registry(error)
    }
}
impl From<Error> for AdmissionError {
    fn from(error: Error) -> Self {
        Self::Registry(error.into())
    }
}
pub(crate) struct ReadyCandidate {
    pub(crate) budget: ConnectionBudget,
    pub(crate) device: [u8; 64],
    pub(crate) deadline: u64,
}
pub(crate) struct ReadyInspection {
    pub(crate) candidate: std::result::Result<ReadyCandidate, AdmissionError>,
    // Expiring the inspected request can promote queued work even when inspection
    // itself refuses. The actor must publish that real readiness after either result.
    pub(crate) promoted: Vec<WorkToken>,
}
/// Constructed only after authoritative claim validation. Never Clone.
pub(crate) struct Permit {
    token: WorkToken,
}
impl Permit {
    pub(crate) fn handle(&self) -> &Handle {
        &self.token.handle
    }
    pub(crate) fn id(&self) -> i64 {
        self.token.id
    }
}
impl Registry {
    pub(crate) fn fixed_peer_budget(
        &mut self,
        handle: &Handle,
    ) -> Result<(ConnectionBudget, crate::policy::Access)> {
        let a = self.active(handle, self.now)?;
        a.session
            .with_access(|| {
                if a.session.device().kind != crate::channel::DeviceKind::Phone {
                    return Err(Error::Unauthorized);
                }
                a.egress_available()?;
                if !a.outbound.is_empty()
                    || a.fixed_packet.is_some()
                    || a.jobs.values().any(|j| j.claimed)
                {
                    return Err(Error::Budget);
                }
                Ok((a.budget(), a.session.access()))
            })
            .map_err(Into::into)
    }
    pub(crate) fn claim_device_key(&mut self, token: &WorkToken, now: u64) -> Result<String> {
        Ok(self.work(token, now)?.session.device().key.clone())
    }
    pub(crate) fn inspect_claim(
        &mut self,
        token: &WorkToken,
        now: u64,
    ) -> std::result::Result<ConnectionBudget, AdmissionError> {
        self.inspect_fixed_claim(token, now, None)
    }
    fn inspect_fixed_claim(
        &mut self,
        token: &WorkToken,
        now: u64,
        fence: Option<&crate::tracked_output::Fence>,
    ) -> std::result::Result<ConnectionBudget, AdmissionError> {
        let inspection = self.inspect_ready_candidate(token, now);
        self.fixed_readiness |= !inspection.promoted.is_empty();
        let ready = inspection.candidate?;
        let limits = self.limits;
        let a = self.active(&token.handle, now)?;
        if !fence.is_some_and(|f| {
            f.active()
                && a.fixed_fence
                    .as_ref()
                    .is_some_and(|current| current.active() && current.same(f))
        }) {
            a.egress_available()?;
        }
        // The scoped authority owner prevents all other producers until output return.
        if !a.outbound.is_empty()
            || limits.outbound_bytes < FIXTURE_FRAME
            || limits.outbound_frames == 0
        {
            return Err(Error::Budget.into());
        }
        Ok(ready.budget)
    }
    pub(crate) fn inspect_ready_candidate(
        &mut self,
        token: &WorkToken,
        now: u64,
    ) -> ReadyInspection {
        let mut promoted = Vec::new();
        let candidate = self.inspect_ready_candidate_inner(token, now, &mut promoted);
        ReadyInspection {
            candidate,
            promoted,
        }
    }
    fn inspect_ready_candidate_inner(
        &mut self,
        token: &WorkToken,
        now: u64,
        promoted: &mut Vec<WorkToken>,
    ) -> std::result::Result<ReadyCandidate, AdmissionError> {
        let limits = self.limits;
        let a = self.active(&token.handle, now)?;
        let Some(job) = a.jobs.get(&token.id) else {
            return Err(if token.status() == WorkStatus::TimedOut {
                AdmissionError::Expired
            } else {
                RegistryError::Revoked.into()
            });
        };
        if job.token.serial != token.serial
            || job.token.status() != WorkStatus::InFlight
            || job.claimed
        {
            return Err(RegistryError::Revoked.into());
        }
        let scheduling = job
            .assembled_at
            .checked_add(20_000)
            .ok_or(Error::Exhausted)?;
        if now >= scheduling || now >= job.deadline {
            a.remove_job(token.id, WorkStatus::TimedOut);
            match a.promote(now, limits) {
                Ok(started) => *promoted = started,
                Err(_) => {
                    self.close(&token.handle, CloseReason::Protocol);
                }
            }
            return Err(AdmissionError::Expired);
        }
        // Opt this candidate into periodic Ready expiry. Reinspection cannot renew it.
        // Uninspected legacy MemoryHttp jobs retain their existing promotion lifetime.
        let job = a.jobs.get_mut(&token.id).unwrap();
        job.deadline = job.deadline.min(scheduling);
        let deadline = job.deadline;
        a.session
            .with_access(|| {
                let mut device = [0u8; 64];
                let key = a.session.device().key.as_bytes();
                if key.len() > device.len() {
                    return Err(Error::TooLarge);
                }
                device[..key.len()].copy_from_slice(key);
                Ok(ReadyCandidate {
                    budget: a.budget(),
                    device,
                    deadline,
                })
            })
            .map_err(Into::into)
    }
    pub(crate) fn claim_work(
        &mut self,
        token: &WorkToken,
        now: u64,
    ) -> std::result::Result<Permit, AdmissionError> {
        self.claim_fixed_work(token, now, None)
    }
    pub(crate) fn claim_fixed_work(
        &mut self,
        token: &WorkToken,
        now: u64,
        fence: Option<&crate::tracked_output::Fence>,
    ) -> std::result::Result<Permit, AdmissionError> {
        self.inspect_fixed_claim(token, now, fence)?;
        let deadline = now.checked_add(345_000).ok_or(Error::Exhausted)?;
        let a = self.work(token, now)?;
        a.session.with_access(|| Ok(()))?;
        a.jobs.get_mut(&token.id).unwrap().claimed = true;
        a.jobs.get_mut(&token.id).unwrap().deadline = deadline;
        Ok(Permit {
            token: token.clone(),
        })
    }
    fn claimed(&mut self, permit: &Permit, now: u64) -> Result<&mut Active> {
        let t = &permit.token;
        let a = self.active(&t.handle, now)?;
        let job = a.jobs.get(&t.id).ok_or(RegistryError::Revoked)?;
        if !job.claimed
            || job.token.serial != t.serial
            || job.token.status() != WorkStatus::InFlight
            || now >= job.deadline
        {
            return Err(RegistryError::Revoked);
        }
        Ok(a)
    }
    pub(crate) fn claim_read_allowed(&self, permit: &Permit, now: u64) -> bool {
        if !self.current(permit.handle()) {
            return false;
        }
        let State::Active(a) = &self.entries[&permit.handle().carrier].state else {
            return false;
        };
        now < a.idle_deadline
            && a.reader.deadline_ms().is_none_or(|deadline| now < deadline)
            && !a.session.is_revoked()
            && a.jobs.get(&permit.token.id).is_some_and(|job| {
                job.claimed && job.token.serial == permit.token.serial && now < job.deadline
            })
    }
    /// Preserve this claim's actual timeout cause after its job or carrier is gone.
    /// Other stale generations and removed sessions do not acquire a timeout cause.
    pub(crate) fn claim_expired(&self, permit: &Permit, now: u64) -> bool {
        let token = &permit.token;
        if token.handle.owner != self.owner || token.handle.binding != self.binding {
            return false;
        }
        if token.status() == WorkStatus::TimedOut
            || matches!(
                token.handle.status(),
                CarrierStatus::Closed(CloseReason::IdleTimeout | CloseReason::FragmentTimeout)
            )
        {
            return true;
        }
        if !self.current(&token.handle) {
            return false;
        }
        let State::Active(active) = &self.entries[&token.handle.carrier].state else {
            return false;
        };
        !active.session.is_revoked()
            && active.jobs.get(&token.id).is_some_and(|job| {
                job.claimed
                    && job.token.serial == token.serial
                    && job.token.status() == WorkStatus::InFlight
                    && now >= effective_claim_deadline(active, permit)
            })
    }
    pub(crate) fn claim_barrier<T>(
        &mut self,
        permit: &Permit,
        now: u64,
        action: impl FnOnce() -> crate::Result<T>,
    ) -> Result<T> {
        self.claim_deadline_barrier(permit, now, |_| action())
    }
    /// Keeps exact claim/session authorization through the caller's bounded commit.
    /// The caller checks a fresh clock after acquiring its commit lock against this
    /// fixed deadline, captured while Registry remains exclusively borrowed.
    pub(crate) fn claim_deadline_barrier<T>(
        &mut self,
        permit: &Permit,
        now: u64,
        consume: impl FnOnce(u64) -> crate::Result<T>,
    ) -> Result<T> {
        let a = self.claimed(permit, now)?;
        let deadline = effective_claim_deadline(a, permit);
        a.session
            .with_access(|| consume(deadline))
            .map_err(Into::into)
    }
    /// Synthetic Registry-state injection for deadline races only. Phone requests
    /// use RequestAssembler and cannot populate this desktop reader on the wire.
    #[cfg(test)]
    pub(crate) fn inject_claim_reader_fragment_for_test(
        &mut self,
        permit: &Permit,
        now: u64,
    ) -> Result<u64> {
        let a = self.claimed(permit, now)?;
        a.session
            .with_access(|| {
                a.reader
                    .read(br#"{"t":"part","id":1,"i":0,"n":2,"data":"eA=="}"#, now)?;
                a.reader.deadline_ms().ok_or(Error::BadPart)
            })
            .map_err(Into::into)
    }
    pub(crate) fn emit_claim(
        &mut self,
        permit: &Permit,
        plain: &[u8],
        mut prepaid: Reservation,
        now: u64,
        may_send: impl FnOnce() -> crate::Result<()>,
    ) -> Result<()> {
        if plain.len() + 25 > FIXTURE_FRAME {
            return Err(Error::TooLarge.into());
        }
        let a = self.claimed(permit, now)?;
        a.egress_available()?;
        if !a.outbound.is_empty() {
            return Err(Error::Budget.into());
        }
        let frame_lease = prepaid.split(FIXTURE_FRAME + 512)?;
        // Mark MaySend under the same final authorization guard as encryption.
        let bytes = a.session.seal_after(plain, may_send)?;
        a.outbound_bytes += bytes.len();
        a.outbound.push_back(Bytes {
            bytes,
            _lease: frame_lease,
        });
        Ok(())
    }
    /// A sealed frame cannot be skipped: the peer requires consecutive counters.
    /// Preserve this work's terminal status without promoting work on a broken carrier.
    pub(crate) fn discard_claim_output(&mut self, permit: &Permit, status: WorkStatus) {
        if !self.current(permit.handle()) {
            return;
        }
        if let State::Active(a) = &mut self
            .entries
            .get_mut(&permit.handle().carrier)
            .unwrap()
            .state
        {
            if a.jobs
                .get(&permit.token.id)
                .is_some_and(|job| job.claimed && job.token.serial == permit.token.serial)
            {
                a.remove_job(permit.token.id, status);
            }
        }
        self.close(permit.handle(), CloseReason::CarrierFailure);
    }
    pub(crate) fn end_claim(&mut self, permit: &Permit, status: WorkStatus, now: u64) {
        let limits = self.limits;
        if !self.current(permit.handle()) {
            return;
        }
        let mut failed = false;
        let mut promoted = false;
        if let State::Active(a) = &mut self
            .entries
            .get_mut(&permit.handle().carrier)
            .unwrap()
            .state
        {
            if a.jobs
                .get(&permit.token.id)
                .is_some_and(|job| job.claimed && job.token.serial == permit.token.serial)
            {
                a.remove_job(permit.token.id, status);
                match a.promote(now, limits) {
                    Ok(started) => promoted = !started.is_empty(),
                    Err(_) => failed = true,
                }
            }
        }
        self.fixed_readiness |= promoted;
        if failed {
            self.close(permit.handle(), CloseReason::Protocol);
        }
    }
}

impl Registry {
    /// Transfers a coalesced notification of actual fixed-path promotion. Refusal,
    /// observation and unrelated operations do not clear it.
    pub(crate) fn take_fixed_readiness(&mut self) -> bool {
        std::mem::take(&mut self.fixed_readiness)
    }
    /// Classify only this current session's live fence. This does not export output
    /// or relax the ordinary producer/export checks.
    pub(crate) fn fixed_egress(&mut self, handle: &Handle, now: u64) -> Result<FixedEgress> {
        let active = self.active(handle, now)?;
        active
            .session
            .with_access(|| {
                Ok(
                    if active.fixed_fence.as_ref().is_some_and(|fence| {
                        fence.active() && fence.target.generation == handle.generation
                    }) {
                        FixedEgress::TrackedFence
                    } else {
                        FixedEgress::Ordinary
                    },
                )
            })
            .map_err(Into::into)
    }
    pub(crate) fn fixed_registration(
        &mut self,
        handle: &Handle,
    ) -> Result<(ConnectionBudget, crate::policy::Access)> {
        let a = self.active(handle, self.now)?;
        a.session
            .with_access(|| Ok((a.budget(), a.session.access())))
            .map_err(Into::into)
    }
    pub(crate) fn reserve_fixed_output(
        &mut self,
        token: &WorkToken,
        fence: Arc<crate::tracked_output::Fence>,
        now: u64,
    ) -> Result<()> {
        if fence.target.generation != token.handle().generation() {
            return Err(RegistryError::Revoked);
        }
        let limits = self.limits;
        let a = self.work(token, now)?;
        a.egress_available()?;
        if !a.outbound.is_empty()
            || limits.outbound_frames == 0
            || limits.outbound_bytes < FIXTURE_FRAME
        {
            return Err(Error::Budget.into());
        }
        a.fixed_fence = Some(fence);
        Ok(())
    }
}

impl Registry {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn emit_fixed_claim(
        &mut self,
        permit: &Permit,
        fence: &crate::tracked_output::Fence,
        plain: &[u8],
        lease: Reservation,
        returned: crate::tracked_output::ReturnSender,
        wake: Option<crate::persistent_supervisor::wake::WakeToken>,
        now: u64,
        may_send: impl FnOnce(u64) -> crate::Result<()>,
    ) -> Result<()> {
        if plain.len() > FIXTURE_FRAME - 25 {
            return Err(Error::TooLarge.into());
        }
        let a = self.claimed(permit, now)?;
        if !fence.active()
            || !a
                .fixed_fence
                .as_ref()
                .is_some_and(|f| f.active() && f.same(fence))
            || a.fixed_packet.is_some()
            || !a.outbound.is_empty()
        {
            return Err(Error::Budget.into());
        }
        let deadline = effective_claim_deadline(a, permit);
        let bytes = a.session.seal_after(plain, || may_send(deadline))?;
        if bytes.capacity() > FIXTURE_FRAME {
            return Err(Error::TooLarge.into());
        }
        a.fixed_packet = Some(crate::tracked_output::Packet::new(
            bytes, lease, returned, wake,
        ));
        Ok(())
    }
    pub(crate) fn transfer_fixed_claim(
        &mut self,
        permit: &Permit,
        fence: &crate::tracked_output::Fence,
        memory: &crate::supervisor::MemoryCarrier,
        now: u64,
    ) -> Result<()> {
        let a = self.claimed(permit, now)?;
        if !fence.active()
            || !a
                .fixed_fence
                .as_ref()
                .is_some_and(|f| f.active() && f.same(fence))
        {
            return Err(Error::Budget.into());
        }
        let packet = a.fixed_packet.take().ok_or(Error::Unauthorized)?;
        a.session
            .with_access(|| memory.deliver_fixed(fence, packet))
            .map_err(Into::into)
    }
}

fn effective_claim_deadline(active: &Active, permit: &Permit) -> u64 {
    active.jobs[&permit.token.id]
        .deadline
        .min(active.idle_deadline)
        .min(active.reader.deadline_ms().unwrap_or(u64::MAX))
}

#[cfg(test)]
#[path = "claim_deadline_tests.rs"]
mod claim_deadline_tests;

impl Registry {
    pub(crate) fn fixed_registration_empty(
        &mut self,
        handle: &Handle,
    ) -> Result<(ConnectionBudget, crate::policy::Access)> {
        let a = self.active(handle, self.now)?;
        a.egress_available()?;
        if !a.outbound.is_empty() || a.fixed_packet.is_some() {
            return Err(Error::Budget.into());
        }
        a.session
            .with_access(|| Ok((a.budget(), a.session.access())))
            .map_err(Into::into)
    }
}

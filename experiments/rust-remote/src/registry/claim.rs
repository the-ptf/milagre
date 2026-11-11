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
    pub(crate) fn inspect_claim(
        &mut self,
        token: &WorkToken,
        now: u64,
    ) -> std::result::Result<ConnectionBudget, AdmissionError> {
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
            let failed = a.promote(now, limits).is_err();
            if failed {
                self.close(&token.handle, CloseReason::Protocol);
            }
            return Err(AdmissionError::Expired);
        }
        // Opt this candidate into periodic Ready expiry. Reinspection cannot renew it.
        // Uninspected legacy MemoryHttp jobs retain their existing promotion lifetime.
        let job = a.jobs.get_mut(&token.id).unwrap();
        job.deadline = job.deadline.min(scheduling);
        // The scoped authority owner prevents all other producers until output return.
        if !a.outbound.is_empty()
            || limits.outbound_bytes < FIXTURE_FRAME
            || limits.outbound_frames == 0
        {
            return Err(Error::Budget.into());
        }
        a.session.with_access(|| Ok(a.budget())).map_err(Into::into)
    }
    pub(crate) fn claim_work(
        &mut self,
        token: &WorkToken,
        now: u64,
    ) -> std::result::Result<Permit, AdmissionError> {
        self.inspect_claim(token, now)?;
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
    pub(crate) fn claim_barrier<T>(
        &mut self,
        permit: &Permit,
        now: u64,
        action: impl FnOnce() -> crate::Result<T>,
    ) -> Result<T> {
        self.claimed(permit, now)?
            .session
            .with_access(action)
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
    pub(crate) fn end_claim(&mut self, permit: &Permit, status: WorkStatus, now: u64) {
        let limits = self.limits;
        if !self.current(permit.handle()) {
            return;
        }
        let mut failed = false;
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
                failed = a.promote(now, limits).is_err();
            }
        }
        if failed {
            self.close(permit.handle(), CloseReason::Protocol);
        }
    }
}

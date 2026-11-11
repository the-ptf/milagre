//! Exact private evidence passed back to the consuming owner row after actual disposal.
use super::*;
use crate::persistent_supervisor::fixed::{FixedId, OwnerBinding};

/// Constructed only by the core under the actual Registry claim barrier.
pub(crate) struct Acceptance<'a> {
    owner: Option<&'a OwnerBinding>,
    core: Id,
    sampled_at: u64,
    deadline: u64,
    fault: Option<Fault>,
}
impl<'a> Acceptance<'a> {
    pub(super) fn new(
        owner: Option<&'a OwnerBinding>,
        core: Id,
        sampled_at: u64,
        deadline: u64,
    ) -> Self {
        Self {
            owner,
            core,
            sampled_at,
            deadline,
            fault: None,
        }
    }
    pub(crate) fn deadline(&self) -> u64 {
        self.deadline
    }
    pub(super) fn fault(&self) -> Option<Fault> {
        self.fault
    }
    pub(crate) fn commit(&mut self, commit: impl FnOnce()) -> crate::Result<()> {
        if let Some(owner) = self.owner {
            owner
                .commit_output(
                    self.core,
                    self.sampled_at,
                    self.deadline,
                    crate::persistent_supervisor::fixed::OutputCommit::Acceptance,
                    None,
                    commit,
                )
                .map_err(|fault| {
                    self.fault = Some(fault);
                    if fault == Fault::Expired {
                        crate::Error::Timeout
                    } else {
                        crate::Error::Unauthorized
                    }
                })
        } else {
            commit();
            Ok(())
        }
    }
}

pub(crate) struct Disposed {
    owner: FixedId,
    core: Id,
    observation: Observation,
}
impl Disposed {
    pub(super) fn new(owner: FixedId, core: Id, observation: Observation) -> Self {
        Self {
            owner,
            core,
            observation,
        }
    }
    pub(crate) fn matches(&self, owner: FixedId, core: Id) -> bool {
        self.owner == owner && self.core == core
    }
    pub(crate) fn observation(&self) -> Observation {
        self.observation
    }
}
pub(crate) enum Disposal {
    Pending,
    Done(Disposed),
}

impl PersistentAuthority {
    pub(crate) fn start_fixed_owned(
        &mut self,
        token: WorkToken,
        target: TargetId,
        outcome: Outcome,
        clock: &Clock,
        owner: OwnerBinding,
    ) -> std::result::Result<Id, StartFailure> {
        self.start_fixed_bound(
            token,
            outcome,
            clock,
            Hooks::default(),
            Some(target),
            Some(owner),
        )
    }
    #[cfg(test)]
    pub(crate) fn start_fixed_owned_test(
        &mut self,
        token: WorkToken,
        target: TargetId,
        outcome: Outcome,
        clock: &Clock,
        owner: OwnerBinding,
        hooks: Hooks,
    ) -> std::result::Result<Id, StartFailure> {
        self.start_fixed_bound(token, outcome, clock, hooks, Some(target), Some(owner))
    }
    pub(crate) fn dispose_fixed_owned(
        &mut self,
        id: Id,
        now: u64,
    ) -> std::result::Result<Disposal, Fault> {
        if self
            .fixed
            .entry(id)
            .and_then(|e| e.owner.as_ref())
            .is_none()
        {
            return Err(Fault::State);
        }
        self.cancel_fixed(id)?;
        self.poll_fixed(now)?;
        let index = self
            .fixed
            .entries
            .iter()
            .position(|e| e.as_ref().is_some_and(|e| e.id == id))
            .ok_or(Fault::Stale)?;
        if self.fixed.entries[index].as_ref().unwrap().joined.is_none() {
            return Ok(Disposal::Pending);
        }
        let entry = self.fixed.entries[index].take().unwrap();
        let proof = Disposed {
            owner: entry.owner.as_ref().unwrap().id(),
            core: id,
            observation: entry.observation,
        };
        drop(entry);
        Ok(Disposal::Done(proof))
    }
    pub(crate) fn fixed_owner_occupancy(&self) -> [Option<[u8; 64]>; 2] {
        std::array::from_fn(|i| {
            self.fixed.entries[i].as_ref().map(|entry| {
                let mut device = [0; 64];
                device[..entry.device.len()].copy_from_slice(entry.device.as_bytes());
                device
            })
        })
    }
}

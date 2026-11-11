//! Private composition boundary. No worker, queue admission or join receipt here.
use super::*;
use crate::budget::Reservation;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum Phase {
    Running,
    Quiesced,
    Aborted,
}
pub(super) struct Binding {
    handle: Handle,
    ticket: u64,
    approval: bool,
}
/// Owns the exact HELLO ticket/carrier association; no caller-selected deadline.
pub(crate) struct CarrierTicket {
    handle: Handle,
    ticket: Ticket,
}
pub(crate) struct ApprovalMetadata {
    pub device_key: String,
    pub deadline: u64,
}
#[derive(Clone, Copy)]
pub(crate) enum CarrierDecision {
    PhoneOrKnown,
    ApprovedDesktop,
}

impl PersistentAuthority {
    /// Derive eligibility before revocation; mark Aborted until teardown completes.
    /// Caller must still join its future worker before consuming terminal close.
    pub(crate) fn quiesce_for_join(&mut self) -> std::result::Result<(), StoreFault> {
        if self.pid != std::process::id() {
            return Err(StoreFault::WrongProcess);
        }
        let core = self.core.as_ref().unwrap();
        let RecordStore::Persistent(store) = &core.storage else {
            unreachable!()
        };
        let fault = store.fault;
        let unhealthy = core.revocations.is_poisoned()
            || fault.is_some()
            || self.phase == Phase::Aborted
            || (self.phase == Phase::Running && core.retired);
        if unhealthy {
            self.abort_in_place();
            return Err(fault.unwrap_or(StoreFault::DirtyRun));
        }
        if self.phase == Phase::Quiesced {
            return Ok(());
        }
        self.phase = Phase::Aborted;
        self.core().retire();
        self.registry.as_mut().unwrap().retire();
        self.pending_carriers.clear();
        self.phase = Phase::Quiesced;
        Ok(())
    }
    /// Sticky abort for a future startup failure, caught panic or poisoned owner slot.
    /// Recovery may revoke/drop state but must never re-enter Running/Quiesced.
    pub(crate) fn abort_in_place(&mut self) {
        self.phase = Phase::Aborted;
        if self.pid != std::process::id() {
            return;
        }
        if let Some(core) = &mut self.core {
            core.retire();
        }
        if let Some(registry) = &mut self.registry {
            registry.retire();
        }
        self.pending_carriers.clear();
    }
    pub(crate) fn abort_without_commit(mut self) -> StoppedAuthority {
        if self.pid != std::process::id() {
            return self.abandon_inherited();
        }
        self.abort_in_place();
        let mut core = self.core.take().unwrap();
        let RecordStore::Persistent(store) =
            std::mem::replace(&mut core.storage, RecordStore::Closed)
        else {
            unreachable!()
        };
        drop(core);
        let diag = diagnostics(
            &store.state,
            Some(store.fault.unwrap_or(StoreFault::DirtyRun)),
        );
        let writer = (*store).into_writer();
        StoppedAuthority {
            writer,
            diagnostics: diag,
        }
    }
    fn bound(&self, t: &CarrierTicket) -> bool {
        self.core
            .as_ref()
            .is_some_and(|c| c.ticket_id(&t.ticket).is_ok())
            && self
                .pending_carriers
                .get(&t.handle.carrier())
                .is_some_and(|b| b.handle.same(&t.handle) && b.ticket == t.ticket.id)
    }
    fn cancel_bound_ref(&mut self, t: &CarrierTicket, reason: CloseReason) -> bool {
        if self.pid != std::process::id() || !self.bound(t) {
            return false;
        }
        self.pending_carriers.remove(&t.handle.carrier());
        self.core().pending.remove(&t.ticket.id);
        self.registry.as_mut().unwrap().close(&t.handle, reason);
        true
    }
    pub(super) fn reconcile_bound(&mut self) {
        if self.pid != std::process::id() {
            return;
        }
        let stale: Vec<_> = self
            .pending_carriers
            .iter()
            .filter(|(_, b)| {
                !self.core.as_ref().unwrap().pending.contains_key(&b.ticket)
                    || matches!(b.handle.status(), registry::CarrierStatus::Closed(_))
            })
            .map(|(id, _)| *id)
            .collect();
        for id in stale {
            let b = self.pending_carriers.remove(&id).unwrap();
            self.core().pending.remove(&b.ticket);
            self.registry
                .as_mut()
                .unwrap()
                .close(&b.handle, CloseReason::HelloTimeout);
        }
    }
}
impl PersistentAuthority {
    pub(crate) fn begin_for_carrier(
        &mut self,
        handle: &Handle,
        source: Source,
        hello: &[u8],
        now: u64,
        rng: &mut (impl RngCore + CryptoRng),
    ) -> std::result::Result<CarrierTicket, PersistentError> {
        self.check_policy()?;
        if let Err(e) = self.registry.as_mut().unwrap().pending(handle, now) {
            self.close_carrier(handle, CloseReason::Protocol);
            return Err(e.into());
        }
        if self
            .pending_carriers
            .get(&handle.carrier())
            .is_some_and(|b| b.handle.same(handle))
        {
            // A second HELLO cannot leave the first protected ticket orphaned.
            self.close_carrier(handle, CloseReason::Protocol);
            return Err(PolicyError::Denied.into());
        }
        let result = self.core().begin(source, hello, now, rng);
        self.reconcile_bound();
        let ticket = match result {
            Ok(t) => t,
            Err(e) => {
                self.registry
                    .as_mut()
                    .unwrap()
                    .close(handle, CloseReason::Protocol);
                return Err(e.into());
            }
        };
        self.pending_carriers.insert(
            handle.carrier(),
            Binding {
                handle: handle.clone(),
                ticket: ticket.id,
                approval: false,
            },
        );
        Ok(CarrierTicket {
            handle: handle.clone(),
            ticket,
        })
    }
    pub(crate) fn pending_for_carrier(
        &self,
        t: &CarrierTicket,
    ) -> super::super::Result<&channel::Device> {
        self.check_policy()?;
        if !self.bound(t) {
            return Err(PolicyError::Denied);
        }
        self.core.as_ref().unwrap().pending_device(&t.ticket)
    }
    pub(crate) fn prepare_pending_approval(
        &mut self,
        t: &CarrierTicket,
        now: u64,
    ) -> std::result::Result<ApprovalMetadata, PersistentError> {
        self.check_policy()?;
        if !self.bound(t) {
            return Err(PolicyError::Denied.into());
        }
        let result = (|| {
            self.core().expire(now)?;
            let d = self.core.as_ref().unwrap().pending_device(&t.ticket)?;
            if !d.first_pairing || d.kind != DeviceKind::Desktop {
                return Err(PolicyError::Denied.into());
            }
            let device_key = d.key.clone();
            let deadline = self.core.as_ref().unwrap().pending_deadline(&t.ticket)?;
            // Repeated preparation cannot renew an already protected carrier.
            if self.pending_carriers[&t.handle.carrier()].approval {
                return Err(PolicyError::Denied.into());
            }
            self.registry
                .as_mut()
                .unwrap()
                .wait_approval(&t.handle, deadline, now)?;
            self.pending_carriers
                .get_mut(&t.handle.carrier())
                .unwrap()
                .approval = true;
            Ok(ApprovalMetadata {
                device_key,
                deadline,
            })
        })();
        if result.is_err() {
            self.cancel_bound_ref(t, CloseReason::Protocol);
        }
        result
    }
    pub(crate) fn complete_for_carrier(
        &mut self,
        t: CarrierTicket,
        decision: CarrierDecision,
        mut now: impl FnMut() -> u64,
    ) -> std::result::Result<Access, PersistentError> {
        self.check_policy()?;
        if !self.bound(&t) {
            return Err(PolicyError::Denied.into());
        }
        let result = (|| {
            self.core().expire(now())?;
            let d = self.core.as_ref().unwrap().pending_device(&t.ticket)?;
            let desktop = d.first_pairing && d.kind == DeviceKind::Desktop;
            match decision {
                CarrierDecision::PhoneOrKnown if desktop => return Err(PolicyError::Denied.into()),
                CarrierDecision::ApprovedDesktop => {
                    if !desktop || !self.pending_carriers[&t.handle.carrier()].approval {
                        return Err(PolicyError::Denied.into());
                    }
                    self.core().approve_desktop(&t.ticket, now())?;
                }
                _ => (),
            }
            Ok(())
        })();
        if let Err(e) = result {
            self.cancel_bound_ref(&t, CloseReason::Protocol);
            return Err(e);
        }
        self.pending_carriers.remove(&t.handle.carrier());
        self.complete_access(&t.handle, t.ticket, now)
    }
    pub(crate) fn cancel_carrier_ticket(&mut self, t: CarrierTicket, reason: CloseReason) -> bool {
        self.cancel_bound_ref(&t, reason)
    }
    pub(crate) fn take_output_owned(
        &mut self,
        h: &Handle,
        now: u64,
        consume: impl FnOnce(Vec<u8>, Reservation) -> crate::Result<()>,
    ) -> registry::Result<bool> {
        self.check_registry()?;
        self.registry
            .as_mut()
            .unwrap()
            .take_output_owned(h, now, consume)
    }
    pub(crate) fn send_for_carrier(
        &mut self,
        h: &Handle,
        bytes: &[u8],
        now: u64,
    ) -> registry::Result<()> {
        self.check_registry()?;
        self.registry.as_mut().unwrap().send_encoded(h, bytes, now)
    }
    pub(crate) fn close_carrier(&mut self, h: &Handle, reason: CloseReason) -> bool {
        if self.check_registry().is_err() {
            return false;
        }
        let result = self.registry.as_mut().unwrap().close(h, reason);
        self.reconcile_bound();
        result
    }
    pub(crate) fn global_pool(&self) -> super::super::Result<GlobalBudget> {
        self.check_policy()?;
        Ok(self.core.as_ref().unwrap().global.clone())
    }
}

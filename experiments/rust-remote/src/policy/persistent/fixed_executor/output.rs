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
    pub(crate) fn register_fixed_carrier(
        &mut self,
        handle: &Handle,
        memory: MemoryCarrier,
        limits: MailboxLimits,
    ) -> std::result::Result<TargetId, Fault> {
        self.check_registry().map_err(|_| Fault::Stale)?;
        self.fixed.cancel_closed();
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
        let (budget, access) = self
            .registry
            .as_mut()
            .unwrap()
            .fixed_registration(handle)
            .map_err(|_| Fault::Stale)?;
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
            serial,
        };
        memory.bind_fixed(access, id).map_err(|_| Fault::Stale)?;
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
        Ok(Tracked {
            grant: Some(grant),
            memory: target.memory.clone(),
            clock: clock.clone(),
            encoded,
            scratch: Some(scratch),
            packet: Some(packet),
            _receipt: prepaid,
        })
    }
}

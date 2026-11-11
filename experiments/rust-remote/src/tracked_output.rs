//! Private shared identity and prepaid egress grant. No public delivery capability.
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

pub(crate) const FRAME_BYTES: usize = 1024;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct TargetId {
    pub(crate) authority: [u8; 16],
    pub(crate) generation: u64,
    pub(crate) serial: u64,
}
/// Immutable exact target/claim identity. The sole owning grant releases both slots.
pub(crate) struct Fence {
    pub(crate) target: TargetId,
    pub(crate) claim: u64,
    active: AtomicBool,
}
impl Fence {
    pub(crate) fn active(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }
    pub(crate) fn same(&self, other: &Self) -> bool {
        self.target == other.target && self.claim == other.claim
    }
}
pub(crate) struct Grant(pub(crate) Arc<Fence>);
impl Grant {
    pub(crate) fn new(target: TargetId, claim: u64) -> Self {
        Self(Arc::new(Fence {
            target,
            claim,
            active: AtomicBool::new(true),
        }))
    }
}
impl Drop for Grant {
    fn drop(&mut self) {
        self.0.active.store(false, Ordering::SeqCst);
    }
}

use crate::{budget::Reservation, channel::Channel, supervisor::Clock};
use std::sync::mpsc::{self, Receiver, SyncSender};

// Neither acceptance nor returned credit has a constructor outside its evidence path.
struct PeerAccepted(());
pub(crate) struct ReturnedCredit {
    accepted: Option<PeerAccepted>,
}
impl ReturnedCredit {
    pub(crate) fn accepted(&self) -> bool {
        self.accepted.is_some()
    }
}
pub(crate) type ReturnReceiver = Receiver<ReturnedCredit>;
pub(crate) type ReturnSender = SyncSender<ReturnedCredit>;
pub(crate) fn receipt_cell() -> (ReturnSender, ReturnReceiver) {
    mpsc::sync_channel(1)
}
pub(crate) struct Packet {
    bytes: Option<Vec<u8>>,
    lease: Option<Reservation>,
    returned: ReturnSender,
    accepted: Option<PeerAccepted>,
}
impl Packet {
    pub(crate) fn new(bytes: Vec<u8>, lease: Reservation, returned: ReturnSender) -> Self {
        Self {
            bytes: Some(bytes),
            lease: Some(lease),
            returned,
            accepted: None,
        }
    }
    pub(crate) fn wire_len(&self) -> usize {
        self.bytes.as_ref().unwrap().len()
    }
    pub(crate) fn verify(
        &mut self,
        peer: &mut Channel,
        expected: &[u8],
        clock: &Clock,
        acceptance: &mut crate::persistent::fixed_executor::Acceptance<'_>,
    ) -> crate::Result<()> {
        if clock.now() >= acceptance.deadline() {
            return Err(crate::Error::Timeout);
        }
        let plain = peer.open_encoded(self.bytes.as_ref().unwrap())?;
        let matches = plain == expected;
        drop(plain);
        if !matches {
            return Err(crate::Error::Authentication);
        }
        if clock.now() >= acceptance.deadline() {
            return Err(crate::Error::Timeout);
        }
        acceptance.commit(|| self.accepted = Some(PeerAccepted(())))?;
        Ok(())
    }
}
impl Drop for Packet {
    fn drop(&mut self) {
        drop(self.bytes.take());
        drop(self.lease.take());
        let _ = self.returned.try_send(ReturnedCredit {
            accepted: self.accepted.take(),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_packet_drop_publishes_credit_and_unverified_drop_has_no_acceptance() {
        let global = crate::budget::GlobalBudget::new(1536).unwrap();
        let budget = global.connection(1536).unwrap();
        let (sender, receiver) = receipt_cell();
        let packet = Packet::new(vec![3, 1, 2], budget.reserve(1536).unwrap(), sender);
        assert!(matches!(
            receiver.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
        assert_eq!(packet.wire_len(), 3);
        assert_eq!(global.used(), 1536);
        drop(packet);
        let returned = receiver.try_recv().unwrap();
        assert!(!returned.accepted());
        assert_eq!(global.used(), 0);
        assert!(receiver.try_recv().is_err());
    }
}

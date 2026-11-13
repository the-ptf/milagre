//! The sole constructor of a packet-return receipt is Packet::drop, after both
//! the ciphertext and its reservation are destroyed. No adjacent marker minting.
use crate::budget::Reservation;
use std::sync::mpsc::{self, Receiver, SyncSender};
pub(super) struct ReturnedCredit(());
pub(super) type ReturnReceiver = Receiver<ReturnedCredit>;
pub(super) type ReturnSender = SyncSender<ReturnedCredit>;
pub(super) fn channel() -> (ReturnSender, ReturnReceiver) {
    mpsc::sync_channel(1)
}
pub(super) struct Packet {
    bytes: Option<Vec<u8>>,
    lease: Option<Reservation>,
    returned: ReturnSender,
}
impl Packet {
    pub(super) fn new(bytes: Vec<u8>, lease: Reservation, returned: ReturnSender) -> Self {
        Self {
            bytes: Some(bytes),
            lease: Some(lease),
            returned,
        }
    }
    pub(super) fn bytes(&self) -> &[u8] {
        self.bytes.as_ref().unwrap()
    }
}
impl Drop for Packet {
    fn drop(&mut self) {
        drop(self.bytes.take());
        drop(self.lease.take());
        let _ = self.returned.try_send(ReturnedCredit(()));
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::budget::GlobalBudget;
    #[test]
    fn receipt_exists_only_after_packet_and_charge_are_destroyed() {
        let global = GlobalBudget::new(1024).unwrap();
        let budget = global.connection(1024).unwrap();
        let (sender, receiver) = channel();
        let packet = Packet::new(vec![1, 2, 3], budget.reserve(1024).unwrap(), sender);
        assert!(matches!(
            receiver.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
        assert_eq!(packet.bytes(), &[1, 2, 3]);
        assert_eq!(global.used(), 1024);
        drop(packet);
        let _receipt = receiver.try_recv().unwrap();
        assert_eq!(global.used(), 0);
        assert!(budget.reserve(1024).is_ok());
    }
}

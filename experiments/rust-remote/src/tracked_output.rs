//! Private shared identity and prepaid egress grant. No public delivery capability.
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

pub(crate) const FRAME_BYTES: usize = 1024;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct TargetId {
    pub(crate) authority: [u8; 16],
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

//! Private fixture peer admission. Stage 2B.1 has no response-delivery pump.
use super::*;
use crate::channel::Channel;
use crate::phone::{Headers, Method, Request};

pub(crate) const PEER_BYTES: usize = 4096;
const REQUEST_BYTES: usize = 256;
const WIRE_BYTES: usize = REQUEST_BYTES + 25;
// Both crypto buffers, codec containers and the fixed request path fit this
// allowance before transfer. Retained ownership moves between Pending and Runtime.
pub(super) fn allowance_fits() -> bool {
    std::mem::size_of::<PeerBinding>().max(std::mem::size_of::<QueuedPeer>())
        + std::mem::size_of::<Request>()
        + REQUEST_BYTES
        + 2 * WIRE_BYTES
        + 1024
        <= PEER_BYTES
}
pub(crate) struct PeerTransfer {
    handle: Handle,
    peer: Channel,
}
impl PeerTransfer {
    pub(in crate::persistent_supervisor) fn new(handle: Handle, peer: Channel) -> Self {
        Self { handle, peer }
    }
}
pub(crate) enum PeerRejection {
    Full(PeerTransfer),
    Unavailable(PrepareRefusal, PeerTransfer),
}
impl std::fmt::Debug for PeerRejection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Full(_) => f.write_str("Full"),
            Self::Unavailable(reason, _) => f.debug_tuple("Unavailable").field(reason).finish(),
        }
    }
}
pub(crate) struct PeerReceipt(ReplyHandle);
pub(crate) struct FixtureReceipt(ReplyHandle);
impl PeerReceipt {
    pub(crate) fn wait(&mut self, timeout: Duration) -> Result<TargetId, WaitFault> {
        match self.0.wait(timeout)? {
            PreparedReply::PeerReady(t) => Ok(t),
            _ => Err(PrepareRefusal::Stale.into()),
        }
    }
}
impl FixtureReceipt {
    pub(crate) fn wait(&mut self, timeout: Duration) -> Result<(), WaitFault> {
        match self.0.wait(timeout)? {
            PreparedReply::Requested => Ok(()),
            _ => Err(PrepareRefusal::Stale.into()),
        }
    }
}
#[derive(Clone)]
pub(super) struct Descriptor {
    pub(super) handle: Handle,
    pub(super) target: TargetId,
    pub(super) budget: ConnectionBudget,
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) struct PeerId {
    slot: usize,
    serial: u64,
    target: TargetId,
}
pub(super) struct PeerCell {
    id: PeerId,
    handle: Handle,
    installed: bool,
}
pub(super) struct QueuedPeer {
    id: PeerId,
    transfer: PeerTransfer,
    lease: Reservation,
}
pub(super) struct PeerBinding {
    id: PeerId,
    handle: Handle,
    peer: Channel,
    _lease: Reservation,
}
impl State {
    fn peer_reply_slot(&self) -> Result<(usize, u64), PrepareRefusal> {
        if self.operations.len == QUEUE_SLOTS {
            return Err(PrepareRefusal::Full);
        }
        let slot = self
            .replies
            .iter()
            .position(Option::is_none)
            .ok_or(PrepareRefusal::Full)?;
        let generation = self.next_reply.checked_add(1).ok_or(PrepareRefusal::Full)?;
        Ok((slot, generation))
    }
    fn queue_peer(
        &mut self,
        shared: &Arc<Shared>,
        reply: (usize, u64),
        operation: Operation,
    ) -> ReplyHandle {
        let (slot, generation) = reply;
        self.replies[slot] = Some(ReplyCell {
            generation,
            result: None,
            pinned: true,
            abandoned: false,
        });
        self.operations.push(Pending {
            slot,
            generation,
            operation,
        });
        self.next_reply = generation;
        shared.notify_work();
        ReplyHandle {
            shared: Arc::downgrade(shared),
            slot,
            generation,
            armed: true,
        }
    }
    fn peer_descriptor(&self, handle: &Handle) -> Result<Descriptor, PrepareRefusal> {
        if handle.status() != registry::CarrierStatus::Active {
            return Err(PrepareRefusal::Stale);
        }
        self.roster
            .iter()
            .flatten()
            .find(|r| r.handle.same(handle))
            .cloned()
            .ok_or(PrepareRefusal::Stale)
    }
    fn peer_capacity(&self, handle: &Handle) -> Result<(usize, u64, (usize, u64)), PrepareRefusal> {
        if self.peers.iter().flatten().any(|p| p.handle.same(handle)) {
            return Err(PrepareRefusal::Stale);
        }
        let slot = self
            .peers
            .iter()
            .position(Option::is_none)
            .ok_or(PrepareRefusal::Full)?;
        let serial = self.next_peer.checked_add(1).ok_or(PrepareRefusal::Full)?;
        Ok((slot, serial, self.peer_reply_slot()?))
    }
}
impl FixedOwnerClient {
    pub(crate) fn adopt_peer(&self, transfer: PeerTransfer) -> Result<PeerReceipt, PeerRejection> {
        let reject = |reason, transfer| {
            if reason == PrepareRefusal::Full {
                PeerRejection::Full(transfer)
            } else {
                PeerRejection::Unavailable(reason, transfer)
            }
        };
        let shared = match self.shared() {
            Ok(s) => s,
            Err(e) => return Err(reject(e, transfer)),
        };
        let descriptor = (|| {
            let q = shared.queues();
            if !shared.running() {
                return Err(PrepareRefusal::Stopped);
            }
            let fixed = q.fixed.as_ref().ok_or(PrepareRefusal::Stopped)?;
            let descriptor = fixed.peer_descriptor(&transfer.handle)?;
            fixed.peer_capacity(&transfer.handle)?;
            Ok(descriptor)
        })();
        let descriptor = match descriptor {
            Ok(d) => d,
            Err(e) => return Err(reject(e, transfer)),
        };
        if !allowance_fits() {
            return Err(PeerRejection::Full(transfer));
        }
        let lease = match descriptor.budget.reserve(PEER_BYTES) {
            Ok(l) => l,
            Err(_) => return Err(PeerRejection::Full(transfer)),
        };
        let mut q = shared.queues();
        let admitted = (|| {
            if !shared.running() {
                return Err(PrepareRefusal::Stopped);
            }
            let fixed = q.fixed.as_mut().ok_or(PrepareRefusal::Stopped)?;
            if fixed.peer_descriptor(&transfer.handle)?.target != descriptor.target {
                return Err(PrepareRefusal::Stale);
            }
            let (slot, serial, reply) = fixed.peer_capacity(&transfer.handle)?;
            Ok((
                PeerId {
                    slot,
                    serial,
                    target: descriptor.target,
                },
                reply,
            ))
        })();
        let (id, reply) = match admitted {
            Ok(v) => v,
            Err(e) => {
                drop(q);
                drop(lease);
                return Err(reject(e, transfer));
            }
        };
        if !shared.running() {
            drop(q);
            drop(lease);
            return Err(PeerRejection::Unavailable(
                PrepareRefusal::Stopped,
                transfer,
            ));
        }
        let fixed = q.fixed.as_mut().unwrap();
        fixed.peers[id.slot] = Some(PeerCell {
            id,
            handle: transfer.handle.clone(),
            installed: false,
        });
        fixed.next_peer = id.serial;
        let receipt = fixed.queue_peer(
            &shared,
            reply,
            Operation::AdoptPeer(QueuedPeer {
                id,
                transfer,
                lease,
            }),
        );
        Ok(PeerReceipt(receipt))
    }
    pub(crate) fn request_fixture(
        &self,
        target: TargetId,
        request_id: i64,
    ) -> Result<FixtureReceipt, PrepareRefusal> {
        let shared = self.shared()?;
        let mut q = shared.queues();
        if !shared.running() {
            return Err(PrepareRefusal::Stopped);
        }
        let fixed = q.fixed.as_mut().ok_or(PrepareRefusal::Stopped)?;
        let id = fixed
            .peers
            .iter()
            .flatten()
            .find(|p| {
                p.id.target == target
                    && p.installed
                    && p.handle.status() == registry::CarrierStatus::Active
            })
            .map(|p| p.id)
            .ok_or(PrepareRefusal::Stale)?;
        let reply = fixed.peer_reply_slot()?;
        if !shared.running() {
            return Err(PrepareRefusal::Stopped);
        }
        Ok(FixtureReceipt(fixed.queue_peer(
            &shared,
            reply,
            Operation::RequestFixture(id, request_id),
        )))
    }
}

#[cfg(test)]
impl FixedOwnerClient {
    pub(crate) fn peer_counts(&self) -> (usize, usize, usize) {
        let shared = self.shared().unwrap();
        let q = shared.queues();
        q.fixed.as_ref().map_or((0, 0, 0), |f| {
            (
                f.roster.iter().flatten().count(),
                f.peers.iter().flatten().filter(|p| !p.installed).count(),
                f.peers.iter().flatten().filter(|p| p.installed).count(),
            )
        })
    }
    pub(crate) fn peer_budget(&self, target: TargetId) -> ConnectionBudget {
        let shared = self.shared().unwrap();
        let q = shared.queues();
        q.fixed
            .as_ref()
            .unwrap()
            .roster
            .iter()
            .flatten()
            .find(|d| d.target == target)
            .unwrap()
            .budget
            .clone()
    }
}

impl Runtime {
    pub(in crate::persistent_supervisor) fn fixed_peer_maintain(&mut self, shared: &Shared) {
        let Some(runtime) = self.fixed.as_mut() else {
            return;
        };
        for i in 0..runtime.peers.len() {
            if runtime.peers[i]
                .as_ref()
                .is_some_and(|p| p.handle.status() != registry::CarrierStatus::Active)
            {
                let peer = runtime.peers[i].take().unwrap();
                let id = peer.id;
                drop(peer);
                let mut q = shared.queues();
                if let Some(fixed) = q.fixed.as_mut() {
                    if fixed.peers[i].as_ref().is_some_and(|p| p.id == id) {
                        fixed.peers[i] = None;
                    }
                }
            }
        }
        let mut q = shared.queues();
        if let Some(fixed) = q.fixed.as_mut() {
            for descriptor in &mut fixed.roster {
                if descriptor
                    .as_ref()
                    .is_some_and(|d| d.handle.status() != registry::CarrierStatus::Active)
                {
                    *descriptor = None;
                }
            }
        }
    }
    pub(in crate::persistent_supervisor) fn fixed_peer_outbound(
        &self,
        handle: &Handle,
    ) -> crate::supervisor::Result<()> {
        if self
            .fixed
            .as_ref()
            .is_some_and(|f| f.peers.iter().flatten().any(|p| p.handle.same(handle)))
        {
            return Err(crate::supervisor::Error::Full);
        }
        Ok(())
    }
    pub(super) fn fixed_adopt_peer(
        &mut self,
        shared: &Shared,
        queued: QueuedPeer,
    ) -> Result<TargetId, PrepareRefusal> {
        let QueuedPeer {
            id,
            transfer,
            lease,
        } = queued;
        let result = (|| {
            self.current(&transfer.handle)
                .map_err(|_| PrepareRefusal::Stale)?;
            let valid = {
                let q = shared.queues();
                q.fixed
                    .as_ref()
                    .and_then(|f| f.peers[id.slot].as_ref())
                    .is_some_and(|p| p.id == id && !p.installed)
            };
            if !valid {
                return Err(PrepareRefusal::Stale);
            }
            self.authority
                .inspect_fixed_peer(id.target, &transfer.handle)
                .map_err(|e| {
                    if e == executor::Fault::Full {
                        PrepareRefusal::Full
                    } else {
                        PrepareRefusal::Stale
                    }
                })?;
            let mut q = shared.queues();
            if !shared.running() {
                return Err(PrepareRefusal::Stopped);
            }
            let cell = q
                .fixed
                .as_mut()
                .and_then(|f| f.peers[id.slot].as_mut())
                .filter(|p| p.id == id)
                .ok_or(PrepareRefusal::Stale)?;
            cell.installed = true;
            Ok(())
        })();
        if let Err(e) = result {
            self.authority
                .close_carrier(&transfer.handle, registry::CloseReason::CarrierFailure);
            drop(transfer);
            drop(lease);
            if let Some(fixed) = shared.queues().fixed.as_mut() {
                if fixed.peers[id.slot].as_ref().is_some_and(|p| p.id == id) {
                    fixed.peers[id.slot] = None;
                }
            }
            return Err(e);
        }
        self.fixed.as_mut().unwrap().peers[id.slot] = Some(PeerBinding {
            id,
            handle: transfer.handle,
            peer: transfer.peer,
            _lease: lease,
        });
        Ok(id.target)
    }
    pub(super) fn fixed_request_fixture(
        &mut self,
        id: PeerId,
        request: i64,
        shared: &Shared,
    ) -> Result<(), PrepareRefusal> {
        let binding = self
            .fixed
            .as_mut()
            .and_then(|f| f.peers[id.slot].as_mut())
            .filter(|p| p.id == id)
            .ok_or(PrepareRefusal::Stale)?;
        let handle = binding.handle.clone();
        if handle.status() != registry::CarrierStatus::Active {
            return Err(PrepareRefusal::Stale);
        }
        let mut parts = crate::phone::request_parts(&Request {
            id: request,
            method: Method::GET,
            path: "/rpc".into(),
            headers: Headers::new(),
            body: Vec::new(),
        })
        .map_err(|_| PrepareRefusal::Full)?;
        if parts.len() != 1
            || parts[0].capacity() > REQUEST_BYTES
            || parts.capacity() * std::mem::size_of::<Vec<u8>>() > 512
        {
            return Err(PrepareRefusal::Full);
        }
        let plain = parts.pop().unwrap();
        if !shared.running() {
            return Err(PrepareRefusal::Stopped);
        }
        let result = binding.peer.seal_encoded(&plain);
        drop(plain);
        drop(parts);
        // From this attempt onward a sequence may be consumed. Never replay it.
        let result = result.and_then(|wire| {
            if !shared.running() {
                return Err(crate::Error::Unauthorized);
            }
            if wire.capacity() > WIRE_BYTES {
                return Err(crate::Error::Budget);
            }
            self.authority
                .receive_request(&handle, &wire, self.clock.now())
                .map_err(|_| crate::Error::Unauthorized)
        });
        match result {
            Ok(started) => {
                Self::work_available(shared, started);
                Ok(())
            }
            Err(_) => {
                self.authority
                    .close_carrier(&handle, registry::CloseReason::CarrierFailure);
                self.reconcile(shared);
                self.fixed_peer_maintain(shared);
                Err(PrepareRefusal::Stale)
            }
        }
    }
}
impl Runtime {
    // Existing bounded ticks only: up to two retained entries, with no new scheduler or wake.
    pub(in crate::persistent_supervisor) fn fixed_deliver(
        &mut self,
        shared: &Shared,
    ) -> crate::supervisor::Result<()> {
        for (core, target) in self
            .authority
            .fixed_delivery_entries()
            .into_iter()
            .flatten()
        {
            if !shared.running() {
                break;
            }
            let Some(peer) = self
                .fixed
                .as_mut()
                .and_then(|f| f.peers.iter_mut().flatten().find(|p| p.id.target == target))
            else {
                continue;
            };
            #[cfg(test)]
            if self.authority.fixed_output_held(core, false) {
                continue;
            }
            let observation = self.authority.observe_fixed(core).unwrap();
            let mut result = Ok(());
            if observation.delivery == executor::Delivery::None {
                result = self.authority.emit_fixed(core);
            }
            #[cfg(test)]
            let held = self.authority.fixed_output_held(core, true);
            #[cfg(not(test))]
            let held = false;
            if result.is_ok() && !held {
                #[cfg(test)]
                if let Some(wrong) = self.authority.fixed_test_peer(core) {
                    peer.peer = wrong;
                }
                result = self
                    .authority
                    .consume_fixed_progress(core, &mut peer.peer)
                    .map(|_| ());
            }
            self.publish_fixed_readiness(shared);
            if matches!(
                result,
                Err(executor::Fault::Worker | executor::Fault::Clock)
            ) {
                self.authority.abort_in_place();
                shared.fail(WorkerFault::InvalidExit);
                return Err(crate::supervisor::Error::NotExecuted);
            }
        }
        self.reconcile(shared);
        self.fixed_maintain(shared);
        self.fixed_copy_progress(shared)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn peer_allowance_contains_fixed_request_and_crypto_buffers() {
        assert!(allowance_fits());
        for id in [-9_007_199_254_740_991, 0, 9_007_199_254_740_991] {
            let request = Request {
                id,
                method: Method::GET,
                path: "/rpc".into(),
                headers: Headers::new(),
                body: Vec::new(),
            };
            let parts = crate::phone::request_parts(&request).unwrap();
            assert_eq!(parts.len(), 1);
            assert!(parts[0].capacity() <= REQUEST_BYTES);
            assert!(parts.capacity() * std::mem::size_of::<Vec<u8>>() <= 512);
            assert_eq!(request.path.capacity(), 4);
            assert_eq!(request.body.capacity(), 0);
            assert!(
                std::mem::size_of::<PeerBinding>().max(std::mem::size_of::<QueuedPeer>())
                    + std::mem::size_of::<Request>()
                    + request.path.capacity()
                    + parts[0].capacity()
                    + parts.capacity() * std::mem::size_of::<Vec<u8>>()
                    + 2 * WIRE_BYTES
                    + 512
                    <= PEER_BYTES
            );
        }
    }
}

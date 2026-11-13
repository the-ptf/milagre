use super::*;
use crate::{
    admission::Source,
    channel::{self, Channel, DesktopAccess, DeviceKind, HelloOptions},
    peer::{FRAME_TIMEOUT_MS, PART_THRESHOLD},
    phone::{request_parts, Headers, Method},
    policy::{self, TemporaryAuthority},
    tracked_output::{Grant, TargetId},
    SecretKey,
};
use rand_core::OsRng;

const TOKEN: &str = "synthetic-fixed-registry";
fn new_authority() -> TemporaryAuthority {
    TemporaryAuthority::create_synthetic(
        SecretKey::from([1; 32]),
        TOKEN.into(),
        DesktopAccess::Enabled,
        policy::Limits::default(),
        &mut OsRng,
    )
    .unwrap()
}
fn new_registry() -> Registry {
    Registry::new(
        Limits {
            inflight: 1,
            ..Limits::default()
        },
        &mut OsRng,
    )
    .unwrap()
}
fn install(
    registry: &mut Registry,
    authority: &mut TemporaryAuthority,
    carrier: u64,
    seed: u8,
    kind: DeviceKind,
    now: u64,
) -> (Handle, Channel, ConnectionBudget) {
    let handle = registry.open_carrier(carrier, now).unwrap();
    authority.open_pairing(now).unwrap();
    let (hello, pending) = channel::phone_hello(
        &SecretKey::from([seed; 32]),
        &SecretKey::from([1; 32]).public_key(),
        TOKEN,
        HelloOptions {
            kind: Some(kind),
            ..HelloOptions::default()
        },
        &mut OsRng,
    )
    .unwrap();
    let ticket = authority
        .begin(Source::Direct(1), &hello, now, &mut OsRng)
        .unwrap();
    if kind == DeviceKind::Desktop {
        authority.approve_desktop(&ticket, now).unwrap();
    }
    let session = authority.complete(ticket, || now).unwrap();
    let budget = session.budget();
    registry.establish(&handle, session, now).unwrap();
    let mut accept = Vec::new();
    registry
        .take_output(&handle, now, |bytes| {
            accept.extend_from_slice(bytes);
            Ok(())
        })
        .unwrap();
    (handle, pending.finish(&accept).unwrap(), budget)
}
fn request(
    registry: &mut Registry,
    handle: &Handle,
    peer: &mut Channel,
    id: i64,
    now: u64,
) -> WorkToken {
    for part in request_parts(&Request {
        id,
        method: Method::GET,
        path: "/rpc".into(),
        headers: Headers::new(),
        body: Vec::new(),
    })
    .unwrap()
    {
        registry
            .receive_request(handle, &peer.seal_encoded(&part).unwrap(), now)
            .unwrap();
    }
    registry.work_token(handle, id).unwrap()
}
fn fence(registry: &mut Registry, token: &WorkToken, now: u64) -> Grant {
    let grant = Grant::new(
        TargetId {
            authority: [7; 16],
            generation: token.handle().generation(),
            serial: 1,
        },
        1,
    );
    registry
        .reserve_fixed_output(token, grant.0.clone(), now)
        .unwrap();
    grant
}

#[test]
fn fixed_inspection_refusal_retains_actual_promotion_until_latch_taken() {
    let mut registry = new_registry();
    let mut authority = new_authority();
    let (handle, mut peer, _) = install(&mut registry, &mut authority, 1, 2, DeviceKind::Phone, 1);
    let first = request(&mut registry, &handle, &mut peer, 1, 1);
    let queued = request(&mut registry, &handle, &mut peer, 2, 19_000);
    assert_eq!(queued.status(), WorkStatus::Queued);
    assert!(!registry.take_fixed_readiness());
    assert!(matches!(
        registry.inspect_claim(&first, 20_001),
        Err(claim::AdmissionError::Expired)
    ));
    assert_eq!(first.status(), WorkStatus::TimedOut);
    assert_eq!(queued.status(), WorkStatus::InFlight);
    // Later refusal and ordinary observation cannot erase the pending notification.
    assert!(matches!(
        registry.inspect_claim(&first, 20_001),
        Err(claim::AdmissionError::Expired)
    ));
    assert_eq!(
        registry.fixed_egress(&handle, 20_001).unwrap(),
        FixedEgress::Ordinary
    );
    let ready = registry.drain_work(None, 64, 20_001).unwrap();
    assert_eq!(ready.tokens.len(), 1);
    assert_eq!(ready.tokens[0].id(), queued.id());
    assert!(registry.take_fixed_readiness());
    assert!(!registry.take_fixed_readiness());
    assert_eq!(
        registry
            .inspect_ready_candidate(&queued, 20_001)
            .candidate
            .unwrap()
            .deadline,
        39_000
    );
    // Expiry with no eligible successor fabricates no readiness.
    assert!(matches!(
        registry.inspect_claim(&queued, 39_000),
        Err(claim::AdmissionError::Expired)
    ));
    assert!(!registry.take_fixed_readiness());
}

#[test]
fn fixed_readiness_does_not_duplicate_the_existing_preparation_bridge() {
    let mut registry = new_registry();
    let mut authority = new_authority();
    let (handle, mut peer, _) = install(&mut registry, &mut authority, 1, 2, DeviceKind::Phone, 1);
    let first = request(&mut registry, &handle, &mut peer, 1, 1);
    let queued = request(&mut registry, &handle, &mut peer, 2, 19_000);
    let inspection = registry.inspect_ready_candidate(&first, 20_001);
    assert!(matches!(
        inspection.candidate,
        Err(claim::AdmissionError::Expired)
    ));
    assert_eq!(inspection.promoted.len(), 1);
    assert_eq!(inspection.promoted[0].id(), queued.id());
    assert!(!registry.take_fixed_readiness());
}

#[test]
fn fixed_end_claim_coalesces_actual_promotions_and_stale_disposal_adds_none() {
    let mut registry = new_registry();
    let mut authority = new_authority();
    let (handle, mut peer, _) = install(&mut registry, &mut authority, 1, 2, DeviceKind::Phone, 1);
    let first = request(&mut registry, &handle, &mut peer, 1, 1);
    let first_permit = registry.claim_work(&first, 1).unwrap();
    let second = request(&mut registry, &handle, &mut peer, 2, 2);
    let third = request(&mut registry, &handle, &mut peer, 3, 2);
    registry.end_claim(&first_permit, WorkStatus::Cancelled, 3);
    assert_eq!(second.status(), WorkStatus::InFlight);
    assert_eq!(third.status(), WorkStatus::Queued);
    let second_permit = registry.claim_work(&second, 3).unwrap();
    registry.end_claim(&second_permit, WorkStatus::TimedOut, 4);
    assert_eq!(third.status(), WorkStatus::InFlight);
    assert!(registry.take_fixed_readiness());
    assert!(!registry.take_fixed_readiness());
    registry.end_claim(&first_permit, WorkStatus::Completed, 4);
    registry.end_claim(&second_permit, WorkStatus::Completed, 4);
    assert_eq!(first.status(), WorkStatus::Cancelled);
    assert_eq!(second.status(), WorkStatus::TimedOut);
    assert!(!registry.take_fixed_readiness());
    let third_permit = registry.claim_work(&third, 4).unwrap();
    registry.end_claim(&third_permit, WorkStatus::Cancelled, 5);
    assert!(!registry.take_fixed_readiness());
    let replacement = registry.open_carrier(1, 5).unwrap();
    registry.end_claim(&third_permit, WorkStatus::Completed, 5);
    assert!(!registry.take_fixed_readiness());
    assert_eq!(replacement.status(), CarrierStatus::Pending);
}

#[test]
fn fixed_egress_is_live_exact_generation_scoped_and_does_not_export_or_unfence() {
    let mut registry = new_registry();
    let mut authority = new_authority();
    let (old, mut peer, budget) =
        install(&mut registry, &mut authority, 1, 2, DeviceKind::Phone, 1);
    let (other, _, _) = install(&mut registry, &mut authority, 2, 3, DeviceKind::Phone, 1);
    let token = request(&mut registry, &old, &mut peer, 1, 1);
    let grant = fence(&mut registry, &token, 1);
    let before = budget.used();
    assert_eq!(
        registry.fixed_egress(&old, 1).unwrap(),
        FixedEgress::TrackedFence
    );
    assert_eq!(
        registry.fixed_egress(&other, 1).unwrap(),
        FixedEgress::Ordinary
    );
    assert_eq!(budget.used(), before);
    assert!(matches!(
        registry.take_output(&old, 1, |_| panic!("fence must still refuse export")),
        Err(RegistryError::Protocol(Error::Budget))
    ));
    let (fresh, mut fresh_peer, _) =
        install(&mut registry, &mut authority, 1, 2, DeviceKind::Phone, 2);
    assert_eq!(old.status(), CarrierStatus::Closed(CloseReason::Replaced));
    assert!(grant.0.active());
    assert!(matches!(
        registry.fixed_egress(&old, 2),
        Err(RegistryError::Revoked)
    ));
    assert_eq!(
        registry.fixed_egress(&fresh, 2).unwrap(),
        FixedEgress::Ordinary
    );
    assert_eq!(fresh.status(), CarrierStatus::Active);
    let fresh_work = request(&mut registry, &fresh, &mut fresh_peer, 2, 2);
    let fresh_grant = fence(&mut registry, &fresh_work, 2);
    assert_eq!(
        registry.fixed_egress(&fresh, 2).unwrap(),
        FixedEgress::TrackedFence
    );
    drop(fresh_grant);
    assert_eq!(
        registry.fixed_egress(&fresh, 2).unwrap(),
        FixedEgress::Ordinary
    );
    registry.send_encoded(&fresh, b"null", 2).unwrap();
    assert_eq!(
        registry.fixed_egress(&fresh, 2).unwrap(),
        FixedEgress::Ordinary
    );
    assert!(registry
        .take_output(&fresh, 2, |wire| {
            assert_eq!(fresh_peer.open_encoded(wire)?, b"null");
            Ok(())
        })
        .unwrap());
    let mut foreign = Registry::new(Limits::default(), &mut OsRng).unwrap();
    let foreign_handle = foreign.open_carrier(1, 2).unwrap();
    assert!(matches!(
        registry.fixed_egress(&foreign_handle, 2),
        Err(RegistryError::Revoked)
    ));
    assert_eq!(fresh.status(), CarrierStatus::Active);
}

#[test]
fn fixed_egress_preserves_clock_authorization_idle_and_fragment_failures() {
    let mut registry = new_registry();
    let mut authority = new_authority();
    let (handle, mut peer, _) = install(&mut registry, &mut authority, 1, 2, DeviceKind::Phone, 1);
    let token = request(&mut registry, &handle, &mut peer, 1, 1);
    let _grant = fence(&mut registry, &token, 1);
    assert_eq!(
        registry.fixed_egress(&handle, 2).unwrap(),
        FixedEgress::TrackedFence
    );
    assert!(matches!(
        registry.fixed_egress(&handle, 1),
        Err(RegistryError::Time)
    ));
    assert_eq!(handle.status(), CarrierStatus::Active);
    assert!(matches!(
        registry.fixed_egress(&handle, 45_001),
        Err(RegistryError::Revoked)
    ));
    assert_eq!(
        handle.status(),
        CarrierStatus::Closed(CloseReason::IdleTimeout)
    );

    let (revoked, _, _) = install(
        &mut registry,
        &mut authority,
        2,
        3,
        DeviceKind::Phone,
        45_001,
    );
    authority.retire();
    assert!(matches!(
        registry.fixed_egress(&revoked, 45_001),
        Err(RegistryError::Revoked)
    ));
    assert_eq!(
        revoked.status(),
        CarrierStatus::Closed(CloseReason::Removed)
    );

    let mut registry = new_registry();
    let mut authority = new_authority();
    let pending = registry.open_carrier(9, 1).unwrap();
    assert!(matches!(
        registry.fixed_egress(&pending, 1),
        Err(RegistryError::Revoked)
    ));
    assert_eq!(pending.status(), CarrierStatus::Pending);
    let (handle, mut peer, _) =
        install(&mut registry, &mut authority, 1, 2, DeviceKind::Desktop, 1);
    let text = format!("\"{}\"", "x".repeat(PART_THRESHOLD));
    let frames = FrameWriter::new(Direction::Rpc).write(&text).unwrap();
    assert!(!registry
        .receive_peer(
            &handle,
            &peer.seal_encoded(&frames[0]).unwrap(),
            1,
            |_| panic!("partial frame")
        )
        .unwrap());
    assert!(matches!(
        registry.fixed_egress(&handle, 1 + FRAME_TIMEOUT_MS),
        Err(RegistryError::Revoked)
    ));
    assert_eq!(
        handle.status(),
        CarrierStatus::Closed(CloseReason::FragmentTimeout)
    );
}

use super::*;
use crate::{
    admission::Source,
    channel::{self, Channel, DesktopAccess, HelloOptions},
    peer::FRAME_TIMEOUT_MS,
    phone::{request_parts, Headers, Method},
    policy::{self, TemporaryAuthority},
    tracked_output::{receipt_cell, Grant, TargetId},
    SecretKey,
};
use rand_core::OsRng;

const TOKEN: &str = "synthetic-claim-deadline";

fn fixture(idle_ms: u64) -> (Registry, TemporaryAuthority, Handle, Channel, Permit) {
    let mut authority = TemporaryAuthority::create_synthetic(
        SecretKey::from([1; 32]),
        TOKEN.into(),
        DesktopAccess::Enabled,
        policy::Limits::default(),
        &mut OsRng,
    )
    .unwrap();
    let mut registry = Registry::new(
        Limits {
            idle_ms,
            ..Limits::default()
        },
        &mut OsRng,
    )
    .unwrap();
    let (handle, mut peer) = install(&mut registry, &mut authority, 1);
    let token = request(&mut registry, &handle, &mut peer, 1);
    let permit = registry.claim_work(&token, 1).unwrap();
    (registry, authority, handle, peer, permit)
}

fn install(
    registry: &mut Registry,
    authority: &mut TemporaryAuthority,
    now: u64,
) -> (Handle, Channel) {
    let handle = registry.open_carrier(1, now).unwrap();
    authority.open_pairing(now).unwrap();
    let (hello, pending) = channel::phone_hello(
        &SecretKey::from([2; 32]),
        &SecretKey::from([1; 32]).public_key(),
        TOKEN,
        HelloOptions::default(),
        &mut OsRng,
    )
    .unwrap();
    let ticket = authority
        .begin(Source::Direct(1), &hello, now, &mut OsRng)
        .unwrap();
    let session = authority.complete(ticket, || now).unwrap();
    registry.establish(&handle, session, now).unwrap();
    let mut accept = Vec::new();
    registry
        .take_output(&handle, now, |bytes| {
            accept.extend_from_slice(bytes);
            Ok(())
        })
        .unwrap();
    (handle, pending.finish(&accept).unwrap())
}

fn request(registry: &mut Registry, handle: &Handle, peer: &mut Channel, now: u64) -> WorkToken {
    for part in request_parts(&Request {
        id: 7,
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
    registry.work_token(handle, 7).unwrap()
}

fn start_reader_fragment(registry: &mut Registry, permit: &Permit, now: u64) {
    // Phone receive_request uses RequestAssembler, so no public Phone operation
    // reaches this reader. Seed a real parsed partial in its private FrameReader
    // to exercise this shared Registry barrier boundary, not Phone wire reachability.
    assert_eq!(
        registry
            .inject_claim_reader_fragment_for_test(permit, now)
            .unwrap(),
        now + FRAME_TIMEOUT_MS
    );
    let active = registry.claimed(permit, now).unwrap();
    assert!(active.reader.pending());
    assert_eq!(active.reader.buffered_bytes(), 1);
    assert_eq!(active.reader.deadline_ms(), Some(now + FRAME_TIMEOUT_MS));
}

#[test]
fn deadline_barrier_uses_each_actual_minimum_and_refuses_equality() {
    for (idle_ms, fragment_at, deadline, closed) in [
        (1_000_000, 345_000, 345_001, None),
        (45_000, 40_000, 45_001, Some(CloseReason::IdleTimeout)),
        (45_000, 1, 15_001, Some(CloseReason::FragmentTimeout)),
    ] {
        let (mut registry, _authority, handle, _peer, permit) = fixture(idle_ms);
        start_reader_fragment(&mut registry, &permit, fragment_at);
        assert!(!registry.claim_expired(&permit, deadline - 1));
        assert!(registry.claim_expired(&permit, deadline));
        assert_eq!(
            registry
                .claim_deadline_barrier(&permit, deadline - 1, Ok)
                .unwrap(),
            deadline
        );
        assert!(matches!(
            registry.claim_deadline_barrier::<()>(&permit, deadline, |_| {
                panic!("equality must refuse before the commit")
            }),
            Err(RegistryError::Revoked)
        ));
        assert_eq!(
            handle.status(),
            closed.map_or(CarrierStatus::Active, CarrierStatus::Closed)
        );
        assert!(registry.claim_expired(&permit, deadline));
    }
}

#[test]
fn deadline_barrier_absent_reader_keeps_fixed_deadline_and_legacy_result() {
    let (mut registry, _authority, handle, _peer, permit) = fixture(45_000);
    assert_eq!(
        registry.claim_deadline_barrier(&permit, 1, Ok).unwrap(),
        45_001
    );
    assert_eq!(
        registry
            .claim_deadline_barrier(&permit, 20_000, Ok)
            .unwrap(),
        45_001
    );
    assert_eq!(
        registry.claim_barrier(&permit, 20_000, || Ok(73)).unwrap(),
        73
    );
    assert!(matches!(
        registry.claim_barrier::<()>(&permit, 20_000, || Err(Error::Authentication)),
        Err(RegistryError::Protocol(Error::Authentication))
    ));
    assert!(matches!(
        registry.claim_deadline_barrier::<()>(&permit, 19_999, |_| panic!("clock regressed")),
        Err(RegistryError::Time)
    ));
    assert_eq!(handle.status(), CarrierStatus::Active);
}

#[test]
fn deadline_barrier_refuses_old_job_serial_without_disturbing_current_claim() {
    let (mut registry, _authority, handle, mut peer, old) = fixture(45_000);
    registry.end_claim(&old, WorkStatus::Completed, 2);
    let token = request(&mut registry, &handle, &mut peer, 2);
    let current = registry.claim_work(&token, 2).unwrap();
    assert_eq!(old.id(), current.id());
    assert_ne!(old.token.serial, current.token.serial);
    assert!(!registry.claim_expired(&old, u64::MAX));
    assert!(matches!(
        registry.claim_deadline_barrier::<()>(&old, 2, |_| panic!("old claim")),
        Err(RegistryError::Revoked)
    ));
    assert_eq!(
        registry.claim_deadline_barrier(&current, 2, Ok).unwrap(),
        45_002
    );
    assert_eq!(token.status(), WorkStatus::InFlight);
    assert_eq!(handle.status(), CarrierStatus::Active);
}

#[test]
fn deadline_barrier_rechecks_exact_generation_registry_and_authorization() {
    let (mut registry, mut authority, old_handle, _peer, old) = fixture(45_000);
    let (current_handle, mut peer) = install(&mut registry, &mut authority, 2);
    let token = request(&mut registry, &current_handle, &mut peer, 2);
    let current = registry.claim_work(&token, 2).unwrap();
    assert_eq!(
        old_handle.status(),
        CarrierStatus::Closed(CloseReason::Replaced)
    );
    assert!(!registry.claim_expired(&old, u64::MAX));
    assert!(matches!(
        registry.claim_deadline_barrier::<()>(&old, 2, |_| panic!("old generation")),
        Err(RegistryError::Revoked)
    ));
    assert_eq!(
        registry.claim_deadline_barrier(&current, 2, Ok).unwrap(),
        45_002
    );
    let (mut foreign, _authority, _handle, _peer, _permit) = fixture(45_000);
    assert!(!foreign.claim_expired(&current, u64::MAX));
    assert!(matches!(
        foreign.claim_deadline_barrier::<()>(&current, 2, |_| panic!("foreign registry")),
        Err(RegistryError::Revoked)
    ));
    authority.retire();
    assert!(!registry.claim_expired(&current, u64::MAX));
    assert!(matches!(
        registry.claim_deadline_barrier::<()>(&current, 2, |_| panic!("revoked session")),
        Err(RegistryError::Revoked)
    ));
    assert_eq!(
        current_handle.status(),
        CarrierStatus::Closed(CloseReason::Removed)
    );
    assert!(!registry.claim_expired(&current, u64::MAX));
}

#[test]
fn expired_claim_retains_its_own_timeout_cause_without_expiring_successors() {
    let (mut registry, mut authority, handle, mut peer, expired) = fixture(45_000);
    registry.end_claim(&expired, WorkStatus::TimedOut, 2);
    assert!(registry.claim_expired(&expired, 2));
    let token = request(&mut registry, &handle, &mut peer, 2);
    let current = registry.claim_work(&token, 2).unwrap();
    assert!(!registry.claim_expired(&current, 2));
    assert!(registry.claim_expired(&expired, 2));
    let (mut foreign, _authority, _handle, _peer, _permit) = fixture(45_000);
    assert!(!foreign.claim_expired(&expired, u64::MAX));
    let (replacement, mut peer) = install(&mut registry, &mut authority, 3);
    let token = request(&mut registry, &replacement, &mut peer, 3);
    let replacement_claim = registry.claim_work(&token, 3).unwrap();
    assert!(registry.claim_expired(&expired, 3));
    assert!(!registry.claim_expired(&current, u64::MAX));
    assert!(!registry.claim_expired(&replacement_claim, 3));
    assert!(matches!(
        foreign.claim_deadline_barrier::<()>(&expired, 3, |_| panic!("foreign expired claim")),
        Err(RegistryError::Revoked)
    ));
}

#[test]
fn fixed_emit_supplies_actual_deadline_before_seal_and_propagates_refusal() {
    let (mut registry, _authority, handle, mut peer, first) = fixture(45_000);
    registry.end_claim(&first, WorkStatus::Completed, 1);
    let token = request(&mut registry, &handle, &mut peer, 1);
    let grant = Grant::new(
        TargetId {
            authority: [7; 16],
            generation: handle.generation(),
            serial: 1,
        },
        1,
    );
    registry
        .reserve_fixed_output(&token, grant.0.clone(), 1)
        .unwrap();
    let permit = registry
        .claim_fixed_work(&token, 1, Some(&grant.0))
        .unwrap();
    start_reader_fragment(&mut registry, &permit, 1);
    let active = registry.claimed(&permit, 1).unwrap();
    let lease = active.budget().reserve(FIXTURE_FRAME).unwrap();
    let (returned, receiver) = receipt_cell();
    assert!(matches!(
        registry.emit_fixed_claim(&permit, &grant.0, b"null", lease, returned, 1, |deadline| {
            assert_eq!(deadline, 15_001);
            Err(Error::Timeout)
        }),
        Err(RegistryError::Protocol(Error::Timeout))
    ));
    let active = registry.claimed(&permit, 1).unwrap();
    assert!(active.fixed_packet.is_none());
    assert!(receiver.try_recv().is_err());
    let wire = active.session.seal_encoded(b"null").unwrap();
    assert_eq!(peer.open_encoded(&wire).unwrap(), b"null");
}

use milagre_remote::{
    admission::{Limits as AdmissionLimits, Source},
    budget::ConnectionBudget,
    channel::{self, Channel, DesktopAccess, DeviceKind, HelloOptions, PendingHello},
    peer::{Direction, FrameWriter, FRAME_TIMEOUT_MS, PART_THRESHOLD},
    phone::{request_parts, Headers, Method, Request, CHUNK},
    policy::{self, Session, TemporaryAuthority},
    registry::{
        self, CarrierStatus, CloseReason, Handle, Registry, RegistryError, WorkStatus, WorkToken,
    },
    Error, SecretKey,
};
use rand_core::OsRng;
const TOKEN: &str = "synthetic-registry-token";
fn authority() -> TemporaryAuthority {
    TemporaryAuthority::create_synthetic(
        SecretKey::from([1; 32]),
        TOKEN.into(),
        DesktopAccess::Enabled,
        policy::Limits {
            admission: AdmissionLimits {
                failures_global: 100,
                failures_per_source: 100,
                ..Default::default()
            },
            ..Default::default()
        },
        &mut OsRng,
    )
    .unwrap()
}
fn session(
    a: &mut TemporaryAuthority,
    seed: u8,
    kind: DeviceKind,
    now: u64,
) -> (Session, PendingHello) {
    a.open_pairing(now).unwrap();
    let (bytes, pending) = channel::phone_hello(
        &SecretKey::from([seed; 32]),
        &SecretKey::from([1; 32]).public_key(),
        TOKEN,
        HelloOptions {
            kind: Some(kind),
            ..Default::default()
        },
        &mut OsRng,
    )
    .unwrap();
    let ticket = a.begin(Source::Direct(1), &bytes, now, &mut OsRng).unwrap();
    if kind == DeviceKind::Desktop && a.pending_device(&ticket).unwrap().first_pairing {
        a.approve_desktop(&ticket, now).unwrap();
    }
    (a.complete(ticket, || now).unwrap(), pending)
}
fn install(
    r: &mut Registry,
    a: &mut TemporaryAuthority,
    carrier: u64,
    seed: u8,
    kind: DeviceKind,
    now: u64,
) -> (Handle, Channel, ConnectionBudget, String) {
    let h = r.open_carrier(carrier, now).unwrap();
    let (s, pending) = session(a, seed, kind, now);
    let budget = s.budget();
    let key = s.device().key.clone();
    r.establish(&h, s, now).unwrap();
    let mut reply = Vec::new();
    assert!(r
        .take_output(&h, now, |b| {
            reply.extend_from_slice(b);
            Ok(())
        })
        .unwrap());
    (h, pending.finish(&reply).unwrap(), budget, key)
}
fn registry(limits: registry::Limits) -> Registry {
    Registry::new(limits, &mut OsRng).unwrap()
}
fn parts(id: i64, size: usize) -> Vec<Vec<u8>> {
    request_parts(&Request {
        id,
        method: Method::POST,
        path: "/rpc".into(),
        headers: Headers::new(),
        body: vec![b'x'; size],
    })
    .unwrap()
}
fn request(
    r: &mut Registry,
    h: &Handle,
    c: &mut Channel,
    id: i64,
    size: usize,
    now: u64,
) -> Vec<WorkToken> {
    let mut started = Vec::new();
    for p in parts(id, size) {
        started.extend(
            r.receive_request(h, &c.seal_encoded(&p).unwrap(), now)
                .unwrap(),
        );
    }
    started
}
#[test]
fn disconnect_cancels_queued_and_inflight_releases_all_leases_and_rejects_callbacks() {
    let mut a = authority();
    let mut r = registry(registry::Limits {
        inflight: 1,
        queued: 2,
        ..Default::default()
    });
    let (h, mut c, budget, _) = install(&mut r, &mut a, 7, 2, DeviceKind::Phone, 0);
    let running = request(&mut r, &h, &mut c, 1, CHUNK + 1, 0).pop().unwrap();
    assert!(request(&mut r, &h, &mut c, 2, 100, 0).is_empty());
    let queued = r.work_token(&h, 2).unwrap();
    r.send_encoded(&h, br#"{"t":"pong"}"#, 0).unwrap();
    assert!(budget.used() > CHUNK);
    assert_eq!(r.stats(&h).unwrap().inflight, 1);
    assert_eq!(r.stats(&h).unwrap().queued, 1);
    assert!(r.close(&h, CloseReason::Disconnected));
    assert_eq!(budget.used(), 0);
    assert_eq!(budget.global_used(), 0);
    assert_eq!(running.status(), WorkStatus::Cancelled);
    assert_eq!(queued.status(), WorkStatus::Cancelled);
    assert!(r.finish_request(&running, b"null", 1).is_err());
    assert!(r
        .with_request(&running, 1, |_| panic!("late work must not run"))
        .is_err());
    assert!(r.send_encoded(&h, b"null", 1).is_err());
    assert!(r.receive_request(&h, b"junk", 1).is_err());
    assert!(r.take_output(&h, 1, |_| panic!("closed output")).is_err());
    assert!(!r.close(&h, CloseReason::Disconnected));
}
#[test]
fn replacement_and_late_authorization_cannot_close_or_resurrect_successor() {
    let mut a = authority();
    let mut r = registry(Default::default());
    let (h, mut c, budget, _) = install(&mut r, &mut a, 7, 2, DeviceKind::Phone, 0);
    let old_work = request(&mut r, &h, &mut c, 1, 500, 0).pop().unwrap();
    let replacement = r.open_carrier(7, 1).unwrap();
    assert_eq!(h.status(), CarrierStatus::Closed(CloseReason::Replaced));
    assert_eq!(budget.used(), 0);
    let (stale, _) = session(&mut a, 2, DeviceKind::Phone, 1);
    assert!(r.establish(&h, stale, 1).is_err());
    assert!(!r.close(&h, CloseReason::Protocol));
    assert!(r.finish_request(&old_work, b"null", 1).is_err());
    let (new, _) = session(&mut a, 2, DeviceKind::Phone, 1);
    r.establish(&replacement, new, 1).unwrap();
    let (duplicate, _) = session(&mut a, 2, DeviceKind::Phone, 1);
    assert!(r.establish(&replacement, duplicate, 1).is_err());
    assert_eq!(replacement.status(), CarrierStatus::Active);
    r.send_encoded(&replacement, b"null", 1).unwrap();
}
#[test]
fn removal_revokes_all_matching_sessions_and_retirement_blocks_late_installs() {
    let mut a = authority();
    let mut r = registry(Default::default());
    let (h1, _, b1, key) = install(&mut r, &mut a, 1, 2, DeviceKind::Phone, 0);
    let (h2, _, b2, _) = install(&mut r, &mut a, 2, 2, DeviceKind::Phone, 0);
    let (other, _, b3, _) = install(&mut r, &mut a, 3, 3, DeviceKind::Phone, 0);
    let (late, _) = session(&mut a, 2, DeviceKind::Phone, 0);
    let pending = r.open_carrier(4, 0).unwrap();
    a.remove(&mut r, &key, 0).unwrap();
    assert_eq!(h1.status(), CarrierStatus::Closed(CloseReason::Removed));
    assert_eq!(h2.status(), CarrierStatus::Closed(CloseReason::Removed));
    assert_eq!(b1.used(), 0);
    assert_eq!(b2.used(), 0);
    assert_eq!(b1.device_used(), Some(0));
    assert!(b3.used() > 0);
    assert!(r.establish(&pending, late, 0).is_err());
    assert_eq!(other.status(), CarrierStatus::Active);
    let (waiting, _) = session(&mut a, 3, DeviceKind::Phone, 0);
    let pending = r.open_carrier(5, 0).unwrap();
    r.retire();
    assert_eq!(other.status(), CarrierStatus::Closed(CloseReason::Retired));
    assert_eq!(b3.global_used(), 0);
    assert!(r.establish(&pending, waiting, 0).is_err());
    assert!(r.open_carrier(99, 0).is_err());
}
#[test]
fn periodic_ticks_expire_idle_and_partial_peer_frames_without_network_input() {
    let mut a = authority();
    let mut r = registry(Default::default());
    let pending = r.open_carrier(99, 0).unwrap();
    r.tick(15_000).unwrap();
    assert_eq!(
        pending.status(),
        CarrierStatus::Closed(CloseReason::HelloTimeout)
    );
    let (h, mut c, budget, _) = install(&mut r, &mut a, 1, 2, DeviceKind::Desktop, 15_000);
    let text = format!("\"{}\"", "x".repeat(PART_THRESHOLD));
    let frames = FrameWriter::new(Direction::Rpc).write(&text).unwrap();
    assert!(!r
        .receive_peer(
            &h,
            &c.seal_encoded(&frames[0]).unwrap(),
            15_000,
            |_| panic!("partial")
        )
        .unwrap());
    assert!(budget.used() > 500_000);
    assert_eq!(r.next_deadline_ms(), Some(15_000 + FRAME_TIMEOUT_MS));
    r.heard(&h, 20_000).unwrap();
    r.tick(15_000 + FRAME_TIMEOUT_MS).unwrap();
    assert_eq!(
        h.status(),
        CarrierStatus::Closed(CloseReason::FragmentTimeout)
    );
    assert_eq!(budget.global_used(), 0);
    let (h, _, budget, _) = install(&mut r, &mut a, 2, 3, DeviceKind::Phone, 30_000);
    r.tick(74_999).unwrap();
    assert_eq!(h.status(), CarrierStatus::Active);
    r.tick(75_000).unwrap();
    assert_eq!(h.status(), CarrierStatus::Closed(CloseReason::IdleTimeout));
    assert_eq!(budget.used(), 0);
    assert!(matches!(r.tick(74_000), Err(RegistryError::Time)));
}
#[test]
fn queued_and_active_deadlines_cancel_and_promote_in_order() {
    let mut a = authority();
    let mut r = registry(registry::Limits {
        inflight: 1,
        queued: 2,
        queue_wait_ms: 10,
        request_ms: 5,
        idle_ms: 100,
        ..Default::default()
    });
    let (h, mut c, _, _) = install(&mut r, &mut a, 1, 2, DeviceKind::Phone, 0);
    let first = request(&mut r, &h, &mut c, 1, 5, 0).pop().unwrap();
    request(&mut r, &h, &mut c, 2, 7, 0);
    let second = r.work_token(&h, 2).unwrap();
    let started = r.tick(5).unwrap();
    assert_eq!(first.status(), WorkStatus::TimedOut);
    assert_eq!(started.len(), 1);
    assert_eq!(started[0].id(), 2);
    assert_eq!(r.with_request(&started[0], 5, |q| q.body.len()).unwrap(), 7);
    assert!(r.finish_request(&first, b"null", 5).is_err());
    let none = r.finish_request(&second, b"null", 6).unwrap();
    assert!(none.is_empty());
    assert_eq!(second.status(), WorkStatus::Completed);
    let first = request(&mut r, &h, &mut c, 3, 1, 7).pop().unwrap();
    request(&mut r, &h, &mut c, 4, 1, 7);
    let queued = r.work_token(&h, 4).unwrap();
    r.tick(17).unwrap();
    assert_eq!(first.status(), WorkStatus::TimedOut);
    assert_eq!(queued.status(), WorkStatus::TimedOut);
    assert_eq!(r.stats(&h).unwrap().inflight, 0);
}
#[test]
fn completed_id_can_be_reused_but_old_callback_cannot_complete_new_work() {
    let mut a = authority();
    let mut r = registry(Default::default());
    let (h, mut c, _, _) = install(&mut r, &mut a, 1, 2, DeviceKind::Phone, 0);
    let old = request(&mut r, &h, &mut c, 1, 4, 0).pop().unwrap();
    r.finish_request(&old, b"null", 0).unwrap();
    let current = request(&mut r, &h, &mut c, 1, 9, 0).pop().unwrap();
    assert!(r.finish_request(&old, b"null", 0).is_err());
    assert_eq!(current.status(), WorkStatus::InFlight);
    assert_eq!(r.with_request(&current, 0, |q| q.body.len()).unwrap(), 9);
}
#[test]
fn upload_leases_expire_and_last_part_at_combined_request_limit_is_allowed() {
    let mut a = authority();
    let mut r = registry(registry::Limits {
        inflight: 1,
        queued: 0,
        queue_wait_ms: 5,
        idle_ms: 100,
        ..Default::default()
    });
    let (h, mut c, budget, _) = install(&mut r, &mut a, 1, 2, DeviceKind::Phone, 0);
    let baseline = budget.used();
    let p = parts(1, CHUNK + 1);
    r.receive_request(&h, &c.seal_encoded(&p[0]).unwrap(), 0)
        .unwrap();
    assert!(budget.used() > baseline + CHUNK);
    let started = r
        .receive_request(&h, &c.seal_encoded(&p[1]).unwrap(), 0)
        .unwrap();
    assert_eq!(started.len(), 1);
    r.finish_request(&started[0], b"null", 0).unwrap();
    r.take_output(&h, 0, |_| Ok(())).unwrap();
    assert_eq!(budget.used(), baseline);
    r.receive_request(&h, &c.seal_encoded(&p[0]).unwrap(), 1)
        .unwrap();
    r.tick(6).unwrap();
    assert_eq!(r.stats(&h).unwrap().uploads, 0);
    assert_eq!(budget.used(), baseline);
    assert!(r
        .receive_request(&h, &c.seal_encoded(&p[1]).unwrap(), 6)
        .unwrap()
        .is_empty());
    assert_eq!(budget.used(), baseline);
}
#[test]
fn outbound_failure_bounds_and_registry_drop_release_buffers_and_tokens() {
    let mut a = authority();
    let mut r = registry(registry::Limits {
        outbound_frames: 1,
        ..Default::default()
    });
    let (h, mut c, budget, _) = install(&mut r, &mut a, 1, 2, DeviceKind::Phone, 0);
    let work = request(&mut r, &h, &mut c, 1, 600, 0).pop().unwrap();
    r.send_encoded(&h, b"null", 0).unwrap();
    assert!(r.send_encoded(&h, b"null", 0).is_err());
    assert_eq!(h.status(), CarrierStatus::Closed(CloseReason::Limit));
    assert_eq!(work.status(), WorkStatus::Cancelled);
    assert_eq!(budget.global_used(), 0);
    let (h, mut c, budget, _) = install(&mut r, &mut a, 2, 3, DeviceKind::Phone, 1);
    let work = request(&mut r, &h, &mut c, 2, 600, 1).pop().unwrap();
    r.send_encoded(&h, b"null", 1).unwrap();
    assert!(r.take_output(&h, 1, |_| Err(Error::Envelope)).is_err());
    assert_eq!(budget.used(), 0);
    assert_eq!(work.status(), WorkStatus::Cancelled);
    let (h, mut c, budget, _) = install(&mut r, &mut a, 3, 4, DeviceKind::Phone, 2);
    let work = request(&mut r, &h, &mut c, 3, 600, 2).pop().unwrap();
    drop(r);
    assert_eq!(h.status(), CarrierStatus::Closed(CloseReason::Retired));
    assert_eq!(budget.used(), 0);
    assert_eq!(work.status(), WorkStatus::Cancelled);
}
#[test]
fn limits_foreign_handles_and_revoked_session_operations_fail_closed() {
    let mut a = authority();
    let mut r = registry(registry::Limits {
        carriers: 1,
        ..Default::default()
    });
    let h = r.open_carrier(1, 0).unwrap();
    assert!(r.open_carrier(2, 0).is_ok());
    assert_eq!(h.status(), CarrierStatus::Closed(CloseReason::Replaced));
    assert_eq!(r.carriers(), 1);
    let mut foreign = registry(Default::default());
    assert!(!foreign.close(&h, CloseReason::Disconnected));
    assert!(foreign.send_encoded(&h, b"null", 0).is_err());
    r.retire();
    assert_eq!(r.carriers(), 0);
    assert!(r.open_carrier(1, 0).is_err());
    let (mut s, _) = session(&mut a, 2, DeviceKind::Phone, 0);
    s.revoke();
    assert!(s.is_revoked());
    assert!(s.reply().is_err());
    assert_eq!(s.open_encoded(b"bad"), Err(Error::Unauthorized));
    assert_eq!(s.seal_encoded(b"null"), Err(Error::Unauthorized));
    assert!(s.reader(Direction::Rpc).is_err());
    assert!(s.writer(Direction::Evt).is_err());
}
#[test]
fn failed_establish_releases_owned_state_without_releasing_external_lease() {
    let mut a = authority();
    let mut r = registry(Default::default());
    let (s, _) = session(&mut a, 2, DeviceKind::Phone, 0);
    let budget = s.budget();
    let held = budget.reserve(64 * 1024 * 1024).unwrap();
    let h = r.open_carrier(1, 0).unwrap();
    assert!(r.establish(&h, s, 0).is_err());
    assert_eq!(budget.used(), 64 * 1024 * 1024);
    drop(held);
    assert_eq!(budget.global_used(), 0);
    assert_eq!(h.status(), CarrierStatus::Closed(CloseReason::Limit));
}
#[test]
fn phone_bytes_remain_lossless_through_owned_output() {
    let mut a = authority();
    let mut r = registry(Default::default());
    let (h, mut c, _, _) = install(&mut r, &mut a, 1, 2, DeviceKind::Phone, 0);
    let json = r#"{"t":"live","id":1,"data":"\ud800\udfff󰀀"}"#;
    r.send_encoded(&h, json.as_bytes(), 0).unwrap();
    r.take_output(&h, 0, |bytes| {
        assert_eq!(c.open_encoded(bytes)?, json.as_bytes());
        Ok(())
    })
    .unwrap();
}
#[test]
fn node_lifecycle_fixture_matches_release_and_late_continuation_rules() {
    let f: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/registry-node.json")).unwrap();
    let node = &f["observed"];
    let mut a = authority();
    let mut r = registry(registry::Limits {
        inflight: 1,
        queued: 1,
        ..Default::default()
    });
    let (h, mut c, budget, _) = install(&mut r, &mut a, 7, 2, DeviceKind::Phone, 0);
    let active = request(&mut r, &h, &mut c, 1, 3, 0).pop().unwrap();
    request(&mut r, &h, &mut c, 2, 5, 0);
    let queued = r.work_token(&h, 2).unwrap();
    r.send_encoded(&h, b"null", 0).unwrap();
    let replacement = r.open_carrier(7, 1).unwrap();
    assert!(!r.close(&h, CloseReason::Disconnected));
    assert!(r.finish_request(&active, b"null", 1).is_err());
    assert_eq!(
        replacement.status() == CarrierStatus::Pending,
        node["replacementKeepsSuccessor"].as_bool().unwrap()
    );
    assert_eq!(
        r.stats(&h).map_or(0, |s| s.queued),
        node["queuedAfterClose"].as_u64().unwrap() as usize
    );
    assert_eq!(budget.used(), 0);
    assert_eq!(active.status(), WorkStatus::Cancelled);
    assert_eq!(queued.status(), WorkStatus::Cancelled);
    assert_eq!(node["lateResponseFrames"], 0);
    // Intentional stronger cancellation: Node suppresses late output but does not abort its fetch.
    assert_eq!(node["nodeInflightAfterClose"], 1);
    assert_eq!(node["nodeFetchAbortedOnDisconnect"], false);
}
#[test]
fn complete_peer_frames_roundtrip_losslessly_in_both_directions() {
    let mut a = authority();
    let mut r = registry(Default::default());
    let (h, mut c, budget, _) = install(&mut r, &mut a, 1, 2, DeviceKind::Desktop, 0);
    let text = format!("{{\"x\":\"{}\\ud800󰀀\"}}", "a".repeat(PART_THRESHOLD));
    let frames = FrameWriter::new(Direction::Rpc).write(&text).unwrap();
    let mut observed = 0;
    for frame in frames.iter() {
        r.receive_peer(&h, &c.seal_encoded(frame).unwrap(), 0, |raw| {
            assert_eq!(raw, text.as_bytes());
            observed += 1;
        })
        .unwrap();
    }
    assert_eq!(observed, 1);
    r.send_peer(&h, &text, 0).unwrap();
    let mut reader = milagre_remote::peer::FrameReader::new(Direction::Evt);
    let mut response = None;
    while r
        .take_output(&h, 0, |sealed| {
            let plain = c.open_encoded(sealed)?;
            if let Some(frame) = reader.read(&plain, 0)? {
                response = Some(frame);
            }
            Ok(())
        })
        .unwrap()
    {}
    assert_eq!(response.unwrap().as_bytes(), text.as_bytes());
    r.close(&h, CloseReason::Disconnected);
    assert_eq!(budget.global_used(), 0);
}

#[test]
fn removal_epoch_allows_fresh_pairing_but_never_old_sessions_or_tickets() {
    let mut a = authority();
    let mut r = registry(Default::default());
    let (h, _, budget, key) = install(&mut r, &mut a, 1, 2, DeviceKind::Phone, 1);
    let (mut completed_before, _) = session(&mut a, 2, DeviceKind::Phone, 1);
    let (bytes, _) = channel::phone_hello(
        &SecretKey::from([2; 32]),
        &SecretKey::from([1; 32]).public_key(),
        TOKEN,
        HelloOptions::default(),
        &mut OsRng,
    )
    .unwrap();
    let ticket_before = a.begin(Source::Relay, &bytes, 1, &mut OsRng).unwrap();
    a.remove(&mut r, &key, 1).unwrap();
    assert_eq!(h.status(), CarrierStatus::Closed(CloseReason::Removed));
    assert_eq!(budget.used(), 0);
    assert!(completed_before.is_revoked());
    assert!(completed_before.reply().is_err());
    assert_eq!(
        completed_before.seal_encoded(b"null"),
        Err(Error::Unauthorized)
    );
    a.open_pairing(2).unwrap();
    assert!(a.complete(ticket_before, || 2).is_err());
    let (fresh, _, _, _) = install(&mut r, &mut a, 2, 2, DeviceKind::Phone, 2);
    assert_eq!(fresh.status(), CarrierStatus::Active);
    let pending = r.open_carrier(3, 2).unwrap();
    assert!(r.establish(&pending, completed_before, 2).is_err());
    r.send_encoded(&fresh, b"null", 2).unwrap();
}
#[test]
fn more_than_64_distinct_removals_do_not_retire_registry() {
    let mut a = TemporaryAuthority::create_synthetic(
        SecretKey::from([1; 32]),
        TOKEN.into(),
        DesktopAccess::Enabled,
        policy::Limits {
            records: 128,
            admission: AdmissionLimits {
                enrollment_crypto_units: 128,
                ..Default::default()
            },
            ..Default::default()
        },
        &mut OsRng,
    )
    .unwrap();
    let mut r = registry(Default::default());
    let (unrelated, _, _, _) = install(&mut r, &mut a, 1, 200, DeviceKind::Phone, 1);
    for seed in 2..72 {
        let (_, _, _, key) = install(&mut r, &mut a, 2, seed, DeviceKind::Phone, u64::from(seed));
        a.remove(&mut r, &key, u64::from(seed)).unwrap();
        assert_eq!(unrelated.status(), CarrierStatus::Active);
    }
    let (fresh, _, _, _) = install(&mut r, &mut a, 3, 2, DeviceKind::Phone, 73);
    assert_eq!(fresh.status(), CarrierStatus::Active);
    assert_eq!(r.carriers(), 2);
}
#[test]
fn shared_epoch_covers_other_registries_and_authority_disposal() {
    let mut a = authority();
    let mut r = registry(Default::default());
    let mut other = registry(Default::default());
    let (h, _, budget, key) = install(&mut r, &mut a, 1, 2, DeviceKind::Phone, 1);
    a.remove(&mut other, &key, 1).unwrap(); // wrong registry still cannot leave usable access behind
    let mut delivered = false;
    assert!(r
        .take_output(&h, 1, |_| {
            delivered = true;
            Ok(())
        })
        .is_err());
    assert!(!delivered);
    assert_eq!(budget.used(), 0);
    let (h, _, budget, _) = install(&mut r, &mut a, 2, 3, DeviceKind::Phone, 2);
    drop(a);
    r.tick(2).unwrap();
    assert!(matches!(h.status(), CarrierStatus::Closed(_)));
    assert_eq!(budget.used(), 0);
}
#[test]
fn removal_waits_for_started_delivery_then_forbids_any_later_delivery() {
    use std::{sync::mpsc, time::Duration};
    let mut a = authority();
    let mut r = registry(Default::default());
    let mut other = registry(Default::default());
    let (h, _, _, key) = install(&mut r, &mut a, 1, 2, DeviceKind::Phone, 1);
    r.send_encoded(&h, b"null", 1).unwrap();
    let (entered_tx, entered_rx) = mpsc::sync_channel(1);
    let (release_tx, release_rx) = mpsc::sync_channel(1);
    let (done_tx, done_rx) = mpsc::sync_channel(1);
    std::thread::scope(|scope| {
        let registry_ref = &mut r;
        let handle_ref = &h;
        let delivery = scope.spawn(move || {
            registry_ref.take_output(handle_ref, 1, |_| {
                entered_tx.send(()).unwrap();
                release_rx.recv_timeout(Duration::from_secs(3)).unwrap();
                Ok(())
            })
        });
        entered_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        let removal = scope.spawn(|| {
            a.remove(&mut other, &key, 1).unwrap();
            done_tx.send(()).unwrap();
        });
        assert!(done_rx.recv_timeout(Duration::from_millis(20)).is_err());
        release_tx.send(()).unwrap();
        delivery.join().unwrap().unwrap();
        removal.join().unwrap();
    });
    assert!(r.send_encoded(&h, b"null", 1).is_err());
}

#[test]
fn pending_carrier_flood_evicts_oldest_pending_and_preserves_established_phones() {
    let mut a = authority();
    let mut r = registry(Default::default());
    let (active, _, _, _) = install(&mut r, &mut a, 1, 2, DeviceKind::Phone, 1);
    let oldest = r.open_carrier(2, 1).unwrap();
    for id in 3..34 {
        r.open_carrier(id, 1).unwrap();
        assert!(r.carriers() <= 9);
    }
    assert_eq!(
        oldest.status(),
        CarrierStatus::Closed(CloseReason::Replaced)
    );
    assert_eq!(active.status(), CarrierStatus::Active);
    let (known, _) = session(&mut a, 2, DeviceKind::Phone, 1);
    assert!(!known.device().first_pairing);
    let h = r.open_carrier(34, 1).unwrap();
    r.establish(&h, known, 1).unwrap();
    assert_eq!(h.status(), CarrierStatus::Active);
}

#[test]
fn synthetic_dispatch_reserves_exact_connection_threshold_before_invoking() {
    use milagre_remote::http_dispatch::{MemoryHttp, Outcome};
    let mut a = authority();
    let mut r = registry(Default::default());
    let (h, mut ch, budget, _) = install(&mut r, &mut a, 1, 2, DeviceKind::Phone, 0);
    let token = request(&mut r, &h, &mut ch, 1, 20, 0).pop().unwrap();
    let http = MemoryHttp::new(Outcome::Response {
        status: 200,
        headers: Headers::new(),
        body: vec![165; CHUNK + 1],
    })
    .unwrap();
    let needed = r
        .with_request(&token, 0, |request| http.required_bytes(request).unwrap())
        .unwrap();
    let baseline = budget.used();
    let occupied = budget
        .reserve(64 * 1024 * 1024 - baseline - (needed - 1))
        .unwrap();
    assert!(matches!(
        r.dispatch_synthetic(&token, &http, 0),
        Err(RegistryError::Protocol(Error::Budget))
    ));
    assert_eq!(http.calls(), 0);
    assert_eq!(h.status(), CarrierStatus::Active);
    assert_eq!(token.status(), WorkStatus::InFlight);
    drop(occupied);
    assert_eq!(budget.used(), baseline);
    let occupied = budget
        .reserve(64 * 1024 * 1024 - baseline - needed)
        .unwrap();
    let (record, _) = r.dispatch_synthetic(&token, &http, 0).unwrap();
    assert_eq!(record.response_parts, 2);
    assert_eq!(http.calls(), 1);
    assert_eq!(token.status(), WorkStatus::Completed);
    let mut count = 0;
    while r
        .take_output(&h, 0, |bytes| {
            ch.open_encoded(bytes).unwrap();
            count += 1;
            Ok(())
        })
        .unwrap()
    {}
    assert_eq!(count, 2);
    r.close(&h, CloseReason::Disconnected);
    drop(occupied);
    assert_eq!(budget.used(), 0);
    assert_eq!(budget.global_used(), 0);
}

use super::*;
use fixed::peer::{PeerRejection, PeerTransfer, PEER_BYTES};

fn peer_installed(
    fixed: &FixedOwnerClient,
    handle: &Handle,
    peer: Channel,
) -> crate::persistent::fixed_executor::TargetId {
    fixed
        .adopt_peer(PeerTransfer::new(handle.clone(), peer))
        .unwrap()
        .wait(WAIT)
        .unwrap()
}
fn request(fixed: &FixedOwnerClient, target: crate::persistent::fixed_executor::TargetId, id: i64) {
    fixed
        .request_fixture(target, id)
        .unwrap()
        .wait(WAIT)
        .unwrap();
}

#[test]
fn actor_owned_peer_sends_actual_consecutive_requests_and_preserves_ready_without_delivery() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, owner, fixed, _) = fixture();
    fixed.pause_dispatch(false);
    let (h, memory, peer) = phone(&owner, 1, 4);
    let target = adopted(&fixed, &h);
    let before = s.retained_bytes();
    assert_eq!(peer_installed(&fixed, &h, peer), target);
    assert_eq!(fixed.peer_counts(), (1, 0, 1));
    assert_eq!(s.retained_bytes(), before + PEER_BYTES);
    assert!(fixed
        .request_fixture(target, i64::MIN)
        .unwrap()
        .wait(WAIT)
        .is_err());
    assert!(!memory.is_closed()); // Pre-seal schema refusal consumes no peer counter.
    for (id, outcome, status) in [
        (-9_007_199_254_740_991, FixedOutcome::Success, 200),
        (0, FixedOutcome::Unavailable, 502),
        (9_007_199_254_740_991, FixedOutcome::Timeout, 504),
    ] {
        request(&fixed, target, id);
        let work = tokens(&owner);
        assert_eq!(work.len(), 1);
        assert_eq!(work[0].id(), id);
        let permit = prepared(&fixed, &work[0]);
        fixed.configure(
            permit.id(),
            fixed::TestHooks {
                output: Some(Arc::new(fixed::OutputHooks {
                    hold_emit: AtomicBool::new(true),
                    ..Default::default()
                })),
                ..Default::default()
            },
        );
        let attempt = fixed.submit(permit, outcome).unwrap().id();
        wait(
            || matches!(fixed.observe(attempt),Observation::Present {phase:Phase::Ready,status:Some(s),cleanup_pending:true,..} if s==status),
        );
        assert_eq!(fixed.ack_terminal(attempt), Err(StatusRefusal::NotTerminal));
        assert_eq!(memory.delivery_attempts(), 1);
        assert!(memory.receive().is_none());
        fixed.cancel(attempt).unwrap();
        wait(|| {
            matches!(
                fixed.observe(attempt),
                Observation::Present {
                    phase: Phase::Terminal(Terminal::Cancelled),
                    cleanup_pending: false,
                    ..
                }
            )
        });
        fixed.ack_terminal(attempt).unwrap();
    }
    assert_eq!(s.retained_bytes(), before + PEER_BYTES);
    run(&owner, C::Disconnect(h));
    wait(|| fixed.peer_counts() == (0, 0, 0));
    assert!(memory.is_closed());
    finish(s);
}

#[test]
fn peer_needed_minus_one_and_exact_charge_original_connection_device_and_global() {
    let _disk = crate::synthetic_store::testing_lock();
    for scope in 0..3 {
        let (s, owner, fixed, _) = fixture();
        let (h, memory, peer) = phone(&owner, 1, 4);
        let (alias, _, _) = phone(&owner, 2, if scope == 1 { 4 } else { 5 });
        let target = adopted(&fixed, &h);
        let other = adopted(&fixed, &alias);
        let budget = fixed.peer_budget(target);
        let alias_budget = fixed.peer_budget(other);
        let global = s.shared.global.clone();
        let pool = global.connection(256 * 1024 * 1024).unwrap();
        let pressure = |less| {
            let (b, max, used) = match scope {
                0 => (&budget, 64 * 1024 * 1024, budget.used()),
                1 => (
                    &alias_budget,
                    64 * 1024 * 1024,
                    budget.device_used().unwrap(),
                ),
                _ => (&pool, 256 * 1024 * 1024, global.used()),
            };
            b.reserve(max - used - PEER_BYTES + less).unwrap()
        };
        let fill = pressure(1);
        let before = global.used();
        let transfer = match fixed.adopt_peer(PeerTransfer::new(h.clone(), peer)) {
            Err(PeerRejection::Full(t)) => t,
            _ => panic!("needed-minus-one"),
        };
        assert_eq!(global.used(), before);
        assert_eq!(fixed.peer_counts(), (2, 0, 0));
        drop(fill);
        let fill = pressure(0);
        assert_eq!(
            fixed.adopt_peer(transfer).unwrap().wait(WAIT).unwrap(),
            target
        );
        match scope {
            0 => assert_eq!(budget.used(), 64 * 1024 * 1024),
            1 => assert_eq!(budget.device_used(), Some(64 * 1024 * 1024)),
            _ => assert_eq!(global.used(), 256 * 1024 * 1024),
        };
        drop(fill);
        request(&fixed, target, 7); // The returned original Channel retained its counter.
        assert_eq!(tokens(&owner)[0].id(), 7);
        assert!(!memory.is_closed());
        finish(s);
    }
}

#[test]
fn peer_full_returns_original_channel_and_abandoned_replies_keep_accepted_effects_bounded() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, owner, fixed, _) = fixture();
    let (h, memory, peer) = phone(&owner, 1, 4);
    let target = adopted(&fixed, &h);
    let before = s.retained_bytes();
    let (gate, parked) = park(&owner);
    let release = UnparkOnDrop(gate);
    let mut crowded = Vec::new();
    for _ in 0..16 {
        crowded.push(fixed.adopt(h.clone()).unwrap());
    }
    let transfer = match fixed.adopt_peer(PeerTransfer::new(h.clone(), peer)) {
        Err(PeerRejection::Full(t)) => t,
        _ => panic!("full reply cells"),
    };
    assert_eq!(fixed.peer_counts(), (1, 0, 0));
    drop(release);
    parked.wait(WAIT).unwrap();
    for r in &mut crowded {
        assert!(r.wait(WAIT).is_err());
    }
    assert_eq!(s.retained_bytes(), before);
    let (gate, parked) = park(&owner);
    let release = UnparkOnDrop(gate);
    let mut receipt = fixed.adopt_peer(transfer).unwrap();
    assert_eq!(
        receipt.wait(Duration::from_millis(1)),
        Err(WaitFault::Timeout)
    );
    drop(receipt);
    assert_eq!(fixed.peer_counts(), (1, 1, 0));
    assert_eq!(fixed.counts().2, 1); // Abandoned accepted operation retains its exact cell.
    assert_eq!(s.retained_bytes(), before + PEER_BYTES + 1024); // Park command ingress is live.
    drop(release);
    parked.wait(WAIT).unwrap();
    wait(|| fixed.peer_counts() == (1, 0, 1) && fixed.counts().2 == 0);
    let (gate, parked) = park(&owner);
    let release = UnparkOnDrop(gate);
    let mut first = fixed.request_fixture(target, 1).unwrap();
    assert_eq!(
        first.wait(Duration::from_millis(1)),
        Err(WaitFault::Timeout)
    );
    drop(first);
    let mut second = fixed.request_fixture(target, 2).unwrap();
    assert_eq!(fixed.counts().2, 2);
    drop(release);
    parked.wait(WAIT).unwrap();
    second.wait(WAIT).unwrap();
    let all = tokens(&owner);
    assert_eq!(all.iter().map(WorkToken::id).collect::<Vec<_>>(), [1, 2]);
    assert_eq!(fixed.counts().2, 0);
    assert!(memory.receive().is_none());
    finish(s);
}

#[test]
fn peer_owned_targets_refuse_other_producers_without_consuming_work_or_http() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, owner, fixed, _) = fixture();
    let (h, memory, peer) = phone(&owner, 1, 4);
    adopted(&fixed, &h);
    let target = peer_installed(&fixed, &h, peer);
    request(&fixed, target, 1);
    let token = tokens(&owner).remove(0);
    let http =
        crate::http_dispatch::MemoryHttp::new(crate::http_dispatch::Outcome::Timeout).unwrap();
    for command in [
        C::Send {
            handle: h.clone(),
            encoded: b"{}".to_vec(),
        },
        C::Finish {
            token: token.clone(),
            response: b"{}".to_vec(),
        },
        C::DispatchSynthetic {
            token: token.clone(),
            http: http.clone(),
        },
    ] {
        assert!(matches!(
            owner.submit(command).unwrap().wait(WAIT),
            Err(Error::Full)
        ));
    }
    assert_eq!(http.calls(), 0);
    assert_eq!(token.status(), WorkStatus::InFlight);
    assert_eq!(memory.delivery_attempts(), 1);
    assert!(!memory.is_closed());
    let (other, other_memory, _) = phone(&owner, 2, 5);
    run(
        &owner,
        C::Send {
            handle: other,
            encoded: b"{}".to_vec(),
        },
    );
    assert!(other_memory.receive().is_some());
    finish(s);
}

#[test]
fn peer_bad_channel_duplicate_and_post_seal_budget_failure_close_only_the_exact_carrier() {
    let _disk = crate::synthetic_store::testing_lock();
    for fault in 0..3 {
        let (s, owner, fixed, _) = fixture();
        let (h, memory, peer) = phone(&owner, 1, 4);
        adopted(&fixed, &h);
        let (other, other_memory, other_peer) = phone(&owner, 2, 5);
        let target = peer_installed(&fixed, &h, if fault == 1 { other_peer } else { peer });
        if fault == 0 {
            request(&fixed, target, 1);
        }
        let budget = fixed.peer_budget(target);
        let pressure =
            (fault == 2).then(|| budget.reserve(64 * 1024 * 1024 - budget.used()).unwrap());
        assert_eq!(
            fixed.request_fixture(target, 1).unwrap().wait(WAIT),
            Err(WaitFault::Refused(PrepareRefusal::Stale))
        );
        wait(|| fixed.peer_counts() == (0, 0, 0));
        drop(pressure);
        assert!(memory.is_closed());
        assert_eq!(other.status(), CarrierStatus::Active);
        assert!(!other_memory.is_closed());
        assert!(fixed.request_fixture(target, 2).is_err());
        let (fresh, fresh_memory, fresh_peer) = phone(&owner, 1, 4);
        let next = adopted(&fixed, &fresh);
        assert_ne!(next, target);
        assert_eq!(peer_installed(&fixed, &fresh, fresh_peer), next);
        request(&fixed, next, 2);
        assert!(!fresh_memory.is_closed());
        finish(s);
    }
}

#[test]
fn accepted_peer_setup_after_prior_output_closes_exact_target_and_refunds_lease() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, owner, fixed, _) = fixture();
    let (h, memory, peer) = phone(&owner, 1, 4);
    let target = adopted(&fixed, &h);
    let budget = fixed.peer_budget(target);
    run(
        &owner,
        C::Send {
            handle: h.clone(),
            encoded: b"{}".to_vec(),
        },
    ); // Unread ordinary output after roster publication.
    assert_eq!(
        fixed
            .adopt_peer(PeerTransfer::new(h.clone(), peer))
            .unwrap()
            .wait(WAIT),
        Err(WaitFault::Refused(PrepareRefusal::Full))
    );
    wait(|| fixed.peer_counts() == (0, 0, 0));
    assert!(memory.is_closed());
    assert!(memory.receive().is_none());
    assert_eq!(budget.used(), 0);
    finish(s);
}

#[test]
fn queued_peer_replacement_retains_charge_until_resolution_and_cannot_close_successor() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, owner, fixed, _) = fixture();
    let (h, memory, peer) = phone(&owner, 1, 4);
    let target = adopted(&fixed, &h);
    let budget = fixed.peer_budget(target);
    let hold = Arc::new((Mutex::new(false), Condvar::new()));
    let release_hold = UnparkOnDrop(hold.clone());
    let (entered, rx) = mpsc::sync_channel(1);
    run(
        &owner,
        C::Probe(Probe::AfterApply(Box::new(move || {
            entered.send(()).unwrap();
            let (lock, cv) = &*hold;
            let g = lock.lock().unwrap();
            drop(cv.wait_while(g, |open| !*open).unwrap());
        }))),
    );
    let (gate, parked) = park(&owner);
    let release = UnparkOnDrop(gate);
    // The first private turn resolves this refusal; the next ordinary turn
    // applies replacement while the accepted peer transfer is still queued.
    let mut ahead = fixed.adopt(h.clone()).unwrap();
    let mut pending = fixed
        .adopt_peer(PeerTransfer::new(h.clone(), peer))
        .unwrap();
    let fresh_memory = MemoryCarrier::new();
    let replacement = owner
        .submit(C::Attach {
            id: 1,
            carrier: fresh_memory.clone(),
        })
        .unwrap();
    drop(release);
    parked.wait(WAIT).unwrap();
    assert!(ahead.wait(WAIT).is_err());
    rx.recv_timeout(WAIT).unwrap();
    assert!(memory.is_closed());
    assert!(!fresh_memory.is_closed());
    assert_eq!(fixed.peer_counts().1, 1);
    assert_eq!(budget.used(), PEER_BYTES);
    drop(release_hold);
    let fresh = match replacement.wait(WAIT).unwrap() {
        Reply::Attached(h) => h,
        _ => panic!("handle"),
    };
    assert_eq!(
        pending.wait(WAIT),
        Err(WaitFault::Refused(PrepareRefusal::Stale))
    );
    wait(|| fixed.peer_counts() == (0, 0, 0));
    assert_eq!(budget.used(), 0);
    assert_eq!(fresh.status(), CarrierStatus::Pending);
    assert!(!fresh_memory.is_closed());
    let hello = hello(&owner, &fresh, 4, DeviceKind::Phone);
    let peer = hello.finish(&fresh_memory.receive().unwrap()).unwrap();
    let new = adopted(&fixed, &fresh);
    assert_ne!(target, new);
    peer_installed(&fixed, &fresh, peer);
    request(&fixed, new, 1);
    assert!(!fresh_memory.is_closed());
    finish(s);
}

#[test]
fn sixteen_pending_and_installed_peers_share_one_bound_and_forgotten_handles_drain() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, owner, fixed, clock) = fixture();
    let mut pending = Vec::new();
    let mut memories = Vec::new();
    let mut targets = Vec::new();
    for n in 1..=16 {
        clock.advance_to(n * 1001).unwrap();
        let (h, m, peer) = phone(&owner, n, n as u8 + 20);
        let target = adopted(&fixed, &h);
        if n <= 8 {
            peer_installed(&fixed, &h, peer);
        } else {
            pending.push(PeerTransfer::new(h, peer));
        }
        targets.push(target);
        memories.push(m);
    }
    let before = s.retained_bytes();
    let (gate, parked) = park(&owner);
    let release = UnparkOnDrop(gate);
    for transfer in pending {
        std::mem::forget(fixed.adopt_peer(transfer).unwrap());
    }
    assert_eq!(fixed.peer_counts(), (16, 8, 8));
    assert_eq!(s.retained_bytes(), before + 8 * PEER_BYTES + 1024);
    for id in 0..8 {
        std::mem::forget(fixed.request_fixture(targets[0], id).unwrap());
    }
    assert_eq!(fixed.counts().2, 16);
    assert_eq!(fixed.counts().3, 16);
    assert!(matches!(
        fixed.request_fixture(targets[0], 100),
        Err(PrepareRefusal::Full)
    ));
    s.shared.request_stop(false);
    drop(release);
    let _ = parked.wait(WAIT);
    finish(s);
    assert_eq!(fixed.peer_counts(), (0, 0, 0));
    assert_eq!(fixed.counts(), (0, 0, 0, 0));
    assert!(memories.iter().all(MemoryCarrier::is_closed));
    assert_eq!(owner.retained_bytes(), wake::wake_charge().unwrap()); // Only the old strong client retains the charged weak hub.
}

#[test]
fn peer_foreign_service_and_desktop_refusals_preserve_unqueued_channel() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, owner, fixed, _) = fixture();
    let (other, _, foreign, _) = fixture();
    let (h, m, peer) = phone(&owner, 1, 4);
    let target = adopted(&fixed, &h);
    let before = s.retained_bytes();
    let transfer = match foreign.adopt_peer(PeerTransfer::new(h.clone(), peer)) {
        Err(PeerRejection::Unavailable(PrepareRefusal::Stale, t)) => t,
        _ => panic!("foreign transfer"),
    };
    assert_eq!(s.retained_bytes(), before);
    assert!(!m.is_closed());
    fixed.adopt_peer(transfer).unwrap().wait(WAIT).unwrap();
    request(&fixed, target, 1);
    run(&owner, C::EnableDesktop);
    let (d, dm) = attach(&owner, 2);
    let pending = hello(&owner, &d, 5, DeviceKind::Desktop);
    owner
        .approve(approval(&owner))
        .ok()
        .unwrap()
        .wait(WAIT)
        .unwrap();
    let peer = pending.finish(&dm.receive().unwrap()).unwrap();
    adopted(&fixed, &d);
    let before = s.retained_bytes();
    assert!(matches!(
        fixed.adopt_peer(PeerTransfer::new(d.clone(), peer)),
        Err(PeerRejection::Unavailable(PrepareRefusal::Stale, _))
    ));
    assert_eq!(s.retained_bytes(), before);
    assert_eq!(d.status(), CarrierStatus::Active);
    finish(other);
    finish(s);
}

#[test]
fn peer_setup_refuses_active_claim_and_poison_keeps_the_original_writer() {
    let _disk = crate::synthetic_store::testing_lock();
    for poison in [false, true] {
        let (s, owner, fixed, _) = fixture();
        fixed.pause_dispatch(false);
        let (h, memory, mut peer) = phone(&owner, 1, 4);
        let target = adopted(&fixed, &h);
        let budget = fixed.peer_budget(target);
        if poison {
            memory.poison_fixed_mailbox();
        } else {
            work(&owner, &h, &mut peer, 1);
            let token = tokens(&owner).remove(0);
            let id = fixed
                .submit(prepared(&fixed, &token), FixedOutcome::Success)
                .unwrap()
                .id();
            wait(|| {
                matches!(
                    fixed.observe(id),
                    Observation::Present {
                        phase: Phase::Ready,
                        ..
                    }
                )
            });
        }
        let mut receipt = fixed
            .adopt_peer(PeerTransfer::new(h.clone(), peer))
            .unwrap();
        if poison {
            assert!(receipt.wait(WAIT).is_err());
            wait(|| owner.is_finished());
            let (_, mut stopped) = s.close_for_restart().err().unwrap().into_parts();
            assert!(stopped.diagnostics().worker_joined);
            assert!(matches!(
                stopped.profile.acquire_writer(),
                Err(StoreFault::Busy)
            ));
            assert_eq!(budget.used(), 0);
            quarantined(released(stopped)).destroy().unwrap();
        } else {
            assert_eq!(
                receipt.wait(WAIT),
                Err(WaitFault::Refused(PrepareRefusal::Full))
            );
            wait(|| fixed.peer_counts() == (0, 0, 0));
            assert!(memory.is_closed());
            finish(s);
        }
    }
}

#[path = "fixed_delivery_tests.rs"]
mod fixed_delivery_tests;

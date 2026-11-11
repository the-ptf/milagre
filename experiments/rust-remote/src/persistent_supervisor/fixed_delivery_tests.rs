use super::*;
use crate::persistent::fixed_executor::{Delivery, Execution, ExitGate};
use fixed::{OutputCommit, OutputHooks, TestHooks};

struct Release(Arc<ExitGate>);
impl Drop for Release {
    fn drop(&mut self) {
        self.0.release();
    }
}
fn start(
    fixed: &FixedOwnerClient,
    owner: &PersistentOwnerClient,
    target: crate::persistent::fixed_executor::TargetId,
    request_id: i64,
    outcome: FixedOutcome,
    hooks: Arc<OutputHooks>,
) -> fixed::FixedId {
    request(fixed, target, request_id);
    let work = tokens(owner);
    assert_eq!(work.len(), 1);
    let permit = prepared(fixed, &work[0]);
    let id = permit.id();
    fixed.configure(
        id,
        TestHooks {
            output: Some(hooks),
            ..Default::default()
        },
    );
    fixed.submit(permit, outcome).unwrap();
    id
}
fn done(
    fixed: &FixedOwnerClient,
    id: fixed::FixedId,
    terminal: Terminal,
    delivery: Delivery,
    status: u16,
) {
    wait(|| {
        matches!(fixed.observe(id),Observation::Present {
        phase:Phase::Terminal(t),delivery:d,status:Some(s),execution:Execution::MayHaveRun,cleanup_pending:false,..
    } if t==terminal && d==delivery && s==status)
    });
}
fn peer_fixture() -> (
    PersistentSupervisor,
    PersistentOwnerClient,
    FixedOwnerClient,
    ManualClock,
    Handle,
    MemoryCarrier,
    crate::persistent::fixed_executor::TargetId,
) {
    let (s, owner, fixed, clock) = fixture();
    fixed.pause_dispatch(false);
    let (h, memory, peer) = phone(&owner, 1, 4);
    let target = adopted(&fixed, &h);
    assert_eq!(peer_installed(&fixed, &h, peer), target);
    (s, owner, fixed, clock, h, memory, target)
}
#[test]
fn owner_delivers_200_502_504_with_real_peer_credit_and_consecutive_counters() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, owner, fixed, _, _, memory, target) = peer_fixture();
    let baseline = s.retained_bytes();
    for (n, (outcome, status)) in [
        (FixedOutcome::Success, 200),
        (FixedOutcome::Unavailable, 502),
        (FixedOutcome::Timeout, 504),
    ]
    .into_iter()
    .enumerate()
    {
        let gate = Arc::new(ExitGate::default());
        let release = Release(gate.clone());
        let mut hooks = OutputHooks::default();
        hooks.after[OutputCommit::Completed as usize] = Some(gate.clone());
        let id = start(&fixed, &owner, target, n as i64, outcome, Arc::new(hooks));
        wait(|| gate.entered());
        let probe = fixed.probe(id);
        assert_eq!(probe.calls(), 1);
        assert_eq!(probe.joins(), 1);
        drop(release);
        done(&fixed, id, Terminal::Completed, Delivery::Returned, status);
        assert_eq!(memory.delivery_attempts(), n as u64 + 2);
        assert!(memory.receive().is_none());
        fixed.cancel(id).unwrap(); // Completion won before this cancellation.
        done(&fixed, id, Terminal::Completed, Delivery::Returned, status);
        fixed.ack_terminal(id).unwrap();
        assert_eq!(fixed.observe(id), Observation::Forgotten);
        assert_eq!(s.retained_bytes(), baseline);
    }
    assert!(!memory.is_closed());
    finish(s);
}
#[test]
fn owner_delayed_return_keeps_maysend_without_decrypt_replay_then_completes() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, owner, fixed, _, _, memory, target) = peer_fixture();
    let baseline = s.retained_bytes();
    let hooks = Arc::new(OutputHooks {
        delay_return: AtomicBool::new(true),
        hold_consume: AtomicBool::new(true),
        ..Default::default()
    });
    let id = start(
        &fixed,
        &owner,
        target,
        1,
        FixedOutcome::Success,
        hooks.clone(),
    );
    wait(|| {
        matches!(
            fixed.observe(id),
            Observation::Present {
                phase: Phase::MaySend,
                delivery: Delivery::MaySend,
                ..
            }
        )
    });
    wait(|| memory.delivery_attempts() == 2);
    let unread = s.retained_bytes();
    hooks.hold_consume.store(false, Ordering::SeqCst);
    // Multiple ordinary commands force maintenance. No second mailbox take is allowed.
    for _ in 0..4 {
        run(&owner, C::OpenPairing);
    }
    assert_eq!(s.retained_bytes() + 1536, unread); // Packet Drop refunded the real moved lease before receipt reconciliation.
    assert_eq!(memory.delivery_attempts(), 2);
    assert!(!memory.is_closed());
    assert_eq!(fixed.ack_terminal(id), Err(StatusRefusal::NotTerminal));
    hooks.delay_return.store(false, Ordering::SeqCst);
    done(&fixed, id, Terminal::Completed, Delivery::Returned, 200);
    fixed.ack_terminal(id).unwrap();
    assert_eq!(s.retained_bytes(), baseline);
    let next = start(
        &fixed,
        &owner,
        target,
        2,
        FixedOutcome::Success,
        Arc::default(),
    );
    done(&fixed, next, Terminal::Completed, Delivery::Returned, 200);
    finish(s);
}
#[test]
fn delayed_credit_cancellation_never_revives_completion_and_closes_exact_carrier() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, owner, fixed, _, h, memory, target) = peer_fixture();
    let (other, other_memory, mut other_peer) = phone(&owner, 2, 5);
    let hooks = Arc::new(OutputHooks {
        delay_return: AtomicBool::new(true),
        ..Default::default()
    });
    let id = start(
        &fixed,
        &owner,
        target,
        1,
        FixedOutcome::Success,
        hooks.clone(),
    );
    wait(|| {
        matches!(
            fixed.observe(id),
            Observation::Present {
                phase: Phase::MaySend,
                ..
            }
        )
    });
    for _ in 0..2 {
        run(&owner, C::OpenPairing);
    }
    fixed.cancel(id).unwrap();
    hooks.delay_return.store(false, Ordering::SeqCst);
    done(&fixed, id, Terminal::Cancelled, Delivery::Unknown, 200);
    assert!(memory.is_closed());
    assert!(matches!(h.status(), CarrierStatus::Closed(_)));
    assert!(!other_memory.is_closed());
    work(&owner, &other, &mut other_peer, 9);
    assert_eq!(tokens(&owner)[0].id(), 9);
    finish(s);
}
#[test]
fn cancellation_wins_before_each_output_commit_but_not_after_completed() {
    let _disk = crate::synthetic_store::testing_lock();
    for point in 0..3 {
        let (s, owner, fixed, _, _, memory, target) = peer_fixture();
        let gate = Arc::new(ExitGate::default());
        let release = Release(gate.clone());
        let mut hooks = OutputHooks::default();
        hooks.before[point] = Some(gate.clone());
        let id = start(
            &fixed,
            &owner,
            target,
            1,
            FixedOutcome::Success,
            Arc::new(hooks),
        );
        wait(|| gate.entered());
        fixed.cancel(id).unwrap();
        drop(release);
        done(
            &fixed,
            id,
            Terminal::Cancelled,
            if point == 0 {
                Delivery::None
            } else {
                Delivery::Unknown
            },
            200,
        );
        assert_eq!(memory.delivery_attempts(), if point == 0 { 1 } else { 2 });
        assert_eq!(memory.is_closed(), point != 0);
        finish(s);
    }
    let (s, owner, fixed, _, _, memory, target) = peer_fixture();
    let gate = Arc::new(ExitGate::default());
    let release = Release(gate.clone());
    let mut hooks = OutputHooks::default();
    hooks.after[OutputCommit::Completed as usize] = Some(gate.clone());
    let id = start(
        &fixed,
        &owner,
        target,
        1,
        FixedOutcome::Success,
        Arc::new(hooks),
    );
    wait(|| gate.entered());
    assert!(matches!(
        fixed.observe(id),
        Observation::Present {
            phase: Phase::Terminal(Terminal::Completed),
            delivery: Delivery::Returned,
            cleanup_pending: true,
            ..
        }
    ));
    fixed.cancel(id).unwrap();
    fixed.ack_terminal(id).unwrap();
    assert_eq!(fixed.observe(id), Observation::Forgotten);
    assert_eq!(fixed.counts().0, 1); // Hidden row retains the exact core until actual disposal.
    drop(release);
    wait(|| fixed.counts().0 == 0);
    assert!(!memory.is_closed());
    finish(s);
}
#[test]
fn deadline_equality_during_each_queue_commit_checks_idle_and_real_fragment() {
    let _disk = crate::synthetic_store::testing_lock();
    for fragment in [false, true] {
        for point in 0..3 {
            let (s, owner, fixed, clock, _, memory, target) = peer_fixture();
            let gate = Arc::new(ExitGate::default());
            let release = Release(gate.clone());
            let mut hooks = OutputHooks {
                fragment,
                ..Default::default()
            };
            hooks.before[point] = Some(gate.clone());
            let id = start(
                &fixed,
                &owner,
                target,
                1,
                FixedOutcome::Success,
                Arc::new(hooks),
            );
            wait(|| gate.entered());
            // Hold the same queue mutex the final transaction needs, then cross the captured expiry.
            let q = s.shared.queues();
            gate.release();
            clock
                .advance_to(if fragment { 15_001 } else { 45_001 })
                .unwrap();
            drop(q);
            drop(release);
            done(
                &fixed,
                id,
                Terminal::TimedOut,
                if point == 0 {
                    Delivery::None
                } else {
                    Delivery::Unknown
                },
                200,
            );
            assert_eq!(memory.delivery_attempts(), if point == 0 { 1 } else { 2 });
            if point != 0 {
                assert!(memory.is_closed());
            }
            finish(s);
        }
    }
}
#[test]
fn full_original_pool_after_begin_still_delivers_from_prepaid_resources() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, owner, fixed, _, _, memory, target) = peer_fixture();
    let hooks = Arc::new(OutputHooks {
        hold_emit: AtomicBool::new(true),
        ..Default::default()
    });
    let id = start(
        &fixed,
        &owner,
        target,
        1,
        FixedOutcome::Success,
        hooks.clone(),
    );
    wait(|| {
        matches!(
            fixed.observe(id),
            Observation::Present {
                phase: Phase::Ready,
                ..
            }
        )
    });
    let pool = s.shared.global.connection(256 * 1024 * 1024).unwrap();
    let fill = pool
        .reserve(256 * 1024 * 1024 - s.shared.global.used())
        .unwrap();
    hooks.hold_emit.store(false, Ordering::SeqCst);
    done(&fixed, id, Terminal::Completed, Delivery::Returned, 200);
    assert_eq!(memory.delivery_attempts(), 2);
    drop(fill);
    finish(s);
}
#[test]
fn owned_seal_transfer_and_verifier_failures_close_without_replay() {
    let _disk = crate::synthetic_store::testing_lock();
    for fault in 0..3 {
        let (s, owner, fixed, _, _, memory, target) = peer_fixture();
        let wrong = if fault == 2 {
            Some(phone(&owner, 2, 5).2)
        } else {
            None
        };
        let hooks = Arc::new(OutputHooks {
            verification_peer: Mutex::new(wrong),
            hold_emit: AtomicBool::new(true),
            fail_seal: fault == 0,
            ..Default::default()
        });
        let id = start(
            &fixed,
            &owner,
            target,
            1,
            FixedOutcome::Success,
            hooks.clone(),
        );
        wait(|| {
            matches!(
                fixed.observe(id),
                Observation::Present {
                    phase: Phase::Ready,
                    ..
                }
            )
        });
        if fault == 1 {
            memory.inject_unknown_delivery();
        }
        hooks.hold_emit.store(false, Ordering::SeqCst);
        done(
            &fixed,
            id,
            Terminal::DeliveryUnknown,
            Delivery::Unknown,
            200,
        );
        assert!(memory.is_closed());
        assert_eq!(memory.delivery_attempts(), if fault == 0 { 1 } else { 2 });
        finish(s);
    }
}

#[test]
fn after_maysend_cancel_and_unread_shutdown_drain_real_packet_credit() {
    let _disk = crate::synthetic_store::testing_lock();
    for stop in [false, true] {
        let (s, owner, fixed, _, _, memory, target) = peer_fixture();
        let gate = Arc::new(ExitGate::default());
        let release = Release(gate.clone());
        let mut hooks = OutputHooks {
            hold_consume: AtomicBool::new(true),
            ..Default::default()
        };
        hooks.after[OutputCommit::MaySend as usize] = Some(gate.clone());
        let id = start(
            &fixed,
            &owner,
            target,
            1,
            FixedOutcome::Success,
            Arc::new(hooks),
        );
        wait(|| gate.entered());
        if !stop {
            fixed.cancel(id).unwrap();
        }
        drop(release);
        if stop {
            wait(|| memory.delivery_attempts() == 2);
            assert!(memory.receive().is_none());
            assert_eq!(fixed.ack_terminal(id), Err(StatusRefusal::NotTerminal));
            let probe = fixed.probe(id);
            finish(s);
            assert_eq!(probe.joins(), 1);
        } else {
            done(&fixed, id, Terminal::Cancelled, Delivery::Unknown, 200);
            finish(s);
        }
        assert!(memory.is_closed());
        assert!(memory.receive().is_none());
    }
}
#[test]
fn stop_before_each_output_commit_refuses_and_joins_with_original_writer() {
    let _disk = crate::synthetic_store::testing_lock();
    for after in [false, true] {
        for point in 0..3 {
            let (s, owner, fixed, _, _, memory, target) = peer_fixture();
            let gate = Arc::new(ExitGate::default());
            let release = Release(gate.clone());
            let mut hooks = OutputHooks::default();
            if after {
                hooks.after[point] = Some(gate.clone());
            } else {
                hooks.before[point] = Some(gate.clone());
            }
            let id = start(
                &fixed,
                &owner,
                target,
                1,
                FixedOutcome::Success,
                Arc::new(hooks),
            );
            wait(|| gate.entered());
            let probe = fixed.probe(id);
            s.shared.request_stop(false);
            drop(release);
            finish(s);
            assert_eq!(probe.joins(), 1);
            assert_eq!(
                memory.delivery_attempts(),
                if point == 0 && !after { 1 } else { 2 }
            );
            assert!(memory.is_closed());
        }
    }
}

#[test]
fn idle_and_fragment_expiry_between_ticks_preserve_timeout_cause_after_maysend() {
    let _disk = crate::synthetic_store::testing_lock();
    for fragment in [false, true] {
        let (s, owner, fixed, clock, _, memory, target) = peer_fixture();
        let hooks = Arc::new(OutputHooks {
            fragment,
            hold_consume: AtomicBool::new(true),
            ..Default::default()
        });
        let id = start(&fixed, &owner, target, 1, FixedOutcome::Success, hooks);
        wait(|| memory.delivery_attempts() == 2);
        clock
            .advance_to(if fragment { 15_001 } else { 45_001 })
            .unwrap();
        done(&fixed, id, Terminal::TimedOut, Delivery::Unknown, 200);
        assert!(memory.is_closed());
        finish(s);
    }
}
#[test]
fn replacing_or_removing_unread_exact_target_drains_without_closing_other_generation() {
    let _disk = crate::synthetic_store::testing_lock();
    for removal in [false, true] {
        let (s, owner, fixed, _, old, memory, target) = peer_fixture();
        let (other, other_memory, mut other_peer) = phone(&owner, 2, 5);
        let hooks = Arc::new(OutputHooks {
            hold_consume: AtomicBool::new(true),
            ..Default::default()
        });
        let id = start(&fixed, &owner, target, 1, FixedOutcome::Success, hooks);
        wait(|| memory.delivery_attempts() == 2);
        assert!(memory.receive().is_none());
        let successor = if removal {
            run(&owner, C::RemoveDevice(key(4)));
            None
        } else {
            Some(phone(&owner, 1, 6))
        };
        done(&fixed, id, Terminal::Cancelled, Delivery::Unknown, 200);
        assert!(memory.is_closed());
        assert!(matches!(old.status(), CarrierStatus::Closed(_)));
        assert!(!other_memory.is_closed());
        if let Some((fresh, fresh_memory, mut fresh_peer)) = successor {
            assert_ne!(old.generation(), fresh.generation());
            assert!(!fresh_memory.is_closed());
            work(&owner, &fresh, &mut fresh_peer, 9);
            assert_eq!(tokens(&owner)[0].id(), 9);
        }
        work(&owner, &other, &mut other_peer, 10);
        assert_eq!(tokens(&owner)[0].id(), 10);
        finish(s);
    }
}
#[test]
fn owned_verifier_unwind_drains_credit_and_keeps_abort_and_original_writer() {
    let _disk = crate::synthetic_store::testing_lock();
    for point in [1, 2] {
        let (s, owner, fixed, _, _, memory, target) = peer_fixture();
        let budget = fixed.peer_budget(target);
        let hooks = Arc::new(OutputHooks {
            hold_consume: AtomicBool::new(true),
            ..Default::default()
        });
        let id = start(
            &fixed,
            &owner,
            target,
            1,
            FixedOutcome::Success,
            hooks.clone(),
        );
        wait(|| memory.delivery_attempts() == 2);
        let probe = fixed.probe(id);
        memory.inject_fixed_unwind(point);
        hooks.hold_consume.store(false, Ordering::SeqCst);
        wait(|| owner.is_finished());
        let (_, mut stopped) = s.close_for_restart().err().unwrap().into_parts();
        assert!(stopped.diagnostics().worker_joined);
        assert_eq!(probe.joins(), 1);
        assert!(memory.is_closed());
        assert_eq!(budget.used(), 0);
        assert!(matches!(
            stopped.profile.acquire_writer(),
            Err(StoreFault::Busy)
        ));
        quarantined(released(stopped)).destroy().unwrap();
    }
}

#[path = "fixed_wake_tests.rs"]
mod fixed_wake_tests;

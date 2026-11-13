use super::*;
use crate::persistent::fixed_executor::Hooks as CoreHooks;

fn hub(s: &PersistentSupervisor) -> Arc<wake::WakeHub> {
    s.shared.fixed_wake.as_ref().unwrap().hub().unwrap()
}

struct ParkCleanup {
    shared: Arc<Shared>,
    test: Arc<fixed::ParkTest>,
    armed: bool,
}
impl Drop for ParkCleanup {
    fn drop(&mut self) {
        if self.armed {
            self.shared.request_stop(true);
            self.test.release.store(true, Ordering::SeqCst);
            if let Some(actor) = self.test.actor.get() {
                actor.unpark();
            }
        }
    }
}

#[test]
fn wake_generation_closes_both_runnable_scan_to_park_gaps() {
    let _disk = crate::synthetic_store::testing_lock();
    for after in [false, true] {
        let (s, owner, fixed, _) = fixture();
        let gate = Arc::new(ExitGate::default());
        let release = Release(gate.clone());
        let test = Arc::new(fixed::ParkTest {
            before_check: (!after).then_some(gate.clone()),
            no_timeout: after,
            ..Default::default()
        });
        let mut cleanup = ParkCleanup {
            shared: s.shared.clone(),
            test: test.clone(),
            armed: true,
        };
        fixed.park_test(test.clone());
        wait(|| {
            if after {
                test.entered.load(Ordering::SeqCst)
            } else {
                gate.entered()
            }
        });
        let before = hub(&s).generation();
        let receipt = owner.submit(C::HostPublicKey).unwrap();
        assert!(hub(&s).generation() > before);
        test.release.store(true, Ordering::SeqCst);
        drop(release);
        assert!(matches!(
            receipt.wait(WAIT).unwrap(),
            Reply::HostPublicKey(_)
        ));
        if after {
            assert!(test.parks.load(Ordering::SeqCst) > 0);
        } else {
            assert!(test.skipped.load(Ordering::SeqCst) > 0);
        }
        cleanup.armed = false;
        finish(s);
    }
}

#[test]
fn unfinished_ready_and_awaiting_return_alone_reach_the_park_path() {
    let _disk = crate::synthetic_store::testing_lock();
    for state in 0..3 {
        let (s, owner, fixed, _, _, _, target) = peer_fixture();
        let hooks = Arc::new(OutputHooks {
            hold_emit: AtomicBool::new(state == 1),
            delay_return: AtomicBool::new(state == 2),
            ..Default::default()
        });
        request(&fixed, target, 1);
        let token = tokens(&owner).remove(0);
        let attempt = prepared(&fixed, &token);
        let id = attempt.id();
        fixed.configure(
            id,
            TestHooks {
                core: CoreHooks {
                    hold: state == 0,
                    ..Default::default()
                },
                output: Some(hooks),
                ..Default::default()
            },
        );
        fixed.submit(attempt, FixedOutcome::Success).unwrap();
        wait(
            || matches!(fixed.observe(id),Observation::Present {phase,..} if phase==[Phase::Running,Phase::Ready,Phase::MaySend][state]),
        );
        for _ in 0..2 {
            run(&owner, C::HostPublicKey);
        }
        let gate = Arc::new(ExitGate::default());
        let release = Release(gate.clone());
        fixed.park_test(Arc::new(fixed::ParkTest {
            after_check: Some(gate.clone()),
            ..Default::default()
        }));
        wait(|| gate.entered()); // A busy-only predicate would never reach this exact park branch.
        drop(release);
        finish(s);
    }
}

#[test]
fn worker_wake_before_thread_exit_is_not_join_or_completion_evidence() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, owner, fixed, _, _, memory, target) = peer_fixture();
    request(&fixed, target, 1);
    let token = tokens(&owner).remove(0);
    let attempt = prepared(&fixed, &token);
    let id = attempt.id();
    let exit = Arc::new(ExitGate::default());
    let release = Release(exit.clone());
    fixed.configure(
        id,
        TestHooks {
            core: CoreHooks {
                exit: Some(exit.clone()),
                ..Default::default()
            },
            ..Default::default()
        },
    );
    let before = hub(&s).generation();
    fixed.submit(attempt, FixedOutcome::Success).unwrap();
    wait(|| exit.entered());
    assert!(hub(&s).generation() >= before + 2); // Submission plus actual worker guard.
    assert_eq!(fixed.probe(id).joins(), 0);
    assert_eq!(memory.delivery_attempts(), 1);
    assert!(matches!(
        fixed.observe(id),
        Observation::Present {
            phase: Phase::Running,
            cleanup_pending: true,
            ..
        }
    ));
    let parked = Arc::new(ExitGate::default());
    let unpark = Release(parked.clone());
    fixed.park_test(Arc::new(fixed::ParkTest {
        after_check: Some(parked.clone()),
        ..Default::default()
    }));
    wait(|| parked.entered());
    assert_eq!(fixed.probe(id).joins(), 0);
    drop(release);
    drop(unpark);
    done(&fixed, id, Terminal::Completed, Delivery::Returned, 200);
    finish(s);
}

#[test]
fn duplicate_prepared_loser_parks_after_its_old_deadline_then_cleans_without_replay() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, owner, fixed, clock) = fixture();
    let (h, memory, mut peer) = phone(&owner, 1, 4);
    adopted(&fixed, &h);
    work(&owner, &h, &mut peer, 1);
    let token = tokens(&owner).remove(0);
    let first = prepared(&fixed, &token);
    let second = prepared(&fixed, &token);
    let a = first.id();
    let b = second.id();
    fixed.configure(
        a,
        TestHooks {
            core: CoreHooks {
                hold: true,
                ..Default::default()
            },
            ..Default::default()
        },
    );
    fixed.submit(first, FixedOutcome::Success).unwrap();
    fixed.pause_dispatch(false);
    wait(|| {
        matches!(
            fixed.observe(a),
            Observation::Present {
                phase: Phase::Running,
                ..
            }
        )
    });
    fixed.submit(second, FixedOutcome::Success).unwrap();
    clock.advance_to(20_001).unwrap();
    let gate = Arc::new(ExitGate::default());
    let release = Release(gate.clone());
    fixed.park_test(Arc::new(fixed::ParkTest {
        after_check: Some(gate.clone()),
        ..Default::default()
    }));
    wait(|| gate.entered());
    assert_eq!(token.status(), WorkStatus::InFlight);
    assert!(matches!(
        fixed.observe(b),
        Observation::Present {
            phase: Phase::Queued,
            execution: Execution::NotStarted,
            ..
        }
    ));
    assert!(owner.next_event(Duration::ZERO).is_none());
    fixed.cancel(a).unwrap();
    drop(release);
    wait(|| {
        matches!(
            fixed.observe(b),
            Observation::Present {
                phase: Phase::Terminal(Terminal::NotClaimed(NotClaimed::Stale)),
                execution: Execution::NotStarted,
                cleanup_pending: false,
                ..
            }
        )
    });
    assert_eq!(token.status(), WorkStatus::Cancelled);
    assert_eq!(memory.delivery_attempts(), 1);
    assert!(owner.next_event(Duration::ZERO).is_none());
    assert!(tokens(&owner).is_empty());
    finish(s);
}

#[test]
fn old_strong_clients_retain_exact_wake_charge_and_weak_clients_cannot_hold_hub() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, owner, fixed, _) = fixture();
    let pool = s.shared.global.clone();
    let (h, memory, peer) = phone(&owner, 1, 4);
    drop(peer);
    adopted(&fixed, &h);
    let carrier = owner.carrier(h.clone(), Source::Relay);
    run(&owner, C::EnableDesktop);
    let (_, _, approval) = desktop(&owner, 2, 9);
    let charge = s.shared.fixed_wake.as_ref().unwrap().held_bytes();
    assert_eq!(charge, 118);
    finish(s);
    assert!(memory.is_closed());
    assert_eq!(pool.used(), charge);
    assert!(owner.0.fixed_wake.as_ref().unwrap().hub().is_none());
    let (fresh, fresh_owner, _, _) = fixture();
    let generation = hub(&fresh).generation();
    owner.0.notify_work();
    assert_eq!(hub(&fresh).generation(), generation);
    drop(owner);
    assert_eq!(pool.used(), charge);
    drop(carrier);
    assert_eq!(pool.used(), 0);
    drop(approval);
    assert_eq!(pool.used(), 0);
    assert_eq!(fixed.counts(), (0, 0, 0, 0));
    assert_eq!(pool.used(), 0);
    drop(fresh_owner);
    finish(fresh);
}

#[test]
fn overflow_latch_refuses_all_four_final_commits_before_abort_publication() {
    let _disk = crate::synthetic_store::testing_lock();
    for point in 0..4 {
        let (s, owner, fixed, _, _, memory, target) = peer_fixture();
        request(&fixed, target, 1);
        let token = tokens(&owner).remove(0);
        let attempt = prepared(&fixed, &token);
        let id = attempt.id();
        let gate = Arc::new(ExitGate::default());
        let release = Release(gate.clone());
        let committed = Arc::new(ExitGate::default());
        committed.release();
        let mut output = OutputHooks::default();
        if point > 0 {
            output.before[point - 1] = Some(gate.clone());
            output.after[point - 1] = Some(committed.clone());
        } else {
            output.after_begin = Some(committed.clone());
        }
        fixed.configure(
            id,
            TestHooks {
                before_begin: (point == 0).then_some(gate.clone()),
                output: Some(Arc::new(output)),
                ..Default::default()
            },
        );
        fixed.submit(attempt, FixedOutcome::Success).unwrap();
        wait(|| gate.entered());
        let probe = fixed.probe(id);
        hub(&s).latch_overflow_for_test();
        assert_eq!(s.shared.stop.load(Ordering::SeqCst), RUNNING);
        assert!(!s.shared.running());
        drop(release);
        wait(|| owner.is_finished());
        let (_, stopped) = s.close_for_restart().err().unwrap().into_parts();
        assert!(stopped.diagnostics().worker_joined);
        assert_eq!(probe.joins(), 1);
        assert!(!committed.entered(), "overflow admitted commit {point}");
        assert_eq!(memory.delivery_attempts(), if point <= 1 { 1 } else { 2 });
        assert!(memory.is_closed());
        quarantined(released(stopped)).destroy().unwrap();
    }
}

#[test]
fn packet_return_overflow_under_session_guard_keeps_real_refund_and_abort() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, owner, fixed, _, _, memory, target) = peer_fixture();
    let budget = fixed.peer_budget(target);
    let gate = Arc::new(ExitGate::default());
    let release = Release(gate.clone());
    let mut output = OutputHooks::default();
    output.after[OutputCommit::Acceptance as usize] = Some(gate.clone());
    let id = start(
        &fixed,
        &owner,
        target,
        1,
        FixedOutcome::Success,
        Arc::new(output),
    );
    wait(|| gate.entered());
    let probe = fixed.probe(id);
    hub(&s).set_generation_for_test(u64::MAX);
    drop(release);
    wait(|| owner.is_finished());
    assert_eq!(s.shared.fault(), Some(WorkerFault::WakeOverflow));
    let (_, mut stopped) = s.close_for_restart().err().unwrap().into_parts();
    assert_eq!(probe.joins(), 1);
    assert_eq!(budget.used(), 0);
    assert!(memory.is_closed());
    assert!(matches!(
        stopped.profile.acquire_writer(),
        Err(StoreFault::Busy)
    ));
    quarantined(released(stopped)).destroy().unwrap();
}

#[test]
fn latched_overflow_refuses_command_control_approval_and_private_admissions() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, owner, fixed, _) = fixture();
    let (h, _, mut peer) = phone(&owner, 1, 4);
    let target = adopted(&fixed, &h);
    work(&owner, &h, &mut peer, 1);
    let token = tokens(&owner).remove(0);
    let attempt = prepared(&fixed, &token);
    let id = attempt.id();
    run(&owner, C::EnableDesktop);
    let (_, _, permit) = desktop(&owner, 2, 5);
    let gate = Arc::new(ExitGate::default());
    let release = Release(gate.clone());
    fixed.park_test(Arc::new(fixed::ParkTest {
        after_check: Some(gate.clone()),
        ..Default::default()
    }));
    wait(|| gate.entered());
    hub(&s).latch_overflow_for_test();
    assert_eq!(s.shared.stop.load(Ordering::SeqCst), RUNNING);
    assert!(matches!(
        owner.submit(C::HostPublicKey),
        Err(Error::NotExecuted)
    ));
    assert!(matches!(
        owner.submit(C::DrainWork {
            cursor: None,
            limit: 64
        }),
        Err(Error::NotExecuted)
    ));
    assert!(matches!(fixed.prepare(token), Err(PrepareRefusal::Stopped)));
    assert!(matches!(
        fixed.adopt(h.clone()),
        Err(PrepareRefusal::Stopped)
    ));
    assert!(matches!(
        fixed.request_fixture(target, 2),
        Err(PrepareRefusal::Stopped)
    ));
    assert_eq!(fixed.cancel(id), Err(StatusRefusal::Stopped));
    assert!(matches!(
        fixed.adopt_peer(PeerTransfer::new(h, peer)),
        Err(PeerRejection::Unavailable(PrepareRefusal::Stopped, _))
    ));
    assert!(matches!(
        owner.approve(permit),
        Err(ApprovalRejection::Unavailable(ApprovalRefusal::Stopped))
    ));
    assert!(matches!(
        fixed.submit(attempt, FixedOutcome::Success),
        Err(SubmitRejection::Unavailable(SubmitRefusal::Stopped))
    ));
    drop(release);
    wait(|| owner.is_finished());
    assert_eq!(s.shared.fault(), Some(WorkerFault::WakeOverflow));
    let (_, stopped) = s.close_for_restart().err().unwrap().into_parts();
    quarantined(released(stopped)).destroy().unwrap();
}

#[test]
fn verified_and_unverified_packet_drop_publish_real_credit_before_waking() {
    let _disk = crate::synthetic_store::testing_lock();
    for accepted in [false, true] {
        let (s, owner, fixed, _, _, memory, target) = peer_fixture();
        if accepted {
            let gate = Arc::new(ExitGate::default());
            let release = Release(gate.clone());
            let mut output = OutputHooks::default();
            output.after[OutputCommit::Acceptance as usize] = Some(gate.clone());
            let id = start(
                &fixed,
                &owner,
                target,
                1,
                FixedOutcome::Success,
                Arc::new(output),
            );
            wait(|| gate.entered());
            let before = hub(&s).generation();
            drop(release);
            done(&fixed, id, Terminal::Completed, Delivery::Returned, 200);
            assert_eq!(hub(&s).generation(), before + 1);
        } else {
            let id = start(
                &fixed,
                &owner,
                target,
                1,
                FixedOutcome::Success,
                Arc::new(OutputHooks {
                    hold_consume: AtomicBool::new(true),
                    ..Default::default()
                }),
            );
            wait(|| memory.delivery_attempts() == 2);
            let before = hub(&s).generation();
            fixed.cancel(id).unwrap();
            done(&fixed, id, Terminal::Cancelled, Delivery::Unknown, 200);
            assert_eq!(hub(&s).generation(), before + 2);
            assert!(memory.is_closed());
        }
        finish(s);
    }
}

#[test]
fn child_and_packet_progress_under_full_command_control_and_event_lanes() {
    let _disk = crate::synthetic_store::testing_lock();
    let clock = ManualClock::default();
    clock.advance_to(1).unwrap();
    let s = PersistentSupervisor::start_fixed_fixture(
        profile(),
        Limits {
            commands: 2,
            events: 1,
            tick_ms: 100,
            ..Default::default()
        },
        Clock::Manual(clock),
        FixedFixture,
    )
    .unwrap_or_else(|_| panic!("wake fixture"));
    let owner = s.owner();
    let fixed = s.fixed_owner().unwrap();
    run(&owner, C::OpenPairing);
    let (h, memory, peer) = phone(&owner, 1, 4);
    let target = adopted(&fixed, &h);
    peer_installed(&fixed, &h, peer);
    request(&fixed, target, 1);
    let token = tokens(&owner).remove(0);
    let attempt = prepared(&fixed, &token);
    let id = attempt.id();
    fixed.configure(
        id,
        TestHooks {
            core: CoreHooks {
                hold: true,
                ..Default::default()
            },
            ..Default::default()
        },
    );
    fixed.submit(attempt, FixedOutcome::Success).unwrap();
    wait(|| {
        matches!(
            fixed.observe(id),
            Observation::Present {
                phase: Phase::Running,
                ..
            }
        )
    });
    run(&owner, C::EnableDesktop);
    let (pending, _) = attach(&owner, 99);
    hello(&owner, &pending, 8, DeviceKind::Desktop);
    assert_eq!(owner.0.queues().events.len(), 1);
    let gate = Arc::new(ExitGate::default());
    let release = Release(gate.clone());
    fixed.park_test(Arc::new(fixed::ParkTest {
        after_check: Some(gate.clone()),
        ..Default::default()
    }));
    wait(|| gate.entered());
    let ordinary: Vec<_> = (0..2)
        .map(|_| owner.submit(C::HostPublicKey).unwrap())
        .collect();
    let controls: Vec<_> = (0..8)
        .map(|_| {
            owner
                .submit(C::DrainWork {
                    cursor: None,
                    limit: 64,
                })
                .unwrap()
        })
        .collect();
    assert!(matches!(owner.submit(C::HostPublicKey), Err(Error::Full)));
    assert!(matches!(
        owner.submit(C::DrainWork {
            cursor: None,
            limit: 64
        }),
        Err(Error::Full)
    ));
    let probe = fixed.probe(id);
    probe.finish();
    drop(release);
    done(&fixed, id, Terminal::Completed, Delivery::Returned, 200);
    assert_eq!(probe.joins(), 1);
    assert_eq!(memory.delivery_attempts(), 2);
    for receipt in ordinary.into_iter().chain(controls) {
        assert!(receipt.wait(WAIT).is_ok());
    }
    finish(s);
}

#[test]
fn writer_refusal_drops_prepaid_hub_and_counter_before_return() {
    let _disk = crate::synthetic_store::testing_lock();
    let mut p = profile();
    let pool = p.service_pool().unwrap();
    let writer = p.acquire_writer().unwrap();
    let before = pool.used();
    let (_, stopped) = PersistentSupervisor::start_fixed_fixture(
        p,
        Limits::default(),
        Clock::monotonic(),
        FixedFixture,
    )
    .err()
    .unwrap()
    .into_parts();
    assert_eq!(pool.used(), before);
    drop(writer);
    released(stopped).destroy().unwrap();
    assert_eq!(pool.used(), 0);
}

#[test]
fn private_adoption_rechecks_overflow_after_maintenance_before_registration() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, owner, fixed, _) = fixture();
    let (handle, memory, _) = phone(&owner, 1, 4);
    let gate = Arc::new(ExitGate::default());
    let release = Release(gate.clone());
    let hooks = Arc::new(fixed::ParkTest {
        before_operation_maintain: Some(gate.clone()),
        ..Default::default()
    });
    fixed.park_test(hooks.clone());
    let mut receipt = fixed.adopt(handle).unwrap();
    wait(|| gate.entered());
    hub(&s).latch_overflow_for_test();
    drop(release);
    assert_eq!(
        receipt.wait(WAIT),
        Err(WaitFault::Refused(PrepareRefusal::Stopped))
    );
    wait(|| owner.is_finished());
    assert_eq!(hooks.adoptions.load(Ordering::SeqCst), 0);
    assert!(memory.is_closed());
    let (_, stopped) = s.close_for_restart().err().unwrap().into_parts();
    quarantined(released(stopped)).destroy().unwrap();
}

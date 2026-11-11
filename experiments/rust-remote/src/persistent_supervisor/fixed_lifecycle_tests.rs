use super::*;
use crate::persistent::fixed_executor::{Execution, ExitGate, Hooks as CoreHooks};
use fixed::TestHooks;

struct OpenGate(Arc<ExitGate>);
impl Drop for OpenGate {
    fn drop(&mut self) {
        self.0.release();
    }
}

fn service_with(
    limits: Limits,
) -> (
    PersistentSupervisor,
    PersistentOwnerClient,
    FixedOwnerClient,
    ManualClock,
) {
    let clock = ManualClock::default();
    clock.advance_to(1).unwrap();
    let s = PersistentSupervisor::start_fixed_fixture(
        profile(),
        limits,
        Clock::Manual(clock.clone()),
        FixedFixture,
    )
    .unwrap_or_else(|_| panic!("lifecycle fixture"));
    let owner = s.owner();
    let fixed = s.fixed_owner().unwrap();
    run(&owner, C::OpenPairing);
    (s, owner, fixed, clock)
}
fn ready(fixed: &FixedOwnerClient, id: fixed::FixedId, status: u16) {
    wait(|| {
        fixed.observe(id)
            == Observation::Present {
                phase: Phase::Ready,
                cancel_requested: false,
                execution: Execution::MayHaveRun,
                status: Some(status),
                cleanup_pending: true,
            }
    });
}
fn terminal(fixed: &FixedOwnerClient, id: fixed::FixedId, expected: Terminal) {
    wait(|| {
        matches!(fixed.observe(id), Observation::Present {
        phase:Phase::Terminal(t), execution:Execution::MayHaveRun, cleanup_pending:false, ..
    } if t == expected)
    });
}

#[test]
fn owner_fixed_results_need_real_join_and_keep_ready_without_any_delivery() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, owner, fixed, _) = service_with(Limits::default());
    let (h, memory, mut peer) = phone(&owner, 1, 4);
    adopted(&fixed, &h);
    let baseline = s.retained_bytes();
    for (request, outcome, status) in [
        (1, FixedOutcome::Success, 200),
        (2, FixedOutcome::Unavailable, 502),
        (3, FixedOutcome::Timeout, 504),
    ] {
        work(&owner, &h, &mut peer, request);
        let token = tokens(&owner).remove(0);
        let id = fixed
            .submit(prepared(&fixed, &token), outcome)
            .unwrap()
            .id();
        ready(&fixed, id, status);
        assert_eq!(token.status(), WorkStatus::InFlight);
        assert_eq!(fixed.ack_terminal(id), Err(StatusRefusal::NotTerminal));
        run(&owner, C::HostPublicKey); // Generic flush must skip the exact live fence.
        assert_eq!(h.status(), CarrierStatus::Active);
        assert_eq!(memory.delivery_attempts(), 1);
        assert!(memory.receive().is_none());
        fixed.cancel(id).unwrap();
        terminal(&fixed, id, Terminal::Cancelled);
        assert_eq!(token.status(), WorkStatus::Cancelled);
        assert_eq!(s.retained_bytes(), baseline + fixed::STATUS_BYTES);
        fixed.ack_terminal(id).unwrap();
        assert_eq!(fixed.observe(id), Observation::Forgotten);
        assert_eq!(s.retained_bytes(), baseline);
    }
    assert_eq!(memory.delivery_attempts(), 1);
    finish(s);
}

#[test]
fn owner_joined_cancel_promotes_queued_work_and_notifies_without_a_followup_command() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, owner, fixed, _) = service_with(Limits {
        registry: crate::registry::Limits {
            inflight: 1,
            ..Default::default()
        },
        ..Default::default()
    });
    let (h, memory, mut peer) = phone(&owner, 1, 4);
    adopted(&fixed, &h);
    work(&owner, &h, &mut peer, 1);
    let first = tokens(&owner).remove(0);
    let id = fixed
        .submit(prepared(&fixed, &first), FixedOutcome::Success)
        .unwrap()
        .id();
    ready(&fixed, id, 200);
    work(&owner, &h, &mut peer, 2);
    assert!(owner.next_event(Duration::ZERO).is_none());
    fixed.cancel(id).unwrap();
    assert!(matches!(owner.next_event(WAIT), Some(Event::WorkAvailable)));
    terminal(&fixed, id, Terminal::Cancelled);
    let promoted = tokens(&owner);
    assert_eq!(promoted.len(), 1);
    assert_eq!(promoted[0].id(), 2);
    assert_eq!(promoted[0].status(), WorkStatus::InFlight);
    assert!(owner.next_event(Duration::ZERO).is_none());
    assert_eq!(memory.delivery_attempts(), 1);
    assert!(!memory.is_closed());
    fixed.ack_terminal(id).unwrap();
    assert_eq!(fixed.counts().0, 0); // Promotion does not prepare or execute B.
    finish(s);
}

#[test]
fn owner_ready_survives_scheduling_expiry_until_exact_claim_completion_deadline() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, owner, fixed, clock) = service_with(Limits::default());
    let (h, memory, mut peer) = phone(&owner, 1, 4);
    adopted(&fixed, &h);
    work(&owner, &h, &mut peer, 1);
    let token = tokens(&owner).remove(0);
    let id = fixed
        .submit(prepared(&fixed, &token), FixedOutcome::Success)
        .unwrap()
        .id();
    ready(&fixed, id, 200);
    clock.advance_to(20_001).unwrap();
    run(&owner, C::HostPublicKey);
    ready(&fixed, id, 200);
    for n in 1..=8 {
        clock.advance_to(1 + n * 40_000).unwrap();
        work(&owner, &h, &mut peer, n as i64 + 1);
        assert!(!memory.is_closed());
    }
    clock.advance_to(345_001).unwrap();
    terminal(&fixed, id, Terminal::TimedOut);
    assert_eq!(token.status(), WorkStatus::TimedOut);
    assert_eq!(memory.delivery_attempts(), 1);
    assert!(!memory.is_closed());
    fixed.ack_terminal(id).unwrap();
    finish(s);
}

#[test]
fn owner_cancel_and_stop_win_the_real_pre_begin_queue_transaction() {
    let _disk = crate::synthetic_store::testing_lock();
    for stop in 0..3 {
        let (s, owner, fixed, clock) = service_with(Limits {
            commands: 2,
            events: 1,
            ..Default::default()
        });
        let (other, other_memory, mut other_peer) = phone(&owner, 2, 5);
        adopted(&fixed, &other);
        work(&owner, &other, &mut other_peer, 2);
        let other_token = tokens(&owner).remove(0);
        let other_id = fixed
            .submit(prepared(&fixed, &other_token), FixedOutcome::Unavailable)
            .unwrap()
            .id();
        ready(&fixed, other_id, 502);
        clock.advance_to(1002).unwrap();
        let (h, memory, mut peer) = phone(&owner, 1, 4);
        adopted(&fixed, &h);
        work(&owner, &h, &mut peer, 1);
        let token = tokens(&owner).remove(0);
        let attempt = prepared(&fixed, &token);
        let id = attempt.id();
        run(&owner, C::EnableDesktop);
        let (pending, _) = attach(&owner, 99);
        hello(&owner, &pending, 8, DeviceKind::Desktop);
        assert_eq!(owner.0.queues().events.len(), 1); // Real unread approval fills the event lane.
        let gate = Arc::new(ExitGate::default());
        let release = OpenGate(gate.clone());
        fixed.configure(
            id,
            TestHooks {
                before_begin: Some(gate.clone()),
                ..Default::default()
            },
        );
        fixed.submit(attempt, FixedOutcome::Success).unwrap();
        wait(|| gate.entered());
        let probe = fixed.probe(id);
        assert_eq!(probe.calls(), 0);
        assert!(matches!(
            fixed.observe(id),
            Observation::Present {
                phase: Phase::Claimed,
                execution: Execution::NotStarted,
                cleanup_pending: true,
                ..
            }
        ));
        assert_eq!(fixed.ack_terminal(id), Err(StatusRefusal::NotTerminal));
        let commands: Vec<_> = (0..2)
            .map(|_| owner.submit(C::HostPublicKey).unwrap())
            .collect();
        assert!(matches!(owner.submit(C::HostPublicKey), Err(Error::Full)));
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
        assert!(matches!(
            owner.submit(C::DrainWork {
                cursor: None,
                limit: 64
            }),
            Err(Error::Full)
        ));
        if stop > 0 {
            s.shared.request_stop(stop == 2);
        } else {
            fixed.cancel(id).unwrap();
        }
        drop(release);
        if stop > 0 {
            if stop == 1 {
                finish(s);
            } else {
                quarantined(released(s.abort())).destroy().unwrap();
            }
            for receipt in commands.into_iter().chain(controls) {
                assert!(matches!(receipt.wait(WAIT), Err(Error::NotExecuted)));
            }
            assert!(memory.is_closed());
        } else {
            wait(|| {
                matches!(
                    fixed.observe(id),
                    Observation::Present {
                        phase: Phase::Terminal(Terminal::Cancelled),
                        execution: Execution::NotStarted,
                        cleanup_pending: false,
                        ..
                    }
                )
            });
            assert_eq!(token.status(), WorkStatus::Cancelled);
            assert!(matches!(
                fixed.prepare(token.clone()).unwrap().wait(WAIT),
                Err(WaitFault::Refused(PrepareRefusal::Stale))
            ));
            fixed.ack_terminal(id).unwrap();
            assert!(!memory.is_closed());
            for receipt in commands.into_iter().chain(controls) {
                assert!(receipt.wait(WAIT).is_ok());
            }
            ready(&fixed, other_id, 502);
            assert!(!other_memory.is_closed());
            finish(s);
        }
        assert_eq!(probe.joins(), 1);
        assert_eq!(probe.calls(), 0);
        assert_eq!(memory.delivery_attempts(), 1);
    }
}

#[test]
fn owner_early_terminal_ack_retains_exit_held_worker_row_and_credit() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, owner, fixed, _) = service_with(Limits::default());
    let (h, memory, mut peer) = phone(&owner, 1, 4);
    adopted(&fixed, &h);
    work(&owner, &h, &mut peer, 1);
    let token = tokens(&owner).remove(0);
    let attempt = prepared(&fixed, &token);
    let id = attempt.id();
    let gate = Arc::new(ExitGate::default());
    let release = OpenGate(gate.clone());
    fixed.configure(
        id,
        TestHooks {
            core: CoreHooks {
                exit: Some(gate.clone()),
                ..Default::default()
            },
            ..Default::default()
        },
    );
    fixed.submit(attempt, FixedOutcome::Success).unwrap();
    wait(|| gate.entered());
    let probe = fixed.probe(id);
    assert_eq!(probe.calls(), 1);
    assert_eq!(probe.joins(), 0);
    assert!(matches!(
        fixed.observe(id),
        Observation::Present {
            phase: Phase::Running,
            execution: Execution::MayHaveRun,
            cleanup_pending: true,
            ..
        }
    ));
    fixed.cancel(id).unwrap();
    wait(|| {
        matches!(
            fixed.observe(id),
            Observation::Present {
                phase: Phase::Terminal(Terminal::Cancelled),
                cleanup_pending: true,
                ..
            }
        )
    });
    let before = s.retained_bytes();
    fixed.ack_terminal(id).unwrap();
    assert_eq!(fixed.observe(id), Observation::Forgotten);
    assert_eq!(fixed.counts().0, 1);
    assert_eq!(s.retained_bytes(), before);
    assert_eq!(probe.joins(), 0);
    run(&owner, C::HostPublicKey);
    assert!(!memory.is_closed());
    drop(release);
    wait(|| fixed.counts().0 == 0);
    assert_eq!(probe.joins(), 1);
    assert_eq!(token.status(), WorkStatus::Cancelled);
    assert!(s.retained_bytes() < before);
    finish(s);
}

#[test]
fn owner_refusal_is_terminal_and_needs_an_explicit_fresh_attempt_to_retry() {
    let _disk = crate::synthetic_store::testing_lock();
    for spawn in [false, true] {
        let (s, owner, fixed, _) = service_with(Limits::default());
        let (h, memory, mut peer) = phone(&owner, 1, 4);
        adopted(&fixed, &h);
        work(&owner, &h, &mut peer, 1);
        let token = tokens(&owner).remove(0);
        let attempt = prepared(&fixed, &token);
        let id = attempt.id();
        let budget = fixed.budget_for_test(id);
        let pressure = if spawn {
            fixed.configure(
                id,
                TestHooks {
                    core: CoreHooks {
                        refuse_after_spawn: true,
                        ..Default::default()
                    },
                    ..Default::default()
                },
            );
            None
        } else {
            Some(
                budget
                    .reserve(64 * 1024 * 1024 - budget.used() - 2_172_416 + 1)
                    .unwrap(),
            )
        };
        fixed.submit(attempt, FixedOutcome::Success).unwrap();
        let expected = if spawn {
            NotClaimed::Spawn
        } else {
            NotClaimed::Full
        };
        wait(|| {
            matches!(fixed.observe(id),Observation::Present {
            phase:Phase::Terminal(Terminal::NotClaimed(reason)),execution:Execution::NotStarted,cleanup_pending:false,..
        } if reason==expected)
        });
        drop(pressure);
        let ticks = s.ticks();
        wait(|| s.ticks() > ticks + 2);
        assert_eq!(token.status(), WorkStatus::InFlight);
        assert_eq!(memory.delivery_attempts(), 1);
        assert!(matches!(
            fixed.observe(id),
            Observation::Present {
                phase: Phase::Terminal(Terminal::NotClaimed(_)),
                ..
            }
        ));
        let retry = prepared(&fixed, &token);
        assert_ne!(retry.id(), id);
        let next = fixed.submit(retry, FixedOutcome::Success).unwrap().id();
        ready(&fixed, next, 200);
        fixed.ack_terminal(id).unwrap();
        fixed.cancel(next).unwrap();
        terminal(&fixed, next, Terminal::Cancelled);
        finish(s);
    }
}

#[test]
fn owner_abort_and_actor_unwind_keep_rows_and_backing_until_actual_child_join() {
    let _disk = crate::synthetic_store::testing_lock();
    for unwind in [false, true] {
        let (s, owner, fixed, _) = service_with(Limits::default());
        let (h, memory, mut peer) = phone(&owner, 1, 4);
        adopted(&fixed, &h);
        work(&owner, &h, &mut peer, 1);
        let token = tokens(&owner).remove(0);
        let attempt = prepared(&fixed, &token);
        let id = attempt.id();
        let gate = Arc::new(ExitGate::default());
        let release = OpenGate(gate.clone());
        fixed.configure(
            id,
            TestHooks {
                core: CoreHooks {
                    exit: Some(gate.clone()),
                    ..Default::default()
                },
                ..Default::default()
            },
        );
        fixed.submit(attempt, FixedOutcome::Success).unwrap();
        wait(|| gate.entered());
        let probe = fixed.probe(id);
        assert_eq!(probe.calls(), 1);
        if unwind {
            owner.submit(C::Probe(Probe::Panic)).unwrap();
        } else {
            owner.request_abort();
        }
        wait(|| s.shared.stop.load(Ordering::SeqCst) != RUNNING);
        assert_eq!(fixed.counts().0, 1);
        assert_eq!(probe.joins(), 0);
        assert!(!owner.is_finished());
        assert!(owner.retained_bytes() >= fixed::backing_bytes().unwrap() + 2 * 1024 * 1024);
        let join = thread::spawn(move || s.abort());
        drop(release);
        let mut stopped = join.join().unwrap();
        assert_eq!(probe.joins(), 1);
        assert!(stopped.diagnostics().worker_joined);
        assert_eq!(fixed.counts(), (0, 0, 0, 0));
        assert!(memory.is_closed());
        assert_eq!(
            owner.retained_bytes(),
            crate::synthetic_store::StoreLimits::default().working_bytes
        );
        assert!(matches!(
            stopped.profile.acquire_writer(),
            Err(StoreFault::Busy)
        ));
        quarantined(released(stopped)).destroy().unwrap();
    }
}

#[test]
fn owner_two_slots_skip_busy_device_and_keep_pending_work_until_disposal() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, owner, fixed, clock) = service_with(Limits::default());
    let (a, ma, mut pa) = phone(&owner, 1, 4);
    adopted(&fixed, &a);
    work(&owner, &a, &mut pa, 1);
    let first = tokens(&owner).remove(0);
    let first_id = fixed
        .submit(prepared(&fixed, &first), FixedOutcome::Success)
        .unwrap()
        .id();
    ready(&fixed, first_id, 200);
    work(&owner, &a, &mut pa, 2);
    let same = tokens(&owner).remove(0);
    let same_id = fixed
        .submit(prepared(&fixed, &same), FixedOutcome::Success)
        .unwrap()
        .id();
    clock.advance_to(1002).unwrap();
    let (b, mb, mut pb) = phone(&owner, 2, 5);
    adopted(&fixed, &b);
    work(&owner, &b, &mut pb, 3);
    let second = tokens(&owner).into_iter().find(|t| t.id() == 3).unwrap();
    let attempt = prepared(&fixed, &second);
    let second_id = attempt.id();
    let gate = Arc::new(ExitGate::default());
    let release = OpenGate(gate.clone());
    fixed.configure(
        second_id,
        TestHooks {
            core: CoreHooks {
                exit: Some(gate.clone()),
                ..Default::default()
            },
            ..Default::default()
        },
    );
    fixed.submit(attempt, FixedOutcome::Success).unwrap();
    wait(|| gate.entered()); // A queued same-device attempt did not block carrier B.
    let probe = fixed.probe(second_id);
    assert_eq!(probe.calls(), 1);
    clock.advance_to(2003).unwrap();
    let (c, mc, mut pc) = phone(&owner, 3, 6);
    adopted(&fixed, &c);
    work(&owner, &c, &mut pc, 4);
    let third = tokens(&owner).into_iter().find(|t| t.id() == 4).unwrap();
    let cancelled_id = fixed
        .submit(prepared(&fixed, &third), FixedOutcome::Success)
        .unwrap()
        .id();
    fixed.cancel(cancelled_id).unwrap();
    wait(|| {
        matches!(
            fixed.observe(cancelled_id),
            Observation::Present {
                phase: Phase::Terminal(Terminal::NotClaimed(NotClaimed::Cancelled)),
                execution: Execution::NotStarted,
                cleanup_pending: false,
                ..
            }
        )
    });
    assert_eq!(third.status(), WorkStatus::InFlight);
    fixed.ack_terminal(cancelled_id).unwrap();
    let third_id = fixed
        .submit(prepared(&fixed, &third), FixedOutcome::Success)
        .unwrap()
        .id();
    assert_ne!(third_id, cancelled_id);
    let ticks = s.ticks();
    wait(|| s.ticks() > ticks + 2);
    for id in [same_id, third_id] {
        assert!(matches!(
            fixed.observe(id),
            Observation::Present {
                phase: Phase::Queued,
                execution: Execution::NotStarted,
                ..
            }
        ));
    }
    fixed.cancel(second_id).unwrap();
    wait(|| {
        matches!(
            fixed.observe(second_id),
            Observation::Present {
                phase: Phase::Terminal(Terminal::Cancelled),
                cleanup_pending: true,
                ..
            }
        )
    });
    assert_eq!(probe.joins(), 0);
    assert!(matches!(
        fixed.observe(third_id),
        Observation::Present {
            phase: Phase::Queued,
            ..
        }
    ));
    drop(release);
    terminal(&fixed, second_id, Terminal::Cancelled);
    assert_eq!(probe.joins(), 1);
    ready(&fixed, third_id, 200);
    assert!(matches!(
        fixed.observe(same_id),
        Observation::Present {
            phase: Phase::Queued,
            ..
        }
    ));
    fixed.cancel(first_id).unwrap();
    terminal(&fixed, first_id, Terminal::Cancelled);
    ready(&fixed, same_id, 200);
    for memory in [ma, mb, mc] {
        assert_eq!(memory.delivery_attempts(), 1);
        assert!(!memory.is_closed());
    }
    finish(s);
}

#[test]
fn owner_failed_admission_and_failed_begin_publish_real_successors_once() {
    let _disk = crate::synthetic_store::testing_lock();
    for before_claim in [true, false] {
        let (s, owner, fixed, clock) = service_with(Limits {
            events: 1,
            registry: crate::registry::Limits {
                inflight: 1,
                ..Default::default()
            },
            ..Default::default()
        });
        let (h, memory, mut peer) = phone(&owner, 1, 4);
        adopted(&fixed, &h);
        work(&owner, &h, &mut peer, 1);
        let first = tokens(&owner).remove(0);
        let attempt = prepared(&fixed, &first);
        let id = attempt.id();
        clock.advance_to(19_000).unwrap();
        work(&owner, &h, &mut peer, 2);
        assert!(owner.next_event(Duration::ZERO).is_none());
        let gate = Arc::new(ExitGate::default());
        let release = OpenGate(gate.clone());
        fixed.configure(
            id,
            if before_claim {
                TestHooks {
                    core: CoreHooks {
                        before_claim: Some(gate.clone()),
                        ..Default::default()
                    },
                    ..Default::default()
                }
            } else {
                TestHooks {
                    before_begin: Some(gate.clone()),
                    ..Default::default()
                }
            },
        );
        fixed.submit(attempt, FixedOutcome::Success).unwrap();
        wait(|| gate.entered());
        if before_claim {
            clock.advance_to(20_001).unwrap();
        } else {
            fixed.cancel(id).unwrap();
        }
        drop(release);
        let expected = if before_claim {
            Terminal::NotClaimed(NotClaimed::Expired)
        } else {
            Terminal::Cancelled
        };
        wait(
            || matches!(fixed.observe(id),Observation::Present {phase:Phase::Terminal(t),execution:Execution::NotStarted,cleanup_pending:false,..} if t==expected),
        );
        assert!(matches!(owner.next_event(WAIT), Some(Event::WorkAvailable)));
        // Refused drain leaves the real coalesced readiness bit set.
        assert!(owner
            .submit(C::DrainWork {
                cursor: None,
                limit: 0
            })
            .unwrap()
            .wait(WAIT)
            .is_err());
        assert!(matches!(owner.next_event(WAIT), Some(Event::WorkAvailable)));
        let promoted = tokens(&owner);
        assert_eq!(promoted.len(), 1);
        assert_eq!(promoted[0].id(), 2);
        assert_eq!(promoted[0].status(), WorkStatus::InFlight);
        assert!(owner.next_event(Duration::ZERO).is_none());
        assert_eq!(memory.delivery_attempts(), 1);
        let retry = prepared(&fixed, &promoted[0]);
        clock.advance_to(39_000).unwrap();
        wait(|| {
            matches!(
                fixed.observe(retry.id()),
                Observation::Present {
                    phase: Phase::Terminal(Terminal::NotClaimed(NotClaimed::Expired)),
                    ..
                }
            )
        });
        assert!(matches!(
            fixed.prepare(promoted[0].clone()).unwrap().wait(WAIT),
            Err(WaitFault::Refused(PrepareRefusal::Expired))
        ));
        assert_eq!(promoted[0].status(), WorkStatus::TimedOut);
        assert!(!memory.is_closed());
        drop(retry);
        finish(s);
    }
}

#[test]
fn owner_exact_carrier_closure_preserves_other_core_and_successor_generation() {
    let _disk = crate::synthetic_store::testing_lock();
    for closure in 0..3 {
        let (s, owner, fixed, clock) = service_with(Limits::default());
        let (a, ma, mut pa) = phone(&owner, 1, 4);
        let old_target = adopted(&fixed, &a);
        work(&owner, &a, &mut pa, 1);
        let first = tokens(&owner).remove(0);
        let first_id = fixed
            .submit(prepared(&fixed, &first), FixedOutcome::Success)
            .unwrap()
            .id();
        ready(&fixed, first_id, 200);
        clock.advance_to(1002).unwrap();
        let (b, mb, mut pb) = phone(&owner, 2, 5);
        work(&owner, &b, &mut pb, 2);
        run(
            &owner,
            C::Send {
                handle: b.clone(),
                encoded: b"{}".to_vec(),
            },
        );
        assert!(mb.receive().is_some()); // Ordinary export remains live beside A's fence.
        adopted(&fixed, &b);
        let second = tokens(&owner).remove(0);
        let second_id = fixed
            .submit(prepared(&fixed, &second), FixedOutcome::Unavailable)
            .unwrap()
            .id();
        ready(&fixed, second_id, 502);
        if closure == 1 {
            run(&owner, C::RemoveDevice(key(4)));
        } else if closure == 0 {
            run(&owner, C::Disconnect(a.clone()));
        }
        clock.advance_to(2003).unwrap();
        run(&owner, C::OpenPairing);
        let (fresh, fresh_memory, mut fresh_peer) =
            phone(&owner, 1, if closure == 1 { 6 } else { 4 });
        terminal(&fixed, first_id, Terminal::Cancelled);
        assert!(ma.is_closed());
        ready(&fixed, second_id, 502);
        assert!(!mb.is_closed());
        fixed.ack_terminal(first_id).unwrap();
        let target = adopted(&fixed, &fresh);
        assert_ne!(target, old_target);
        assert_ne!(target.generation, old_target.generation);
        work(&owner, &fresh, &mut fresh_peer, 1);
        let token = tokens(&owner).remove(0);
        let id = fixed
            .submit(prepared(&fixed, &token), FixedOutcome::Success)
            .unwrap()
            .id();
        ready(&fixed, id, 200);
        assert_ne!(id, first_id);
        assert_eq!(fixed.cancel(first_id), Err(StatusRefusal::Forgotten));
        ready(&fixed, id, 200);
        assert!(!fresh_memory.is_closed());
        assert_eq!(fresh_memory.delivery_attempts(), 1);
        finish(s);
    }
}

#[test]
fn owner_healthy_close_keeps_two_workers_and_forgotten_rows_until_join_then_preserves_typed_io_failure(
) {
    let _disk = crate::synthetic_store::testing_lock();
    let (mut s, owner, fixed, clock) = service_with(Limits::default());
    let mut probes = Vec::new();
    let mut memories = Vec::new();
    let gate = Arc::new(ExitGate::default());
    let release = OpenGate(gate.clone());
    for n in 1..=2 {
        clock.advance_to(n * 1001).unwrap();
        let (h, memory, mut peer) = phone(&owner, n, n as u8 + 3);
        adopted(&fixed, &h);
        work(&owner, &h, &mut peer, 1);
        let token = tokens(&owner).remove(0);
        let attempt = prepared(&fixed, &token);
        let id = attempt.id();
        std::mem::forget(prepared(&fixed, &token)); // A real consuming permit has Drop cleanup.
        if n == 1 {
            fixed.configure(
                id,
                TestHooks {
                    core: CoreHooks {
                        exit: Some(gate.clone()),
                        ..Default::default()
                    },
                    ..Default::default()
                },
            );
        }
        let _receipt = fixed.submit(attempt, FixedOutcome::Success).unwrap();
        if n == 1 {
            wait(|| gate.entered());
        } else {
            ready(&fixed, id, 200);
        }
        probes.push(fixed.probe(id));
        memories.push(memory);
    }
    s.shared.request_stop(false);
    wait(|| probes[0].cancelled());
    assert!(!owner.is_finished());
    assert_eq!(fixed.counts().0, 4);
    assert_eq!(probes[0].joins(), 0);
    let joining = thread::spawn(move || {
        s.join(false);
        s
    });
    drop(release);
    let s = joining.join().unwrap();
    assert!(probes.iter().all(|p| p.joins() == 1));
    assert_eq!(fixed.counts(), (0, 0, 0, 0));
    assert!(memories.iter().all(|m| m.is_closed()));
    assert_eq!(
        owner.retained_bytes(),
        crate::synthetic_store::StoreLimits::default().working_bytes
    );
    slot(&s.retained, &s.shared)
        .runtime
        .as_mut()
        .unwrap()
        .authority
        .fail_next_terminal_for_test(IoStage::SyncDirectory);
    let (fault, mut stopped) = s.close_for_restart().err().unwrap().into_parts();
    assert!(matches!(fault, CloseFault::Store(StoreFault::Io { .. })));
    assert!(stopped.diagnostics().worker_joined);
    assert!(matches!(
        stopped.profile.acquire_writer(),
        Err(StoreFault::Busy)
    ));
    quarantined(released(stopped)).destroy().unwrap();
}

#[test]
fn owner_worker_panic_gate_and_queue_poison_keep_abort_and_joined_writer_ownership() {
    let _disk = crate::synthetic_store::testing_lock();
    for fault in 0..4 {
        let (s, owner, fixed, _) = service_with(Limits::default());
        let (h, memory, mut peer) = phone(&owner, 1, 4);
        adopted(&fixed, &h);
        work(&owner, &h, &mut peer, 1);
        let token = tokens(&owner).remove(0);
        let attempt = prepared(&fixed, &token);
        let id = attempt.id();
        let gate = Arc::new(ExitGate::default());
        let release = OpenGate(gate.clone());
        fixed.configure(
            id,
            TestHooks {
                before_begin: Some(gate.clone()),
                core: CoreHooks {
                    hold: fault == 0,
                    fail_installed: fault == 3,
                    ..Default::default()
                },
                outcome: (fault == 0)
                    .then_some(crate::persistent::fixed_executor::Outcome::PanicAfterBegin),
            },
        );
        fixed.submit(attempt, FixedOutcome::Success).unwrap();
        wait(|| gate.entered());
        let probe = fixed.probe(id);
        match fault {
            1 => probe.poison(),
            2 => {
                let _ = std::panic::catch_unwind(|| {
                    let _held = s.shared.queues.lock().unwrap();
                    panic!("synthetic owner status poison");
                });
            }
            _ => (),
        }
        drop(release);
        if fault == 0 {
            wait(|| probe.calls() == 1);
            assert!(matches!(
                fixed.observe(id),
                Observation::Present {
                    execution: Execution::MayHaveRun,
                    cleanup_pending: true,
                    ..
                }
            ));
            probe.finish();
        }
        wait(|| owner.is_finished());
        let (fault, mut stopped) = s.close_for_restart().err().unwrap().into_parts();
        assert!(matches!(fault, CloseFault::Worker(_)));
        assert_eq!(probe.joins(), 1);
        assert!(stopped.diagnostics().worker_joined);
        assert_eq!(fixed.counts(), (0, 0, 0, 0));
        assert_eq!(token.status(), WorkStatus::Cancelled);
        assert!(memory.is_closed());
        assert_eq!(memory.delivery_attempts(), 1);
        assert!(matches!(
            stopped.profile.acquire_writer(),
            Err(StoreFault::Busy)
        ));
        quarantined(released(stopped)).destroy().unwrap();
    }
}

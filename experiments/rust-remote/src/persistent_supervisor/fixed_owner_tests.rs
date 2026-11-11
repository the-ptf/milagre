use super::*;
use crate::persistent_supervisor::fixed::{
    self, FixedFixture, FixedOutcome, FixedOwnerClient, NotClaimed, Observation, Phase,
    PrepareRefusal, StatusRefusal, SubmitRefusal, SubmitRejection, Terminal, WaitFault,
};
fn fixture() -> (
    PersistentSupervisor,
    PersistentOwnerClient,
    FixedOwnerClient,
    ManualClock,
) {
    let clock = ManualClock::default();
    clock.advance_to(1).unwrap();
    let s = PersistentSupervisor::start_fixed_fixture(
        profile(),
        Limits::default(),
        Clock::Manual(clock.clone()),
        FixedFixture,
    )
    .unwrap_or_else(|_| panic!("fixed fixture start"));
    let owner = s.owner();
    let fixed = s.fixed_owner().unwrap();
    fixed.pause_dispatch(true);
    run(&owner, C::OpenPairing);
    (s, owner, fixed, clock)
}
fn wait(mut predicate: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + WAIT;
    while !predicate() {
        assert!(
            std::time::Instant::now() < deadline,
            "fixed admission did not progress"
        );
        std::thread::yield_now();
    }
}
fn prepared(fixed: &FixedOwnerClient, token: &WorkToken) -> fixed::FixedAttempt {
    fixed.prepare(token.clone()).unwrap().wait(WAIT).unwrap()
}
fn adopted(
    fixed: &FixedOwnerClient,
    handle: &Handle,
) -> crate::persistent::fixed_executor::TargetId {
    fixed.adopt(handle.clone()).unwrap().wait(WAIT).unwrap()
}

#[test]
fn fixed_mode_is_private_opt_in_and_backing_is_precharged() {
    let _disk = crate::synthetic_store::testing_lock();
    let (ordinary, _, _) = service(Limits::default());
    assert!(ordinary.fixed_owner().is_none());
    let before = ordinary.retained_bytes();
    let (s, _, fixed, _) = fixture();
    assert_eq!(fixed.counts(), (0, 0, 0, 0));
    assert_eq!(s.retained_bytes() - before, fixed::backing_bytes().unwrap());
    let stale = fixed.clone();
    finish(s);
    assert_eq!(stale.counts(), (0, 0, 0, 0));
    finish(ordinary);
}
#[test]
fn fixed_adoption_preserves_bound_mailbox_and_rejects_unread_or_stale_generation() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, owner, fixed, _) = fixture();
    let (h, memory) = attach(&owner, 1);
    assert_eq!(
        fixed.adopt(h.clone()).unwrap().wait(WAIT),
        Err(WaitFault::Refused(PrepareRefusal::Stale))
    );
    let pending = hello(&owner, &h, 4, DeviceKind::Phone);
    let before = s.retained_bytes();
    assert_eq!(
        fixed.adopt(h.clone()).unwrap().wait(WAIT),
        Err(WaitFault::Refused(PrepareRefusal::Full))
    );
    assert_eq!(s.retained_bytes(), before);
    let mut peer = pending.finish(&memory.receive().unwrap()).unwrap();
    let before = s.retained_bytes();
    let target = adopted(&fixed, &h);
    assert_eq!(s.retained_bytes(), before + 4096);
    assert_eq!(
        fixed.adopt(h.clone()).unwrap().wait(WAIT),
        Err(WaitFault::Refused(PrepareRefusal::Stale))
    );
    work(&owner, &h, &mut peer, 1);
    let token = tokens(&owner).remove(0);
    let attempt = prepared(&fixed, &token);
    let (fresh, fresh_memory, _) = phone(&owner, 1, 4);
    assert!(memory.is_closed());
    let fresh_target = adopted(&fixed, &fresh);
    assert_ne!(fresh_target, target);
    assert_ne!(fresh_target.generation, target.generation);
    assert!(matches!(
        fixed.submit(attempt, FixedOutcome::Success),
        Err(SubmitRejection::Unavailable(
            SubmitRefusal::Replaced | SubmitRefusal::Revoked
        ))
    ));
    assert!(!fresh_memory.is_closed());
    assert_eq!(
        fixed.adopt(h).unwrap().wait(WAIT),
        Err(WaitFault::Refused(PrepareRefusal::Stale))
    );
    finish(s);
}
#[test]
fn fixed_full_returns_exact_unqueued_permit_and_explicit_retry_consumes_once() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, owner, fixed, _) = fixture();
    let (h, memory, mut peer) = phone(&owner, 1, 4);
    adopted(&fixed, &h);
    work(&owner, &h, &mut peer, 1);
    let token = tokens(&owner).remove(0);
    let first = prepared(&fixed, &token);
    let second = prepared(&fixed, &token);
    let first_id = first.id();
    let second_id = second.id();
    let before = s.retained_bytes();
    assert_eq!(
        fixed.submit(first, FixedOutcome::Success).unwrap().id(),
        first_id
    );
    let returned = match fixed.submit(second, FixedOutcome::Unavailable) {
        Err(SubmitRejection::Full(a)) => a,
        _ => panic!("exact Full permit"),
    };
    assert_eq!(returned.id(), second_id);
    assert_eq!(s.retained_bytes(), before);
    assert_eq!(
        fixed.ack_terminal(first_id),
        Err(StatusRefusal::NotTerminal)
    );
    assert_eq!(token.status(), crate::registry::WorkStatus::InFlight);
    assert!(memory.receive().is_none());
    fixed.cancel(first_id).unwrap();
    wait(|| {
        fixed.observe(first_id)
            == Observation::Present {
                phase: Phase::Terminal(Terminal::NotClaimed(NotClaimed::Cancelled)),
                cancel_requested: true,
                execution: crate::persistent::fixed_executor::Execution::NotStarted,
                status: None,
                cleanup_pending: false,
            }
    });
    fixed.ack_terminal(first_id).unwrap();
    assert_eq!(fixed.observe(first_id), Observation::Forgotten);
    let accepted = {
        let receipt = fixed.submit(returned, FixedOutcome::Unavailable).unwrap();
        receipt.id() // Accepted receipt destruction never cancels or replays.
    };
    assert_eq!(accepted, second_id);
    assert_eq!(
        fixed.observe(second_id),
        Observation::Present {
            phase: Phase::Queued,
            cancel_requested: false,
            execution: crate::persistent::fixed_executor::Execution::NotStarted,
            status: None,
            cleanup_pending: false,
        }
    );
    assert_eq!(fixed.counts().1, 1);
    assert_eq!(token.status(), crate::registry::WorkStatus::InFlight);
    fixed.cancel(second_id).unwrap();
    wait(|| {
        matches!(
            fixed.observe(second_id),
            Observation::Present {
                phase: Phase::Terminal(_),
                ..
            }
        )
    });
    fixed.ack_terminal(second_id).unwrap();
    let retry = prepared(&fixed, &token);
    assert_ne!(retry.id(), first_id);
    assert_ne!(retry.id(), second_id);
    assert_eq!(fixed.cancel(first_id), Err(StatusRefusal::Forgotten));
    drop(retry);
    wait(|| fixed.counts().0 == 0);
    finish(s);
}
#[test]
fn fixed_prepare_full_retains_registry_eligibility_and_unread_replies_are_bounded() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, owner, fixed, _) = fixture();
    let (h, _, mut peer) = phone(&owner, 1, 4);
    adopted(&fixed, &h);
    work(&owner, &h, &mut peer, 1);
    let token = tokens(&owner).remove(0);
    let baseline = s.retained_bytes();
    let mut replies = Vec::new();
    for _ in 0..16 {
        replies.push(fixed.prepare(token.clone()).unwrap());
    }
    wait(|| fixed.counts().0 == 16);
    assert!(matches!(
        fixed.prepare(token.clone()),
        Err(PrepareRefusal::Full)
    ));
    assert_eq!(token.status(), crate::registry::WorkStatus::InFlight);
    drop(replies.pop());
    wait(|| fixed.counts().0 == 15);
    let retry = fixed.prepare(token.clone()).unwrap().wait(WAIT).unwrap();
    assert_eq!(fixed.counts().0, 16);
    drop(retry);
    drop(replies);
    wait(|| fixed.counts() == (0, 0, 0, 0));
    assert_eq!(s.retained_bytes(), baseline);
    let (gate, receipt) = park(&owner);
    let release = UnparkOnDrop(gate);
    let mut pending = fixed.prepare(token.clone()).unwrap();
    assert!(matches!(
        pending.wait(Duration::from_millis(1)),
        Err(WaitFault::Timeout)
    ));
    assert_eq!(fixed.counts().0, 0);
    drop(pending);
    drop(release);
    receipt.wait(WAIT).unwrap();
    wait(|| fixed.counts() == (0, 0, 0, 0));
    assert_eq!(token.status(), crate::registry::WorkStatus::InFlight);
    finish(s);
}
#[test]
fn fixed_device_status_cap_charges_original_pool_and_reuses_only_disposed_rows() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, owner, fixed, _) = fixture();
    let (h, _, mut peer) = phone(&owner, 1, 4);
    adopted(&fixed, &h);
    work(&owner, &h, &mut peer, 1);
    let token = tokens(&owner).remove(0);
    let baseline = s.retained_bytes();
    let mut attempts = Vec::new();
    for _ in 0..32 {
        attempts.push(prepared(&fixed, &token));
    }
    assert_eq!(fixed.counts().0, 32);
    assert_eq!(s.retained_bytes(), baseline + 32 * fixed::STATUS_BYTES);
    assert!(matches!(
        fixed.prepare(token.clone()).unwrap().wait(WAIT),
        Err(WaitFault::Refused(PrepareRefusal::Full))
    ));
    let discarded = attempts.pop().unwrap();
    let old = discarded.id();
    drop(discarded);
    wait(|| fixed.counts().0 == 31);
    assert_eq!(s.retained_bytes(), baseline + 31 * fixed::STATUS_BYTES);
    assert_eq!(fixed.observe(old), Observation::Forgotten);
    let fresh = prepared(&fixed, &token);
    assert_ne!(fresh.id(), old);
    assert_eq!(fixed.cancel(old), Err(StatusRefusal::Forgotten));
    drop(fresh);
    drop(attempts);
    wait(|| fixed.counts().0 == 0);
    assert_eq!(s.retained_bytes(), baseline);
    finish(s);
}

struct UnparkOnDrop(Gate);
impl Drop for UnparkOnDrop {
    fn drop(&mut self) {
        unpark(self.0.clone());
    }
}

#[path = "fixed_lifecycle_tests.rs"]
mod fixed_lifecycle_tests;

#[path = "fixed_peer_tests.rs"]
mod fixed_peer_tests;

#[test]
fn fixed_all_512_statuses_remain_charged_across_device_churn_until_ack() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, owner, fixed, clock) = fixture();
    let mut attempts = Vec::new();
    let mut tokens_by_device = Vec::new();
    for n in 1..=16 {
        clock.advance_to(n * 1001).unwrap();
        let (h, _, mut peer) = phone(&owner, n, n as u8 + 20);
        adopted(&fixed, &h);
        work(&owner, &h, &mut peer, 1);
        let token = tokens(&owner)
            .into_iter()
            .find(|t| t.handle().same(&h))
            .unwrap();
        tokens_by_device.push(token);
    }
    let baseline = s.retained_bytes();
    for token in &tokens_by_device {
        for _ in 0..32 {
            attempts.push(prepared(&fixed, token));
        }
    }
    assert_eq!(fixed.counts().0, 512);
    assert_eq!(s.retained_bytes(), baseline + 512 * fixed::STATUS_BYTES);
    clock.advance_to(17_017).unwrap();
    let (h, _, mut peer) = phone(&owner, 1, 100);
    adopted(&fixed, &h);
    work(&owner, &h, &mut peer, 1);
    let token = tokens(&owner)
        .into_iter()
        .find(|t| t.handle().same(&h))
        .unwrap();
    assert!(matches!(
        fixed.prepare(token.clone()).unwrap().wait(WAIT),
        Err(WaitFault::Refused(PrepareRefusal::Full))
    ));
    assert_eq!(fixed.counts().0, 512);
    let old = attempts[0].id();
    wait(|| {
        matches!(
            fixed.observe(old),
            Observation::Present {
                phase: Phase::Terminal(Terminal::NotClaimed(NotClaimed::Stale)),
                ..
            }
        )
    });
    let before = s.retained_bytes();
    fixed.ack_terminal(old).unwrap();
    assert_eq!(s.retained_bytes(), before - fixed::STATUS_BYTES);
    let fresh = prepared(&fixed, &token);
    assert_ne!(fresh.id(), old);
    assert_eq!(fixed.observe(old), Observation::Forgotten);
    assert_eq!(fixed.counts().0, 512);
    assert_eq!(s.retained_bytes(), before);
    drop(attempts);
    drop(fresh);
    wait(|| fixed.counts().0 == 0);
    finish(s);
}

#[test]
fn fixed_status_needed_minus_one_and_exact_use_original_connection_device_global() {
    let _disk = crate::synthetic_store::testing_lock();
    for scope in 0..3 {
        let (s, owner, fixed, _) = fixture();
        let (h, _, mut peer) = phone(&owner, 1, 4);
        let (alias, _, mut peer2) = phone(&owner, 2, if scope == 1 { 4 } else { 5 });
        adopted(&fixed, &h);
        adopted(&fixed, &alias);
        work(&owner, &h, &mut peer, 1);
        work(&owner, &alias, &mut peer2, 1);
        let all = tokens(&owner);
        let token = all.iter().find(|t| t.handle().same(&h)).unwrap();
        let alias_token = all.iter().find(|t| t.handle().same(&alias)).unwrap();
        let first = prepared(&fixed, token);
        let alias_first = prepared(&fixed, alias_token);
        let budget = fixed.budget_for_test(first.id());
        let alias_budget = fixed.budget_for_test(alias_first.id());
        let global = s.shared.global.clone();
        let pool = global.connection(256 * 1024 * 1024).unwrap();
        let pressure = |less: usize| {
            let (b, max, used) = match scope {
                0 => (&budget, 64 * 1024 * 1024, budget.used()),
                1 => (
                    &alias_budget,
                    64 * 1024 * 1024,
                    budget.device_used().unwrap(),
                ),
                _ => (&pool, 256 * 1024 * 1024, global.used()),
            };
            b.reserve(max - used - fixed::STATUS_BYTES + less).unwrap()
        };
        let fill = pressure(1);
        let before = global.used();
        assert!(matches!(
            fixed.prepare(token.clone()).unwrap().wait(WAIT),
            Err(WaitFault::Refused(PrepareRefusal::Full))
        ));
        assert_eq!(global.used(), before);
        assert_eq!(token.status(), crate::registry::WorkStatus::InFlight);
        drop(fill);
        let fill = pressure(0);
        let admitted = prepared(&fixed, token);
        match scope {
            0 => assert_eq!(budget.used(), 64 * 1024 * 1024),
            1 => assert_eq!(budget.device_used(), Some(64 * 1024 * 1024)),
            _ => assert_eq!(global.used(), 256 * 1024 * 1024),
        }
        drop(admitted);
        drop(first);
        drop(alias_first);
        drop(fill);
        wait(|| fixed.counts().0 == 0);
        finish(s);
    }
}

#[test]
fn fixed_start_failure_preserves_existing_typed_writer_and_releases_backing() {
    let _disk = crate::synthetic_store::testing_lock();
    let bad = Limits {
        carrier_bytes: 1023,
        ..Default::default()
    };
    let (_, stopped) =
        PersistentSupervisor::start_fixed_fixture(profile(), bad, Clock::monotonic(), FixedFixture)
            .err()
            .unwrap()
            .into_parts();
    assert!(!stopped.diagnostics().worker_joined);
    let p = released(stopped);
    let s = PersistentSupervisor::start_fixed_fixture(
        p,
        Limits::default(),
        Clock::monotonic(),
        FixedFixture,
    )
    .unwrap_or_else(|_| panic!("corrected retry"));
    finish(s);
    for mode in 0..3 {
        let p = profile();
        let pool = p.service_pool().unwrap();
        let (_, mut stopped) = PersistentSupervisor::start_inner(
            p,
            Limits::default(),
            Clock::monotonic(),
            Hooks {
                fixed_fixture: true,
                reserve_failure: mode == 0,
                spawn_failure: mode == 1,
                startup_panic: mode == 2,
                ..Default::default()
            },
        )
        .err()
        .unwrap()
        .into_parts();
        assert!(matches!(
            stopped.profile.acquire_writer(),
            Err(StoreFault::Busy)
        ));
        assert_eq!(
            pool.used(),
            crate::synthetic_store::StoreLimits::default().working_bytes
        );
        quarantined(released(stopped)).destroy().unwrap();
    }
}

#[test]
fn fixed_foreign_scope_cannot_adopt_observe_cancel_or_submit() {
    let _disk = crate::synthetic_store::testing_lock();
    let (first, owner, fixed, _) = fixture();
    let (second, _, foreign, _) = fixture();
    let (h, memory, mut peer) = phone(&owner, 1, 4);
    let before = second.retained_bytes();
    assert_eq!(
        foreign.adopt(h.clone()).unwrap().wait(WAIT),
        Err(WaitFault::Refused(PrepareRefusal::Stale))
    );
    assert_eq!(second.retained_bytes(), before);
    adopted(&fixed, &h);
    work(&owner, &h, &mut peer, 1);
    let token = tokens(&owner).remove(0);
    let attempt = prepared(&fixed, &token);
    let id = attempt.id();
    assert_eq!(foreign.observe(id), Observation::Forgotten);
    assert_eq!(foreign.cancel(id), Err(StatusRefusal::Forgotten));
    assert_eq!(foreign.ack_terminal(id), Err(StatusRefusal::Forgotten));
    assert!(matches!(
        foreign.submit(attempt, FixedOutcome::Success),
        Err(SubmitRejection::Unavailable(SubmitRefusal::Replaced))
    ));
    wait(|| fixed.counts().0 == 0);
    assert_eq!(token.status(), WorkStatus::InFlight);
    assert!(!memory.is_closed());
    assert!(memory.receive().is_none());
    assert_eq!(foreign.counts(), (0, 0, 0, 0));
    finish(first);
    finish(second);
}

#[test]
fn fixed_queued_expiry_progresses_on_tick_without_another_command() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, owner, fixed, clock) = fixture();
    let (h, memory, mut peer) = phone(&owner, 1, 4);
    adopted(&fixed, &h);
    work(&owner, &h, &mut peer, 1);
    let token = tokens(&owner).remove(0);
    let attempt = prepared(&fixed, &token);
    let id = fixed.submit(attempt, FixedOutcome::Timeout).unwrap().id();
    clock.advance_to(20_001).unwrap();
    wait(|| {
        fixed.observe(id)
            == Observation::Present {
                phase: Phase::Terminal(Terminal::NotClaimed(NotClaimed::Expired)),
                cancel_requested: false,
                execution: crate::persistent::fixed_executor::Execution::NotStarted,
                status: None,
                cleanup_pending: false,
            }
    });
    assert_eq!(fixed.counts().1, 0);
    assert_eq!(token.status(), WorkStatus::TimedOut);
    assert!(!memory.is_closed());
    assert!(memory.receive().is_none());
    fixed.ack_terminal(id).unwrap();
    assert_eq!(fixed.observe(id), Observation::Forgotten);
    assert_eq!(fixed.counts().0, 0);
    finish(s);
}

#[test]
fn fixed_expired_preparation_reasserts_real_promoted_work_without_execution() {
    let _disk = crate::synthetic_store::testing_lock();
    let clock = ManualClock::default();
    clock.advance_to(1).unwrap();
    let s = PersistentSupervisor::start_fixed_fixture(
        profile(),
        Limits {
            registry: crate::registry::Limits {
                inflight: 1,
                ..Default::default()
            },
            ..Default::default()
        },
        Clock::Manual(clock.clone()),
        FixedFixture,
    )
    .unwrap_or_else(|_| panic!("fixture"));
    let owner = s.owner();
    let fixed = s.fixed_owner().unwrap();
    run(&owner, C::OpenPairing);
    let (h, memory, mut peer) = phone(&owner, 1, 4);
    adopted(&fixed, &h);
    work(&owner, &h, &mut peer, 1);
    let first = tokens(&owner).remove(0); // Draining clears the coalesced readiness bit.
    clock.advance_to(19_000).unwrap();
    work(&owner, &h, &mut peer, 2); // Queued behind the uninspected first request.
    assert!(owner.next_event(Duration::ZERO).is_none());
    clock.advance_to(20_001).unwrap();
    assert!(matches!(
        fixed.prepare(first.clone()).unwrap().wait(WAIT),
        Err(WaitFault::Refused(PrepareRefusal::Expired))
    ));
    assert_eq!(first.status(), WorkStatus::TimedOut);
    assert!(matches!(owner.next_event(WAIT), Some(Event::WorkAvailable)));
    let promoted = tokens(&owner);
    assert_eq!(promoted.len(), 1);
    assert_eq!(promoted[0].id(), 2);
    assert_eq!(promoted[0].status(), WorkStatus::InFlight);
    assert!(owner.next_event(Duration::ZERO).is_none());
    assert_eq!(fixed.counts(), (0, 0, 0, 0));
    assert_eq!(memory.delivery_attempts(), 1); // ACCEPT only.
    assert!(memory.receive().is_none());
    // Promotion does not renew the second request's assembly-based scheduling deadline.
    let attempt = prepared(&fixed, &promoted[0]);
    let id = attempt.id();
    clock.advance_to(39_000).unwrap();
    wait(|| {
        promoted[0].status() == WorkStatus::TimedOut
            && matches!(
                fixed.observe(id),
                Observation::Present {
                    phase: Phase::Terminal(Terminal::NotClaimed(NotClaimed::Expired)),
                    ..
                }
            )
    });
    assert_eq!(promoted[0].status(), WorkStatus::TimedOut);
    assert_eq!(memory.delivery_attempts(), 1);
    assert!(!memory.is_closed());
    drop(attempt);
    finish(s);
}

#[test]
fn fixed_saturated_admission_keeps_control_and_stop_lanes_and_drains_forgotten_handles() {
    let _disk = crate::synthetic_store::testing_lock();
    let (mut s, owner, fixed, clock) = fixture();
    let mut work_tokens = Vec::new();
    let mut memories = Vec::new();
    for n in 1..=16 {
        clock.advance_to(n * 1001).unwrap();
        let (h, memory, mut peer) = phone(&owner, n, n as u8 + 20);
        adopted(&fixed, &h);
        work(&owner, &h, &mut peer, 1);
        let token = tokens(&owner)
            .into_iter()
            .find(|t| t.handle().same(&h))
            .unwrap();
        fixed
            .submit(prepared(&fixed, &token), FixedOutcome::Success)
            .unwrap();
        work_tokens.push(token);
        memories.push(memory);
    }
    assert_eq!(fixed.counts().1, 16);
    let spare = prepared(&fixed, &work_tokens[0]);
    let old = spare.id();
    let spare = match fixed.submit(spare, FixedOutcome::Success) {
        Err(SubmitRejection::Full(a)) => a,
        _ => panic!("full global submission ring"),
    };
    assert_eq!(spare.id(), old);
    let (gate, held) = park(&owner);
    let release = UnparkOnDrop(gate);
    for _ in 0..16 {
        std::mem::forget(fixed.prepare(work_tokens[0].clone()).unwrap());
    }
    assert_eq!(fixed.counts(), (17, 16, 16, 16));
    for _ in 0..Limits::default().commands {
        owner.submit(C::HostPublicKey).unwrap();
    }
    assert!(matches!(owner.submit(C::HostPublicKey), Err(Error::Full)));
    // Fixed and ordinary saturation cannot consume the reserved control lane.
    for _ in 0..8 {
        owner
            .submit(C::DrainWork {
                cursor: None,
                limit: 1,
            })
            .unwrap();
    }
    assert!(matches!(
        owner.submit(C::DrainWork {
            cursor: None,
            limit: 1
        }),
        Err(Error::Full)
    ));
    s.shared.request_stop(false);
    assert!(matches!(
        fixed.prepare(work_tokens[0].clone()),
        Err(PrepareRefusal::Stopped)
    ));
    assert!(matches!(
        fixed.submit(spare, FixedOutcome::Success),
        Err(SubmitRejection::Unavailable(SubmitRefusal::Stopped))
    ));
    drop(release);
    let _ = held.wait(WAIT);
    s.join(false);
    assert!(s.worker.is_none());
    assert!(s.shared.finished.load(Ordering::SeqCst));
    assert_eq!(fixed.counts(), (0, 0, 0, 0));
    assert_eq!(fixed.observe(old), Observation::Stopped);
    assert!(memories.iter().all(MemoryCarrier::is_closed));
    assert!(work_tokens
        .iter()
        .all(|t| t.status() == WorkStatus::Cancelled));
    assert_eq!(
        s.retained_bytes(),
        crate::synthetic_store::StoreLimits::default().working_bytes
    );
    assert!(matches!(
        s.profile.as_mut().unwrap().acquire_writer(),
        Err(StoreFault::Busy)
    ));
    finish(s);
}

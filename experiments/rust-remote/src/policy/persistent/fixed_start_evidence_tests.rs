use super::*;
use crate::policy::persistent::fixed_executor::{
    BeforeBegin, BeginTerminal, Fault, Hooks, Id, Outcome, StartFailure,
};
use crate::supervisor::{Clock, ManualClock, MemoryCarrier};

fn clock() -> Clock {
    let clock = ManualClock::default();
    clock.advance_to(2).unwrap();
    Clock::Manual(clock)
}
fn joined(authority: &mut PersistentAuthority, id: Id) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while !authority.fixed_thread_finished(id) {
        assert!(
            std::time::Instant::now() < deadline,
            "fixed worker did not exit"
        );
        std::thread::yield_now();
    }
    authority.poll_fixed(2).unwrap();
}

#[test]
fn evidenced_preclaim_budget_refusal_keeps_original_work_eligible_for_explicit_retry() {
    let _disk = crate::synthetic_store::testing_lock();
    let mut profile = profile(Default::default());
    let mut authority = resume(&mut profile, Default::default());
    authority.open_pairing(1).unwrap();
    let (handle, mut peer, _) = pair(&mut authority, 1, 4, 1);
    let memory = MemoryCarrier::new();
    let target = authority
        .register_fixed_carrier(&handle, memory, Default::default())
        .unwrap();
    let work = request(&mut authority, &handle, &mut peer, 1, 2).remove(0);
    let budget = authority
        .registry
        .as_mut()
        .unwrap()
        .inspect_claim(&work, 2)
        .unwrap();
    let pressure = budget
        .reserve(64 * 1024 * 1024 - budget.used() - 2_172_416 + 1)
        .unwrap();
    let before = budget.used();
    assert_eq!(
        authority.start_fixed_tracked_evidenced(work.clone(), target, Outcome::Success, &clock()),
        Err(StartFailure::NotClaimed(Fault::Full))
    );
    assert_eq!(authority.fixed_occupied_slots(), 0);
    assert_eq!(authority.fixed_failed_install_stats(), None);
    assert_eq!(budget.used(), before);
    assert_eq!(work.status(), WorkStatus::InFlight);
    drop(pressure);
    let id = authority
        .start_fixed_tracked_evidenced(work.clone(), target, Outcome::Success, &clock())
        .unwrap();
    let probe = authority.fixed_probe(id);
    joined(&mut authority, id);
    assert_eq!(probe.calls(), 1);
    assert_eq!(probe.joins(), 1);
    authority.discard_fixed(id, 2).unwrap();
    assert_eq!(work.status(), WorkStatus::Cancelled);
    clean(authority);
}

#[test]
fn evidenced_preclaim_spawn_refusal_is_reported_only_after_the_gated_thread_is_joined() {
    let _disk = crate::synthetic_store::testing_lock();
    let mut profile = profile(Default::default());
    let mut authority = resume(&mut profile, Default::default());
    authority.open_pairing(1).unwrap();
    let (handle, mut peer, _) = pair(&mut authority, 1, 4, 1);
    let memory = MemoryCarrier::new();
    let target = authority
        .register_fixed_carrier(&handle, memory.clone(), Default::default())
        .unwrap();
    let work = request(&mut authority, &handle, &mut peer, 1, 2).remove(0);
    let pool = authority.global_pool().unwrap();
    let baseline = pool.used();
    assert_eq!(
        authority.fixed_start_evidence_for_test(
            work.clone(),
            target,
            Outcome::Success,
            &clock(),
            Hooks {
                refuse_after_spawn: true,
                ..Default::default()
            }
        ),
        Err(StartFailure::NotClaimed(Fault::Spawn))
    );
    assert_eq!(authority.fixed_failed_install_stats(), Some((0, 1)));
    assert_eq!(authority.fixed_occupied_slots(), 0);
    assert_eq!(pool.used(), baseline);
    assert_eq!(work.status(), WorkStatus::InFlight);
    assert!(!memory.is_closed());
    let id = authority
        .start_fixed_tracked_evidenced(work, target, Outcome::Success, &clock())
        .unwrap();
    joined(&mut authority, id);
    authority.discard_fixed(id, 2).unwrap();
    clean(authority);
}

#[test]
fn evidenced_failed_begin_is_terminal_even_when_the_same_fault_can_mean_preclaim_stale() {
    let _disk = crate::synthetic_store::testing_lock();
    for (intervention, fault, terminal, status) in [
        (
            BeforeBegin::Cancel,
            Fault::Stale,
            BeginTerminal::Cancelled,
            WorkStatus::Cancelled,
        ),
        (
            BeforeBegin::Deadline,
            Fault::Expired,
            BeginTerminal::TimedOut,
            WorkStatus::TimedOut,
        ),
    ] {
        let mut profile = profile(Default::default());
        let mut authority = resume(&mut profile, Default::default());
        authority.open_pairing(1).unwrap();
        let (handle, mut peer, _) = pair(&mut authority, 1, 4, 1);
        let target = authority
            .register_fixed_carrier(&handle, MemoryCarrier::new(), Default::default())
            .unwrap();
        let pool = authority.global_pool().unwrap();
        let baseline = pool.used();
        let work = request(&mut authority, &handle, &mut peer, 1, 2).remove(0);
        let clock = clock();
        authority.fixed_before_begin(intervention);
        assert_eq!(
            authority.start_fixed_tracked_evidenced(work.clone(), target, Outcome::Success, &clock),
            Err(StartFailure::BeginRefused { fault, terminal })
        );
        assert_eq!(authority.fixed_failed_install_stats(), Some((0, 1)));
        assert_eq!(authority.fixed_occupied_slots(), 0);
        assert_eq!(pool.used(), baseline);
        assert_eq!(work.status(), status);
        if matches!(intervention, BeforeBegin::Cancel) {
            // Identical legacy Fault and token status, different actual start provenance.
            assert_eq!(
                authority.start_fixed_tracked_evidenced(
                    work.clone(),
                    target,
                    Outcome::Success,
                    &clock
                ),
                Err(StartFailure::NotClaimed(Fault::Stale))
            );
            assert_eq!(work.status(), WorkStatus::Cancelled);
        }
        clean(authority);
    }
}

#[test]
fn evidenced_worker_cleanup_and_clock_faults_never_advertise_clean_not_claimed() {
    let _disk = crate::synthetic_store::testing_lock();
    for fault_case in 0..3 {
        let mut profile = profile(Default::default());
        let mut authority = resume(&mut profile, Default::default());
        authority.open_pairing(1).unwrap();
        let (handle, mut peer, _) = pair(&mut authority, 1, 4, 1);
        let memory = MemoryCarrier::new();
        let target = authority
            .register_fixed_carrier(&handle, memory.clone(), Default::default())
            .unwrap();
        let work = request(&mut authority, &handle, &mut peer, 1, 2).remove(0);
        let clock = clock();
        let expected = if fault_case == 2 {
            Fault::Clock
        } else {
            Fault::Worker
        };
        let result = match fault_case {
            0 => authority.fixed_start_evidence_for_test(
                work,
                target,
                Outcome::PanicBeforeBegin,
                &clock,
                Hooks {
                    refuse_after_spawn: true,
                    ..Default::default()
                },
            ),
            1 => {
                authority.fixed_before_begin(BeforeBegin::Poison);
                authority.start_fixed_tracked_evidenced(work, target, Outcome::Success, &clock)
            }
            _ => {
                authority.poll_fixed(3).unwrap();
                authority.start_fixed_tracked_evidenced(work, target, Outcome::Success, &clock)
            }
        };
        assert_eq!(result, Err(StartFailure::Dirty(expected)));
        if fault_case != 2 {
            assert_eq!(authority.fixed_failed_install_stats(), Some((0, 1)));
        }
        assert_eq!(authority.fixed_occupied_slots(), 0);
        assert!(memory.is_closed());
        let (fault, stopped) = authority.close_for_restart().err().unwrap().into_parts();
        assert_eq!(fault, StoreFault::DirtyRun);
        assert!(matches!(profile.acquire_writer(), Err(StoreFault::Busy)));
        stopped.release();
    }
}

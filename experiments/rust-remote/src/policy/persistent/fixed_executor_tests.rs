use super::*;
use crate::policy::persistent::fixed_executor::{
    Execution, Fault, Hooks, Id, Outcome, State, EXECUTION_BYTES, METADATA_BYTES,
};
use crate::supervisor::{Clock, ManualClock};
fn clock() -> (ManualClock, Clock) {
    let m = ManualClock::default();
    m.advance_to(2).unwrap();
    (m.clone(), Clock::Manual(m))
}
fn until(mut ready: impl FnMut() -> bool) {
    let end = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while !ready() {
        assert!(
            std::time::Instant::now() < end,
            "fixed worker barrier timed out"
        );
        std::thread::yield_now();
    }
}
fn joined(a: &mut PersistentAuthority, id: Id, now: u64) {
    until(|| a.fixed_thread_finished(id));
    a.poll_fixed(now).unwrap();
    assert!(a.observe_fixed(id).unwrap().joined);
}
fn held(a: &mut PersistentAuthority, w: WorkToken, c: &Clock, deferred: bool) -> Id {
    a.start_fixed_inner(
        w,
        Outcome::Success,
        c,
        Hooks {
            hold: true,
            defer_begin: deferred,
            ..Default::default()
        },
    )
    .unwrap()
}
#[test]
fn fixed_results_require_actual_join_and_never_emit_output() {
    let _disk = crate::synthetic_store::testing_lock();
    for (outcome, status) in [
        (Outcome::Success, 200),
        (Outcome::Unavailable, 502),
        (Outcome::Timeout, 504),
    ] {
        let mut p = profile(Default::default());
        let mut a = resume(&mut p, Default::default());
        a.open_pairing(1).unwrap();
        let (h, mut peer, _) = pair(&mut a, 1, 4, 1);
        let work = request(&mut a, &h, &mut peer, 1, 2).remove(0);
        let (_, c) = clock();
        let pool = a.global_pool().unwrap();
        let baseline = pool.used();
        let id = a.start_fixed(work.clone(), outcome, &c).unwrap();
        let probe = a.fixed_probe(id);
        until(|| a.fixed_thread_finished(id));
        assert_eq!(probe.joins(), 0);
        assert_eq!(pool.used(), baseline + EXECUTION_BYTES + METADATA_BYTES);
        assert!(!a.observe_fixed(id).unwrap().joined);
        joined(&mut a, id, 2);
        let obs = a.observe_fixed(id).unwrap();
        assert_eq!(obs.state, State::Ready);
        assert_eq!(obs.status, Some(status));
        assert_eq!(obs.execution, Execution::MayHaveRun);
        assert_eq!(probe.calls(), 1);
        assert_eq!(probe.joins(), 1);
        assert_eq!(pool.used(), baseline + METADATA_BYTES);
        assert!(!a
            .take_output(&h, 2, |_| panic!("core has no output"))
            .unwrap());
        assert!(a.drain_work(None, 64, 2).unwrap().tokens.is_empty());
        a.discard_fixed(id, 2).unwrap();
        assert!(a.observe_fixed(id).is_none());
        assert_eq!(work.status(), WorkStatus::Cancelled);
        assert!(a.start_fixed(work, outcome, &c).is_err());
        clean(a);
        assert_eq!(pool.used(), StoreLimits::default().working_bytes);
    }
}
#[test]
fn installed_gate_serializes_cancel_before_and_after_begin() {
    let _disk = crate::synthetic_store::testing_lock();
    for begin in [false, true] {
        let mut p = profile(Default::default());
        let mut a = resume(&mut p, Default::default());
        a.open_pairing(1).unwrap();
        let (h, mut peer, _) = pair(&mut a, 1, 4, 1);
        let work = request(&mut a, &h, &mut peer, 1, 2).remove(0);
        let (_, c) = clock();
        let id = held(&mut a, work.clone(), &c, true);
        let probe = a.fixed_probe(id);
        if begin {
            a.fixed_test_begin(id, 2).unwrap();
            until(|| probe.calls() == 1);
        }
        a.cancel_fixed(id).unwrap();
        assert!(a.fixed_test_begin(id, 2).is_err());
        joined(&mut a, id, 2);
        let obs = a.observe_fixed(id).unwrap();
        assert_eq!(
            obs.execution,
            if begin {
                Execution::MayHaveRun
            } else {
                Execution::NotStarted
            }
        );
        assert_eq!(probe.calls(), usize::from(begin));
        assert_eq!(obs.state, State::Cancelled);
        assert_eq!(work.status(), WorkStatus::Cancelled);
        assert_eq!(h.status(), CarrierStatus::Active);
        clean(a);
        assert_eq!(probe.joins(), 1);
    }
}
#[test]
fn two_slots_per_device_limit_and_other_carrier_progress() {
    let _disk = crate::synthetic_store::testing_lock();
    let mut p = profile(Default::default());
    let mut a = resume(&mut p, Default::default());
    a.open_pairing(1).unwrap();
    let (h, mut peer, _) = pair(&mut a, 1, 4, 1);
    let (other, mut peer2, _) = pair(&mut a, 2, 5, 1);
    let (third, mut peer3, _) = pair(&mut a, 3, 6, 1);
    let (alias, mut alias_peer, _) = pair(&mut a, 4, 4, 1);
    let work = request(&mut a, &h, &mut peer, 1, 2).remove(0);
    let duplicate = request(&mut a, &h, &mut peer, 2, 2).remove(0);
    let (_, c) = clock();
    let id = held(&mut a, work.clone(), &c, false);
    let probe = a.fixed_probe(id);
    until(|| probe.calls() == 1);
    assert_eq!(
        a.start_fixed(duplicate, Outcome::Success, &c),
        Err(Fault::Full)
    );
    assert!(a.start_fixed(work, Outcome::Success, &c).is_err());
    let same_device = request(&mut a, &alias, &mut alias_peer, 1, 2).remove(0);
    assert_eq!(
        a.start_fixed(same_device, Outcome::Success, &c),
        Err(Fault::Full)
    );
    let w2 = request(&mut a, &other, &mut peer2, 1, 2).remove(0);
    let second = held(&mut a, w2, &c, false);
    let w3 = request(&mut a, &third, &mut peer3, 1, 2).remove(0);
    assert_eq!(
        a.start_fixed(w3.clone(), Outcome::Success, &c),
        Err(Fault::Full)
    );
    a.tick(3).unwrap();
    assert!(!a.observe_fixed(id).unwrap().joined);
    // The stalled fixtures do not borrow authority: ordinary traffic on carrier 3 still works.
    a.registry
        .as_mut()
        .unwrap()
        .send_encoded(&third, b"null", 3)
        .unwrap();
    a.take_output(&third, 3, |b| {
        assert_eq!(peer3.open_encoded(b).unwrap(), b"null");
        Ok(())
    })
    .unwrap();
    probe.finish();
    joined(&mut a, id, 3);
    a.discard_fixed(id, 3).unwrap();
    let m = ManualClock::default();
    m.advance_to(3).unwrap();
    let id3 = a
        .start_fixed(w3, Outcome::Success, &Clock::Manual(m))
        .unwrap();
    joined(&mut a, id3, 3);
    clean(a);
    assert_eq!(probe.joins(), 1);
    let _ = second; // No observer is needed to cancel/join the second worker at close.
}
#[test]
fn connection_preflight_needed_minus_one_and_exact_preserve_work() {
    let _disk = crate::synthetic_store::testing_lock();
    let mut p = profile(Default::default());
    let mut a = resume(&mut p, Default::default());
    a.open_pairing(1).unwrap();
    let (h, mut peer, _) = pair(&mut a, 1, 4, 1);
    let work = request(&mut a, &h, &mut peer, 1, 2).remove(0);
    let budget = a
        .registry
        .as_mut()
        .unwrap()
        .inspect_claim(&work, 2)
        .unwrap();
    let (_, c) = clock();
    let needed = EXECUTION_BYTES + METADATA_BYTES;
    let pressure = budget
        .reserve(64 * 1024 * 1024 - budget.used() - needed + 1)
        .unwrap();
    assert_eq!(
        a.start_fixed(work.clone(), Outcome::Success, &c),
        Err(Fault::Full)
    );
    assert_eq!(work.status(), WorkStatus::InFlight);
    drop(pressure);
    let pressure = budget
        .reserve(64 * 1024 * 1024 - budget.used() - needed)
        .unwrap();
    let id = held(&mut a, work, &c, false);
    assert_eq!(budget.used(), 64 * 1024 * 1024);
    a.cancel_fixed(id).unwrap();
    joined(&mut a, id, 2);
    drop(pressure);
    clean(a);
}
#[test]
fn remove_replace_and_disconnect_signal_cancel_without_polling() {
    let _disk = crate::synthetic_store::testing_lock();
    for action in 0..3 {
        let mut p = profile(Default::default());
        let mut a = resume(&mut p, Default::default());
        a.open_pairing(1).unwrap();
        let (h, mut peer, key) = pair(&mut a, 1, 4, 1);
        let work = request(&mut a, &h, &mut peer, 1, 2).remove(0);
        let (_, c) = clock();
        let id = held(&mut a, work.clone(), &c, false);
        let probe = a.fixed_probe(id);
        until(|| probe.calls() == 1);
        match action {
            0 => a.remove_device(&key, 3).unwrap(),
            1 => {
                let (fresh, _, _) = pair(&mut a, 1, 4, 3);
                assert_eq!(fresh.status(), CarrierStatus::Active);
            }
            _ => {
                assert!(a.disconnect(&h));
            }
        }
        assert!(probe.cancelled(), "action {action}");
        joined(&mut a, id, 3);
        assert_eq!(work.status(), WorkStatus::Cancelled);
        assert_eq!(
            a.observe_fixed(id).unwrap().execution,
            Execution::MayHaveRun
        );
        clean(a);
    }
}
#[test]
fn panic_before_and_after_begin_retains_credit_and_dirty_writer() {
    let _disk = crate::synthetic_store::testing_lock();
    for before in [true, false] {
        let mut p = profile(Default::default());
        let mut a = resume(&mut p, Default::default());
        a.open_pairing(1).unwrap();
        let (h, mut peer, _) = pair(&mut a, 1, 4, 1);
        let w = request(&mut a, &h, &mut peer, 1, 2).remove(0);
        let (_, c) = clock();
        let id = a
            .start_fixed_inner(
                w,
                if before {
                    Outcome::PanicBeforeBegin
                } else {
                    Outcome::PanicAfterBegin
                },
                &c,
                Hooks {
                    defer_begin: before,
                    ..Default::default()
                },
            )
            .unwrap();
        let probe = a.fixed_probe(id);
        let pool = a.global_pool().unwrap();
        let charged = pool.used();
        until(|| a.fixed_thread_finished(id));
        assert_eq!(pool.used(), charged);
        assert_eq!(probe.joins(), 0);
        assert_eq!(a.poll_fixed(2), Err(Fault::Worker));
        assert_eq!(probe.joins(), 1);
        assert_eq!(
            a.observe_fixed(id).unwrap().execution,
            if before {
                Execution::NotStarted
            } else {
                Execution::MayHaveRun
            }
        );
        let (fault, stopped) = a.close_for_restart().err().unwrap().into_parts();
        assert_eq!(fault, StoreFault::DirtyRun);
        assert!(matches!(p.acquire_writer(), Err(StoreFault::Busy)));
        stopped.release();
    }
}
#[test]
fn failure_after_install_joins_and_never_cleans_the_running_profile() {
    let _disk = crate::synthetic_store::testing_lock();
    let mut p = profile(Default::default());
    let mut a = resume(&mut p, Default::default());
    a.open_pairing(1).unwrap();
    let (h, mut peer, _) = pair(&mut a, 1, 4, 1);
    let w = request(&mut a, &h, &mut peer, 1, 2).remove(0);
    let (_, c) = clock();
    let pool = a.global_pool().unwrap();
    assert_eq!(
        a.start_fixed_inner(
            w.clone(),
            Outcome::Success,
            &c,
            Hooks {
                fail_installed: true,
                ..Default::default()
            }
        ),
        Err(Fault::Worker)
    );
    assert_eq!(w.status(), WorkStatus::Cancelled);
    assert_eq!(a.fixed_failed_install_stats(), Some((0, 1)));
    assert_eq!(pool.used(), StoreLimits::default().working_bytes);
    let (fault, stopped) = a.close_for_restart().err().unwrap().into_parts();
    assert_eq!(fault, StoreFault::DirtyRun);
    stopped.release();
}
#[test]
fn poisoned_signal_is_cleanup_only_and_retains_guard() {
    let _disk = crate::synthetic_store::testing_lock();
    let mut p = profile(Default::default());
    let mut a = resume(&mut p, Default::default());
    a.open_pairing(1).unwrap();
    let (h, mut peer, _) = pair(&mut a, 1, 4, 1);
    let w = request(&mut a, &h, &mut peer, 1, 2).remove(0);
    let (_, c) = clock();
    let id = held(&mut a, w, &c, true);
    let probe = a.fixed_probe(id);
    probe.poison();
    assert_eq!(a.poll_fixed(2), Err(Fault::Worker));
    assert!(a.fixed_test_begin(id, 2).is_err());
    let (fault, stopped) = a.close_for_restart().err().unwrap().into_parts();
    assert_eq!(fault, StoreFault::DirtyRun);
    assert_eq!(probe.joins(), 1);
    assert_eq!(probe.calls(), 0);
    stopped.release();
}
#[test]
fn http_margin_and_completion_expiry_keep_fixed_results_private() {
    let _disk = crate::synthetic_store::testing_lock();
    let mut p = profile(Default::default());
    let mut a = resume(&mut p, Default::default());
    a.open_pairing(1).unwrap();
    let (h, mut peer, _) = pair(&mut a, 1, 4, 1);
    let w = request(&mut a, &h, &mut peer, 1, 2).remove(0);
    let (_, c) = clock();
    let id = held(&mut a, w.clone(), &c, false);
    for n in 1..=8 {
        request(&mut a, &h, &mut peer, n + 1, 2 + n as u64 * 40_000);
        a.tick(2 + n as u64 * 40_000).unwrap();
    }
    a.tick(340_002).unwrap();
    joined(&mut a, id, 340_002);
    assert_eq!(a.observe_fixed(id).unwrap().status, Some(504));
    assert!(!a
        .take_output(&h, 340_002, |_| panic!("no asynchronous egress"))
        .unwrap());
    a.tick(345_002).unwrap();
    assert_eq!(a.observe_fixed(id).unwrap().state, State::TimedOut);
    assert_eq!(w.status(), WorkStatus::TimedOut);
    clean(a);
}
#[test]
fn idle_expiry_and_forgotten_observer_do_not_detach_workers() {
    let _disk = crate::synthetic_store::testing_lock();
    for drop_authority in [false, true] {
        let mut p = profile(Default::default());
        let mut a = resume(&mut p, Default::default());
        a.open_pairing(1).unwrap();
        let (h, mut peer, _) = pair(&mut a, 1, 4, 1);
        let w = request(&mut a, &h, &mut peer, 1, 2).remove(0);
        let (_, c) = clock();
        let id = held(&mut a, w.clone(), &c, false);
        let probe = a.fixed_probe(id);
        let pool = a.global_pool().unwrap();
        // Id is only a copyable value; discarding every observer cannot discard authority ownership.
        if drop_authority {
            drop(a);
        } else {
            a.tick(45_002).unwrap();
            assert!(probe.cancelled());
            joined(&mut a, id, 45_002);
            clean(a);
        }
        assert_eq!(probe.joins(), 1);
        assert_eq!(w.status(), WorkStatus::Cancelled);
        assert_eq!(pool.used(), StoreLimits::default().working_bytes);
    }
}

struct ReleaseExit(Arc<crate::policy::persistent::fixed_executor::ExitGate>);
impl Drop for ReleaseExit {
    fn drop(&mut self) {
        self.0.release();
    }
}
#[test]
fn unfinished_exit_does_not_block_poll_but_clean_waits_for_real_join() {
    use crate::policy::persistent::fixed_executor::ExitGate;
    let _disk = crate::synthetic_store::testing_lock();
    let mut p = profile(Default::default());
    let mut a = resume(&mut p, Default::default());
    a.open_pairing(1).unwrap();
    let (h, mut peer, _) = pair(&mut a, 1, 4, 1);
    let (other, mut peer2, _) = pair(&mut a, 2, 5, 1);
    let w = request(&mut a, &h, &mut peer, 1, 2).remove(0);
    let (_, c) = clock();
    let exit = Arc::new(ExitGate::default());
    let release = ReleaseExit(exit.clone());
    let id = a
        .start_fixed_inner(
            w,
            Outcome::Success,
            &c,
            Hooks {
                exit: Some(exit.clone()),
                ..Default::default()
            },
        )
        .unwrap();
    let probe = a.fixed_probe(id);
    let pool = a.global_pool().unwrap();
    let charged = pool.used();
    until(|| exit.entered());
    assert!(!a.fixed_thread_finished(id));
    let (poll_tx, poll_rx) = std::sync::mpsc::sync_channel(1);
    let polling = std::thread::spawn(move || {
        let result = a.poll_fixed(2);
        let _ = poll_tx.send((a, result));
    });
    let polled = poll_rx.recv_timeout(std::time::Duration::from_secs(3));
    if polled.is_err() {
        exit.release(); // A regression must fail, not strand the fixture thread.
    }
    polling.join().unwrap();
    let (mut a, result) = polled.unwrap();
    result.unwrap();
    assert_eq!(probe.joins(), 0);
    assert_eq!(pool.used(), charged);
    request(&mut a, &other, &mut peer2, 1, 2);
    a.tick(3).unwrap();
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    let closing = std::thread::spawn(move || {
        let ok = a.close_for_restart().is_ok();
        tx.send(ok).unwrap();
    });
    until(|| probe.cancelled());
    let premature = rx.try_recv();
    let busy = matches!(p.acquire_writer(), Err(StoreFault::Busy));
    let joins = probe.joins();
    drop(release);
    closing.join().unwrap();
    assert!(matches!(
        premature,
        Err(std::sync::mpsc::TryRecvError::Empty)
    ));
    assert!(busy);
    assert_eq!(joins, 0);
    assert!(rx.recv().unwrap());
    assert_eq!(probe.joins(), 1);
    assert_eq!(pool.used(), StoreLimits::default().working_bytes);
    clean(resume(&mut p, Default::default()));
}
#[test]
fn stale_ids_and_terminal_slots_are_bounded_until_explicit_discard() {
    let _disk = crate::synthetic_store::testing_lock();
    let mut p = profile(Default::default());
    let mut a = resume(&mut p, Default::default());
    a.open_pairing(1).unwrap();
    let (h, mut peer, _) = pair(&mut a, 1, 4, 1);
    let (_, c) = clock();
    let pool = a.global_pool().unwrap();
    let mut old = None;
    for n in 1..=40 {
        let w = request(&mut a, &h, &mut peer, n, 2).remove(0);
        let id = a.start_fixed(w, Outcome::Success, &c).unwrap();
        joined(&mut a, id, 2);
        if let Some(old) = old {
            assert!(a.observe_fixed(old).is_none());
            assert_eq!(a.cancel_fixed(old), Err(Fault::Stale));
        }
        a.discard_fixed(id, 2).unwrap();
        old = Some(id);
        assert!(pool.used() < StoreLimits::default().working_bytes + 64 * 1024);
    }
    clean(a);
    let b = resume(&mut p, Default::default());
    assert!(b.observe_fixed(old.unwrap()).is_none());
    clean(b);
}
#[test]
fn clock_regression_and_authority_poison_forbid_clean_and_drain() {
    let _disk = crate::synthetic_store::testing_lock();
    for poison in [false, true] {
        let mut p = profile(Default::default());
        let mut a = resume(&mut p, Default::default());
        a.open_pairing(1).unwrap();
        let (h, mut peer, _) = pair(&mut a, 1, 4, 1);
        let w = request(&mut a, &h, &mut peer, 1, 2).remove(0);
        let (_, c) = clock();
        let id = held(&mut a, w, &c, true);
        let probe = a.fixed_probe(id);
        if poison {
            let revocations = a.core.as_ref().unwrap().revocations.clone();
            let _ = std::panic::catch_unwind(|| {
                let _lock = revocations.write().unwrap();
                panic!("synthetic authority poison");
            });
        }
        assert!(a.poll_fixed(if poison { 2 } else { 1 }).is_err());
        assert!(probe.cancelled());
        let (fault, stopped) = a.close_for_restart().err().unwrap().into_parts();
        assert_eq!(fault, StoreFault::DirtyRun);
        assert_eq!(probe.joins(), 1);
        stopped.release();
    }
}

#[test]
fn post_spawn_preclaim_refusal_joins_guard_and_preserves_eligible_work() {
    let _disk = crate::synthetic_store::testing_lock();
    let mut p = profile(Default::default());
    let mut a = resume(&mut p, Default::default());
    a.open_pairing(1).unwrap();
    let (h, mut peer, _) = pair(&mut a, 1, 4, 1);
    let w = request(&mut a, &h, &mut peer, 1, 2).remove(0);
    let (_, c) = clock();
    let pool = a.global_pool().unwrap();
    let before = pool.used();
    assert_eq!(
        a.start_fixed_inner(
            w.clone(),
            Outcome::Success,
            &c,
            Hooks {
                refuse_after_spawn: true,
                ..Default::default()
            }
        ),
        Err(Fault::Spawn)
    );
    assert_eq!(a.fixed_failed_install_stats(), Some((0, 1)));
    assert_eq!(pool.used(), before);
    assert_eq!(w.status(), WorkStatus::InFlight);
    let id = a.start_fixed(w, Outcome::Success, &c).unwrap();
    joined(&mut a, id, 2);
    clean(a);
}
#[test]
fn old_observation_cannot_cancel_repaired_device_or_new_work() {
    let _disk = crate::synthetic_store::testing_lock();
    let mut p = profile(Default::default());
    let mut a = resume(&mut p, Default::default());
    a.open_pairing(1).unwrap();
    let (h, mut peer, key) = pair(&mut a, 1, 4, 1);
    let w = request(&mut a, &h, &mut peer, 1, 2).remove(0);
    let (m, c) = clock();
    let old = held(&mut a, w, &c, false);
    a.remove_device(&key, 3).unwrap();
    joined(&mut a, old, 3);
    a.discard_fixed(old, 3).unwrap();
    a.open_pairing(4).unwrap();
    let (fresh, mut peer, _) = pair(&mut a, 1, 4, 4);
    let w = request(&mut a, &fresh, &mut peer, 1, 4).remove(0);
    m.advance_to(4).unwrap();
    let id = held(&mut a, w.clone(), &c, false);
    assert_eq!(a.cancel_fixed(old), Err(Fault::Stale));
    assert_eq!(fresh.status(), CarrierStatus::Active);
    assert_eq!(w.status(), WorkStatus::InFlight);
    a.fixed_probe(id).finish();
    joined(&mut a, id, 4);
    assert_eq!(a.observe_fixed(id).unwrap().state, State::Ready);
    clean(a);
}
#[test]
fn expired_or_overflowing_clock_refuses_without_claim_or_worker() {
    let _disk = crate::synthetic_store::testing_lock();
    let mut p = profile(Default::default());
    let mut a = resume(&mut p, Default::default());
    a.open_pairing(1).unwrap();
    let (h, mut peer, _) = pair(&mut a, 1, 4, 1);
    let w = request(&mut a, &h, &mut peer, 1, 2).remove(0);
    let (m, c) = clock();
    let pool = a.global_pool().unwrap();
    let before = pool.used();
    m.advance_to(u64::MAX).unwrap();
    assert!(a.start_fixed(w.clone(), Outcome::Success, &c).is_err());
    assert_ne!(w.status(), WorkStatus::InFlight);
    assert!(pool.used() < before);
    clean(a);
}

#[test]
fn terminal_close_discovers_unpolled_panic_before_any_clean_write() {
    let _disk = crate::synthetic_store::testing_lock();
    let mut p = profile(Default::default());
    let mut a = resume(&mut p, Default::default());
    a.open_pairing(1).unwrap();
    let (h, mut peer, _) = pair(&mut a, 1, 4, 1);
    let w = request(&mut a, &h, &mut peer, 1, 2).remove(0);
    let (_, c) = clock();
    let id = a.start_fixed(w, Outcome::PanicAfterBegin, &c).unwrap();
    let probe = a.fixed_probe(id);
    until(|| a.fixed_thread_finished(id));
    assert_eq!(probe.joins(), 0);
    let revision = a.diagnostics().revision;
    let (fault, stopped) = a.close_for_restart().err().unwrap().into_parts();
    assert_eq!(fault, StoreFault::DirtyRun);
    assert_eq!(probe.joins(), 1);
    assert_eq!(stopped.diagnostics().revision, revision);
    assert!(matches!(p.acquire_writer(), Err(StoreFault::Busy)));
    stopped.release();
}

#[test]
fn preclaim_refusal_cannot_hide_a_prebegin_worker_panic() {
    let _disk = crate::synthetic_store::testing_lock();
    let mut p = profile(Default::default());
    let mut a = resume(&mut p, Default::default());
    a.open_pairing(1).unwrap();
    let (h, mut peer, _) = pair(&mut a, 1, 4, 1);
    let w = request(&mut a, &h, &mut peer, 1, 2).remove(0);
    let (_, c) = clock();
    assert_eq!(
        a.start_fixed_inner(
            w,
            Outcome::PanicBeforeBegin,
            &c,
            Hooks {
                refuse_after_spawn: true,
                ..Default::default()
            }
        ),
        Err(Fault::Worker)
    );
    assert_eq!(a.fixed_failed_install_stats(), Some((0, 1)));
    let (fault, stopped) = a.close_for_restart().err().unwrap().into_parts();
    assert_eq!(fault, StoreFault::DirtyRun);
    stopped.release();
}

#[test]
fn begin_at_deadline_cancels_installed_worker_without_invocation() {
    let _disk = crate::synthetic_store::testing_lock();
    let mut p = profile(Default::default());
    let mut a = resume(&mut p, Default::default());
    a.open_pairing(1).unwrap();
    let (h, mut peer, _) = pair(&mut a, 1, 4, 1);
    let w = request(&mut a, &h, &mut peer, 1, 2).remove(0);
    let (_, c) = clock();
    let id = held(&mut a, w, &c, true);
    let probe = a.fixed_probe(id);
    assert_eq!(a.fixed_test_begin(id, 340_002), Err(Fault::Expired));
    assert!(probe.cancelled());
    joined(&mut a, id, 340_002);
    assert_eq!(probe.calls(), 0);
    assert_eq!(
        a.observe_fixed(id).unwrap().execution,
        Execution::NotStarted
    );
    assert_eq!(a.observe_fixed(id).unwrap().state, State::TimedOut);
    clean(a);
}

#[test]
fn immediate_begin_failures_refund_slots_and_credits_before_returning_no_id() {
    use crate::policy::persistent::fixed_executor::BeforeBegin;
    let _disk = crate::synthetic_store::testing_lock();
    for failure in [BeforeBegin::Cancel, BeforeBegin::Deadline] {
        let mut p = profile(Default::default());
        let mut a = resume(
            &mut p,
            PersistentLimits {
                registry: registry::Limits {
                    idle_ms: 400_000,
                    ..Default::default()
                },
                ..Default::default()
            },
        );
        a.open_pairing(1).unwrap();
        let (h, mut peer, _) = pair(&mut a, 1, 4, 1);
        let (other, mut peer2, _) = pair(&mut a, 2, 5, 1);
        let (_, c) = clock();
        let pool = a.global_pool().unwrap();
        let baseline = pool.used();
        for n in 1..=6 {
            let w = request(&mut a, &h, &mut peer, n, c.now()).remove(0);
            a.fixed_before_begin(failure);
            let expected = if matches!(failure, BeforeBegin::Deadline) {
                Fault::Expired
            } else {
                Fault::Stale
            };
            assert_eq!(
                a.start_fixed(w.clone(), Outcome::Success, &c),
                Err(expected)
            );
            assert_eq!(a.fixed_occupied_slots(), 0, "failed Begin returned no Id");
            assert_eq!(a.fixed_failed_install_stats(), Some((0, 1)));
            assert_eq!(
                pool.used(),
                baseline,
                "all request, execution and metadata credits returned"
            );
            assert_eq!(
                w.status(),
                if matches!(failure, BeforeBegin::Deadline) {
                    WorkStatus::TimedOut
                } else {
                    WorkStatus::Cancelled
                }
            );
            assert!(a.start_fixed(w, Outcome::Success, &c).is_err()); // Never restored to Ready.
            assert!(!a
                .take_output(&h, c.now(), |_| panic!("failed Begin cannot emit"))
                .unwrap());
            let other_work = request(&mut a, &other, &mut peer2, n, c.now()).remove(0);
            a.finish_request(&other_work, b"null", c.now()).unwrap();
            assert!(a
                .take_output(&other, c.now(), |bytes| {
                    assert_eq!(peer2.open_encoded(bytes).unwrap(), b"null");
                    Ok(())
                })
                .unwrap());
            assert_eq!(other.status(), CarrierStatus::Active);
            assert_eq!(pool.used(), baseline);
        }
        // Both slots remain admissible after more than two failed starts.
        let w1 = request(&mut a, &h, &mut peer, 7, c.now()).remove(0);
        let w2 = request(&mut a, &other, &mut peer2, 7, c.now()).remove(0);
        let first = a.start_fixed(w1, Outcome::Success, &c).unwrap();
        let second = a.start_fixed(w2, Outcome::Success, &c).unwrap();
        assert_eq!(a.fixed_occupied_slots(), 2);
        for id in [first, second] {
            if !a.observe_fixed(id).unwrap().joined {
                joined(&mut a, id, c.now());
            }
            a.discard_fixed(id, c.now()).unwrap();
        }
        assert_eq!(pool.used(), baseline);
        clean(a);
    }
}

#[test]
fn immediate_begin_idle_refusal_joins_and_removes_its_unobservable_slot() {
    use crate::policy::persistent::fixed_executor::BeforeBegin;
    let _disk = crate::synthetic_store::testing_lock();
    let mut p = profile(Default::default());
    let mut a = resume(&mut p, Default::default());
    a.open_pairing(1).unwrap();
    let (h, mut peer, _) = pair(&mut a, 1, 4, 1);
    let w = request(&mut a, &h, &mut peer, 1, 2).remove(0);
    let (_, c) = clock();
    let pool = a.global_pool().unwrap();
    a.fixed_before_begin(BeforeBegin::Idle);
    assert_eq!(
        a.start_fixed(w.clone(), Outcome::Success, &c),
        Err(Fault::Stale)
    );
    assert_eq!(a.fixed_occupied_slots(), 0);
    assert_eq!(a.fixed_failed_install_stats(), Some((0, 1)));
    assert_eq!(h.status(), CarrierStatus::Closed(CloseReason::IdleTimeout));
    assert_eq!(w.status(), WorkStatus::Cancelled);
    assert_eq!(pool.used(), StoreLimits::default().working_bytes);
    clean(a);
}

#[test]
fn immediate_begin_refusal_preserves_poison_and_panic_abort_after_refunding_slot() {
    use crate::policy::persistent::fixed_executor::BeforeBegin;
    let _disk = crate::synthetic_store::testing_lock();
    for poison in [false, true] {
        let mut p = profile(Default::default());
        let mut a = resume(&mut p, Default::default());
        a.open_pairing(1).unwrap();
        let (h, mut peer, _) = pair(&mut a, 1, 4, 1);
        let w = request(&mut a, &h, &mut peer, 1, 2).remove(0);
        let (_, c) = clock();
        let pool = a.global_pool().unwrap();
        a.fixed_before_begin(if poison {
            BeforeBegin::Poison
        } else {
            BeforeBegin::Deadline
        });
        assert_eq!(
            a.start_fixed(
                w.clone(),
                if poison {
                    Outcome::Success
                } else {
                    Outcome::PanicBeforeBegin
                },
                &c
            ),
            Err(Fault::Worker)
        );
        assert_eq!(a.fixed_occupied_slots(), 0);
        assert_eq!(a.fixed_failed_install_stats(), Some((0, 1)));
        assert_eq!(pool.used(), StoreLimits::default().working_bytes);
        assert_eq!(w.status(), WorkStatus::Cancelled);
        assert!(a.start_fixed(w, Outcome::Success, &c).is_err());
        let revision = a.diagnostics().revision;
        let (fault, stopped) = a.close_for_restart().err().unwrap().into_parts();
        assert_eq!(fault, StoreFault::DirtyRun);
        assert_eq!(stopped.diagnostics().revision, revision);
        assert!(matches!(p.acquire_writer(), Err(StoreFault::Busy)));
        stopped.release();
    }
}

#[test]
fn failed_immediate_begin_does_not_cancel_or_join_another_owned_slot() {
    use crate::policy::persistent::fixed_executor::BeforeBegin;
    let _disk = crate::synthetic_store::testing_lock();
    let mut p = profile(Default::default());
    let mut a = resume(&mut p, Default::default());
    a.open_pairing(1).unwrap();
    let (h, mut peer, _) = pair(&mut a, 1, 4, 1);
    let (other, mut peer2, _) = pair(&mut a, 2, 5, 1);
    let (_, c) = clock();
    let other_work = request(&mut a, &other, &mut peer2, 1, 2).remove(0);
    let running = held(&mut a, other_work.clone(), &c, false);
    let probe = a.fixed_probe(running);
    until(|| probe.calls() == 1);
    let pool = a.global_pool().unwrap();
    let baseline = pool.used();
    for n in 1..=6 {
        let w = request(&mut a, &h, &mut peer, n, 2).remove(0);
        a.fixed_before_begin(BeforeBegin::Cancel);
        assert_eq!(
            a.start_fixed(w.clone(), Outcome::Success, &c),
            Err(Fault::Stale)
        );
        assert_eq!(a.fixed_occupied_slots(), 1);
        assert_eq!(a.fixed_failed_install_stats(), Some((0, 1)));
        assert_eq!(pool.used(), baseline);
        assert_eq!(w.status(), WorkStatus::Cancelled);
        assert_eq!(other_work.status(), WorkStatus::InFlight);
        assert!(!probe.cancelled());
        assert_eq!(probe.joins(), 0);
    }
    probe.finish();
    joined(&mut a, running, 2);
    assert_eq!(a.observe_fixed(running).unwrap().status, Some(200));
    clean(a);
}

#[test]
fn tracked_preflight_is_atomic_and_fences_every_competing_producer() {
    use crate::supervisor::MemoryCarrier;
    let _disk = crate::synthetic_store::testing_lock();
    let mut p = profile(Default::default());
    let mut a = resume(&mut p, Default::default());
    a.open_pairing(1).unwrap();
    let (h, mut peer, _) = pair(&mut a, 1, 4, 1);
    let work = request(&mut a, &h, &mut peer, 1, 2).remove(0);
    let sibling = request(&mut a, &h, &mut peer, 2, 2).remove(0);
    let budget = a
        .registry
        .as_mut()
        .unwrap()
        .inspect_claim(&work, 2)
        .unwrap();
    let baseline = budget.used();
    let memory = MemoryCarrier::new();
    let pressure = budget
        .reserve(64 * 1024 * 1024 - baseline - 4096 + 1)
        .unwrap();
    assert_eq!(
        a.register_fixed_carrier(&h, memory.clone(), Default::default()),
        Err(Fault::Full)
    );
    assert_eq!(budget.used(), 64 * 1024 * 1024 - 4096 + 1);
    drop(pressure);
    let target = a
        .register_fixed_carrier(&h, memory.clone(), Default::default())
        .unwrap();
    assert_eq!(budget.used(), baseline + 4096);
    let (_, c) = clock();
    let pressure = budget
        .reserve(64 * 1024 * 1024 - budget.used() - 2_172_416 + 1)
        .unwrap();
    assert_eq!(
        a.start_fixed_tracked(work.clone(), target, Outcome::Success, &c),
        Err(Fault::Full)
    );
    assert_eq!(a.fixed_occupied_slots(), 0);
    assert_eq!(work.status(), WorkStatus::InFlight);
    drop(pressure);
    let pressure = budget
        .reserve(64 * 1024 * 1024 - budget.used() - 2_172_416)
        .unwrap();
    let id = a
        .start_fixed_tracked(work.clone(), target, Outcome::Success, &c)
        .unwrap();
    assert_eq!(budget.used(), 64 * 1024 * 1024);
    let is_budget = |r: registry::Result<()>| {
        assert!(matches!(
            r,
            Err(registry::RegistryError::Protocol(crate::Error::Budget))
        ))
    };
    is_budget(a.registry.as_mut().unwrap().send_encoded(&h, b"null", 2));
    is_budget(a.registry.as_mut().unwrap().send_peer(&h, "null", 2));
    assert!(a
        .take_output(&h, 2, |_| panic!("fence exported output"))
        .is_err());
    assert!(a.finish_request(&sibling, b"null", 2).is_err());
    let http =
        crate::http_dispatch::MemoryHttp::new(crate::http_dispatch::Outcome::Unavailable).unwrap();
    assert!(a.dispatch_synthetic(&sibling, &http, 2).is_err());
    assert_eq!(http.calls(), 0);
    assert_eq!(sibling.status(), WorkStatus::InFlight);
    assert!(memory.receive().is_none());
    assert_eq!(memory.delivery_attempts(), 0);
    assert_eq!(h.status(), CarrierStatus::Active);
    joined(&mut a, id, 2);
    a.discard_fixed(id, 2).unwrap();
    drop(pressure);
    a.registry
        .as_mut()
        .unwrap()
        .send_encoded(&h, b"null", 2)
        .unwrap();
    a.take_output(&h, 2, |b| {
        assert_eq!(peer.open_encoded(b).unwrap(), b"null");
        Ok(())
    })
    .unwrap();
    a.disconnect(&h);
    assert!(memory.is_closed());
    clean(a);
}

#[test]
fn tracked_registration_identity_and_capacity_refusals_leave_mailbox_fresh() {
    use crate::supervisor::{Limits as MailboxLimits, MemoryCarrier};
    let _disk = crate::synthetic_store::testing_lock();
    let mut p = profile(Default::default());
    let mut a = resume(&mut p, Default::default());
    a.open_pairing(1).unwrap();
    let (h, mut peer, _) = pair(&mut a, 1, 4, 1);
    let (other, mut peer2, _) = pair(&mut a, 2, 5, 1);
    let memory = MemoryCarrier::new();
    for limits in [
        MailboxLimits {
            carrier_bytes: 1023,
            ..Default::default()
        },
        MailboxLimits {
            carrier_frames: 0,
            ..Default::default()
        },
    ] {
        assert_eq!(
            a.register_fixed_carrier(&h, memory.clone(), limits),
            Err(Fault::Full)
        );
        assert!(!memory.is_closed());
    }
    let target = a
        .register_fixed_carrier(
            &h,
            memory.clone(),
            MailboxLimits {
                carrier_bytes: 1024,
                carrier_frames: 1,
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(
        a.register_fixed_carrier(&other, memory.clone(), Default::default()),
        Err(Fault::Stale)
    );
    let (_, c) = clock();
    let wrong = request(&mut a, &other, &mut peer2, 1, 2).remove(0);
    assert_eq!(
        a.start_fixed_tracked(wrong, target, Outcome::Success, &c),
        Err(Fault::Stale)
    );
    let work = request(&mut a, &h, &mut peer, 1, 2).remove(0);
    a.registry
        .as_mut()
        .unwrap()
        .send_encoded(&h, b"null", 2)
        .unwrap();
    assert_eq!(
        a.start_fixed_tracked(work.clone(), target, Outcome::Success, &c),
        Err(Fault::Full)
    );
    a.take_output(&h, 2, |b| {
        peer.open_encoded(b)?;
        Ok(())
    })
    .unwrap();
    let id = a
        .start_fixed_tracked(work, target, Outcome::Success, &c)
        .unwrap();
    joined(&mut a, id, 2);
    a.discard_fixed(id, 2).unwrap();
    clean(a);
    assert!(memory.is_closed());
}

#[test]
fn inactive_rolled_back_fence_cannot_authorize_retry_with_same_serial() {
    use crate::tracked_output::{Grant, TargetId};
    let _disk = crate::synthetic_store::testing_lock();
    let mut p = profile(Default::default());
    let mut a = resume(&mut p, Default::default());
    a.open_pairing(1).unwrap();
    let (h, mut peer, _) = pair(&mut a, 1, 4, 1);
    let work = request(&mut a, &h, &mut peer, 1, 2).remove(0);
    let target = TargetId {
        authority: a.core.as_ref().unwrap().instance,
        serial: 1,
    };
    let rolled_back = Grant::new(target, 1);
    let stale = rolled_back.0.clone();
    a.registry
        .as_mut()
        .unwrap()
        .reserve_fixed_output(&work, stale.clone(), 2)
        .unwrap();
    drop(rolled_back);
    let retry = Grant::new(target, 1);
    a.registry
        .as_mut()
        .unwrap()
        .reserve_fixed_output(&work, retry.0.clone(), 2)
        .unwrap();
    assert!(a
        .registry
        .as_mut()
        .unwrap()
        .claim_fixed_work(&work, 2, Some(&stale))
        .is_err());
    assert_eq!(work.status(), WorkStatus::InFlight);
    let permit = a
        .registry
        .as_mut()
        .unwrap()
        .claim_fixed_work(&work, 2, Some(&retry.0))
        .unwrap();
    a.registry
        .as_mut()
        .unwrap()
        .end_claim(&permit, WorkStatus::Cancelled, 2);
    assert!(retry.0.active());
    assert_eq!(h.status(), CarrierStatus::Active);
    drop(retry);
    clean(a);
}

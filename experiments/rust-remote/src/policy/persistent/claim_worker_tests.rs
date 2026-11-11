use super::*;
use crate::policy::persistent::claim_worker::{
    Claim, Delivery, Execution, Fault, Outcome, Phase, Prepared,
};
use crate::supervisor::{Clock, ManualClock};
fn clock() -> (ManualClock, Clock) {
    let manual = ManualClock::default();
    manual.advance_to(2).unwrap();
    (manual.clone(), Clock::Manual(manual))
}
fn with_claim<'a, T>(
    a: &'a mut PersistentAuthority,
    token: WorkToken,
    clock: Clock,
    outcome: Outcome,
    action: impl for<'scope> FnOnce(&'scope mut Claim<'a>) -> T,
) -> T {
    Prepared::new(a, token, clock)
        .unwrap()
        .with_claim(outcome, action)
        .unwrap_or_else(|e| panic!("start: {:?}", e.fault))
}
fn finish_worker(claim: &mut Claim<'_>) {
    claim.begin().unwrap();
    claim.wait_worker_for_test(false);
    claim.finish_fixture();
    claim.wait_worker_for_test(true);
    claim.collect().unwrap();
}
#[test]
fn joined_fixed_responses_keep_200_502_504_and_transfer_prepaid_ciphertext() {
    let _disk = crate::synthetic_store::testing_lock();
    for (outcome, status) in [
        (Outcome::Success, 200),
        (Outcome::Unavailable, 502),
        (Outcome::Timeout, 504),
    ] {
        let mut p = profile(StoreLimits::default());
        let mut a = resume(&mut p, Default::default());
        a.open_pairing(1).unwrap();
        let (h, mut channel, _) = pair(&mut a, 1, 4, 1);
        let work = request(&mut a, &h, &mut channel, 1, 2).remove(0);
        let pool = a.global_pool().unwrap();
        let baseline = pool.used();
        let (_, clock) = clock();
        with_claim(&mut a, work.clone(), clock, outcome, |claim| {
            finish_worker(claim);
            assert_eq!(claim.invocations(), 1);
            assert_eq!(claim.observe().status, Some(status));
            let pressure = pool.connection(256 * 1024 * 1024).unwrap();
            let full = pressure.reserve(256 * 1024 * 1024 - pool.used()).unwrap();
            claim.may_send().unwrap();
            assert_eq!(claim.observe().delivery, Delivery::MaySend);
            assert!(!claim.cleanup_complete());
            let retained = pool.used();
            {
                let output = claim.receive().unwrap();
                let plain = channel.open_encoded(output.bytes().unwrap()).unwrap();
                let value: serde_json::Value = serde_json::from_slice(&plain).unwrap();
                assert_eq!(value["status"], status);
                assert_eq!(value["id"], 1);
                assert_eq!(pool.used(), retained); // Loan keeps its ciphertext charge.
            }
            assert!(claim.cleanup_complete());
            assert_eq!(claim.observe().status, Some(status));
            assert_eq!(claim.observe().delivery, Delivery::Returned);
            assert_eq!(claim.observe().phase, Phase::Completed);
            assert_eq!(work.status(), WorkStatus::Completed);
            assert!(pool.used() < retained);
            drop(full);
        });
        assert!(pool.used() <= baseline);
        assert!(Prepared::new(&mut a, work, Clock::monotonic()).is_err());
        clean(a);
        assert_eq!(pool.used(), StoreLimits::default().working_bytes);
    }
}
#[test]
fn full_preserves_original_prepared_work_and_lease_for_retry() {
    let _disk = crate::synthetic_store::testing_lock();
    let mut p = profile(StoreLimits::default());
    let mut a = resume(&mut p, Default::default());
    a.open_pairing(1).unwrap();
    let (h, mut channel, _) = pair(&mut a, 1, 4, 1);
    let token = request(&mut a, &h, &mut channel, 1, 2).remove(0);
    let budget = a
        .registry
        .as_mut()
        .unwrap()
        .inspect_claim(&token, 2)
        .unwrap();
    let (_, clock) = clock();
    let prepared = Prepared::new(&mut a, token.clone(), clock).unwrap();
    let needed = prepared.required_bytes();
    let occupied = budget
        .reserve(64 * 1024 * 1024 - budget.used() - needed + 1)
        .unwrap();
    let rejected = match prepared.with_claim(Outcome::Success, |_| panic!("must refuse")) {
        Err(e) => e,
        _ => panic!("Full"),
    };
    assert_eq!(rejected.fault, Fault::Full);
    assert_eq!(token.status(), WorkStatus::InFlight);
    drop(occupied);
    let exact = budget
        .reserve(64 * 1024 * 1024 - budget.used() - needed)
        .unwrap();
    rejected
        .permit
        .with_claim(Outcome::Success, |claim| {
            finish_worker(claim);
            assert_eq!(claim.invocations(), 1);
        })
        .unwrap_or_else(|_| panic!("original retry"));
    assert_eq!(token.status(), WorkStatus::Cancelled);
    drop(exact);
    clean(a);
}
#[test]
fn registry_claim_excludes_drain_finish_and_duplicate_dispatch() {
    let _disk = crate::synthetic_store::testing_lock();
    let mut p = profile(StoreLimits::default());
    let mut a = resume(&mut p, Default::default());
    a.open_pairing(1).unwrap();
    let (h, mut channel, _) = pair(&mut a, 1, 4, 1);
    let token = request(&mut a, &h, &mut channel, 1, 2).remove(0);
    let permit = a.registry.as_mut().unwrap().claim_work(&token, 2).unwrap();
    assert!(a.drain_work(None, 64, 2).unwrap().tokens.is_empty());
    assert!(a.registry.as_mut().unwrap().claim_work(&token, 2).is_err());
    assert!(a.finish_request(&token, b"{}", 2).is_err());
    let http =
        crate::http_dispatch::MemoryHttp::new(crate::http_dispatch::Outcome::Timeout).unwrap();
    assert!(a.dispatch_synthetic(&token, &http, 2).is_err());
    assert_eq!(http.calls(), 0);
    a.registry
        .as_mut()
        .unwrap()
        .end_claim(&permit, WorkStatus::Cancelled, 2);
    assert_eq!(token.status(), WorkStatus::Cancelled);
    clean(a);
}
#[test]
fn revocation_before_begin_and_after_begin_before_output_cannot_resurrect() {
    let _disk = crate::synthetic_store::testing_lock();
    for began in [false, true] {
        let mut p = profile(StoreLimits::default());
        let mut a = resume(&mut p, Default::default());
        a.open_pairing(1).unwrap();
        let (h, mut channel, key) = pair(&mut a, 1, 4, 1);
        let token = request(&mut a, &h, &mut channel, 1, 2).remove(0);
        let (_, clock) = clock();
        with_claim(&mut a, token.clone(), clock, Outcome::Success, |claim| {
            if began {
                claim.begin().unwrap();
                claim.wait_worker_for_test(false);
            }
            claim.remove_device(&key).unwrap();
            assert!(claim.begin().is_err());
            claim.finish_fixture();
            assert!(claim.collect().is_err());
            assert!(claim.may_send().is_err());
            assert_eq!(claim.invocations(), usize::from(began));
            assert_eq!(
                claim.observe().execution,
                if began {
                    Execution::MayHaveRun
                } else {
                    Execution::NotStarted
                }
            );
            assert_eq!(claim.observe().delivery, Delivery::None);
        }); // Joins the cancelled worker before authority can be closed.
        assert_eq!(token.status(), WorkStatus::Cancelled);
        a.open_pairing(3).unwrap();
        let (fresh, _, _) = pair(&mut a, 2, 4, 3);
        assert_eq!(fresh.status(), CarrierStatus::Active);
        clean(a);
    }
}
#[test]
fn removal_after_may_send_is_unknown_and_releases_owned_output() {
    let _disk = crate::synthetic_store::testing_lock();
    let mut p = profile(StoreLimits::default());
    let mut a = resume(&mut p, Default::default());
    a.open_pairing(1).unwrap();
    let (h, mut channel, key) = pair(&mut a, 1, 4, 1);
    let token = request(&mut a, &h, &mut channel, 1, 2).remove(0);
    let (_, clock) = clock();
    with_claim(&mut a, token, clock, Outcome::Unavailable, |claim| {
        finish_worker(claim);
        claim.may_send().unwrap();
        claim.remove_device(&key).unwrap();
        assert_eq!(claim.observe().delivery, Delivery::Unknown);
        assert_eq!(claim.observe().status, Some(502));
        assert!(claim.receive().is_err());
        assert!(claim.cleanup_complete());
        assert_eq!(claim.invocations(), 1);
    });
    clean(a);
}
#[test]
fn worker_panic_is_joined_and_marks_retained_authority_dirty() {
    let _disk = crate::synthetic_store::testing_lock();
    let mut p = profile(StoreLimits::default());
    let mut a = resume(&mut p, Default::default());
    a.open_pairing(1).unwrap();
    let (h, mut channel, _) = pair(&mut a, 1, 4, 1);
    let token = request(&mut a, &h, &mut channel, 1, 2).remove(0);
    let (_, clock) = clock();
    with_claim(&mut a, token, clock, Outcome::Panic, |claim| {
        claim.begin().unwrap();
        claim.wait_worker_for_test(false);
        claim.finish_fixture();
        claim.wait_worker_for_test(true);
        assert_eq!(claim.collect(), Err(Fault::Worker));
        assert_eq!(claim.observe().phase, Phase::Failed);
    });
    let (fault, stopped) = a.close_for_restart().err().unwrap().into_parts();
    assert_eq!(fault, StoreFault::DirtyRun);
    assert!(matches!(p.acquire_writer(), Err(StoreFault::Busy)));
    stopped.release();
}
#[test]
fn actual_timeout_margin_and_expiry_after_may_send_preserve_delivery_evidence() {
    let _disk = crate::synthetic_store::testing_lock();
    for delivered in [false, true] {
        let mut p = profile(StoreLimits::default());
        let mut a = resume(&mut p, Default::default());
        a.open_pairing(1).unwrap();
        let (h, mut channel, _) = pair(&mut a, 1, 4, 1);
        let token = request(&mut a, &h, &mut channel, 1, 2).remove(0);
        let (manual, clock) = clock();
        with_claim(&mut a, token, clock, Outcome::Success, |claim| {
            claim.begin().unwrap();
            claim.wait_worker_for_test(false);
            for n in 1..=8 {
                manual.advance_to(2 + n * 40_000).unwrap();
                let parts = crate::phone::request_parts(&crate::phone::Request {
                    id: n as i64 + 1,
                    method: crate::phone::Method::GET,
                    path: "/rpc".into(),
                    headers: crate::phone::Headers::new(),
                    body: Vec::new(),
                })
                .unwrap();
                claim
                    .keepalive(&channel.seal_encoded(&parts[0]).unwrap())
                    .unwrap();
            }
            manual.advance_to(340_002).unwrap();
            claim.maintain().unwrap();
            assert_eq!(claim.observe().status, Some(504));
            claim.may_send().unwrap();
            if delivered {
                let output = claim.receive().unwrap();
                let bytes = channel.open_encoded(output.bytes().unwrap()).unwrap();
                let response: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(response["status"], 504);
                drop(output);
                assert_eq!(claim.observe().delivery, Delivery::Returned);
                assert_eq!(claim.observe().status, Some(504));
            } else {
                manual.advance_to(345_002).unwrap();
                assert_eq!(claim.maintain(), Err(Fault::Expired));
                assert_eq!(claim.observe().phase, Phase::TimedOut);
                assert_eq!(claim.observe().delivery, Delivery::Unknown);
                assert!(claim.receive().is_err());
            }
        });
        clean(a);
    }
}

#[test]
fn held_output_loan_expiry_is_unknown_and_releases_credit_only_on_drop() {
    let _disk = crate::synthetic_store::testing_lock();
    let mut p = profile(StoreLimits::default());
    let mut a = resume(&mut p, Default::default());
    a.open_pairing(1).unwrap();
    let (h, mut channel, _) = pair(&mut a, 1, 4, 1);
    let work = request(&mut a, &h, &mut channel, 1, 2).remove(0);
    let pool = a.global_pool().unwrap();
    let (manual, clock) = clock();
    with_claim(&mut a, work, clock, Outcome::Success, |claim| {
        finish_worker(claim);
        claim.may_send().unwrap();
        let output = claim.receive().unwrap();
        let charged = pool.used();
        manual.advance_to(345_002).unwrap();
        assert_eq!(output.bytes().err(), Some(Fault::Expired));
        assert_eq!(pool.used(), charged);
        drop(output);
        assert!(pool.used() < charged);
        assert_eq!(claim.observe().delivery, Delivery::Unknown);
        assert_eq!(claim.observe().status, Some(200));
        assert!(claim.cleanup_complete());
    });
    clean(a);
}
#[test]
fn dropping_a_blocked_or_started_claim_joins_without_completion_or_force_path() {
    let _disk = crate::synthetic_store::testing_lock();
    for began in [false, true] {
        let mut p = profile(StoreLimits::default());
        let mut a = resume(&mut p, Default::default());
        a.open_pairing(1).unwrap();
        let (h, mut channel, _) = pair(&mut a, 1, 4, 1);
        let work = request(&mut a, &h, &mut channel, 1, 2).remove(0);
        let pool = a.global_pool().unwrap();
        let baseline = pool.used();
        let (_, clock) = clock();
        with_claim(&mut a, work.clone(), clock, Outcome::Success, |claim| {
            if began {
                claim.begin().unwrap();
                claim.wait_worker_for_test(false);
                assert_eq!(claim.collect(), Err(Fault::Full)); // Collect never waits on an unfinished fixture.
            }
        });
        assert_eq!(work.status(), WorkStatus::Cancelled);
        assert!(pool.used() < baseline);
        clean(a);
        assert_eq!(pool.used(), StoreLimits::default().working_bytes);
    }
}

#[test]
fn held_loan_respects_registry_idle_expiry_without_caller_tick() {
    let _disk = crate::synthetic_store::testing_lock();
    let mut p = profile(StoreLimits::default());
    let mut a = resume(&mut p, Default::default());
    a.open_pairing(1).unwrap();
    let (h, mut channel, _) = pair(&mut a, 1, 4, 1);
    let work = request(&mut a, &h, &mut channel, 1, 2).remove(0);
    let (manual, clock) = clock();
    with_claim(&mut a, work, clock, Outcome::Success, |claim| {
        finish_worker(claim);
        claim.may_send().unwrap();
        let output = claim.receive().unwrap();
        manual.advance_to(45_002).unwrap();
        assert_eq!(output.bytes().err(), Some(Fault::Stale));
        drop(output);
        assert_eq!(claim.observe().delivery, Delivery::Unknown);
        assert!(claim.cleanup_complete());
    });
    clean(a);
}

#[test]
#[allow(forgetting_references)] // Regression: forgetting a reborrow must not forget its owner.
fn scoped_callback_forget_cannot_bypass_join_or_output_cleanup() {
    use std::sync::atomic::Ordering;
    let _disk = crate::synthetic_store::testing_lock();
    for stage in 0..4 {
        let mut p = profile(StoreLimits::default());
        let mut a = resume(&mut p, Default::default());
        a.open_pairing(1).unwrap();
        let (h, mut channel, _) = pair(&mut a, 1, 4, 1);
        let work = request(&mut a, &h, &mut channel, 1, 2).remove(0);
        let pool = a.global_pool().unwrap();
        let baseline = pool.used();
        let (_, clock) = clock();
        let joined = with_claim(&mut a, work.clone(), clock, Outcome::Success, |claim| {
            let joined = claim.joined_probe_for_test();
            if stage == 1 {
                claim.begin().unwrap();
                claim.wait_worker_for_test(false);
            }
            if stage >= 2 {
                finish_worker(claim);
                claim.may_send().unwrap();
            }
            if stage == 3 {
                std::mem::forget(claim.receive().unwrap());
            } else {
                std::mem::forget(claim);
            }
            joined
        });
        assert!(joined.load(Ordering::SeqCst)); // Actual JoinHandle::join returned.
        assert!(pool.used() < baseline);
        assert_eq!(work.status(), WorkStatus::Cancelled);
        clean(a); // Can only reach terminal persistence after the owning scope drained.
        assert_eq!(pool.used(), StoreLimits::default().working_bytes);
    }
}
#[test]
fn callback_unwind_through_output_loan_joins_before_authority_close() {
    use std::{
        panic::{catch_unwind, AssertUnwindSafe},
        sync::atomic::Ordering,
    };
    let _disk = crate::synthetic_store::testing_lock();
    let mut p = profile(StoreLimits::default());
    let mut a = resume(&mut p, Default::default());
    a.open_pairing(1).unwrap();
    let (h, mut channel, _) = pair(&mut a, 1, 4, 1);
    let work = request(&mut a, &h, &mut channel, 1, 2).remove(0);
    let pool = a.global_pool().unwrap();
    let baseline = pool.used();
    let (_, clock) = clock();
    let mut joined = None;
    let unwind = catch_unwind(AssertUnwindSafe(|| {
        with_claim(&mut a, work, clock, Outcome::Success, |claim| {
            joined = Some(claim.joined_probe_for_test());
            finish_worker(claim);
            claim.may_send().unwrap();
            let output = claim.receive().unwrap();
            assert!(!output.bytes().unwrap().is_empty());
            panic!("synthetic callback unwind");
        });
    }));
    assert!(unwind.is_err());
    assert!(joined.unwrap().load(Ordering::SeqCst));
    assert!(pool.used() < baseline);
    clean(a);
}
#[test]
fn worker_panic_retains_execution_charge_until_actual_join() {
    use std::sync::atomic::Ordering;
    let _disk = crate::synthetic_store::testing_lock();
    let mut p = profile(StoreLimits::default());
    let mut a = resume(&mut p, Default::default());
    a.open_pairing(1).unwrap();
    let (h, mut channel, _) = pair(&mut a, 1, 4, 1);
    let work = request(&mut a, &h, &mut channel, 1, 2).remove(0);
    let pool = a.global_pool().unwrap();
    let (_, clock) = clock();
    with_claim(&mut a, work, clock, Outcome::Panic, |claim| {
        let charged = pool.used();
        let joined = claim.joined_probe_for_test();
        claim.begin().unwrap();
        claim.wait_worker_for_test(false);
        claim.finish_fixture();
        claim.wait_worker_for_test(true);
        assert!(!joined.load(Ordering::SeqCst));
        assert_eq!(pool.used(), charged);
        assert_eq!(claim.collect(), Err(Fault::Worker));
        assert!(joined.load(Ordering::SeqCst));
        assert!(pool.used() < charged);
    });
    let (_, stopped) = a.close_for_restart().err().unwrap().into_parts();
    assert!(matches!(p.acquire_writer(), Err(StoreFault::Busy)));
    stopped.release();
}

#[test]
fn unread_loan_is_discarded_but_never_makes_an_executed_request_replayable() {
    let _disk = crate::synthetic_store::testing_lock();
    let mut p = profile(StoreLimits::default());
    let mut a = resume(&mut p, Default::default());
    a.open_pairing(1).unwrap();
    let (h, mut channel, _) = pair(&mut a, 1, 4, 1);
    let work = request(&mut a, &h, &mut channel, 1, 2).remove(0);
    let (_, clock) = clock();
    with_claim(&mut a, work.clone(), clock, Outcome::Success, |claim| {
        finish_worker(claim);
        claim.may_send().unwrap();
        assert!(!claim.packet_receipt_for_test());
        drop(claim.receive().unwrap()); // Intentionally never calls bytes().
        assert!(claim.packet_receipt_for_test());
        assert!(claim.cleanup_complete());
        assert_eq!(claim.observe().delivery, Delivery::Discarded);
        assert_eq!(claim.observe().phase, Phase::Discarded);
        assert_eq!(claim.observe().execution, Execution::MayHaveRun);
        assert_eq!(claim.observe().status, Some(200));
        assert!(claim.may_send().is_err());
    });
    assert_eq!(work.status(), WorkStatus::Cancelled);
    let (_, clock) = crate::policy::persistent::tests::claim_worker_tests::clock();
    assert!(Prepared::new(&mut a, work, clock).is_err());
    clean(a);
}
#[test]
fn unused_prepaid_credit_is_released_without_inventing_a_packet_receipt() {
    let _disk = crate::synthetic_store::testing_lock();
    let mut p = profile(StoreLimits::default());
    let mut a = resume(&mut p, Default::default());
    a.open_pairing(1).unwrap();
    let (h, mut channel, _) = pair(&mut a, 1, 4, 1);
    let work = request(&mut a, &h, &mut channel, 1, 2).remove(0);
    let pool = a.global_pool().unwrap();
    let (_, clock) = clock();
    with_claim(&mut a, work, clock, Outcome::Success, |claim| {
        finish_worker(claim);
        let retained = pool.used();
        assert!(!claim.packet_receipt_for_test());
        claim.cancel();
        assert!(pool.used() < retained);
        assert!(claim.cleanup_complete());
        assert!(!claim.packet_receipt_for_test());
        assert_eq!(claim.observe().delivery, Delivery::None);
    });
    clean(a);
}

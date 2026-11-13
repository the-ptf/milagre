use super::*;
use crate::{
    policy::persistent::composition::{CarrierDecision, CarrierTicket, Phase},
    supervisor::{Limits as MailboxLimits, MemoryCarrier},
};

fn bound_hello(
    a: &mut PersistentAuthority,
    id: u64,
    seed: u8,
    desktop: bool,
    now: u64,
) -> (Handle, CarrierTicket, PendingHello) {
    let token = a.with_pairing_invitation(now, str::to_owned).unwrap();
    let (bytes, pending) = channel::phone_hello(
        &SecretKey::from([seed; 32]),
        &a.host_public_key(),
        &token,
        HelloOptions {
            kind: desktop.then_some(DeviceKind::Desktop),
            ..Default::default()
        },
        &mut OsRng,
    )
    .unwrap();
    let h = a.open_carrier(id, now).unwrap();
    let t = a
        .begin_for_carrier(&h, Source::Relay, &bytes, now, &mut OsRng)
        .unwrap();
    (h, t, pending)
}
fn flush(a: &mut PersistentAuthority, h: &Handle, m: &MemoryCarrier, now: u64) {
    assert!(a
        .take_output_owned(h, now, |bytes, lease| m.deliver(
            bytes,
            lease,
            MailboxLimits::default()
        ))
        .unwrap());
}
#[test]
fn healthy_quiescence_revokes_work_and_access_but_only_explicit_close_commits_clean() {
    let _disk_test = crate::synthetic_store::testing_lock();
    let mut p = profile(StoreLimits::default());
    let mut a = resume(
        &mut p,
        PersistentLimits {
            registry: registry::Limits {
                inflight: 1,
                ..Default::default()
            },
            ..Default::default()
        },
    );
    a.open_pairing(1).unwrap();
    let (h, t, pending) = bound_hello(&mut a, 1, 4, false, 1);
    let access = a
        .complete_for_carrier(t, CarrierDecision::PhoneOrKnown, || 1)
        .unwrap();
    let m = MemoryCarrier::new();
    m.bind().unwrap();
    m.bind_access(access.clone()).unwrap();
    flush(&mut a, &h, &m, 1);
    let mut c = pending.finish(&m.receive().unwrap()).unwrap();
    let inflight = request(&mut a, &h, &mut c, 1, 2).remove(0);
    assert!(request(&mut a, &h, &mut c, 2, 2).is_empty());
    let queued = a.registry.as_mut().unwrap().work_token(&h, 2).unwrap();
    a.enable_desktop().unwrap();
    let (_, ticket, _) = bound_hello(&mut a, 2, 5, true, 2);
    a.prepare_pending_approval(&ticket, 2).unwrap();
    a.send_for_carrier(&h, b"{}", 2).unwrap();
    flush(&mut a, &h, &m, 2);
    let pool = a.global_pool().unwrap();
    let revision = a.diagnostics().revision;
    a.quiesce_for_join().unwrap();
    a.quiesce_for_join().unwrap();
    assert_eq!(a.phase, Phase::Quiesced);
    assert_eq!(a.diagnostics().revision, revision);
    assert!(matches!(p.acquire_writer(), Err(StoreFault::Busy)));
    assert_eq!(inflight.status(), WorkStatus::Cancelled);
    assert_eq!(queued.status(), WorkStatus::Cancelled);
    assert!(access.with(|| Ok(())).is_err());
    assert!(m.receive().is_none());
    assert!(a.tick(3).is_err());
    assert!(a.open_pairing(3).is_err());
    assert!(a.open_carrier(3, 3).is_err());
    assert!(a.global_pool().is_err());
    assert!(a.finish_request(&inflight, b"{}", 3).is_err());
    assert!(a.send_for_carrier(&h, b"{}", 3).is_err());
    assert!(a
        .take_output_owned(&h, 3, |_, _| panic!("late delivery"))
        .is_err());
    assert!(a
        .complete_for_carrier(ticket, CarrierDecision::ApprovedDesktop, || 3)
        .is_err());
    assert!(!a.close_carrier(&h, CloseReason::Disconnected));
    m.close(); // Future worker must close its mailboxes before join/terminal close.
    assert_eq!(pool.used(), StoreLimits::default().working_bytes);
    clean(a);
    clean(resume(&mut p, Default::default()));
}
#[test]
fn abort_dominates_quiescence_and_typed_failure_retains_writer() {
    let _disk_test = crate::synthetic_store::testing_lock();
    for quiesce in [false, true] {
        let mut p = profile(StoreLimits::default());
        let mut a = resume(&mut p, Default::default());
        if quiesce {
            a.quiesce_for_join().unwrap();
        }
        a.abort_in_place();
        assert_eq!(a.quiesce_for_join(), Err(StoreFault::DirtyRun));
        assert_eq!(a.phase, Phase::Aborted);
        let (fault, stopped) = match a.close_for_restart() {
            Err(failure) => failure.into_parts(),
            _ => panic!("abort cannot become clean"),
        };
        assert_eq!(fault, StoreFault::DirtyRun);
        assert!(matches!(p.acquire_writer(), Err(StoreFault::Busy)));
        stopped.release();
        match PersistentAuthority::resume(
            p.acquire_writer().unwrap(),
            Default::default(),
            &mut OsRng,
        ) {
            OpenedAuthority::Quarantined(q) => {
                q.release();
            }
            _ => panic!("dirty run must quarantine"),
        }
    }
}
#[test]
fn poisoned_access_and_post_running_reservation_failure_can_only_abort() {
    let _disk_test = crate::synthetic_store::testing_lock();
    for poison in [false, true] {
        let mut p = profile(StoreLimits::default());
        let mut a = resume(&mut p, Default::default());
        if poison {
            let state = a.core().revocations.clone();
            let _ = std::panic::catch_unwind(move || {
                let _held = state.write().unwrap();
                panic!("synthetic access poison");
            });
            assert_eq!(a.quiesce_for_join(), Err(StoreFault::DirtyRun));
        } else {
            // Models the owner's fallible reservation after resume has written Running.
            let connection = a.global_pool().unwrap().connection(1).unwrap();
            assert!(connection.reserve(2).is_err());
            a.abort_in_place();
        }
        assert!(a.open_carrier(1, 1).is_err());
        let guard = a.abort_without_commit();
        assert!(matches!(p.acquire_writer(), Err(StoreFault::Busy)));
        assert_eq!(guard.diagnostics().fault, Some(StoreFault::DirtyRun));
        guard.release();
    }
}
#[test]
fn approval_uses_ticket_deadline_and_expires_at_equality() {
    let _disk_test = crate::synthetic_store::testing_lock();
    for expired in [false, true] {
        let mut p = profile(StoreLimits::default());
        let mut a = resume(&mut p, Default::default());
        a.enable_desktop().unwrap();
        a.open_pairing(1).unwrap();
        let (h, t, _) = bound_hello(&mut a, 1, 8, true, 2);
        let metadata = a.prepare_pending_approval(&t, 2).unwrap();
        assert_eq!(metadata.device_key, a.pending_for_carrier(&t).unwrap().key);
        assert_eq!(metadata.deadline, 600_001);
        let now = if expired { metadata.deadline } else { 20_000 };
        a.tick(now).unwrap();
        let result = a.complete_for_carrier(t, CarrierDecision::ApprovedDesktop, || now);
        assert_eq!(result.is_err(), expired);
        assert_eq!(
            h.status(),
            if expired {
                CarrierStatus::Closed(CloseReason::HelloTimeout)
            } else {
                CarrierStatus::Active
            }
        );
        assert!(a.pending_carriers.is_empty());
        clean(a);
    }
}
#[test]
fn replaced_approval_cannot_close_or_deliver_to_new_carrier_or_ticket() {
    let _disk_test = crate::synthetic_store::testing_lock();
    for same_id in [false, true] {
        for cancel in [false, true] {
            let mut p = profile(StoreLimits::default());
            let mut a = resume(&mut p, Default::default());
            a.enable_desktop().unwrap();
            a.open_pairing(1).unwrap();
            let (old, t, _) = bound_hello(&mut a, 1, 8, true, 2);
            a.prepare_pending_approval(&t, 2).unwrap();
            let (new, replacement, _) =
                bound_hello(&mut a, if same_id { 1 } else { 2 }, 8, true, 3);
            a.prepare_pending_approval(&replacement, 3).unwrap();
            assert!(matches!(old.status(), CarrierStatus::Closed(_)));
            if cancel {
                assert!(!a.cancel_carrier_ticket(t, CloseReason::Protocol));
            } else {
                assert!(a
                    .complete_for_carrier(t, CarrierDecision::ApprovedDesktop, || 3)
                    .is_err());
            }
            assert_eq!(new.status(), CarrierStatus::Pending);
            a.complete_for_carrier(replacement, CarrierDecision::ApprovedDesktop, || 3)
                .unwrap();
            assert_eq!(new.status(), CarrierStatus::Active);
            clean(a);
        }
    }
}
#[test]
fn invalid_repeated_or_closed_approval_removes_only_its_exact_binding() {
    let _disk_test = crate::synthetic_store::testing_lock();
    for mode in 0..5 {
        let mut p = profile(StoreLimits::default());
        let mut a = resume(&mut p, Default::default());
        a.enable_desktop().unwrap();
        a.open_pairing(1).unwrap();
        let (h, t, _) = bound_hello(&mut a, 1, 8, mode != 0, 2);
        match mode {
            0 => {
                assert!(a.prepare_pending_approval(&t, 2).is_err());
            }
            1 => {
                a.prepare_pending_approval(&t, 2).unwrap();
                assert!(a.prepare_pending_approval(&t, 3).is_err());
            }
            2 => {
                assert!(a
                    .complete_for_carrier(t, CarrierDecision::PhoneOrKnown, || 2)
                    .is_err());
            }
            3 => {
                a.prepare_pending_approval(&t, 2).unwrap();
                assert!(a.close_carrier(&h, CloseReason::Disconnected));
                assert!(a
                    .complete_for_carrier(t, CarrierDecision::ApprovedDesktop, || 2)
                    .is_err());
            }
            _ => {
                assert!(a.cancel_carrier_ticket(t, CloseReason::Disconnected));
            }
        }
        assert!(matches!(h.status(), CarrierStatus::Closed(_)));
        assert!(a.pending_carriers.is_empty());
        assert!(a.core().pending.is_empty());
        assert!(a.core().records.is_empty());
        clean(a);
    }
}
#[test]
fn carrier_transfer_keeps_one_lease_and_rejects_buffered_bytes_during_removal_write() {
    let _disk_test = crate::synthetic_store::testing_lock();
    let mut p = profile(StoreLimits::default());
    let mut a = resume(&mut p, Default::default());
    a.open_pairing(1).unwrap();
    let (h, t, pending) = bound_hello(&mut a, 1, 4, false, 1);
    let key = a.pending_for_carrier(&t).unwrap().key.clone();
    let access = a
        .complete_for_carrier(t, CarrierDecision::PhoneOrKnown, || 1)
        .unwrap();
    let m = MemoryCarrier::new();
    assert!(m.bind_access(access.clone()).is_err());
    m.bind().unwrap();
    m.bind_access(access.clone()).unwrap();
    assert!(m.bind_access(access.clone()).is_err());
    let pool = a.global_pool().unwrap();
    let before = pool.used();
    flush(&mut a, &h, &m, 1);
    assert_eq!(pool.used(), before);
    let mut c = pending.finish(&m.receive().unwrap()).unwrap();
    let work = request(&mut a, &h, &mut c, 1, 2).remove(0);
    a.send_for_carrier(&h, b"{}", 2).unwrap();
    let before = pool.used();
    flush(&mut a, &h, &m, 2);
    assert_eq!(pool.used(), before);
    let during = m.clone();
    store(&mut a).before_commit = Some(Box::new(move || {
        assert!(!during.is_closed());
        assert!(during.receive().is_none());
    }));
    a.remove_device(&key, 3).unwrap();
    assert_eq!(work.status(), WorkStatus::Cancelled);
    assert!(a.finish_request(&work, b"{}", 3).is_err());
    assert!(a
        .take_output_owned(&h, 3, |_, _| panic!("late callback"))
        .is_err());
    assert!(m.bind_access(access).is_err());
    m.close();
    assert_eq!(pool.used(), StoreLimits::default().working_bytes);
    clean(a);
}
#[test]
fn unknown_delivery_is_not_retried_and_other_carrier_stays_active() {
    let _disk_test = crate::synthetic_store::testing_lock();
    let mut p = profile(StoreLimits::default());
    let mut a = resume(&mut p, Default::default());
    a.open_pairing(1).unwrap();
    let (h, t, _) = bound_hello(&mut a, 1, 4, false, 1);
    let access = a
        .complete_for_carrier(t, CarrierDecision::PhoneOrKnown, || 1)
        .unwrap();
    let (other, _, _) = pair(&mut a, 2, 5, 1);
    let m = MemoryCarrier::new();
    m.bind().unwrap();
    m.bind_access(access).unwrap();
    m.inject_unknown_delivery();
    assert!(a
        .take_output_owned(&h, 1, |bytes, lease| m.deliver(
            bytes,
            lease,
            MailboxLimits::default()
        ))
        .is_err());
    assert_eq!(
        h.status(),
        CarrierStatus::Closed(CloseReason::CarrierFailure)
    );
    assert_eq!(other.status(), CarrierStatus::Active);
    assert!(a
        .take_output_owned(&h, 1, |_, _| panic!("no retry"))
        .is_err());
    assert_eq!(m.delivery_attempts(), 1);
    m.close();
    clean(a);
}

#[test]
fn post_commit_deadline_refuses_accept_without_replaying_durable_enrollment() {
    let _disk_test = crate::synthetic_store::testing_lock();
    let mut p = profile(StoreLimits::default());
    let mut a = resume(&mut p, Default::default());
    a.enable_desktop().unwrap();
    a.open_pairing(1).unwrap();
    let (h, t, _) = bound_hello(&mut a, 1, 8, true, 2);
    let deadline = a.prepare_pending_approval(&t, 2).unwrap().deadline;
    let clock = Arc::new(std::sync::atomic::AtomicU64::new(2));
    let during = clock.clone();
    store(&mut a).before_commit = Some(Box::new(move || {
        during.store(deadline, Ordering::SeqCst);
    }));
    assert!(a
        .complete_for_carrier(t, CarrierDecision::ApprovedDesktop, || clock
            .load(Ordering::SeqCst))
        .is_err());
    assert_eq!(a.core().records.len(), 1); // Commit succeeded; no reply proves delivery.
    assert!(a.pending_carriers.is_empty());
    assert!(matches!(h.status(), CarrierStatus::Closed(_)));
    assert!(a
        .take_output_owned(&h, deadline, |_, _| panic!("expired accept"))
        .is_err());
    clean(a);
}
#[test]
fn new_window_and_removal_cancel_protected_carriers_without_touching_new_pairings() {
    let _disk_test = crate::synthetic_store::testing_lock();
    let mut p = profile(StoreLimits::default());
    let mut a = resume(&mut p, Default::default());
    a.enable_desktop().unwrap();
    a.open_pairing(1).unwrap();
    let (h, t, _) = bound_hello(&mut a, 1, 8, true, 2);
    a.prepare_pending_approval(&t, 2).unwrap();
    a.open_pairing(3).unwrap();
    assert!(matches!(h.status(), CarrierStatus::Closed(_)));
    assert!(a.pending_carriers.is_empty());
    assert!(a
        .complete_for_carrier(t, CarrierDecision::ApprovedDesktop, || 3)
        .is_err());
    let (h, t, _) = bound_hello(&mut a, 2, 8, true, 3);
    let key = a.prepare_pending_approval(&t, 3).unwrap().device_key;
    a.complete_for_carrier(t, CarrierDecision::ApprovedDesktop, || 3)
        .unwrap();
    let (pending, ticket, _) = bound_hello(&mut a, 3, 8, true, 4);
    assert!(!a.pending_for_carrier(&ticket).unwrap().first_pairing);
    a.remove_device(&key, 5).unwrap();
    assert!(matches!(h.status(), CarrierStatus::Closed(_)));
    assert!(matches!(pending.status(), CarrierStatus::Closed(_)));
    assert!(a
        .complete_for_carrier(ticket, CarrierDecision::PhoneOrKnown, || 5)
        .is_err());
    a.open_pairing(6).unwrap();
    let (fresh, ticket, _) = bound_hello(&mut a, 2, 8, true, 6);
    a.prepare_pending_approval(&ticket, 6).unwrap();
    a.complete_for_carrier(ticket, CarrierDecision::ApprovedDesktop, || 6)
        .unwrap();
    assert_eq!(fresh.status(), CarrierStatus::Active);
    clean(a);
}

#[test]
fn duplicate_or_expired_hello_reconciles_the_existing_ticket_immediately() {
    let _disk_test = crate::synthetic_store::testing_lock();
    for expired in [false, true] {
        let mut p = profile(StoreLimits::default());
        let mut a = resume(&mut p, Default::default());
        a.enable_desktop().unwrap();
        a.open_pairing(1).unwrap();
        let (h, t, _) = bound_hello(&mut a, 1, 8, true, 2);
        if !expired {
            a.prepare_pending_approval(&t, 2).unwrap();
        }
        assert!(a
            .begin_for_carrier(
                &h,
                Source::Relay,
                b"{}",
                if expired { 15_002 } else { 3 },
                &mut OsRng
            )
            .is_err());
        assert!(a.pending_carriers.is_empty());
        assert!(a.core().pending.is_empty());
        assert!(matches!(h.status(), CarrierStatus::Closed(_)));
        assert!(!a.cancel_carrier_ticket(t, CloseReason::Protocol));
        clean(a);
    }
}

fn owner_drain_clock() -> crate::supervisor::Clock {
    let clock = crate::supervisor::ManualClock::default();
    clock.advance_to(2).unwrap();
    crate::supervisor::Clock::Manual(clock)
}
fn owner_drain_until(mut ready: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while !ready() {
        assert!(
            std::time::Instant::now() < deadline,
            "owner drain did not progress"
        );
        std::thread::yield_now();
    }
}
struct OwnerDrainRelease(Arc<crate::policy::persistent::fixed_executor::ExitGate>);
impl Drop for OwnerDrainRelease {
    fn drop(&mut self) {
        self.0.release();
    }
}

#[test]
fn owner_dirty_drain_holds_join_credit_and_writer_until_actual_worker_exit() {
    use crate::policy::persistent::fixed_executor::{
        ExitGate, Hooks, Outcome, EXECUTION_BYTES, METADATA_BYTES,
    };
    let _disk = crate::synthetic_store::testing_lock();
    let mut p = profile(Default::default());
    let mut a = resume(&mut p, Default::default());
    a.open_pairing(1).unwrap();
    let (h, mut peer, _) = pair(&mut a, 1, 4, 1);
    let memory = MemoryCarrier::new();
    let target = a
        .register_fixed_carrier(&h, memory.clone(), Default::default())
        .unwrap();
    let work = request(&mut a, &h, &mut peer, 1, 2).remove(0);
    let exit = Arc::new(ExitGate::default());
    let release = OwnerDrainRelease(exit.clone());
    let id = a
        .fixed_tracked_hooks(
            work.clone(),
            target,
            Outcome::Success,
            &owner_drain_clock(),
            Hooks {
                exit: Some(exit.clone()),
                ..Default::default()
            },
        )
        .unwrap();
    let probe = a.fixed_probe(id);
    let pool = a.global_pool().unwrap();
    let revision = a.diagnostics().revision;
    owner_drain_until(|| exit.entered());
    assert_eq!(probe.joins(), 0);
    assert!(!a.fixed_thread_finished(id));
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    let draining = std::thread::spawn(move || {
        let proof = a.drain_fixed_for_owner().unwrap();
        let _ = tx.send(proof.healthy());
        a
    });
    owner_drain_until(|| probe.cancelled());
    let premature = rx.try_recv();
    let busy = matches!(p.acquire_writer(), Err(StoreFault::Busy));
    let joins_before_exit = probe.joins();
    let charged_before_exit = pool.used();
    drop(release);
    let a = draining.join().unwrap();
    assert!(matches!(
        premature,
        Err(std::sync::mpsc::TryRecvError::Empty)
    ));
    assert!(busy);
    assert_eq!(joins_before_exit, 0);
    assert!(
        charged_before_exit
            >= StoreLimits::default().working_bytes + EXECUTION_BYTES + METADATA_BYTES
    );
    assert!(rx.recv_timeout(std::time::Duration::from_secs(3)).unwrap());
    assert_eq!(probe.joins(), 1);
    assert_eq!(a.phase, Phase::Aborted); // Healthy resource drainage cannot certify a clean run.
    assert_eq!(a.fixed_occupied_slots(), 0);
    assert!(a.observe_fixed(id).is_none());
    assert_eq!(work.status(), WorkStatus::Cancelled);
    assert!(memory.is_closed());
    assert_eq!(pool.used(), StoreLimits::default().working_bytes);
    assert_eq!(a.diagnostics().revision, revision);
    let (fault, stopped) = a.close_for_restart().err().unwrap().into_parts();
    assert_eq!(fault, StoreFault::DirtyRun);
    assert_eq!(stopped.diagnostics().revision, revision);
    assert!(matches!(p.acquire_writer(), Err(StoreFault::Busy)));
    stopped.release();
}

#[test]
fn owner_drain_discovers_unpolled_worker_panic_and_never_authorizes_clean() {
    use crate::policy::persistent::fixed_executor::Outcome;
    let _disk = crate::synthetic_store::testing_lock();
    let mut p = profile(Default::default());
    let mut a = resume(&mut p, Default::default());
    a.open_pairing(1).unwrap();
    let (h, mut peer, _) = pair(&mut a, 1, 4, 1);
    let work = request(&mut a, &h, &mut peer, 1, 2).remove(0);
    let id = a
        .start_fixed(work.clone(), Outcome::PanicAfterBegin, &owner_drain_clock())
        .unwrap();
    let probe = a.fixed_probe(id);
    let pool = a.global_pool().unwrap();
    let revision = a.diagnostics().revision;
    owner_drain_until(|| a.fixed_thread_finished(id));
    assert_eq!(a.phase, Phase::Running);
    assert_eq!(probe.joins(), 0);
    assert!(!a.observe_fixed(id).unwrap().joined);
    assert!(!a.drain_fixed_for_owner().unwrap().healthy());
    assert_eq!(probe.joins(), 1);
    assert_eq!(a.phase, Phase::Aborted);
    assert_eq!(a.fixed_occupied_slots(), 0);
    assert_eq!(work.status(), WorkStatus::Cancelled);
    assert_eq!(pool.used(), StoreLimits::default().working_bytes);
    assert!(!a.drain_fixed_for_owner().unwrap().healthy()); // Failed cleanup stays sticky.
    assert_eq!(probe.joins(), 1);
    let (fault, stopped) = a.close_for_restart().err().unwrap().into_parts();
    assert_eq!(fault, StoreFault::DirtyRun);
    assert_eq!(stopped.diagnostics().revision, revision);
    assert!(matches!(p.acquire_writer(), Err(StoreFault::Busy)));
    stopped.release();
    match PersistentAuthority::resume(p.acquire_writer().unwrap(), Default::default(), &mut OsRng) {
        OpenedAuthority::Quarantined(quarantined) => {
            quarantined.release();
        }
        _ => panic!("drain failure must not write Clean"),
    }
}

#[test]
fn owner_drain_after_healthy_quiescence_is_idempotent_and_preserves_clean_close() {
    use crate::policy::persistent::fixed_executor::Outcome;
    let _disk = crate::synthetic_store::testing_lock();
    let mut p = profile(Default::default());
    let mut a = resume(&mut p, Default::default());
    a.open_pairing(1).unwrap();
    let (h, mut peer, _) = pair(&mut a, 1, 4, 1);
    let memory = MemoryCarrier::new();
    let target = a
        .register_fixed_carrier(&h, memory.clone(), Default::default())
        .unwrap();
    let work = request(&mut a, &h, &mut peer, 1, 2).remove(0);
    let id = a
        .start_fixed_tracked(work.clone(), target, Outcome::Success, &owner_drain_clock())
        .unwrap();
    let probe = a.fixed_probe(id);
    let pool = a.global_pool().unwrap();
    let revision = a.diagnostics().revision;
    owner_drain_until(|| a.fixed_thread_finished(id));
    assert_eq!(probe.joins(), 0);
    a.quiesce_for_join().unwrap();
    assert_eq!(probe.joins(), 1);
    for _ in 0..3 {
        assert!(a.drain_fixed_for_owner().unwrap().healthy());
        assert_eq!(a.phase, Phase::Quiesced);
        assert_eq!(a.diagnostics().revision, revision);
        assert_eq!(probe.joins(), 1);
        assert_eq!(a.fixed_occupied_slots(), 0);
        assert!(matches!(p.acquire_writer(), Err(StoreFault::Busy)));
        assert_eq!(pool.used(), StoreLimits::default().working_bytes);
    }
    assert_eq!(work.status(), WorkStatus::Cancelled);
    assert!(memory.is_closed());
    assert_eq!(clean(a).revision, revision.map(|n| n + 1));
    clean(resume(&mut p, Default::default()));
}

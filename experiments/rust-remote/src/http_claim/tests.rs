use super::*;
use std::sync::{mpsc, Barrier};
use std::thread;

fn fixture() -> (Machine, GlobalBudget) {
    let pool = GlobalBudget::new(256 * 1024 * 1024).unwrap();
    (Machine::with_blocks(pool.clone(), 1).unwrap(), pool)
}
fn work(m: &Machine, device: u64, now: u64) -> (Carrier, WorkToken) {
    let carrier = m.connect(device).unwrap();
    let work = m.admit(&carrier, now).unwrap();
    (carrier, work)
}
fn submit(m: &Machine, work: &WorkToken) -> Id {
    let a = m.prepare_claim(work).unwrap();
    let id = a.id();
    let receipt = m
        .submit_claim(a)
        .unwrap_or_else(|e| panic!("submit: {:?}", e.fault));
    assert_eq!(receipt.0.serial, id.serial);
    drop(receipt);
    id
}
fn claim(m: &Machine, work: &WorkToken, now: u64) -> Id {
    let id = submit(m, work);
    assert_eq!(m.process_next(now).unwrap().unwrap().serial, id.serial);
    assert_eq!(m.observe(&id).unwrap().phase, Phase::Claimed);
    id
}
fn finish(m: &Machine, id: &Id) {
    m.cancel(id).unwrap();
    m.cleanup(id, true, true).unwrap();
    m.ack_terminal(id).unwrap();
}

#[test]
fn prepared_drop_releases_exact_status_charge_without_cancelling_work() {
    let (m, pool) = fixture();
    let (_, w) = work(&m, 1, 0);
    let base = pool.used();
    let a = m.prepare_claim(&w).unwrap();
    let id = a.id();
    assert_eq!(pool.used(), base + STATUS_BYTES);
    drop(a);
    assert_eq!(pool.used(), base);
    assert!(m.observe(&id).is_none());
    let a = m.prepare_claim(&w).unwrap();
    assert!(a.id.serial > id.serial);
    drop(a);
}

#[test]
fn status_backing_is_prepaid_and_per_device_and_global_slots_are_bounded() {
    let (m, pool) = fixture();
    assert!(pool.used() >= std::mem::size_of::<Core>());
    let (_, first) = work(&m, 0, 0);
    let mut attempts = Vec::new();
    for d in 0..DEVICE_SLOTS {
        let w = if d == 0 {
            first.clone()
        } else {
            work(&m, d as u64, 0).1
        };
        for _ in 0..PER_DEVICE {
            attempts.push(m.prepare_claim(&w).unwrap());
        }
        assert!(matches!(m.prepare_claim(&w), Err(Fault::Full)));
    }
    assert_eq!(
        m.core().unwrap().slots.iter().flatten().count(),
        STATUS_SLOTS
    );
    let charged = pool.used();
    drop(attempts);
    assert_eq!(pool.used(), charged - STATUS_BYTES * STATUS_SLOTS);
    // Budget shortage before prepare does not consume a slot or allocate one.
    let c = m.core().unwrap();
    let conn = c.devices[0].as_ref().unwrap().connection.clone();
    drop(c);
    let fill = conn.reserve(CONNECTION_BYTES - conn.used()).unwrap();
    assert!(matches!(m.prepare_claim(&first), Err(Fault::Budget)));
    assert_eq!(m.core().unwrap().slots.iter().flatten().count(), 0);
    drop(fill);
    assert!(m.prepare_claim(&first).is_ok());
}

#[test]
fn full_returns_original_attempt_and_dropped_accepted_receipt_does_not_cancel() {
    let (m, _) = fixture();
    let (carrier, w) = work(&m, 1, 0);
    for _ in 0..QUEUE {
        submit(&m, &w);
    }
    let fresh = m.admit(&carrier, 0).unwrap();
    let a = m.prepare_claim(&fresh).unwrap();
    let serial = a.id.serial;
    let rejected = match m.submit_claim(a) {
        Err(e) => e,
        Ok(_) => panic!("full"),
    };
    assert_eq!(rejected.fault, Fault::Full);
    let a = rejected.attempt.unwrap();
    assert_eq!(a.id.serial, serial);
    assert_eq!(m.observe(&a.id()).unwrap().phase, Phase::Prepared);
    let first = m.process_next(0).unwrap().unwrap();
    assert_eq!(m.observe(&first).unwrap().phase, Phase::Claimed);
    let accepted = m.submit_claim(a).unwrap_or_else(|_| panic!("retry Full"));
    drop(accepted);
    m.begin(&first, 0).unwrap();
    assert_eq!(m.core().unwrap().invocations, 1);
    for _ in 0..QUEUE {
        m.process_next(0).unwrap();
    }
    assert_eq!(m.observe(&first).unwrap().execution, Evidence::MayHaveRun);
    let c = m.core().unwrap();
    assert_eq!(
        c.slots
            .iter()
            .flatten()
            .filter(|s| s.resources.is_some())
            .count(),
        1
    );
    assert_eq!(c.invocations, 1);
}

#[test]
fn concurrent_clones_have_one_claim_and_one_begin() {
    let (m, _) = fixture();
    let (_, w) = work(&m, 1, 0);
    let barrier = Barrier::new(8);
    thread::scope(|scope| {
        for _ in 0..8 {
            let w = w.clone();
            let m = &m;
            let b = &barrier;
            scope.spawn(move || {
                b.wait();
                submit(m, &w);
            });
        }
    });
    let mut winner = None;
    for _ in 0..8 {
        let id = m.process_next(0).unwrap().unwrap();
        match m.observe(&id).unwrap().phase {
            Phase::Claimed => {
                assert!(winner.is_none());
                winner = Some(id);
            }
            phase => assert_eq!(phase, Phase::Terminal(Terminal::NotClaimed(Fault::State))),
        }
    }
    let id = winner.unwrap();
    thread::scope(|scope| {
        let handles: Vec<_> = (0..8).map(|_| scope.spawn(|| m.begin(&id, 0))).collect();
        assert_eq!(
            handles
                .into_iter()
                .map(|h| h.join().unwrap())
                .filter(Result::is_ok)
                .count(),
            1
        );
    });
    assert_eq!(m.core().unwrap().invocations, 1);
    assert!(matches!(m.prepare_claim(&w), Err(Fault::State)));
}

#[test]
fn cancellation_before_and_after_begin_has_deterministic_evidence() {
    for before in [true, false] {
        let (m, _) = fixture();
        let (_, w) = work(&m, 1, 0);
        let id = claim(&m, &w, 0);
        let (ready_tx, ready_rx) = mpsc::sync_channel(0);
        let (resume_tx, resume_rx) = mpsc::sync_channel(0);
        thread::scope(|scope| {
            let m = &m;
            let id = &id;
            let worker = scope.spawn(move || {
                if !before {
                    m.begin(id, 0).unwrap();
                }
                ready_tx.send(()).unwrap();
                resume_rx.recv().unwrap();
                if before {
                    assert_eq!(m.begin(id, 0), Err(Fault::State));
                }
                assert_eq!(m.complete(id, 1), Err(Fault::State));
            });
            ready_rx.recv().unwrap();
            m.cancel(id).unwrap();
            let observed = m.observe(id).unwrap();
            assert_eq!(
                observed.execution,
                if before {
                    Evidence::NotStarted
                } else {
                    Evidence::MayHaveRun
                }
            );
            assert_eq!(observed.phase, Phase::Terminal(Terminal::Cancelled));
            resume_tx.send(()).unwrap();
            worker.join().unwrap();
        });
        assert_eq!(m.core().unwrap().invocations, usize::from(!before));
        assert!(matches!(m.prepare_claim(&w), Err(Fault::State)));
    }
}

#[test]
fn acknowledgement_cannot_free_executor_output_or_reuse_active_slot() {
    let (m, pool) = fixture();
    let (_, w) = work(&m, 1, 0);
    let id = claim(&m, &w, 0);
    m.begin(&id, 0).unwrap();
    m.cancel(&id).unwrap();
    let charged = pool.used();
    m.ack_terminal(&id).unwrap();
    assert!(m.observe(&id).is_none());
    assert_eq!(pool.used(), charged);
    m.cleanup(&id, true, false).unwrap();
    assert_eq!(pool.used(), charged);
    assert!(m.core().unwrap().slot_index(id.serial).is_some());
    m.cleanup(&id, false, true).unwrap();
    assert_eq!(
        pool.used(),
        charged - m.required_bytes().unwrap() - STATUS_BYTES
    );
    assert!(m.core().unwrap().slot_index(id.serial).is_none());
    assert!(matches!(m.prepare_claim(&w), Err(Fault::Stale)));
    assert_eq!(m.begin(&id, 0), Err(Fault::Stale));
}

#[test]
fn exact_connection_device_and_global_budget_threshold_precedes_invocation() {
    for kind in 0..3 {
        let pool = GlobalBudget::new(256 * 1024 * 1024).unwrap();
        let m = Machine::new(pool.clone()).unwrap();
        let (_, w) = work(&m, 1, 0);
        let id = submit(&m, &w);
        let c = m.core().unwrap();
        let d = c.devices[0].as_ref().unwrap();
        let (budget, limit, used) = match kind {
            0 => (d.connection.clone(), CONNECTION_BYTES, d.connection.used()),
            1 => (
                d.budget.connection(CONNECTION_BYTES).unwrap(),
                CONNECTION_BYTES,
                d.budget.used(),
            ),
            _ => (
                pool.connection(256 * 1024 * 1024).unwrap(),
                256 * 1024 * 1024,
                pool.used(),
            ),
        };
        drop(c);
        let required = m.required_bytes().unwrap();
        let fill = budget.reserve(limit - used - required + 1).unwrap();
        m.process_next(0).unwrap();
        assert_eq!(
            m.observe(&id).unwrap().phase,
            Phase::Terminal(Terminal::NotClaimed(Fault::Budget))
        );
        assert_eq!(m.core().unwrap().invocations, 0);
        drop(fill);
        m.ack_terminal(&id).unwrap();
        let retry = submit(&m, &w);
        let used = match kind {
            0 => budget.used(),
            1 => budget.device_used().unwrap(),
            _ => pool.used(),
        };
        let fill = budget.reserve(limit - used - required).unwrap();
        m.process_next(0).unwrap();
        assert_eq!(m.observe(&retry).unwrap().phase, Phase::Claimed);
        m.begin(&retry, 0).unwrap();
        assert_eq!(m.core().unwrap().invocations, 1);
        // All unreserved capacity is occupied. The prepaid timeout/delivery still progresses.
        m.tick(HTTP_MS).unwrap();
        assert_eq!(m.observe(&retry).unwrap().phase, Phase::ResponseReady(504));
        m.deliver(&retry, true, HTTP_MS).unwrap();
        drop(fill);
        finish(&m, &retry);
    }
}

#[test]
fn deadlines_are_claim_based_and_scheduling_is_not_extended_by_observation() {
    let (m, _) = fixture();
    let (_, w) = work(&m, 1, 0);
    let id = claim(&m, &w, SCHEDULE_MS - 1);
    let start = SCHEDULE_MS - 1;
    m.begin(&id, start + 100).unwrap();
    m.tick(start + HTTP_MS).unwrap();
    assert_eq!(m.observe(&id).unwrap().phase, Phase::ResponseReady(504));
    m.deliver(&id, true, start + COMPLETION_MS - 1).unwrap();
    assert_eq!(m.observe(&id).unwrap().delivery, Delivery::Complete);
    let (_, w) = work(&m, 2, start + COMPLETION_MS);
    let id = submit(&m, &w);
    m.tick(start + COMPLETION_MS + SCHEDULE_MS).unwrap();
    assert_eq!(
        m.observe(&id).unwrap().phase,
        Phase::Terminal(Terminal::NotClaimed(Fault::Expired))
    );
    assert!(matches!(m.prepare_claim(&w), Err(Fault::Stale)));
    m.process_next(start + COMPLETION_MS + SCHEDULE_MS).unwrap();
    let now = start + COMPLETION_MS + SCHEDULE_MS;
    let (_, w) = work(&m, 3, now);
    let id = claim(&m, &w, now);
    m.begin(&id, now).unwrap();
    m.tick(now + COMPLETION_MS).unwrap();
    assert_eq!(m.deliver(&id, true, now + COMPLETION_MS), Err(Fault::State));
    assert_eq!(
        m.observe(&id).unwrap().phase,
        Phase::Terminal(Terminal::TimedOut)
    );
}

#[test]
fn checked_arithmetic_refuses_with_zero_invocations() {
    let (m, _) = fixture();
    let carrier = m.connect(1).unwrap();
    assert!(matches!(
        m.admit(&carrier, u64::MAX - SCHEDULE_MS + 1),
        Err(Fault::Overflow)
    ));
    assert_eq!(m.core().unwrap().invocations, 0);
    let (m, _) = fixture();
    let (_, w) = work(&m, 1, u64::MAX - SCHEDULE_MS);
    let id = submit(&m, &w);
    m.process_next(u64::MAX - SCHEDULE_MS).unwrap();
    assert_eq!(
        m.observe(&id).unwrap().phase,
        Phase::Terminal(Terminal::NotClaimed(Fault::Overflow))
    );
    assert_eq!(m.core().unwrap().invocations, 0);
    let (m, pool) = fixture();
    let (_, w) = work(&m, 1, 0);
    m.core().unwrap().next = u64::MAX;
    let used = pool.used();
    assert!(matches!(m.prepare_claim(&w), Err(Fault::Overflow)));
    assert_eq!(pool.used(), used);
    assert_eq!(m.core().unwrap().invocations, 0);
}

#[test]
fn full_response_uses_fixed_blocks_preserves_bytes_and_refuses_overflow_before_success() {
    let pool = GlobalBudget::new(256 * 1024 * 1024).unwrap();
    let m = Machine::new(pool.clone()).unwrap();
    let (_, w) = work(&m, 1, 0);
    let id = claim(&m, &w, 0);
    m.begin(&id, 0).unwrap();
    let used = pool.used();
    let chunk = [0xa5; BLOCK];
    m.append(&id, b"\x00\xff", 1).unwrap();
    for _ in 0..BLOCKS - 1 {
        m.append(&id, &chunk, 1).unwrap();
    }
    m.append(&id, &chunk[..BLOCK - 2], 1).unwrap();
    assert_eq!(pool.used(), used);
    {
        let c = m.core().unwrap();
        let body = &c.slots[c.slot_index(id.serial).unwrap()]
            .as_ref()
            .unwrap()
            .resources
            .as_ref()
            .unwrap()
            .body;
        assert_eq!(body.len, 64 * 1024 * 1024);
        assert_eq!(body.blocks.iter().flatten().count(), BLOCKS);
        assert_eq!(&body.blocks[0].as_ref().unwrap()[..3], &[0, 255, 0xa5]);
    }
    assert_eq!(m.append(&id, &[1], 1), Err(Fault::TooLarge));
    assert_eq!(m.observe(&id).unwrap().phase, Phase::ResponseReady(502));
    assert_eq!(m.observe(&id).unwrap().delivery, Delivery::None);
    m.deliver(&id, true, 1).unwrap();
    finish(&m, &id);
}

#[test]
fn stale_callbacks_remove_repair_replacement_and_unknown_delivery_never_replay() {
    let (m, _) = fixture();
    let (old, w) = work(&m, 1, 0);
    let id = claim(&m, &w, 0);
    m.begin(&id, 0).unwrap();
    m.remove(1).unwrap();
    let (new, fresh) = work(&m, 1, 0);
    assert!(new.generation > old.generation);
    assert!(matches!(m.admit(&old, 0), Err(Fault::Stale)));
    assert_eq!(m.complete(&id, 0), Err(Fault::State));
    let waiting = submit(&m, &fresh);
    m.process_next(0).unwrap();
    // The old unjoined executor still holds the per-device slot.
    assert_eq!(
        m.observe(&waiting).unwrap().phase,
        Phase::Terminal(Terminal::NotClaimed(Fault::Full))
    );
    finish(&m, &id);
    let current = claim(&m, &fresh, 0);
    m.begin(&current, 0).unwrap();
    m.complete(&current, 0).unwrap();
    m.deliver(&current, false, 0).unwrap();
    assert!(m.cancellation_requested(&current).unwrap());
    assert_eq!(
        m.observe(&current).unwrap().phase,
        Phase::Terminal(Terminal::DeliveryUnknown)
    );
    assert_eq!(m.observe(&current).unwrap().execution, Evidence::MayHaveRun);
    assert_eq!(m.deliver(&current, true, 0), Err(Fault::State));
    assert!(matches!(m.prepare_claim(&fresh), Err(Fault::State)));
    assert_eq!(m.core().unwrap().invocations, 2);
    let replaced = m.connect(1).unwrap();
    assert!(matches!(m.admit(&new, 0), Err(Fault::Stale)));
    assert!(m.admit(&replaced, 0).is_ok());
}

#[test]
fn source_churn_has_no_lifetime_device_cap_or_unbounded_tombstones() {
    let (m, pool) = fixture();
    let base = pool.used();
    for d in 0..1000 {
        let (_, w) = work(&m, d, 0);
        let a = m.prepare_claim(&w).unwrap();
        m.remove(d).unwrap();
        drop(a);
        assert!(m.core().unwrap().devices.iter().all(Option::is_none));
    }
    assert_eq!(pool.used(), base);
}

#[test]
fn stop_requires_queue_drain_acknowledgment_and_resource_cleanup_before_quiescence() {
    let (m, pool) = fixture();
    let base = pool.used();
    let (_, w) = work(&m, 1, 0);
    let active = claim(&m, &w, 0);
    m.begin(&active, 0).unwrap();
    let (_, queued_work) = work(&m, 2, 0);
    let queued = submit(&m, &queued_work);
    m.stop().unwrap();
    assert!(!m.quiescent().unwrap());
    assert!(matches!(m.prepare_claim(&w), Err(Fault::Stopped)));
    assert_eq!(m.complete(&active, 0), Err(Fault::State));
    m.ack_terminal(&active).unwrap();
    m.ack_terminal(&queued).unwrap();
    m.process_next(0).unwrap();
    assert!(!m.quiescent().unwrap());
    m.cleanup(&active, true, false).unwrap();
    assert!(!m.quiescent().unwrap());
    m.cleanup(&active, false, true).unwrap();
    assert!(m.quiescent().unwrap());
    assert_eq!(pool.used(), base);
    drop((active, queued, queued_work, w, m));
    assert_eq!(pool.used(), 0);
}

#[test]
fn previous_scope_and_refused_full_attempt_are_never_reconstructed() {
    let (m, _) = fixture();
    let (_, w) = work(&m, 1, 0);
    let a = m.prepare_claim(&w).unwrap();
    let id = a.id();
    let (next, _) = fixture();
    assert!(matches!(next.prepare_claim(&w), Err(Fault::Stale)));
    assert!(next.observe(&id).is_none());
    let rejection = match next.submit_claim(a) {
        Err(e) => e,
        _ => panic!("scope"),
    };
    assert_eq!(rejection.fault, Fault::Stale);
    assert!(rejection.attempt.is_none());
    assert!(m.observe(&id).is_none());
}

#[test]
fn execution_slots_are_two_global_one_device_and_released_only_after_cleanup() {
    let (m, _) = fixture();
    let (carrier, first) = work(&m, 1, 0);
    let first = claim(&m, &first, 0);
    let (_, second) = work(&m, 2, 0);
    let second = claim(&m, &second, 0);
    let (_, third) = work(&m, 3, 0);
    let refused = submit(&m, &third);
    m.process_next(0).unwrap();
    assert_eq!(
        m.observe(&refused).unwrap().phase,
        Phase::Terminal(Terminal::NotClaimed(Fault::Full))
    );
    m.cancel(&first).unwrap();
    m.ack_terminal(&first).unwrap();
    assert!(m.cancellation_requested(&first).unwrap());
    m.cleanup(&first, true, false).unwrap();
    let still_full = submit(&m, &third);
    m.process_next(0).unwrap();
    assert_eq!(
        m.observe(&still_full).unwrap().phase,
        Phase::Terminal(Terminal::NotClaimed(Fault::Full))
    );
    m.cleanup(&first, false, true).unwrap();
    let third = claim(&m, &third, 0);
    finish(&m, &third);
    let same = m.admit(&carrier, 0).unwrap();
    let same = claim(&m, &same, 0);
    let another = m.admit(&carrier, 0).unwrap();
    finish(&m, &second);
    let per_device = submit(&m, &another);
    m.process_next(0).unwrap();
    assert_eq!(
        m.observe(&per_device).unwrap().phase,
        Phase::Terminal(Terminal::NotClaimed(Fault::Full))
    );
    finish(&m, &same);
    let another = claim(&m, &another, 0);
    assert!(!m.cancellation_requested(&another).unwrap());
}

#[test]
fn stopped_disposal_discards_unobserved_results_only_after_owned_cleanup() {
    let (m, pool) = fixture();
    let base = pool.used();
    let (_, w) = work(&m, 1, 0);
    let active = claim(&m, &w, 0);
    let (_, queued_work) = work(&m, 2, 0);
    let queued = submit(&m, &queued_work);
    let prepared = m.prepare_claim(&queued_work).unwrap();
    assert_eq!(m.finish_stop(), Err(Fault::State));
    assert_eq!(m.ack_terminal(&active), Err(Fault::State));
    m.stop().unwrap();
    assert!(m.cancellation_requested(&active).unwrap());
    assert_eq!(m.finish_stop(), Err(Fault::State));
    m.cleanup(&active, false, true).unwrap();
    assert_eq!(m.finish_stop(), Err(Fault::State));
    m.cleanup(&active, true, false).unwrap();
    m.finish_stop().unwrap();
    assert!(m.quiescent().unwrap());
    assert_eq!(pool.used(), base);
    assert!(m.observe(&queued).is_none());
    assert!(m.observe(&active).is_none());
    let refusal = match m.submit_claim(prepared) {
        Err(e) => e,
        _ => panic!("stopped"),
    };
    assert_eq!(refusal.fault, Fault::Stopped);
    assert!(refusal.attempt.is_none());
}

#[test]
fn exact_body_eof_success_and_http_deadline_cancel_signal_are_distinct() {
    let (m, _) = fixture();
    let (_, w) = work(&m, 1, 0);
    let id = claim(&m, &w, 0);
    m.begin(&id, 0).unwrap();
    m.append(&id, &[0xff; BLOCK], HTTP_MS - 1).unwrap();
    m.complete(&id, HTTP_MS - 1).unwrap();
    m.tick(HTTP_MS).unwrap();
    assert_eq!(m.observe(&id).unwrap().phase, Phase::ResponseReady(200));
    assert!(!m.cancellation_requested(&id).unwrap());
    m.deliver(&id, true, HTTP_MS).unwrap();
    let (_, w) = work(&m, 2, HTTP_MS);
    let timeout = claim(&m, &w, HTTP_MS);
    // Begin was never entered, even though the timeout result is deliverable.
    m.tick(2 * HTTP_MS).unwrap();
    assert!(m.cancellation_requested(&timeout).unwrap());
    assert_eq!(m.observe(&timeout).unwrap().execution, Evidence::NotStarted);
    assert_eq!(m.begin(&timeout, 2 * HTTP_MS), Err(Fault::State));
    assert_eq!(m.core().unwrap().invocations, 1);
}

#[test]
fn fixed_table_reservation_failure_allocates_no_scope_or_status() {
    let pool = GlobalBudget::new(1024 * 1024).unwrap();
    let budget = pool.connection(1024 * 1024).unwrap();
    let needed = std::mem::size_of::<Core>() + DEVICE_SLOTS * 512 + 1024;
    let fill = budget.reserve(1024 * 1024 - needed + 1).unwrap();
    let used = pool.used();
    assert!(matches!(Machine::new(pool.clone()), Err(Fault::Budget)));
    assert_eq!(pool.used(), used);
    drop(fill);
    let fill = budget.reserve(1024 * 1024 - needed).unwrap();
    let machine = Machine::new(pool.clone()).unwrap();
    assert_eq!(pool.used(), 1024 * 1024);
    drop((machine, fill));
    assert_eq!(pool.used(), 0);
}

#[test]
fn acknowledged_cancelled_queue_entry_cannot_hide_the_next_eligible_claim() {
    let (m, _) = fixture();
    let (_, first) = work(&m, 1, 0);
    let first = submit(&m, &first);
    let (_, second) = work(&m, 2, 0);
    let second = submit(&m, &second);
    m.cancel(&first).unwrap();
    m.ack_terminal(&first).unwrap();
    assert_eq!(m.process_next(0).unwrap().unwrap().serial, second.serial);
    assert_eq!(m.observe(&second).unwrap().phase, Phase::Claimed);
    assert!(m.process_next(0).unwrap().is_none());
}

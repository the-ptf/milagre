use super::*;
use crate::persistent::fixed_executor::Hooks as CoreHooks;
use std::collections::VecDeque;

struct Rounds {
    shared: Arc<Shared>,
    hooks: Arc<fixed::FairTest>,
    armed: bool,
}
impl Rounds {
    fn new(s: &PersistentSupervisor, fixed: &FixedOwnerClient) -> Self {
        let hooks = Arc::new(fixed::FairTest::default());
        fixed.park_test(Arc::new(fixed::ParkTest {
            fair: Some(hooks.clone()),
            ..Default::default()
        }));
        wait(|| hooks.entered() > 0);
        hooks.visits.lock().unwrap().clear();
        Self {
            shared: s.shared.clone(),
            hooks,
            armed: true,
        }
    }
    fn step(&self) {
        let entered = self.hooks.entered();
        self.hooks.release();
        wait(|| self.hooks.entered() == entered + 1);
    }
    fn finish(mut self) {
        self.armed = false;
        self.hooks.open();
    }
}
impl Drop for Rounds {
    fn drop(&mut self) {
        if self.armed {
            self.shared.request_stop(true);
        }
        self.hooks.open();
    }
}
fn drain_command(owner: &PersistentOwnerClient) -> Receipt {
    owner
        .submit(C::DrainWork {
            cursor: None,
            limit: 64,
        })
        .unwrap()
}

#[test]
fn eligible_bucket_gets_sixteenth_visit_under_busy_device_and_full_command_lanes() {
    let _disk = crate::synthetic_store::testing_lock();
    let clock = ManualClock::default();
    clock.advance_to(1).unwrap();
    let s = PersistentSupervisor::start_fixed_fixture(
        profile(),
        Limits {
            commands: 2,
            events: 1,
            ..Default::default()
        },
        Clock::Manual(clock),
        FixedFixture,
    )
    .unwrap_or_else(|_| panic!("fair fixture"));
    let owner = s.owner();
    let fixed = s.fixed_owner().unwrap();
    fixed.pause_dispatch(true);
    run(&owner, C::OpenPairing);
    let (a, _, peer) = phone(&owner, 1, 4);
    let target_a = adopted(&fixed, &a);
    peer_installed(&fixed, &a, peer);
    let (b, memory_b, peer) = phone(&owner, 2, 5);
    let target_b = adopted(&fixed, &b);
    peer_installed(&fixed, &b, peer);
    request(&fixed, target_a, 1);
    let token_a = tokens(&owner).remove(0);
    let active = prepared(&fixed, &token_a);
    let active_id = active.id();
    fixed.configure(
        active_id,
        TestHooks {
            core: CoreHooks {
                hold: true,
                ..Default::default()
            },
            ..Default::default()
        },
    );
    let mut attempts: VecDeque<_> = (0..9).map(|_| prepared(&fixed, &token_a)).collect();
    request(&fixed, target_b, 2);
    let token_b = tokens(&owner)
        .into_iter()
        .find(|token| token.handle().same(&b))
        .unwrap();
    let pending_b = prepared(&fixed, &token_b);
    let id_b = pending_b.id();
    run(&owner, C::EnableDesktop);
    let (pending, _) = attach(&owner, 99);
    hello(&owner, &pending, 8, DeviceKind::Desktop);
    assert_eq!(s.shared.queues().events.len(), 1);
    fixed.pause_dispatch(false);
    fixed.submit(active, FixedOutcome::Success).unwrap();
    wait(|| {
        matches!(
            fixed.observe(active_id),
            Observation::Present {
                phase: Phase::Running,
                ..
            }
        )
    });
    let rounds = Rounds::new(&s, &fixed);
    fixed.submit(pending_b, FixedOutcome::Success).unwrap();
    let slot_b = fixed.bucket_slot(id_b);
    let mut pending_a = Some(
        fixed
            .submit(attempts.pop_front().unwrap(), FixedOutcome::Success)
            .unwrap()
            .id(),
    );
    let mut ordinary: VecDeque<_> = (0..2)
        .map(|_| owner.submit(C::HostPublicKey).unwrap())
        .collect();
    let mut controls: VecDeque<_> = (0..8).map(|_| drain_command(&owner)).collect();
    for visit in 0..16 {
        assert!(matches!(owner.submit(C::HostPublicKey), Err(Error::Full)));
        assert!(matches!(
            owner.submit(C::DrainWork {
                cursor: None,
                limit: 64
            }),
            Err(Error::Full)
        ));
        rounds.step();
        assert!(matches!(
            ordinary.pop_front().unwrap().wait(WAIT).unwrap(),
            Reply::HostPublicKey(_)
        ));
        assert!(matches!(
            controls.pop_front().unwrap().wait(WAIT).unwrap(),
            Reply::Work(_)
        ));
        ordinary.push_back(owner.submit(C::HostPublicKey).unwrap());
        controls.push_back(drain_command(&owner));
        let visits = rounds.hooks.visits.lock().unwrap().clone();
        assert_eq!(visits.len(), visit + 1);
        assert_eq!(visits[visit].0, (slot_b + visit + 1) % 16);
        if visit < 15 {
            assert_eq!(fixed.bucket_slot(id_b), slot_b, "an occupied bucket moved");
            assert!(matches!(
                fixed.observe(id_b),
                Observation::Present {
                    phase: Phase::Queued,
                    ..
                }
            ));
        } else {
            assert_eq!(visits[visit], (slot_b, Some(id_b)));
            assert!(matches!(
                fixed.observe(id_b),
                Observation::Present {
                    execution: Execution::MayHaveRun,
                    ..
                }
            ));
        }
        if let Some(id) = pending_a.take() {
            fixed.cancel(id).unwrap();
        } else if let Some(attempt) = attempts.pop_front() {
            pending_a = Some(fixed.submit(attempt, FixedOutcome::Success).unwrap().id());
        }
    }
    assert!(attempts.is_empty(), "busy carrier must repeatedly resubmit");
    assert_eq!(s.shared.queues().events.len(), 1);
    fixed.probe(active_id).finish();
    rounds.finish();
    done(&fixed, id_b, Terminal::Completed, Delivery::Returned, 200);
    assert_eq!(memory_b.delivery_attempts(), 2);
    finish(s);
}

#[test]
fn exhausted_bucket_aborts_before_consuming_or_installing_the_attempt() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, owner, fixed, _) = fixture();
    let (h, _, mut peer) = phone(&owner, 1, 4);
    adopted(&fixed, &h);
    work(&owner, &h, &mut peer, 1);
    let token = tokens(&owner).remove(0);
    let attempt = prepared(&fixed, &token);
    let id = attempt.id();
    let rounds = Rounds::new(&s, &fixed);
    fixed.exhaust_bucket();
    assert!(matches!(
        fixed.submit(attempt, FixedOutcome::Success),
        Err(SubmitRejection::Unavailable(SubmitRefusal::Stopped))
    ));
    assert_eq!(s.shared.fault(), Some(WorkerFault::BucketOverflow));
    assert_eq!(s.shared.stop.load(Ordering::SeqCst), ABORT);
    assert_eq!(fixed.counts().1, 0);
    assert_eq!(
        fixed.raw_phase(id),
        (Phase::Prepared, Execution::NotStarted)
    );
    assert_eq!(token.status(), WorkStatus::InFlight);
    rounds.finish();
    wait(|| owner.is_finished());
    let (_, stopped) = s.close_for_restart().err().unwrap().into_parts();
    quarantined(released(stopped)).destroy().unwrap();
}

#[test]
fn target_replacement_reuses_exact_bucket_without_stale_take_or_neighbor_relocation() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, owner, fixed, _) = fixture();
    let (old, old_memory, mut peer) = phone(&owner, 1, 4);
    adopted(&fixed, &old);
    work(&owner, &old, &mut peer, 1);
    let old_token = tokens(&owner).remove(0);
    let old_id = fixed
        .submit(prepared(&fixed, &old_token), FixedOutcome::Success)
        .unwrap()
        .id();
    let old_ticket = fixed.bucket_ticket(old_id);
    let (other, _, mut peer) = phone(&owner, 2, 5);
    adopted(&fixed, &other);
    work(&owner, &other, &mut peer, 2);
    let token = tokens(&owner)
        .into_iter()
        .find(|t| t.handle().same(&other))
        .unwrap();
    let other_id = fixed
        .submit(prepared(&fixed, &token), FixedOutcome::Success)
        .unwrap()
        .id();
    let other_slot = fixed.bucket_slot(other_id);
    let (fresh, fresh_memory, mut peer) = phone(&owner, 1, 4);
    assert!(old_memory.is_closed());
    assert_ne!(fresh.generation(), old.generation());
    adopted(&fixed, &fresh);
    work(&owner, &fresh, &mut peer, 3);
    let token = tokens(&owner)
        .into_iter()
        .find(|t| t.handle().same(&fresh))
        .unwrap();
    let attempt = prepared(&fixed, &token);
    let id = attempt.id();
    let rounds = Rounds::new(&s, &fixed);
    for _ in 0..16 {
        rounds.step();
        assert_eq!(fixed.bucket_slot(other_id), other_slot);
        if rounds.hooks.visits.lock().unwrap().last().unwrap().0 == old_ticket.slot {
            break;
        }
    }
    fixed.submit(attempt, FixedOutcome::Success).unwrap();
    let new_ticket = fixed.bucket_ticket(id);
    assert_eq!(new_ticket.slot, old_ticket.slot);
    assert_ne!(new_ticket, old_ticket);
    assert!(!fixed.take_stale_bucket(old_ticket, old_id));
    assert!(
        !fixed.take_stale_bucket(old_ticket, id),
        "stale generation consumed the reused slot"
    );
    assert_eq!(fixed.bucket_ticket(id), new_ticket);
    assert_eq!(fixed.bucket_slot(other_id), other_slot);
    assert!(matches!(
        fixed.observe(old_id),
        Observation::Present {
            phase: Phase::Terminal(Terminal::NotClaimed(NotClaimed::Stale)),
            ..
        }
    ));
    fixed.cancel(old_id).unwrap();
    assert_eq!(fixed.raw_phase(id), (Phase::Queued, Execution::NotStarted));
    assert!(!fresh_memory.is_closed());
    rounds.finish();
    finish(s);
}

#[test]
fn control_stop_or_unwind_keeps_second_ordinary_envelope_in_its_owned_queue() {
    let _disk = crate::synthetic_store::testing_lock();
    for panic in [false, true] {
        let (s, owner, fixed, _) = fixture();
        let shared = s.shared.clone();
        run(
            &owner,
            C::Probe(Probe::AfterApply(Box::new(move || {
                // A control command must finish before the ordinary envelope is extracted.
                assert_eq!(
                    shared.queues().commands.len(),
                    1,
                    "ordinary command extracted early"
                );
                shared.request_stop(false);
                if panic {
                    panic!("synthetic control unwind");
                }
            }))),
        );
        let rounds = Rounds::new(&s, &fixed);
        let ordinary = owner.submit(C::HostPublicKey).unwrap();
        let control = drain_command(&owner);
        rounds.finish();
        wait(|| owner.is_finished());
        assert!(matches!(control.wait(WAIT), Err(Error::UnknownOutcome)));
        assert!(matches!(ordinary.wait(WAIT), Err(Error::NotExecuted)));
        if panic {
            let (fault, stopped) = s.close_for_restart().err().unwrap().into_parts();
            assert_eq!(fault, CloseFault::Worker(WorkerFault::Panic));
            quarantined(released(stopped)).destroy().unwrap();
        } else {
            finish(s);
        }
    }
}

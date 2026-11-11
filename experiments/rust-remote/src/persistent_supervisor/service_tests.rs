use super::super::service::Probe;
use super::*;
use crate::{
    admission::Source,
    channel::{self, Channel, DeviceKind, HelloOptions},
    phone::{request_parts, Headers, Method, Request},
    registry::{CarrierStatus, Handle, WorkStatus, WorkToken},
    supervisor::{CarrierCommand, Error, MemoryCarrier},
    SecretKey,
};
use PersistentCommand as C;
const WAIT: Duration = Duration::from_secs(3);
fn service(limits: Limits) -> (PersistentSupervisor, PersistentOwnerClient, ManualClock) {
    let clock = ManualClock::default();
    clock.advance_to(1).unwrap();
    let s = PersistentSupervisor::start(profile(), limits, Clock::Manual(clock.clone()))
        .unwrap_or_else(|_| panic!("start"));
    let owner = s.owner();
    run(&owner, C::OpenPairing);
    run(&owner, C::EnableDesktop);
    (s, owner, clock)
}
fn run(c: &PersistentOwnerClient, command: C) -> Reply {
    c.submit(command).unwrap().wait(WAIT).unwrap()
}
fn attach(c: &PersistentOwnerClient, id: u64) -> (Handle, MemoryCarrier) {
    let memory = MemoryCarrier::new();
    match run(
        c,
        C::Attach {
            id,
            carrier: memory.clone(),
        },
    ) {
        Reply::Attached(h) => (h, memory),
        _ => panic!("handle"),
    }
}
fn hello(
    c: &PersistentOwnerClient,
    h: &Handle,
    seed: u8,
    kind: DeviceKind,
) -> channel::PendingHello {
    let public = match run(c, C::HostPublicKey) {
        Reply::HostPublicKey(k) => k,
        _ => panic!("public"),
    };
    let token = match run(c, C::PairingInvitation) {
        Reply::PairingInvitation(t) => t,
        _ => panic!("invitation"),
    };
    let (bytes, p) = channel::phone_hello(
        &SecretKey::from([seed; 32]),
        &public,
        &token,
        HelloOptions {
            kind: Some(kind),
            ..Default::default()
        },
        &mut OsRng,
    )
    .unwrap();
    c.carrier(h.clone(), Source::Relay)
        .submit(CarrierCommand::Hello(bytes))
        .unwrap()
        .wait(WAIT)
        .unwrap();
    p
}
fn phone(c: &PersistentOwnerClient, id: u64, seed: u8) -> (Handle, MemoryCarrier, Channel) {
    let (h, m) = attach(c, id);
    let p = hello(c, &h, seed, DeviceKind::Phone);
    let channel = p.finish(&m.receive().unwrap()).unwrap();
    (h, m, channel)
}
fn approval(c: &PersistentOwnerClient) -> PersistentApproval {
    loop {
        match c.next_event(WAIT).expect("approval") {
            Event::Approval { permit, .. } => return permit,
            Event::Closed(_) => (),
            _ => panic!("approval"),
        }
    }
}
fn desktop(
    c: &PersistentOwnerClient,
    id: u64,
    seed: u8,
) -> (Handle, MemoryCarrier, PersistentApproval) {
    let (h, m) = attach(c, id);
    hello(c, &h, seed, DeviceKind::Desktop);
    let permit = approval(c);
    (h, m, permit)
}
fn key(seed: u8) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(SecretKey::from([seed; 32]).public_key().as_bytes())
}
fn work(c: &PersistentOwnerClient, h: &Handle, ch: &mut Channel, id: i64) {
    for part in request_parts(&Request {
        id,
        method: Method::GET,
        path: "/rpc".into(),
        headers: Headers::new(),
        body: Vec::new(),
    })
    .unwrap()
    {
        run(
            c,
            C::Request {
                handle: h.clone(),
                bytes: ch.seal_encoded(&part).unwrap(),
            },
        );
    }
}
fn tokens(c: &PersistentOwnerClient) -> Vec<WorkToken> {
    match run(
        c,
        C::DrainWork {
            cursor: None,
            limit: 64,
        },
    ) {
        Reply::Work(p) => p.tokens,
        _ => panic!("work"),
    }
}
fn finish(s: PersistentSupervisor) {
    clean(s).destroy().unwrap();
}
fn closed(c: &PersistentOwnerClient, h: &Handle) {
    loop {
        match c.next_event(WAIT).expect("automatic close") {
            Event::Closed(g) if g.generation() == h.generation() => break,
            Event::Closed(_) => (),
            _ => panic!("close"),
        }
    }
    assert!(matches!(h.status(), CarrierStatus::Closed(_)));
}
type Gate = Arc<(Mutex<bool>, Condvar)>;
fn park(c: &PersistentOwnerClient) -> (Gate, Receipt) {
    let release = Arc::new((Mutex::new(false), Condvar::new()));
    let (entered, rx) = mpsc::sync_channel(1);
    let receipt = c
        .submit(C::Probe(Probe::Park {
            entered,
            release: release.clone(),
        }))
        .unwrap();
    rx.recv_timeout(WAIT).unwrap();
    (release, receipt)
}
fn unpark(g: Gate) {
    *g.0.lock().unwrap() = true;
    g.1.notify_all();
}
#[test]
fn automatic_idle_and_approval_expiry_need_no_client_tick() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, c, clock) = service(Limits::default());
    let (h, m, _) = phone(&c, 1, 4);
    clock
        .advance_to(Limits::default().registry.idle_ms + 1)
        .unwrap();
    closed(&c, &h);
    assert!(m.is_closed());
    let (h, m, permit) = desktop(&c, 2, 5);
    clock.advance_to(600_001).unwrap();
    closed(&c, &h);
    assert!(m.is_closed());
    assert!(matches!(
        c.approve(permit),
        Err(ApprovalRejection::Unavailable(ApprovalRefusal::Expired))
    ));
    finish(s);
}
#[test]
fn approval_survives_hello_timeout_but_stale_replaced_and_closed_permits_cannot_deliver() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, c, clock) = service(Limits::default());
    let (old, old_m, old_p) = desktop(&c, 1, 4);
    let (new, m, p) = desktop(&c, 1, 4);
    assert!(old_m.is_closed());
    assert!(matches!(old.status(), CarrierStatus::Closed(_)));
    assert!(matches!(
        c.approve(old_p),
        Err(ApprovalRejection::Unavailable(ApprovalRefusal::Replaced))
    ));
    clock.advance_to(20_000).unwrap();
    c.approve(p)
        .unwrap_or_else(|_| panic!("approved"))
        .wait(WAIT)
        .unwrap();
    assert_eq!(new.status(), CarrierStatus::Active);
    assert_eq!(m.delivery_attempts(), 1);
    let (h, m, p) = desktop(&c, 2, 5);
    run(&c, C::Disconnect(h));
    assert!(matches!(
        c.approve(p),
        Err(ApprovalRejection::Unavailable(_))
    ));
    assert_eq!(m.delivery_attempts(), 0);
    finish(s);
}
#[test]
fn full_approval_returns_exact_unqueued_permit_and_retry_consumes_it_once() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, c, _) = service(Limits::default());
    let (h, m, p) = desktop(&c, 1, 4);
    let (gate, held) = park(&c);
    let mut controls = Vec::new();
    for _ in 0..8 {
        controls.push(
            c.submit(C::DrainWork {
                cursor: None,
                limit: 1,
            })
            .unwrap(),
        );
    }
    let p = match c.approve(p) {
        Err(ApprovalRejection::Full(p)) => p,
        _ => panic!("full must return permit"),
    };
    unpark(gate);
    held.wait(WAIT).unwrap();
    for r in controls {
        r.wait(WAIT).unwrap();
    }
    c.approve(p)
        .unwrap_or_else(|_| panic!("retry same permit"))
        .wait(WAIT)
        .unwrap();
    assert_eq!(h.status(), CarrierStatus::Active);
    assert_eq!(m.delivery_attempts(), 1);
    finish(s);
}
#[test]
fn dropped_full_permit_cancels_exact_ticket_and_newer_ticket_survives() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, c, _) = service(Limits::default());
    let (h, m, p) = desktop(&c, 1, 4);
    let (gate, held) = park(&c);
    let mut controls = Vec::new();
    for _ in 0..8 {
        controls.push(
            c.submit(C::DrainWork {
                cursor: None,
                limit: 1,
            })
            .unwrap(),
        );
    }
    let p = match c.approve(p) {
        Err(ApprovalRejection::Full(p)) => p,
        _ => panic!("full"),
    };
    drop(p);
    unpark(gate);
    held.wait(WAIT).unwrap();
    for r in controls {
        r.wait(WAIT).unwrap();
    }
    closed(&c, &h);
    assert_eq!(m.delivery_attempts(), 0);
    let (old, _, p) = desktop(&c, 2, 5);
    let (new, m, fresh) = desktop(&c, 3, 5);
    drop(p);
    assert!(matches!(old.status(), CarrierStatus::Closed(_)));
    c.approve(fresh)
        .unwrap_or_else(|_| panic!("fresh"))
        .wait(WAIT)
        .unwrap();
    assert_eq!(new.status(), CarrierStatus::Active);
    assert_eq!(m.delivery_attempts(), 1);
    finish(s);
}
#[test]
fn stopped_expired_and_cross_restart_approval_are_nonretryable_even_when_full() {
    let _disk = crate::synthetic_store::testing_lock();
    for stop in [false, true] {
        let (s, c, clock) = service(Limits::default());
        let (_, _, p) = desktop(&c, 1, 4);
        let (gate, held) = park(&c);
        for _ in 0..8 {
            c.submit(C::DrainWork {
                cursor: None,
                limit: 1,
            })
            .unwrap();
        }
        if stop {
            c.request_abort();
        } else {
            clock.advance_to(600_001).unwrap();
        }
        assert!(matches!(
            c.approve(p),
            Err(ApprovalRejection::Unavailable(_))
        ));
        unpark(gate);
        let _ = held.wait(WAIT);
        if stop {
            let mut p = quarantined(released(s.abort()));
            p.destroy().unwrap();
        } else {
            finish(s);
        }
    }
    let (s, c, _) = service(Limits::default());
    let (_, _, p) = desktop(&c, 1, 4);
    let profile = clean(s);
    let successor = start(profile);
    let next = successor.owner();
    assert!(matches!(
        next.approve(p),
        Err(ApprovalRejection::Unavailable(ApprovalRefusal::Replaced))
    ));
    finish(successor);
}
#[test]
fn joined_close_drains_all_leases_and_cancels_queued_and_inflight_work() {
    let _disk = crate::synthetic_store::testing_lock();
    let limits = Limits {
        registry: crate::registry::Limits {
            inflight: 1,
            ..Default::default()
        },
        ..Default::default()
    };
    let (s, c, _) = service(limits);
    let (h, m, mut ch) = phone(&c, 1, 4);
    work(&c, &h, &mut ch, 1);
    let token = tokens(&c).remove(0);
    work(&c, &h, &mut ch, 2);
    run(
        &c,
        C::Send {
            handle: h.clone(),
            encoded: b"{}".to_vec(),
        },
    );
    assert!(c.retained_bytes() > StoreLimits::default().working_bytes);
    let p = clean(s);
    assert!(c.is_finished());
    assert!(m.is_closed());
    assert!(m.receive().is_none());
    assert_eq!(token.status(), WorkStatus::Cancelled);
    assert_eq!(c.retained_bytes(), StoreLimits::default().working_bytes);
    assert!(matches!(
        c.submit(C::Finish {
            token,
            response: b"null".to_vec()
        }),
        Err(Error::NotExecuted)
    ));
    let next = start(p);
    assert!(c.submit(C::OpenPairing).is_err());
    finish(next);
}
#[test]
fn saturated_queues_cannot_block_abort_and_accepted_receipts_are_not_replayed() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, c, _) = service(Limits::default());
    let (gate, held) = park(&c);
    let mut queued = Vec::new();
    for _ in 0..64 {
        queued.push(c.submit(C::HostPublicKey).unwrap());
    }
    for _ in 0..8 {
        queued.push(
            c.submit(C::DrainWork {
                cursor: None,
                limit: 1,
            })
            .unwrap(),
        );
    }
    c.request_abort();
    assert!(matches!(c.submit(C::OpenPairing), Err(Error::NotExecuted)));
    let join = thread::spawn(move || s.abort());
    unpark(gate);
    assert!(matches!(held.wait(WAIT), Err(Error::UnknownOutcome)));
    let stopped = join.join().unwrap();
    for r in queued {
        assert!(matches!(r.wait(WAIT), Err(Error::NotExecuted)));
    }
    assert_eq!(c.retained_bytes(), StoreLimits::default().working_bytes);
    let mut p = quarantined(released(stopped));
    p.destroy().unwrap();
}
#[test]
fn worker_panic_and_queue_poison_return_joined_dirty_owners_without_admission() {
    let _disk = crate::synthetic_store::testing_lock();
    for poison in [false, true] {
        let (s, c, _) = service(Limits::default());
        let (h, m, _) = phone(&c, 1, 4);
        let receipt = c
            .submit(C::Probe(if poison {
                Probe::PoisonQueue
            } else {
                Probe::Panic
            }))
            .unwrap();
        assert!(matches!(receipt.wait(WAIT), Err(Error::UnknownOutcome)));
        let (_, mut stopped) = s.close_for_restart().err().expect("no clean").into_parts();
        assert!(stopped.diagnostics().worker_joined);
        assert!(matches!(
            stopped.profile.acquire_writer(),
            Err(StoreFault::Busy)
        ));
        assert!(c.is_finished());
        assert!(m.is_closed());
        assert!(matches!(h.status(), CarrierStatus::Closed(_)));
        assert!(matches!(c.submit(C::OpenPairing), Err(Error::NotExecuted)));
        let mut p = quarantined(released(stopped));
        p.destroy().unwrap();
    }
}
#[test]
fn stop_after_commit_before_reply_is_unknown_and_never_replays() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, c, _) = service(Limits::default());
    let shared = c.0.clone();
    run(
        &c,
        C::Probe(Probe::AfterApply(Box::new(move || {
            shared.request_stop(false)
        }))),
    );
    let r = c.submit(C::OpenPairing).unwrap();
    assert!(matches!(r.wait(WAIT), Err(Error::UnknownOutcome)));
    drop(r);
    let (receipt, p) = s
        .close_for_restart()
        .unwrap_or_else(|_| panic!("healthy joined stop"))
        .into_parts();
    assert_eq!(receipt.diagnostics().revision, Some(5)); // Running, first window, second window, Clean after initial revision.
    let s = start(p);
    finish(s);
}
#[test]
fn removal_revokes_buffered_receive_before_io_and_late_callbacks_cannot_deliver() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, c, _) = service(Limits::default());
    let (h, m, mut ch) = phone(&c, 1, 4);
    work(&c, &h, &mut ch, 1);
    let t = tokens(&c).remove(0);
    run(
        &c,
        C::Send {
            handle: h.clone(),
            encoded: b"{}".to_vec(),
        },
    );
    let observe = m.clone();
    run(
        &c,
        C::Probe(Probe::BeforeCommit(Box::new(move || {
            assert!(!observe.is_closed());
            assert!(observe.receive().is_none());
        }))),
    );
    run(&c, C::RemoveDevice(key(4)));
    assert_eq!(t.status(), WorkStatus::Cancelled);
    assert!(m.is_closed());
    assert!(c
        .submit(C::Finish {
            token: t,
            response: b"{}".to_vec()
        })
        .unwrap()
        .wait(WAIT)
        .is_err());
    assert_eq!(m.delivery_attempts(), 2);
    finish(s);
}
#[test]
fn unknown_delivery_is_attributed_to_target_and_memory_http_is_one_shot() {
    let _disk = crate::synthetic_store::testing_lock();
    use crate::http_dispatch::{MemoryHttp, Outcome};
    let (s, c, _) = service(Limits::default());
    let (h, m, mut ch) = phone(&c, 1, 4);
    let (other, other_m, _) = phone(&c, 2, 5);
    work(&c, &h, &mut ch, 1);
    let token = tokens(&c).remove(0);
    let http = MemoryHttp::new(Outcome::Timeout).unwrap();
    m.inject_unknown_delivery();
    assert!(matches!(
        c.submit(C::DispatchSynthetic {
            token: token.clone(),
            http: http.clone()
        })
        .unwrap()
        .wait(WAIT),
        Err(Error::DeliveryUnknown)
    ));
    assert_eq!(http.calls(), 1);
    assert_eq!(other.status(), CarrierStatus::Active);
    assert!(!other_m.is_closed());
    assert!(c
        .submit(C::DispatchSynthetic {
            token,
            http: http.clone()
        })
        .unwrap()
        .wait(WAIT)
        .is_err());
    assert_eq!(http.calls(), 1);
    finish(s);
}
#[test]
fn advisory_eviction_flood_does_not_stop_service_and_work_signal_survives_refused_drain() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, c, _) = service(Limits {
        events: 1,
        ..Default::default()
    });
    let (h, _, mut ch) = phone(&c, 1, 4);
    for id in 2..1002 {
        attach(&c, id);
    }
    assert!(c.failure().is_none());
    assert!(c.event_stats().closed_dropped > 0);
    assert_eq!(h.status(), CarrierStatus::Active);
    work(&c, &h, &mut ch, 1);
    assert!(matches!(c.next_event(WAIT), Some(Event::WorkAvailable)));
    assert!(c
        .submit(C::DrainWork {
            cursor: None,
            limit: 0
        })
        .unwrap()
        .wait(WAIT)
        .is_err());
    assert!(matches!(c.next_event(WAIT), Some(Event::WorkAvailable)));
    assert_eq!(tokens(&c).len(), 1);
    finish(s);
}
#[test]
fn snapshot_dependent_limit_rejection_releases_clean_proof_for_corrected_retry() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, c, _) = service(Limits::default());
    phone(&c, 1, 4);
    phone(&c, 2, 5);
    let p = clean(s);
    let l = Limits {
        authority: crate::policy::Limits {
            records: 1,
            ..Default::default()
        },
        ..Default::default()
    };
    let (fault, stopped) = PersistentSupervisor::start(p, l, Clock::monotonic())
        .err()
        .expect("read-only reject")
        .into_parts();
    assert_eq!(fault, StartFault::InvalidLimits);
    finish(start(released(stopped)));
}

#[test]
fn default_256_work_items_survive_one_event_slot_and_lost_drain_receipt() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, c, _) = service(Limits {
        events: 1,
        ..Default::default()
    });
    let mut phones = Vec::new();
    for id in 1..=16 {
        phones.push(phone(&c, id, (id + 2) as u8));
    }
    for (h, _, ch) in &mut phones {
        for id in 1..=16 {
            work(&c, h, ch, id);
        }
    }
    assert!(c.failure().is_none());
    assert_eq!(c.event_stats().authoritative, 1);
    drop(
        c.submit(C::DrainWork {
            cursor: None,
            limit: 64,
        })
        .unwrap(),
    );
    let mut cursor = None;
    let mut work = Vec::new();
    loop {
        let page = match run(&c, C::DrainWork { cursor, limit: 64 }) {
            Reply::Work(p) => p,
            _ => panic!("page"),
        };
        work.extend(page.tokens);
        cursor = page.next;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(work.len(), 256);
    let mut p = clean(s);
    assert!(work.iter().all(|t| t.status() == WorkStatus::Cancelled));
    assert_eq!(c.retained_bytes(), StoreLimits::default().working_bytes);
    p.destroy().unwrap();
}
#[test]
fn new_window_and_device_removal_refuse_old_approval_but_repair_is_admissible() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, c, clock) = service(Limits::default());
    let (_, m, p) = desktop(&c, 1, 4);
    run(&c, C::OpenPairing);
    assert!(matches!(
        c.approve(p),
        Err(ApprovalRejection::Unavailable(_))
    ));
    assert!(m.is_closed());
    let (_, _, p) = desktop(&c, 2, 4);
    c.approve(p)
        .unwrap_or_else(|_| panic!("approve"))
        .wait(WAIT)
        .unwrap();
    run(&c, C::RemoveDevice(key(4)));
    clock.advance_to(2).unwrap();
    run(&c, C::OpenPairing);
    let (h, m, p) = desktop(&c, 3, 4);
    c.approve(p)
        .unwrap_or_else(|_| panic!("repair"))
        .wait(WAIT)
        .unwrap();
    assert_eq!(h.status(), CarrierStatus::Active);
    assert_eq!(m.delivery_attempts(), 1);
    finish(s);
}
#[test]
fn requested_stop_cannot_hide_later_command_panic() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, c, _) = service(Limits::default());
    let shared = c.0.clone();
    run(
        &c,
        C::Probe(Probe::AfterApply(Box::new(move || {
            shared.request_stop(false);
            panic!("synthetic post-commit panic");
        }))),
    );
    assert!(matches!(
        c.submit(C::OpenPairing).unwrap().wait(WAIT),
        Err(Error::UnknownOutcome)
    ));
    let (fault, stopped) = s
        .close_for_restart()
        .err()
        .expect("abort dominates")
        .into_parts();
    assert_eq!(fault, CloseFault::Worker(WorkerFault::Panic));
    let mut p = quarantined(released(stopped));
    p.destroy().unwrap();
}
#[test]
fn timeout_margin_delivers_504_and_consumed_http_cannot_close_another_carrier() {
    let _disk = crate::synthetic_store::testing_lock();
    use crate::http_dispatch::{MemoryHttp, Outcome, REQUEST_LIFETIME_MS, TIMEOUT_MS};
    for elapsed in [TIMEOUT_MS, REQUEST_LIFETIME_MS] {
        let (s, c, clock) = service(Limits::default());
        let (h, m, mut ch) = phone(&c, 1, 4);
        work(&c, &h, &mut ch, 1);
        let t = tokens(&c).remove(0);
        let mut now = 1;
        let mut id = 2;
        while now + 40_000 < elapsed + 1 {
            now += 40_000;
            clock.advance_to(now).unwrap();
            work(&c, &h, &mut ch, id);
            id += 1;
        }
        clock.advance_to(elapsed + 1).unwrap();
        let http = MemoryHttp::new(Outcome::Timeout).unwrap();
        let r = c
            .submit(C::DispatchSynthetic {
                token: t.clone(),
                http: http.clone(),
            })
            .unwrap();
        if elapsed < REQUEST_LIFETIME_MS {
            assert!(
                matches!(r.wait(WAIT).unwrap(),Reply::Dispatched(record) if record.status==504)
            );
            let frame: serde_json::Value =
                serde_json::from_slice(&ch.open_encoded(&m.receive().unwrap()).unwrap()).unwrap();
            assert_eq!(frame["status"], 504);
            let (other, other_m, mut other_ch) = phone(&c, 2, 5);
            work(&c, &other, &mut other_ch, 100);
            let token = tokens(&c).into_iter().find(|t| t.id() == 100).unwrap();
            assert!(c
                .submit(C::DispatchSynthetic {
                    token: token.clone(),
                    http: http.clone()
                })
                .unwrap()
                .wait(WAIT)
                .is_err());
            assert_eq!(http.calls(), 1);
            assert_eq!(token.status(), WorkStatus::InFlight);
            assert_eq!(other.status(), CarrierStatus::Active);
            assert!(!other_m.is_closed());
        } else {
            assert!(r.wait(WAIT).is_err());
            assert_eq!(http.calls(), 0);
            assert_eq!(t.status(), WorkStatus::TimedOut);
        }
        finish(s);
    }
}

#[test]
fn global_saturation_cannot_consume_reserved_control_or_stop_admission() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, c, _) = service(Limits::default());
    let (gate, held) = park(&c);
    let pool = c.0.global.connection(256 * 1024 * 1024).unwrap();
    let fill = pool
        .reserve(256 * 1024 * 1024 - c.retained_bytes())
        .unwrap();
    assert!(matches!(c.submit(C::HostPublicKey), Err(Error::Full)));
    let control = c.submit(C::RemoveDevice(key(4))).unwrap();
    c.request_abort();
    drop(fill);
    unpark(gate);
    assert!(matches!(held.wait(WAIT), Err(Error::UnknownOutcome)));
    assert!(matches!(control.wait(WAIT), Err(Error::NotExecuted)));
    let stopped = s.abort();
    assert_eq!(c.retained_bytes(), StoreLimits::default().working_bytes);
    let mut p = quarantined(released(stopped));
    p.destroy().unwrap();
}
#[test]
fn timed_out_and_dropped_accepted_approval_receipt_never_reconstructs_or_replays() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, c, _) = service(Limits::default());
    let (h, m, p) = desktop(&c, 1, 4);
    let (gate, held) = park(&c);
    let receipt = c.approve(p).unwrap_or_else(|_| panic!("queued"));
    assert!(matches!(
        receipt.wait(Duration::ZERO),
        Err(Error::UnknownOutcome)
    ));
    drop(receipt);
    unpark(gate);
    held.wait(WAIT).unwrap();
    run(&c, C::HostPublicKey);
    assert_eq!(h.status(), CarrierStatus::Active);
    assert_eq!(m.delivery_attempts(), 1);
    finish(s);
}

#[test]
fn full_queues_still_join_and_acknowledge_healthy_close_after_draining() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, c, _) = service(Limits::default());
    let (gate, held) = park(&c);
    let mut queued = Vec::new();
    for _ in 0..64 {
        queued.push(c.submit(C::HostPublicKey).unwrap());
    }
    for _ in 0..8 {
        queued.push(
            c.submit(C::DrainWork {
                cursor: None,
                limit: 1,
            })
            .unwrap(),
        );
    }
    c.0.request_stop(false);
    let join = thread::spawn(move || s.close_for_restart());
    assert!(!join.is_finished());
    unpark(gate);
    assert!(matches!(held.wait(WAIT), Err(Error::UnknownOutcome)));
    let stop = join
        .join()
        .unwrap()
        .unwrap_or_else(|_| panic!("joined clean"));
    for r in queued {
        assert!(matches!(r.wait(WAIT), Err(Error::NotExecuted)));
    }
    assert!(c.is_finished());
    assert_eq!(c.retained_bytes(), StoreLimits::default().working_bytes);
    finish(start(stop.into_parts().1));
}
#[test]
fn approval_event_count_shortage_closes_only_new_carrier_and_preserves_clean_restart() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, c, _) = service(Limits {
        events: 1,
        ..Default::default()
    });
    let (phone, phone_m, _) = phone(&c, 3, 6);
    let (h, m) = attach(&c, 1);
    hello(&c, &h, 4, DeviceKind::Desktop);
    let (other, other_m) = attach(&c, 2);
    let public = match run(&c, C::HostPublicKey) {
        Reply::HostPublicKey(k) => k,
        _ => panic!("host"),
    };
    let token = match run(&c, C::PairingInvitation) {
        Reply::PairingInvitation(t) => t,
        _ => panic!("invitation"),
    };
    let (bytes, _) = channel::phone_hello(
        &SecretKey::from([5; 32]),
        &public,
        &token,
        HelloOptions {
            kind: Some(DeviceKind::Desktop),
            ..Default::default()
        },
        &mut OsRng,
    )
    .unwrap();
    assert!(matches!(
        c.submit(C::Hello {
            handle: other.clone(),
            source: Source::Relay,
            bytes
        })
        .unwrap()
        .wait(WAIT),
        Err(Error::Full)
    ));
    assert!(c.failure().is_none());
    assert_eq!(
        other.status(),
        CarrierStatus::Closed(crate::registry::CloseReason::Limit)
    );
    assert!(other_m.is_closed());
    assert_eq!(other_m.delivery_attempts(), 0);
    assert_eq!(phone.status(), CarrierStatus::Active);
    assert!(!phone_m.is_closed());
    let permit = approval(&c);
    c.approve(permit)
        .unwrap_or_else(|_| panic!("existing approval"))
        .wait(WAIT)
        .unwrap();
    assert_eq!(h.status(), CarrierStatus::Active);
    assert_eq!(m.delivery_attempts(), 1);
    let (fresh, _, permit) = desktop(&c, 4, 5);
    c.approve(permit)
        .unwrap_or_else(|_| panic!("capacity recovered"))
        .wait(WAIT)
        .unwrap();
    assert_eq!(fresh.status(), CarrierStatus::Active);
    finish(start(clean(s)));
}

#[test]
fn hello_queued_before_global_saturation_cannot_dirty_profile_on_approval_shortage() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, c, _) = service(Limits::default());
    let (known, known_m, _) = phone(&c, 1, 4);
    let (h, m) = attach(&c, 2);
    let public = match run(&c, C::HostPublicKey) {
        Reply::HostPublicKey(k) => k,
        _ => panic!("host"),
    };
    let token = match run(&c, C::PairingInvitation) {
        Reply::PairingInvitation(t) => t,
        _ => panic!("invitation"),
    };
    let (bytes, _) = channel::phone_hello(
        &SecretKey::from([5; 32]),
        &public,
        &token,
        HelloOptions {
            kind: Some(DeviceKind::Desktop),
            ..Default::default()
        },
        &mut OsRng,
    )
    .unwrap();
    let (gate, held) = park(&c);
    let hello = c
        .submit(C::Hello {
            handle: h.clone(),
            source: Source::Relay,
            bytes,
        })
        .unwrap();
    let pool = c.0.global.connection(256 * 1024 * 1024).unwrap();
    let fill = pool
        .reserve(256 * 1024 * 1024 - c.retained_bytes())
        .unwrap();
    unpark(gate);
    held.wait(WAIT).unwrap();
    assert!(matches!(hello.wait(WAIT), Err(Error::Full)));
    drop(fill);
    assert!(c.failure().is_none());
    assert_eq!(
        h.status(),
        CarrierStatus::Closed(crate::registry::CloseReason::Limit)
    );
    assert!(m.is_closed());
    assert_eq!(m.delivery_attempts(), 0);
    assert_eq!(known.status(), CarrierStatus::Active);
    assert!(!known_m.is_closed());
    let (fresh, _, permit) = desktop(&c, 3, 5);
    c.approve(permit)
        .unwrap_or_else(|_| panic!("later approval"))
        .wait(WAIT)
        .unwrap();
    assert_eq!(fresh.status(), CarrierStatus::Active);
    finish(start(clean(s)));
}
#[test]
fn idle_tick_expires_and_promotes_work_without_creating_response_frames() {
    let _disk = crate::synthetic_store::testing_lock();
    let (s, c, clock) = service(Limits {
        registry: crate::registry::Limits {
            inflight: 1,
            request_ms: 10,
            queue_wait_ms: 20,
            ..Default::default()
        },
        ..Default::default()
    });
    let (h, m, mut ch) = phone(&c, 1, 4);
    work(&c, &h, &mut ch, 1);
    let first = tokens(&c).remove(0);
    work(&c, &h, &mut ch, 2);
    assert!(c.next_event(Duration::ZERO).is_none());
    clock.advance_to(11).unwrap();
    assert!(matches!(c.next_event(WAIT), Some(Event::WorkAvailable))); // No command/tick submitted after advancing.
    assert_eq!(first.status(), WorkStatus::TimedOut);
    assert_eq!(m.delivery_attempts(), 1);
    assert!(m.receive().is_none());
    let promoted = tokens(&c).remove(0);
    assert_eq!(promoted.id(), 2);
    assert_eq!(promoted.status(), WorkStatus::InFlight);
    finish(s);
}

#[path = "fixed_owner_tests.rs"]
mod fixed_owner_tests;

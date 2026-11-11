use milagre_remote::{
    admission::Source,
    channel::{self, Channel, DesktopAccess, DeviceKind, HelloOptions},
    phone::{request_parts, Headers, Method, Request},
    registry::{CarrierStatus, CloseReason, Handle, WorkStatus, WorkToken},
    supervisor::{
        Client, Clock, Command, Error, Event, Limits, ManualClock, MemoryCarrier, Reply,
        StopReason, Supervisor, SyntheticIdentity,
    },
    SecretKey,
};
use rand_core::OsRng;
use std::time::Duration;
const WAIT: Duration = Duration::from_secs(3);
const TOKEN: &str = "synthetic-supervisor-token";
fn identity(seed: u8) -> SyntheticIdentity {
    SyntheticIdentity {
        host: SecretKey::from([seed; 32]),
        token: TOKEN.into(),
        desktop: DesktopAccess::Enabled,
    }
}
fn start(limits: Limits) -> (Supervisor, Client, ManualClock) {
    let clock = ManualClock::default();
    clock.advance_to(1).unwrap();
    let s = Supervisor::spawn_synthetic(identity(1), limits, Clock::Manual(clock.clone())).unwrap();
    let c = s.client();
    (s, c, clock)
}
fn run(c: &Client, cmd: Command) -> Reply {
    c.submit(cmd).unwrap().wait(WAIT).unwrap()
}
fn attach(c: &Client, id: u64) -> (Handle, MemoryCarrier) {
    let memory = MemoryCarrier::new();
    match run(
        c,
        Command::Attach {
            id,
            carrier: memory.clone(),
        },
    ) {
        Reply::Attached(h) => (h, memory),
        _ => panic!("missing handle"),
    }
}
fn hello(c: &Client, h: &Handle, seed: u8, host: u8, kind: DeviceKind) -> channel::PendingHello {
    let (bytes, pending) = channel::phone_hello(
        &SecretKey::from([seed; 32]),
        &SecretKey::from([host; 32]).public_key(),
        TOKEN,
        HelloOptions {
            kind: Some(kind),
            ..Default::default()
        },
        &mut OsRng,
    )
    .unwrap();
    run(
        c,
        Command::Hello {
            handle: h.clone(),
            source: Source::Relay,
            bytes,
        },
    );
    pending
}
fn phone(c: &Client, id: u64, seed: u8) -> (Handle, MemoryCarrier, Channel) {
    let (h, m) = attach(c, id);
    let p = hello(c, &h, seed, 1, DeviceKind::Phone);
    let channel = p.finish(&m.receive().expect("ACCEPT")).unwrap();
    (h, m, channel)
}
fn work(c: &Client, h: &Handle, ch: &mut Channel, id: i64) {
    for p in request_parts(&Request {
        id,
        method: Method::POST,
        path: "/rpc".into(),
        headers: Headers::new(),
        body: vec![b'x'; 20],
    })
    .unwrap()
    {
        run(
            c,
            Command::Request {
                handle: h.clone(),
                bytes: ch.seal_encoded(&p).unwrap(),
            },
        );
    }
}
fn next_work(c: &Client) -> WorkToken {
    match c.next_event(WAIT).expect("work event") {
        Event::Work(t) => t,
        _ => panic!("not work"),
    }
}
fn closed(c: &Client, h: &Handle, reason: CloseReason) {
    match c.next_event(WAIT).expect("automatic close event") {
        Event::Closed(g) => assert_eq!(g.generation(), h.generation()),
        _ => panic!("not closed"),
    }
    assert_eq!(h.status(), CarrierStatus::Closed(reason));
}
#[test]
fn idle_and_hello_deadlines_run_without_commands_or_caller_ticks() {
    let (s, c, clock) = start(Limits::default());
    let path = s.initial_directory().to_owned();
    run(&c, Command::OpenPairing);
    let (h, m, _) = phone(&c, 1, 2);
    let (pending, pending_memory) = attach(&c, 2);
    let before = c.ticks();
    clock.advance_to(15001).unwrap();
    closed(&c, &pending, CloseReason::HelloTimeout);
    assert!(pending_memory.is_closed());
    assert!(c.ticks() > before);
    clock.advance_to(45001).unwrap();
    closed(&c, &h, CloseReason::IdleTimeout);
    assert!(m.is_closed());
    assert_eq!(c.retained_bytes(), 0);
    drop(s);
    assert!(!path.exists());
    assert!(c.is_finished());
}
#[test]
fn approval_expiry_is_automatic_and_old_owner_callback_cannot_deliver() {
    let (s, c, clock) = start(Limits::default());
    run(&c, Command::OpenPairing);
    let (h, m) = attach(&c, 1);
    hello(&c, &h, 2, 1, DeviceKind::Desktop);
    let permit = match c.next_event(WAIT).unwrap() {
        Event::Approval { permit, .. } => permit,
        _ => panic!(),
    };
    clock.advance_to(16000).unwrap();
    // A real owner decision after HELLO's 15 s remains valid in the ten-minute window.
    run(&c, Command::Approve(permit));
    assert!(m.receive().is_some());
    let (other, m2) = attach(&c, 2);
    hello(&c, &other, 3, 1, DeviceKind::Desktop);
    let stale = match c.next_event(WAIT).unwrap() {
        Event::Approval { permit, .. } => permit,
        _ => panic!(),
    };
    clock.advance_to(600001).unwrap();
    for _ in 0..2 {
        assert!(matches!(c.next_event(WAIT), Some(Event::Closed(_))));
    }
    assert!(m2.is_closed());
    assert_eq!(m2.delivery_attempts(), 0);
    assert!(matches!(
        c.submit(Command::Approve(stale)).unwrap().wait(WAIT),
        Err(Error::Stale)
    ));
    drop(s);
}
#[test]
fn removal_cancels_running_and_queued_then_late_finish_cannot_send() {
    let limits = Limits {
        registry: milagre_remote::registry::Limits {
            inflight: 1,
            ..Default::default()
        },
        ..Default::default()
    };
    let (s, c, clock) = start(limits);
    run(&c, Command::OpenPairing);
    let (h, m, mut ch) = phone(&c, 1, 2);
    work(&c, &h, &mut ch, 1);
    let token = next_work(&c);
    work(&c, &h, &mut ch, 2); // queued, no Work event until promotion
    let key = base64_key(2);
    run(&c, Command::RemoveDevice(key));
    closed(&c, &h, CloseReason::Removed);
    assert_eq!(token.status(), WorkStatus::Cancelled);
    assert!(m.is_closed());
    assert!(matches!(
        c.submit(Command::Finish {
            token,
            response: b"null".to_vec()
        })
        .unwrap()
        .wait(WAIT),
        Err(Error::Registry(_))
    ));
    assert_eq!(m.delivery_attempts(), 1);
    assert_eq!(c.retained_bytes(), 0);
    clock.advance_to(2).unwrap();
    run(&c, Command::OpenPairing);
    let (new, m2, _) = phone(&c, 2, 2);
    assert_eq!(new.status(), CarrierStatus::Active);
    assert_eq!(m2.delivery_attempts(), 1);
    drop(s);
}
fn base64_key(seed: u8) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(SecretKey::from([seed; 32]).public_key().as_bytes())
}
#[test]
fn replace_retires_old_identity_and_invalidates_work_and_approval() {
    let (s, c, _) = start(Limits::default());
    let path = s.initial_directory().to_owned();
    run(&c, Command::OpenPairing);
    let (h, m, mut ch) = phone(&c, 1, 2);
    work(&c, &h, &mut ch, 1);
    let token = next_work(&c);
    let (d, dm) = attach(&c, 2);
    hello(&c, &d, 3, 1, DeviceKind::Desktop);
    let permit = match c.next_event(WAIT).unwrap() {
        Event::Approval { permit, .. } => permit,
        _ => panic!(),
    };
    run(&c, Command::Replace(identity(9)));
    assert!(!path.exists());
    assert!(m.is_closed() && dm.is_closed());
    assert_eq!(token.status(), WorkStatus::Cancelled);
    assert!(c
        .submit(Command::Approve(permit))
        .unwrap()
        .wait(WAIT)
        .is_err());
    assert!(c
        .submit(Command::Finish {
            token,
            response: b"null".to_vec()
        })
        .unwrap()
        .wait(WAIT)
        .is_err());
    run(&c, Command::OpenPairing);
    let (fresh, fm) = attach(&c, 1);
    let p = hello(&c, &fresh, 2, 9, DeviceKind::Phone);
    p.finish(&fm.receive().unwrap()).unwrap();
    assert!(c
        .submit(Command::Send {
            handle: h,
            encoded: b"null".to_vec()
        })
        .unwrap()
        .wait(WAIT)
        .is_err());
    drop(s);
    assert!(fm.is_closed());
    assert!(c.is_finished());
    assert_eq!(c.retained_bytes(), 0);
}
#[test]
fn carrier_replacement_and_disconnect_invalidate_approval_before_accept() {
    let (s, c, _) = start(Limits::default());
    run(&c, Command::OpenPairing);
    let (h, m) = attach(&c, 1);
    hello(&c, &h, 2, 1, DeviceKind::Desktop);
    let permit = match c.next_event(WAIT).unwrap() {
        Event::Approval { permit, .. } => permit,
        _ => panic!(),
    };
    let (new, nm) = attach(&c, 1);
    closed(&c, &h, CloseReason::Replaced);
    assert!(c
        .submit(Command::Approve(permit))
        .unwrap()
        .wait(WAIT)
        .is_err());
    assert!(m.is_closed());
    assert_eq!(m.delivery_attempts(), 0);
    run(&c, Command::Disconnect(new.clone()));
    closed(&c, &new, CloseReason::Disconnected);
    assert!(nm.is_closed());
    drop(s);
}
#[test]
fn request_deadlines_promote_queue_while_carrier_is_idle() {
    let limits = Limits {
        registry: milagre_remote::registry::Limits {
            inflight: 1,
            request_ms: 10,
            queue_wait_ms: 20,
            ..Default::default()
        },
        ..Default::default()
    };
    let (s, c, clock) = start(limits);
    run(&c, Command::OpenPairing);
    let (h, m, mut ch) = phone(&c, 1, 2);
    work(&c, &h, &mut ch, 1);
    let first = next_work(&c);
    work(&c, &h, &mut ch, 2);
    clock.advance_to(11).unwrap();
    let second = next_work(&c);
    assert_eq!(first.status(), WorkStatus::TimedOut);
    assert_eq!(second.id(), 2);
    run(
        &c,
        Command::Finish {
            token: second.clone(),
            response: br#"{"t":"res","id":2,"status":200,"chunk":"","more":false}"#.to_vec(),
        },
    );
    assert_eq!(second.status(), WorkStatus::Completed);
    assert!(ch
        .open_encoded(&m.receive().unwrap())
        .unwrap()
        .starts_with(b"{\"t\":\"res\""));
    drop(s);
}
#[test]
fn unknown_delivery_is_closed_and_never_replayed() {
    let (s, c, _) = start(Limits::default());
    run(&c, Command::OpenPairing);
    let (h, m, _) = phone(&c, 1, 2);
    m.inject_unknown_delivery();
    assert!(matches!(
        c.submit(Command::Send {
            handle: h.clone(),
            encoded: b"null".to_vec()
        })
        .unwrap()
        .wait(WAIT),
        Err(Error::DeliveryUnknown)
    ));
    closed(&c, &h, CloseReason::CarrierFailure);
    assert_eq!(m.delivery_attempts(), 2);
    assert!(m.receive().is_none());
    assert!(c
        .submit(Command::Send {
            handle: h,
            encoded: b"null".to_vec()
        })
        .unwrap()
        .wait(WAIT)
        .is_err());
    assert_eq!(m.delivery_attempts(), 2);
    drop(s);
}
#[test]
fn event_overflow_retires_all_work_instead_of_blocking_deadlines() {
    let (s, c, _) = start(Limits {
        events: 1,
        ..Default::default()
    });
    run(&c, Command::OpenPairing);
    let (h, m, mut ch) = phone(&c, 1, 2);
    work(&c, &h, &mut ch, 1); // leave Work in queue
    let bytes=ch.seal_encoded(br#"{"t":"req","id":2,"method":"GET","path":"/rpc","headers":{},"chunk":"","more":false}"#).unwrap();
    assert!(matches!(
        c.submit(Command::Request {
            handle: h.clone(),
            bytes
        })
        .unwrap()
        .wait(WAIT),
        Err(Error::UnknownOutcome)
    )); // another event exceeds bound
    drop(s);
    assert!(c.is_finished());
    assert_eq!(c.stop_reason(), StopReason::EventOverflow);
    assert!(m.is_closed());
    assert_eq!(c.retained_bytes(), 0);
    assert!(matches!(c.submit(Command::Retire), Err(Error::NotExecuted)));
}
#[test]
fn disposal_joins_worker_closes_all_owned_work_and_clears_undelivered_buffers() {
    let (s, c, _) = start(Limits::default());
    run(&c, Command::OpenPairing);
    let (h, m, mut ch) = phone(&c, 1, 2);
    work(&c, &h, &mut ch, 1);
    let token = next_work(&c);
    run(
        &c,
        Command::Send {
            handle: h.clone(),
            encoded: b"null".to_vec(),
        },
    );
    let (pending, pm) = attach(&c, 2);
    let path = s.initial_directory().to_owned();
    assert!(c.retained_bytes() > 0);
    drop(s);
    assert!(c.is_finished());
    assert!(!path.exists());
    assert_eq!(token.status(), WorkStatus::Cancelled);
    assert!(m.is_closed() && pm.is_closed());
    assert!(m.receive().is_none());
    assert_eq!(
        pending.status(),
        CarrierStatus::Closed(CloseReason::Retired)
    );
    assert_eq!(c.retained_bytes(), 0);
}
#[test]
fn carrier_queue_byte_bounds_close_and_release() {
    let (s, c, _) = start(Limits {
        carrier_frames: 1,
        ..Default::default()
    });
    run(&c, Command::OpenPairing);
    let (h, m, _) = phone(&c, 1, 2);
    run(
        &c,
        Command::Send {
            handle: h.clone(),
            encoded: b"null".to_vec(),
        },
    );
    assert!(matches!(
        c.submit(Command::Send {
            handle: h.clone(),
            encoded: b"null".to_vec()
        })
        .unwrap()
        .wait(WAIT),
        Err(Error::DeliveryUnknown)
    ));
    closed(&c, &h, CloseReason::CarrierFailure);
    assert!(m.receive().is_none());
    assert_eq!(c.retained_bytes(), 0);
    drop(s);
}
#[test]
fn invalid_limits_and_oversized_allocated_command_capacity_are_refused() {
    assert!(matches!(
        Supervisor::spawn_synthetic(
            identity(1),
            Limits {
                tick_ms: 0,
                ..Default::default()
            },
            Clock::monotonic()
        ),
        Err(Error::Configuration)
    ));
    let (s, c, clock) = start(Limits {
        command_bytes: 4096,
        ..Default::default()
    });
    let (h, _) = attach(&c, 1);
    let mut bytes = Vec::with_capacity(8192);
    bytes.extend_from_slice(b"bad");
    assert!(matches!(
        c.submit(Command::Hello {
            handle: h,
            source: Source::Relay,
            bytes
        }),
        Err(Error::Full)
    ));
    assert!(clock.advance_to(0).is_err());
    drop(s);
}

#[test]
fn pending_open_flood_cannot_evict_authenticated_desktop_approval() {
    let (s, c, _) = start(Limits::default());
    run(&c, Command::OpenPairing);
    let (h, m) = attach(&c, 1);
    let pending = hello(&c, &h, 2, 1, DeviceKind::Desktop);
    let permit = match c.next_event(WAIT).unwrap() {
        Event::Approval { permit, .. } => permit,
        _ => panic!(),
    };
    for id in 2..34 {
        attach(&c, id);
    }
    assert_eq!(h.status(), CarrierStatus::Pending);
    run(&c, Command::Approve(permit));
    pending.finish(&m.receive().unwrap()).unwrap();
    assert_eq!(h.status(), CarrierStatus::Active);
    drop(s);
    assert_eq!(c.retained_bytes(), 0);
}
#[test]
fn failed_removal_persistence_still_revokes_and_retires_other_work() {
    let (s, c, _) = start(Limits::default());
    run(&c, Command::OpenPairing);
    let (h, m, _) = phone(&c, 1, 2);
    let (other, other_memory, _) = phone(&c, 2, 3);
    let records = s.initial_directory().join("records.json");
    std::fs::remove_file(&records).unwrap();
    std::fs::create_dir(&records).unwrap();
    assert!(matches!(
        c.submit(Command::RemoveDevice(base64_key(2)))
            .unwrap()
            .wait(WAIT),
        Err(Error::Policy(_))
    ));
    assert_eq!(h.status(), CarrierStatus::Closed(CloseReason::Removed));
    assert_eq!(other.status(), CarrierStatus::Closed(CloseReason::Retired));
    assert!(m.is_closed() && other_memory.is_closed());
    assert!(c.submit(Command::OpenPairing).unwrap().wait(WAIT).is_err());
    std::fs::remove_dir(records).unwrap();
    drop(s);
    assert_eq!(c.retained_bytes(), 0);
}
#[test]
fn realtime_idle_timer_and_explicit_retire_need_no_caller_tick() {
    let limits = Limits {
        registry: milagre_remote::registry::Limits {
            hello_ms: 50,
            ..Default::default()
        },
        tick_ms: 5,
        ..Default::default()
    };
    let s = Supervisor::spawn_synthetic(identity(1), limits, Clock::monotonic()).unwrap();
    let c = s.client();
    let (h, m) = attach(&c, 1);
    closed(&c, &h, CloseReason::HelloTimeout);
    assert!(m.is_closed());
    run(&c, Command::OpenPairing);
    let (h, m) = attach(&c, 2);
    run(&c, Command::Retire);
    closed(&c, &h, CloseReason::Retired);
    assert!(m.is_closed());
    assert!(c.submit(Command::OpenPairing).unwrap().wait(WAIT).is_err());
    drop(s);
    assert!(c.is_finished());
}

#[test]
fn thousand_pending_evictions_without_event_consumer_preserve_phones_and_authoritative_events() {
    let (s, c, _) = start(Limits::default());
    run(&c, Command::OpenPairing);
    let (phone_handle, phone_memory, mut channel) = phone(&c, 1, 2);
    for id in 2..1002 {
        attach(&c, id);
    }
    assert_eq!(c.stop_reason(), StopReason::Running);
    assert_eq!(phone_handle.status(), CarrierStatus::Active);
    assert!(!phone_memory.is_closed());
    let stats = c.event_stats();
    assert_eq!(stats.advisory, 64);
    assert_eq!(stats.authoritative, 0);
    assert!(stats.closed_dropped > 900);
    work(&c, &phone_handle, &mut channel, 1);
    let (desktop, memory) = attach(&c, 1002);
    let pending = hello(&c, &desktop, 3, 1, DeviceKind::Desktop);
    assert_eq!(c.event_stats().authoritative, 2);
    let token = next_work(&c); // authoritative events skip the queued advisory closures
    let permit = match c.next_event(WAIT).unwrap() {
        Event::Approval { permit, .. } => permit,
        _ => panic!(),
    };
    run(&c, Command::Approve(permit));
    pending.finish(&memory.receive().unwrap()).unwrap();
    run(
        &c,
        Command::Finish {
            token,
            response: b"null".to_vec(),
        },
    );
    assert_eq!(
        channel
            .open_encoded(&phone_memory.receive().unwrap())
            .unwrap(),
        b"null"
    );
    assert_eq!(c.stop_reason(), StopReason::Running);
    drop(s);
    assert_eq!(c.retained_bytes(), 0);
}
#[test]
fn one_event_slot_drops_advisories_and_still_delivers_approval() {
    let (s, c, _) = start(Limits {
        events: 1,
        ..Default::default()
    });
    run(&c, Command::OpenPairing);
    for _ in 0..20 {
        attach(&c, 1);
    }
    assert_eq!(c.event_stats().advisory, 0);
    assert_eq!(c.event_stats().closed_dropped, 19);
    let (h, m) = attach(&c, 1);
    let pending = hello(&c, &h, 2, 1, DeviceKind::Desktop);
    let permit = match c.next_event(WAIT).unwrap() {
        Event::Approval { permit, .. } => permit,
        _ => panic!(),
    };
    run(&c, Command::Approve(permit));
    pending.finish(&m.receive().unwrap()).unwrap();
    assert_eq!(c.stop_reason(), StopReason::Running);
    drop(s);
    assert_eq!(c.retained_bytes(), 0);
}

#[test]
fn authoritative_event_evicts_advisory_from_full_queue() {
    let (s, c, _) = start(Limits {
        events: 2,
        ..Default::default()
    });
    run(&c, Command::OpenPairing);
    attach(&c, 9);
    attach(&c, 9); // one advisory
    let (h, _, mut ch) = phone(&c, 1, 2);
    work(&c, &h, &mut ch, 1); // fills queue
    assert_eq!(c.event_stats().advisory, 1);
    assert_eq!(c.event_stats().authoritative, 1);
    let (d, m) = attach(&c, 2);
    let pending = hello(&c, &d, 3, 1, DeviceKind::Desktop);
    assert_eq!(c.event_stats().advisory, 0);
    assert_eq!(c.event_stats().authoritative, 2);
    assert_eq!(c.event_stats().closed_dropped, 1);
    next_work(&c);
    let permit = match c.next_event(WAIT).unwrap() {
        Event::Approval { permit, .. } => permit,
        _ => panic!(),
    };
    run(&c, Command::Approve(permit));
    pending.finish(&m.receive().unwrap()).unwrap();
    drop(s);
    assert_eq!(c.retained_bytes(), 0);
}

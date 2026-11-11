use super::*;

#[test]
fn registered_total_includes_preparation_and_spawn_does_not_reset_it() {
    let start = Instant::now();
    let prelaunch = start + Duration::from_secs(5);
    for spawn_seconds in [0, 4, 29] {
        let timing = Timing::registered(prelaunch, start + Duration::from_secs(spawn_seconds)).unwrap();
        assert_eq!(timing.until, start + Duration::from_secs(30));
        assert_eq!(timing.read_until(), start + Duration::from_secs((spawn_seconds + 5).min(30)));
    }
}

#[test]
fn receipt_bytes_do_not_extend_validation_deadline() {
    let start = Instant::now();
    let shared = Shared::new();
    let mut timing = Timing::registered(start + Duration::from_secs(5), start).unwrap();
    timing.received(start + Duration::from_secs(4)).unwrap();
    assert_eq!(timing.read_until(), start + Duration::from_secs(5));
    assert_eq!(timing.received(start + Duration::from_secs(5)), Err(Error::Deadline));
    assert_eq!(timing.validated(&shared, start + Duration::from_secs(5)), Err(Error::Deadline));
    assert_eq!(timing.read_until(), start + Duration::from_secs(5));
    timing.validated(&shared, start + Duration::from_secs(4)).unwrap();
    assert_eq!(timing.read_until(), start + Duration::from_secs(14));
}

#[test]
fn read_idle_renews_on_data_but_never_extends_total() {
    let start = Instant::now();
    let shared = Shared::new();
    let mut timing = Timing::registered(start + Duration::from_secs(5), start).unwrap();
    timing.received(start + Duration::from_secs(1)).unwrap();
    timing.validated(&shared, start + Duration::from_secs(1)).unwrap();
    assert_eq!(timing.read_until(), start + Duration::from_secs(11));
    assert_eq!(timing.received(start + Duration::from_secs(11)), Err(Error::Deadline));
    timing.received(start + Duration::from_secs(10)).unwrap();
    assert_eq!(timing.read_until(), start + Duration::from_secs(20));
    timing.received(start + Duration::from_secs(19)).unwrap();
    assert_eq!(timing.read_until(), start + Duration::from_secs(29));
    timing.received(start + Duration::from_secs(28)).unwrap();
    assert_eq!(timing.read_until(), start + Duration::from_secs(30));
    assert_eq!(timing.received(start + Duration::from_secs(30)), Err(Error::Deadline));
}

#[test]
fn cancellation_before_receipt_validation_stays_revoked() {
    let start = Instant::now();
    let shared = Shared::new();
    let mut timing = Timing::registered(start + Duration::from_secs(5), start).unwrap();
    timing.received(start + Duration::from_secs(1)).unwrap();
    shared.revoke();
    assert_eq!(timing.validated(&shared, start + Duration::from_secs(1)), Err(Error::Revoked));
    assert_eq!(timing.read_until(), start + Duration::from_secs(5));
}

#[test]
fn wrapper_keeps_its_existing_execution_budget_without_receipt_or_idle_caps() {
    let start = Instant::now();
    let shared = Shared::new();
    let mut timing = Timing::wrapper(start);
    timing.received(start + Duration::from_secs(12)).unwrap();
    timing.validated(&shared, start + Duration::from_secs(12)).unwrap();
    assert_eq!(timing.read_until(), start + Duration::from_secs(30));
    timing.received(start + Duration::from_secs(25)).unwrap();
    assert_eq!(timing.read_until(), start + Duration::from_secs(30));
    assert!(timing.receipt.is_none() && timing.idle.is_none());
}

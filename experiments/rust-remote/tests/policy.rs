use milagre_remote::{
    admission::{AdmissionError, Lane, Limits as AdmissionLimits, Scope, Source},
    channel::{phone_hello, DesktopAccess, DeviceKind, HelloOptions},
    policy::{Limits, PolicyError, TemporaryAuthority},
    SecretKey,
};
use rand_core::OsRng;
const TOKEN: &str = "synthetic-policy-token-never-real";
fn authority(limits: Limits) -> TemporaryAuthority {
    TemporaryAuthority::create_synthetic(
        SecretKey::from([1; 32]),
        TOKEN.into(),
        DesktopAccess::Enabled,
        limits,
        &mut OsRng,
    )
    .unwrap()
}
fn hello(seed: u8, kind: DeviceKind, token: &str) -> Vec<u8> {
    phone_hello(
        &SecretKey::from([seed; 32]),
        &SecretKey::from([1; 32]).public_key(),
        token,
        HelloOptions {
            kind: Some(kind),
            ..Default::default()
        },
        &mut OsRng,
    )
    .unwrap()
    .0
}
#[test]
fn new_phones_commit_before_release_in_same_window_and_known_reconnects() {
    let mut a = authority(Limits::default());
    let path = a.temporary_directory().to_owned();
    assert!(path.join("RUST_REMOTE_SYNTHETIC_ONLY").is_file());
    assert!(a
        .begin(
            Source::Direct(1),
            &hello(2, DeviceKind::Phone, TOKEN),
            0,
            &mut OsRng
        )
        .is_err());
    a.open_pairing(1).unwrap();
    let ticket = a
        .begin(
            Source::Direct(1),
            &hello(2, DeviceKind::Phone, TOKEN),
            1,
            &mut OsRng,
        )
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(path.join("records.json")).unwrap(),
        "{}\n"
    );
    let auth = a.complete(ticket, || 2).unwrap();
    let records = std::fs::read_to_string(path.join("records.json")).unwrap();
    assert!(records.contains(&auth.device().key));
    assert!(!records.contains(TOKEN));
    assert!(auth.device().first_pairing);
    let second = a
        .begin(
            Source::Direct(1),
            &hello(4, DeviceKind::Phone, TOKEN),
            3,
            &mut OsRng,
        )
        .unwrap();
    assert!(a.complete(second, || 3).unwrap().device().first_pairing);
    let known = a
        .begin(
            Source::Direct(1),
            &hello(2, DeviceKind::Phone, TOKEN),
            3,
            &mut OsRng,
        )
        .unwrap();
    assert!(!a.complete(known, || 3).unwrap().device().first_pairing);
    drop(a);
    assert!(!path.exists());
}
#[test]
fn desktop_requires_trusted_owner_event_and_kind_cannot_escalate() {
    let mut a = authority(Limits::default());
    a.open_pairing(1).unwrap();
    let bytes = hello(2, DeviceKind::Desktop, TOKEN);
    let ticket = a.begin(Source::Direct(1), &bytes, 1, &mut OsRng).unwrap();
    assert!(matches!(a.complete(ticket, || 1), Err(PolicyError::Denied)));
    let ticket = a.begin(Source::Direct(1), &bytes, 2, &mut OsRng).unwrap();
    a.approve_desktop(&ticket, 2).unwrap();
    let auth = a.complete(ticket, || 2).unwrap();
    assert_eq!(auth.device().kind, DeviceKind::Desktop);
    assert!(matches!(
        a.begin(
            Source::Direct(1),
            &hello(2, DeviceKind::Phone, TOKEN),
            3,
            &mut OsRng
        ),
        Err(PolicyError::Denied)
    ));
    let mut no_desktop = TemporaryAuthority::create_synthetic(
        SecretKey::from([1; 32]),
        TOKEN.into(),
        DesktopAccess::Disabled,
        Limits::default(),
        &mut OsRng,
    )
    .unwrap();
    no_desktop.open_pairing(1).unwrap();
    assert!(matches!(
        no_desktop.begin(Source::Direct(1), &bytes, 1, &mut OsRng),
        Err(PolicyError::Denied)
    ));
}
#[test]
fn removal_blocks_current_window_and_invalidates_known_tickets() {
    let mut a = authority(Limits::default());
    a.open_pairing(1).unwrap();
    let bytes = hello(2, DeviceKind::Phone, TOKEN);
    let t = a.begin(Source::Direct(1), &bytes, 1, &mut OsRng).unwrap();
    let key = a.complete(t, || 1).unwrap().device().key.clone();
    a.open_pairing(2).unwrap();
    let pending = a.begin(Source::Direct(1), &bytes, 2, &mut OsRng).unwrap();
    a.remove(
        &mut milagre_remote::registry::Registry::new(Default::default(), &mut OsRng).unwrap(),
        &key,
        2,
    )
    .unwrap();
    assert!(matches!(
        a.complete(pending, || 2),
        Err(PolicyError::Denied)
    ));
    assert!(a.begin(Source::Direct(1), &bytes, 2, &mut OsRng).is_err());
    a.open_pairing(2).unwrap(); // strict <, a same-timestamp reopen does not bypass removal
    assert!(a.begin(Source::Direct(1), &bytes, 2, &mut OsRng).is_err());
    a.open_pairing(3).unwrap();
    let t = a.begin(Source::Direct(1), &bytes, 3, &mut OsRng).unwrap();
    assert!(a.complete(t, || 3).unwrap().device().first_pairing);
}
#[test]
fn grant_races_replacements_cancel_and_foreign_tickets_never_release_channels() {
    let mut a = authority(Limits::default());
    a.open_pairing(1).unwrap();
    let t1 = a
        .begin(
            Source::Direct(1),
            &hello(2, DeviceKind::Phone, TOKEN),
            1,
            &mut OsRng,
        )
        .unwrap();
    let t2 = a
        .begin(
            Source::Direct(2),
            &hello(3, DeviceKind::Phone, TOKEN),
            1,
            &mut OsRng,
        )
        .unwrap();
    a.complete(t1, || 1).unwrap();
    assert!(a.complete(t2, || 1).unwrap().device().first_pairing);
    a.open_pairing(2).unwrap();
    let old = a
        .begin(
            Source::Direct(2),
            &hello(4, DeviceKind::Phone, TOKEN),
            2,
            &mut OsRng,
        )
        .unwrap();
    let next = a
        .begin(
            Source::Direct(2),
            &hello(4, DeviceKind::Phone, TOKEN),
            2,
            &mut OsRng,
        )
        .unwrap();
    assert!(matches!(a.complete(old, || 2), Err(PolicyError::Denied)));
    a.cancel(next).unwrap();
    let stale = a
        .begin(
            Source::Direct(2),
            &hello(4, DeviceKind::Phone, TOKEN),
            2,
            &mut OsRng,
        )
        .unwrap();
    a.open_pairing(3).unwrap();
    assert!(matches!(a.complete(stale, || 3), Err(PolicyError::Denied)));
    let ticket = a
        .begin(
            Source::Direct(2),
            &hello(4, DeviceKind::Phone, TOKEN),
            3,
            &mut OsRng,
        )
        .unwrap();
    let mut b = authority(Limits::default());
    assert!(matches!(b.complete(ticket, || 3), Err(PolicyError::Denied)));
    assert_eq!(a.expire(600_003).unwrap(), 1);
}
#[test]
fn failure_quotas_bound_source_churn_and_reset_at_deadline() {
    let mut a = authority(Limits {
        admission: AdmissionLimits {
            failures_per_source: 1,
            failures_global: 3,
            sources: 1,
            failure_window_ms: 10,
            ..Default::default()
        },
        ..Default::default()
    });
    assert!(matches!(
        a.begin(Source::Direct(1), &bad_hello(), 0, &mut OsRng),
        Err(PolicyError::Protocol(_))
    ));
    assert!(matches!(
        a.begin(Source::Direct(1), &bad_hello(), 1, &mut OsRng),
        Err(PolicyError::Admission(AdmissionError::FailureQuota {
            scope: Scope::DirectSource,
            retry_at_ms: 10
        }))
    ));
    for id in 2..=3 {
        assert!(matches!(
            a.begin(Source::Direct(id), &bad_hello(), 1, &mut OsRng),
            Err(PolicyError::Protocol(_))
        ));
    }
    for id in 4..10_000 {
        assert!(matches!(
            a.begin(Source::Direct(id), &bad_hello(), 9, &mut OsRng),
            Err(PolicyError::Admission(AdmissionError::FailureQuota {
                scope: Scope::GlobalEnrollment,
                retry_at_ms: 10
            }))
        ));
    }
    let state = a.admission_status(Source::Direct(1), 9).unwrap();
    assert_eq!(state.source_entries, 1);
    assert_eq!(state.enrollment_failures, 3);
    assert_eq!(state.failures.untracked_source, 2);
    assert_eq!(state.enrollment_units_remaining, 13); // only three admitted crypto failures
    assert!(
        state.source_table_full && state.global_enrollment_locked && state.direct_source_locked
    );
    assert!(matches!(
        a.begin(Source::Direct(3), &bad_hello(), 10, &mut OsRng),
        Err(PolicyError::Protocol(_))
    ));
    assert_eq!(
        a.admission_status(Source::Direct(1), 10)
            .unwrap()
            .direct_source_failures,
        0
    );
    assert!(matches!(
        a.begin(Source::Direct(3), &bad_hello(), 9, &mut OsRng),
        Err(PolicyError::Time)
    ));
    assert!(matches!(
        a.admission_status(Source::Relay, u64::MAX),
        Err(PolicyError::Admission(AdmissionError::Clock))
    ));
}
#[test]
fn bad_token_counts_failure_success_does_not_spend_pairing_window() {
    let mut a = authority(Limits {
        admission: AdmissionLimits {
            known_key_units: 64,
            ..Default::default()
        },
        ..Default::default()
    });
    a.open_pairing(1).unwrap();
    assert!(matches!(
        a.begin(
            Source::Relay,
            &hello(2, DeviceKind::Phone, "wrong"),
            1,
            &mut OsRng
        ),
        Err(PolicyError::Protocol(milagre_remote::Error::BadToken))
    ));
    let t = a
        .begin(
            Source::Relay,
            &hello(2, DeviceKind::Phone, TOKEN),
            1,
            &mut OsRng,
        )
        .unwrap();
    a.complete(t, || 1).unwrap();
    for _ in 0..40 {
        let t = a
            .begin(
                Source::Relay,
                &hello(2, DeviceKind::Phone, TOKEN),
                1,
                &mut OsRng,
            )
            .unwrap();
        assert!(!a.complete(t, || 1).unwrap().device().first_pairing);
    }
    let state = a.admission_status(Source::Relay, 1).unwrap();
    assert_eq!(state.enrollment_failures, 1);
    assert_eq!(state.failures.bad_token, 1);
    assert_eq!(state.known_units_remaining, 24);
}
#[test]
fn pending_record_capacity_expiry_retirement_and_overflow_fail_closed() {
    let mut a = authority(Limits {
        records: 1,
        pending: 2,
        pending_desktops: 1,
        pairing_window_ms: 10,
        ..Default::default()
    });
    a.open_pairing(1).unwrap();
    let d = a
        .begin(
            Source::Direct(1),
            &hello(2, DeviceKind::Desktop, TOKEN),
            1,
            &mut OsRng,
        )
        .unwrap();
    assert!(matches!(
        a.begin(
            Source::Direct(2),
            &hello(3, DeviceKind::Desktop, TOKEN),
            1,
            &mut OsRng
        ),
        Err(PolicyError::Limited)
    ));
    let p = a
        .begin(
            Source::Direct(3),
            &hello(4, DeviceKind::Phone, TOKEN),
            1,
            &mut OsRng,
        )
        .unwrap();
    assert!(matches!(
        a.begin(Source::Direct(4), b"bad", 1, &mut OsRng),
        Err(PolicyError::Limited)
    ));
    assert_eq!(a.expire(11).unwrap(), 2);
    assert!(a.approve_desktop(&d, 11).is_err());
    assert!(a.complete(p, || 11).is_err());
    a.open_pairing(12).unwrap();
    let t = a
        .begin(
            Source::Direct(1),
            &hello(2, DeviceKind::Phone, TOKEN),
            12,
            &mut OsRng,
        )
        .unwrap();
    a.complete(t, || 12).unwrap();
    a.open_pairing(13).unwrap();
    let t = a
        .begin(
            Source::Direct(1),
            &hello(3, DeviceKind::Phone, TOKEN),
            13,
            &mut OsRng,
        )
        .unwrap();
    assert!(matches!(a.complete(t, || 13), Err(PolicyError::Limited)));
    let known = a
        .begin(
            Source::Direct(1),
            &hello(2, DeviceKind::Phone, TOKEN),
            13,
            &mut OsRng,
        )
        .unwrap();
    a.retire();
    assert!(a.complete(known, || 13).is_err());
    assert!(a.open_pairing(14).is_err());
    let mut b = authority(Limits::default());
    assert!(matches!(b.open_pairing(u64::MAX), Err(PolicyError::Time)));
}
#[test]
fn failed_commit_never_releases_reply_or_allows_retry() {
    let mut a = authority(Limits::default());
    a.open_pairing(1).unwrap();
    let t = a
        .begin(
            Source::Direct(1),
            &hello(2, DeviceKind::Phone, TOKEN),
            1,
            &mut OsRng,
        )
        .unwrap();
    // Only our newly created test capability is touched. Force rename to fail.
    let records = a.temporary_directory().join("records.json");
    std::fs::remove_file(&records).unwrap();
    std::fs::create_dir(&records).unwrap();
    assert!(matches!(a.complete(t, || 1), Err(PolicyError::Storage(_))));
    assert!(matches!(
        a.begin(
            Source::Direct(1),
            &hello(2, DeviceKind::Phone, TOKEN),
            2,
            &mut OsRng
        ),
        Err(PolicyError::Denied)
    ));
    assert!(a.open_pairing(2).is_err());
    std::fs::remove_dir(records).unwrap();
}
#[test]
fn persistence_permissions_and_no_import_path() {
    let a = authority(Limits::default());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(a.temporary_directory())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(a.temporary_directory().join("records.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    assert_eq!(
        std::fs::read_dir(a.temporary_directory()).unwrap().count(),
        2
    );
}
#[test]
fn deadline_rechecked_after_persistence_and_before_channel_release() {
    let mut a = authority(Limits {
        pairing_window_ms: 10,
        ..Default::default()
    });
    a.open_pairing(1).unwrap();
    let t = a
        .begin(
            Source::Direct(1),
            &hello(2, DeviceKind::Phone, TOKEN),
            1,
            &mut OsRng,
        )
        .unwrap();
    let key = a.pending_device(&t).unwrap().key.clone();
    let mut calls = 0;
    let result = a.complete(t, || {
        calls += 1;
        if calls == 1 {
            1
        } else {
            11
        }
    });
    assert_eq!(calls, 2);
    assert!(matches!(
        result,
        Err(PolicyError::Protocol(milagre_remote::Error::Unauthorized))
    ));
    assert!(
        std::fs::read_to_string(a.temporary_directory().join("records.json"))
            .unwrap()
            .contains(&key)
    );
    assert!(a
        .begin(
            Source::Direct(1),
            &hello(3, DeviceKind::Phone, TOKEN),
            12,
            &mut OsRng
        )
        .is_err());
    let known = a
        .begin(
            Source::Direct(1),
            &hello(2, DeviceKind::Phone, TOKEN),
            12,
            &mut OsRng,
        )
        .unwrap();
    assert!(!a.complete(known, || 12).unwrap().device().first_pairing);
}
#[test]
fn sessions_share_connection_and_device_budgets_and_enforce_admission() {
    let mut a = authority(Limits::default());
    a.open_pairing(1).unwrap();
    let bytes = hello(2, DeviceKind::Phone, TOKEN);
    let mut sessions = Vec::new();
    for _ in 0..4 {
        let t = a.begin(Source::Direct(1), &bytes, 1, &mut OsRng).unwrap();
        sessions.push(a.complete(t, || 1).unwrap());
    }
    let t = a.begin(Source::Direct(1), &bytes, 1, &mut OsRng).unwrap();
    assert!(matches!(a.complete(t, || 1), Err(PolicyError::Limited)));
    let lease = sessions[0].budget().reserve(40 * 1024 * 1024).unwrap();
    assert!(sessions[1].budget().reserve(40 * 1024 * 1024).is_err());
    assert_eq!(sessions[1].budget().used(), 0);
    drop(lease);
    let output = sessions[0]
        .writer(milagre_remote::peer::Direction::Rpc)
        .unwrap()
        .write("null")
        .unwrap();
    let before = sessions[0].budget().used();
    let raw = sessions[0]
        .reader(milagre_remote::peer::Direction::Rpc)
        .unwrap()
        .read(&output[0], 0)
        .unwrap()
        .unwrap();
    assert!(sessions[0].budget().used() > before);
    drop(raw);
    drop(output);
    assert_eq!(sessions[0].budget().used(), 0);
    sessions.pop();
    let t = a.begin(Source::Direct(1), &bytes, 1, &mut OsRng).unwrap();
    assert!(a.complete(t, || 1).is_ok());
}
#[test]
fn service_global_session_admission_precedes_new_record_commit() {
    let mut a = authority(Limits {
        admission: AdmissionLimits {
            failures_global: 100,
            failures_per_source: 100,
            ..Default::default()
        },
        ..Default::default()
    });
    let mut sessions = Vec::new();
    for seed in 2..6 {
        a.open_pairing(1).unwrap();
        for _ in 0..4 {
            let t = a
                .begin(
                    Source::Direct(1),
                    &hello(seed, DeviceKind::Phone, TOKEN),
                    1,
                    &mut OsRng,
                )
                .unwrap();
            sessions.push(a.complete(t, || 1).unwrap());
        }
    }
    a.open_pairing(1).unwrap();
    let before = std::fs::read(a.temporary_directory().join("records.json")).unwrap();
    let t = a
        .begin(
            Source::Direct(1),
            &hello(6, DeviceKind::Phone, TOKEN),
            1,
            &mut OsRng,
        )
        .unwrap();
    assert!(matches!(a.complete(t, || 1), Err(PolicyError::Limited)));
    assert_eq!(
        std::fs::read(a.temporary_directory().join("records.json")).unwrap(),
        before
    );
    sessions.pop();
    let t = a
        .begin(
            Source::Direct(1),
            &hello(6, DeviceKind::Phone, TOKEN),
            1,
            &mut OsRng,
        )
        .unwrap();
    assert!(a.complete(t, || 1).unwrap().device().first_pairing);
}

#[test]
fn relay_garbage_flood_does_not_lock_known_or_new_phones() {
    let mut a = authority(Limits::default());
    a.open_pairing(1).unwrap();
    let valid = hello(2, DeviceKind::Phone, TOKEN);
    let ticket = a.begin(Source::Relay, &valid, 1, &mut OsRng).unwrap();
    a.complete(ticket, || 1).unwrap();
    for _ in 0..8 {
        assert!(a.begin(Source::Direct(1), b"bad", 1, &mut OsRng).is_err());
    }
    let oversized = vec![1; milagre_remote::channel::MAX_HELLO_BYTES + 1];
    for i in 0..1000 {
        let bytes = if i % 2 == 0 {
            b"bad".as_slice()
        } else {
            &oversized
        };
        assert!(a.begin(Source::Relay, bytes, 1, &mut OsRng).is_err());
    }
    let state = a.admission_status(Source::Direct(1), 1).unwrap();
    assert!(!state.global_enrollment_locked && !state.direct_source_locked);
    assert_eq!(state.failures.bad_hello, 1008);
    assert_eq!(state.known_units_remaining, 64);
    assert_eq!(state.enrollment_units_remaining, 15);
    for source in [Source::Relay, Source::Direct(1)] {
        let t = a.begin(source, &valid, 1, &mut OsRng).unwrap();
        assert!(!a.complete(t, || 1).unwrap().device().first_pairing);
    }
    assert_eq!(
        a.admission_status(Source::Relay, 1)
            .unwrap()
            .enrollment_failures,
        0
    );
    let t = a
        .begin(
            Source::Relay,
            &hello(3, DeviceKind::Phone, TOKEN),
            1,
            &mut OsRng,
        )
        .unwrap();
    assert!(a.complete(t, || 1).unwrap().device().first_pairing);
}

#[test]
fn crypto_lanes_bound_unknown_flood_and_expose_targeted_known_saturation() {
    let mut a = authority(Limits {
        admission: AdmissionLimits {
            known_crypto_units: 2,
            enrollment_crypto_units: 2,
            ..Default::default()
        },
        ..Default::default()
    });
    a.open_pairing(1).unwrap();
    let valid = hello(2, DeviceKind::Phone, TOKEN);
    let t = a.begin(Source::Relay, &valid, 1, &mut OsRng).unwrap();
    a.complete(t, || 1).unwrap();
    let mut unknown = hello(3, DeviceKind::Phone, TOKEN);
    *unknown.last_mut().unwrap() ^= 1;
    assert!(matches!(
        a.begin(Source::Relay, &unknown, 1, &mut OsRng),
        Err(PolicyError::Protocol(_))
    ));
    assert!(matches!(
        a.begin(Source::Relay, &unknown, 1, &mut OsRng),
        Err(PolicyError::Admission(AdmissionError::Saturated {
            lane: Lane::Enrollment,
            retry_at_ms: 1001
        }))
    ));
    let t = a.begin(Source::Relay, &valid, 1, &mut OsRng).unwrap();
    a.complete(t, || 1).unwrap();
    let mut spoofed_known = valid.clone();
    *spoofed_known.last_mut().unwrap() ^= 1;
    assert!(matches!(
        a.begin(Source::Relay, &spoofed_known, 1, &mut OsRng),
        Err(PolicyError::Protocol(_))
    ));
    assert!(matches!(
        a.begin(Source::Relay, &valid, 1, &mut OsRng),
        Err(PolicyError::Admission(AdmissionError::Saturated {
            lane: Lane::KnownCandidate,
            retry_at_ms: 1001
        }))
    ));
    let state = a.admission_status(Source::Relay, 1).unwrap();
    assert_eq!(state.known_units_remaining, 0);
    assert_eq!(state.enrollment_failures, 1); // known-key spoof did not spend enrollment quota
    assert_eq!(state.failures.known_candidate, 1);
    for _ in 0..31 {
        let _ = a.begin(Source::Relay, b"bad", 1, &mut OsRng);
    }
    assert!(
        !a.admission_status(Source::Relay, 1000)
            .unwrap()
            .global_enrollment_locked
    );
    let t = a.begin(Source::Relay, &valid, 1001, &mut OsRng).unwrap();
    a.complete(t, || 1001).unwrap();
    assert!(
        !a.admission_status(Source::Relay, 1001)
            .unwrap()
            .global_enrollment_locked
    );
}

#[test]
fn crypto_work_charges_bounded_bytes_before_decryption() {
    let mut a = authority(Limits {
        admission: AdmissionLimits {
            enrollment_crypto_units: 4,
            ..Default::default()
        },
        ..Default::default()
    });
    let mut large = vec![0; milagre_remote::channel::MAX_HELLO_BYTES];
    large[0] = 1;
    assert!(matches!(
        a.begin(Source::Relay, &large, 0, &mut OsRng),
        Err(PolicyError::Protocol(_))
    ));
    assert_eq!(
        a.admission_status(Source::Relay, 0)
            .unwrap()
            .enrollment_units_remaining,
        0
    );
    assert!(matches!(
        a.begin(Source::Relay, &large, 0, &mut OsRng),
        Err(PolicyError::Admission(AdmissionError::Saturated {
            lane: Lane::Enrollment,
            ..
        }))
    ));
    assert_eq!(
        a.admission_status(Source::Relay, 1000)
            .unwrap()
            .enrollment_units_remaining,
        4
    );
}

#[test]
fn one_window_allows_multiple_devices_but_each_desktop_requires_own_approval() {
    let mut a = authority(Limits::default());
    a.open_pairing(1).unwrap();
    let mut tickets = Vec::new();
    for (seed, kind) in [
        (2, DeviceKind::Phone),
        (3, DeviceKind::Phone),
        (4, DeviceKind::Desktop),
        (5, DeviceKind::Desktop),
    ] {
        tickets.push(
            a.begin(Source::Relay, &hello(seed, kind, TOKEN), 1, &mut OsRng)
                .unwrap(),
        );
    }
    a.approve_desktop(&tickets[2], 1).unwrap();
    for ticket in tickets.drain(..3) {
        assert!(a.complete(ticket, || 1).unwrap().device().first_pairing);
    }
    assert!(matches!(
        a.complete(tickets.pop().unwrap(), || 1),
        Err(PolicyError::Denied)
    ));
    let ticket = a
        .begin(
            Source::Relay,
            &hello(5, DeviceKind::Desktop, TOKEN),
            1,
            &mut OsRng,
        )
        .unwrap();
    a.approve_desktop(&ticket, 1).unwrap();
    assert!(a.complete(ticket, || 1).unwrap().device().first_pairing);
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/policy-node.json")).unwrap();
    assert_eq!(
        fixture["firstPairing"],
        serde_json::json!([true, true, true, true])
    );
    assert_eq!(fixture["knownAfterWindow"], false);
    assert_eq!(fixture["removedSameWindow"], false);
    assert_eq!(fixture["removedNextWindow"], true);
}

fn bad_hello() -> Vec<u8> {
    let mut bytes = vec![0; 105];
    bytes[0] = 1;
    bytes
}
#[test]
fn cryptographic_failure_lockout_still_admits_known_phone() {
    let mut a = authority(Limits {
        admission: AdmissionLimits {
            enrollment_crypto_units: 64,
            ..Default::default()
        },
        ..Default::default()
    });
    a.open_pairing(1).unwrap();
    let valid = hello(2, DeviceKind::Phone, TOKEN);
    let t = a.begin(Source::Relay, &valid, 1, &mut OsRng).unwrap();
    a.complete(t, || 1).unwrap();
    for i in 0..32 {
        assert!(a
            .begin(
                if i < 8 {
                    Source::Direct(1)
                } else {
                    Source::Relay
                },
                &bad_hello(),
                1,
                &mut OsRng
            )
            .is_err());
    }
    let state = a.admission_status(Source::Direct(1), 1).unwrap();
    assert!(state.global_enrollment_locked && state.direct_source_locked);
    let t = a.begin(Source::Direct(1), &valid, 1, &mut OsRng).unwrap();
    a.complete(t, || 1).unwrap();
}
#[test]
fn spoofed_key_subquota_leaves_other_known_phone_admissible() {
    let mut a = authority(Limits::default());
    a.open_pairing(1).unwrap();
    let first = hello(2, DeviceKind::Phone, TOKEN);
    let second = hello(3, DeviceKind::Phone, TOKEN);
    for bytes in [&first, &second] {
        let t = a.begin(Source::Relay, bytes, 1, &mut OsRng).unwrap();
        a.complete(t, || 1).unwrap();
    }
    let mut spoofed = first;
    *spoofed.last_mut().unwrap() ^= 1;
    for _ in 0..8 {
        assert!(matches!(
            a.begin(Source::Relay, &spoofed, 1, &mut OsRng),
            Err(PolicyError::Protocol(_))
        ));
    }
    for _ in 0..1000 {
        assert!(matches!(
            a.begin(Source::Relay, &spoofed, 1, &mut OsRng),
            Err(PolicyError::Admission(AdmissionError::Saturated {
                lane: Lane::KnownDevice,
                ..
            }))
        ));
    }
    let t = a.begin(Source::Relay, &second, 1, &mut OsRng).unwrap();
    assert!(!a.complete(t, || 1).unwrap().device().first_pairing);
    let state = a.admission_status(Source::Relay, 1).unwrap();
    assert_eq!(state.known_key_entries, 2);
    assert_eq!(state.known_units_remaining, 55);
    assert_eq!(
        a.admission_status(Source::Relay, 1001)
            .unwrap()
            .known_key_entries,
        0
    );
}

#[test]
fn consuming_completion_releases_ticket_even_when_clock_fails() {
    let mut a = authority(Limits {
        pending: 1,
        pending_desktops: 1,
        ..Default::default()
    });
    a.open_pairing(1).unwrap();
    let bytes = hello(2, DeviceKind::Phone, TOKEN);
    let ticket = a.begin(Source::Relay, &bytes, 1, &mut OsRng).unwrap();
    assert!(matches!(a.complete(ticket, || 0), Err(PolicyError::Time)));
    let retry = a.begin(Source::Relay, &bytes, 1, &mut OsRng).unwrap();
    assert!(a.complete(retry, || 1).unwrap().device().first_pairing);
}

use milagre_remote::{
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
fn new_phone_commits_before_release_single_use_grant_keeps_known_reconnects() {
    let mut a = authority(Limits::default());
    let path = a.temporary_directory().to_owned();
    assert!(path.join("RUST_REMOTE_SYNTHETIC_ONLY").is_file());
    assert!(a
        .begin(1, &hello(2, DeviceKind::Phone, TOKEN), 0, &mut OsRng)
        .is_err());
    a.open_pairing(1).unwrap();
    let ticket = a
        .begin(1, &hello(2, DeviceKind::Phone, TOKEN), 1, &mut OsRng)
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
    assert!(a
        .begin(1, &hello(3, DeviceKind::Phone, TOKEN), 3, &mut OsRng)
        .is_err());
    let known = a
        .begin(1, &hello(2, DeviceKind::Phone, TOKEN), 3, &mut OsRng)
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
    let ticket = a.begin(1, &bytes, 1, &mut OsRng).unwrap();
    assert!(matches!(a.complete(ticket, || 1), Err(PolicyError::Denied)));
    let ticket = a.begin(1, &bytes, 2, &mut OsRng).unwrap();
    a.approve_desktop(&ticket, 2).unwrap();
    let auth = a.complete(ticket, || 2).unwrap();
    assert_eq!(auth.device().kind, DeviceKind::Desktop);
    assert!(matches!(
        a.begin(1, &hello(2, DeviceKind::Phone, TOKEN), 3, &mut OsRng),
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
        no_desktop.begin(1, &bytes, 1, &mut OsRng),
        Err(PolicyError::Denied)
    ));
}
#[test]
fn removal_blocks_current_window_and_invalidates_known_tickets() {
    let mut a = authority(Limits::default());
    a.open_pairing(1).unwrap();
    let bytes = hello(2, DeviceKind::Phone, TOKEN);
    let t = a.begin(1, &bytes, 1, &mut OsRng).unwrap();
    let key = a.complete(t, || 1).unwrap().device().key.clone();
    a.open_pairing(2).unwrap();
    let pending = a.begin(1, &bytes, 2, &mut OsRng).unwrap();
    a.remove(&key, 2).unwrap();
    assert!(matches!(
        a.complete(pending, || 2),
        Err(PolicyError::Denied)
    ));
    assert!(a.begin(1, &bytes, 2, &mut OsRng).is_err());
    a.open_pairing(2).unwrap(); // strict <, a same-timestamp reopen does not bypass removal
    assert!(a.begin(1, &bytes, 2, &mut OsRng).is_err());
    a.open_pairing(3).unwrap();
    let t = a.begin(1, &bytes, 3, &mut OsRng).unwrap();
    assert!(a.complete(t, || 3).unwrap().device().first_pairing);
}
#[test]
fn grant_races_replacements_cancel_and_foreign_tickets_never_release_channels() {
    let mut a = authority(Limits::default());
    a.open_pairing(1).unwrap();
    let t1 = a
        .begin(1, &hello(2, DeviceKind::Phone, TOKEN), 1, &mut OsRng)
        .unwrap();
    let t2 = a
        .begin(2, &hello(3, DeviceKind::Phone, TOKEN), 1, &mut OsRng)
        .unwrap();
    a.complete(t1, || 1).unwrap();
    assert!(matches!(a.complete(t2, || 1), Err(PolicyError::Denied)));
    a.open_pairing(2).unwrap();
    let old = a
        .begin(2, &hello(3, DeviceKind::Phone, TOKEN), 2, &mut OsRng)
        .unwrap();
    let next = a
        .begin(2, &hello(3, DeviceKind::Phone, TOKEN), 2, &mut OsRng)
        .unwrap();
    assert!(matches!(a.complete(old, || 2), Err(PolicyError::Denied)));
    a.cancel(next).unwrap();
    let stale = a
        .begin(2, &hello(3, DeviceKind::Phone, TOKEN), 2, &mut OsRng)
        .unwrap();
    a.open_pairing(3).unwrap();
    assert!(matches!(a.complete(stale, || 3), Err(PolicyError::Denied)));
    let ticket = a
        .begin(2, &hello(3, DeviceKind::Phone, TOKEN), 3, &mut OsRng)
        .unwrap();
    let mut b = authority(Limits::default());
    assert!(matches!(b.complete(ticket, || 3), Err(PolicyError::Denied)));
    assert_eq!(a.expire(600_003).unwrap(), 1);
}
#[test]
fn attempt_limits_precede_crypto_bound_source_churn_and_reset_at_deadline() {
    let limits = Limits {
        attempts_per_source: 1,
        attempts_global: 3,
        sources: 1,
        attempt_window_ms: 10,
        ..Default::default()
    };
    let mut a = authority(limits);
    assert!(matches!(
        a.begin(1, b"bad", 0, &mut OsRng),
        Err(PolicyError::Protocol(_))
    ));
    assert!(matches!(
        a.begin(1, b"bad", 1, &mut OsRng),
        Err(PolicyError::Limited)
    ));
    assert!(matches!(
        a.begin(2, b"bad", 1, &mut OsRng),
        Err(PolicyError::Limited)
    ));
    assert!(matches!(
        a.begin(3, b"bad", 9, &mut OsRng),
        Err(PolicyError::Limited)
    ));
    assert!(matches!(
        a.begin(3, b"bad", 10, &mut OsRng),
        Err(PolicyError::Protocol(_))
    ));
    assert!(matches!(
        a.begin(3, b"bad", 9, &mut OsRng),
        Err(PolicyError::Time)
    ));
}
#[test]
fn bad_token_consumes_attempt_but_not_pairing_grant() {
    let mut a = authority(Limits {
        attempts_per_source: 2,
        ..Default::default()
    });
    a.open_pairing(1).unwrap();
    assert!(matches!(
        a.begin(1, &hello(2, DeviceKind::Phone, "wrong"), 1, &mut OsRng),
        Err(PolicyError::Protocol(milagre_remote::Error::BadToken))
    ));
    let t = a
        .begin(1, &hello(2, DeviceKind::Phone, TOKEN), 1, &mut OsRng)
        .unwrap();
    a.complete(t, || 1).unwrap();
    assert!(matches!(
        a.begin(1, &hello(2, DeviceKind::Phone, TOKEN), 1, &mut OsRng),
        Err(PolicyError::Limited)
    ));
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
        .begin(1, &hello(2, DeviceKind::Desktop, TOKEN), 1, &mut OsRng)
        .unwrap();
    assert!(matches!(
        a.begin(2, &hello(3, DeviceKind::Desktop, TOKEN), 1, &mut OsRng),
        Err(PolicyError::Limited)
    ));
    let p = a
        .begin(3, &hello(4, DeviceKind::Phone, TOKEN), 1, &mut OsRng)
        .unwrap();
    assert!(matches!(
        a.begin(4, b"bad", 1, &mut OsRng),
        Err(PolicyError::Limited)
    ));
    assert_eq!(a.expire(11).unwrap(), 2);
    assert!(a.approve_desktop(&d, 11).is_err());
    assert!(a.complete(p, || 11).is_err());
    a.open_pairing(12).unwrap();
    let t = a
        .begin(1, &hello(2, DeviceKind::Phone, TOKEN), 12, &mut OsRng)
        .unwrap();
    a.complete(t, || 12).unwrap();
    a.open_pairing(13).unwrap();
    let t = a
        .begin(1, &hello(3, DeviceKind::Phone, TOKEN), 13, &mut OsRng)
        .unwrap();
    assert!(matches!(a.complete(t, || 13), Err(PolicyError::Limited)));
    let known = a
        .begin(1, &hello(2, DeviceKind::Phone, TOKEN), 13, &mut OsRng)
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
        .begin(1, &hello(2, DeviceKind::Phone, TOKEN), 1, &mut OsRng)
        .unwrap();
    // Only our newly created test capability is touched. Force rename to fail.
    let records = a.temporary_directory().join("records.json");
    std::fs::remove_file(&records).unwrap();
    std::fs::create_dir(&records).unwrap();
    assert!(matches!(a.complete(t, || 1), Err(PolicyError::Storage(_))));
    assert!(matches!(
        a.begin(1, &hello(2, DeviceKind::Phone, TOKEN), 2, &mut OsRng),
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
        .begin(1, &hello(2, DeviceKind::Phone, TOKEN), 1, &mut OsRng)
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
        .begin(1, &hello(3, DeviceKind::Phone, TOKEN), 12, &mut OsRng)
        .is_err());
    let known = a
        .begin(1, &hello(2, DeviceKind::Phone, TOKEN), 12, &mut OsRng)
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
        let t = a.begin(1, &bytes, 1, &mut OsRng).unwrap();
        sessions.push(a.complete(t, || 1).unwrap());
    }
    let t = a.begin(1, &bytes, 1, &mut OsRng).unwrap();
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
    let t = a.begin(1, &bytes, 1, &mut OsRng).unwrap();
    assert!(a.complete(t, || 1).is_ok());
}
#[test]
fn service_global_session_admission_precedes_new_record_commit() {
    let mut a = authority(Limits {
        attempts_global: 100,
        attempts_per_source: 100,
        ..Default::default()
    });
    let mut sessions = Vec::new();
    for seed in 2..6 {
        a.open_pairing(1).unwrap();
        for _ in 0..4 {
            let t = a
                .begin(1, &hello(seed, DeviceKind::Phone, TOKEN), 1, &mut OsRng)
                .unwrap();
            sessions.push(a.complete(t, || 1).unwrap());
        }
    }
    a.open_pairing(1).unwrap();
    let before = std::fs::read(a.temporary_directory().join("records.json")).unwrap();
    let t = a
        .begin(1, &hello(6, DeviceKind::Phone, TOKEN), 1, &mut OsRng)
        .unwrap();
    assert!(matches!(a.complete(t, || 1), Err(PolicyError::Limited)));
    assert_eq!(
        std::fs::read(a.temporary_directory().join("records.json")).unwrap(),
        before
    );
    sessions.pop();
    let t = a
        .begin(1, &hello(6, DeviceKind::Phone, TOKEN), 1, &mut OsRng)
        .unwrap();
    assert!(a.complete(t, || 1).unwrap().device().first_pairing);
}

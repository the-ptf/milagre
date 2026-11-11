use super::*;
use crate::{
    channel::{self, Channel, HelloOptions, PendingHello},
    registry::{CarrierStatus, WorkStatus},
    synthetic_store::{IoStage, StoreLimits, SyntheticProfile},
};
use rand_core::OsRng;
struct Profile(SyntheticProfile);
impl std::ops::Deref for Profile {
    type Target = SyntheticProfile;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl std::ops::DerefMut for Profile {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}
impl Drop for Profile {
    fn drop(&mut self) {
        let _ = self.0.destroy();
    }
}
fn profile(l: StoreLimits) -> Profile {
    Profile(SyntheticProfile::create(l, &mut OsRng).unwrap())
}
fn resume(p: &mut Profile, l: PersistentLimits) -> PersistentAuthority {
    match PersistentAuthority::resume(p.acquire_writer().unwrap(), l, &mut OsRng) {
        OpenedAuthority::Ready(a) => a,
        _ => panic!("expected ready"),
    }
}
fn clean(a: PersistentAuthority) -> StoreDiagnostics {
    a.close_for_restart()
        .unwrap_or_else(|_| panic!("clean close"))
        .diagnostics()
}
fn hello(a: &PersistentAuthority, seed: u8, token: &str) -> (Vec<u8>, PendingHello) {
    channel::phone_hello(
        &SecretKey::from([seed; 32]),
        &a.host_public_key(),
        token,
        HelloOptions::default(),
        &mut OsRng,
    )
    .unwrap()
}
fn pair(a: &mut PersistentAuthority, id: u64, seed: u8, now: u64) -> (Handle, Channel, String) {
    let token = a.with_pairing_invitation(now, str::to_owned).unwrap();
    install(a, id, seed, &token, now)
}
fn install(
    a: &mut PersistentAuthority,
    id: u64,
    seed: u8,
    token: &str,
    now: u64,
) -> (Handle, Channel, String) {
    let (bytes, pending) = hello(a, seed, token);
    let h = a.open_carrier(id, now).unwrap();
    let ticket = a.begin(Source::Relay, &bytes, now, &mut OsRng).unwrap();
    let key = a.pending_device(&ticket).unwrap().key.clone();
    a.complete(&h, ticket, || now).unwrap();
    let mut reply = Vec::new();
    a.take_output(&h, now, |b| {
        reply.extend_from_slice(b);
        Ok(())
    })
    .unwrap();
    (h, pending.finish(&reply).unwrap(), key)
}
fn request(
    a: &mut PersistentAuthority,
    h: &Handle,
    c: &mut Channel,
    id: i64,
    now: u64,
) -> Vec<WorkToken> {
    let parts = crate::phone::request_parts(&crate::phone::Request {
        id,
        method: crate::phone::Method::GET,
        path: "/rpc".into(),
        headers: crate::phone::Headers::new(),
        body: Vec::new(),
    })
    .unwrap();
    let mut tokens = Vec::new();
    for part in parts {
        tokens.extend(
            a.receive_request(h, &c.seal_encoded(&part).unwrap(), now)
                .unwrap(),
        );
    }
    tokens
}
fn store(a: &mut PersistentAuthority) -> &mut RestartRecords {
    match &mut a.core().storage {
        RecordStore::Persistent(s) => s,
        _ => unreachable!(),
    }
}
#[test]
fn clean_restart_preserves_identity_kind_epochs_closes_windows_and_cancels_owned_work() {
    let _disk_test = crate::synthetic_store::testing_lock();
    let mut p = profile(StoreLimits::default());
    let limits = PersistentLimits {
        registry: registry::Limits {
            inflight: 1,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut a = resume(&mut p, limits);
    let public = a.host_public_key();
    a.open_pairing(1).unwrap();
    let token = a.with_pairing_invitation(1, str::to_owned).unwrap();
    let (h, mut c, key) = pair(&mut a, 1, 4, 2);
    let inflight = request(&mut a, &h, &mut c, 1, 2).remove(0);
    assert!(request(&mut a, &h, &mut c, 2, 2).is_empty());
    let queued = a.registry.as_mut().unwrap().work_token(&h, 2).unwrap();
    let (bytes, _) = hello(&a, 5, &token);
    let stale_ticket = a.begin(Source::Relay, &bytes, 2, &mut OsRng).unwrap();
    // Retained completed Session outside the registry is also revoked by close.
    let (bytes, _) = hello(&a, 6, &token);
    let t = a.begin(Source::Relay, &bytes, 2, &mut OsRng).unwrap();
    let mut retained = a.core().complete(t, || 2).unwrap();
    let budget = retained.budget();
    assert!(budget.reserve(1).is_ok());
    let pool = a.core().global.clone();
    assert!(pool.used() > StoreLimits::default().working_bytes);
    let first = clean(a);
    assert_eq!(pool.used(), StoreLimits::default().working_bytes);
    assert_eq!(h.status(), CarrierStatus::Closed(CloseReason::Retired));
    assert_eq!(queued.status(), WorkStatus::Cancelled);
    assert_eq!(inflight.status(), WorkStatus::Cancelled);
    assert!(retained.seal_encoded(b"{}").is_err());
    let mut b = resume(&mut p, limits);
    assert_eq!(b.host_public_key(), public);
    assert_eq!(b.diagnostics().boot, first.boot.map(|n| n + 1));
    assert!(b.with_pairing_invitation(0, str::to_owned).is_err());
    assert!(b.cancel(stale_ticket).is_err());
    assert!(b.finish_request(&inflight, b"{}", 0).is_err());
    assert!(!b.disconnect(&h));
    let fresh = b.open_carrier(3, 0).unwrap();
    assert!(b
        .registry
        .as_mut()
        .unwrap()
        .establish(&fresh, retained, 0)
        .is_err());
    let (_, _, reconnected) = install(&mut b, 1, 4, &token, 0);
    assert_eq!(key, reconnected);
    let (bytes, _) = channel::phone_hello(
        &SecretKey::from([4; 32]),
        &public,
        &token,
        HelloOptions {
            kind: Some(DeviceKind::Desktop),
            ..Default::default()
        },
        &mut OsRng,
    )
    .unwrap();
    assert!(b.begin(Source::Relay, &bytes, 0, &mut OsRng).is_err());
    b.open_pairing(1).unwrap();
    assert_eq!(b.with_pairing_invitation(1, str::to_owned).unwrap(), token);
    clean(b);
    p.destroy().unwrap();
}
#[test]
fn removed_epoch_survives_restart_and_requires_later_explicit_window() {
    let _disk_test = crate::synthetic_store::testing_lock();
    let mut p = profile(StoreLimits::default());
    let mut a = resume(&mut p, Default::default());
    a.open_pairing(1).unwrap();
    let (h, _, key) = pair(&mut a, 1, 4, 2);
    let token = a.with_pairing_invitation(2, str::to_owned).unwrap();
    a.remove_device(&key, 3).unwrap();
    assert_eq!(h.status(), CarrierStatus::Closed(CloseReason::Removed));
    a.open_pairing(3).unwrap();
    let (bytes, _) = hello(&a, 4, &token);
    assert!(a.begin(Source::Relay, &bytes, 3, &mut OsRng).is_err());
    assert_eq!(store(&mut a).state.devices[0].epoch, 1);
    clean(a);
    let mut b = resume(&mut p, Default::default());
    let (bytes, _) = hello(&b, 4, &token);
    assert!(b.begin(Source::Relay, &bytes, 0, &mut OsRng).is_err());
    b.open_pairing(0).unwrap();
    let (_, _, again) = pair(&mut b, 1, 4, 0);
    assert_eq!(again, key);
    assert_eq!(store(&mut b).state.devices[0].epoch, 1);
    assert!(store(&mut b).state.devices[0].last_removed.is_some());
    b.remove_device(&key, 1).unwrap();
    b.open_pairing(1).unwrap();
    assert!(b.begin(Source::Relay, &bytes, 1, &mut OsRng).is_err());
    b.open_pairing(2).unwrap();
    pair(&mut b, 2, 4, 2);
    assert_eq!(store(&mut b).state.devices[0].epoch, 2);
    clean(b);
}
#[test]
fn more_than_64_removals_do_not_retire_and_full_history_still_reconnects_and_repairs() {
    let _disk_test = crate::synthetic_store::testing_lock();
    let mut p = profile(StoreLimits {
        history_slots: 70,
        ..Default::default()
    });
    let l = PersistentLimits {
        policy: Limits {
            records: 2,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut a = resume(&mut p, l);
    for seed in 1..=70u8 {
        let now = u64::from(seed) * 2000;
        a.open_pairing(now).unwrap();
        let (h, _, key) = pair(&mut a, u64::from(seed), seed, now);
        if seed < 70 {
            a.remove_device(&key, now + 1).unwrap();
        } else {
            a.disconnect(&h);
        }
    }
    let now = 142_000;
    a.open_pairing(now).unwrap();
    let token = a.with_pairing_invitation(now, str::to_owned).unwrap();
    let (bytes, _) = hello(&a, 71, &token);
    let t = a.begin(Source::Relay, &bytes, now, &mut OsRng).unwrap();
    let h = a.open_carrier(71, now).unwrap();
    assert!(matches!(
        a.complete(&h, t, || now),
        Err(PersistentError::Policy(PolicyError::Limited))
    ));
    assert!(!a.core().retired);
    install(&mut a, 72, 70, &token, now);
    pair(&mut a, 73, 1, now);
    let key = URL_SAFE_NO_PAD.encode(SecretKey::from([1; 32]).public_key().as_bytes());
    a.remove_device(&key, now + 1).unwrap();
    assert_eq!(store(&mut a).state.devices.len(), 70);
    clean(a);
    let mut b = resume(&mut p, l);
    install(&mut b, 1, 70, &token, 0);
    b.open_pairing(0).unwrap();
    pair(&mut b, 2, 1, 0);
    clean(b);
}
#[test]
fn ordinary_drop_quarantines_and_keeps_guard_ownership() {
    let _disk_test = crate::synthetic_store::testing_lock();
    let mut p = profile(StoreLimits::default());
    let mut a = resume(&mut p, Default::default());
    a.open_pairing(1).unwrap();
    let (h, _, _) = pair(&mut a, 1, 4, 1);
    drop(a);
    assert_eq!(h.status(), CarrierStatus::Closed(CloseReason::Retired));
    let q = match PersistentAuthority::resume(
        p.acquire_writer().unwrap(),
        Default::default(),
        &mut OsRng,
    ) {
        OpenedAuthority::Quarantined(q) => q,
        _ => panic!("drop must quarantine"),
    };
    assert_eq!(q.diagnostics().fault, Some(StoreFault::DirtyRun));
    assert!(matches!(p.acquire_writer(), Err(StoreFault::Busy)));
    assert!(matches!(p.destroy(), Err(StoreFault::Busy)));
    q.release();
    p.destroy().unwrap();
}
#[test]
fn consuming_close_and_retire_faults_keep_revoked_stopped_writer_without_replay() {
    let _disk_test = crate::synthetic_store::testing_lock();
    for terminal in [false, true] {
        for stage in [
            IoStage::WriteTransaction,
            IoStage::SyncFile,
            IoStage::Rename,
            IoStage::SyncDirectory,
        ] {
            let mut p = profile(StoreLimits::default());
            let mut a = resume(&mut p, Default::default());
            a.open_pairing(1).unwrap();
            let (h, mut c, _) = pair(&mut a, 1, 4, 1);
            let work = request(&mut a, &h, &mut c, 1, 1).remove(0);
            let before = a.diagnostics();
            store(&mut a).writer.fail_next = Some(stage);
            let failure = match if terminal {
                a.retire_identity().map(|_| ())
            } else {
                a.close_for_restart().map(|_| ())
            } {
                Err(f) => f,
                Ok(_) => panic!("fault must retain writer"),
            };
            assert_eq!(work.status(), WorkStatus::Cancelled);
            assert_eq!(h.status(), CarrierStatus::Closed(CloseReason::Retired));
            let (fault, guard) = failure.into_parts();
            assert!(matches!(fault,StoreFault::Io{stage:s,..} if s==stage));
            assert_eq!(guard.diagnostics().revision, before.revision);
            assert!(!guard.diagnostics().retired);
            assert!(matches!(p.acquire_writer(), Err(StoreFault::Busy)));
            guard.release();
            match PersistentAuthority::resume(
                p.acquire_writer().unwrap(),
                Default::default(),
                &mut OsRng,
            ) {
                OpenedAuthority::Quarantined(q) => {
                    q.release();
                }
                _ => panic!("no clean replay"),
            }
            p.destroy().unwrap();
        }
    }
}
#[test]
fn running_removal_enrollment_and_window_faults_never_release_authorization() {
    let _disk_test = crate::synthetic_store::testing_lock();
    for stage in [
        IoStage::WriteTransaction,
        IoStage::SyncFile,
        IoStage::Rename,
        IoStage::SyncDirectory,
    ] {
        let mut p = profile(StoreLimits::default());
        let mut writer = p.acquire_writer().unwrap();
        writer.fail_next = Some(stage);
        match PersistentAuthority::resume(writer, Default::default(), &mut OsRng) {
            OpenedAuthority::Quarantined(q) => {
                assert!(matches!(p.acquire_writer(), Err(StoreFault::Busy)));
                q.release();
            }
            _ => panic!("running fault"),
        };
        p.destroy().unwrap();
        for operation in 0..3 {
            let mut p = profile(StoreLimits::default());
            let mut a = resume(&mut p, Default::default());
            a.open_pairing(1).unwrap();
            let (h, _, key) = pair(&mut a, 1, 4, 1);
            let token = a.with_pairing_invitation(1, str::to_owned).unwrap();
            let (bytes, _) = hello(&a, 5, &token);
            let t = a.begin(Source::Relay, &bytes, 1, &mut OsRng).unwrap();
            let pending = a.open_carrier(2, 1).unwrap();
            store(&mut a).writer.fail_next = Some(stage);
            match operation {
                0 => assert!(a.remove_device(&key, 2).is_err()),
                1 => assert!(a.complete(&pending, t, || 2).is_err()),
                _ => assert!(a.open_pairing(2).is_err()),
            };
            assert!(matches!(h.status(), CarrierStatus::Closed(_)));
            assert!(a
                .take_output(&h, 2, |_| panic!("revoked delivery"))
                .is_err());
            let failure = match a.close_for_restart() {
                Err(f) => f,
                _ => panic!("poison cannot clean"),
            };
            let (_, guard) = failure.into_parts();
            assert!(matches!(p.acquire_writer(), Err(StoreFault::Busy)));
            guard.release();
            match PersistentAuthority::resume(
                p.acquire_writer().unwrap(),
                Default::default(),
                &mut OsRng,
            ) {
                OpenedAuthority::Quarantined(q) => {
                    q.release();
                }
                _ => panic!("ambiguous mutation"),
            };
            p.destroy().unwrap();
        }
    }
}
#[test]
fn retirement_is_terminal_and_invalid_configuration_preserves_clean_eligibility() {
    let _disk_test = crate::synthetic_store::testing_lock();
    let mut p = profile(StoreLimits::default());
    let a = resume(&mut p, Default::default());
    let receipt = a.retire_identity().unwrap_or_else(|_| panic!("retire"));
    assert!(receipt.diagnostics().retired);
    match PersistentAuthority::resume(p.acquire_writer().unwrap(), Default::default(), &mut OsRng) {
        OpenedAuthority::Retired(r) => {
            assert!(r.diagnostics().retired);
            assert!(matches!(p.acquire_writer(), Err(StoreFault::Busy)));
            r.release();
        }
        _ => panic!("terminal"),
    };
    p.destroy().unwrap();
    let mut p = profile(StoreLimits::default());
    let limits = PersistentLimits {
        policy: Limits {
            records: 0,
            ..Default::default()
        },
        ..Default::default()
    };
    match PersistentAuthority::resume(p.acquire_writer().unwrap(), limits, &mut OsRng) {
        OpenedAuthority::Rejected(q) => {
            assert_eq!(q.diagnostics().fault, Some(StoreFault::InvalidLimits));
            q.release().unwrap_or_else(|_| panic!("release unstarted"));
        }
        _ => panic!("limits"),
    };
    clean(resume(&mut p, Default::default()));
    p.destroy().unwrap();
}
#[test]
fn checked_counter_exhaustion_revokes_and_cannot_clean() {
    let _disk_test = crate::synthetic_store::testing_lock();
    let mut p = profile(StoreLimits::default());
    let mut a = resume(&mut p, Default::default());
    a.open_pairing(1).unwrap();
    let (h, _, key) = pair(&mut a, 1, 4, 1);
    store(&mut a).state.policy = u64::MAX;
    assert!(matches!(
        a.open_pairing(2),
        Err(PolicyError::PersistentStore(StoreFault::Exhausted))
    ));
    assert!(matches!(h.status(), CarrierStatus::Closed(_)));
    let (f, guard) = match a.close_for_restart() {
        Err(e) => e.into_parts(),
        _ => panic!("exhausted"),
    };
    assert_eq!(f, StoreFault::Exhausted);
    guard.release();
    p.destroy().unwrap();
    let mut p = profile(StoreLimits::default());
    let mut a = resume(&mut p, Default::default());
    a.open_pairing(1).unwrap();
    pair(&mut a, 1, 4, 1);
    a.core()
        .revocations
        .write()
        .unwrap()
        .epochs
        .insert(key.clone(), u64::MAX);
    assert!(matches!(
        a.remove_device(&key, 2),
        Err(PolicyError::Limited)
    ));
    // Runtime exhaustion must not mint a Clean receipt even without a disk error.
    assert!(a.core().retired);
    let (_, guard) = match a.close_for_restart() {
        Err(e) => e.into_parts(),
        _ => panic!("runtime exhaustion cannot clean"),
    };
    guard.release();
    p.destroy().unwrap();
}
struct Repeated;
impl RngCore for Repeated {
    fn next_u32(&mut self) -> u32 {
        7
    }
    fn next_u64(&mut self) -> u64 {
        7
    }
    fn fill_bytes(&mut self, d: &mut [u8]) {
        d.fill(7)
    }
    fn try_fill_bytes(&mut self, d: &mut [u8]) -> std::result::Result<(), rand_core::Error> {
        self.fill_bytes(d);
        Ok(())
    }
}
impl CryptoRng for Repeated {}
fn repeated_resume(p: &mut Profile) -> PersistentAuthority {
    match PersistentAuthority::resume(
        p.acquire_writer().unwrap(),
        Default::default(),
        &mut Repeated,
    ) {
        OpenedAuthority::Ready(a) => a,
        _ => panic!("ready"),
    }
}
#[test]
fn repeated_nonces_do_not_rebind_old_ticket_handle_cursor_or_foreign_session() {
    let _disk_test = crate::synthetic_store::testing_lock();
    let mut p = profile(StoreLimits::default());
    let mut a = repeated_resume(&mut p);
    a.open_pairing(1).unwrap();
    let token = a.with_pairing_invitation(1, str::to_owned).unwrap();
    let (h, mut c, _) = pair(&mut a, 1, 4, 1);
    request(&mut a, &h, &mut c, 1, 1);
    request(&mut a, &h, &mut c, 2, 1);
    let cursor = a.drain_work(None, 1, 1).unwrap().next.unwrap();
    let (bytes, _) = hello(&a, 5, &token);
    let old = a.begin(Source::Relay, &bytes, 1, &mut OsRng).unwrap();
    clean(a);
    let mut b = repeated_resume(&mut p);
    let (fresh, _, _) = install(&mut b, 1, 4, &token, 0);
    assert!(!b.disconnect(&h));
    assert_eq!(fresh.status(), CarrierStatus::Active);
    b.open_pairing(1).unwrap();
    let (bytes, _) = hello(&b, 5, &token);
    let current = b.begin(Source::Relay, &bytes, 1, &mut OsRng).unwrap();
    assert_eq!(old.id, current.id);
    assert_eq!(old.authority, current.authority);
    assert!(b.cancel(old).is_err());
    assert!(b.pending_device(&current).is_ok());
    assert!(b.drain_work(Some(&cursor), 1, 1).is_err());
    let mut other = profile(StoreLimits::default());
    let mut foreign = repeated_resume(&mut other);
    foreign.open_pairing(1).unwrap();
    let token = foreign.with_pairing_invitation(1, str::to_owned).unwrap();
    let (bytes, _) = hello(&foreign, 5, &token);
    let t = foreign.begin(Source::Relay, &bytes, 1, &mut OsRng).unwrap();
    let s = foreign.core().complete(t, || 1).unwrap();
    assert!(!s.is_revoked());
    let target = b.open_carrier(2, 1).unwrap();
    assert!(b
        .registry
        .as_mut()
        .unwrap()
        .establish(&target, s, 1)
        .is_err());
    clean(b);
    clean(foreign);
}
#[test]
fn closed_carrier_cannot_commit_enrollment_and_desktop_approval_is_not_restored() {
    let _disk_test = crate::synthetic_store::testing_lock();
    let mut p = profile(StoreLimits::default());
    let mut a = resume(&mut p, Default::default());
    a.open_pairing(1).unwrap();
    a.enable_desktop().unwrap();
    let token = a.with_pairing_invitation(1, str::to_owned).unwrap();
    let (bytes, _) = channel::phone_hello(
        &SecretKey::from([5; 32]),
        &a.host_public_key(),
        &token,
        HelloOptions {
            kind: Some(DeviceKind::Desktop),
            ..Default::default()
        },
        &mut OsRng,
    )
    .unwrap();
    let t = a.begin(Source::Relay, &bytes, 1, &mut OsRng).unwrap();
    a.approve_desktop(&t, 1).unwrap();
    let h = a.open_carrier(1, 1).unwrap();
    a.disconnect(&h);
    let revision = a.diagnostics().revision;
    assert!(a.complete(&h, t, || 1).is_err());
    assert_eq!(a.diagnostics().revision, revision);
    assert!(store(&mut a).state.devices.is_empty());
    let old = a.begin(Source::Relay, &bytes, 1, &mut OsRng).unwrap();
    a.approve_desktop(&old, 1).unwrap();
    clean(a);
    let mut b = resume(&mut p, Default::default());
    b.enable_desktop().unwrap();
    b.open_pairing(0).unwrap();
    assert!(b.approve_desktop(&old, 0).is_err());
    let t = b.begin(Source::Relay, &bytes, 0, &mut OsRng).unwrap();
    let h = b.open_carrier(1, 0).unwrap();
    assert!(b.complete(&h, t, || 0).is_err());
    let t = b.begin(Source::Relay, &bytes, 0, &mut OsRng).unwrap();
    b.approve_desktop(&t, 0).unwrap();
    let h = b.open_carrier(2, 0).unwrap();
    b.complete(&h, t, || 0).unwrap();
    clean(b);
}
#[test]
fn wrong_pid_refuses_before_inherited_runtime_locks_and_drop_never_waits() {
    let _disk_test = crate::synthetic_store::testing_lock();
    let mut p = profile(StoreLimits::default());
    let mut a = resume(&mut p, Default::default());
    let revocations = a.core().revocations.clone();
    let _held = revocations.write().unwrap();
    a.pid = a.pid.wrapping_add(1);
    assert!(matches!(
        a.open_pairing(0),
        Err(PolicyError::PersistentStore(StoreFault::WrongProcess))
    ));
    assert!(a.open_carrier(1, 0).is_err());
    // Simulated foreign process takes the same refusal branch as an inherited authority.
    let (fault, guard) = match a.close_for_restart() {
        Err(e) => e.into_parts(),
        _ => panic!("foreign process"),
    };
    assert_eq!(fault, StoreFault::WrongProcess);
    guard.release();
    p.destroy().unwrap();
    let mut p = profile(StoreLimits::default());
    let mut a = resume(&mut p, Default::default());
    let state = a.core().revocations.clone();
    let _held = state.write().unwrap();
    a.pid = a.pid.wrapping_add(1);
    drop(a);
    p.destroy().unwrap();
}
/// Test-only fixed subprocess worker: no public FD/launcher/receipt-import API.
pub(crate) fn worker(writer: WriterLease, mode: &str, attempt: u64) {
    let mut a = match PersistentAuthority::resume(writer, Default::default(), &mut OsRng) {
        OpenedAuthority::Ready(a) => a,
        _ => panic!("worker resume"),
    };
    let first = a.diagnostics().boot == Some(1);
    if first {
        a.open_pairing(0).unwrap();
    }
    let token = a.core().token.clone();
    let (bytes, pending) = hello(&a, 4, &token);
    let t = a.begin(Source::Relay, &bytes, 0, &mut OsRng).unwrap();
    assert_eq!(a.pending_device(&t).unwrap().first_pairing, first);
    let key = a.pending_device(&t).unwrap().key.clone();
    let h = a.open_carrier(1, 0).unwrap();
    a.complete(&h, t, || 0).unwrap();
    let mut reply = Vec::new();
    a.take_output(&h, 0, |b| {
        reply.extend_from_slice(b);
        Ok(())
    })
    .unwrap();
    let mut c = pending.finish(&reply).unwrap();
    let work = request(&mut a, &h, &mut c, 1, 0).remove(0);
    if mode == "worker-authority-exit-removal" {
        store(&mut a).before_commit = Some(Box::new(move || {
            assert_eq!(h.status(), CarrierStatus::Closed(CloseReason::Removed));
            assert_eq!(work.status(), WorkStatus::Cancelled);
            std::process::exit(23);
        }));
        let _ = a.remove_device(&key, 1);
        panic!("expected abrupt exit");
    }
    if mode == "worker-authority-drop" {
        return;
    }
    if mode == "worker-authority-ambiguous" {
        store(&mut a).writer.fail_next = Some(IoStage::SyncDirectory);
        let (_, guard) = match a.close_for_restart() {
            Err(e) => e.into_parts(),
            _ => panic!("sync fault"),
        };
        guard.release();
        return;
    }
    let receipt = clean(a);
    assert_eq!(work.status(), WorkStatus::Cancelled);
    assert_eq!(h.status(), CarrierStatus::Closed(CloseReason::Retired));
    if mode == "worker-authority-no-ack" {
        return;
    }
    println!(
        "CLEAN {attempt} {} {}",
        receipt.revision.unwrap(),
        receipt.boot.unwrap()
    );
}
#[test]
fn prewrite_rejections_retry_same_lease_and_drop_preserves_prior_eligibility() {
    let _disk_test = crate::synthetic_store::testing_lock();
    let variants = [
        PersistentLimits {
            policy: Limits {
                records: 0,
                ..Default::default()
            },
            ..Default::default()
        },
        PersistentLimits {
            registry: registry::Limits {
                carriers: 0,
                ..Default::default()
            },
            ..Default::default()
        },
    ];
    for limits in variants {
        assert_eq!(limits.validate(), Err(StoreFault::InvalidLimits));
        let mut p = profile(StoreLimits::default());
        let rejected =
            match PersistentAuthority::resume(p.acquire_writer().unwrap(), limits, &mut OsRng) {
                OpenedAuthority::Rejected(r) => r,
                _ => panic!("prewrite rejection"),
            };
        assert_eq!(rejected.diagnostics().boot, Some(0));
        assert!(matches!(p.acquire_writer(), Err(StoreFault::Busy)));
        let a = match rejected.retry(Default::default(), &mut OsRng) {
            OpenedAuthority::Ready(a) => a,
            _ => panic!("corrected retry"),
        };
        assert_eq!(a.diagnostics().boot, Some(1));
        let previous = clean(a);
        let rejected =
            match PersistentAuthority::resume(p.acquire_writer().unwrap(), limits, &mut OsRng) {
                OpenedAuthority::Rejected(r) => r,
                _ => panic!("prewrite rejection"),
            };
        drop(rejected);
        let a = resume(&mut p, Default::default());
        assert_eq!(a.diagnostics().boot, previous.boot.map(|b| b + 1));
        clean(a);
    }
}
#[test]
fn snapshot_dependent_record_limit_rejection_can_be_corrected() {
    let _disk_test = crate::synthetic_store::testing_lock();
    let mut p = profile(StoreLimits::default());
    let mut a = resume(&mut p, Default::default());
    a.open_pairing(1).unwrap();
    pair(&mut a, 1, 4, 1);
    pair(&mut a, 2, 5, 1);
    let previous = clean(a);
    let limits = PersistentLimits {
        policy: Limits {
            records: 1,
            ..Default::default()
        },
        ..Default::default()
    };
    assert!(limits.validate().is_ok());
    let r = match PersistentAuthority::resume(p.acquire_writer().unwrap(), limits, &mut OsRng) {
        OpenedAuthority::Rejected(r) => r,
        _ => panic!("active count rejection"),
    };
    assert_eq!(r.diagnostics().revision, previous.revision);
    r.release().unwrap_or_else(|_| panic!("release"));
    let mut a = resume(&mut p, Default::default());
    assert_eq!(store(&mut a).state.devices.len(), 2);
    clean(a);
}

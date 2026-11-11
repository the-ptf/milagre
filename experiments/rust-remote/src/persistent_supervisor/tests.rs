use super::*;
use crate::{
    supervisor::ManualClock,
    synthetic_store::{IoStage, StoreLimits},
};
fn profile() -> SyntheticProfile {
    SyntheticProfile::create(StoreLimits::default(), &mut OsRng).unwrap()
}
fn start(p: SyntheticProfile) -> PersistentSupervisor {
    PersistentSupervisor::start(p, Limits::default(), Clock::Manual(ManualClock::default()))
        .unwrap_or_else(|_| panic!("start"))
}
fn released(s: StoppedService) -> SyntheticProfile {
    s.release().unwrap_or_else(|_| panic!("release"))
}
fn clean(s: PersistentSupervisor) -> SyntheticProfile {
    s.close_for_restart()
        .unwrap_or_else(|_| panic!("clean"))
        .into_parts()
        .1
}
fn quarantined(p: SyntheticProfile) -> SyntheticProfile {
    let (fault, stopped) = match PersistentSupervisor::start(
        p,
        Limits::default(),
        Clock::Manual(ManualClock::default()),
    ) {
        Err(e) => e.into_parts(),
        _ => panic!("must quarantine"),
    };
    assert_eq!(fault, StartFault::Quarantined);
    released(stopped)
}
#[test]
fn joined_quiescence_keeps_writer_until_explicit_terminal_ack_and_restarts() {
    let _disk = crate::synthetic_store::testing_lock();
    let mut s = start(profile());
    let pool = s.shared.global.clone();
    s.join(false);
    assert!(s.worker.is_none());
    assert!(s.shared.finished.load(Ordering::SeqCst));
    assert_eq!(pool.used(), StoreLimits::default().working_bytes);
    assert!(matches!(
        s.profile.as_mut().unwrap().acquire_writer(),
        Err(StoreFault::Busy)
    ));
    let revision = slot(&s.retained, &s.shared)
        .runtime
        .as_ref()
        .unwrap()
        .authority
        .diagnostics()
        .revision;
    let (receipt, p) = s
        .close_for_restart()
        .unwrap_or_else(|_| panic!("clean"))
        .into_parts();
    assert_eq!(receipt.diagnostics().revision, revision.map(|n| n + 1));
    let s = start(p);
    let (receipt, mut p) = s
        .close_for_restart()
        .unwrap_or_else(|_| panic!("clean"))
        .into_parts();
    assert_eq!(receipt.diagnostics().boot, Some(2));
    p.destroy().unwrap();
}
#[test]
fn invalid_limits_are_prewrite_and_corrected_start_succeeds() {
    let _disk = crate::synthetic_store::testing_lock();
    for field in 0..3 {
        let p = clean(start(profile()));
        let mut limits = Limits::default();
        match field {
            0 => limits.commands = 0,
            1 => limits.registry.carriers = 0,
            _ => limits.authority.records = 0,
        }
        let (fault, stopped) =
            match PersistentSupervisor::start(p, limits, Clock::Manual(ManualClock::default())) {
                Err(e) => e.into_parts(),
                _ => panic!("invalid"),
            };
        assert_eq!(fault, StartFault::InvalidLimits);
        assert!(stopped.diagnostics().store.is_none());
        let mut p = clean(start(released(stopped)));
        p.destroy().unwrap();
    }
}
#[test]
fn post_running_start_failures_retain_guard_and_never_restore_clean() {
    let _disk = crate::synthetic_store::testing_lock();
    for mode in 0..4 {
        let hooks = Hooks {
            reserve_failure: mode == 0,
            spawn_failure: mode == 1,
            startup_panic: mode == 2,
            poison_slot: mode == 3,
        };
        let (fault, mut stopped) = match PersistentSupervisor::start_inner(
            profile(),
            Limits::default(),
            Clock::monotonic(),
            hooks,
        ) {
            Err(e) => e.into_parts(),
            _ => panic!("injected start failure"),
        };
        assert_eq!(stopped.diagnostics().worker_joined, mode >= 2);
        assert!(matches!(
            stopped.profile.acquire_writer(),
            Err(StoreFault::Busy)
        ));
        assert!(matches!(
            fault,
            StartFault::Reservation | StartFault::Spawn(_) | StartFault::Worker(_)
        ));
        let mut p = quarantined(released(stopped));
        p.destroy().unwrap();
    }
}
#[test]
fn terminal_io_faults_keep_joined_writer_and_never_retry_clean() {
    let _disk = crate::synthetic_store::testing_lock();
    for stage in [
        IoStage::WriteTransaction,
        IoStage::SyncFile,
        IoStage::Rename,
        IoStage::SyncDirectory,
    ] {
        for retired in [false, true] {
            let mut s = start(profile());
            s.join(false);
            slot(&s.retained, &s.shared)
                .runtime
                .as_mut()
                .unwrap()
                .authority
                .fail_next_terminal_for_test(stage);
            let e = if retired {
                s.retire_identity().err()
            } else {
                s.close_for_restart().err()
            }
            .expect("typed fault");
            let (fault, mut stopped) = e.into_parts();
            assert!(matches!(fault, CloseFault::Store(StoreFault::Io { .. })));
            assert!(stopped.diagnostics().worker_joined);
            assert!(matches!(
                stopped.profile.acquire_writer(),
                Err(StoreFault::Busy)
            ));
            let mut p = quarantined(released(stopped));
            p.destroy().unwrap();
        }
    }
}
#[test]
fn abort_dominates_requested_stop_and_poison_recovery_cannot_clean() {
    let _disk = crate::synthetic_store::testing_lock();
    for poison in [false, true] {
        let mut s = start(profile());
        s.join(false);
        if poison {
            let retained = s.retained.clone();
            let _ = catch_unwind(AssertUnwindSafe(move || {
                let _g = retained.lock().unwrap();
                panic!("synthetic owner slot poison");
            }));
        } else {
            s.shared.request_stop(true);
        }
        let (fault, mut stopped) = s
            .close_for_restart()
            .err()
            .expect("dirty close")
            .into_parts();
        assert_eq!(
            fault,
            CloseFault::Worker(if poison {
                WorkerFault::Poisoned
            } else {
                WorkerFault::Aborted
            })
        );
        assert!(matches!(
            stopped.profile.acquire_writer(),
            Err(StoreFault::Busy)
        ));
        let mut p = quarantined(released(stopped));
        p.destroy().unwrap();
    }
}
#[test]
fn retired_start_retains_guard_and_explicit_abort_quarantines() {
    let _disk = crate::synthetic_store::testing_lock();
    let s = start(profile());
    let (receipt, p) = s
        .retire_identity()
        .unwrap_or_else(|_| panic!("retire"))
        .into_parts();
    assert!(receipt.diagnostics().retired);
    let (fault, mut stopped) =
        PersistentSupervisor::start(p, Limits::default(), Clock::monotonic())
            .err()
            .expect("retired")
            .into_parts();
    assert_eq!(fault, StartFault::Retired);
    assert!(matches!(
        stopped.profile.acquire_writer(),
        Err(StoreFault::Busy)
    ));
    released(stopped).destroy().unwrap();
    let mut p = quarantined(released(start(profile()).abort()));
    p.destroy().unwrap();
}

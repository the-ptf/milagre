use super::*;
use std::{
    thread,
    time::{Duration, Instant},
};
fn wait_flag(mut ready: impl FnMut() -> bool) {
    let until = Instant::now() + Duration::from_secs(5);
    while !ready() {
        assert!(Instant::now() < until);
        thread::sleep(Duration::from_millis(5));
    }
}
fn report(shared: &Shared) -> Report {
    wait_flag(|| shared.completion.lock().unwrap().progress.report.is_some());
    shared.completion.lock().unwrap().progress.report.clone().unwrap()
}
#[test]
fn public_text_limit_and_api_errors_are_redacted() {
    assert!(matches!(automatic(FixtureCase::Ready, &"x".repeat(wire::TEXT_LIMIT + 1)), Err(Error::Bounds)));
    assert_eq!(format!("{}", Error::Identity), "Identity");
    assert_eq!(format!("{}", Error::UnsupportedPlatform), "UnsupportedPlatform");
}
#[test]
#[ignore = "Only scripts/check-private-copy-fixture.py stages the fixed native sibling"]
fn native_private_copy_end_to_end() {
    let old = std::env::var_os("DYLD_INSERT_LIBRARIES");
    std::env::set_var("DYLD_INSERT_LIBRARIES", "/synthetic-forbidden-loader");
    let text = "native consumed \"text\" with \n Unicode ä😀 and \0";
    let fixture = automatic(FixtureCase::Ready, text).unwrap();
    let done = report(&fixture.shared);
    let execution = done.result.clone().unwrap_or_else(|_| panic!("native result: {done:?}"));
    assert!(done.reaped && done.resources_removed);
    assert_eq!(done.exit_code, Some(0));
    assert_eq!(execution.text_bytes, text.len());
    assert_eq!(execution.compiled_identity, wire::IDENTITY);
    assert_ne!(execution.pid, std::process::id());
    println!(
        "PRIVATE_COPY_NATIVE_EVIDENCE identity={} pid={} textBytes={} frameBytes={} parentArtifactSha256={} reaped={} removed={}",
        execution.compiled_identity,
        execution.pid,
        execution.text_bytes,
        execution.frame_bytes,
        execution.parent_artifact_sha256,
        done.reaped,
        done.resources_removed
    );
    drop(fixture);
    for drop_observer in [false, true] {
        let fixture = automatic(FixtureCase::IgnoreCancel, "cancel consumed text").unwrap();
        let shared = fixture.shared.clone();
        wait_flag(|| shared.parsed.load(Ordering::Acquire));
        if drop_observer {
            drop(fixture);
        } else {
            fixture.cancel_handle().cancel();
        }
        let done = report(&shared);
        assert_eq!(done.result, Err(Error::Revoked));
        assert!(done.reaped && done.resources_removed);
    }
    for fault in [worker::Fault::PanicAfterSpawn, worker::Fault::SpawnFailure] {
        ACTIVE.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).unwrap();
        let shared = Shared::new();
        let retained = shared.clone();
        thread::spawn(move || {
            worker::run(
                retained.clone(),
                FixtureCase::Ready,
                "fault fixture".into(),
                Slot,
                fault,
                Some(Control { shared: retained.clone() }),
            )
        });
        let done = report(&shared);
        assert!(done.resources_removed);
        match fault {
            worker::Fault::PanicAfterSpawn => {
                assert_eq!(done.result, Err(Error::WorkerPanic));
                assert!(done.reaped);
            }
            worker::Fault::SpawnFailure => {
                assert_eq!(done.result, Err(Error::Spawn));
                assert!(!done.reaped);
            }
            _ => unreachable!(),
        }
    }
    ACTIVE.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).unwrap();
    let shared = Shared::new();
    shared.revoke();
    worker::run(
        shared.clone(),
        FixtureCase::Ready,
        "never admitted".into(),
        Slot,
        worker::Fault::None,
        Some(Control { shared: shared.clone() }),
    );
    assert_eq!(report(&shared).result, Err(Error::Revoked));
    assert_eq!(shared.pid.load(Ordering::Acquire), 0);
    for before in [true, false] {
        ACTIVE.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).unwrap();
        let shared = Shared::new();
        let barrier = Arc::new(std::sync::Barrier::new(2));
        if before {
            *shared.before_commit.lock().unwrap() = Some(barrier.clone());
        } else {
            *shared.after_commit.lock().unwrap() = Some(barrier.clone());
        }
        let retained = shared.clone();
        thread::spawn(move || {
            worker::run(
                retained.clone(),
                FixtureCase::Ready,
                "no consumed prompt".into(),
                Slot,
                worker::Fault::None,
                Some(Control { shared: retained.clone() }),
            )
        });
        barrier.wait();
        shared.revoke();
        barrier.wait();
        let done = report(&shared);
        assert_eq!(done.result, Err(Error::Revoked));
        assert!(done.resources_removed);
        assert!(!shared.parsed.load(Ordering::Acquire));
        if before {
            assert_eq!(shared.pid.load(Ordering::Acquire), 0);
            assert!(!done.reaped);
        } else {
            assert_ne!(shared.pid.load(Ordering::Acquire), 0);
            assert!(done.reaped);
        }
    }
    match old {
        Some(value) => std::env::set_var("DYLD_INSERT_LIBRARIES", value),
        None => std::env::remove_var("DYLD_INSERT_LIBRARIES"),
    }
    println!("PRIVATE_COPY_LIFETIME_EVIDENCE cancellation=true drop=true panic=true spawnFailure=true precommitRevocation=true postcommitRevocation=true");
}

#[test]
fn stamped_gate_requires_preparation_exact_instance_and_live_epoch() {
    let shared = Shared::new();
    let control = Control { shared: shared.clone() };
    assert_eq!(control.stamp(control.capture().unwrap()), Err(Error::Revoked));
    assert_eq!(shared.commit(), Err(Error::Revoked));
    shared.prepared().unwrap();
    let foreign = Shared::new();
    let other = Control { shared: foreign.clone() };
    foreign.prepared().unwrap();
    assert_eq!(control.stamp(other.capture().unwrap()), Err(Error::Revoked));
    let old = control.capture().unwrap();
    control.invalidate();
    assert_eq!(control.stamp(old), Err(Error::Revoked));
    assert_eq!(shared.commit(), Err(Error::Revoked));
    other.stamp(other.capture().unwrap()).unwrap();
    assert_eq!(other.stamp(other.capture().unwrap()), Err(Error::Revoked));
    foreign.commit().unwrap();
    assert_eq!(foreign.commit(), Err(Error::Revoked));
    other.invalidate();
    assert_eq!(foreign.active(), Err(Error::Revoked));
}

#[test]
fn revisioned_progress_is_cumulative_and_keeps_first_terminal_failure() {
    use std::{
        future::Future,
        task::{Context, Wake},
    };
    struct WakeCount(std::sync::atomic::AtomicUsize);
    impl Wake for WakeCount {
        fn wake(self: Arc<Self>) {
            self.0.fetch_add(1, Ordering::Relaxed);
        }
    }
    let wake = Arc::new(WakeCount(std::sync::atomic::AtomicUsize::new(0)));
    let waker = wake.clone().into();
    let mut context = Context::from_waker(&waker);
    let shared = Shared::new();
    let mut observer = Observer { shared: shared.clone(), revision: 0 };
    let cancel = observer.cancel_handle();
    let mut pending = Box::pin(observer.next());
    assert!(pending.as_mut().poll(&mut context).is_pending());
    shared.prepared().unwrap();
    assert_eq!(wake.0.load(Ordering::Relaxed), 1);
    let Poll::Ready(Some(first)) = pending.as_mut().poll(&mut context) else { panic!("prepared progress") };
    assert_eq!(first.revision, 1);
    drop(pending);
    let evidence = Execution {
        compiled_identity: wire::IDENTITY,
        pid: 7,
        cwd_device: 1,
        cwd_inode: 2,
        nonce: "n".into(),
        frame_bytes: 2,
        frame_sha256: "f".into(),
        text_bytes: 1,
        text_sha256: "t".into(),
        parent_artifact_sha256: "a".into(),
    };
    shared.consumed(evidence.clone());
    let uncertain = Report { result: Err(Error::CleanupUncertain), reaped: false, exit_code: None, resources_removed: false };
    shared.publish(uncertain.clone(), false);
    shared.publish(uncertain, false);
    let mut pending = Box::pin(observer.next());
    let Poll::Ready(Some(update)) = pending.as_mut().poll(&mut context) else { panic!("consumed/uncertain progress") };
    assert_eq!(update.revision, 3);
    assert_eq!(update.consumed, Some(evidence.clone()));
    drop(pending);
    let mut pending = Box::pin(observer.next());
    assert!(pending.as_mut().poll(&mut context).is_pending());
    cancel.cancel(); // Independent cancellation while the observer is mutably borrowed.
    assert_eq!(shared.active(), Err(Error::Revoked));
    shared.publish(Report { result: Ok(evidence), reaped: true, exit_code: Some(0), resources_removed: true }, true);
    let Poll::Ready(Some(done)) = pending.as_mut().poll(&mut context) else { panic!("final cleanup progress") };
    assert_eq!(done.revision, 4);
    assert_eq!(done.report.as_ref().unwrap().result, Err(Error::CleanupUncertain));
    assert!(done.report.unwrap().reaped && done.finished);
    drop(pending);
    assert!(matches!(Box::pin(observer.next()).as_mut().poll(&mut context), Poll::Ready(None)));
}

#[test]
#[ignore = "Runs alone in the staged fixed-native test process; intentionally retains ACTIVE"]
fn partial_preparation_retains_full_worker_slot() {
    ACTIVE.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).unwrap();
    let shared = Shared::new();
    worker::run(
        shared.clone(),
        FixtureCase::Ready,
        "never delivered".into(),
        Slot,
        worker::Fault::PartialPreparation,
        Some(Control { shared: shared.clone() }),
    );
    let done = report(&shared);
    assert_eq!(done.result, Err(Error::CleanupUncertain));
    assert!(!done.reaped && !done.resources_removed);
    assert_eq!(shared.pid.load(Ordering::Acquire), 0);
    assert!(!shared.parsed.load(Ordering::Acquire));
    assert!(matches!(automatic(FixtureCase::Ready, "busy"), Err(Error::Busy)));
    assert!(shared.completion.lock().unwrap().progress.finished);
    println!("PRIVATE_COPY_PARTIAL_PREPARATION_EVIDENCE noSpawn=true cleanupUncertain=true retainedSlotBusy=true");
}

#[test]
#[ignore = "Only the staging checker provides the fixed native sibling"]
fn coordinated_native_commit_progress_and_cancel() {
    let (control, observer) = prepare(FixtureCase::IgnoreCancel, "coordinated consumed prompt").unwrap();
    wait_flag(|| observer.shared.completion.lock().unwrap().progress.prepared);
    assert_eq!(observer.shared.pid.load(Ordering::Acquire), 0);
    assert!(matches!(automatic(FixtureCase::Ready, "same core busy"), Err(Error::Busy)));
    control.stamp(control.capture().unwrap()).unwrap();
    wait_flag(|| observer.shared.completion.lock().unwrap().progress.consumed.is_some());
    assert!(observer.shared.completion.lock().unwrap().progress.report.is_none());
    assert!(matches!(prepare(FixtureCase::Ready, "same core busy"), Err(Error::Busy)));
    observer.cancel_handle().cancel();
    let done = report(&observer.shared);
    assert_eq!(done.result, Err(Error::Revoked));
    assert!(done.reaped && done.resources_removed);
    drop(control);
    drop(observer);
    let (control, observer) = prepare(FixtureCase::Ready, "no stamp before drop").unwrap();
    wait_flag(|| observer.shared.completion.lock().unwrap().progress.prepared);
    drop(control);
    let done = report(&observer.shared);
    assert_eq!(done.result, Err(Error::Revoked));
    assert_eq!(observer.shared.pid.load(Ordering::Acquire), 0);
    assert!(done.resources_removed);
    println!("PRIVATE_COPY_COORDINATED_EVIDENCE oneCoreBusy=true noUnstampedSpawn=true consumedBeforeExit=true cancelReaped=true controlDropRevoked=true");
}

#[test]
#[ignore = "Only the staging checker provides the fixed native sibling"]
fn retained_unstamped_worker_expires_and_closes_control() {
    let (control, observer) = prepare(FixtureCase::Ready, "never admitted").unwrap();
    wait_flag(|| observer.shared.completion.lock().unwrap().progress.prepared);
    let until = Instant::now() + Duration::from_secs(7);
    while observer.shared.completion.lock().unwrap().progress.report.is_none() {
        assert!(Instant::now() < until);
        thread::sleep(Duration::from_millis(5));
    }
    let done = report(&observer.shared);
    assert_eq!(done.result, Err(Error::Deadline));
    assert!(!done.reaped && done.resources_removed);
    assert_eq!(observer.shared.pid.load(Ordering::Acquire), 0);
    assert!(matches!(control.capture(), Err(Error::Revoked)));
    let next = automatic(FixtureCase::Ready, "capacity released after deadline").unwrap();
    let completed = report(&next.shared);
    assert!(completed.result.is_ok() && completed.reaped && completed.resources_removed);
    println!("PRIVATE_COPY_UNSTAMPED_DEADLINE_EVIDENCE noSpawn=true removed=true closedControl=true capacityReleased=true");
}

#[test]
fn reservation_owns_capacity_before_activation_and_expiry_never_resets() {
    let (control, observer, reservation) = reserve(FixtureCase::Ready, "unstarted", None, Instant::now()).unwrap();
    assert!(matches!(automatic(FixtureCase::Ready, "busy"), Err(Error::Busy)));
    assert!(!observer.shared.completion.lock().unwrap().progress.prepared);
    let mut running = reservation.activate();
    assert!(running.worker.is_none());
    assert_eq!(report(&observer.shared).result, Err(Error::Deadline));
    let ack = running.try_join().unwrap().unwrap();
    let foreign = Control { shared: Shared::new() };
    let ack = foreign.accept_cleanup(ack).expect_err("foreign identity must refuse");
    assert!(matches!(control.accept_cleanup(ack), Ok(Disposal::NoChild)));
    assert!(matches!(running.try_join(), Err(Error::Revoked)));

    let (control, observer, reservation) =
        reserve(FixtureCase::Ready, "cancel before thread", None, Instant::now() + Duration::from_secs(5)).unwrap();
    observer.cancel_handle().cancel();
    let mut running = reservation.activate();
    assert!(running.worker.is_none());
    assert!(matches!(control.accept_cleanup(running.try_join().unwrap().unwrap()), Ok(Disposal::NoChild)));
    assert_eq!(report(&observer.shared).result, Err(Error::Revoked));

    let (control, observer, reservation) =
        reserve(FixtureCase::Ready, "explicit abandonment", None, Instant::now() + Duration::from_secs(5)).unwrap();
    assert!(matches!(control.accept_cleanup(reservation.abandon()), Ok(Disposal::NoChild)));
    assert!(report(&observer.shared).resources_removed);
}

#[test]
fn final_gate_refuses_expired_stamp_and_commit() {
    let shared = Shared::until(Instant::now());
    let control = Control { shared: shared.clone() };
    let capture = Capture { shared: shared.clone(), epoch: 0 };
    {
        let mut gate = shared.gate.lock().unwrap();
        gate.prepared = true;
        gate.validated = Some(0);
    }
    assert_eq!(shared.commit(), Err(Error::Deadline));
    assert!(shared.gate.lock().unwrap().phase == Phase::Pending);
    shared.gate.lock().unwrap().validated = None;
    assert_eq!(control.stamp(capture), Err(Error::Deadline));
}

#[test]
#[ignore = "Only the staging checker provides the fixed native sibling; runs serially"]
fn registered_workspace_requires_joined_cleanup_ack() {
    use std::{
        fs::{self, File},
        os::unix::fs::{MetadataExt, PermissionsExt},
    };
    fn workspace() -> (tempfile::TempDir, RegisteredWorkspace, [i32; 4], (u64, u64)) {
        let root = tempfile::Builder::new().prefix("milagre-acp-registered-").tempdir_in("/private/tmp").unwrap();
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
        for name in ["project", "home", "tmp"] {
            fs::create_dir(root.path().join(name)).unwrap();
        }
        let meta = root.path().join("project").metadata().unwrap();
        let input = RegisteredWorkspace::from_descriptors(
            File::open(root.path().join("project")).unwrap(),
            File::open(root.path().join("home")).unwrap(),
            File::open(root.path().join("tmp")).unwrap(),
        )
        .unwrap();
        let fds = input.0.descriptors();
        (root, input, fds, (meta.dev(), meta.ino()))
    }
    fn closed(fds: [i32; 4]) {
        for fd in fds {
            assert_eq!(unsafe { libc::fcntl(fd, libc::F_GETFD) }, -1);
            assert_eq!(std::io::Error::last_os_error().raw_os_error(), Some(libc::EBADF));
        }
    }
    let (root, input, fds, identity) = workspace();
    let text = "registered workspace consumed \"input\" \n ä😀";
    let (control, observer, reservation) = reserve(FixtureCase::Ready, text, Some(input), Instant::now() + Duration::from_secs(5)).unwrap();
    let barrier = Arc::new(std::sync::Barrier::new(2));
    *observer.shared.before_return.lock().unwrap() = Some(barrier.clone());
    let mut running = reservation.activate();
    wait_flag(|| observer.shared.completion.lock().unwrap().progress.prepared);
    control.stamp(control.capture().unwrap()).unwrap();
    barrier.wait();
    let done = report(&observer.shared);
    let execution = done.result.as_ref().unwrap();
    assert_eq!((execution.cwd_device, execution.cwd_inode), identity);
    assert_eq!(execution.text_bytes, text.len());
    assert_eq!(done.exit_code, Some(0));
    assert!(done.reaped && done.resources_removed && observer.shared.completion.lock().unwrap().progress.finished);
    assert!(running.try_join().unwrap().is_none());
    assert!(matches!(automatic(FixtureCase::Ready, "descriptors still held"), Err(Error::Busy)));
    for fd in fds {
        assert!(unsafe { libc::fcntl(fd, libc::F_GETFD) } >= 0);
    }
    assert!(root.path().join("project").exists());
    barrier.wait();
    wait_flag(|| running.is_finished());
    let ack = running.try_join().unwrap().unwrap();
    closed(fds);
    assert!(matches!(control.accept_cleanup(ack), Ok(Disposal::Reaped { natural_zero: true, exit_code: Some(0), .. })));
    assert!(root.path().join("project").exists());
    println!("PRIVATE_COPY_REGISTERED_WORKSPACE_EVIDENCE pid={} cwdDevice={} cwdInode={} textSha256={} joined=true descriptorsClosed=true serviceDirectoriesRetained=true naturalZero=true", execution.pid, identity.0, identity.1, execution.text_sha256);

    let (root, input, fds, _) = workspace();
    let (control, observer, reservation) = reserve(FixtureCase::Ready, "expired before activation", Some(input), Instant::now()).unwrap();
    let mut running = reservation.activate();
    assert!(running.worker.is_none());
    let ack = running.try_join().unwrap().unwrap();
    closed(fds);
    assert!(matches!(control.accept_cleanup(ack), Ok(Disposal::NoChild)));
    assert_eq!(report(&observer.shared).result, Err(Error::Deadline));
    assert!(root.path().join("project").exists());

    let (root, input, fds, _) = workspace();
    let deadline = Instant::now() + Duration::from_secs(5);
    let (control, observer, reservation) = reserve(FixtureCase::Ready, "expire before final commitment", Some(input), deadline).unwrap();
    let barrier = Arc::new(std::sync::Barrier::new(2));
    *observer.shared.before_commit.lock().unwrap() = Some(barrier.clone());
    let mut running = reservation.activate();
    wait_flag(|| observer.shared.completion.lock().unwrap().progress.prepared);
    control.stamp(control.capture().unwrap()).unwrap();
    barrier.wait();
    thread::sleep(deadline.saturating_duration_since(Instant::now()) + Duration::from_millis(1));
    barrier.wait();
    wait_flag(|| running.is_finished());
    let ack = running.try_join().unwrap().unwrap();
    closed(fds);
    assert!(matches!(control.accept_cleanup(ack), Ok(Disposal::NoChild)));
    assert_eq!(report(&observer.shared).result, Err(Error::Deadline));
    assert_eq!(observer.shared.pid.load(Ordering::Acquire), 0);
    assert!(root.path().join("project").exists());

    let (root, input, fds, _) = workspace();
    fs::rename(root.path().join("project"), root.path().join("held-project")).unwrap();
    fs::create_dir(root.path().join("project")).unwrap();
    let (control, observer, reservation) =
        reserve(FixtureCase::Ready, "refuse replacement cwd", Some(input), Instant::now() + Duration::from_secs(5)).unwrap();
    let mut running = reservation.activate();
    wait_flag(|| running.is_finished());
    let ack = running.try_join().unwrap().unwrap();
    closed(fds);
    assert!(matches!(control.accept_cleanup(ack), Ok(Disposal::NoChild)));
    assert_eq!(report(&observer.shared).result, Err(Error::Identity));
    assert_eq!(observer.shared.pid.load(Ordering::Acquire), 0);
    assert!(root.path().join("project").exists() && root.path().join("held-project").exists());

    let (root, input, fds, _) = workspace();
    let (control, observer, reservation) =
        reserve(FixtureCase::Ready, "thread cannot start", Some(input), Instant::now() + Duration::from_secs(5)).unwrap();
    let mut running = reservation.activate_with(None, worker::Fault::ThreadSpawnFailure);
    assert!(running.worker.is_none());
    let ack = running.try_join().unwrap().unwrap();
    closed(fds);
    assert!(matches!(control.accept_cleanup(ack), Ok(Disposal::NoChild)));
    assert_eq!(report(&observer.shared).result, Err(Error::Spawn));
    assert!(root.path().join("project").exists());

    for fault in [worker::Fault::None, worker::Fault::PanicAfterSpawn, worker::Fault::SpawnFailure] {
        let (root, input, fds, _) = workspace();
        let (control, observer, reservation) =
            reserve(FixtureCase::IgnoreCancel, "registered cleanup", Some(input), Instant::now() + Duration::from_secs(5)).unwrap();
        let mut running = reservation.activate_with(None, fault);
        wait_flag(|| observer.shared.completion.lock().unwrap().progress.prepared);
        control.stamp(control.capture().unwrap()).unwrap();
        if matches!(fault, worker::Fault::None) {
            wait_flag(|| observer.shared.parsed.load(Ordering::Acquire));
            observer.cancel_handle().cancel();
        }
        wait_flag(|| running.is_finished());
        let ack = running.try_join().unwrap().unwrap();
        closed(fds);
        let disposition = control.accept_cleanup(ack).unwrap_or_else(|_| panic!("exact cleanup identity"));
        assert!(matches!(disposition, Disposal::NoChild | Disposal::Reaped { natural_zero: false, .. }));
        assert!(report(&observer.shared).result.is_err());
        assert!(root.path().join("project").exists());
    }
    println!(
        "PRIVATE_COPY_REGISTERED_LIFETIME_EVIDENCE noDeadlineReset=true expiredCommitNoSpawn=true replacementRefused=true threadFailure=true cancellation=true panic=true spawnFailure=true noHostBinding=true"
    );
}

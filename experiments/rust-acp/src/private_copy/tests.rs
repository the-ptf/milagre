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
    wait_flag(|| shared.completion.lock().unwrap().report.is_some());
    shared.completion.lock().unwrap().report.clone().unwrap()
}
#[test]
fn public_text_limit_and_api_errors_are_redacted() {
    assert!(matches!(MacOsPrivateCopyFixture::start(FixtureCase::Ready, &"x".repeat(wire::TEXT_LIMIT + 1)), Err(Error::Bounds)));
    assert_eq!(format!("{}", Error::Identity), "Identity");
}
#[test]
#[ignore = "Only scripts/check-private-copy-fixture.py stages the fixed native sibling"]
fn native_private_copy_end_to_end() {
    let old = std::env::var_os("DYLD_INSERT_LIBRARIES");
    std::env::set_var("DYLD_INSERT_LIBRARIES", "/synthetic-forbidden-loader");
    let text = "native consumed \"text\" with \n Unicode ä😀 and \0";
    let fixture = MacOsPrivateCopyFixture::start(FixtureCase::Ready, text).unwrap();
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
        let fixture = MacOsPrivateCopyFixture::start(FixtureCase::IgnoreCancel, "cancel consumed text").unwrap();
        let shared = fixture.shared.clone();
        wait_flag(|| shared.parsed.load(Ordering::Acquire));
        if drop_observer {
            drop(fixture);
        } else {
            fixture.cancel();
        }
        let done = report(&shared);
        assert_eq!(done.result, Err(Error::Revoked));
        assert!(done.reaped && done.resources_removed);
    }
    for fault in [worker::Fault::PanicAfterSpawn, worker::Fault::SpawnFailure] {
        ACTIVE.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).unwrap();
        let shared = Shared::new();
        let retained = shared.clone();
        thread::spawn(move || worker::run(retained, FixtureCase::Ready, "fault fixture".into(), Slot, fault));
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
    shared.phase.store(REVOKED, Ordering::Release);
    worker::run(shared.clone(), FixtureCase::Ready, "never admitted".into(), Slot, worker::Fault::None);
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
        thread::spawn(move || worker::run(retained, FixtureCase::Ready, "no consumed prompt".into(), Slot, worker::Fault::None));
        barrier.wait();
        shared.phase.store(REVOKED, Ordering::Release);
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

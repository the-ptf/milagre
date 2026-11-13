use crate::{composed_owner as composed, native_core as native};
use milagre_owner_store::chat_host::Notice;
use sha2::{Digest, Sha256};
use std::{
    thread,
    time::{Duration, Instant},
};

fn wait(watch: &composed::Watch, condition: impl Fn(&composed::Snapshot) -> bool) -> composed::Snapshot {
    let until = Instant::now() + Duration::from_secs(12);
    loop {
        let snapshot = watch.snapshot();
        if condition(&snapshot) {
            return snapshot;
        }
        assert!(Instant::now() < until, "bounded composed observation: {snapshot:?}");
        thread::sleep(Duration::from_millis(10));
    }
}
fn events(notices: &[Notice]) -> Vec<&str> {
    notices
        .iter()
        .filter_map(|notice| match notice {
            Notice::Event { event, .. } => event.get("type").and_then(|v| v.as_str()),
            _ => None,
        })
        .collect()
}
#[test]
#[ignore = "Only the fixed native staging checker provides the sibling executable"]
fn real_ready_turn_consumes_captured_prompt_and_joins_before_close() {
    let mut fixture = composed::Fixture::create(native::FixtureCase::Ready).unwrap();
    let watch = fixture.watch();
    let text = "host-created exact prompt\nwith unicode \u{263a}";
    fixture.send(text).unwrap();
    let done = wait(&watch, |s| s.terminal.is_some());
    assert_eq!(done.terminal, Some(composed::Terminal::Completed));
    assert_eq!(done.error, None);
    let receipt = done.receipt.unwrap();
    let evidence = done.evidence.unwrap();
    assert_eq!(evidence.generation, 0);
    assert!(evidence.turn > 0);
    assert_eq!(receipt.text_sha256, format!("{:x}", Sha256::digest(text.as_bytes())));
    assert_eq!((receipt.cwd_device, receipt.cwd_inode), evidence.cwd);
    assert!(matches!(done.disposal, Some(native::Disposal::Reaped { natural_zero: true, exit_code: Some(0), .. })));
    let notices = fixture.notices().unwrap();
    assert_eq!(notices.iter().filter(|n| matches!(n, Notice::Started { .. })).count(), 1);
    let started =
        notices.iter().find_map(|n| if let Notice::Started { turn, result, .. } = n { Some((turn, result)) } else { None }).unwrap();
    assert_eq!(started.0 .0, evidence.turn);
    assert_eq!(started.1["turnId"], format!("fixture-{}", receipt.nonce));
    let types = events(&notices);
    assert_eq!(types.iter().filter(|v| **v == "turn-started").count(), 1);
    assert_eq!(types.iter().filter(|v| **v == "turn-completed").count(), 1);
    assert!(!types.iter().any(|v| matches!(*v, "turn-failed" | "turn-cancelled" | "text-delta")));
    let state = fixture.state().unwrap();
    let messages = state["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0]["role"], "user");
    assert_eq!(messages[0]["body"], text);
    assert_eq!(messages[1]["role"], "assistant");
    assert_eq!(messages[1]["body"], "The agent finished without a reply.");
    assert_eq!(messages[1]["outcome"], "completed");
    assert!(fixture.locks().unwrap().account_busy);
    fixture.close(false).unwrap();
    let closed = wait(&watch, |s| s.closed);
    assert!(closed.resources_removed);
    println!("SERVICE_NATIVE_READY_EVIDENCE hostTurn={} generation=0 promptSha256={} cwdDevice={} cwdInode={} pid={} joined=true emptyTurn=true resourcesRemoved=true", evidence.turn, receipt.text_sha256, receipt.cwd_device, receipt.cwd_inode, receipt.pid);
}
#[test]
#[ignore = "Only the fixed native staging checker provides the sibling executable"]
fn real_ignore_cancel_holds_services_until_joined_cleanup() {
    let mut fixture = composed::Fixture::create(native::FixtureCase::IgnoreCancel).unwrap();
    let watch = fixture.watch();
    fixture.send("stalled fixed native prompt").unwrap();
    let consumed = wait(&watch, |s| s.receipt.is_some());
    assert!(consumed.disposal.is_none() && consumed.terminal.is_none());
    let locks = fixture.locks().unwrap();
    assert!(locks.account_busy && locks.project_busy == Some(true));
    assert_eq!(fixture.close(false), Err(composed::Error::Busy));
    assert!(watch.snapshot().terminal.is_none());
    fixture.close(true).unwrap();
    let closed = wait(&watch, |s| s.closed);
    assert_eq!(closed.terminal, Some(composed::Terminal::Cancelled));
    assert!(matches!(closed.disposal, Some(native::Disposal::Reaped { natural_zero: false, .. })));
    assert!(closed.resources_removed);
    println!(
        "SERVICE_NATIVE_IGNORE_CANCEL_EVIDENCE hostTurn={} pid={} joined=true ownerHeldUntilAck=true resourcesRemoved=true",
        consumed.evidence.unwrap().turn,
        consumed.receipt.unwrap().pid
    );
}

fn pause_entered(pause: &native::TestPause) {
    let until = Instant::now() + Duration::from_secs(8);
    while !pause.entered() {
        assert!(Instant::now() < until, "bounded native pause");
        thread::sleep(Duration::from_millis(5));
    }
}
fn close(fixture: &mut composed::Fixture, watch: &composed::Watch) -> composed::Snapshot {
    fixture.close(true).unwrap();
    let result = wait(watch, |s| s.closed);
    assert!(result.resources_removed);
    result
}
#[test]
#[ignore = "Only the fixed native staging checker provides the sibling executable"]
fn cancellation_commit_races_and_authority_round_trip_never_complete() {
    let mut early = composed::Fixture::create(native::FixtureCase::Ready).unwrap();
    let watch = early.watch();
    early.cancel_handle().cancel();
    assert_eq!(early.send("never admitted"), Err(composed::Error::Closed));
    let ended = close(&mut early, &watch);
    assert!(ended.evidence.is_none() && ended.receipt.is_none() && ended.disposal.is_none());
    for point in [native::TestPoint::BeforeCommit, native::TestPoint::AfterCommit] {
        let mut fixture = composed::Fixture::create(native::FixtureCase::IgnoreCancel).unwrap();
        let watch = fixture.watch();
        let pause = fixture.send_paused("one commit", point).unwrap();
        pause_entered(&pause);
        fixture.mutate(crate::service_owner::Mutation::ReobserveSignedOut).unwrap();
        fixture.mutate(crate::service_owner::Mutation::ReobserveReady).unwrap();
        assert_eq!(fixture.send("old admission cannot replay"), Err(composed::Error::Busy));
        pause.release();
        let ended = wait(&watch, |s| s.terminal.is_some());
        assert_ne!(ended.terminal, Some(composed::Terminal::Completed));
        assert!(ended.receipt.is_none());
        match point {
            native::TestPoint::BeforeCommit => assert_eq!(ended.disposal, Some(native::Disposal::NoChild)),
            native::TestPoint::AfterCommit => assert!(matches!(ended.disposal, Some(native::Disposal::Reaped { natural_zero: false, .. }))),
            _ => unreachable!(),
        }
        assert!(!fixture.notices().unwrap().iter().any(|n| matches!(n, Notice::Started { .. })));
        close(&mut fixture, &watch);
    }
    println!("SERVICE_NATIVE_CANCEL_RACES_EVIDENCE beforeAdmission=true pendingNoSpawn=true committedReaped=true readyRoundTripRevoked=true noReplay=true");
}
#[test]
#[ignore = "Only the fixed native staging checker provides the sibling executable"]
fn final_report_does_not_release_registered_workspace_before_join() {
    let mut fixture = composed::Fixture::create(native::FixtureCase::Ready).unwrap();
    let watch = fixture.watch();
    let pause = fixture.send_paused("report is not cleanup authority", native::TestPoint::BeforeReturn).unwrap();
    pause_entered(&pause);
    let public = wait(&watch, |s| s.report.is_some());
    assert!(public.report.unwrap().resources_removed);
    assert!(public.disposal.is_none() && public.terminal.is_none());
    assert!(matches!(native::automatic(native::FixtureCase::Ready, "must stay busy"), Err(native::Error::Busy)));
    assert_eq!(fixture.mutate(crate::service_owner::Mutation::ReopenAccount), Err(composed::Error::Busy));
    assert!(fixture.locks().unwrap().account_busy);
    fixture.close_project(true).unwrap();
    thread::sleep(Duration::from_millis(40));
    let held = watch.snapshot();
    assert!(!held.project_closed && !held.closed && held.disposal.is_none());
    let locks = fixture.locks().unwrap();
    assert!(locks.account_busy && locks.project_busy == Some(true));
    pause.release();
    let ended = wait(&watch, |s| s.project_closed);
    assert!(ended.disposal.is_some() && !ended.closed && !ended.resources_removed);
    let locks = fixture.locks().unwrap();
    assert!(locks.account_busy && locks.project_busy == Some(false));
    assert_eq!(fixture.state(), Err(composed::Error::Service(crate::service_owner::Error::Closed)));
    close(&mut fixture, &watch);
    println!("SERVICE_NATIVE_JOIN_BARRIER_EVIDENCE reportInsufficient=true capacityHeld=true reopenWriterHeld=true projectCloseWaited=true accountHeldUntilAllClose=true");
}
#[test]
#[ignore = "Only the fixed native staging checker provides the sibling executable"]
fn uncertain_native_cleanup_recovers_ack_without_rewriting_failed_turn() {
    let mut fixture = composed::Fixture::create(native::FixtureCase::IgnoreCancel).unwrap();
    let watch = fixture.watch();
    let pause = fixture.send_paused("retain the real exact child", native::TestPoint::Cleanup).unwrap();
    wait(&watch, |s| s.receipt.is_some());
    fixture.cancel_handle().cancel();
    pause_entered(&pause);
    let unknown = wait(&watch, |s| s.terminal == Some(composed::Terminal::Failed));
    assert_eq!(unknown.error, Some(composed::Error::Native(native::Error::CleanupUncertain)));
    assert!(unknown.disposal.is_none() && !unknown.report.unwrap().reaped);
    assert!(matches!(native::automatic(native::FixtureCase::Ready, "retained capacity"), Err(native::Error::Busy)));
    let locks = fixture.locks().unwrap();
    assert!(locks.account_busy && locks.project_busy == Some(true));
    fixture.close(true).unwrap();
    thread::sleep(Duration::from_millis(40));
    assert!(!watch.snapshot().closed);
    pause.release();
    let done = wait(&watch, |s| s.closed);
    assert!(done.resources_removed && matches!(done.disposal, Some(native::Disposal::Reaped { natural_zero: false, .. })));
    assert_eq!(done.terminal, Some(composed::Terminal::Failed));
    assert_eq!(done.error, Some(composed::Error::Native(native::Error::CleanupUncertain)));
    println!("SERVICE_NATIVE_CLEANUP_RECOVERY_EVIDENCE workerHeldExactChild=true initialUncertain=true serviceLocksHeld=true laterJoinedAck=true stickyFailure=true removed=true");
}
#[test]
#[ignore = "Only the fixed native staging checker provides the sibling executable"]
fn native_failures_actor_panic_and_facade_drop_keep_cleanup_ownership() {
    for fault in
        [native::TestFault::WorkerPanic, native::TestFault::Spawn, native::TestFault::ThreadSpawn, native::TestFault::MalformedFrame]
    {
        let mut fixture = composed::Fixture::create_fault(native::FixtureCase::IgnoreCancel, fault).unwrap();
        let watch = fixture.watch();
        fixture.send("failure before native consumption").unwrap();
        let done = wait(&watch, |s| s.terminal.is_some());
        assert_eq!(done.terminal, Some(composed::Terminal::Failed));
        assert!(done.receipt.is_none() && done.disposal.is_some());
        assert!(!fixture.notices().unwrap().iter().any(|n| matches!(n, Notice::Started { .. })));
        close(&mut fixture, &watch);
    }
    let mut unactivated = composed::Fixture::create(native::FixtureCase::Ready).unwrap();
    let no_worker = unactivated.watch();
    unactivated.panic_activation().unwrap();
    assert_eq!(unactivated.send("panic owns the reservation"), Err(composed::Error::Worker));
    let abandoned = wait(&no_worker, |s| s.closed);
    assert_eq!(abandoned.disposal, Some(native::Disposal::NoChild));
    assert_eq!(abandoned.terminal, Some(composed::Terminal::Failed));
    assert!(abandoned.resources_removed);
    let mut fixture = composed::Fixture::create(native::FixtureCase::IgnoreCancel).unwrap();
    let watch = fixture.watch();
    fixture.send("actor panic retains flight").unwrap();
    wait(&watch, |s| s.receipt.is_some());
    assert_eq!(fixture.panic_actor(), Err(composed::Error::Worker));
    let done = wait(&watch, |s| s.closed);
    assert_eq!(done.terminal, Some(composed::Terminal::Failed));
    assert!(done.disposal.is_some() && done.resources_removed);
    let mut fixture = composed::Fixture::create(native::FixtureCase::IgnoreCancel).unwrap();
    let watch = fixture.watch();
    fixture.send("dropped caller retains owner actor").unwrap();
    wait(&watch, |s| s.receipt.is_some());
    drop(fixture);
    let done = wait(&watch, |s| s.closed);
    assert!(done.disposal.is_some() && done.resources_removed);
    println!(
        "SERVICE_NATIVE_FAILURES_EVIDENCE nativePanicReaped=true spawnFailuresNoChild=true malformedInputRefused=true actorPanicReaped=true reservationPanicAbandoned=true droppedFacadeReaped=true"
    );
}

#[test]
#[ignore = "Only the fixed native staging checker provides the sibling executable"]
fn native_ack_does_not_override_failed_service_close() {
    let mut fixture = composed::Fixture::create(native::FixtureCase::IgnoreCancel).unwrap();
    let watch = fixture.watch();
    fixture.send("owner save still matters after native reap").unwrap();
    wait(&watch, |s| s.receipt.is_some());
    fixture.mutate(crate::service_owner::Mutation::SwapProject).unwrap();
    fixture.close(true).unwrap();
    let failed = wait(&watch, |s| s.disposal.is_some() && s.close_error == Some(crate::service_owner::Error::Owner));
    assert!(!failed.closed && !failed.resources_removed);
    assert!(fixture.locks().unwrap().account_busy);
    fixture.mutate(crate::service_owner::Mutation::RestoreProject).unwrap();
    close(&mut fixture, &watch);
    println!("SERVICE_NATIVE_OWNER_RETRY_EVIDENCE nativeAckBeforeClose=true failedSaveRetainedWriter=true restoredOwnerClosed=true");
}
#[test]
#[ignore = "Fixed staging parent removes retained service roots only after this process exits"]
fn native_ack_cannot_clear_consumed_service_release_uncertainty() {
    let mut fixture = composed::Fixture::create(native::FixtureCase::Ready).unwrap();
    let watch = fixture.watch();
    fixture.send("native success cannot prove service disposal").unwrap();
    wait(&watch, |s| s.terminal.is_some());
    fixture.block_release().unwrap();
    fixture.close(true).unwrap();
    let failed = wait(&watch, |s| s.error == Some(composed::Error::Service(crate::service_owner::Error::CleanupUncertain)));
    assert!(failed.disposal.is_some() && !failed.closed && !failed.resources_removed);
    assert!(fixture.locks().unwrap().account_busy);
    fixture.close(true).unwrap();
    thread::sleep(Duration::from_millis(40));
    assert!(!watch.snapshot().closed && fixture.locks().unwrap().account_busy);
    assert_eq!(
        fixture.mutate(crate::service_owner::Mutation::ReopenAccount),
        Err(composed::Error::Service(crate::service_owner::Error::CleanupUncertain))
    );
    fixture.record_retention().unwrap();
    drop(fixture);
    println!("SERVICE_NATIVE_OWNER_UNCERTAIN_EVIDENCE nativeAckInsufficient=true stickyServiceUncertainty=true accountWriterRetained=true rootsRetained=true");
}

#[test]
#[ignore = "Only the fixed native staging checker provides the sibling executable"]
fn completion_decision_linearizes_before_host_fold_and_rejects_late_cancel() {
    let mut fixture = composed::Fixture::create(native::FixtureCase::Ready).unwrap();
    let watch = fixture.watch();
    let pause = fixture.pause_terminal().unwrap();
    fixture.send("one terminal decision").unwrap();
    pause_entered(&pause);
    let decided = watch.snapshot();
    assert_eq!(decided.decision, Some(composed::Terminal::Completed));
    assert!(decided.terminal.is_none() && decided.disposal.is_some());
    assert!(!fixture.cancel_handle().cancel(), "completion already won the same route gate");
    pause.release();
    let done = wait(&watch, |s| s.terminal.is_some());
    assert_eq!(done.terminal, Some(composed::Terminal::Completed));
    let notices = fixture.notices().unwrap();
    assert_eq!(events(&notices).iter().filter(|v| **v == "turn-completed").count(), 1);
    close(&mut fixture, &watch);
    println!("SERVICE_NATIVE_TERMINAL_RACE_EVIDENCE immutableDecision=true lateCancelRejected=true actualCompletedOnce=true");
}

#[test]
fn rejected_provider_enqueue_is_distinct_from_retained_owner_fold() {
    use crate::service_owner::{DeliveryError, Error, Scenario, ServiceOwner, Signal};
    let mut first = ServiceOwner::for_composition(Scenario::Ready).unwrap();
    let mut second = ServiceOwner::for_composition(Scenario::Ready).unwrap();
    let one = first.send_until("first pending".into(), Instant::now() + Duration::from_secs(5)).unwrap();
    let two = second.send_until("second pending".into(), Instant::now() + Duration::from_secs(5)).unwrap();
    assert!(matches!(second.native_signals(&one, vec![Signal::Completed], 0), Err(DeliveryError::Rejected(Error::Revoked))));
    assert!(matches!(
        second.native_signals(&two, vec![Signal::Started("bad identifier".into())], 0),
        Err(DeliveryError::Rejected(Error::Request))
    ));
    assert!(second.native_active(&two).unwrap());
    second.mutate(crate::service_owner::Mutation::SwapProject).unwrap();
    let retained = second.native_signals(&two, vec![Signal::StartFailed], 0);
    second.mutate(crate::service_owner::Mutation::RestoreProject).unwrap();
    assert!(matches!(retained, Err(DeliveryError::Retained(Error::Owner))));
    assert!(second.finish().unwrap().resources_removed);
    assert!(first.finish().unwrap().resources_removed);
}

#[test]
#[ignore = "Fixed staging parent removes retained native/service roots after this process exits"]
fn native_partial_preparation_withholds_ack_and_retains_all_service_owners() {
    let mut fixture = composed::Fixture::create_fault(native::FixtureCase::Ready, native::TestFault::PartialPreparation).unwrap();
    let watch = fixture.watch();
    fixture.send("no executed child, still no disposal authority").unwrap();
    let done = wait(&watch, |s| s.terminal == Some(composed::Terminal::Failed));
    assert_eq!(done.error, Some(composed::Error::Native(native::Error::CleanupUncertain)));
    assert!(done.receipt.is_none() && done.disposal.is_none());
    fixture.close(true).unwrap();
    thread::sleep(Duration::from_millis(40));
    assert!(!watch.snapshot().closed);
    let locks = fixture.locks().unwrap();
    assert!(locks.account_busy && locks.project_busy == Some(true));
    assert!(matches!(native::automatic(native::FixtureCase::Ready, "no reclaimed slot"), Err(native::Error::Busy)));
    fixture.record_retention().unwrap();
    drop(fixture);
    println!(
        "SERVICE_NATIVE_PREPARATION_RETAINED_EVIDENCE noChild=true noAck=true nativeSlotHeld=true serviceOwnersHeld=true serviceReleaseRefused=true"
    );
}

#[test]
#[ignore = "Only the fixed native staging checker provides the sibling executable"]
fn cancellation_between_validation_and_stamp_and_absolute_activation_deadline() {
    for point in [composed::AdmissionPoint::BeforeActivation, composed::AdmissionPoint::BeforeStamp] {
        let mut fixture = composed::Fixture::create(native::FixtureCase::Ready).unwrap();
        let watch = fixture.watch();
        let cancel = fixture.cancel_handle();
        let pause = fixture.pause_admission(point).unwrap();
        let sender = thread::spawn(move || {
            let result = fixture.send("revoked in admission gap");
            (fixture, result)
        });
        pause_entered(&pause);
        assert!(cancel.cancel());
        pause.release();
        let (mut fixture, result) = sender.join().unwrap();
        result.unwrap();
        let done = wait(&watch, |s| s.terminal.is_some());
        assert_eq!(done.disposal, Some(native::Disposal::NoChild));
        assert!(done.receipt.is_none());
        close(&mut fixture, &watch);
    }
    let mut fixture = composed::Fixture::create(native::FixtureCase::Ready).unwrap();
    let watch = fixture.watch();
    let pause = fixture.pause_admission(composed::AdmissionPoint::BeforeActivation).unwrap();
    let sender = thread::spawn(move || {
        let result = fixture.send("one absolute deadline");
        (fixture, result)
    });
    pause_entered(&pause);
    thread::sleep(Duration::from_secs(5));
    pause.release();
    let (mut fixture, result) = sender.join().unwrap();
    result.unwrap();
    let done = wait(&watch, |s| s.terminal.is_some());
    assert_eq!(done.disposal, Some(native::Disposal::NoChild));
    assert_eq!(done.error, Some(composed::Error::Native(native::Error::Deadline)));
    assert!(done.receipt.is_none());
    close(&mut fixture, &watch);
    println!("SERVICE_NATIVE_ADMISSION_GAPS_EVIDENCE activationCancelNoSpawn=true validatedStampCancelNoSpawn=true absoluteDeadlineNotReset=true");
}

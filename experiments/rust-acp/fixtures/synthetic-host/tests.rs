use super::service_owner::{Close, Error, Fixture, Mutation, Scenario};

#[test]
fn real_service_capture_uses_generation_zero_and_owner_allocated_turn() {
    let mut fixture = Fixture::create(Scenario::Ready).unwrap();
    let locks = fixture.locks().unwrap();
    assert!(locks.account_busy && locks.project_busy == Some(true));
    let id = fixture.send("one actual owner admission").unwrap();
    let evidence = fixture.validate(&id).unwrap();
    assert_eq!(evidence.generation, 0);
    assert!(evidence.turn > 0);
    assert_eq!(fixture.retained_descriptor().unwrap(), evidence.cwd);
    assert_eq!(fixture.send("second"), Err(Error::Busy));
    assert_eq!(fixture.close(Close::Project, false), Err(Error::Busy));
    assert_eq!(fixture.validate(&id).unwrap(), evidence);
    assert!(fixture.close(Close::Project, true).unwrap().host_closed);
    let locks = fixture.locks().unwrap();
    assert!(locks.account_busy && locks.project_busy == Some(false));
    assert_eq!(fixture.validate(&id), Err(Error::Revoked));
    assert!(fixture.close(Close::All, true).unwrap().accounts_closed);
    let locks = fixture.locks().unwrap();
    assert!(!locks.account_busy && locks.project_busy == Some(false));
    let notices = fixture.notices().unwrap();
    assert!(!notices.iter().any(|n| matches!(n, milagre_owner_store::chat_host::Notice::Started { .. })));
    assert!(fixture.finish().unwrap().no_native_connection);
}

#[test]
fn signed_out_and_missing_scoped_selection_do_not_fallback() {
    for (scenario, error) in [(Scenario::SignedOut, Error::NotReady), (Scenario::MissingSelection, Error::Selection)] {
        let mut fixture = Fixture::create(scenario).unwrap();
        assert_eq!(fixture.send("refused"), Err(error));
        assert!(fixture.finish().unwrap().accounts_closed);
    }
}

#[test]
fn every_exclusive_mutation_revokes_capture_including_failed_attempts() {
    for mutation in [
        Mutation::ReobserveReady,
        Mutation::ReobserveSignedOut,
        Mutation::FailedObservation,
        Mutation::Metadata,
        Mutation::FailedMetadata,
        Mutation::ReopenAccount,
        Mutation::RegistryBytes,
    ] {
        let mut fixture = Fixture::create(Scenario::Ready).unwrap();
        let id = fixture.send("captured").unwrap();
        let _ = fixture.mutate(mutation);
        assert!(fixture.validate(&id).is_err());
        assert!(fixture.locks().unwrap().account_busy);
        assert!(fixture.finish().unwrap().accounts_closed);
    }
}

#[test]
fn foreign_capture_and_cancel_handle_cannot_authorize_old_admission() {
    let mut first = Fixture::create(Scenario::Ready).unwrap();
    let mut second = Fixture::create(Scenario::Ready).unwrap();
    let old = first.send("first").unwrap();
    let current = second.send("second").unwrap();
    assert_eq!(second.validate(&old), Err(Error::Revoked));
    assert!(second.validate(&current).is_ok());
    first.cancel_handle().cancel();
    assert_eq!(first.validate(&old), Err(Error::Revoked));
    assert!(second.validate(&current).is_ok());
    first.finish().unwrap();
    second.finish().unwrap();
}

#[test]
fn project_replacement_refuses_and_keeps_registered_directory_identity() {
    let mut fixture = Fixture::create(Scenario::Ready).unwrap();
    let id = fixture.send("descriptor").unwrap();
    let expected = fixture.validate(&id).unwrap().cwd;
    fixture.mutate(Mutation::SwapProject).unwrap();
    assert!(fixture.validate(&id).is_err());
    assert_eq!(fixture.retained_descriptor().unwrap(), expected);
    fixture.mutate(Mutation::RestoreProject).unwrap();
    assert_eq!(fixture.validate(&id), Err(Error::Revoked));
    assert!(fixture.finish().unwrap().resources_removed);
}

#[test]
fn actor_panic_closes_actual_service_owners_without_native_execution() {
    let mut fixture = Fixture::create(Scenario::Ready).unwrap();
    fixture.send("no child").unwrap();
    assert_eq!(fixture.mutate(Mutation::Panic), Err(Error::Worker));
    let closed = fixture.finish().unwrap();
    assert!(closed.no_native_connection && closed.host_closed && closed.accounts_closed);
}

#[test]
fn failed_close_retains_account_writer_until_owner_root_is_restored() {
    let mut fixture = Fixture::create(Scenario::Ready).unwrap();
    let id = fixture.send("pending admission").unwrap();
    fixture.mutate(Mutation::SwapProject).unwrap();
    assert_eq!(fixture.close(Close::All, true), Err(Error::Owner));
    assert!(fixture.locks().unwrap().account_busy);
    fixture.mutate(Mutation::RestoreProject).unwrap();
    assert_eq!(fixture.validate(&id), Err(Error::Revoked));
    let closed = fixture.finish().unwrap();
    assert!(closed.accounts_closed && closed.resources_removed);
}

#[test]
fn prompt_bound_is_checked_before_owner_admission_and_refusal_preserves_capture() {
    let mut fixture = Fixture::create(Scenario::Ready).unwrap();
    assert_eq!(fixture.send(&"x".repeat(64 * 1024 + 1)), Err(Error::Bounds));
    let id = fixture.send(&"x".repeat(64 * 1024)).unwrap();
    let admitted = fixture.validate(&id).unwrap();
    assert_eq!(fixture.send(&"x".repeat(64 * 1024 + 1)), Err(Error::Bounds));
    assert_eq!(fixture.validate(&id).unwrap(), admitted);
    assert!(fixture.finish().unwrap().resources_removed);
}

#[test]
fn admission_failure_after_host_send_settles_the_original_pending_start() {
    let mut fixture = Fixture::create(Scenario::Ready).unwrap();
    fixture.mutate(Mutation::RegistryBytes).unwrap();
    assert_eq!(fixture.send("registry will refuse after host capture"), Err(Error::Registry));
    assert!(!fixture.notices().unwrap().iter().any(|n| matches!(n, milagre_owner_store::chat_host::Notice::Started { .. })));
    // No capture was completed, but the actual host turn still had to be settled.
    assert!(fixture.close(Close::All, false).unwrap().accounts_closed);
    assert!(fixture.finish().unwrap().resources_removed);
}

#[test]
fn ready_signed_out_ready_round_trip_never_revives_old_capture() {
    let mut fixture = Fixture::create(Scenario::Ready).unwrap();
    let original = fixture.send("original ready epoch").unwrap();
    fixture.mutate(Mutation::ReobserveSignedOut).unwrap();
    fixture.mutate(Mutation::ReobserveReady).unwrap();
    assert_eq!(fixture.validate(&original), Err(Error::Revoked));
    assert!(fixture.finish().unwrap().resources_removed);
}

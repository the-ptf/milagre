#![cfg(feature = "routine-execution-fixture")]
#[test]
fn actual_actor_timer_claims_native_turn_and_reopens_without_replay() {
    let output = std::process::Command::new("node")
        .arg("tests/routine-actor.cjs")
        .arg(env!("CARGO_BIN_EXE_chat-runtime"))
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("\"actorTimer\":true"));
}

#[test]
fn actual_actor_stop_drains_an_active_native_schedule() {
    let output = std::process::Command::new("node")
        .arg("tests/routine-actor.cjs")
        .arg(env!("CARGO_BIN_EXE_chat-runtime"))
        .arg("--blocked")
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("\"actorStopActive\":true"));
}

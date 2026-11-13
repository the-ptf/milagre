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

#[test]
fn actual_actor_timer_creates_fresh_primary_chat_attaches_and_reopens_without_replay() {
    let output = std::process::Command::new("node")
        .arg("tests/routine-actor.cjs")
        .arg(env!("CARGO_BIN_EXE_chat-runtime"))
        .arg("--new-chat")
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("\"newChat\":true"));
}

#[test]
fn actual_actor_quiet_terminal_carries_annotation_and_saved_completion_survives_restart() {
    let output = std::process::Command::new("node")
        .arg("tests/routine-actor.cjs")
        .arg(env!("CARGO_BIN_EXE_chat-runtime"))
        .arg("--quiet")
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("\"liveQuietTerminal\":true"));
}

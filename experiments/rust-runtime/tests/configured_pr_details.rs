#![cfg(feature = "chat-runtime")]
#[test]
fn actual_private_github_grant_keeps_network_reads_off_actor_and_revokes_before_cleanup() {
    let output = std::process::Command::new("node")
        .arg("tests/configured-pr-details.cjs")
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
    assert!(String::from_utf8_lossy(&output.stdout).contains("\"cleanup\":true"));
}

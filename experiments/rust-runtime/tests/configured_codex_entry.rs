#![cfg(feature = "chat-runtime")]
#[test]
fn actual_dedicated_codex_cli_streams_persists_and_reopens_without_node_daemon() {
    let output = std::process::Command::new("node")
        .arg("tests/configured-codex-entry.cjs")
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

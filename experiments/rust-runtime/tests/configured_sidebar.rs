#![cfg(feature = "chat-runtime-fixture")]
#[test]
fn actual_node_client_validates_sidebar_done_busy_restart_and_node_parity() {
    let output = std::process::Command::new("node")
        .arg("tests/configured-sidebar.cjs")
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

#![cfg(feature = "chat-runtime-fixture")]
#[test]
fn real_node_client_drives_dedicated_terminal_and_reconnect() {
    let output = std::process::Command::new("node")
        .arg("tests/configured-terminals.cjs")
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

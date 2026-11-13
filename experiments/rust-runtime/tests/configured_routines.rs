#![cfg(feature = "chat-runtime-fixture")]
#[test]
fn actual_node_client_validates_paused_routine_crud_bytes_and_restart() {
    let output = std::process::Command::new("node")
        .arg("tests/configured-routines.cjs")
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

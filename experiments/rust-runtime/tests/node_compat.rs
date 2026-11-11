#[test]
fn production_node_client_reads_copied_projects_through_rust() {
    let output = std::process::Command::new("node")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/node-compat.cjs"
        ))
        .arg(env!("CARGO_BIN_EXE_milagre-rust-runtime"))
        .output()
        .expect("Node is required for production client/read conformance");
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("conformance passed"));
}

#[test]
fn production_node_client_reads_actual_isolated_project_states() {
    let output = std::process::Command::new("node")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/owned-compat.cjs"
        ))
        .arg(env!("CARGO_BIN_EXE_owned-runtime"))
        .output()
        .expect("Node is required for actual ProjectStates conformance");
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("conformance passed"));
}

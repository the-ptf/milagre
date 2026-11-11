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

#[test]
fn production_node_client_manages_only_isolated_terminal_ports() {
    let output = std::process::Command::new("node")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/ports-compat.cjs"
        ))
        .arg(env!("CARGO_BIN_EXE_owned-runtime"))
        .arg(env!("CARGO_BIN_EXE_runtime-port-listener"))
        .output()
        .expect("Node is required for real private port conformance");
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("conformance passed"));
}

#[test]
fn production_node_client_reads_only_owned_isolated_artifacts() {
    let output = std::process::Command::new("node")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/artifact-compat.cjs"
        ))
        .arg(env!("CARGO_BIN_EXE_owned-runtime"))
        .output()
        .expect("Node is required for real Artifact read conformance");
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("conformance passed"));
}

#[test]
fn production_node_client_edits_owned_designs_with_native_rendering() {
    let output = std::process::Command::new("node")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/design-compat.cjs"
        ))
        .arg(env!("CARGO_BIN_EXE_owned-runtime"))
        .output()
        .expect("Node is required for saved native Design conformance");
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("conformance passed"));
}

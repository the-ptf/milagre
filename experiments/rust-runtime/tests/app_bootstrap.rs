#![cfg(feature = "app-fixture")]
#[test]
fn node_client_reads_and_edits_app_content_with_scoped_revocation() {
    let output = std::process::Command::new("node")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/app-content-compat.cjs"
        ))
        .arg(env!("CARGO_BIN_EXE_app-fixture"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("app content conformance passed"));
}

#[test]
fn node_runtime_bootstrap_shapes_and_single_owner_readiness() {
    let output = std::process::Command::new("node")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/fixtures/app-bootstrap-node.cjs"
        ))
        .arg("--check")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let output = std::process::Command::new("node")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/app-bootstrap-compat.cjs"
        ))
        .arg(env!("CARGO_BIN_EXE_app-fixture"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("bootstrap conformance passed"));
}

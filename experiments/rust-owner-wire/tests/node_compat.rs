#[test]
fn production_node_clients_use_isolated_rust_wire_server() {
    let output = std::process::Command::new("node")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/node-compat.cjs"
        ))
        .arg(env!("CARGO_BIN_EXE_fixture-server"))
        .output()
        .expect("Node is required to check the real production client contract");
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("conformance passed"));
}

//! CP3 acceptance against the production Node daemon, sequentially on one marked throwaway profile.
//! The JS harness compares every command result/error, settings byte write and relevant event, then reopens
//! Rust's final saves with Node. It never invokes the installed daemon or copies a real profile/credentials.
use milagre_owner_store::Isolation;
use milagre_profile_owner::policy::owner_policy;
use std::process::Command;

#[test]
fn settings_results_bytes_events_and_node_rollback() {
    let base = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(base.path()).unwrap().join("iso");
    Isolation::create(&root, &owner_policy()).expect("marked throwaway profile");
    let output = Command::new("node")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/settings-differential.cjs"
        ))
        .arg(&root)
        .arg(env!("CARGO_BIN_EXE_profile-owner"))
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOME", root.join("home"))
        .output()
        .expect("Node runs");
    println!("{}", String::from_utf8_lossy(&output.stdout));
    assert!(
        output.status.success(),
        "settings differential failed:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

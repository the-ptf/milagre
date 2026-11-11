//! Shared helpers for the tests that run the real Node writers (Node 24, this repository's packages/core).

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

pub fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

pub fn driver() -> PathBuf {
    crate_dir().join("fixtures/writer-node.cjs")
}

/// `node` when it is Node 24 or later; these tests fail without it unless MILAGRE_OWNER_SKIP_NODE=1.
pub fn node() -> Option<PathBuf> {
    let found = Command::new("node")
        .arg("--version")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| {
            let version = String::from_utf8_lossy(&output.stdout)
                .trim()
                .trim_start_matches('v')
                .to_string();
            version
                .split('.')
                .next()?
                .parse::<u32>()
                .ok()
                .filter(|major| *major >= 24)
                .map(|_| PathBuf::from("node"))
        });
    if found.is_none() && std::env::var_os("MILAGRE_OWNER_SKIP_NODE").is_none() {
        panic!("These tests run the real Node writers: install Node 24+, or set MILAGRE_OWNER_SKIP_NODE=1 to skip them.");
    }
    found
}

pub fn run_node(args: &[&str]) -> Output {
    let output = Command::new("node")
        .arg(driver())
        .args(args)
        .output()
        .expect("node runs");
    assert!(
        output.status.success(),
        "node {:?} failed: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
    output
}

pub fn snapshot(dir: &Path) -> String {
    String::from_utf8(run_node(&["snapshot", dir.to_str().unwrap()]).stdout).unwrap()
}

pub fn copy_tree(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap().flatten() {
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), &target).unwrap();
        }
    }
}

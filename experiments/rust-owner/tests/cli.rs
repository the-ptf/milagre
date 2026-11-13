//! The CLI's write commands: only inside an isolated copy, and what they write reads back the same in Node.

mod common;

use std::path::Path;
use std::process::Command;

fn cli(args: &[&str]) -> (bool, String, String) {
    let output = Command::new(env!("CARGO_BIN_EXE_milagre-owner-store"))
        .args(args)
        .output()
        .unwrap();
    (
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

#[test]
fn write_commands_refuse_anything_but_an_isolated_copy() {
    let base = tempfile::tempdir().unwrap();
    let plain = base.path().join("plain");
    std::fs::create_dir_all(plain.join("p/.milagre")).unwrap();
    std::fs::write(
        plain.join("p/.milagre/coordination.json"),
        r#"{"sessions":{},"messages":[]}"#,
    )
    .unwrap();
    std::fs::write(
        base.path().join("state.json"),
        r#"{"next_id":1,"sessions":{},"messages":[]}"#,
    )
    .unwrap();
    let state = base.path().join("state.json");
    let (ok, _, error) = cli(&[
        "save",
        plain.to_str().unwrap(),
        "p",
        state.to_str().unwrap(),
    ]);
    assert!(!ok && error.contains("MILAGRE-ISOLATED-COPY"), "{error}");
    let (ok, _, error) = cli(&["rewrite", plain.to_str().unwrap(), "p"]);
    assert!(!ok && error.contains("MILAGRE-ISOLATED-COPY"), "{error}");
    assert!(
        !plain.join("p/.milagre/runtime.lock").exists()
            && !plain.join("p/.milagre/chats.db").exists()
    );
    if let Some(home) = std::env::var_os("HOME") {
        let inside = Path::new(&home).join(".milagre/owner-store-test-never-created");
        let (ok, _, error) = cli(&[
            "prepare-copy",
            plain.join("p").to_str().unwrap(),
            inside.to_str().unwrap(),
        ]);
        assert!(!ok && error.contains("overlaps"), "{error}");
        assert!(!inside.exists());
    }
    // An isolated copy with a lock in it (a copied live Project, or another owner) isn't written either.
    let copies = base.path().join("copies");
    let (ok, _, error) = cli(&[
        "prepare-copy",
        plain.join("p").to_str().unwrap(),
        copies.to_str().unwrap(),
        "p",
    ]);
    assert!(ok, "{error}");
    std::fs::create_dir(copies.join("p/.milagre/runtime.lock")).unwrap();
    let (ok, _, error) = cli(&[
        "save",
        copies.to_str().unwrap(),
        "p",
        state.to_str().unwrap(),
    ]);
    assert!(!ok && error.contains("owner lock"), "{error}");
}

#[test]
fn rewrite_of_a_copy_matches_node_and_reads_back() {
    if common::node().is_none() {
        return;
    }
    let base = tempfile::tempdir().unwrap();
    let source = common::crate_dir().join("fixtures/.projects/alpha");
    let copies = base.path().join("copies");
    let (ok, out, error) = cli(&[
        "prepare-copy",
        source.to_str().unwrap(),
        copies.to_str().unwrap(),
        "alpha",
    ]);
    assert!(ok, "{error}");
    let project = Path::new(out.trim()).to_path_buf();
    assert!(!project.join(".milagre/runtime.lock").exists());
    let (ok, report, error) = cli(&["rewrite", copies.to_str().unwrap(), "alpha"]);
    assert!(ok, "{error}");
    // Nothing changed since the read: no row is written (Node writes none either); positions are renumbered.
    assert!(report.contains("\"rowsWritten\":0"), "{report}");
    assert!(
        !project.join(".milagre/runtime.lock").exists(),
        "the lock is released"
    );
    // Node, doing the same (read, then save the state it read) on its own copy, leaves the same disk.
    let node = base.path().join("node/alpha");
    common::copy_tree(&source, &node);
    let scenarios = base.path().join("rewrite.json");
    std::fs::write(
        &scenarios,
        r#"[{"name":"rewrite","steps":[{"op":"read"},{"op":"save"}]}]"#,
    )
    .unwrap();
    common::run_node(&[
        "run",
        scenarios.to_str().unwrap(),
        "rewrite",
        node.to_str().unwrap(),
    ]);
    // Node's run saves with sweepMinAgeMs 0, the CLI with Node's default minute: no sidecar is old enough to differ.
    assert_eq!(common::snapshot(&project), common::snapshot(&node));
    // The read-only commands answer from it.
    let (ok, page, error) = cli(&[
        "read",
        project.to_str().unwrap(),
        "chat:messages",
        "10",
        "--turns",
        "1",
    ]);
    assert!(ok && page.contains("\"hasMore\":true"), "{page}{error}");
}

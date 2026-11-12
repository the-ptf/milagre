use milagre_git_read::{GitReader, PR_READ_METHODS};
use serde_json::{json, Value};
use std::{os::unix::fs::PermissionsExt, path::PathBuf, process::Command};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn actual_node_pr_diff_reads_match_without_fetch_or_worktree_writes() {
    let temp = tempfile::Builder::new()
        .prefix("milagre-pr-read-")
        .tempdir()
        .unwrap();
    let generated = Command::new("node")
        .arg(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/pr-fixtures.cjs"))
        .arg(temp.path())
        .output()
        .unwrap();
    assert!(
        generated.status.success(),
        "{}",
        String::from_utf8_lossy(&generated.stderr)
    );
    let data: Value = serde_json::from_slice(&generated.stdout).unwrap();
    assert_eq!(data["deniedFetch"], 2);
    let cwd = PathBuf::from(data["cwd"].as_str().unwrap());
    let before = std::fs::read(cwd.join(".git/index")).unwrap();
    let query = tempfile::tempdir().unwrap();
    std::fs::set_permissions(query.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let reader =
        GitReader::private_read([cwd.clone()], std::fs::canonicalize(query.path()).unwrap())
            .unwrap();
    assert_eq!(PR_READ_METHODS.len(), 2);
    for case in data["cases"].as_array().unwrap() {
        let result = reader
            .call(case["method"].as_str().unwrap(), case["args"].clone())
            .await
            .unwrap();
        assert_eq!(result, case["expected"], "{}", case["name"]);
    }
    assert_eq!(std::fs::read(cwd.join(".git/index")).unwrap(), before);
    assert!(reader.call("git:diff-file",json!({"cwd":cwd,"mode":"pr-range","base":"0".repeat(40),"head":"0".repeat(40),"path":"foreign"})).await.is_err());
    assert!(reader
        .call(
            "pr:diff-files",
            json!({"cwd":temp.path(),"base":"0".repeat(40),"head":"0".repeat(40)})
        )
        .await
        .is_err());
}

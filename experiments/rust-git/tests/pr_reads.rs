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

/// Node's `localCommits` (inside `pr:detail`), run against the same real repository.
fn node_local_commits(cwd: &std::path::Path, head: &str) -> u64 {
    let script = r#"const {createPullRequestReview}=require(process.argv[1]+'/packages/core/src/pull-request-review.cjs');
const [cwd,head]=process.argv.slice(2);
const pr={number:7,state:'OPEN',headRefOid:head,baseRefOid:head,files:{nodes:[],pageInfo:{hasNextPage:false}}};
const review=createPullRequestReview({exec:async()=>({stdout:JSON.stringify({data:{repository:{pullRequest:pr}}})})});
review.detail({cwd,number:7}).then(x=>console.log(Number(x.pr?.localCommits??0))).catch(e=>{console.error(e);process.exitCode=1;});"#;
    let out = Command::new("node")
        .env_remove("ELECTRON_RUN_AS_NODE")
        .arg("-e")
        .arg(script)
        .arg(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .arg(cwd)
        .arg(head)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout)
        .unwrap()
        .trim()
        .parse()
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn local_commits_match_node_rev_list_count_semantics() {
    let temp = tempfile::tempdir().unwrap();
    let cwd = std::fs::canonicalize(temp.path()).unwrap().join("repo");
    std::fs::create_dir(&cwd).unwrap();
    let run = |args: &[&str]| -> String {
        let out = Command::new("/usr/bin/git")
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", &cwd)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_AUTHOR_NAME", "Synthetic")
            .env("GIT_AUTHOR_EMAIL", "synthetic@example.invalid")
            .env("GIT_COMMITTER_NAME", "Synthetic")
            .env("GIT_COMMITTER_EMAIL", "synthetic@example.invalid")
            .current_dir(&cwd)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8(out.stdout).unwrap().trim().to_owned()
    };
    run(&["init", "-b", "main"]);
    let mut shas = Vec::new();
    for n in 0..4 {
        std::fs::write(cwd.join("f.txt"), format!("{n}\n")).unwrap();
        run(&["add", "f.txt"]);
        run(&["commit", "-m", &format!("c{n}")]);
        shas.push(run(&["rev-parse", "HEAD"]));
    }
    let query = tempfile::tempdir().unwrap();
    std::fs::set_permissions(query.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let reader =
        GitReader::private_read([cwd.clone()], std::fs::canonicalize(query.path()).unwrap())
            .unwrap();
    let cases = [
        (shas[1].clone(), 2),
        (shas[0].clone(), 3),
        (shas[3].clone(), 0),
        ("9".repeat(40), 0),
        (shas[1].to_uppercase(), 0),
        ("not-a-sha".to_owned(), 0),
    ];
    for (head, expected) in cases {
        let actual = reader.local_commits(&cwd, &head).await.unwrap();
        assert_eq!(actual, expected, "{head}");
        assert_eq!(
            actual,
            node_local_commits(&cwd, &head),
            "Node differs for {head}"
        );
    }
    assert!(reader.local_commits(temp.path(), &shas[1]).await.is_err());
}

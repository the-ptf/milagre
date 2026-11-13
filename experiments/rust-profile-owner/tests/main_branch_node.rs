//! main-sync branch discovery against Node resolveBase, restricted to throwaway repositories.
use milagre_owner_store::{Isolation, Policy};
use milagre_registry::Registry;
use std::{fs, path::Path, process::Command, sync::Arc};
fn git(root: &Path, args: &[&str]) {
    let result = Command::new("/usr/bin/git")
        .args(args)
        .current_dir(root)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", root)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "Fixture")
        .env("GIT_AUTHOR_EMAIL", "fixture@example.invalid")
        .env("GIT_COMMITTER_NAME", "Fixture")
        .env("GIT_COMMITTER_EMAIL", "fixture@example.invalid")
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}
#[test]
fn main_sync_branch_matches_node_for_plain_unborn_main_master_and_remote_head() {
    let temp = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(temp.path(), &Policy::default()).unwrap();
    let root = isolation.root();
    fs::create_dir(root.join("profile")).unwrap();
    let registry = Registry::open(isolation.clone(), "profile", Arc::new(|| Ok(()))).unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    for kind in ["plain", "unborn", "main", "master", "remote-head"] {
        let project = root.join(kind);
        fs::create_dir(&project).unwrap();
        if kind != "plain" {
            git(
                &project,
                &[
                    "init",
                    "-b",
                    if kind == "master" { "master" } else { "main" },
                ],
            );
            if kind != "unborn" {
                git(
                    &project,
                    &[
                        "-c",
                        "core.hooksPath=/dev/null",
                        "commit",
                        "--allow-empty",
                        "-m",
                        "fixture",
                    ],
                );
            }
            if kind == "remote-head" {
                git(
                    &project,
                    &["update-ref", "refs/remotes/origin/trunk", "HEAD"],
                );
                git(
                    &project,
                    &[
                        "symbolic-ref",
                        "refs/remotes/origin/HEAD",
                        "refs/remotes/origin/trunk",
                    ],
                );
            }
        }
        let module =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/core/src/git/client.cjs");
        let script="require(process.argv[1]).createGit().read.resolveBase(process.argv[2]).then(v=>process.stdout.write(v.name)).catch(e=>{console.error(e);process.exitCode=1})";
        let result = Command::new("node")
            .args(["-e", script])
            .arg(module)
            .arg(&project)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", root)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let expected = String::from_utf8(result.stdout).unwrap();
        assert_eq!(
            runtime.block_on(registry.main_branch(&project)).unwrap(),
            expected,
            "{kind}"
        );
    }
}

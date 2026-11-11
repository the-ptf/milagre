//! Regression for repository-controlled clean filters. Each disposable repository includes a positive control:
//! ordinary Git must execute its harmless marker filter; the owner changed-files path must not.
use milagre_owner_store::changed_files::{changed_files, GitGrants};
use std::{fs, path::Path, process::Command};
fn git(dir: &Path, copy: &Path, args: &[&str]) {
    let out = Command::new("/usr/bin/git")
        .current_dir(dir)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", copy)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .args([
            "-c",
            "user.name=fixture",
            "-c",
            "user.email=fixture@example.invalid",
        ])
        .args(args)
        .output()
        .unwrap();
    assert!(out.status.success(), "git fixture failed");
}
#[test]
fn sanitized_git_never_runs_clean_filters_for_same_size_or_racy_edits() {
    let temp = tempfile::tempdir().unwrap();
    let base = std::fs::canonicalize(temp.path()).unwrap();
    for info in [false, true] {
        for racy in [false, true] {
            let label = format!(
                "sanitized-{}-{}",
                if info { "info" } else { "worktree" },
                if racy { "restored-mtime" } else { "same-size" }
            );
            let copy = base.join(&label);
            let repo = copy.join("repo");
            fs::create_dir_all(&repo).unwrap();
            git(&repo, &copy, &["init", "-q"]);
            let tracked = repo.join("tracked.txt");
            fs::write(&tracked, "before\n").unwrap();
            let original_time = fs::metadata(&tracked).unwrap().modified().unwrap();
            git(&repo, &copy, &["add", "tracked.txt"]);
            git(&repo, &copy, &["commit", "-q", "-m", "fixture"]);
            git(
                &repo,
                &copy,
                &[
                    "config",
                    "filter.marker.clean",
                    "touch FILTER_EXECUTED; cat",
                ],
            );
            git(&repo, &copy, &["config", "core.trustctime", "false"]);
            let attributes = if info {
                repo.join(".git/info/attributes")
            } else {
                repo.join(".gitattributes")
            };
            fs::write(attributes, "tracked.txt filter=marker\n").unwrap();
            fs::write(&tracked, "after!\n").unwrap();
            if racy {
                fs::File::options()
                    .write(true)
                    .open(&tracked)
                    .unwrap()
                    .set_times(fs::FileTimes::new().set_modified(original_time))
                    .unwrap();
            }
            let mut grants = GitGrants::new(&copy);
            grants.admit(&repo).unwrap();
            let plan = grants.plan(repo.to_str(), None);
            let result = changed_files(&copy, &plan).expect("safe status refused fixture");
            assert!(
                result.iter().any(|x| x == "tracked.txt"),
                "safe status missed edited file"
            );
            let marker = repo.join("FILTER_EXECUTED");
            assert!(!marker.exists(), "safe status ran clean filter");
            git(&repo, &copy, &["status", "--porcelain"]);
            assert!(
                marker.exists(),
                "positive control failed to exercise configured filter"
            );
            println!("{label}: rust_marker=false changed_file=true original_git_marker=true");
        }
    }
}

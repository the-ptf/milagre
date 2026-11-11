#![cfg(unix)]
use milagre_git_read::isolated::{CreateWorktree, IsolatedGit, OwnedWorktree, RemoveOptions};
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    os::unix::fs::{symlink, PermissionsExt},
    path::Path,
    process::{Command, Stdio},
};

fn git(cwd: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args([
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "commit.gpgSign=false",
        ])
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}
fn write(cwd: &Path, file: &str, bytes: impl AsRef<[u8]>) {
    let file = cwd.join(file);
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(file, bytes).unwrap();
}
fn executable(path: &Path, body: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}
async fn repository() -> IsolatedGit {
    let owner = IsolatedGit::create().await.unwrap();
    for (file, content) in [
        ("README.md", "one\ntwo\nthree\n"),
        ("old.txt", "keep\nme\nplease\n"),
        ("gone.txt", "gone\n"),
        (".gitignore", "ignored.txt\n"),
    ] {
        write(owner.project_path(), file, content);
    }
    assert_eq!(
        owner.commit(owner.project_path(), "Initial").await.unwrap()["ok"],
        true
    );
    owner
}
fn oracle(owner: &IsolatedGit, method: &str, args: Value) -> Value {
    let mut child = Command::new("node")
        .arg(format!(
            "{}/tests/mutation-oracle.cjs",
            env!("CARGO_MANIFEST_DIR")
        ))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(
            serde_json::to_string(&json!({"root":owner.root_path(),"method":method,"args":args}))
                .unwrap()
                .as_bytes(),
        )
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
fn normalized(value: Value, owner: &IsolatedGit) -> Value {
    fn walk(value: &mut Value, root: &str) {
        match value {
            Value::String(text) => *text = text.replace(root, "$ROOT"),
            Value::Array(values) => {
                for value in values {
                    walk(value, root);
                }
            }
            Value::Object(values) => {
                for (key, value) in values {
                    if ["sha", "shortSha", "head"].contains(&key.as_str()) && value.is_string() {
                        *value = json!(format!("${key}"));
                    } else {
                        walk(value, root);
                    }
                }
            }
            _ => {}
        }
    }
    let mut value = value;
    walk(&mut value, owner.root_path().to_str().unwrap());
    value
}
fn snapshot(cwd: &Path) -> Value {
    json!({"status":git(cwd,&["status","--porcelain=v1","-z","--untracked-files=all"]),"cached":git(cwd,&["diff","--cached","--name-status","-z"]),"tree":git(cwd,&["ls-tree","-r","--name-only","-z","HEAD"]),"message":git(cwd,&["log","-1","--format=%B"])})
}
async fn compare_commit(rust: &IsolatedGit, node: &IsolatedGit, message: &str) -> Value {
    let expected = oracle(
        node,
        "commit",
        json!({"cwd":node.project_path(),"message":message}),
    )["value"]
        .clone();
    let actual = rust.commit(rust.project_path(), message).await.unwrap();
    assert_eq!(normalized(actual.clone(), rust), normalized(expected, node));
    if actual["ok"] == true {
        assert_eq!(
            actual["sha"],
            git(rust.project_path(), &["rev-parse", "HEAD"]).trim()
        );
        assert_eq!(
            actual["shortSha"],
            git(rust.project_path(), &["rev-parse", "--short", "HEAD"]).trim()
        );
    }
    actual
}
fn request(owner: &IsolatedGit, prompt: &str, suffix: &str) -> CreateWorktree {
    CreateWorktree {
        project_path: owner.project_path().into(),
        base_branch: "main".into(),
        prompt: prompt.into(),
        branch: None,
        suffix: Some(suffix.into()),
        folder_slug: None,
        track_base: false,
    }
}
async fn make(owner: &IsolatedGit, suffix: &str) -> OwnedWorktree {
    owner
        .create_worktree(request(owner, "Task", suffix))
        .await
        .unwrap()
}

#[tokio::test]
async fn commit_matches_node_and_preserves_literal_message_and_paths() {
    let rust = repository().await;
    let node = repository().await;
    for owner in [&rust, &node] {
        write(owner.project_path(), "README.md", "one\nTWO\nthree\n");
        fs::remove_file(owner.project_path().join("gone.txt")).unwrap();
        git(
            owner.project_path(),
            &["mv", "old.txt", "renamed é\nfile.txt"],
        );
        write(owner.project_path(), "-n*.txt", "literal\n");
        write(owner.project_path(), "new µ file.txt", "new\n");
        write(owner.project_path(), "binary.bin", [0, 1, 2]);
        write(owner.project_path(), ".milagre/state.json", "{}\n");
        git(owner.project_path(), &["add", ".milagre"]);
    }
    let result = compare_commit(
        &rust,
        &node,
        "  feat: saved\n\nQuotes ' and \" and $HOME and `commands` stay literal.  ",
    )
    .await;
    assert_eq!(result["ok"], true);
    assert_eq!(snapshot(rust.project_path()), snapshot(node.project_path()));
    assert_eq!(
        git(rust.project_path(), &["status", "--porcelain"]).trim(),
        "?? .milagre/"
    );
}
#[tokio::test]
async fn secret_refusal_restores_index_like_node() {
    let rust = repository().await;
    let node = repository().await;
    for owner in [&rust, &node] {
        write(owner.project_path(), "README.md", "staged\n");
        git(owner.project_path(), &["add", "README.md"]);
        write(owner.project_path(), ".env.local", "dummy fixture value\n");
        write(owner.project_path(), "untracked.txt", "new\n");
    }
    assert_eq!(
        compare_commit(&rust, &node, "No secrets").await["kind"],
        "secrets"
    );
    assert_eq!(snapshot(rust.project_path()), snapshot(node.project_path()));
    assert_eq!(
        git(rust.project_path(), &["diff", "--cached", "--name-only"]).trim(),
        "README.md"
    );
}
#[tokio::test]
async fn empty_unborn_detached_and_operation_results_match_node() {
    let rust = IsolatedGit::create().await.unwrap();
    let node = IsolatedGit::create().await.unwrap();
    for owner in [&rust, &node] {
        write(owner.project_path(), "first.txt", "first\n");
        write(owner.project_path(), ".milagre/state.json", "{}\n");
        git(owner.project_path(), &["add", ".milagre"]);
    }
    assert_eq!(
        compare_commit(&rust, &node, "First commit").await["ok"],
        true
    );
    assert_eq!(snapshot(rust.project_path()), snapshot(node.project_path()));
    assert_eq!(compare_commit(&rust, &node, " \n").await["kind"], "error");
    assert_eq!(
        compare_commit(&rust, &node, "Nothing").await["kind"],
        "nothing"
    );
    for owner in [&rust, &node] {
        git(owner.project_path(), &["checkout", "--detach"]);
        write(owner.project_path(), "new.txt", "new\n");
    }
    assert_eq!(
        compare_commit(&rust, &node, "Detached").await["code"],
        "DETACHED_COMMIT"
    );
    for owner in [&rust, &node] {
        git(owner.project_path(), &["checkout", "main"]);
    }
    for operation in [
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "rebase-merge",
        "rebase-apply",
    ] {
        for owner in [&rust, &node] {
            if operation.starts_with("rebase") {
                fs::create_dir(owner.project_path().join(".git").join(operation)).unwrap();
            } else {
                write(
                    owner.project_path(),
                    &format!(".git/{operation}"),
                    git(owner.project_path(), &["rev-parse", "HEAD"]),
                );
            }
        }
        assert_eq!(
            compare_commit(&rust, &node, "Blocked").await["kind"],
            "blocked"
        );
        for owner in [&rust, &node] {
            let path = owner.project_path().join(".git").join(operation);
            if path.is_dir() {
                fs::remove_dir(path).unwrap();
            } else {
                fs::remove_file(path).unwrap();
            }
        }
    }
}
#[tokio::test]
async fn hook_and_private_signer_failures_match_node() {
    for signing in [false, true] {
        let rust = repository().await;
        let node = repository().await;
        for owner in [&rust, &node] {
            write(owner.project_path(), "change.txt", "change\n");
            if signing {
                let program = owner.root_path().join("fixture-sign");
                executable(
                    &program,
                    "echo 'gpg: signing failed: No secret key' >&2\nexit 1",
                );
                git(
                    owner.project_path(),
                    &["config", "gpg.program", program.to_str().unwrap()],
                );
                git(owner.project_path(), &["config", "commit.gpgSign", "true"]);
            } else {
                executable(
                    &owner.project_path().join(".git/hooks/pre-commit"),
                    "echo 'error: assigning to a constant' >&2\nexit 1",
                );
            }
        }
        assert_eq!(
            compare_commit(&rust, &node, "Refused").await["kind"],
            if signing { "signing" } else { "hook" }
        );
        assert_eq!(snapshot(rust.project_path()), snapshot(node.project_path()));
    }
}

#[tokio::test]
async fn effective_signer_and_linked_metadata_cannot_escape_the_owner() {
    let owner = repository().await;
    let outside = tempfile::tempdir().unwrap();
    let marker = outside.path().join("executed");
    let external = outside.path().join("external-sign");
    executable(&external, &format!("touch '{}'\nexit 1", marker.display()));
    let internal = owner.root_path().join("fixture-sign");
    executable(&internal, "exit 1");
    git(
        owner.project_path(),
        &["config", "gpg.program", internal.to_str().unwrap()],
    );
    git(
        owner.project_path(),
        &["config", "gpg.openpgp.program", external.to_str().unwrap()],
    );
    git(owner.project_path(), &["config", "commit.gpgSign", "true"]);
    write(owner.project_path(), "change.txt", "change\n");
    assert_eq!(
        owner
            .commit(owner.project_path(), "No outside signing")
            .await
            .unwrap()["kind"],
        "signing"
    );
    assert!(!marker.exists());
    git(owner.project_path(), &["config", "commit.gpgSign", "false"]);

    let foreign_file = outside.path().join("sentinel");
    fs::write(&foreign_file, "unchanged").unwrap();
    fs::hard_link(&foreign_file, owner.project_path().join(".git/linked-file")).unwrap();
    assert_eq!(
        owner
            .commit(owner.project_path(), "No linked metadata")
            .await
            .unwrap_err()
            .kind,
        "ISOLATED_GIT_SCOPE"
    );
    assert_eq!(fs::read_to_string(foreign_file).unwrap(), "unchanged");
}

#[tokio::test]
async fn isolated_hooks_receive_only_private_process_environment() {
    let owner = repository().await;
    let output = owner.root_path().join("hook-environment");
    executable(
        &owner.project_path().join(".git/hooks/pre-commit"),
        &format!("env > '{}'", output.display()),
    );
    write(owner.project_path(), "change.txt", "change\n");
    assert_eq!(
        owner
            .commit(owner.project_path(), "Private hook environment")
            .await
            .unwrap()["ok"],
        true
    );
    let values = fs::read_to_string(output).unwrap();
    for line in values.lines() {
        let (name, value) = line.split_once('=').unwrap();
        assert!(
            name.starts_with("GIT_")
                || [
                    "PATH",
                    "LC_ALL",
                    "HOME",
                    "TMPDIR",
                    "XDG_CONFIG_HOME",
                    "XDG_CACHE_HOME",
                    "GNUPGHOME",
                    // Apple's /usr/bin/git shim adds these after env_clear.
                    "MANPATH",
                    "LIBRARY_PATH",
                    "CPATH",
                    "__CF_USER_TEXT_ENCODING",
                    "SDKROOT",
                    "DEVELOPER_DIR",
                    "PWD",
                    "SHLVL",
                    "_"
                ]
                .contains(&name),
            "unexpected hook variable {name}"
        );
        if name == "HOME" {
            assert_eq!(value, owner.root_path().join("home").to_str().unwrap());
        }
    }
}
#[tokio::test]
async fn create_list_status_and_remove_match_node_domain_contracts() {
    let rust = repository().await;
    let node = repository().await;
    let made = rust
        .create_worktree(request(
            &rust,
            "Corrija a navegação do menu lateral agora",
            "ab12",
        ))
        .await
        .unwrap();
    let expected = oracle(&node,"create",json!({"projectPath":node.project_path(),"baseBranch":"main","prompt":"Corrija a navegação do menu lateral agora","suffix":"ab12"}))["value"].clone();
    assert_eq!(
        normalized(made.info(), &rust),
        normalized(expected.clone(), &node)
    );
    assert_eq!(
        normalized(rust.list_worktrees().await.unwrap(), &rust),
        normalized(
            oracle(&node, "list", json!({"cwd":node.project_path()}))["value"].clone(),
            &node
        )
    );
    let node_path = Path::new(expected["path"].as_str().unwrap());
    for (path, owner) in [(made.path(), &rust), (node_path, &node)] {
        write(path, "ignored.txt", "ignored\n");
        assert!(owner.root_path().is_dir());
    }
    let actual = rust.worktree_status(&made).await.unwrap();
    assert_eq!(
        normalized(json!(actual), &rust),
        normalized(
            oracle(&node, "status", json!({"path":node_path,"base":"main"}))["value"].clone(),
            &node
        )
    );
    let removed = rust
        .remove_worktree(&made, RemoveOptions::default())
        .await
        .unwrap();
    assert_eq!(
        removed,
        oracle(
            &node,
            "remove",
            json!({"path":node_path,"projectPath":node.project_path(),"base":"main"})
        )["value"]
    );
    assert!(!made.path().exists());
    assert!(rust.project_path().exists());
    assert_eq!(
        rust.remove_worktree(&made, RemoveOptions::default())
            .await
            .unwrap()["alreadyRemoved"],
        true
    );
}
#[tokio::test]
async fn force_checks_and_leases_protect_owned_worktrees() {
    let owner = repository().await;
    let worktree = make(&owner, "force").await;
    let lease = owner.lease(&worktree).await.unwrap();
    assert_eq!(
        owner
            .remove_worktree(&worktree, RemoveOptions::default())
            .await
            .unwrap_err()
            .kind,
        "ISOLATED_GIT_SCOPE"
    );
    drop(lease);
    write(worktree.path(), "one.txt", "one\n");
    let seen = owner.worktree_status(&worktree).await.unwrap();
    assert_eq!(
        owner
            .remove_worktree(&worktree, RemoveOptions::default())
            .await
            .unwrap_err()
            .kind,
        "WORKTREE_CHANGED"
    );
    assert_eq!(
        owner
            .remove_worktree(
                &worktree,
                RemoveOptions {
                    force: true,
                    seen: None
                }
            )
            .await
            .unwrap_err()
            .kind,
        "WORKTREE_CHANGED"
    );
    write(worktree.path(), "two.txt", "two\n");
    assert_eq!(
        owner
            .remove_worktree(
                &worktree,
                RemoveOptions {
                    force: true,
                    seen: Some(seen.clone())
                }
            )
            .await
            .unwrap_err()
            .kind,
        "WORKTREE_CHANGED"
    );
    fs::remove_file(worktree.path().join("two.txt")).unwrap();
    assert_eq!(
        owner.commit(worktree.path(), "Work").await.unwrap()["ok"],
        true
    );
    assert_eq!(
        owner
            .remove_worktree(
                &worktree,
                RemoveOptions {
                    force: true,
                    seen: Some(seen)
                }
            )
            .await
            .unwrap_err()
            .kind,
        "WORKTREE_CHANGED"
    );
    let seen = owner.worktree_status(&worktree).await.unwrap();
    assert_eq!(seen.unpushed, 1);
    assert_eq!(
        owner
            .remove_worktree(
                &worktree,
                RemoveOptions {
                    force: true,
                    seen: Some(seen)
                }
            )
            .await
            .unwrap()["removed"],
        true
    );
}
#[tokio::test]
async fn identity_marker_foreign_handles_and_metadata_symlinks_fail_closed() {
    let owner = repository().await;
    let foreign = repository().await;
    let worktree = make(&foreign, "foreign").await;
    assert_eq!(
        owner
            .commit(foreign.project_path(), "Not owned")
            .await
            .unwrap_err()
            .kind,
        "ISOLATED_GIT_SCOPE"
    );
    assert_eq!(
        owner
            .remove_worktree(&worktree, RemoveOptions::default())
            .await
            .unwrap_err()
            .kind,
        "ISOLATED_GIT_SCOPE"
    );
    let marker = owner.root_path().join(".milagre-isolated-git");
    let before = fs::read(&marker).unwrap();
    fs::write(&marker, "changed").unwrap();
    assert_eq!(
        owner
            .commit(owner.project_path(), "No marker")
            .await
            .unwrap_err()
            .kind,
        "ISOLATED_GIT_SCOPE"
    );
    fs::write(&marker, before).unwrap();
    let link = owner.project_path().join(".git/foreign-link");
    symlink(foreign.project_path().join(".git"), &link).unwrap();
    assert_eq!(
        owner
            .commit(owner.project_path(), "No symlinks")
            .await
            .unwrap_err()
            .kind,
        "ISOLATED_GIT_SCOPE"
    );
    fs::remove_file(link).unwrap();
    assert!(foreign.project_path().exists());
    let mut invalid = request(&owner, "Bad", "bad");
    invalid.base_branch = "--detach".into();
    assert_eq!(
        owner.create_worktree(invalid).await.unwrap_err().kind,
        "INVALID_ARGUMENT"
    );
    let mut invalid = request(&owner, "Bad", "bad");
    invalid.branch = Some("refs/heads/no".into());
    assert_eq!(
        owner.create_worktree(invalid).await.unwrap_err().kind,
        "INVALID_ARGUMENT"
    );
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn repository_lane_serializes_commits_across_worktrees() {
    let owner = repository().await;
    let first = make(&owner, "one").await;
    let second = make(&owner, "two").await;
    write(first.path(), "one.txt", "one\n");
    write(second.path(), "two.txt", "two\n");
    let marker = owner.root_path().join("hook-active");
    executable(
        &owner.project_path().join(".git/hooks/pre-commit"),
        &format!(
            "mkdir '{}' || exit 1\nsleep 0.1\nrmdir '{}'",
            marker.display(),
            marker.display()
        ),
    );
    let clone = owner.clone();
    let (a, b) = tokio::join!(
        owner.commit(first.path(), "First"),
        clone.commit(second.path(), "Second")
    );
    assert_eq!(a.unwrap()["ok"], true);
    assert_eq!(b.unwrap()["ok"], true);
    assert!(!marker.exists());
}

#[tokio::test]
async fn redirected_destination_is_rejected_before_creating_any_directory() {
    let owner = repository().await;
    let foreign = repository().await;
    let destination = owner.worktree_root();
    let saved = owner.root_path().join("original-worktrees");
    fs::rename(&destination, &saved).unwrap();
    let outside = foreign.root_path().join("home");
    assert!(!outside.join("project").exists());
    symlink(&outside, &destination).unwrap();
    assert_eq!(
        owner
            .create_worktree(request(&owner, "Never outside", "safe"))
            .await
            .unwrap_err()
            .kind,
        "ISOLATED_GIT_SCOPE"
    );
    assert!(!outside.join("project").exists());
    fs::remove_file(&destination).unwrap();
    fs::rename(saved, destination).unwrap();
    let hooks = owner.project_path().join(".git/hooks");
    git(
        owner.project_path(),
        &["config", "core.hooksPath", hooks.to_str().unwrap()],
    );
    assert_eq!(
        owner
            .commit(owner.project_path(), "Custom config")
            .await
            .unwrap_err()
            .kind,
        "ISOLATED_GIT_SCOPE"
    );
}

#[tokio::test]
async fn forced_removal_matches_node_and_rejects_stale_observations() {
    let rust = repository().await;
    let node = repository().await;
    let made = make(&rust, "forced").await;
    let created=oracle(&node,"create",json!({"projectPath":node.project_path(),"baseBranch":"main","prompt":"Task","suffix":"forced"}))["value"].clone();
    let node_path = Path::new(created["path"].as_str().unwrap());
    for path in [made.path(), node_path] {
        write(path, "one.txt", "one\n");
    }
    let rust_seen = rust.worktree_status(&made).await.unwrap();
    let node_seen =
        oracle(&node, "status", json!({"path":node_path,"base":"main"}))["value"].clone();
    assert_eq!(
        normalized(json!(rust_seen), &rust),
        normalized(node_seen.clone(), &node)
    );
    for force in [false, true] {
        let expected = oracle(
            &node,
            "remove",
            json!({"path":node_path,"projectPath":node.project_path(),"base":"main","force":force}),
        );
        let actual = rust
            .remove_worktree(&made, RemoveOptions { force, seen: None })
            .await
            .unwrap_err();
        assert_eq!(
            normalized(json!(actual.message), &rust),
            normalized(expected["error"].clone(), &node)
        );
    }
    for path in [made.path(), node_path] {
        write(path, "two.txt", "two\n");
    }
    let expected = oracle(
        &node,
        "remove",
        json!({"path":node_path,"projectPath":node.project_path(),"base":"main","force":true,"seen":node_seen}),
    );
    let actual = rust
        .remove_worktree(
            &made,
            RemoveOptions {
                force: true,
                seen: Some(rust_seen.clone()),
            },
        )
        .await
        .unwrap_err();
    assert_eq!(
        normalized(json!(actual.message), &rust),
        normalized(expected["error"].clone(), &node)
    );
    for path in [made.path(), node_path] {
        fs::remove_file(path.join("two.txt")).unwrap();
    }
    let expected = oracle(
        &node,
        "remove",
        json!({"path":node_path,"projectPath":node.project_path(),"base":"main","force":true,"seen":node_seen}),
    );
    assert_eq!(
        rust.remove_worktree(
            &made,
            RemoveOptions {
                force: true,
                seen: Some(rust_seen)
            }
        )
        .await
        .unwrap(),
        expected["value"]
    );
}

#[tokio::test]
async fn detached_and_renamed_worktree_behavior_matches_node() {
    for detached in [false, true] {
        let rust = repository().await;
        let node = repository().await;
        let made = make(&rust, "branches").await;
        let created=oracle(&node,"create",json!({"projectPath":node.project_path(),"baseBranch":"main","prompt":"Task","suffix":"branches"}))["value"].clone();
        let node_path = Path::new(created["path"].as_str().unwrap());
        for path in [made.path(), node_path] {
            if detached {
                git(path, &["checkout", "--detach"]);
            } else {
                git(path, &["checkout", "-b", "feature/keep"]);
            }
            write(path, "committed.txt", "committed\n");
            git(path, &["add", "committed.txt"]);
            git(path, &["commit", "-m", "Fixture commit"]);
        }
        let rust_seen = rust.worktree_status(&made).await.unwrap();
        let node_seen =
            oracle(&node, "status", json!({"path":node_path,"base":"main"}))["value"].clone();
        assert_eq!(
            normalized(json!(rust_seen), &rust),
            normalized(node_seen.clone(), &node)
        );
        let expected = oracle(
            &node,
            "remove",
            json!({"path":node_path,"projectPath":node.project_path(),"base":"main","force":true,"seen":node_seen}),
        );
        assert_eq!(
            rust.remove_worktree(
                &made,
                RemoveOptions {
                    force: true,
                    seen: Some(rust_seen)
                }
            )
            .await
            .unwrap(),
            expected["value"]
        );
        if !detached {
            assert!(!git(
                rust.project_path(),
                &["rev-parse", "--verify", "refs/heads/feature/keep"]
            )
            .is_empty());
        }
    }
}

#[tokio::test]
async fn existing_tracking_refs_and_explicit_tracking_match_without_fetch() {
    let rust = repository().await;
    let node = repository().await;
    for owner in [&rust, &node] {
        let cwd = owner.project_path();
        let head = git(cwd, &["rev-parse", "HEAD"]);
        let tree = git(cwd, &["rev-parse", "HEAD^{tree}"]);
        let tip = git(
            cwd,
            &[
                "commit-tree",
                tree.trim(),
                "-p",
                head.trim(),
                "-m",
                "Existing remote commit",
            ],
        );
        git(
            cwd,
            &["remote", "add", "origin", "/nonexistent/no-network-fixture"],
        );
        git(cwd, &["update-ref", "refs/remotes/origin/main", tip.trim()]);
        git(cwd, &["config", "branch.main.remote", "origin"]);
        git(cwd, &["config", "branch.main.merge", "refs/heads/main"]);
    }
    let mut req = request(&rust, "Tracked", "track");
    req.track_base = true;
    let made = rust.create_worktree(req).await.unwrap();
    let expected=oracle(&node,"create",json!({"projectPath":node.project_path(),"baseBranch":"main","prompt":"Tracked","suffix":"track","trackBase":true}))["value"].clone();
    assert_eq!(normalized(made.info(), &rust), normalized(expected, &node));
    assert_eq!(made.base(), "origin/main");
    assert_eq!(
        git(made.path(), &["rev-parse", "--abbrev-ref", "@{upstream}"]).trim(),
        "origin/main"
    );
}

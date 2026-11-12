#![cfg(unix)]

use milagre_git_read::GitReader;
use serde_json::json;
use std::{
    fs,
    os::unix::fs::{DirBuilderExt, PermissionsExt},
    path::Path,
    process::Command,
};

fn directory(path: &Path) {
    fs::DirBuilder::new().mode(0o700).create(path).unwrap();
}

#[test]
fn private_reader_uses_fixed_git_and_ignores_parent_configuration() {
    let temporary = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(temporary.path()).unwrap();
    for name in ["repo", "query", "parent-home", "bin"] {
        directory(&root.join(name));
    }
    let setup = Command::new("/usr/bin/git")
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", root.join("query"))
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .current_dir(root.join("repo"))
        .args(["init", "-b", "main"])
        .output()
        .unwrap();
    assert!(setup.status.success());
    fs::write(root.join("repo/actual.txt"), "actual checkout\n").unwrap();
    // These make an accidentally inherited Git environment or executable fail.
    fs::write(
        root.join("parent-home/.gitconfig"),
        "[core]\n bare = true\n",
    )
    .unwrap();
    fs::write(root.join("bin/git"), "#!/bin/sh\nexit 79\n").unwrap();
    fs::set_permissions(root.join("bin/git"), fs::Permissions::from_mode(0o700)).unwrap();
    let output = Command::new(std::env::current_exe().unwrap())
        .env_clear()
        .env("MILAGRE_PRIVATE_GIT_CHILD", &root)
        .env("PATH", root.join("bin"))
        .env("HOME", root.join("parent-home"))
        .env("GIT_CONFIG_GLOBAL", root.join("parent-home/.gitconfig"))
        .env("GIT_DIR", root.join("does-not-exist"))
        .args([
            "--exact",
            "private_environment_child",
            "--ignored",
            "--nocapture",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
#[ignore = "subprocess helper, invoked with a synthetic poisoned parent environment"]
fn private_environment_child() {
    let root = std::path::PathBuf::from(std::env::var_os("MILAGRE_PRIVATE_GIT_CHILD").unwrap());
    let reader = GitReader::private_read([root.join("repo")], root.join("query")).unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let result = runtime
        .block_on(reader.call("git:changes", json!({"cwd":root.join("repo")})))
        .unwrap();
    assert_eq!(result["isRepo"], true);
    assert!(result["files"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["path"] == "actual.txt"));
}

#[test]
fn private_reader_refuses_public_or_substituted_query_directories() {
    let temporary = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(temporary.path()).unwrap();
    directory(&root.join("repo"));
    directory(&root.join("query"));
    fs::set_permissions(root.join("query"), fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(
        GitReader::private_read([root.join("repo")], root.join("query"))
            .err()
            .unwrap()
            .kind,
        "GIT_PRIVATE_CONTEXT"
    );
    fs::set_permissions(root.join("query"), fs::Permissions::from_mode(0o700)).unwrap();
    directory(&root.join("elsewhere"));
    std::os::unix::fs::symlink(root.join("elsewhere"), root.join("query/home")).unwrap();
    assert_eq!(
        GitReader::private_read([root.join("repo")], root.join("query"))
            .err()
            .unwrap()
            .kind,
        "GIT_PRIVATE_CONTEXT"
    );
}

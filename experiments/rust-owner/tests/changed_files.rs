//! The minimal brief's changed files: hardened `git status --porcelain` in admitted worktrees only, read as Node's
//! runtime.cjs `changedFiles` reads it (checked against Node over the same repository), and nothing run anywhere else.

mod common;

use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::process::Command;

use milagre_owner_store::changed_files::{changed_files, GitGrants};
use milagre_owner_store::isolation::{Isolation, Policy};
use serde_json::json;

const GIT: &str = "/usr/bin/git";

fn git(dir: &Path, args: &[&str]) {
    let status = Command::new(GIT)
        .current_dir(dir)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .args(["-c", "user.name=t", "-c", "user.email=t@example.com"])
        .args(args)
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?}");
}

/// A repository inside `copy` with a committed file changed, one deleted, one renamed, untracked files with a space
/// and non-ASCII letters, and a quote.
fn repository(copy: &Path, name: &str) -> PathBuf {
    let dir = copy.join(name);
    std::fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q"]);
    for file in ["kept.txt", "gone.txt", "moved.txt", "edited.txt"] {
        std::fs::write(dir.join(file), file).unwrap();
    }
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-q", "-m", "first"]);
    std::fs::write(dir.join("edited.txt"), "changed").unwrap();
    std::fs::remove_file(dir.join("gone.txt")).unwrap();
    git(&dir, &["mv", "moved.txt", "renamed.txt"]);
    std::fs::write(dir.join("with space.txt"), "x").unwrap();
    std::fs::write(dir.join("caf\u{e9} \u{1F600}.md"), "x").unwrap();
    std::fs::write(dir.join("quote\"d.txt"), "x").unwrap();
    std::fs::canonicalize(dir).unwrap()
}

/// What runtime.cjs makes of the same status: `git status --porcelain` (here with the same cleared environment),
/// `split("\n").filter(Boolean).map((line) => line.slice(3))`, alias in front for a Link member.
fn node_changed(copy: &Path, members: &[(Option<&str>, &Path)]) -> Vec<String> {
    let script = r#"
const { execFileSync } = require("node:child_process");
const [copy, members] = [process.argv[1], JSON.parse(process.argv[2])];
const env = { PATH: "/usr/bin:/bin", HOME: copy, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0" };
const out = members.flatMap(([alias, cwd]) =>
  execFileSync("/usr/bin/git", ["status", "--porcelain"], { cwd, env, encoding: "utf8" })
    .split("\n").filter(Boolean).map((line) => (alias == null ? line.slice(3) : `${alias}/${line.slice(3)}`)));
process.stdout.write(JSON.stringify(out));
"#;
    let members: Vec<(Option<&str>, String)> = members
        .iter()
        .map(|(alias, path)| (*alias, path.display().to_string()))
        .collect();
    let output = Command::new("node")
        .args([
            "-e",
            script,
            &copy.display().to_string(),
            &serde_json::to_string(&members).unwrap(),
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

fn setup() -> Option<(tempfile::TempDir, PathBuf)> {
    if !Path::new(GIT).exists() || common::node().is_none() {
        return None;
    }
    let base = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(&base.path().join("copies"), &Policy::default()).unwrap();
    let copy = isolation.root().to_path_buf();
    Some((base, copy))
}

#[test]
fn changed_files_match_node_for_a_chat_and_a_link_chat() {
    let Some((_base, copy)) = setup() else { return };
    let one = repository(&copy, "one");
    let two = repository(&copy, "two");
    let mut grants = GitGrants::new(&copy);
    grants.admit(&one).unwrap();
    grants.admit(&two).unwrap();
    let plan = grants.plan(Some(&one.display().to_string()), None);
    let rust = changed_files(&copy, &plan).unwrap();
    assert_eq!(rust, node_changed(&copy, &[(None, &one)]));
    assert!(rust.iter().any(|file| file == "edited.txt"), "{rust:?}");
    assert!(
        rust.iter().any(|file| file.contains("renamed.txt")),
        "{rust:?}"
    );
    let members = json!([{ "alias": "api", "worktreePath": one.display().to_string() }, { "alias": "web", "worktreePath": two.display().to_string() }]);
    let plan = grants.plan(None, Some(&members));
    let rust = changed_files(&copy, &plan).unwrap();
    assert_eq!(
        rust,
        node_changed(&copy, &[(Some("api"), &one), (Some("web"), &two)])
    );
    assert!(rust
        .iter()
        .all(|file| file.starts_with("api/") || file.starts_with("web/")));
}

#[test]
fn only_admitted_worktrees_inside_the_copy_are_run_in() {
    let Some((base, copy)) = setup() else { return };
    let mut grants = GitGrants::new(&copy);
    // Outside the copy, a link, the copy itself.
    let outside = repository(base.path(), "outside");
    assert!(grants.admit(&outside).is_err());
    let inside = repository(&copy, "inside");
    symlink(&inside, copy.join("link")).unwrap();
    assert!(grants.admit(&copy.join("link")).is_err());
    assert!(grants.admit(&copy).is_err());
    // A .git that is a file (a gitdir pointer), a shared Git folder, config that includes or redirects.
    let pointer = copy.join("pointer");
    std::fs::create_dir(&pointer).unwrap();
    std::fs::write(
        pointer.join(".git"),
        format!("gitdir: {}/.git\n", outside.display()),
    )
    .unwrap();
    assert!(grants
        .admit(&std::fs::canonicalize(&pointer).unwrap())
        .is_err());
    for (name, line) in [
        ("included", "[include]\n\tpath = /tmp/elsewhere\n"),
        ("conditional", "[includeIf \"gitdir:/\"]\n\tpath = /tmp/x\n"),
        ("redirected", "[core]\n\tworktree = /tmp\n"),
        ("monitored", "[core]\n\tfsmonitor = true\n"),
    ] {
        let repo = repository(&copy, name);
        let config = repo.join(".git/config");
        let mut text = std::fs::read_to_string(&config).unwrap();
        text.push_str(line);
        std::fs::write(&config, text).unwrap();
        assert!(grants.admit(&repo).is_err(), "{name}");
    }
    let shared = repository(&copy, "shared");
    std::fs::write(shared.join(".git/commondir"), "../inside/.git\n").unwrap();
    assert!(grants.admit(&shared).is_err());
    // A path the Chat's state names that isn't admitted gives no list; nothing runs.
    assert!(grants
        .plan(Some(&inside.display().to_string()), None)
        .is_none());
    assert!(grants
        .plan(Some(&outside.display().to_string()), None)
        .is_none());
    // Admitted, then its config changed to include another file: checked again at the run, no list.
    grants.admit(&inside).unwrap();
    let plan = grants.plan(Some(&inside.display().to_string()), None);
    assert!(changed_files(&copy, &plan).is_some());
    let config = inside.join(".git/config");
    let mut text = std::fs::read_to_string(&config).unwrap();
    text.push_str("[include]\n\tpath = /tmp/elsewhere\n");
    std::fs::write(&config, text).unwrap();
    assert!(changed_files(&copy, &plan).is_none());
    // A Link member not admitted fails the whole list, as one failing Node member does.
    let members = json!([{ "alias": "a", "worktreePath": outside.display().to_string() }]);
    assert!(grants.plan(None, Some(&members)).is_none());
}

/// A restore whose model can't answer lists the admitted worktree's changed files in its minimal brief.
#[test]
fn the_minimal_brief_lists_the_admitted_worktrees_changes() {
    use milagre_owner_store::brief::fake::FakeBriefModel;
    use milagre_owner_store::brief::BriefRefused;
    use milagre_owner_store::chat_host::{ChatHost, HandoffMode, MockProvider};
    use milagre_owner_store::states::{ProjectStates, Timing};
    let Some((_base, copy)) = setup() else { return };
    let worktree = repository(&copy, "wt");
    let isolation = Isolation::open(&copy, &Policy::default()).unwrap();
    let project = isolation.project(Path::new("p")).unwrap();
    std::fs::create_dir_all(project.join(".milagre")).unwrap();
    let state = json!({ "next_id": 10, "worktrees": { "1": { "id": 1, "path": worktree.display().to_string(), "name": "main" } },
        "sessions": { "1": { "id": 1, "worktree_id": 1, "provider": "kiro", "title": "T" } },
        "messages": [
            { "id": 1, "session_id": 1, "role": "user", "body": "Fix it" },
            { "id": 2, "session_id": 1, "role": "assistant", "body": "Done.", "outcome": "completed" },
        ] });
    std::fs::write(
        project.join(".milagre/coordination.json"),
        state.to_string(),
    )
    .unwrap();
    let mut host = ChatHost::new(ProjectStates::new(isolation, Timing::default(), 0));
    host.handoff = HandoffMode::Restore;
    let kiro = MockProvider::new("kiro");
    host.register(Box::new(kiro.clone()));
    let brief = FakeBriefModel::default();
    brief.state.lock().unwrap().refuse = Some(BriefRefused::NoModel);
    host.register_brief_model(Box::new(brief));
    host.admit_worktree(&worktree).unwrap();
    host.send(&json!({ "projectPath": project.display().to_string(), "sessionId": 1, "provider": "kiro", "model": "m", "body": "Next", "clientMessageId": "c1" }))
        .unwrap();
    for job in host.take_jobs() {
        job.run();
    }
    host.pump();
    let prompt = kiro.state.lock().unwrap().turns[0]["prompt"]
        .as_str()
        .unwrap()
        .to_string();
    let expected: Vec<String> = node_changed(&copy, &[(None, &worktree)])
        .iter()
        .map(|file| format!("- {file}"))
        .collect();
    assert!(
        prompt.contains(&format!("Changed files:\n{}", expected.join("\n"))),
        "{prompt}"
    );
    assert!(prompt.contains("- edited.txt"), "{prompt}");
}

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
    use milagre_owner_store::chat_host::{ChatHost, MockProvider};
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
    host.enable_restore_for_tests().unwrap();
    let kiro = MockProvider::new("kiro");
    host.register(Box::new(kiro.clone()));
    let brief = FakeBriefModel::default();
    brief.state.lock().unwrap().refuse = Some(BriefRefused::NoModel);
    host.register_brief_model(Box::new(brief));
    host.admit_worktree(&worktree).unwrap();
    host.open_project(&project).unwrap();
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

/// The bounded runner: a run past its time is killed with everything it started; a descendant left holding a pipe
/// after the run exits can't hold it longer than the drain wait; output past the cap is no output.
#[test]
fn runs_are_bounded_in_time_descendants_and_output() {
    use milagre_owner_store::changed_files::test_hooks::run_bounded;
    use std::time::{Duration, Instant};
    let base = tempfile::tempdir().unwrap();
    let pidfile = base.path().join("child.pid");
    // Timed out: the background descendant dies with the group.
    let started = Instant::now();
    let script = format!("sleep 30 & echo $! > {}; wait", pidfile.display());
    assert!(run_bounded(
        "/bin/sh",
        &["-c", &script],
        Duration::from_millis(300),
        1024
    )
    .is_none());
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "{:?}",
        started.elapsed()
    );
    let pid: i32 = std::fs::read_to_string(&pidfile)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    std::thread::sleep(Duration::from_millis(100));
    // SAFETY: signal 0 only checks the process exists.
    assert!(
        unsafe { libc::kill(pid, 0) } != 0,
        "a descendant outlived the timeout"
    );
    // Exited, but a detached descendant keeps stdout open: no output, and no 30 s wait.
    let started = Instant::now();
    assert!(run_bounded(
        "/bin/sh",
        &["-c", "(sleep 30 &); echo hi"],
        Duration::from_secs(2),
        1024
    )
    .is_none());
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "{:?}",
        started.elapsed()
    );
    // Too much output: no output.
    assert!(run_bounded(
        "/bin/sh",
        &["-c", "head -c 4096 /dev/zero"],
        Duration::from_secs(2),
        1024
    )
    .is_none());
    assert_eq!(
        run_bounded("/bin/sh", &["-c", "echo ok"], Duration::from_secs(2), 1024).as_deref(),
        Some("ok\n")
    );
}

/// Whatever the repository's own config or attributes name is never run: a clean filter on every file (required),
/// a submodule with its own filter, a config changed after admission. Its changes still list as Node's would for the
/// same repository without them. `worktreeConfig` (an extension) and object alternates give no list. Odd aliases give
/// no list.
#[test]
fn nothing_the_repository_names_is_run() {
    let Some((base, copy)) = setup() else { return };
    let marker = base.path().join("MARKER");
    let repo = repository(&copy, "repo");
    // A nested repository committed as a submodule, with a hostile filter of its own and a change inside.
    let sub = repo.join("sub");
    std::fs::create_dir(&sub).unwrap();
    git(&sub, &["init", "-q"]);
    std::fs::write(sub.join("f.txt"), "x").unwrap();
    git(&sub, &["add", "."]);
    git(&sub, &["commit", "-q", "-m", "sub"]);
    git(&repo, &["add", "sub"]);
    std::fs::write(sub.join("f.txt"), "changed").unwrap();
    let hostile = |dir: &Path| {
        let config = dir.join(".git/config");
        let mut text = std::fs::read_to_string(&config).unwrap();
        text.push_str(&format!(
            "[filter \"evil\"]\n\tclean = touch {0}\n\tsmudge = touch {0}\n\trequired = true\n[core]\n\thooksPath = /tmp\n[diff]\n\texternal = touch {0}\n",
            marker.display()
        ));
        std::fs::write(&config, text).unwrap();
        std::fs::write(dir.join(".gitattributes"), "* filter=evil\n").unwrap();
    };
    let mut grants = GitGrants::new(&copy);
    grants.admit(&repo).unwrap();
    let expected = node_changed(&copy, &[(None, &repo)]);
    // Turned hostile after admission (the checks only refuse include/worktree/fsmonitor).
    hostile(&repo);
    hostile(&sub);
    let plan = grants.plan(Some(&repo.display().to_string()), None);
    let rust = changed_files(&copy, &plan).expect("a list");
    assert!(!marker.exists(), "a repository-named command ran");
    // Deliberately not listed: the submodule itself (Node's run looks into it; this one never opens a submodule).
    let mut expected: Vec<String> = expected.into_iter().filter(|file| file != "sub").collect();
    expected.push(".gitattributes".into());
    expected.sort();
    let mut rust_sorted = rust.clone();
    rust_sorted.sort();
    assert_eq!(rust_sorted, expected, "{rust:?}");
    assert!(
        !rust.iter().any(|file| file.starts_with("sub")),
        "the submodule was looked into: {rust:?}"
    );
    // An extension (worktreeConfig) and an object alternate: no list, nothing run.
    let extended = repository(&copy, "extended");
    grants.admit(&extended).unwrap();
    let config = extended.join(".git/config");
    let mut text = std::fs::read_to_string(&config).unwrap();
    text.push_str("[extensions]\n\tworktreeConfig = true\n");
    std::fs::write(&config, text).unwrap();
    assert!(changed_files(
        &copy,
        &grants.plan(Some(&extended.display().to_string()), None)
    )
    .is_none());
    let alternated = repository(&copy, "alternated");
    grants.admit(&alternated).unwrap();
    std::fs::write(
        alternated.join(".git/objects/info/alternates"),
        format!("{}/.git/objects\n", repo.display()),
    )
    .unwrap();
    assert!(changed_files(
        &copy,
        &grants.plan(Some(&alternated.display().to_string()), None)
    )
    .is_none());
    assert!(!marker.exists());
    // No private Git folder is left behind.
    let scratch = copy.join(".owner/git");
    assert_eq!(
        std::fs::read_dir(&scratch).map(|d| d.count()).unwrap_or(0),
        0
    );
    let path = repo.display().to_string();
    assert!(grants
        .plan(
            None,
            Some(&json!([{ "alias": "a".repeat(257), "worktreePath": path }]))
        )
        .is_none());
    assert!(grants
        .plan(
            None,
            Some(&json!([{ "alias": ["x"], "worktreePath": path }]))
        )
        .is_none());
    assert!(grants
        .plan(None, Some(&json!([{ "alias": 7, "worktreePath": path }])))
        .is_some());
}

/// Races and malformed metadata: a hostile config swapped in after the allow-list was read (also at the same size)
/// is never run; the private folder's path swapped for a link gives no list and nothing outside the copy is written
/// or left; an index that is a link gives no list while an absent one (nothing staged yet) lists as Node does; a
/// config Git can't parse gives no list.
#[test]
fn races_and_bad_metadata_never_run_or_redirect() {
    use milagre_owner_store::changed_files::test_hooks::before_status;
    let Some((base, copy)) = setup() else { return };
    let marker = base.path().join("MARKER");
    let repo = repository(&copy, "repo");
    let mut grants = GitGrants::new(&copy);
    grants.admit(&repo).unwrap();
    let plan = grants.plan(Some(&repo.display().to_string()), None);
    // Hostile config swapped in between the allow-list read and the status run, then one of the same size.
    let config = repo.join(".git/config");
    let original = std::fs::read_to_string(&config).unwrap();
    let hostile = format!(
        "[filter \"evil\"]\n\tclean = touch {}\n\trequired = true\n",
        marker.display()
    );
    std::fs::write(repo.join(".gitattributes"), "* filter=evil\n").unwrap();
    let (swap, text) = (config.clone(), hostile.clone());
    before_status(move || std::fs::write(&swap, text).unwrap());
    changed_files(&copy, &plan);
    assert!(!marker.exists(), "a config swapped in mid-run was run");
    let mut same = hostile.clone();
    same.truncate(original.len().min(same.len()));
    while same.len() < original.len() {
        same.push('\n');
    }
    std::fs::write(&config, &same).unwrap();
    changed_files(&copy, &plan);
    assert!(!marker.exists(), "a same-size hostile config was run");
    std::fs::write(&config, &original).unwrap();
    std::fs::remove_file(repo.join(".gitattributes")).unwrap();
    // The private folder's path swapped for a link to a folder outside: no list, nothing written there.
    let outside = base.path().join("outside");
    std::fs::create_dir(&outside).unwrap();
    let git_folder = copy.join(".owner/git");
    let moved = base.path().join("moved-git");
    let (from, to, link) = (git_folder.clone(), moved.clone(), outside.clone());
    before_status(move || {
        std::fs::rename(&from, &to).unwrap();
        symlink(&link, &from).unwrap();
    });
    assert!(
        changed_files(&copy, &plan).is_none(),
        "a swapped private folder was used"
    );
    assert_eq!(
        std::fs::read_dir(&outside).unwrap().count(),
        0,
        "something was written outside"
    );
    assert_eq!(
        std::fs::read_dir(&moved).unwrap().count(),
        0,
        "the private folder wasn't removed through its handle"
    );
    std::fs::remove_file(&git_folder).unwrap();
    // An index that is a link: no list. An absent one (a fresh repository): listed as Node lists it.
    let linked = repository(&copy, "linked");
    grants.admit(&linked).unwrap();
    let index = linked.join(".git/index");
    std::fs::rename(&index, base.path().join("index-elsewhere")).unwrap();
    symlink(base.path().join("index-elsewhere"), &index).unwrap();
    assert!(changed_files(
        &copy,
        &grants.plan(Some(&linked.display().to_string()), None)
    )
    .is_none());
    let fresh = copy.join("fresh");
    std::fs::create_dir(&fresh).unwrap();
    git(&fresh, &["init", "-q"]);
    std::fs::write(fresh.join("new.txt"), "x").unwrap();
    let fresh = std::fs::canonicalize(fresh).unwrap();
    assert!(!fresh.join(".git/index").exists());
    grants.admit(&fresh).unwrap();
    let listed = changed_files(
        &copy,
        &grants.plan(Some(&fresh.display().to_string()), None),
    )
    .unwrap();
    assert_eq!(listed, node_changed(&copy, &[(None, &fresh)]));
    // A config Git can't parse: no list (Node's run fails too).
    let broken = repository(&copy, "broken");
    grants.admit(&broken).unwrap();
    std::fs::write(broken.join(".git/config"), "[core\n\tbare = false\n").unwrap();
    assert!(changed_files(
        &copy,
        &grants.plan(Some(&broken.display().to_string()), None)
    )
    .is_none());
    assert!(!marker.exists());
}

/// The admitted worktree, or its `.git` alone, swapped for another real folder under the same name (a copy of the
/// same repository plus a file of its own) before Git runs or while it runs: no list. Untouched, it lists.
#[test]
fn a_worktree_swapped_under_its_name_gives_no_list() {
    use milagre_owner_store::changed_files::test_hooks::{after_git, before_status};
    let Some((base, copy)) = setup() else { return };
    let repo = repository(&copy, "repo");
    let other = copy.join("other");
    assert!(Command::new("/bin/cp")
        .args(["-Rp"])
        .arg(&repo)
        .arg(&other)
        .status()
        .unwrap()
        .success());
    std::fs::write(other.join("other-only.txt"), "x").unwrap();
    let mut grants = GitGrants::new(&copy);
    grants.admit(&repo).unwrap();
    let plan = grants.plan(Some(&repo.display().to_string()), None);
    let listed = changed_files(&copy, &plan).expect("a list");
    assert!(!listed.iter().any(|file| file == "other-only.txt"));
    let aside = base.path().join("aside");
    // Swaps `name` (the worktree, or its .git) with the copy's, and back.
    let swap = |name: &str| {
        let (from, to, away) = (other.join(name), repo.join(name), aside.clone());
        move || {
            std::fs::rename(&to, &away).unwrap();
            std::fs::rename(&from, &to).unwrap();
        }
    };
    let back = |name: &str| {
        std::fs::rename(repo.join(name), other.join(name)).unwrap();
        std::fs::rename(&aside, repo.join(name)).unwrap();
    };
    // The whole worktree before Git runs, then while it runs.
    let (from, to, away) = (other.clone(), repo.clone(), aside.clone());
    before_status(move || {
        std::fs::rename(&to, &away).unwrap();
        std::fs::rename(&from, &to).unwrap();
    });
    assert!(
        changed_files(&copy, &plan).is_none(),
        "a worktree swapped in before Git ran was listed"
    );
    std::fs::rename(&repo, &other).unwrap();
    std::fs::rename(&aside, &repo).unwrap();
    let (from, to, away) = (other.clone(), repo.clone(), aside.clone());
    after_git(move || {
        std::fs::rename(&to, &away).unwrap();
        std::fs::rename(&from, &to).unwrap();
    });
    assert!(
        changed_files(&copy, &plan).is_none(),
        "a worktree swapped while Git ran was listed"
    );
    std::fs::rename(&repo, &other).unwrap();
    std::fs::rename(&aside, &repo).unwrap();
    // Its .git alone, before Git runs.
    before_status(swap(".git"));
    assert!(
        changed_files(&copy, &plan).is_none(),
        "a .git swapped in before Git ran was used"
    );
    back(".git");
    assert_eq!(changed_files(&copy, &plan), Some(listed));
}

/// Metadata under `.git` is read through descriptors from the held `.git` down: a link on the way (`refs`, `info`,
/// `objects`, `objects/info`), even one to a folder with the same contents, gives no list. A folder on the way that
/// isn't there is only absent: refs packed with `refs/heads` removed still list as Node does.
#[test]
fn a_link_above_git_metadata_gives_no_list() {
    let Some((base, copy)) = setup() else { return };
    let mut grants = GitGrants::new(&copy);
    // Moves `.git/<name>` to `away` and puts a link to it in its place.
    let linked = |repo: &Path, name: &str, away: &Path| {
        let at = repo.join(".git").join(name);
        std::fs::rename(&at, away).unwrap();
        symlink(away, &at).unwrap();
    };
    for (index, name) in ["refs", "info", "objects", "objects/info"]
        .into_iter()
        .enumerate()
    {
        let repo = repository(&copy, &format!("repo{index}"));
        grants.admit(&repo).unwrap();
        let plan = grants.plan(Some(&repo.display().to_string()), None);
        assert!(
            changed_files(&copy, &plan).is_some(),
            "{name}: no list before the link"
        );
        // `objects` points inside the worktree itself; the others outside the copy.
        let away = if name == "objects" {
            repo.join("store")
        } else {
            base.path().join(format!("away{index}"))
        };
        linked(&repo, name, &away);
        assert!(
            changed_files(&copy, &plan).is_none(),
            "{name}: read through a link"
        );
    }
    let packed = repository(&copy, "packed");
    git(&packed, &["pack-refs", "--all"]);
    std::fs::remove_dir_all(packed.join(".git/refs/heads")).unwrap();
    grants.admit(&packed).unwrap();
    let rust = changed_files(
        &copy,
        &grants.plan(Some(&packed.display().to_string()), None),
    )
    .expect("a list from packed refs");
    let mut rust = rust;
    let mut node = node_changed(&copy, &[(None, &packed)]);
    rust.sort();
    node.sort();
    assert_eq!(rust, node);
}

/// A pipe read that fails ends the run with no list, never with what was read so far; an interrupted read is retried.
#[test]
fn a_failed_pipe_read_gives_no_output() {
    use milagre_owner_store::changed_files::test_hooks::{fail_next_read, run_bounded};
    use std::time::Duration;
    let run = || run_bounded("/bin/sh", &["-c", "echo ok"], Duration::from_secs(2), 1024);
    fail_next_read(std::io::ErrorKind::BrokenPipe);
    assert_eq!(
        run(),
        None,
        "a failed read was taken for the end of the output"
    );
    fail_next_read(std::io::ErrorKind::Interrupted);
    assert_eq!(run().as_deref(), Some("ok\n"));
    assert_eq!(run().as_deref(), Some("ok\n"));
}

/// The kept `core` settings are read as Git reads them: `off` is false (a mode change isn't listed, as Node's run
/// doesn't list it), a valueless key is true, and a value Git would refuse gives no list instead of being dropped.
#[test]
fn kept_settings_are_read_as_git_reads_them() {
    use std::os::unix::fs::PermissionsExt;
    let Some((_base, copy)) = setup() else { return };
    let mut grants = GitGrants::new(&copy);
    let with = |name: &str, extra: &str| {
        let repo = repository(&copy, name);
        let config = repo.join(".git/config");
        let mut text = std::fs::read_to_string(&config).unwrap();
        text.push_str(extra);
        std::fs::write(&config, text).unwrap();
        std::fs::set_permissions(
            repo.join("kept.txt"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        repo
    };
    let sorted = |mut list: Vec<String>| {
        list.sort();
        list
    };
    for (name, extra, mode_listed) in [
        ("off", "[core]\n\tfilemode = off\n", false),
        ("zero", "[core]\n\tfilemode = 0\n", false),
        ("valueless", "[core]\n\tfilemode = off\n\tfilemode\n", true),
    ] {
        let repo = with(name, extra);
        grants.admit(&repo).unwrap();
        let rust = changed_files(&copy, &grants.plan(Some(&repo.display().to_string()), None))
            .unwrap_or_else(|| panic!("{name}: no list"));
        assert_eq!(
            rust.iter().any(|file| file == "kept.txt"),
            mode_listed,
            "{name}: {rust:?}"
        );
        assert_eq!(
            sorted(rust),
            sorted(node_changed(&copy, &[(None, &repo)])),
            "{name}"
        );
    }
    for (name, extra) in [
        ("maybe", "[core]\n\tfilemode = maybe\n"),
        ("checkstat", "[core]\n\tcheckstat = sometimes\n"),
        ("eol", "[core]\n\teol = cr\n"),
    ] {
        let repo = with(name, extra);
        grants.admit(&repo).unwrap();
        assert!(
            changed_files(&copy, &grants.plan(Some(&repo.display().to_string()), None)).is_none(),
            "{name}: a value Git wouldn't take was dropped"
        );
    }
}

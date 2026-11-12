//! The Preview's Changes panel on the runtime's typed Git reads, with the backend's fixed Claude stand-in.
//!
//! One Chat (one fixed reply), then: the Project folder is not a repository (the runtime's own message, the panel
//! live with Changes only); a synthetic repository with a commit, a modified file and an untracked one (both listed
//! with their patches, the branch in the history); the local PR diff routes with commits the repository does not
//! have (the runtime's fetch-needed and empty-patch answers; the PR tab stays off). No account, network or fetch.

use std::path::Path;
use std::process::Command;
use std::sync::Arc;

use gpui::TestAppContext;
use milagre_gpui_spike::logic::diff::git::DiffStatus;
use milagre_gpui_spike::workspace::panel::PanelTab;
use milagre_gpui_spike::workspace::panel::changes::data::ChangesData;
use serde_json::{Value, json};

use super::owned::{Mounted, delta, finish, handshake, init, mount, prepare_with, result, stage};
use crate::session::{self, Root as RootKind, Session};

fn git(dir: &Path, args: &[&str]) {
    let status = Command::new("/usr/bin/git")
        .args(args)
        .current_dir(dir)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "GPUI check")
        .env("GIT_AUTHOR_EMAIL", "gpui@example.invalid")
        .env("GIT_COMMITTER_NAME", "GPUI check")
        .env("GIT_COMMITTER_EMAIL", "gpui@example.invalid")
        .status()
        .expect("git");
    assert!(status.success(), "git {args:?}");
}

fn changes(m: &mut Mounted) -> ChangesData {
    m.workspace.read_with(m.vcx, |w, cx| w.panel.read(cx).changes_data().clone())
}

#[gpui::test]
#[ignore = "staged runtime: run through daemon-check/scripts/check-gpui-live.py"]
fn the_preview_changes_panel_reads_the_worktree(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let case = stage().join("case-git");
    let mut first = handshake(json!({"absent":["--no-session-persistence","--resume"]}));
    first.extend([json!({"expect":{"type":"user"}}), init(), delta("Ready"), result(), json!({"wait_eof":true})]);
    let (root, manifest) = prepare_with(&case, Some(first));
    let guard =
        Arc::new(futures::executor::block_on(session::launch(RootKind::Create { root: &root, manifest: &manifest })).expect("create"));
    let session = futures::executor::block_on(Session::connect(guard.clone())).expect("connect");
    let project = session.project.clone();
    let git_reads = session.git.clone();
    let mut m = mount(cx, session);
    assert!(m.vcx.debug_bounds("toggle-panel").is_none(), "no panel toggle before the panel is backed");

    // One Chat, so the panel has a Chat to follow.
    m.type_and_send("One turn");
    m.until("the reply", |m| !m.running() && m.items() == ["user: One turn", "reply: Ready"]);

    // Not a repository: the runtime says so; the panel shows Changes only, and its toggle is back.
    m.until("the not-a-repository answer", |m| matches!(changes(m), ChangesData::NotRepo(_)));
    let ChangesData::NotRepo(message) = changes(&mut m) else { unreachable!() };
    println!("GPUI_LIVE_GIT_NOT_REPO {message:?}");
    let (live, tabs) = m.workspace.read_with(m.vcx, |w, cx| (w.panel.read(cx).is_live(), w.panel.read(cx).visible_tabs()));
    assert!(live);
    assert_eq!(tabs, [PanelTab::Changes], "only the tab the runtime backs");
    m.vcx.run_until_parked();
    assert!(m.vcx.debug_bounds("toggle-panel").is_some(), "the panel toggle returns once Changes is backed");

    // A synthetic repository in the Project folder: one commit, a modified file, an untracked file.
    let dir = Path::new(&project);
    git(dir, &["init", "-q", "-b", "main"]);
    std::fs::write(dir.join("kept.txt"), "one\ntwo\n").unwrap();
    git(dir, &["add", "kept.txt"]);
    git(dir, &["commit", "-q", "-m", "First commit"]);
    // A branch with its own commit: "On this branch" and the history compare it with main.
    git(dir, &["checkout", "-q", "-b", "feature"]);
    std::fs::write(dir.join("branch.txt"), "on the branch\n").unwrap();
    git(dir, &["add", "branch.txt"]);
    git(dir, &["commit", "-q", "-m", "Branch commit"]);
    std::fs::write(dir.join("kept.txt"), "one\ntwo changed\n").unwrap();
    std::fs::write(dir.join("new.txt"), "fresh\n").unwrap();
    m.controller.update(m.vcx, |c, cx| c.read_changes(cx));
    m.until("the repository's changes", |m| matches!(changes(m), ChangesData::Ready(_)));
    let ChangesData::Ready(read) = changes(&mut m) else { unreachable!() };
    let listed: Vec<_> = read.uncommitted.files.iter().map(|f| (f.path.clone(), f.status, f.untracked, f.added, f.removed)).collect();
    println!("GPUI_LIVE_GIT_UNCOMMITTED {listed:?} branch={:?} commits={}", read.history.branch, read.history.commits.len());
    assert!(listed.contains(&("kept.txt".into(), DiffStatus::Modified, false, 1, 1)), "{listed:?}");
    assert!(
        listed.iter().any(|(path, status, untracked, ..)| path == "new.txt" && *status == DiffStatus::Added && *untracked),
        "{listed:?}"
    );
    assert!(read.patches["kept.txt"].patch.contains("+two changed"), "{:?}", read.patches.get("kept.txt"));
    assert!(read.patches["new.txt"].patch.contains("+fresh"), "{:?}", read.patches.get("new.txt"));
    let committed: Vec<_> = read.committed.files.iter().map(|f| f.path.clone()).collect();
    println!("GPUI_LIVE_GIT_COMMITTED {committed:?} base={:?} history_base={:?}", read.committed.base, read.history.base);
    assert_eq!(read.history.branch.as_deref(), Some("feature"));
    assert_eq!(read.history.commits.first().map(|c| c.message.as_str()), Some("Branch commit"));
    assert_eq!(committed, ["branch.txt"], "on this branch, against main");
    let sha = read.history.commits[0].sha.clone();
    assert_eq!(read.commit_files.get(&sha).map(|f| f.files.len()), Some(1), "the commit's files are read too");
    let file_count = m.workspace.read_with(m.vcx, |w, cx| w.panel.read(cx).changes().read(cx).file_count());
    assert_eq!(file_count, 3, "the panel lists the uncommitted and committed files");

    // Local PR diffs for commits this repository does not have: the runtime's own answers, never a fetch.
    let (missing_base, missing_head) = ("1".repeat(40), "2".repeat(40));
    let (files, patch) = futures::executor::block_on(async {
        (
            git_reads.pr_diff_files(&missing_base, &missing_head).await,
            git_reads.pr_diff_file(&missing_base, &missing_head, "kept.txt", None).await,
        )
    });
    println!("GPUI_LIVE_GIT_PR_MISSING files={files:?} patch={patch:?}");
    let files: Value = files.expect("pr:diff-files answers");
    let patch: Value = patch.expect("pr:diff-file answers");
    assert!(files.to_string().to_lowercase().contains("fetch"), "fetch-needed: {files}");
    assert_eq!(patch["patch"].as_str().unwrap_or(""), "", "an empty patch: {patch}");

    m.controller.update(m.vcx, |c, _| c.disconnect());
    finish(&guard);
}

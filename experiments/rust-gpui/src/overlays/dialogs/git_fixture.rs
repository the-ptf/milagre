//! The "Commit and open PR" dialog's bridge (`bridge.git.changes`, `generate`, `commit`, `push`, `openPr`) as a
//! trait, and a fixture that plays seven folder states: the dialog's whole mode table (`lib/git-dialog.ts`) without a
//! repository. A daemon-backed bridge replaces [`FixtureGit`]; the dialog reads and runs through the trait only.

use std::cell::RefCell;

use super::git_dialog::{GitChanges, GitFileChange, GitFileStatus, GitPullRequest, RepoChanges};
use crate::logic::diff::codes::GitCode;

/// Which folder the fixture plays.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scenario {
    /// A worktree branch with changes, one of them a secret: commit, push and open a PR.
    Ready,
    /// The same, with a PR already open: pushing updates it.
    OpenPr,
    /// On the base branch: committing is the primary button.
    Base,
    /// No origin remote: only the commit runs.
    NoOrigin,
    /// A merge in progress: both commit buttons disabled.
    MergeBlocked,
    /// A pre-commit hook rejects the commit and prints why.
    Hook,
    /// The push is rejected.
    PushRejected,
    /// Everything is committed and pushed.
    Clean,
    /// The folder is not a repository.
    NotRepo,
}

impl Scenario {
    pub const ALL: [Scenario; 9] = [
        Scenario::Ready,
        Scenario::OpenPr,
        Scenario::Base,
        Scenario::NoOrigin,
        Scenario::MergeBlocked,
        Scenario::Hook,
        Scenario::PushRejected,
        Scenario::Clean,
        Scenario::NotRepo,
    ];

    pub fn key(self) -> &'static str {
        match self {
            Scenario::Ready => "ready",
            Scenario::OpenPr => "open-pr",
            Scenario::Base => "base",
            Scenario::NoOrigin => "no-origin",
            Scenario::MergeBlocked => "merge-blocked",
            Scenario::Hook => "hook",
            Scenario::PushRejected => "push-rejected",
            Scenario::Clean => "clean",
            Scenario::NotRepo => "not-repo",
        }
    }

    pub fn from_key(key: &str) -> Option<Scenario> {
        Scenario::ALL.into_iter().find(|scenario| scenario.key() == key)
    }
}

/// `GitTextResult`'s text.
#[derive(Clone, Debug, PartialEq)]
pub struct GeneratedText {
    pub commit_message: String,
    pub pr_title: String,
    pub pr_body: String,
}

#[derive(Clone, Debug, PartialEq)]
pub enum CommitKind {
    Hook,
    Signing,
    Secrets,
    Blocked,
    Nothing,
    Error,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CommitFailure {
    pub code: Option<GitCode>,
    pub kind: CommitKind,
    pub message: String,
    pub output: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PushFailure {
    pub code: Option<GitCode>,
    pub message: String,
    pub hint: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PrFailure {
    pub code: Option<GitCode>,
    pub message: String,
}

pub trait GitBridge {
    /// `git:changes [{ cwd, base }]`.
    fn changes(&self) -> Result<GitChanges, String>;
    /// `git:generate`: the commit message and PR text written from the diff and the Chat.
    fn generate(&self) -> Result<GeneratedText, String>;
    /// `git:commit`: the short SHA.
    fn commit(&self, message: &str) -> Result<String, CommitFailure>;
    /// `git:push`: the branch and the remote it went to.
    fn push(&self) -> Result<(String, String), PushFailure>;
    /// `git:open-pr`: the PR's URL and number.
    fn open_pr(&self, title: &str, body: &str) -> Result<(String, Option<u32>), PrFailure>;
}

fn file(path: &str, status: GitFileStatus, added: u32, removed: u32) -> GitFileChange {
    GitFileChange { path: path.to_string(), status, added, removed, secret: false }
}

fn dirty_files() -> Vec<GitFileChange> {
    use GitFileStatus::{Added, Deleted, Modified};
    vec![
        file("experiments/rust-gpui/src/workspace/panel/pr/mod.rs", Added, 412, 0),
        file("experiments/rust-gpui/src/workspace/panel/pr/header.rs", Added, 318, 0),
        file("experiments/rust-gpui/src/workspace/panel/mod.rs", Modified, 14, 2),
        file("experiments/rust-gpui/src/workspace/panel/body.rs", Modified, 1, 1),
        file("experiments/rust-gpui/tools/gen-icons.mjs", Modified, 8, 0),
        file("experiments/rust-gpui/PORT-MAP.md", Modified, 3, 3),
        file("experiments/rust-gpui/src/overlays/dialogs/old_dialog.rs", Deleted, 0, 96),
        GitFileChange { secret: true, ..file(".env.local", Added, 2, 0) },
    ]
}

const BRANCH: &str = "milagre/chat-tie0";

fn repo(scenario: Scenario) -> RepoChanges {
    let mut repo = RepoChanges {
        branch: Some(BRANCH.to_string()),
        base: "main".to_string(),
        files: dirty_files(),
        has_changes: true,
        unpushed: 1,
        ahead: 1,
        has_origin: true,
        remotes: 1,
        pr_repo: None,
        on_base: false,
        commit_blocked: None,
        gh_ready: true,
        gh_message: None,
        pr: None,
    };
    match scenario {
        Scenario::Ready | Scenario::Hook | Scenario::PushRejected | Scenario::NotRepo => {}
        Scenario::OpenPr => {
            repo.pr = Some(GitPullRequest { number: Some(412), url: "https://github.com/the-ptf/milagre-ade/pull/412".to_string() })
        }
        Scenario::Base => {
            repo.branch = Some("main".to_string());
            repo.on_base = true;
        }
        Scenario::NoOrigin => {
            repo.has_origin = false;
            repo.gh_ready = false;
        }
        Scenario::MergeBlocked => {
            repo.commit_blocked = Some("A merge is in progress. Finish or abort it, then commit.".to_string());
            repo.remotes = 2;
            repo.pr_repo = Some("the-ptf/milagre-ade".to_string());
        }
        Scenario::Clean => {
            repo.files.clear();
            repo.has_changes = false;
            repo.unpushed = 0;
            repo.ahead = 0;
        }
    }
    repo
}

const HOOK_OUTPUT: &str = "> milagre@0.232.0 lint\n> oxlint --deny-warnings\n\n  x eslint(no-unused-vars): `Window` is declared but never used\n   ,-[apps/desktop/app/src/lib/git-dialog.ts:3:8]\n 3 | import type { Window } from \"./dom\";\n   :              ^^^^^^\n   `----\n\nFound 1 error.\nhusky - pre-commit script failed (code 1)";

/// What has happened since the dialog opened: the folder moves on after each step.
#[derive(Default)]
struct Progress {
    committed: bool,
    pushed: bool,
    pr: Option<(String, Option<u32>)>,
}

pub struct FixtureGit {
    scenario: Scenario,
    progress: RefCell<Progress>,
}

impl FixtureGit {
    pub fn new(scenario: Scenario) -> Self {
        Self { scenario, progress: RefCell::new(Progress::default()) }
    }
}

impl GitBridge for FixtureGit {
    fn changes(&self) -> Result<GitChanges, String> {
        if self.scenario == Scenario::NotRepo {
            return Ok(GitChanges::NotRepo { message: None });
        }
        let mut repo = repo(self.scenario);
        let progress = self.progress.borrow();
        if progress.committed {
            repo.files.clear();
            repo.has_changes = false;
            repo.unpushed = repo.unpushed.max(1);
            repo.ahead = repo.ahead.max(1);
        }
        if progress.pushed {
            repo.unpushed = 0;
        }
        if let Some((url, number)) = &progress.pr {
            repo.pr = Some(GitPullRequest { number: *number, url: url.clone() });
        }
        Ok(GitChanges::Repo(repo))
    }

    fn generate(&self) -> Result<GeneratedText, String> {
        Ok(GeneratedText {
            commit_message: "feat(experiments): PR panel and Git actions dialog in the GPUI port\n\nThe PR tab (header and merge actions, checks bar, reviewers and labels, Summary and Files) and the Commit and open PR dialog."
                .to_string(),
            pr_title: "feat(experiments): PR panel and Git actions dialog in the GPUI port".to_string(),
            pr_body: "## What\n\nThe PR tab and the Commit and open PR dialog in the GPUI port, on fixture data.\n\n## How to check\n\n- `cargo test`\n- `MILAGRE_GPUI_SNAPSHOT=/tmp/pr.png MILAGRE_GPUI_PANEL_TAB=PR cargo run`".to_string(),
        })
    }

    fn commit(&self, message: &str) -> Result<String, CommitFailure> {
        let _ = message;
        match self.scenario {
            Scenario::Hook => Err(CommitFailure {
                code: None,
                kind: CommitKind::Hook,
                message: "A git hook stopped the commit.".to_string(),
                output: Some(HOOK_OUTPUT.to_string()),
            }),
            Scenario::MergeBlocked => {
                Err(CommitFailure { code: None, kind: CommitKind::Blocked, message: "A merge is in progress.".to_string(), output: None })
            }
            _ => {
                self.progress.borrow_mut().committed = true;
                Ok("3f9a1c2".to_string())
            }
        }
    }

    fn push(&self) -> Result<(String, String), PushFailure> {
        match self.scenario {
            Scenario::PushRejected => Err(PushFailure {
                code: None,
                message: "The remote has commits this branch does not. Pull them in, then push again.".to_string(),
                hint: Some("Ask the agent to rebase the branch on origin, or update it from the PR.".to_string()),
            }),
            Scenario::NoOrigin => Err(PushFailure { code: Some(GitCode::NoOrigin), message: String::new(), hint: None }),
            _ => {
                self.progress.borrow_mut().pushed = true;
                let branch = if self.scenario == Scenario::Base { "main" } else { BRANCH };
                Ok((branch.to_string(), "origin".to_string()))
            }
        }
    }

    fn open_pr(&self, title: &str, body: &str) -> Result<(String, Option<u32>), PrFailure> {
        let _ = (title, body);
        let result = ("https://github.com/the-ptf/milagre-ade/pull/413".to_string(), Some(413));
        self.progress.borrow_mut().pr = Some(result.clone());
        Ok(result)
    }
}

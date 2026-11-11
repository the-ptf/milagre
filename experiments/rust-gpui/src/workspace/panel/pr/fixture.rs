//! A realistic PR for the panel while it has no daemon: six variants (ready, pending, draft, blocked, merged,
//! closed) of one pull request, with checks, reviewers, labels, a description in GitHub's HTML, comments, review
//! threads and a patch per file. Timestamps are relative to `now`, so "updated 2h ago" reads the same on any day.

use super::bridge::{PrBridge, Write};
use super::model::{
    Check, Comment, Label, MergeMethod, Outcome, PrFile, PullRequestDetail, PullState, RepoLabel, ReviewDecision, Reviewer, ReviewerState,
    Side, Thread, now_ms,
};
use crate::logic::diff::git::{DiffFileResult, DiffStatus};

/// Which PR the fixture shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Variant {
    /// Open, CLEAN, every check passed, approved: the primary Merge button.
    Ready,
    /// Open, checks running, a review required: "Merge when ready".
    Pending,
    Draft,
    /// Conflicts, two failing checks, changes requested: the admin escape hatch.
    Blocked,
    Merged,
    Closed,
}

impl Variant {
    pub const ALL: [Variant; 6] = [Variant::Ready, Variant::Pending, Variant::Draft, Variant::Blocked, Variant::Merged, Variant::Closed];

    pub fn key(self) -> &'static str {
        match self {
            Variant::Ready => "ready",
            Variant::Pending => "pending",
            Variant::Draft => "draft",
            Variant::Blocked => "blocked",
            Variant::Merged => "merged",
            Variant::Closed => "closed",
        }
    }

    pub fn from_key(key: &str) -> Option<Variant> {
        Variant::ALL.into_iter().find(|variant| variant.key() == key)
    }

    /// The seeded Chat's PR (412) is ready; the others vary by number.
    pub fn for_number(number: u32) -> Variant {
        if number == 412 { Variant::Ready } else { Variant::ALL[number as usize % Variant::ALL.len()] }
    }
}

const REPO_URL: &str = "https://github.com/the-ptf/milagre-ade/pull";
const MINUTE: i64 = 60_000;

type Hunk = (u32, &'static str);

/// A `git diff` patch for one file: `(start line, body)` hunks whose lines start with ` `, `+` or `-`.
fn patch(old: Option<&str>, new: Option<&str>, hunks: &[Hunk]) -> String {
    let path = new.or(old).unwrap_or("");
    let mut out = format!("diff --git a/{} b/{path}\n", old.unwrap_or(path));
    out.push_str(&match old {
        Some(old) => format!("--- a/{old}\n"),
        None => "--- /dev/null\n".to_string(),
    });
    out.push_str(&match new {
        Some(new) => format!("+++ b/{new}\n"),
        None => "+++ /dev/null\n".to_string(),
    });
    for (start, body) in hunks {
        let lines: Vec<&str> = body.lines().collect();
        let count = |keep: &[char]| lines.iter().filter(|l| keep.contains(&l.chars().next().unwrap_or(' '))).count();
        let (old_n, new_n) = (count(&[' ', '-']), count(&[' ', '+']));
        let (old_start, new_start) = if old.is_some() { (*start, *start) } else { (0, 1) };
        out.push_str(&format!("@@ -{old_start},{old_n} +{new_start},{new_n} @@\n"));
        for line in lines {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

/// A changed file: its entry (counts computed from the patch) and the patch.
fn file(old: Option<&str>, new: Option<&str>, hunks: &[Hunk]) -> (PrFile, String) {
    let text = patch(old, new, hunks);
    let (additions, deletions) = text.lines().fold((0, 0), |(a, d), line| match line.as_bytes().first() {
        Some(b'+') if !line.starts_with("+++") => (a + 1, d),
        Some(b'-') if !line.starts_with("---") => (a, d + 1),
        _ => (a, d),
    });
    let status = match (old, new) {
        (None, _) => DiffStatus::Added,
        (_, None) => DiffStatus::Deleted,
        (Some(a), Some(b)) if a != b => DiffStatus::Renamed,
        _ => DiffStatus::Modified,
    };
    (PrFile { path: new.or(old).unwrap_or("").to_string(), additions, deletions, status }, text)
}

/// The PR's files with their patches.
pub fn files() -> Vec<(PrFile, String)> {
    let base = "experiments/rust-gpui/src/workspace/panel";
    let a = |s: &str| format!("{base}/{s}");
    let (mod_rs, header_rs, model_rs, panel_mod, body_rs, git_dialog) = (
        a("pr/mod.rs"),
        a("pr/header.rs"),
        a("pr/model.rs"),
        a("mod.rs"),
        a("body.rs"),
        "experiments/rust-gpui/src/overlays/dialogs/git_actions.rs".to_string(),
    );
    vec![
        file(
            None,
            Some(&mod_rs),
            &[(
                1,
                "+//! The PR panel (P-09): the header and merge actions, the checks bar, Summary and Files.\n\
                 +\n\
                 +pub mod bridge;\n\
                 +pub mod fixture;\n\
                 +pub mod model;\n\
                 +\n\
                 +pub struct PrView {\n\
                 +    detail: Option<PullRequestDetail>,\n\
                 +    tab: Tab,\n\
                 +}",
            )],
        ),
        file(
            None,
            Some(&header_rs),
            &[(
                1,
                "+/// The line under the branch: what stops an open PR, or how a merged or closed one ended.\n\
                 +fn status_line(pr: &PullRequestDetail) -> Option<AnyElement> {\n\
                 +    let status = merge_status(pr);\n\
                 +    matches!(status.tone, StatusTone::Blocked | StatusTone::Draft | StatusTone::Merged | StatusTone::Closed)\n\
                 +        .then(|| div().child(status.title).into_any_element())\n\
                 +}",
            )],
        ),
        file(
            None,
            Some(&model_rs),
            &[(
                1,
                "+/// `canMergeNow`: whether \"Merge\" merges now; otherwise the client offers auto-merge.\n\
                 +pub fn can_merge_now(pr: &PullRequestDetail) -> bool {\n\
                 +    pr.state == PullState::Open && !pr.is_draft && matches!(pr.merge_state_status.as_str(), \"CLEAN\" | \"UNSTABLE\")\n\
                 +}",
            )],
        ),
        file(
            Some(&panel_mod),
            Some(&panel_mod),
            &[
                (
                    16,
                    " pub mod body;\n pub mod changes;\n pub mod dock;\n pub mod fixture;\n+pub mod pr;\n \n #[cfg(test)]\n mod dock_tests;",
                ),
                (
                    110,
                    "     changes: Entity<ChangesView>,\n+    pr: Entity<PrView>,\n     placeholders: HashMap<PanelTab, Entity<TabPlaceholder>>,",
                ),
            ],
        ),
        file(
            Some(&body_rs),
            Some(&body_rs),
            &[(
                9,
                "-/// What a tab says until its package lands (WP-33 Terminal, WP-35 Browser, WP-36 Designs, WP-37 Artifacts, WP-32 PR).\n\
                 +/// What a tab says until its package lands (WP-33 Terminal, WP-35 Browser, WP-36 Designs, WP-37 Artifacts).",
            )],
        ),
        file(
            Some(&git_dialog),
            Some(&git_dialog),
            &[(
                42,
                " fn footer_reason(mode: &DialogMode, generating: bool) -> Option<String> {\n-    mode.primary.as_ref()?.disabled_reason.clone()\n+    mode.primary.as_ref().and_then(|button| button.disabled_reason.clone())\n }",
            )],
        ),
    ]
}

fn comment(id: &str, author: &str, body: &str, minutes_ago: i64, now: i64) -> Comment {
    Comment {
        id: id.to_string(),
        author: author.to_string(),
        body: body.to_string(),
        created_at: now - minutes_ago * MINUTE,
        pending: false,
    }
}

fn check(name: &str, workflow: Option<&str>, outcome: Outcome) -> Check {
    Check {
        name: name.to_string(),
        workflow: workflow.map(str::to_string),
        outcome,
        url: Some("https://github.com/the-ptf/milagre-ade/actions/runs/1".to_string()),
    }
}

const BODY: &str = "## What\n\nThe PR panel and the Git actions dialog in the GPUI port: header and merge actions, the checks bar, reviewers and labels, Summary and Files.\n\n<!-- Describe the change -->\n\n- Merge, Merge when ready and Merge anyway follow `canMergeNow`\n- The merge method is remembered per repository\n- Files lists the PR's files; a click shows a read-only unified diff\n\n<img width=\"640\" alt=\"PR panel\" src=\"https://github.com/user-attachments/assets/0d1c2c9e-1111-4222-8333-444455556666\">\n\nCloses #1180.";

const REVIEW_BODY: &str = "Looks right. One nit on `status_line`: it builds the element even when the tone shows nothing.";

/// The label colours the repository uses.
pub fn repo_labels() -> Vec<RepoLabel> {
    let label = |name: &str, color: &str, description: &str| RepoLabel {
        name: name.to_string(),
        color: color.to_string(),
        description: description.to_string(),
    };
    vec![
        label("desktop", "1d76db", "The Electron app"),
        label("gpui", "7057ff", "The GPUI port"),
        label("needs-qa", "fbca04", "Waiting for a manual pass"),
        label("bug", "d73a4a", "Something is broken"),
        label("mobile", "0e8a16", "The phone app"),
        label("docs", "0075ca", ""),
    ]
}

/// Who a reviewer can be requested from.
pub fn reviewer_candidates() -> Vec<String> {
    ["marcosgenesis", "jefo3", "reviewer-one", "ana-maria", "the-ptf/desktop", "victor", "cloud-bot"].map(str::to_string).to_vec()
}

/// The fixture PR.
pub fn detail(number: u32, variant: Variant) -> PullRequestDetail {
    detail_at(number, variant, now_ms())
}

pub fn detail_at(number: u32, variant: Variant, now: i64) -> PullRequestDetail {
    let list = files();
    let (additions, deletions) = list.iter().fold((0, 0), |(a, d), (f, _)| (a + f.additions, d + f.deletions));
    let files: Vec<PrFile> = list.into_iter().map(|(f, _)| f).collect();
    let thread = Thread {
        id: "thread-1".to_string(),
        path: files[1].path.clone(),
        line: Some(3),
        side: Side::Right,
        resolved: false,
        outdated: false,
        comments: vec![
            comment("c-t1", "marcosgenesis", REVIEW_BODY, 95, now),
            comment("c-t2", "victor", "Good catch, building it lazily now.", 70, now),
        ],
    };
    let resolved = Thread {
        id: "thread-2".to_string(),
        path: files[2].path.clone(),
        line: Some(2),
        side: Side::Right,
        resolved: true,
        outdated: false,
        comments: vec![comment("c-t3", "jefo3", "Should UNSTABLE merge?", 300, now)],
    };
    let passing = |n: usize| (0..n).map(|i| check(&format!("test shard {}", i + 1), Some("CI"), Outcome::Pass)).collect::<Vec<_>>();
    let mut checks = passing(4);
    checks.push(check("lint", Some("CI"), Outcome::Pass));
    checks.push(check("typecheck", Some("CI"), Outcome::Pass));
    checks.push(check("test-desktop (macOS)", Some("Desktop smoke"), Outcome::Skipped));
    checks.push(check("lighthouse", None, Outcome::Neutral));

    let mut pr = PullRequestDetail {
        number,
        url: format!("{REPO_URL}/{number}"),
        title: "feat(experiments): PR panel and Git actions dialog in the GPUI port".to_string(),
        body: BODY.to_string(),
        state: PullState::Open,
        is_draft: false,
        author: "victor".to_string(),
        created_at: now - 26 * 60 * MINUTE,
        updated_at: now - 125 * MINUTE,
        base_ref_name: "main".to_string(),
        head_ref_name: "milagre/chat-tie0".to_string(),
        additions,
        deletions,
        changed_files: files.len() as u32,
        merge_state_status: "CLEAN".to_string(),
        review_decision: Some(ReviewDecision::Approved),
        auto_merge: None,
        viewer_can_merge_as_admin: false,
        viewer_is_author: false,
        checks,
        reviewers: vec![
            Reviewer::new("marcosgenesis", ReviewerState::Approved),
            Reviewer::new("jefo3", ReviewerState::Commented),
            Reviewer { team: true, ..Reviewer::new("the-ptf/desktop", ReviewerState::Requested) },
        ],
        labels: vec![Label { name: "desktop".into(), color: "1d76db".into() }, Label { name: "gpui".into(), color: "7057ff".into() }],
        files,
        threads: vec![thread, resolved],
        comments: vec![
            comment("c1", "cloud-bot", "Preview deployed: the PR panel snapshot is attached to the run.", 240, now),
            comment(
                "c2",
                "jefo3",
                "Can we show the merge method somewhere other than the menu?\n\nI kept looking for it next to the button.",
                180,
                now,
            ),
            comment("c3", "victor", "It is in the \u{22ef} menu on purpose, like the desktop.", 150, now),
        ],
        pending_review: None,
        local_commits: 1,
    };
    match variant {
        Variant::Ready => {}
        Variant::Pending => {
            pr.merge_state_status = "BLOCKED".to_string();
            pr.review_decision = Some(ReviewDecision::ReviewRequired);
            pr.reviewers = vec![Reviewer::new("marcosgenesis", ReviewerState::Requested), Reviewer::new("jefo3", ReviewerState::Requested)];
            for (i, c) in pr.checks.iter_mut().enumerate() {
                if (2..5).contains(&i) {
                    c.outcome = Outcome::Running;
                }
            }
            pr.threads.clear();
        }
        Variant::Draft => {
            pr.is_draft = true;
            pr.merge_state_status = "DRAFT".to_string();
            pr.review_decision = None;
            pr.reviewers = Vec::new();
            pr.threads.clear();
            pr.comments.truncate(1);
        }
        Variant::Blocked => {
            pr.merge_state_status = "DIRTY".to_string();
            pr.review_decision = Some(ReviewDecision::ChangesRequested);
            pr.viewer_can_merge_as_admin = true;
            pr.reviewers = vec![
                Reviewer::new("marcosgenesis", ReviewerState::ChangesRequested),
                Reviewer { stale: true, ..Reviewer::new("jefo3", ReviewerState::Approved) },
            ];
            pr.checks[0].outcome = Outcome::Fail;
            pr.checks[4].outcome = Outcome::Fail;
        }
        Variant::Merged => {
            pr.state = PullState::Merged;
            pr.merge_state_status = "UNKNOWN".to_string();
            pr.local_commits = 0;
        }
        Variant::Closed => {
            pr.state = PullState::Closed;
            pr.merge_state_status = "UNKNOWN".to_string();
            pr.review_decision = None;
            pr.local_commits = 0;
        }
    }
    pr
}

/// The fixture bridge: answers a PR number with the variant it maps to (or the one the environment names).
pub struct FixtureBridge {
    forced: Option<Variant>,
}

impl FixtureBridge {
    pub fn new() -> Self {
        Self { forced: None }
    }

    /// Always answers `variant`, whatever the number.
    pub fn forced(variant: Variant) -> Self {
        Self { forced: Some(variant) }
    }

    fn variant(&self, number: u32) -> Variant {
        self.forced.unwrap_or_else(|| Variant::for_number(number))
    }
}

impl Default for FixtureBridge {
    fn default() -> Self {
        Self::new()
    }
}

impl PrBridge for FixtureBridge {
    fn detail(&self, number: u32) -> Result<PullRequestDetail, String> {
        Ok(detail(number, self.variant(number)))
    }

    fn write(&self, number: u32, write: &Write) -> Result<(), String> {
        let pr = detail(number, self.variant(number));
        match write {
            Write::Merge { admin: false, auto: None, .. } if !super::model::can_merge_now(&pr) => {
                Err("Pull request is not mergeable: the base branch policy prohibits the merge.".to_string())
            }
            Write::Merge { method: MergeMethod::Rebase, admin: false, auto: None, .. } if pr.merge_state_status == "UNSTABLE" => {
                Err("Rebase merging is not allowed on this repository.".to_string())
            }
            _ => Ok(()),
        }
    }

    fn reviewer_candidates(&self) -> Vec<String> {
        reviewer_candidates()
    }

    fn repo_labels(&self) -> Vec<RepoLabel> {
        repo_labels()
    }

    fn file_patch(&self, _number: u32, file: &PrFile) -> Option<DiffFileResult> {
        files().into_iter().find(|(entry, _)| entry.path == file.path).map(|(_, patch)| DiffFileResult {
            patch,
            binary: false,
            too_large: false,
        })
    }
}

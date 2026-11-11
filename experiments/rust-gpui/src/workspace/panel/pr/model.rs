//! The PR the panel shows and the rules that word it: `PullRequestDetail` and its parts from
//! `packages/shared/src/pull-request-review.ts`, and the pure helpers of `pull-request-review.ts` and
//! `lib/pull-request-view.ts` (`checksSummary`, `checksProgress`, `canMergeNow`, `mergeStatus`, `notInPrLabel`,
//! `openThreads`, `repoOf`, `age`, the merge methods). Panel-local like `changes/data.rs`: `src/data` has no PR
//! detail yet, and the bridge (`bridge.rs`) is the one seam a daemon-backed source replaces.

use crate::logic::diff::git::DiffStatus;
use crate::logic::diff::tree::Counted;
use crate::logic::prompts::parts::quote_markdown;

/// `PullRequestState`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PullState {
    Open,
    Merged,
    Closed,
}

/// `MergeMethod`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MergeMethod {
    Squash,
    Merge,
    Rebase,
}

impl MergeMethod {
    /// `MERGE_METHODS`, in the menu's order.
    pub const ALL: [MergeMethod; 3] = [MergeMethod::Squash, MergeMethod::Merge, MergeMethod::Rebase];

    pub fn key(self) -> &'static str {
        match self {
            MergeMethod::Squash => "squash",
            MergeMethod::Merge => "merge",
            MergeMethod::Rebase => "rebase",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            MergeMethod::Squash => "Squash",
            MergeMethod::Merge => "Merge commit",
            MergeMethod::Rebase => "Rebase",
        }
    }

    /// `MERGE_METHODS[].action`: GitHub's button words.
    pub fn action(self) -> &'static str {
        match self {
            MergeMethod::Squash => "Squash and merge",
            MergeMethod::Merge => "Merge",
            MergeMethod::Rebase => "Rebase and merge",
        }
    }

    pub fn from_key(key: &str) -> Option<MergeMethod> {
        MergeMethod::ALL.into_iter().find(|method| method.key() == key)
    }
}

/// `ReviewEvent`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReviewEvent {
    Comment,
    Approve,
    RequestChanges,
}

impl ReviewEvent {
    pub const ALL: [ReviewEvent; 3] = [ReviewEvent::Comment, ReviewEvent::Approve, ReviewEvent::RequestChanges];

    pub fn key(self) -> &'static str {
        match self {
            ReviewEvent::Comment => "COMMENT",
            ReviewEvent::Approve => "APPROVE",
            ReviewEvent::RequestChanges => "REQUEST_CHANGES",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            ReviewEvent::Comment => "Comment",
            ReviewEvent::Approve => "Approve",
            ReviewEvent::RequestChanges => "Request changes",
        }
    }
}

/// `PullRequestCheck.outcome`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Pass,
    Fail,
    Running,
    Skipped,
    Neutral,
}

impl Outcome {
    /// `CHECK_ORDER`: failing checks first, then the ones still running.
    pub fn order(self) -> u8 {
        match self {
            Outcome::Fail => 0,
            Outcome::Running => 1,
            Outcome::Pass => 2,
            Outcome::Neutral => 3,
            Outcome::Skipped => 4,
        }
    }

    pub fn key(self) -> &'static str {
        match self {
            Outcome::Pass => "pass",
            Outcome::Fail => "fail",
            Outcome::Running => "running",
            Outcome::Skipped => "skipped",
            Outcome::Neutral => "neutral",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Check {
    pub name: String,
    /// The GitHub Actions workflow the job belongs to, when it is one.
    pub workflow: Option<String>,
    pub outcome: Outcome,
    pub url: Option<String>,
}

/// `PullRequestReviewer.state`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReviewerState {
    Approved,
    ChangesRequested,
    Commented,
    /// Asked to review, nothing yet.
    Requested,
    Dismissed,
}

impl ReviewerState {
    /// `REVIEW_STATE[].label`.
    pub fn label(self) -> &'static str {
        match self {
            ReviewerState::Approved => "Approved",
            ReviewerState::ChangesRequested => "Changes requested",
            ReviewerState::Commented => "Commented",
            ReviewerState::Requested => "Review pending",
            ReviewerState::Dismissed => "Dismissed",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Reviewer {
    pub login: String,
    pub state: ReviewerState,
    /// The verdict came before the latest push.
    pub stale: bool,
    /// A requested team: no avatar.
    pub team: bool,
}

impl Reviewer {
    pub fn new(login: &str, state: ReviewerState) -> Self {
        Self { login: login.to_string(), state, stale: false, team: false }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct PrFile {
    pub path: String,
    pub additions: u32,
    pub deletions: u32,
    pub status: DiffStatus,
}

impl Counted for PrFile {
    fn path(&self) -> &str {
        &self.path
    }
    fn added(&self) -> u32 {
        self.additions
    }
    fn removed(&self) -> u32 {
        self.deletions
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Comment {
    pub id: String,
    pub author: String,
    pub body: String,
    /// Milliseconds since the epoch.
    pub created_at: i64,
    /// Part of the viewer's pending review: only they see it until the review is submitted.
    pub pending: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Left,
    Right,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Thread {
    pub id: String,
    pub path: String,
    /// The line in the new file (right) or the old one (left); `None` when the thread is outdated past any line.
    pub line: Option<u32>,
    pub side: Side,
    pub resolved: bool,
    pub outdated: bool,
    pub comments: Vec<Comment>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReviewDecision {
    Approved,
    ChangesRequested,
    ReviewRequired,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Label {
    pub name: String,
    /// GitHub's hex without the `#`.
    pub color: String,
}

/// `RepoLabel`: a label of the PR's repository, for the picker.
#[derive(Clone, Debug, PartialEq)]
pub struct RepoLabel {
    pub name: String,
    pub color: String,
    pub description: String,
}

/// `PullRequestDetail`.
#[derive(Clone, Debug, PartialEq)]
pub struct PullRequestDetail {
    pub number: u32,
    pub url: String,
    pub title: String,
    pub body: String,
    pub state: PullState,
    pub is_draft: bool,
    pub author: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub base_ref_name: String,
    pub head_ref_name: String,
    pub additions: u32,
    pub deletions: u32,
    pub changed_files: u32,
    /// GitHub's merge box state: CLEAN, BLOCKED, BEHIND, DIRTY (conflicts), UNSTABLE, DRAFT, UNKNOWN.
    pub merge_state_status: String,
    pub review_decision: Option<ReviewDecision>,
    pub auto_merge: Option<MergeMethod>,
    pub viewer_can_merge_as_admin: bool,
    pub viewer_is_author: bool,
    pub checks: Vec<Check>,
    pub reviewers: Vec<Reviewer>,
    pub labels: Vec<Label>,
    pub files: Vec<PrFile>,
    pub threads: Vec<Thread>,
    /// Comments on the PR itself, not on a line.
    pub comments: Vec<Comment>,
    /// The viewer's draft review: how many comments it holds.
    pub pending_review: Option<u32>,
    /// Commits on the Chat's folder that an open PR doesn't have yet.
    pub local_commits: u32,
}

fn plural(count: usize, word: &str) -> String {
    format!("{count} {word}{}", if count == 1 { "" } else { "s" })
}

fn count(checks: &[Check], outcomes: &[Outcome]) -> usize {
    checks.iter().filter(|check| outcomes.contains(&check.outcome)).count()
}

/// `checksSummary`: "23 passed · 3 skipped", failures and running checks first; empty when the PR has none.
pub fn checks_summary(checks: &[Check]) -> String {
    let parts = [
        (count(checks, &[Outcome::Fail]), "failing"),
        (count(checks, &[Outcome::Running]), "running"),
        (count(checks, &[Outcome::Pass, Outcome::Neutral]), "passed"),
        (count(checks, &[Outcome::Skipped]), "skipped"),
    ];
    parts.iter().filter(|(n, _)| *n > 0).map(|(n, word)| format!("{n} {word}")).collect::<Vec<_>>().join(" \u{b7} ")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChecksTone {
    Pass,
    Fail,
    Running,
    None,
}

/// What `checksProgress` returns: counts for the split bar and the words beside it.
#[derive(Clone, Debug, PartialEq)]
pub struct ChecksProgress {
    pub passed: usize,
    pub failed: usize,
    pub running: usize,
    pub skipped: usize,
    pub total: usize,
    pub label: String,
    pub tone: ChecksTone,
}

/// `checksProgress`: failures first ("2 of 25 failing"), then running ("13 of 18 done"), then the summary.
pub fn checks_progress(checks: &[Check]) -> ChecksProgress {
    let (passed, failed, running, skipped) = (
        count(checks, &[Outcome::Pass, Outcome::Neutral]),
        count(checks, &[Outcome::Fail]),
        count(checks, &[Outcome::Running]),
        count(checks, &[Outcome::Skipped]),
    );
    let total = checks.len();
    let (label, tone) = if total == 0 {
        (String::new(), ChecksTone::None)
    } else if failed > 0 {
        (format!("{failed} of {total} failing"), ChecksTone::Fail)
    } else if running > 0 {
        (format!("{} of {total} done", total - running), ChecksTone::Running)
    } else {
        (checks_summary(checks), ChecksTone::Pass)
    };
    ChecksProgress { passed, failed, running, skipped, total, label, tone }
}

/// `openThreads`: unresolved threads with a comment that is not pending.
pub fn open_threads(pr: &PullRequestDetail) -> Vec<&Thread> {
    pr.threads.iter().filter(|thread| !thread.resolved && thread.comments.iter().any(|comment| !comment.pending)).collect()
}

/// `canMergeNow`: whether "Merge" merges now; otherwise the client offers auto-merge (or merging anyway).
pub fn can_merge_now(pr: &PullRequestDetail) -> bool {
    pr.state == PullState::Open && !pr.is_draft && matches!(pr.merge_state_status.as_str(), "CLEAN" | "UNSTABLE" | "HAS_HOOKS")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StatusTone {
    Ready,
    Blocked,
    Pending,
    Merged,
    Closed,
    Draft,
}

/// `MergeStatus`.
#[derive(Clone, Debug, PartialEq)]
pub struct MergeStatus {
    pub tone: StatusTone,
    pub title: &'static str,
    pub detail: String,
}

/// `mergeStatus`: the merge box's words, the same on desktop, phone and iPad.
pub fn merge_status(pr: &PullRequestDetail) -> MergeStatus {
    let status = |tone, title, detail: String| MergeStatus { tone, title, detail };
    match pr.state {
        PullState::Merged => return status(StatusTone::Merged, "Merged", format!("Merged into {}", pr.base_ref_name)),
        PullState::Closed => return status(StatusTone::Closed, "Closed", "Closed without merging".to_string()),
        PullState::Open => {}
    }
    if pr.is_draft {
        return status(StatusTone::Draft, "Draft", "Mark it ready for review before merging".to_string());
    }
    let failing = count(&pr.checks, &[Outcome::Fail]);
    let approvals = pr.reviewers.iter().filter(|r| r.state == ReviewerState::Approved && !r.stale).count();
    if pr.merge_state_status == "DIRTY" {
        return status(StatusTone::Blocked, "Conflicts", format!("This branch conflicts with {}", pr.base_ref_name));
    }
    if failing > 0 {
        return status(StatusTone::Blocked, "Checks failing", format!("{} failed of {}", plural(failing, "check"), pr.checks.len()));
    }
    if pr.review_decision == Some(ReviewDecision::ChangesRequested) {
        let who = pr.reviewers.iter().find(|r| r.state == ReviewerState::ChangesRequested).map(|r| r.login.as_str());
        let detail = who.map_or_else(|| "A reviewer asked for changes".to_string(), |who| format!("{who} asked for changes"));
        return status(StatusTone::Blocked, "Changes requested", detail);
    }
    if pr.merge_state_status == "BEHIND" {
        return status(StatusTone::Blocked, "Behind", format!("Update the branch with {} to merge", pr.base_ref_name));
    }
    if count(&pr.checks, &[Outcome::Running]) > 0 {
        return status(StatusTone::Pending, "Checks running", checks_summary(&pr.checks));
    }
    if can_merge_now(pr) {
        let mut parts = Vec::new();
        if !pr.checks.is_empty() {
            parts.push("Checks passed".to_string());
        }
        if approvals > 0 {
            parts.push(plural(approvals, "approval"));
        }
        parts.push("no conflicts".to_string());
        return status(StatusTone::Ready, "Ready to merge", parts.join(" \u{b7} "));
    }
    if pr.review_decision == Some(ReviewDecision::ReviewRequired) {
        return status(StatusTone::Pending, "Waiting for review", "A review is required before merging".to_string());
    }
    if pr.merge_state_status == "BLOCKED" {
        return status(StatusTone::Blocked, "Blocked", "A branch rule blocks merging".to_string());
    }
    status(StatusTone::Pending, "Checking", "GitHub is checking if it can merge".to_string())
}

/// `notInPrLabel`: "2 files · 1 commit", the Worktree's work an open PR doesn't have yet; empty when none.
pub fn not_in_pr_label(files: usize, commits: usize) -> String {
    let part = |n: usize, one: &str| if n > 0 { plural(n, one) } else { String::new() };
    [part(files, "file"), part(commits, "commit")].into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join(" \u{b7} ")
}

/// `repoOf`: "owner/name" from a PR address.
pub fn repo_of(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://")?;
    let mut parts = rest.split('/');
    let (_host, owner, name, pull, number) = (parts.next()?, parts.next()?, parts.next()?, parts.next()?, parts.next()?);
    let digits = number.bytes().take_while(u8::is_ascii_digit).count();
    (!owner.is_empty() && !name.is_empty() && pull == "pull" && digits > 0).then(|| format!("{owner}/{name}"))
}

/// `age`: a relative age like "2h" for a timestamp; "now" under a minute, `None` for no timestamp.
pub fn age(at: i64, now: i64) -> Option<String> {
    if at <= 0 {
        return None;
    }
    let minutes = ((now - at).max(0) as f64 / 60_000.0).round() as i64;
    Some(if minutes < 1 {
        "now".to_string()
    } else if minutes < 60 {
        format!("{minutes}m")
    } else {
        let hours = (minutes as f64 / 60.0).round() as i64;
        if hours < 24 { format!("{hours}h") } else { format!("{}d", (hours as f64 / 24.0).round() as i64) }
    })
}

/// The panel's `ago`: "just now", "2h ago".
pub fn ago(at: i64, now: i64) -> String {
    match age(at, now).as_deref() {
        Some("now") => "just now".to_string(),
        Some(text) => format!("{text} ago"),
        None => String::new(),
    }
}

/// A login's initials (`initials` in `pr/Properties.tsx`): the first letters of its first two words
/// ("reviewer-one" is RO); a one-word login takes its first letter.
pub fn initials(login: &str) -> String {
    let words: Vec<&str> = login.split(['-', '_', '.', ' ']).filter(|w| !w.is_empty()).collect();
    let first = |word: &str| word.chars().next().map(|c| c.to_uppercase().to_string()).unwrap_or_default();
    match words.as_slice() {
        [a, b, ..] => format!("{}{}", first(a), first(b)),
        _ => first(login),
    }
}

/// `threadState`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThreadState {
    Pending,
    Resolved,
    Outdated,
    Open,
}

impl ThreadState {
    pub fn label(self) -> &'static str {
        match self {
            ThreadState::Open => "Open",
            ThreadState::Resolved => "Resolved",
            ThreadState::Outdated => "Outdated",
            ThreadState::Pending => "Pending",
        }
    }
}

pub fn thread_state(thread: &Thread) -> ThreadState {
    if thread.comments.iter().all(|comment| comment.pending) {
        ThreadState::Pending
    } else if thread.resolved {
        ThreadState::Resolved
    } else if thread.outdated {
        ThreadState::Outdated
    } else {
        ThreadState::Open
    }
}

/// `threadFixMessage`: what "Fix in Chat" sends for a thread.
pub fn thread_fix_message(number: u32, thread: &Thread) -> String {
    let place = match thread.line {
        Some(line) => format!("{}:{line}", thread.path),
        None => thread.path.clone(),
    };
    let comments: Vec<String> =
        thread.comments.iter().filter(|c| !c.pending).map(|c| format!("{} wrote:\n{}", c.author, quote_markdown(&c.body))).collect();
    format!(
        "Address this review thread on PR #{number}, at {place}:\n\n{}\n\nMake the change, push it, and tell me what you did so I can reply and resolve the thread.",
        comments.join("\n\n")
    )
}

/// Now, in milliseconds since the epoch.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

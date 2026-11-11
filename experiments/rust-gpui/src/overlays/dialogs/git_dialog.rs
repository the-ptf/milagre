//! After `apps/desktop/app/src/lib/git-dialog.ts`: what the "Commit and open PR" dialog shows and which steps its
//! buttons run, from what git and gh report about the Chat's folder (`electron/git-actions.cjs`).
//!
//! Not ported here: `testCommandsFrom` and `gitChatContext` (they read a Chat's messages to feed the text
//! generator), and `isGitNote` (it tells the dialog's notes from replies in the transcript); the generator is a
//! fixture in `git_actions.rs`.

use crate::logic::diff::codes::{GitCode, git_message};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GitFileStatus {
    Added,
    Modified,
    Deleted,
}

#[derive(Clone, Debug, PartialEq)]
pub struct GitFileChange {
    pub path: String,
    pub status: GitFileStatus,
    pub added: u32,
    pub removed: u32,
    /// Looks like a secret (.env, a key, credentials): never committed from the dialog.
    pub secret: bool,
}

/// The branch's open PR.
#[derive(Clone, Debug, PartialEq)]
pub struct GitPullRequest {
    pub number: Option<u32>,
    pub url: String,
}

/// `GitChanges` when the folder is a repository.
#[derive(Clone, Debug, PartialEq)]
pub struct RepoChanges {
    /// `None` when HEAD is detached.
    pub branch: Option<String>,
    /// The branch a PR goes into.
    pub base: String,
    /// Staged, unstaged and untracked files.
    pub files: Vec<GitFileChange>,
    pub has_changes: bool,
    /// Commits the remote does not have.
    pub unpushed: u32,
    /// Commits on the branch that its base does not have.
    pub ahead: u32,
    pub has_origin: bool,
    /// How many remotes the repo has; with more than one, the dialog says where PRs open.
    pub remotes: u32,
    /// gh's default repo, where PRs open, when there are several remotes and one is set.
    pub pr_repo: Option<String>,
    pub on_base: bool,
    /// Why nothing may be committed now: a merge, rebase, cherry-pick or revert, or conflicts.
    pub commit_blocked: Option<String>,
    pub gh_ready: bool,
    pub gh_message: Option<String>,
    pub pr: Option<GitPullRequest>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum GitChanges {
    NotRepo { message: Option<String> },
    Repo(RepoChanges),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GitStep {
    Commit,
    Push,
    Pr,
}

impl GitStep {
    pub fn key(self) -> &'static str {
        match self {
            GitStep::Commit => "commit",
            GitStep::Push => "push",
            GitStep::Pr => "pr",
        }
    }

    /// `STEP_COPY[step].running`.
    pub fn running(self) -> &'static str {
        match self {
            GitStep::Commit => "Committing\u{2026}",
            GitStep::Push => "Pushing\u{2026}",
            GitStep::Pr => "Opening PR\u{2026}",
        }
    }

    /// `STEP_COPY[step].failed`.
    pub fn failed(self) -> &'static str {
        match self {
            GitStep::Commit => "Commit failed",
            GitStep::Push => "Push failed",
            GitStep::Pr => "Couldn't open the PR",
        }
    }
}

/// `TURN_RUNNING`.
pub const TURN_RUNNING: &str = "The agent is still working. Wait for the turn to end or stop it.";

pub fn no_origin() -> String {
    git_message(GitCode::NoOrigin, None)
}

pub fn detached_commit() -> String {
    git_message(GitCode::DetachedCommit, None)
}

pub fn gh_missing() -> String {
    git_message(GitCode::GhMissing, None)
}

/// `DialogModeInput`.
#[derive(Clone, Debug, PartialEq)]
pub struct DialogModeInput {
    pub has_changes: bool,
    pub unpushed: u32,
    pub pr_open: bool,
    pub on_base: bool,
    pub has_origin: bool,
    pub gh_ready: bool,
    /// Commits on the branch its base does not have: an already pushed branch can still get its PR.
    pub ahead: u32,
    /// The base branch's name, for the reason a PR cannot be opened from it.
    pub base: String,
    /// Why gh cannot open a PR, when it is not ready.
    pub gh_message: Option<String>,
    pub detached: bool,
    /// Why git will not take a commit now (a merge in progress, say).
    pub commit_blocked: Option<String>,
    /// The Chat's agent is mid-turn and may still be editing.
    pub turn_running: bool,
}

impl Default for DialogModeInput {
    fn default() -> Self {
        Self {
            has_changes: false,
            unpushed: 0,
            pr_open: false,
            on_base: false,
            has_origin: true,
            gh_ready: true,
            ahead: 0,
            base: "main".to_string(),
            gh_message: None,
            detached: false,
            commit_blocked: None,
            turn_running: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct DialogButton {
    pub label: String,
    pub steps: Vec<GitStep>,
    /// Shown beside a disabled button.
    pub disabled_reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DialogMode {
    /// The commit message field; hidden when there is nothing to commit.
    pub show_commit: bool,
    /// The PR title and body fields; shown when the primary button opens a PR.
    pub show_pr_fields: bool,
    /// The branch's PR is open, so pushing updates it.
    pub pr_open: bool,
    /// Why no PR can be opened, shown in the PR section.
    pub pr_blocked: Option<String>,
    pub primary: Option<DialogButton>,
    pub secondary: Option<DialogButton>,
    /// Shown when there is nothing to do.
    pub idle: Option<String>,
}

/// `dialogMode`: the dialog's sections and buttons for a folder's state. A button that commits is disabled
/// mid-merge (or rebase, cherry-pick, revert), on a detached HEAD and while the agent's turn runs; one that pushes
/// is disabled without origin. On the base branch nothing reaches the remote in one click: "Commit only" is the
/// primary button.
pub fn dialog_mode(input: &DialogModeInput) -> DialogMode {
    let DialogModeInput {
        has_changes,
        unpushed,
        pr_open,
        on_base,
        has_origin,
        gh_ready,
        ahead,
        base,
        gh_message,
        detached,
        commit_blocked,
        turn_running,
    } = input.clone();
    let push_blocked = if !has_origin {
        Some(no_origin())
    } else if detached {
        Some(git_message(GitCode::Detached, None))
    } else {
        None
    };
    let commit_reason = commit_blocked
        .filter(|reason| !reason.is_empty())
        .or_else(|| detached.then(detached_commit))
        .or_else(|| turn_running.then(|| TURN_RUNNING.to_string()));
    let pr_blocked = if pr_open {
        None
    } else {
        push_blocked.clone().or_else(|| {
            if on_base {
                Some(format!("You're on {base}. Open a PR from a worktree branch."))
            } else if !gh_ready {
                Some(gh_message.filter(|m| !m.is_empty()).unwrap_or_else(gh_missing))
            } else {
                None
            }
        })
    };
    let can_pr = !pr_open && pr_blocked.is_none();
    let button = |label: String, steps: Vec<GitStep>| {
        let disabled_reason = steps
            .contains(&GitStep::Commit)
            .then(|| commit_reason.clone())
            .flatten()
            .or_else(|| steps.contains(&GitStep::Push).then(|| push_blocked.clone()).flatten());
        DialogButton { label, steps, disabled_reason }
    };
    let (mut primary, mut secondary) = (None, None);
    if has_changes && on_base {
        primary = Some(button("Commit only".into(), vec![GitStep::Commit]));
        secondary = Some(button(format!("Commit and push to {base}"), vec![GitStep::Commit, GitStep::Push]));
    } else if has_changes {
        primary = Some(if can_pr {
            button("Commit, push and open PR".into(), vec![GitStep::Commit, GitStep::Push, GitStep::Pr])
        } else {
            button("Commit and push".into(), vec![GitStep::Commit, GitStep::Push])
        });
        secondary = Some(button("Commit only".into(), vec![GitStep::Commit]));
    } else if unpushed > 0 {
        primary = Some(if on_base {
            button(format!("Push to {base}"), vec![GitStep::Push])
        } else if can_pr {
            button("Push and open PR".into(), vec![GitStep::Push, GitStep::Pr])
        } else {
            button("Push".into(), vec![GitStep::Push])
        });
    } else if can_pr && ahead > 0 {
        primary = Some(button("Open PR".into(), vec![GitStep::Pr]));
    }
    let idle = if primary.is_some() {
        None
    } else if pr_open {
        Some("Everything is committed and pushed.".to_string())
    } else {
        Some("Nothing to commit or push.".to_string())
    };
    DialogMode {
        show_commit: has_changes,
        show_pr_fields: primary.as_ref().is_some_and(|button| button.steps.contains(&GitStep::Pr)),
        pr_open,
        pr_blocked,
        primary,
        secondary,
        idle,
    }
}

/// `prTargetLine`: where PRs open, for a repo with several remotes; `None` with one.
pub fn pr_target_line(remotes: u32, pr_repo: Option<&str>) -> Option<String> {
    if remotes <= 1 {
        return None;
    }
    Some(match pr_repo {
        Some(repo) => format!("PRs open against {repo}."),
        None => "This repo has several remotes. Run `gh repo set-default` in a terminal to choose where PRs open.".to_string(),
    })
}

/// `hookFailureMessage`: what "Send to agent" sends after a hook stops the commit.
pub fn hook_failure_message(output: &str) -> String {
    format!("The commit failed in a git hook. Fix what it reports, but don't commit or push. I'll do that from Milagre.\n\n{output}")
}

/// `GitRunResult.pr`.
#[derive(Clone, Debug, PartialEq)]
pub struct RunPr {
    pub url: String,
    pub number: Option<u32>,
    pub created: bool,
}

/// `GitRunResult`: what the steps did.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct GitRunResult {
    pub short_sha: Option<String>,
    pub pushed_branch: Option<String>,
    pub pr: Option<RunPr>,
}

fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    chars.next().map(|c| c.to_uppercase().chain(chars).collect()).unwrap_or_default()
}

/// `gitRunNote`: the line saved in the Chat after the dialog's steps, e.g. "Committed abc1234 and opened PR #12:
/// <link>". `None` when nothing happened.
pub fn git_run_note(result: &GitRunResult) -> Option<String> {
    let pr_name = result.pr.as_ref().and_then(|pr| pr.number).map_or_else(|| "the PR".to_string(), |n| format!("PR #{n}"));
    let mut done = Vec::new();
    if let Some(sha) = &result.short_sha {
        done.push(format!("committed {sha}"));
    }
    if let Some(branch) = &result.pushed_branch {
        done.push(format!("pushed {branch}"));
    }
    if result.pr.as_ref().is_some_and(|pr| pr.created) {
        done.push(format!("opened {pr_name}"));
    }
    let first = done.first()?.clone();
    let list = if done.len() > 1 { format!("{} and {}", done[..done.len() - 1].join(", "), done[done.len() - 1]) } else { first };
    match &result.pr {
        Some(pr) if pr.created => Some(format!("{}: {}", capitalize(&list), pr.url)),
        // A push to a branch with an open PR updates it.
        Some(pr) if result.pushed_branch.is_some() => {
            Some(format!("{}. {} is updated: {}", capitalize(&list), capitalize(&pr_name), pr.url))
        }
        _ => Some(format!("{}.", capitalize(&list))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready() -> DialogModeInput {
        DialogModeInput { has_changes: true, ..Default::default() }
    }

    fn button(label: &str, steps: &[GitStep], reason: Option<&str>) -> DialogButton {
        DialogButton { label: label.to_string(), steps: steps.to_vec(), disabled_reason: reason.map(str::to_string) }
    }

    use GitStep::{Commit, Pr, Push};

    #[test]
    fn changes_on_a_worktree_branch_commit_push_and_open_a_pr() {
        let mode = dialog_mode(&ready());
        assert!(mode.show_commit && mode.show_pr_fields && !mode.pr_open);
        assert_eq!(mode.pr_blocked, None);
        assert_eq!(mode.primary, Some(button("Commit, push and open PR", &[Commit, Push, Pr], None)));
        assert_eq!(mode.secondary, Some(button("Commit only", &[Commit], None)));
        assert_eq!(mode.idle, None);
    }

    #[test]
    fn with_an_open_pr_the_dialog_commits_and_pushes_which_updates_it() {
        let mode = dialog_mode(&DialogModeInput { pr_open: true, ..ready() });
        assert!(!mode.show_pr_fields && mode.pr_open);
        assert_eq!(mode.primary, Some(button("Commit and push", &[Commit, Push], None)));
        assert_eq!(mode.secondary.map(|b| b.label), Some("Commit only".to_string()));
        let push_only = dialog_mode(&DialogModeInput { pr_open: true, has_changes: false, unpushed: 2, ..ready() });
        assert!(!push_only.show_commit);
        assert_eq!(push_only.primary, Some(button("Push", &[Push], None)));
        assert_eq!(push_only.secondary, None);
    }

    #[test]
    fn unpushed_commits_push_and_open_a_pr_with_no_commit_field() {
        let mode = dialog_mode(&DialogModeInput { has_changes: false, unpushed: 1, ahead: 1, ..ready() });
        assert!(!mode.show_commit && mode.show_pr_fields);
        assert_eq!(mode.primary, Some(button("Push and open PR", &[Push, Pr], None)));
        assert_eq!(mode.secondary, None);
    }

    #[test]
    fn a_pushed_branch_without_a_pr_can_still_open_one() {
        let open = dialog_mode(&DialogModeInput { has_changes: false, ahead: 3, ..ready() });
        assert_eq!(open.primary, Some(button("Open PR", &[Pr], None)));
        let idle = dialog_mode(&DialogModeInput { has_changes: false, ..ready() });
        assert_eq!(idle.primary, None);
        assert_eq!(idle.idle.as_deref(), Some("Nothing to commit or push."));
        let done = dialog_mode(&DialogModeInput { has_changes: false, pr_open: true, ..ready() });
        assert_eq!(done.idle.as_deref(), Some("Everything is committed and pushed."));
    }

    #[test]
    fn on_the_base_branch_committing_is_primary_and_nothing_reaches_the_remote_in_one_click() {
        let mode = dialog_mode(&DialogModeInput { on_base: true, ..ready() });
        assert_eq!(mode.pr_blocked.as_deref(), Some("You're on main. Open a PR from a worktree branch."));
        assert!(!mode.show_pr_fields);
        assert_eq!(mode.primary, Some(button("Commit only", &[Commit], None)));
        assert_eq!(mode.secondary, Some(button("Commit and push to main", &[Commit, Push], None)));
        let push = dialog_mode(&DialogModeInput { on_base: true, base: "trunk".into(), has_changes: false, unpushed: 1, ..ready() });
        assert_eq!(push.primary, Some(button("Push to trunk", &[Push], None)));
        let no_origin = dialog_mode(&DialogModeInput { on_base: true, has_origin: false, ..ready() });
        assert_eq!(no_origin.primary.and_then(|b| b.disabled_reason), None);
        assert_eq!(no_origin.secondary.and_then(|b| b.disabled_reason), Some(super::no_origin()));
    }

    #[test]
    fn mid_merge_both_commit_buttons_are_disabled_with_gits_state_as_the_reason() {
        let reason = "A merge is in progress. Finish or abort it, then commit.";
        let mode = dialog_mode(&DialogModeInput { commit_blocked: Some(reason.into()), ..ready() });
        assert_eq!(mode.primary.and_then(|b| b.disabled_reason).as_deref(), Some(reason));
        assert_eq!(mode.secondary.and_then(|b| b.disabled_reason).as_deref(), Some(reason));
        let base = dialog_mode(&DialogModeInput { on_base: true, commit_blocked: Some(reason.into()), ..ready() });
        assert_eq!(base.primary.and_then(|b| b.disabled_reason).as_deref(), Some(reason));
        assert_eq!(base.secondary.and_then(|b| b.disabled_reason).as_deref(), Some(reason));
    }

    #[test]
    fn on_a_detached_head_neither_commit_button_works() {
        let mode = dialog_mode(&DialogModeInput { detached: true, ..ready() });
        assert_eq!(mode.primary.and_then(|b| b.disabled_reason), Some(detached_commit()));
        assert_eq!(mode.secondary.and_then(|b| b.disabled_reason), Some(detached_commit()));
    }

    #[test]
    fn while_the_agents_turn_runs_committing_waits_but_pushing_and_opening_a_pr_do_not() {
        let mode = dialog_mode(&DialogModeInput { turn_running: true, ..ready() });
        assert_eq!(mode.primary.and_then(|b| b.disabled_reason).as_deref(), Some(TURN_RUNNING));
        assert_eq!(mode.secondary.and_then(|b| b.disabled_reason).as_deref(), Some(TURN_RUNNING));
        let push = dialog_mode(&DialogModeInput { turn_running: true, has_changes: false, unpushed: 1, ..ready() });
        assert_eq!(push.primary, Some(button("Push and open PR", &[Push, Pr], None)));
        let open = dialog_mode(&DialogModeInput { turn_running: true, has_changes: false, ahead: 1, ..ready() });
        assert_eq!(open.primary, Some(button("Open PR", &[Pr], None)));
    }

    #[test]
    fn pr_target_line_speaks_only_with_several_remotes() {
        assert_eq!(pr_target_line(1, None), None);
        assert_eq!(pr_target_line(2, Some("acme/shop")).as_deref(), Some("PRs open against acme/shop."));
        assert!(pr_target_line(3, None).unwrap().contains("gh repo set-default"));
    }

    #[test]
    fn without_origin_push_and_pr_are_disabled_and_only_the_commit_runs() {
        let mode = dialog_mode(&DialogModeInput { has_origin: false, gh_ready: false, ..ready() });
        assert_eq!(mode.pr_blocked, Some(no_origin()));
        assert_eq!(mode.primary, Some(button("Commit and push", &[Commit, Push], Some(&no_origin()))));
        assert_eq!(mode.secondary, Some(button("Commit only", &[Commit], None)));
        let push = dialog_mode(&DialogModeInput { has_origin: false, has_changes: false, unpushed: 1, ..ready() });
        assert_eq!(push.primary.and_then(|b| b.disabled_reason), Some(no_origin()));
    }

    #[test]
    fn when_gh_cannot_open_prs_the_dialog_says_why_and_still_commits_and_pushes() {
        let missing = dialog_mode(&DialogModeInput { gh_ready: false, gh_message: Some(gh_missing()), ..ready() });
        assert_eq!(missing.pr_blocked, Some(gh_missing()));
        assert!(!missing.show_pr_fields);
        assert_eq!(missing.primary, Some(button("Commit and push", &[Commit, Push], None)));
        let auth =
            dialog_mode(&DialogModeInput { gh_ready: false, gh_message: Some("Run `gh auth login` in a terminal.".into()), ..ready() });
        assert_eq!(auth.pr_blocked.as_deref(), Some("Run `gh auth login` in a terminal."));
    }

    #[test]
    fn hook_failure_message_asks_the_agent_to_fix_and_leave_committing_to_milagre() {
        assert_eq!(
            hook_failure_message("lint: missing semicolon"),
            "The commit failed in a git hook. Fix what it reports, but don't commit or push. I'll do that from Milagre.\n\nlint: missing semicolon"
        );
    }

    #[test]
    fn git_run_note_records_what_the_dialog_did() {
        let url = "https://github.com/example/shop/pull/12";
        let pr = |created| Some(RunPr { url: url.into(), number: Some(12), created });
        let sha = || Some("abc1234".to_string());
        let branch = || Some("milagre/cart".to_string());
        let note = |short_sha, pushed_branch, pr| git_run_note(&GitRunResult { short_sha, pushed_branch, pr });
        assert_eq!(note(sha(), branch(), pr(true)).unwrap(), format!("Committed abc1234, pushed milagre/cart and opened PR #12: {url}"));
        assert_eq!(
            note(sha(), branch(), pr(false)).unwrap(),
            format!("Committed abc1234 and pushed milagre/cart. PR #12 is updated: {url}")
        );
        assert_eq!(note(sha(), None, None).unwrap(), "Committed abc1234.");
        assert_eq!(note(None, branch(), pr(true)).unwrap(), format!("Pushed milagre/cart and opened PR #12: {url}"));
        let unnumbered = Some(RunPr { url: url.into(), number: None, created: true });
        assert_eq!(note(None, None, unnumbered).unwrap(), format!("Opened the PR: {url}"));
        assert_eq!(note(None, None, None), None);
    }
}

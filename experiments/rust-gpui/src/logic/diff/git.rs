//! `git-diff.ts`: the shapes of `git:diff-files`, `git:diff-file` and `git:history` replies, and the labels and
//! picker entries built from them.

use super::is_js_space;
use super::tree::Counted;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiffMode {
    Uncommitted,
    Committed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiffStatus {
    Added,
    Deleted,
    Modified,
    Renamed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffFileEntry {
    /// The new path, relative to the chat's folder.
    pub path: String,
    /// Renames only.
    pub old_path: Option<String>,
    pub status: DiffStatus,
    pub added: u32,
    pub removed: u32,
    pub binary: bool,
    pub untracked: bool,
}

impl Counted for DiffFileEntry {
    fn path(&self) -> &str {
        &self.path
    }
    fn added(&self) -> u32 {
        self.added
    }
    fn removed(&self) -> u32 {
        self.removed
    }
}

/// `commit`, `commit_parent` (`Some(None)` is a root commit, `None` unknown), `truncated` and `message` as the host
/// sends them. `base` is the branch `committed` compares with, none for `uncommitted` or when there is none.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DiffFilesRepo {
    pub commit: Option<String>,
    pub commit_parent: Option<Option<String>>,
    pub truncated: bool,
    pub base: Option<String>,
    pub files: Vec<DiffFileEntry>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiffFilesResult {
    NotRepo { message: String },
    Repo(DiffFilesRepo),
}

/// `patch` is empty when the file is binary or `too_large` (over 1 MB).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DiffFileResult {
    pub patch: String,
    pub binary: bool,
    pub too_large: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatsUnavailable {
    Timeout,
    TooLarge,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommitStats {
    Counts { files: u32, added: u32, removed: u32 },
    Unavailable(StatsUnavailable),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitCommit {
    pub sha: String,
    pub author: String,
    pub email: String,
    pub date: String,
    pub message: String,
    pub stats: CommitStats,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitBranch {
    /// A full ref such as `refs/heads/main` or `refs/remotes/origin/main`.
    pub git_ref: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitBranchCatalog {
    pub version: String,
    pub branches: Vec<GitBranch>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutomaticBase {
    pub name: String,
    pub git_ref: Option<String>,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectDefault {
    pub name: String,
    pub git_ref: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GitHistoryRepo {
    pub branch: Option<String>,
    pub base: Option<String>,
    pub comparison_ref: Option<String>,
    pub head: Option<String>,
    pub total: Option<u32>,
    pub automatic: Option<AutomaticBase>,
    pub project_default: Option<ProjectDefault>,
    pub suggested: Option<String>,
    /// `None` when the caller already has `branches_version`.
    pub branches: Option<Vec<GitBranch>>,
    pub branches_version: Option<String>,
    /// Checked live, independently of the cached catalogue.
    pub base_missing: Option<bool>,
    pub commits: Vec<GitCommit>,
    pub has_more: bool,
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitHistory {
    NotRepo { message: String },
    Repo(Box<GitHistoryRepo>),
}

/// Older desktop hosts can reject this optional read while still serving file diffs.
pub fn is_git_history_unavailable(message: &str) -> bool {
    if message == "Command is not available from mobile" {
        return true;
    }
    // /Unknown command: git:history(?:[. ]|$)/
    const NEEDLE: &str = "Unknown command: git:history";
    message.match_indices(NEEDLE).any(|(at, _)| match message[at + NEEDLE.len()..].chars().next() {
        None => true,
        Some(c) => c == '.' || c == ' ',
    })
}

/// One entry of the comparison picker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComparisonOption {
    pub value: String,
    pub label: String,
    pub description: Option<String>,
    pub disabled: bool,
    pub remote: bool,
    pub group: String,
}

/// `^refs\/remotes\/([^/]+)\/(.+)$`: the remote's name. `.` does not match a line terminator.
fn remote_name(git_ref: &str) -> Option<&str> {
    let rest = git_ref.strip_prefix("refs/remotes/")?;
    let (remote, branch) = rest.split_once('/')?;
    let line_end = |c: char| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}');
    (!remote.is_empty() && !branch.is_empty() && !branch.contains(line_end)).then_some(remote)
}

/// Platform-neutral picker entries keep desktop and phone grouping and copy aligned.
///
/// The "current" branch test compares against `refs/heads/${data?.branch}`, which the TS builds with a template
/// string: with no branch (detached, or no data) it compares with `refs/heads/null` / `refs/heads/undefined`, so
/// a branch literally named `null` would be marked current. Ported as is.
pub fn comparison_options(data: Option<&GitHistoryRepo>) -> Vec<ComparisonOption> {
    let current_ref = match data {
        None => "refs/heads/undefined".to_string(),
        Some(d) => format!("refs/heads/{}", d.branch.as_deref().unwrap_or("null")),
    };
    let suggested = data.and_then(|d| d.suggested.as_deref());
    let branch_options: Vec<ComparisonOption> = data
        .and_then(|d| d.branches.as_deref())
        .unwrap_or(&[])
        .iter()
        .map(|branch| {
            let remote = remote_name(&branch.git_ref);
            let is_current = branch.git_ref == current_ref;
            ComparisonOption {
                value: branch.git_ref.clone(),
                label: branch.name.clone(),
                description: is_current.then(|| "current".to_string()),
                disabled: is_current,
                remote: remote.is_some(),
                group: if Some(branch.git_ref.as_str()) == suggested {
                    "Suggested".to_string()
                } else if let Some(name) = remote {
                    format!("Remote · {name}")
                } else {
                    "Local".to_string()
                },
            }
        })
        .collect();
    let description = match data {
        Some(d) if d.automatic.is_some() => {
            let automatic = d.automatic.as_ref().expect("checked");
            format!("{}, {}", automatic.name, automatic.reason)
        }
        Some(d) if d.base.as_deref().is_some_and(|b| !b.is_empty()) => format!("{}, the automatic base", d.base.as_deref().unwrap_or("")),
        _ => "Recorded base or project default".to_string(),
    };
    let mut out = vec![ComparisonOption {
        value: String::new(),
        label: "Automatic".to_string(),
        description: Some(description),
        disabled: false,
        remote: false,
        group: String::new(),
    }];
    out.extend(branch_options.iter().filter(|o| o.group == "Suggested").cloned());
    out.extend(branch_options.iter().filter(|o| o.group == "Local").cloned());
    out.extend(branch_options.iter().filter(|o| o.remote && o.group != "Suggested").cloned());
    out
}

/// `refs/heads/main` and `refs/remotes/origin/main` to `main` and `origin/main`.
pub fn branch_name(git_ref: &str) -> &str {
    git_ref.strip_prefix("refs/heads/").or_else(|| git_ref.strip_prefix("refs/remotes/")).unwrap_or(git_ref)
}

/// Up to two initials of an author's name, uppercased; "?" for an empty name.
pub fn commit_initials(author: &str) -> String {
    let initials: String = author
        .trim_matches(is_js_space)
        .split(is_js_space)
        .filter(|word| !word.is_empty())
        .filter_map(|word| word.chars().next())
        .take(2)
        .collect::<String>()
        .to_uppercase();
    if initials.is_empty() { "?".to_string() } else { initials }
}

/// Never reuse a catalogue from a different response version. Callers also scope it by host and folder.
pub fn with_history_branches(data: GitHistory, catalog: Option<&GitBranchCatalog>) -> GitHistory {
    match data {
        GitHistory::Repo(mut repo) if repo.branches.is_none() => {
            repo.branches = Some(match catalog {
                Some(c) if repo.branches_version.as_deref() == Some(c.version.as_str()) => c.branches.clone(),
                _ => Vec::new(),
            });
            GitHistory::Repo(repo)
        }
        other => other,
    }
}

/// Whether the selected comparison base no longer exists. A live `base_missing` wins over the cached catalogue.
pub fn comparison_base_missing(data: &GitHistoryRepo, selected: &str) -> bool {
    !selected.is_empty()
        && data
            .base_missing
            .unwrap_or_else(|| data.branches.as_ref().is_some_and(|branches| branches.iter().all(|b| b.git_ref != selected)))
}

pub fn commit_stats_notice(reason: StatsUnavailable) -> &'static str {
    match reason {
        StatsUnavailable::Timeout => "Totals unavailable: Git exceeded the read time limit. Retrying automatically.",
        StatsUnavailable::TooLarge => "Totals unavailable: Git exceeded the output limit. Retrying automatically.",
    }
}

/// Older hosts can omit the parent metadata; avoid asserting a parent until it is known. `None` is unknown,
/// `Some(None)` a root commit.
pub fn commit_comparison_label(parent: Option<Option<&str>>) -> &'static str {
    match parent {
        Some(None) => "First commit",
        Some(Some(sha)) if !sha.is_empty() => "Compared with first parent",
        _ => "Commit changes",
    }
}

pub fn diff_file_count_label(data: &DiffFilesRepo) -> String {
    let count = data.files.len();
    let plus = if data.truncated { "+" } else { "" };
    let noun = if count == 1 && !data.truncated { "file" } else { "files" };
    format!("{count}{plus} {noun}")
}

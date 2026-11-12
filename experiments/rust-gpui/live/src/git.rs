//! The Changes panel on the runtime's typed Git reads (`OwnedChatGuard::git_reads`), for the owned Project's Worktree.
//!
//! One read is `git:diff-files` uncommitted and committed (against the runtime's own comparison base), `git:history`
//! (the branch, its base and up to [`HISTORY`] commits), each commit's files, and `git:diff-file` for every listed
//! file (up to [`PATCHES`]; a file past that, or whose patch read fails, shows no patch). A folder that is not a Git
//! repository is the runtime's own `isRepo:false` message. Nothing is fetched and no PR is read: a PR's base and head
//! come only from GitHub, which this runtime does not serve, so the PR tab stays off.

use std::collections::HashMap;
use std::rc::Rc;

use anyhow::{Context as _, Result, anyhow};
use milagre_daemon_client::{GitDiffFileOptions, GitDiffMode, GitDiffOptions, GitHistoryOptions, GitReads};
use milagre_gpui_spike::logic::diff::git::{
    AutomaticBase, CommitStats, DiffFileEntry, DiffFileResult, DiffFilesRepo, DiffStatus, GitBranch, GitCommit, GitHistoryRepo,
    ProjectDefault, StatsUnavailable,
};
use milagre_gpui_spike::workspace::panel::changes::data::{ChangesData, WorktreeChanges};
use serde_json::Value;

/// Commits read with the history.
pub const HISTORY: u16 = 30;
/// Files whose patch is read with the list.
pub const PATCHES: usize = 200;

fn text(value: &Value, key: &str) -> Option<String> {
    value[key].as_str().map(str::to_owned)
}

fn count(value: &Value, key: &str) -> u32 {
    value[key].as_u64().unwrap_or(0) as u32
}

/// `DiffFilesResult`: `Err` with the message when the folder is not a repository.
pub fn diff_files(value: &Value) -> Result<std::result::Result<DiffFilesRepo, String>> {
    if value["isRepo"] == false {
        return Ok(Err(text(value, "message").unwrap_or_else(|| "Not a Git repository".into())));
    }
    if value["isRepo"] != true {
        return Err(anyhow!("git:diff-files answered without isRepo: {value}"));
    }
    let files = value["files"].as_array().context("git:diff-files: files")?;
    let files = files
        .iter()
        .map(|file| {
            let status = match file["status"].as_str() {
                Some("added") => DiffStatus::Added,
                Some("deleted") => DiffStatus::Deleted,
                Some("renamed") => DiffStatus::Renamed,
                Some("modified") => DiffStatus::Modified,
                other => return Err(anyhow!("git:diff-files: status {other:?}")),
            };
            Ok(DiffFileEntry {
                path: text(file, "path").context("git:diff-files: path")?,
                old_path: text(file, "oldPath"),
                status,
                added: count(file, "added"),
                removed: count(file, "removed"),
                binary: file["binary"] == true,
                untracked: file["untracked"] == true,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(Ok(DiffFilesRepo {
        commit: text(value, "commit"),
        commit_parent: value.get("commitParent").map(|parent| parent.as_str().map(str::to_owned)),
        truncated: value["truncated"] == true,
        base: text(value, "base"),
        files,
        message: text(value, "message"),
    }))
}

pub fn diff_file(value: &Value) -> DiffFileResult {
    DiffFileResult {
        patch: text(value, "patch").unwrap_or_default(),
        binary: value["binary"] == true,
        too_large: value["tooLarge"] == true,
    }
}

pub fn history(value: &Value) -> GitHistoryRepo {
    let commits = value["commits"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|commit| GitCommit {
            sha: text(commit, "sha").unwrap_or_default(),
            author: text(commit, "author").unwrap_or_default(),
            email: text(commit, "email").unwrap_or_default(),
            date: text(commit, "date").unwrap_or_default(),
            message: text(commit, "message").unwrap_or_default(),
            stats: match commit["statsUnavailable"].as_str() {
                Some("timeout") => CommitStats::Unavailable(StatsUnavailable::Timeout),
                Some(_) => CommitStats::Unavailable(StatsUnavailable::TooLarge),
                None => {
                    CommitStats::Counts { files: count(commit, "files"), added: count(commit, "added"), removed: count(commit, "removed") }
                }
            },
        })
        .collect();
    GitHistoryRepo {
        branch: text(value, "branch"),
        base: text(value, "base"),
        comparison_ref: text(value, "comparisonRef"),
        head: text(value, "head"),
        total: value["total"].as_u64().map(|total| total as u32),
        automatic: value.get("automatic").filter(|a| a.is_object()).map(|a| AutomaticBase {
            name: text(a, "name").unwrap_or_default(),
            git_ref: text(a, "ref"),
            reason: text(a, "reason").unwrap_or_default(),
        }),
        project_default: value
            .get("projectDefault")
            .filter(|d| d.is_object())
            .map(|d| ProjectDefault { name: text(d, "name").unwrap_or_default(), git_ref: text(d, "ref") }),
        suggested: text(value, "suggested"),
        branches: value["branches"].as_array().map(|branches| {
            branches
                .iter()
                .map(|b| GitBranch { git_ref: text(b, "ref").unwrap_or_default(), name: text(b, "name").unwrap_or_default() })
                .collect()
        }),
        branches_version: text(value, "branchesVersion"),
        base_missing: value["baseMissing"].as_bool(),
        commits,
        has_more: value["hasMore"] == true,
        message: text(value, "message"),
    }
}

fn options(mode: GitDiffMode) -> GitDiffOptions {
    GitDiffOptions { mode, ..GitDiffOptions::default() }
}

/// Everything the Changes panel shows for the owned Worktree, read now.
pub async fn read(git: &GitReads) -> Result<ChangesData> {
    let uncommitted = match diff_files(&git.diff_files(options(GitDiffMode::Uncommitted)).await?)? {
        Ok(repo) => repo,
        Err(message) => return Ok(ChangesData::NotRepo(message)),
    };
    let committed = match diff_files(&git.diff_files(options(GitDiffMode::Committed)).await?)? {
        Ok(repo) => repo,
        Err(message) => return Ok(ChangesData::NotRepo(message)),
    };
    let history_value = git.history(GitHistoryOptions { limit: Some(HISTORY), ..GitHistoryOptions::default() }).await?;
    let history = if history_value["isRepo"] == true { history(&history_value) } else { GitHistoryRepo::default() };
    let mut commit_files = HashMap::new();
    for commit in &history.commits {
        let read = git
            .diff_files(GitDiffOptions { mode: GitDiffMode::Committed, commit: Some(commit.sha.clone()), ..GitDiffOptions::default() })
            .await;
        if let Ok(Ok(Ok(files))) = read.map(|value| diff_files(&value)) {
            commit_files.insert(commit.sha.clone(), files);
        }
    }
    let mut patches = HashMap::new();
    let listed =
        uncommitted.files.iter().map(|f| (f, GitDiffMode::Uncommitted)).chain(committed.files.iter().map(|f| (f, GitDiffMode::Committed)));
    for (file, mode) in listed.take(PATCHES) {
        if patches.contains_key(&file.path) {
            continue;
        }
        let options = GitDiffFileOptions {
            diff: options(mode),
            old_path: file.old_path.clone(),
            untracked: file.untracked && mode == GitDiffMode::Uncommitted,
        };
        if let Ok(value) = git.diff_file(&file.path, options).await {
            patches.insert(file.path.clone(), diff_file(&value));
        }
    }
    Ok(ChangesData::Ready(Rc::new(WorktreeChanges { uncommitted, committed, history, patches, commit_files })))
}

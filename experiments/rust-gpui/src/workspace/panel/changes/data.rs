//! What the Changes panel reads, in the shapes `git:diff-files`, `git:diff-file` and `git:history` return
//! (`logic::diff::git`). Panel-local: `src/data` has no Worktree diff types yet, and the panel's source of
//! these (the fixture today, a daemon call later) fills one [`WorktreeChanges`] per Chat.

use std::collections::HashMap;
use std::rc::Rc;

use crate::logic::diff::git::{DiffFileEntry, DiffFileResult, DiffFilesRepo, GitHistoryRepo};

/// Everything the panel shows for one Chat's Worktree.
#[derive(Clone, Debug, Default)]
pub struct WorktreeChanges {
    /// "Not committed": `git:diff-files` with `mode: uncommitted`.
    pub uncommitted: DiffFilesRepo,
    /// "On this branch": `mode: committed`, against the comparison base.
    pub committed: DiffFilesRepo,
    /// `git:history`: the branch, its base, the branch catalogue and the commits since the base.
    pub history: GitHistoryRepo,
    /// `git:diff-file` per path. A path with no entry has no patch to show.
    pub patches: HashMap<String, DiffFileResult>,
    /// `git:diff-files` for a commit, by SHA (`CommitFiles`).
    pub commit_files: HashMap<String, DiffFilesRepo>,
}

/// The panel's read state for a Chat.
#[derive(Clone, Debug)]
pub enum ChangesData {
    /// A read is in flight: the skeleton.
    Loading,
    /// The folder is not a Git repository (or Git failed): the host's message.
    NotRepo(String),
    Ready(Rc<WorktreeChanges>),
}

/// The two lists of the Files view, in the order the panel draws them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Section {
    Uncommitted,
    Committed,
}

impl Section {
    pub const ALL: [Section; 2] = [Section::Uncommitted, Section::Committed];

    pub fn label(self) -> &'static str {
        match self {
            Section::Uncommitted => "Not committed",
            Section::Committed => "On this branch",
        }
    }
}

impl WorktreeChanges {
    pub fn list(&self, section: Section) -> &DiffFilesRepo {
        match section {
            Section::Uncommitted => &self.uncommitted,
            Section::Committed => &self.committed,
        }
    }

    /// Files across both sections, a file in both counted once (`changedFileCount`).
    pub fn unique_files(&self) -> Vec<&DiffFileEntry> {
        let mut seen = std::collections::HashSet::new();
        self.uncommitted.files.iter().chain(&self.committed.files).filter(|file| seen.insert(file.path.as_str())).collect()
    }

    pub fn file_count(&self) -> usize {
        self.unique_files().len()
    }

    /// Added and removed lines over the unique files (binary files count nothing, as the rows do).
    pub fn totals(&self) -> (u32, u32) {
        self.unique_files().iter().filter(|file| !file.binary).fold((0, 0), |(a, r), file| (a + file.added, r + file.removed))
    }
}

impl ChangesData {
    pub fn file_count(&self) -> usize {
        match self {
            ChangesData::Ready(changes) => changes.file_count(),
            _ => 0,
        }
    }
}

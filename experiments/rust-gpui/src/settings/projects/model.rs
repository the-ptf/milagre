//! A Project's settings as its host answers them (`project:set-icon`, `project:hidden`, `main-sync:*`,
//! `project-git:*`, `files-to-copy:*`, `worktree-setup:*`, `project:forget`): the global [`ProjectsStore`], one entry
//! per Project path, made on first use from a deterministic fixture. Nothing is read from disk or the daemon.

use std::collections::BTreeMap;

use gpui::Global;

use super::logic::{
    BranchPolicy, BranchSettings, DEFAULT_FILES_TO_COPY, PartialPolicy, branch_policy_overrides, fixture_ignored_files, match_files,
    parse_patterns,
};
use crate::settings::devices::logic::{MainSyncChoice, MainSyncResult, SyncOutcome};
use crate::settings::devices::model::now_ms;

/// A custom icon: the file it came from and the fixture tile colour that stands for its pixels.
#[derive(Clone, Debug, PartialEq)]
pub struct IconChoice {
    pub file: String,
    pub hue: u32,
}

/// `WorktreeSetupSettings`: what runs in a new Worktree, and who decided.
#[derive(Clone, Debug, PartialEq)]
pub struct SetupSettings {
    /// "setup" in `.milagre/worktree.json` wins when present (`Some(None)`: it says to run nothing).
    pub repo: Option<Option<String>>,
    pub note: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProjectEntry {
    pub icon: Option<IconChoice>,
    pub hidden: bool,
    pub main_sync: MainSyncChoice,
    pub main_sync_last: Option<MainSyncResult>,
    pub branch: BranchSettings,
    pub files: String,
    /// `.worktreeinclude` at the repo root wins when present.
    pub worktree_include: Option<String>,
    pub setup: String,
    pub setup_settings: SetupSettings,
    pub removed: bool,
    /// How many times each group was saved (the autosave tests read these).
    pub saves: Saves,
    /// A data layer's host: how many times its reads landed (the page makes its fields again from each), the files
    /// its last preview matched, and why a read or save failed, by group (`branch`, `files`, `setup`, `sync`, `sidebar`).
    pub loaded: u64,
    pub matches: Option<Vec<String>>,
    pub errors: BTreeMap<&'static str, String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Saves {
    pub branch: usize,
    pub files: usize,
    pub setup: usize,
}

#[derive(Clone, Debug, Default)]
pub struct ProjectsStore {
    entries: BTreeMap<String, ProjectEntry>,
    pub ignored: Vec<String>,
    /// A data layer's host keeps the entries ([`super::hosted`]): one not read yet is blank, not the fixture's.
    pub hosted: bool,
}

impl Global for ProjectsStore {}

fn leaf(path: &str) -> &str {
    path.rsplit(['/', '|']).next().unwrap_or(path)
}

/// The fixture for a path: milagre-ade has a personal username and a base branch its repository fixes, happiergym's
/// repository fixes its files and setup too, every other Project is plain.
pub fn default_entry(path: &str) -> ProjectEntry {
    let name = leaf(path);
    let mut entry = ProjectEntry {
        icon: None,
        hidden: false,
        main_sync: MainSyncChoice::Default,
        main_sync_last: None,
        branch: BranchSettings::default(),
        files: String::new(),
        worktree_include: None,
        setup: String::new(),
        setup_settings: SetupSettings { repo: None, note: None },
        removed: false,
        saves: Saves::default(),
        loaded: 0,
        matches: None,
        errors: BTreeMap::new(),
    };
    if name.contains("ade") {
        entry.branch.local.username = Some("victor".into());
        entry.branch.repository.base_branch = Some("main".into());
        entry.files = ".env*\nconfig/secrets.json".into();
        entry.setup = "npm ci".into();
        entry.main_sync_last = Some(MainSyncResult {
            at: now_ms() - 12 * 60_000,
            outcome: SyncOutcome::Updated,
            branch: "main".into(),
            commit: Some("a1b2c3d".into()),
            message: None,
        });
    } else if name.contains("gym") {
        entry.worktree_include = Some(".env*\nios/GoogleService-Info.plist".into());
        entry.setup_settings.repo = Some(Some("uv sync".into()));
        entry.main_sync = MainSyncChoice::On;
        entry.main_sync_last = Some(MainSyncResult {
            at: now_ms() - 3 * 3_600_000,
            outcome: SyncOutcome::Skipped,
            branch: "main".into(),
            commit: None,
            message: Some("it has local commits".into()),
        });
    }
    entry
}

/// An entry nothing has been read for yet (a host's Project before its answers).
pub fn blank_entry() -> ProjectEntry {
    ProjectEntry {
        icon: None,
        hidden: false,
        main_sync: MainSyncChoice::Default,
        main_sync_last: None,
        branch: BranchSettings::default(),
        files: String::new(),
        worktree_include: None,
        setup: String::new(),
        setup_settings: SetupSettings { repo: None, note: None },
        removed: false,
        saves: Saves::default(),
        loaded: 0,
        matches: None,
        errors: BTreeMap::new(),
    }
}

impl ProjectsStore {
    pub fn fixture() -> Self {
        ProjectsStore { entries: BTreeMap::new(), ignored: fixture_ignored_files(), hosted: false }
    }

    fn made(&self, path: &str) -> ProjectEntry {
        if self.hosted { blank_entry() } else { default_entry(path) }
    }

    pub fn get(&self, path: &str) -> ProjectEntry {
        self.entries.get(path).cloned().unwrap_or_else(|| self.made(path))
    }

    pub fn entry(&mut self, path: &str) -> &mut ProjectEntry {
        let made = self.made(path);
        self.entries.entry(path.to_string()).or_insert(made)
    }

    pub fn is_removed(&self, path: &str) -> bool {
        self.entries.get(path).is_some_and(|entry| entry.removed)
    }

    /// `project-git:save`: the personal overrides that differ from the defaults, the repository's untouched.
    pub fn save_branch(&mut self, path: &str, draft: &BranchPolicy) {
        let entry = self.entry(path);
        entry.branch.local = branch_policy_overrides(&entry.branch, draft);
        entry.saves.branch += 1;
    }

    /// "Reset to defaults".
    pub fn reset_branch(&mut self, path: &str) {
        let entry = self.entry(path);
        entry.branch.local = PartialPolicy::default();
        entry.saves.branch += 1;
    }

    /// `files-to-copy:save`.
    pub fn save_files(&mut self, path: &str, text: &str) {
        let entry = self.entry(path);
        entry.files = text.to_string();
        entry.saves.files += 1;
    }

    /// `worktree-setup:save`.
    pub fn save_setup(&mut self, path: &str, command: &str) {
        let entry = self.entry(path);
        entry.setup = command.trim().to_string();
        entry.saves.setup += 1;
    }

    /// `files-to-copy:preview`: the ignored files the patterns (or the repository's `.worktreeinclude`) copy.
    pub fn preview_files(&self, path: &str, text: &str) -> Vec<String> {
        let entry = self.get(path);
        // A host previews the patterns itself (`files-to-copy:preview`).
        if self.hosted {
            return entry.matches.unwrap_or_default();
        }
        let source = entry.worktree_include.as_deref().unwrap_or(text);
        let mut patterns = parse_patterns(source);
        if patterns.is_empty() {
            patterns = parse_patterns(DEFAULT_FILES_TO_COPY);
        }
        match_files(&patterns, &self.ignored)
    }

    pub fn set_icon(&mut self, path: &str, icon: Option<IconChoice>) {
        self.entry(path).icon = icon;
    }

    pub fn set_hidden(&mut self, path: &str, hidden: bool) {
        self.entry(path).hidden = hidden;
    }

    pub fn set_main_sync(&mut self, path: &str, choice: MainSyncChoice) {
        self.entry(path).main_sync = choice;
    }

    pub fn forget(&mut self, path: &str) {
        self.entry(path).removed = true;
    }
}

pub fn init(cx: &mut gpui::App) {
    if !cx.has_global::<ProjectsStore>() {
        cx.set_global(ProjectsStore::fixture());
    }
}

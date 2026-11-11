//! What the dialogs ask of the host (the bridge calls named on each method) and the fixture that answers them.
//!
//! Every method returns a `Send` future like [`crate::data::DataSource`]'s, so a daemon adapter can implement the
//! trait later. The fixture answers at once and keeps its few facts behind a mutex; a dialog waits a step of its own
//! (`mod.rs` `call`) so "Connecting…" and "Removing…" are seen.

use std::sync::{Arc, Mutex};

use anyhow::anyhow;

use crate::data::{DataFuture, ready};

/// `ComputerPreview`: what a pairing link names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ComputerPreview {
    pub name: String,
    pub relay_host: String,
}

/// `PendingComputer`: a computer waiting to drive this one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingComputer {
    pub key: String,
    pub name: Option<String>,
}

/// One folder of `DirListing.entries`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub git: bool,
    pub branch: Option<String>,
    /// Already a Project.
    pub project: bool,
}

/// `DirListing` (`fs:list-dirs`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DirListing {
    pub path: String,
    pub home: String,
    pub parent: Option<String>,
    pub entries: Vec<DirEntry>,
    /// More subfolders than the first 500 by name.
    pub truncated: bool,
}

/// A Project a Link can hold (`project:registry` rows).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkProject {
    pub id: String,
    pub name: String,
    pub path: String,
}

/// `NamedProjectLink`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NamedLink {
    pub id: String,
    pub name: String,
    pub project_ids: Vec<String>,
}

/// `NamedLinkDeleteCheck`: how many Chats a delete archives, and which hold it back by running.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkDeleteCheck {
    pub chats: usize,
    pub running: Vec<String>,
}

/// `NamedLinkDeleted`: the Worktrees it kept (paths).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkDeleted {
    pub kept: Vec<String>,
}

pub trait DialogHost {
    /// `project:forget [path]`.
    fn forget_project(&self, path: &str) -> DataFuture<()>;
    /// `computers:preview [link]`.
    fn preview_computer(&self, link: &str) -> DataFuture<ComputerPreview>;
    /// `computers:add [link, { name }]`: resolves once the other computer allowed it.
    fn add_computer(&self, link: &str, name: &str) -> DataFuture<()>;
    /// `onComputerAddPending`: resolves once the other computer is being asked to allow this one.
    fn add_pending(&self) -> DataFuture<()>;
    /// `computers:cancel-add`.
    fn cancel_add(&self);
    /// `fs:list-dirs` on `computer` (this Mac for `None`); `path` of `None` is its home.
    fn list_dirs(&self, computer: Option<&str>, path: Option<&str>) -> DataFuture<DirListing>;
    /// `project:choose-folder`: the folder the native chooser picked on this computer, `None` when it was cancelled.
    fn choose_folder(&self) -> DataFuture<Option<String>>;
    /// `project:open-at [path]` on `computer`: the opened Project's name.
    fn open_project_at(&self, computer: &str, path: &str) -> DataFuture<String>;
    /// `onboarding:clone [url, parent]`: the opened Project's name.
    fn clone_project(&self, computer: Option<&str>, url: &str, into: Option<&str>) -> DataFuture<String>;
    /// `project:registry`.
    fn list_link_projects(&self) -> DataFuture<Vec<LinkProject>>;
    /// `link:create` (no id) or `link:update`.
    fn save_link(&self, id: Option<&str>, name: &str, project_ids: &[String]) -> DataFuture<NamedLink>;
    /// `link:delete-check`.
    fn check_delete_link(&self, id: &str) -> DataFuture<LinkDeleteCheck>;
    /// `link:delete`.
    fn delete_link(&self, id: &str) -> DataFuture<LinkDeleted>;
    /// `devices:allow` / `devices:deny`: the requests still waiting.
    fn answer_device(&self, key: &str, allow: bool) -> DataFuture<Vec<PendingComputer>>;
    /// `update:release-notes [version]`: markdown, empty when none were published.
    fn release_notes(&self, version: &str) -> DataFuture<String>;
    /// `app:retry-quit`.
    fn retry_quit(&self) -> DataFuture<()>;
}

/// What the fixture does next, set by a test or a snapshot run.
#[derive(Default)]
pub struct FixtureState {
    /// The next call fails with this message.
    pub fail_next: Option<String>,
    /// Checks of the Link that still find a Chat running before it stops.
    pub running_checks: usize,
    pub cancelled_adds: usize,
    pub forgotten: Vec<String>,
    pub pending: Vec<PendingComputer>,
    pub answered: Vec<(String, bool)>,
    pub saved: Vec<NamedLink>,
    pub opened: Vec<(String, String)>,
    pub cloned: Vec<(Option<String>, String, Option<String>)>,
    pub deleted_links: Vec<String>,
    pub added_computers: Vec<(String, String)>,
    pub notes: Option<String>,
    pub quit_retries: usize,
}

#[derive(Clone, Default)]
pub struct FixtureHost {
    pub state: Arc<Mutex<FixtureState>>,
}

const HOME: &str = "/Users/dev";

fn dir(name: &str, parent: &str, git: bool, project: bool) -> DirEntry {
    DirEntry { name: name.into(), path: format!("{parent}/{name}"), git, branch: git.then(|| "main".to_string()), project }
}

impl FixtureHost {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with(&self, change: impl FnOnce(&mut FixtureState)) -> &Self {
        change(&mut self.state.lock().unwrap());
        self
    }

    fn failure(&self) -> Option<anyhow::Error> {
        self.state.lock().unwrap().fail_next.take().map(|message| anyhow!(message))
    }

    fn answer<T: Send + 'static>(&self, value: impl FnOnce(&mut FixtureState) -> T) -> DataFuture<T> {
        match self.failure() {
            Some(error) => ready(Err(error)),
            None => ready(Ok(value(&mut self.state.lock().unwrap()))),
        }
    }
}

/// The folders under `path` on the fixture computer (`~/Code` holds the Projects).
fn listing(path: &str) -> anyhow::Result<DirListing> {
    let entries = match path {
        HOME => vec![
            dir("Code", HOME, false, false),
            dir("Desktop", HOME, false, false),
            dir("Documents", HOME, false, false),
            dir("Downloads", HOME, false, false),
        ],
        "/Users/dev/Code" => vec![
            dir("happiergym", path, true, false),
            dir("milagre-ade", path, true, true),
            dir("notes", path, false, false),
            dir("rd-mobile", path, true, false),
        ],
        "/Users/dev/Code/milagre-ade" | "/Users/dev/Code/happiergym" | "/Users/dev/Code/notes" | "/Users/dev/Code/rd-mobile" => {
            vec![dir("apps", path, false, false), dir("packages", path, false, false)]
        }
        "/Users/dev/Desktop" | "/Users/dev/Documents" | "/Users/dev/Downloads" => Vec::new(),
        other => return Err(anyhow!("{other} is not a folder on this computer.")),
    };
    let parent = (path != HOME).then(|| path.rsplit_once('/').map_or(HOME.to_string(), |(parent, _)| parent.to_string()));
    Ok(DirListing { path: path.to_string(), home: HOME.to_string(), parent, entries, truncated: false })
}

fn link_projects() -> Vec<LinkProject> {
    [
        ("milagre-ade", "~/Code/milagre-ade"),
        ("happiergym", "~/Code/happiergym"),
        ("rd-mobile", "~/Code/rd-mobile"),
        ("rd-food", "~/Code/rd-food"),
        ("notes", "~/Code/notes"),
    ]
    .into_iter()
    .map(|(name, path)| LinkProject { id: format!("/Users/dev{}", &path[1..]), name: name.into(), path: path.into() })
    .collect()
}

impl DialogHost for FixtureHost {
    fn forget_project(&self, path: &str) -> DataFuture<()> {
        let path = path.to_string();
        self.answer(move |state| state.forgotten.push(path))
    }

    fn preview_computer(&self, link: &str) -> DataFuture<ComputerPreview> {
        let name = link
            .trim()
            .strip_prefix("milagre://pair?")
            .and_then(|query| query.split('&').find_map(|part| part.strip_prefix("name=")))
            .map(|value| value.replace('+', " ").replace("%20", " "));
        match (name, self.failure()) {
            (_, Some(error)) => ready(Err(error)),
            (Some(name), None) => ready(Ok(ComputerPreview { name, relay_host: "relay.milagre.cloud".into() })),
            (None, None) => {
                ready(Err(anyhow!("That is not a Milagre pairing link. Scan the code your Mac shows, or copy its pairing link.")))
            }
        }
    }

    fn add_computer(&self, link: &str, name: &str) -> DataFuture<()> {
        // Lazy: the pairing happens when the answer is waited on, so dropping the wait cancels it.
        let (link, name, state) = (link.to_string(), name.to_string(), self.state.clone());
        let failure = self.failure();
        Box::pin(async move {
            match failure {
                Some(error) => Err(error),
                None => {
                    state.lock().unwrap().added_computers.push((link, name));
                    Ok(())
                }
            }
        })
    }

    fn add_pending(&self) -> DataFuture<()> {
        ready(Ok(()))
    }

    fn cancel_add(&self) {
        self.state.lock().unwrap().cancelled_adds += 1;
    }

    fn list_dirs(&self, computer: Option<&str>, path: Option<&str>) -> DataFuture<DirListing> {
        let _ = computer;
        match self.failure() {
            Some(error) => ready(Err(error)),
            None => ready(listing(path.unwrap_or(HOME))),
        }
    }

    fn choose_folder(&self) -> DataFuture<Option<String>> {
        self.answer(|_| Some("/Users/dev/Code/notes".to_string()))
    }

    fn open_project_at(&self, computer: &str, path: &str) -> DataFuture<String> {
        let (computer, path) = (computer.to_string(), path.to_string());
        self.answer(move |state| {
            let name = path.rsplit('/').next().unwrap_or("").to_string();
            state.opened.push((computer, path));
            name
        })
    }

    fn clone_project(&self, computer: Option<&str>, url: &str, into: Option<&str>) -> DataFuture<String> {
        let entry = (computer.map(str::to_string), url.to_string(), into.map(str::to_string));
        self.answer(move |state| {
            let name = entry.1.trim_end_matches('/').trim_end_matches(".git").rsplit('/').next().unwrap_or("").to_string();
            state.cloned.push(entry);
            name
        })
    }

    fn list_link_projects(&self) -> DataFuture<Vec<LinkProject>> {
        self.answer(|_| link_projects())
    }

    fn save_link(&self, id: Option<&str>, name: &str, project_ids: &[String]) -> DataFuture<NamedLink> {
        let link = NamedLink { id: id.unwrap_or("link-1").to_string(), name: name.to_string(), project_ids: project_ids.to_vec() };
        self.answer(move |state| {
            state.saved.push(link.clone());
            link
        })
    }

    fn check_delete_link(&self, _id: &str) -> DataFuture<LinkDeleteCheck> {
        self.answer(|state| {
            if state.running_checks > 0 {
                state.running_checks -= 1;
                LinkDeleteCheck { chats: 3, running: vec!["Fix header".to_string()] }
            } else {
                LinkDeleteCheck { chats: 3, running: Vec::new() }
            }
        })
    }

    fn delete_link(&self, id: &str) -> DataFuture<LinkDeleted> {
        let id = id.to_string();
        self.answer(move |state| {
            state.deleted_links.push(id);
            LinkDeleted { kept: Vec::new() }
        })
    }

    fn answer_device(&self, key: &str, allow: bool) -> DataFuture<Vec<PendingComputer>> {
        let key = key.to_string();
        self.answer(move |state| {
            state.pending.retain(|request| request.key != key);
            state.answered.push((key, allow));
            state.pending.clone()
        })
    }

    fn release_notes(&self, version: &str) -> DataFuture<String> {
        let version = version.to_string();
        self.answer(move |state| {
            state.notes.clone().unwrap_or_else(|| {
                format!(
                    "## Milagre v{version}\n\n- **Command palette** searches Chats, Projects, actions and the words in your messages.\n- Dialogs for adding a computer or a Project.\n- Fewer pauses when a computer comes back.\n\nFull notes are on [GitHub](https://github.com/the-ptf/milagre/releases)."
                )
            })
        })
    }

    fn retry_quit(&self) -> DataFuture<()> {
        self.answer(|state| state.quit_retries += 1)
    }
}

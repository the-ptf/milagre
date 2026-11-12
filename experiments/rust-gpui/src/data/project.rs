//! Computers, scopes, Projects, Worktrees and a scope's state: what `computers:list`, `project:recent`,
//! `project:current`, `project:open`, `project:read` and `state:read` answer.
//!
//! Sources: `ComputerView`, `ComputersSnapshot`, `StateStamp`, `ProjectRead` in `apps/desktop/app/src/electron.d.ts`;
//! `RecentProject` in `apps/desktop/app/src/lib/project-list.ts`; `OpenProject`, `CoordinatorState`, `Worktree`,
//! `DiffStat`, `PersistenceFailure` in `packages/shared/src/model.ts`; `ProjectKind` in
//! `packages/shared/src/chats-home.mjs`; scope keys in `packages/shared/src/chat-scopes.mjs`.

use std::collections::BTreeMap;

use gpui::{Rgba, SharedString};

use super::chat::{Chat, ChatId};
use crate::logic::identity::scopes::{LOCAL_COMPUTER, computer_of_key, qualify_key};

/// A computer's id: [`LOCAL`] for this Mac, else the id this Mac paired it under (`ComputerView.id`,
/// `^[A-Za-z0-9-]{1,64}$`).
pub type ComputerId = SharedString;

/// The id of this computer in every key (`LOCAL_COMPUTER` in `chat-scopes.mjs`).
pub const LOCAL: &str = LOCAL_COMPUTER;

/// How a paired computer stands (`ComputerState`). "off" while Settings › Devices › Other computers is off.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ComputerState {
    Off,
    Connecting,
    Online,
    Reconnecting,
    Offline,
    Refused,
}

impl ComputerState {
    /// What the sidebar dims and names ", offline" (`isDimmed` in `apps/desktop/app/src/lib/computers.ts`).
    pub fn is_dimmed(self) -> bool {
        matches!(self, ComputerState::Offline | ComputerState::Refused)
    }
}

/// A computer this Mac drives (`ComputerView`), trimmed to what the lists read.
#[derive(Clone, Debug, PartialEq)]
pub struct Computer {
    pub id: ComputerId,
    /// This Mac's label for it ("Show it as").
    pub name: SharedString,
    pub state: ComputerState,
    /// Why it isn't connected, in words, while that can be said.
    pub message: Option<SharedString>,
}

/// `computers:list` (`ComputersSnapshot`): this Mac's name and every computer it drives.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ComputersSnapshot {
    pub this_mac: SharedString,
    pub computers: Vec<Computer>,
}

impl ComputersSnapshot {
    /// The name a row shows for a computer: this Mac's own name for [`LOCAL`].
    pub fn name_of(&self, id: &str) -> SharedString {
        if id == LOCAL {
            return self.this_mac.clone();
        }
        self.computers.iter().find(|computer| computer.id.as_ref() == id).map_or_else(|| "Computer".into(), |c| c.name.clone())
    }

    /// Whether rows dim a computer and say it is offline (an unknown computer is not). This Mac never is.
    pub fn is_offline(&self, id: &str) -> bool {
        id != LOCAL && self.computers.iter().find(|computer| computer.id.as_ref() == id).is_some_and(|c| c.state.is_dimmed())
    }

    /// Every computer id, this Mac first.
    pub fn ids(&self) -> Vec<ComputerId> {
        std::iter::once(ComputerId::from(LOCAL)).chain(self.computers.iter().map(|computer| computer.id.clone())).collect()
    }
}

/// What a scope key names: a Project's path, or a Link's key (`milagre-link:<id>`), qualified with its computer
/// (`<computer>|<path>`) when it is not this Mac's. The key `state:read` and `chat:messages` take, and the prefix of
/// every Chat key (`<scope>#<id>`).
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ScopeKey(pub SharedString);

impl ScopeKey {
    /// A Project's key on `computer` (`qualifyKey`).
    pub fn project(computer: &str, path: &str) -> ScopeKey {
        let key = qualify_key(Some(computer), path).unwrap_or_else(|_| path.to_owned());
        ScopeKey(key.into())
    }

    /// The computer the key belongs to ([`LOCAL`] for this Mac).
    pub fn computer(&self) -> &str {
        computer_of_key(&self.0)
    }

    /// `<scope>#<id>`: the Chat key `chat:runs` and the lists use.
    pub fn chat_key(&self, chat: ChatId) -> String {
        format!("{}#{chat}", self.0)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// `ProjectKind` (`kind` on `OpenProject`): absent for every Project but the Chats home, `"chats"`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ProjectKind {
    /// A folder the user opened (a Git checkout, or a plain folder).
    #[default]
    Project,
    /// The Chats home: the internal repository Chats without a Project run in ("Chats" in the list).
    ChatsHome,
}

impl ProjectKind {
    /// The wire's `kind`: `Some("chats")` for the Chats home.
    pub fn from_wire(kind: Option<&str>) -> ProjectKind {
        if crate::logic::identity::chats_home::is_chats_home_project(kind) { ProjectKind::ChatsHome } else { ProjectKind::Project }
    }
}

/// A Project as the lists know it: `OpenProject` without its state, with `RecentProject`'s `hidden`, `origin` and
/// `openedAt`, and the computer it lives on (which the wire carries in the scope key, not on the Project).
#[derive(Clone, Debug, PartialEq)]
pub struct Project {
    /// The folder on its computer, as that computer names it.
    pub path: SharedString,
    pub name: SharedString,
    /// `git`: false for a folder outside Git (its one Worktree is the folder). Absent on the wire means Git.
    pub git: bool,
    pub kind: ProjectKind,
    /// `RecentProject.hidden`: kept out of the all-Projects sidebar and the phone's Projects list.
    pub hidden: bool,
    /// `RecentProject.origin`: the Git remote as "host/owner/repo", which ties one repository's copies on several
    /// computers together (`logic::identity::project_origin`).
    pub origin: Option<SharedString>,
    /// `RecentProject.openedAt`, ISO; most recent first in `project:recent`.
    pub opened_at: Option<SharedString>,
    /// The computer the Project is on.
    pub computer: ComputerId,
    /// Not on the wire: a stand-in for the Project's image (`project:image`) until images are read. `None` draws
    /// the neutral tile.
    pub tile: Option<Rgba>,
    /// Not on the wire: the Project's picture (`project:image`: its icon file, favicon or GitHub avatar), decoded,
    /// once a data layer has read it. `None` draws the letter tile.
    pub image: Option<std::sync::Arc<gpui::Image>>,
}

impl Project {
    /// A Git Project on this Mac, not hidden, with no origin.
    pub fn new(path: impl Into<SharedString>, name: impl Into<SharedString>) -> Project {
        Project {
            path: path.into(),
            name: name.into(),
            git: true,
            kind: ProjectKind::Project,
            hidden: false,
            origin: None,
            opened_at: None,
            computer: LOCAL.into(),
            tile: None,
            image: None,
        }
    }

    /// The key its state and Chats are read under.
    pub fn scope(&self) -> ScopeKey {
        ScopeKey::project(&self.computer, &self.path)
    }

    pub fn is_chats_home(&self) -> bool {
        self.kind == ProjectKind::ChatsHome
    }
}

/// `StateStamp`: the number of the state a reply carries or holds (`version`, +1 each send per scope) and the host
/// run that numbered it (`epoch`, one UUID per run). Both absent from a host that predates them. A client applies a
/// `project:state` patch only when its `base` is the held version in the same epoch; otherwise it reads again.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StateStamp {
    pub version: Option<u64>,
    pub epoch: Option<SharedString>,
}

/// `PersistenceFailure`: a failed save the computer retains until every pending edit reached disk.
#[derive(Clone, Debug, PartialEq)]
pub struct PersistenceFailure {
    pub error: SharedString,
    pub code: Option<SharedString>,
    pub saving: bool,
}

/// `CoordinatorState` as a lean host sends it (`messagesInChats`: `messages` is empty and each Chat's messages
/// come from `chat:messages`). `projects` and `tasks` are left out: no screen reads them.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ScopeState {
    pub persistence: Option<PersistenceFailure>,
    pub messages_in_chats: bool,
    pub next_id: u64,
    /// `worktrees`, by id (the wire keys them by the id's decimal string).
    pub worktrees: BTreeMap<WorktreeId, Worktree>,
    /// `sessions`: the Chats, by id.
    pub sessions: BTreeMap<ChatId, Chat>,
}

impl ScopeState {
    pub fn chat(&self, id: ChatId) -> Option<&Chat> {
        self.sessions.get(&id)
    }

    pub fn worktree_of(&self, chat: &Chat) -> Option<&Worktree> {
        self.worktrees.get(&chat.worktree_id)
    }
}

/// `OpenProject` (`project:current`, `project:open`) and `ProjectRead` (`project:read`): a Project with its state
/// and stamp. `state` is `None` only for `project:read [path, { state: false }]`.
#[derive(Clone, Debug, PartialEq)]
pub struct OpenProject {
    pub project: Project,
    pub state: Option<ScopeState>,
    pub stamp: StateStamp,
}

/// `state:read [scope]`: `{ state, version, epoch }`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StateRead {
    pub state: ScopeState,
    pub stamp: StateStamp,
}

pub type WorktreeId = u64;

/// `DiffStat`: lines changed against the base.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DiffStat {
    pub added: u64,
    pub removed: u64,
}

/// `Worktree.sharedChat`: the Link Chat a Worktree belongs to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SharedChat {
    pub link_id: SharedString,
    pub session_id: ChatId,
}

/// One checkout of a Project (`Worktree`).
#[derive(Clone, Debug, PartialEq)]
pub struct Worktree {
    pub id: WorktreeId,
    pub project_id: u64,
    pub path: SharedString,
    /// `name`: the checked-out branch, or the folder name when HEAD is detached.
    pub name: SharedString,
    /// The ref a Worktree Milagre created started from; its changes are measured against it.
    pub base: Option<SharedString>,
    /// `generatedBranch`: the exact branch Milagre generated.
    pub generated_branch: Option<SharedString>,
    /// `linearIssue`: a stored issue key. The wire's `null` (explicitly unlinked) and absent (detect from the
    /// branch) both read `None` here; [`Worktree::linear_unlinked`] keeps the difference.
    pub linear_issue: Option<SharedString>,
    pub linear_unlinked: bool,
    pub linear_workspace: Option<SharedString>,
    pub diff: Option<DiffStat>,
    pub shared_chat: Option<SharedChat>,
}

impl Worktree {
    /// A Worktree with only its identity set.
    pub fn new(id: WorktreeId, project_id: u64, path: impl Into<SharedString>, name: impl Into<SharedString>) -> Worktree {
        Worktree {
            id,
            project_id,
            path: path.into(),
            name: name.into(),
            base: None,
            generated_branch: None,
            linear_issue: None,
            linear_unlinked: false,
            linear_workspace: None,
            diff: None,
            shared_chat: None,
        }
    }
}

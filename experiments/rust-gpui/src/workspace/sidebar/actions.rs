//! What the sidebar's menus ask the host to do, as a seam of their own.
//!
//! `DataSource` is read-only so far; the writes a sidebar action makes (`chat:patch`, `chat:reload`,
//! `chat:delete`, `worktree:link-issue`, `editor:open`, `project:set-hidden`, the pins preference) go through
//! [`SidebarActions`], one method, one [`SidebarCall`] per daemon call, named in its doc. The daemon adapter
//! implements it later; until then [`RecordingActions`] keeps every call so a test can read what a menu item sent.
//!
//! The sidebar applies each change to its own copy of the data at once (the desktop's optimistic Done, held while
//! the host catches up), then sends the call; an undo sends the opposite call.

use std::sync::{Arc, Mutex};

use gpui::{Global, SharedString};

/// What a Chat patch changes (`chat:patch [scope, id, patch]`).
#[derive(Clone, Debug, PartialEq)]
pub enum ChatPatch {
    /// `title`: the new name; empty puts the generated one back.
    Title(SharedString),
    /// `unread`.
    Unread(bool),
    /// `doneAt`: when it moved to Done, `None` for Reopen.
    DoneAt(Option<i64>),
    /// `parent: null`: a Subchat becomes a Chat of its own.
    Detach,
    /// `kept: true`: the user took over a Run Chat its host could still hide.
    Kept,
}

/// How a deletion treats the Worktree: the sidebar's Delete only hides the conversation (`HIDE_ONLY`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArchiveMode {
    HideOnly,
}

/// One write the sidebar makes. `chat` is the Chat key, `<scope>#<id>`.
#[derive(Clone, Debug, PartialEq)]
pub enum SidebarCall {
    /// `chat:patch`.
    Patch {
        chat: String,
        patch: ChatPatch,
    },
    /// `chat:reload`: the Chat's agent session starts again from its history.
    Reload {
        chat: String,
    },
    /// `chat:delete` with the archive mode: hides the Chat; the host finishes it after the undo window.
    Archive {
        chat: String,
        mode: ArchiveMode,
    },
    /// Takes a deletion back inside its undo window (`undoDelete`).
    UndoArchive {
        chat: String,
    },
    /// `milagre.chatPins`: this device's pin for a Chat, `None` unpins.
    Pin {
        chat: String,
        order: Option<f64>,
    },
    /// `worktree:link-issue [scope, worktree, null]`.
    UnlinkIssue {
        chat: String,
    },
    /// "Link issue…": opens the Linear issue picker for the Chat's Worktree.
    LinkIssue {
        chat: String,
    },
    /// "Report a Milagre bug": opens the report dialog about this Chat.
    ReportBug {
        chat: String,
    },
    /// `editor:open`.
    OpenInEditor {
        path: String,
    },
    /// Shows the folder in Finder.
    Reveal {
        path: String,
    },
    /// "Commit and open PR…": opens the Git actions dialog on the Chat's Worktree.
    CommitAndOpenPr {
        chat: String,
    },
    /// "Link with…" / "Remove Link with…": the canvas Link pickers.
    LinkWith {
        chat: String,
    },
    RemoveLinkWith {
        chat: String,
    },
    /// `project:set-hidden`: a Project out of (or back in) the sidebar. `scope` is the Project's scope key.
    SetProjectHidden {
        scope: String,
        hidden: bool,
    },
    /// Settings › Devices: a computer's Projects out of (or back in) the sidebar.
    SetComputerHidden {
        computer: String,
        hidden: bool,
    },
    /// Filters › Show: which facts a row's second line carries.
    SetRowField {
        field: &'static str,
        shown: bool,
    },
    /// Filters › Computers › Add computer.
    AddComputer,
    /// Footer: the Add Project button.
    AddProject,
    /// `canvas:link-add [a, b]`: a Link between two ends (a drop on a row, "Link with…").
    AddLink {
        a: super::links::LinkEnd,
        b: super::links::LinkEnd,
    },
    /// `canvas:link-remove`.
    RemoveLink {
        id: String,
    },
    /// `canvas:link-restore`: the same Link back, id and all, so an Always allow grant on it holds again.
    RestoreLink {
        link: super::links::CanvasLink,
    },
    /// `linked:grant`: Always allow Delegations from this Chat over the Link.
    GrantDelegations {
        chat: String,
        link: String,
    },
    /// "Link and ask": a plain user message to the Chat (`body` shown, `prompt` sent).
    AskChat {
        chat: String,
        body: String,
        prompt: String,
    },
}

pub trait SidebarActions: Send + Sync + 'static {
    fn call(&self, call: SidebarCall);
}

/// Keeps every call, in order. The fixture's [`SidebarActions`].
#[derive(Default)]
pub struct RecordingActions {
    calls: Mutex<Vec<SidebarCall>>,
}

impl RecordingActions {
    pub fn calls(&self) -> Vec<SidebarCall> {
        self.calls.lock().expect("recorded calls").clone()
    }

    /// Reads and clears the calls.
    pub fn take(&self) -> Vec<SidebarCall> {
        std::mem::take(&mut *self.calls.lock().expect("recorded calls"))
    }
}

impl SidebarActions for RecordingActions {
    fn call(&self, call: SidebarCall) {
        self.calls.lock().expect("recorded calls").push(call);
    }
}

/// The app's sidebar actions, as a GPUI global; a sidebar without one records into its own [`RecordingActions`].
#[derive(Clone)]
pub struct Actions(pub Arc<dyn SidebarActions>);

impl Global for Actions {}

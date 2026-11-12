//! The UI's write seams as [`Command`]s for the controller, which runs them on the Chat actions.
//!
//! - [`LiveSink`] is the composer's `MessageSink`: a send (now or queued), Stop, and the queue's Send now and Remove.
//!   It is called inside the composer's update, so it reads what it needs from cells the controller keeps current:
//!   which Chat the composer is for ([`Target`]) and the permission mode and effort the picker shows.
//! - [`LiveSidebarActions`] is the sidebar's `SidebarActions`: unread, Done, Reopen and Rename go to the runtime (its
//!   `chat:patch` writes); every other call is recorded, as the fixture does, and changes nothing on the runtime.

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::Arc;

use futures::channel::mpsc::UnboundedSender;
use milagre_daemon_client::PermissionMode as WireMode;
use milagre_gpui_spike::data::PermissionMode;
use milagre_gpui_spike::workspace::chat::composer::{MessageSink, OutgoingMessage, SendAction};
use milagre_gpui_spike::workspace::sidebar::{ChatPatch, RecordingActions, SidebarActions, SidebarCall};

/// Where a composer send goes, as the Chat column stood when it was sent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target {
    /// The empty new-Chat screen: the runtime makes (or reuses its starter) Chat on this first send.
    NewChat,
    Existing(u64),
    /// No Chat of this runtime is on screen (nothing is sent).
    None,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Command {
    Send {
        target: Target,
        text: String,
        queue: bool,
        mode: PermissionMode,
        effort: Option<&'static str>,
    },
    Interrupt(u64),
    SendQueuedNow {
        chat: u64,
        id: String,
    },
    RemoveQueued {
        chat: u64,
        id: String,
    },
    MarkUnread {
        chat: u64,
        unread: bool,
    },
    /// Done (`true`, which also clears unread) or Reopen (`false`).
    MarkDone {
        chat: u64,
        done: bool,
    },
    /// An explicit title; empty puts the generated one back.
    Rename {
        chat: u64,
        title: String,
    },
    /// A send the runtime cannot take (attachments, `/compact`): shown as an error, nothing is sent.
    Refused(String),
}

pub fn wire_mode(mode: PermissionMode) -> WireMode {
    match mode {
        PermissionMode::Ask => WireMode::Ask,
        PermissionMode::Auto => WireMode::Auto,
        PermissionMode::Full => WireMode::Full,
    }
}

/// The composer's side, read when it calls.
#[derive(Clone)]
pub struct SinkState {
    pub target: Rc<Cell<Target>>,
    pub mode: Rc<Cell<PermissionMode>>,
    pub effort: Rc<Cell<Option<&'static str>>>,
}

impl Default for SinkState {
    fn default() -> Self {
        Self { target: Rc::new(Cell::new(Target::None)), mode: Rc::new(Cell::new(PermissionMode::Ask)), effort: Rc::new(Cell::new(None)) }
    }
}

pub struct LiveSink {
    pub state: SinkState,
    pub commands: UnboundedSender<Command>,
}

impl LiveSink {
    fn push(&self, command: Command) {
        let _ = self.commands.unbounded_send(command);
    }

    fn chat(&self) -> Option<u64> {
        match self.state.target.get() {
            Target::Existing(id) => Some(id),
            _ => None,
        }
    }
}

impl MessageSink for LiveSink {
    fn send(&self, message: OutgoingMessage) {
        if !message.files.is_empty() || !message.images.is_empty() {
            return self.push(Command::Refused("Attachments are not available on this runtime yet".into()));
        }
        if message.prompt.trim_start().starts_with("/compact") {
            return self.push(Command::Refused("Compact is not available on this runtime yet".into()));
        }
        let queue = matches!(message.delivery, SendAction::Queue | SendAction::Steer);
        self.push(Command::Send {
            target: self.state.target.get(),
            text: message.prompt,
            queue,
            mode: self.state.mode.get(),
            effort: self.state.effort.get(),
        });
    }

    fn stop(&self) {
        if let Some(chat) = self.chat() {
            self.push(Command::Interrupt(chat));
        }
    }

    fn send_queued_now(&self, id: &str) {
        if let Some(chat) = self.chat() {
            self.push(Command::SendQueuedNow { chat, id: id.to_owned() });
        }
    }

    fn remove_queued(&self, id: &str) {
        if let Some(chat) = self.chat() {
            self.push(Command::RemoveQueued { chat, id: id.to_owned() });
        }
    }
}

/// The id of a Chat key `<project>#<id>` of the owned Project.
pub fn chat_id(project: &str, key: &str) -> Option<u64> {
    let (scope, id) = key.rsplit_once('#')?;
    (scope == project).then(|| id.parse().ok()).flatten()
}

pub struct LiveSidebarActions {
    pub project: String,
    pub commands: UnboundedSender<Command>,
    pub recorded: Arc<RecordingActions>,
}

impl SidebarActions for LiveSidebarActions {
    fn call(&self, call: SidebarCall) {
        if let SidebarCall::Patch { chat, patch } = &call
            && let Some(id) = chat_id(&self.project, chat)
        {
            let command = match patch {
                ChatPatch::Unread(unread) => Some(Command::MarkUnread { chat: id, unread: *unread }),
                ChatPatch::DoneAt(at) => Some(Command::MarkDone { chat: id, done: at.is_some() }),
                ChatPatch::Title(title) => Some(Command::Rename { chat: id, title: title.to_string() }),
                _ => None,
            };
            if let Some(command) = command {
                let _ = self.commands.unbounded_send(command);
                return;
            }
        }
        self.recorded.call(call);
    }
}

/// Keeps the sink's state shared with the controller.
pub type Shared<T> = Rc<RefCell<T>>;

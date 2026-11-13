//! The UI's write seams as [`Command`]s for the controller, which runs them on the Chat actions.
//!
//! - [`LiveSink`] is the composer's `MessageSink`: a send (now or queued), Stop, and the queue's Send now and Remove.
//!   It is called inside the composer's update, so it reads what it needs from cells the controller keeps current:
//!   which Chat the composer is for ([`Target`]) and the permission mode and effort the picker shows.
//! - [`LiveSidebarActions`] is the sidebar's `SidebarActions`: unread, Done, Reopen and Rename go to the runtime (its
//!   `chat:patch` writes); every other call is recorded, as the fixture does, and changes nothing on the runtime.
//!
//! A Chat is named by [`ChatRef`] (its Project and id): one Project on the owned runtime, any of the daemon's.

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::Arc;

use futures::channel::mpsc::UnboundedSender;
use milagre_daemon_client::PermissionMode as WireMode;
use milagre_gpui_spike::data::{PermissionMode, Provider};
use milagre_gpui_spike::workspace::chat::composer::{MessageSink, OutgoingMessage, SendAction};
use milagre_gpui_spike::workspace::sidebar::{ChatPatch, RecordingActions, SidebarActions, SidebarCall};

/// One Chat: its Project (scope key on this computer) and its id there.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ChatRef {
    pub project: String,
    pub id: u64,
}

impl ChatRef {
    pub fn key(&self) -> String {
        format!("{}#{}", self.project, self.id)
    }
}

/// Where a composer send goes, as the Chat column stood when it was sent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    /// The empty new-Chat screen: the runtime makes (or reuses its starter) Chat on this first send.
    NewChat,
    Existing(ChatRef),
    /// No Chat of this runtime is on screen (nothing is sent).
    None,
}

/// A send's attachments as Electron's `chat:send` carries them (`executeSend`): `images` are `ImageAttachment`s
/// (`id`, `name`, `dataUrl`, and `path` for a chosen or dropped file), `files` the paths of chosen files (an image
/// file is in both, as `attachFiles` keeps it; a pasted image only in `images`), and the agent's `prompt` names the
/// files (`attachmentPrompt`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Attachments {
    pub images: Vec<serde_json::Value>,
    pub files: Vec<String>,
}

impl Attachments {
    pub fn of(message: &OutgoingMessage, client_id_seed: &str) -> Self {
        let mut files = Vec::new();
        let images = message
            .images
            .iter()
            .map(|image| {
                let mut value = serde_json::json!({
                    "id": format!("{client_id_seed}-image-{}", image.index),
                    "name": image.name.to_string(),
                    "dataUrl": image.data_url.clone().unwrap_or_default(),
                });
                if let Some(path) = &image.path {
                    value["path"] = serde_json::json!(path.display().to_string());
                    files.push(path.display().to_string());
                }
                value
            })
            .collect();
        files.extend(message.files.iter().filter_map(|file| file.path.as_ref().map(|path| path.display().to_string())));
        Self { images, files }
    }

    pub fn is_empty(&self) -> bool {
        self.images.is_empty() && self.files.is_empty()
    }

    /// Lays them on a `chat:send` request whose `body` is `body`.
    pub fn apply(&self, request: &mut serde_json::Value, body: &str) {
        if self.is_empty() {
            return;
        }
        request["images"] = serde_json::json!(self.images);
        request["files"] = serde_json::json!(self.files);
        request["prompt"] = serde_json::json!(attachment_prompt(body, &self.files));
    }
}

/// `attachmentPrompt` (`lib/media.ts`): what the agent reads for a message with attachments.
pub fn attachment_prompt(body: &str, files: &[String]) -> String {
    if files.is_empty() {
        return if body.is_empty() { "Describe the attached images.".into() } else { body.to_owned() };
    }
    let body = if body.is_empty() { "Please review the attached files." } else { body };
    format!("{body}\n\nAttached files:\n{}", files.join("\n"))
}

#[derive(Clone, Debug, PartialEq)]
pub enum Command {
    Send {
        target: Target,
        text: String,
        queue: bool,
        mode: PermissionMode,
        effort: Option<&'static str>,
        /// The composer's provider and model id (a new Chat starts on them in Node-daemon mode).
        model: (Provider, String),
        /// The new-Chat tray's choice at the send (Node-daemon mode sends where it says).
        new_chat: Option<Box<milagre_gpui_spike::workspace::chat::composer::new_chat::NewChatChoice>>,
        /// Its images and files (Node-daemon mode; the owned runtime refuses them).
        attachments: Attachments,
    },
    Interrupt(ChatRef),
    SendQueuedNow {
        chat: ChatRef,
        id: String,
    },
    RemoveQueued {
        chat: ChatRef,
        id: String,
    },
    MarkUnread {
        chat: ChatRef,
        unread: bool,
    },
    /// Done (`true`, which also clears unread) or Reopen (`false`).
    MarkDone {
        chat: ChatRef,
        done: bool,
    },
    /// An explicit title; empty puts the generated one back.
    Rename {
        chat: ChatRef,
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

/// The wire name of a permission mode (`chat:send`'s `permissionMode`).
pub fn wire_name(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::Ask => "ask",
        PermissionMode::Auto => "auto",
        PermissionMode::Full => "full",
    }
}

/// The composer's side, read when it calls.
#[derive(Clone)]
pub struct SinkState {
    pub target: Rc<RefCell<Target>>,
    pub mode: Rc<Cell<PermissionMode>>,
    pub effort: Rc<Cell<Option<&'static str>>>,
    pub model: Rc<RefCell<(Provider, String)>>,
}

impl Default for SinkState {
    fn default() -> Self {
        Self {
            target: Rc::new(RefCell::new(Target::None)),
            mode: Rc::new(Cell::new(PermissionMode::Ask)),
            effort: Rc::new(Cell::new(None)),
            model: Rc::new(RefCell::new((Provider::Claude, String::new()))),
        }
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

    fn chat(&self) -> Option<ChatRef> {
        match &*self.state.target.borrow() {
            Target::Existing(chat) => Some(chat.clone()),
            _ => None,
        }
    }
}

impl MessageSink for LiveSink {
    fn send(&self, message: OutgoingMessage) {
        if message.prompt.trim_start().starts_with("/compact") {
            return self.push(Command::Refused("Compact is not available on this runtime yet".into()));
        }
        let queue = matches!(message.delivery, SendAction::Queue | SendAction::Steer);
        let target = self.state.target.borrow().clone();
        // A new Chat starts on the picker's model; an open one keeps its own (the controller's, set when it opened).
        let model = match target {
            Target::NewChat => (message.provider, message.model.to_string()),
            _ => self.state.model.borrow().clone(),
        };
        let attachments = Attachments::of(&message, &format!("{}-{}", std::process::id(), crate::transcript::now_ms()));
        self.push(Command::Send {
            attachments,
            new_chat: message.new_chat,
            target,
            text: message.prompt,
            queue,
            // The permission mode the picker shows at the send.
            mode: message.permission,
            effort: self.state.effort.get(),
            model,
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

/// A Chat key `<project>#<id>` on this computer, split (no other computer's qualified keys).
pub fn split_key(key: &str) -> Option<(String, u64)> {
    let (scope, id) = key.rsplit_once('#')?;
    (scope.starts_with('/') && !scope.contains('|')).then_some(())?;
    Some((scope.to_owned(), id.parse().ok()?))
}

/// The Chat a key names: of `project` only (the owned runtime), or of any Project here (`None`, Node-daemon mode).
pub fn chat_ref(project: Option<&str>, key: &str) -> Option<ChatRef> {
    let (scope, id) = split_key(key)?;
    project.is_none_or(|project| project == scope).then_some(ChatRef { project: scope, id })
}

pub struct LiveSidebarActions {
    /// The owned Project; `None` takes a Chat of any Project (Node-daemon mode).
    pub project: Option<String>,
    pub commands: UnboundedSender<Command>,
    pub recorded: Arc<RecordingActions>,
}

impl SidebarActions for LiveSidebarActions {
    fn call(&self, call: SidebarCall) {
        if let SidebarCall::Patch { chat, patch } = &call
            && let Some(id) = chat_ref(self.project.as_deref(), chat)
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

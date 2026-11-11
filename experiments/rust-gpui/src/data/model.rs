//! Domain types, after `packages/shared/src/model.ts` (the shapes the daemon's state and messages have),
//! trimmed to what the UI reads. Plain data: no GPUI views, no async. `serde` is left out until a real
//! [`super::DataSource`] needs to decode the daemon's JSON.

use std::collections::HashMap;
use std::path::PathBuf;

use gpui::{Rgba, SharedString};

use crate::theme::hex;

/// The agent a Chat runs on (`ModelProvider`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Provider {
    Claude,
    Codex,
    Antigravity,
    Kiro,
}

impl Provider {
    pub const ALL: [Provider; 4] = [Provider::Claude, Provider::Codex, Provider::Antigravity, Provider::Kiro];

    /// The name the UI shows (`PROVIDER_NAMES`).
    pub fn name(self) -> &'static str {
        match self {
            Provider::Claude => "Claude",
            Provider::Codex => "Codex",
            Provider::Antigravity => "Antigravity",
            Provider::Kiro => "Kiro",
        }
    }

    /// The provider's identity colour (DESIGN.md: identity colours keep their meaning everywhere): the
    /// mark's fill, or the middle of its gradient.
    pub fn brand_color(self) -> Rgba {
        match self {
            Provider::Claude => hex("#d97757"),
            Provider::Codex => hex("#7a9dff"),
            Provider::Antigravity => hex("#3186ff"),
            Provider::Kiro => hex("#9046ff"),
        }
    }
}

/// What a scope key names: a Project's path, or a Link's key (`state:read`, `chat:messages`).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ScopeKey(pub SharedString);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProjectKind {
    /// A folder the user opened (a Git checkout, or a plain folder).
    Project,
    /// The Chats home: where Chats without a Project live ("Chats" in the list).
    ChatsHome,
}

/// An open Project (`project:current`, `project:open`, `project:read` without its state).
#[derive(Clone, Debug, PartialEq)]
pub struct Project {
    pub path: PathBuf,
    pub name: SharedString,
    pub kind: ProjectKind,
    /// Whether the folder is a Git repository (`git` in the reply).
    pub git: bool,
    /// The tile's identity colour; `None` draws the neutral tile. Stands in for a Project's image.
    pub color: Option<Rgba>,
}

impl Project {
    pub fn scope(&self) -> ScopeKey {
        ScopeKey(self.path.to_string_lossy().into_owned().into())
    }
}

pub type WorktreeId = u64;

/// One checkout of a Project (`Worktree`).
#[derive(Clone, Debug, PartialEq)]
pub struct Worktree {
    pub id: WorktreeId,
    pub path: PathBuf,
    /// The checked-out branch, or the folder name when HEAD is detached.
    pub name: SharedString,
    /// The ref a Worktree Milagre created started from.
    pub base: Option<SharedString>,
}

/// A Chat's number in its scope (`AgentSession.id`).
pub type ChatId = u64;

/// How a turn ended (`lastOutcome`, a message's `outcome`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Completed,
    Failed,
    Cancelled,
}

/// One Chat (`AgentSession` with its `ChatSummary`).
#[derive(Clone, Debug, PartialEq)]
pub struct Chat {
    pub id: ChatId,
    pub worktree: WorktreeId,
    /// `title`, else `generatedTitle`, else the first line the user wrote (`summary.titleLine`).
    pub title: SharedString,
    pub provider: Provider,
    /// A turn ended while the Chat wasn't open, or the user marked it unread.
    pub unread: bool,
    pub archived: bool,
    pub pinned: bool,
    /// How the last reply ended.
    pub last_outcome: Option<Outcome>,
    /// The PRs the Chat's commands created or merged, as numbers (`summary.pullRequests` are URLs).
    pub pull_requests: Vec<u32>,
    /// The computer the Chat runs on, by its name.
    pub computer: SharedString,
}

/// A Chat's live state from `chat:runs`: whether a turn is running and whether it waits on the user.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunState {
    Running,
    /// A tool call waits for Allow or Deny.
    WaitingApproval,
    /// The agent asked a question and waits for an answer.
    WaitingAnswer,
}

/// `chat:runs`: the live runs by Chat, and a sequence number that grows with every change.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ChatRuns {
    pub runs: HashMap<(ScopeKey, ChatId), RunState>,
    pub seq: u64,
}

/// The one mark a Chat row shows (DESIGN.md "Chat status marks"), most urgent first.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChatStatus {
    None,
    Running,
    NeedsApproval,
    Question,
    Failed,
    Unread,
}

impl ChatStatus {
    /// Needs you (approval, question) beats running, running beats a failed last turn, and that beats
    /// unread; an idle, read Chat shows nothing.
    pub fn of(chat: &Chat, run: Option<RunState>) -> Self {
        match run {
            Some(RunState::WaitingApproval) => ChatStatus::NeedsApproval,
            Some(RunState::WaitingAnswer) => ChatStatus::Question,
            Some(RunState::Running) => ChatStatus::Running,
            None if chat.last_outcome == Some(Outcome::Failed) => ChatStatus::Failed,
            None if chat.unread => ChatStatus::Unread,
            None => ChatStatus::None,
        }
    }
}

/// An open scope's state (`state:read`): its Worktrees and Chats. Messages come a page at a time from
/// `chat:messages`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ScopeState {
    pub worktrees: Vec<Worktree>,
    pub chats: Vec<Chat>,
}

/// A Project with or without its state (`project:read [path, { state }]`).
#[derive(Clone, Debug, PartialEq)]
pub struct ProjectSnapshot {
    pub project: Project,
    pub state: Option<ScopeState>,
}

pub type MessageId = u64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    User,
    Assistant,
}

/// One saved message (`ChatMessage`), trimmed: tool steps, images and context are not modelled yet.
#[derive(Clone, Debug, PartialEq)]
pub struct Message {
    pub id: MessageId,
    pub chat: ChatId,
    pub role: Role,
    /// Markdown for an assistant reply, plain text for the user's.
    pub body: SharedString,
    pub outcome: Option<Outcome>,
}

/// Which page of a Chat to read (`chat:messages` options): the `turns` user turns before `before`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PageRequest {
    pub before: Option<MessageId>,
    pub turns: usize,
    /// At most this many messages, whatever `turns` says.
    pub limit: usize,
}

impl Default for PageRequest {
    /// The newest 10 turns, at most 75 messages (`chatPage` in `packages/core/src/chat-pages.cjs`).
    fn default() -> Self {
        Self { before: None, turns: 10, limit: 75 }
    }
}

/// A page of messages, oldest first (`{ messages, hasMore, total }`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MessagePage {
    pub messages: Vec<Message>,
    pub has_more: bool,
    pub total: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UsageStatus {
    Ok,
    Unavailable,
    /// The last read failed; the numbers are the last known ones.
    Error,
}

/// One usage window of a provider (`UsageWindow`): "46% wk".
#[derive(Clone, Debug, PartialEq)]
pub struct UsageWindow {
    pub short_label: SharedString,
    pub used_percent: f32,
}

/// A provider's limits (`ProviderUsage`).
#[derive(Clone, Debug, PartialEq)]
pub struct ProviderUsage {
    pub provider: Provider,
    pub status: UsageStatus,
    pub windows: Vec<UsageWindow>,
}

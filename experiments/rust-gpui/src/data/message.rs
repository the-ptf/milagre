//! Saved messages and their pages: what `chat:messages` answers. Sources: `ChatMessage`, `ChatContext` and its
//! variants, `ChatStep`, `StepKind`, `ArtifactRef`, `ImageAttachment`, `AnsweredQuestion` in
//! `packages/shared/src/model.ts`; `MessageChanges` in `apps/desktop/app/src/electron.d.ts`; paging in
//! `packages/core/src/chat-pages.cjs` (`chatPage`).

use gpui::SharedString;

use super::chat::{ChatId, Millis, Outcome, StepKind};
use super::provider::Provider;

/// A message's id, unique in its scope and growing: a later message has a larger id.
pub type MessageId = u64;

/// `ChatMessage.role`. Absent on the wire is a user message.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Role {
    #[default]
    User,
    Assistant,
}

/// `ImageAttachment`: a persisted image has `path`; a draft or legacy one a `data_url`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImageAttachment {
    pub id: SharedString,
    pub name: SharedString,
    pub path: Option<SharedString>,
    pub data_url: Option<SharedString>,
    pub source_path: Option<SharedString>,
}

/// `AnsweredQuestion`: one question the user answered, kept on their answer message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AnsweredQuestion {
    pub header: SharedString,
    pub question: SharedString,
    pub answers: Vec<SharedString>,
}

/// `ChatStep.status`: saved steps are done or failed; only a streaming reply has running ones.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum StepStatus {
    Running,
    #[default]
    Done,
    Failed,
}

/// `ArtifactRef`: a design or HTML page an agent showed, and the version this step made.
#[derive(Clone, Debug, PartialEq)]
pub struct ArtifactRef {
    pub id: SharedString,
    pub version: u64,
    pub title: SharedString,
    /// `"design" | "html"`; older entries have none.
    pub format: Option<SharedString>,
    pub inline: bool,
    pub height: Option<f32>,
    pub group: Option<SharedString>,
}

/// `ChatStep`: one tool call of a reply (a command, an edit, a read, a search, another tool), or its thinking.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ChatStep {
    pub id: SharedString,
    pub kind: Option<StepKind>,
    /// What it did, e.g. "Ran `npm test`"; text between backticks is code.
    pub title: SharedString,
    pub status: StepStatus,
    pub started_at: Option<Millis>,
    pub ended_at: Option<Millis>,
    /// MCP identity: `source.name` and `source.server`.
    pub source_name: Option<SharedString>,
    pub source_server: Option<SharedString>,
    /// Bounded, redacted arguments for the detail panel.
    pub input: Option<SharedString>,
    pub summary: Option<SharedString>,
    pub error: Option<SharedString>,
    /// The command and its output, a unified diff, or the thinking summary, capped at 20,000 characters.
    pub detail: Option<SharedString>,
    /// The detail is left out and kept elsewhere (`chat:message` reads it).
    pub has_detail: bool,
    /// The file a read or edit worked on; for an image step, its image.
    pub file: Option<SharedString>,
    /// Muted text after the title, e.g. "3s" or "exited with code 1 after 4s".
    pub note: Option<SharedString>,
    pub duration_ms: Option<u64>,
    /// Where the step sits in the reply: the length of the reply's text when it started (UTF-16 units).
    pub offset: Option<usize>,
    pub artifact: Option<ArtifactRef>,
    /// For an artifact step, the Milagre tool it called (`design_show`, `html_render`, ...).
    pub tool: Option<SharedString>,
    /// For a step a subagent made, the subagent's id.
    pub agent: Option<SharedString>,
}

/// `HandoffContext.status` and `CompactionContext.status`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DividerStatus {
    Preparing,
    Done,
    Failed,
}

/// `ChatContext`: what a message no person typed in this Chat is, or `None` for one they did. The kinds the
/// transcript draws are typed; every other kind keeps its `kind` and its whole JSON object in [`ChatContext::Other`]
/// so an adapter loses nothing (`advisor-result`, `worktree-linked`, `negotiation-agreement`, `linked-notice`,
/// `babysit-stopped`, `checkpoint-restore`, the `subchat-*` kinds, ...).
#[derive(Clone, Debug, PartialEq)]
pub enum ChatContext {
    /// `{ kind: "handoff" }`: a provider switch, drawn as a divider before the message that caused it.
    Handoff { from: Provider, to: Provider, from_model: Option<SharedString>, to_model: Option<SharedString>, status: DividerStatus },
    /// `{ kind: "compaction" }`: a manual or automatic compaction, a divider; token counts around it.
    Compaction { automatic: bool, status: DividerStatus, before: Option<u64>, after: Option<u64>, size: Option<u64> },
    /// `{ kind: "reload" }`: where the user reloaded the Chat's agent.
    Reload,
    /// `{ kind: "git-action" }`: the commit dialog wrote it.
    GitAction,
    /// `{ kind: "pr-action" }`: a PR-blocker pill the user clicked (`action` is the blocker's key).
    PullRequestAction { action: SharedString, pr: u32, url: SharedString },
    /// `{ kind: "linear-issue" }`: a Chat started from a Linear issue.
    LinearIssue { key: SharedString, title: SharedString, url: SharedString, state: SharedString, note: Option<SharedString> },
    /// `{ kind: "routine-run" }`: the divider a Routine's Run leaves; `quiet` once the reply was a "(pass)".
    RoutineRun { routine_id: SharedString, run_id: SharedString, name: SharedString, at: Millis, label: Option<SharedString>, quiet: bool },
    /// `{ kind: "limit" }`: a reply the plan's usage limit stopped.
    Limit { provider: Provider, account_id: Option<SharedString>, window: Option<SharedString>, resets_at: Option<SharedString> },
    /// `{ kind: "account-switch" }`: the message that continued on another account.
    AccountSwitch { provider: Provider, label: SharedString },
    /// `{ kind: "limit-reset" }`.
    LimitReset,
    /// `{ kind: "delegation" }`: a Delegation from another Chat (`from` is null for another computer's).
    Delegation { delegation_id: SharedString, from: Option<SharedString>, from_label: SharedString },
    /// `{ kind: "delegation-report" }`: a Delegation's report coming back.
    DelegationReport { delegation_id: SharedString, from: Option<SharedString>, from_label: SharedString, status: SharedString },
    /// The legacy `"handover"` string.
    Handover,
    /// Any other kind, as sent.
    Other { kind: SharedString, raw: serde_json::Value },
}

impl ChatContext {
    /// The wire's `kind`.
    pub fn kind(&self) -> &str {
        match self {
            ChatContext::Handoff { .. } => "handoff",
            ChatContext::Compaction { .. } => "compaction",
            ChatContext::Reload => "reload",
            ChatContext::GitAction => "git-action",
            ChatContext::PullRequestAction { .. } => "pr-action",
            ChatContext::LinearIssue { .. } => "linear-issue",
            ChatContext::RoutineRun { .. } => "routine-run",
            ChatContext::Limit { .. } => "limit",
            ChatContext::AccountSwitch { .. } => "account-switch",
            ChatContext::LimitReset => "limit-reset",
            ChatContext::Delegation { .. } => "delegation",
            ChatContext::DelegationReport { .. } => "delegation-report",
            ChatContext::Handover => "handover",
            ChatContext::Other { kind, .. } => kind,
        }
    }

    /// A divider of its own in the transcript (a handoff, a compaction, a reload, a Routine's Run, an account
    /// switch) rather than a bubble.
    pub fn is_divider(&self) -> bool {
        matches!(
            self,
            ChatContext::Handoff { .. }
                | ChatContext::Compaction { .. }
                | ChatContext::Reload
                | ChatContext::RoutineRun { .. }
                | ChatContext::AccountSwitch { .. }
                | ChatContext::LimitReset
        )
    }
}

/// One saved message (`ChatMessage`).
#[derive(Clone, Debug, PartialEq)]
pub struct ChatMessage {
    pub id: MessageId,
    /// Matches a local send preview to the saved message.
    pub client_message_id: Option<SharedString>,
    /// `session_id`: the Chat it belongs to.
    pub chat: ChatId,
    /// Markdown for an assistant reply, plain text for the user's.
    pub body: SharedString,
    /// `context`: `None` for a message a person typed.
    pub context: Option<ChatContext>,
    pub role: Role,
    pub model: Option<SharedString>,
    pub images: Vec<ImageAttachment>,
    /// Paths of the files attached.
    pub files: Vec<SharedString>,
    /// How the turn that produced this reply ended.
    pub outcome: Option<Outcome>,
    /// The tool calls and thinking of this reply, in the order they started.
    pub steps: Vec<ChatStep>,
    /// Kiro only: what the turn cost, in credits.
    pub credits: Option<f64>,
    /// On the user's answers to an agent's questions: each question with what they answered.
    pub answered: Vec<AnsweredQuestion>,
}

impl ChatMessage {
    /// A message with only its text: no context, images, files or steps.
    pub fn text(id: MessageId, chat: ChatId, role: Role, body: impl Into<SharedString>) -> ChatMessage {
        ChatMessage {
            id,
            client_message_id: None,
            chat,
            body: body.into(),
            context: None,
            role,
            model: None,
            images: Vec::new(),
            files: Vec::new(),
            outcome: None,
            steps: Vec::new(),
            credits: None,
            answered: Vec::new(),
        }
    }
}

/// Which page of a Chat to read (`chat:messages [scope, chatId, { before, turns, limit }]`): going back `turns`
/// of the user's messages before `before` (from the end when `None`), at most `limit` messages.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PageRequest {
    pub before: Option<MessageId>,
    pub turns: usize,
    pub limit: usize,
}

impl PageRequest {
    /// The first page the desktop reads when a Chat opens (`{ turns: 20 }` in `lib/chat-messages.ts`; the
    /// limit is the host's default).
    pub const OPEN: PageRequest = PageRequest { before: None, turns: 20, limit: 75 };

    /// The page before `first`, the oldest message held (`loadEarlier`: `{ before, turns: 20 }`).
    pub fn before(first: MessageId) -> PageRequest {
        PageRequest { before: Some(first), ..PageRequest::OPEN }
    }
}

impl Default for PageRequest {
    /// The host's defaults: 10 turns, at most 75 messages (`chatPage`).
    fn default() -> Self {
        Self { before: None, turns: 10, limit: 75 }
    }
}

/// A page of messages, oldest first (`{ messages, hasMore, total }`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MessagePage {
    pub messages: Vec<ChatMessage>,
    /// Older messages remain before the first.
    pub has_more: bool,
    /// How many messages the Chat has.
    pub total: usize,
}

/// `MessageChanges`, on a state event to a client that reads messages by Chat: the messages a change added or
/// changed (each after the message before it in its Chat, `None` for the first) and the ids it removed.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MessageChanges {
    pub changed: Vec<(ChatMessage, Option<MessageId>)>,
    pub removed: Vec<MessageId>,
}

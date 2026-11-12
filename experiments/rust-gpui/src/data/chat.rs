//! A Chat as its scope's state carries it: `AgentSession` with its `ChatSummary`, subagents, background tasks,
//! queue and the flags the lists read. Source: `packages/shared/src/model.ts` (`AgentSession`, `ChatSummary`,
//! `Subagent`, `AgentTask`, `BackgroundTask`, `QueuedMessage`, `ContextUsage`, `PermissionMode`, `SessionStatus`).
//!
//! The rules over these (title, listing, order, pins, Done, families, activity, mark) are the shared logic's, in
//! `src/logic`; `edge.rs` turns a [`Chat`] into each rule's input.

use gpui::SharedString;

use super::project::WorktreeId;
use super::provider::Provider;

pub use crate::logic::activity::subagent_glance::{
    Entry as SubagentTranscriptEntry, EntryKind as TranscriptEntryKind, Progress as SubagentProgress, StepKind, TaskStatus,
};
/// `ContextUsage`: tokens in the agent's context window, out of the model's window size.
pub use crate::logic::lists::chat_display::ContextUsage;

/// A Chat's number in its scope (`AgentSession.id`); Chat keys are `<scope>#<id>`.
pub type ChatId = u64;

/// Milliseconds since the epoch, as the host stamps times (`Date.now()`).
pub type Millis = i64;

/// `SessionStatus`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SessionStatus {
    #[default]
    Created,
    Running,
    Stopped,
}

/// How a turn ended (`ChatSummary.lastOutcome`, `ChatMessage.outcome`): `"completed" | "failed" | "cancelled"`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Completed,
    Failed,
    Cancelled,
}

impl Outcome {
    pub fn key(self) -> &'static str {
        match self {
            Outcome::Completed => "completed",
            Outcome::Failed => "failed",
            Outcome::Cancelled => "cancelled",
        }
    }
}

/// `PermissionMode`: `"ask" | "auto" | "full"`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PermissionMode {
    #[default]
    Ask,
    Auto,
    Full,
}

/// `ChatSummary`: what the lists need from a Chat's messages, kept on the Chat by the host (`chat-summary.mjs`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ChatSummary {
    pub count: usize,
    /// The first and last message in the Project's order: when the Chat started, and its latest activity.
    pub first_id: Option<u64>,
    pub last_id: Option<u64>,
    /// When the Chat last got a message or a reply ended; absent on a host that doesn't keep it.
    pub last_at: Option<Millis>,
    /// When the Chat got its first message; absent on a Chat that began before the host kept it.
    pub first_at: Option<Millis>,
    /// The first line of the first thing the user wrote, which names a Chat that has no title.
    pub title_line: Option<SharedString>,
    /// How many images that first message carried; absent when none or not counted.
    pub title_images: Option<usize>,
    pub last_outcome: Option<Outcome>,
    /// `pullRequests`: URLs of the PRs the Chat's commands created or merged.
    pub pull_requests: Vec<SharedString>,
    /// The model of the last message the user sent.
    pub last_model: Option<SharedString>,
    /// A handoff divider still preparing, by message id.
    pub open_handoff: Option<u64>,
    /// The Linear issue the Chat's first message is the card of.
    pub linear_issue: Option<SharedString>,
    pub linear_workspace: Option<SharedString>,
}

/// `Subagent.status`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SubagentStatus {
    Initializing,
    Running,
    Waiting,
    Completed,
    Failed,
    Cancelled,
    #[default]
    Unknown,
}

impl SubagentStatus {
    pub fn key(self) -> &'static str {
        match self {
            SubagentStatus::Initializing => "initializing",
            SubagentStatus::Running => "running",
            SubagentStatus::Waiting => "waiting",
            SubagentStatus::Completed => "completed",
            SubagentStatus::Failed => "failed",
            SubagentStatus::Cancelled => "cancelled",
            SubagentStatus::Unknown => "unknown",
        }
    }
}

/// `AgentTask`: one item of an agent's own to-do list.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentTask {
    pub id: SharedString,
    pub content: SharedString,
    pub active_form: Option<SharedString>,
    pub status: TaskStatus,
}

/// `Subagent`: a subagent or a Milagre advisor working for the Chat. A lean state sends only the transcript's tail
/// (`transcript_length` says how long it is); an archived one comes as a summary (`details_on_demand`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Subagent {
    pub id: SharedString,
    /// `"milagre-advisor"` for an advisor.
    pub source: Option<SharedString>,
    /// An advisor's `"analysis" | "execution"`.
    pub mode: Option<SharedString>,
    pub provider: Option<Provider>,
    pub model: Option<SharedString>,
    pub retryable: bool,
    pub archived: bool,
    pub parent_id: Option<SharedString>,
    /// Launched to run in the background: its result wakes the Chat with a turn of its own.
    pub background: bool,
    /// The agent type it was launched as (Claude's `subagent_type`).
    pub agent_type: Option<SharedString>,
    pub title: SharedString,
    pub prompt: Option<SharedString>,
    pub status: SubagentStatus,
    pub started_at: Millis,
    pub updated_at: Millis,
    pub ended_at: Option<Millis>,
    pub latest_activity: Option<SharedString>,
    pub tasks: Vec<AgentTask>,
    pub progress: Option<SubagentProgress>,
    pub transcript: Vec<SubagentTranscriptEntry>,
    pub transcript_length: Option<usize>,
    pub details_on_demand: bool,
}

/// `BackgroundTask`: background work the agent's process runs besides its subagents (`kind` is the provider's own
/// name: `local_bash`, `local_workflow`, `mcp_task`, ...).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BackgroundTask {
    pub id: SharedString,
    pub kind: SharedString,
    pub title: SharedString,
    pub started_at: Millis,
}

/// `AgentSession.routine`: the Routine and Run that started this Chat. `hidden` keeps it out of every list until
/// it waits on an approval or question; absent on a Chat made before Run Chats were hidden.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoutineRef {
    pub routine_id: SharedString,
    pub run_id: SharedString,
    pub hidden: Option<bool>,
}

/// `QueuedMessage`: a message waiting for a later turn, oldest first.
#[derive(Clone, Debug, PartialEq)]
pub struct QueuedMessage {
    pub id: SharedString,
    pub body: SharedString,
    pub files: Vec<SharedString>,
    pub model: SharedString,
    pub provider: Provider,
    pub queued_at: Millis,
    pub client_message_id: Option<SharedString>,
}

/// `AgentSession.suggestion`: Claude's predicted follow-up.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Suggestion {
    pub text: SharedString,
    pub turn_id: SharedString,
}

/// `AgentSession.formerWorktree`: the Worktree a Run's Chat had before Milagre removed it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FormerWorktree {
    pub path: SharedString,
    pub name: SharedString,
    pub branch: Option<SharedString>,
}

/// One Chat (`AgentSession`). Optional booleans the wire leaves out are `false`, as the TypeScript's
/// `Boolean(undefined)` reads them.
#[derive(Clone, Debug, PartialEq)]
pub struct Chat {
    pub id: ChatId,
    /// `worktree_id`: the Worktree the Chat works in, in its scope's state.
    pub worktree_id: WorktreeId,
    /// `agent_name`: the title of last resort.
    pub agent_name: SharedString,
    pub status: SessionStatus,
    /// Kept by the host from the Chat's messages; absent from an older host.
    pub summary: Option<ChatSummary>,
    /// `provider` as sent: absent on a Chat saved before providers were recorded ([`Chat::provider`] reads it).
    pub provider_id: Option<SharedString>,
    pub native_session_id: Option<SharedString>,
    pub subagents: Vec<Subagent>,
    /// `backgroundTasks`, live while the agent's process runs.
    pub background_tasks: Vec<BackgroundTask>,
    pub generated_title: Option<SharedString>,
    pub title_pending: bool,
    /// A name the user gave the Chat.
    pub title: Option<SharedString>,
    /// A turn ended while the Chat wasn't open, or the user marked it unread.
    pub unread: bool,
    /// Hidden from the Chat lists.
    pub archived: bool,
    /// In the Pinned section, in `pin_order` (shared pins; this device's own come from `logic::lists::pins`).
    pub pinned: bool,
    pub pin_order: Option<f64>,
    /// `done_at`: when the user marked it Done (host clock); it sits in the Done list until archived.
    pub done_at: Option<Millis>,
    /// Legacy handover (before in-place handoff), read only.
    pub handed_over_to: Option<ChatId>,
    pub handed_over_from: Option<ChatId>,
    pub handover_pending: bool,
    pub handover_draft: Option<SharedString>,
    /// `resumeTurn.stoppedAt`: a quit stopped this Chat's turn (`Some(None)` when the time is unknown).
    pub resume_turn: Option<Option<Millis>>,
    pub context_usage: Option<ContextUsage>,
    pub suggestion: Option<Suggestion>,
    /// The Routine Run that made this Chat.
    pub routine: Option<RoutineRef>,
    pub former_worktree: Option<FormerWorktree>,
    pub permission_mode: Option<PermissionMode>,
    /// The Chat (same scope) whose Delegation first reached this one: it is that Chat's Subchat.
    pub parent: Option<ChatId>,
    pub queued: Vec<QueuedMessage>,
    pub queue_held: bool,
    /// `plan`: the Chat's task list and phase history (the Tasks pill), set by the agent's tasks and phase tools.
    pub plan: Option<crate::logic::plan::ChatPlan>,
    /// `limitTurn.sourceMessageId`: the reply a plan's usage limit stopped, which "Continue at" may schedule.
    pub limit_turn: Option<u64>,
    /// `limitResume`: a continuation scheduled for when the limit resets.
    pub limit_resume: Option<LimitResume>,
}

/// `LimitResume`: when a stopped reply continues, and the send that will do it.
#[derive(Clone, Debug, PartialEq)]
pub struct LimitResume {
    pub at: SharedString,
    pub source_message_id: u64,
    pub send_id: SharedString,
}

impl Chat {
    /// A Chat with only its identity set: no summary, nothing flagged.
    pub fn new(id: ChatId, worktree_id: WorktreeId, agent_name: impl Into<SharedString>) -> Chat {
        Chat {
            id,
            worktree_id,
            agent_name: agent_name.into(),
            status: SessionStatus::Created,
            summary: None,
            provider_id: None,
            native_session_id: None,
            subagents: Vec::new(),
            background_tasks: Vec::new(),
            generated_title: None,
            title_pending: false,
            title: None,
            unread: false,
            archived: false,
            pinned: false,
            pin_order: None,
            done_at: None,
            handed_over_to: None,
            handed_over_from: None,
            handover_pending: false,
            handover_draft: None,
            resume_turn: None,
            context_usage: None,
            suggestion: None,
            routine: None,
            former_worktree: None,
            permission_mode: None,
            parent: None,
            queued: Vec::new(),
            queue_held: false,
            plan: None,
            limit_turn: None,
            limit_resume: None,
        }
    }

    /// The provider the Chat is on now; absent or unknown is Claude.
    pub fn provider(&self) -> Provider {
        Provider::of_session(self.provider_id.as_deref())
    }

    /// `summary.lastOutcome`.
    pub fn last_outcome(&self) -> Option<Outcome> {
        self.summary.as_ref().and_then(|summary| summary.last_outcome)
    }
}

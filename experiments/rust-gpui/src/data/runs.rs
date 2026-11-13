//! Live turns: what `chat:runs` answers (`{ runs, seq }`), with the approval and question requests a turn waits on.
//! Sources: `AgentRun`, `AgentRuns` in `packages/shared/src/agent-runs.d.mts`; `PermissionRequest`,
//! `QuestionRequest`, `AgentQuestion`, `QuestionOption`, `PermissionDecision` in `packages/shared/src/model.ts`.
//!
//! The streaming reducer that folds `agent:event`s into runs (`agent-runs.mjs`) is WP-06's; these are its results.

use std::collections::BTreeMap;

use gpui::SharedString;

use super::chat::{ContextUsage, Millis, PermissionMode};
use super::message::ChatStep;

pub use crate::logic::activity::subchat_states::{AgentQuestion, QuestionOption};

/// `PermissionRequest.kind`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PermissionKind {
    Command,
    Edit,
    #[default]
    Other,
    Delegation,
    Setup,
}

/// `PermissionRequest.delegation`: where a Delegation goes and what it says.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DelegationTarget {
    /// "Project / branch / Chat".
    pub target: SharedString,
    pub message: SharedString,
    pub negotiation: bool,
    pub computer: Option<SharedString>,
}

/// `PermissionRequest`: what an agent asks to do, as the approval card shows it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PermissionRequest {
    pub request_id: SharedString,
    pub kind: PermissionKind,
    /// Short name of the tool: "Bash", "Shell", "Edit files".
    pub tool: SharedString,
    pub title: SharedString,
    pub description: Option<SharedString>,
    pub command: Option<SharedString>,
    pub cwd: Option<SharedString>,
    /// A unified diff (or the new content), capped at 20,000 characters.
    pub diff: Option<SharedString>,
    pub files: Vec<SharedString>,
    /// The tool's raw input, for tools that are neither commands nor edits.
    pub detail: Option<SharedString>,
    pub reason: Option<SharedString>,
    /// Whether "Always allow in this chat" can be offered.
    pub allow_for_chat: bool,
    /// The tool step this request is about.
    pub step_id: Option<SharedString>,
    pub delegation: Option<DelegationTarget>,
}

/// `QuestionRequest.secretRequest`: a host-owned request for a secret.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SecretRequest {
    pub description: SharedString,
    pub expires_at: Option<Millis>,
}

/// `QuestionRequest.bugReport`: a Milagre bug report waiting for approval of its redacted text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BugReport {
    pub repo: SharedString,
    pub title: SharedString,
    pub body: SharedString,
    pub expires_at: Option<Millis>,
    pub redactions: Option<u32>,
    pub recheck: bool,
}

/// `QuestionRequest`: questions a turn waits on, asked together (or a secret or bug-report request).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct QuestionRequest {
    pub request_id: SharedString,
    pub secret_request: Option<SecretRequest>,
    pub bug_report: Option<BugReport>,
    pub questions: Vec<AgentQuestion>,
}

/// What was sent for a request until the agent takes it (`SentAnswer`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SentAnswer {
    Allow,
    AllowForChat,
    Deny,
    Answered,
    Dismissed,
}

/// `AgentRun`: a turn streaming in a Chat.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AgentRun {
    /// The provider turn whose completion can supply a follow-up suggestion.
    pub turn_id: Option<SharedString>,
    pub text: SharedString,
    pub model: SharedString,
    pub permission_mode: Option<PermissionMode>,
    /// When the turn began; older hosts omit it.
    pub started_at: Option<Millis>,
    /// Tool steps in the order they started; each one's `offset` is where it sits in `text`.
    pub steps: Vec<ChatStep>,
    /// Approval requests the turn waits on, oldest first.
    pub approvals: Vec<PermissionRequest>,
    /// Questions the turn waits on, oldest first.
    pub questions: Vec<QuestionRequest>,
    /// What was sent for each approval or question, by request id, until the agent takes it.
    pub answered: BTreeMap<SharedString, SentAnswer>,
    pub split: bool,
    pub steered: bool,
    /// The agent waits on its subagents, so the indicator says so instead of "Working".
    pub waiting_for_subagents: bool,
    pub context_usage: Option<ContextUsage>,
}

impl AgentRun {
    /// `runStatus`: waiting while an approval or question is open, else working.
    pub fn waiting(&self) -> bool {
        !self.approvals.is_empty() || !self.questions.is_empty()
    }
}

/// `chat:runs`: every live turn on one computer by Chat key (`<scope>#<id>`, computer-qualified by the caller for
/// another computer's), and the runs sequence. An `agent:event` whose `seq` is at or below `seq` is already in these
/// runs and is skipped (`useAgentRuns`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ChatRuns {
    pub runs: BTreeMap<String, AgentRun>,
    pub seq: u64,
}

impl ChatRuns {
    pub fn get(&self, chat_key: &str) -> Option<&AgentRun> {
        self.runs.get(chat_key)
    }

    /// The runs of several computers as one map; the highest `seq` is kept only as a hint (each computer numbers
    /// its own events, so a real store keeps one `seq` per computer).
    pub fn merge(all: impl IntoIterator<Item = ChatRuns>) -> ChatRuns {
        let mut merged = ChatRuns::default();
        for runs in all {
            merged.seq = merged.seq.max(runs.seq);
            merged.runs.extend(runs.runs);
        }
        merged
    }
}

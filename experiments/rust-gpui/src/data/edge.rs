//! The edge between the domain types and the shared logic: each `src/logic` rule takes a small input struct of
//! its own (what the TypeScript function reads), and these methods build it from the one domain type that holds
//! the field. The logic modules stay pure ports with their own tests; the data types stay the single source.

use crate::logic::activity::attention::{WaitingApproval, WaitingRun};
use crate::logic::activity::subchat_states::{ApprovalRequest, QuestionRequest as SubchatQuestionRequest, SubchatRun};
use crate::logic::identity::project_list::RecentProject;
use crate::logic::lists::chats::{
    ListSession, PinOrder, RoutineHidden, TitleMessage, TitleSession, TitleSummary, chat_title, is_handover_chat, is_listed_chat,
};
use crate::logic::lists::done::{DoneChat, is_done};
use crate::logic::lists::order::ChatSortKey;
use crate::logic::lists::pins::Pinnable;
use crate::logic::lists::subchats::FamilySession;
use crate::logic::marks::activity::{
    ActivitySession, BackgroundTask as ActivityTask, ChatActivity, RunState as ActivityRun, Subagent as ActivitySubagent, chat_activity,
};

use super::{AgentRun, BackgroundTask, Chat, ChatMessage, PermissionRequest, Project, QuestionRequest, Role, Subagent};

impl Chat {
    /// What `chatTitle` reads.
    pub fn title_session(&self) -> TitleSession<'_> {
        TitleSession {
            title: self.title.as_deref(),
            generated_title: self.generated_title.as_deref(),
            summary: self
                .summary
                .as_ref()
                .map(|summary| TitleSummary { title_line: summary.title_line.as_deref(), title_images: summary.title_images }),
            agent_name: &self.agent_name,
        }
    }

    /// The Chat's name (`chatTitle`): its own, else the first line of its first message from the summary, else the
    /// agent's name. `messages` is read only for a Chat whose host keeps no summary.
    pub fn display_title(&self, messages: &[ChatMessage]) -> String {
        let messages: Vec<TitleMessage> =
            messages.iter().filter(|message| message.chat == self.id).map(ChatMessage::title_message).collect();
        chat_title(&self.title_session(), &messages)
    }

    pub fn routine_hidden(&self) -> Option<RoutineHidden> {
        self.routine.as_ref().map(|routine| RoutineHidden { hidden: routine.hidden })
    }

    /// What `isChatListed` reads.
    pub fn list_session(&self) -> ListSession {
        ListSession {
            handover_pending: self.handover_pending,
            has_handover_draft: self.handover_draft.is_some(),
            routine: self.routine_hidden(),
        }
    }

    /// `isChatListed`: shown once it has a message (or a handover prepares it); a hidden Run Chat only while
    /// `waiting` (its turn waits on an approval or question). Archived Chats are the caller's to leave out.
    pub fn is_listed(&self, waiting: bool) -> bool {
        is_listed_chat(&self.list_session(), self.summary.as_ref().map_or(0, |summary| summary.count), waiting)
    }

    pub fn is_handover(&self) -> bool {
        is_handover_chat(&self.list_session())
    }

    /// What `comparePins` reads.
    pub fn pin(&self) -> PinOrder {
        PinOrder { pinned: self.pinned, pin_order: self.pin_order }
    }

    /// What `orderChats` reads: the pin and the summary's first and last message ids.
    pub fn sort_key(&self) -> ChatSortKey {
        let summary = self.summary.as_ref();
        ChatSortKey {
            pin: self.pin(),
            first_id: summary.and_then(|summary| summary.first_id).map(|id| id as i64),
            last_id: summary.and_then(|summary| summary.last_id).map(|id| id as i64),
        }
    }

    /// What the Done rules read.
    pub fn done_chat(&self) -> DoneChat {
        DoneChat { done_at: self.done_at, archived: self.archived }
    }

    /// In the Done list: marked Done and not archived yet.
    pub fn is_done(&self) -> bool {
        is_done(&self.done_chat())
    }

    /// What the Subchat family rules read.
    pub fn family(&self) -> FamilySession {
        FamilySession { id: self.id, parent: self.parent, archived: self.archived, done_at: self.done_at }
    }

    /// What `chat-activity.mjs` reads.
    pub fn activity_session(&self) -> ActivitySession {
        ActivitySession {
            provider: self.provider_id.as_ref().map(ToString::to_string),
            native_session_id: self.native_session_id.as_ref().map(ToString::to_string),
            subagents: self.subagents.iter().map(Subagent::activity).collect(),
            background_tasks: self.background_tasks.iter().map(BackgroundTask::activity).collect(),
            last_outcome: self.last_outcome().map(|outcome| outcome.key().to_owned()),
        }
    }

    /// `chatActivity`: what the Chat is doing given its live run (if any), with its background work.
    pub fn activity(&self, run: Option<&AgentRun>) -> ChatActivity {
        chat_activity(&self.activity_session(), run.map(AgentRun::activity_run), None)
    }
}

/// The pin rules (`chat-pins.ts`) run on Chats directly.
impl Pinnable for Chat {
    fn id(&self) -> u64 {
        self.id
    }

    fn pinned(&self) -> bool {
        self.pinned
    }

    fn pin_order(&self) -> Option<f64> {
        self.pin_order
    }

    fn with_pin_state(&self, pinned: bool, pin_order: Option<f64>) -> Self {
        Chat { pinned, pin_order, ..self.clone() }
    }
}

impl Subagent {
    pub fn activity(&self) -> ActivitySubagent {
        ActivitySubagent {
            id: self.id.to_string(),
            title: self.title.to_string(),
            status: Some(self.status.key().to_owned()),
            background: self.background,
            source: self.source.as_ref().map(ToString::to_string),
            started_at: Some(self.started_at as f64),
        }
    }
}

impl BackgroundTask {
    pub fn activity(&self) -> ActivityTask {
        ActivityTask {
            id: self.id.to_string(),
            kind: self.kind.to_string(),
            title: self.title.to_string(),
            started_at: Some(self.started_at as f64),
        }
    }
}

impl ChatMessage {
    /// What `chatTitle` reads of a message.
    pub fn title_message(&self) -> TitleMessage<'_> {
        TitleMessage { is_assistant: self.role == Role::Assistant, body: &self.body, images: self.images.len() }
    }
}

impl PermissionRequest {
    /// What the Subchat pill reads.
    pub fn approval(&self) -> ApprovalRequest {
        ApprovalRequest { request_id: self.request_id.to_string(), title: self.title.to_string() }
    }

    /// What `waitingFor` reads.
    pub fn waiting(&self) -> WaitingApproval {
        WaitingApproval { title: self.title.to_string(), command: self.command.as_ref().map(ToString::to_string) }
    }
}

impl QuestionRequest {
    pub fn subchat(&self) -> SubchatQuestionRequest {
        SubchatQuestionRequest { request_id: self.request_id.to_string(), questions: self.questions.clone() }
    }
}

impl AgentRun {
    /// What `chatActivity` reads of a run.
    pub fn activity_run(&self) -> ActivityRun {
        ActivityRun { approvals: self.approvals.len(), questions: self.questions.len() }
    }

    /// What `subchatState` reads of a Subchat's run.
    pub fn subchat_run(&self) -> SubchatRun {
        SubchatRun {
            text: Some(self.text.to_string()),
            started_at: self.started_at,
            approvals: self.approvals.iter().map(PermissionRequest::approval).collect(),
            questions: self.questions.iter().map(QuestionRequest::subchat).collect(),
            answered: self.answered.keys().map(ToString::to_string).collect(),
        }
    }

    /// What `waitingFor` and `chatsNeedingAttention` read.
    pub fn waiting_run(&self) -> WaitingRun {
        WaitingRun {
            approvals: self.approvals.iter().map(PermissionRequest::waiting).collect(),
            questions: self
                .questions
                .iter()
                .map(|request| request.questions.iter().map(|question| question.question.clone()).collect())
                .collect(),
        }
    }
}

impl Project {
    /// The Project as the recent list keeps it (`RecentProject`), for `projectRows` and `newChatProject`.
    pub fn recent(&self) -> RecentProject {
        RecentProject {
            path: self.path.to_string(),
            name: self.name.to_string(),
            opened_at: self.opened_at.as_ref().map(ToString::to_string).unwrap_or_default(),
            hidden: self.hidden,
            origin: self.origin.as_ref().map(ToString::to_string),
        }
    }
}

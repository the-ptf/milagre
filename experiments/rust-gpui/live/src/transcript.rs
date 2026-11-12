//! Saved messages and live requests as the base transcript's items.
//!
//! A user message is `Item::User`; a reply is its tool steps (`Item::Step`, oldest first) then its text
//! (`Item::Prose`, left out when empty). Message contexts have no card of their own here yet: their body shows as
//! the user's text. A live approval is `Item::Approval` (its step from the run when the run has it), a live
//! question the question card.

use milagre_gpui_spike::data::{ChatStep, MessagePage, PermissionRequest, QuestionRequest, Role, StepStatus};
use milagre_gpui_spike::workspace::chat::transcript::cards::{Card, QuestionCard};
use milagre_gpui_spike::workspace::chat::transcript::{Approval, ApprovalState, Item, Prose, StepItem};

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

pub fn saved_items(page: &MessagePage) -> Vec<Item> {
    let now = now_ms();
    let mut items = Vec::new();
    for message in &page.messages {
        match message.role {
            Role::User => items.push(Item::User(message.body.clone())),
            Role::Assistant => {
                items.extend(message.steps.iter().cloned().map(|step| Item::Step(StepItem::new(step, now))));
                if !message.body.trim().is_empty() {
                    items.push(Item::Prose(Prose::new(message.body.clone())));
                }
            }
        }
    }
    items
}

/// The approval card for `request`, on its step when the run has one.
pub fn approval_item(request: &PermissionRequest, steps: &[ChatStep]) -> Item {
    let step = request.step_id.as_ref().and_then(|id| steps.iter().find(|step| &step.id == id).cloned()).unwrap_or_else(|| ChatStep {
        id: request.request_id.clone(),
        title: if request.title.is_empty() { request.tool.clone() } else { request.title.clone() },
        status: StepStatus::Running,
        ..ChatStep::default()
    });
    let command = request.command.clone().or_else(|| request.detail.clone()).or_else(|| request.description.clone()).unwrap_or_default();
    Item::Approval(Approval { step, command, state: ApprovalState::Waiting })
}

pub fn question_item(request: &QuestionRequest) -> Item {
    Item::Card(Card::Question(Box::new(QuestionCard::new(request, None))))
}

/// An item as a line, for tests and evidence.
pub fn describe(item: &Item) -> String {
    match item {
        Item::User(text) => format!("user: {text}"),
        Item::Prose(prose) => format!("reply: {}", prose.text),
        Item::Step(step) => format!("step: {}", step.step.title),
        Item::Approval(approval) => format!("approval {:?}: {}", approval.state, approval.step.title),
        Item::Card(Card::Question(card)) => format!("question {}: {:?}", card.request_id, card.status),
        other => format!("other: {other:?}"),
    }
}

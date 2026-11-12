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
    saved_items_with(page, &LimitInfo::default())
}

/// What the Chat's usage-limit cards may offer (`UsageLimitCard`'s props in `ChatComposer.tsx`): only the message
/// `interactive` names (the Chat's `limitTurn` reply, else its last message, while nothing is sending) gets actions.
#[derive(Clone, Debug, Default)]
pub struct LimitInfo {
    pub interactive: Option<u64>,
    /// `limitChoices` for the Project on screen.
    pub choices: Vec<milagre_gpui_spike::logic::usage::limit::LimitChoice>,
    /// `limitResume`: the scheduled continuation's reply and time.
    pub pending: Option<(u64, String)>,
    /// "Continue at" is offered: resume at reset supported, this is the `limitTurn` reply, nothing queued.
    pub resume: Option<u64>,
    /// A data layer answers the actions.
    pub live: bool,
}

pub fn saved_items_with(page: &MessagePage, info: &LimitInfo) -> Vec<Item> {
    let now = now_ms();
    let mut items = Vec::new();
    for message in &page.messages {
        match message.role {
            Role::User => match message.context.as_ref().and_then(pr_action_card) {
                // A PR pill's message: Electron's action card ("Update branch" · "Pull request #177"), not its prompt.
                Some(card) => items.push(Item::Card(card)),
                None => items.push(Item::User(message.body.clone())),
            },
            Role::Assistant => {
                items.extend(message.steps.iter().cloned().map(|step| Item::Step(StepItem::new(step, now))));
                if !message.body.trim().is_empty() {
                    items.push(Item::Prose(Prose::new(message.body.clone())));
                }
                // A reply the plan's usage limit stopped: the limit card under it.
                if let Some(mut card) = message.context.as_ref().and_then(|context| crate::usage::limit_card(context, now)) {
                    card.message = Some(message.id);
                    apply_limit(&mut card, info);
                    items.push(Item::Card(Card::Limit(card)));
                }
            }
        }
    }
    items
}

/// Lays `info` over a limit card (its `message` decides whether it is the interactive one). Whether it changed.
pub fn apply_limit(card: &mut milagre_gpui_spike::workspace::chat::transcript::cards::LimitCard, info: &LimitInfo) -> bool {
    let before = (card.interactive, card.live, card.choices.clone(), card.resume, card.pending_at.clone());
    let mine = card.message.is_some() && card.message == info.interactive;
    card.live = info.live && mine;
    card.interactive = card.live;
    card.choices = if card.live { info.choices.clone() } else { Vec::new() };
    card.resume = card.live && info.resume == card.message;
    card.pending_at = info.pending.as_ref().filter(|(id, _)| Some(*id) == card.message).map(|(_, at)| at.clone());
    before != (card.interactive, card.live, card.choices.clone(), card.resume, card.pending_at.clone())
}

/// A user message's `{kind: "pr-action", action, pr, url}` context as the PR action card.
pub fn pr_action_card(context: &milagre_gpui_spike::data::ChatContext) -> Option<Card> {
    use milagre_gpui_spike::data::ChatContext;
    let (action, pr, url) = match context {
        ChatContext::PullRequestAction { action, pr, url } => (action.to_string(), f64::from(*pr), url.to_string()),
        ChatContext::Other { kind, raw } if kind.as_ref() == "pr-action" => {
            (raw["action"].as_str()?.to_owned(), raw["pr"].as_f64()?, raw["url"].as_str()?.to_owned())
        }
        _ => return None,
    };
    let checked = milagre_gpui_spike::logic::prs::action::pull_request_action_context(&action, pr, &url)?;
    Some(Card::PrAction(milagre_gpui_spike::workspace::chat::transcript::cards::PrActionCard {
        blocker: checked.action,
        pr: checked.pr,
        url: checked.url.into(),
        state: None,
    }))
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
        Item::Card(Card::PrAction(card)) => format!("pr action {} #{}", card.blocker.key(), card.pr),
        Item::Card(Card::Limit(card)) => {
            format!("limit {} resets {}", card.limit.provider.id(), card.limit.resets_at.as_deref().unwrap_or("later"))
        }
        other => format!("other: {other:?}"),
    }
}

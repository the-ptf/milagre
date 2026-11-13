//! Saved messages and live requests as the base transcript's items.
//!
//! A user message is `cards::build::items_for` (its attachments as one strip of tiles over the bubble, and the cards
//! of the kinds that module knows); a PR pill's message is its action card. A reply is laid out as Electron's
//! `ReplyContent` (`cards::build::reply_items`): consecutive tool steps and thoughts fold into one activity line
//! ("Thought for 12s · ran 3 commands") that opens to the steps, the images it viewed or made, then the answer
//! (`Item::Prose`, left out when empty) and any calls after it. A live approval is `Item::Approval` (its step from the
//! run when the run has it), a live question the question card; the live run's steps are folds of their own
//! ([`run_folds`]).

use gpui::SharedString;
use milagre_gpui_spike::data::{ChatStep, MessagePage, PermissionRequest, QuestionRequest, Role, StepKind, StepStatus};
use milagre_gpui_spike::workspace::chat::transcript::cards::build::{items_for, reply_items};
use milagre_gpui_spike::workspace::chat::transcript::cards::{Card, QuestionCard};
use milagre_gpui_spike::workspace::chat::transcript::{Activity, Approval, ApprovalState, Entry, Item};

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
                // Its attachments as one strip of tiles over the bubble (and the other kinds' cards), as `MessageSection`.
                None => items.extend(items_for(message)),
            },
            Role::Assistant => {
                // `ReplyContent`: setup rows, the activity before the answer as one fold, the answer, the fold after.
                items.extend(reply_items(message, now));
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

/// What a run's new step does to its folds ([`run_folds`]), in the order the steps started.
#[derive(Debug, PartialEq)]
pub enum FoldOp {
    /// It joins fold `n` (its place in the list): no text was written between it and that fold's last step.
    Join(usize, SharedString),
    /// It opens a new fold, under the reply's text up to `text_at` (bytes of the run's text), which shows first.
    New(SharedString, usize),
}

/// The byte index in `text` of a step's `offset` (UTF-16 units, as the daemon counts), clamped to the text.
pub fn byte_offset(text: &str, offset: Option<usize>) -> usize {
    let Some(offset) = offset else { return text.len() };
    let mut units = 0;
    for (at, ch) in text.char_indices() {
        if units >= offset {
            return at;
        }
        units += ch.len_utf16();
    }
    text.len()
}

/// The live run's steps as folds, by Electron's `replyParts` rule: steps with no text between them form one group.
/// A new step joins the last fold when the run's text between that fold's last step and it is only whitespace;
/// otherwise it opens a fold of its own under that text (the calls the text led into). Setup, image and artifact
/// steps are cards, and a step with its own approval card (`carded`) stays out. The saved reply replaces all of it
/// when the turn ends.
pub fn run_folds(steps: &[ChatStep], folds: &[(usize, Vec<SharedString>)], text: &str, carded: &[SharedString]) -> Vec<FoldOp> {
    let mut ops = Vec::new();
    let mut groups: Vec<Vec<SharedString>> = folds.iter().map(|(_, ids)| ids.clone()).collect();
    let at = |id: &SharedString| byte_offset(text, steps.iter().find(|step| &step.id == id).and_then(|step| step.offset));
    for step in steps {
        if matches!(step.kind, Some(StepKind::Setup | StepKind::Image | StepKind::Artifact))
            || carded.contains(&step.id)
            || groups.iter().any(|ids| ids.contains(&step.id))
        {
            continue;
        }
        let here = byte_offset(text, step.offset);
        let joins = groups.last().and_then(|ids| ids.last()).is_some_and(|last| {
            let from = at(last).min(here);
            text[from..here].trim().is_empty()
        });
        if joins {
            ops.push(FoldOp::Join(groups.len() - 1, step.id.clone()));
            groups.last_mut().expect("a fold").push(step.id.clone());
        } else {
            ops.push(FoldOp::New(step.id.clone(), here));
            groups.push(vec![step.id.clone()]);
        }
    }
    ops
}

/// Whether the run on screen was split since it was drawn (`splitRun`: a message sent during the turn, a PR action
/// or answers): its text starts again shorter than what is shown, or a fold's steps are gone from it (saved above the
/// new message). The saved messages then hold that part, so the Chat is read again and the live tail rebuilt.
pub fn run_was_split(steps: &[ChatStep], text: &str, folds: &[(usize, Vec<SharedString>)], shown: Option<usize>) -> bool {
    shown.is_some_and(|shown| shown > text.len())
        || folds.iter().any(|(_, ids)| !ids.is_empty() && ids.iter().all(|id| !steps.iter().any(|step| &step.id == id)))
}

/// A fold's steps as they are now in the run, in the fold's order.
pub fn fold_entries(steps: &[ChatStep], ids: &[SharedString]) -> Vec<Entry> {
    ids.iter().filter_map(|id| steps.iter().find(|step| &step.id == id)).cloned().map(Entry::Step).collect()
}

/// A new, empty live fold (its steps arrive with `Transcript::update_activity`).
pub fn live_fold(now: i64) -> Item {
    let mut activity = Activity::new(Vec::new(), now);
    activity.streaming = true;
    Item::Activity(activity)
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
        Item::Activity(activity) => {
            let steps = activity.steps();
            let (summary, _) = milagre_gpui_spike::workspace::chat::transcript::summary::activity_summary(&steps, activity.credits);
            format!("activity ({} steps): {summary}", steps.len())
        }
        Item::Approval(approval) => format!("approval {:?}: {}", approval.state, approval.step.title),
        Item::Card(Card::Question(card)) => format!("question {}: {:?}", card.request_id, card.status),
        Item::Card(Card::PrAction(card)) => format!("pr action {} #{}", card.blocker.key(), card.pr),
        Item::Card(Card::Limit(card)) => {
            format!("limit {} resets {}", card.limit.provider.id(), card.limit.resets_at.as_deref().unwrap_or("later"))
        }
        other => format!("other: {other:?}"),
    }
}

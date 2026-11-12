//! A saved `ChatMessage` as transcript items, in the order `MessageSection` (`ChatComposer.tsx`) decides what a
//! message is: a divider kind is a divider; a Delegation report is one line; a PR action or a Linear issue on a
//! user message is its card; a user message that answered questions is the answer card; anything else is the
//! ordinary message (a bubble with its attachments above it, or the reply's images and text).
//!
//! A context kind this module does not know (`ChatContext::Other`, or a typed kind with no card) falls to that
//! ordinary message, as the app does: its text shows as a bubble or as the answer, and a message with no text and
//! no attachments adds nothing.
//!
//! A reply's tool calls are WP-22's activity fold; only the steps that are cards here (generated and viewed images)
//! are read.

use std::path::PathBuf;

use gpui::SharedString;

use super::images::{GeneratedImage, ImageRef, ImageStrip, StripKind, is_image_path};
use super::small::{LimitCard, LinearCard, NoteLine, PrActionCard, ReportCard};
use super::{Card, Divider};
use crate::data::{ChatContext, ChatMessage, ChatStep, ImageAttachment, Role, StepKind};
use crate::logic::activity::subchat_states::{ReportContext, report_marker};
use crate::logic::prs::action::pull_request_action_context;
use crate::logic::usage::limit::UsageLimit;
use crate::workspace::chat::transcript::{Item, Prose};

fn file_name(path: &str) -> SharedString {
    path.rsplit('/').next().filter(|name| !name.is_empty()).unwrap_or(path).to_string().into()
}

fn attachment(image: &ImageAttachment) -> ImageRef {
    ImageRef { name: image.name.clone(), path: image.path.as_ref().map(|path| PathBuf::from(path.as_ref())) }
}

/// The image a viewed (Read) step shows: its file when that is an image.
fn viewed(step: &ChatStep) -> Option<ImageRef> {
    let file = step.file.as_ref().filter(|file| is_image_path(file))?;
    Some(ImageRef { name: file_name(file), path: Some(PathBuf::from(file.as_ref())) })
}

/// The cards a usage limit leaves under its reply; the Chat's last message gets the actions (`interactive`).
pub fn limit_card(limit: UsageLimit, now: i64) -> LimitCard {
    LimitCard {
        limit,
        now,
        choices: Vec::new(),
        pending_at: None,
        interactive: false,
        result: None,
        resume: true,
        live: false,
        busy: false,
        error: None,
        message: None,
    }
}

/// `MessageSection` for one message.
pub fn items_for(message: &ChatMessage) -> Vec<Item> {
    let user = message.role == Role::User;
    let mut items = Vec::new();
    if let Some(context) = &message.context {
        if let Some(divider) = Divider::from_context(context, None) {
            return vec![Item::Card(Card::Divider(divider))];
        }
        match context {
            ChatContext::DelegationReport { from_label, status, .. } => {
                let report = ReportContext {
                    kind: "delegation-report".into(),
                    status: Some(status.to_string()),
                    from_label: Some(from_label.to_string()),
                    negotiation: false,
                };
                if let Some((text, kind)) = report_marker(Some(&report)) {
                    return vec![Item::Card(Card::Report(ReportCard { text: text.into(), kind, body: message.body.clone(), open: false }))];
                }
            }
            ChatContext::PullRequestAction { action, pr, url } if user => {
                if let Some(checked) = pull_request_action_context(action, f64::from(*pr), url) {
                    return vec![Item::Card(Card::PrAction(PrActionCard {
                        blocker: checked.action,
                        pr: checked.pr,
                        url: checked.url.into(),
                        state: None,
                    }))];
                }
            }
            ChatContext::LinearIssue { key, title, url, state, note } if user => {
                return vec![Item::Card(Card::Linear(LinearCard {
                    key: key.clone(),
                    title: title.clone(),
                    state: state.clone(),
                    url: url.clone(),
                    note: note.clone(),
                }))];
            }
            ChatContext::Other { kind, raw } if kind.as_ref() == "subchat-answered-by" => {
                let title = raw.get("parentTitle").and_then(|v| v.as_str()).unwrap_or("the Chat above");
                return vec![Item::Card(Card::Note(NoteLine { text: format!("Answered by {title}").into() }))];
            }
            _ => {}
        }
    }
    if user && !message.answered.is_empty() {
        return vec![Item::Card(Card::Answer(message.answered.clone()))];
    }
    if user {
        if !message.images.is_empty() {
            items.push(Item::Card(Card::Images(ImageStrip {
                kind: StripKind::Attachments,
                images: message.images.iter().map(attachment).collect(),
            })));
        }
        if !message.body.trim().is_empty() {
            items.push(Item::User(message.body.clone()));
        }
        return items;
    }
    let seen: Vec<ImageRef> = message.steps.iter().filter(|step| step.kind == Some(StepKind::Read)).filter_map(viewed).collect();
    if !seen.is_empty() {
        items.push(Item::Card(Card::Images(ImageStrip { kind: StripKind::Viewed, images: seen })));
    }
    for step in message.steps.iter().filter(|step| step.kind == Some(StepKind::Image)) {
        items.push(Item::Card(Card::Generated(GeneratedImage::new(step.clone()))));
    }
    if !message.body.trim().is_empty() {
        items.push(Item::Prose(Prose::new(message.body.clone())));
    }
    if let Some(ChatContext::Limit { provider, account_id, resets_at, .. }) = &message.context {
        let limit = UsageLimit {
            provider: *provider,
            account_id: account_id.as_ref().map(|id| id.to_string()),
            resets_at: resets_at.as_ref().map(|at| at.to_string()),
        };
        items.push(Item::Card(Card::Limit(limit_card(limit, crate::workspace::chat::fixture::NOW))));
    }
    items
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::{ChatId, Provider};

    fn user(body: &str, context: Option<ChatContext>) -> ChatMessage {
        let mut message = ChatMessage::text(1, ChatId::default(), Role::User, body.to_string());
        message.context = context;
        message
    }

    #[test]
    fn an_unknown_kind_is_an_ordinary_message_and_never_a_crash() {
        let other = ChatContext::Other { kind: "from-the-future".into(), raw: serde_json::json!({ "kind": "from-the-future" }) };
        assert!(matches!(items_for(&user("hello", Some(other.clone()))).as_slice(), [Item::User(text)] if text.as_ref() == "hello"));
        assert!(items_for(&user("  ", Some(other))).is_empty());
        let mut reply = user("an answer", Some(ChatContext::Other { kind: "x".into(), raw: serde_json::Value::Null }));
        reply.role = Role::Assistant;
        assert!(matches!(items_for(&reply).as_slice(), [Item::Prose(_)]));
    }

    #[test]
    fn dividers_cards_and_reports_come_from_their_kinds() {
        assert!(matches!(items_for(&user("", Some(ChatContext::Reload))).as_slice(), [Item::Card(Card::Divider(_))]));
        let url = "https://github.com/the-ptf/milagre-ade/pull/77";
        let action = ChatContext::PullRequestAction { action: "checks-failed".into(), pr: 77, url: url.into() };
        assert!(matches!(items_for(&user("Fix CI", Some(action))).as_slice(), [Item::Card(Card::PrAction(card))] if card.pr == 77));
        // A PR action whose URL is not that pull request's is refused, so it draws as the bubble it is.
        let bad = ChatContext::PullRequestAction { action: "checks-failed".into(), pr: 78, url: url.into() };
        assert!(matches!(items_for(&user("Fix CI", Some(bad))).as_slice(), [Item::User(_)]));
        let report = ChatContext::DelegationReport {
            delegation_id: "d".into(),
            from: None,
            from_label: "milagre / main / Fix login".into(),
            status: "failed".into(),
        };
        let items = items_for(&user("It broke", Some(report)));
        assert!(matches!(items.as_slice(), [Item::Card(Card::Report(card))] if card.text.as_ref() == "Fix login failed"));
    }

    #[test]
    fn answers_attachments_and_limits() {
        let mut answered = user("", None);
        answered.answered = vec![crate::data::AnsweredQuestion { header: "".into(), question: "Which?".into(), answers: vec!["A".into()] }];
        assert!(matches!(items_for(&answered).as_slice(), [Item::Card(Card::Answer(_))]));
        let mut with_image = user("look", None);
        with_image.images = vec![ImageAttachment {
            id: "i".into(),
            name: "a.png".into(),
            path: Some("/nowhere/a.png".into()),
            data_url: None,
            source_path: None,
        }];
        assert!(matches!(items_for(&with_image).as_slice(), [Item::Card(Card::Images(_)), Item::User(_)]));
        let mut limited = user(
            "You hit the limit",
            Some(ChatContext::Limit { provider: Provider::Claude, account_id: None, window: None, resets_at: None }),
        );
        limited.role = Role::Assistant;
        assert!(matches!(items_for(&limited).as_slice(), [Item::Prose(_), Item::Card(Card::Limit(_))]));
    }
}

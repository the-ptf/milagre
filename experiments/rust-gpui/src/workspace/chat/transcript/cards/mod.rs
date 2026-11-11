//! Transcript cards (WP-23): every item kind that is not prose, a user bubble or a tool row, built from the real
//! data types and drawn as the desktop draws them.
//!
//! - `build.rs`: `ChatMessage` (and its `ChatContext`) into items, as `MessageSection` in `ChatComposer.tsx` picks
//!   what a message is. An unknown context kind draws as an ordinary message (the bubble or the answer), as the app
//!   does, and nothing at all when it has no text.
//! - `question.rs`, `answers.rs`: the question card, its answered state, and the draft rules of `question-answers.ts`.
//! - `dividers.rs`: every `TranscriptDivider`.
//! - `images.rs`: attachment tiles, viewed images, generated images, and the simple in-window viewer.
//! - `small.rs`: PR action, Linear issue, usage limit, delegation report line (the queued messages are docked above the composer now).
//!
//! Each card is one list item. The state a card changes (a pick, a tab, an open report) lives in the item, and the
//! transcript re-measures that item with `ListState::splice` when its height can change.

pub mod answers;
pub mod build;
pub mod dividers;
pub mod images;
pub mod question;
pub mod small;

use gpui::{AnyElement, Context, Window};

use super::Transcript;
use crate::data::AnsweredQuestion;
use crate::theme::Theme;

pub use dividers::Divider;
pub use images::{GeneratedImage, ImageStrip};
pub use question::QuestionCard;
pub use small::{LimitCard, LinearCard, NoteLine, PrActionCard, ReportCard};

/// One card. Cloned with its item. The variants differ in size (a generated image holds its whole step); boxing them
/// would only move the allocation, since items are built once and kept in a `Vec`.
#[allow(clippy::large_enum_variant)]
#[derive(Clone, Debug)]
pub enum Card {
    Question(Box<QuestionCard>),
    /// The user's answers to the agent's questions (`AnswerCard`).
    Answer(Vec<AnsweredQuestion>),
    Divider(Divider),
    Images(ImageStrip),
    Generated(GeneratedImage),
    PrAction(PrActionCard),
    Linear(LinearCard),
    Limit(LimitCard),
    Report(ReportCard),
    Note(NoteLine),
    /// An HTML reply, as a card that opens it in the Artifact tab (WP-34).
    Html(crate::workspace::panel::artifacts::card::HtmlReplyCard),
}

impl Transcript {
    /// The element of card `ix`. The cards that act reach the transcript through `cx.listener`.
    pub(super) fn card_item(&mut self, ix: usize, card: &Card, theme: &Theme, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        match card {
            Card::Question(question) => self.question_card(ix, question, theme, window, cx),
            Card::Answer(answered) => small::answer_card(ix, answered, theme),
            Card::Divider(divider) => self.divider(ix, divider, theme, cx),
            Card::Images(strip) => self.image_strip(ix, strip, theme, cx),
            Card::Generated(image) => self.generated_image(ix, image, theme, cx),
            Card::PrAction(card) => small::pr_action(ix, card, theme),
            Card::Linear(card) => small::linear_issue(ix, card, theme),
            Card::Limit(card) => self.limit_card(ix, card, theme, cx),
            Card::Report(card) => self.report_line(ix, card, theme, cx),
            Card::Note(note) => small::note_line(ix, note, theme),
            Card::Html(card) => crate::workspace::panel::artifacts::card::reply_card(ix, card, theme),
        }
    }

    /// Replaces card `ix` and re-measures it: a card's height changes with what it shows.
    pub(super) fn set_card(&mut self, ix: usize, card: Card, cx: &mut Context<Self>) {
        if let Some(super::Item::Card(slot)) = self.items.get_mut(ix) {
            *slot = card;
            self.list.splice(ix..ix + 1, 1);
            cx.notify();
        }
    }

    /// The card at `ix`, cloned for a handler to change and put back with [`Transcript::set_card`].
    pub(super) fn card_at(&self, ix: usize) -> Option<Card> {
        match self.items.get(ix) {
            Some(super::Item::Card(card)) => Some(card.clone()),
            _ => None,
        }
    }
}

/// The space above a card (`TranscriptDivider`'s own padding, the message gaps): what the user wrote sits 24 below the
/// last item, as a user message does; a reply's images and cards sit close under their text.
pub fn top_gap(card: &Card) -> f32 {
    match card {
        Card::Answer(_) | Card::PrAction(_) | Card::Linear(_) => 24.0,
        Card::Images(strip) if strip.kind == images::StripKind::Attachments => 24.0,
        Card::Images(_) | Card::Generated(_) => 8.0,
        Card::Limit(_) => 0.0,
        Card::Question(_) | Card::Divider(_) | Card::Report(_) | Card::Note(_) => 12.0,
        Card::Html(_) => 8.0,
    }
}

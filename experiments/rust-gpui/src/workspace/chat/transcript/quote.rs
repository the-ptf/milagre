//! Quote selection (WP-28): when a drag, double click or shift-click leaves a selection inside one message's text,
//! the transcript offers it as a [`Passage`] and the Chat column shows a Quote button under the selection's end
//! (`MessageSelection.tsx`). Quote, or ⇧⌘', puts the passage in the composer as a quote chip named after the
//! message it came from (`composerQuote`, `quoteSource`), and the selection goes.
//!
//! - The passage's text is what ⌘C copies of that selection (`ui::selection::plain`): a user message's chips keep
//!   their tokens, as `typedText` does in the desktop.
//! - A selection across messages, into a tool row or card, or ⌘A offers nothing, as on the desktop.
//! - The button sits under where the pointer let go (the desktop puts it under the selection's last line box,
//!   which gpui-base does not expose), above it when that would leave the transcript. Scrolling, a press anywhere,
//!   Escape and a new Chat take it away.

use gpui::{
    App, Bounds, ClickEvent, Context, FontWeight, IntoElement, MouseButton, MouseUpEvent, Pixels, Point, SharedString, Window, canvas, div,
    point, prelude::*, px,
};
use gpui_base::TextSelection;

use super::{Item, Transcript};
use crate::logic::prompts::parts::{QuoteFrom, quote_source};
use crate::theme::{CONTROL_MD, RADIUS_CONTROL, TEXT_12, TEXT_13, TextStepExt, Theme};

/// The button's offset from the selection's end, and its size for keeping it inside (`h-8`, about 140 wide).
const GAP: f32 = 6.0;
const NUDGE_LEFT: f32 = 48.0;
const EDGE: f32 = 8.0;
const BUTTON_WIDTH: f32 = 132.0;

/// A passage selected inside one message.
#[derive(Clone, Debug, PartialEq)]
pub struct Passage {
    pub item: usize,
    /// What the quote holds: the selection as ⌘C copies it.
    pub text: String,
    /// Whose words: "Your message", "Claude reply".
    pub source: String,
    /// Where the pointer let go, in window coordinates.
    pub at: Point<Pixels>,
}

/// What the transcript tells the Chat column.
#[derive(Clone, Debug, PartialEq)]
pub enum TranscriptEvent {
    /// The selection now offers this passage to quote, or nothing.
    Passage(Option<Passage>),
}

impl gpui::EventEmitter<TranscriptEvent> for Transcript {}

impl Transcript {
    /// The passage the selection holds now: a selection inside one user message or answer, with text.
    pub fn passage(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Option<Passage> {
        if self.all.borrow().active {
            return None;
        }
        let tracker = *self.tracker.borrow();
        let item = tracker.anchor.filter(|anchor| tracker.cursor == Some(*anchor))?;
        let from = match self.items.get(item)? {
            Item::User(_) => QuoteFrom::User,
            Item::Prose(_) => QuoteFrom::Assistant,
            _ => return None,
        };
        if !TextSelection::has_selection(window, cx) {
            return None;
        }
        let text = self.part_text(item, cx).text;
        if text.trim().is_empty() {
            return None;
        }
        let at = tracker.pointer.unwrap_or_default();
        Some(Passage { item, text, source: quote_source(from, None), at })
    }

    /// After the button goes up: what the selection offers now (a press that cleared it offers nothing).
    fn read_passage(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let passage = self.passage(window, cx);
        cx.emit(TranscriptEvent::Passage(passage));
    }

    /// A zero-size element whose paint listens for the left button going up anywhere in the window after a press in
    /// the transcript, and reads the passage once every handler of that event (gpui-base's selection layer among
    /// them) has run.
    pub(super) fn passage_listener(&self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let transcript = cx.weak_entity();
        let tracker = self.tracker.clone();
        canvas(
            |_, _, _| {},
            move |_, _, window, _| {
                let (transcript, tracker) = (transcript.clone(), tracker.clone());
                window.on_mouse_event(move |event: &MouseUpEvent, phase, window, cx| {
                    if !phase.bubble() || event.button != MouseButton::Left || tracker.borrow().origin.is_none() {
                        return;
                    }
                    let transcript = transcript.clone();
                    window.defer(cx, move |window, cx| {
                        transcript.update(cx, |this, cx| this.read_passage(window, cx)).ok();
                    });
                });
            },
        )
        .absolute()
        .size(px(0.0))
    }
}

/// Where the button goes in `area` (the transcript's bounds, window coordinates): under the selection's end, or
/// above it when that would leave the area; kept inside on the left and right. Relative to `area`'s origin.
pub fn button_origin(at: Point<Pixels>, area: Bounds<Pixels>) -> Point<Pixels> {
    let line = px(crate::theme::chat_text().line_height / 2.0);
    let left = (at.x - px(NUDGE_LEFT)).min(area.right() - px(BUTTON_WIDTH + EDGE)).max(area.left() + px(EDGE));
    let below = at.y + line + px(GAP);
    let top =
        if below + CONTROL_MD + px(EDGE) < area.bottom() { below } else { (at.y - line - px(GAP) - CONTROL_MD).max(area.top() + px(EDGE)) };
    point(left - area.left(), top - area.top())
}

/// The hovered Quote button's fill: the surface with the theme's `hover` wash over it, opaque.
pub fn hover_fill(theme: &Theme) -> gpui::Hsla {
    gpui::Hsla::from(theme.surface).blend(gpui::Hsla::from(theme.hover))
}

/// The Quote button: `surface`, a 1px `line` border and `shadow-raised`, 32 high, 13 medium ink, its shortcut in 12
/// `ink-3` (`MessageSelection.tsx`). Opaque in every state: hovered it is the surface with `hover` laid over it (the
/// theme's `hover` alone is a translucent wash, which let the transcript's text show through the button).
pub fn quote_button<F: Fn(&ClickEvent, &mut Window, &mut App) + 'static>(
    origin: Point<Pixels>,
    shortcut: Option<SharedString>,
    theme: &Theme,
    on_click: F,
) -> impl IntoElement + use<F> {
    let hover = hover_fill(theme);
    div()
        .id("quote-selection")
        .debug_selector(|| "quote-selection".into())
        .absolute()
        .left(origin.x)
        .top(origin.y)
        .occlude()
        .flex()
        .items_center()
        .gap_2()
        .h(CONTROL_MD)
        .px_3()
        .rounded(RADIUS_CONTROL)
        .bg(theme.surface)
        .border_1()
        .border_color(theme.line)
        .shadow(theme.shadow_raised())
        .text_step(TEXT_13)
        .font_weight(FontWeight::MEDIUM)
        .text_color(theme.ink)
        .cursor_pointer()
        .hover(move |style| style.bg(hover))
        .on_click(on_click)
        .child("Quote")
        .children(shortcut.map(|keys| div().text_step(TEXT_12).font_weight(FontWeight::NORMAL).text_color(theme.ink3).child(keys)))
}

#[cfg(test)]
mod opaque_tests {
    use super::*;

    #[test]
    fn the_quote_button_is_opaque_hovered_or_not_in_both_themes() {
        for theme in [Theme::dark(), Theme::light()] {
            assert_eq!(gpui::Hsla::from(theme.surface).a, 1.0, "its fill");
            let hover = hover_fill(&theme);
            assert!((hover.a - 1.0).abs() < 1e-6, "hovered: {hover:?}");
            assert_ne!(hover, gpui::Hsla::from(theme.surface), "hover still shows");
        }
    }
}

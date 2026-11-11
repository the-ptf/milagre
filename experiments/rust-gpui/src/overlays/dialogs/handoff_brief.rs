//! The handoff brief (O-13; `Handover.tsx` `HandoffBriefDialog`): the brief the new provider was sent, or the linked
//! summary a Link gave a Chat, as markdown in a dialog with a Close button. The divider that opens it belongs to
//! the transcript (`copy.rs` has its label rules).

use gpui::{App, AppContext as _, Context, Entity, IntoElement, Render, SharedString, Window, div, prelude::*, px};
use gpui_base::TextViewState;

use super::footer;
use crate::theme::{ActiveTheme, TEXT_13, TextStepExt};
use crate::ui::markdown::{Markdown, base_extensions, open_with_system, text_view_style};
use crate::ui::{Button, Dialog};

const SIZE: f32 = 13.0;

pub struct HandoffBriefDialog {
    text: Entity<TextViewState>,
}

impl Render for HandoffBriefDialog {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.theme();
        div()
            .flex()
            .flex_col()
            .gap(px(12.0))
            .child(
                div()
                    .debug_selector(|| "brief-preview".into())
                    .max_h(px(420.0))
                    .overflow_hidden()
                    .text_step(TEXT_13)
                    .child(Markdown::new(&self.text, text_view_style(&theme, SIZE), base_extensions(), open_with_system()).size(SIZE)),
            )
            .child(footer(
                None,
                vec![
                    Button::new("brief-close", "Close")
                        .selector("brief-close")
                        .on_click(|_, window, cx| Dialog::close(window, cx))
                        .into_any_element(),
                ],
            ))
    }
}

/// Opens the brief under `title` ("Handoff brief").
pub fn open(title: impl Into<SharedString>, brief: &str, window: &mut Window, cx: &mut App) -> Entity<HandoffBriefDialog> {
    let text = cx.new(|cx| TextViewState::markdown(brief, cx));
    let view = cx.new(|_| HandoffBriefDialog { text });
    let body = view.clone();
    Dialog::new(title).width(680.0).body(move |_, _| body.clone().into_any_element()).open(window, cx);
    view
}

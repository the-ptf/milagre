//! An HTML reply in the transcript, v1 (PORT-MAP N-01 (c)): a card that names the page and opens it in the Artifact
//! dock, instead of the live inline page (`HtmlReply.tsx`) or the scaled live preview (`ArtifactCard.tsx`'s
//! `ScaledPreview`). A live webview per reply is v2: on `gpui-pre` it would cover the transcript around it.
//!
//! The footer row is the artifact card's: the page icon, its title over "Artifact", and Open.

use gpui::{AnyElement, ClickEvent, ElementId, SharedString, div, prelude::*, px};

use crate::theme::{RADIUS_CARD, TEXT_11, TEXT_13, TextStepExt, Theme};
use crate::ui::{Button, ButtonSize, ButtonVariant, Icon, IconName, IconSize};

/// `max-w-xl`.
const CARD_MAX_WIDTH: f32 = 576.0;

/// The card's item: the page it opens and the title it shows.
#[derive(Clone, Debug, PartialEq)]
pub struct HtmlReplyCard {
    pub page: SharedString,
    pub title: SharedString,
}

/// The fixture's reply: the page `fixture::REPLY_PAGE`.
pub fn fixture_reply() -> HtmlReplyCard {
    HtmlReplyCard { page: super::fixture::REPLY_PAGE.into(), title: "Intro timing".into() }
}

/// Card `ix` of the transcript.
pub fn reply_card(ix: usize, card: &HtmlReplyCard, theme: &Theme) -> AnyElement {
    let page = card.page.clone();
    div()
        .w_full()
        .max_w(px(CARD_MAX_WIDTH))
        .flex()
        .items_center()
        .gap_2()
        .px_3()
        .py_2()
        .rounded(RADIUS_CARD)
        .border_1()
        .border_color(theme.line)
        .bg(theme.surface)
        .child(Icon::new(IconName::File01).size(IconSize::S16).color(theme.ink2))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .child(div().truncate().text_step(TEXT_13).text_color(theme.ink).child(card.title.clone()))
                .child(div().text_step(TEXT_11).text_color(theme.ink3).child("Artifact")),
        )
        .child(
            div()
                .id(ElementId::from((SharedString::from("html-reply-open"), ix)))
                .debug_selector(move || format!("html-reply-open-{ix}"))
                .child(
                    Button::new(ElementId::from((SharedString::from("html-reply-open-button"), ix)), "Open")
                        .variant(ButtonVariant::Secondary)
                        .size(ButtonSize::S28)
                        .on_click(move |_: &ClickEvent, _window, cx| super::open(&page, cx)),
                ),
        )
        .into_any_element()
}

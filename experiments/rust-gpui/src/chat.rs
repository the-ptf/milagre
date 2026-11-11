//! Chat column: header, transcript area and composer.
//!
//! The transcript area is empty; a later step fills it. The composer is a placeholder box with the
//! real size and surface tokens.

use gpui::{Context, FontWeight, SharedString, Window, div, prelude::*, px};

use crate::chrome;
use crate::theme::{ActiveTheme, RADIUS_WINDOW, StyledText, TEXT_12, TEXT_13};

const COMPOSER_MAX_WIDTH: f32 = 536.0;
const COMPOSER_HEIGHT: f32 = 112.0;
const COMPOSER_BOTTOM: f32 = 24.0;

pub struct ChatView {
    title: SharedString,
    project: SharedString,
}

impl ChatView {
    pub fn new(_cx: &mut Context<Self>) -> Self {
        Self { title: "Fix sidebar undo toast on iPad".into(), project: "milagre-ade".into() }
    }
}

impl Render for ChatView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .h_full()
            .bg(theme.page)
            .child(
                chrome::header("chat-header")
                    .px_4()
                    .gap_2()
                    .child(
                        div()
                            .text_step(TEXT_13)
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme.ink)
                            .truncate()
                            .child(self.title.clone()),
                    )
                    .child(div().flex_none().text_step(TEXT_12).text_color(theme.ink3).child(self.project.clone())),
            )
            // Transcript goes here.
            .child(div().id("transcript").flex_1().min_h_0())
            .child(
                div().flex_none().flex().justify_center().px_4().pb(px(COMPOSER_BOTTOM)).child(
                    div()
                        .id("composer")
                        .w_full()
                        .max_w(px(COMPOSER_MAX_WIDTH))
                        .h(px(COMPOSER_HEIGHT))
                        .rounded(RADIUS_WINDOW)
                        .bg(theme.surface)
                        .border_1()
                        .border_color(theme.line),
                ),
            )
    }
}

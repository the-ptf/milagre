//! Chat column: header, transcript, floating pills and composer.
//!
//! The transcript and the composer are entities of their own. The transcript is drawn as a cached
//! view (`AnyView::cached`), so a keystroke in the composer re-renders the composer and its
//! ancestors but reuses the transcript's last layout and paint; only `cx.notify()` on the transcript
//! (a new item, a settled approval, a scroll) lays its visible items out again.

pub mod composer;
pub mod fixture;
pub mod markdown;
pub mod transcript;

#[cfg(test)]
mod tests;

use gpui::{
    AnyView, Context, Entity, FocusHandle, Focusable, FontWeight, SharedString, StyleRefinement, Subscription, Window, div, prelude::*, px,
};

use crate::theme::{ActiveTheme, CONTROL_SM, StyledText, TEXT_12, TEXT_13, Theme};
use crate::workspace::chat::composer::{Composer, ComposerEvent};
use crate::workspace::chat::transcript::{COLUMN_WIDTH, Transcript};
use crate::workspace::chrome;

const COMPOSER_BOTTOM: f32 = 24.0;
const PILLS_BOTTOM: f32 = 8.0;

pub struct ChatView {
    title: SharedString,
    project: SharedString,
    pub transcript: Entity<Transcript>,
    pub composer: Entity<Composer>,
    composer_focused_once: bool,
    _send: Subscription,
}

impl ChatView {
    pub fn new(cx: &mut Context<Self>) -> Self {
        let transcript = cx.new(Transcript::new);
        let composer = cx.new(Composer::new);
        let send = cx.subscribe(&composer, |this, _, event: &ComposerEvent, cx| match event {
            ComposerEvent::Send(text) => this.transcript.update(cx, |transcript, cx| transcript.push_user(text.clone(), cx)),
        });
        Self {
            title: "Fix Linux onboarding intro hang".into(),
            project: "milagre-ade".into(),
            transcript,
            composer,
            composer_focused_once: false,
            _send: send,
        }
    }

    pub fn composer_focus_handle(&self, cx: &gpui::App) -> FocusHandle {
        self.composer.focus_handle(cx)
    }
}

impl Render for ChatView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // A Chat opens with the composer focused, as in the Electron app.
        if !self.composer_focused_once {
            self.composer_focused_once = true;
            let handle = self.composer.focus_handle(cx);
            window.defer(cx, move |window, cx| window.focus(&handle, cx));
        }
        let theme = *cx.theme();
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
            .child(
                div()
                    .id("transcript")
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .child(AnyView::from(self.transcript.clone()).cached(StyleRefinement::default().size_full()))
                    .child(pills(&theme)),
            )
            .child(div().flex_none().flex().justify_center().px_4().pb(px(COMPOSER_BOTTOM)).child(self.composer.clone()))
    }
}

/// "2 subagents" and "3/7", floating over the transcript's bottom edge, aligned to the column.
fn pills(theme: &Theme) -> impl IntoElement + use<> {
    div().absolute().left_0().right_0().bottom(px(PILLS_BOTTOM)).flex().justify_center().px_4().child(
        div().w_full().max_w(px(COLUMN_WIDTH)).flex().justify_between().child(pill("pill-subagents", "2 subagents", theme)).child(pill(
            "pill-progress",
            "3/7",
            theme,
        )),
    )
}

fn pill(id: &'static str, label: &'static str, theme: &Theme) -> impl IntoElement + use<> {
    div()
        .id(id)
        .debug_selector(move || id.into())
        .flex()
        .flex_none()
        .items_center()
        .h(CONTROL_SM)
        .px(px(12.0))
        .rounded_full()
        .bg(theme.surface)
        .border_1()
        .border_color(theme.line)
        .text_step(TEXT_12)
        .font_weight(FontWeight::MEDIUM)
        .text_color(theme.ink2)
        .cursor_pointer()
        .child(label)
}

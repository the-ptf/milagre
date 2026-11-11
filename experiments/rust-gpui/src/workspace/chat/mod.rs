//! Chat column: header, transcript, the running row, floating pills and composer.
//!
//! The transcript, the running row and the composer are entities of their own. The transcript and the
//! running row are drawn as cached views (`AnyView::cached`), so a keystroke in the composer or a frame of
//! the running mark re-renders that view and its ancestors but reuses the transcript's last layout and
//! paint; only `cx.notify()` on the transcript (a new item, a settled approval, a scroll) lays its visible
//! items out again. The composer is not cached: its height follows its text, and a cached view needs its
//! size before it renders. It re-renders whenever this column does (one input, cheap).

pub mod composer;
pub mod fixture;
pub mod running;
pub mod transcript;
pub mod transcript_selection;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod transcript_tests;

use gpui::{
    AnyView, Context, Entity, FocusHandle, Focusable, FontWeight, SharedString, StyleRefinement, Subscription, Window, div, prelude::*, px,
};

use crate::theme::{ActiveTheme, CONTROL_SM, CONTROL_XS, TEXT_12, TEXT_13, TextStepExt, Theme};
use crate::workspace::chat::composer::{Composer, ComposerEvent};
use crate::workspace::chat::running::RunningRow;
use crate::workspace::chat::transcript::{BOTTOM_CLEARANCE, COLUMN_WIDTH, Transcript};
use crate::workspace::chrome;

const COMPOSER_BOTTOM: f32 = 24.0;
const PILLS_BOTTOM: f32 = 8.0;

pub struct ChatView {
    title: SharedString,
    project: SharedString,
    pub transcript: Entity<Transcript>,
    pub composer: Entity<Composer>,
    /// The running turn's row, while a turn runs.
    pub running: Option<Entity<RunningRow>>,
    composer_focused_once: bool,
    _send: Subscription,
}

impl ChatView {
    pub fn new(cx: &mut Context<Self>) -> Self {
        let transcript = cx.new(Transcript::new);
        let composer = cx.new(Composer::new);
        // The fixture Chat is mid-turn: 2m 18s in.
        let running = Some(cx.new(|_| RunningRow::new("2m 18s")));
        transcript.update(cx, |transcript, cx| transcript.set_running_row(running.is_some(), cx));
        let send = cx.subscribe(&composer, |this, _, event: &ComposerEvent, cx| match event {
            ComposerEvent::Send(text) => this.transcript.update(cx, |transcript, cx| transcript.push_user(text.clone(), cx)),
        });
        Self {
            title: "Fix Linux onboarding intro hang".into(),
            project: "milagre-ade".into(),
            transcript,
            composer,
            running,
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
                    .when_some(self.running.clone(), |el, running| el.child(running_row(running)))
                    .child(pills(&theme)),
            )
            .child(div().flex_none().flex().justify_center().px_4().pb(px(COMPOSER_BOTTOM)).child(self.composer.clone()))
    }
}

/// The running row over the bottom of the transcript, where its last item would be: in the column, just
/// above the pills. The transcript keeps room for it (`Transcript::set_running_row`).
fn running_row(running: Entity<RunningRow>) -> impl IntoElement {
    div()
        .absolute()
        .left_0()
        .right_0()
        .bottom(px(BOTTOM_CLEARANCE))
        .h(CONTROL_XS)
        .flex()
        .justify_center()
        .px_4()
        .child(div().w_full().max_w(px(COLUMN_WIDTH)).h_full().child(AnyView::from(running).cached(StyleRefinement::default().size_full())))
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

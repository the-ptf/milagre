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
mod activity_tests;
#[cfg(test)]
mod cards_tests;
#[cfg(test)]
mod switch_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod transcript_tests;

use std::collections::HashMap;

use gpui::{
    AnyView, Context, Entity, FocusHandle, Focusable, FontWeight, ListState, Pixels, SharedString, StyleRefinement, Subscription, Window,
    div, prelude::*, px,
};

use crate::logic::marks::chat_mark::ChatMark;
use crate::theme::{ActiveTheme, CONTROL_SM, CONTROL_XS, TEXT_12, TEXT_13, TextStepExt, Theme};
use crate::workspace::chat::composer::{Composer, ComposerEvent};
use crate::workspace::chat::running::RunningRow;
use crate::workspace::chat::transcript::{BOTTOM_CLEARANCE, COLUMN_WIDTH, LIST_TOP_PAD, RUNNING_GAP, Transcript};
use crate::workspace::chrome;
use crate::workspace::sidebar::ChatRow;

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
    /// The Chat on screen (`None` until the sidebar has named one: the fixture shows meanwhile).
    key: Option<SharedString>,
    /// Unsent drafts of the Chats left behind, by Chat key.
    drafts: HashMap<SharedString, String>,
    _send: Subscription,
}

impl ChatView {
    pub fn new(cx: &mut Context<Self>) -> Self {
        let transcript = cx.new(Transcript::new);
        let composer = cx.new(Composer::new);
        // The fixture Chat is mid-turn: 2m 18s in.
        let running = Some(cx.new(|_| RunningRow::new("2m 18s")));
        transcript.update(cx, |transcript, cx| transcript.set_running_row(running.is_some(), cx));
        composer.update(cx, |composer, cx| composer.set_running(running.is_some(), cx));
        let send = cx.subscribe(&composer, |this, composer, event: &ComposerEvent, cx| match event {
            ComposerEvent::Send(text) if !text.is_empty() => {
                this.transcript.update(cx, |transcript, cx| transcript.push_user(text.clone(), cx))
            }
            ComposerEvent::Send(_) | ComposerEvent::Queued(_) | ComposerEvent::Compact => {}
            // Stop ends the fixture's turn: the running row goes and the send button is Send again.
            ComposerEvent::Stop => {
                this.running = None;
                this.transcript.update(cx, |transcript, cx| transcript.set_running_row(false, cx));
                composer.update(cx, |composer, cx| composer.set_running(false, cx));
                cx.notify();
            }
        });
        Self {
            title: fixture::DEFAULT_TITLE.into(),
            project: "milagre-ade".into(),
            transcript,
            composer,
            running,
            composer_focused_once: false,
            key: None,
            drafts: HashMap::new(),
            _send: send,
        }
    }

    /// The Chat on screen.
    pub fn key(&self) -> Option<&str> {
        self.key.as_deref()
    }

    pub fn title(&self) -> &str {
        &self.title
    }

    pub fn project(&self) -> &str {
        &self.project
    }

    /// A different Chat picked in the sidebar: its title and Project, its transcript, whether a turn runs, and its
    /// draft. The first Chat named keeps the fixture transcript (the default Chat's rich history). The sidebar is not
    /// touched and the transcript stays one cached leaf: only `set_items` and the composer text change.
    pub fn set_chat(&mut self, row: &ChatRow, window: &mut Window, cx: &mut Context<Self>) {
        if self.key.as_ref() == Some(&row.key) {
            return;
        }
        // The fixture's own Chat (its title is the one `new` shows) keeps the rich fixture transcript.
        let first = self.key.is_none() && row.title == self.title;
        let running = if first { self.running.is_some() } else { row.mark == ChatMark::Running };
        self.title = row.title.clone();
        self.project = row.detail.split(" \u{b7} ").next().unwrap_or_default().to_string().into();
        if let Some(old) = self.key.replace(row.key.clone()) {
            // The default Chat's draft is saved too.
            let draft = self.composer.read(cx).text().to_string();
            if draft.is_empty() {
                self.drafts.remove(&old);
            } else {
                self.drafts.insert(old, draft);
            }
        }
        if !first {
            let items = fixture::transcript_for(&row.key, &row.title);
            self.transcript.update(cx, |transcript, cx| transcript.set_items(items, cx));
            let draft = self.drafts.get(&row.key).cloned().unwrap_or_default();
            self.composer.update(cx, |composer, cx| composer.set_text(&draft, window, cx));
        }
        if running != self.running.is_some() {
            self.running = running.then(|| cx.new(|_| RunningRow::new("2m 18s")));
            self.transcript.update(cx, |transcript, cx| transcript.set_running_row(running, cx));
            self.composer.update(cx, |composer, cx| composer.set_running(running, cx));
        }
        cx.notify();
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
            // Read once the composer has drawn: its text area (and so its focus handle) is made on its first frame.
            let composer = self.composer.clone();
            window.defer(cx, move |window, cx| {
                let handle = composer.focus_handle(cx);
                window.focus(&handle, cx);
            });
        }
        let theme = *cx.theme();
        let running_offset = running_offset(self.transcript.read(cx).list_state());
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
                    .overflow_hidden()
                    .flex_1()
                    .min_h_0()
                    .child(AnyView::from(self.transcript.clone()).cached(StyleRefinement::default().size_full()))
                    .when_some(self.running.clone().zip(running_offset), |el, (running, offset)| el.child(running_row(running, offset)))
                    .child(pills(&theme)),
            )
            .child(div().flex_none().flex().justify_center().px_4().pb(px(COMPOSER_BOTTOM)).child(self.composer.clone()))
    }
}

/// How far the reader has scrolled up from the end of the list, which is how far the running row sits below its
/// pinned spot: it follows the last item, so it moves with the content (the transcript's box clips it once it is
/// out of view) instead of floating over the messages. `None` when the last items are far out of view: the list
/// has not measured the items between, so the distance is unknown, and the row is long gone anyway.
///
/// The row stays a view outside the list so that its animation never re-renders the transcript's items; the
/// scroll that moved the list re-rendered this view, so the distance is current.
fn running_offset(list: &ListState) -> Option<Pixels> {
    const FAR: usize = 40;
    let top = list.logical_scroll_top().item_ix;
    let count = list.item_count();
    if top >= count {
        return Some(px(0.0));
    }
    if count - top > FAR {
        return None;
    }
    // The list's own maximum leaves out its padding, which the scroll range includes.
    let padding = px(LIST_TOP_PAD + BOTTOM_CLEARANCE + RUNNING_GAP) + CONTROL_XS;
    Some((list.max_offset_for_scrollbar().y + padding + list.scroll_px_offset_for_scrollbar().y).max(px(0.0)))
}

/// The running row after the last item, and over the pills' strip when the list is pinned to the bottom.
fn running_row(running: Entity<RunningRow>, offset: Pixels) -> impl IntoElement {
    div()
        .absolute()
        .left_0()
        .right_0()
        .bottom(px(BOTTOM_CLEARANCE) - offset)
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

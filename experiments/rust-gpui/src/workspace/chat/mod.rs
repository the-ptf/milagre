//! Chat column: header, transcript, the running row, floating pills and composer.
//!
//! The transcript, the running row and the composer are entities of their own. The transcript and the
//! running row are drawn as cached views (`AnyView::cached`), so a keystroke in the composer or a frame of
//! the running mark re-renders that view and its ancestors but reuses the transcript's last layout and
//! paint; only `cx.notify()` on the transcript (a new item, a settled approval, a scroll) lays its visible
//! items out again. The composer is not cached: its height follows its text, and a cached view needs its
//! size before it renders. It re-renders whenever this column does (one input, cheap).

pub mod composer;
pub mod find;
pub mod find_bar;
pub mod fixture;
pub mod pills;
pub mod running;
pub mod transcript;
pub mod transcript_selection;
pub mod undo_panel;

#[cfg(test)]
mod activity_tests;
#[cfg(test)]
mod cards_tests;
#[cfg(test)]
mod find_tests;
#[cfg(test)]
mod switch_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod transcript_tests;
#[cfg(test)]
mod undo_tests;

use std::collections::HashMap;

use gpui::{
    AnyView, Context, Entity, EventEmitter, FocusHandle, Focusable, ListState, Pixels, SharedString, StyleRefinement, Subscription, Window,
    div, prelude::*, px,
};

use crate::logic::marks::chat_mark::ChatMark;
use crate::theme::{ActiveTheme, CONTROL_XS};
use crate::workspace::chat::composer::{Composer, ComposerEvent};
use crate::workspace::chat::pills::bookmark::{self, Bookmark, FamilyChat, FamilyMenu};
use crate::workspace::chat::pills::{PillEvent, PillRow};
use crate::workspace::chat::running::RunningRow;
use crate::workspace::chat::transcript::{BOTTOM_CLEARANCE, LIST_TOP_PAD, RUNNING_GAP, Transcript};
use crate::workspace::chat::undo_panel::{Intent, UndoEvent, UndoPanel};
use crate::workspace::chrome;
use crate::workspace::sidebar::ChatRow;

const COMPOSER_BOTTOM: f32 = 24.0;

/// What the Chat column asks the window to do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ChatEvent {
    /// Open this Chat (a Subchat row, the bookmark's parent, a family menu row).
    OpenChat(String),
    /// A Subchat's question answered from its row.
    Answer { chat: String, request: String, label: String },
    /// A Subchat's approval allowed or denied from its row.
    Respond { chat: String, request: String, allow: bool },
    /// The first message sent from the empty new-Chat screen: the window makes the Chat.
    StartChat(String),
}

impl EventEmitter<ChatEvent> for ChatView {}

pub struct ChatView {
    title: SharedString,
    project: SharedString,
    pub transcript: Entity<Transcript>,
    pub composer: Entity<Composer>,
    /// The running turn's row, while a turn runs.
    pub running: Option<Entity<RunningRow>>,
    composer_focused_once: bool,
    /// The pill row over the composer: Subchats, Ports, Tasks, Subagents, Go to bottom.
    pub pills: Entity<PillRow>,
    /// The Undo panel, while it replaces the composer.
    pub undo: Option<Entity<UndoPanel>>,
    _undo: Option<Subscription>,
    want_undo: Option<Intent>,
    refocus_composer: bool,
    _pill_events: Subscription,
    /// The open Chat's place in its family, read from the sidebar's Chats: the bookmark and the family menu.
    bookmark: Option<Bookmark>,
    family: Option<FamilyMenu>,
    family_open: bool,
    /// The Chat on screen (`None` until the sidebar has named one: the fixture shows meanwhile).
    key: Option<SharedString>,
    /// The empty new-Chat screen is up: no transcript, the composer and its tray centred (`isNewChat`).
    new_chat: bool,
    /// Unsent drafts of the Chats left behind, by Chat key.
    drafts: HashMap<SharedString, String>,
    _send: Subscription,
    /// The header's leading and trailing padding: the window's top bar and corner toggles reach over it (`shell`).
    header_insets: (Pixels, Pixels),
    /// Find in chat and the Quote button (`find_bar.rs`).
    find: find_bar::ChatFind,
    _transcript_events: Subscription,
}

impl ChatView {
    pub fn new(cx: &mut Context<Self>) -> Self {
        find_bar::install_keys(cx);
        let transcript = cx.new(Transcript::new);
        let transcript_events = cx.subscribe(&transcript, |this, _, event, cx| this.on_transcript_event(event, cx));
        let composer = cx.new(Composer::new);
        // The fixture Chat is mid-turn: 2m 18s in.
        let running = Some(cx.new(|_| RunningRow::new(std::time::Duration::from_secs(138))));
        transcript.update(cx, |transcript, cx| transcript.set_running_row(running.is_some(), cx));
        composer.update(cx, |composer, cx| composer.set_running(running.is_some(), cx));
        let send = cx.subscribe(&composer, |this, composer, event: &ComposerEvent, cx| match event {
            // `/undo` opens the Undo panel in the composer's place (it needs the window: the next render does it).
            ComposerEvent::Send(text) if text.trim() == "/undo" => {
                this.want_undo = Some(Intent::Undo);
                cx.notify();
            }
            // From the empty new-Chat screen the window makes the Chat first.
            ComposerEvent::Send(text) if !text.is_empty() && this.new_chat => cx.emit(ChatEvent::StartChat(text.to_string())),
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
        let pills = cx.new(|cx| PillRow::new("", fixture::DEFAULT_TITLE, cx));
        let pill_events = cx.subscribe(&pills, |this, _, event: &PillEvent, cx| match event {
            PillEvent::OpenChat(key) => cx.emit(ChatEvent::OpenChat(key.clone())),
            PillEvent::Answer { chat, request, label } => {
                cx.emit(ChatEvent::Answer { chat: chat.clone(), request: request.clone(), label: label.clone() })
            }
            PillEvent::Respond { chat, request, allow } => {
                cx.emit(ChatEvent::Respond { chat: chat.clone(), request: request.clone(), allow: *allow })
            }
            PillEvent::JumpToBottom => this.transcript.update(cx, |transcript, cx| transcript.scroll_to_bottom(cx)),
            PillEvent::Closed => {}
        });
        Self {
            title: fixture::DEFAULT_TITLE.into(),
            project: "milagre-ade".into(),
            transcript,
            composer,
            running,
            composer_focused_once: false,
            pills,
            undo: None,
            _undo: None,
            // Snapshot seed (never in tests): `MILAGRE_GPUI_UNDO=list|preview|redo` opens the Undo panel.
            want_undo: match std::env::var("MILAGRE_GPUI_UNDO").ok().as_deref() {
                Some("list" | "preview") => Some(Intent::Undo),
                Some("redo") => Some(Intent::Redo),
                _ => None,
            },
            refocus_composer: false,
            bookmark: None,
            family: None,
            family_open: false,
            _pill_events: pill_events,
            key: None,
            new_chat: false,
            drafts: HashMap::new(),
            _send: send,
            header_insets: (px(16.0), px(16.0)),
            find: find_bar::ChatFind::from_env(),
            _transcript_events: transcript_events,
        }
    }

    /// Keeps the header's identity clear of what the window draws over it (`workspace::shell::top_bar`). The
    /// window sets it while it renders, before this column does, so it needs no notify.
    pub fn set_header_insets(&mut self, leading: Pixels, trailing: Pixels) {
        self.header_insets = (leading, trailing);
    }

    pub fn header_insets(&self) -> (Pixels, Pixels) {
        self.header_insets
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
        if std::mem::take(&mut self.new_chat) {
            self.composer.update(cx, |composer, cx| composer.end_new_chat(cx));
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
        // The find bar belongs to the Chat it was opened in.
        self.close_find(window, cx);
        let (key, title) = (row.key.clone(), row.title.clone());
        self.pills.update(cx, |pills, cx| pills.set_chat(&key, &title, cx));
        self.close_undo(cx);
        self.family_open = false;
        if running != self.running.is_some() {
            self.running = running.then(|| cx.new(|_| RunningRow::new(std::time::Duration::from_secs(138))));
            self.transcript.update(cx, |transcript, cx| transcript.set_running_row(running, cx));
            self.composer.update(cx, |composer, cx| composer.set_running(running, cx));
        }
        cx.notify();
    }

    /// The empty new-Chat screen (`New Chat`, ⌘N): nothing on screen but the title, the composer in its tray with the
    /// first-Chat starters, centred in the column. The sidebar's selection is cleared by the window; picking a row
    /// again ([`ChatView::set_chat`]) leaves this screen.
    pub fn set_new_chat(&mut self, project: &str, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(old) = self.key.take() {
            let draft = self.composer.read(cx).text().to_string();
            if draft.is_empty() {
                self.drafts.remove(&old);
            } else {
                self.drafts.insert(old, draft);
            }
        }
        self.new_chat = true;
        self.title = crate::logic::copy::model_copy::UI_COPY.new_chat.into();
        self.project = "".into();
        self.transcript.update(cx, |transcript, cx| transcript.set_items(Vec::new(), cx));
        if self.running.take().is_some() {
            self.transcript.update(cx, |transcript, cx| transcript.set_running_row(false, cx));
            self.composer.update(cx, |composer, cx| composer.set_running(false, cx));
        }
        self.composer.update(cx, |composer, cx| {
            composer.set_text("", window, cx);
            composer.start_new_chat(cx);
            composer.set_starters(Some(project), cx);
        });
        self.close_find(window, cx);
        self.close_undo(cx);
        self.bookmark = None;
        self.family = None;
        self.family_open = false;
        let title = self.title.clone();
        self.pills.update(cx, |pills, cx| pills.set_chat("", &title, cx));
        self.refocus_composer = true;
        cx.notify();
    }

    /// Whether the empty new-Chat screen is up.
    pub fn is_new_chat(&self) -> bool {
        self.new_chat
    }

    /// The Chat the first message made: it opens with that message as its whole transcript.
    pub fn start_chat(&mut self, row: &ChatRow, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.set_chat(row, window, cx);
        self.transcript.update(cx, |transcript, cx| {
            transcript.set_items(Vec::new(), cx);
            transcript.push_user(text.to_owned().into(), cx);
        });
    }

    /// The Chats of the open Chat's Project as the bookmark and the family menu read them (the sidebar's data).
    pub fn set_family(&mut self, chats: &[FamilyChat], cx: &mut Context<Self>) {
        let Some(key) = self.key.clone() else { return };
        let (bookmark, family) = (bookmark::bookmark(chats, &key), bookmark::family_menu(chats, &key));
        // Snapshot seed (never in tests): `MILAGRE_GPUI_FAMILY_MENU=1` opens the family menu.
        if std::env::var_os("MILAGRE_GPUI_FAMILY_MENU").is_some() && family.is_some() {
            self.family_open = true;
        }
        if self.bookmark != bookmark || self.family != family {
            self.bookmark = bookmark;
            self.family = family;
            cx.notify();
        }
    }

    pub fn bookmark(&self) -> Option<&Bookmark> {
        self.bookmark.as_ref()
    }

    pub fn family_menu_open(&self) -> bool {
        self.family_open
    }

    pub fn toggle_family_menu(&mut self, cx: &mut Context<Self>) {
        self.family_open = !self.family_open && self.family.is_some();
        cx.notify();
    }

    pub fn close_family_menu(&mut self, cx: &mut Context<Self>) {
        if self.family_open {
            self.family_open = false;
            cx.notify();
        }
    }

    /// Opens the Undo panel in the composer's place (`/undo`, Esc Esc on the desktop).
    pub fn open_undo(&mut self, intent: Intent, window: &mut Window, cx: &mut Context<Self>) {
        let items = undo_panel::fixture();
        let panel = cx.new(|cx| UndoPanel::new(intent, items, cx));
        if std::env::var("MILAGRE_GPUI_UNDO").as_deref() == Ok("preview") {
            panel.update(cx, |panel, cx| panel.inspect("c4", cx));
        }
        let sub = cx.subscribe(&panel, |this, _, event: &UndoEvent, cx| {
            if matches!(event, UndoEvent::Closed) {
                this.close_undo(cx);
                this.refocus_composer = true;
            }
        });
        window.focus(&panel.focus_handle(cx), cx);
        self.undo = Some(panel);
        self._undo = Some(sub);
        cx.notify();
    }

    pub fn close_undo(&mut self, cx: &mut Context<Self>) {
        if self.undo.take().is_some() {
            self._undo = None;
            cx.notify();
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
            // Read once the composer has drawn: its text area (and so its focus handle) is made on its first frame.
            let composer = self.composer.clone();
            window.defer(cx, move |window, cx| {
                let handle = composer.focus_handle(cx);
                window.focus(&handle, cx);
            });
        }
        let theme = *cx.theme();
        if let Some(intent) = self.want_undo.take() {
            self.open_undo(intent, window, cx);
        }
        if std::mem::take(&mut self.refocus_composer) {
            let composer = self.composer.clone();
            window.defer(cx, move |window, cx| {
                let handle = composer.focus_handle(cx);
                window.focus(&handle, cx);
            });
        }
        let running_offset = running_offset(self.transcript.read(cx).list_state());
        // "Go to bottom" shows once the reader has scrolled more than a few lines from the end.
        let away = running_offset.is_none_or(|distance| distance > px(JUMP_THRESHOLD));
        let composer_focus = self.composer.focus_handle(cx);
        self.pills.update(cx, |pills, cx| {
            pills.set_jump(away, cx);
            pills.set_return_focus(composer_focus);
        });
        let header = chrome::header("chat-header").pl(self.header_insets.0).pr(self.header_insets.1).gap_2().relative().child(match &self
            .bookmark
        {
            Some(bookmark) => bookmark::bookmark_view(bookmark, self.family_open, &theme, cx),
            None => bookmark::identity(self.title.clone(), self.project.clone(), &theme),
        });
        let menu = match (&self.family, self.family_open, self.key.as_deref()) {
            (Some(menu), true, Some(key)) => Some(bookmark::family_menu_view(menu, key, &theme, cx)),
            _ => None,
        };
        let find_overlays = self.find_overlays(window, cx);
        let composer_bottom = COMPOSER_BOTTOM;
        self.find_actions(div(), cx)
            .relative()
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .h_full()
            .bg(theme.page)
            .child(header)
            .when(self.new_chat, |el| {
                // `isNewChat`: `justify-center`, the transcript and the pills gone.
                el.child(
                    div()
                        .id("new-chat-body")
                        .debug_selector(|| "new-chat-body".into())
                        .flex()
                        .flex_col()
                        .flex_1()
                        .min_h_0()
                        .justify_center()
                        .items_center()
                        .px_4()
                        .pb(px(composer_bottom))
                        .child(div().w_full().max_w(px(composer::new_chat::tray_width())).child(self.composer.clone())),
                )
            })
            .when(!self.new_chat, |el| {
                el.child(
                    div()
                        .id("transcript")
                        .relative()
                        .overflow_hidden()
                        .flex_1()
                        .min_h_0()
                        .child(AnyView::from(self.transcript.clone()).cached(StyleRefinement::default().size_full()))
                        .on_key_down(cx.listener(Self::on_transcript_key))
                        .when_some(self.running.clone().zip(running_offset), |el, (running, offset)| el.child(running_row(running, offset)))
                        .child(self.pills.clone())
                        .children(find_overlays),
                )
            })
            .when(!self.new_chat, |el| {
                el.child(div().flex_none().flex().justify_center().px_4().pb(px(composer_bottom)).child(match &self.undo {
                    // The panel takes the composer's place, as wide as it.
                    Some(undo) => div().w_full().max_w(px(crate::theme::column_width())).child(undo.clone()).into_any_element(),
                    None => self.composer.clone().into_any_element(),
                }))
            })
            .children(menu)
    }
}

/// How far from the end (px) the transcript must be scrolled before "Go to bottom" shows.
const JUMP_THRESHOLD: f32 = 48.0;

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
    div().absolute().left_0().right_0().bottom(px(BOTTOM_CLEARANCE) - offset).h(CONTROL_XS).flex().justify_center().px_4().child(
        div()
            .w_full()
            .max_w(px(crate::theme::column_width()))
            .h_full()
            .child(AnyView::from(running).cached(StyleRefinement::default().size_full())),
    )
}

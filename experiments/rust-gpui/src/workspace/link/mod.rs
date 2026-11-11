//! The Link workspace (V-03, WP-48): `LinkWorkspace.tsx`. A named Link's shared Chats across its Projects, in place of
//! the window's sidebar and columns: the Link's own sidebar (its Projects and Chats), the shared Chat in a `ChatView`
//! of its own, and the member-aware Changes panel (`changes.rs`), with the Changes toggle in the corner. Escape (or the
//! sidebar's back row) leaves the Link. Fixture data only (`fixture.rs`).
//!
//! Not yet: the Link's own command palette (New Chat, Link Projects…, Edit Link…, its Chats and Projects), the Git
//! "Choose a Project" dialog, the per-Project PR tabs and the Canvas; they come with the daemon's `link:*` calls.

pub mod changes;
pub mod fixture;
pub mod hooks;

#[cfg(test)]
mod tests;

use std::collections::HashSet;

use gpui::{
    AnyElement, ClickEvent, Context, ElementId, Entity, EventEmitter, FocusHandle, FontWeight, KeyDownEvent, SharedString, Window, div,
    prelude::*, px,
};

use self::changes::{Picked, changed_count};
use self::fixture::{Link, LinkChat};
use crate::theme::{ActiveTheme, HEADER_HEIGHT, RADIUS_CHIP, RADIUS_CONTROL, TEXT_11, TEXT_12, TEXT_13, TextStepExt};
use crate::ui::{Icon, IconButton, IconButtonSize, IconName, IconSize, ProjectAvatar, SectionLabel, Tooltip};
use crate::workspace::chat::ChatView;
use crate::workspace::chrome::NoDrag;
use crate::workspace::shell::top_bar::{self, BUTTON, CORNER_RIGHT};
use crate::workspace::sidebar::{ChatRow, SIDEBAR_WIDTH};

/// What the Link workspace asks the window to do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LinkEvent {
    /// Leave the Link: the window's sidebar and columns come back.
    Close,
}

impl EventEmitter<LinkEvent> for LinkWorkspace {}

pub struct LinkWorkspace {
    pub link: Link,
    /// The shared Chat on screen, by id.
    selected: u64,
    /// The Link's own Chat column.
    pub chat: Entity<ChatView>,
    changes_open: bool,
    /// Members whose section is folded, by Project id.
    collapsed: HashSet<&'static str>,
    /// The file the diff would show, with its member.
    picked: Option<Picked>,
    focus: FocusHandle,
}

impl LinkWorkspace {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let link = fixture::link();
        let selected = link.chats.first().map_or(0, |chat| chat.id);
        let chat = cx.new(ChatView::new);
        let mut this =
            Self { link, selected: 0, chat, changes_open: true, collapsed: HashSet::new(), picked: None, focus: cx.focus_handle() };
        this.select(selected, window, cx);
        this
    }

    pub fn selected_chat(&self) -> Option<&LinkChat> {
        self.link.chats.iter().find(|chat| chat.id == self.selected)
    }

    pub fn changes_open(&self) -> bool {
        self.changes_open
    }

    pub fn picked(&self) -> Option<&Picked> {
        self.picked.as_ref()
    }

    pub fn collapsed(&self, project_id: &str) -> bool {
        self.collapsed.contains(project_id)
    }

    /// A Link Chat as the Chat column's header names it: its title over the Link's name.
    fn row(&self, chat: &LinkChat) -> ChatRow {
        ChatRow {
            key: self.link.chat_key(chat.id).into(),
            initial: self.link.name.chars().next().map(String::from).unwrap_or_default().into(),
            tile: None,
            title: chat.title.into(),
            detail: self.link.name.into(),
            offline: None,
            mark: chat.mark,
            failed: false,
            background: 0,
            depth: 0,
            family: None,
        }
    }

    /// Opens a shared Chat: its transcript and draft in the Link's Chat column; the picked file was the old Chat's.
    pub fn select(&mut self, id: u64, window: &mut Window, cx: &mut Context<Self>) {
        let Some(chat) = self.link.chats.iter().find(|chat| chat.id == id) else { return };
        let row = self.row(chat);
        self.selected = id;
        self.picked = None;
        self.chat.update(cx, |view, cx| view.set_chat(&row, window, cx));
        cx.notify();
    }

    pub fn toggle_changes(&mut self, cx: &mut Context<Self>) {
        self.changes_open = !self.changes_open;
        cx.notify();
    }

    pub fn toggle_member(&mut self, project_id: &'static str, cx: &mut Context<Self>) {
        if !self.collapsed.remove(project_id) {
            self.collapsed.insert(project_id);
        }
        cx.notify();
    }

    pub fn pick_file(&mut self, picked: Picked, cx: &mut Context<Self>) {
        self.picked = Some(picked);
        cx.notify();
    }

    fn on_key(&mut self, event: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        if event.keystroke.key == "escape" && !event.keystroke.modifiers.modified() {
            cx.emit(LinkEvent::Close);
            cx.stop_propagation();
        }
    }

    fn sidebar(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let projects = div()
            .flex()
            .items_center()
            .gap_1()
            .children(self.link.projects.iter().map(|project| ProjectAvatar::new(project.name).size(16.0)))
            .child(div().pl_1().text_step(TEXT_11).text_color(theme.ink3).child(format!("{} Projects", self.link.projects.len())));
        let header = div()
            .flex()
            .flex_col()
            .gap_1()
            .px_3()
            .pb_3()
            .child(
                div().flex().items_center().gap_1p5().child(Icon::new(IconName::Link04).size(IconSize::S16).color(theme.ink2)).child(
                    div().truncate().text_step(TEXT_13).font_weight(FontWeight::SEMIBOLD).text_color(theme.ink).child(self.link.name),
                ),
            )
            .child(projects);
        let back = div()
            .id("link-back")
            .debug_selector(|| "link-back".into())
            .mx_2()
            .mb_2()
            .h(px(28.0))
            .px_2()
            .flex()
            .items_center()
            .gap_1p5()
            .rounded(RADIUS_CONTROL)
            .text_step(TEXT_12)
            .text_color(theme.ink2)
            .cursor_pointer()
            .hover(move |style| style.bg(theme.hover))
            .on_click(cx.listener(|_, _: &ClickEvent, _, cx| cx.emit(LinkEvent::Close)))
            .child(Icon::new(IconName::ArrowLeft01).size(IconSize::S14).color(theme.ink3))
            .child("Back to Projects");
        let rows = self.link.chats.iter().map(|chat| {
            let id = chat.id;
            let selected = id == self.selected;
            let projects: Vec<&str> =
                chat.members.iter().filter_map(|member| self.link.project(member.project_id).map(|project| project.name)).collect();
            let detail = if projects.is_empty() { "No Worktree yet".to_string() } else { projects.join(", ") };
            let selector = format!("link-chat-{id}");
            let dot = crate::logic::marks::chat_mark::chat_mark_tone(chat.mark);
            div()
                .id(ElementId::from(SharedString::from(selector.clone())))
                .debug_selector(move || selector.clone())
                .mx_2()
                .px_2()
                .py_1p5()
                .flex()
                .items_center()
                .gap_2()
                .rounded(RADIUS_CHIP)
                .cursor_pointer()
                .when(selected, |el| el.bg(theme.hover2))
                .when(!selected, |el| el.hover(move |style| style.bg(theme.hover)))
                .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| this.select(id, window, cx)))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .flex_1()
                        .min_w_0()
                        .child(div().truncate().text_step(TEXT_13).text_color(theme.ink).child(chat.title))
                        .child(div().truncate().text_step(TEXT_11).text_color(theme.ink3).child(detail)),
                )
                .when(chat.mark != crate::logic::marks::chat_mark::ChatMark::Idle, |el| {
                    el.child(div().flex_none().size(px(8.0)).rounded_full().bg(match dot {
                        crate::logic::marks::tone::Tone::Orange => theme.orange,
                        crate::logic::marks::tone::Tone::Red => theme.red,
                        _ => theme.accent,
                    }))
                })
        });
        div()
            .id("link-sidebar")
            .debug_selector(|| "link-sidebar".into())
            .flex()
            .flex_col()
            .flex_none()
            .w(px(SIDEBAR_WIDTH))
            .h_full()
            .bg(theme.canvas)
            // The window's bar draws over the first 44px.
            .pt(HEADER_HEIGHT)
            .child(back)
            .child(header)
            .child(div().px_3().pb_1().child(SectionLabel::new("Chats")))
            .child(div().id("link-chats").flex_1().min_h_0().overflow_y_scroll().flex().flex_col().gap_0p5().children(rows))
            .into_any_element()
    }

    /// The corner's Changes toggle (`ChangesToggle`), over the Chat column's top right.
    fn corner(&self, count: usize, cx: &mut Context<Self>) -> AnyElement {
        let label = if self.changes_open { "Hide Changes" } else { "Show Changes" };
        div()
            .id("link-corner")
            .debug_selector(|| "link-corner".into())
            .absolute()
            .top((HEADER_HEIGHT - px(BUTTON)) / 2.0)
            .right(px(CORNER_RIGHT))
            .occlude()
            .no_drag()
            .tooltip(Tooltip::new(format!("{label} ({count} files)")).build())
            .child(
                IconButton::new("link-changes-toggle", IconName::FileDiff)
                    .size(IconButtonSize::S32)
                    .glyph(IconSize::S16)
                    .pressed(self.changes_open)
                    .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.toggle_changes(cx))),
            )
            .into_any_element()
    }
}

impl gpui::Focusable for LinkWorkspace {
    fn focus_handle(&self, _: &gpui::App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for LinkWorkspace {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.theme();
        let chat = self.selected_chat().cloned();
        let count = chat.as_ref().map_or(0, changed_count);
        // The header keeps clear of the window's bar on the left (the sidebar is open) and the toggle on the right.
        let insets = (px(top_bar::HEADER_PAD), top_bar::chat_trailing_inset(1));
        self.chat.update(cx, |view, _| view.set_header_insets(insets.0, insets.1));
        let panel = match (&chat, self.changes_open) {
            (Some(chat), true) => Some(self.changes_panel(chat, cx)),
            _ => None,
        };
        div()
            .id("link-workspace")
            .debug_selector(|| "link-workspace".into())
            .track_focus(&self.focus)
            .on_key_down(cx.listener(Self::on_key))
            .flex()
            .flex_row()
            .size_full()
            .bg(theme.page)
            .child(self.sidebar(cx))
            .child(div().flex_none().w(px(1.0)).h_full().bg(theme.line))
            .child(div().relative().flex().flex_1().min_w_0().h_full().child(self.chat.clone()).child(self.corner(count, cx)))
            .children(panel)
            .text_step(TEXT_13)
    }
}

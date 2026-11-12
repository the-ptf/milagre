//! The Details tab of the side panel, modelled on Claude desktop's details sidebar: sections with a muted heading,
//! then rows (a 16px icon, a label, a muted trailing value) with a hairline between sections (`HAIRLINE`; a 12px gap while it is 0). It is new; the React
//! desktop has no such panel.
//!
//! - Environment: the computer and how it is connected, the repo, the Worktree's branch and its path (click copies
//!   it; the Finder and editor buttons ask the host to open it).
//! - Context: tokens used of the window; expands to the composer ring's bar and Compact on Claude.
//! - Children (collapsible, like T3 Code's Lineage): the open Chat's Subchats, nested, and its parent when it is one. A row opens that Chat
//!   ([`DetailsEvent::OpenChat`]): the Workspace selects it, since the sidebar no longer lists Subchats.
//! - Background tasks (collapsible): running commands, ports and subagents with their time and a stop button, then "N finished".
//! - Links and PR, only when the Chat has them.
//!
//! Everything the host would do (copy aside) is recorded in [`DetailsView::requests`], the fixture's stand-in.
//! The rows follow the Chat ([`DetailsView::set_chat`]).

pub mod data;
pub mod family;
pub mod fixture;
mod rows;

#[cfg(test)]
mod tests;

use std::sync::Arc;
use std::time::Duration;

use gpui::{ClickEvent, ClipboardItem, Context, EventEmitter, ScrollHandle, SharedString, Task, Window, div, prelude::*, px};

use self::data::DetailsData;
use self::family::Family;
use crate::data::DataSource;
use crate::settings::SettingsStore;
use crate::settings::store::EditorChoice;
use crate::theme::{ActiveTheme, HAIRLINE};
use crate::ui::ScrollArea;
use crate::workspace::chat::pills::bookmark::FamilyChat;

/// The row height, the side padding and the longest branch and path the rows show before cutting the middle (they
/// fit the Changes panel's default width).
pub(crate) const ROW_HEIGHT: f32 = 32.0;
pub(crate) const PAD_X: f32 = 16.0;
/// The vertical gap between two sections (the room a heading's rule used to leave).
pub(crate) const SECTION_GAP: f32 = 12.0;
pub(crate) const BRANCH_CHARS: usize = 34;
pub(crate) const PATH_CHARS: usize = 26;
/// How long "Copied" stays in place of the path's buttons.
const COPIED_FOR: Duration = Duration::from_millis(1500);

/// What the host is asked for (the fixture only records it).
#[derive(Clone, Debug, PartialEq)]
pub enum Request {
    Finder(String),
    Editor { path: String, editor: &'static str },
    Compact,
    StopCommand(String),
    StopPort(u32),
    StopAgent(String),
    OpenLinear(String),
    OpenPr(u32),
    OpenLinked(String),
}

/// Tells the Workspace to select a Chat (a Subchat or the parent).
pub enum DetailsEvent {
    OpenChat(String),
}

impl EventEmitter<DetailsEvent> for DetailsView {}

pub struct DetailsView {
    key: SharedString,
    pr: Option<u32>,
    seeded: bool,
    source: Option<Arc<dyn DataSource>>,
    data: DetailsData,
    chats: Vec<FamilyChat>,
    /// The Workspace pushed the list: it is not read from the source again.
    chats_pushed: bool,
    family: Family,
    context_open: bool,
    finished_open: bool,
    /// The Children, Background tasks and Links sections' open state: kept for the session, across Chats.
    children_open: bool,
    background_open: bool,
    links_open: bool,
    copied: bool,
    copy_timer: Option<Task<()>>,
    requests: Vec<Request>,
    copied_text: Option<String>,
    scroll: ScrollHandle,
    /// Every `render`, for the tests that check what a change elsewhere re-renders.
    renders: usize,
}

impl DetailsView {
    pub fn new(cx: &mut Context<Self>) -> Self {
        // Snapshot seed: `MILAGRE_GPUI_DETAILS_FOLD=children,background,links` starts those sections folded.
        let fold = if cfg!(test) { String::new() } else { std::env::var("MILAGRE_GPUI_DETAILS_FOLD").unwrap_or_default() };
        Self {
            key: SharedString::default(),
            pr: None,
            seeded: false,
            source: cx.try_global::<crate::data::Data>().map(|data| data.0.clone()),
            data: DetailsData::default(),
            chats: Vec::new(),
            chats_pushed: false,
            family: Family::default(),
            context_open: false,
            finished_open: false,
            children_open: !fold.contains("children"),
            background_open: !fold.contains("background"),
            links_open: !fold.contains("links"),
            copied: false,
            copy_timer: None,
            requests: Vec::new(),
            copied_text: None,
            scroll: ScrollHandle::new(),
            renders: 0,
        }
    }

    /// Follows the Chat: its rows, with the sections folded again. `pr` is the number the PR tab shows; `seeded` is
    /// the Chat open at startup.
    pub fn set_chat(&mut self, key: impl Into<SharedString>, pr: Option<u32>, seeded: bool, cx: &mut Context<Self>) {
        self.key = key.into();
        // Snapshot seed (never in tests): `MILAGRE_GPUI_DETAILS_CHAT=<title>` shows that Chat's Details instead.
        if !cfg!(test)
            && let (Ok(title), Some(source)) = (std::env::var("MILAGRE_GPUI_DETAILS_CHAT"), self.source.as_ref())
            && let Some(chat) = family::from_source(source, &self.key).into_iter().find(|chat| chat.title == title)
        {
            self.key = chat.key.into();
        }
        self.pr = pr;
        self.seeded = seeded;
        self.context_open = false;
        self.finished_open = false;
        self.copied = false;
        self.copy_timer = None;
        self.reload(cx);
    }

    /// The Workspace's list of every Chat with its mark (the sidebar's `family_chats`): the Subchats and the parent.
    pub fn set_family(&mut self, chats: &[FamilyChat], cx: &mut Context<Self>) {
        if self.chats_pushed && self.chats == chats {
            return;
        }
        self.chats = chats.to_vec();
        self.chats_pushed = true;
        self.family = family::family(&self.chats, &self.key);
        cx.notify();
    }

    fn reload(&mut self, cx: &mut Context<Self>) {
        self.data = DetailsData::load(&self.key, self.pr, self.seeded, self.source.as_ref());
        if !self.chats_pushed {
            self.chats = self.source.as_ref().map(|source| family::from_source(source, &self.key)).unwrap_or_default();
        }
        self.family = family::family(&self.chats, &self.key);
        cx.notify();
    }

    pub fn key(&self) -> &str {
        &self.key
    }

    pub fn data(&self) -> &DetailsData {
        &self.data
    }

    pub fn family(&self) -> &Family {
        &self.family
    }

    pub fn requests(&self) -> &[Request] {
        &self.requests
    }

    pub fn copied_text(&self) -> Option<&str> {
        self.copied_text.as_deref()
    }

    pub fn is_copied(&self) -> bool {
        self.copied
    }

    pub fn context_open(&self) -> bool {
        self.context_open
    }

    pub fn finished_open(&self) -> bool {
        self.finished_open
    }

    pub fn children_open(&self) -> bool {
        self.children_open
    }

    pub fn background_open(&self) -> bool {
        self.background_open
    }

    pub fn links_open(&self) -> bool {
        self.links_open
    }

    pub fn renders(&self) -> usize {
        self.renders
    }

    pub fn toggle_context(&mut self, cx: &mut Context<Self>) {
        self.context_open = !self.context_open;
        cx.notify();
    }

    pub fn toggle_children(&mut self, cx: &mut Context<Self>) {
        self.children_open = !self.children_open;
        cx.notify();
    }

    pub fn toggle_background(&mut self, cx: &mut Context<Self>) {
        self.background_open = !self.background_open;
        cx.notify();
    }

    pub fn toggle_links(&mut self, cx: &mut Context<Self>) {
        self.links_open = !self.links_open;
        cx.notify();
    }

    pub fn toggle_finished(&mut self, cx: &mut Context<Self>) {
        self.finished_open = !self.finished_open;
        cx.notify();
    }

    /// Copies the Worktree's path and says so for a moment.
    pub fn copy_path(&mut self, cx: &mut Context<Self>) {
        let Some(path) = self.data.path.clone() else { return };
        cx.write_to_clipboard(ClipboardItem::new_string(path.clone()));
        self.copied_text = Some(path);
        self.copied = true;
        self.copy_timer = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(COPIED_FOR).await;
            this.update(cx, |this, cx| {
                this.copied = false;
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    pub fn reveal_in_finder(&mut self, cx: &mut Context<Self>) {
        if let Some(path) = self.data.path.clone() {
            self.requests.push(Request::Finder(path));
            cx.notify();
        }
    }

    pub fn open_in_editor(&mut self, cx: &mut Context<Self>) {
        if let Some(path) = self.data.path.clone() {
            self.requests.push(Request::Editor { path, editor: self.editor(cx).0 });
            cx.notify();
        }
    }

    /// The editor Settings › General opens files in: its name for the tooltip.
    pub(crate) fn editor(&self, cx: &gpui::App) -> (&'static str, &'static str) {
        let choice = cx.try_global::<SettingsStore>().map_or(EditorChoice::System, |store| store.default_editor);
        match choice {
            EditorChoice::Cursor => ("Cursor", "Open in Cursor"),
            EditorChoice::Vscode => ("VS Code", "Open in VS Code"),
            EditorChoice::Zed => ("Zed", "Open in Zed"),
            EditorChoice::System => ("Default editor", "Open in the default editor"),
        }
    }

    pub fn compact(&mut self, cx: &mut Context<Self>) {
        self.requests.push(Request::Compact);
        cx.notify();
    }

    /// Stops a command, a port or a subagent: it leaves the running list at once (a subagent moves to the finished
    /// ones as stopped).
    pub fn stop(&mut self, request: Request, cx: &mut Context<Self>) {
        match &request {
            Request::StopCommand(id) => self.data.commands.retain(|command| &command.id != id),
            Request::StopPort(pid) => self.data.ports.retain(|port| port.pid != *pid),
            Request::StopAgent(id) => {
                let now = self.data.agents_now;
                for agent in self.data.agents.iter_mut().filter(|agent| &agent.id == id) {
                    agent.status = crate::workspace::chat::pills::data::AgentStatus::Cancelled;
                    agent.ended_at = Some(now);
                }
            }
            _ => return,
        }
        self.requests.push(request);
        cx.notify();
    }

    pub fn open_chat(&mut self, key: &str, cx: &mut Context<Self>) {
        cx.emit(DetailsEvent::OpenChat(key.to_owned()));
    }

    pub fn open_linear(&mut self, issue: &str, cx: &mut Context<Self>) {
        self.requests.push(Request::OpenLinear(issue.to_owned()));
        cx.notify();
    }

    pub fn open_pr(&mut self, number: u32, cx: &mut Context<Self>) {
        self.requests.push(Request::OpenPr(number));
        cx.notify();
    }

    pub fn open_linked(&mut self, name: &str, cx: &mut Context<Self>) {
        self.requests.push(Request::OpenLinked(name.to_owned()));
        cx.notify();
    }
}

impl Render for DetailsView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.renders += 1;
        let theme = *cx.theme();
        let mut sections: Vec<gpui::AnyElement> = vec![self.environment(&theme, cx)];
        if self.data.context.is_some() {
            sections.push(self.context(&theme, cx));
        }
        if !self.family.is_empty() {
            sections.push(self.subchats(&theme, cx));
        }
        sections.push(self.background(&theme, cx));
        if self.data.has_links_section() {
            sections.push(self.links(&theme, cx));
        }
        let mut body: Vec<gpui::AnyElement> = Vec::new();
        for (ix, section) in sections.into_iter().enumerate() {
            if ix > 0 {
                body.push(separator(&theme));
            }
            body.push(section);
        }
        div().size_full().bg(theme.canvas).child(
            ScrollArea::new("details-scroll", &self.scroll)
                .child(div().flex().flex_col().w_full().pt(px(SECTION_GAP)).pb(px(12.0)).children(body)),
        )
    }
}

/// Between two sections: a `HAIRLINE` rule with room under it, or with no hairline a plain gap of `SECTION_GAP`.
fn separator(theme: &crate::theme::Theme) -> gpui::AnyElement {
    if HAIRLINE > px(0.0) {
        div().flex_none().w_full().h(HAIRLINE).mb(px(SECTION_GAP)).bg(theme.line).into_any_element()
    } else {
        div().flex_none().w_full().h(px(SECTION_GAP)).into_any_element()
    }
}

/// `ClickEvent` handler that calls a method on the view.
pub(crate) fn on<F>(cx: &mut Context<DetailsView>, f: F) -> impl Fn(&ClickEvent, &mut Window, &mut gpui::App) + 'static
where
    F: Fn(&mut DetailsView, &mut Context<DetailsView>) + 'static,
{
    cx.listener(move |this, _: &ClickEvent, _window, cx| f(this, cx))
}

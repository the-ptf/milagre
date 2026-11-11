//! Side panel column: the tab strip in the 44px header (`ui::Tab` in a horizontally scrolling list, expand and
//! close pinned at the right) over the open tab's body.
//!
//! - State is per Chat: which tab is open, whether the panel is shown, whether it is expanded. Switching Chats in
//!   the sidebar ([`Panel::set_chat`], driven by the Workspace) brings back that Chat's, and shows only the tabs the
//!   Chat has content for (`fixture::ChatContent::has`).
//! - Widths are per panel kind and last the session (`dock.rs`, the desktop's `panel-width.ts`).
//! - Every body is its own view mounted cached with a fixed size: the Changes tab is [`ChangesView`], the rest are
//!   [`body::TabPlaceholder`]s. The panel itself holds no state a body changes, so typing in the composer or a
//!   transcript animation re-renders none of them.

pub mod artifacts;
pub mod body;
pub mod changes;
pub mod dock;
pub mod fixture;
pub mod pr;
pub mod terminal;

#[cfg(test)]
mod dock_tests;
#[cfg(test)]
mod tests;

use std::collections::HashMap;

use gpui::{
    AnyElement, AnyView, ClickEvent, Context, Entity, EventEmitter, ScrollHandle, SharedString, StyleRefinement, Window, div, prelude::*,
    px,
};
use gpui_component::resizable::ResizableState;

use self::artifacts::ArtifactsView;
use self::body::TabPlaceholder;
use self::changes::ChangesView;
use self::fixture::ChatContent;
use self::pr::{PrEvent, PrView};
use crate::theme::ActiveTheme;
use crate::ui::{IconButton, IconButtonSize, IconName, IconSize, Tab};
use crate::workspace::chrome::{self, NoDrag};
use crate::workspace::sidebar::SidebarSeed;

/// The Changes panel's default width (`PANEL_WIDTHS.changes.default`), where the panel opens.
pub const PANEL_WIDTH: f32 = 320.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PanelTab {
    Changes,
    Browser,
    Designs,
    Artifact,
    Pr,
}

impl PanelTab {
    /// Terminals live in the drawer under the Chat (`panel/terminal/`), as on the desktop.
    pub const ALL: [PanelTab; 5] = [PanelTab::Changes, PanelTab::Browser, PanelTab::Designs, PanelTab::Artifact, PanelTab::Pr];

    pub fn label(self) -> &'static str {
        match self {
            PanelTab::Changes => "Changes",
            PanelTab::Browser => "Browser",
            PanelTab::Designs => "Designs",
            PanelTab::Artifact => "Artifact",
            PanelTab::Pr => "PR",
        }
    }

    /// The desktop's tab glyphs (`agents/PanelToggles.tsx`).
    pub fn icon(self) -> IconName {
        match self {
            PanelTab::Changes => IconName::FileDiff,
            PanelTab::Browser => IconName::Globe02,
            PanelTab::Designs => IconName::PaintBoard,
            PanelTab::Artifact => IconName::File01,
            PanelTab::Pr => IconName::GitPullRequest,
        }
    }
}

/// Tells the Workspace the panel's place in the window changed (shown, hidden, expanded, another width).
pub enum PanelEvent {
    Layout,
}

impl EventEmitter<PanelEvent> for Panel {}

/// What a Chat keeps of its panel.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ChatPanel {
    open: bool,
    tab: PanelTab,
    expanded: bool,
}

impl Default for ChatPanel {
    fn default() -> Self {
        Self { open: true, tab: PanelTab::Changes, expanded: false }
    }
}

pub struct Panel {
    chat: SharedString,
    /// The Chat open at startup: the fixture gives it every tab.
    seeded: Option<SharedString>,
    content: ChatContent,
    states: HashMap<SharedString, ChatPanel>,
    /// Widths dragged this session, by panel kind (`PanelTab::width_key`).
    widths: HashMap<PanelTab, f32>,
    /// The dock's split state. A new one whenever the layout changes, so the panel opens at its width.
    resizable: Entity<ResizableState>,
    /// Horizontal scroll of the tab list; also used to bring a clicked tab fully into view.
    tabs_scroll: ScrollHandle,
    changes: Entity<ChangesView>,
    artifacts: Entity<ArtifactsView>,
    pr: Entity<PrView>,
    placeholders: HashMap<PanelTab, Entity<TabPlaceholder>>,
    /// Every `render`, for the tests that check what a change elsewhere re-renders.
    renders: usize,
}

impl Panel {
    pub fn new(cx: &mut Context<Self>) -> Self {
        let seeded: Option<SharedString> = cx.try_global::<SidebarSeed>().and_then(|seed| seed.open_chat.clone()).map(Into::into);
        let chat = seeded.clone().unwrap_or_default();
        let content = fixture::content_for(&chat, seeded.as_deref());
        let changes = cx.new(ChangesView::new);
        changes.update(cx, |changes, cx| changes.set_chat(chat.clone(), content.changes.clone(), cx));
        let pr = cx.new(PrView::new);
        pr.update(cx, |pr, cx| pr.set_chat(chat.clone(), content.pr, pr::local_files(&content.changes), cx));
        cx.subscribe(&pr, |panel, _, event: &PrEvent, cx| {
            if let PrEvent::OpenChanges = event {
                panel.activate(PanelTab::Changes, cx);
            }
        })
        .detach();
        let placeholders = PanelTab::ALL
            .into_iter()
            .filter(|tab| !matches!(tab, PanelTab::Changes | PanelTab::Pr))
            .map(|tab| (tab, cx.new(|_| TabPlaceholder::new(tab))))
            .collect();
        let mut panel = Self {
            chat,
            seeded,
            content,
            states: HashMap::new(),
            widths: HashMap::new(),
            resizable: cx.new(|_| ResizableState::default()),
            tabs_scroll: ScrollHandle::new(),
            changes,
            artifacts: {
                let panel = cx.entity();
                cx.new(|cx| ArtifactsView::new(&panel, cx))
            },
            pr,
            placeholders,
            renders: 0,
        };
        panel.apply_env_seed(cx);
        panel
    }

    /// Snapshot runs pick a width and a file through the environment (never in tests).
    fn apply_env_seed(&mut self, cx: &mut Context<Self>) {
        if cfg!(test) {
            return;
        }
        if let Some(width) = std::env::var("MILAGRE_GPUI_PANEL_WIDTH").ok().and_then(|w| w.parse::<f32>().ok()) {
            self.set_width(width);
        }
        if let Some(tab) = std::env::var("MILAGRE_GPUI_PANEL_TAB").ok().and_then(|n| PanelTab::ALL.into_iter().find(|t| t.label() == n)) {
            self.state_mut().tab = tab;
        }
        if let Ok(path) = std::env::var("MILAGRE_GPUI_CHANGES_FILE") {
            self.changes
                .update(cx, |changes, cx| changes.select_file(changes::Source::Section(changes::data::Section::Uncommitted), path, cx));
        }
    }

    fn state(&self) -> ChatPanel {
        self.states.get(&self.chat).copied().unwrap_or_default()
    }

    fn state_mut(&mut self) -> &mut ChatPanel {
        self.states.entry(self.chat.clone()).or_default()
    }

    pub fn active(&self) -> PanelTab {
        self.state().tab
    }

    pub fn is_open(&self) -> bool {
        self.state().open
    }

    pub fn is_expanded(&self) -> bool {
        self.state().expanded
    }

    pub fn chat(&self) -> &str {
        &self.chat
    }

    /// The tabs the Chat on screen has, in order.
    pub fn visible_tabs(&self) -> Vec<PanelTab> {
        PanelTab::ALL.into_iter().filter(|tab| self.content.has(*tab)).collect()
    }

    /// The open tab's width: dragged this session, else its default.
    pub fn width(&self) -> f32 {
        let tab = self.active();
        self.widths.get(&tab.width_key()).copied().unwrap_or(tab.width_rule().default)
    }

    pub fn resizable(&self) -> &Entity<ResizableState> {
        &self.resizable
    }

    pub fn changes(&self) -> &Entity<ChangesView> {
        &self.changes
    }

    pub fn body_view(&self, tab: PanelTab) -> Option<AnyView> {
        match tab {
            PanelTab::Changes => Some(self.changes.clone().into()),
            PanelTab::Artifact => Some(self.artifacts.clone().into()),
            PanelTab::Pr => Some(self.pr.clone().into()),
            other => self.placeholders.get(&other).map(|view| view.clone().into()),
        }
    }

    /// How many times the panel has rendered.
    pub fn renders(&self) -> usize {
        self.renders
    }

    pub fn tabs_scroll(&self) -> &ScrollHandle {
        &self.tabs_scroll
    }

    /// Records the width a drag ended on. It does not move anything: the split already shows it.
    pub fn set_width(&mut self, width: f32) {
        let tab = self.active();
        self.widths.insert(tab.width_key(), tab.width_rule().clamp(width));
    }

    /// Back to the tab's default width (the double-click on the edge).
    pub fn reset_width(&mut self, cx: &mut Context<Self>) {
        self.widths.remove(&self.active().width_key());
        self.relayout(cx);
    }

    /// The panel's place in the window changed: the split starts again at the panel's width.
    fn relayout(&mut self, cx: &mut Context<Self>) {
        self.resizable = cx.new(|_| ResizableState::default());
        cx.emit(PanelEvent::Layout);
        cx.notify();
    }

    /// Switches to `chat`: its own open tab, panel and width, and its own Changes.
    pub fn set_chat(&mut self, chat: impl Into<SharedString>, cx: &mut Context<Self>) {
        let chat = chat.into();
        if chat == self.chat {
            return;
        }
        self.chat = chat;
        self.content = fixture::content_for(&self.chat, self.seeded.as_deref());
        // A tab this Chat has no content for falls back to Changes.
        if !self.content.has(self.state().tab) {
            self.state_mut().tab = PanelTab::Changes;
        }
        let (key, data) = (self.chat.clone(), self.content.changes.clone());
        let local = pr::local_files(&data);
        self.pr.update(cx, |pr, cx| pr.set_chat(key.clone(), self.content.pr, local, cx));
        self.changes.update(cx, |changes, cx| changes.set_chat(key, data, cx));
        self.relayout(cx);
    }

    pub fn activate(&mut self, tab: PanelTab, cx: &mut Context<Self>) {
        if !self.content.has(tab) {
            return;
        }
        let ix = self.visible_tabs().iter().position(|t| *t == tab).unwrap_or(0);
        // Applied while the list paints next frame: scrolls the least needed to show the tab fully.
        self.tabs_scroll.scroll_to_item(ix);
        let state = self.state_mut();
        let changed_width = state.tab.width_key() != tab.width_key() || !state.open;
        state.tab = tab;
        state.open = true;
        if changed_width {
            self.relayout(cx);
        } else {
            cx.notify();
        }
    }

    /// A tab's shortcut: show it, or hide the panel when that tab is already the one showing.
    pub fn toggle_tab(&mut self, tab: PanelTab, cx: &mut Context<Self>) {
        let state = self.state();
        if state.open && state.tab == tab {
            self.close(cx);
        } else {
            self.activate(tab, cx);
        }
    }

    pub fn close(&mut self, cx: &mut Context<Self>) {
        let state = self.state_mut();
        state.open = false;
        state.expanded = false;
        self.relayout(cx);
    }

    pub fn toggle_expand(&mut self, cx: &mut Context<Self>) {
        let state = self.state_mut();
        state.expanded = !state.expanded;
        self.relayout(cx);
    }

    fn header(&self, cx: &mut Context<Self>) -> AnyElement {
        let active = self.active();
        let expanded = self.is_expanded();
        let tabs = self.visible_tabs().into_iter().map(|tab| {
            Tab::new(tab.label(), tab.label())
                .selector(format!("panel-tab-{}", tab.label()))
                .icon(tab.icon())
                .active(tab == active)
                .when(tab == PanelTab::Changes && self.content.changes.file_count() > 0, |el| {
                    el.count(self.content.changes.file_count().to_string())
                })
                .when_some(self.content.pr.filter(|_| tab == PanelTab::Pr), |el, number| el.count(format!("#{number}")))
                .on_click(cx.listener(move |this, _: &ClickEvent, _window, cx| this.activate(tab, cx)))
        });
        // Expand and close: 24px buttons with 16px glyphs, pinned right of the scrolling tabs.
        let button = |id: &'static str, icon: IconName, pressed: bool, on_click: fn(&mut Panel, &mut Context<Panel>)| {
            div().flex_none().no_drag().child(
                IconButton::new(id, icon)
                    .size(IconButtonSize::S24)
                    .glyph(IconSize::S16)
                    .pressed(pressed)
                    .on_click(cx.listener(move |this, _: &ClickEvent, _window, cx| on_click(this, cx))),
            )
        };
        let tab_list = div()
            .id("panel-tab-list")
            .debug_selector(|| "panel-tab-list".to_string())
            .flex()
            .flex_1()
            .min_w_0()
            .h_full()
            .items_center()
            .gap(px(2.0))
            .overflow_x_scroll()
            .track_scroll(&self.tabs_scroll)
            .children(tabs);
        chrome::header("panel-tabs")
            .debug_selector(|| "panel-header".to_string())
            .px_2()
            .gap_1()
            .child(tab_list)
            .child(button("panel-expand", IconName::ArrowExpand01, expanded, Panel::toggle_expand))
            .child(button("panel-close", IconName::Cancel01, false, Panel::close))
            .into_any_element()
    }
}

impl Render for Panel {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.renders += 1;
        let theme = *cx.theme();
        let header = self.header(cx);
        // Each body is a cached view with a fixed size, so what changes inside it never rebuilds the panel.
        let body = self.body_view(self.active()).map(|view| view.cached(StyleRefinement::default().size_full()));
        div()
            .flex()
            .flex_col()
            .size_full()
            .bg(theme.canvas)
            .child(header)
            .child(div().flex_none().h(px(1.0)).bg(theme.line))
            .child(div().id("panel-body").flex_1().min_h_0().children(body))
    }
}

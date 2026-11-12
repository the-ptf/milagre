//! Side panel column: the tab strip in the 44px header (`ui::Tab` in a horizontally scrolling list, expand and
//! close pinned at the right) over the open tab's body.
//!
//! - State is per Chat: which tab is open, whether the panel is shown, whether it is expanded. Switching Chats in
//!   the sidebar ([`Panel::set_chat`], driven by the Workspace) brings back that Chat's, and shows only the tabs the
//!   Chat has content for (`fixture::ChatContent::has`).
//! - One width serves every tab and Chat, and lasts the session (`dock.rs`).
//! - Every body is its own view mounted cached with a fixed size ([`ChangesView`], the PR, Designs, Artifact and
//!   Simulator views). The panel itself holds no state a body changes, so typing in the composer or a
//!   transcript animation re-renders none of them.

pub mod artifacts;
pub mod browser;
pub mod changes;
pub mod designs;
pub mod details;
pub mod diff;
pub mod dock;
pub mod fixture;
pub mod pr;
pub mod simulator;
pub mod skeletons;
pub mod slide;
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
use self::browser::BrowserView;
use self::changes::ChangesView;
use self::designs::DesignsView;
use self::details::DetailsView;
use self::fixture::ChatContent;
use self::pr::{PrEvent, PrView};
use self::simulator::{SimulatorEvent, SimulatorView};
use crate::theme::{ActiveTheme, HAIRLINE};
use crate::ui::{IconName, Tab};
use crate::workspace::chrome;
use crate::workspace::sidebar::SidebarSeed;

/// The Changes panel's default width (`PANEL_WIDTHS.changes.default`), where the panel opens.
pub const PANEL_WIDTH: f32 = 320.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PanelTab {
    Changes,
    Designs,
    Artifact,
    Pr,
    /// The Chat's environment, context, Subchats, background tasks and links (not in `ALL`, which the desktop's
    /// panel toggles list; Details is new). Always shown, first, and the tab a Chat opens on.
    Details,
    /// Shown only while the Chat has a simulator attached, after the others (not in `ALL`).
    Simulator,
    /// The Browser spike (`browser/`), shown only with `MILAGRE_GPUI_BROWSER_SPIKE=1` (not in `ALL`).
    Browser,
}

impl PanelTab {
    /// Terminals live in the drawer under the Chat (`panel/terminal/`), as on the desktop.
    pub const ALL: [PanelTab; 4] = [PanelTab::Changes, PanelTab::Designs, PanelTab::Artifact, PanelTab::Pr];

    /// Every tab the strip can show, in order.
    pub const SHOWN: [PanelTab; 7] =
        [PanelTab::Details, PanelTab::Pr, PanelTab::Designs, PanelTab::Artifact, PanelTab::Changes, PanelTab::Simulator, PanelTab::Browser];

    /// Whether the tab's body runs to the panel's left edge (the Artifact page and the Designs board), not inset by
    /// the panel's half of the gap beside the Chat card.
    pub fn edge_to_edge(self) -> bool {
        matches!(self, PanelTab::Artifact | PanelTab::Designs)
    }

    pub fn label(self) -> &'static str {
        match self {
            PanelTab::Changes => "Changes",
            PanelTab::Designs => "Designs",
            PanelTab::Artifact => "Artifact",
            PanelTab::Pr => "PR",
            PanelTab::Details => "Details",
            PanelTab::Simulator => "Simulator",
            PanelTab::Browser => "Browser",
        }
    }

    /// The desktop's tab glyphs (`agents/PanelToggles.tsx`).
    pub fn icon(self) -> IconName {
        match self {
            PanelTab::Changes => IconName::FileDiff,
            PanelTab::Designs => IconName::PaintBoard,
            PanelTab::Artifact => IconName::File01,
            PanelTab::Pr => IconName::GitPullRequest,
            PanelTab::Details => IconName::LeftToRightListBullet,
            PanelTab::Simulator => IconName::Smartphone,
            PanelTab::Browser => IconName::Globe02,
        }
    }
}

/// Tells the Workspace the panel's place in the window changed (shown, hidden, expanded, another width).
pub enum PanelEvent {
    Layout,
    /// "Fix in Chat" on a PR thread: the window sends this to the open Chat.
    FixInChat(String),
}

impl EventEmitter<PanelEvent> for Panel {}

/// What a Chat keeps of its panel.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ChatPanel {
    open: bool,
    tab: PanelTab,
}

impl Default for ChatPanel {
    fn default() -> Self {
        Self { open: true, tab: PanelTab::Details }
    }
}

pub struct Panel {
    chat: SharedString,
    /// The Chat open at startup: the fixture gives it every tab.
    seeded: Option<SharedString>,
    content: ChatContent,
    states: HashMap<SharedString, ChatPanel>,
    /// The panel's width, the same for every tab and Chat; a drag sets it (`dock::WIDTH_RULE`).
    width: f32,
    /// The dock's split state. A new one whenever the layout changes, so the panel opens at its width.
    resizable: Entity<ResizableState>,
    /// Horizontal scroll of the tab list; also used to bring a clicked tab fully into view.
    tabs_scroll: ScrollHandle,
    /// Edge fades over the tab strip: left once scrolled, right while tabs are cut off.
    tabs_fade: crate::ui::scroll_fade::ScrollFade,
    changes: Entity<ChangesView>,
    artifacts: Entity<ArtifactsView>,
    designs: Entity<DesignsView>,
    pr: Entity<PrView>,
    details: Entity<DetailsView>,
    simulator: Entity<SimulatorView>,
    browser: Entity<BrowserView>,
    /// Room the tab strip leaves at its right end for the window's panel toggle, set by the shell.
    header_trailing: gpui::Pixels,
    /// Every `render`, for the tests that check what a change elsewhere re-renders.
    renders: usize,
    /// A data layer feeds the panel (`set_live_changes`, `set_live_details`): only the tabs it feeds show, and no
    /// fixture content.
    live: bool,
    /// The data layer feeds the Details tab (`set_live_details`).
    live_details: bool,
    /// The data layer feeds the Changes tab (`set_live_changes`), and for which Chat it last did.
    live_changes: Option<SharedString>,
}

impl Panel {
    pub fn new(cx: &mut Context<Self>) -> Self {
        // Preview: the panel is hidden; seeding it with the opening Chat would build fixture content for it (and compile
        // the highlighting grammars of its files, about 170 MB kept for the process's life).
        let seeded: Option<SharedString> = (!crate::workspace::preview::is_on(cx))
            .then(|| cx.try_global::<SidebarSeed>().and_then(|seed| seed.open_chat.clone()))
            .flatten()
            .map(Into::into);
        let chat = seeded.clone().unwrap_or_default();
        let content = fixture::content_for(&chat, seeded.as_deref());
        let changes = cx.new(ChangesView::new);
        changes.update(cx, |changes, cx| changes.set_chat(chat.clone(), content.changes.clone(), cx));
        // "Send N comments" from the diff goes to the Chat the way "Fix in Chat" does.
        cx.subscribe(&changes, |_, _, event: &changes::ChangesEvent, cx| match event {
            changes::ChangesEvent::SendToChat(text) => cx.emit(PanelEvent::FixInChat(text.clone())),
        })
        .detach();
        let pr = cx.new(PrView::new);
        pr.update(cx, |pr, cx| pr.set_chat(chat.clone(), content.pr, pr::local_files(&content.changes), cx));
        cx.subscribe(&pr, |panel, _, event: &PrEvent, cx| match event {
            PrEvent::OpenChanges => panel.activate(PanelTab::Changes, cx),
            PrEvent::FixInChat(text) => cx.emit(PanelEvent::FixInChat(text.clone())),
        })
        .detach();
        // The Chat open at startup gets a simulator only when a snapshot asks for the Simulator tab.
        let seeded_simulator = !cfg!(test) && std::env::var("MILAGRE_GPUI_PANEL_TAB").is_ok_and(|tab| tab == "Simulator");
        let simulator = cx.new(|cx| {
            let seeded = seeded.clone();
            SimulatorView::fixture(move |chat| simulator::fixture::attached_at_start(chat, seeded.as_deref(), seeded_simulator), cx)
        });
        cx.subscribe(&simulator, |panel, _, event: &SimulatorEvent, cx| match *event {
            SimulatorEvent::Attached(count) => panel.set_simulator_attached(count > 0, cx),
        })
        .detach();
        let tabs_scroll = ScrollHandle::new();
        let mut panel = Self {
            chat,
            seeded,
            content,
            states: HashMap::new(),
            width: dock::WIDTH_RULE.default,
            resizable: Self::new_resizable(cx),
            tabs_fade: crate::ui::scroll_fade::ScrollFade::handle(&tabs_scroll).horizontal(),
            tabs_scroll,
            changes,
            artifacts: {
                let panel = cx.entity();
                cx.new(|cx| ArtifactsView::new(&panel, cx))
            },
            pr,
            details: cx.new(DetailsView::new),
            designs: cx.new(DesignsView::new),
            simulator,
            browser: cx.new(BrowserView::new),
            header_trailing: px(0.0),
            renders: 0,
            live: false,
            live_details: false,
            live_changes: None,
        };
        // Send on the Designs tab (live): the choice goes to the Chat as a message, the way "Fix in Chat" does.
        cx.subscribe(&panel.designs, |_, _, event: &designs::DesignsEvent, cx| {
            if let designs::DesignsEvent::Send(text) = event {
                cx.emit(PanelEvent::FixInChat(text.clone()));
            }
        })
        .detach();
        panel.load_simulator(cx);
        panel.load_details(cx);
        panel.apply_env_seed(cx);
        panel
    }

    /// The tab strip's clearance for the corner toggle over its right end (the shell's).
    pub fn set_header_trailing(&mut self, trailing: gpui::Pixels, cx: &mut Context<Self>) {
        if self.header_trailing != trailing {
            self.header_trailing = trailing;
            cx.notify();
        }
    }

    /// Shows this Chat's simulators; the fixture answers at once, so the tab is known before the fallback below.
    fn load_simulator(&mut self, cx: &mut Context<Self>) {
        let chat = self.chat.clone();
        self.simulator.update(cx, |view, cx| view.set_chat(chat, cx));
        self.content.simulator = self.simulator.read(cx).attached_count() > 0;
    }

    /// Shows this Chat's Details.
    fn load_details(&mut self, cx: &mut Context<Self>) {
        let (chat, pr) = (self.chat.clone(), self.content.pr);
        let seeded = self.seeded.as_ref() == Some(&chat);
        self.details.update(cx, |details, cx| details.set_chat(chat, pr, seeded, cx));
    }

    pub fn details(&self) -> &Entity<DetailsView> {
        &self.details
    }

    /// Every Chat with its mark (the sidebar's `family_chats`), for the Details tab's Subchats. The Workspace sends
    /// it as it does to the Chat column.
    pub fn set_family(&mut self, chats: &[crate::workspace::chat::pills::bookmark::FamilyChat], cx: &mut Context<Self>) {
        self.details.update(cx, |details, cx| details.set_family(chats, cx));
    }

    /// A device was attached or detached: the tab comes and goes with it.
    fn set_simulator_attached(&mut self, attached: bool, cx: &mut Context<Self>) {
        if self.content.simulator == attached {
            return;
        }
        self.content.simulator = attached;
        if !attached && self.active() == PanelTab::Simulator {
            self.state_mut().tab = PanelTab::Details;
            self.relayout(cx);
        } else {
            cx.notify();
        }
    }

    pub fn simulator(&self) -> &Entity<SimulatorView> {
        &self.simulator
    }

    /// Snapshot runs pick a width and a file through the environment (never in tests).
    fn apply_env_seed(&mut self, cx: &mut Context<Self>) {
        if cfg!(test) {
            return;
        }
        if let Some(width) = std::env::var("MILAGRE_GPUI_PANEL_WIDTH").ok().and_then(|w| w.parse::<f32>().ok()) {
            self.set_width(width);
        }
        if let Some(tab) = std::env::var("MILAGRE_GPUI_PANEL_TAB").ok().and_then(|n| PanelTab::SHOWN.into_iter().find(|t| t.label() == n)) {
            self.state_mut().tab = tab;
            if tab == PanelTab::Browser && self.content.has(tab) {
                self.browser.update(cx, |browser, cx| browser.ensure_started(cx));
            }
        }
        if std::env::var_os("MILAGRE_GPUI_PANEL_CLOSED").is_some() {
            self.state_mut().open = false;
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

    pub fn chat(&self) -> &str {
        &self.chat
    }

    /// The tabs the Chat on screen has, in order.
    pub fn visible_tabs(&self) -> Vec<PanelTab> {
        if self.live {
            let details = self.live_details.then_some(PanelTab::Details);
            let pr = (self.live_details && self.content.pr.is_some()).then_some(PanelTab::Pr);
            // Designs and the Artifact page only while a data layer says the Chat has them (`set_live_canvas`).
            let designs = (self.live_details && self.content.designs).then_some(PanelTab::Designs);
            let artifact = (self.live_details && self.content.artifacts).then_some(PanelTab::Artifact);
            return details
                .into_iter()
                .chain(pr)
                .chain(designs)
                .chain(artifact)
                .chain(self.live_changes.is_some().then_some(PanelTab::Changes))
                .collect();
        }
        PanelTab::SHOWN.into_iter().filter(|tab| self.content.has(*tab)).collect()
    }

    /// A data layer's Changes for `chat` (its Git reads): the panel shows that Chat's Changes and no fixture tab from
    /// then on. Another Chat starts its view state afresh; the same Chat keeps its picks and folds. Without live
    /// Details, Changes is the only tab and the panel follows `chat`; with them, the panel stays on the Chat the
    /// Details show and these Changes are its Project's.
    pub fn set_live_changes(&mut self, chat: SharedString, data: changes::data::ChangesData, cx: &mut Context<Self>) {
        let switched = self.live_changes.as_ref() != Some(&chat);
        let first = self.live_changes.is_none();
        self.live = true;
        self.live_changes = Some(chat.clone());
        let pr = self.content.pr.filter(|_| self.live_details);
        let (designs, artifacts) = (self.content.designs && self.live_details, self.content.artifacts && self.live_details);
        self.content = fixture::ChatContent { changes: data.clone(), designs, artifacts, pr, simulator: false };
        if !self.live_details {
            let moved = self.chat != chat;
            self.chat = chat.clone();
            self.state_mut().tab = PanelTab::Changes;
            if moved && !switched {
                self.relayout(cx);
            }
        }
        if switched {
            self.changes.update(cx, |changes, cx| changes.set_chat(chat, data, cx));
            self.relayout(cx);
        } else {
            self.changes.update(cx, |changes, cx| changes.set_data(data, cx));
            if first {
                self.relayout(cx);
            }
            cx.notify();
        }
    }

    /// A data layer's Details for `chat` (`DetailsData` it built from its own state): the panel follows `chat`, shows
    /// its Details tab (and Changes once fed) and no fixture tab. Read again by the data layer as its state changes.
    pub fn set_live_details(&mut self, chat: SharedString, data: details::data::DetailsData, cx: &mut Context<Self>) {
        let switched = !self.live_details || self.chat != chat;
        if switched {
            // Another Chat's PR, designs and page are not this one's: the data layer sets them (`set_live_pr`,
            // `set_live_canvas`).
            self.content.pr = None;
            self.content.designs = false;
            self.content.artifacts = false;
        }
        self.live = true;
        self.live_details = true;
        self.chat = chat.clone();
        if !self.visible_tabs().contains(&self.state().tab) {
            self.state_mut().tab = PanelTab::Details;
        }
        self.details.update(cx, |details, cx| details.set_live(chat, data, cx));
        if switched {
            self.relayout(cx);
        } else {
            cx.notify();
        }
    }

    /// A data layer's PR for `chat` (the one its Details show): `number` is the PR the tab reads through the PR view's
    /// bridge (`PrView::set_bridge`), `None` when the Chat has none (the tab goes, and the panel falls back to
    /// Details). `local_files` is what the Worktree has that the PR does not yet. Ignored for another Chat.
    pub fn set_live_pr(&mut self, chat: SharedString, number: Option<u32>, local_files: usize, cx: &mut Context<Self>) {
        if !self.live_details || self.chat != chat {
            return;
        }
        let had = self.content.pr;
        self.content.pr = number;
        let same = self.pr.read(cx).number() == number && self.pr.read(cx).chat() == chat.as_ref();
        if !same {
            self.pr.update(cx, |pr, cx| pr.set_chat(chat, number, local_files, cx));
        }
        if number.is_none() && self.state().tab == PanelTab::Pr {
            self.state_mut().tab = PanelTab::Details;
        }
        if had != number {
            cx.notify();
        }
    }

    /// A data layer's word on whether `chat` (the one its Details show) has designs and an Artifact page: the Designs
    /// and Artifact tabs show only then (a tab that goes falls back to Details). Ignored for another Chat.
    pub fn set_live_canvas(&mut self, chat: SharedString, designs: bool, artifacts: bool, cx: &mut Context<Self>) {
        if !self.live_details || self.chat != chat {
            return;
        }
        if (self.content.designs, self.content.artifacts) == (designs, artifacts) {
            return;
        }
        self.content.designs = designs;
        self.content.artifacts = artifacts;
        if !self.visible_tabs().contains(&self.state().tab) {
            self.state_mut().tab = PanelTab::Details;
        }
        cx.notify();
    }

    /// The Designs tab's view.
    pub fn designs(&self) -> &Entity<DesignsView> {
        &self.designs
    }

    /// The Artifact tab's view.
    pub fn artifacts(&self) -> &Entity<ArtifactsView> {
        &self.artifacts
    }

    /// The PR tab's view.
    pub fn pr(&self) -> &Entity<PrView> {
        &self.pr
    }

    /// Whether a data layer feeds the panel (`set_live_changes`).
    pub fn is_live(&self) -> bool {
        self.live
    }

    /// The Changes the panel holds for its Chat (the fixture's, or a data layer's).
    pub fn changes_data(&self) -> &changes::data::ChangesData {
        &self.content.changes
    }

    /// The panel's width: dragged this session, else the default. No tab has one of its own.
    pub fn width(&self) -> f32 {
        self.width
    }

    pub fn resizable(&self) -> &Entity<ResizableState> {
        &self.resizable
    }

    pub fn changes(&self) -> &Entity<ChangesView> {
        &self.changes
    }

    /// The diff the shown tab has open (Changes, or the PR's Files), while the panel is open.
    fn open_diff(&self, cx: &gpui::App) -> Option<diff::over_chat::OpenDiff> {
        if !self.is_open() {
            return None;
        }
        match self.active() {
            PanelTab::Changes => self.changes.read(cx).diff_view().map(diff::over_chat::OpenDiff::Changes),
            PanelTab::Pr => self.pr.read(cx).diff_over_chat().then(|| diff::over_chat::OpenDiff::Pr(self.pr.clone())),
            _ => None,
        }
    }

    /// The diff the window draws over the Chat column: the shown tab's, while the panel is open beside the Chat.
    pub fn diff_over_chat(&self, cx: &gpui::App) -> Option<diff::over_chat::OpenDiff> {
        self.open_diff(cx)
    }

    pub fn body_view(&self, tab: PanelTab) -> Option<AnyView> {
        match tab {
            PanelTab::Changes => Some(self.changes.clone().into()),
            PanelTab::Artifact => Some(self.artifacts.clone().into()),
            PanelTab::Designs => Some(self.designs.clone().into()),
            PanelTab::Pr => Some(self.pr.clone().into()),
            PanelTab::Details => Some(self.details.clone().into()),
            PanelTab::Simulator => Some(self.simulator.clone().into()),
            PanelTab::Browser => Some(self.browser.clone().into()),
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
        self.width = dock::WIDTH_RULE.clamp(width);
    }

    /// The split's state, watched so a drag re-lays the window out on every step: the corner toggle and the
    /// card follow the panel's edge while it moves, not only when the drag ends.
    fn new_resizable(cx: &mut Context<Self>) -> Entity<ResizableState> {
        let state = cx.new(|_| ResizableState::default());
        cx.observe(&state, |_, _, cx| cx.emit(PanelEvent::Layout)).detach();
        state
    }

    /// The panel's width as drawn right now: the split's live size during a drag, else the stored width.
    pub fn live_width(&self, cx: &gpui::App) -> f32 {
        self.resizable.read(cx).sizes().get(1).copied().map(f32::from).unwrap_or(self.width)
    }

    /// Back to the tab's default width (the double-click on the edge).
    pub fn reset_width(&mut self, cx: &mut Context<Self>) {
        self.width = dock::WIDTH_RULE.default;
        self.relayout(cx);
    }

    /// The panel's place in the window changed: the split starts again at the panel's width.
    fn relayout(&mut self, cx: &mut Context<Self>) {
        self.resizable = Self::new_resizable(cx);
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
        if self.live {
            // A data layer says what this Chat has (`set_live_pr`, `set_live_canvas`); no fixture tab shows meanwhile.
            self.content.designs = false;
            self.content.artifacts = false;
            self.content.pr = None;
        }
        self.load_simulator(cx);
        self.load_details(cx);
        // A tab this Chat has no content for falls back to Details, which every Chat has.
        if !self.content.has(self.state().tab) {
            self.state_mut().tab = PanelTab::Details;
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
        if tab == PanelTab::Browser {
            self.browser.update(cx, |browser, cx| browser.ensure_started(cx));
        }
        let ix = self.visible_tabs().iter().position(|t| *t == tab).unwrap_or(0);
        // Applied while the list paints next frame: scrolls the least needed to show the tab fully.
        self.tabs_scroll.scroll_to_item(ix);
        let state = self.state_mut();
        // Only opening the panel lays it out again: switching tabs keeps the width.
        let opening = !state.open;
        state.tab = tab;
        state.open = true;
        if opening {
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
        self.relayout(cx);
    }

    fn header(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let active = self.active();
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
            .children(tabs)
            // The strip's end padding lives in the scroll content, so the last tab scrolls fully into view while the
            // viewport (and its fade) still runs to the panel's right edge.
            .child(div().flex_none().w(px(8.0)).h_full());
        // Over the strip, not in it, on the shared surface (the grain shows through the transparent end).
        let tab_list = div()
            .relative()
            .flex()
            .flex_1()
            .min_w_0()
            .h_full()
            .child(tab_list)
            .child(self.tabs_fade.overlay(crate::ui::grain::grained(theme.canvas, theme.appearance)));
        chrome::top_row("panel-tabs")
            .debug_selector(|| "panel-header".to_string())
            // The panel's half of the Chat card's gap is before it (`dock.rs`): the tabs keep their 8px from the edge.
            .pl(px(8.0) - crate::workspace::shell::card::panel_lead())
            .pr(self.header_trailing)
            .gap_1()
            .child(tab_list)
            .into_any_element()
    }
}

impl Render for Panel {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.renders += 1;
        let theme = *cx.theme();
        let header = self.header(cx);
        // Each body is a cached view with a fixed size, so what changes inside it never rebuilds the panel. An open
        // diff is drawn by the window over the Chat column, never in the panel.
        let body = self.body_view(self.active()).map(|view| view.cached(StyleRefinement::default().size_full()).into_any_element());
        div()
            .relative()
            .flex()
            .flex_col()
            .size_full()
            // No fill of its own: the window's surface and its grain show through (`workspace/mod.rs`).
            .child(header)
            .when(HAIRLINE > px(0.0), |el| el.child(div().flex_none().h(HAIRLINE).bg(theme.line)))
            .child(
                div()
                    .id("panel-body")
                    .debug_selector(|| "panel-body".into())
                    .flex_1()
                    .min_h_0()
                    // A page or a board runs to the panel's left edge, over the panel's half of the Chat card's gap
                    // (`dock.rs`), so no strip of the surface shows down its left side.
                    .when(self.active().edge_to_edge(), |el| el.ml(-crate::workspace::shell::card::panel_lead()))
                    .children(body),
            )
    }
}

//! Settings dialog shell, search, left navigation and simple sections (WP-39: `SettingsModal.tsx`,
//! `Settings.tsx`, `SettingsSearch.tsx`, `settings-index.ts`).
//!
//! Opens as an in-window modal dialog (`rounded-window`, scrim, up to `1120 × 800`, 248px left nav on `canvas`
//! and scrollable right body on `surface`) with `cmd-,` (`ToggleSettings`) or the sidebar footer's Settings button,
//! and closes with `Escape`, the top-right `Cancel01` icon button, or a click on the scrim.
//! Inside Settings, `cmd-f` (`FindInSettings`) focuses the search input; typing ranks `SETTINGS_INDEX` and section
//! entries, and clicking or pressing `Enter` on a result opens its section and highlights the matching row.

pub mod about;
pub mod accounts;
pub mod appearance;
pub mod browser;
pub mod chat;
pub mod church;
pub mod devices;
pub mod general;
pub mod group;
pub mod models;
pub mod nav;
pub mod notifications;
pub mod projects;
pub mod search;
pub mod store;

#[cfg(test)]
mod tests;

use std::rc::Rc;

use gpui::{
    AnyElement, App, Context, Entity, FocusHandle, IntoElement, KeyBinding, KeyDownEvent, MouseButton, ParentElement, Render, ScrollHandle,
    SharedString, Styled, Subscription, Window, actions, div, prelude::*, px,
};
use gpui_component::input::{InputEvent, InputState};

pub use nav::{SelectedSection, SettingsNav};
pub use search::{
    ALL_SECTIONS, SETTINGS_INDEX, SettingsSearchEntry, SettingsSearchHit, SettingsSectionId, build_search_entries, fold_search_text,
    search_ranges, search_settings, search_trail,
};
pub use store::SettingsStore;

use crate::data::{ComputerState, Data, LOCAL, Polled, poll_once};
use crate::theme::{ActiveTheme, RADIUS_CARD, RADIUS_WINDOW, TEXT_12, TextStepExt};
use crate::ui::{EmptyState, IconButton, IconButtonSize, IconName, Input, ScrollArea};
use group::page_header;

actions!(milagre_settings, [ToggleSettings, FindInSettings]);

/// Installs the global [`SettingsStore`] (if not already present) and binds `cmd-,` and `cmd-f`.
pub fn init(cx: &mut App) {
    if !cx.has_global::<SettingsStore>() {
        cx.set_global(SettingsStore::default());
    }
    appearance::init(cx);
    accounts::init(cx);
    devices::init(cx);
    projects::init(cx);
    cx.bind_keys([KeyBinding::new("cmd-,", ToggleSettings, None), KeyBinding::new("cmd-f", FindInSettings, Some("SettingsModal"))]);
}

/// The in-window Settings dialog entity owned by [`Workspace`](crate::workspace::Workspace).
pub struct SettingsModal {
    open: bool,
    selected: SelectedSection,
    highlighted_row: Option<String>,
    focus: FocusHandle,
    nav_scroll: ScrollHandle,
    search_scroll: ScrollHandle,
    body_scroll: ScrollHandle,
    search_input: Option<Entity<InputState>>,
    search_sub: Option<Subscription>,
    active_hit: usize,
    this_mac_name: String,
    computers: Vec<(String, String, bool)>,
    projects: Vec<(String, String)>,
    appearance: Entity<appearance::AppearanceView>,
    accounts: Entity<accounts::AccountsView>,
    usage: Entity<accounts::UsageView>,
    devices: Entity<devices::DevicesView>,
    project: Entity<projects::ProjectView>,
}

impl SettingsModal {
    pub fn new(cx: &mut Context<Self>) -> Self {
        if !cx.has_global::<SettingsStore>() {
            cx.set_global(SettingsStore::default());
        }
        cx.observe_global::<SettingsStore>(|_, cx| cx.notify()).detach();
        let (this_mac_name, computers, projects) = load_nav_data(cx);
        let initial_env = std::env::var("MILAGRE_GPUI_SETTINGS").ok().filter(|v| !v.is_empty());
        let (open, selected) = match initial_env.as_deref() {
            Some("1") | Some("true") => (true, SelectedSection::Section(SettingsSectionId::General)),
            Some(name) => (
                true,
                SettingsSectionId::parse(name)
                    .map(SelectedSection::Section)
                    .or_else(|| devices::snapshot_selection(name, &computers, &projects))
                    .unwrap_or(SelectedSection::Section(SettingsSectionId::General)),
            ),
            None => (false, SelectedSection::Section(SettingsSectionId::General)),
        };

        let weak = cx.weak_entity();
        let body_scroll = ScrollHandle::new();
        // Snapshot aid: `MILAGRE_GPUI_SETTINGS_SCROLL=<px>` opens with the body scrolled down.
        if let Some(px_down) = std::env::var("MILAGRE_GPUI_SETTINGS_SCROLL").ok().and_then(|v| v.parse::<f32>().ok()) {
            body_scroll.set_offset(gpui::point(px(0.0), px(-px_down)));
        }
        Self {
            open,
            selected,
            highlighted_row: None,
            focus: cx.focus_handle(),
            nav_scroll: ScrollHandle::new(),
            search_scroll: ScrollHandle::new(),
            body_scroll,
            search_input: None,
            search_sub: None,
            active_hit: 0,
            this_mac_name,
            computers,
            projects,
            appearance: cx.new(appearance::AppearanceView::new),
            accounts: cx.new(accounts::AccountsView::new),
            usage: cx.new(|cx| accounts::UsageView::new(weak.clone(), cx)),
            devices: cx.new(devices::DevicesView::new),
            project: cx.new(|cx| projects::ProjectView::new(weak, cx)),
        }
    }

    pub fn appearance_view(&self) -> &Entity<appearance::AppearanceView> {
        &self.appearance
    }

    pub fn is_open(&self) -> bool {
        self.open
    }

    pub fn selected(&self) -> &SelectedSection {
        &self.selected
    }

    pub fn selected_section_id(&self) -> SettingsSectionId {
        self.selected.section_id()
    }

    pub fn highlighted_row(&self) -> Option<&str> {
        self.highlighted_row.as_deref()
    }

    pub fn query(&self, cx: &App) -> String {
        self.search_input.as_ref().map(|input| input.read(cx).value().to_string()).unwrap_or_default()
    }

    pub fn search_input(&self) -> Option<Entity<InputState>> {
        self.search_input.clone()
    }

    pub fn body_scroll(&self) -> &ScrollHandle {
        &self.body_scroll
    }

    fn ensure_search_input(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Entity<InputState> {
        if let Some(input) = &self.search_input {
            return input.clone();
        }
        let input = Input::state("Search settings", window, cx);
        let sub = cx.subscribe(&input, |this, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                this.active_hit = 0;
                cx.notify();
            }
        });
        self.search_input = Some(input.clone());
        self.search_sub = Some(sub);
        input
    }

    pub fn open(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.open = true;
        let _ = self.ensure_search_input(window, cx);
        let handle = self.focus.clone();
        window.focus(&handle, cx);
        cx.notify();
    }

    pub fn open_section(&mut self, section: SettingsSectionId, window: &mut Window, cx: &mut Context<Self>) {
        self.selected = SelectedSection::Section(section);
        self.highlighted_row = None;
        self.body_scroll.set_offset(gpui::point(px(0.0), px(0.0)));
        self.open(window, cx);
    }

    pub fn close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.open {
            return;
        }
        self.open = false;
        self.highlighted_row = None;
        if let Some(input) = &self.search_input {
            input.update(cx, |state, cx| state.set_value("", window, cx));
        }
        self.active_hit = 0;
        cx.notify();
    }

    pub fn toggle(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.open {
            self.close(window, cx);
        } else {
            self.open(window, cx);
        }
    }

    pub fn focus_search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let input = self.ensure_search_input(window, cx);
        input.update(cx, |state, cx| state.focus(window, cx));
        cx.notify();
    }

    pub fn set_query(&mut self, query: impl Into<SharedString>, window: &mut Window, cx: &mut Context<Self>) {
        let query: SharedString = query.into();
        let input = self.ensure_search_input(window, cx);
        input.update(cx, |state, cx| state.set_value(query, window, cx));
        self.active_hit = 0;
        cx.notify();
    }

    pub fn select_section(&mut self, section: SelectedSection, cx: &mut Context<Self>) {
        self.selected = section;
        self.highlighted_row = None;
        self.body_scroll.set_offset(gpui::point(px(0.0), px(0.0)));
        cx.notify();
    }

    pub fn open_search_entry(&mut self, entry: &SettingsSearchEntry, cx: &mut Context<Self>) {
        match entry.page {
            SettingsSectionId::Computer => {
                if let Some(id) = &entry.target_id {
                    self.selected = SelectedSection::Computer {
                        id: id.clone(),
                        name: entry.title.clone(),
                        connected: entry.connected.unwrap_or(false),
                    };
                    self.highlighted_row = None;
                }
            }
            SettingsSectionId::Project => {
                if let Some(path) = &entry.target_id {
                    self.selected = SelectedSection::Project { path: path.clone(), name: entry.title.clone() };
                    self.highlighted_row = None;
                }
            }
            page => {
                self.selected = SelectedSection::Section(page);
                let is_section_header = entry.group.is_none() && entry.title == page.title();
                self.highlighted_row = (!is_section_header).then(|| entry.title.clone());
            }
        }
        self.body_scroll.set_offset(gpui::point(px(0.0), px(0.0)));
        cx.notify();
    }

    pub fn current_hits(&self, cx: &App) -> Vec<SettingsSearchHit> {
        let query = self.query(cx);
        if query.trim().is_empty() {
            return Vec::new();
        }
        let entries = build_search_entries(Some(&self.this_mac_name), &self.computers, &self.projects);
        search_settings(&entries, &query, 60)
    }

    fn handle_key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let key = event.keystroke.key.as_str();
        let m = &event.keystroke.modifiers;
        if (m.platform || m.control) && !m.alt && !m.shift && key.eq_ignore_ascii_case("f") {
            cx.stop_propagation();
            self.focus_search(window, cx);
            return;
        }
        if !m.platform && !m.control && !m.alt {
            match key {
                "escape" => {
                    cx.stop_propagation();
                    if !self.query(cx).is_empty() {
                        self.set_query("", window, cx);
                    } else {
                        self.close(window, cx);
                    }
                }
                "down" | "arrowdown" => {
                    let hits = self.current_hits(cx);
                    if !hits.is_empty() {
                        cx.stop_propagation();
                        self.active_hit = (self.active_hit + 1).min(hits.len() - 1);
                        cx.notify();
                    }
                }
                "up" | "arrowup" => {
                    let hits = self.current_hits(cx);
                    if !hits.is_empty() {
                        cx.stop_propagation();
                        self.active_hit = self.active_hit.saturating_sub(1);
                        cx.notify();
                    }
                }
                "enter" => {
                    let hits = self.current_hits(cx);
                    if !hits.is_empty() {
                        cx.stop_propagation();
                        let ix = self.active_hit.min(hits.len() - 1);
                        let entry = hits[ix].entry.clone();
                        self.open_search_entry(&entry, cx);
                    }
                }
                _ => {}
            }
        }
    }
}

impl Render for SettingsModal {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if !self.open {
            return div().into_any_element();
        }

        let input = self.ensure_search_input(window, cx);
        let query = input.read(cx).value().to_string();
        let hits = self.current_hits(cx);
        let active_hit = self.active_hit.min(hits.len().saturating_sub(1));
        let selected = self.selected.clone();
        let highlighted = self.highlighted_row.clone();
        let computers = self.computers.clone();
        let projects = self.projects.clone();
        let this_mac_name = self.this_mac_name.clone();
        let entity = cx.entity();

        let on_select_section = {
            let entity = entity.clone();
            Rc::new(move |sec: SelectedSection, _window: &mut Window, cx: &mut App| {
                entity.update(cx, |this, cx| this.select_section(sec, cx));
            })
        };

        let on_select_hit = {
            let entity = entity.clone();
            Rc::new(move |ix: usize, entry: &SettingsSearchEntry, _window: &mut Window, cx: &mut App| {
                let entry = entry.clone();
                entity.update(cx, |this, cx| {
                    this.active_hit = ix;
                    this.open_search_entry(&entry, cx);
                });
            })
        };

        let on_clear_search = {
            let entity = entity.clone();
            Rc::new(move |window: &mut Window, cx: &mut App| {
                entity.update(cx, |this, cx| {
                    this.set_query("", window, cx);
                    this.focus_search(window, cx);
                });
            })
        };

        let nav = SettingsNav {
            search_input: input,
            nav_scroll: self.nav_scroll.clone(),
            search_scroll: self.search_scroll.clone(),
            query,
            selected: selected.clone(),
            this_mac_name: this_mac_name.clone(),
            computers: computers.clone(),
            projects,
            hits,
            active_hit,
            on_select_section,
            on_select_hit,
            on_clear_search,
        };

        let appearance_view = self.appearance.clone();
        if selected == SelectedSection::Section(SettingsSectionId::Appearance) {
            appearance_view.update(cx, |v, cx| v.set_found(highlighted.as_deref(), cx));
        }
        let section_body = match accounts::section_body(&selected, highlighted.as_deref(), &self.accounts, &self.usage, cx) {
            Some(body) => body,
            None => match devices::section_body(&selected, highlighted.as_deref(), &self.devices, cx)
                .or_else(|| projects::section_body(&selected, highlighted.as_deref(), &self.project, cx))
            {
                Some(body) => body,
                None => render_section_body(&selected, highlighted.as_deref(), &this_mac_name, &computers, &appearance_view, cx),
            },
        };

        let theme = *cx.theme();
        let close_entity = entity.clone();
        let scrim_entity = entity.clone();

        let close_btn = div().absolute().top(px(12.0)).right(px(12.0)).child(
            IconButton::new("settings-close", IconName::Cancel01).size(IconButtonSize::S28).on_click(move |_, window, cx| {
                close_entity.update(cx, |this, cx| this.close(window, cx));
            }),
        );

        let main_pane =
            div().debug_selector(|| "settings-main".into()).min_w_0().flex_1().h_full().bg(theme.surface).flex().flex_col().child(
                div().min_h_0().flex_1().child(
                    ScrollArea::new("settings-body-scroll", &self.body_scroll).child(
                        div()
                            .w_full()
                            .flex()
                            .justify_center()
                            .child(div().w_full().max_w(px(788.0)).px(px(40.0)).pt(px(36.0)).pb(px(40.0)).child(section_body)),
                    ),
                ),
            );

        let modal_card = div()
            .id("settings-dialog")
            .debug_selector(|| "settings-dialog".into())
            .key_context("SettingsModal")
            .track_focus(&self.focus)
            .on_action(cx.listener(|this, _: &FindInSettings, window, cx| {
                this.focus_search(window, cx);
            }))
            .on_key_down(cx.listener(Self::handle_key_down))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .w(px(1120.0))
            .max_w_full()
            .h(px(800.0))
            .max_h_full()
            .rounded(RADIUS_WINDOW)
            .border_1()
            .border_color(theme.line)
            .bg(theme.surface)
            .text_color(theme.ink)
            .shadow(theme.shadow_raised())
            .overflow_hidden()
            .relative()
            .flex()
            .child(nav)
            .child(main_pane)
            .child(close_btn);

        div()
            .id("settings-scrim")
            .debug_selector(|| "settings-scrim".into())
            .absolute()
            .inset_0()
            .bg(theme.scrim)
            .px(px(24.0))
            .py(px(44.0))
            .flex()
            .items_center()
            .justify_center()
            .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                scrim_entity.update(cx, |this, cx| this.close(window, cx));
            })
            .child(modal_card)
            .into_any_element()
    }
}

fn render_section_body(
    selected: &SelectedSection,
    highlighted: Option<&str>,
    this_mac_name: &str,
    computers: &[(String, String, bool)],
    appearance_view: &Entity<appearance::AppearanceView>,
    cx: &App,
) -> AnyElement {
    match selected {
        SelectedSection::Section(SettingsSectionId::Appearance) => appearance_view.clone().into_any_element(),
        SelectedSection::Section(SettingsSectionId::General) => general::render_general(highlighted, cx).into_any_element(),
        SelectedSection::Section(SettingsSectionId::Chat) => chat::render_chat(highlighted, cx).into_any_element(),
        SelectedSection::Section(SettingsSectionId::Notifications) => {
            notifications::render_notifications(highlighted, cx).into_any_element()
        }
        SelectedSection::Section(SettingsSectionId::Models) => models::render_models(highlighted, cx).into_any_element(),
        SelectedSection::Section(SettingsSectionId::Browser) => browser::render_browser(computers, highlighted, cx).into_any_element(),
        SelectedSection::Section(SettingsSectionId::Experimental) => church::render_church(highlighted, cx).into_any_element(),
        SelectedSection::Section(SettingsSectionId::About) => about::render_about(highlighted, cx).into_any_element(),
        SelectedSection::Section(section) => {
            let title = if *section == SettingsSectionId::ThisMac && !this_mac_name.trim().is_empty() {
                this_mac_name.to_string()
            } else {
                section.title().to_string()
            };
            let (wp, pkg_label) = section.placeholder_package().unwrap_or(("WP-40", "Settings"));
            render_placeholder(section.as_str(), &title, section.icon(), wp, pkg_label, highlighted, cx)
        }
        SelectedSection::Computer { id, name, .. } => render_placeholder(
            &format!("computer-{}", group::slug(id)),
            name,
            IconName::Computer,
            "WP-44",
            "Computer Settings",
            highlighted,
            cx,
        ),
        SelectedSection::Project { name, .. } => render_placeholder(
            &format!("project-{}", group::slug(name)),
            name,
            IconName::Folder01,
            "WP-44",
            "Project Settings",
            highlighted,
            cx,
        ),
    }
}

fn render_placeholder(
    slug_id: &str,
    title: &str,
    icon: IconName,
    wp: &str,
    pkg_label: &str,
    highlighted: Option<&str>,
    cx: &App,
) -> AnyElement {
    let theme = *cx.theme();
    let sec_sel = format!("settings-section-{slug_id}");
    let placeholder_sel = format!("settings-placeholder-{wp}");
    let detail = format!("{pkg_label} ({wp}) is delivered in its own work package.");

    div()
        .debug_selector(move || sec_sel.clone())
        .flex()
        .flex_col()
        .child(page_header(title.to_owned(), None, cx))
        .when_some(highlighted.map(str::to_owned), |d, row_title| {
            d.child(
                div()
                    .debug_selector(|| "settings-found-row".into())
                    .mb(px(12.0))
                    .px(px(12.0))
                    .py(px(8.0))
                    .rounded(RADIUS_CARD)
                    .border_1()
                    .border_color(theme.line)
                    .bg(theme.hover2)
                    .text_step(TEXT_12)
                    .text_color(theme.ink2)
                    .child(row_title),
            )
        })
        .child(
            div()
                .debug_selector(move || placeholder_sel.clone())
                .rounded(RADIUS_CARD)
                .border_1()
                .border_color(theme.line)
                .bg(theme.inset)
                .py(px(32.0))
                .child(EmptyState::new().icon(icon).title(format!("{wp}: {pkg_label}")).help(detail)),
        )
        .into_any_element()
}

type NavData = (String, Vec<(String, String, bool)>, Vec<(String, String)>);

fn load_nav_data(cx: &App) -> NavData {
    let Some(source) = cx.try_global::<Data>().map(|d| d.0.clone()) else {
        return ("This Mac".to_string(), Vec::new(), Vec::new());
    };
    let (this_mac_name, computers) = match poll_once(source.computers()) {
        Polled::Ready(Ok(snapshot)) => {
            let mac = if snapshot.this_mac.trim().is_empty() { "This Mac".to_string() } else { snapshot.this_mac.to_string() };
            let list =
                snapshot.computers.into_iter().map(|c| (c.id.to_string(), c.name.to_string(), c.state == ComputerState::Online)).collect();
            (mac, list)
        }
        _ => ("This Mac".to_string(), Vec::new()),
    };
    let projects = match poll_once(source.recent_projects(LOCAL.into())) {
        Polled::Ready(Ok(list)) => {
            list.into_iter().filter(|p| !p.hidden && !p.is_chats_home()).map(|p| (p.path.to_string(), p.name.to_string())).collect()
        }
        _ => Vec::new(),
    };
    (this_mac_name, computers, projects)
}

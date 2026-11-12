//! Settings left navigation column (`248px`, `border-r border-line bg-canvas`) and search results list,
//! matching `SettingsNav` in `apps/desktop/app/src/components/Settings.tsx` and
//! `apps/desktop/app/src/components/settings/SettingsSearch.tsx`.

use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, Div, ElementId, Entity, FontWeight, IntoElement, ParentElement, RenderOnce, ScrollHandle, SharedString,
    Styled, Window, div, prelude::*, px,
};
use gpui_component::input::InputState;

use super::group::slug;
use super::search::{SettingsSearchEntry, SettingsSearchHit, SettingsSectionId, search_trail};
use crate::theme::{ActiveTheme, CONTROL_SM, RADIUS_CONTROL, TEXT_11, TEXT_12, TEXT_13, TextStepExt};
use crate::ui::{FieldSize, Icon, IconName, IconSize, Input, ProjectAvatar, ScrollArea};

/// Which nav item is currently selected in Settings.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SelectedSection {
    Section(SettingsSectionId),
    Computer { id: String, name: String, connected: bool },
    Project { path: String, name: String },
}

impl SelectedSection {
    pub fn section_id(&self) -> SettingsSectionId {
        match self {
            Self::Section(id) => *id,
            Self::Computer { .. } => SettingsSectionId::Computer,
            Self::Project { .. } => SettingsSectionId::Project,
        }
    }

    pub fn is_section(&self, id: SettingsSectionId) -> bool {
        matches!(self, Self::Section(s) if *s == id)
    }

    pub fn is_computer(&self, target_id: &str) -> bool {
        matches!(self, Self::Computer { id, .. } if id == target_id)
    }

    pub fn is_project(&self, target_path: &str) -> bool {
        matches!(self, Self::Project { path, .. } if path == target_path)
    }
}

/// Renders the `ComputerDot` icon (`Settings.tsx` lines 65-80): a 16px `Computer` icon with a 6px presence dot
/// inside an 8px `bg-canvas` ring at the bottom-right corner (`green` when connected, `ink-3` when offline).
pub fn computer_dot(connected: bool, active: bool, cx: &App) -> Div {
    let theme = *cx.theme();
    let icon_color = if active { theme.ink } else { theme.ink3 };
    let dot_color = if connected { theme.green } else { theme.ink3 };
    div()
        .relative()
        .flex_shrink_0()
        .size(px(16.0))
        .flex()
        .items_center()
        .justify_center()
        .text_color(icon_color)
        .child(Icon::new(IconName::Computer).size(IconSize::S16))
        .child(
            div()
                .absolute()
                .right(px(-2.0))
                .bottom(px(-2.0))
                .size(px(8.0))
                .rounded_full()
                .bg(theme.canvas)
                .flex()
                .items_center()
                .justify_center()
                .child(div().size(px(6.0)).rounded_full().bg(dot_color)),
        )
}

/// Renders one 28px nav row (`NavItem` in `Settings.tsx`).
pub fn nav_item(
    id: impl Into<ElementId>,
    selector: String,
    label: impl Into<SharedString>,
    active: bool,
    leading: impl IntoElement,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    cx: &App,
) -> impl IntoElement {
    let theme = *cx.theme();
    let label: SharedString = label.into();
    div()
        .id(id.into())
        .debug_selector(move || selector.clone())
        .w_full()
        .h(CONTROL_SM)
        .px(px(8.0))
        .rounded(RADIUS_CONTROL)
        .cursor_pointer()
        .flex()
        .items_center()
        .gap(px(8.0))
        .text_step(TEXT_13)
        .font_weight(FontWeight::MEDIUM)
        .when(active, |d| d.bg(theme.hover2))
        .text_color(if active { theme.ink } else { theme.ink2 })
        .hover(move |s| s.bg(if active { theme.hover2 } else { theme.hover }).text_color(theme.ink))
        .on_click(on_click)
        .child(leading)
        .child(div().min_w_0().flex_1().truncate().child(label))
}

/// Renders a section icon in the nav (`size 16`, `text-ink` when active, `text-ink-3` at rest).
pub fn nav_icon(name: IconName, active: bool, cx: &App) -> Div {
    let theme = *cx.theme();
    div().flex_shrink_0().text_color(if active { theme.ink } else { theme.ink3 }).child(Icon::new(name).size(IconSize::S16))
}

/// Renders a nav group heading (`pt-4 pb-1 px-2 text-11 font-medium text-ink-3`).
pub fn nav_group_heading(title: &'static str, cx: &App) -> Div {
    let theme = *cx.theme();
    div().pt(px(16.0)).pb(px(4.0)).px(px(8.0)).text_step(TEXT_11).font_weight(FontWeight::MEDIUM).text_color(theme.ink3).child(title)
}

/// Renders a title string with matched `[start, end)` character spans in semibold (`MatchedTitle` in `SettingsSearch.tsx`).
pub fn render_matched_title(text: &str, ranges: &[(usize, usize)], cx: &App) -> Div {
    let theme = *cx.theme();
    let chars: Vec<char> = text.chars().collect();
    let mut row = div().min_w_0().truncate().flex().items_center().text_step(TEXT_13).font_weight(FontWeight::MEDIUM).text_color(theme.ink);

    if ranges.is_empty() {
        return row.child(SharedString::from(text.to_owned()));
    }

    let mut at = 0;
    for &(start, end) in ranges {
        let start = start.min(chars.len());
        let end = end.min(chars.len());
        if start > at {
            let plain: String = chars[at..start].iter().collect();
            row = row.child(div().child(plain));
        }
        if end > start {
            let bold: String = chars[start..end].iter().collect();
            row = row.child(div().font_weight(FontWeight::SEMIBOLD).child(bold));
        }
        at = end;
    }
    if at < chars.len() {
        let tail: String = chars[at..].iter().collect();
        row = row.child(div().child(tail));
    }
    row
}

type HitSelectFn = Rc<dyn Fn(usize, &SettingsSearchEntry, &mut Window, &mut App)>;
type SectionSelectFn = Rc<dyn Fn(SelectedSection, &mut Window, &mut App)>;
type ClearSearchFn = Rc<dyn Fn(&mut Window, &mut App)>;

/// The left 248px Settings navigation panel, including the `Search01` input field and either the
/// search results list or the grouped section list.
#[derive(IntoElement)]
pub struct SettingsNav {
    pub search_input: Entity<InputState>,
    pub nav_scroll: ScrollHandle,
    pub search_scroll: ScrollHandle,
    pub query: String,
    pub selected: SelectedSection,
    pub this_mac_name: String,
    pub computers: Vec<(String, String, bool)>,
    pub projects: Vec<(String, String)>,
    pub hits: Vec<SettingsSearchHit>,
    pub active_hit: usize,
    pub on_select_section: SectionSelectFn,
    pub on_select_hit: HitSelectFn,
    pub on_clear_search: ClearSearchFn,
}

impl RenderOnce for SettingsNav {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = *cx.theme();
        let searching = !self.query.trim().is_empty();
        let has_query = !self.query.is_empty();
        let on_clear = self.on_clear_search.clone();

        // Search box header: `px-2 pt-2.5 pb-1.5`
        let search_box = div()
            .px(px(8.0))
            .pt(px(10.0))
            .pb(px(6.0))
            .relative()
            .flex()
            .items_center()
            .child(
                div()
                    .w_full()
                    .child(Input::new("settings-search-input", &self.search_input).size(FieldSize::S28).leading(IconName::Search01)),
            )
            .when(has_query, move |d| {
                let on_clear = on_clear.clone();
                d.child(
                    div()
                        .id("settings-search-clear")
                        .debug_selector(|| "settings-search-clear".into())
                        .absolute()
                        .right(px(14.0))
                        .size(px(18.0))
                        .rounded(RADIUS_CONTROL)
                        .cursor_pointer()
                        .flex()
                        .items_center()
                        .justify_center()
                        .text_color(theme.ink3)
                        .hover(move |s| s.bg(theme.hover2).text_color(theme.ink2))
                        .on_click(move |_, window, cx| on_clear(window, cx))
                        .child(Icon::new(IconName::Cancel01).size(IconSize::S12)),
                )
            });

        let body: AnyElement = if searching {
            render_search_results(&self.hits, self.active_hit, &self.search_scroll, self.on_select_hit, cx).into_any_element()
        } else {
            render_section_list(
                &self.selected,
                &self.this_mac_name,
                &self.computers,
                &self.projects,
                &self.nav_scroll,
                self.on_select_section,
                cx,
            )
            .into_any_element()
        };

        div()
            .debug_selector(|| "settings-nav".into())
            .w(px(248.0))
            .h_full()
            .flex_shrink_0()
            .border_r_1()
            .border_color(theme.line)
            .bg(theme.canvas)
            .flex()
            .flex_col()
            .child(search_box)
            .child(div().min_h_0().flex_1().child(body))
    }
}

fn render_search_results(
    hits: &[SettingsSearchHit],
    active_hit: usize,
    scroll: &ScrollHandle,
    on_select_hit: HitSelectFn,
    cx: &App,
) -> impl IntoElement {
    let theme = *cx.theme();
    if hits.is_empty() {
        return div()
            .debug_selector(|| "settings-search-empty".into())
            .flex_1()
            .px(px(16.0))
            .py(px(24.0))
            .text_step(TEXT_12)
            .text_color(theme.ink3)
            .child("No matching settings")
            .into_any_element();
    }

    let active_ix = active_hit.min(hits.len().saturating_sub(1));
    let mut list = div().debug_selector(|| "settings-search-results".into()).px(px(8.0)).pb(px(12.0)).flex().flex_col().gap(px(2.0));

    for (index, hit) in hits.iter().enumerate() {
        let is_active = index == active_ix;
        let entry = hit.entry.clone();
        let on_select = on_select_hit.clone();
        let hit_sel = format!("settings-search-hit-{index}");
        let hit_title_sel = format!("settings-search-hit-{}-{}", entry.page.as_str(), slug(&entry.title));

        let leading: AnyElement = match entry.page {
            SettingsSectionId::Project => ProjectAvatar::new(&entry.title).size(18.0).into_any_element(),
            SettingsSectionId::Computer => computer_dot(entry.connected.unwrap_or(false), is_active, cx).into_any_element(),
            section => div()
                .flex_shrink_0()
                .text_color(if is_active { theme.ink } else { theme.ink3 })
                .child(Icon::new(section.icon()).size(IconSize::S16))
                .into_any_element(),
        };

        let is_top_level = entry.group.is_none() || matches!(entry.page, SettingsSectionId::Computer | SettingsSectionId::Project);
        let subtitle: Option<String> = if is_top_level { entry.group.clone() } else { Some(search_trail(&entry)) };

        let mut text_col = div().min_w_0().flex_1().flex().flex_col().child(render_matched_title(&entry.title, &hit.ranges, cx));
        if let Some(sub) = subtitle {
            text_col = text_col.child(div().min_w_0().truncate().text_step(TEXT_11).text_color(theme.ink3).child(sub));
        }

        let row = div()
            .id(ElementId::Name(SharedString::from(hit_sel.clone())))
            .debug_selector(move || hit_title_sel.clone())
            .w_full()
            .px(px(8.0))
            .py(px(6.0))
            .rounded(RADIUS_CONTROL)
            .cursor_pointer()
            .flex()
            .items_center()
            .gap(px(8.0))
            .when(is_active, |d| d.bg(theme.hover2))
            .hover(move |s| s.bg(if is_active { theme.hover2 } else { theme.hover }))
            .on_click(move |_, window, cx| on_select(index, &entry, window, cx))
            .child(leading)
            .child(text_col);

        list = list.child(row);
    }

    ScrollArea::new("settings-search-scroll", scroll).fade(theme.canvas).child(list).into_any_element()
}

fn render_section_list(
    selected: &SelectedSection,
    this_mac_name: &str,
    computers: &[(String, String, bool)],
    projects: &[(String, String)],
    scroll: &ScrollHandle,
    on_select: SectionSelectFn,
    cx: &App,
) -> impl IntoElement {
    let theme = *cx.theme();

    let make_section_item = |section: SettingsSectionId| -> AnyElement {
        let active = selected.is_section(section);
        let on_select = on_select.clone();
        let id = format!("settings-nav-{}", section.as_str());
        let leading = nav_icon(section.icon(), active, cx);
        nav_item(
            id.clone(),
            id,
            section.title(),
            active,
            leading,
            move |_, window, cx| on_select(SelectedSection::Section(section), window, cx),
            cx,
        )
        .into_any_element()
    };

    // Top ungrouped sections
    let top_group = div()
        .px(px(8.0))
        .flex()
        .flex_col()
        .gap(px(2.0))
        .child(make_section_item(SettingsSectionId::General))
        .child(make_section_item(SettingsSectionId::Appearance))
        .child(make_section_item(SettingsSectionId::Chat))
        .child(make_section_item(SettingsSectionId::Voice))
        .child(make_section_item(SettingsSectionId::Notifications))
        .child(make_section_item(SettingsSectionId::Keybindings));

    // Agents group
    let agents_group = div()
        .px(px(8.0))
        .flex()
        .flex_col()
        .gap(px(2.0))
        .child(nav_group_heading("Agents", cx))
        .child(make_section_item(SettingsSectionId::Models))
        .child(make_section_item(SettingsSectionId::Accounts))
        .child(make_section_item(SettingsSectionId::Usage))
        .child(make_section_item(SettingsSectionId::Skills))
        .child(make_section_item(SettingsSectionId::Mcp))
        .child(make_section_item(SettingsSectionId::Browser));

    // Code group
    let code_group = div()
        .px(px(8.0))
        .flex()
        .flex_col()
        .gap(px(2.0))
        .child(nav_group_heading("Code", cx))
        .child(make_section_item(SettingsSectionId::Worktrees))
        .child(make_section_item(SettingsSectionId::Connections));

    // Computers & devices group
    let this_mac_active = selected.is_section(SettingsSectionId::ThisMac);
    let this_mac_label = if this_mac_name.trim().is_empty() { "This Mac".to_string() } else { this_mac_name.to_string() };
    let on_select_mac = on_select.clone();
    let mut computers_group = div()
        .px(px(8.0))
        .flex()
        .flex_col()
        .gap(px(2.0))
        .child(nav_group_heading("Computers & devices", cx))
        .child(make_section_item(SettingsSectionId::Devices))
        .child(nav_item(
            "settings-nav-this-mac",
            "settings-nav-this-mac".to_string(),
            this_mac_label,
            this_mac_active,
            computer_dot(true, this_mac_active, cx),
            move |_, window, cx| on_select_mac(SelectedSection::Section(SettingsSectionId::ThisMac), window, cx),
            cx,
        ));

    for (comp_id, comp_name, connected) in computers {
        let active = selected.is_computer(comp_id);
        let id = comp_id.clone();
        let name = comp_name.clone();
        let is_conn = *connected;
        let on_select_comp = on_select.clone();
        let nav_id = format!("settings-nav-computer-{}", slug(&id));
        computers_group = computers_group.child(nav_item(
            nav_id.clone(),
            nav_id,
            name.clone(),
            active,
            computer_dot(is_conn, active, cx),
            move |_, window, cx| {
                on_select_comp(SelectedSection::Computer { id: id.clone(), name: name.clone(), connected: is_conn }, window, cx)
            },
            cx,
        ));
    }

    // Projects group
    let mut content = div().pb(px(12.0)).flex().flex_col().child(top_group).child(agents_group).child(code_group).child(computers_group);

    if !projects.is_empty() {
        let mut projects_group = div().px(px(8.0)).flex().flex_col().gap(px(2.0)).child(nav_group_heading("Projects", cx));
        for (proj_path, proj_name) in projects {
            let active = selected.is_project(proj_path);
            let path = proj_path.clone();
            let name = proj_name.clone();
            let on_select_proj = on_select.clone();
            let nav_id = format!("settings-nav-project-{}", slug(&name));
            projects_group = projects_group.child(nav_item(
                nav_id.clone(),
                nav_id,
                name.clone(),
                active,
                ProjectAvatar::new(&name).size(16.0),
                move |_, window, cx| on_select_proj(SelectedSection::Project { path: path.clone(), name: name.clone() }, window, cx),
                cx,
            ));
        }
        content = content.child(projects_group);
    }

    // Divider + Footer (Church, About)
    let divider = div().mx(px(16.0)).mt(px(12.0)).mb(px(4.0)).h(px(1.0)).bg(theme.line);

    let footer_group = div()
        .px(px(8.0))
        .pt(px(8.0))
        .flex()
        .flex_col()
        .gap(px(2.0))
        .child(make_section_item(SettingsSectionId::Experimental))
        .child(make_section_item(SettingsSectionId::About));

    content = content.child(divider).child(footer_group);

    ScrollArea::new("settings-nav-scroll", scroll).fade(theme.canvas).child(content)
}

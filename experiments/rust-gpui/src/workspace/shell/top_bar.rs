//! The window's top bar: the controls beside the traffic lights and the panel toggles in the corner.
//!
//! Beside the lights (`SidebarNav.tsx`'s `data-sidebar-bar`): the sidebar toggle, then Routines (with its unread dot),
//! Link Projects and Search, 32px buttons 8px apart from x 80 (`sidebarLeft - 12`: the lights at x 16 span 60px
//! with 16px clear of them). They stay put whether the sidebar is open or a rail: open, they sit on the sidebar's
//! header; as a rail (44px, narrower than the lights), they sit on the Chat header's leading edge, which keeps clear
//! of them ([`chat_leading_inset`], the desktop's `useControlsClearance`). The Canvas button is left out: the Canvas
//! view is not migrated.
//!
//! The corner (`PanelToggles.tsx`): Terminals, and Simulators while one is attached, right to left from 12px in,
//! 40px apart, each pressed while its panel shows. Design A keeps the panel's own tab strip, which already has
//! Changes, the pull request, Designs and Artifacts, so those four have no toggle here. The corner is the Chat
//! column's top-right rather than the window's; the Chat header ends short of it ([`chat_trailing_inset`]).

use std::rc::Rc;

use gpui::{AnyElement, App, IntoElement, Pixels, SharedString, Window, div, prelude::*, px};

use super::keys::shortcut_hint;
use crate::theme::{ActiveTheme, HEADER_HEIGHT, Theme};
use crate::ui::{IconButton, IconButtonSize, IconName, IconSize, Tooltip};
use crate::workspace::chrome::NoDrag;
use crate::workspace::panel::PanelTab;

/// Where the traffic lights end: x 16 plus three 14pt buttons and their gaps.
pub const TRAFFIC_LIGHTS_END: f32 = 76.0;
/// The bar's left edge (the desktop's `sidebarLeft` of 92 for leading lights, less the bar's 12px offset).
pub const BAR_LEFT: f32 = 80.0;
/// Each bar and corner button (`IconButton size={32}`).
pub const BUTTON: f32 = 32.0;
/// Between two buttons; the corner's pitch is a button plus this (`CORNER_PITCH`, 40).
pub const GAP: f32 = 8.0;
/// The corner's inset from the right edge.
pub const CORNER_RIGHT: f32 = 12.0;
/// The Chat header's own padding when nothing overlaps it.
pub const HEADER_PAD: f32 = 16.0;
/// Buttons in the bar: the sidebar toggle, Routines, Link Projects, Search.
pub const BAR_BUTTONS: usize = 4;

/// The bar's buttons vertically centred in the 44px header.
fn bar_top() -> Pixels {
    (HEADER_HEIGHT - px(BUTTON)) / 2.0
}

/// The bar's width.
pub fn bar_width() -> f32 {
    BAR_BUTTONS as f32 * BUTTON + (BAR_BUTTONS - 1) as f32 * GAP
}

/// Where what follows the bar may start (`controlsEnd`: the bar plus one gap).
pub fn controls_end() -> f32 {
    BAR_LEFT + bar_width() + GAP
}

/// The Chat header's leading padding when its column starts at `column_left`: its own 16, or clear of the traffic
/// lights and the bar when those reach over it (the sidebar is a rail).
pub fn chat_leading_inset(column_left: f32) -> Pixels {
    px((controls_end() - column_left).max(HEADER_PAD))
}

/// The Chat header's trailing padding with `buttons` corner toggles: clear of them and one gap, else its own 16.
pub fn chat_trailing_inset(buttons: usize) -> Pixels {
    if buttons == 0 {
        return px(HEADER_PAD);
    }
    px(CORNER_RIGHT + buttons as f32 * (BUTTON + GAP))
}

type Handler = Rc<dyn Fn(&mut Window, &mut App)>;
/// What pressing a corner toggle does.
pub type CornerHandler = Rc<dyn Fn(Corner, &mut Window, &mut App)>;

/// What the bar shows.
pub struct Bar {
    pub collapsed: bool,
    pub routines_active: bool,
    pub routines_unread: bool,
    /// What the bar's buttons sit on (the sidebar's canvas open, the Chat's page as a rail): the unread dot's ring.
    pub ground: gpui::Rgba,
    pub on_toggle: Handler,
    pub on_routines: Handler,
    pub on_search: Handler,
    /// Link Projects: the Link Projects dialog, then the new Link's workspace (`sidebar/hooks.rs`).
    pub on_link_projects: Handler,
}

/// The bar, positioned absolutely in the window's top-left. It occludes what is under it, so a press on it never
/// reaches the header's window drag.
pub fn bar(bar: Bar, theme: &Theme) -> AnyElement {
    let Bar { collapsed, routines_active, routines_unread, ground, on_toggle, on_routines, on_search, on_link_projects } = bar;
    let toggle_label = if collapsed { "Expand sidebar" } else { "Collapse sidebar" };
    let toggle_icon = if collapsed { IconName::SidebarRight01 } else { IconName::SidebarLeft01 };
    let routines = div()
        .relative()
        .child(button("bar-routines", IconName::TimeSchedule, routines_active, move |window, cx| on_routines(window, cx)))
        .when(routines_unread, |el| {
            // The dot sits on the glyph's top-right corner, cut out of it by a ring of what is behind.
            el.child(
                div()
                    .debug_selector(|| "bar-routines-unread".into())
                    .absolute()
                    .top(px(2.0))
                    .left(px(18.0))
                    .size(px(12.0))
                    .rounded_full()
                    .border_2()
                    .border_color(ground)
                    .bg(theme.accent),
            )
        });
    div()
        .id("top-bar")
        .debug_selector(|| "top-bar".into())
        .absolute()
        .top(bar_top())
        .left(px(BAR_LEFT))
        .flex()
        .items_center()
        .gap(px(GAP))
        .occlude()
        .no_drag()
        .child(tip("tip-sidebar-toggle", toggle_label, shortcut_hint("sidebar.toggle"), {
            button("bar-sidebar-toggle", toggle_icon, false, move |window, cx| on_toggle(window, cx))
        }))
        .child(tip("tip-routines", if routines_unread { "Routines, unread Runs" } else { "Routines" }, None, routines))
        .child(tip(
            "tip-link-projects",
            "Link Projects",
            None,
            button("bar-link-projects", IconName::Link04, false, move |window, cx| on_link_projects(window, cx)),
        ))
        .child(tip(
            "tip-search",
            "Search commands, Chats and Projects",
            shortcut_hint("commandPalette.toggle"),
            button("bar-search", IconName::Search01, false, move |window, cx| on_search(window, cx)),
        ))
        .into_any_element()
}

/// One corner toggle.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Corner {
    Terminal,
    Tab(PanelTab),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CornerItem {
    pub corner: Corner,
    pub pressed: bool,
}

/// The toggles the Chat on screen offers, left to right: Terminals, then Simulators when it has one attached. The
/// panel's other tabs (Artifacts, Designs, the pull request, Changes) have no toggle here: the panel's own tab strip
/// shows them, and their shortcuts still work. `showing` is the panel tab on screen, if any.
pub fn corner_items(tabs: &[PanelTab], showing: Option<PanelTab>, terminal_open: bool) -> Vec<CornerItem> {
    let mut items = vec![CornerItem { corner: Corner::Terminal, pressed: terminal_open }];
    if tabs.contains(&PanelTab::Simulator) {
        items.push(CornerItem { corner: Corner::Tab(PanelTab::Simulator), pressed: showing == Some(PanelTab::Simulator) });
    }
    items
}

impl Corner {
    pub fn selector(self) -> &'static str {
        match self {
            Corner::Terminal => "toggle-terminal",
            Corner::Tab(PanelTab::Artifact) => "toggle-artifacts",
            Corner::Tab(PanelTab::Designs) => "toggle-designs",
            Corner::Tab(PanelTab::Pr) => "toggle-pr",
            Corner::Tab(PanelTab::Changes) => "toggle-changes",
            Corner::Tab(PanelTab::Simulator) => "toggle-simulator",
        }
    }

    fn icon(self) -> IconName {
        match self {
            Corner::Terminal => IconName::ComputerTerminal01,
            Corner::Tab(tab) => tab.icon(),
        }
    }

    /// The tooltip: "Show Changes" or "Hide Changes", as the desktop's.
    fn label(self, pressed: bool) -> SharedString {
        let name = match self {
            Corner::Terminal => "Terminals",
            Corner::Tab(PanelTab::Artifact) => "artifacts",
            Corner::Tab(PanelTab::Designs) => "designs",
            Corner::Tab(PanelTab::Pr) => return "Pull request".into(),
            Corner::Tab(PanelTab::Changes) => "Changes",
            Corner::Tab(PanelTab::Simulator) => "simulator",
        };
        format!("{} {name}", if pressed { "Hide" } else { "Show" }).into()
    }

    fn command(self) -> Option<&'static str> {
        match self {
            Corner::Terminal => Some("terminal.toggle"),
            Corner::Tab(PanelTab::Artifact) => Some("artifacts.toggle"),
            Corner::Tab(PanelTab::Designs) => Some("designs.toggle"),
            Corner::Tab(PanelTab::Changes) => Some("changes.toggle"),
            Corner::Tab(PanelTab::Simulator) => Some("simulator.toggle"),
            Corner::Tab(PanelTab::Pr) => None,
        }
    }
}

/// The corner's toggles, positioned absolutely in the top-right of the box they are added to.
pub fn corner(items: &[CornerItem], on_toggle: CornerHandler) -> AnyElement {
    div()
        .id("corner-toggles")
        .debug_selector(|| "corner-toggles".into())
        .absolute()
        .top(bar_top())
        .right(px(CORNER_RIGHT))
        .flex()
        .items_center()
        .gap(px(GAP))
        .occlude()
        .no_drag()
        .children(items.iter().map(|item| {
            let (corner, on_toggle) = (item.corner, on_toggle.clone());
            let label = corner.label(item.pressed);
            let hint = corner.command().and_then(shortcut_hint);
            tip(
                SharedString::from(format!("tip-{}", corner.selector())),
                label,
                hint,
                button(corner.selector(), corner.icon(), item.pressed, move |window, cx| on_toggle(corner, window, cx)),
            )
        }))
        .into_any_element()
}

fn button(id: &'static str, icon: IconName, pressed: bool, on_click: impl Fn(&mut Window, &mut App) + 'static) -> IconButton {
    IconButton::new(id, icon)
        .size(IconButtonSize::S32)
        .glyph(IconSize::S16)
        .pressed(pressed)
        .on_click(move |_, window, cx| on_click(window, cx))
}

fn tip(
    id: impl Into<gpui::ElementId>,
    label: impl Into<SharedString>,
    shortcut: Option<String>,
    child: impl IntoElement,
) -> impl IntoElement {
    let tooltip = Tooltip::new(label);
    let tooltip = match shortcut {
        Some(keys) => tooltip.shortcut(keys),
        None => tooltip,
    };
    div().id(id.into()).tooltip(tooltip.build()).child(child)
}

/// The ring colour behind the bar: the sidebar's surface while it is open, the Chat's page while it is a rail.
pub fn ground(collapsed: bool, cx: &App) -> gpui::Rgba {
    let theme = cx.theme();
    if collapsed { theme.page } else { theme.canvas }
}

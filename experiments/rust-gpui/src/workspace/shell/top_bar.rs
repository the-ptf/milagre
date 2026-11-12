//! The window's top bar: the controls beside the traffic lights and the panel toggles in the corner.
//!
//! Beside the lights (`SidebarNav.tsx`'s `data-sidebar-bar`): the sidebar toggle, then Routines (with its unread dot),
//! Link Projects and Search, 32px buttons 8px apart from x 80 (`sidebarLeft - 12`: the lights at x 16 span 60px
//! with 16px clear of them). They stay put whether the sidebar is open or a rail: open, they sit on the sidebar's
//! header; as a rail (44px, narrower than the lights), they sit on the Chat header's leading edge, which keeps clear
//! of them ([`chat_leading_inset`], the desktop's `useControlsClearance`). The Canvas button is left out: the Canvas
//! view is not migrated.
//!
//! The corner (`PanelToggles.tsx`): one right-panel toggle that opens and closes the side panel, 12px in, pressed while
//! the panel shows. It sits at the window's top-right in the top bar's row, whether the panel is open or closed; the
//! Chat header (panel closed) or the panel's tab strip (open) ends short of it ([`chat_trailing_inset`]). The panel's own
//! tab strip has every tab, so no other toggle is drawn here, and the Terminals open with ⌘J.

use std::rc::Rc;

use gpui::{AnyElement, App, IntoElement, Pixels, SharedString, Window, div, linear_color_stop, linear_gradient, prelude::*, px};

use super::keys::shortcut_hint;
use crate::theme::{ActiveTheme, HEADER_HEIGHT, Theme};
use crate::ui::{IconButton, IconButtonSize, IconName, IconSize, Tooltip};
use crate::workspace::chrome::NoDrag;

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

/// How wide the fade is: shorter than the Chat header's own 16px padding, so it never tints the header's text.
pub const EDGE_FADE: f32 = 12.0;

/// Where the sidebar's background meets the page's, in the top row: a short horizontal gradient from the sidebar's
/// background to the page's, on the page side of the edge (`edge` is the sidebar's width: its full width open, the
/// rail's as a rail), so the row fades instead of ending in a hard edge. Draws over the Chat header, under the bar.
pub fn edge_fade(edge: f32, theme: &Theme) -> AnyElement {
    div()
        .debug_selector(|| "top-row-fade".into())
        .absolute()
        .top_0()
        .left(px(edge + 1.0))
        .w(px(EDGE_FADE))
        .h(HEADER_HEIGHT)
        .bg(linear_gradient(90., linear_color_stop(theme.canvas, 0.), linear_color_stop(theme.page, 1.)))
        .into_any_element()
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

/// The corner's one toggle: it opens and closes the side panel (`PanelToggles.tsx`'s per-panel buttons, as one).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Corner {
    Panel,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CornerItem {
    pub corner: Corner,
    pub pressed: bool,
}

/// The corner's toggle, pressed while the panel shows.
pub fn corner_items(panel_open: bool) -> Vec<CornerItem> {
    vec![CornerItem { corner: Corner::Panel, pressed: panel_open }]
}

impl Corner {
    pub fn selector(self) -> &'static str {
        "toggle-panel"
    }

    /// A right-panel glyph, whatever tab the panel shows.
    pub fn icon(self) -> IconName {
        IconName::SidebarRight01
    }

    /// The tooltip: "Show panel" or "Hide panel".
    pub fn label(self, pressed: bool) -> SharedString {
        if pressed { "Hide panel".into() } else { "Show panel".into() }
    }

    /// The command whose key the tooltip shows: the panel's default tab (Changes, ⇧⌘D).
    pub fn command(self) -> Option<&'static str> {
        Some("changes.toggle")
    }
}

/// The corner's toggle, positioned absolutely at the Chat column's top-right, in the top bar row (the window root
/// draws it). `panel_right` is how far the open panel reaches in from the window's right edge (0 when it is closed).
pub fn corner(items: &[CornerItem], panel_right: f32, on_toggle: CornerHandler) -> AnyElement {
    div()
        .id("corner-toggles")
        .debug_selector(|| "corner-toggles".into())
        .absolute()
        .top(bar_top())
        .right(px(panel_right + CORNER_RIGHT))
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

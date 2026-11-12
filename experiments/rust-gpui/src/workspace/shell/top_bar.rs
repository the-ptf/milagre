//! The window's top bar: the controls beside the traffic lights and the panel toggles in the corner.
//!
//! Beside the lights (`SidebarNav.tsx`'s `data-sidebar-bar`): the sidebar toggle, then Routines (with its unread dot),
//! Link Projects and Search, 28px buttons 8px apart from x 80 (`sidebarLeft - 12`: the lights at x 16 span 60px
//! with 16px clear of them). They stay put whether the sidebar is open or a rail: open, they sit on the sidebar's
//! header; as a rail (44px, narrower than the lights), they sit on the Chat header's leading edge, which keeps clear
//! of them ([`chat_leading_inset`], the desktop's `useControlsClearance`). The Canvas button is left out: the Canvas
//! view is not migrated.
//!
//! The corner (`PanelToggles.tsx`): one right-panel toggle that opens and closes the side panel, pressed while the
//! panel shows by its glyph alone (no fill, at rest, pressed or hovered). It sits in the top bar's row, its 32px
//! click area's right edge on the Chat card's right border line ([`CORNER_INSET`] 0): near the
//! window's edge while the panel is closed, just left of the panel while it is open; the Chat header ends short of it
//! ([`chat_trailing_inset`]). The panel's own
//! tab strip has every tab, so no other toggle is drawn here, and the Terminals open with ⌘J.

use std::rc::Rc;

use gpui::{AnyElement, App, IntoElement, Pixels, SharedString, Window, div, prelude::*, px};

use super::keys::shortcut_hint;
use crate::theme::{ActiveTheme, Theme};
use crate::ui::press::Press;
use crate::ui::{IconButton, IconButtonSize, IconName, IconSize, Tooltip};
use crate::workspace::chrome::{NoDrag, TOP_ROW_CENTRE};

/// Where the traffic lights end: x 16 plus three 14pt buttons and their gaps.
pub const TRAFFIC_LIGHTS_END: f32 = 76.0;
/// The bar's left edge (the desktop's `sidebarLeft` of 92 for leading lights, less the bar's 12px offset).
pub const BAR_LEFT: f32 = 80.0;
/// Each bar and corner button: 28px, so centred on the traffic lights it fits the 36px top row (`chrome::TOP_ROW`).
pub const BUTTON: f32 = 28.0;
/// Between two buttons; the corner's pitch is a button plus this (36).
pub const GAP: f32 = 8.0;
/// The Chat header's trailing clearance for the corner's toggles: their inset plus one gap.
pub const CORNER_RIGHT: f32 = 12.0;
/// The toggle's inset from the Chat card's right edge: none, its click area ends on the card's border line.
pub const CORNER_INSET: f32 = 0.0;
/// The toggle's click area: a bare 32px square around its 16px glyph.
pub const CORNER_BUTTON: f32 = 32.0;
/// The Chat header's own padding when nothing overlaps it.
pub const HEADER_PAD: f32 = 16.0;
/// Buttons in the bar: the sidebar toggle, Routines, Link Projects, Search.
pub const BAR_BUTTONS: usize = 4;

/// The bar's buttons centred on the traffic lights, in the top row.
fn bar_top() -> Pixels {
    px(TOP_ROW_CENTRE - BUTTON / 2.0)
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
                    .top(px(0.0))
                    .left(px(16.0))
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

    /// The panel's state, as the sidebar toggle shows the sidebar's: a right-panel glyph while it is open, the
    /// mirrored one while it is closed, whatever tab it shows.
    pub fn icon(self, pressed: bool) -> IconName {
        if pressed { IconName::SidebarRight01 } else { IconName::SidebarLeft01 }
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

/// The corner's toggle, positioned absolutely over the Chat card's top-right, in the top bar row (the window root
/// draws it). `card_right` is how far the card's right edge is from the window's.
pub fn corner(items: &[CornerItem], card_right: f32, on_toggle: CornerHandler) -> AnyElement {
    div()
        .id("corner-toggles")
        .debug_selector(|| "corner-toggles".into())
        .absolute()
        .top(px(TOP_ROW_CENTRE - CORNER_BUTTON / 2.0))
        .right(px(card_right + CORNER_INSET))
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
                bare_button(corner.selector(), corner.icon(item.pressed), move |window, cx| on_toggle(corner, window, cx)),
            )
        }))
        .into_any_element()
}

type BareClick = Box<dyn Fn(&mut Window, &mut App)>;

/// A glyph in a 32px click area with no fill at rest, pressed or hovered: the glyph turns ink on hover, and presses to
/// 0.97 (the desktop's SidebarNav buttons press with no fill either).
#[derive(IntoElement)]
struct BareButton {
    id: &'static str,
    icon: IconName,
    on_click: BareClick,
}

fn bare_button(id: &'static str, icon: IconName, on_click: impl Fn(&mut Window, &mut App) + 'static) -> BareButton {
    BareButton { id, icon, on_click: Box::new(on_click) }
}

impl RenderOnce for BareButton {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        const GROUP: &str = "corner-toggle";
        let (id, on_click) = (self.id, self.on_click);
        let press = Press::new(id, window, cx);
        let glyph = press.factor();
        press
            .wire(div().id(id))
            .debug_selector(move || id.into())
            .group(GROUP)
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .size(px(CORNER_BUTTON))
            .cursor_pointer()
            .on_click(move |_, window, cx| on_click(window, cx))
            .child(BareGlyph(self.icon, glyph))
    }
}

/// The bare button's glyph: `ink-3`, `ink` while the button is hovered; `scale` is the press.
#[derive(IntoElement)]
struct BareGlyph(IconName, f32);

impl RenderOnce for BareGlyph {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = cx.theme();
        let ink = theme.ink;
        gpui::svg()
            .path(self.0.path(IconSize::S16))
            .flex_none()
            .size(px(IconSize::S16.px() * self.1))
            .text_color(theme.ink3)
            .group_hover("corner-toggle", move |style| style.text_color(ink))
    }
}

fn button(id: &'static str, icon: IconName, pressed: bool, on_click: impl Fn(&mut Window, &mut App) + 'static) -> IconButton {
    IconButton::new(id, icon)
        .size(IconButtonSize::S28)
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

/// The ring colour behind the bar: the window's one surface, under the sidebar and the top row alike.
pub fn ground(cx: &App) -> gpui::Rgba {
    cx.theme().canvas
}

//! The shell (WP-18): the bar's and the corner's geometry, the sidebar toggle and its key, view switching and the
//! Escape cascade, the menu bar and the window state file.

use gpui::{Modifiers, TestAppContext, point, px, size};

use super::top_bar::{self, Corner, CornerItem};
use super::window_state::{Mode, WindowState};
use super::{EscapeStep, RoutinesState, View, escape_step};
use crate::testing;
use crate::workspace::chrome::{TOP_ROW, TOP_ROW_CENTRE};
use crate::workspace::sidebar::rail::RAIL_WIDTH;

#[gpui::test]
fn the_bar_sits_beside_the_traffic_lights(cx: &mut TestAppContext) {
    let (_workspace, cx) = testing::mount_workspace(cx);
    for (ix, name) in ["bar-sidebar-toggle", "bar-routines", "bar-link-projects", "bar-search"].into_iter().enumerate() {
        let b = cx.debug_bounds(name).unwrap_or_else(|| panic!("{name} is drawn"));
        assert_eq!(b.origin.x, px(top_bar::BAR_LEFT + ix as f32 * 36.0), "{name} x");
        assert_eq!(b.center().y, px(TOP_ROW_CENTRE), "{name} is centred on the traffic lights");
        assert!(b.bottom() <= px(TOP_ROW), "{name} stays in the top row");
        assert_eq!(b.size, size(px(28.0), px(28.0)));
        assert!(b.origin.x >= px(top_bar::TRAFFIC_LIGHTS_END), "{name} clears the traffic lights");
    }
    assert!(cx.debug_bounds("bar-routines-unread").is_some(), "the fixture has unread Runs");
    // Open, the bar fits in the sidebar's header, before its New Chat button.
    let search = cx.debug_bounds("bar-search").unwrap();
    let new_chat = cx.debug_bounds("new-chat").unwrap();
    assert!(search.right() <= new_chat.left());
}

#[gpui::test]
fn the_collapsed_rail_shares_the_one_top_row_with_the_lights_and_the_bar(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    assert!(cx.debug_bounds("title-band").is_none(), "there is no separate band");
    cx.simulate_keystrokes("cmd-b");
    let sidebar = workspace.read_with(cx, |w, _| w.sidebar.clone());
    assert!(sidebar.read_with(cx, |s, _| s.is_collapsed()), "⌘B collapses the sidebar");
    assert!(cx.debug_bounds("title-band").is_none());
    // The bar keeps its place, over the rail and the start of the Chat column.
    let toggle = cx.debug_bounds("bar-sidebar-toggle").unwrap();
    assert_eq!((toggle.origin.x, toggle.center().y), (px(top_bar::BAR_LEFT), px(TOP_ROW_CENTRE)));
    let icon = cx.debug_bounds("rail-item-0").expect("the rail is drawn");
    assert!(
        icon.right() <= px(RAIL_WIDTH) && icon.top() >= px(crate::workspace::chrome::TOP_ROW),
        "the rail's icons start under the top row"
    );
    let chat = workspace.read_with(cx, |w, _| w.chat.clone());
    assert_eq!(chat.read_with(cx, |c, _| c.header_insets()).0, top_bar::chat_leading_inset(RAIL_WIDTH + 1.0, false), "clear of the bar");
    // The bar's toggle expands it again.
    cx.simulate_click(toggle.center(), Modifiers::none());
    assert!(!sidebar.read_with(cx, |s, _| s.is_collapsed()));
    assert_eq!(chat.read_with(cx, |c, _| c.header_insets()).0, px(top_bar::TITLE_INSET - super::card::CARD_BORDER));
    // The title stands on the Chat card's left edge (its border line).
    cx.run_until_parked();
    let (title, card) = (cx.debug_bounds("chat-identity-title").unwrap(), cx.debug_bounds("chat-card").unwrap());
    assert_eq!(title.left(), card.left(), "the title's left edge is the card's");
}

/// The title's place in both sidebar states, in the Preview (whose bar is the sidebar toggle alone): on the Chat
/// card's left edge with the sidebar open, right after the toggle (one gap) as a rail, as Electron's
/// `useControlsClearance`. A Subchat's breadcrumb starts at the same place.
#[gpui::test]
fn the_title_sits_on_the_card_edge_open_and_after_the_toggle_as_a_rail(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    cx.update(|_, cx| cx.set_global(crate::workspace::preview::PreviewMode { account: "test".into(), model: "test".into() }));
    cx.refresh().unwrap();
    cx.run_until_parked();
    let (title, card) = (cx.debug_bounds("chat-identity-title").unwrap(), cx.debug_bounds("chat-card").unwrap());
    assert_eq!(title.left(), card.left(), "open: on the card's edge");
    cx.simulate_keystrokes("cmd-b");
    let sidebar = workspace.read_with(cx, |w, _| w.sidebar.clone());
    assert!(sidebar.read_with(cx, |s, _| s.is_collapsed()));
    cx.run_until_parked();
    let toggle = cx.debug_bounds("bar-sidebar-toggle").unwrap();
    let title = cx.debug_bounds("chat-identity-title").unwrap();
    assert!(cx.debug_bounds("bar-routines").is_none(), "the Preview's bar is the toggle alone");
    assert_eq!(title.left(), toggle.right() + px(top_bar::GAP), "rail: one gap after the toggle");
    assert_eq!(title.left(), px(top_bar::controls_end(true)));
}

/// Collapsing the sidebar and closing the panel move nothing vertically: the Chat header, the panel's tab strip, the
/// bar and the panel toggle share one top row in all four states.
#[gpui::test]
fn the_top_row_is_the_same_height_and_place_in_all_four_states(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let (sidebar, panel) = workspace.read_with(cx, |w, _| (w.sidebar.clone(), w.panel.clone()));
    let mut rows = Vec::new();
    for collapsed in [false, true] {
        if sidebar.read_with(cx, |s, _| s.is_collapsed()) != collapsed {
            cx.simulate_keystrokes("cmd-b");
        }
        for open in [true, false] {
            panel.update(cx, |p, cx| if open { p.activate(crate::workspace::panel::PanelTab::Changes, cx) } else { p.close(cx) });
            cx.run_until_parked();
            let mut y = |name: &'static str| cx.debug_bounds(name).unwrap_or_else(|| panic!("{name} is drawn")).origin.y;
            let (identity, toggle, search) = (y("chat-identity-title"), y("toggle-panel"), y("bar-search"));
            let strip = open.then(|| {
                let b = cx.debug_bounds("panel-header").expect("the strip");
                (b.origin.x, b.origin.y, b.size.width, b.size.height)
            });
            rows.push((identity, toggle, search, strip));
        }
    }
    let first = rows[0];
    for row in &rows {
        assert_eq!((row.0, row.1, row.2), (first.0, first.1, first.2), "Chat header, toggle and bar rows: {rows:?}");
        if let (Some(a), Some(b)) = (row.3, first.3) {
            assert_eq!(a, b, "the tab strip's place: {rows:?}");
        }
    }
    assert_eq!(first.3.map(|s| s.1), Some(px(0.0)), "the tab strip is in the top row, at the top of the window");
}

#[gpui::test]
fn the_corner_has_one_toggle_that_opens_and_closes_the_side_panel(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let panel = workspace.read_with(cx, |w, _| w.panel.clone());
    // The terminal drawer is the keyboard's alone.
    let terminals = workspace.read_with(cx, |w, _| w.terminals.clone());
    cx.simulate_keystrokes("cmd-j");
    cx.run_until_parked();
    assert!(terminals.read_with(cx, |t, _| t.is_open()), "⌘J still toggles the drawer");
    let items = workspace.read_with(cx, |w, cx| w.corner_items(cx));
    assert_eq!(items, [CornerItem { corner: Corner::Panel, pressed: true }], "one toggle, pressed while the panel shows");
    for gone in
        ["toggle-terminal", "toggle-simulator", "toggle-designs", "toggle-artifacts", "toggle-pr", "toggle-details", "toggle-changes"]
    {
        assert!(cx.debug_bounds(gone).is_none(), "{gone}: the corner has only the panel toggle");
    }
    let corner = cx.debug_bounds("corner-toggles").expect("the corner is drawn");
    let toggle = cx.debug_bounds("toggle-panel").expect("the panel toggle");
    let window = cx.update(|window, _| window.viewport_size());
    assert_eq!(corner.right(), toggle.right());
    let panel_left = window.width - px(panel.read_with(cx, |p, _| p.width()));
    assert_eq!(toggle.right(), panel_left - px(4.0), "on the Chat card's border line, 4px left of the open panel");
    assert_eq!(toggle.center().y, px(TOP_ROW_CENTRE), "centred on the traffic lights, as the bar's buttons");
    assert_eq!(toggle.size.width, px(32.0), "a 32px click area");
    cx.simulate_click(toggle.center(), Modifiers::none());
    assert!(!panel.read_with(cx, |p, _| p.is_open()), "the toggle closes the panel");
    let closed = cx.debug_bounds("toggle-panel").expect("still there");
    assert_eq!(closed.right(), window.width - px(8.0), "closed: on the Chat card's border line, 8px from the window's edge");
    assert_eq!(closed.origin.y, toggle.origin.y, "same row");
    let chat = workspace.read_with(cx, |w, _| w.chat.clone());
    assert_eq!(chat.read_with(cx, |c, _| c.header_insets()).1, top_bar::chat_trailing_inset(1), "closed: the Chat header ends short of it");
    let bar = cx.debug_bounds("bar-search").unwrap();
    assert_eq!(bar.center().y, toggle.center().y, "in the bar's row, with its buttons");
    cx.simulate_click(closed.center(), Modifiers::none());
    assert!(panel.read_with(cx, |p, _| p.is_open()), "and opens it again");
    assert_eq!(
        chat.read_with(cx, |c, _| c.header_insets()).1,
        top_bar::chat_trailing_inset(1),
        "open: the toggle sits at the Chat column's right edge too"
    );
}

#[test]
fn the_toggle_wears_a_right_panel_icon_and_a_show_or_hide_tooltip_with_its_shortcut() {
    assert_eq!(Corner::Panel.icon(true), crate::ui::IconName::SidebarRight01, "open: the right-panel glyph, never the tab's icon");
    assert_eq!(Corner::Panel.icon(false), crate::ui::IconName::SidebarLeft01, "closed: the mirrored glyph, as the sidebar toggle");
    assert_eq!(Corner::Panel.label(false), "Show panel");
    assert_eq!(Corner::Panel.label(true), "Hide panel");
    assert!(Corner::Panel.command().and_then(super::keys::shortcut_hint).is_some(), "the tooltip shows a shortcut");
}

#[test]
fn the_corner_item_is_one_panel_toggle() {
    assert_eq!(top_bar::corner_items(false), [CornerItem { corner: Corner::Panel, pressed: false }]);
    assert_eq!(top_bar::corner_items(true), [CornerItem { corner: Corner::Panel, pressed: true }]);
}

#[test]
fn chat_header_insets() {
    assert_eq!(top_bar::controls_end(false), 224.0, "80 + 4 x 28 + 3 x 8 + 8");
    assert_eq!(top_bar::controls_end(true), 116.0, "80 + 28 + 8: the Preview's toggle alone");
    assert_eq!(
        top_bar::chat_leading_inset(305.0, false),
        px(-1.0),
        "open sidebar: the title on the card's edge (back over its 1px border)"
    );
    assert_eq!(top_bar::chat_leading_inset(45.0, false), px(179.0), "rail: clear of the bar");
    assert_eq!(top_bar::chat_leading_inset(45.0, true), px(71.0), "Preview rail: right after the toggle");
    assert_eq!(top_bar::chat_trailing_inset(0), px(16.0));
    assert_eq!(top_bar::chat_trailing_inset(3), px(120.0), "12 + 3 x 36");
}

#[gpui::test]
fn routines_and_escape(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    assert_eq!(workspace.read_with(cx, |w, _| w.view()), View::Chat);
    let routines = cx.debug_bounds("bar-routines").unwrap();
    cx.simulate_click(routines.center(), Modifiers::none());
    assert_eq!(workspace.read_with(cx, |w, _| w.view()), View::Routines, "the bar's Routines opens the Routines view");
    assert!(cx.debug_bounds("routines-view").is_some());
    cx.simulate_keystrokes("escape");
    assert_eq!(workspace.read_with(cx, |w, _| w.view()), View::Chat, "Escape goes back to the Chat");

    // Settings closes first, before the view.
    cx.simulate_click(routines.center(), Modifiers::none());
    let settings = workspace.read_with(cx, |w, _| w.settings.clone());
    cx.simulate_keystrokes("cmd-,");
    assert!(settings.read_with(cx, |s, _| s.is_open()));
    cx.simulate_keystrokes("escape");
    assert!(!settings.read_with(cx, |s, _| s.is_open()), "Escape closes Settings");
    assert_eq!(workspace.read_with(cx, |w, _| w.view()), View::Routines, "and nothing more");
    cx.simulate_keystrokes("escape");
    assert_eq!(workspace.read_with(cx, |w, _| w.view()), View::Chat);
}

#[gpui::test]
fn new_chat_key_leaves_routines_for_the_new_chat_composer(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let routines = cx.debug_bounds("bar-routines").unwrap();
    cx.simulate_click(routines.center(), Modifiers::none());
    cx.simulate_keystrokes("cmd-n");
    assert_eq!(workspace.read_with(cx, |w, _| w.view()), View::Chat);
    let composer = workspace.read_with(cx, |w, cx| w.chat.read(cx).composer.clone());
    assert!(composer.read_with(cx, |c, _| c.new_chat().is_some()));
}

#[test]
fn escape_cascade_order() {
    let none = RoutinesState::default();
    assert_eq!(escape_step(true, View::Routines, RoutinesState { run_pane_open: true, ..none }), Some(EscapeStep::CloseSettings));
    let pane = RoutinesState { run_pane_open: true, page_open: true, editing: false };
    assert_eq!(escape_step(false, View::Routines, pane), Some(EscapeStep::CloseRunPane));
    assert_eq!(escape_step(false, View::Routines, RoutinesState { page_open: true, ..none }), Some(EscapeStep::CloseRoutinePage));
    assert_eq!(escape_step(false, View::Routines, none), Some(EscapeStep::BackToChat));
    assert_eq!(escape_step(false, View::Routines, RoutinesState { editing: true, page_open: true, ..none }), None, "the form's own");
    assert_eq!(escape_step(false, View::Chat, none), None, "the Chat's own steps");
}

#[test]
fn every_shell_command_has_a_default_key_and_hint() {
    for id in super::keys::COMMANDS {
        assert!(super::keys::shortcut_hint(id).is_some(), "{id}");
    }
    assert_eq!(super::keys::shortcut_hint("sidebar.toggle").as_deref(), Some("⌘B"));
}

#[test]
fn the_menu_bar_matches_the_desktop() {
    let names: Vec<String> = super::keys::menus().iter().map(|menu| menu.name.to_string()).collect();
    assert_eq!(names, ["Milagre", "File", "Edit", "View", "Window"]);
}

#[test]
fn window_state_round_trips_and_is_checked_against_the_displays() {
    let bounds = gpui::Bounds { origin: point(px(120.0), px(80.0)), size: size(px(1200.0), px(800.0)) };
    let state = WindowState { bounds, mode: Mode::Maximized, sidebar_collapsed: true };
    assert_eq!(WindowState::parse(&state.to_json()), Some(state));
    assert_eq!(WindowState::parse("{not json"), None);
    assert_eq!(WindowState::parse(r#"{"x":1}"#), None);
    let display = gpui::Bounds { origin: point(px(0.0), px(0.0)), size: size(px(1512.0), px(982.0)) };
    let min = size(px(980.0), px(680.0));
    assert_eq!(state.restorable(&[display], min), Some(gpui::WindowBounds::Maximized(bounds)));
    let away = WindowState { bounds: gpui::Bounds { origin: point(px(4000.0), px(80.0)), ..bounds }, ..state };
    assert_eq!(away.restorable(&[display], min), None, "a display that is gone");
    let small = WindowState { bounds: gpui::Bounds { size: size(px(600.0), px(400.0)), ..bounds }, ..state };
    assert_eq!(small.restorable(&[display], min), None, "below the minimum");
}

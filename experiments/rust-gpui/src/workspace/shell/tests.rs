//! The shell (WP-18): the bar's and the corner's geometry, the sidebar toggle and its key, view switching and the
//! Escape cascade, the menu bar and the window state file.

use gpui::{Modifiers, TestAppContext, point, px, size};

use super::top_bar::{self, Corner, CornerItem};
use super::window_state::{Mode, WindowState};
use super::{EscapeStep, RoutinesState, View, escape_step};
use crate::testing;
use crate::workspace::panel::PanelTab;
use crate::workspace::sidebar::rail::RAIL_WIDTH;

#[gpui::test]
fn the_bar_sits_beside_the_traffic_lights(cx: &mut TestAppContext) {
    let (_workspace, cx) = testing::mount_workspace(cx);
    for (ix, name) in ["bar-sidebar-toggle", "bar-routines", "bar-link-projects", "bar-search"].into_iter().enumerate() {
        let b = cx.debug_bounds(name).unwrap_or_else(|| panic!("{name} is drawn"));
        assert_eq!(b.origin.x, px(top_bar::BAR_LEFT + ix as f32 * 40.0), "{name} x");
        assert_eq!(b.origin.y, px(6.0), "{name} is centred in the 44px header");
        assert_eq!(b.size, size(px(32.0), px(32.0)));
        assert!(b.origin.x >= px(top_bar::TRAFFIC_LIGHTS_END), "{name} clears the traffic lights");
    }
    assert!(cx.debug_bounds("bar-routines-unread").is_some(), "the fixture has unread Runs");
    // Open, the bar fits in the sidebar's header, before its New Chat button.
    let search = cx.debug_bounds("bar-search").unwrap();
    let new_chat = cx.debug_bounds("new-chat").unwrap();
    assert!(search.right() <= new_chat.left());
}

#[gpui::test]
fn the_collapsed_rail_sits_under_a_full_width_title_band_that_holds_the_lights_and_the_bar(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    assert!(cx.debug_bounds("title-band").is_none(), "open, the sidebar's header carries the bar");
    cx.simulate_keystrokes("cmd-b");
    let sidebar = workspace.read_with(cx, |w, _| w.sidebar.clone());
    assert!(sidebar.read_with(cx, |s, _| s.is_collapsed()), "⌘B collapses the sidebar");
    let window = cx.update(|window, _| window.viewport_size());
    let band = cx.debug_bounds("title-band").expect("the band is drawn");
    assert_eq!((band.origin.x, band.origin.y, band.size.width, band.size.height), (px(0.0), px(0.0), window.width, px(44.0)));
    // The bar follows the lights inside the band, and the rail and the Chat header start under it.
    let toggle = cx.debug_bounds("bar-sidebar-toggle").unwrap();
    assert_eq!(toggle.origin.x, px(top_bar::BAR_LEFT));
    assert!(toggle.bottom() <= band.bottom());
    let icon = cx.debug_bounds("rail-item-0").expect("the rail is drawn");
    assert!(icon.right() <= px(RAIL_WIDTH) && icon.top() >= band.bottom());
    let identity = cx.debug_bounds("chat-identity-title").expect("the fixture Chat shows its identity");
    assert!(identity.top() >= band.bottom(), "the Chat header starts under the band: {identity:?}");
    let chat = workspace.read_with(cx, |w, _| w.chat.clone());
    assert_eq!(chat.read_with(cx, |c, _| c.header_insets()).0, px(top_bar::HEADER_PAD), "nothing reaches over the Chat header");
    // The bar's toggle expands it again.
    cx.simulate_click(toggle.center(), Modifiers::none());
    assert!(!sidebar.read_with(cx, |s, _| s.is_collapsed()));
    assert_eq!(chat.read_with(cx, |c, _| c.header_insets()).0, px(top_bar::HEADER_PAD));
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
    assert_eq!(items, [CornerItem { corner: Corner::Tab(PanelTab::Changes), pressed: true }], "one toggle, pressed while the panel shows");
    for gone in ["toggle-terminal", "toggle-simulator", "toggle-designs", "toggle-artifacts", "toggle-pr", "toggle-details"] {
        assert!(cx.debug_bounds(gone).is_none(), "{gone}: the corner has only the panel toggle");
    }
    let corner = cx.debug_bounds("corner-toggles").expect("the corner is drawn");
    let toggle = cx.debug_bounds("toggle-changes").expect("the panel toggle");
    assert_eq!(corner.right(), toggle.right(), "12px from the Chat column's right edge");
    assert_eq!(toggle.size.width, px(32.0));
    cx.simulate_click(toggle.center(), Modifiers::none());
    assert!(!panel.read_with(cx, |p, _| p.is_open()), "the toggle closes the panel");
    let toggle = cx.debug_bounds("toggle-changes").expect("still there");
    cx.simulate_click(toggle.center(), Modifiers::none());
    assert!(panel.read_with(cx, |p, _| p.is_open()), "and opens it again");
    let chat = workspace.read_with(cx, |w, _| w.chat.clone());
    assert_eq!(chat.read_with(cx, |c, _| c.header_insets()).1, top_bar::chat_trailing_inset(1));
}

#[test]
fn the_corner_item_wears_the_active_panel_tab() {
    assert_eq!(top_bar::corner_items(PanelTab::Changes, false), [CornerItem { corner: Corner::Tab(PanelTab::Changes), pressed: false }]);
    assert_eq!(top_bar::corner_items(PanelTab::Designs, true), [CornerItem { corner: Corner::Tab(PanelTab::Designs), pressed: true }]);
}

#[test]
fn chat_header_insets() {
    assert_eq!(top_bar::controls_end(), 240.0, "80 + 4 x 32 + 3 x 8 + 8");
    assert_eq!(top_bar::chat_leading_inset(305.0), px(16.0), "open sidebar: the header's own padding");
    assert_eq!(top_bar::chat_leading_inset(45.0), px(195.0), "rail: clear of the bar");
    assert_eq!(top_bar::chat_trailing_inset(0), px(16.0));
    assert_eq!(top_bar::chat_trailing_inset(3), px(132.0), "12 + 3 x 40");
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

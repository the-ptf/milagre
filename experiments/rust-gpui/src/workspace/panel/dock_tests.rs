//! Dock tests: widths, the resizable edge, shortcuts, per-Chat tab and width, and what a keystroke re-renders.

use gpui::{Modifiers, MouseButton, TestAppContext, point, px};

use super::dock::MIN_CHAT_WIDTH;
use super::{Panel, PanelTab};
use crate::testing;

fn mount(cx: &mut TestAppContext) -> (gpui::Entity<crate::workspace::Workspace>, &mut gpui::VisualTestContext) {
    testing::mount_workspace_on(cx, PanelTab::Changes)
}

/// The panel's edge: its tabs start after its half of the Chat card's gap.
fn panel_left(cx: &mut gpui::VisualTestContext) -> gpui::Pixels {
    let tabs = cx.debug_bounds("panel-header").expect("the panel header is drawn");
    tabs.left() - crate::workspace::shell::card::panel_lead()
}

fn window_width(cx: &mut gpui::VisualTestContext) -> gpui::Pixels {
    cx.update(|window, _| window.viewport_size().width)
}

fn settle(cx: &mut gpui::VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, _| window.refresh());
    cx.run_until_parked();
}

fn drag_edge(cx: &mut gpui::VisualTestContext, to_x: gpui::Pixels) {
    let from = point(panel_left(cx) + px(1.0), px(300.0));
    cx.simulate_mouse_down(from, MouseButton::Left, Modifiers::none());
    cx.simulate_mouse_move(point(from.x - px(10.0), from.y), Some(MouseButton::Left), Modifiers::none());
    cx.simulate_mouse_move(point(to_x, from.y), Some(MouseButton::Left), Modifiers::none());
    cx.simulate_mouse_up(point(to_x, from.y), MouseButton::Left, Modifiers::none());
    settle(cx);
}

#[test]
fn one_width_rule_serves_every_tab() {
    let rule = super::dock::WIDTH_RULE;
    assert_eq!((rule.min, rule.default, rule.max), (280.0, 320.0, 1400.0));
    assert_eq!(rule.default, super::PANEL_WIDTH, "the Changes default");
    assert_eq!(rule.clamp(100.0), 280.0);
    assert_eq!(rule.clamp(2000.0), 1400.0);
    assert_eq!(MIN_CHAT_WIDTH, 420.0);
}

#[gpui::test]
fn the_panel_opens_at_its_default_width(cx: &mut TestAppContext) {
    let (_workspace, cx) = mount(cx);
    let width = window_width(cx);
    assert_eq!(panel_left(cx), width - px(320.0));
}

#[gpui::test]
fn dragging_the_left_edge_resizes_and_stops_at_the_maximum(cx: &mut TestAppContext) {
    let (workspace, cx) = mount(cx);
    let width = window_width(cx);
    drag_edge(cx, width - px(420.0));
    assert_eq!(panel_left(cx), width - px(420.0), "the edge follows the pointer");
    let panel = workspace.read_with(cx, |w, _| w.panel.clone());
    assert_eq!(panel.read_with(cx, |p, _| p.width()), 420.0, "the drag's end is remembered");
    drag_edge(cx, px(300.0));
    let widest = panel.read_with(cx, |p, _| p.width());
    assert!(widest > 420.0 && widest <= 1400.0, "stops at the window's limit: {widest}");
}

#[gpui::test]
fn dragging_never_squeezes_the_chat_under_its_minimum(cx: &mut TestAppContext) {
    let (_workspace, cx) = mount(cx);
    let width = window_width(cx);
    let chat = cx.debug_bounds("composer").map(|b| b.size.width);
    drag_edge(cx, px(310.0));
    let left = panel_left(cx);
    let chat_width = left - px(305.0);
    assert!(chat_width >= px(MIN_CHAT_WIDTH) - px(1.0), "Chat {chat_width:?} of window {width:?} ({chat:?})");
}

#[gpui::test]
fn double_clicking_the_edge_resets_the_width(cx: &mut TestAppContext) {
    let (workspace, cx) = mount(cx);
    let width = window_width(cx);
    drag_edge(cx, width - px(500.0));
    assert_eq!(panel_left(cx), width - px(500.0));
    let edge = point(panel_left(cx), px(300.0));
    cx.simulate_event(gpui::MouseDownEvent {
        position: edge,
        modifiers: Modifiers::none(),
        button: MouseButton::Left,
        click_count: 2,
        first_mouse: false,
    });
    settle(cx);
    assert_eq!(panel_left(cx), width - px(320.0), "back to the default");
    let panel = workspace.read_with(cx, |w, _| w.panel.clone());
    assert_eq!(panel.read_with(cx, |p, _| p.width()), 320.0);
}

#[gpui::test]
fn the_strip_has_no_expand_or_close_button(cx: &mut TestAppContext) {
    let (workspace, cx) = mount(cx);
    assert!(cx.debug_bounds("panel-expand").is_none(), "there is no full-width mode");
    assert!(cx.debug_bounds("panel-close").is_none(), "the corner toggle and the shortcuts close the panel");
    let list = cx.debug_bounds("panel-tab-list").expect("tab list");
    assert_eq!(list.right(), window_width(cx), "the tab list takes the strip's whole width: the toggle sits left of the panel");
    let panel = workspace.read_with(cx, |w, _| w.panel.clone());
    panel.update(cx, |p, cx| p.close(cx));
    settle(cx);
    assert!(cx.debug_bounds("panel-header").is_none(), "closed, the panel is not drawn");
    assert!(!panel.read_with(cx, |p, _| p.is_open()));
}

#[gpui::test]
fn the_desktops_shortcuts_show_and_hide_the_panel(cx: &mut TestAppContext) {
    let (workspace, cx) = mount(cx);
    let panel = workspace.read_with(cx, |w, _| w.panel.clone());
    let state = |cx: &mut gpui::VisualTestContext| panel.read_with(cx, |p: &Panel, _| (p.is_open(), p.active()));
    assert_eq!(state(cx), (true, PanelTab::Changes));
    cx.simulate_keystrokes("shift-cmd-d");
    settle(cx);
    assert_eq!(state(cx), (false, PanelTab::Changes), "changes.toggle hides the open Changes panel");
    cx.simulate_keystrokes("shift-cmd-d");
    settle(cx);
    assert_eq!(state(cx), (true, PanelTab::Changes), "and shows it again");
    cx.simulate_keystrokes("shift-cmd-e");
    settle(cx);
    assert_eq!(state(cx), (true, PanelTab::Designs), "designs.toggle switches to Designs");
    assert_eq!(panel_left(cx), window_width(cx) - px(320.0), "Designs opens at the shared width");
    cx.simulate_keystrokes("shift-cmd-e");
    settle(cx);
    assert!(!state(cx).0);
}

/// The Chat's tab and the panel's width come back when its row is picked again.
#[gpui::test]
fn each_chat_keeps_its_tab_and_the_panel_comes_back_to_it(cx: &mut TestAppContext) {
    let (workspace, cx) = mount(cx);
    let (sidebar, panel) = workspace.read_with(cx, |w, _| (w.sidebar.clone(), w.panel.clone()));
    let first = panel.read_with(cx, |p, _| p.chat().to_string());
    let designs = cx.debug_bounds("panel-tab-Designs").expect("Designs").center();
    cx.simulate_click(designs, Modifiers::none());
    settle(cx);
    assert_eq!(panel.read_with(cx, |p, _| p.active()), PanelTab::Designs);
    let row = cx.debug_bounds("chat-row-4").expect("row 4");
    cx.simulate_click(row.center(), Modifiers::none());
    settle(cx);
    let second = panel.read_with(cx, |p, _| p.chat().to_string());
    assert_ne!(first, second, "the panel follows the sidebar's selection");
    assert_eq!(panel.read_with(cx, |p, _| p.active()), PanelTab::Details, "another Chat starts on Details");
    let row = cx.debug_bounds("chat-row-3").expect("row 3");
    cx.simulate_click(row.center(), Modifiers::none());
    settle(cx);
    assert_eq!(panel.read_with(cx, |p, _| p.chat().to_string()), first);
    assert_eq!(panel.read_with(cx, |p, _| p.active()), PanelTab::Designs, "the first Chat's tab is restored");
    assert_eq!(sidebar.read_with(cx, |s, _| s.selected()), Some(3));
}

/// Tabs a Chat has no content for are hidden (Designs, Artifact and PR); the rest stay.
#[gpui::test]
fn tabs_without_content_are_hidden(cx: &mut TestAppContext) {
    let (workspace, cx) = mount(cx);
    let (sidebar, panel) = workspace.read_with(cx, |w, _| (w.sidebar.clone(), w.panel.clone()));
    assert_eq!(panel.read_with(cx, |p, _| p.visible_tabs().len()), 5, "the Chat on screen has everything");
    let seeded = panel.read_with(cx, |p, _| p.chat().to_string());
    // Find a visible row whose Chat has fewer than six tabs.
    let mut found = None;
    for ix in 0..12 {
        let key = sidebar.read_with(cx, |s, _| s.row(ix).map(|r| r.key.to_string()));
        let Some(key) = key else { continue };
        if key != seeded && !super::fixture::content_for(&key, Some(&seeded)).has(PanelTab::Designs) {
            found = Some(ix);
            break;
        }
    }
    let ix = found.expect("some fixture Chat has no designs");
    let row = cx.debug_bounds(testing::leak(format!("chat-row-{ix}"))).expect("the row is drawn");
    cx.simulate_click(row.center(), Modifiers::none());
    settle(cx);
    assert!(cx.debug_bounds("panel-tab-Designs").is_none(), "Designs is hidden");
    assert!(cx.debug_bounds("panel-tab-Changes").is_some());
    assert!(panel.read_with(cx, |p, _| p.visible_tabs().len()) < 5);
}

/// Typing in the composer re-renders the root, the sidebar and the Chat column, never the panel nor any tab body.
#[gpui::test]
fn typing_in_the_composer_renders_no_panel_view(cx: &mut TestAppContext) {
    let (workspace, cx) = mount(cx);
    let panel = workspace.read_with(cx, |w, _| w.panel.clone());
    let counts = |cx: &mut gpui::VisualTestContext| {
        let changes = panel.read_with(cx, |p, _| p.changes().clone());
        (panel.read_with(cx, |p, _| p.renders()), changes.read_with(cx, |c, _| c.renders()))
    };
    // GPUI refreshes every view once on the first key after the mouse; the rest of the typing is quiet.
    cx.simulate_input("a");
    cx.run_until_parked();
    let before = counts(cx);
    assert!(before.1 > 0, "the Changes body rendered once");
    cx.simulate_input("hello");
    cx.run_until_parked();
    assert_eq!(counts(cx), before, "typing rebuilds neither the panel nor its Changes body");
    // A tab click re-renders the panel (it shows the new tab) but not the Changes body it leaves.
    let designs = cx.debug_bounds("panel-tab-Designs").expect("Designs").center();
    cx.simulate_click(designs, Modifiers::none());
    settle(cx);
    assert!(counts(cx).0 > before.0);
    cx.simulate_input("x"); // the first key after the mouse refreshes every view once
    cx.run_until_parked();
    let after_click = counts(cx);
    cx.simulate_input("yz");
    cx.run_until_parked();
    assert_eq!(counts(cx), after_click, "nor does typing with another tab open");
}

/// One width for every tab: a drag sets it for all, and switching tabs never moves the edge.
#[gpui::test]
fn switching_tabs_never_changes_the_width(cx: &mut TestAppContext) {
    let (workspace, cx) = mount(cx);
    let width = window_width(cx);
    drag_edge(cx, width - px(450.0));
    let panel = workspace.read_with(cx, |w, _| w.panel.clone());
    for tab in [PanelTab::Designs, PanelTab::Artifact, PanelTab::Pr, PanelTab::Details, PanelTab::Changes] {
        panel.update(cx, |p, cx| p.activate(tab, cx));
        settle(cx);
        assert_eq!(panel.read_with(cx, |p, _| p.width()), 450.0, "{tab:?} keeps the dragged width");
        assert_eq!(panel_left(cx), width - px(450.0), "{tab:?} keeps the edge in place");
    }
}

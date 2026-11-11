//! Interaction tests in GPUI's headless test platform: mount the real root view, find elements by
//! their debug selectors and click them.

use gpui::{Modifiers, TestAppContext};

use crate::testing;
use crate::workspace::panel::PanelTab;

#[gpui::test]
fn clicking_a_panel_tab_makes_it_active(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let panel = workspace.read_with(cx, |workspace, _| workspace.panel.clone());
    assert_eq!(panel.read_with(cx, |panel, _| panel.active()), PanelTab::Changes);

    let terminal = cx.debug_bounds("panel-tab-Terminal").expect("the Terminal tab is drawn");
    cx.simulate_click(terminal.center(), Modifiers::none());
    assert_eq!(panel.read_with(cx, |panel, _| panel.active()), PanelTab::Terminal);

    // The PR tab is clipped at rest (the tab list scrolls), so click the last tab that is fully visible.
    let artifact = cx.debug_bounds("panel-tab-Artifact").expect("the Artifact tab is drawn");
    cx.simulate_click(artifact.center(), Modifiers::none());
    assert_eq!(panel.read_with(cx, |panel, _| panel.active()), PanelTab::Artifact);
}

#[gpui::test]
fn clicking_a_chat_row_selects_it(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let sidebar = workspace.read_with(cx, |workspace, _| workspace.sidebar.clone());
    assert_eq!(sidebar.read_with(cx, |sidebar, _| sidebar.selected()), Some(1));

    let row = cx.debug_bounds("chat-row-4").expect("row 4 is drawn by the uniform_list");
    assert_eq!(row.size.height, crate::theme::ROW_TWO_LINE);
    assert_eq!(row.size.width, gpui::px(crate::workspace::sidebar::SIDEBAR_WIDTH - 16.0), "8px inset on each side");
    cx.simulate_click(row.center(), Modifiers::none());
    assert_eq!(sidebar.read_with(cx, |sidebar, _| sidebar.selected()), Some(4));
}

#[gpui::test]
fn columns_have_their_fixed_widths(cx: &mut TestAppContext) {
    let (_workspace, cx) = testing::mount_workspace(cx);
    let first_tab = cx.debug_bounds("panel-tab-Changes").expect("the Changes tab is drawn");
    let row = cx.debug_bounds("chat-row-0").expect("row 0 is drawn");
    // The sidebar row starts 8px in from the window edge; the panel's first tab starts 8px in from
    // the panel's left edge, which is the window width minus 518.
    assert_eq!(row.origin.x, gpui::px(8.0));
    let window_width = cx.update(|window, _| window.viewport_size().width);
    assert_eq!(first_tab.origin.x, window_width - gpui::px(crate::workspace::panel::PANEL_WIDTH) + gpui::px(8.0));
}

/// gpui-component is available to views: its `init` runs in the headless test platform and one of
/// its widgets lays out inside our window.
#[gpui::test]
fn gpui_component_widgets_mount(cx: &mut TestAppContext) {
    use gpui::{Context, Window, div, prelude::*};
    use gpui_component::button::Button;

    struct Probe;
    impl Render for Probe {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div().size_full().child(div().debug_selector(|| "component-button".into()).child(Button::new("probe").label("Probe")))
        }
    }

    testing::init(cx);
    let (_probe, cx) = cx.add_window_view(|_, _| Probe);
    let button = cx.debug_bounds("component-button").expect("the gpui-component Button is drawn");
    assert!(button.size.height > gpui::px(0.0) && button.size.width > gpui::px(0.0), "it has a size: {button:?}");
}

fn chrome_calls() -> Vec<&'static str> {
    crate::workspace::chrome::CHROME_CALLS.with_borrow_mut(std::mem::take)
}

fn double_click(cx: &mut gpui::VisualTestContext, position: gpui::Point<gpui::Pixels>) {
    use gpui::{MouseButton, MouseDownEvent, MouseUpEvent};
    for click_count in [1, 2] {
        let modifiers = Modifiers::none();
        cx.simulate_event(MouseDownEvent { button: MouseButton::Left, position, modifiers, click_count, first_mouse: false });
        cx.simulate_event(MouseUpEvent { button: MouseButton::Left, position, modifiers, click_count });
    }
}

/// Every header drags the window from anywhere in its 44px, controls excepted, and a double-click on a
/// header (not on a control) zooms. `chrome.rs` records the calls in tests (GPUI's test window cannot move).
#[gpui::test]
fn headers_move_and_zoom_the_window_but_their_controls_do_not(cx: &mut TestAppContext) {
    use gpui::{MouseButton, point, px};
    let (_workspace, cx) = testing::mount_workspace(cx);
    chrome_calls();

    // Press low in the sidebar header (y 38 of 44: below AppKit's old 28px strip), then move.
    for (name, at) in [("sidebar", point(px(120.0), px(38.0))), ("chat", point(px(700.0), px(38.0)))] {
        cx.simulate_mouse_down(at, MouseButton::Left, Modifiers::none());
        cx.simulate_mouse_move(at + point(px(6.0), px(0.0)), Some(MouseButton::Left), Modifiers::none());
        cx.simulate_mouse_up(at + point(px(6.0), px(0.0)), MouseButton::Left, Modifiers::none());
        assert_eq!(chrome_calls(), ["move"], "a press and move in the {name} header moves the window, once");
    }

    // A press on a header control, then a move: no window move.
    let search = cx.debug_bounds("search").expect("the search button is drawn").center();
    cx.simulate_mouse_down(search, MouseButton::Left, Modifiers::none());
    cx.simulate_mouse_move(search + point(px(6.0), px(0.0)), Some(MouseButton::Left), Modifiers::none());
    cx.simulate_mouse_up(search + point(px(6.0), px(0.0)), MouseButton::Left, Modifiers::none());
    assert!(chrome_calls().is_empty(), "the search button is no-drag");

    // A move without a press does nothing either.
    cx.simulate_mouse_move(point(px(130.0), px(20.0)), None, Modifiers::none());
    assert!(chrome_calls().is_empty());

    double_click(cx, point(px(700.0), px(22.0)));
    assert_eq!(chrome_calls(), ["double-click"], "a double-click on the Chat header zooms");
    let tab = cx.debug_bounds("panel-tab-Terminal").expect("the Terminal tab is drawn").center();
    double_click(cx, tab);
    assert!(chrome_calls().is_empty(), "a double-click on a tab does not");
}

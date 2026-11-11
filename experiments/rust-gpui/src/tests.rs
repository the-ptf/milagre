//! Interaction tests in GPUI's headless test platform: mount the real root view, find elements by
//! their debug selectors and click them.

use gpui::{Modifiers, TestAppContext};

use crate::panel::PanelTab;
use crate::theme::Theme;
use crate::workspace::Workspace;

#[gpui::test]
fn clicking_a_panel_tab_makes_it_active(cx: &mut TestAppContext) {
    cx.update(|cx| cx.set_global(Theme::dark()));
    let (workspace, cx) = cx.add_window_view(Workspace::new);
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
    cx.update(|cx| cx.set_global(Theme::dark()));
    let (workspace, cx) = cx.add_window_view(Workspace::new);
    let sidebar = workspace.read_with(cx, |workspace, _| workspace.sidebar.clone());
    assert_eq!(sidebar.read_with(cx, |sidebar, _| sidebar.selected()), Some(1));

    let row = cx.debug_bounds("chat-row-4").expect("row 4 is drawn by the uniform_list");
    assert_eq!(row.size.height, crate::theme::ROW_TWO_LINE);
    assert_eq!(row.size.width, gpui::px(crate::sidebar::SIDEBAR_WIDTH - 16.0), "8px inset on each side");
    cx.simulate_click(row.center(), Modifiers::none());
    assert_eq!(sidebar.read_with(cx, |sidebar, _| sidebar.selected()), Some(4));
}

#[gpui::test]
fn columns_have_their_fixed_widths(cx: &mut TestAppContext) {
    cx.update(|cx| cx.set_global(Theme::dark()));
    let (_workspace, cx) = cx.add_window_view(Workspace::new);
    let first_tab = cx.debug_bounds("panel-tab-Changes").expect("the Changes tab is drawn");
    let row = cx.debug_bounds("chat-row-0").expect("row 0 is drawn");
    // The sidebar row starts 8px in from the window edge; the panel's first tab starts 8px in from
    // the panel's left edge, which is the window width minus 518.
    assert_eq!(row.origin.x, gpui::px(8.0));
    let window_width = cx.update(|window, _| window.viewport_size().width);
    assert_eq!(first_tab.origin.x, window_width - gpui::px(crate::panel::PANEL_WIDTH) + gpui::px(8.0));
}

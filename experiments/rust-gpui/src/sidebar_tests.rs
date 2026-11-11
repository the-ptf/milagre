//! Sidebar tests in GPUI's headless test platform.

use gpui::{Modifiers, TestAppContext, px};

use crate::fixtures::CHAT_COUNT;
use crate::theme::Theme;
use crate::workspace::Workspace;

fn mount(cx: &mut TestAppContext) -> (gpui::Entity<crate::sidebar::Sidebar>, &mut gpui::VisualTestContext) {
    cx.update(|cx| cx.set_global(Theme::dark()));
    let (workspace, cx) = cx.add_window_view(Workspace::new);
    let sidebar = workspace.read_with(cx, |workspace, _| workspace.sidebar.clone());
    (sidebar, cx)
}

#[gpui::test]
fn clicking_row_three_selects_it(cx: &mut TestAppContext) {
    let (sidebar, cx) = mount(cx);
    let row = cx.debug_bounds("chat-row-3").expect("row 3 is drawn");
    cx.simulate_click(row.center(), Modifiers::none());
    assert_eq!(sidebar.read_with(cx, |s, _| s.selected()), Some(3));
}

#[gpui::test]
fn the_list_holds_500_rows_but_builds_only_the_visible_ones(cx: &mut TestAppContext) {
    let (sidebar, cx) = mount(cx);
    let (count, built, visible) = sidebar.read_with(cx, |s, _| (s.row_count(), s.rows_built(), s.visible_range()));
    assert_eq!(count, CHAT_COUNT);
    assert_eq!(CHAT_COUNT, 500);
    assert!(built > 0 && built < 40, "built {built} rows for the first frames, of 500");
    assert!(visible.end < 40, "visible range {visible:?}");
    assert!(cx.debug_bounds("chat-row-0").is_some());
    assert!(cx.debug_bounds("chat-row-300").is_none(), "row 300 is far outside the viewport and not built");
}

#[gpui::test]
fn arrow_keys_move_the_selection_and_scroll_it_into_view(cx: &mut TestAppContext) {
    let (sidebar, cx) = mount(cx);
    let handle = sidebar.read_with(cx, |s, _| s.focus_handle().clone());
    cx.update(|window, _| window.focus(&handle));
    cx.simulate_keystrokes("down");
    assert_eq!(sidebar.read_with(cx, |s, _| s.selected()), Some(2));
    cx.simulate_keystrokes("up up");
    assert_eq!(sidebar.read_with(cx, |s, _| s.selected()), Some(0));
    cx.simulate_keystrokes("up");
    assert_eq!(sidebar.read_with(cx, |s, _| s.selected()), Some(0), "stops at the first row");

    for _ in 0..60 {
        cx.simulate_keystrokes("down");
    }
    assert_eq!(sidebar.read_with(cx, |s, _| s.selected()), Some(60));
    let row = cx.debug_bounds("chat-row-60").expect("the selected row was scrolled into view");
    let bottom = cx.update(|window, _| window.viewport_size().height);
    assert!(row.bottom() <= bottom && row.top() >= px(0.0), "row 60 at {row:?} inside the window");
    // Every frame rebuilds only the visible rows (about 19 here), never the 500.
    let (built, visible) = sidebar.read_with(cx, |s, _| (s.rows_built(), s.visible_range()));
    assert!(visible.len() < 40, "last frame built {visible:?}");
    assert!(built < 63 * 40, "built {built} rows over 63 key presses");
}

#[gpui::test]
fn the_bottom_group_is_pinned_under_the_list(cx: &mut TestAppContext) {
    let (_sidebar, cx) = mount(cx);
    let done = cx.debug_bounds("sidebar-done").expect("Done row is drawn");
    let usage = cx.debug_bounds("sidebar-usage").expect("usage block is drawn");
    let footer = cx.debug_bounds("sidebar-footer").expect("footer is drawn");
    let window = cx.update(|window, _| window.viewport_size());
    assert_eq!(done.size.height, px(40.0));
    assert_eq!(usage.size.height, px(100.0), "8 + 3 x 28 + 8");
    assert_eq!(footer.size.height, px(44.0));
    assert!(done.bottom() <= usage.top(), "Done above usage");
    assert!(usage.bottom() <= footer.top(), "usage above footer");
    assert_eq!(footer.bottom(), window.height, "footer bottom is the window bottom");
}

#[gpui::test]
fn header_buttons_sit_at_their_x_positions(cx: &mut TestAppContext) {
    let (_sidebar, cx) = mount(cx);
    for (name, x) in [("hide-sidebar", 208.0), ("search", 240.0), ("new-chat", 272.0)] {
        let b = cx.debug_bounds(name).unwrap_or_else(|| panic!("{name} is drawn"));
        assert_eq!(b.origin.x + px(4.0), px(x), "{name} glyph left edge");
        assert_eq!(b.size.width, px(24.0));
    }
}

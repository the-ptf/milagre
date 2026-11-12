//! The sidebar's scroll edge fades: right edges at the top and scrolled, and scrolling rebuilds no row for them.

use gpui::{Modifiers, TestAppContext, VisualTestContext, point, px};

use super::Sidebar;
use crate::testing;

fn mount(cx: &mut TestAppContext) -> (gpui::Entity<Sidebar>, &mut VisualTestContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let sidebar = workspace.read_with(cx, |workspace, _| workspace.sidebar.clone());
    cx.run_until_parked();
    (sidebar, cx)
}

/// Where the wheel turns: over the list, whatever rows are drawn.
fn list_point(cx: &mut VisualTestContext) -> gpui::Point<gpui::Pixels> {
    cx.debug_bounds("chat-row-3").expect("the list is drawn").center()
}

fn wheel(cx: &mut VisualTestContext, at: gpui::Point<gpui::Pixels>, dy: f32) {
    cx.simulate_event(gpui::ScrollEvent {
        position: at,
        delta: gpui::ScrollDelta::Pixels(point(px(0.0), px(-dy))),
        modifiers: Modifiers::none(),
        touch_phase: gpui::TouchPhase::Moved,
        source: gpui::ScrollSource::Pointer,
    });
    cx.run_until_parked();
}

fn state(sidebar: &gpui::Entity<Sidebar>, cx: &VisualTestContext) -> ((bool, bool), (f32, f32)) {
    sidebar.read_with(cx, |s, _| (s.fades().0.edges(), s.fades().0.strength()))
}

#[gpui::test]
fn the_list_fades_at_the_bottom_at_the_top_and_at_both_edges_in_the_middle(cx: &mut TestAppContext) {
    let (sidebar, cx) = mount(cx);
    let at = list_point(cx);
    assert_eq!(state(&sidebar, cx), ((false, true), (0.0, 1.0)), "at the top: only the bottom has more");
    wheel(cx, at, 600.0);
    assert_eq!(state(&sidebar, cx), ((true, true), (1.0, 1.0)), "scrolled: more above and below");
    wheel(cx, at, -600.0);
    assert_eq!(state(&sidebar, cx), ((false, true), (0.0, 1.0)), "back at the top");
}

#[gpui::test]
fn the_fades_do_not_take_the_mouse(cx: &mut TestAppContext) {
    let (sidebar, cx) = mount(cx);
    let at = list_point(cx);
    wheel(cx, at, 600.0);
    // The first row under the top fade still takes its click.
    let row = sidebar.read_with(cx, |s, _| s.visible_range().start) + 1;
    let at =
        cx.debug_bounds(Box::leak(format!("chat-row-{}", row + 2).into_boxed_str())).expect("a row near the top edge is drawn").center();
    cx.simulate_click(at, Modifiers::none());
    assert!(sidebar.read_with(cx, |s, _| s.selected()).is_some());
}

/// The rows a few wheel steps render: scrolling re-renders what it does (GPUI refreshes the window on input), and the
/// fades must add nothing to it, so steps that flip a fade cost the same as steps that leave both fades alone.
#[gpui::test]
fn scrolling_updates_the_fades_without_rendering_rows_the_scroll_did_not_reveal(cx: &mut TestAppContext) {
    let (sidebar, cx) = mount(cx);
    let at = list_point(cx);
    let built_rows = |cx: &VisualTestContext| sidebar.read_with(cx, |s, _| s.rows_built());
    // Warm up in the middle, where both fades stay on, so the margin of row views exists.
    wheel(cx, at, 600.0);
    wheel(cx, at, 2.0);
    wheel(cx, at, -2.0);
    let before = built_rows(cx);
    for _ in 0..4 {
        wheel(cx, at, 2.0);
        wheel(cx, at, -2.0);
    }
    let steady = built_rows(cx) - before;
    // Back to the top and across it: the top fade flips on and off with every step.
    wheel(cx, at, -600.0);
    wheel(cx, at, 6.0);
    wheel(cx, at, -6.0);
    let before = built_rows(cx);
    for _ in 0..4 {
        wheel(cx, at, 6.0);
        assert_eq!(state(&sidebar, cx).0, (true, true), "the top fade is on");
        wheel(cx, at, -6.0);
        assert_eq!(state(&sidebar, cx).0, (false, true), "and off at the top");
    }
    let flipping = built_rows(cx) - before;
    assert!(flipping <= steady, "flipping a fade rendered {flipping} rows, scrolling without a flip {steady}");
    // A long scroll builds only the rows it brings into the viewport and its margin, never the whole list.
    let before = built_rows(cx);
    wheel(cx, at, 1500.0);
    let built = built_rows(cx) - before;
    let alive = sidebar.read_with(cx, |s, _| s.row_views_alive());
    assert!(built <= alive + 5, "scrolling built {built} rows, with {alive} alive");
}

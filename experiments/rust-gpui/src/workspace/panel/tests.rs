//! Panel header tests in GPUI's headless test platform.

use gpui::{Modifiers, TestAppContext, px};

use crate::testing::{self, leak};
use crate::workspace::panel::{PANEL_WIDTH, PanelTab};

fn mount(cx: &mut TestAppContext) -> (gpui::Entity<crate::workspace::panel::Panel>, &mut gpui::VisualTestContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let panel = workspace.read_with(cx, |workspace, _| workspace.panel.clone());
    (panel, cx)
}

#[gpui::test]
fn six_tabs_in_order_each_with_icon_and_name(cx: &mut TestAppContext) {
    let (_panel, cx) = mount(cx);
    let names = ["Changes", "Terminal", "Browser", "Designs", "Artifact", "PR"];
    assert_eq!(PanelTab::ALL.map(PanelTab::label), names);
    let mut last_x = px(-1.0);
    for name in names {
        let tab = cx.debug_bounds(leak(format!("panel-tab-{name}"))).unwrap_or_else(|| panic!("{name} tab is drawn"));
        assert_eq!(tab.size.height, px(28.0));
        assert!(tab.origin.x > last_x, "{name} is right of the previous tab");
        last_x = tab.origin.x;
        if let Some(icon) = cx.debug_bounds(leak(format!("panel-tab-{name}-icon"))) {
            assert_eq!(icon.size.width, px(14.0));
            assert_eq!(icon.size.height, px(14.0));
            assert_eq!(icon.origin.x, tab.origin.x + px(6.0), "{name} icon after the 6px padding");
        } else {
            assert_eq!(name, "PR", "only the clipped PR tab may be unmeasured");
        }
    }
    for tab in PanelTab::ALL {
        let _ = tab.icon();
    }
}

#[gpui::test]
fn clicking_designs_activates_it(cx: &mut TestAppContext) {
    let (panel, cx) = mount(cx);
    // At the Changes panel's 320px the tab list scrolls: bring the end of it into view first.
    panel.read_with(cx, |panel, _| {
        let scroll = panel.tabs_scroll();
        scroll.set_offset(gpui::point(-scroll.max_offset().x, px(0.0)));
    });
    cx.update(|window, _| window.refresh());
    cx.run_until_parked();
    let designs = cx.debug_bounds("panel-tab-Designs").expect("Designs is drawn");
    cx.simulate_click(designs.center(), Modifiers::none());
    assert_eq!(panel.read_with(cx, |panel, _| panel.active()), PanelTab::Designs);
}

#[gpui::test]
fn expand_and_close_stay_inside_the_panel_right_edge(cx: &mut TestAppContext) {
    let (_panel, cx) = mount(cx);
    let window_width = cx.update(|window, _| window.viewport_size().width);
    let list = cx.debug_bounds("panel-tab-list").expect("tab list is drawn");
    let expand = cx.debug_bounds("panel-expand").expect("expand is drawn");
    let close = cx.debug_bounds("panel-close").expect("close is drawn");
    assert_eq!(expand.size.width, px(24.0));
    assert!(close.right() <= window_width, "close inside the window");
    assert_eq!(close.right(), window_width - px(8.0), "8px header padding");
    assert!(expand.right() <= close.left());
    assert!(list.right() <= expand.left(), "tabs scroll outside the pinned buttons");
    assert!(close.left() >= window_width - px(PANEL_WIDTH));
}

#[gpui::test]
fn clicking_the_clipped_pr_tab_scrolls_it_inside_the_list(cx: &mut TestAppContext) {
    let (panel, cx) = mount(cx);
    let list = cx.debug_bounds("panel-tab-list").expect("tab list is drawn");
    let before = panel.read_with(cx, |p, _| p.tabs_scroll().max_offset());
    assert!(before.x > px(0.0), "the six tabs overflow the list");
    // Wheel / trackpad horizontal scroll moves the list; nudge it so the PR tab's left part shows.
    let pr = cx.debug_bounds("panel-tab-PR").expect("PR is drawn");
    let nudge = (pr.left() - list.right()).max(px(0.0)) + px(20.0);
    cx.simulate_event(gpui::ScrollEvent {
        position: list.center(),
        delta: gpui::ScrollDelta::Pixels(gpui::point(-nudge, px(0.0))),
        modifiers: Modifiers::none(),
        touch_phase: gpui::TouchPhase::Moved,
        source: gpui::ScrollSource::Pointer,
    });
    cx.run_until_parked();
    assert!(panel.read_with(cx, |p, _| p.tabs_scroll().offset().x) < px(0.0), "the wheel scrolled the list");
    let pr = cx.debug_bounds("panel-tab-PR").expect("PR is drawn");
    assert!(pr.right() > list.right() || before.x <= nudge, "PR still partly clipped after the nudge");
    let click = gpui::point(pr.left() + px(4.0), pr.center().y);
    assert!(list.contains(&click), "click {click:?} list {list:?} pr {pr:?}");
    cx.simulate_click(click, Modifiers::none());
    cx.run_until_parked();
    cx.update(|window, _| window.refresh());
    cx.run_until_parked();
    assert_eq!(panel.read_with(cx, |p, _| p.active()), PanelTab::Pr);
    let pr = cx.debug_bounds("panel-tab-PR").expect("PR is drawn");
    assert!(pr.right() <= list.right(), "PR right edge {:?} inside list {:?}", pr.right(), list.right());
    assert!(panel.read_with(cx, |p, _| p.tabs_scroll().offset().x) < px(0.0));
}

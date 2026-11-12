//! Panel header tests in GPUI's headless test platform.

use gpui::{Modifiers, TestAppContext, px};

use crate::testing::{self, leak};
use crate::workspace::panel::{PANEL_WIDTH, PanelTab};

fn mount(cx: &mut TestAppContext) -> (gpui::Entity<crate::workspace::panel::Panel>, &mut gpui::VisualTestContext) {
    let (workspace, cx) = testing::mount_workspace_on(cx, PanelTab::Changes);
    let panel = workspace.read_with(cx, |workspace, _| workspace.panel.clone());
    (panel, cx)
}

#[gpui::test]
fn tabs_in_order_each_with_icon_and_name(cx: &mut TestAppContext) {
    let (panel, cx) = mount(cx);
    let names = ["Details", "PR", "Designs", "Artifact", "Changes"];
    assert_eq!(panel.read_with(cx, |p, _| p.visible_tabs()).into_iter().map(PanelTab::label).collect::<Vec<_>>(), names);
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
            assert_eq!(name, "Changes", "only the clipped last tab may be unmeasured");
        }
    }
    for tab in PanelTab::ALL {
        let _ = tab.icon();
    }
}

#[gpui::test]
fn clicking_designs_activates_it(cx: &mut TestAppContext) {
    let (panel, cx) = mount(cx);
    // At the Changes panel's 320px the tab list scrolls: Designs is the second tab, so show the start of it.
    panel.read_with(cx, |panel, _| panel.tabs_scroll().set_offset(gpui::point(px(0.0), px(0.0))));
    cx.update(|window, _| window.refresh());
    cx.run_until_parked();
    let designs = cx.debug_bounds("panel-tab-Designs").expect("Designs is drawn");
    cx.simulate_click(designs.center(), Modifiers::none());
    assert_eq!(panel.read_with(cx, |panel, _| panel.active()), PanelTab::Designs);
}

#[gpui::test]
fn the_strip_is_only_the_scrolling_tab_list(cx: &mut TestAppContext) {
    let (_panel, cx) = mount(cx);
    let window_width = cx.update(|window, _| window.viewport_size().width);
    let list = cx.debug_bounds("panel-tab-list").expect("tab list is drawn");
    assert!(cx.debug_bounds("panel-expand").is_none() && cx.debug_bounds("panel-close").is_none());
    assert_eq!(list.right(), window_width, "the whole strip, to the window edge: its fade reaches it");
    assert!(list.left() >= window_width - px(PANEL_WIDTH));
}

#[gpui::test]
fn clicking_the_last_tab_scrolls_it_inside_the_list(cx: &mut TestAppContext) {
    let (panel, cx) = mount(cx);
    let list = cx.debug_bounds("panel-tab-list").expect("tab list is drawn");
    let before = panel.read_with(cx, |p, _| p.tabs_scroll().max_offset());
    assert!(before.x > px(0.0), "the six tabs overflow the list");
    // Wheel / trackpad horizontal scroll moves the list; nudge it so the last tab's left part shows.
    let pr = cx.debug_bounds("panel-tab-Changes").expect("the last tab is drawn");
    let nudge = (pr.left() - list.right()).max(px(0.0)) + px(1.0);
    cx.simulate_event(gpui::ScrollEvent {
        position: list.center(),
        delta: gpui::ScrollDelta::Pixels(gpui::point(-nudge, px(0.0))),
        modifiers: Modifiers::none(),
        touch_phase: gpui::TouchPhase::Moved,
        source: gpui::ScrollSource::Pointer,
    });
    cx.run_until_parked();
    assert!(panel.read_with(cx, |p, _| p.tabs_scroll().offset().x) < px(0.0), "the wheel scrolled the list");
    let pr = cx.debug_bounds("panel-tab-Changes").expect("the last tab is drawn");
    let click = gpui::point(pr.left() + px(4.0), pr.center().y);
    assert!(list.contains(&click), "click {click:?} list {list:?} pr {pr:?}");
    cx.simulate_click(click, Modifiers::none());
    cx.run_until_parked();
    cx.update(|window, _| window.refresh());
    cx.run_until_parked();
    assert_eq!(panel.read_with(cx, |p, _| p.active()), PanelTab::Changes);
    let pr = cx.debug_bounds("panel-tab-Changes").expect("the last tab is drawn");
    assert!(pr.right() <= list.right(), "last tab right edge {:?} inside list {:?}", pr.right(), list.right());
    assert!(panel.read_with(cx, |p, _| p.tabs_scroll().offset().x) < px(0.0));
}

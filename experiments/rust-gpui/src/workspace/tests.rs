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

    let designs = cx.debug_bounds("panel-tab-Designs").expect("the Designs tab is drawn");
    cx.simulate_click(designs.center(), Modifiers::none());
    assert_eq!(panel.read_with(cx, |panel, _| panel.active()), PanelTab::Designs);

    // At the Changes panel's 320px the tab list scrolls: bring the end of it into view, then click Artifact.
    panel.read_with(cx, |panel, _| {
        let scroll = panel.tabs_scroll();
        scroll.set_offset(gpui::point(-scroll.max_offset().x, gpui::px(0.0)));
    });
    cx.update(|window, _| window.refresh());
    cx.run_until_parked();
    let artifact = cx.debug_bounds("panel-tab-Artifact").expect("the Artifact tab is drawn");
    cx.simulate_click(artifact.center(), Modifiers::none());
    assert_eq!(panel.read_with(cx, |panel, _| panel.active()), PanelTab::Artifact);
}

#[gpui::test]
fn clicking_a_chat_row_selects_it(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let sidebar = workspace.read_with(cx, |workspace, _| workspace.sidebar.clone());
    // The fixture's Chat on screen, after two pinned rows and the opened Subchat family.
    assert_eq!(sidebar.read_with(cx, |sidebar, _| sidebar.selected()), Some(6));

    let row = cx.debug_bounds("chat-row-7").expect("row 7 is drawn by the uniform_list");
    assert_eq!(row.size.height, crate::theme::ROW_TWO_LINE);
    assert_eq!(row.size.width, gpui::px(crate::workspace::sidebar::SIDEBAR_WIDTH - 16.0), "8px inset on each side");
    cx.simulate_click(row.center(), Modifiers::none());
    assert_eq!(sidebar.read_with(cx, |sidebar, _| sidebar.selected()), Some(7));
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
    let search = cx.debug_bounds("bar-search").expect("the search button is drawn").center();
    cx.simulate_mouse_down(search, MouseButton::Left, Modifiers::none());
    cx.simulate_mouse_move(search + point(px(6.0), px(0.0)), Some(MouseButton::Left), Modifiers::none());
    cx.simulate_mouse_up(search + point(px(6.0), px(0.0)), MouseButton::Left, Modifiers::none());
    assert!(chrome_calls().is_empty(), "the search button is no-drag");

    // A move without a press does nothing either.
    cx.simulate_mouse_move(point(px(130.0), px(20.0)), None, Modifiers::none());
    assert!(chrome_calls().is_empty());

    double_click(cx, point(px(700.0), px(22.0)));
    assert_eq!(chrome_calls(), ["double-click"], "a double-click on the Chat header zooms");
    let tab = cx.debug_bounds("panel-tab-Changes").expect("the Changes tab is drawn").center();
    double_click(cx, tab);
    assert!(chrome_calls().is_empty(), "a double-click on a tab does not");
}

/// What one keystroke and one animation frame of the running mark re-render: only the views on their
/// path to the root, never the transcript's items, the sidebar's rows or the panel (all cached).
#[gpui::test]
fn a_keystroke_or_a_running_frame_repaints_only_its_own_path(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let (sidebar, chat, panel) = workspace.read_with(cx, |w, _| (w.sidebar.clone(), w.chat.clone(), w.panel.clone()));
    let (transcript, running) = chat.read_with(cx, |c, _| (c.transcript.clone(), c.running.clone().expect("the fixture Chat runs")));
    // The first key switches GPUI to keyboard input, which refreshes every view once: do it first.
    cx.simulate_input("a");
    let counts = |cx: &mut gpui::VisualTestContext| {
        (
            transcript.read_with(cx, |t, _| t.item_renders()),
            sidebar.read_with(cx, |s, _| s.rows_built()),
            panel.read_with(cx, |p, _| p.renders()),
            running.read_with(cx, |r, _| r.renders()),
        )
    };
    let before = counts(cx);
    cx.simulate_input("bc");
    assert_eq!(counts(cx), before, "typing re-renders no item, no row, not the panel, not the running row");

    running.update(cx, |_, cx| cx.notify()); // what each animation frame does
    cx.run_until_parked();
    let (items, rows, panel_renders, running_renders) = counts(cx);
    assert_eq!((items, rows, panel_renders), (before.0, before.1, before.2), "a running frame repaints none of them");
    assert_eq!(running_renders, before.3 + 1, "only the running row itself");
}

/// GPUI's caching rules this layout relies on (gpui-pre 0.3.12, `view.rs`): a dirty cached view
/// re-renders its whole subtree, cached views inside it included; a plain view does not. If an upgrade
/// changes this, the structure in `workspace/mod.rs` can be revisited.
#[gpui::test]
fn a_dirty_cached_view_rebuilds_the_cached_views_inside_it(cx: &mut TestAppContext) {
    use gpui::{AnyView, Context, Entity, StyleRefinement, Window, div, prelude::*};
    use std::cell::Cell;
    use std::rc::Rc;

    struct Leaf(Rc<Cell<usize>>);
    impl Render for Leaf {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            self.0.set(self.0.get() + 1);
            div().size_full()
        }
    }
    struct Outer {
        leaf: Entity<Leaf>,
        cache_self: bool,
    }
    impl Render for Outer {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div().size_full().child(AnyView::from(self.leaf.clone()).cached(StyleRefinement::default().size_full()))
        }
    }
    struct Root(Entity<Outer>);
    impl Render for Root {
        fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            let outer = AnyView::from(self.0.clone());
            let cached = self.0.read(cx).cache_self;
            div().size_full().child(if cached {
                outer.cached(StyleRefinement::default().size_full()).into_any_element()
            } else {
                outer.into_any_element()
            })
        }
    }

    for cache_outer in [false, true] {
        let renders = Rc::new(Cell::new(0));
        testing::init(cx);
        let (root, window) = cx.add_window_view({
            let renders = renders.clone();
            move |_, cx| {
                let leaf = cx.new(|_| Leaf(renders));
                Root(cx.new(|_| Outer { leaf, cache_self: cache_outer }))
            }
        });
        window.run_until_parked();
        let outer = root.read_with(window, |r, _| r.0.clone());
        let before = renders.get();
        outer.update(window, |_, cx| cx.notify());
        window.run_until_parked();
        let rebuilt = renders.get() - before;
        assert_eq!(rebuilt, usize::from(cache_outer), "outer cached: {cache_outer}; the cached leaf rebuilt {rebuilt} times");
    }
}

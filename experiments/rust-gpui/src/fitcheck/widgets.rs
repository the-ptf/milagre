//! Fit check (c): gpui-component's controls and overlays against DESIGN.md (heights 24/28/32/36,
//! radii, `hover` and `hover-2`, no switches, the accent focus ring) and the dismissal rules of the
//! desktop's `lib/use-dismiss.ts`.
//!
//! Heights are measured on a wrapper that hugs each widget; the test platform's text is fixed-advance,
//! so widths are not asserted.

use std::cell::Cell;
use std::rc::Rc;

use gpui::{
    AnyElement, Context, InteractiveElement as _, IntoElement, Modifiers, ParentElement as _, Pixels, Render, Styled as _,
    VisualTestContext, Window, div, px,
};
use gpui_component::button::{Button, ButtonVariants as _};
use gpui_component::checkbox::Checkbox;
use gpui_component::popover::Popover;
use gpui_component::radio::Radio;
use gpui_component::tab::{Tab, TabBar};
use gpui_component::{Sizable as _, WindowExt as _, h_resizable, resizable_panel};

use super::harness::{draw, mount};
use crate::testing::bounds;
use crate::theme::{ActiveTheme, CONTROL_MD, CONTROL_SM, CONTROL_XS};

fn probe(name: &'static str, element: impl IntoElement) -> AnyElement {
    div().flex().items_start().child(div().debug_selector(move || name.into()).flex().child(element)).into_any_element()
}

/// Every control at its default size and at the sizes Milagre would ask for.
pub struct ControlsProbe {
    pub clicked_tab: Rc<Cell<Option<usize>>>,
}

impl Render for ControlsProbe {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.theme();
        let clicked = self.clicked_tab.clone();
        div()
            .size_full()
            .p_4()
            .flex()
            .flex_col()
            .gap_2()
            .bg(theme.page)
            .child(probe("button-default", Button::new("b1").label("Allow once").primary()))
            .child(probe("button-small", Button::new("b2").label("Allow once").primary().small()))
            .child(probe("button-xsmall", Button::new("b3").label("Allow once").primary().xsmall()))
            .child(probe("button-28", Button::new("b4").label("Allow once").primary().h(CONTROL_SM)))
            .child(probe("checkbox", Checkbox::new("c1").label("Show stats").checked(true)))
            .child(probe("radio", Radio::new("r1").label("Every Project").checked(true)))
            .child(probe(
                "tabs-default",
                TabBar::new("tabs")
                    .child(Tab::new().label("Changes"))
                    .child(Tab::new().label("Terminal"))
                    .child(Tab::new().label("Browser"))
                    .selected_index(0)
                    .on_click(move |ix, _, _| clicked.set(Some(*ix))),
            ))
            .child(probe("tabs-small", TabBar::new("tabs-s").small().child(Tab::new().label("Changes")).child(Tab::new().label("PR"))))
            .child(probe("tab-28", TabBar::new("tabs-28").child(Tab::new().label("Changes").h(CONTROL_SM))))
            .child(probe("tabbar-28", TabBar::new("tabs-bar-28").h(CONTROL_SM).child(Tab::new().label("Changes"))))
    }
}

fn height(cx: &mut VisualTestContext, selector: &'static str) -> Pixels {
    bounds(cx, selector).size.height
}

/// What gpui-component's sizes come out at, against DESIGN.md's fixed heights. The numbers are the
/// evidence in COMPONENT-FIT.md; a re-skin sets heights explicitly (as `button-28` and `tab-28` do).
#[gpui::test]
fn control_heights_against_design_md(cx: &mut gpui::TestAppContext) {
    let (_, cx) = mount(cx, |_, _| ControlsProbe { clicked_tab: Rc::default() });
    let measured: Vec<(&str, Pixels)> = [
        "button-default",
        "button-small",
        "button-xsmall",
        "button-28",
        "checkbox",
        "radio",
        "tabs-default",
        "tabs-small",
        "tab-28",
        "tabbar-28",
    ]
    .into_iter()
    .map(|name| (name, height(cx, name)))
    .collect();
    eprintln!("gpui-component heights: {measured:?}");
    let get = |name: &str| measured.iter().find(|(n, _)| *n == name).map(|(_, h)| *h).unwrap();
    // Default button = DESIGN.md's default control (32); small and xsmall miss 28 and 24.
    assert_eq!(get("button-default"), CONTROL_MD);
    assert_eq!(get("button-small"), CONTROL_XS, "small is 24, not DESIGN.md's small 28");
    assert_eq!(get("button-xsmall"), px(20.0), "xsmall is 20, under DESIGN.md's 24 floor");
    // An explicit height wins: a re-skin can pin every size.
    assert_eq!(get("button-28"), CONTROL_SM);
    // A tab's own height is ignored inside a TabBar; the bar's small size is 24, its default 32.
    assert_eq!(get("tab-28"), CONTROL_MD, "Tab::h is overridden by the bar");
    assert_eq!(get("tabs-small"), CONTROL_XS);
    assert_eq!(get("tabs-default"), CONTROL_MD, "no TabBar size gives DESIGN.md's 28px tab");
    assert_eq!(get("tabbar-28"), CONTROL_SM, "TabBar::h sets the tabs' height");
    // Checkbox and radio rows: an 18px row around a 14px box at rem 16.
    assert_eq!(get("checkbox"), px(18.0));
}

#[gpui::test]
fn a_tab_click_reports_its_index(cx: &mut gpui::TestAppContext) {
    let clicked: Rc<Cell<Option<usize>>> = Rc::default();
    let shared = clicked.clone();
    let (_, cx) = mount(cx, move |_, _| ControlsProbe { clicked_tab: shared });
    let tabs = bounds(cx, "tabs-default");
    // Third tab: the bar is laid out left to right with the labels at fixed advances.
    let target = gpui::point(tabs.right() - px(8.0), tabs.center().y);
    cx.simulate_click(target, Modifiers::none());
    assert_eq!(clicked.get(), Some(2));
}

/// The sidebar and side panel as resizable panels: a drag moves the split and stops at the range.
struct SplitProbe;

impl Render for SplitProbe {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.theme();
        div().size_full().bg(theme.page).child(
            h_resizable("split")
                .child(
                    resizable_panel()
                        .size(px(304.0))
                        .size_range(px(240.0)..px(420.0))
                        .child(div().debug_selector(|| "left-panel".into()).size_full()),
                )
                .child(resizable_panel().child(div().debug_selector(|| "right-panel".into()).size_full())),
        )
    }
}

#[gpui::test]
fn resizable_panels_drag_and_clamp(cx: &mut gpui::TestAppContext) {
    let (_, cx) = mount(cx, |_, _| SplitProbe);
    let left = bounds(cx, "left-panel");
    assert_eq!(left.size.width, px(304.0));
    let handle = gpui::point(left.right() - px(2.0), left.center().y);
    cx.simulate_mouse_down(handle, gpui::MouseButton::Left, Modifiers::none());
    draw(cx);
    // GPUI starts a drag once the pointer has moved a few pixels with the button down; moves follow.
    cx.simulate_mouse_move(gpui::point(handle.x + px(12.0), handle.y), Some(gpui::MouseButton::Left), Modifiers::none());
    cx.simulate_mouse_move(gpui::point(left.right() + px(60.0), handle.y), Some(gpui::MouseButton::Left), Modifiers::none());
    draw(cx);
    let dragged = bounds(cx, "left-panel").size.width;
    cx.simulate_mouse_move(gpui::point(left.right() + px(400.0), handle.y), Some(gpui::MouseButton::Left), Modifiers::none());
    cx.simulate_mouse_up(gpui::point(left.right() + px(400.0), handle.y), gpui::MouseButton::Left, Modifiers::none());
    draw(cx);
    let clamped = bounds(cx, "left-panel").size.width;
    assert_eq!(dragged, px(364.0), "the split follows the pointer");
    assert_eq!(clamped, px(420.0), "and stops at the panel's maximum");
}

/// A popover opens from its trigger, and closes on an outside press and on Escape (`useDismiss`).
struct PopoverProbe;

impl Render for PopoverProbe {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.theme();
        div()
            .size_full()
            .p_4()
            .bg(theme.page)
            .child(
                // A flex row, so the trigger's wrapper hugs the button instead of the window's width.
                div().flex().child(
                    div().debug_selector(|| "popover-trigger".into()).child(
                        Popover::new("menu").trigger(Button::new("open").label("Open")).content(|_, _, _| {
                            div().debug_selector(|| "popover-body".into()).w(px(200.0)).h(px(64.0)).child("Rename Chat")
                        }),
                    ),
                ),
            )
            .child(div().debug_selector(|| "outside".into()).mt(px(300.0)).size(px(40.0)))
    }
}

#[gpui::test]
fn popover_opens_and_dismisses_like_use_dismiss(cx: &mut gpui::TestAppContext) {
    let (_, cx) = mount(cx, |_, _| PopoverProbe);
    let trigger = bounds(cx, "popover-trigger").center();
    // A popover is positioned from its trigger's bounds of the frame before: draw twice.
    let settle = |cx: &mut VisualTestContext| {
        cx.run_until_parked();
        draw(cx);
        draw(cx);
    };
    let open = |cx: &mut VisualTestContext| {
        cx.simulate_click(trigger, Modifiers::none());
        settle(cx);
        cx.debug_bounds("popover-body").is_some()
    };
    assert!(open(cx), "a click on the trigger opens it");
    let outside = bounds(cx, "outside").center();
    cx.simulate_click(outside, Modifiers::none());
    settle(cx);
    assert!(cx.debug_bounds("popover-body").is_none(), "an outside press closes it");
    assert!(open(cx));
    cx.simulate_keystrokes("escape");
    settle(cx);
    assert!(cx.debug_bounds("popover-body").is_none(), "Escape closes it");
}

/// A dialog opens over the window with the scrim, and Escape closes it.
struct DialogProbe;

impl Render for DialogProbe {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div().size_full().bg(cx.theme().page)
    }
}

#[gpui::test]
fn dialog_opens_and_escape_closes_it(cx: &mut gpui::TestAppContext) {
    let (_, cx) = mount(cx, |_, _| DialogProbe);
    cx.update(|window, cx| {
        window.open_dialog(cx, |dialog, _, _| {
            dialog.title("Remove Project?").child(div().debug_selector(|| "dialog-body".into()).child("Its Chats stay in Done."))
        })
    });
    cx.run_until_parked();
    draw(cx);
    assert!(cx.update(|window, cx| window.has_active_dialog(cx)));
    assert!(cx.debug_bounds("dialog-body").is_some(), "the dialog drew its body");
    cx.simulate_keystrokes("escape");
    cx.run_until_parked();
    draw(cx);
    assert!(!cx.update(|window, cx| window.has_active_dialog(cx)), "Escape closes the dialog");
}

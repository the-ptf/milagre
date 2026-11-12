//! `ScrollArea::fade`: which edges fade where the content is scrolled, the 180ms ease, and the mouse.

use std::time::Duration;

use gpui::{Modifiers, ScrollHandle, TestAppContext, VisualTestContext, div, point, prelude::*, px, rgb};

use super::scroll_fade::{FADE_SIZE, ScrollFade};
use crate::testing::{bounds, mount_element};
use crate::ui::ScrollArea;

fn area(cx: &mut TestAppContext, clicked: std::rc::Rc<std::cell::Cell<bool>>) -> (ScrollHandle, &mut VisualTestContext) {
    let handle = ScrollHandle::new();
    let (_, cx) = mount_element(cx, {
        let handle = handle.clone();
        move |_, _| {
            let clicked = clicked.clone();
            div().h(px(200.0)).w(px(200.0)).child(ScrollArea::new("area", &handle).fade(rgb(0x111b29)).children((0..40usize).map(
                move |i| {
                    let clicked = clicked.clone();
                    div().id(("row", i)).h(px(30.0)).flex_none().on_click(move |_, _, _| clicked.set(true)).child(format!("Row {i}"))
                },
            )))
        }
    });
    (handle, cx)
}

fn scroll_by(cx: &mut VisualTestContext, dy: f32) {
    let position = bounds(cx, "area").center();
    cx.simulate_event(gpui::ScrollEvent {
        position,
        delta: gpui::ScrollDelta::Pixels(point(px(0.0), px(-dy))),
        modifiers: Modifiers::none(),
        touch_phase: gpui::TouchPhase::Moved,
        source: gpui::ScrollSource::Pointer,
    });
    cx.run_until_parked();
}

fn edges(handle: &ScrollHandle) -> (bool, bool) {
    ScrollFade::handle(handle).edges()
}

#[gpui::test]
fn an_area_fades_only_toward_the_content_that_is_left(cx: &mut TestAppContext) {
    let (handle, cx) = area(cx, Default::default());
    assert_eq!(edges(&handle), (false, true), "at the top: the bottom fades");
    scroll_by(cx, 300.0);
    assert_eq!(edges(&handle), (true, true), "in the middle: both");
    scroll_by(cx, 5000.0);
    assert_eq!(edges(&handle), (true, false), "at the end: the top fades");
    scroll_by(cx, -5000.0);
    assert_eq!(edges(&handle), (false, true));
    // React's slack: a pixel of scroll does not count.
    scroll_by(cx, 1.0);
    assert_eq!(edges(&handle), (false, true), "scrollTop 1 is not scrolled");
    scroll_by(cx, 1.0);
    assert_eq!(edges(&handle), (true, true), "scrollTop 2 is");
}

#[gpui::test]
fn an_area_that_fits_its_content_does_not_fade(cx: &mut TestAppContext) {
    let handle = ScrollHandle::new();
    let (_, _cx) = mount_element(cx, {
        let handle = handle.clone();
        move |_, _| div().h(px(200.0)).w(px(200.0)).child(ScrollArea::new("area", &handle).fade(rgb(0)).child(div().h(px(100.0))))
    });
    assert_eq!(edges(&handle), (false, false));
}

#[gpui::test]
fn the_fades_do_not_take_the_mouse(cx: &mut TestAppContext) {
    let clicked = std::rc::Rc::new(std::cell::Cell::new(false));
    let (_, cx) = area(cx, clicked.clone());
    // The last pixels of the viewport sit under the bottom fade (FADE_SIZE tall): the row there still gets its click.
    let area = bounds(cx, "area");
    cx.simulate_click(point(area.center().x, area.bottom() - px(FADE_SIZE / 4.0)), Modifiers::none());
    assert!(clicked.get(), "a click under the fade reaches the row");
}

/// React's transition: `--fade-top 180ms ease-out`, CSS `ease-out` = `cubic-bezier(0, 0, 0.58, 1)`, 28px.
#[test]
fn the_fade_copies_reacts_size_curve_and_duration() {
    use crate::ui::ease::{DURATION_BASE, css_ease_out};
    assert_eq!(FADE_SIZE, 28.0);
    assert_eq!(DURATION_BASE, Duration::from_millis(180));
    assert_eq!((css_ease_out(0.0), css_ease_out(1.0)), (0.0, 1.0));
    let mid = css_ease_out(0.5);
    assert!((mid - 0.68).abs() < 0.02, "CSS ease-out is about 0.68 at half time, got {mid}");
    assert!(css_ease_out(0.25) < css_ease_out(0.5) && css_ease_out(0.5) < css_ease_out(0.75));
}

#[gpui::test]
fn a_horizontal_strip_fades_left_once_scrolled_and_right_while_more_is_off_to_the_right(cx: &mut TestAppContext) {
    let handle = ScrollHandle::new();
    let (_, cx) = mount_element(cx, {
        let handle = handle.clone();
        move |_, _| {
            div()
                .relative()
                .w(px(200.0))
                .h(px(30.0))
                .child(
                    div()
                        .id("strip")
                        .debug_selector(|| "strip".into())
                        .size_full()
                        .flex()
                        .overflow_x_scroll()
                        .track_scroll(&handle)
                        .children((0..10).map(|i| div().w(px(80.0)).h(px(30.0)).flex_none().child(format!("Tab {i}")))),
                )
                .child(ScrollFade::handle(&handle).horizontal().overlay(rgb(0x111b29).into()))
        }
    });
    let fade = ScrollFade::handle(&handle).horizontal();
    assert_eq!(fade.edges(), (false, true), "at the start: more to the right");
    let position = bounds(cx, "strip").center();
    cx.simulate_event(gpui::ScrollEvent {
        position,
        delta: gpui::ScrollDelta::Pixels(point(px(-100.0), px(0.0))),
        modifiers: Modifiers::none(),
        touch_phase: gpui::TouchPhase::Moved,
        source: gpui::ScrollSource::Pointer,
    });
    cx.run_until_parked();
    assert_eq!(fade.edges(), (true, true), "scrolled right: both");
    handle.set_offset(point(-handle.max_offset().x, px(0.0)));
    assert_eq!(fade.edges(), (true, false), "at the end: only the left");
}

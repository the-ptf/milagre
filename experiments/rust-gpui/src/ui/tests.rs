//! One or more headless tests per primitive: size, state and what a click does.

use std::cell::Cell;
use std::rc::Rc;
use std::time::Duration;

use gpui::{Modifiers, ScrollHandle, TestAppContext, div, point, prelude::*, px};

use super::*;
use crate::testing::{bounds, leak, mount_element};
use crate::theme::{CONTROL_MD, CONTROL_SM, CONTROL_XS};

#[gpui::test]
fn icons_take_their_size_box(cx: &mut TestAppContext) {
    let (_, cx) =
        mount_element(cx, |_, _| {
            // Each wrapper hugs its icon: a flex row's children take their content's width.
            div().flex().items_start().gap_2().children(IconSize::ALL.map(|size| {
                div().flex().debug_selector(move || format!("icon-{}", size.px())).child(Icon::new(IconName::Search01).size(size))
            }))
        });
    for size in IconSize::ALL {
        let b = bounds(cx, leak(format!("icon-{}", size.px())));
        assert_eq!((b.size.width, b.size.height), (px(size.px()), px(size.px())), "{size:?}");
    }
    assert_eq!(IconSize::S12.stroke(), 1.6);
    assert_eq!(IconSize::S18.stroke(), 2.0);
    assert_eq!(IconName::Search01.hugeicons_name(), "Search01");
}

#[gpui::test]
fn buttons_have_their_heights_and_click_unless_disabled(cx: &mut TestAppContext) {
    let clicks = Rc::new(Cell::new(0));
    let (_, cx) = mount_element(cx, {
        let clicks = clicks.clone();
        move |_, _| {
            let variants = [
                ButtonVariant::Primary,
                ButtonVariant::Secondary,
                ButtonVariant::Ghost,
                ButtonVariant::Quiet,
                ButtonVariant::Link,
                ButtonVariant::Danger,
                ButtonVariant::DangerGhost,
            ];
            let count = clicks.clone();
            let ignored = clicks.clone();
            div()
                .flex()
                .flex_col()
                .gap_2()
                .child(Button::new("b24", "Small").size(ButtonSize::S24))
                .child(Button::new("b28", "Allow once").size(ButtonSize::S28).on_click(move |_, _, _| count.set(count.get() + 1)))
                .child(Button::new("b32", "Default").icon(IconName::Add01))
                .child(Button::new("off", "Disabled").disabled(true).on_click(move |_, _, _| ignored.set(ignored.get() + 100)))
                .child(Button::new("pill", "Pill").pill())
                .children(variants.into_iter().enumerate().map(|(i, v)| Button::new(("variant", i), format!("{v:?}")).variant(v)))
        }
    });
    assert_eq!(bounds(cx, "b24").size.height, CONTROL_XS);
    assert_eq!(bounds(cx, "b28").size.height, CONTROL_SM);
    assert_eq!(bounds(cx, "b32").size.height, CONTROL_MD);
    assert!(cx.debug_bounds("variant-6").is_some(), "every variant draws");
    let at = bounds(cx, "b28").center();
    cx.simulate_click(at, Modifiers::none());
    let at = bounds(cx, "off").center();
    cx.simulate_click(at, Modifiers::none());
    assert_eq!(clicks.get(), 1, "the enabled button clicked once, the disabled one not at all");
}

#[gpui::test]
fn icon_buttons_are_square(cx: &mut TestAppContext) {
    let clicks = Rc::new(Cell::new(0));
    let (_, cx) = mount_element(cx, {
        let clicks = clicks.clone();
        move |_, _| {
            let count = clicks.clone();
            div()
                .flex()
                .gap_2()
                .child(
                    IconButton::new("i24", IconName::Search01)
                        .size(IconButtonSize::S24)
                        .on_click(move |_, _, _| count.set(count.get() + 1)),
                )
                .child(IconButton::new("i28", IconName::Search01).pressed(true))
                .child(IconButton::new("i32", IconName::Search01).size(IconButtonSize::S32).disabled(true))
        }
    });
    for (name, side) in [("i24", CONTROL_XS), ("i28", CONTROL_SM), ("i32", CONTROL_MD)] {
        let b = bounds(cx, name);
        assert_eq!((b.size.width, b.size.height), (side, side), "{name}");
    }
    let at = bounds(cx, "i24").center();
    cx.simulate_click(at, Modifiers::none());
    assert_eq!(clicks.get(), 1);
}

#[gpui::test]
fn chips_are_28_high_and_hold_children(cx: &mut TestAppContext) {
    let (_, cx) = mount_element(cx, |_, _| {
        div()
            .flex()
            .gap_2()
            .child(Chip::new("model").chevron().child("Opus 5.5"))
            .child(Chip::new("field").variant(ChipVariant::Field).child("Field"))
            .child(Chip::new("filter-on").variant(ChipVariant::Filter).on(true).child("All"))
            .child(Chip::new("tag").variant(ChipVariant::Static).child(div().debug_selector(|| "chip-child".into()).child("Tag")))
    });
    for name in ["model", "field", "filter-on", "tag"] {
        assert_eq!(bounds(cx, name).size.height, CONTROL_SM, "{name}");
    }
    let (tag, child) = (bounds(cx, "tag"), bounds(cx, "chip-child"));
    assert!(tag.contains(&child.center()), "children sit inside the chip");
}

#[gpui::test]
fn tabs_show_their_icon_and_click(cx: &mut TestAppContext) {
    let clicked = Rc::new(Cell::new(false));
    let (_, cx) = mount_element(cx, {
        let clicked = clicked.clone();
        move |_, _| {
            let clicked = clicked.clone();
            div()
                .flex()
                .child(Tab::new("changes", "Changes").icon(IconName::FileDiff).count("4").active(true))
                .child(Tab::new("terminal", "Terminal").icon(IconName::ComputerTerminal01).on_click(move |_, _, _| clicked.set(true)))
        }
    });
    let tab = bounds(cx, "changes");
    assert_eq!(tab.size.height, CONTROL_SM);
    let icon = bounds(cx, "changes-icon");
    assert_eq!((icon.size.width, icon.origin.x), (px(14.0), tab.origin.x + px(6.0)), "a 14px icon after the 6px inset");
    let at = bounds(cx, "terminal").center();
    cx.simulate_click(at, Modifiers::none());
    assert!(clicked.get());
}

#[gpui::test]
fn a_scroll_area_scrolls_its_content(cx: &mut TestAppContext) {
    let handle = ScrollHandle::new();
    let (_, cx) = mount_element(cx, {
        let handle = handle.clone();
        move |_, _| {
            div()
                .h(px(200.0))
                .w(px(200.0))
                .child(ScrollArea::new("area", &handle).children((0..40).map(|i| div().h(px(30.0)).flex_none().child(format!("Row {i}")))))
        }
    });
    assert_eq!(bounds(cx, "area").size.height, px(200.0), "the area fills its parent");
    let position = bounds(cx, "area").center();
    cx.simulate_event(gpui::ScrollEvent {
        position,
        delta: gpui::ScrollDelta::Pixels(point(px(0.0), px(-90.0))),
        modifiers: Modifiers::none(),
        touch_phase: gpui::TouchPhase::Moved,
        source: gpui::ScrollSource::Pointer,
    });
    cx.run_until_parked();
    assert_eq!(handle.offset().y, px(-90.0), "the wheel scrolled it");
}

#[gpui::test]
fn a_tooltip_shows_after_hovering(cx: &mut TestAppContext) {
    let (_, cx) =
        mount_element(cx, |_, _| div().id("target").debug_selector(|| "target".into()).size(px(40.0)).tooltip(Tooltip::text("Search")));
    assert!(cx.debug_bounds("tooltip").is_none());
    let at = bounds(cx, "target").center();
    cx.simulate_mouse_move(at, None, Modifiers::none());
    cx.executor().advance_clock(Duration::from_secs(2));
    cx.run_until_parked();
    assert!(cx.debug_bounds("tooltip").is_some(), "the ink capsule is drawn");
}

#[gpui::test]
fn spinner_section_label_and_avatar_sizes(cx: &mut TestAppContext) {
    let (_, cx) = mount_element(cx, |_, _| {
        div()
            .flex()
            .flex_col()
            .items_start()
            .child(div().debug_selector(|| "spinner".into()).child(SpinnerRing::new()))
            .child(div().debug_selector(|| "spinner-10".into()).child(SpinnerRing::new().size(10.0)))
            .child(div().debug_selector(|| "label".into()).child(SectionLabel::new("All Chats")))
            .child(div().debug_selector(|| "menu-label".into()).child(SectionLabel::new("Recent").menu()))
            .child(div().debug_selector(|| "avatar".into()).child(ProjectAvatar::new("milagre-ade").size(24.0)))
            .child(div().debug_selector(|| "avatar-40".into()).child(ProjectAvatar::new("site").size(40.0)))
    });
    assert_eq!(bounds(cx, "spinner").size.width, px(12.0));
    assert_eq!(bounds(cx, "spinner-10").size.width, px(10.0));
    assert_eq!(bounds(cx, "label").size.height, px(16.0), "12 on a 16 line");
    assert_eq!(bounds(cx, "menu-label").size.height, px(16.0), "11 on a 16 line");
    assert_eq!(bounds(cx, "avatar").size.height, px(24.0));
    assert_eq!(bounds(cx, "avatar-40").size.height, px(40.0));
}

#[gpui::test]
fn a_checkbox_reports_the_new_value(cx: &mut TestAppContext) {
    let value = Rc::new(Cell::new(None));
    let (_, cx) = mount_element(cx, {
        let value = value.clone();
        move |_, _| {
            let set = value.clone();
            let off = value.clone();
            div()
                .flex()
                .flex_col()
                .gap_2()
                .child(Checkbox::new("show-stats", false).label("Show stats").on_toggle(move |checked, _, _| set.set(Some(checked))))
                .child(Checkbox::new("locked", true).disabled(true).on_toggle(move |_, _, _| off.set(Some(false))))
        }
    });
    assert_eq!(bounds(cx, "show-stats-box").size.width, px(16.0));
    let at = bounds(cx, "show-stats").center();
    cx.simulate_click(at, Modifiers::none());
    assert_eq!(value.get(), Some(true), "a click on the label checks it");
    value.set(None);
    let at = bounds(cx, "locked").center();
    cx.simulate_click(at, Modifiers::none());
    assert_eq!(value.get(), None, "a disabled checkbox ignores clicks");
}

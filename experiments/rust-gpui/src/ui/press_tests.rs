//! The press response (`press.rs`): it follows the mouse, ends when the mouse comes up anywhere, and shrinks by
//! the CSS scale; every button primitive draws it.

use std::cell::Cell;
use std::rc::Rc;

use gpui::{Modifiers, MouseButton, MouseDownEvent, MouseUpEvent, TestAppContext, div, prelude::*, px};

use super::press::{PRESS_SCALE, Press};
use crate::testing;

fn down(cx: &mut gpui::VisualTestContext, at: gpui::Point<gpui::Pixels>) {
    cx.simulate_event(MouseDownEvent {
        position: at,
        button: MouseButton::Left,
        modifiers: Modifiers::none(),
        click_count: 1,
        first_mouse: false,
    });
    cx.run_until_parked();
}

fn up(cx: &mut gpui::VisualTestContext, at: gpui::Point<gpui::Pixels>) {
    cx.simulate_event(MouseUpEvent { position: at, button: MouseButton::Left, modifiers: Modifiers::none(), click_count: 1 });
    cx.run_until_parked();
}

#[gpui::test]
fn a_press_scales_to_point_97_while_down_and_lets_go_on_release_anywhere(cx: &mut TestAppContext) {
    let factor = Rc::new(Cell::new(1.0f32));
    let seen = factor.clone();
    let (_, cx) = testing::mount_element(cx, move |window, cx| {
        let press = Press::new("box", window, cx);
        seen.set(press.factor());
        press.wire(div().id("box")).debug_selector(|| "box".into()).size(px(40.0))
    });
    assert_eq!(factor.get(), 1.0);
    let centre = testing::bounds(cx, "box").center();
    down(cx, centre);
    assert!((factor.get() - PRESS_SCALE).abs() < 1e-4, "pressed: {}", factor.get());
    // Released outside the box: it lets go.
    up(cx, gpui::point(px(400.0), px(400.0)));
    assert_eq!(factor.get(), 1.0, "mouse up outside ends the press");
    down(cx, centre);
    up(cx, centre);
    assert_eq!(factor.get(), 1.0, "mouse up inside ends the press");
}

struct Pressed;

impl gpui::Render for Pressed {
    fn render(&mut self, window: &mut gpui::Window, cx: &mut gpui::Context<Self>) -> impl gpui::IntoElement {
        let press = Press::new("pressed", window, cx);
        press.wire(div()).debug_selector(|| "pressed".into()).size(px(40.0))
    }
}

struct Bystander(Rc<Cell<usize>>);

impl gpui::Render for Bystander {
    fn render(&mut self, _: &mut gpui::Window, _: &mut gpui::Context<Self>) -> impl gpui::IntoElement {
        self.0.set(self.0.get() + 1);
        div().size(px(40.0))
    }
}

struct Host(gpui::Entity<Pressed>, gpui::Entity<Bystander>);

impl gpui::Render for Host {
    fn render(&mut self, _: &mut gpui::Window, _: &mut gpui::Context<Self>) -> impl gpui::IntoElement {
        let fixed = gpui::StyleRefinement::default().w(px(40.0)).h(px(40.0));
        div()
            .flex()
            .child(gpui::AnyView::from(self.0.clone()).cached(fixed.clone()))
            .child(gpui::AnyView::from(self.1.clone()).cached(fixed))
    }
}

/// A press renders its own view and nobody else's: a cached view beside it is reused. (The element here has no id: GPUI
/// refreshes the whole window on a mouse down on any element with one, `div.rs`, which is outside the press.)
#[gpui::test]
fn a_press_renders_its_own_view_and_no_cached_neighbour(cx: &mut TestAppContext) {
    testing::init(cx);
    let renders = Rc::new(Cell::new(0));
    let seen = renders.clone();
    let (_, cx) = cx.add_window_view(move |_, cx| Host(cx.new(|_| Pressed), cx.new(|_| Bystander(seen))));
    cx.run_until_parked();
    let centre = testing::bounds(cx, "pressed").center();
    cx.simulate_mouse_move(centre, None, Modifiers::none());
    cx.run_until_parked();
    let before = renders.get();
    down(cx, centre);
    up(cx, centre);
    assert_eq!(renders.get(), before, "the neighbouring cached view was not rebuilt by a press");
}

//! [`RangeSlider`] (DESIGN.md "Model picker"; the desktop's `primitives/RangeSlider.tsx`, default variant): a 32px
//! high `field` track with `rounded-control`, filled with ink at 15% up to its value, a 4px tick dot per step (ink
//! at 25%) and a 4x20 ink bar handle. Press or drag anywhere on the track to pick the nearest step; Left, Down,
//! Right, Up, Home and End move it when focused. The handle's centre runs from 10px to the width less 10px (the
//! desktop's `HANDLE_INSET` 8 plus the 2px clip inset), and the ticks and the fill follow it. No spring: the
//! handle lands on its step at once.

use std::cell::Cell;
use std::rc::Rc;

use gpui::{
    App, Bounds, ElementId, IntoElement, KeyDownEvent, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, ParentElement, Pixels,
    RenderOnce, Rgba, Styled, Window, canvas, div, prelude::*, px,
};

use super::focus::{inset_ring, item_focus};
use crate::theme::{ActiveTheme, RADIUS_CONTROL};

const TRACK_HEIGHT: f32 = 32.0;
const HANDLE_INSET: f32 = 10.0;
const HANDLE_WIDTH: f32 = 4.0;
const HANDLE_HEIGHT: f32 = 20.0;
const TICK: f32 = 4.0;

type Change = Rc<dyn Fn(usize, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct RangeSlider {
    id: ElementId,
    value: usize,
    steps: usize,
    on_change: Option<Change>,
}

impl RangeSlider {
    /// `steps` is the number of stops (at least 2); `value` the index of the picked one.
    pub fn new(id: impl Into<ElementId>, value: usize, steps: usize) -> Self {
        Self { id: id.into(), value, steps: steps.max(2), on_change: None }
    }

    pub fn on_change(mut self, handler: impl Fn(usize, &mut Window, &mut App) + 'static) -> Self {
        self.on_change = Some(Rc::new(handler));
        self
    }
}

/// The step nearest to `x` (relative to the track's left edge) on a track `width` wide.
pub fn step_at(x: f32, width: f32, steps: usize) -> usize {
    let span = (width - 2.0 * HANDLE_INSET).max(1.0);
    let fraction = ((x - HANDLE_INSET) / span).clamp(0.0, 1.0);
    (fraction * (steps - 1) as f32).round() as usize
}

/// Where the handle's centre sits, from the track's left edge.
pub fn centre_at(value: usize, width: f32, steps: usize) -> f32 {
    HANDLE_INSET + (width - 2.0 * HANDLE_INSET).max(0.0) * value as f32 / (steps - 1) as f32
}

fn faded(color: Rgba, alpha: f32) -> Rgba {
    Rgba { a: alpha, ..color }
}

impl RenderOnce for RangeSlider {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = *cx.theme();
        let handle = item_focus(&self.id, window, cx);
        let width = window.use_keyed_state((self.id.clone(), "width"), cx, |_, _| Rc::new(Cell::new(176.0_f32))).read(cx).clone();
        let origin = window.use_keyed_state((self.id.clone(), "origin"), cx, |_, _| Rc::new(Cell::new(0.0_f32))).read(cx).clone();
        let dragging = window.use_keyed_state((self.id.clone(), "drag"), cx, |_, _| Rc::new(Cell::new(false))).read(cx).clone();
        let (steps, value) = (self.steps, self.value.min(self.steps - 1));
        let w = width.get();
        let centre = centre_at(value, w, steps);
        let on_change = self.on_change.clone();
        let pick = {
            let (origin, width) = (origin.clone(), width.clone());
            move |x: Pixels, window: &mut Window, cx: &mut App, on_change: &Option<Change>| {
                if let Some(on_change) = on_change {
                    on_change(step_at(f32::from(x) - origin.get(), width.get(), steps), window, cx);
                }
            }
        };
        let (down_change, move_change, key_change) = (on_change.clone(), on_change.clone(), on_change);
        let (down_pick, move_pick) = (pick.clone(), pick);
        let (drag_down, drag_move, drag_up) = (dragging.clone(), dragging.clone(), dragging);
        let key_handle = handle.clone();
        let accent = theme.accent;
        let ink = theme.ink;
        div()
            .id(self.id)
            .debug_selector(|| "range-slider".into())
            .track_focus(&handle)
            .relative()
            .flex_none()
            .w_full()
            .h(px(TRACK_HEIGHT))
            .rounded(RADIUS_CONTROL)
            .bg(theme.field)
            .overflow_hidden()
            .cursor_pointer()
            .focus_visible(move |style| style.shadow(inset_ring(accent)))
            .on_mouse_down(MouseButton::Left, move |event: &MouseDownEvent, window, cx| {
                key_handle.focus(window, cx);
                drag_down.set(true);
                down_pick(event.position.x, window, cx, &down_change);
            })
            .on_mouse_move(move |event: &MouseMoveEvent, window, cx| {
                if drag_move.get() && event.dragging() {
                    move_pick(event.position.x, window, cx, &move_change);
                }
            })
            .on_mouse_up(MouseButton::Left, move |_: &MouseUpEvent, _, _| drag_up.set(false))
            .on_key_down(move |event: &KeyDownEvent, window, cx| {
                let next = match event.keystroke.key.as_str() {
                    "left" | "down" => value.checked_sub(1),
                    "right" | "up" => Some((value + 1).min(steps - 1)),
                    "home" => Some(0),
                    "end" => Some(steps - 1),
                    _ => return,
                };
                if let (Some(next), Some(on_change)) = (next, &key_change) {
                    on_change(next, window, cx);
                }
                cx.stop_propagation();
            })
            // Measures the track each frame (the handle and the ticks follow its width).
            .child(
                canvas(
                    {
                        let (width, origin) = (width, origin);
                        move |bounds: Bounds<Pixels>, _, _| {
                            width.set(f32::from(bounds.size.width));
                            origin.set(f32::from(bounds.origin.x));
                        }
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full(),
            )
            // The fill ends at the handle's centre, inset 2px at the left like the desktop's clip.
            .child(div().absolute().top_0().bottom_0().left(px(2.0)).w(px((centre - 2.0).max(0.0))).bg(faded(ink, 0.15)))
            .children((0..steps).map(|step| {
                div()
                    .absolute()
                    .top(px((TRACK_HEIGHT - TICK) / 2.0))
                    .left(px(centre_at(step, w, steps) - TICK / 2.0))
                    .size(px(TICK))
                    .rounded_full()
                    .bg(faded(ink, 0.25))
            }))
            .child(
                div()
                    .debug_selector(|| "range-slider-handle".into())
                    .absolute()
                    .top(px((TRACK_HEIGHT - HANDLE_HEIGHT) / 2.0))
                    .left(px(centre - HANDLE_WIDTH / 2.0))
                    .w(px(HANDLE_WIDTH))
                    .h(px(HANDLE_HEIGHT))
                    .rounded_full()
                    .bg(ink),
            )
    }
}

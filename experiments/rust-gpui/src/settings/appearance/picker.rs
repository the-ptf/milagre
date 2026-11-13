//! Our own colour picker for the custom theme editor (the desktop uses the browser's `<input type="color">`):
//! a saturation/value square over the hue, and a hue strip. Press or drag either; the hex field beside the swatch
//! is the exact input. The state is HSV so dragging to black or white keeps the hue.

use std::cell::Cell;
use std::rc::Rc;

use gpui::{
    App, Bounds, ElementId, Hsla, IntoElement, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, ParentElement, Pixels,
    RenderOnce, Rgba, Styled, Window, canvas, div, linear_color_stop, linear_gradient, prelude::*, px,
};

use super::color::{hex_to_hsv, hsv_to_hex};
use super::palette::parse_rgba;
use crate::theme::{ActiveTheme, RADIUS_CHIP};

pub const SV_WIDTH: f32 = 208.0;
pub const SV_HEIGHT: f32 = 136.0;
const HUE_HEIGHT: f32 = 14.0;
const KNOB: f32 = 14.0;

type Change = Rc<dyn Fn(String, &mut Window, &mut App)>;

/// Saturation and value for a point `(x, y)` in the square (origin top-left).
pub fn sv_at(x: f32, y: f32) -> (f64, f64) {
    ((x / SV_WIDTH).clamp(0.0, 1.0) as f64, (1.0 - y / SV_HEIGHT).clamp(0.0, 1.0) as f64)
}

/// Hue (degrees) for a point `x` along the strip.
pub fn hue_at(x: f32) -> f64 {
    (x / SV_WIDTH).clamp(0.0, 1.0) as f64 * 360.0
}

#[derive(Clone, Copy, PartialEq)]
enum Drag {
    None,
    Square,
    Hue,
}

#[derive(IntoElement)]
pub struct ColorPicker {
    id: ElementId,
    value: String,
    on_change: Option<Change>,
}

impl ColorPicker {
    pub fn new(id: impl Into<ElementId>, value: impl Into<String>) -> Self {
        Self { id: id.into(), value: value.into(), on_change: None }
    }

    pub fn on_change(mut self, handler: impl Fn(String, &mut Window, &mut App) + 'static) -> Self {
        self.on_change = Some(Rc::new(handler));
        self
    }
}

fn hsla(hex: &str) -> Hsla {
    parse_rgba(hex).into()
}

impl RenderOnce for ColorPicker {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = *cx.theme();
        let id = self.id;
        let hsv = window.use_keyed_state((id.clone(), "hsv"), cx, |_, _| Rc::new(Cell::new(hex_to_hsv("#000000")))).read(cx).clone();
        let square_origin = window.use_keyed_state((id.clone(), "sq"), cx, |_, _| Rc::new(Cell::new((0.0_f32, 0.0_f32)))).read(cx).clone();
        let hue_origin = window.use_keyed_state((id.clone(), "hue"), cx, |_, _| Rc::new(Cell::new(0.0_f32))).read(cx).clone();
        let drag = window.use_keyed_state((id.clone(), "drag"), cx, |_, _| Rc::new(Cell::new(Drag::None))).read(cx).clone();

        // An outside change (hex field, another scheme) wins; our own drag writes the same hex back.
        if hsv_to_hex(hsv.get().0, hsv.get().1, hsv.get().2) != self.value {
            hsv.set(hex_to_hsv(&self.value));
        }
        let (h, s, v) = hsv.get();
        let pure_hue = hsv_to_hex(h, 1.0, 1.0);
        let current = hsv_to_hex(h, s, v);
        let on_change = self.on_change;

        let emit = {
            let (hsv, on_change) = (hsv.clone(), on_change);
            move |window: &mut Window, cx: &mut App| {
                if let Some(on_change) = &on_change {
                    let (h, s, v) = hsv.get();
                    on_change(hsv_to_hex(h, s, v), window, cx);
                }
            }
        };

        let white: Rgba = Rgba { r: 1.0, g: 1.0, b: 1.0, a: 1.0 };
        let clear_white = Rgba { a: 0.0, ..white };
        let black = Rgba { r: 0.0, g: 0.0, b: 0.0, a: 1.0 };
        let clear_black = Rgba { a: 0.0, ..black };

        let square = div()
            .id((id.clone(), "square"))
            .debug_selector(|| "color-picker-square".into())
            .relative()
            .w(px(SV_WIDTH))
            .h(px(SV_HEIGHT))
            .rounded(RADIUS_CHIP)
            .overflow_hidden()
            .cursor_crosshair()
            .bg(hsla(&pure_hue))
            .child(div().absolute().inset_0().bg(linear_gradient(90., linear_color_stop(white, 0.), linear_color_stop(clear_white, 1.))))
            .child(div().absolute().inset_0().bg(linear_gradient(180., linear_color_stop(clear_black, 0.), linear_color_stop(black, 1.))))
            .child(
                canvas(
                    {
                        let origin = square_origin.clone();
                        move |bounds: Bounds<Pixels>, _, _| origin.set((f32::from(bounds.origin.x), f32::from(bounds.origin.y)))
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full(),
            )
            .child(
                div()
                    .absolute()
                    .left(px(s as f32 * SV_WIDTH - KNOB / 2.0))
                    .top(px((1.0 - v as f32) * SV_HEIGHT - KNOB / 2.0))
                    .size(px(KNOB))
                    .rounded_full()
                    .border_2()
                    .border_color(white)
                    .shadow_sm(),
            )
            .on_mouse_down(MouseButton::Left, {
                let (hsv, origin, drag, emit) = (hsv.clone(), square_origin.clone(), drag.clone(), emit.clone());
                move |event: &MouseDownEvent, window, cx| {
                    drag.set(Drag::Square);
                    let (ox, oy) = origin.get();
                    let (s, v) = sv_at(f32::from(event.position.x) - ox, f32::from(event.position.y) - oy);
                    hsv.set((hsv.get().0, s, v));
                    emit(window, cx);
                }
            });

        let stops = [0.0, 60.0, 120.0, 180.0, 240.0, 300.0, 360.0];
        let strip = div()
            .id((id.clone(), "hue"))
            .debug_selector(|| "color-picker-hue".into())
            .relative()
            .w(px(SV_WIDTH))
            .h(px(HUE_HEIGHT))
            .rounded_full()
            .overflow_hidden()
            .cursor_pointer()
            .flex()
            .children(stops.windows(2).map(|w| {
                div().h_full().flex_1().bg(linear_gradient(
                    90.,
                    linear_color_stop(hsla(&hsv_to_hex(w[0], 1.0, 1.0)), 0.),
                    linear_color_stop(hsla(&hsv_to_hex(w[1] % 360.0, 1.0, 1.0)), 1.),
                ))
            }))
            .child(
                canvas(
                    {
                        let origin = hue_origin.clone();
                        move |bounds: Bounds<Pixels>, _, _| origin.set(f32::from(bounds.origin.x))
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full(),
            )
            .child(
                div()
                    .absolute()
                    .top(px((HUE_HEIGHT - KNOB) / 2.0))
                    .left(px(h as f32 / 360.0 * SV_WIDTH - KNOB / 2.0).max(px(0.0)))
                    .size(px(KNOB))
                    .rounded_full()
                    .border_2()
                    .border_color(white)
                    .bg(hsla(&pure_hue))
                    .shadow_sm(),
            )
            .on_mouse_down(MouseButton::Left, {
                let (hsv, origin, drag, emit) = (hsv.clone(), hue_origin.clone(), drag.clone(), emit.clone());
                move |event: &MouseDownEvent, window, cx| {
                    drag.set(Drag::Hue);
                    let hue = hue_at(f32::from(event.position.x) - origin.get());
                    let (_, s, v) = hsv.get();
                    hsv.set((hue, s, v));
                    emit(window, cx);
                }
            });

        div()
            .id((id.clone(), "picker"))
            .debug_selector(|| "color-picker".into())
            .flex()
            .flex_col()
            .gap(px(10.0))
            .p(px(6.0))
            .on_mouse_move({
                let (hsv, sq, hu, drag, emit) = (hsv, square_origin, hue_origin, drag.clone(), emit);
                move |event: &MouseMoveEvent, window, cx| {
                    if !event.dragging() {
                        return;
                    }
                    match drag.get() {
                        Drag::Square => {
                            let (ox, oy) = sq.get();
                            let (s, v) = sv_at(f32::from(event.position.x) - ox, f32::from(event.position.y) - oy);
                            hsv.set((hsv.get().0, s, v));
                            emit(window, cx);
                        }
                        Drag::Hue => {
                            let hue = hue_at(f32::from(event.position.x) - hu.get());
                            let (_, s, v) = hsv.get();
                            hsv.set((hue, s, v));
                            emit(window, cx);
                        }
                        Drag::None => {}
                    }
                }
            })
            .on_mouse_up(MouseButton::Left, {
                let drag = drag.clone();
                move |_: &MouseUpEvent, _, _| drag.set(Drag::None)
            })
            .on_mouse_up_out(MouseButton::Left, move |_: &MouseUpEvent, _, _| drag.set(Drag::None))
            .child(square)
            .child(strip)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(div().size(px(20.0)).rounded(RADIUS_CHIP).border_1().border_color(theme.line_strong).bg(hsla(&current)))
                    .child(div().text_color(theme.ink3).font_family(crate::theme::mono()).text_size(px(12.0)).child(current)),
            )
    }
}

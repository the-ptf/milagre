//! Drawing the Simulator tab: the device list (`SimulatorTrack.tsx`), and the viewer (the receiver page's
//! stage, device frame, control rail and "More" row). Look values that are not theme tokens are the receiver's
//! hardware colours and sizes, named here.

use gpui::{
    AnyElement, App, BoxShadow, ClickEvent, Context, Hsla, ImageSource, IntoElement, KeyDownEvent, KeyUpEvent, MouseButton, MouseDownEvent,
    MouseMoveEvent, MouseUpEvent, ObjectFit, Pixels, Render, RenderImage, Rgba, SharedString, Window, canvas, div, img, point, prelude::*,
    px, rgb, rgba,
};

use std::sync::Arc;

use super::SimulatorView;
use super::geometry::{self, Geometry};
use super::types::{Connection, Device, HardwareButton, KeyPhase, Platform};
use crate::theme::{ActiveTheme, RADIUS_CARD, RADIUS_CHIP, RADIUS_CONTROL, TEXT_11, TEXT_12, TEXT_13, TextStepExt, Theme};
use crate::ui::{
    Button, ButtonSize, ButtonVariant, EmptySize, EmptyState, Icon, IconButton, IconButtonSize, IconName, IconSize, InlineError, Tooltip,
};

// The device frame: hardware colours from the receiver's stylesheet, the same in both themes.
const BEZEL: u32 = 0x060709;
const RIM: u32 = 0x6c7178;
const RIM_BAND: u32 = 0x30343a;
const SIDE_BUTTON: u32 = 0x666b72;
const SCREEN: u32 = 0x08090b;
const SCREEN_TEXT: u32 = 0x9199a4;
/// `0 4px 20px #0002` under the device.
const DEVICE_SHADOW: u32 = 0x00000022;

// The control rail.
const RAIL_WIDTH: f32 = 47.0;
const RAIL_BUTTON: f32 = 35.0;
const RAIL_GLYPH: f32 = 17.0;
/// Below this height the rail moves under the stage, as the receiver's container query does.
const COMPACT_HEIGHT: f32 = 500.0;

/// The rail's glyphs are the receiver's own line icons (its inline SVGs), drawn at 17px with a 1.6 stroke in the
/// colour asked for. GPUI's SVG rasteriser renders at twice the size it is given, so 17 here is 34 pixels.
const GLYPH_RASTER: u32 = 17;
const GLYPH_STROKE: f32 = 1.6;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) enum Glyph {
    Home,
    Back,
    Rotate,
    More,
    Control,
}

impl Glyph {
    #[cfg(test)]
    pub(super) const ALL: [Glyph; 5] = [Glyph::Home, Glyph::Back, Glyph::Rotate, Glyph::More, Glyph::Control];

    /// The shapes inside the receiver's `<svg viewBox="0 0 24 24">`.
    fn shapes(self) -> &'static str {
        match self {
            Glyph::Home => r#"<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z"/>"#,
            Glyph::Back => r#"<path d="m14 5-7 7 7 7"/>"#,
            Glyph::Rotate => {
                r#"<rect x="8" y="5" width="9" height="14" rx="2" transform="rotate(30 12.5 12)"/><path d="M3 10a9 9 0 0 1 14-7M3 5v5h5m13 4a9 9 0 0 1-14 7m14-2v-5h-5"/>"#
            }
            Glyph::More => r#"<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>"#,
            Glyph::Control => {
                r#"<path d="M8 13V6a2 2 0 0 1 4 0v6-2a2 2 0 0 1 4 0v2a2 2 0 0 1 4 0v4c0 4-3 6-6 6h-1c-2 0-3-1-4-2l-5-6a2 2 0 0 1 3-2l1 1Z"/>"#
            }
        }
    }
}

/// `glyph` as a raster in `color`.
pub(super) fn glyph_image(glyph: Glyph, color: Rgba, cx: &App) -> Option<Arc<RenderImage>> {
    let hex =
        format!("#{:02x}{:02x}{:02x}", (color.r * 255.0).round() as u8, (color.g * 255.0).round() as u8, (color.b * 255.0).round() as u8);
    let svg = format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{GLYPH_RASTER}" height="{GLYPH_RASTER}" viewBox="0 0 24 24" fill="none" stroke="{hex}" stroke-opacity="{}" stroke-width="{GLYPH_STROKE}" stroke-linecap="round" stroke-linejoin="round">{}</svg>"#,
        color.a,
        glyph.shapes()
    );
    cx.svg_renderer().render_single_frame(svg.as_bytes(), 1.0).ok()
}

impl Render for SimulatorView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.renders += 1;
        if self.hidden_paused {
            // Shown again after a pause while hidden: reconnect, as the receiver does when the page is visible.
            self.hidden_paused = false;
            cx.defer_in(window, |this, _, cx| this.start(cx));
        }
        let theme = *cx.theme();
        let body: AnyElement = if self.selected.is_some() { self.viewer(&theme, cx) } else { self.device_list(&theme, cx) };
        div()
            .id("simulator-panel")
            .debug_selector(|| "panel-body-Simulator".to_string())
            .size_full()
            .flex()
            .flex_col()
            .bg(theme.surface)
            .text_color(theme.ink)
            .child(body)
    }
}

impl SimulatorView {
    /// A rail glyph in `color`, rasterised once per colour.
    fn glyph(&self, glyph: Glyph, color: Rgba, cx: &App) -> Option<Arc<RenderImage>> {
        let key = (glyph, colour_key(color));
        if let Some(image) = self.glyphs.borrow().get(&key) {
            return Some(image.clone());
        }
        let image = glyph_image(glyph, color, cx)?;
        self.glyphs.borrow_mut().insert(key, image.clone());
        Some(image)
    }

    // ---------------------------------------------------------------------------------------------------------
    // Device list

    fn device_list(&self, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let attaching = self.attaching;
        let lead: AnyElement = if attaching {
            IconButton::new("simulator-list-back", IconName::ArrowLeft01)
                .size(IconButtonSize::S24)
                .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.set_attaching(false, cx)))
                .into_any_element()
        } else {
            Icon::new(IconName::Smartphone).size(IconSize::S16).color(theme.ink2).into_any_element()
        };
        let header = div().flex().flex_none().items_center().gap_2().px_3().py_2().border_b_1().border_color(theme.line).child(lead).child(
            div()
                .flex_1()
                .min_w_0()
                .child(div().truncate().text_step(TEXT_13).child(if attaching { "Attach simulator" } else { "Simulators" }))
                .child(div().text_step(TEXT_11).text_color(theme.ink3).child(if attaching {
                    "Other devices on this computer"
                } else {
                    "This Chat"
                })),
        );
        let devices = if attaching { &self.list.available } else { &self.list.attached };
        let empty = !self.loading && self.list_error.is_none() && devices.is_empty();
        let rows: Vec<AnyElement> = devices.iter().enumerate().map(|(ix, device)| self.device_row(ix, device, theme, cx)).collect();
        let attach_row = (!attaching).then(|| {
            div()
                .id("simulator-attach")
                .debug_selector(|| "simulator-attach".to_string())
                .flex()
                .items_center()
                .h(px(32.0))
                .px_3()
                .rounded(RADIUS_CONTROL)
                .text_step(TEXT_13)
                .text_color(theme.ink2)
                .cursor_pointer()
                .hover(|s| s.bg(theme.hover2).text_color(theme.ink))
                .child("Attach simulator")
                .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.set_attaching(true, cx)))
        });
        div()
            .flex()
            .flex_col()
            .size_full()
            .child(header)
            .child(
                div()
                    .id("simulator-list")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .p_1()
                    .when(self.loading, |el| el.child(EmptyState::new().size(EmptySize::Compact).title("Finding running simulators…")))
                    .children(self.list_error.clone().map(|error| div().p_3().child(InlineError::new(error).small())))
                    .when(empty, |el| {
                        el.child(EmptyState::new().size(EmptySize::Compact).title(if attaching {
                            "No other devices are running on this computer"
                        } else {
                            "No simulators attached to this Chat"
                        }))
                    })
                    .children(rows)
                    .children(attach_row),
            )
            .into_any_element()
    }

    fn device_row(&self, ix: usize, device: &Device, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let attaching = self.attaching;
        let running = attaching || self.list.is_running(&device.id);
        let enabled = running && !self.busy;
        let line = if running { device.os_line() } else { "Stopped".to_string() };
        let pick = device.clone();
        let detach = device.clone();
        let row = div()
            .id(("simulator-device", ix))
            .debug_selector(move || format!("simulator-device-{ix}"))
            .flex()
            .flex_1()
            .min_w_0()
            .items_center()
            .gap_2()
            .h(px(32.0))
            .px_3()
            .rounded(RADIUS_CONTROL)
            .when(!enabled, |el| el.opacity(0.6))
            .when(enabled, |el| {
                el.cursor_pointer().hover(|s| s.bg(theme.hover2)).on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                    if this.attaching { this.attach(pick.clone(), cx) } else { this.select(pick.clone(), cx) }
                }))
            })
            .child(Icon::new(IconName::Smartphone).size(IconSize::S16).color(theme.ink2))
            .child(div().flex_1().min_w_0().truncate().text_step(TEXT_13).child(device.name.clone()))
            .child(div().flex_none().text_step(TEXT_11).text_color(theme.ink3).child(line));
        div()
            .flex()
            .items_center()
            .child(row)
            .when(!attaching, |el| {
                el.child(
                    div()
                        .id(("simulator-detach", ix))
                        .debug_selector(move || format!("simulator-detach-{ix}"))
                        .p_2()
                        .rounded(RADIUS_CONTROL)
                        .cursor_pointer()
                        .hover(|s| s.bg(theme.hover))
                        .tooltip(Tooltip::text("Detach from Chat"))
                        .child(Icon::new(IconName::Cancel01).size(IconSize::S14).color(theme.ink3))
                        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.detach(detach.clone(), cx))),
                )
            })
            .into_any_element()
    }

    // ---------------------------------------------------------------------------------------------------------
    // Viewer

    fn viewer(&self, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let compact = self.viewer_height > Pixels::ZERO && self.viewer_height <= px(COMPACT_HEIGHT);
        let entity = cx.entity().downgrade();
        // Measures the stage and marks the frame painted; the stage lays out from the size it had last frame.
        let measure = canvas(
            move |bounds, _, cx| {
                if let Some(view) = entity.upgrade() {
                    view.update(cx, |view, cx| {
                        let viewer = view.viewer_height;
                        view.painted(bounds, viewer, cx);
                    });
                }
            },
            |_, _, _, _| {},
        )
        .absolute()
        .size_full();
        let entity = cx.entity().downgrade();
        let measure_viewer = canvas(
            move |bounds, _, cx| {
                if let Some(view) = entity.upgrade() {
                    view.update(cx, |view, cx| {
                        let stage = view.stage;
                        view.painted(stage, bounds.size.height, cx);
                    });
                }
            },
            |_, _, _, _| {},
        )
        .absolute()
        .size_full();
        let stage = self.stage(theme, cx).child(measure);
        div()
            .flex()
            .flex_col()
            .size_full()
            .child(self.viewer_header(theme, cx))
            .child(
                div().relative().flex().flex_1().min_h_0().child(measure_viewer).child(
                    div()
                        .flex()
                        .flex_1()
                        .min_w_0()
                        .min_h_0()
                        .gap_2()
                        .when(compact, |el| el.flex_col())
                        .when(!compact, |el| el.pr_3())
                        .child(stage)
                        .child(self.rail(compact, theme, cx)),
                ),
            )
            .when(self.extras_open, |el| el.child(self.extras(theme, cx)))
            .into_any_element()
    }

    fn viewer_header(&self, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let Some(device) = &self.selected else { return div().into_any_element() };
        let connection = self.connection();
        let dot = match connection {
            Connection::Live => theme.green,
            Connection::Error => theme.red,
            _ => theme.ink4,
        };
        let mut line = device.os_line();
        if device.is_simlock() {
            line.push_str(" · Leased from Simlock");
        }
        div()
            .flex()
            .flex_none()
            .items_center()
            .justify_between()
            .gap_3()
            .px_4()
            .pt_4()
            .pb_1()
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(
                        div()
                            .id("simulator-device-name")
                            .debug_selector(|| "simulator-device-name".to_string())
                            .flex()
                            .max_w_full()
                            .items_center()
                            .gap_1()
                            .ml(px(-4.0))
                            .px_1()
                            .rounded(RADIUS_CHIP)
                            .text_step(TEXT_13)
                            .font_weight(gpui::FontWeight::MEDIUM)
                            .cursor_pointer()
                            .hover(|s| s.bg(theme.hover))
                            .tooltip(Tooltip::text("Choose simulator"))
                            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.show_list(cx)))
                            .child(div().truncate().child(device.name.clone()))
                            .child(Icon::new(IconName::ArrowDown01).size(IconSize::S14).color(theme.ink3)),
                    )
                    .child(div().mt_1().text_step(TEXT_11).text_color(theme.ink3).child(line)),
            )
            .child(
                div()
                    .debug_selector(|| "simulator-connection".to_string())
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap(px(6.0))
                    .text_step(TEXT_11)
                    .text_color(theme.ink2)
                    .child(div().size(px(6.0)).rounded_full().bg(dot))
                    .child(connection.label()),
            )
            .into_any_element()
    }

    /// The touch screen: the device frame letterboxed with the receiver's geometry, the picture inside it, and
    /// the failure card over it. Presses map to touches; keys go to the device while it has focus.
    fn stage(&self, theme: &Theme, cx: &mut Context<Self>) -> gpui::Stateful<gpui::Div> {
        let geometry = self.geometry();
        let device = self.selected.clone();
        let mut stage = div()
            .id("simulator-stage")
            .debug_selector(|| "simulator-stage".to_string())
            .track_focus(&self.focus)
            .relative()
            .flex_1()
            .min_w_0()
            .min_h_0()
            .overflow_hidden()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, event: &MouseDownEvent, window, cx| {
                    window.focus(&this.focus, cx);
                    if this.touch_down(event.position, cx) {
                        cx.stop_propagation();
                    }
                }),
            )
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                let keystroke = &event.keystroke;
                if keystroke.key == "escape" && this.extras_open {
                    this.extras_open = false;
                    cx.notify();
                    return cx.stop_propagation();
                }
                if keystroke.modifiers.platform || keystroke.modifiers.control {
                    return;
                }
                if this.key(&keystroke.key, KeyPhase::Down, keystroke.modifiers.shift, cx) {
                    cx.stop_propagation();
                }
            }))
            .on_key_up(cx.listener(|this, event: &KeyUpEvent, _, cx| {
                let keystroke = &event.keystroke;
                if !(keystroke.modifiers.platform || keystroke.modifiers.control)
                    && this.key(&keystroke.key, KeyPhase::Up, keystroke.modifiers.shift, cx)
                {
                    cx.stop_propagation();
                }
            }));
        // A drag keeps reporting outside the stage (pointer capture in the receiver): window-level listeners while it lasts.
        if self.touch.is_some() {
            let entity = cx.entity().downgrade();
            stage = stage.child(
                canvas(
                    |_, _, _| (),
                    move |_, _, window, _| {
                        let moved = entity.clone();
                        window.on_mouse_event(move |event: &MouseMoveEvent, phase, _, cx| {
                            if phase.bubble()
                                && let Some(view) = moved.upgrade()
                            {
                                view.update(cx, |view, cx| view.touch_move(event.position, cx));
                            }
                        });
                        let released = entity.clone();
                        window.on_mouse_event(move |event: &MouseUpEvent, phase, _, cx| {
                            if phase.bubble()
                                && event.button == MouseButton::Left
                                && let Some(view) = released.upgrade()
                            {
                                view.update(cx, |view, cx| view.touch_up(cx));
                            }
                        });
                    },
                )
                .absolute()
                .size_0(),
            );
        }
        if let (Some(geometry), Some(device)) = (geometry, device) {
            stage = stage.child(self.device_frame(&geometry, &device));
        }
        if let Some(error) = &self.error {
            stage = stage.child(failure_card(error.clone(), theme));
        } else if self.is_offline() {
            stage = stage.child(
                div().absolute().inset_0().flex().items_center().justify_center().child(
                    EmptyState::new()
                        .size(EmptySize::Compact)
                        .icon(IconName::Smartphone)
                        .title("Simulator stopped")
                        .help("Start it on this computer and it reconnects."),
                ),
            );
        }
        stage
    }

    fn device_frame(&self, g: &Geometry, device: &Device) -> AnyElement {
        let (bezel, radius) = geometry::bezel_and_radius(g, device);
        let sideways = g.width > g.height;
        let (outer_w, outer_h) = (g.width + bezel * 2.0, g.height + bezel * 2.0);
        let ring = |spread: f32, color: u32| BoxShadow {
            color: Hsla::from(rgb(color)),
            offset: point(px(0.0), px(0.0)),
            blur_radius: px(0.0),
            spread_radius: px(spread),
            inset: true,
        };
        let shadows = vec![
            ring(1.0, RIM),
            ring(3.0, RIM_BAND),
            BoxShadow {
                color: Hsla::from(rgb(0x000000)),
                offset: point(px(0.0), px(0.0)),
                blur_radius: px(0.0),
                spread_radius: px(1.0),
                inset: false,
            },
            BoxShadow {
                color: Hsla::from(rgba(DEVICE_SHADOW)),
                offset: point(px(0.0), px(4.0)),
                blur_radius: px(20.0),
                spread_radius: px(0.0),
                inset: false,
            },
        ];
        // The side buttons: a power key and a volume rocker, 2px proud of the frame.
        let side = |left: f32, top: f32, w: f32, h: f32| {
            div().absolute().left(px(left)).top(px(top)).w(px(w)).h(px(h)).rounded(px(2.0)).bg(rgb(SIDE_BUTTON))
        };
        let buttons = if sideways {
            [side(outer_w * 0.24, -2.0, outer_w * 0.12, 3.0), side(outer_w * 0.29, outer_h - 1.0, outer_w * 0.15, 3.0)]
        } else {
            [side(-2.0, outer_h * 0.24, 3.0, outer_h * 0.12), side(outer_w - 1.0, outer_h * 0.29, 3.0, outer_h * 0.15)]
        };
        let screen = match &self.picture {
            Some(picture) if self.frames => img(ImageSource::Render(picture.image.clone()))
                .debug_selector(|| "simulator-picture".to_string())
                .size_full()
                .rounded(px(radius))
                .object_fit(ObjectFit::Fill)
                .into_any_element(),
            _ if self.active => div()
                .size_full()
                .flex()
                .items_center()
                .justify_center()
                .p_6()
                .text_step(TEXT_12)
                .text_color(rgb(SCREEN_TEXT))
                .child("Connecting...")
                .into_any_element(),
            _ => div().into_any_element(),
        };
        div()
            .debug_selector(|| "simulator-device".to_string())
            .absolute()
            .left(px(g.left - bezel))
            .top(px(g.top - bezel))
            .w(px(outer_w))
            .h(px(outer_h))
            .rounded(px(radius + bezel))
            .bg(rgb(BEZEL))
            .shadow(shadows)
            .children(buttons)
            .child(
                div()
                    .debug_selector(|| "simulator-screen".to_string())
                    .absolute()
                    .left(px(bezel))
                    .top(px(bezel))
                    .w(px(g.width))
                    .h(px(g.height))
                    .rounded(px(radius))
                    .bg(rgb(SCREEN))
                    .overflow_hidden()
                    .child(screen),
            )
            .into_any_element()
    }

    /// Home, Back (Android), Rotate, More and Take control, in a pill: a column beside the stage, a row under it
    /// when the viewer is short.
    fn rail(&self, compact: bool, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let controllable = self.controllable();
        let ready = self.display_ready() && !self.repairing;
        let controlling = self.status.as_ref().is_some_and(|s| s.controlling);
        let android = self.selected.as_ref().is_some_and(|d| d.platform == Platform::Android);
        let mut nav = div()
            .flex()
            .items_center()
            .justify_center()
            .gap(px(3.0))
            .px(px(5.0))
            .py(px(3.0))
            .border_1()
            .border_color(theme.line)
            .rounded_full()
            .bg(mix(theme.hover, theme.surface))
            .when(!compact, |el| el.flex_col())
            .child(rail_button(
                "simulator-home",
                "Home",
                self.glyph(Glyph::Home, theme.ink2, cx),
                self.glyph(Glyph::Home, theme.ink, cx),
                !controllable,
                false,
                theme,
                cx.listener(|this, _, _, cx| this.press(HardwareButton::Home, cx)),
            ));
        if android {
            nav = nav.child(rail_button(
                "simulator-back",
                "Back",
                self.glyph(Glyph::Back, theme.ink2, cx),
                self.glyph(Glyph::Back, theme.ink, cx),
                !controllable,
                false,
                theme,
                cx.listener(|this, _, _, cx| this.press(HardwareButton::Back, cx)),
            ));
        }
        nav = nav
            .child(rail_button(
                "simulator-rotate",
                "Rotate",
                self.glyph(Glyph::Rotate, theme.ink2, cx),
                self.glyph(Glyph::Rotate, theme.ink, cx),
                !controllable,
                false,
                theme,
                cx.listener(|this, _, _, cx| this.rotate(cx)),
            ))
            .child(rail_button(
                "simulator-more",
                "More controls",
                self.glyph(Glyph::More, if self.extras_open { theme.accent } else { theme.ink2 }, cx),
                self.glyph(Glyph::More, if self.extras_open { theme.accent } else { theme.ink }, cx),
                false,
                self.extras_open,
                theme,
                cx.listener(|this, _, _, cx| this.toggle_extras(cx)),
            ));
        if ready && !controlling {
            nav = nav.child(rail_button(
                "simulator-control",
                "Take control",
                self.glyph(Glyph::Control, theme.ink2, cx),
                self.glyph(Glyph::Control, theme.ink, cx),
                self.claiming,
                false,
                theme,
                cx.listener(|this, _, _, cx| this.claim(true, cx)),
            ));
        }
        div()
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .when(compact, |el| el.px_3().pb_2())
            .when(!compact, |el| el.flex_col().w(px(RAIL_WIDTH)).py_3())
            .child(nav)
            .into_any_element()
    }

    /// The "More" row: Reconnect, Reset input (iOS), Pause or Resume, Copy screenshot and Detach.
    fn extras(&self, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let controllable = self.controllable();
        let ios = self.selected.as_ref().is_some_and(|d| d.platform == Platform::Ios);
        let paused = !self.active;
        let repair_label = if self.repairing {
            "Restarting..."
        } else if self.confirm_repair {
            "Restart"
        } else {
            "Reset input"
        };
        let hint = if self.confirm_repair || self.repairing {
            Some("Resetting input restarts the simulator's home screen and closes its apps.")
        } else if controllable && self.status.as_ref().is_some_and(|s| s.input_hint) {
            Some("If touches don't respond, reset input.")
        } else {
            None
        };
        let detach = self.selected.clone();
        let button = |id: &'static str, label: &'static str, icon: Option<IconName>| {
            let button = Button::new(id, label).selector(id).variant(ButtonVariant::Secondary).size(ButtonSize::S32);
            match icon {
                Some(icon) => button.icon(icon),
                None => button,
            }
        };
        div()
            .debug_selector(|| "simulator-extras".to_string())
            .flex_none()
            .px_4()
            .pt_2()
            .pb_3()
            .border_t_1()
            .border_color(theme.line)
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .justify_center()
                    .gap_2()
                    .child(
                        button("simulator-reconnect", if self.error.is_some() { "Retry" } else { "Reconnect" }, Some(IconName::Refresh01))
                            .disabled(self.active && (!self.frames || self.rotating_generation.is_some()))
                            .on_click(cx.listener(|this, _, _, cx| this.reconnect(cx))),
                    )
                    .when(ios, |el| {
                        el.child(
                            button("simulator-repair", repair_label, None)
                                .disabled(!controllable || self.repairing)
                                .on_click(cx.listener(|this, _, _, cx| this.repair(cx))),
                        )
                    })
                    .child(
                        button(
                            "simulator-pause",
                            if paused { "Resume" } else { "Pause" },
                            Some(if paused { IconName::Play } else { IconName::Pause }),
                        )
                        .disabled(self.is_offline())
                        .on_click(cx.listener(|this, _, _, cx| this.toggle_pause(cx))),
                    )
                    .child(
                        button(
                            "simulator-screenshot",
                            if self.copied { "Copied" } else { "Copy screenshot" },
                            Some(if self.copied { IconName::Tick02 } else { IconName::Copy01 }),
                        )
                        .disabled(self.last_frame.is_none() || !self.frames)
                        .on_click(cx.listener(|this, _, _, cx| this.copy_screenshot(cx))),
                    )
                    .child(button("simulator-detach", "Detach", Some(IconName::Unlink04)).disabled(self.busy).on_click(cx.listener(
                        move |this, _, _, cx| {
                            if let Some(device) = detach.clone() {
                                this.detach(device, cx);
                            }
                        },
                    ))),
            )
            .children(hint.map(|hint| div().pt_2().text_step(TEXT_12).text_color(theme.ink2).text_center().child(hint)))
            .into_any_element()
    }
}

#[allow(clippy::too_many_arguments)]
fn rail_button(
    id: &'static str,
    label: &'static str,
    glyph: Option<Arc<RenderImage>>,
    hover_glyph: Option<Arc<RenderImage>>,
    disabled: bool,
    pressed: bool,
    theme: &Theme,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> AnyElement {
    // The glyph goes `ink` while the button is hovered: a second image in `ink`, swapped in by the button's group.
    let group: SharedString = format!("{id}-glyph").into();
    let icon = glyph.map(|image| {
        img(ImageSource::Render(image)).absolute().flex_none().size(px(RAIL_GLYPH)).group_hover(group.clone(), |s| s.opacity(0.0))
    });
    let hovered = hover_glyph.map(|image| {
        img(ImageSource::Render(image))
            .absolute()
            .flex_none()
            .size(px(RAIL_GLYPH))
            .opacity(0.0)
            .group_hover(group.clone(), |s| s.opacity(1.0))
    });
    let hover = theme.hover;
    div()
        .id(id)
        .group(group)
        .relative()
        .debug_selector(move || id.to_string())
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(px(RAIL_BUTTON))
        .rounded_full()
        .when(pressed, |el| el.bg(hover))
        .when(disabled, |el| el.opacity(0.3))
        .when(!disabled, |el| el.cursor_pointer().hover(move |s| s.bg(hover)).on_click(on_click))
        .tooltip(Tooltip::text(label))
        .child(div().relative().flex_none().size(px(RAIL_GLYPH)).children(icon).children(hovered))
        .into_any_element()
}

/// The receiver's `#failure`: a card across the stage's middle with the reason.
fn failure_card(message: SharedString, theme: &Theme) -> AnyElement {
    div()
        .absolute()
        .inset_0()
        .flex()
        .items_center()
        .px_6()
        .child(
            div()
                .debug_selector(|| "simulator-failure".to_string())
                .w_full()
                .p_4()
                .border_1()
                .border_color(theme.line)
                .rounded(RADIUS_CARD)
                .bg(theme.surface)
                .text_step(TEXT_12)
                .text_center()
                .child(message),
        )
        .into_any_element()
}

/// `color-mix(in srgb, hover 50%, surface)`: the rail pill's fill (premultiplied, as CSS mixes).
fn mix(a: Rgba, b: Rgba) -> Rgba {
    let alpha = (a.a + b.a) / 2.0;
    if alpha == 0.0 {
        return Rgba { r: 0.0, g: 0.0, b: 0.0, a: 0.0 };
    }
    let channel = |x: f32, y: f32| (x * a.a + y * b.a) / 2.0 / alpha;
    Rgba { r: channel(a.r, b.r), g: channel(a.g, b.g), b: channel(a.b, b.b), a: alpha }
}

/// A hashable key for a colour.
fn colour_key(color: Rgba) -> u32 {
    let byte = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u32;
    byte(color.r) << 24 | byte(color.g) << 16 | byte(color.b) << 8 | byte(color.a)
}

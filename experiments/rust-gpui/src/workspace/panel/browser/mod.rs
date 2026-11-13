//! The Browser tab, as a spike (WP-35 exploration, `BROWSER-EXPLORATION.md`): a page drawn from CDP screencast
//! frames, with clicks, drags, the wheel and typing sent back as input events. Shown only with
//! `MILAGRE_GPUI_BROWSER_SPIKE=1`; nothing here runs otherwise.
//!
//! The view talks only to a [`BrowserBridge`], the daemon's existing streamed-viewer API (`browser:open`, `frame`,
//! `status`, `input`, `close`). The spike answers it from its own headless Chromium (`spike.rs`); production answers
//! it from the shared daemon client, which owns every browser.
//!
//! - **Frames.** One `frame(after)` call in flight; each answer decodes on the background executor (JPEG to BGRA),
//!   replaces the picture, and the next call goes out. The bridge keeps only the newest frame, so a slow decode
//!   drops frames instead of queueing them. Replaced pictures leave GPUI's atlas once the new one has painted.
//! - **Geometry.** The page lays out at the stage's size in CSS pixels (GPUI's logical pixels are CSS pixels) and
//!   the window's scale, so text is as sharp as the window's own. The picture sits at the stage's top left; input
//!   points are fractions of the picture, as the wire's are.
//! - **Numbers.** An overlay shows frames received and painted per second, the decode time and the time from an
//!   input to the paint of the first frame captured after it.

pub mod bridge;
pub mod keys;
pub mod spike;

#[cfg(test)]
mod tests;

use std::collections::VecDeque;
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui::{
    AnyElement, Bounds, Context, FocusHandle, Focusable, KeyDownEvent, KeyUpEvent, MouseButton, MouseDownEvent, MouseMoveEvent,
    MouseUpEvent, Pixels, RenderImage, ScrollEvent, SharedString, Task, Window, canvas, div, img, prelude::*, px,
};

use self::bridge::{BrowserBridge, BrowserFrame, BrowserInput, BrowserStatus, Button, Navigate, Phase};
use crate::theme::{ActiveTheme, CONTROL_SM, RADIUS_CONTROL, TEXT_11, TEXT_12, TextStepExt, mono};
use crate::ui::{IconButton, IconButtonSize, IconName};

/// Whether the spike is on (`MILAGRE_GPUI_BROWSER_SPIKE=1`); never in tests.
pub fn spike_enabled() -> bool {
    !cfg!(test) && std::env::var("MILAGRE_GPUI_BROWSER_SPIKE").is_ok_and(|value| value == "1")
}

/// How long a snapshot waits for the browser and its first frames.
const SNAPSHOT_WAIT: Duration = Duration::from_secs(10);
/// The window over which rates are counted.
const RATE_WINDOW: Duration = Duration::from_secs(1);
/// Latency samples kept for the median.
const SAMPLES: usize = 64;

/// What the overlay shows, kept as the frames come.
#[derive(Default)]
pub struct Stats {
    received: VecDeque<Instant>,
    painted: VecDeque<Instant>,
    /// Exponential average of the JPEG decode, in milliseconds.
    pub decode_ms: f32,
    /// The input waiting for its frame: when it was sent.
    input_at: Option<Instant>,
    /// The frame that answers it, once shown and not yet painted.
    answer: Option<u64>,
    pub latencies: VecDeque<f32>,
}

impl Stats {
    fn rate(times: &mut VecDeque<Instant>, now: Instant) -> usize {
        while times.front().is_some_and(|at| now.duration_since(*at) > RATE_WINDOW) {
            times.pop_front();
        }
        times.len()
    }

    /// The median input-to-paint latency in milliseconds.
    pub fn median_latency(&self) -> Option<f32> {
        let mut sorted: Vec<f32> = self.latencies.iter().copied().collect();
        sorted.sort_by(f32::total_cmp);
        sorted.get(sorted.len() / 2).copied()
    }
}

pub struct BrowserView {
    bridge: Rc<dyn BrowserBridge>,
    url: String,
    viewer: Option<String>,
    started: bool,
    picture: Option<(u64, Arc<RenderImage>)>,
    /// The sequence of the picture last painted, to count new pictures on screen.
    painted_sequence: u64,
    stale: Vec<Arc<RenderImage>>,
    /// The newest frame's sequence and its page size in CSS pixels.
    after: u64,
    viewport: (u32, u32),
    status: BrowserStatus,
    error: Option<SharedString>,
    /// The stage's bounds when it last painted.
    stage: Bounds<Pixels>,
    sent_viewport: Option<(u32, u32, f32)>,
    input_sequence: u64,
    focus: FocusHandle,
    stats: Stats,
    pull: Option<Task<()>>,
    status_poll: Option<Task<()>>,
}

impl BrowserView {
    pub fn new(cx: &mut Context<Self>) -> Self {
        Self::with_bridge(Rc::new(spike::CdpSpike::default()), spike::start_url(), cx)
    }

    pub fn with_bridge(bridge: Rc<dyn BrowserBridge>, url: String, cx: &mut Context<Self>) -> Self {
        // Quitting drops nothing: close the viewer so the spike's browser and its profile go with the app.
        cx.on_app_quit(|this: &mut Self, _| {
            let closed = this.viewer.take().map(|viewer| this.bridge.close(&viewer));
            async move {
                if let Some(closed) = closed {
                    let _ = closed.await;
                }
            }
        })
        .detach();
        Self {
            bridge,
            url,
            viewer: None,
            started: false,
            picture: None,
            painted_sequence: 0,
            stale: vec![],
            after: 0,
            viewport: (0, 0),
            status: BrowserStatus::default(),
            error: None,
            stage: Bounds::default(),
            sent_viewport: None,
            input_sequence: 0,
            focus: cx.focus_handle(),
            stats: Stats::default(),
            pull: None,
            status_poll: None,
        }
    }

    pub fn stats(&self) -> &Stats {
        &self.stats
    }

    fn snapshot_mode() -> bool {
        std::env::var_os("MILAGRE_GPUI_SNAPSHOT").is_some()
    }

    /// Opens the viewer the first time the tab shows. A snapshot waits for the first frame here, before the window
    /// draws; the app does not.
    pub fn ensure_started(&mut self, cx: &mut Context<Self>) {
        if self.started {
            return;
        }
        self.started = true;
        let open = self.bridge.open("spike", &self.url);
        if Self::snapshot_mode() {
            match spike::block_on(open, SNAPSHOT_WAIT) {
                Ok(opened) => self.viewer = Some(opened.viewer),
                Err(error) => return self.fail(error, cx),
            }
            if let Some(viewer) = self.viewer.clone()
                && let Ok(Some(frame)) = spike::block_on(self.bridge.frame(&viewer, 0), SNAPSHOT_WAIT)
            {
                let started = Instant::now();
                let decoded = decode(&frame.jpeg);
                self.show(frame, decoded, started.elapsed(), cx);
            }
            return;
        }
        self.pull = Some(cx.spawn(async move |this, cx| {
            let opened = open.await;
            this.update(cx, |this, cx| match opened {
                Ok(opened) => {
                    this.viewer = Some(opened.viewer);
                    this.request_frame(cx);
                    this.poll_status(cx);
                }
                Err(error) => this.fail(error, cx),
            })
            .ok();
        }));
    }

    fn fail(&mut self, error: anyhow::Error, cx: &mut Context<Self>) {
        self.error = Some(format!("{error:#}").into());
        cx.notify();
    }

    fn request_frame(&mut self, cx: &mut Context<Self>) {
        let Some(viewer) = self.viewer.clone() else { return };
        let next = self.bridge.frame(&viewer, self.after);
        self.pull = Some(cx.spawn(async move |this, cx| {
            let frame = next.await;
            this.update(cx, |this, cx| match frame {
                Ok(Some(frame)) => this.decode_later(frame, cx),
                Ok(None) => this.request_frame(cx),
                Err(error) => this.fail(error, cx),
            })
            .ok();
        }));
    }

    fn decode_later(&mut self, frame: BrowserFrame, cx: &mut Context<Self>) {
        let jpeg = frame.jpeg.clone();
        let decoded = cx.background_executor().spawn(async move {
            let started = Instant::now();
            let image = decode(&jpeg);
            (image, started.elapsed())
        });
        self.pull = Some(cx.spawn(async move |this, cx| {
            let (image, took) = decoded.await;
            this.update(cx, |this, cx| {
                this.show(frame, image, took, cx);
                this.request_frame(cx);
            })
            .ok();
        }));
    }

    fn show(&mut self, frame: BrowserFrame, image: anyhow::Result<Arc<RenderImage>>, took: Duration, cx: &mut Context<Self>) {
        let image = match image {
            Ok(image) => image,
            Err(error) => return self.fail(error, cx),
        };
        let ms = took.as_secs_f32() * 1000.0;
        self.stats.decode_ms = if self.stats.decode_ms == 0.0 { ms } else { self.stats.decode_ms * 0.9 + ms * 0.1 };
        self.stats.received.push_back(frame.received);
        if self.stats.input_at.is_some_and(|at| frame.received > at) && self.stats.answer.is_none() {
            self.stats.answer = Some(frame.sequence);
        }
        if let Some((_, old)) = self.picture.replace((frame.sequence, image)) {
            self.stale.push(old);
        }
        self.after = frame.sequence;
        self.viewport = frame.viewport;
        cx.notify();
    }

    /// Reads the title, address and history every half second while the tab is open.
    fn poll_status(&mut self, cx: &mut Context<Self>) {
        let Some(viewer) = self.viewer.clone() else { return };
        let bridge = self.bridge.clone();
        self.status_poll = Some(cx.spawn(async move |this, cx| {
            loop {
                let status = bridge.status(&viewer).await;
                let alive = this
                    .update(cx, |this, cx| {
                        if let Ok(status) = status
                            && status != this.status
                        {
                            this.status = status;
                            cx.notify();
                        }
                    })
                    .is_ok();
                if !alive {
                    break;
                }
                cx.background_executor().timer(Duration::from_millis(500)).await;
            }
        }));
    }

    /// The stage painted at `bounds`: drop replaced pictures, record latency, and lay the page out at the new size.
    fn painted(&mut self, bounds: Bounds<Pixels>, scale: f32, cx: &mut Context<Self>) {
        let now = Instant::now();
        for image in std::mem::take(&mut self.stale) {
            cx.drop_image(image, None);
        }
        if let Some((sequence, _)) = &self.picture {
            if self.painted_sequence != *sequence {
                self.painted_sequence = *sequence;
                self.stats.painted.push_back(now);
            }
            if self.stats.answer == Some(*sequence)
                && let Some(at) = self.stats.input_at.take()
            {
                self.stats.answer = None;
                if self.stats.latencies.len() == SAMPLES {
                    self.stats.latencies.pop_front();
                }
                self.stats.latencies.push_back(now.duration_since(at).as_secs_f32() * 1000.0);
            }
        }
        self.stage = bounds;
        let size = (f32::from(bounds.size.width).round() as u32, f32::from(bounds.size.height).round() as u32, scale);
        if size.0 > 0 && size.1 > 0 && self.sent_viewport != Some(size) && self.viewer.is_some() {
            self.sent_viewport = Some(size);
            self.send(BrowserInput::Viewport { width: size.0, height: size.1, scale }, cx);
            if Self::snapshot_mode() {
                self.wait_for_resized_frame(size, cx);
            }
        }
    }

    /// A snapshot pulls no frames in the background: after the page takes the stage's size, wait for its frame.
    fn wait_for_resized_frame(&mut self, size: (u32, u32, f32), cx: &mut Context<Self>) {
        let Some(viewer) = self.viewer.clone() else { return };
        let deadline = Instant::now() + SNAPSHOT_WAIT;
        while Instant::now() < deadline {
            let Ok(Some(frame)) = spike::block_on(self.bridge.frame(&viewer, self.after), Duration::from_secs(2)) else { break };
            let matches = frame.viewport == (size.0, size.1);
            let started = Instant::now();
            let decoded = decode(&frame.jpeg);
            self.show(frame, decoded, started.elapsed(), cx);
            if matches {
                break;
            }
        }
        if let Ok(status) = spike::block_on(self.bridge.status(&viewer), Duration::from_secs(2)) {
            self.status = status;
        }
    }

    fn send(&mut self, event: BrowserInput, cx: &mut Context<Self>) {
        let Some(viewer) = self.viewer.clone() else { return };
        if !matches!(event, BrowserInput::Viewport { .. } | BrowserInput::Mouse { phase: Phase::Move, .. }) {
            self.stats.input_at = Some(Instant::now());
            self.stats.answer = None;
        }
        self.input_sequence += 1;
        let sent = self.bridge.input(&viewer, self.input_sequence, self.status.generation, event);
        cx.spawn(async move |_, _| {
            let _ = sent.await;
        })
        .detach();
    }

    /// `position` as a fraction of the picture, or `None` outside it.
    fn fraction(&self, position: gpui::Point<Pixels>) -> Option<(f32, f32)> {
        let rect = picture_rect(self.stage, self.viewport)?;
        let x = f32::from(position.x - rect.origin.x) / f32::from(rect.size.width);
        let y = f32::from(position.y - rect.origin.y) / f32::from(rect.size.height);
        ((0.0..=1.0).contains(&x) && (0.0..=1.0).contains(&y)).then_some((x, y))
    }

    fn mouse(
        &mut self,
        phase: Phase,
        position: gpui::Point<Pixels>,
        button: Button,
        clicks: usize,
        modifiers: u32,
        cx: &mut Context<Self>,
    ) {
        if let Some((x, y)) = self.fraction(position) {
            self.send(BrowserInput::Mouse { phase, x, y, button, click_count: clicks as u32, modifiers }, cx);
        }
    }

    fn toolbar(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let nav = |id: &'static str, icon: IconName, enabled: bool, action: Navigate, cx: &mut Context<Self>| {
            let entity = cx.entity().downgrade();
            IconButton::new(id, icon).size(IconButtonSize::S24).disabled(!enabled).on_click(move |_, _, cx| {
                entity.update(cx, |view, cx| view.send(BrowserInput::Navigate(action), cx)).ok();
            })
        };
        let address: SharedString = if self.status.url.starts_with("data:") {
            "Spike test page".into()
        } else if self.status.url.is_empty() {
            self.url.clone().into()
        } else {
            self.status.url.clone().into()
        };
        div()
            .flex()
            .flex_none()
            .items_center()
            .gap_1()
            .px_2()
            .h(px(40.0))
            .child(nav("browser-back", IconName::ArrowLeft01, self.status.can_go_back, Navigate::Back, cx))
            .child(nav("browser-forward", IconName::ArrowRight01, self.status.can_go_forward, Navigate::Forward, cx))
            .child(nav("browser-reload", IconName::Refresh, self.viewer.is_some(), Navigate::Reload, cx))
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_w_0()
                    .h(CONTROL_SM)
                    .px_2()
                    .items_center()
                    .rounded(RADIUS_CONTROL)
                    .bg(theme.field)
                    .text_step(TEXT_12)
                    .text_color(theme.ink2)
                    .child(div().truncate().child(address)),
            )
            .into_any_element()
    }

    fn overlay(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let now = Instant::now();
        let received = Stats::rate(&mut self.stats.received, now);
        let painted = Stats::rate(&mut self.stats.painted, now);
        let latency = self.stats.median_latency().map_or("–".into(), |ms| format!("{ms:.0} ms"));
        let text = format!(
            "{received} fps in · {painted} painted · decode {:.1} ms · input→paint {latency} · {}×{}",
            self.stats.decode_ms, self.viewport.0, self.viewport.1
        );
        div()
            .absolute()
            .bottom_2()
            .right_2()
            .px_2()
            .py_1()
            .rounded(RADIUS_CONTROL)
            .bg(theme.ink)
            .opacity(0.85)
            .font_family(mono())
            .text_step(TEXT_11)
            .text_color(theme.on_ink)
            .child(text)
            .into_any_element()
    }
}

/// Where a `viewport`-sized picture sits in `stage`: top left, scaled down to fit, never up.
pub fn picture_rect(stage: Bounds<Pixels>, viewport: (u32, u32)) -> Option<Bounds<Pixels>> {
    let (w, h) = (viewport.0 as f32, viewport.1 as f32);
    if w <= 0.0 || h <= 0.0 || stage.size.width <= px(0.0) {
        return None;
    }
    let scale = (f32::from(stage.size.width) / w).min(f32::from(stage.size.height) / h).min(1.0);
    Some(Bounds::new(stage.origin, gpui::size(px(w * scale), px(h * scale))))
}

/// JPEG to the BGRA image GPUI's atlas takes.
pub fn decode(jpeg: &[u8]) -> anyhow::Result<Arc<RenderImage>> {
    let mut rgba = image::load_from_memory_with_format(jpeg, image::ImageFormat::Jpeg)?.into_rgba8();
    for pixel in rgba.pixels_mut() {
        pixel.0.swap(0, 2);
    }
    Ok(Arc::new(RenderImage::new([image::Frame::new(rgba)])))
}

impl Focusable for BrowserView {
    fn focus_handle(&self, _: &gpui::App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for BrowserView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.theme();
        let entity = cx.entity().downgrade();
        let measure = canvas(
            move |bounds, window, cx| {
                let scale = window.scale_factor();
                if let Some(view) = entity.upgrade() {
                    view.update(cx, |view, cx| view.painted(bounds, scale, cx));
                }
            },
            |_, _, _, _| {},
        )
        .absolute()
        .size_full();
        let picture = match (&self.picture, picture_rect(self.stage, self.viewport)) {
            (Some((_, image)), Some(rect)) => Some(
                img(gpui::ImageSource::Render(image.clone()))
                    .debug_selector(|| "browser-picture".into())
                    .absolute()
                    .left(px(0.0))
                    .top(px(0.0))
                    .w(rect.size.width)
                    .h(rect.size.height)
                    .into_any_element(),
            ),
            (Some((_, image)), None) => Some(img(gpui::ImageSource::Render(image.clone())).size_full().into_any_element()),
            _ => None,
        };
        let placeholder = match (&self.error, picture.is_none()) {
            (Some(error), _) => Some(error.clone()),
            (None, true) => Some("Starting the browser…".into()),
            _ => None,
        };
        let stage = div()
            .id("browser-stage")
            .debug_selector(|| "browser-stage".into())
            .track_focus(&self.focus)
            .relative()
            .flex_1()
            .min_h_0()
            .overflow_hidden()
            .bg(theme.page)
            .child(measure)
            .children(picture)
            .when_some(placeholder, |el, text| {
                el.child(
                    div().absolute().inset_0().flex().items_center().justify_center().text_step(TEXT_12).text_color(theme.ink3).child(text),
                )
            })
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, event: &MouseDownEvent, window, cx| {
                    window.focus(&this.focus, cx);
                    this.mouse(Phase::Down, event.position, Button::Left, event.click_count, keys::modifiers(&event.modifiers), cx);
                }),
            )
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(|this, event: &MouseDownEvent, _, cx| {
                    this.mouse(Phase::Down, event.position, Button::Right, event.click_count, keys::modifiers(&event.modifiers), cx);
                }),
            )
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, event: &MouseUpEvent, _, cx| {
                    this.mouse(Phase::Up, event.position, Button::Left, event.click_count, keys::modifiers(&event.modifiers), cx);
                }),
            )
            .on_mouse_up(
                MouseButton::Right,
                cx.listener(|this, event: &MouseUpEvent, _, cx| {
                    this.mouse(Phase::Up, event.position, Button::Right, event.click_count, keys::modifiers(&event.modifiers), cx);
                }),
            )
            .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, _, cx| {
                this.mouse(Phase::Move, event.position, Button::None, 0, keys::modifiers(&event.modifiers), cx);
            }))
            .on_scroll(cx.listener(|this, event: &ScrollEvent, _, cx| {
                let delta = event.delta.pixel_delta(px(16.0));
                if let Some((x, y)) = this.fraction(event.position) {
                    // GPUI's delta moves the content (positive y: towards the top of the page); CDP's scrolls the view.
                    let (delta_x, delta_y) = (-f32::from(delta.x), -f32::from(delta.y));
                    this.send(BrowserInput::Wheel { x, y, delta_x, delta_y, modifiers: keys::modifiers(&event.modifiers) }, cx);
                }
                cx.stop_propagation();
            }))
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                if let Some(input) = keys::key_event(&event.keystroke, true) {
                    this.send(input, cx);
                    cx.stop_propagation();
                }
            }))
            .on_key_up(cx.listener(|this, event: &KeyUpEvent, _, cx| {
                if let Some(input) = keys::key_event(&event.keystroke, false) {
                    this.send(input, cx);
                    cx.stop_propagation();
                }
            }))
            .child(self.overlay(cx));
        div().flex().flex_col().size_full().child(self.toolbar(cx)).child(stage)
    }
}

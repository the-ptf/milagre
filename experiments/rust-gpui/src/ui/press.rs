//! The press response every clickable gives while the mouse is down (the desktop's `active:scale-press`, DESIGN.md
//! "Motion": press scales to `--press-scale` 0.97 over `--duration-fast` 120 ms on `--ease-enter`; a chat row presses
//! to 0.98 over 150 ms; menu rows, tabs and nav rows go `hover-2` instead).
//!
//! GPUI draws quads and text without a transform and `.active(..)` refreshes every cached view in the window on a mouse
//! down, so a press is built here instead: a [`Press`] is a small keyed state (pressed or not, and since when) owned by
//! the element's own view, so a press re-renders that view alone, and the scale is painted as a [`Press::face`], an
//! absolute layer inside the element that stands in for its fill and shrinks toward its centre by the same fraction
//! the CSS scale would (percent insets, so a hug-width button needs no measuring). The label and glyph stay at full size
//! (a 3% change of a 12px label is under half a pixel); an icon glyph follows through its size. The hit area never
//! changes, so no sibling moves.
//!
//! GPUI itself refreshes the whole window (every cached view, once) on the mouse down and up of any element that has an
//! id, to track its click and active state; that cost is there with or without a press, and the press adds none.
//!
//! Appearance › Motion: Off (or a test) makes the duration zero, so the pressed state lands and leaves at once.

use std::time::{Duration, Instant};

use gpui::{App, Div, ElementId, Entity, InteractiveElement, MouseButton, Window, div, prelude::*, relative};

use super::ease::{DURATION_FAST, ease_out, progress};
use super::scaled;

/// `--press-scale`.
pub const PRESS_SCALE: f32 = 0.97;
/// A chat row's press (`active:scale-[0.98]`) and its timing (`duration-150`).
pub const ROW_SCALE: f32 = 0.98;
pub const ROW_DURATION: Duration = Duration::from_millis(150);

/// Whether the mouse is down on the element, and the eased amount at the last change.
pub struct PressState {
    down: bool,
    from: f32,
    since: Instant,
}

impl PressState {
    fn amount(&self, duration: Duration) -> f32 {
        let target = if self.down { 1.0 } else { 0.0 };
        let t = progress(self.since.elapsed(), scaled(duration), ease_out);
        self.from + (target - self.from) * t
    }

    fn set(&mut self, down: bool, duration: Duration, cx: &mut gpui::Context<Self>) {
        if self.down == down {
            return;
        }
        self.from = self.amount(duration);
        self.since = Instant::now();
        self.down = down;
        cx.notify();
    }
}

/// Snapshot aid (never in tests): `MILAGRE_GPUI_PRESSED=new-chat,chat-row-4` starts those elements pressed (a headless
/// snapshot has no mouse); the names are the elements' ids as `ElementId` prints them.
fn held_by_seed(id: &ElementId) -> bool {
    #[cfg(test)]
    let _ = id;
    #[cfg(not(test))]
    if let Ok(list) = std::env::var("MILAGRE_GPUI_PRESSED") {
        let name = id.to_string();
        return list.split(',').any(|seed| seed.trim() == name);
    }
    false
}

/// A press response for one element: build it in `render`, wire the element with [`Press::wire`] and draw the face.
#[derive(Clone)]
pub struct Press {
    state: Entity<PressState>,
    scale: f32,
    duration: Duration,
    amount: f32,
}

impl Press {
    /// The press of the element named `id`, to `scale` over `duration` (see [`PRESS_SCALE`], [`DURATION_FAST`]).
    pub fn with(id: impl Into<ElementId>, scale: f32, duration: Duration, window: &mut Window, cx: &mut App) -> Self {
        let id: ElementId = id.into();
        let held = held_by_seed(&id);
        let key: ElementId = (id, "press").into();
        let state = window.use_keyed_state(key, cx, move |_, _| PressState {
            down: held,
            from: if held { 1.0 } else { 0.0 },
            since: Instant::now(),
        });
        let amount = state.read(cx).amount(duration);
        let settled = (amount - if state.read(cx).down { 1.0 } else { 0.0 }).abs() < 1e-3;
        if !settled {
            // Mid-transition: the next frame renders this view again, until it lands.
            window.request_animation_frame();
        }
        Self { state, scale, duration, amount }
    }

    /// The button press: 0.97 over 120 ms.
    pub fn new(id: impl Into<ElementId>, window: &mut Window, cx: &mut App) -> Self {
        Self::with(id, PRESS_SCALE, DURATION_FAST, window, cx)
    }

    /// How far the press has come, 0 (up) to 1 (down), eased.
    pub fn amount(&self) -> f32 {
        self.amount
    }

    /// Down now or still easing back: the element draws its [`face`](Self::face) and leaves its own fill off.
    pub fn engaged(&self) -> bool {
        self.amount > 1e-3
    }

    /// The scale now: 1 at rest, `scale` fully pressed.
    pub fn factor(&self) -> f32 {
        1.0 - (1.0 - self.scale) * self.amount
    }

    /// `el` reports the left button going down on it and coming up (anywhere) to this press.
    pub fn wire<E: InteractiveElement>(&self, el: E) -> E {
        let (down, up, out, duration) = (self.state.clone(), self.state.clone(), self.state.clone(), self.duration);
        el.on_mouse_down(MouseButton::Left, move |_, _, cx| down.update(cx, |s, cx| s.set(true, duration, cx)))
            .on_mouse_up(MouseButton::Left, move |_, _, cx| up.update(cx, |s, cx| s.set(false, duration, cx)))
            .on_mouse_up_out(MouseButton::Left, move |_, _, cx| out.update(cx, |s, cx| s.set(false, duration, cx)))
    }

    /// The layer that stands in for the element's fill while it is pressed: absolute, inset by the fraction the scale
    /// removes, in `fill` with the element's `radius`. Add it as the element's first child, so the content paints over
    /// it, and drop the element's own fill, shadow and hover fill while [`engaged`](Self::engaged).
    pub fn face(&self, fill: Option<gpui::Hsla>, radius: gpui::Pixels) -> Div {
        let inset = relative((1.0 - self.factor()) / 2.0);
        div().absolute().left(inset).right(inset).top(inset).bottom(inset).rounded(radius).when_some(fill, |el, fill| el.bg(fill))
    }
}

impl std::fmt::Debug for Press {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Press({:.2})", self.amount)
    }
}

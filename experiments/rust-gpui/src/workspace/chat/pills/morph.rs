//! The pill-to-panel morph (`PillMorph.tsx`, `morph.ts`): one surface hung from the pill's bottom corner that grows
//! from the pill's size into the panel's, its corners going from round to `radius-card`, while the two faces crossfade
//! over it (the panel face fades in over 180ms after 60ms; the pill face out over 100ms).
//!
//! This file is the timing and the geometry as plain functions, so a test can ask for the frame at any time. The
//! view reads the clock (`Instant`) once per render and asks for another frame until the morph is over; with motion
//! off (the tests, Appearance › Motion Off) a morph is over at once.

use std::time::Duration;

use crate::theme::{CONTROL_SM, RADIUS_CARD};

/// The box's own transition (`--duration-slow`).
pub const BOX_MS: f32 = 300.0;
/// The panel stays this far from the window's edges (`EDGE`) and never takes more than this share of its height.
pub const EDGE: f32 = 12.0;
pub const VIEWPORT_SHARE: f32 = 0.7;
/// The pill: 28 high, fully round.
pub const PILL_HEIGHT: f32 = 28.0;

/// `EASE_OUT`, a cubic bezier close to `cubic-bezier(0.23, 1, 0.32, 1)`: quint-out is within a pixel at these sizes.
pub fn ease_out(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    1.0 - (1.0 - t).powi(4)
}

pub fn lerp(from: f32, to: f32, t: f32) -> f32 {
    from + (to - from) * t
}

/// One frame of a morph, `elapsed` after it began.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Frame {
    /// 0 is the pill, 1 the panel.
    pub grown: f32,
    pub pill_opacity: f32,
    pub panel_opacity: f32,
    /// The morph is over: the surface is at rest (open, or closed and the panel face unmounted).
    pub done: bool,
}

/// The frame of an opening (`opening`) or closing morph `elapsed` after it began.
pub fn frame(opening: bool, elapsed: Duration) -> Frame {
    let ms = elapsed.as_secs_f32() * 1000.0;
    let u = ease_out(ms / BOX_MS);
    // A face showing waits 60ms and fades in over 180ms; a face hiding fades out over 100ms.
    let show = ((ms - 60.0) / 180.0).clamp(0.0, 1.0);
    let hide = 1.0 - (ms / 100.0).clamp(0.0, 1.0);
    let (pill_opacity, panel_opacity) = if opening { (hide, show) } else { (show, hide) };
    Frame { grown: if opening { u } else { 1.0 - u }, pill_opacity, panel_opacity, done: ms >= BOX_MS }
}

/// The frame of a surface at rest.
pub fn at_rest(open: bool) -> Frame {
    Frame {
        grown: if open { 1.0 } else { 0.0 },
        pill_opacity: if open { 0.0 } else { 1.0 },
        panel_opacity: if open { 1.0 } else { 0.0 },
        done: true,
    }
}

/// The surface's size and corner radius at `grown`.
pub fn surface(pill: (f32, f32), panel: (f32, f32), grown: f32) -> (f32, f32, f32) {
    let width = lerp(pill.0, panel.0, grown);
    let height = lerp(pill.1, panel.1, grown);
    let closed_radius = pill.1 / 2.0;
    (width, height, lerp(closed_radius, f32::from(RADIUS_CARD), grown))
}

/// The room the panel gets: its preferred size, no wider than the window less an edge each side, no taller than a
/// share of the window or the space over the pill (`fit`).
pub fn room(preferred: (f32, f32), window: (f32, f32), space_above: f32) -> (f32, f32) {
    let width = preferred.0.min(window.0 - 2.0 * EDGE).max(0.0).round();
    let height = preferred.1.min(window.1 * VIEWPORT_SHARE).min(space_above - EDGE).max(0.0).round();
    (width, height)
}

/// How far a panel hung from the pill's right edge (`right`, window x) is moved right so a narrow window still fits it.
pub fn right_shift(right: f32, width: f32) -> f32 {
    (EDGE - (right - width)).max(0.0)
}

/// How far a panel hung from the pill's left edge (`left`) is moved left so it stays inside the window.
pub fn left_shift(left: f32, width: f32, window_width: f32) -> f32 {
    (left + width - (window_width - EDGE)).max(0.0)
}

pub fn pill_size(width: f32) -> (f32, f32) {
    (width, f32::from(CONTROL_SM))
}

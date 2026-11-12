//! The desktop's motion curves and durations (`lib/ease.ts`, DESIGN.md "Motion") as plain functions, for the views
//! that time their own frames. Durations go through [`super::scaled`], which applies the Appearance "Motion" speed.

use std::time::Duration;

/// `--duration-fast`: hover and press.
pub const DURATION_FAST: Duration = Duration::from_millis(120);
/// `--duration-base`: things that enter (a find bar, a toast).
pub const DURATION_BASE: Duration = Duration::from_millis(180);
/// `--duration-slow`: panels and sheets.
pub const DURATION_SLOW: Duration = Duration::from_millis(280);

/// `--ease-enter`, `cubic-bezier(0.23, 1, 0.32, 1)`: everything that appears or settles. `t` in 0..=1.
pub fn ease_out(t: f32) -> f32 {
    cubic_bezier(0.23, 1.0, 0.32, 1.0, t)
}

/// `EASE_IN_OUT`, `cubic-bezier(0.77, 0, 0.175, 1)`: a size that morphs both ways.
pub fn ease_in_out(t: f32) -> f32 {
    cubic_bezier(0.77, 0.0, 0.175, 1.0, t)
}

/// CSS `ease-out`, `cubic-bezier(0, 0, 0.58, 1)`: the scroll edge fades (`.scroll-fade`'s transition).
pub fn css_ease_out(t: f32) -> f32 {
    cubic_bezier(0.0, 0.0, 0.58, 1.0, t)
}

/// How far along `elapsed` is in `duration`, eased; 1 when the duration is zero (motion off).
pub fn progress(elapsed: Duration, duration: Duration, ease: fn(f32) -> f32) -> f32 {
    if duration.is_zero() {
        return 1.0;
    }
    ease((elapsed.as_secs_f32() / duration.as_secs_f32()).clamp(0.0, 1.0))
}

/// CSS `cubic-bezier(x1, y1, x2, y2)` at `t`: solves x for t by Newton's method, then returns y.
fn cubic_bezier(x1: f32, y1: f32, x2: f32, y2: f32, t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    if t == 0.0 || t == 1.0 {
        return t;
    }
    let curve = |a: f32, b: f32, s: f32| {
        let u = 1.0 - s;
        3.0 * u * u * s * a + 3.0 * u * s * s * b + s * s * s
    };
    let slope = |a: f32, b: f32, s: f32| {
        let u = 1.0 - s;
        3.0 * u * u * a + 6.0 * u * s * (b - a) + 3.0 * s * s * (1.0 - b)
    };
    let mut s = t;
    for _ in 0..8 {
        let dx = slope(x1, x2, s);
        if dx.abs() < 1e-6 {
            break;
        }
        s = (s - (curve(x1, x2, s) - t) / dx).clamp(0.0, 1.0);
    }
    // A few bisection steps where Newton's method was not exact enough.
    let (mut lo, mut hi) = (0.0f32, 1.0f32);
    for _ in 0..20 {
        let x = curve(x1, x2, s);
        if (x - t).abs() < 1e-5 {
            break;
        }
        if x < t {
            lo = s
        } else {
            hi = s
        }
        s = (lo + hi) / 2.0;
    }
    curve(y1, y2, s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_curves_start_at_zero_end_at_one_and_rise() {
        for ease in [ease_out as fn(f32) -> f32, ease_in_out] {
            assert_eq!(ease(0.0), 0.0);
            assert_eq!(ease(1.0), 1.0);
            let mut last = 0.0;
            for step in 1..=20 {
                let y = ease(step as f32 / 20.0);
                assert!(y >= last - 1e-4, "monotonic");
                last = y;
            }
        }
        // The enter curve is front-loaded: most of the way there by a third of the time.
        assert!(ease_out(0.33) > 0.8, "{}", ease_out(0.33));
    }

    #[test]
    fn progress_is_done_at_once_with_motion_off() {
        assert_eq!(progress(Duration::ZERO, Duration::ZERO, ease_out), 1.0);
        assert_eq!(progress(DURATION_SLOW, DURATION_SLOW, ease_out), 1.0);
        assert!(progress(Duration::from_millis(10), DURATION_SLOW, ease_out) < 0.5);
    }
}

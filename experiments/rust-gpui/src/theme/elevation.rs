//! Elevation (DESIGN.md "Elevation"): each shadow token paints its own 1px ring, so an elevated surface
//! takes a shadow and no border. Values from the desktop's `styles.css`: the dark block exactly; in light,
//! the ring exactly and the drop shadow approximated (the CSS uses shadow-plugin's layered `--shadow-xs` and
//! `--shadow-md` stacks, which are not in this repository).

use gpui::{BoxShadow, Hsla, point, px};

use super::{Appearance, Theme};

/// Black or white at `alpha` (styles.css writes them as `oklch(0 0 0 / a)` and `oklch(1 0 0 / a)`).
fn black(alpha: f32) -> Hsla {
    Hsla { h: 0.0, s: 0.0, l: 0.0, a: alpha }
}

fn white(alpha: f32) -> Hsla {
    Hsla { h: 0.0, s: 0.0, l: 1.0, a: alpha }
}

/// A 1px ring drawn outside the box.
fn ring(color: Hsla) -> BoxShadow {
    BoxShadow { color, offset: point(px(0.0), px(0.0)), blur_radius: px(0.0), spread_radius: px(1.0), inset: false }
}

fn drop(y: f32, blur: f32, color: Hsla) -> BoxShadow {
    BoxShadow { color, offset: point(px(0.0), px(y)), blur_radius: px(blur), spread_radius: px(0.0), inset: false }
}

impl Theme {
    /// `shadow-btn`: secondary buttons and filter chips.
    pub fn shadow_btn(&self) -> Vec<BoxShadow> {
        match self.appearance {
            Appearance::Light => vec![ring(self.line_strong.into()), drop(1.0, 2.0, black(0.05))],
            Appearance::Dark => vec![ring(white(0.1)), drop(1.0, 2.0, black(0.3))],
        }
    }

    /// `shadow-raised`: menus, pickers, toasts, tooltips.
    pub fn shadow_raised(&self) -> Vec<BoxShadow> {
        match self.appearance {
            Appearance::Light => vec![ring(self.line.into()), drop(2.0, 10.0, black(0.08))],
            Appearance::Dark => vec![ring(white(0.13)), drop(2.0, 10.0, black(0.22))],
        }
    }
}

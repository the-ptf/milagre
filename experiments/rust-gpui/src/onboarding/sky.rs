//! The light behind the steps (`OnboardingSky`, `styles.css` `.onboarding-sky`): a wash of the intro's day over the
//! page, thinning on the second step. Top colour to the middle colour over the first 34% of the window, the middle
//! colour to the page by 64%. Not built: the radial glow (GPUI has no radial gradient).

use gpui::{AnyElement, IntoElement, Rgba, div, linear_color_stop, linear_gradient, prelude::*, relative, rgb};

use super::model::Step;
use crate::theme::{Appearance, Theme};

/// `--sky-top` and `--sky-mid`, which `styles.css` defines for this screen only (they are no DESIGN.md token).
fn colours(theme: &Theme) -> (Rgba, Rgba) {
    match theme.appearance {
        Appearance::Light => (rgb(0xc6dcf4), rgb(0xe1edf9)),
        Appearance::Dark => (rgb(0x1d2d4a), rgb(0x15223a)),
    }
}

/// The opacity of the whole sky: lighter on step 2.
pub fn opacity(step: Step) -> f32 {
    if step == Step::Project { 0.7 } else { 1.0 }
}

pub fn sky(step: Step, theme: &Theme) -> AnyElement {
    let (top, mid) = colours(theme);
    div()
        .debug_selector(|| "onboarding-sky".into())
        .absolute()
        .inset_0()
        .opacity(opacity(step))
        .child(div().w_full().h(relative(0.34)).bg(linear_gradient(180.0, linear_color_stop(top, 0.0), linear_color_stop(mid, 1.0))))
        .child(div().w_full().h(relative(0.30)).bg(linear_gradient(180.0, linear_color_stop(mid, 0.0), linear_color_stop(theme.page, 1.0))))
        .into_any_element()
}

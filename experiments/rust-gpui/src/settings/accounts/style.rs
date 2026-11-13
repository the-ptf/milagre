//! Looks the two pages share: the usage meter, the `shadow-card` ring and the page's small text pieces.

use gpui::{BoxShadow, Div, FontWeight, Hsla, ParentElement, Rgba, SharedString, Styled, div, point, px, relative};

use crate::logic::usage::report::{UsageDisplay, UsageTone, shown_percent, usage_tone};
use crate::theme::{Appearance, TEXT_11, TEXT_12, TEXT_13, TextStepExt, Theme};

/// The fill of a meter: how full the window is, or "stale" for numbers from an earlier read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BarTone {
    Usage(UsageTone),
    Stale,
}

impl BarTone {
    /// `UsageBar`'s fills with a `tone` given: ink-3, then orange and red as a window nears its limit.
    pub fn fill(self, theme: &Theme) -> Rgba {
        match self {
            BarTone::Usage(UsageTone::Normal) | BarTone::Stale => theme.ink3,
            BarTone::Usage(UsageTone::Warning) => theme.orange,
            BarTone::Usage(UsageTone::Critical) => theme.red,
        }
    }
}

/// `UsageBar`: a `line-strong` track, fully round, whose fill is as long as the shown percent (it drains in
/// "remaining" mode) while its colour follows how much is used.
pub fn usage_bar(theme: &Theme, used_percent: f64, display: UsageDisplay, tone: BarTone, height: f32) -> Div {
    let shown = (shown_percent(used_percent, display) / 100.0).clamp(0.0, 1.0) as f32;
    div()
        .relative()
        .flex_none()
        .w_full()
        .h(px(height))
        .overflow_hidden()
        .rounded_full()
        .bg(theme.line_strong)
        .child(div().absolute().top_0().bottom_0().left_0().w(relative(shown)).rounded_full().bg(tone.fill(theme)))
}

/// The tone a percent reads in, from `usageTone`.
pub fn tone_of(used_percent: f64) -> UsageTone {
    usage_tone(used_percent)
}

/// `percentInk`: the percent's colour.
pub fn percent_ink(theme: &Theme, tone: UsageTone) -> Rgba {
    match tone {
        UsageTone::Normal => theme.ink,
        UsageTone::Warning => theme.orange_ink,
        UsageTone::Critical => theme.red_ink,
    }
}

fn shadow_ring(color: Hsla) -> BoxShadow {
    BoxShadow { color, offset: point(px(0.0), px(0.0)), blur_radius: px(0.0), spread_radius: px(1.0), inset: false }
}

fn shadow_drop(y: f32, blur: f32, alpha: f32) -> BoxShadow {
    BoxShadow {
        color: Hsla { h: 0.0, s: 0.0, l: 0.0, a: alpha },
        offset: point(px(0.0), px(y)),
        blur_radius: px(blur),
        spread_radius: px(0.0),
        inset: false,
    }
}

/// `shadow-card` (styles.css): a hairline ring and a soft drop, deeper in dark. The light drop approximates the
/// CSS `--shadow-sm`.
pub fn shadow_card(theme: &Theme) -> Vec<BoxShadow> {
    match theme.appearance {
        Appearance::Light => vec![shadow_ring(theme.line.into()), shadow_drop(1.0, 2.0, 0.05)],
        Appearance::Dark => {
            vec![shadow_ring(Hsla { h: 0.0, s: 0.0, l: 1.0, a: 0.11 }), shadow_drop(1.0, 2.0, 0.2), shadow_drop(2.0, 6.0, 0.2)]
        }
    }
}

/// A 13px medium line, `ink` by default.
pub fn label_13(text: impl Into<SharedString>, theme: &Theme) -> Div {
    div().text_step(TEXT_13).font_weight(FontWeight::MEDIUM).text_color(theme.ink).child(text.into())
}

/// A 12px `ink-3` note.
pub fn note_12(text: impl Into<SharedString>, theme: &Theme) -> Div {
    div().text_step(TEXT_12).text_color(theme.ink3).child(text.into())
}

/// An 11px `ink-3` note.
pub fn note_11(text: impl Into<SharedString>, theme: &Theme) -> Div {
    div().text_step(TEXT_11).text_color(theme.ink3).child(text.into())
}

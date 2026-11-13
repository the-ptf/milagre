//! [`ProgressBar`] (the desktop's `primitives/ProgressBar.tsx`): a progress or usage bar, a `line-strong` track, an
//! ink fill (or a status tone at a usage threshold), fully round, 4px or 6px tall. `value` is a fraction, 0 to 1.
//! Our own. Not built: the width transition (`duration-slow`).

use gpui::{App, IntoElement, RenderOnce, Rgba, Window, div, prelude::*, px, relative};

use crate::theme::{ActiveTheme, Theme};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ProgressTone {
    #[default]
    Ink,
    Green,
    Orange,
    Red,
}

impl ProgressTone {
    fn fill(self, theme: &Theme) -> Rgba {
        match self {
            ProgressTone::Ink => theme.ink,
            ProgressTone::Green => theme.green,
            ProgressTone::Orange => theme.orange,
            ProgressTone::Red => theme.red,
        }
    }
}

#[derive(IntoElement)]
pub struct ProgressBar {
    value: f32,
    tone: ProgressTone,
    thick: bool,
}

impl ProgressBar {
    pub fn new(value: f32) -> Self {
        Self { value: value.clamp(0.0, 1.0), tone: ProgressTone::default(), thick: false }
    }

    pub fn tone(mut self, tone: ProgressTone) -> Self {
        self.tone = tone;
        self
    }

    /// 6px instead of 4.
    pub fn thick(mut self) -> Self {
        self.thick = true;
        self
    }
}

impl RenderOnce for ProgressBar {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = *cx.theme();
        div()
            .debug_selector(|| "progress-bar".into())
            .relative()
            .flex_none()
            .w_full()
            .h(px(if self.thick { 6.0 } else { 4.0 }))
            .overflow_hidden()
            .rounded_full()
            .bg(theme.line_strong)
            .child(
                div()
                    .debug_selector(|| "progress-fill".into())
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .left_0()
                    .w(relative(self.value))
                    .rounded_full()
                    .bg(self.tone.fill(&theme)),
            )
    }
}

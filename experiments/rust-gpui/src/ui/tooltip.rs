//! [`Tooltip`] (stub): the desktop's look, an ink capsule (`bg-ink`, 12 medium on-ink, `rounded-chip`,
//! 8 by 4 padding, `shadow-raised`), shown by GPUI's own tooltip machinery after its hover delay:
//!
//! ```ignore
//! div().id("search").tooltip(Tooltip::text("Search")).child(...)
//! ```
//!
//! Not built yet: the shortcut hint, the 400 ms delay of the desktop (GPUI uses its own), placement
//! above or below, and wrapping at 280px. gpui-component's `Tooltip` has these if we need them sooner.

use gpui::{AnyView, App, Context, FontWeight, IntoElement, Render, SharedString, Window, div, prelude::*, px};

use crate::theme::{ActiveTheme, RADIUS_CHIP, TEXT_12, TextStepExt};

pub struct Tooltip {
    label: SharedString,
}

impl Tooltip {
    /// A builder for `.tooltip(...)` that shows `label`.
    pub fn text(label: impl Into<SharedString>) -> impl Fn(&mut Window, &mut App) -> AnyView + 'static {
        let label = label.into();
        move |_, cx| cx.new(|_| Tooltip { label: label.clone() }).into()
    }
}

impl Render for Tooltip {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        div()
            .debug_selector(|| "tooltip".into())
            .px(px(8.0))
            .py(px(4.0))
            .rounded(RADIUS_CHIP)
            .bg(theme.ink)
            .shadow(theme.shadow_raised())
            .text_step(TEXT_12)
            .font_weight(FontWeight::MEDIUM)
            .text_color(theme.on_ink)
            .whitespace_nowrap()
            .child(self.label.clone())
    }
}

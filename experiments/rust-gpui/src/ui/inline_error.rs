//! [`InlineError`] (DESIGN.md "States"; the desktop's `primitives/InlineError.tsx`): a failure, in `red-ink`.
//!
//! - `Inline` (default): red-ink text under the control or form it belongs to, 12px under fields and in dialogs,
//!   13px standalone.
//! - `Card`: a blocking failure with a way out (a Chat that will not load, a failed save): a `red-tint` card, 13px
//!   `red-ink`, with an `action` (a secondary Button at 28) at its right.
//! - `Floating`: the same message over a canvas or view, on a `surface` with `shadow-raised`, 12px.
//!
//! Renders nothing when the message is empty. Our own.

use gpui::{AnyElement, App, IntoElement, RenderOnce, SharedString, Window, div, prelude::*, px};

use crate::theme::{ActiveTheme, RADIUS_CARD, TEXT_12, TEXT_13, TextStepExt};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ErrorVariant {
    #[default]
    Inline,
    Card,
    Floating,
}

#[derive(IntoElement)]
pub struct InlineError {
    message: SharedString,
    small: bool,
    variant: ErrorVariant,
    action: Option<AnyElement>,
}

impl InlineError {
    pub fn new(message: impl Into<SharedString>) -> Self {
        Self { message: message.into(), small: false, variant: ErrorVariant::default(), action: None }
    }

    /// 12px text (under a field or in a dialog) instead of 13.
    pub fn small(mut self) -> Self {
        self.small = true;
        self
    }

    pub fn variant(mut self, variant: ErrorVariant) -> Self {
        self.variant = variant;
        self
    }

    /// With `Card`: the retry button.
    pub fn action(mut self, action: impl IntoElement) -> Self {
        self.action = Some(action.into_any_element());
        self
    }
}

impl RenderOnce for InlineError {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = *cx.theme();
        if self.message.is_empty() {
            return div().into_any_element();
        }
        let base = div().debug_selector(|| "inline-error".into()).text_color(theme.red_ink);
        match self.variant {
            ErrorVariant::Card => base
                .flex()
                .items_center()
                .gap(px(12.0))
                .p(px(12.0))
                .rounded(RADIUS_CARD)
                .bg(theme.red_tint)
                .text_step(TEXT_13)
                .child(div().flex_1().min_w_0().child(self.message))
                .children(self.action.map(|action| div().flex_none().child(action)))
                .into_any_element(),
            ErrorVariant::Floating => base
                .px(px(12.0))
                .py(px(8.0))
                .rounded(RADIUS_CARD)
                .bg(theme.surface)
                .shadow(theme.shadow_raised())
                .text_step(TEXT_12)
                .child(self.message)
                .into_any_element(),
            ErrorVariant::Inline => base.text_step(if self.small { TEXT_12 } else { TEXT_13 }).child(self.message).into_any_element(),
        }
    }
}

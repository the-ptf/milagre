//! [`Skeleton`] (the desktop's `primitives/Skeleton.tsx`): a loading placeholder bar, `hover-2` for the main line
//! and `hover` (`.secondary()`) for the one under it, 4px corners, a pulse unless motion is reduced. Size it like
//! any element (`.w(px(128.0)).h(px(12.0))`). The pulse is an animation: give it an id with `.pulse(id)` and keep it
//! out of big views (CONVENTIONS.md); static otherwise, and always static under `ui::motion()` off (tests).

use std::time::Duration;

use gpui::{Animation, AnimationExt as _, App, ElementId, IntoElement, RenderOnce, StyleRefinement, Styled, Window, div, prelude::*};

use crate::theme::{ActiveTheme, RADIUS_INLINE};

/// Tailwind's `animate-pulse`: 2s, opacity 1 to .5 and back.
const PULSE: Duration = Duration::from_millis(2000);

#[derive(IntoElement)]
pub struct Skeleton {
    secondary: bool,
    pulse: Option<ElementId>,
    style: StyleRefinement,
}

impl Default for Skeleton {
    fn default() -> Self {
        Self::new()
    }
}

impl Skeleton {
    pub fn new() -> Self {
        Self { secondary: false, pulse: None, style: StyleRefinement::default() }
    }

    /// The fainter bar (`hover`) for the line under the main one.
    pub fn secondary(mut self) -> Self {
        self.secondary = true;
        self
    }

    /// Pulses; `id` must be unique among its siblings.
    pub fn pulse(mut self, id: impl Into<ElementId>) -> Self {
        self.pulse = Some(id.into());
        self
    }
}

impl Styled for Skeleton {
    fn style(&mut self) -> &mut StyleRefinement {
        &mut self.style
    }
}

impl RenderOnce for Skeleton {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = cx.theme();
        let mut bar = div().rounded(RADIUS_INLINE).bg(if self.secondary { theme.hover } else { theme.hover2 });
        bar.style().refine(&self.style);
        match self.pulse.filter(|_| super::motion()) {
            Some(id) => bar
                .with_animation(id, Animation::new(PULSE).repeat(), |bar, delta| {
                    // 0 -> 1 -> 0 over the cycle, opacity from 1 down to 0.5 at the middle.
                    let wave = 1.0 - (delta * 2.0 - 1.0).abs();
                    bar.opacity(1.0 - 0.5 * wave)
                })
                .into_any_element(),
            None => bar.into_any_element(),
        }
    }
}

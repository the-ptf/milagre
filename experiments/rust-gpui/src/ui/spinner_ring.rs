//! [`SpinnerRing`]: a ring with an arc sweeping round it; a turn is running (DESIGN.md "Chat status
//! marks": work in progress is quiet `ink-3`). The desktop's `SpinnerRing.tsx`: a `line` track, an arc of 28%
//! of the circle, one turn every 1.1 s in 24 steps.
//!
//! Static unless `.animated(id)`. An animation asks for a frame every vsync and re-renders the view that
//! draws it (and that view's ancestors), so put an animated ring in a small view of its own, mounted as a
//! cached view, never inside a big one (CONVENTIONS.md "Views that do not repaint their siblings").

use std::time::Duration;

use gpui::{
    Animation, AnimationExt as _, App, ElementId, Hsla, IntoElement, RenderOnce, Transformation, Window, div, percentage, prelude::*, px,
    svg,
};

use crate::theme::ActiveTheme;

const TURN: Duration = Duration::from_millis(1100);
const STEPS: f32 = 24.0;

#[derive(IntoElement)]
pub struct SpinnerRing {
    size: f32,
    color: Option<Hsla>,
    animation: Option<ElementId>,
}

impl Default for SpinnerRing {
    fn default() -> Self {
        Self::new()
    }
}

impl SpinnerRing {
    /// A 12px ring with a 2px stroke, the size Chat rows use.
    pub fn new() -> Self {
        Self { size: 12.0, color: None, animation: None }
    }

    pub fn size(mut self, size: f32) -> Self {
        self.size = size;
        self
    }

    /// The arc's colour; `ink-3` by default.
    pub fn color(mut self, color: impl Into<Hsla>) -> Self {
        self.color = Some(color.into());
        self
    }

    /// Spins. `id` must be unique among its siblings (GPUI keeps the animation's clock under it).
    pub fn animated(mut self, id: impl Into<ElementId>) -> Self {
        self.animation = Some(id.into());
        self
    }
}

impl RenderOnce for SpinnerRing {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = cx.theme();
        let size = px(self.size);
        let track = svg().path("ui/spinner-track.svg").absolute().size(size).text_color(theme.line);
        let arc = svg().path("ui/spinner-arc.svg").absolute().size(size).text_color(self.color.unwrap_or_else(|| theme.ink3.into()));
        let arc = match self.animation {
            Some(id) => arc
                .with_animation(id, Animation::new(TURN).repeat(), |arc, delta| {
                    let step = (delta * STEPS).floor() / STEPS;
                    arc.with_transformation(Transformation::rotate(percentage(step)))
                })
                .into_any_element(),
            None => arc.into_any_element(),
        };
        div().relative().flex_none().size(size).child(track).child(arc)
    }
}

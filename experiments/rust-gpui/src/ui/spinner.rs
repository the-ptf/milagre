//! [`Spinner`]: a [`SpinnerRing`] that turns, drawn by a small view of its own ([`SpinnerView`]).
//!
//! An animation asks for a frame every vsync and notifies the view that draws it (CONVENTIONS.md, rule 4). Drawn
//! inline, a ring in the pill row would notify the pill row, in a sidebar row the row, in a grid tile the grid: each
//! frame their observers would run and their renders would be the animation's. Here only the `SpinnerView` is
//! notified. GPUI still marks the views above it dirty (a cached row holding one renders again, which is the row's own
//! cheap render), but its siblings stay cached: the transcript, the other sidebar rows and the panel are reused.
//!
//! The view lives in the element state of the place that draws it (`Window::use_keyed_state`), so a ring keeps
//! turning across renders without the caller holding an entity. `id` must be unique among its siblings. Never put one
//! inside a cached view whose rebuild is expensive (the transcript): it would rebuild that view every frame.
//!
//! With [`super::motion`] off (the headless tests) the ring is static, as `SpinnerRing` without `.animated`.

use std::cell::Cell;

use gpui::{AnyView, App, Context, ElementId, Hsla, IntoElement, RenderOnce, StyleRefinement, Window, div, prelude::*, px};

use super::SpinnerRing;

/// A turning ring, `size` px square, the arc in `color` (`ink-3` by default).
#[derive(IntoElement)]
pub struct Spinner {
    id: ElementId,
    size: f32,
    color: Option<Hsla>,
}

impl Spinner {
    /// A 12px ring, the size Chat rows use. `id` keeps its view across renders.
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self { id: id.into(), size: 12.0, color: None }
    }

    pub fn size(mut self, size: f32) -> Self {
        self.size = size;
        self
    }

    pub fn color(mut self, color: impl Into<Hsla>) -> Self {
        self.color = Some(color.into());
        self
    }
}

impl RenderOnce for Spinner {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let (size, color) = (self.size, self.color);
        let view = window.use_keyed_state(self.id, cx, |_, _| SpinnerView::new(size, color));
        // A theme change or another size: the view draws again once with it.
        if view.read(cx).size != size || view.read(cx).color != color {
            view.update(cx, |view, cx| {
                view.size = size;
                view.color = color;
                cx.notify();
            });
        }
        div().flex_none().size(px(size)).child(AnyView::from(view).cached(StyleRefinement::default().size_full()))
    }
}

/// The view a [`Spinner`] draws its ring in; each animation frame renders this view alone.
pub struct SpinnerView {
    size: f32,
    color: Option<Hsla>,
}

impl SpinnerView {
    fn new(size: f32, color: Option<Hsla>) -> Self {
        Self { size, color }
    }

    /// How many times any spinner view has rendered on this thread (each animation frame is one per ring), for the
    /// tests that count what a frame rebuilds.
    pub fn renders() -> usize {
        RENDERS.with(Cell::get)
    }
}

thread_local! {
    static RENDERS: Cell<usize> = const { Cell::new(0) };
}

impl Render for SpinnerView {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        RENDERS.with(|renders| renders.set(renders.get() + 1));
        let ring = SpinnerRing::new().size(self.size);
        let ring = match self.color {
            Some(color) => ring.color(color),
            None => ring,
        };
        let ring = if super::motion() { ring.animated("spin") } else { ring };
        div().size_full().debug_selector(|| "spinner-view".into()).child(ring)
    }
}

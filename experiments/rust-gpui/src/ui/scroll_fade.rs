//! Scroll edge fades (the desktop's `.scroll-fade` in `styles.css` with `lib/use-scroll-fade.ts`): while a scroller
//! has more content above, its top edge fades into the surface; while it has more below, its bottom edge does.
//!
//! React masks the scroller's content (`mask-image: linear-gradient(transparent, #000 28px, #000 calc(100% - 28px),
//! transparent)`, the 28px a `--fade-top` / `--fade-bottom` length that animates 0 to 28px in 180ms `ease-out`);
//! `data-fade-top` is set when `scrollTop > 1`, `data-fade-bottom` when `scrollTop + clientHeight < scrollHeight - 1`.
//! GPUI has no mask, so [`ScrollFade`] paints the same ramp the other way round: the surface's colour at the edge
//! down to transparent 28px in, over the content. Transparent at the inner end, so the grain under a transparent
//! scroller shows through.
//!
//! It is a canvas, not a view: it reads the scroll handle while it paints, so a scroll tick never renders (or
//! rebuilds) anything for it, and it never takes the mouse. Keep one [`ScrollFade`] next to the scroll handle (it
//! holds the fade animation), and mount [`ScrollFade::overlay`] last inside a `relative()` container around the scroller.

use std::cell::Cell;
use std::rc::Rc;
use std::time::Instant;

use gpui::{
    App, Bounds, ElementId, Hsla, IntoElement, ScrollHandle, UniformListScrollHandle, Window, canvas, fill, linear_color_stop,
    linear_gradient, point, prelude::*, px, size,
};

use super::ease::{DURATION_BASE, css_ease_out};

/// `--scroll-fade-size`: how far in the fade reaches. A tight list (the command palette) passes 16.
pub const FADE_SIZE: f32 = 28.0;
/// React's `scrollTop > 1` and `scrollHeight - 1` slack.
const SLACK: f32 = 1.0;

#[derive(Clone)]
enum Source {
    Uniform(UniformListScrollHandle),
    Handle(ScrollHandle),
}

/// How far each fade has grown, 0 to 1 (linear in time; the curve is applied when drawing), and when it was last drawn.
#[derive(Clone, Copy, Default)]
pub(super) struct Anim {
    top: f32,
    bottom: f32,
    at: Option<Instant>,
}

/// The fades of one scroller: its scroll handle and the animation state.
#[derive(Clone)]
pub struct ScrollFade {
    source: Source,
    anim: Rc<Cell<Anim>>,
    size: f32,
    horizontal: bool,
}

impl ScrollFade {
    pub fn uniform(handle: &UniformListScrollHandle) -> Self {
        Self::from_source(Source::Uniform(handle.clone()))
    }

    pub fn handle(handle: &ScrollHandle) -> Self {
        Self::from_source(Source::Handle(handle.clone()))
    }

    fn from_source(source: Source) -> Self {
        Self { source, anim: Rc::default(), size: FADE_SIZE, horizontal: false }
    }

    /// Fades for a plain scroll handle whose animation state lives somewhere that outlasts the render (`ScrollArea`).
    pub(super) fn with_anim(handle: &ScrollHandle, anim: Rc<Cell<Anim>>) -> Self {
        Self { source: Source::Handle(handle.clone()), anim, size: FADE_SIZE, horizontal: false }
    }

    /// A scroll handle and its fades kept in window state under `id` (for a `RenderOnce` that owns neither): the same
    /// pair on every render. Track the handle on the scroller (`track_scroll`).
    pub fn kept(id: &ElementId, window: &mut Window, cx: &mut App) -> (ScrollHandle, Self) {
        let handle = window.use_keyed_state(ElementId::from((id.clone(), "scroll")), cx, |_, _| ScrollHandle::new()).read(cx).clone();
        let anim =
            window.use_keyed_state(ElementId::from((id.clone(), "fade")), cx, |_, _| Rc::new(Cell::<Anim>::default())).read(cx).clone();
        let fade = Self::with_anim(&handle, anim);
        (handle, fade)
    }

    /// Fades the left and right edges of a horizontal scroller (React's `ScrollArea horizontal`): left once scrolled right,
    /// right while more is off to the right.
    pub fn horizontal(mut self) -> Self {
        self.horizontal = true;
        self
    }

    /// A shorter fade, for a list whose rows sit close to its edge.
    pub fn size(mut self, size: f32) -> Self {
        self.size = size;
        self
    }

    fn base(&self) -> ScrollHandle {
        match &self.source {
            Source::Uniform(handle) => handle.0.borrow().base_handle.clone(),
            Source::Handle(handle) => handle.clone(),
        }
    }

    /// Whether there is more to scroll up and down, as the last paint left the handle.
    pub fn edges(&self) -> (bool, bool) {
        let base = self.base();
        let (offset, max) = if self.horizontal { (base.offset().x, base.max_offset().x) } else { (base.offset().y, base.max_offset().y) };
        let (scrolled, max) = (-f32::from(offset), f32::from(max));
        (scrolled > SLACK, scrolled < max - SLACK)
    }

    /// The fades' current strength (0 to 1, after the curve), top then bottom: tests read it.
    pub fn strength(&self) -> (f32, f32) {
        let anim = self.anim.get();
        (css_ease_out(anim.top), css_ease_out(anim.bottom))
    }

    /// The two fades, absolutely over the scroller's bounds, in `surface`'s colour. The container must be `relative()`.
    pub fn overlay(&self, surface: Hsla) -> impl IntoElement + use<> {
        let fade = self.clone();
        canvas(
            |_, _, _| (),
            move |bounds, _, window, _| {
                let (more_up, more_down) = fade.edges();
                let now = Instant::now();
                let mut anim = fade.anim.get();
                let duration = super::scaled(DURATION_BASE);
                let (target_top, target_bottom) = (f32::from(u8::from(more_up)), f32::from(u8::from(more_down)));
                match anim.at {
                    // The first frame lands where it belongs: a list that opens scrolled does not fade in.
                    None => (anim.top, anim.bottom) = (target_top, target_bottom),
                    Some(_) if duration.is_zero() => (anim.top, anim.bottom) = (target_top, target_bottom),
                    Some(before) => {
                        let step = (now - before).as_secs_f32() / duration.as_secs_f32();
                        let toward = |now: f32, target: f32| if target > now { (now + step).min(target) } else { (now - step).max(target) };
                        (anim.top, anim.bottom) = (toward(anim.top, target_top), toward(anim.bottom, target_bottom));
                    }
                }
                anim.at = Some(now);
                fade.anim.set(anim);
                if anim.top != target_top || anim.bottom != target_bottom {
                    window.request_animation_frame();
                }
                let (top, bottom) = fade.strength();
                let stops =
                    |strength: f32| (linear_color_stop(surface.opacity(strength), 0.0), linear_color_stop(surface.opacity(0.0), 1.0));
                // Along the scroll axis: "leading" is the top or left edge, "trailing" the bottom or right one.
                let length = if fade.horizontal { bounds.size.width } else { bounds.size.height };
                let depth = px(fade.size).min(length / 2.0);
                let (lead_size, trail_origin) = if fade.horizontal {
                    (size(depth, bounds.size.height), point(bounds.right() - depth, bounds.origin.y))
                } else {
                    (size(bounds.size.width, depth), point(bounds.origin.x, bounds.bottom() - depth))
                };
                // CSS angles: 180 runs top to bottom, 90 left to right; the trailing edge runs the other way.
                let (lead_angle, trail_angle) = if fade.horizontal { (90.0, 270.0) } else { (180.0, 0.0) };
                if top > 0.0 {
                    let (from, to) = stops(top);
                    window.paint_quad(fill(Bounds::new(bounds.origin, lead_size), linear_gradient(lead_angle, from, to)));
                }
                if bottom > 0.0 {
                    let (from, to) = stops(bottom);
                    window.paint_quad(fill(Bounds::new(trail_origin, lead_size), linear_gradient(trail_angle, from, to)));
                }
            },
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full()
    }
}

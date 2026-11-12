//! [`Glass`]: frosted glass behind an element (CSS `backdrop-filter: blur()` over a translucent fill), the desktop's
//! `.status-pill` and composer glass.
//!
//! A layer placed as the **first child** of a `relative()` element: it fills the element's padding box and paints,
//! before the element's content, one quad marked for backdrop blur (`gpui_apple::backdrop_blur_marker`). Our patched
//! gpui-pre-apple (`vendor/PATCHES.md`) sees the mark, blurs what is already drawn behind the quad, then draws the quad
//! itself over it as the tint. Then an optional 1px edge and a brighter top edge. It takes no layout room.
//!
//! ```ignore
//! div().relative().rounded(RADIUS_WINDOW).child(Glass::surface(&theme, 0.62).radius(RADIUS_WINDOW)).child(content)
//! ```
//!
//! The blur needs the Metal renderer: the live window and headless snapshots have it; GPUI's test platform draws
//! nothing, so tests see the tint quad only. `MILAGRE_GPUI_GLASS=0` turns the blur off (tint only), for comparing.
//! Each glass surface on screen costs a copy, an MPS Gaussian and a pass per frame, so keep them few and small.

use gpui::{App, BorderStyle, Bounds, Corners, Edges, Hsla, IntoElement, Pixels, RenderOnce, Window, canvas, prelude::*, px};

use crate::theme::{Appearance, Theme};
use crate::ui::grain::CARD_STRENGTH;

/// The blur radius of every glass surface (CSS `blur(24px)`; the gaussian's sigma, in points).
pub const GLASS_BLUR: Pixels = px(24.0);
/// The composer's tint: the surface at 62%, so text behind reads soft but the box still reads as a box.
pub const GLASS_COMPOSER_FILL: f32 = 0.62;
/// The pills' tint: `.status-pill`'s own mix, the surface at 68%.
pub const GLASS_PILL_FILL: f32 = 0.68;
/// Film grain over the glass tint, as strong as the Chat card's: the baked texture's specks reach 18/255 alpha
/// (`tools/gen-grain.mjs`) and the card shows them at [`CARD_STRENGTH`], so the glass reads as the same grained
/// surface as the card around it, and the grain hides what the dither leaves of the blur's steps. The renderer draws
/// it per device pixel, fixed to the window like the tiled texture.
pub const GLASS_GRAIN: f32 = 18.0 / 255.0 * CARD_STRENGTH;
/// The light edge in dark: ink at 10%, and 18% along the top.
const DARK_EDGE: f32 = 0.10;
const DARK_TOP: f32 = 0.18;
/// The edge in light: ink at 9%; the top is the (white) surface itself, a lit rim.
const LIGHT_EDGE: f32 = 0.09;

thread_local! {
    static BLUR_ON: bool = std::env::var("MILAGRE_GPUI_GLASS").map_or(true, |value| value != "0");
}

/// Whether the backdrop blur is on (`MILAGRE_GPUI_GLASS=0` turns it off, leaving the tint).
pub fn blur_enabled() -> bool {
    BLUR_ON.with(|on| *on)
}

#[derive(IntoElement, Clone, Copy, Debug, PartialEq)]
pub struct Glass {
    blur: Pixels,
    tint: Hsla,
    radius: Pixels,
    edge: Option<Hsla>,
    top_edge: Option<Hsla>,
    outset: bool,
    /// Grain specks' peak alpha over the tint: positive for white specks, negative for black (0: none).
    grain: f32,
}

impl Glass {
    /// `blur` points of backdrop blur under a `tint`. Square corners, no edge.
    pub fn new(blur: Pixels, tint: impl Into<Hsla>) -> Self {
        Self { blur, tint: tint.into(), radius: px(0.0), edge: None, top_edge: None, outset: false, grain: 0.0 }
    }

    /// The app's glass: [`GLASS_BLUR`] under the theme's `surface` at `fill`, with the appearance's light edge and
    /// the card's grain.
    pub fn surface(theme: &Theme, fill: f32) -> Self {
        let ink = Hsla::from(theme.ink);
        let (edge, top) = match theme.appearance {
            Appearance::Dark => (ink.opacity(DARK_EDGE), ink.opacity(DARK_TOP)),
            Appearance::Light => (ink.opacity(LIGHT_EDGE), Hsla::from(theme.surface)),
        };
        Self::new(GLASS_BLUR, Hsla::from(theme.surface).opacity(fill)).edge(edge).top_edge(top).grain(theme.appearance, GLASS_GRAIN)
    }

    /// Film grain over the tint, specks up to `alpha`: white over the dark theme, black over the light one, like the
    /// app's grain texture. Drawn by the renderer with the blur, so it needs the blur on.
    pub fn grain(mut self, appearance: Appearance, alpha: f32) -> Self {
        self.grain = match appearance {
            Appearance::Dark => alpha,
            Appearance::Light => -alpha,
        };
        self
    }

    /// The corner radius (clamped to half the shorter side, so a large value makes a capsule).
    pub fn radius(mut self, radius: Pixels) -> Self {
        self.radius = radius;
        self
    }

    /// A 1px edge around the glass, inside its bounds.
    pub fn edge(mut self, color: impl Into<Hsla>) -> Self {
        self.edge = Some(color.into());
        self
    }

    /// No edge.
    pub fn no_edge(mut self) -> Self {
        self.edge = None;
        self.top_edge = None;
        self
    }

    /// A brighter 1px top edge over the edge (it thins out around the top corners).
    pub fn top_edge(mut self, color: impl Into<Hsla>) -> Self {
        self.top_edge = Some(color.into());
        self
    }

    /// The edges sit 1px outside the bounds (a ring, like a 1px spread shadow), not inside.
    pub fn outset(mut self) -> Self {
        self.outset = true;
        self
    }

    /// The backdrop blur in points (0: tint only).
    pub fn blur(mut self, blur: Pixels) -> Self {
        self.blur = blur;
        self
    }

    /// Paints the glass in `bounds`. For elements that paint themselves; [`Glass`] as a child calls this.
    pub fn paint(&self, bounds: Bounds<Pixels>, window: &mut Window) {
        let radius = |bounds: Bounds<Pixels>| Corners::all(self.radius.min(bounds.size.width.min(bounds.size.height) / 2.0));
        let sigma = if blur_enabled() { f32::from(self.blur) * window.scale_factor() } else { 0.0 };
        // The marked quad must not be fully transparent (GPUI would split it into border strips).
        let mut tint = self.tint;
        if sigma > 0.0 && tint.a <= 0.0 {
            tint.a = 1.0 / 255.0;
        }
        window.paint_quad(gpui::quad(bounds, radius(bounds), tint, Edges::default(), marker(sigma, self.grain), BorderStyle::default()));
        let ring = if self.outset { bounds.dilate(px(1.0)) } else { bounds };
        let clear = Hsla::transparent_black();
        if let Some(edge) = self.edge {
            window.paint_quad(gpui::quad(ring, radius(ring), clear, Edges::all(px(1.0)), edge, BorderStyle::default()));
        }
        if let Some(top) = self.top_edge {
            let widths = Edges { top: px(1.0), ..Edges::default() };
            window.paint_quad(gpui::quad(ring, radius(ring), clear, widths, top, BorderStyle::default()));
        }
    }
}

/// The border colour that asks the renderer for `sigma` device pixels of blur (and `grain`, see [`Glass::grain`]), or a
/// plain transparent one for none.
fn marker(sigma: f32, grain: f32) -> Hsla {
    #[cfg(target_os = "macos")]
    if sigma > 0.0 {
        return gpui_apple::backdrop_blur_marker_grained(sigma, grain);
    }
    let _ = (sigma, grain);
    Hsla::transparent_black()
}

impl RenderOnce for Glass {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        canvas(|_, _, _| (), move |bounds, _, window, _| self.paint(bounds, window)).absolute().top_0().left_0().size_full()
    }
}

//! Film grain: a static noise texture tiled over a surface (the window's one surface under the sidebar, the top row
//! and the panel, as in Victor's reference video).
//!
//! The texture is `assets/grain/` (`tools/gen-grain.mjs`): 256 px of per-pixel noise drawn as a 128pt tile, so one
//! speck is one device pixel on a Retina display. Its strength is baked into the PNG's alpha (0 to 7 %, about 3.5 % on
//! average), white specks over the dark theme and black over the light one, so it lightens on dark and darkens on
//! light by the same amount. [`GrainView`] is a view of its own: mount it cached, absolutely over its surface's fill
//! and under the content, and it renders once (again only when the theme changes) and never on hover or scroll.

use gpui::{App, Context, ImgResourceLoader, IntoElement, Render, Resource, Window, div, img, prelude::*, px};

use crate::theme::{ActiveTheme, Appearance};

/// One tile, in points.
pub const GRAIN_TILE: f32 = 128.0;
/// The most tiles the view draws across or down (a 8192pt surface), so a runaway viewport cannot build a huge tree.
const MAX_TILES: usize = 64;

/// How many tiles cover `length` points (the view clips the rest).
fn tiles_for(length: f32) -> usize {
    ((length / GRAIN_TILE).ceil().max(1.0) as usize).min(MAX_TILES)
}

/// How much of the baked texture shows: Victor asked for a quieter grain than the reference.
pub const STRENGTH: f32 = 0.5;
/// Inside the Chat card the grain matches the surface outside it: Victor first asked for 1.5 to 2 times, then for
/// less noise inside the Chat (2026-11-12).
pub const CARD_STRENGTH: f32 = STRENGTH;

const LIGHT_SPECKS: &str = "grain/grain-light.png";
const DARK_SPECKS: &str = "grain/grain-dark.png";

/// The texture for an appearance: light specks on dark, dark specks on light.
fn texture(appearance: Appearance) -> &'static str {
    match appearance {
        Appearance::Dark => LIGHT_SPECKS,
        Appearance::Light => DARK_SPECKS,
    }
}

/// The texture's mean strength once baked alpha (about 3.5 %) and `strength` are applied.
fn mean_speck(strength: f32) -> f32 {
    0.035 * strength
}

fn grained_at(surface: gpui::Rgba, appearance: Appearance, strength: f32) -> gpui::Hsla {
    let a = mean_speck(strength);
    let speck = match appearance {
        Appearance::Dark => gpui::Rgba { r: 1.0, g: 1.0, b: 1.0, a },
        Appearance::Light => gpui::Rgba { r: 0.0, g: 0.0, b: 0.0, a },
    };
    gpui::Hsla::from(surface).blend(gpui::Hsla::from(speck))
}

/// `surface` as it looks with the grain on it, on average: the colour for an edge fade that covers the grain at its
/// opaque end, so the faded band does not read as a flat patch next to the grained surface around it.
pub fn grained(surface: gpui::Rgba, appearance: Appearance) -> gpui::Hsla {
    grained_at(surface, appearance, STRENGTH)
}

/// [`grained`] for a surface inside the Chat card (`page`), where the grain is [`CARD_STRENGTH`].
pub fn grained_card(surface: gpui::Rgba, appearance: Appearance) -> gpui::Hsla {
    grained_at(surface, appearance, CARD_STRENGTH)
}

/// Starts decoding both textures (see `preload_logos`); whether both are ready.
pub fn preload_grain(cx: &mut App) -> bool {
    [LIGHT_SPECKS, DARK_SPECKS].iter().all(|path| cx.fetch_asset::<ImgResourceLoader>(&Resource::Embedded((*path).into())).is_some())
}

/// The grain over a surface. Mount it with `AnyView::from(view).cached(..)` at the surface's size, absolutely.
pub struct GrainView {
    renders: usize,
    /// The debug selector, so tests can find it.
    selector: &'static str,
    /// How much of the baked texture shows.
    strength: f32,
}

impl GrainView {
    pub fn new() -> Self {
        Self::named("grain")
    }

    pub fn named(selector: &'static str) -> Self {
        Self { renders: 0, selector, strength: STRENGTH }
    }

    /// The grain inside the Chat card: [`CARD_STRENGTH`].
    pub fn card() -> Self {
        Self { renders: 0, selector: "card-grain", strength: CARD_STRENGTH }
    }

    /// How many times it has rendered (tests: hovering and scrolling the sidebar must not render it).
    pub fn renders(&self) -> usize {
        self.renders
    }
}

impl Default for GrainView {
    fn default() -> Self {
        Self::new()
    }
}

impl Render for GrainView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.renders += 1;
        // It tiles over the whole window, whatever its size: the cached view renders again when its bounds change.
        let viewport = window.viewport_size();
        let (columns, rows) = (tiles_for(f32::from(viewport.width)), tiles_for(f32::from(viewport.height)));
        let path = texture(cx.theme().appearance);
        let (selector, strength) = (self.selector, self.strength);
        div().debug_selector(move || selector.into()).size_full().overflow_hidden().opacity(strength).flex().flex_col().children(
            (0..rows).map(|_| div().flex().flex_none().children((0..columns).map(|_| img(path).flex_none().size(px(GRAIN_TILE))))),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tiles_cover_any_width_up_to_the_cap() {
        for width in [1.0_f32, 127.0, 128.0, 1440.0, 1536.0, 1537.0, 3000.0, 3840.0] {
            assert!(tiles_for(width) as f32 * GRAIN_TILE >= width, "{width}pt is covered");
        }
        assert_eq!(tiles_for(1.0e9), MAX_TILES);
    }
}

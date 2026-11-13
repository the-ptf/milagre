//! [`ProviderLogo`]: each agent's brand mark (Claude, Codex, Antigravity, Kiro), the shapes the desktop's
//! `ProviderLogo.tsx` draws from `packages/shared/src/provider-logos.ts`.
//!
//! By default the mark is drawn in its brand colours (gradient and blurred blobs included) as an image;
//! `.mono(color)` draws the one-colour outline in `color`, for controls such as the model picker's rail.

use gpui::{App, Hsla, ImgResourceLoader, IntoElement, ObjectFit, RenderOnce, Resource, StyledImage, Window, img, prelude::*, px, svg};

use crate::data::Provider;
use crate::theme::ActiveTheme;

#[derive(IntoElement)]
pub struct ProviderLogo {
    provider: Provider,
    size: f32,
    mono: Option<Hsla>,
}

impl ProviderLogo {
    /// A 16px mark in its brand colours.
    pub fn new(provider: Provider) -> Self {
        Self { provider, size: 16.0, mono: None }
    }

    /// The mark's box in px (the desktop uses 12 to 24).
    pub fn size(mut self, size: f32) -> Self {
        self.size = size;
        self
    }

    /// The one-colour mark in `color` instead of the brand colours.
    pub fn mono(mut self, color: impl Into<Hsla>) -> Self {
        self.mono = Some(color.into());
        self
    }
}

impl Provider {
    /// The brand-colour mark, drawn with `img()`.
    pub fn logo_path(self) -> &'static str {
        match self {
            Provider::Claude => "logos/claude.svg",
            Provider::Codex => "logos/codex.svg",
            Provider::Antigravity => "logos/antigravity.svg",
            Provider::Kiro => "logos/kiro.svg",
        }
    }

    /// The one-colour mark, drawn with `svg()` in the text colour.
    pub fn mono_logo_path(self) -> &'static str {
        match self {
            Provider::Claude => "logos/claude-mono.svg",
            Provider::Codex => "logos/codex-mono.svg",
            Provider::Antigravity => "logos/antigravity-mono.svg",
            Provider::Kiro => "logos/kiro-mono.svg",
        }
    }
}

impl RenderOnce for ProviderLogo {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let size = px(self.size);
        // Settings › Appearance › Provider icons "Simplified": the one-colour mark in the surrounding text colour
        // (`providerIcons === "simplified"` in `ProviderLogo.tsx`).
        if self.mono.is_none() && crate::theme::live::simplified_icons() {
            // `ink-2`, the colour of the controls and rows that hold a mark.
            let color = cx.theme().ink2;
            return svg().path(self.provider.mono_logo_path()).flex_none().size(size).text_color(color).into_any_element();
        }
        match self.mono {
            Some(color) => svg().path(self.provider.mono_logo_path()).flex_none().size(size).text_color(color).into_any_element(),
            // Decoded once by GPUI's image cache (resvg keeps the gradient, mask and blur filters).
            None => img(self.provider.logo_path()).flex_none().size(size).object_fit(ObjectFit::Contain).into_any_element(),
        }
    }
}

/// Starts decoding every brand mark, so the first frame that shows one already has it (an `img()` that is
/// still loading draws nothing until its view renders again). Returns whether all are decoded; call it again
/// to poll. `app::init` calls it; snapshot mode waits for it, because a window nobody can see gets no more
/// frames after its first ones (gpui-pre stops the display link of an occluded window). The sidebar's grain
/// (`ui::grain`) is waited for with them.
pub fn preload_logos(cx: &mut App) -> bool {
    let grain = super::grain::preload_grain(cx);
    let logos = Provider::ALL
        .iter()
        .all(|provider| cx.fetch_asset::<ImgResourceLoader>(&Resource::Embedded(provider.logo_path().into())).is_some());
    grain && logos
}

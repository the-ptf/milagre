//! [`Icon`]: a Hugeicons glyph on DESIGN.md's icon scale, drawn in one colour.
//!
//! ```ignore
//! Icon::new(IconName::Search01).size(IconSize::S16).color(theme.ink3)
//! ```
//!
//! Sizes and strokes follow DESIGN.md "Icons" (and the desktop's `Icon.tsx`): 12 → 1.6, 14 → 1.8, 16 → 1.8,
//! 18 → 2, in the glyph's 24-unit viewBox. Without `.color(...)` an icon is `ink-3`, the colour of a desktop
//! control glyph at rest. To add a glyph, add its Hugeicons name to `tools/gen-icons.mjs` and run it.

use gpui::{App, Hsla, IntoElement, RenderOnce, Window, prelude::*, px, svg};

use super::icon_name::ICONS;
pub use super::icon_name::IconName;
use crate::theme::ActiveTheme;

/// The four desktop icon sizes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum IconSize {
    /// Inside 20px marks and inline with captions.
    S12,
    /// Inside 28px chips, menu rows, panel tabs.
    S14,
    /// Window chrome, buttons, rows.
    #[default]
    S16,
    /// Large controls, the provider rail.
    S18,
}

impl IconSize {
    pub const ALL: [IconSize; 4] = [IconSize::S12, IconSize::S14, IconSize::S16, IconSize::S18];

    /// The icon's box, in px.
    pub const fn px(self) -> f32 {
        match self {
            IconSize::S12 => 12.0,
            IconSize::S14 => 14.0,
            IconSize::S16 => 16.0,
            IconSize::S18 => 18.0,
        }
    }

    /// The stroke width in the glyph's 24-unit viewBox (at 16px, 1.8 draws 1.2px).
    pub const fn stroke(self) -> f32 {
        match self {
            IconSize::S12 => 1.6,
            IconSize::S14 | IconSize::S16 => 1.8,
            IconSize::S18 => 2.0,
        }
    }

    const fn variant(self) -> usize {
        match self {
            IconSize::S12 => 0,
            IconSize::S14 | IconSize::S16 => 1,
            IconSize::S18 => 2,
        }
    }
}

impl IconName {
    /// Every generated icon, in the order `tools/gen-icons.mjs` lists them.
    pub fn all() -> impl Iterator<Item = IconName> {
        ICONS.iter().map(|(name, _, _)| *name)
    }

    /// The asset path that draws this glyph at `size`'s stroke (see `src/assets`).
    pub fn path(self, size: IconSize) -> &'static str {
        ICONS[self as usize].2[size.variant()]
    }

    /// The Hugeicons export name without its `Icon` suffix, as the desktop code imports it.
    pub fn hugeicons_name(self) -> &'static str {
        ICONS[self as usize].1
    }
}

/// A Hugeicons glyph. Decorative: name the control around it, not the icon.
#[derive(IntoElement)]
pub struct Icon {
    name: IconName,
    size: IconSize,
    color: Option<Hsla>,
}

impl Icon {
    pub fn new(name: IconName) -> Self {
        Self { name, size: IconSize::default(), color: None }
    }

    pub fn size(mut self, size: IconSize) -> Self {
        self.size = size;
        self
    }

    pub fn color(mut self, color: impl Into<Hsla>) -> Self {
        self.color = Some(color.into());
        self
    }
}

impl RenderOnce for Icon {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        // GPUI's `svg()` paints only with a colour set on the element itself; it does not inherit one.
        let color = self.color.unwrap_or_else(|| cx.theme().ink3.into());
        svg().path(self.name.path(self.size)).flex_none().size(px(self.size.px())).text_color(color)
    }
}

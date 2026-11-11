//! [`SectionLabel`] and [`ProjectAvatar`].

use gpui::{App, FontWeight, IntoElement, RenderOnce, Rgba, SharedString, Window, div, prelude::*, px};

use crate::theme::{ActiveTheme, TEXT_10, TEXT_11, TEXT_12, TEXT_15, TextStepExt, project_avatar_radius};

/// The label over a group of rows (DESIGN.md "Type"): sentence case, no tracking, medium `ink-3`; 12px
/// over a page or panel section, 11px inside a menu or picker. Write the text in sentence case; nothing
/// here uppercases it.
#[derive(IntoElement)]
pub struct SectionLabel {
    text: SharedString,
    menu: bool,
}

impl SectionLabel {
    pub fn new(text: impl Into<SharedString>) -> Self {
        Self { text: text.into(), menu: false }
    }

    /// The 11px label inside a menu or picker.
    pub fn menu(mut self) -> Self {
        self.menu = true;
        self
    }
}

impl RenderOnce for SectionLabel {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        div()
            .text_step(if self.menu { TEXT_11 } else { TEXT_12 })
            .font_weight(FontWeight::MEDIUM)
            .text_color(cx.theme().ink3)
            .child(self.text)
    }
}

/// A Project's tile (DESIGN.md "Radius": project tiles, the desktop's `ProjectAvatar`): a rounded square
/// with the Project's initial at 600. Sizes 16, 20 and 24 letter at 10px, 40 at 15px; the radius follows
/// `projectAvatarRadius`. DESIGN.md's tile is an ink fill with an on-ink initial; `.colors(..)` gives a
/// Project its own fill (an identity colour, the stand-in for its image).
#[derive(IntoElement)]
pub struct ProjectAvatar {
    initial: char,
    size: f32,
    colors: Option<(Rgba, Rgba)>,
}

impl ProjectAvatar {
    pub fn new(name: &str) -> Self {
        let initial = name.chars().find(|c| c.is_alphanumeric()).map_or('?', |c| c.to_ascii_uppercase());
        Self { initial, size: 20.0, colors: None }
    }

    /// 16, 20, 24 or 40.
    pub fn size(mut self, size: f32) -> Self {
        self.size = size;
        self
    }

    /// The tile's fill and its letter's colour, instead of ink and on-ink.
    pub fn colors(mut self, fill: Rgba, ink: Rgba) -> Self {
        self.colors = Some((fill, ink));
        self
    }
}

impl RenderOnce for ProjectAvatar {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = cx.theme();
        let (fill, ink) = self.colors.unwrap_or((theme.ink, theme.on_ink));
        div()
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .overflow_hidden()
            .size(px(self.size))
            .rounded(project_avatar_radius(self.size))
            .bg(fill)
            .text_color(ink)
            .text_step(if self.size >= 32.0 { TEXT_15 } else { TEXT_10 })
            .font_weight(FontWeight::SEMIBOLD)
            .child(SharedString::from(self.initial.to_string()))
    }
}

//! Fonts and the desktop type scale (DESIGN.md "Type").
//!
//! Text uses the system UI font; chrome text uses weights 500 or 600 only. Code uses the system's
//! monospaced UI font (SF Mono), which macOS exposes to apps only under a private family name: see
//! [`MONO`].

use std::sync::OnceLock;

use gpui::{App, FontFeatures, Styled, font, px};

/// GPUI's name for the platform UI font (SF Pro on macOS; `.AppleSystemUIFont` underneath).
pub const SANS: &str = ".SystemUIFont";

/// The system's monospaced UI font, SF Mono: what CSS `ui-monospace` gives the Electron app.
///
/// `SF Mono` is not a family name apps can load (`NSFontManager` lists only Andale Mono, Menlo and PT
/// Mono), but CoreText resolves the private family `.AppleSystemUIFontMonospaced` to it: every glyph has
/// the same advance (1266 units: SF Mono), unlike Menlo (1233). It is the system's own copy, so nothing is
/// bundled (Apple's licence does not allow shipping SF Mono). Views call [`mono`], which falls back to
/// [`MONO_FALLBACK`] if a future macOS stops resolving the name ([`init_fonts`] checks once at startup).
pub const MONO: &str = ".AppleSystemUIFontMonospaced";
/// Menlo ships with every macOS and is what the phone uses for code.
pub const MONO_FALLBACK: &str = "Menlo";

/// The OpenType features the desktop's `body` sets (`font-feature-settings: "cv11", "ss01"`): SF Pro's straight-sided
/// six and nine (`ss01`), and Inter's single-storey a and open digits when Settings › Appearance picks Inter.
pub const UI_FEATURES: [&str; 2] = ["cv11", "ss01"];

/// [`UI_FEATURES`] as GPUI takes them, for the root of a window's text (it inherits like the desktop's `body`).
pub fn ui_features() -> FontFeatures {
    FontFeatures(std::sync::Arc::new(UI_FEATURES.iter().map(|tag| ((*tag).to_string(), 1)).collect()))
}

static MONO_FAMILY: OnceLock<&'static str> = OnceLock::new();

/// The code font family to use: [`MONO`], or [`MONO_FALLBACK`] when the system did not resolve it.
pub fn mono() -> &'static str {
    super::live::chosen_mono().unwrap_or_else(|| MONO_FAMILY.get().copied().unwrap_or(MONO))
}

/// The UI families whose Bold (700) draws Semibold (600): the desktop never draws 700 (DESIGN.md "Type"), while
/// gpui-component's markdown asks for Bold for `**strong**`, which the desktop draws at 600 (`.markdown strong`). The
/// code fonts keep their Bold (the Terminal's).
pub const BOLD_AS_SEMIBOLD: [&str; 4] = [SANS, ".AppleSystemUIFont", "Inter", "Geist"];

/// Checks once that the platform text system resolves [`MONO`] and sets the UI fonts' Bold; called from `app::init`.
pub fn init_fonts(cx: &App) {
    #[cfg(target_os = "macos")]
    gpui_apple::set_bold_alias(gpui::FontWeight::SEMIBOLD, BOLD_AS_SEMIBOLD.iter().map(|f| gpui::SharedString::from(*f)).collect());
    // `resolve_font` falls back to the default stack when a family fails; only a direct hit maps back to it.
    let text = cx.text_system();
    let resolved = text.get_font_for_id(text.resolve_font(&font(MONO)));
    let family = if resolved.is_some_and(|f| f.family.as_ref() == MONO) { MONO } else { MONO_FALLBACK };
    MONO_FAMILY.get_or_init(|| family);
}

/// A size on the desktop type scale with its line height, both in px.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TextStep {
    pub size: f32,
    pub line_height: f32,
}

/// Display (Onboarding).
pub const TEXT_26: TextStep = TextStep { size: 26.0, line_height: 32.0 };
/// Page title (DESIGN.md adds -0.02em letter-spacing; GPUI has no letter-spacing style).
pub const TEXT_22: TextStep = TextStep { size: 22.0, line_height: 28.0 };
/// Dialog title.
pub const TEXT_17: TextStep = TextStep { size: 17.0, line_height: 24.0 };
/// Section and card title.
pub const TEXT_15: TextStep = TextStep { size: 15.0, line_height: 20.0 };
/// Body UI, rows, buttons.
pub const TEXT_13: TextStep = TextStep { size: 13.0, line_height: 18.0 };
/// Secondary text, small buttons.
pub const TEXT_12: TextStep = TextStep { size: 12.0, line_height: 16.0 };
/// Caption, metadata, time.
pub const TEXT_11: TextStep = TextStep { size: 11.0, line_height: 16.0 };
/// Badges only.
pub const TEXT_10: TextStep = TextStep { size: 10.0, line_height: 14.0 };

/// Every step, largest first, for tests and specimens.
pub const TEXT_STEPS: [(&str, TextStep); 8] = [
    ("text-26", TEXT_26),
    ("text-22", TEXT_22),
    ("text-17", TEXT_17),
    ("text-15", TEXT_15),
    ("text-13", TEXT_13),
    ("text-12", TEXT_12),
    ("text-11", TEXT_11),
    ("text-10", TEXT_10),
];

/// Chat text: 14px at line height 1.6 (DESIGN.md, `--chat-size`, user-scaled in the real app).
pub const CHAT_TEXT: TextStep = TextStep { size: 14.0, line_height: 14.0 * 1.6 };
/// Code blocks and the approval command: mono 12/18.
pub const CODE_TEXT: TextStep = TextStep { size: 12.0, line_height: 18.0 };

/// Applies a [`TextStep`] (size and line height) to any styled element. Named so it does not clash with
/// `gpui::StyledText`.
pub trait TextStepExt: Styled + Sized {
    fn text_step(self, step: TextStep) -> Self {
        self.text_size(px(step.size)).line_height(px(step.line_height))
    }
}

impl<E: Styled> TextStepExt for E {}

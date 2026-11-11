//! Milagre Blue theme tokens, type scale, radii and control heights.
//!
//! Values come from the token tables in the repository's `DESIGN.md` (Colour: Surfaces, Ink, Accent,
//! Status; Type: Desktop; Radius; Sizes). Hex strings are kept exactly as written there, alpha included,
//! so a reviewer can diff this file against the tables by eye.
//!
//! Views read the active theme through [`ActiveTheme::theme`] on any GPUI context:
//!
//! ```ignore
//! let theme = cx.theme();
//! div().bg(theme.canvas).text_color(theme.ink3)
//! ```

use gpui::{App, Global, Pixels, Rgba, Styled, px};

/// One theme's colour tokens. Field names are the DESIGN.md token names in snake case
/// (`hover-2` is `hover2`, `ink-3` is `ink3`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Theme {
    pub appearance: Appearance,
    // Surfaces
    pub page: Rgba,
    pub canvas: Rgba,
    pub surface: Rgba,
    pub inset: Rgba,
    pub field: Rgba,
    pub hover: Rgba,
    pub hover2: Rgba,
    pub line: Rgba,
    pub line_strong: Rgba,
    // Ink
    pub ink: Rgba,
    pub ink2: Rgba,
    pub ink3: Rgba,
    pub ink4: Rgba,
    /// A label on an ink fill. DESIGN.md: "`on-ink` (the surface)"; desktop CSS maps it to `--surface`.
    pub on_ink: Rgba,
    // Accent
    pub accent: Rgba,
    pub accent_ink: Rgba,
    pub accent_tint: Rgba,
    pub on_accent: Rgba,
    // Status
    pub green: Rgba,
    pub green_ink: Rgba,
    pub green_tint: Rgba,
    pub orange: Rgba,
    pub orange_ink: Rgba,
    pub orange_tint: Rgba,
    pub red: Rgba,
    pub red_ink: Rgba,
    pub red_tint: Rgba,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Appearance {
    Light,
    Dark,
}

impl Global for Theme {}

impl Theme {
    /// Milagre Blue, dark column.
    pub const fn dark() -> Self {
        Self {
            appearance: Appearance::Dark,
            page: hex("#0d1624"),
            canvas: hex("#111b29"),
            surface: hex("#172232"),
            inset: hex("#121c2b"),
            field: hex("#212c3c"),
            hover: hex("#e9eff70d"),
            hover2: hex("#e9eff717"),
            line: hex("#273242"),
            line_strong: hex("#303b4a"),
            ink: hex("#e9eff7"),
            ink2: hex("#abb2bd"),
            ink3: hex("#939ca9"),
            ink4: hex("#646c79"),
            on_ink: hex("#172232"),
            accent: hex("#3e9afd"),
            accent_ink: hex("#80b9fd"),
            accent_tint: hex("#3e9afd29"),
            on_accent: hex("#0d1624"),
            green: hex("#3cbb72"),
            green_ink: hex("#3cbb72"),
            green_tint: hex("#3cbb7224"),
            orange: hex("#f68f3c"),
            orange_ink: hex("#f68f3c"),
            orange_tint: hex("#f68f3c24"),
            red: hex("#ee5c61"),
            red_ink: hex("#fd696d"),
            red_tint: hex("#ee5c6124"),
        }
    }

    /// Milagre Blue, light column.
    pub const fn light() -> Self {
        Self {
            appearance: Appearance::Light,
            page: hex("#f4f9fe"),
            canvas: hex("#e9f1fa"),
            surface: hex("#ffffff"),
            inset: hex("#f9fcff"),
            field: hex("#e8edf2"),
            hover: hex("#1c222b0f"),
            hover2: hex("#1c222b1a"),
            line: hex("#edeeee"),
            line_strong: hex("#e0e1e3"),
            ink: hex("#1c222b"),
            ink2: hex("#4b515a"),
            ink3: hex("#60656d"),
            ink4: hex("#8c929a"),
            on_ink: hex("#ffffff"),
            accent: hex("#007df3"),
            accent_ink: hex("#0068cd"),
            accent_tint: hex("#e3f0fe"),
            on_accent: hex("#ffffff"),
            green: hex("#199a4d"),
            green_ink: hex("#00792e"),
            green_tint: hex("#e5f2ef"),
            orange: hex("#ef720d"),
            orange_ink: hex("#ba4100"),
            orange_tint: hex("#f5efee"),
            red: hex("#e3474c"),
            red_ink: hex("#c62935"),
            red_tint: hex("#f5ecef"),
        }
    }

    /// Dark unless `MILAGRE_GPUI_THEME=light`. Stand-in for following the system appearance.
    pub fn from_env() -> Self {
        match std::env::var("MILAGRE_GPUI_THEME").as_deref() {
            Ok("light") => Self::light(),
            _ => Self::dark(),
        }
    }
}

/// Read the theme global from any GPUI context (`App`, `Context<V>`, ...).
pub trait ActiveTheme {
    fn theme(&self) -> &Theme;
}

impl ActiveTheme for App {
    fn theme(&self) -> &Theme {
        self.global::<Theme>()
    }
}

/// Parses `#rrggbb` or `#rrggbbaa` at compile time. A malformed literal fails the build.
pub const fn hex(s: &str) -> Rgba {
    let b = s.as_bytes();
    assert!(b.len() == 7 || b.len() == 9, "colour must be #rrggbb or #rrggbbaa");
    assert!(b[0] == b'#', "colour must start with #");
    let a = if b.len() == 9 { byte(b, 7) } else { 255 };
    Rgba { r: byte(b, 1) as f32 / 255.0, g: byte(b, 3) as f32 / 255.0, b: byte(b, 5) as f32 / 255.0, a: a as f32 / 255.0 }
}

const fn byte(b: &[u8], at: usize) -> u8 {
    nibble(b[at]) * 16 + nibble(b[at + 1])
}

const fn nibble(c: u8) -> u8 {
    match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        b'A'..=b'F' => c - b'A' + 10,
        _ => panic!("colour has a non-hex digit"),
    }
}

/// Formats a colour the way DESIGN.md writes it: `#rrggbb`, or `#rrggbbaa` when it is translucent.
pub fn to_hex(c: Rgba) -> String {
    let ch = |v: f32| (v * 255.0).round() as u8;
    let (r, g, b, a) = (ch(c.r), ch(c.g), ch(c.b), ch(c.a));
    if a == 255 { format!("#{r:02x}{g:02x}{b:02x}") } else { format!("#{r:02x}{g:02x}{b:02x}{a:02x}") }
}

// Type scale (DESIGN.md, Type: Desktop). Text uses the system UI font; chrome text uses 500 or 600 only.

/// A size on the desktop type scale with its line height, both in px.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TextStep {
    pub size: f32,
    pub line_height: f32,
}

/// Badges only.
pub const TEXT_10: TextStep = TextStep { size: 10.0, line_height: 14.0 };
/// Caption, metadata, time.
pub const TEXT_11: TextStep = TextStep { size: 11.0, line_height: 16.0 };
/// Secondary text, small buttons.
pub const TEXT_12: TextStep = TextStep { size: 12.0, line_height: 16.0 };
/// Body UI, rows, buttons.
pub const TEXT_13: TextStep = TextStep { size: 13.0, line_height: 18.0 };
/// Section and card title.
pub const TEXT_15: TextStep = TextStep { size: 15.0, line_height: 20.0 };
/// Dialog title.
pub const TEXT_17: TextStep = TextStep { size: 17.0, line_height: 24.0 };
/// Page title (DESIGN.md adds -0.02em letter-spacing; GPUI 0.2.2 has no letter-spacing style).
pub const TEXT_22: TextStep = TextStep { size: 22.0, line_height: 28.0 };

/// Applies a [`TextStep`] (size and line height) to any styled element.
pub trait StyledText: Styled + Sized {
    fn text_step(self, step: TextStep) -> Self {
        self.text_size(px(step.size)).line_height(px(step.line_height))
    }
}

impl<E: Styled> StyledText for E {}

// Radii (DESIGN.md, Radius: desktop).

/// Code, kbd, menu items.
pub const RADIUS_INLINE: Pixels = px(4.0);
/// Chips, tooltips; a 20 or 24px project tile.
pub const RADIUS_CHIP: Pixels = px(6.0);
/// Buttons, inputs, menus, option rows.
pub const RADIUS_CONTROL: Pixels = px(8.0);
/// Cards, popovers, toasts.
pub const RADIUS_CARD: Pixels = px(10.0);
/// Dialogs, the composer, panels, Settings.
pub const RADIUS_WINDOW: Pixels = px(14.0);

// Control heights (DESIGN.md, Sizes). Heights are fixed, never derived from padding.

/// Icon and extra-small buttons; the hit-area floor.
pub const CONTROL_XS: Pixels = px(24.0);
/// Small: composer chips, tabs, approval buttons.
pub const CONTROL_SM: Pixels = px(28.0);
/// Default: buttons, selects, rows.
pub const CONTROL_MD: Pixels = px(32.0);
/// Inputs.
pub const CONTROL_LG: Pixels = px(36.0);
/// Two-line list rows.
pub const ROW_TWO_LINE: Pixels = px(48.0);

/// Height of every column header (sidebar header with the traffic lights, Chat header, panel tab strip).
pub const HEADER_HEIGHT: Pixels = px(44.0);

#[cfg(test)]
mod tests {
    use super::*;

    /// The dark column of DESIGN.md's Surfaces, Ink, Accent and Status tables, copied by hand.
    #[test]
    fn dark_theme_matches_design_md() {
        let t = Theme::dark();
        let expected: &[(&str, Rgba, &str)] = &[
            ("page", t.page, "#0d1624"),
            ("canvas", t.canvas, "#111b29"),
            ("surface", t.surface, "#172232"),
            ("inset", t.inset, "#121c2b"),
            ("field", t.field, "#212c3c"),
            ("hover", t.hover, "#e9eff70d"),
            ("hover-2", t.hover2, "#e9eff717"),
            ("line", t.line, "#273242"),
            ("line-strong", t.line_strong, "#303b4a"),
            ("ink", t.ink, "#e9eff7"),
            ("ink-2", t.ink2, "#abb2bd"),
            ("ink-3", t.ink3, "#939ca9"),
            ("ink-4", t.ink4, "#646c79"),
            ("on-ink (= surface)", t.on_ink, "#172232"),
            ("accent", t.accent, "#3e9afd"),
            ("accent-ink", t.accent_ink, "#80b9fd"),
            ("accent-tint", t.accent_tint, "#3e9afd29"),
            ("on-accent", t.on_accent, "#0d1624"),
            ("green", t.green, "#3cbb72"),
            ("green-ink", t.green_ink, "#3cbb72"),
            ("green-tint", t.green_tint, "#3cbb7224"),
            ("orange", t.orange, "#f68f3c"),
            ("orange-ink", t.orange_ink, "#f68f3c"),
            ("orange-tint", t.orange_tint, "#f68f3c24"),
            ("red", t.red, "#ee5c61"),
            ("red-ink", t.red_ink, "#fd696d"),
            ("red-tint", t.red_tint, "#ee5c6124"),
        ];
        for (name, actual, want) in expected {
            assert_eq!(to_hex(*actual), *want, "dark `{name}`");
        }
        assert_eq!(t.on_ink, t.surface, "on-ink is the surface");
    }

    #[test]
    fn light_on_ink_is_surface() {
        let t = Theme::light();
        assert_eq!(to_hex(t.surface), "#ffffff");
        assert_eq!(t.on_ink, t.surface);
    }

    #[test]
    fn hex_keeps_alpha() {
        let c = hex("#e9eff70d");
        assert_eq!((c.a * 255.0).round() as u8, 0x0d);
        assert_eq!(to_hex(hex("#0D1624")), "#0d1624");
    }
}

//! Milagre Blue's colour tokens (DESIGN.md "Colour": Surfaces, Ink, Accent, Status, Ultracode, Diff).
//!
//! Hex strings are kept exactly as written in DESIGN.md, alpha included, so a reviewer can diff this file
//! against the tables by eye; `theme/tests.rs` checks every one against a hand-copied table.

use gpui::{App, Global, Rgba};

/// One theme's colour tokens. Field names are the DESIGN.md token names in snake case
/// (`hover-2` is `hover2`, `ink-3` is `ink3`, `diff-add-word` is `diff_add_word`).
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
    /// Behind a modal: black at 20% in light, 40% in dark (DESIGN.md, Colour).
    pub scrim: Rgba,
    // Accent
    pub accent: Rgba,
    pub accent_ink: Rgba,
    pub accent_tint: Rgba,
    pub on_accent: Rgba,
    // Status
    pub green: Rgba,
    pub green_ink: Rgba,
    pub green_tint: Rgba,
    pub on_green: Rgba,
    pub orange: Rgba,
    pub orange_ink: Rgba,
    pub orange_tint: Rgba,
    pub on_orange: Rgba,
    pub red: Rgba,
    pub red_ink: Rgba,
    pub red_tint: Rgba,
    pub on_red: Rgba,
    // Ultracode
    pub purple: Rgba,
    pub purple_ink: Rgba,
    pub purple_tint: Rgba,
    // Diff
    pub diff_add: Rgba,
    pub diff_add_word: Rgba,
    pub diff_remove: Rgba,
    pub diff_remove_word: Rgba,
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
            scrim: hex("#00000066"),
            accent: hex("#3e9afd"),
            accent_ink: hex("#80b9fd"),
            accent_tint: hex("#3e9afd29"),
            on_accent: hex("#0d1624"),
            green: hex("#3cbb72"),
            green_ink: hex("#3cbb72"),
            green_tint: hex("#3cbb7224"),
            on_green: hex("#0d1624"),
            orange: hex("#f68f3c"),
            orange_ink: hex("#f68f3c"),
            orange_tint: hex("#f68f3c24"),
            on_orange: hex("#0d1624"),
            red: hex("#ee5c61"),
            red_ink: hex("#fd696d"),
            red_tint: hex("#ee5c6124"),
            on_red: hex("#0d1624"),
            purple: hex("#ad46ff"),
            purple_ink: hex("#d0a3ff"),
            purple_tint: hex("#ad46ff2e"),
            diff_add: hex("#3cbb721f"),
            diff_add_word: hex("#3cbb724d"),
            diff_remove: hex("#ee5c611f"),
            diff_remove_word: hex("#ee5c614d"),
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
            scrim: hex("#00000033"),
            accent: hex("#007df3"),
            accent_ink: hex("#0068cd"),
            accent_tint: hex("#e3f0fe"),
            on_accent: hex("#ffffff"),
            green: hex("#199a4d"),
            green_ink: hex("#00792e"),
            green_tint: hex("#e5f2ef"),
            on_green: hex("#ffffff"),
            orange: hex("#ef720d"),
            orange_ink: hex("#ba4100"),
            orange_tint: hex("#f5efee"),
            on_orange: hex("#ffffff"),
            red: hex("#e3474c"),
            red_ink: hex("#c62935"),
            red_tint: hex("#f5ecef"),
            on_red: hex("#ffffff"),
            purple: hex("#ad46ff"),
            purple_ink: hex("#8e2bdc"),
            purple_tint: hex("#f6edff"),
            diff_add: hex("#ddeee8"),
            diff_add_word: hex("#bbddc8"),
            diff_remove: hex("#f6e9ec"),
            diff_remove_word: hex("#f7cecf"),
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

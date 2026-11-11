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
    // Code (`bg-inset border-line` on a code block in the desktop; the theme's own `inset` and `line`)
    pub code_bg: Rgba,
    pub code_border: Rgba,
    /// The Shiki `--shiki-*` variables of `theme-sheet.ts`: one colour per syntax kind.
    pub syntax: SyntaxColors,
    /// The Terminal's 16 ANSI colours, cursor and selection (`--ansi-*`, `cursor`, `selection` in `ThemePalette`).
    pub terminal: TerminalColors,
}

/// A theme's syntax colours (`ThemePalette.syntax`, kinds in `file-syntax.mjs`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SyntaxColors {
    pub plain: Rgba,
    pub comment: Rgba,
    pub keyword: Rgba,
    pub string: Rgba,
    pub number: Rgba,
    pub function: Rgba,
    pub type_: Rgba,
    pub tag: Rgba,
    pub property: Rgba,
    pub operator: Rgba,
    pub punctuation: Rgba,
}

/// A theme's Terminal colours: the 16 ANSI colours in xterm order (black .. white, then the bright row), the cursor
/// and the selection wash.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TerminalColors {
    pub ansi: [Rgba; 16],
    pub cursor: Rgba,
    pub selection: Rgba,
}

impl SyntaxColors {
    /// From the hex strings in `ThemePalette.syntax` order: plain, comment, keyword, string, number, function, type,
    /// tag, property, operator, punctuation.
    pub const fn from_hex(c: [&str; 11]) -> Self {
        Self {
            plain: hex(c[0]),
            comment: hex(c[1]),
            keyword: hex(c[2]),
            string: hex(c[3]),
            number: hex(c[4]),
            function: hex(c[5]),
            type_: hex(c[6]),
            tag: hex(c[7]),
            property: hex(c[8]),
            operator: hex(c[9]),
            punctuation: hex(c[10]),
        }
    }

    /// The colours in the same order as [`Self::from_hex`].
    pub fn all(&self) -> [Rgba; 11] {
        [
            self.plain,
            self.comment,
            self.keyword,
            self.string,
            self.number,
            self.function,
            self.type_,
            self.tag,
            self.property,
            self.operator,
            self.punctuation,
        ]
    }
}

impl TerminalColors {
    pub const fn from_hex(ansi: [&str; 16], cursor: &str, selection: &str) -> Self {
        let mut table = [hex("#000000"); 16];
        let mut i = 0;
        while i < 16 {
            table[i] = hex(ansi[i]);
            i += 1;
        }
        Self { ansi: table, cursor: hex(cursor), selection: hex(selection) }
    }
}

/// Milagre Blue's and Gray's terminal and code colours, light (`lightAnsi`, `lightSyntax` in `palettes/milagre.ts`).
const LIGHT_ANSI: [&str; 16] = [
    "#24292f", "#cf222e", "#116329", "#7d4e00", "#0969da", "#8250df", "#1b7c83", "#6e7781", "#57606a", "#a40e26", "#1a7f37", "#633c01",
    "#218bff", "#a475f9", "#3192aa", "#8c959f",
];
const LIGHT_SYNTAX: [&str; 11] =
    ["#24292e", "#6a737d", "#d73a49", "#032f62", "#005cc5", "#6f42c1", "#005cc5", "#22863a", "#005cc5", "#d73a49", "#24292e"];
/// `darkAnsi` and `darkSyntax`.
const DARK_ANSI: [&str; 16] = [
    "#484f58", "#ff7b72", "#3fb950", "#d29922", "#58a6ff", "#bc8cff", "#39c5cf", "#b1bac4", "#6e7681", "#ffa198", "#56d364", "#e3b341",
    "#79c0ff", "#d2a8ff", "#56d4dd", "#ffffff",
];
const DARK_SYNTAX: [&str; 11] =
    ["#e1e4e8", "#8b949e", "#f97583", "#9ecbff", "#79b8ff", "#b392f0", "#79b8ff", "#85e89d", "#79b8ff", "#f97583", "#e1e4e8"];

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
            code_bg: hex("#121c2b"),
            code_border: hex("#273242"),
            syntax: SyntaxColors::from_hex(DARK_SYNTAX),
            terminal: TerminalColors::from_hex(DARK_ANSI, "#e9eff7", "#3e9afd4d"),
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
            code_bg: hex("#f9fcff"),
            code_border: hex("#edeeee"),
            syntax: SyntaxColors::from_hex(LIGHT_SYNTAX),
            terminal: TerminalColors::from_hex(LIGHT_ANSI, "#1c222b", "#007df34d"),
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

//! A theme's colours: what an author writes ([`ThemeSource`]) and the full palette derived from it
//! ([`build_palette`], `packages/shared/src/themes/build.ts`), including the 16 ANSI colours and the syntax colours the
//! Terminal and the code views read (`ansi()` and `syntax()` in `build.ts`).

use gpui::Rgba;

use super::color::{contrast_ratio, mix, on_color, over, readable_on, with_alpha};
use crate::theme::{Appearance, SyntaxColors, TerminalColors, Theme, hex};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scheme {
    Light,
    Dark,
}

impl Scheme {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Light => "light",
            Self::Dark => "dark",
        }
    }

    pub fn appearance(self) -> Appearance {
        match self {
            Self::Light => Appearance::Light,
            Self::Dark => Appearance::Dark,
        }
    }
}

/// Palette keys an author may give instead of deriving them.
#[derive(Clone, Debug, Default)]
pub struct Overrides {
    pub canvas: Option<String>,
    pub inset: Option<String>,
    pub field: Option<String>,
    pub ink2: Option<String>,
    pub ink3: Option<String>,
    pub on_accent: Option<String>,
    pub line: Option<String>,
    pub line_strong: Option<String>,
    pub accent_ink: Option<String>,
    pub accent_tint: Option<String>,
    pub green_tint: Option<String>,
    pub orange_tint: Option<String>,
    pub red_tint: Option<String>,
    pub diff_add: Option<String>,
    pub diff_add_word: Option<String>,
    pub diff_remove: Option<String>,
    pub diff_remove_word: Option<String>,
}

/// `ansi()` in `build.ts`: the eight normal colours (black, red, green, yellow, blue, magenta, cyan, white) and the bright
/// row, where an unset bright colour is its normal one, except bright black, which is black mixed 35% toward white.
pub fn ansi(normal: [&str; 8], bright: [Option<&str>; 8]) -> [String; 16] {
    let mut table: Vec<String> = normal.iter().map(|c| c.to_string()).collect();
    for (ix, given) in bright.iter().enumerate() {
        table.push(match given {
            Some(color) => color.to_string(),
            None if ix == 0 => mix(normal[0], normal[7], 0.35),
            None => normal[ix].to_string(),
        });
    }
    table.try_into().expect("16 colours")
}

/// `syntax()` in `build.ts`, in `ThemePalette.syntax` order: plain, comment, keyword, string, number, function, type,
/// tag, property, operator, punctuation. `base` is those through type; the rest default to keyword, type, keyword and
/// plain.
pub fn syntax(
    base: [&str; 7],
    tag: Option<&str>,
    property: Option<&str>,
    operator: Option<&str>,
    punctuation: Option<&str>,
) -> [String; 11] {
    let [plain, comment, keyword, string, number, function, type_] = base.map(String::from);
    [
        plain.clone(),
        comment,
        keyword.clone(),
        string,
        number,
        function,
        type_.clone(),
        tag.map_or_else(|| keyword.clone(), String::from),
        property.map_or_else(|| type_, String::from),
        operator.map_or(keyword, String::from),
        punctuation.map_or(plain, String::from),
    ]
}

/// Milagre Blue's and Gray's terminal colours, and the code colours of the same family (`palettes/milagre.ts`).
pub fn github_ansi(scheme: Scheme) -> [String; 16] {
    let colors = match scheme {
        Scheme::Light => [
            "#24292f", "#cf222e", "#116329", "#7d4e00", "#0969da", "#8250df", "#1b7c83", "#6e7781", "#57606a", "#a40e26", "#1a7f37",
            "#633c01", "#218bff", "#a475f9", "#3192aa", "#8c959f",
        ],
        Scheme::Dark => [
            "#484f58", "#ff7b72", "#3fb950", "#d29922", "#58a6ff", "#bc8cff", "#39c5cf", "#b1bac4", "#6e7681", "#ffa198", "#56d364",
            "#e3b341", "#79c0ff", "#d2a8ff", "#56d4dd", "#ffffff",
        ],
    };
    colors.map(String::from)
}

pub fn github_syntax(scheme: Scheme) -> [String; 11] {
    let colors = match scheme {
        Scheme::Light => {
            ["#24292e", "#6a737d", "#d73a49", "#032f62", "#005cc5", "#6f42c1", "#005cc5", "#22863a", "#005cc5", "#d73a49", "#24292e"]
        }
        Scheme::Dark => {
            ["#e1e4e8", "#8b949e", "#f97583", "#9ecbff", "#79b8ff", "#b392f0", "#79b8ff", "#85e89d", "#79b8ff", "#f97583", "#e1e4e8"]
        }
    };
    colors.map(String::from)
}

/// The official colours of one scheme of a theme.
#[derive(Clone, Debug)]
pub struct ThemeSource {
    pub page: String,
    pub surface: String,
    pub ink: String,
    pub accent: String,
    pub green: String,
    pub orange: String,
    pub red: String,
    pub purple: String,
    /// The 16 terminal colours, xterm order (see [`ansi`]).
    pub ansi: [String; 16],
    /// The syntax colours in `ThemePalette.syntax` order (see [`syntax`]).
    pub syntax: [String; 11],
    pub overrides: Overrides,
}

impl ThemeSource {
    /// A source with the GitHub-style terminal and code colours of Milagre Blue and Gray (dark); a theme with its own
    /// sets `ansi` and `syntax` afterwards.
    pub fn new(page: &str, surface: &str, ink: &str, accent: &str, status: [&str; 4]) -> Self {
        Self {
            ansi: github_ansi(Scheme::Dark),
            syntax: github_syntax(Scheme::Dark),
            page: page.into(),
            surface: surface.into(),
            ink: ink.into(),
            accent: accent.into(),
            green: status[0].into(),
            orange: status[1].into(),
            red: status[2].into(),
            purple: status[3].into(),
            overrides: Overrides::default(),
        }
    }
}

/// Every colour the app reads, as hex strings (`ThemePalette`, the ANSI and syntax colours as tables).
#[derive(Clone, Debug, PartialEq)]
pub struct Palette {
    pub page: String,
    pub canvas: String,
    pub surface: String,
    pub inset: String,
    pub hover: String,
    pub hover2: String,
    pub field: String,
    pub ink: String,
    pub ink2: String,
    pub ink3: String,
    pub ink4: String,
    pub on_accent: String,
    pub on_green: String,
    pub on_orange: String,
    pub on_red: String,
    pub line: String,
    pub line_strong: String,
    pub accent: String,
    pub accent_ink: String,
    pub accent_tint: String,
    pub green: String,
    pub green_tint: String,
    pub orange: String,
    pub orange_tint: String,
    pub red: String,
    pub red_tint: String,
    pub green_ink: String,
    pub orange_ink: String,
    pub red_ink: String,
    pub purple: String,
    pub diff_add: String,
    pub diff_add_word: String,
    pub diff_remove: String,
    pub diff_remove_word: String,
    pub ansi: [String; 16],
    pub syntax: [String; 11],
    /// The terminal cursor (`cursor`): the ink.
    pub cursor: String,
    /// The terminal selection wash (`selection`): the accent at 30%.
    pub selection: String,
}

/// A tint of `color` on `page`: solid in light, translucent in dark.
fn tint(page: &str, color: &str, scheme: Scheme, light: f64, dark: f64) -> String {
    if scheme == Scheme::Dark { with_alpha(color, dark) } else { mix(page, color, light) }
}

/// Contrast the green, orange and red -ink shades reach on the page, cards and their own tints.
const STATUS_INK_RATIO: f64 = 4.8;

pub fn build_palette(source: &ThemeSource, scheme: Scheme) -> Palette {
    let dark = scheme == Scheme::Dark;
    let (page, surface, ink, accent) = (&source.page, &source.surface, &source.ink, &source.accent);
    let toward = |t: f64| mix(surface, ink, t);
    let o = &source.overrides;
    let pick = |given: &Option<String>, derived: String| given.clone().unwrap_or(derived);

    let canvas = pick(&o.canvas, mix(page, ink, if dark { 0.025 } else { 0.03 }));
    let inset = pick(&o.inset, mix(page, surface, 0.5));
    let hover = with_alpha(ink, if dark { 0.05 } else { 0.06 });
    let hover2 = with_alpha(ink, if dark { 0.09 } else { 0.1 });
    let field = pick(&o.field, if dark { toward(0.06) } else { mix(page, ink, 0.05) });
    let ink2 = pick(&o.ink2, mix(ink, page, 0.25));
    let ink3 = pick(&o.ink3, mix(ink, page, 0.56));
    let on_accent = pick(&o.on_accent, on_color(accent, page));
    let line = pick(&o.line, toward(if dark { 0.09 } else { 0.07 }));
    let line_strong = pick(&o.line_strong, toward(if dark { 0.14 } else { 0.12 }));
    let accent_ink = pick(&o.accent_ink, if dark { mix(accent, ink, 0.35) } else { mix(accent, "#000000", 0.12) });
    let accent_tint = pick(&o.accent_tint, tint(page, accent, scheme, 0.08, 0.16));
    let green_tint = pick(&o.green_tint, tint(page, &source.green, scheme, 0.08, 0.14));
    let orange_tint = pick(&o.orange_tint, tint(page, &source.orange, scheme, 0.08, 0.14));
    let red_tint = pick(&o.red_tint, tint(page, &source.red, scheme, 0.08, 0.14));
    let diff_add = pick(&o.diff_add, tint(page, &source.green, scheme, 0.12, 0.12));
    let diff_add_word = pick(&o.diff_add_word, tint(page, &source.green, scheme, 0.3, 0.3));
    let diff_remove = pick(&o.diff_remove, tint(page, &source.red, scheme, 0.1, 0.12));
    let diff_remove_word = pick(&o.diff_remove_word, tint(page, &source.red, scheme, 0.26, 0.3));

    // ink2, ink3 and the status colours carry small text, so as text they need 4.5:1 wherever they sit.
    let behind = |fill: &str| [over(fill, page), over(fill, surface)];
    let mut text = vec![page.clone(), surface.clone()];
    text.extend(behind(&field));
    text.extend(behind(&hover2));
    let on_tint = |tint: &str| {
        let mut v = vec![page.clone(), surface.clone()];
        v.extend(behind(tint));
        v
    };
    let worst = |c: &str| text.iter().map(|bg| contrast_ratio(c, bg)).fold(f64::INFINITY, f64::min);
    let solved_ink2 = readable_on(&ink2, ink, &text, 4.5);
    let solved_ink3 = readable_on(&ink3, ink, &text, 4.5);
    let green_ink = readable_on(&source.green, ink, &on_tint(&green_tint), STATUS_INK_RATIO);
    let orange_ink = readable_on(&source.orange, ink, &on_tint(&orange_tint), STATUS_INK_RATIO);
    let red_ink = readable_on(&source.red, ink, &on_tint(&red_tint), STATUS_INK_RATIO);
    let final_ink3 = if worst(&solved_ink3) > worst(&solved_ink2) { solved_ink2.clone() } else { solved_ink3 };
    let accent_ink = readable_on(&accent_ink, ink, &on_tint(&accent_tint), 4.5);

    Palette {
        on_green: on_color(&green_ink, page),
        on_orange: on_color(&orange_ink, page),
        on_red: on_color(&red_ink, page),
        page: page.clone(),
        canvas,
        surface: surface.clone(),
        inset,
        hover,
        hover2,
        field,
        ink: ink.clone(),
        ink2: solved_ink2,
        ink3: final_ink3,
        ink4: ink3,
        on_accent,
        line,
        line_strong,
        accent: accent.clone(),
        accent_ink,
        accent_tint,
        green: source.green.clone(),
        green_tint,
        orange: source.orange.clone(),
        orange_tint,
        red: source.red.clone(),
        red_tint,
        green_ink,
        orange_ink,
        red_ink,
        purple: source.purple.clone(),
        diff_add,
        diff_add_word,
        diff_remove,
        diff_remove_word,
        ansi: source.ansi.clone(),
        syntax: source.syntax.clone(),
        cursor: ink.clone(),
        selection: with_alpha(accent, 0.3),
    }
}

/// Ultracode's purple is a brand colour that themes don't override (`ULTRACODE_PURPLE`): ink and tint per scheme.
const fn purple_ink(scheme: Scheme) -> (&'static str, &'static str) {
    match scheme {
        Scheme::Light => ("#8e2bdc", "#f6edff"),
        Scheme::Dark => ("#d0a3ff", "#ad46ff2e"),
    }
}

/// Parses a palette hex string; malformed input is black.
pub fn parse_rgba(s: &str) -> Rgba {
    rgba(s)
}

fn rgba(s: &str) -> Rgba {
    // The palette only holds well-formed hex; a bad string cannot reach the GPUI theme.
    let b = s.as_bytes();
    if (b.len() == 7 || b.len() == 9) && b[0] == b'#' && s[1..].bytes().all(|c| c.is_ascii_hexdigit()) {
        let n = |i: usize| u8::from_str_radix(&s[i..i + 2], 16).unwrap_or(0) as f32 / 255.0;
        Rgba { r: n(1), g: n(3), b: n(5), a: if b.len() == 9 { n(7) } else { 1.0 } }
    } else {
        hex("#000000")
    }
}

impl Palette {
    /// The GPUI theme for this palette: the engine every view reads (`Theme` global) and the gpui-component
    /// bridge observes. `on_ink` is the surface and the scrim black at 20% / 40%, as in `Theme::light`/`dark`.
    pub fn to_theme(&self, scheme: Scheme) -> Theme {
        let (purple_ink, purple_tint) = purple_ink(scheme);
        Theme {
            appearance: scheme.appearance(),
            page: rgba(&self.page),
            canvas: rgba(&self.canvas),
            surface: rgba(&self.surface),
            inset: rgba(&self.inset),
            field: rgba(&self.field),
            hover: rgba(&self.hover),
            hover2: rgba(&self.hover2),
            line: rgba(&self.line),
            line_strong: rgba(&self.line_strong),
            ink: rgba(&self.ink),
            ink2: rgba(&self.ink2),
            ink3: rgba(&self.ink3),
            ink4: rgba(&self.ink4),
            on_ink: rgba(&self.surface),
            scrim: if scheme == Scheme::Dark { hex("#00000066") } else { hex("#00000033") },
            accent: rgba(&self.accent),
            accent_ink: rgba(&self.accent_ink),
            accent_tint: rgba(&self.accent_tint),
            on_accent: rgba(&self.on_accent),
            green: rgba(&self.green),
            green_ink: rgba(&self.green_ink),
            green_tint: rgba(&self.green_tint),
            on_green: rgba(&self.on_green),
            orange: rgba(&self.orange),
            orange_ink: rgba(&self.orange_ink),
            orange_tint: rgba(&self.orange_tint),
            on_orange: rgba(&self.on_orange),
            red: rgba(&self.red),
            red_ink: rgba(&self.red_ink),
            red_tint: rgba(&self.red_tint),
            on_red: rgba(&self.on_red),
            purple: rgba(&self.purple),
            purple_ink: rgba(purple_ink),
            purple_tint: rgba(purple_tint),
            diff_add: rgba(&self.diff_add),
            diff_add_word: rgba(&self.diff_add_word),
            diff_remove: rgba(&self.diff_remove),
            diff_remove_word: rgba(&self.diff_remove_word),
            code_bg: rgba(&self.inset),
            code_border: rgba(&self.line),
            syntax: SyntaxColors {
                plain: rgba(&self.syntax[0]),
                comment: rgba(&self.syntax[1]),
                keyword: rgba(&self.syntax[2]),
                string: rgba(&self.syntax[3]),
                number: rgba(&self.syntax[4]),
                function: rgba(&self.syntax[5]),
                type_: rgba(&self.syntax[6]),
                tag: rgba(&self.syntax[7]),
                property: rgba(&self.syntax[8]),
                operator: rgba(&self.syntax[9]),
                punctuation: rgba(&self.syntax[10]),
            },
            terminal: TerminalColors {
                ansi: std::array::from_fn(|ix| rgba(&self.ansi[ix])),
                cursor: rgba(&self.cursor),
                selection: rgba(&self.selection),
            },
        }
    }
}

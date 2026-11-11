//! The twelve themes (`packages/shared/src/themes/palettes/{milagre,catppuccin,popular}.ts` and `registry.ts`).
//! Each scheme carries its terminal ANSI and syntax colours (`ansi()` and `syntax()` in `build.ts`).

use std::sync::OnceLock;

use super::color::from_oklch;
use super::palette::{Overrides, Palette, Scheme, ThemeSource, ansi, build_palette, github_ansi, github_syntax, syntax};

pub const DEFAULT_THEME_ID: &str = "milagre-blue";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThemeGroup {
    Milagre,
    Catppuccin,
    Popular,
}

impl ThemeGroup {
    pub const ALL: [ThemeGroup; 3] = [Self::Milagre, Self::Catppuccin, Self::Popular];

    pub fn label(self) -> &'static str {
        match self {
            Self::Milagre => "Milagre",
            Self::Catppuccin => "Catppuccin",
            Self::Popular => "Popular",
        }
    }
}

#[derive(Clone, Debug)]
pub struct ThemeDefinition {
    pub id: &'static str,
    pub name: &'static str,
    pub group: ThemeGroup,
    /// The paired theme's name, shown under the tile ("Light: Latte").
    pub light_name: &'static str,
    pub dark_name: &'static str,
    pub light: ThemeSource,
    pub dark: ThemeSource,
}

impl ThemeDefinition {
    pub fn source(&self, scheme: Scheme) -> &ThemeSource {
        match scheme {
            Scheme::Light => &self.light,
            Scheme::Dark => &self.dark,
        }
    }
}

pub fn themes() -> &'static [ThemeDefinition] {
    static THEMES: OnceLock<Vec<ThemeDefinition>> = OnceLock::new();
    THEMES.get_or_init(build_themes)
}

pub fn get_theme(id: &str) -> Option<&'static ThemeDefinition> {
    themes().iter().find(|t| t.id == id)
}

pub fn is_theme_id(id: &str) -> bool {
    get_theme(id).is_some()
}

/// The palette of a registered theme; an unknown id is Milagre Blue.
pub fn theme_palette(id: &str, scheme: Scheme) -> Palette {
    let theme = get_theme(id).or_else(|| get_theme(DEFAULT_THEME_ID)).expect("default theme");
    build_palette(theme.source(scheme), scheme)
}

fn s(page: &str, surface: &str, ink: &str, accent: &str, status: [&str; 4]) -> ThemeSource {
    ThemeSource::new(page, surface, ink, accent, status)
}

fn gray_light() -> ThemeSource {
    ThemeSource {
        overrides: Overrides {
            canvas: Some("#f1f2f3".into()),
            inset: Some("#f7f8f9".into()),
            field: Some("#f2f2f3".into()),
            ink3: Some("#9a9da3".into()),
            on_accent: Some("#ffffff".into()),
            line: Some("#ecedef".into()),
            line_strong: Some("#e0e2e5".into()),
            accent_ink: Some("#0070dd".into()),
            accent_tint: Some("#e9f3ff".into()),
            green_tint: Some("#e8f5ed".into()),
            orange_tint: Some("#fdf1e5".into()),
            red_tint: Some("#fcecec".into()),
            diff_add: Some("#e4f9ea".into()),
            diff_add_word: Some("#b1ebc4".into()),
            diff_remove: Some("#ffeceb".into()),
            diff_remove_word: Some("#ffc9c8".into()),
            ..Overrides::default()
        },
        ansi: github_ansi(Scheme::Light),
        syntax: github_syntax(Scheme::Light),
        ..s("#fafafb", "#ffffff", "#1f2124", "#0285ff", ["#199a4d", "#ef720d", "#e3474c", "#ad46ff"])
    }
}

fn gray_dark() -> ThemeSource {
    ThemeSource {
        overrides: Overrides {
            canvas: Some("#1c1d1f".into()),
            inset: Some("#1f2022".into()),
            field: Some("#2b2c2f".into()),
            ink3: Some("#6c6f75".into()),
            on_accent: Some("#ffffff".into()),
            line: Some("#2e3033".into()),
            line_strong: Some("#3a3c40".into()),
            accent_ink: Some("#7ec0ff".into()),
            accent_tint: Some("#3d9aff29".into()),
            green_tint: Some("#3cbb7224".into()),
            orange_tint: Some("#f68f3c24".into()),
            red_tint: Some("#ee5c6124".into()),
            diff_add: Some("#3cbb721f".into()),
            diff_add_word: Some("#3cbb724d".into()),
            diff_remove: Some("#ee5c611f".into()),
            diff_remove_word: Some("#ee5c614d".into()),
            ..Overrides::default()
        },
        ansi: github_ansi(Scheme::Dark),
        syntax: github_syntax(Scheme::Dark),
        ..s("#17181a", "#232427", "#f2f3f4", "#3d9aff", ["#3cbb72", "#f68f3c", "#ee5c61", "#ad46ff"])
    }
}

/// Milagre Blue: Gray's status colours on blue-tinted surfaces; the rest is derived.
fn blue(gray: &ThemeSource, page: String, canvas: String, surface: String, ink: String, accent: String) -> ThemeSource {
    ThemeSource {
        page,
        surface,
        ink,
        accent,
        green: gray.green.clone(),
        orange: gray.orange.clone(),
        red: gray.red.clone(),
        purple: gray.purple.clone(),
        ansi: gray.ansi.clone(),
        syntax: gray.syntax.clone(),
        overrides: Overrides { canvas: Some(canvas), ..Overrides::default() },
    }
}

/// One Catppuccin flavour: base, mantle, surface0, surface1, overlay1, subtext0, subtext1, text, then mauve, red,
/// peach, green.
struct Flavor {
    base: &'static str,
    mantle: &'static str,
    surface0: &'static str,
    surface1: &'static str,
    surface2: &'static str,
    overlay1: &'static str,
    overlay2: &'static str,
    subtext0: &'static str,
    subtext1: &'static str,
    text: &'static str,
    mauve: &'static str,
    red: &'static str,
    peach: &'static str,
    yellow: &'static str,
    green: &'static str,
    teal: &'static str,
    sky: &'static str,
    blue: &'static str,
    lavender: &'static str,
    pink: &'static str,
}

const LATTE: Flavor = Flavor {
    base: "#eff1f5",
    mantle: "#e6e9ef",
    surface0: "#ccd0da",
    surface1: "#bcc0cc",
    surface2: "#acb0be",
    overlay1: "#8c8fa1",
    overlay2: "#7c7f93",
    subtext0: "#6c6f85",
    subtext1: "#5c5f77",
    text: "#4c4f69",
    mauve: "#8839ef",
    red: "#d20f39",
    peach: "#fe640b",
    yellow: "#df8e1d",
    green: "#40a02b",
    teal: "#179299",
    sky: "#04a5e5",
    blue: "#1e66f5",
    lavender: "#7287fd",
    pink: "#ea76cb",
};
const FRAPPE: Flavor = Flavor {
    base: "#303446",
    mantle: "#292c3c",
    surface0: "#414559",
    surface1: "#51576d",
    surface2: "#626880",
    overlay1: "#838ba7",
    overlay2: "#949cbb",
    subtext0: "#a5adce",
    subtext1: "#b5bfe2",
    text: "#c6d0f5",
    mauve: "#ca9ee6",
    red: "#e78284",
    peach: "#ef9f76",
    yellow: "#e5c890",
    green: "#a6d189",
    teal: "#81c8be",
    sky: "#99d1db",
    blue: "#8caaee",
    lavender: "#babbf1",
    pink: "#f4b8e4",
};
const MACCHIATO: Flavor = Flavor {
    base: "#24273a",
    mantle: "#1e2030",
    surface0: "#363a4f",
    surface1: "#494d64",
    surface2: "#5b6078",
    overlay1: "#8087a2",
    overlay2: "#939ab7",
    subtext0: "#a5adcb",
    subtext1: "#b8c0e0",
    text: "#cad3f5",
    mauve: "#c6a0f6",
    red: "#ed8796",
    peach: "#f5a97f",
    yellow: "#eed49f",
    green: "#a6da95",
    teal: "#8bd5ca",
    sky: "#91d7e3",
    blue: "#8aadf4",
    lavender: "#b7bdf8",
    pink: "#f5bde6",
};
const MOCHA: Flavor = Flavor {
    base: "#1e1e2e",
    mantle: "#181825",
    surface0: "#313244",
    surface1: "#45475a",
    surface2: "#585b70",
    overlay1: "#7f849c",
    overlay2: "#9399b2",
    subtext0: "#a6adc8",
    subtext1: "#bac2de",
    text: "#cdd6f4",
    mauve: "#cba6f7",
    red: "#f38ba8",
    peach: "#fab387",
    yellow: "#f9e2af",
    green: "#a6e3a1",
    teal: "#94e2d5",
    sky: "#89dceb",
    blue: "#89b4fa",
    lavender: "#b4befe",
    pink: "#f5c2e7",
};

fn catppuccin_source(f: &Flavor, light: bool) -> ThemeSource {
    ThemeSource {
        ansi: ansi(
            [f.surface1, f.red, f.green, f.yellow, f.blue, f.pink, f.teal, f.subtext1],
            [Some(f.surface2), None, None, None, None, None, None, Some(f.subtext0)],
        ),
        syntax: syntax(
            [f.text, f.overlay2, f.mauve, f.green, f.peach, f.blue, f.yellow],
            Some(f.blue),
            Some(f.lavender),
            Some(f.sky),
            Some(f.overlay2),
        ),
        overrides: Overrides {
            canvas: Some(f.mantle.into()),
            ink2: Some((if light { f.subtext1 } else { f.subtext0 }).into()),
            ink3: Some(f.overlay1.into()),
            line: Some((if light { f.surface0 } else { f.surface1 }).into()),
            ..Overrides::default()
        },
        ..s(f.base, if light { "#ffffff" } else { f.surface0 }, f.text, f.mauve, [f.green, f.peach, f.red, f.mauve])
    }
}

fn flavor(id: &'static str, name: &'static str, dark: &Flavor) -> ThemeDefinition {
    ThemeDefinition {
        id,
        name,
        group: ThemeGroup::Catppuccin,
        light_name: "Latte",
        dark_name: name,
        light: catppuccin_source(&LATTE, true),
        dark: catppuccin_source(dark, false),
    }
}

/// A "Popular" theme scheme: page, surface, ink, ink2, ink3, accent, green, orange, red, purple, then the terminal's
/// yellow, blue and cyan. Syntax: plain = ink, comment = ink3, keyword = purple, string = green, number = orange,
/// function = blue, type = yellow, tag = red, property = cyan.
fn popular(c: [&str; 13]) -> ThemeSource {
    ThemeSource {
        ansi: ansi([c[1], c[8], c[6], c[10], c[11], c[9], c[12], c[4]], [None, None, None, None, None, None, None, Some(c[2])]),
        syntax: syntax([c[2], c[4], c[9], c[6], c[7], c[11], c[10]], Some(c[8]), Some(c[12]), None, None),
        overrides: Overrides { ink2: Some(c[3].into()), ink3: Some(c[4].into()), ..Overrides::default() },
        ..s(c[0], c[1], c[2], c[5], [c[6], c[7], c[8], c[9]])
    }
}

fn popular_theme(
    id: &'static str,
    name: &'static str,
    light_name: &'static str,
    dark_name: &'static str,
    light: ThemeSource,
    dark: ThemeSource,
) -> ThemeDefinition {
    ThemeDefinition { id, name, group: ThemeGroup::Popular, light_name, dark_name, light, dark }
}

fn build_themes() -> Vec<ThemeDefinition> {
    let (gl, gd) = (gray_light(), gray_dark());
    let blue_light = blue(
        &gl,
        from_oklch(0.98, 0.008, 250.0),
        from_oklch(0.955, 0.015, 250.0),
        "#ffffff".into(),
        from_oklch(0.25, 0.02, 258.0),
        from_oklch(0.6, 0.2, 255.0),
    );
    let blue_dark = blue(
        &gd,
        from_oklch(0.2, 0.03, 258.0),
        from_oklch(0.22, 0.032, 258.0),
        from_oklch(0.25, 0.035, 258.0),
        from_oklch(0.95, 0.012, 255.0),
        from_oklch(0.68, 0.17, 253.0),
    );
    let mut solarized_light = popular([
        "#fdf6e3", "#ffffff", "#073642", "#586e75", "#93a1a1", "#268bd2", "#859900", "#cb4b16", "#dc322f", "#6c71c4", "#b58900", "#268bd2",
        "#2aa198",
    ]);
    solarized_light.overrides.canvas = Some("#eee8d5".into());
    vec![
        ThemeDefinition {
            id: "milagre-blue",
            name: "Milagre Blue",
            group: ThemeGroup::Milagre,
            light_name: "Light",
            dark_name: "Dark",
            light: blue_light,
            dark: blue_dark,
        },
        ThemeDefinition {
            id: "gray",
            name: "Gray",
            group: ThemeGroup::Milagre,
            light_name: "Light",
            dark_name: "Dark",
            light: gl,
            dark: gd,
        },
        flavor("catppuccin-mocha", "Mocha", &MOCHA),
        flavor("catppuccin-macchiato", "Macchiato", &MACCHIATO),
        flavor("catppuccin-frappe", "Frappé", &FRAPPE),
        popular_theme(
            "tokyo-night",
            "Tokyo Night",
            "Day",
            "Night",
            popular([
                "#e1e2e7", "#f2f3f6", "#343b58", "#3760bf", "#848cb5", "#2e7de9", "#587539", "#b15c00", "#f52a65", "#9854f1", "#8c6c3e",
                "#2e7de9", "#007197",
            ]),
            popular([
                "#1a1b26", "#24283b", "#c0caf5", "#a9b1d6", "#565f89", "#7aa2f7", "#9ece6a", "#ff9e64", "#f7768e", "#bb9af7", "#e0af68",
                "#7aa2f7", "#7dcfff",
            ]),
        ),
        popular_theme(
            "dracula",
            "Dracula",
            "Alucard",
            "Dracula",
            popular([
                "#fffbeb", "#ffffff", "#1f1f1f", "#4b4b4b", "#6c664b", "#644ac9", "#14710a", "#a34d14", "#cb3a2a", "#644ac9", "#846e15",
                "#036a96", "#036a96",
            ]),
            popular([
                "#282a36", "#343746", "#f8f8f2", "#c9c9c0", "#6272a4", "#bd93f9", "#50fa7b", "#ffb86c", "#ff5555", "#bd93f9", "#f1fa8c",
                "#8be9fd", "#8be9fd",
            ]),
        ),
        popular_theme(
            "nord",
            "Nord",
            "Snow Storm",
            "Polar Night",
            popular([
                "#eceff4", "#ffffff", "#2e3440", "#4c566a", "#7b88a1", "#5e81ac", "#5a7d3a", "#b4532a", "#bf616a", "#b48ead", "#b3881c",
                "#5e81ac", "#4c8a8a",
            ]),
            popular([
                "#2e3440", "#3b4252", "#eceff4", "#d8dee9", "#616e88", "#88c0d0", "#a3be8c", "#d08770", "#bf616a", "#b48ead", "#ebcb8b",
                "#81a1c1", "#8fbcbb",
            ]),
        ),
        popular_theme(
            "rose-pine",
            "Rosé Pine",
            "Dawn",
            "Main",
            popular([
                "#faf4ed", "#fffaf3", "#575279", "#6e6a86", "#9893a5", "#286983", "#56949f", "#ea9d34", "#b4637a", "#907aa9", "#ea9d34",
                "#286983", "#56949f",
            ]),
            popular([
                "#191724", "#1f1d2e", "#e0def4", "#908caa", "#6e6a86", "#ebbcba", "#9ccfd8", "#f6c177", "#eb6f92", "#c4a7e7", "#f6c177",
                "#31748f", "#9ccfd8",
            ]),
        ),
        popular_theme(
            "gruvbox",
            "Gruvbox",
            "Gruvbox Light",
            "Gruvbox Dark",
            popular([
                "#fbf1c7", "#f9f5d7", "#3c3836", "#665c54", "#928374", "#af3a03", "#79740e", "#af3a03", "#9d0006", "#8f3f71", "#b57614",
                "#076678", "#427b58",
            ]),
            popular([
                "#282828", "#3c3836", "#ebdbb2", "#d5c4a1", "#928374", "#fe8019", "#b8bb26", "#fe8019", "#fb4934", "#d3869b", "#fabd2f",
                "#83a598", "#8ec07c",
            ]),
        ),
        popular_theme(
            "solarized",
            "Solarized",
            "Solarized Light",
            "Solarized Dark",
            solarized_light,
            popular([
                "#002b36", "#073642", "#eee8d5", "#93a1a1", "#586e75", "#268bd2", "#859900", "#cb4b16", "#dc322f", "#6c71c4", "#b58900",
                "#268bd2", "#2aa198",
            ]),
        ),
        popular_theme(
            "one-dark",
            "One Dark",
            "One Light",
            "One Dark",
            popular([
                "#fafafa", "#ffffff", "#383a42", "#696c77", "#a0a1a7", "#4078f2", "#50a14f", "#986801", "#e45649", "#a626a4", "#c18401",
                "#4078f2", "#0184bc",
            ]),
            popular([
                "#282c34", "#2c313a", "#abb2bf", "#9da5b4", "#5c6370", "#61afef", "#98c379", "#d19a66", "#e06c75", "#c678dd", "#e5c07b",
                "#61afef", "#56b6c2",
            ]),
        ),
    ]
}

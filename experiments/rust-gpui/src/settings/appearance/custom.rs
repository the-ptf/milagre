//! The custom theme (`packages/shared/src/themes/custom.ts`): three seed colours per scheme become a full theme.
//! Seeds, validation of pasted JSON, the JSON written by Copy, "Start from" and the contrast readout.

use serde_json::{Value, json};

use super::color::{contrast_ratio, from_oklch, hex_to_oklch, is_seed, mix};
use super::palette::{Scheme, ThemeSource};
use super::themes::get_theme;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ThemeSeeds {
    pub background: String,
    pub text: String,
    pub accent: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CustomTheme {
    pub light: ThemeSeeds,
    pub dark: ThemeSeeds,
}

impl CustomTheme {
    pub fn seeds(&self, scheme: Scheme) -> &ThemeSeeds {
        match scheme {
            Scheme::Light => &self.light,
            Scheme::Dark => &self.dark,
        }
    }

    pub fn seeds_mut(&mut self, scheme: Scheme) -> &mut ThemeSeeds {
        match scheme {
            Scheme::Light => &mut self.light,
            Scheme::Dark => &mut self.dark,
        }
    }
}

/// A status hue at a lightness that reads on this background: lighter on dark backgrounds, darker on light ones.
fn status(hue: f64, chroma: f64, background: &str) -> String {
    let bg_l = hex_to_oklch(background).l;
    let lighter = bg_l < 0.5;
    let mut l = if lighter { f64::max(0.68, bg_l + 0.45) } else { f64::min(0.58, bg_l - 0.38) };
    let mut color = from_oklch(l, chroma, hue);
    let mut i = 0;
    while i < 30 && contrast_ratio(&color, background) < 3.0 {
        l = (l + if lighter { 0.02 } else { -0.02 }).clamp(0.0, 1.0);
        color = from_oklch(l, chroma, hue);
        i += 1;
    }
    color
}

pub fn custom_source(seeds: &ThemeSeeds) -> ThemeSource {
    let ThemeSeeds { background, text, accent } = seeds;
    let surface = if hex_to_oklch(background).l < 0.5 { mix(background, text, 0.06) } else { mix(background, "#ffffff", 0.6) };
    ThemeSource {
        page: background.clone(),
        surface,
        ink: text.clone(),
        accent: accent.clone(),
        green: status(150.0, 0.16, background),
        orange: status(55.0, 0.16, background),
        red: status(25.0, 0.16, background),
        // `purple: magenta`
        purple: status(320.0, 0.16, background),
        overrides: Default::default(),
    }
}

fn parse_seeds(value: &Value) -> Option<ThemeSeeds> {
    let get = |key: &str| value.get(key).and_then(Value::as_str).filter(|v| is_seed(v)).map(str::to_lowercase);
    Some(ThemeSeeds { background: get("background")?, text: get("text")?, accent: get("accent")? })
}

/// Accepts a JSON string; returns normalised (lowercase) seeds or `None`.
pub fn parse_custom_theme(text: &str) -> Option<CustomTheme> {
    let value: Value = serde_json::from_str(text).ok()?;
    if !value.is_object() {
        return None;
    }
    Some(CustomTheme { light: parse_seeds(value.get("light")?)?, dark: parse_seeds(value.get("dark")?)? })
}

/// `JSON.stringify(theme, null, 2)`: light then dark, each background, text, accent.
pub fn serialize_custom_theme(theme: &CustomTheme) -> String {
    let seeds = |s: &ThemeSeeds| json!({ "background": s.background, "text": s.text, "accent": s.accent });
    serde_json::to_string_pretty(&json!({ "light": seeds(&theme.light), "dark": seeds(&theme.dark) })).unwrap_or_default()
}

/// Page, ink and accent of a registered theme, for "Start from".
pub fn seeds_from(id: &str) -> CustomTheme {
    let theme = get_theme(id).or_else(|| get_theme(super::themes::DEFAULT_THEME_ID)).expect("default theme");
    let seeds = |src: &ThemeSource| ThemeSeeds { background: src.page.clone(), text: src.ink.clone(), accent: src.accent.clone() };
    CustomTheme { light: seeds(&theme.light), dark: seeds(&theme.dark) }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Contrast {
    pub text: f64,
    pub accent: f64,
}

impl Contrast {
    /// Below 4.5:1 for text or 3:1 for the accent the readout turns orange.
    pub fn weak(self) -> bool {
        self.text < 4.5 || self.accent < 3.0
    }
}

pub fn custom_contrast(seeds: &ThemeSeeds) -> Contrast {
    Contrast { text: contrast_ratio(&seeds.text, &seeds.background), accent: contrast_ratio(&seeds.accent, &seeds.background) }
}

//! A theme's colours: what an author writes ([`ThemeSource`]) and the full palette derived from it
//! ([`build_palette`], `packages/shared/src/themes/build.ts`). Terminal ANSI and syntax colours are not part of the
//! GPUI [`Theme`](crate::theme::Theme) yet, so they are not ported here.

use gpui::Rgba;

use super::color::{contrast_ratio, mix, on_color, over, readable_on, with_alpha};
use crate::theme::{Appearance, Theme, hex};

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
    pub overrides: Overrides,
}

impl ThemeSource {
    pub fn new(page: &str, surface: &str, ink: &str, accent: &str, status: [&str; 4]) -> Self {
        Self {
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

/// Every colour the app reads, as hex strings (`ThemePalette` without ANSI, cursor and syntax).
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
        }
    }
}

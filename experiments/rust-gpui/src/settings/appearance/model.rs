//! Appearance settings and the engine that turns them into the GPUI [`Theme`]: `packages/shared/src/appearance.mjs`
//! (the option lists), `resolveThemeSettings` / `resolvePalette` (`themes/index.ts`) and the theme part of
//! `apps/desktop/app/src/lib/settings.ts`.

use gpui::{App, Global};

use super::color::with_alpha;
use super::custom::{CustomTheme, custom_source, seeds_from};
use super::palette::{Palette, Scheme, build_palette};
use super::themes::{DEFAULT_THEME_ID, is_theme_id, theme_palette};
use crate::theme::live::{LiveStyle, set_live};
use crate::theme::{SANS, Theme};

/// System, Light or Dark (`ThemePreference`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThemePreference {
    System,
    Light,
    Dark,
}

impl ThemePreference {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Light => "light",
            Self::Dark => "dark",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "light" => Self::Light,
            "dark" => Self::Dark,
            _ => Self::System,
        }
    }

    /// The scheme on screen; `system` is what the platform reports.
    pub fn resolve(self, system: Scheme) -> Scheme {
        match self {
            Self::System => system,
            Self::Light => Scheme::Light,
            Self::Dark => Scheme::Dark,
        }
    }
}

pub const CHAT_WIDTH_PX_MIN: u32 = 600;
pub const CHAT_WIDTH_PX_MAX: u32 = 2400;

/// The custom chat width in px, clamped to 600..2400 (`clampChatWidth`).
pub fn clamp_chat_width(px: u32) -> u32 {
    px.clamp(CHAT_WIDTH_PX_MIN, CHAT_WIDTH_PX_MAX)
}

/// `[id, label]` lists, as in `appearance.mjs`.
pub const SIDEBAR_SIZES: &[(&str, &str, i32)] =
    &[("small", "Small", -1), ("default", "Default", 0), ("large", "Large", 1), ("larger", "Larger", 2)];
pub const CHAT_SIZES: &[(&str, &str, u32)] =
    &[("small", "Small", 13), ("default", "Default", 14), ("medium", "Medium", 15), ("large", "Large", 16), ("larger", "Larger", 17)];
pub const CODE_SIZES: &[(&str, &str, u32)] =
    &[("small", "Small", 11), ("default", "Default", 12), ("medium", "Medium", 13), ("large", "Large", 14)];
/// Comfortable 704px, Wide 1024px; Full and Custom have no preset width.
pub const CHAT_WIDTHS: &[(&str, &str, Option<u32>)] =
    &[("comfortable", "Comfortable", Some(704)), ("wide", "Wide", Some(1024)), ("full", "Full", None), ("custom", "Custom", None)];
pub const SIDEBAR_USAGE_MODES: &[(&str, &str)] = &[("expanded", "Expanded"), ("compact", "Compact")];
pub const PROVIDER_ICON_STYLES: &[(&str, &str)] = &[("original", "Original"), ("simplified", "Simplified")];
pub const MOTION_SPEEDS: &[(&str, &str, f32)] = &[("normal", "Normal", 1.0), ("fast", "Fast", 0.6), ("off", "Off", 0.0)];

/// A colour-blind friendly diff pair; Red & green keeps each theme's own colours.
pub struct DiffPair {
    pub id: &'static str,
    pub label: &'static str,
    pub light: Option<(&'static str, &'static str)>,
    pub dark: Option<(&'static str, &'static str)>,
}

pub const DIFF_PAIRS: &[DiffPair] = &[
    DiffPair { id: "red-green", label: "Red & green", light: None, dark: None },
    DiffPair { id: "blue-orange", label: "Blue & orange", light: Some(("#1f6feb", "#d9480f")), dark: Some(("#58a6ff", "#ff8c42")) },
    DiffPair { id: "purple-yellow", label: "Purple & yellow", light: Some(("#8250df", "#b08800")), dark: Some(("#bc8cff", "#e3b341")) },
];

pub fn diff_pair(id: &str) -> &'static DiffPair {
    DIFF_PAIRS.iter().find(|p| p.id == id).unwrap_or(&DIFF_PAIRS[0])
}

/// A font choice. `bundled` fonts always load; the rest only when the platform lists them.
pub struct FontChoice {
    pub id: &'static str,
    pub label: &'static str,
    pub bundled: bool,
}

pub const UI_FONTS: &[FontChoice] = &[
    FontChoice { id: "system", label: "System (SF Pro)", bundled: true },
    FontChoice { id: "inter", label: "Inter", bundled: true },
    FontChoice { id: "geist", label: "Geist", bundled: true },
    FontChoice { id: "ibm-plex-sans", label: "IBM Plex Sans", bundled: false },
    FontChoice { id: "source-sans-3", label: "Source Sans 3", bundled: false },
    FontChoice { id: "helvetica-neue", label: "Helvetica Neue", bundled: false },
    FontChoice { id: "avenir-next", label: "Avenir Next", bundled: false },
    FontChoice { id: "charter", label: "Charter", bundled: false },
    FontChoice { id: "iowan-old-style", label: "Iowan Old Style", bundled: false },
    FontChoice { id: "atkinson-hyperlegible", label: "Atkinson Hyperlegible", bundled: false },
];

pub const MONO_FONTS: &[FontChoice] = &[
    FontChoice { id: "system", label: "System (SF Mono)", bundled: true },
    FontChoice { id: "jetbrains-mono", label: "JetBrains Mono", bundled: true },
    FontChoice { id: "fira-code", label: "Fira Code", bundled: false },
    FontChoice { id: "geist-mono", label: "Geist Mono", bundled: true },
    FontChoice { id: "cascadia-code", label: "Cascadia Code", bundled: false },
    FontChoice { id: "ibm-plex-mono", label: "IBM Plex Mono", bundled: false },
    FontChoice { id: "source-code-pro", label: "Source Code Pro", bundled: false },
    FontChoice { id: "menlo", label: "Menlo", bundled: false },
    FontChoice { id: "monaco", label: "Monaco", bundled: false },
    FontChoice { id: "berkeley-mono", label: "Berkeley Mono", bundled: false },
    FontChoice { id: "iosevka", label: "Iosevka", bundled: false },
];

/// The fonts to offer: the system font, the bundled ones, and the others only when `installed` lists their family
/// ("installed fonts only"). The probe is the platform's font list, injected so tests need no text system.
pub fn available_fonts<'a>(list: &'a [FontChoice], installed: &dyn Fn(&str) -> bool) -> Vec<&'a FontChoice> {
    list.iter().filter(|f| f.bundled || installed(f.label)).collect()
}

/// The font shown selected: a saved font that is not installed shows as the system font.
pub fn shown_font<'a>(list: &'a [FontChoice], id: &str, installed: &dyn Fn(&str) -> bool) -> &'a str {
    match list.iter().find(|f| f.id == id) {
        Some(f) if f.bundled || installed(f.label) => f.id,
        _ => list[0].id,
    }
}

/// `appearance` in the desktop settings (`DEFAULT_APPEARANCE`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppearanceOptions {
    pub ui_font: String,
    pub mono_font: String,
    pub sidebar_size: String,
    pub chat_size: String,
    pub code_size: String,
    pub chat_width: String,
    pub chat_width_px: u32,
    pub sidebar_usage: String,
    pub provider_icons: String,
    pub diff_colors: String,
    pub motion: String,
}

impl Default for AppearanceOptions {
    fn default() -> Self {
        Self {
            ui_font: "system".into(),
            mono_font: "system".into(),
            sidebar_size: "default".into(),
            chat_size: "default".into(),
            code_size: "default".into(),
            chat_width: "comfortable".into(),
            chat_width_px: 900,
            sidebar_usage: "expanded".into(),
            provider_icons: "original".into(),
            diff_colors: "red-green".into(),
            motion: "normal".into(),
        }
    }
}

impl AppearanceOptions {
    pub fn sidebar_delta(&self) -> i32 {
        SIDEBAR_SIZES.iter().find(|s| s.0 == self.sidebar_size).map_or(0, |s| s.2)
    }

    pub fn chat_px(&self) -> u32 {
        CHAT_SIZES.iter().find(|s| s.0 == self.chat_size).map_or(14, |s| s.2)
    }

    pub fn code_px(&self) -> u32 {
        CODE_SIZES.iter().find(|s| s.0 == self.code_size).map_or(12, |s| s.2)
    }

    /// Chat column max width in px; `None` fills the pane.
    pub fn chat_width_limit(&self) -> Option<u32> {
        if self.chat_width == "custom" {
            return Some(clamp_chat_width(self.chat_width_px));
        }
        CHAT_WIDTHS.iter().find(|w| w.0 == self.chat_width).and_then(|w| w.2)
    }

    pub fn motion_scale(&self) -> f32 {
        MOTION_SPEEDS.iter().find(|m| m.0 == self.motion).map_or(1.0, |m| m.2)
    }

    /// What the views read while they draw (`theme::live`). `installed` says whether the platform lists a font
    /// family: a font that is not installed is the system font, as `fontStack` falls back on the desktop.
    pub fn live_style(&self, installed: &dyn Fn(&str) -> bool) -> LiveStyle {
        let family = |list: &[FontChoice], id: &str| -> Option<&'static str> {
            list.iter().skip(1).find(|f| f.id == id && installed(f.label)).map(|f| f.label)
        };
        LiveStyle {
            ui_font: family(UI_FONTS, &self.ui_font).unwrap_or(SANS),
            mono_font: family(MONO_FONTS, &self.mono_font),
            chat_size: self.chat_px() as f32,
            code_size: self.code_px() as f32,
            sidebar_delta: self.sidebar_delta() as f32,
            chat_width: self.chat_width_limit().map(|px| px as f32),
            simplified_icons: self.provider_icons == "simplified",
            compact_usage: self.sidebar_usage == "compact",
            motion_scale: self.motion_scale(),
        }
    }
}

/// The platform's font list as a probe for [`AppearanceOptions::live_style`].
fn installed_probe(cx: &App) -> impl Fn(&str) -> bool + use<> {
    let names: std::collections::HashSet<String> = cx.text_system().all_font_names().into_iter().collect();
    move |family| names.contains(family) || crate::theme::fonts::is_bundled(family)
}

/// Everything Appearance edits: the mode, the colour theme, the custom theme and the options.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppearanceState {
    pub theme: ThemePreference,
    /// A registered theme id, or `"custom"`.
    pub color_theme: String,
    pub custom_theme_enabled: bool,
    pub custom_theme: Option<CustomTheme>,
    pub options: AppearanceOptions,
}

impl Default for AppearanceState {
    fn default() -> Self {
        Self {
            theme: ThemePreference::System,
            color_theme: DEFAULT_THEME_ID.into(),
            custom_theme_enabled: false,
            custom_theme: None,
            options: AppearanceOptions::default(),
        }
    }
}

impl AppearanceState {
    /// The choice in effect: custom needs the switch on and saved seeds (`resolveThemeSettings`).
    pub fn resolved_choice(&self) -> &str {
        if self.color_theme == "custom" {
            return if self.custom_theme_enabled && self.custom_theme.is_some() { "custom" } else { DEFAULT_THEME_ID };
        }
        if is_theme_id(&self.color_theme) { &self.color_theme } else { DEFAULT_THEME_ID }
    }

    /// The palette of the choice in effect for a scheme.
    pub fn palette(&self, scheme: Scheme) -> Palette {
        palette_for(self.resolved_choice(), scheme, self.custom_theme.as_ref())
    }

    /// The GPUI theme: the palette, with the diff pair's colours over the diff tints.
    pub fn theme(&self, system: Scheme) -> Theme {
        let scheme = self.theme.resolve(system);
        let mut theme = self.palette(scheme).to_theme(scheme);
        let pair = diff_pair(&self.options.diff_colors);
        let colors = if scheme == Scheme::Dark { pair.dark } else { pair.light };
        if let Some((add, remove)) = colors {
            // `tint(color, 14%/28%)`: translucent, so it sits on any surface.
            let rgba = |hex: String| super::palette::parse_rgba(&hex);
            theme.diff_add = rgba(with_alpha(add, 0.14));
            theme.diff_add_word = rgba(with_alpha(add, 0.28));
            theme.diff_remove = rgba(with_alpha(remove, 0.14));
            theme.diff_remove_word = rgba(with_alpha(remove, 0.28));
        }
        theme
    }

    /// Picks `id` and, for a registered theme, leaves the custom theme alone.
    pub fn choose_theme(&mut self, id: &str) {
        if id == "custom" || is_theme_id(id) {
            self.color_theme = id.to_string();
        }
    }

    /// The Custom theme checkbox (`Settings.tsx`): off falls back to the default theme if custom was chosen; on seeds
    /// the custom theme from the current theme and selects it.
    pub fn set_custom_enabled(&mut self, enabled: bool) {
        self.custom_theme_enabled = enabled;
        if !enabled {
            if self.color_theme == "custom" {
                self.color_theme = DEFAULT_THEME_ID.into();
            }
            return;
        }
        let from = if self.color_theme == "custom" { DEFAULT_THEME_ID.to_string() } else { self.color_theme.clone() };
        if self.custom_theme.is_none() {
            self.custom_theme = Some(seeds_from(&from));
        }
        self.color_theme = "custom".into();
    }

    /// Saves edited seeds and selects the custom theme (`save` in `CustomThemeEditor.tsx`).
    pub fn save_custom(&mut self, theme: CustomTheme) {
        self.custom_theme = Some(theme);
        self.color_theme = "custom".into();
    }
}

/// `resolvePalette`: `custom` without a custom theme, or an unknown id, falls back to Milagre Blue.
pub fn palette_for(choice: &str, scheme: Scheme, custom: Option<&CustomTheme>) -> Palette {
    match (choice, custom) {
        ("custom", Some(custom)) => build_palette(&custom_source(custom.seeds(scheme)), scheme),
        _ => theme_palette(choice, scheme),
    }
}

/// Swatch colours of a picker tile: the dark palette's page and accent (`themeSwatch`).
pub fn theme_swatch(choice: &str, custom: Option<&CustomTheme>) -> (String, String) {
    let p = palette_for(choice, Scheme::Dark, custom);
    (p.page, p.accent)
}

/// The scheme the platform reports. `MILAGRE_GPUI_THEME` overrides it (the spike's stand-in for the system).
pub fn system_scheme(cx: &App) -> Scheme {
    match std::env::var("MILAGRE_GPUI_THEME").as_deref() {
        Ok("light") => return Scheme::Light,
        Ok("dark") => return Scheme::Dark,
        _ => {}
    }
    match cx.window_appearance() {
        gpui::WindowAppearance::Light | gpui::WindowAppearance::VibrantLight => Scheme::Light,
        gpui::WindowAppearance::Dark | gpui::WindowAppearance::VibrantDark => Scheme::Dark,
    }
}

/// The state last pushed into the theme global, so only a real change re-themes the window.
struct Applied(AppearanceState);
impl Global for Applied {}

/// Records `state` as what the window already wears, so only a later change re-themes it.
pub fn mark_applied(state: &AppearanceState, cx: &mut App) {
    set_live(state.options.live_style(&installed_probe(cx)));
    cx.set_global(Applied(state.clone()));
}

/// Re-themes the whole window when the Appearance state changed: sets the [`Theme`] global, which the
/// gpui-component bridge and every view observe.
pub fn apply(state: &AppearanceState, cx: &mut App) {
    let unchanged = cx.try_global::<Applied>().is_some_and(|a| a.0 == *state);
    if unchanged {
        return;
    }
    let theme = state.theme(system_scheme(cx));
    let live_changed = set_live(state.options.live_style(&installed_probe(cx)));
    cx.set_global(Applied(state.clone()));
    let theme_changed = cx.try_global::<Theme>().is_none_or(|current| *current != theme);
    if theme_changed {
        cx.set_global(theme);
    }
    // Fonts, sizes and widths are read in `render`: one refresh rebuilds every view once, the cached ones included. A
    // theme change already refreshes through the component bridge; the bridge also carries the fonts to the widgets.
    if live_changed {
        crate::theme::component_bridge::apply(cx);
    }
}

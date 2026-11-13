//! Headless tests for WP-40: the colour maths and palettes against `packages/shared/src/themes` (vectors generated
//! by running the TypeScript), the custom theme rules, the live re-theme of the window, the editor and the preview.

use std::time::Duration;

use gpui::{BorrowAppContext, ClipboardItem, Modifiers, Rgba, TestAppContext, VisualTestContext};
use serde_json::Value;

use super::color::*;
use super::custom::*;
use super::model::*;
use super::palette::{Palette, Scheme, parse_rgba};
use super::picker::{SV_HEIGHT, SV_WIDTH, hue_at, sv_at};
use super::preview::PreviewArea;
use super::themes::{DEFAULT_THEME_ID, ThemeGroup, get_theme, themes};
use crate::settings::search::SettingsSectionId;
use crate::settings::store::SettingsStore;
use crate::testing;
use crate::theme::{ActiveTheme, Theme, to_hex};

const VECTORS: &str = include_str!("theme_vectors.json");

/// The palette fields in the order the vector file lists them (`ThemePalette` keys, camelCase there).
fn fields(p: &Palette) -> Vec<&str> {
    vec![
        &p.page,
        &p.canvas,
        &p.surface,
        &p.inset,
        &p.hover,
        &p.hover2,
        &p.field,
        &p.ink,
        &p.ink2,
        &p.ink3,
        &p.ink4,
        &p.on_accent,
        &p.on_green,
        &p.on_orange,
        &p.on_red,
        &p.line,
        &p.line_strong,
        &p.accent,
        &p.accent_ink,
        &p.accent_tint,
        &p.green,
        &p.green_tint,
        &p.orange,
        &p.orange_tint,
        &p.red,
        &p.red_tint,
        &p.green_ink,
        &p.orange_ink,
        &p.red_ink,
        &p.purple,
        &p.diff_add,
        &p.diff_add_word,
        &p.diff_remove,
        &p.diff_remove_word,
    ]
}

fn near(a: &str, b: &str, tolerance: f64) -> bool {
    let (x, y) = (parse(a).unwrap(), parse(b).unwrap());
    let t = tolerance / 255.0 + 1e-9;
    (x.r - y.r).abs() <= t && (x.g - y.g).abs() <= t && (x.b - y.b).abs() <= t && (x.alpha - y.alpha).abs() <= t
}

fn settle(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    crate::fitcheck::harness::draw(cx);
    crate::fitcheck::harness::draw(cx);
}

fn click(cx: &mut VisualTestContext, selector: &'static str) {
    let at = cx.debug_bounds(selector).unwrap_or_else(|| panic!("`{selector}` is not drawn")).center();
    cx.simulate_click(at, Modifiers::none());
    settle(cx);
}

/// Scrolls the Settings body so `selector` is inside the dialog, then clicks it.
fn click_scrolled(cx: &mut VisualTestContext, workspace: &gpui::Entity<crate::workspace::Workspace>, selector: &'static str) {
    let body = cx.debug_bounds("settings-main").expect("settings body");
    let at = cx.debug_bounds(selector).unwrap_or_else(|| panic!("`{selector}` is not drawn"));
    let overshoot = f32::from(at.bottom() - body.bottom()) + 120.0;
    if overshoot > 0.0 {
        let settings = workspace.read_with(cx, |w, _| w.settings.clone());
        let handle = settings.read_with(cx, |s, _| s.body_scroll().clone());
        let current = handle.offset();
        handle.set_offset(gpui::point(current.x, current.y - gpui::px(overshoot)));
        settle(cx);
    }
    click(cx, selector);
}

fn open_appearance(cx: &mut TestAppContext) -> (gpui::Entity<crate::workspace::Workspace>, &mut VisualTestContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    settle(cx);
    let settings = workspace.read_with(cx, |w, _| w.settings.clone());
    settings.update_in(cx, |s, window, cx| s.open_section(SettingsSectionId::Appearance, window, cx));
    settle(cx);
    // A fixed mode, so the platform's appearance never decides a test.
    cx.update(|_, cx| cx.update_global::<SettingsStore, _>(|s, _| s.appearance.theme = ThemePreference::Dark));
    settle(cx);
    (workspace, cx)
}

fn theme_now(cx: &mut VisualTestContext) -> Theme {
    cx.update(|_, cx| *cx.theme())
}

fn appearance_now(cx: &mut VisualTestContext) -> AppearanceState {
    cx.update(|_, cx| cx.global::<SettingsStore>().appearance.clone())
}

// ------------------------------------------------------------------ colour maths and palettes

#[test]
fn every_theme_palette_matches_the_typescript_engine() {
    let vectors: Value = serde_json::from_str(VECTORS).unwrap();
    assert_eq!(themes().len(), 12, "twelve themes");
    let custom = CustomTheme {
        light: ThemeSeeds { background: "#f5f0e6".into(), text: "#2b2b2b".into(), accent: "#c2410c".into() },
        dark: ThemeSeeds { background: "#101820".into(), text: "#e6edf3".into(), accent: "#ff7a59".into() },
    };
    let mut checked = 0;
    for (name, expected) in vectors.as_object().unwrap() {
        let Some((id, scheme)) = name.split_once(':') else { continue };
        let scheme = if scheme == "dark" { Scheme::Dark } else { Scheme::Light };
        let palette = palette_for(id, scheme, Some(&custom));
        let got = fields(&palette);
        let expected = expected.as_array().unwrap();
        assert_eq!(got.len(), expected.len());
        for (ix, (g, e)) in got.iter().zip(expected).enumerate() {
            let e = e.as_str().unwrap();
            assert!(near(g, e, 1.0), "{name} field {ix}: got {g}, TypeScript says {e}");
            checked += 1;
        }
    }
    assert_eq!(checked, 26 * 34, "12 themes and the custom theme, both schemes, 34 colours");
}

/// Terminal and code colours (`ansi`, `syntax`, `cursor`, `selection`) of every theme, both schemes, and the custom theme,
/// against vectors from `tools/gen-theme-code-vectors.mjs`, which runs the TypeScript; then the GPUI theme they land in.
#[test]
fn every_theme_terminal_and_syntax_colours_match_the_typescript_engine() {
    let vectors: Value = serde_json::from_str(VECTORS).unwrap();
    let custom = CustomTheme {
        light: ThemeSeeds { background: "#f5f0e6".into(), text: "#2b2b2b".into(), accent: "#c2410c".into() },
        dark: ThemeSeeds { background: "#101820".into(), text: "#e6edf3".into(), accent: "#ff7a59".into() },
    };
    let mut checked = 0;
    for (name, expected) in vectors["code"].as_object().unwrap() {
        let (id, scheme) = name.split_once(':').unwrap();
        let scheme = if scheme == "dark" { Scheme::Dark } else { Scheme::Light };
        let palette = palette_for(id, scheme, Some(&custom));
        let theme = palette.to_theme(scheme);
        let want =
            |key: &str| -> Vec<String> { expected[key].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect() };
        let colours = |got: &[Rgba], want: &[String], what: &str| {
            assert_eq!(got.len(), want.len(), "{name} {what}");
            for (ix, (g, w)) in got.iter().zip(want).enumerate() {
                assert!(rgba_close(*g, parse_rgba(w)), "{name} {what} {ix}: got {}, TypeScript says {w}", to_hex(*g));
            }
        };
        // The hex strings the palette carries, and the GPUI colours made from them.
        for (got, want) in palette.ansi.iter().zip(want("ansi")) {
            assert!(near(got, &want, 1.0), "{name} ansi: got {got}, TypeScript says {want}");
        }
        for (got, want) in palette.syntax.iter().zip(want("syntax")) {
            assert!(near(got, &want, 1.0), "{name} syntax: got {got}, TypeScript says {want}");
        }
        colours(&theme.terminal.ansi, &want("ansi"), "terminal ansi");
        colours(&theme.syntax.all(), &want("syntax"), "syntax");
        colours(
            &[theme.terminal.cursor, theme.terminal.selection],
            &[expected["cursor"].as_str().unwrap().into(), expected["selection"].as_str().unwrap().into()],
            "cursor, selection",
        );
        // The code block is the theme's inset with its line round it (`bg-inset border-line`).
        assert_eq!((theme.code_bg, theme.code_border), (theme.inset, theme.line), "{name} code surface");
        checked += 16 + 11 + 2;
    }
    assert_eq!(checked, 26 * 29, "12 themes and the custom theme, both schemes, 16 ANSI + 11 syntax + cursor + selection");
}

/// The bug behind this: two dark themes differ in the code colours, so a switch has to reach them.
#[test]
fn a_warm_dark_theme_does_not_wear_milagre_blues_code_colours() {
    let blue = Theme::dark();
    let gruvbox = palette_for("gruvbox", Scheme::Dark, None).to_theme(Scheme::Dark);
    assert_eq!(gruvbox.appearance, blue.appearance);
    for (what, a, b) in [
        ("code background", gruvbox.code_bg, blue.code_bg),
        ("code border", gruvbox.code_border, blue.code_border),
        ("keyword", gruvbox.syntax.keyword, blue.syntax.keyword),
        ("string", gruvbox.syntax.string, blue.syntax.string),
        ("ANSI red", gruvbox.terminal.ansi[1], blue.terminal.ansi[1]),
    ] {
        assert_ne!(a, b, "{what} follows the theme");
    }
}

#[test]
fn custom_contrast_readout_matches_typescript() {
    let vectors: Value = serde_json::from_str(VECTORS).unwrap();
    let dark = ThemeSeeds { background: "#101820".into(), text: "#e6edf3".into(), accent: "#ff7a59".into() };
    let contrast = custom_contrast(&dark);
    assert!((contrast.text - vectors["contrast"]["text"].as_f64().unwrap()).abs() < 1e-6);
    assert!((contrast.accent - vectors["contrast"]["accent"].as_f64().unwrap()).abs() < 1e-6);
    assert!(!contrast.weak());
    let weak = custom_contrast(&ThemeSeeds { background: "#ffffff".into(), text: "#bbbbbb".into(), accent: "#eeeeee".into() });
    assert!(weak.weak(), "light grey text on white is flagged");
    assert!((contrast_ratio("#000000", "#ffffff") - 21.0).abs() < 1e-9);
}

fn rgba_close(a: Rgba, b: Rgba) -> bool {
    let t = 1.5 / 255.0;
    (a.r - b.r).abs() <= t && (a.g - b.g).abs() <= t && (a.b - b.b).abs() <= t && (a.a - b.a).abs() <= t
}

#[test]
fn milagre_blue_builds_the_design_md_theme() {
    for (scheme, design) in [(Scheme::Dark, Theme::dark()), (Scheme::Light, Theme::light())] {
        let built = AppearanceState::default().palette(scheme).to_theme(scheme);
        assert_eq!(built.appearance, design.appearance);
        let pairs = [
            ("page", built.page, design.page),
            ("canvas", built.canvas, design.canvas),
            ("surface", built.surface, design.surface),
            ("inset", built.inset, design.inset),
            ("field", built.field, design.field),
            ("hover", built.hover, design.hover),
            ("hover2", built.hover2, design.hover2),
            ("line", built.line, design.line),
            ("line_strong", built.line_strong, design.line_strong),
            ("ink", built.ink, design.ink),
            ("ink2", built.ink2, design.ink2),
            ("ink3", built.ink3, design.ink3),
            ("ink4", built.ink4, design.ink4),
            ("on_ink", built.on_ink, design.on_ink),
            ("scrim", built.scrim, design.scrim),
            ("accent", built.accent, design.accent),
            ("accent_ink", built.accent_ink, design.accent_ink),
            ("accent_tint", built.accent_tint, design.accent_tint),
            ("on_accent", built.on_accent, design.on_accent),
            ("green", built.green, design.green),
            ("green_ink", built.green_ink, design.green_ink),
            ("green_tint", built.green_tint, design.green_tint),
            ("orange", built.orange, design.orange),
            ("orange_ink", built.orange_ink, design.orange_ink),
            ("red", built.red, design.red),
            ("red_ink", built.red_ink, design.red_ink),
            ("purple_ink", built.purple_ink, design.purple_ink),
            ("purple_tint", built.purple_tint, design.purple_tint),
            ("diff_add", built.diff_add, design.diff_add),
            ("diff_remove_word", built.diff_remove_word, design.diff_remove_word),
        ];
        for (name, got, want) in pairs {
            assert!(rgba_close(got, want), "{scheme:?} {name}: built {} vs DESIGN.md {}", to_hex(got), to_hex(want));
        }
    }
}

#[test]
fn colour_maths_round_trips() {
    assert!(parse("#12345").is_none() && parse("123456").is_none() && parse("#12345g").is_none());
    assert!(is_seed("#a1b2c3") && !is_seed("#a1b2c3ff"));
    let c = hex_to_oklch("#3e9afd");
    assert!(near(&from_oklch(c.l, c.c, c.h), "#3e9afd", 1.0));
    assert_eq!(with_alpha("#112233", 0.5), "#11223380");
    assert_eq!(over("#ffffff80", "#000000"), "#808080");
    for hex in ["#000000", "#ffffff", "#3e9afd", "#ee5c61", "#808080"] {
        let (h, s, v) = hex_to_hsv(hex);
        assert_eq!(hsv_to_hex(h, s, v), hex);
    }
    // readable_on moves a colour toward the target only as far as the ratio needs.
    let bg = vec!["#ffffff".to_string()];
    let fixed = readable_on("#cccccc", "#000000", &bg, 4.5);
    assert!(contrast_ratio(&fixed, "#ffffff") >= 4.5);
    assert_eq!(readable_on("#222222", "#000000", &bg, 4.5), "#222222");
}

#[test]
fn custom_theme_parses_normalises_and_serialises_like_typescript() {
    let json = r##"{"light":{"background":"#FFFFFF","text":"#111111","accent":"#0000FF"},"dark":{"background":"#000000","text":"#EEEEEE","accent":"#00FF00"}}"##;
    let parsed = parse_custom_theme(json).expect("valid");
    assert_eq!(parsed.light.background, "#ffffff");
    assert_eq!(parsed.dark.accent, "#00ff00");
    assert_eq!(parse_custom_theme(&serialize_custom_theme(&parsed)), Some(parsed.clone()));
    assert!(serialize_custom_theme(&parsed).starts_with("{\n  \"light\": {\n    \"background\": \"#ffffff\","));
    for bad in ["", "nope", "[]", "{}", r##"{"light":{"background":"#fff","text":"#111111","accent":"#0000ff"},"dark":{}}"##] {
        assert!(parse_custom_theme(bad).is_none(), "rejects {bad:?}");
    }
    let from = seeds_from("dracula");
    assert_eq!(from.dark.background, "#282a36");
    assert_eq!(from.light.accent, "#644ac9");
}

// ------------------------------------------------------------------ settings model

#[test]
fn registry_has_the_react_groups_and_names() {
    let names = |g: ThemeGroup| themes().iter().filter(|t| t.group == g).map(|t| t.name).collect::<Vec<_>>();
    assert_eq!(names(ThemeGroup::Milagre), ["Milagre Blue", "Gray"]);
    assert_eq!(names(ThemeGroup::Catppuccin), ["Mocha", "Macchiato", "Frappé"]);
    assert_eq!(names(ThemeGroup::Popular).len(), 7);
    assert_eq!(get_theme("catppuccin-mocha").unwrap().light_name, "Latte");
}

#[test]
fn custom_needs_the_switch_and_seeds_and_falls_back_to_milagre_blue() {
    let mut a = AppearanceState::default();
    assert_eq!(a.resolved_choice(), DEFAULT_THEME_ID);
    a.choose_theme("nord");
    assert_eq!(a.resolved_choice(), "nord");
    a.choose_theme("not-a-theme");
    assert_eq!(a.color_theme, "nord", "an unknown id is ignored");
    // Turning custom on seeds it from the current theme and selects it.
    a.set_custom_enabled(true);
    assert_eq!(a.color_theme, "custom");
    assert_eq!(a.custom_theme, Some(seeds_from("nord")));
    assert_eq!(a.resolved_choice(), "custom");
    // Off: back to the default theme.
    a.set_custom_enabled(false);
    assert_eq!(a.color_theme, DEFAULT_THEME_ID);
    // A saved "custom" with the switch off reads as the default.
    a.color_theme = "custom".into();
    assert_eq!(a.resolved_choice(), DEFAULT_THEME_ID);
}

#[test]
fn options_clamp_and_resolve_like_appearance_mjs() {
    assert_eq!(clamp_chat_width(10), 600);
    assert_eq!(clamp_chat_width(99999), 2400);
    let mut o = AppearanceOptions::default();
    assert_eq!((o.chat_px(), o.code_px(), o.sidebar_delta()), (14, 12, 0));
    assert_eq!(o.chat_width_limit(), Some(704));
    o.chat_width = "wide".into();
    assert_eq!(o.chat_width_limit(), Some(1024));
    o.chat_width = "full".into();
    assert_eq!(o.chat_width_limit(), None);
    o.chat_width = "custom".into();
    o.chat_width_px = 1500;
    assert_eq!(o.chat_width_limit(), Some(1500));
    o.motion = "fast".into();
    assert_eq!(o.motion_scale(), 0.6);
    o.sidebar_size = "larger".into();
    assert_eq!(o.sidebar_delta(), 2);
}

#[test]
fn fonts_offer_only_installed_ones_and_a_missing_saved_font_reads_as_system() {
    let installed = |label: &str| label == "Charter";
    let ids: Vec<&str> = available_fonts(UI_FONTS, &installed).iter().map(|f| f.id).collect();
    assert_eq!(ids, ["system", "inter", "geist", "charter"]);
    assert_eq!(shown_font(UI_FONTS, "charter", &installed), "charter");
    assert_eq!(shown_font(UI_FONTS, "avenir-next", &installed), "system");
    assert_eq!(shown_font(UI_FONTS, "gone", &installed), "system");
    let mono: Vec<&str> = available_fonts(MONO_FONTS, &|_| false).iter().map(|f| f.id).collect();
    assert_eq!(mono, ["system", "jetbrains-mono", "geist-mono"]);
}

#[test]
fn diff_pairs_recolour_the_diff_tints_and_red_green_keeps_the_theme() {
    let mut a = AppearanceState { theme: ThemePreference::Dark, ..Default::default() };
    let base = a.theme(Scheme::Dark);
    a.options.diff_colors = "blue-orange".into();
    let blue = a.theme(Scheme::Dark);
    assert_ne!(blue.diff_add, base.diff_add);
    assert!(rgba_close(blue.diff_add, parse_rgba("#58a6ff24")), "14% of the dark add colour");
    assert_eq!(blue.page, base.page, "only the diff tokens move");
}

#[test]
fn system_mode_follows_the_platform_scheme() {
    let a = AppearanceState::default();
    assert_eq!(a.theme(Scheme::Light).appearance, crate::theme::Appearance::Light);
    assert_eq!(a.theme(Scheme::Dark).appearance, crate::theme::Appearance::Dark);
    let forced = AppearanceState { theme: ThemePreference::Light, ..Default::default() };
    assert_eq!(forced.theme(Scheme::Dark).appearance, crate::theme::Appearance::Light);
}

#[test]
fn picker_maps_points_to_colour() {
    assert_eq!(sv_at(0.0, 0.0), (0.0, 1.0));
    assert_eq!(sv_at(SV_WIDTH, SV_HEIGHT), (1.0, 0.0));
    assert_eq!(sv_at(-20.0, 900.0), (0.0, 0.0), "clamped outside the square");
    assert_eq!(hue_at(0.0), 0.0);
    assert!((hue_at(SV_WIDTH / 2.0) - 180.0).abs() < 1e-9);
    assert_eq!(hue_at(SV_WIDTH * 3.0), 360.0);
}

// ------------------------------------------------------------------ the page

#[gpui::test]
fn the_page_draws_every_group_and_twelve_theme_tiles(cx: &mut TestAppContext) {
    let (_workspace, cx) = open_appearance(cx);
    assert!(cx.debug_bounds("settings-section-appearance").is_some());
    assert!(cx.debug_bounds("theme-picker").is_some());
    for theme in themes() {
        let selector = testing::leak(format!("theme-tile-{}", theme.id));
        assert!(cx.debug_bounds(selector).is_some(), "{} tile", theme.id);
    }
    assert!(cx.debug_bounds("theme-tile-custom").is_none(), "no Custom tile until the switch is on");
    for group in ["settings-group-mode", "settings-group-custom-theme"] {
        assert!(cx.debug_bounds(group).is_some(), "{group}");
    }
}

#[gpui::test]
fn choosing_a_theme_re_themes_the_window_without_a_reload(cx: &mut TestAppContext) {
    let (_workspace, cx) = open_appearance(cx);
    let before = theme_now(cx);
    click(cx, "theme-tile-dracula");
    let after = theme_now(cx);
    assert_ne!(before.page, after.page);
    assert!(rgba_close(after.page, parse_rgba("#282a36")), "Dracula dark page, got {}", to_hex(after.page));
    assert_eq!(appearance_now(cx).color_theme, "dracula");
    // gpui-component's widgets follow through the theme bridge.
    let component = cx.update(|_, cx| gpui_component::Theme::global(cx).background);
    let component: Rgba = component.into();
    assert!(rgba_close(component, after.page), "the bridge re-applied the colours: {} vs {}", to_hex(component), to_hex(after.page));

    // The mode switches the scheme of the same theme: Dracula's light is Alucard.
    cx.update(|_, cx| cx.update_global::<SettingsStore, _>(|s, _| s.appearance.theme = ThemePreference::Light));
    settle(cx);
    let light = theme_now(cx);
    assert!(rgba_close(light.page, parse_rgba("#fffbeb")), "Alucard page, got {}", to_hex(light.page));
    assert_eq!(light.appearance, crate::theme::Appearance::Light);
    // Unrelated settings do not touch the theme.
    cx.update(|_, cx| cx.update_global::<SettingsStore, _>(|s, _| s.keep_awake = !s.keep_awake));
    settle(cx);
    assert_eq!(theme_now(cx), light);
}

#[gpui::test]
fn mode_control_sets_the_preference(cx: &mut TestAppContext) {
    let (_workspace, cx) = open_appearance(cx);
    assert_eq!(appearance_now(cx).theme, ThemePreference::Dark);
    click(cx, "appearance-mode");
    // The segmented control is one element; clicking its centre picks the middle segment (Light).
    assert_eq!(appearance_now(cx).theme, ThemePreference::Light);
    assert_eq!(theme_now(cx).appearance, crate::theme::Appearance::Light);
}

#[gpui::test]
fn custom_theme_editor_edits_live_and_reads_out_contrast(cx: &mut TestAppContext) {
    let (_workspace, cx) = open_appearance(cx);
    assert!(cx.debug_bounds("custom-theme-editor").is_none());
    click_scrolled(cx, &_workspace, "settings-row-custom-theme");
    let state = appearance_now(cx);
    assert!(state.custom_theme_enabled);
    assert_eq!(state.color_theme, "custom");
    assert!(cx.debug_bounds("custom-theme-editor").is_some());
    assert!(cx.debug_bounds("theme-tile-custom").is_some(), "Custom joins the Milagre tiles");
    assert!(cx.debug_bounds("custom-theme-preview").is_some());
    assert!(cx.debug_bounds("seed-swatch-background").is_some() && cx.debug_bounds("seed-swatch-accent").is_some());

    // Typing a full hex commits at once and re-themes the window.
    let view = cx.update(|_, cx| cx.global::<SettingsStore>().appearance.clone());
    assert_eq!(view.custom_theme, Some(seeds_from(DEFAULT_THEME_ID)));
    let settings = _workspace.read_with(cx, |w, _| w.settings.clone());
    let appearance = settings.read_with(cx, |s, _| s.appearance_view().clone());
    appearance.update(cx, |v, cx| {
        v.set_editing(Scheme::Dark, cx);
        v.edit_seed("background", "#112233", cx)
    });
    settle(cx);
    let themed = theme_now(cx);
    assert!(rgba_close(themed.page, parse_rgba("#112233")), "custom dark page, got {}", to_hex(themed.page));
    assert_eq!(appearance_now(cx).custom_theme.unwrap().dark.background, "#112233");

    // The readout is a ratio per seed, orange when weak.
    appearance.update(cx, |v, cx| v.edit_seed("text", "#112234", cx));
    settle(cx);
    assert!(cx.debug_bounds("custom-contrast").is_some());
    let contrast = custom_contrast(&appearance_now(cx).custom_theme.unwrap().dark);
    assert!(contrast.weak());

    // Turning it off falls back to the default theme.
    click_scrolled(cx, &_workspace, "settings-row-custom-theme");
    assert_eq!(appearance_now(cx).color_theme, DEFAULT_THEME_ID);
    assert!(cx.debug_bounds("custom-theme-editor").is_none());
}

#[gpui::test]
fn colour_picker_drag_writes_the_seed(cx: &mut TestAppContext) {
    let (workspace, cx) = open_appearance(cx);
    click_scrolled(cx, &workspace, "settings-row-custom-theme");
    let settings = workspace.read_with(cx, |w, _| w.settings.clone());
    let view = settings.read_with(cx, |s, _| s.appearance_view().clone());
    view.update(cx, |v, cx| v.set_editing(Scheme::Dark, cx));
    settle(cx);
    click_scrolled(cx, &workspace, "seed-swatch-accent");
    let square = cx.debug_bounds("color-picker-square").expect("picker open");
    let before = appearance_now(cx).custom_theme.unwrap().dark.accent;
    // Press near the square's top-left corner: low saturation, high value.
    cx.simulate_mouse_down(square.origin + gpui::point(gpui::px(4.0), gpui::px(4.0)), gpui::MouseButton::Left, Modifiers::none());
    cx.simulate_mouse_up(square.origin + gpui::point(gpui::px(4.0), gpui::px(4.0)), gpui::MouseButton::Left, Modifiers::none());
    settle(cx);
    let after = appearance_now(cx).custom_theme.unwrap().dark.accent;
    assert_ne!(before, after);
    let (_, s, v) = hex_to_hsv(&after);
    assert!(s < 0.1 && v > 0.9, "a near-white pick, got {after}");
    let _ = workspace;
}

#[gpui::test]
fn copy_and_paste_json_round_trip_and_report_a_bad_paste(cx: &mut TestAppContext) {
    let (workspace, cx) = open_appearance(cx);
    click_scrolled(cx, &workspace, "settings-row-custom-theme");
    let settings = workspace.read_with(cx, |w, _| w.settings.clone());
    let view = settings.read_with(cx, |s, _| s.appearance_view().clone());
    view.update(cx, |v, cx| v.set_editing(Scheme::Dark, cx));
    click_scrolled(cx, &workspace, "custom-copy-json");
    let copied = cx.update(|_, cx| cx.read_from_clipboard().and_then(|c| c.text())).expect("copied");
    assert_eq!(parse_custom_theme(&copied), appearance_now(cx).custom_theme);

    cx.update(|_, cx| cx.write_to_clipboard(ClipboardItem::new_string("not a theme".into())));
    click_scrolled(cx, &workspace, "custom-paste-json");
    assert!(view.read_with(cx, |v, _| v.paste_error().is_some_and(|e| e.starts_with("That isn't a Milagre theme"))));
    assert!(cx.debug_bounds("inline-error").is_some());

    let good = r##"{"light":{"background":"#fafafa","text":"#222222","accent":"#0055ff"},"dark":{"background":"#0a0a0a","text":"#f0f0f0","accent":"#55aaff"}}"##;
    cx.update(|_, cx| cx.write_to_clipboard(ClipboardItem::new_string(good.into())));
    click_scrolled(cx, &workspace, "custom-paste-json");
    assert_eq!(view.read_with(cx, |v, _| v.paste_error().map(str::to_string)), None);
    assert!(rgba_close(theme_now(cx).page, parse_rgba("#0a0a0a")));

    click_scrolled(cx, &workspace, "custom-reset");
    assert_eq!(appearance_now(cx).custom_theme, Some(seeds_from(DEFAULT_THEME_ID)));
}

#[gpui::test]
fn preview_highlights_the_area_of_the_hovered_or_changed_row(cx: &mut TestAppContext) {
    let (workspace, cx) = open_appearance(cx);
    let settings = workspace.read_with(cx, |w, _| w.settings.clone());
    let view = settings.read_with(cx, |s, _| s.appearance_view().clone());
    assert!(cx.debug_bounds("appearance-window-preview").is_some());
    let size = cx.debug_bounds("appearance-window-preview").unwrap().size;
    assert!((f32::from(size.width) - 1440.0 * 0.49).abs() < 1.0);
    assert_eq!(view.read_with(cx, |v, _| v.highlight()), None);

    // A change holds its area for a moment, then lets go.
    view.update(cx, |v, cx| v.hold(Some(PreviewArea::Diff), cx));
    assert_eq!(view.read_with(cx, |v, _| v.highlight()), Some(PreviewArea::Diff));
    settle(cx);
    cx.executor().advance_clock(Duration::from_millis(1600));
    settle(cx);
    assert_eq!(view.read_with(cx, |v, _| v.highlight()), None);

    // A later hold wins over an earlier timer.
    view.update(cx, |v, cx| v.hold(Some(PreviewArea::Chat), cx));
    cx.executor().advance_clock(Duration::from_millis(1000));
    view.update(cx, |v, cx| v.hold(Some(PreviewArea::Code), cx));
    cx.executor().advance_clock(Duration::from_millis(1000));
    settle(cx);
    assert_eq!(view.read_with(cx, |v, _| v.highlight()), Some(PreviewArea::Code));
}

#[gpui::test]
fn preview_follows_the_sidebar_usage_and_chat_width_options(cx: &mut TestAppContext) {
    let (_workspace, cx) = open_appearance(cx);
    let draws = |cx: &mut VisualTestContext| cx.debug_bounds("appearance-window-preview").is_some();
    for (usage, width) in [("expanded", "comfortable"), ("compact", "wide"), ("compact", "full"), ("expanded", "custom")] {
        cx.update(|_, cx| {
            cx.update_global::<SettingsStore, _>(|s, _| {
                s.appearance.options.sidebar_usage = usage.into();
                s.appearance.options.chat_width = width.into();
            })
        });
        settle(cx);
        assert!(draws(cx), "{usage} {width}");
    }
}

#[gpui::test]
fn custom_chat_width_field_commits_a_clamped_width(cx: &mut TestAppContext) {
    let (workspace, cx) = open_appearance(cx);
    cx.update(|_, cx| cx.update_global::<SettingsStore, _>(|s, _| s.appearance.options.chat_width = "custom".into()));
    settle(cx);
    let settings = workspace.read_with(cx, |w, _| w.settings.clone());
    let view = settings.read_with(cx, |s, _| s.appearance_view().clone());
    // Typing into the field commits once it is a width; out of range clamps.
    let input = view.read_with(cx, |v, _| v.width_input_for_test()).expect("field exists");
    cx.update(|window, cx| input.update(cx, |state, cx| state.focus(window, cx)));
    cx.simulate_input("5000");
    settle(cx);
    assert_eq!(appearance_now(cx).options.chat_width_px, 2400);
}

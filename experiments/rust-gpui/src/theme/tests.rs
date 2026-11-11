//! Theme tokens against DESIGN.md's tables, copied here by hand (Light and Dark columns).

use gpui::{Rgba, px};

use super::*;

/// Token name, then the Light and Dark values exactly as DESIGN.md writes them.
const DESIGN_MD: &[(&str, &str, &str)] = &[
    // Surfaces
    ("page", "#f4f9fe", "#0d1624"),
    ("canvas", "#e9f1fa", "#111b29"),
    ("surface", "#ffffff", "#172232"),
    ("inset", "#f9fcff", "#121c2b"),
    ("field", "#e8edf2", "#212c3c"),
    ("hover", "#1c222b0f", "#e9eff70d"),
    ("hover-2", "#1c222b1a", "#e9eff717"),
    ("line", "#edeeee", "#273242"),
    ("line-strong", "#e0e1e3", "#303b4a"),
    // Ink
    ("ink", "#1c222b", "#e9eff7"),
    ("ink-2", "#4b515a", "#abb2bd"),
    ("ink-3", "#60656d", "#939ca9"),
    ("ink-4", "#8c929a", "#646c79"),
    // Accent
    ("accent", "#007df3", "#3e9afd"),
    ("accent-ink", "#0068cd", "#80b9fd"),
    ("accent-tint", "#e3f0fe", "#3e9afd29"),
    ("on-accent", "#ffffff", "#0d1624"),
    // Status
    ("green", "#199a4d", "#3cbb72"),
    ("green-ink", "#00792e", "#3cbb72"),
    ("green-tint", "#e5f2ef", "#3cbb7224"),
    ("on-green", "#ffffff", "#0d1624"),
    ("orange", "#ef720d", "#f68f3c"),
    ("orange-ink", "#ba4100", "#f68f3c"),
    ("orange-tint", "#f5efee", "#f68f3c24"),
    ("on-orange", "#ffffff", "#0d1624"),
    ("red", "#e3474c", "#ee5c61"),
    ("red-ink", "#c62935", "#fd696d"),
    ("red-tint", "#f5ecef", "#ee5c6124"),
    ("on-red", "#ffffff", "#0d1624"),
    // Ultracode
    ("purple", "#ad46ff", "#ad46ff"),
    ("purple-ink", "#8e2bdc", "#d0a3ff"),
    ("purple-tint", "#f6edff", "#ad46ff2e"),
    // Diff
    ("diff-add", "#ddeee8", "#3cbb721f"),
    ("diff-add-word", "#bbddc8", "#3cbb724d"),
    ("diff-remove", "#f6e9ec", "#ee5c611f"),
    ("diff-remove-word", "#f7cecf", "#ee5c614d"),
];

fn token(t: &Theme, name: &str) -> Rgba {
    match name {
        "page" => t.page,
        "canvas" => t.canvas,
        "surface" => t.surface,
        "inset" => t.inset,
        "field" => t.field,
        "hover" => t.hover,
        "hover-2" => t.hover2,
        "line" => t.line,
        "line-strong" => t.line_strong,
        "ink" => t.ink,
        "ink-2" => t.ink2,
        "ink-3" => t.ink3,
        "ink-4" => t.ink4,
        "accent" => t.accent,
        "accent-ink" => t.accent_ink,
        "accent-tint" => t.accent_tint,
        "on-accent" => t.on_accent,
        "green" => t.green,
        "green-ink" => t.green_ink,
        "green-tint" => t.green_tint,
        "on-green" => t.on_green,
        "orange" => t.orange,
        "orange-ink" => t.orange_ink,
        "orange-tint" => t.orange_tint,
        "on-orange" => t.on_orange,
        "red" => t.red,
        "red-ink" => t.red_ink,
        "red-tint" => t.red_tint,
        "on-red" => t.on_red,
        "purple" => t.purple,
        "purple-ink" => t.purple_ink,
        "purple-tint" => t.purple_tint,
        "diff-add" => t.diff_add,
        "diff-add-word" => t.diff_add_word,
        "diff-remove" => t.diff_remove,
        "diff-remove-word" => t.diff_remove_word,
        other => panic!("no token {other}"),
    }
}

#[test]
fn dark_theme_matches_design_md() {
    let t = Theme::dark();
    assert_eq!(t.appearance, Appearance::Dark);
    for (name, _, dark) in DESIGN_MD {
        assert_eq!(to_hex(token(&t, name)), *dark, "dark `{name}`");
    }
    assert_eq!(t.on_ink, t.surface, "on-ink is the surface");
    assert_eq!(to_hex(t.scrim), "#00000066", "scrim is black at 40% in dark");
}

#[test]
fn light_theme_matches_design_md() {
    let t = Theme::light();
    assert_eq!(t.appearance, Appearance::Light);
    for (name, light, _) in DESIGN_MD {
        assert_eq!(to_hex(token(&t, name)), *light, "light `{name}`");
    }
    assert_eq!(t.on_ink, t.surface, "on-ink is the surface");
    assert_eq!(to_hex(t.scrim), "#00000033", "scrim is black at 20% in light");
}

#[test]
fn hex_keeps_alpha() {
    let c = hex("#e9eff70d");
    assert_eq!((c.a * 255.0).round() as u8, 0x0d);
    assert_eq!(to_hex(hex("#0D1624")), "#0d1624");
}

/// DESIGN.md "Type: Desktop".
#[test]
fn type_scale_matches_design_md() {
    let expected = [(26.0, 32.0), (22.0, 28.0), (17.0, 24.0), (15.0, 20.0), (13.0, 18.0), (12.0, 16.0), (11.0, 16.0), (10.0, 14.0)];
    for ((name, step), (size, line)) in TEXT_STEPS.iter().zip(expected) {
        assert_eq!((step.size, step.line_height), (size, line), "{name}");
    }
    assert_eq!((CHAT_TEXT.size, CHAT_TEXT.line_height), (14.0, 14.0 * 1.6));
}

/// DESIGN.md "Radius: desktop", "Sizes" and `projectAvatarRadius`.
#[test]
fn radii_and_sizes_match_design_md() {
    assert_eq!([RADIUS_INLINE, RADIUS_CHIP, RADIUS_CONTROL, RADIUS_CARD, RADIUS_WINDOW], [px(4.0), px(6.0), px(8.0), px(10.0), px(14.0)]);
    assert_eq!([CONTROL_XS, CONTROL_SM, CONTROL_MD, CONTROL_LG, ROW_TWO_LINE], [px(24.0), px(28.0), px(32.0), px(36.0), px(48.0)]);
    let radii: Vec<_> = [16.0, 20.0, 24.0, 32.0, 40.0, 72.0].into_iter().map(project_avatar_radius).collect();
    assert_eq!(radii, [px(4.0), px(6.0), px(6.0), px(10.0), px(10.0), px(20.0)]);
}

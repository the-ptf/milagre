//! Feeds gpui-component's theme (`gpui_component::Theme`) from Milagre's tokens, so its widgets draw in
//! DESIGN.md colours, radii and type instead of its own shadcn palette.
//!
//! [`init`] runs at startup after `gpui_component::init` and re-applies the bridge whenever the
//! [`Theme`] global is set again (a theme or scheme change). Both schemes are installed as
//! gpui-component's light and dark configs, so a later `gpui_component::Theme::change(mode)` (for
//! example `sync_system_appearance`) loads Milagre's colours too, not its defaults.
//!
//! The mapping is DESIGN.md's roles, not a colour-by-colour copy: gpui-component's `accent` is the
//! menu and list highlight (DESIGN.md `hover-2`), `primary` is the ink-filled primary button, `muted` is
//! a field, `ring` is the accent focus ring and `selection` is `accent-tint` (`::selection` in the
//! desktop's `styles.css`). WP-01's `COMPONENT-FIT.md` lists what the bridge cannot express (per-widget
//! sizes, the 10px popover radius next to the 14px dialog radius, focus marks on fields).

use std::rc::Rc;

use gpui::{App, Hsla, Rgba, SharedString};
use gpui_component::{ThemeConfig, ThemeConfigColors, ThemeMode};

use super::{Appearance, CODE_TEXT, RADIUS_CONTROL, RADIUS_WINDOW, SANS, Theme, mono, to_hex};

/// gpui-component's general radius: buttons, inputs, menus, list rows (`rounded-control`).
pub const COMPONENT_RADIUS: gpui::Pixels = RADIUS_CONTROL;
/// gpui-component's large radius: dialogs, the command palette, notifications (`rounded-window`).
pub const COMPONENT_RADIUS_LG: gpui::Pixels = RADIUS_WINDOW;
/// gpui-component's `font_size`. Its `Root` makes this the window's rem size every frame, and every
/// widget height and text step is in rems (`h_8`, `text_sm`). At 16 its steps land on DESIGN.md's grid
/// (`h_6` 24, `h_7` 28, `h_8` 32, `h_9` 36); at the 13px body size they come out at 19.5, 26 and so
/// on (measured in `fitcheck::widgets`). Widget text is then `text_sm` (14), not 13: a re-skin sets it.
pub const COMPONENT_REM: f32 = 16.0;

/// Installs the bridge: applies the current [`Theme`] now and again on every later `set_global::<Theme>`.
/// Call after `gpui_component::init`.
pub fn init(cx: &mut App) {
    apply(cx);
    cx.observe_global::<Theme>(apply).detach();
}

/// Writes the active Milagre [`Theme`] into gpui-component's theme (both scheme configs, the active
/// colours, fonts and radii) and refreshes every window.
pub fn apply(cx: &mut App) {
    let theme = *cx.global::<Theme>();
    let (light, dark) = (Rc::new(config(&Theme::light())), Rc::new(config(&Theme::dark())));
    let active = if theme.appearance == Appearance::Dark { dark.clone() } else { light.clone() };
    gpui_component::Theme::update(cx, move |component| {
        component.light_theme = light;
        component.dark_theme = dark;
        component.apply_config(&active);
        // Not in a theme config: the six base colours (private there) and the focus ring switch.
        let base = base_colors(&theme);
        component.red = base.red;
        component.red_light = base.red_light;
        component.green = base.green;
        component.green_light = base.green_light;
        component.blue = base.blue;
        component.blue_light = base.blue_light;
        component.yellow = base.yellow;
        component.yellow_light = base.yellow_light;
        component.magenta = base.magenta;
        component.magenta_light = base.magenta_light;
        component.cyan = base.cyan;
        component.cyan_light = base.cyan_light;
        // A theme config caps the selection at 30% alpha (and list/table highlights at 20%); light's
        // `accent-tint` is opaque. Selections paint under the glyphs, so set the token itself.
        component.selection = theme.accent_tint.into();
        // DESIGN.md "States": one accent ring on focus. Fields opt out per widget (COMPONENT-FIT.md).
        component.focus_ring = true;
    });
}

/// gpui-component's theme config for one Milagre scheme: every colour it reads, the fonts and radii.
pub fn config(theme: &Theme) -> ThemeConfig {
    let mut config = ThemeConfig::default();
    config.name = match theme.appearance {
        Appearance::Light => "Milagre Blue Light".into(),
        Appearance::Dark => "Milagre Blue Dark".into(),
    };
    config.mode = mode(theme.appearance);
    config.font_family = Some(SANS.into());
    config.font_size = Some(COMPONENT_REM);
    config.mono_font_family = Some(mono().into());
    config.mono_font_size = Some(CODE_TEXT.size);
    config.radius = Some(f32::from(COMPONENT_RADIUS) as usize);
    config.radius_lg = Some(f32::from(COMPONENT_RADIUS_LG) as usize);
    config.window_radius = Some(0);
    // Elevated surfaces (popovers, dialogs) draw a shadow; DESIGN.md's own shadow tokens are not
    // expressible here (gpui-component derives its elevations from one colour).
    config.shadow = Some(true);
    config.colors = colors(theme);
    config
}

/// The gpui-component mode for a Milagre appearance.
pub fn mode(appearance: Appearance) -> ThemeMode {
    match appearance {
        Appearance::Light => ThemeMode::Light,
        Appearance::Dark => ThemeMode::Dark,
    }
}

fn hex(c: Rgba) -> Option<SharedString> {
    Some(to_hex(c).into())
}

/// `c` with its alpha scaled by `alpha` (DESIGN.md's `hover:opacity-90` on filled buttons).
fn fade(c: Rgba, alpha: f32) -> Rgba {
    Rgba { a: c.a * alpha, ..c }
}

const TRANSPARENT: Rgba = Rgba { r: 0.0, g: 0.0, b: 0.0, a: 0.0 };

/// Every colour of a gpui-component theme config, from DESIGN.md roles.
pub fn colors(t: &Theme) -> ThemeConfigColors {
    let mut c = ThemeConfigColors::default();
    // Surfaces and text.
    c.background = hex(t.page);
    c.foreground = hex(t.ink);
    c.border = hex(t.line);
    c.input = hex(t.line_strong);
    c.muted = hex(t.field);
    c.muted_foreground = hex(t.ink3);
    c.overlay = hex(t.scrim);
    c.window_border = hex(t.line);
    c.caret = hex(t.ink);
    c.selection = hex(t.accent_tint);
    c.ring = hex(t.accent);
    c.link = hex(t.accent_ink);
    c.link_hover = hex(t.accent_ink);
    c.link_active = hex(t.accent_ink);
    c.drag_border = hex(t.accent);
    c.drop_target = hex(t.accent_tint);
    // The one moving highlight of menus, lists and pickers is `hover-2`; plain hover is `hover`.
    c.accent = hex(t.hover2);
    c.accent_foreground = hex(t.ink);
    c.popover = hex(t.surface);
    c.popover_foreground = hex(t.ink);
    // Buttons: primary is an ink fill with an on-ink label, hover at 90%; secondary is a surface that
    // hovers to `hover`; the danger button is a `red-ink` fill with an `on-red` label.
    c.primary = hex(t.ink);
    c.primary_hover = hex(fade(t.ink, 0.9));
    c.primary_active = hex(t.ink);
    c.primary_foreground = hex(t.on_ink);
    c.button_primary = hex(t.ink);
    c.button_primary_hover = hex(fade(t.ink, 0.9));
    c.button_primary_active = hex(t.ink);
    c.button_primary_foreground = hex(t.on_ink);
    c.secondary = hex(t.surface);
    c.secondary_hover = hex(t.hover);
    c.secondary_active = hex(t.hover2);
    c.secondary_foreground = hex(t.ink);
    c.button_secondary = hex(t.surface);
    c.button_secondary_hover = hex(t.hover);
    c.button_secondary_active = hex(t.hover2);
    c.button_secondary_foreground = hex(t.ink);
    c.button = hex(t.surface);
    c.button_hover = hex(t.hover);
    c.button_active = hex(t.hover2);
    c.button_foreground = hex(t.ink);
    // `danger` is the plain status red (fills, dots, the diff's removed rows at 12% and words at 30%,
    // which is DESIGN.md's dark `diff-remove` exactly); the danger *button* is `red-ink` below.
    c.danger = hex(t.red);
    c.danger_hover = hex(fade(t.red, 0.9));
    c.danger_active = hex(t.red);
    c.danger_foreground = hex(t.on_red);
    c.button_danger = hex(t.red_ink);
    c.button_danger_hover = hex(fade(t.red_ink, 0.9));
    c.button_danger_active = hex(t.red_ink);
    c.button_danger_foreground = hex(t.on_red);
    // Status fills with their `on-` labels. `success` is also the diff's added rows and words.
    c.success = hex(t.green);
    c.success_hover = hex(fade(t.green, 0.9));
    c.success_active = hex(t.green);
    c.success_foreground = hex(t.on_green);
    c.button_success = hex(t.green_ink);
    c.button_success_hover = hex(fade(t.green_ink, 0.9));
    c.button_success_active = hex(t.green_ink);
    c.button_success_foreground = hex(t.on_green);
    c.warning = hex(t.orange);
    c.warning_hover = hex(fade(t.orange, 0.9));
    c.warning_active = hex(t.orange);
    c.warning_foreground = hex(t.on_orange);
    c.button_warning = hex(t.orange_ink);
    c.button_warning_hover = hex(fade(t.orange_ink, 0.9));
    c.button_warning_active = hex(t.orange_ink);
    c.button_warning_foreground = hex(t.on_orange);
    c.info = hex(t.accent);
    c.info_hover = hex(fade(t.accent, 0.9));
    c.info_active = hex(t.accent);
    c.info_foreground = hex(t.on_accent);
    c.button_info = hex(t.accent);
    c.button_info_hover = hex(fade(t.accent, 0.9));
    c.button_info_active = hex(t.accent);
    c.button_info_foreground = hex(t.on_accent);
    // Lists, tables, tabs: rows hover `hover`, the open or selected one is `hover-2`, never accent.
    c.list = hex(TRANSPARENT);
    c.list_even = hex(TRANSPARENT);
    c.list_head = hex(TRANSPARENT);
    c.list_hover = hex(t.hover);
    c.list_active = hex(t.hover2);
    c.list_active_border = hex(TRANSPARENT);
    c.table = hex(TRANSPARENT);
    c.table_even = hex(TRANSPARENT);
    c.table_head = hex(t.inset);
    c.table_head_foreground = hex(t.ink2);
    c.table_foot = hex(TRANSPARENT);
    c.table_foot_foreground = hex(t.ink2);
    c.table_hover = hex(t.hover);
    c.table_active = hex(t.hover2);
    c.table_active_border = hex(TRANSPARENT);
    c.table_row_border = hex(t.line);
    c.tab = hex(TRANSPARENT);
    c.tab_active = hex(t.hover2);
    c.tab_active_foreground = hex(t.ink);
    c.tab_foreground = hex(t.ink3);
    c.tab_bar = hex(TRANSPARENT);
    c.tab_bar_segmented = hex(t.field);
    // Chrome.
    c.sidebar = hex(t.page);
    c.sidebar_foreground = hex(t.ink);
    c.sidebar_border = hex(t.line);
    c.sidebar_accent = hex(t.hover2);
    c.sidebar_accent_foreground = hex(t.ink);
    c.sidebar_primary = hex(t.ink);
    c.sidebar_primary_foreground = hex(t.on_ink);
    c.title_bar = hex(t.page);
    c.title_bar_border = hex(t.line);
    c.status_bar = hex(t.page);
    c.status_bar_border = hex(t.line);
    c.accordion = hex(TRANSPARENT);
    c.group_box = hex(t.surface);
    c.group_box_foreground = hex(t.ink);
    c.group_box_title_foreground = hex(t.ink3);
    c.description_list_label = hex(t.inset);
    c.description_list_label_foreground = hex(t.ink2);
    // Scrollbars are overlays: no track, an `ink-3` thumb at 40%, 65% under the pointer (`styles.css`).
    c.scrollbar = hex(TRANSPARENT);
    c.scrollbar_thumb = hex(fade(t.ink3, 0.4));
    c.scrollbar_thumb_hover = hex(fade(t.ink3, 0.65));
    // Controls. No switches in Milagre (DESIGN.md "States"); the values only keep a stray one legible.
    c.skeleton = hex(t.hover2);
    c.progress_bar = hex(t.ink);
    c.slider_bar = hex(t.field);
    c.slider_thumb = hex(t.ink);
    c.switch = hex(t.field);
    c.switch_thumb = hex(t.surface);
    // Charts: status and identity colours.
    c.chart_1 = hex(t.accent);
    c.chart_2 = hex(t.green);
    c.chart_3 = hex(t.orange);
    c.chart_4 = hex(t.purple);
    c.chart_5 = hex(t.red);
    c.chart_bullish = hex(t.green);
    c.chart_bearish = hex(t.red);
    c.chart_grid = hex(t.line);
    c
}

/// The six base colours gpui-component derives fallbacks from (private in its theme config).
pub struct BaseColors {
    pub red: Hsla,
    pub red_light: Hsla,
    pub green: Hsla,
    pub green_light: Hsla,
    pub blue: Hsla,
    pub blue_light: Hsla,
    pub yellow: Hsla,
    pub yellow_light: Hsla,
    pub magenta: Hsla,
    pub magenta_light: Hsla,
    pub cyan: Hsla,
    pub cyan_light: Hsla,
}

pub fn base_colors(t: &Theme) -> BaseColors {
    BaseColors {
        red: t.red.into(),
        red_light: t.red_tint.into(),
        green: t.green.into(),
        green_light: t.green_tint.into(),
        blue: t.accent.into(),
        blue_light: t.accent_tint.into(),
        yellow: t.orange.into(),
        yellow_light: t.orange_tint.into(),
        magenta: t.purple.into(),
        magenta_light: t.purple_tint.into(),
        cyan: t.accent_ink.into(),
        cyan_light: t.accent_tint.into(),
    }
}

#[cfg(test)]
mod tests {
    use gpui::{Hsla, TestAppContext, px};
    use gpui_component::ActiveTheme as _;

    use super::*;

    fn component(cx: &mut TestAppContext) -> gpui_component::Theme {
        cx.update(|cx| cx.theme().clone())
    }

    fn mount(cx: &mut TestAppContext, theme: Theme) {
        cx.update(|cx| {
            cx.set_global(theme);
            gpui_component::init(cx);
            init(cx);
        });
    }

    fn assert_tokens(component: &gpui_component::Theme, theme: &Theme) {
        let h = |c: Rgba| Hsla::from(c);
        assert_eq!(component.background, h(theme.page), "background is page");
        assert_eq!(component.foreground, h(theme.ink), "foreground is ink");
        assert_eq!(component.border, h(theme.line), "border is line");
        assert_eq!(component.input, h(theme.line_strong), "input border is line-strong");
        assert_eq!(component.popover, h(theme.surface), "popover is surface");
        assert_eq!(component.accent, h(theme.hover2), "menu highlight is hover-2");
        assert_eq!(component.list_hover, h(theme.hover), "row hover is hover");
        assert_eq!(component.primary, h(theme.ink), "primary fill is ink");
        assert_eq!(component.primary_foreground, h(theme.on_ink), "primary label is on-ink");
        assert_eq!(component.danger, h(theme.red), "danger status is red");
        assert_eq!(component.button_danger, h(theme.red_ink), "the danger button is red-ink");
        assert_eq!(component.ring, h(theme.accent), "focus ring is accent");
        assert_eq!(component.selection, h(theme.accent_tint), "selection is accent-tint");
        assert_eq!(component.link, h(theme.accent_ink), "links are accent-ink");
        assert_eq!(component.muted_foreground, h(theme.ink3), "muted text is ink-3");
        assert_eq!(component.overlay, h(theme.scrim), "overlay is the scrim");
        assert_eq!(component.red, h(theme.red), "base red");
        assert_eq!(component.font_family.as_ref(), SANS);
        assert_eq!(component.font_size, px(COMPONENT_REM));
        assert_eq!(component.mono_font_size, px(CODE_TEXT.size));
        assert_eq!(component.radius, RADIUS_CONTROL);
        assert_eq!(component.radius_lg, RADIUS_WINDOW);
        assert_eq!(component.is_dark(), theme.appearance == Appearance::Dark);
    }

    #[gpui::test]
    fn dark_tokens_reach_gpui_component(cx: &mut TestAppContext) {
        mount(cx, Theme::dark());
        assert_tokens(&component(cx), &Theme::dark());
    }

    #[gpui::test]
    fn light_tokens_reach_gpui_component(cx: &mut TestAppContext) {
        mount(cx, Theme::light());
        assert_tokens(&component(cx), &Theme::light());
    }

    #[gpui::test]
    fn changing_the_theme_global_reapplies_the_bridge(cx: &mut TestAppContext) {
        mount(cx, Theme::dark());
        cx.update(|cx| cx.set_global(Theme::light()));
        assert_tokens(&component(cx), &Theme::light());
        cx.update(|cx| cx.set_global(Theme::dark()));
        assert_tokens(&component(cx), &Theme::dark());
    }

    /// `Theme::change(mode)` reloads the registered config for that mode: it must be Milagre's.
    #[gpui::test]
    fn gpui_component_mode_change_keeps_milagre_colours(cx: &mut TestAppContext) {
        mount(cx, Theme::dark());
        cx.update(|cx| gpui_component::Theme::change(ThemeMode::Light, None, cx));
        let light = component(cx);
        assert_eq!(light.background, Hsla::from(Theme::light().page));
        assert_eq!(light.accent, Hsla::from(Theme::light().hover2));
        assert_eq!(light.radius, RADIUS_CONTROL);
    }
}

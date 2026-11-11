//! Appearance section (WP-40: `AppearanceSettings` in `Settings.tsx`, `ThemePicker.tsx`, `CustomThemeEditor.tsx`,
//! `AppearanceWindowPreview.tsx`; G-04 and G-05).
//!
//! - `color.rs`, `palette.rs`, `themes.rs`, `custom.rs`: the theme engine of `packages/shared/src/themes` in Rust
//!   (OKLab maths, `buildPalette`, the 12 themes, custom seeds). `AppearanceState::theme` turns the choice into the
//!   GPUI `Theme` global, which the gpui-component bridge and every view follow, so a change re-themes the window
//!   live (see [`init`]).
//! - `model.rs`: the settings (`DEFAULT_APPEARANCE`) and the option lists.
//! - `picker.rs`: our own colour picker; `preview.rs`: the window miniature.
//! - This file: the page. Local store only (`SettingsStore`), no daemon calls, no persistence.
//!
//! Not live yet: the interface and monospace fonts, the chat and code sizes, the chat width, the sidebar size,
//! provider icons and Panel animations are stored and shown in the preview, but the real views still read
//! `SANS`, `CHAT_TEXT` and `CODE_TEXT` constants (a later package wires them through the theme module).

pub mod color;
pub mod custom;
pub mod model;
pub mod palette;
pub mod picker;
pub mod preview;
pub mod themes;

#[cfg(test)]
mod tests;

use std::collections::HashSet;
use std::time::Duration;

use gpui::{
    AnyElement, App, ClipboardItem, Context, Entity, Focusable, FontWeight, IntoElement, ParentElement, Render, SharedString, Styled,
    Subscription, Window, div, prelude::*, px,
};
use gpui_component::input::{InputEvent, InputState};

pub use model::{AppearanceOptions, AppearanceState, ThemePreference};
use model::{
    CHAT_SIZES, CHAT_WIDTHS, CODE_SIZES, DIFF_PAIRS, FontChoice, MONO_FONTS, MOTION_SPEEDS, PROVIDER_ICON_STYLES, SIDEBAR_SIZES,
    SIDEBAR_USAGE_MODES, UI_FONTS, available_fonts, clamp_chat_width, shown_font,
};
use palette::Scheme;
use preview::{PreviewArea, WindowPreview, diff_text_colors};

use super::group::{CheckboxRow, SettingRow, SettingsGroup, page_header};
use super::store::SettingsStore;
use crate::theme::{ActiveTheme, RADIUS_CARD, RADIUS_CONTROL, TEXT_12, TEXT_13, TextStepExt, mono};
use crate::ui::{
    Button, ButtonVariant, FieldSize, InlineError, Input, Popover, SectionLabel, Segmented, SegmentedOption, Select, SelectOption,
};

/// A change keeps its area highlighted this long after it is made.
const PREVIEW_HOLD_MS: u64 = 1500;
/// The miniature's scale on the 708px content column.
const PREVIEW_SCALE: f32 = 0.49;

const NO_CLIPBOARD: &str = "Could not read the clipboard.";
const BAD_PASTE: &str = "That isn't a Milagre theme. It needs light and dark, each with background, text and accent hex colors.";

/// Seeds the theme engine: marks the default state as applied (the window already wears it) and re-themes the
/// window whenever the Appearance state of the store changes.
pub fn init(cx: &mut App) {
    let state = cx.global::<SettingsStore>().appearance.clone();
    model::mark_applied(&state, cx);
    cx.observe_global::<SettingsStore>(|cx| {
        let state = cx.global::<SettingsStore>().appearance.clone();
        model::apply(&state, cx);
    })
    .detach();
}

fn update(cx: &mut App, f: impl FnOnce(&mut AppearanceState)) {
    cx.update_global::<SettingsStore, _>(|s, _| f(&mut s.appearance));
}

fn mode_label(pref: ThemePreference) -> &'static str {
    match pref {
        ThemePreference::System => "System",
        ThemePreference::Light => "Light",
        ThemePreference::Dark => "Dark",
    }
}

const SEED_FIELDS: [(&str, &str); 3] = [("background", "Background"), ("text", "Text"), ("accent", "Accent")];

/// The page entity: the editing scheme, the "Start from" choice, the paste error, the preview highlight and the
/// text fields (created on first render, when a window is at hand).
pub struct AppearanceView {
    editing: Scheme,
    base: String,
    paste_error: Option<String>,
    hovered: Option<PreviewArea>,
    held: Option<PreviewArea>,
    hold_gen: u64,
    found: Option<String>,
    hex_inputs: Vec<Entity<InputState>>,
    hex_subs: Vec<Subscription>,
    synced: [String; 3],
    width_input: Option<Entity<InputState>>,
    _width_subs: Vec<Subscription>,
    installed: Option<HashSet<String>>,
}

impl AppearanceView {
    pub fn new(cx: &mut Context<Self>) -> Self {
        let system = model::system_scheme(cx);
        // Snapshot aids (README): `MILAGRE_GPUI_APPEARANCE=custom` opens with the custom theme on,
        // `highlight:<area>` with the preview outlining that area.
        let demo = std::env::var("MILAGRE_GPUI_APPEARANCE").unwrap_or_default();
        if demo.split(',').any(|d| d == "custom") {
            cx.update_global::<SettingsStore, _>(|s, _| s.appearance.set_custom_enabled(true));
        }
        let held = demo.split(',').find_map(|d| d.strip_prefix("highlight:")).and_then(|name| match name {
            "sidebar" => Some(PreviewArea::Sidebar),
            "chat" => Some(PreviewArea::Chat),
            "code" => Some(PreviewArea::Code),
            "width" => Some(PreviewArea::Width),
            "diff" => Some(PreviewArea::Diff),
            "ui" => Some(PreviewArea::Ui),
            "usage" => Some(PreviewArea::Usage),
            _ => None,
        });
        let state = &cx.global::<SettingsStore>().appearance;
        Self {
            editing: state.theme.resolve(system),
            base: themes::DEFAULT_THEME_ID.to_string(),
            paste_error: None,
            hovered: None,
            held,
            hold_gen: 0,
            found: None,
            hex_inputs: Vec::new(),
            hex_subs: Vec::new(),
            synced: Default::default(),
            width_input: None,
            _width_subs: Vec::new(),
            installed: None,
        }
    }

    /// The row title a Settings search result points at.
    pub fn set_found(&mut self, found: Option<&str>, cx: &mut Context<Self>) {
        if self.found.as_deref() != found {
            self.found = found.map(str::to_string);
            cx.notify();
        }
    }

    pub fn highlight(&self) -> Option<PreviewArea> {
        self.hovered.or(self.held)
    }

    pub fn width_input_for_test(&self) -> Option<Entity<InputState>> {
        self.width_input.clone()
    }

    /// Which scheme the custom theme editor edits.
    pub fn set_editing(&mut self, scheme: Scheme, cx: &mut Context<Self>) {
        if self.editing != scheme {
            self.editing = scheme;
            cx.notify();
        }
    }

    pub fn editing(&self) -> Scheme {
        self.editing
    }

    pub fn paste_error(&self) -> Option<&str> {
        self.paste_error.as_deref()
    }

    fn hover(&mut self, area: PreviewArea, on: bool, cx: &mut Context<Self>) {
        let next = on.then_some(area);
        if self.hovered != next {
            self.hovered = next;
            cx.notify();
        }
    }

    /// Keeps `area` highlighted for a moment after a change (`preview.hold`).
    pub fn hold(&mut self, area: Option<PreviewArea>, cx: &mut Context<Self>) {
        self.held = area;
        self.hold_gen += 1;
        let generation = self.hold_gen;
        cx.notify();
        if area.is_some() {
            cx.spawn(async move |this, cx| {
                cx.background_executor().timer(Duration::from_millis(PREVIEW_HOLD_MS)).await;
                this.update(cx, |this, cx| {
                    if this.hold_gen == generation {
                        this.held = None;
                        cx.notify();
                    }
                })
                .ok();
            })
            .detach();
        }
    }

    fn state(cx: &App) -> AppearanceState {
        cx.global::<SettingsStore>().appearance.clone()
    }

    fn is_installed(&mut self, cx: &App) -> HashSet<String> {
        self.installed.get_or_insert_with(|| cx.text_system().all_font_names().into_iter().collect()).clone()
    }

    /// Writes one seed of the editing scheme (`edit` in `CustomThemeEditor.tsx`).
    pub fn edit_seed(&mut self, key: &str, hex: &str, cx: &mut App) {
        self.paste_error = None;
        let scheme = self.editing;
        let hex = hex.to_lowercase();
        update(cx, |a| {
            let mut theme = a.custom_theme.clone().unwrap_or_else(|| custom::seeds_from(themes::DEFAULT_THEME_ID));
            let seeds = theme.seeds_mut(scheme);
            match key {
                "background" => seeds.background = hex,
                "text" => seeds.text = hex,
                _ => seeds.accent = hex,
            }
            a.save_custom(theme);
        });
    }

    fn ensure_inputs(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.hex_inputs.is_empty() {
            for (ix, (key, name)) in SEED_FIELDS.iter().enumerate() {
                let input = Input::state(format!("{name} hex"), window, cx);
                let key = *key;
                let sub = cx.subscribe(&input, move |this, input, event: &InputEvent, cx| match event {
                    InputEvent::Change => {
                        let text = input.read(cx).value().trim().to_lowercase();
                        if color::is_seed(&text) && this.synced[ix] != text {
                            this.synced[ix] = text.clone();
                            this.edit_seed(key, &text, cx);
                            cx.notify();
                        }
                    }
                    InputEvent::Blur => {
                        // The field keeps what is typed until it loses focus, then shows the saved colour again.
                        this.synced[ix].clear();
                        cx.notify();
                    }
                    _ => {}
                });
                self.hex_inputs.push(input);
                self.hex_subs.push(sub);
            }
        }
        if self.width_input.is_none() {
            let input = Input::state("px", window, cx);
            let sub = cx.subscribe(&input, |this, input, event: &InputEvent, cx| match event {
                InputEvent::Change => {
                    let text = input.read(cx).value().to_string();
                    let digits: String = text.chars().filter(char::is_ascii_digit).collect();
                    if digits.len() >= 3
                        && let Ok(px) = digits.parse::<u32>()
                    {
                        let px = clamp_chat_width(px);
                        if px != Self::state(cx).options.chat_width_px {
                            update(cx, |a| a.options.chat_width_px = px);
                            this.hold(Some(PreviewArea::Width), cx);
                        }
                    }
                }
                InputEvent::Blur | InputEvent::PressEnter { .. } => cx.notify(),
                _ => {}
            });
            self.width_input = Some(input);
            self._width_subs.push(sub);
        }
    }

    /// Mirrors the saved seeds into the hex fields unless the field already shows that colour.
    fn sync_inputs(&mut self, seeds: &custom::ThemeSeeds, window: &mut Window, cx: &mut Context<Self>) {
        let values = [&seeds.background, &seeds.text, &seeds.accent];
        for (ix, value) in values.into_iter().enumerate() {
            if self.synced[ix] == *value {
                continue;
            }
            self.synced[ix] = value.clone();
            let input = self.hex_inputs[ix].clone();
            if input.read(cx).value().trim().to_lowercase() != *value {
                let value: SharedString = value.clone().into();
                input.update(cx, |state, cx| state.set_value(value, window, cx));
            }
        }
    }

    fn sync_width(&mut self, px: u32, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(input) = self.width_input.clone() {
            let focused = input.read(cx).focus_handle(cx).is_focused(window);
            let text = input.read(cx).value().to_string();
            if !focused && text != px.to_string() {
                input.update(cx, |state, cx| state.set_value(px.to_string(), window, cx));
            }
        }
    }

    // ------------------------------------------------------------------ pieces

    /// A row whose hover (or focus) outlines `area` in the preview.
    fn area_row(&self, area: PreviewArea, row: impl IntoElement, cx: &mut Context<Self>) -> AnyElement {
        let entity = cx.entity();
        div()
            .id(SharedString::from(format!("area-row-{area:?}")))
            .on_hover(move |hovered, _, cx| entity.update(cx, |v, cx| v.hover(area, *hovered, cx)))
            .child(row)
            .into_any_element()
    }

    fn mode_group(&self, state: &AppearanceState, found: Option<&str>) -> impl IntoElement {
        let control = Segmented::new(
            "appearance-mode",
            Some(state.theme.as_str()),
            [ThemePreference::System, ThemePreference::Light, ThemePreference::Dark]
                .map(|p| SegmentedOption::new(p.as_str(), mode_label(p))),
        )
        .large()
        .on_change(|value, _, cx| {
            let pref = ThemePreference::parse(value);
            update(cx, |a| a.theme = pref);
        });
        SettingsGroup::new().title("Mode").highlighted_row(found.map(SharedString::from)).row(
            SettingRow::new("Mode")
                .description("System follows macOS. Every theme has a light and a dark version. \u{21e7}\u{2318}T switches.")
                .highlighted(found)
                .control(control),
        )
    }

    fn tile(&self, id: &'static str, name: &str, detail: String, selected: bool, swatch: (String, String), cx: &App) -> AnyElement {
        let theme = *cx.theme();
        let (page, accent) = (palette::parse_rgba(&swatch.0), palette::parse_rgba(&swatch.1));
        let id_owned = id.to_string();
        div()
            .id(SharedString::from(format!("theme-tile-{id}")))
            .debug_selector({
                let sel = format!("theme-tile-{id}");
                move || sel.clone()
            })
            .flex()
            .items_center()
            .gap(px(12.0))
            .p(px(12.0))
            .min_w_0()
            .rounded(RADIUS_CARD)
            .border_1()
            .border_color(if selected { theme.ink } else { theme.line })
            .bg(theme.surface)
            .cursor_pointer()
            .hover(move |s| s.bg(theme.hover))
            // The chosen tile is ringed in ink, inside its box: accent is for focus and links.
            .when(selected, |d| {
                d.shadow(vec![gpui::BoxShadow {
                    color: theme.ink.into(),
                    offset: gpui::point(px(0.0), px(0.0)),
                    blur_radius: px(0.0),
                    spread_radius: px(1.0),
                    inset: true,
                }])
            })
            .on_click(move |_, _, cx| {
                let id = id_owned.clone();
                update(cx, |a| a.choose_theme(&id));
            })
            .child(
                div()
                    .relative()
                    .size(px(32.0))
                    .flex_none()
                    .rounded_full()
                    .overflow_hidden()
                    .bg(page)
                    .border_1()
                    .border_color(theme.line)
                    .child(div().absolute().right_0().bottom_0().size(px(16.0)).bg(accent)),
            )
            .child(
                div()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .child(div().text_step(TEXT_13).font_weight(FontWeight::MEDIUM).text_color(theme.ink).child(name.to_string()))
                    .child(div().text_step(TEXT_12).text_color(theme.ink3).child(detail)),
            )
            .into_any_element()
    }

    fn theme_picker(&self, state: &AppearanceState, cx: &App) -> impl IntoElement {
        let custom = state.custom_theme_enabled && state.custom_theme.is_some();
        let mut col = div().debug_selector(|| "theme-picker".into()).flex().flex_col().gap(px(20.0));
        for group in themes::ThemeGroup::ALL {
            let mut grid = div().grid().grid_cols(3).gap(px(8.0));
            for theme in themes::themes().iter().filter(|t| t.group == group) {
                let detail = match theme.id {
                    "milagre-blue" => "Default".to_string(),
                    "gray" => "Classic".to_string(),
                    _ => format!("Light: {}", theme.light_name),
                };
                let swatch = model::theme_swatch(theme.id, state.custom_theme.as_ref());
                let name = theme.name;
                grid = grid.child(self.tile(theme.id, name, detail, state.color_theme == theme.id, swatch, cx));
            }
            if group == themes::ThemeGroup::Milagre && custom {
                let swatch = model::theme_swatch("custom", state.custom_theme.as_ref());
                grid = grid.child(self.tile("custom", "Custom", "Your colors".into(), state.color_theme == "custom", swatch, cx));
            }
            col = col.child(div().child(div().px(px(4.0)).mb(px(8.0)).child(SectionLabel::new(group.label()))).child(grid));
        }
        col
    }

    fn seed_row(&self, ix: usize, seeds: &custom::ThemeSeeds, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let (key, name) = SEED_FIELDS[ix];
        let value = match ix {
            0 => seeds.background.clone(),
            1 => seeds.text.clone(),
            _ => seeds.accent.clone(),
        };
        let entity = cx.entity();
        let swatch_value = value.clone();
        let picker = Popover::new(SharedString::from(format!("seed-picker-{key}")))
            .align_start()
            .trigger({
                let swatch = palette::parse_rgba(&value);
                move |open| {
                    div()
                        .id(SharedString::from(format!("seed-swatch-{key}")))
                        .debug_selector({
                            let sel = format!("seed-swatch-{key}");
                            move || sel.clone()
                        })
                        .size(px(28.0))
                        .rounded(RADIUS_CONTROL)
                        .border_1()
                        .border_color(if open { theme.accent } else { theme.line_strong })
                        .bg(swatch)
                        .cursor_pointer()
                        .into_any_element()
                }
            })
            .content(move |_, _, _| {
                let entity = entity.clone();
                picker::ColorPicker::new(SharedString::from(format!("seed-color-{key}")), swatch_value.clone())
                    .on_change(move |hex, _, cx| entity.update(cx, |v, cx| v.edit_seed(key, &hex, cx)))
                    .into_any_element()
            });
        div()
            .flex()
            .items_center()
            .justify_between()
            .gap(px(16.0))
            .px(px(16.0))
            .py(px(12.0))
            .child(div().text_step(TEXT_13).font_weight(FontWeight::MEDIUM).text_color(theme.ink).child(name))
            .child(
                div().flex().items_center().gap(px(8.0)).child(picker).child(
                    div()
                        .w(px(88.0))
                        .font_family(mono())
                        .child(Input::new(format!("seed-hex-{key}"), &self.hex_inputs[ix]).size(FieldSize::S28)),
                ),
            )
            .into_any_element()
    }

    fn mini_preview(&self, seeds: &custom::ThemeSeeds, scheme: Scheme, state: &AppearanceState) -> impl IntoElement {
        // The editor's own miniature (`Preview` in `CustomThemeEditor.tsx`): the palette of the seeds being edited.
        let custom = custom::CustomTheme { light: seeds.clone(), dark: seeds.clone() };
        let p = model::palette_for("custom", scheme, Some(&custom));
        let _ = state;
        let c = |hex: &str| palette::parse_rgba(hex);
        let bar = |w: f32, color: &str| div().h(px(6.0)).w(px(w)).rounded_full().bg(c(color));
        div()
            .debug_selector(|| "custom-theme-preview".into())
            .w(px(256.0))
            .h(px(176.0))
            .flex_none()
            .flex()
            .overflow_hidden()
            .rounded(RADIUS_CARD)
            .bg(c(&p.page))
            .border_1()
            .border_color(c(&p.line))
            .child(
                div()
                    .w(px(80.0))
                    .flex_none()
                    .flex()
                    .flex_col()
                    .gap(px(6.0))
                    .p(px(8.0))
                    .bg(c(&p.canvas))
                    .border_r_1()
                    .border_color(c(&p.line))
                    .child(bar(40.0, &p.ink3))
                    .child(div().h(px(20.0)).rounded(px(6.0)).bg(c(&p.hover)))
                    .child(bar(48.0, &p.ink3))
                    .child(bar(36.0, &p.ink3)),
            )
            .child(
                div()
                    .min_w_0()
                    .flex_1()
                    .flex()
                    .flex_col()
                    .justify_between()
                    .p(px(12.0))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(8.0))
                            .child(
                                div()
                                    .rounded(RADIUS_CONTROL)
                                    .px(px(8.0))
                                    .py(px(6.0))
                                    .text_step(TEXT_12)
                                    .bg(c(&p.surface))
                                    .text_color(c(&p.ink))
                                    .child("Done. The tests pass."),
                            )
                            .child(
                                div()
                                    .rounded(px(6.0))
                                    .px(px(8.0))
                                    .py(px(4.0))
                                    .font_family(mono())
                                    .text_size(px(11.0))
                                    .bg(c(&p.inset))
                                    .text_color(c(&p.ink2))
                                    .flex()
                                    .gap(px(5.0))
                                    .child(div().text_color(c(&p.accent)).child("const"))
                                    .child("theme = custom"),
                            ),
                    )
                    .child(
                        div().flex().justify_end().child(
                            div()
                                .rounded(RADIUS_CONTROL)
                                .px(px(12.0))
                                .py(px(4.0))
                                .text_step(TEXT_12)
                                .font_weight(FontWeight::MEDIUM)
                                .bg(c(&p.accent))
                                .text_color(c(&p.on_accent))
                                .child("Send"),
                        ),
                    ),
            )
    }

    fn custom_editor(&mut self, state: &AppearanceState, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        self.ensure_inputs(window, cx);
        let custom_theme = state.custom_theme.clone().unwrap_or_else(|| custom::seeds_from(themes::DEFAULT_THEME_ID));
        let editing = self.editing;
        let seeds = custom_theme.seeds(editing).clone();
        self.sync_inputs(&seeds, window, cx);
        let contrast = custom::custom_contrast(&seeds);
        let entity = cx.entity();

        let scheme_toggle = Segmented::new(
            "custom-editing",
            Some(editing.as_str()),
            [SegmentedOption::new("light", "Light"), SegmentedOption::new("dark", "Dark")],
        )
        .large()
        .on_change({
            let entity = entity.clone();
            move |value, _, cx| {
                let scheme = if value.as_ref() == "dark" { Scheme::Dark } else { Scheme::Light };
                entity.update(cx, |v, cx| {
                    v.editing = scheme;
                    cx.notify();
                });
            }
        });

        let base_options = themes::themes().iter().map(|t| SelectOption::new(t.id, t.name).group(t.group.label()));
        let base_select = Select::new("custom-start-from", self.base.clone(), base_options).width(220.0).on_change({
            let entity = entity.clone();
            move |id, _, cx| {
                let id = id.to_string();
                entity.update(cx, |v, cx| {
                    v.base = id.clone();
                    v.paste_error = None;
                    cx.notify();
                });
                update(cx, |a| a.save_custom(custom::seeds_from(&id)));
            }
        });

        let copy = Button::new("custom-copy-json", "Copy as JSON").variant(ButtonVariant::Secondary).on_click({
            let theme = custom_theme.clone();
            move |_, _, cx| cx.write_to_clipboard(ClipboardItem::new_string(custom::serialize_custom_theme(&theme)))
        });
        let paste = Button::new("custom-paste-json", "Paste JSON").variant(ButtonVariant::Secondary).on_click({
            let entity = entity.clone();
            move |_, _, cx| {
                let text = cx.read_from_clipboard().and_then(|item| item.text());
                let parsed = text.as_deref().map(custom::parse_custom_theme);
                let error = match &parsed {
                    None => Some(NO_CLIPBOARD.to_string()),
                    Some(None) => Some(BAD_PASTE.to_string()),
                    Some(Some(_)) => None,
                };
                if let Some(Some(theme)) = parsed {
                    update(cx, |a| a.save_custom(theme));
                }
                entity.update(cx, |v, cx| {
                    v.paste_error = error;
                    cx.notify();
                });
            }
        });
        let reset = Button::new("custom-reset", "Reset").variant(ButtonVariant::Secondary).on_click({
            let entity = entity.clone();
            move |_, _, cx| {
                entity.update(cx, |v, cx| {
                    v.paste_error = None;
                    v.base = themes::DEFAULT_THEME_ID.to_string();
                    cx.notify();
                });
                update(cx, |a| a.save_custom(custom::seeds_from(themes::DEFAULT_THEME_ID)));
            }
        });

        let rows = div()
            .min_w_0()
            .flex_1()
            .rounded(RADIUS_CARD)
            .bg(theme.field)
            .child(self.seed_row(0, &seeds, cx))
            .child(div().h(px(1.0)).bg(theme.line))
            .child(self.seed_row(1, &seeds, cx))
            .child(div().h(px(1.0)).bg(theme.line))
            .child(self.seed_row(2, &seeds, cx));

        div()
            .debug_selector(|| "custom-theme-editor".into())
            .flex()
            .flex_col()
            .gap(px(12.0))
            .p(px(16.0))
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(div().text_step(TEXT_13).font_weight(FontWeight::MEDIUM).text_color(theme.ink).child("Editing"))
                    .child(scheme_toggle),
            )
            .child(div().flex().items_start().gap(px(16.0)).child(rows).child(self.mini_preview(&seeds, editing, state)))
            .child(
                div()
                    .debug_selector(|| "custom-contrast".into())
                    .text_step(TEXT_12)
                    .text_color(if contrast.weak() { theme.orange_ink } else { theme.ink3 })
                    .child(format!("Text on background: {:.1}:1. Accent on background: {:.1}:1.", contrast.text, contrast.accent)),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(div().text_step(TEXT_13).text_color(theme.ink3).child("Start from"))
                    .child(base_select)
                    .child(div().flex_1())
                    .child(copy)
                    .child(paste)
                    .child(reset),
            )
            .when_some(self.paste_error.clone(), |d, error| d.child(InlineError::new(error).small()))
            .into_any_element()
    }

    fn custom_group(&mut self, state: &AppearanceState, found: Option<&str>, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let toggle = CheckboxRow::new("custom-theme-enabled", "Custom theme", state.custom_theme_enabled)
            .description("Build a theme from a few colors. It shows up as \"Custom\" with the Milagre themes.")
            .highlighted(found)
            .on_change(|enabled, _, cx| update(cx, |a| a.set_custom_enabled(enabled)));
        let group = SettingsGroup::new().title("Custom theme").highlighted_row(found.map(SharedString::from)).row(toggle);
        if state.custom_theme_enabled {
            group.row(self.custom_editor(state, window, cx)).into_any_element()
        } else {
            group.into_any_element()
        }
    }

    fn font_select(
        &mut self,
        id: &'static str,
        list: &'static [FontChoice],
        value: &str,
        area: PreviewArea,
        cx: &mut Context<Self>,
    ) -> Select {
        let installed = self.is_installed(cx);
        let probe = move |label: &str| installed.contains(label);
        let options = available_fonts(list, &probe).into_iter().map(|f| {
            if f.id == "system" { SelectOption::new(f.id, f.label).trailing("default") } else { SelectOption::new(f.id, f.label) }
        });
        let entity = cx.entity();
        Select::new(id, shown_font(list, value, &probe), options).width(260.0).searchable().on_change(move |font, _, cx| {
            let font = font.to_string();
            let is_ui = area == PreviewArea::Ui;
            update(cx, |a| if is_ui { a.options.ui_font = font } else { a.options.mono_font = font });
            entity.update(cx, |v, cx| v.hold(Some(area), cx));
        })
    }

    /// A select over `(id, label, ..)` rows that writes one option and holds `area` in the preview.
    fn option_select(
        id: &'static str,
        value: &str,
        options: Vec<SelectOption>,
        width: f32,
        area: Option<PreviewArea>,
        set: fn(&mut AppearanceOptions, String),
        cx: &mut Context<Self>,
    ) -> Select {
        let entity = cx.entity();
        Select::new(id, value.to_string(), options).width(width).on_change(move |value, _, cx| {
            let value = value.to_string();
            update(cx, |a| set(&mut a.options, value));
            entity.update(cx, |v, cx| v.hold(area, cx));
        })
    }

    fn px_options<T: Copy + Into<u32>>(list: &[(&'static str, &'static str, T)]) -> Vec<SelectOption> {
        list.iter()
            .map(|(id, _, px)| {
                let option = SelectOption::new(*id, format!("{} px", (*px).into()));
                if *id == "default" { option.trailing("default") } else { option }
            })
            .collect()
    }
}

impl Render for AppearanceView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.theme();
        let state = Self::state(cx);
        let found = self.found.clone();
        let found = found.as_deref();
        let highlight = self.highlight();
        let o = state.options.clone();
        self.ensure_inputs(window, cx);
        self.sync_width(o.chat_width_px, window, cx);

        // Typography
        let sidebar_opts: Vec<SelectOption> = SIDEBAR_SIZES
            .iter()
            .map(|(id, _, delta)| {
                let option = SelectOption::new(*id, format!("{} px", 13 + delta));
                if *id == "default" { option.trailing("default") } else { option }
            })
            .collect();
        let ui_font = self.font_select("appearance-ui-font", UI_FONTS, &o.ui_font, PreviewArea::Ui, cx);
        let mono_font = self.font_select("appearance-mono-font", MONO_FONTS, &o.mono_font, PreviewArea::Code, cx);
        let sidebar_size = Self::option_select(
            "appearance-sidebar-size",
            &o.sidebar_size,
            sidebar_opts,
            160.0,
            Some(PreviewArea::Sidebar),
            |o, v| o.sidebar_size = v,
            cx,
        );
        let chat_size = Self::option_select(
            "appearance-chat-size",
            &o.chat_size,
            Self::px_options(&CHAT_SIZES.iter().map(|s| (s.0, s.1, s.2)).collect::<Vec<_>>()),
            160.0,
            Some(PreviewArea::Chat),
            |o, v| o.chat_size = v,
            cx,
        );
        let code_size = Self::option_select(
            "appearance-code-size",
            &o.code_size,
            Self::px_options(&CODE_SIZES.iter().map(|s| (s.0, s.1, s.2)).collect::<Vec<_>>()),
            160.0,
            Some(PreviewArea::Code),
            |o, v| o.code_size = v,
            cx,
        );
        let typography = SettingsGroup::new()
            .title("Typography")
            .highlighted_row(found.map(SharedString::from))
            .row(self.area_row(
                PreviewArea::Ui,
                SettingRow::new("Interface font").description("Used across the app.").highlighted(found).control(ui_font),
                cx,
            ))
            .row(self.area_row(
                PreviewArea::Code,
                SettingRow::new("Monospace font").description("Code, diffs and the terminal.").highlighted(found).control(mono_font),
                cx,
            ))
            .row(
                self.area_row(
                    PreviewArea::Sidebar,
                    SettingRow::new("Sidebar size")
                        .description("Project and chat names in the sidebar.")
                        .highlighted(found)
                        .control(sidebar_size),
                    cx,
                ),
            )
            .row(self.area_row(
                PreviewArea::Chat,
                SettingRow::new("Chat size").description("Messages and the composer.").highlighted(found).control(chat_size),
                cx,
            ))
            .row(self.area_row(
                PreviewArea::Code,
                SettingRow::new("Code size").description("Code blocks, diffs and the terminal.").highlighted(found).control(code_size),
                cx,
            ));

        // Layout
        let width_options: Vec<SelectOption> = CHAT_WIDTHS.iter().map(|(id, label, _)| SelectOption::new(*id, *label)).collect();
        let width_select = Self::option_select(
            "appearance-chat-width",
            &o.chat_width,
            width_options,
            200.0,
            Some(PreviewArea::Width),
            |o, v| o.chat_width = v,
            cx,
        );
        let width_control = div()
            .flex()
            .items_center()
            .gap(px(8.0))
            .when(o.chat_width == "custom", |d| {
                let input = self.width_input.clone().expect("created in ensure_inputs");
                d.child(div().w(px(84.0)).child(Input::new("appearance-chat-width-px", &input).size(FieldSize::S32)))
            })
            .child(width_select);
        let icons = Self::option_select(
            "appearance-provider-icons",
            &o.provider_icons,
            PROVIDER_ICON_STYLES.iter().map(|(id, label)| SelectOption::new(*id, *label)).collect(),
            200.0,
            Some(PreviewArea::Ui),
            |o, v| o.provider_icons = v,
            cx,
        );
        let usage = Self::option_select(
            "appearance-sidebar-usage",
            &o.sidebar_usage,
            SIDEBAR_USAGE_MODES.iter().map(|(id, label)| SelectOption::new(*id, *label)).collect(),
            200.0,
            Some(PreviewArea::Usage),
            |o, v| o.sidebar_usage = v,
            cx,
        );
        let layout = SettingsGroup::new()
            .title("Layout")
            .highlighted_row(found.map(SharedString::from))
            .row(
                self.area_row(
                    PreviewArea::Width,
                    SettingRow::new("Chat width")
                        .description("How wide messages and the composer grow on large screens.")
                        .highlighted(found)
                        .control(width_control),
                    cx,
                ),
            )
            .row(
                self.area_row(
                    PreviewArea::Ui,
                    SettingRow::new("Provider icons")
                        .description("Original colors, or black and white to match the mode.")
                        .highlighted(found)
                        .control(icons),
                    cx,
                ),
            )
            .row(
                self.area_row(
                    PreviewArea::Usage,
                    SettingRow::new("Sidebar usage")
                        .description("One row per provider, or provider icons in one line.")
                        .highlighted(found)
                        .control(usage),
                    cx,
                ),
            );

        // Diffs
        let scheme = state.theme.resolve(model::system_scheme(cx));
        let diff_options = DIFF_PAIRS.iter().map(|pair| SelectOption::new(pair.id, pair.label));
        let diff_dots = {
            let pair = model::diff_pair(&o.diff_colors);
            let (add, remove) = diff_text_colors(&o, &theme);
            let _ = (pair, scheme);
            div()
                .flex()
                .gap(px(4.0))
                .child(div().size(px(10.0)).rounded_full().bg(add))
                .child(div().size(px(10.0)).rounded_full().bg(remove))
        };
        let diff_select = {
            let entity = cx.entity();
            Select::new("appearance-diff-colors", o.diff_colors.clone(), diff_options).width(220.0).on_change(move |value, _, cx| {
                let value = value.to_string();
                update(cx, |a| a.options.diff_colors = value);
                entity.update(cx, |v, cx| v.hold(Some(PreviewArea::Diff), cx));
            })
        };
        let diffs = SettingsGroup::new().title("Diffs").highlighted_row(found.map(SharedString::from)).row(
            self.area_row(
                PreviewArea::Diff,
                SettingRow::new("Diff colors")
                    .description("Additions and deletions, including change counts.")
                    .highlighted(found)
                    .control(div().flex().items_center().gap(px(10.0)).child(diff_dots).child(diff_select)),
                cx,
            ),
        );

        // Motion
        let motion_select = {
            let entity = cx.entity();
            Select::new("appearance-motion", o.motion.clone(), MOTION_SPEEDS.iter().map(|(id, label, _)| SelectOption::new(*id, *label)))
                .width(160.0)
                .on_change(move |value, _, cx| {
                    let value = value.to_string();
                    update(cx, |a| a.options.motion = value);
                    // The replay is the feedback; a highlight still held from another row goes.
                    entity.update(cx, |v, cx| v.hold(None, cx));
                })
        };
        let motion = SettingsGroup::new().title("Motion").highlighted_row(found.map(SharedString::from)).row(
            SettingRow::new("Panel animations")
                .description("How fast panels open and close. macOS Reduce Motion turns them off.")
                .highlighted(found)
                .control(motion_select),
        );

        let preview = div()
            .debug_selector(|| "appearance-preview-card".into())
            .mt(px(8.0))
            .mb(px(24.0))
            .flex()
            .justify_center()
            .child(WindowPreview::new(o.clone(), highlight).scale(PREVIEW_SCALE));

        let custom_group = self.custom_group(&state, found, window, cx);
        let picker = self.theme_picker(&state, cx);
        let mode_group = self.mode_group(&state, found);
        let _ = theme;
        div()
            .debug_selector(|| "settings-section-appearance".into())
            .flex()
            .flex_col()
            .child(page_header("Appearance", None, cx))
            .child(mode_group)
            .child(picker)
            .child(div().mt(px(24.0)).child(custom_group))
            .child(preview)
            .child(typography)
            .child(layout)
            .child(diffs)
            .child(motion)
    }
}

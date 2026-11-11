//! The model chip and its picker (`ModelPicker.tsx`, DESIGN.md "Model picker"): a popover opened upward from the
//! chip with the provider rail on the left (the picked provider a `hover-2` tile with an ink mark, the others
//! resting in `ink-3`), the provider's models beside it (a tick on the picked one, the context window or Kiro's
//! multiplier at the row's end) and, when the picked model has any, its settings on the right: the thinking-effort
//! slider with its caption, then the Fast and Ultracode tiles (bordered, taking their tint when on).
//!
//! Under it all sits the permission footer (`permission.rs`): Ask, Auto or Full, Full in orange. The chip shows an
//! orange shield before the provider mark while Full is on, and the Fast bolt after the effort while Fast is on.
//!
//! The list is [`models::catalog`], a fixture. Not built: the search field, the per-Project account select, the CLI
//! update notice and a row's description tooltip.

use gpui::{AnyElement, App, Entity, FontWeight, IntoElement, ParentElement, Rgba, SharedString, Styled, Window, div, prelude::*, px};

use super::models::{self, ModelOption, capability, credits_label, effort_for};
use super::pick_list::{PickList, Row};
use super::{Composer, bar::BarState};
use crate::data::Provider;
use crate::logic::copy::model_copy::effort_copy;
use crate::logic::identity::providers::{PROVIDERS, provider_from_id, provider_name};
use crate::logic::usage::tokens::format_tokens;
use crate::theme::{ActiveTheme, RADIUS_CARD, RADIUS_CONTROL, TEXT_11, TEXT_12, TEXT_13, TextStepExt, Theme};
use crate::ui::{Chip, Icon, IconName, IconSize, ProviderLogo, RangeSlider, Tooltip, item_focus};

const WIDTH_WITH_SETTINGS: f32 = 580.0;
const WIDTH_PLAIN: f32 = 300.0;
const HEIGHT: f32 = 380.0;
const RAIL_WIDTH: f32 = 45.0;
const LIST_WIDTH: f32 = 240.0;

impl Composer {
    /// Picks a model: the chip follows, the effort stays when the model takes it, Fast and Ultracode drop when it
    /// does not offer them.
    pub fn pick_model(&mut self, model: &ModelOption, cx: &mut gpui::Context<Self>) {
        let capability = capability(model);
        let effort = effort_for(&capability, self.bar.effort_id);
        self.bar.provider = model.provider;
        self.bar.tab = model.provider;
        self.bar.can_steer = crate::logic::identity::capabilities::provider_capabilities(Some(model.provider.id())).steer;
        self.bar.model_id = model.id.into();
        self.bar.model_name = model.name.into();
        self.bar.effort_id = effort;
        self.bar.effort = effort.map(|effort| effort_copy(effort).name.into());
        self.bar.fast &= capability.fast_mode;
        self.bar.ultracode &= capability.ultracode;
        cx.notify();
    }

    pub fn set_effort(&mut self, effort: &'static str, cx: &mut gpui::Context<Self>) {
        self.bar.effort_id = Some(effort);
        self.bar.effort = Some(effort_copy(effort).name.into());
        cx.notify();
    }

    pub fn set_fast_mode(&mut self, on: bool, cx: &mut gpui::Context<Self>) {
        self.bar.fast = on;
        cx.notify();
    }

    pub fn set_ultracode(&mut self, on: bool, cx: &mut gpui::Context<Self>) {
        self.bar.ultracode = on;
        cx.notify();
    }

    pub(super) fn model_chip(&self, theme: &Theme, cx: &mut gpui::Context<Self>) -> AnyElement {
        let (provider, name, effort) = (self.bar.provider, self.bar.model_name.clone(), self.bar.effort.clone());
        let (dim, warn) = (theme.ink3, theme.orange_ink);
        let (full, fast) = (self.bar.permission == crate::data::PermissionMode::Full, self.bar.fast);
        let composer = cx.entity();
        let open = matches!(self.bar.open, Some("composer-model" | "composer-permission"));
        super::pick_list::popup(&composer, "composer-model", open)
            .trigger(move |open| {
                Chip::new("composer-model-chip")
                    .on(open)
                    .when(full, |chip| chip.child(Icon::new(IconName::ShieldAlert).size(IconSize::S14).color(warn)))
                    .child(ProviderLogo::new(provider).size(14.0))
                    .child(div().min_w_0().max_w(px(112.0)).truncate().child(name.clone()))
                    .when_some(effort.clone(), |chip, effort| {
                        chip.child(div().flex_none().text_color(dim).child("\u{b7}")).child(div().flex_none().child(effort))
                    })
                    .when(fast, |chip| chip.child(Icon::new(IconName::Flash).size(IconSize::S14).color(warn)))
                    .into_any_element()
            })
            .content(move |_, window, cx| picker(&composer, window, cx))
            .into_any_element()
    }
}

/// Redraws every view: the popover's content is a layer of its own that a composer `notify` does not reach.
fn apply(composer: &Entity<Composer>, window: &mut Window, cx: &mut App, change: impl FnOnce(&mut Composer, &mut gpui::Context<Composer>)) {
    composer.update(cx, change);
    window.refresh();
}

fn picker(composer: &Entity<Composer>, window: &mut Window, cx: &mut App) -> AnyElement {
    let theme = *cx.theme();
    // A snapshot (or an action) that opens the permission popover opens the picker with its menu out.
    if composer.read(cx).bar.open == Some("composer-permission") {
        composer.update(cx, |c, _| {
            c.bar.open = Some("composer-model");
            c.bar.permission_menu = true;
        });
    }
    let bar: BarState = composer.read(cx).bar.clone();
    let selected = models::find(bar.provider, &bar.model_id);
    let capability = selected.as_ref().map(capability);
    let has_settings = capability.as_ref().is_some_and(|c| !c.efforts.is_empty() || c.fast_mode || c.ultracode);
    let tab = bar.tab;
    let rail = div()
        .debug_selector(|| "model-rail".into())
        .flex()
        .flex_col()
        .flex_none()
        .items_center()
        .gap(px(4.0))
        .w(px(RAIL_WIDTH))
        .py(px(8.0))
        .border_r_1()
        .border_color(theme.line)
        .bg(theme.inset)
        .children(
            PROVIDERS.iter().filter_map(|id| provider_from_id(id)).map(|provider| rail_tile(composer, provider, provider == tab, &theme)),
        );

    let models_of = models::models_of(tab);
    let rows: Vec<Row> = models_of
        .iter()
        .map(|model| {
            let on = model.provider == bar.provider && model.id == bar.model_id.as_ref();
            let meta = model.credits.map(credits_label).or_else(|| models::context_window(model).map(format_tokens));
            let (composer, model) = (composer.clone(), *model);
            let mut row = Row::new(SharedString::from(format!("model-{}", model.id)), model.name, move |window, cx| {
                apply(&composer, window, cx, |c, cx| c.pick_model(&model, cx));
            })
            .checked(on);
            if let Some(meta) = meta {
                row = row.meta(meta);
            }
            row
        })
        .collect();
    let list = div()
        .flex()
        .flex_col()
        .min_w_0()
        .pt(px(8.0))
        .pl(px(8.0))
        .when(has_settings, |el| el.w(px(LIST_WIDTH)).flex_none().border_r_1().border_color(theme.line))
        .when(!has_settings, |el| el.flex_1())
        .child(
            div()
                .flex()
                .items_baseline()
                .justify_between()
                .px(px(8.0))
                .pr(px(12.0))
                .pb(px(6.0))
                .child(
                    div().text_step(TEXT_13).font_weight(FontWeight::SEMIBOLD).text_color(theme.ink).child(provider_name(Some(tab.id()))),
                )
                .child(div().text_step(TEXT_11).text_color(theme.ink3).child(format!(
                    "{} {}",
                    models_of.len(),
                    if models_of.len() == 1 { "model" } else { "models" }
                ))),
        )
        .child(
            div()
                .id("model-list")
                .flex_1()
                .min_h_0()
                .overflow_y_scroll()
                .pr(px(8.0))
                .pb(px(8.0))
                .child(PickList::new("model-pick-list", rows).empty("No models found")),
        );

    let mut body = div().flex().flex_1().min_h_0().child(rail).child(list);
    if let (true, Some(capability)) = (has_settings, capability) {
        body = body.child(settings(composer, &bar, &capability, &theme));
    }
    let mode = super::permission::to_mode(bar.permission);
    let trigger = super::permission::trigger_focus(window, cx);
    div()
        .debug_selector(|| "model-picker".into())
        .relative()
        .flex()
        .flex_col()
        .w(px(if has_settings { WIDTH_WITH_SETTINGS } else { WIDTH_PLAIN }))
        .h(px(HEIGHT))
        .overflow_hidden()
        .rounded(RADIUS_CARD)
        .bg(theme.surface)
        .shadow(theme.shadow_raised())
        .text_color(theme.ink)
        .child(body)
        .child(super::permission::footer(composer, mode, bar.permission_menu, window, cx, &theme))
        .when(bar.permission_menu, |el| {
            el.child(
                div()
                    .absolute()
                    .right(px(10.0))
                    .bottom(px(super::permission::FOOTER_HEIGHT + 2.0))
                    .child(super::permission::menu(composer, mode, trigger, &theme)),
            )
        })
        .into_any_element()
}

fn rail_tile(composer: &Entity<Composer>, provider: Provider, on: bool, theme: &Theme) -> AnyElement {
    let (hover, hover2) = (theme.hover, theme.hover2);
    let mark = if on { theme.ink } else { theme.ink3 };
    let composer = composer.clone();
    let id = format!("model-rail-{}", provider.id());
    div()
        .id(SharedString::from(id.clone()))
        .debug_selector(move || id.clone())
        .tooltip(Tooltip::text(provider_name(Some(provider.id()))))
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(px(32.0))
        .rounded(RADIUS_CONTROL)
        .cursor_pointer()
        .when(on, |el| el.bg(hover2))
        .when(!on, |el| el.hover(move |style| style.bg(hover)))
        .on_click(move |_, window, cx| {
            apply(&composer, window, cx, |c, cx| {
                c.bar.tab = provider;
                cx.notify();
            })
        })
        // Codex's solid mark reads as a blob beside the others' line marks: the rail draws OpenAI's line mark.
        .child(if provider == Provider::Codex {
            Icon::new(IconName::ChatGpt).size(IconSize::S18).color(mark).into_any_element()
        } else {
            ProviderLogo::new(provider).size(18.0).mono(mark).into_any_element()
        })
        .into_any_element()
}

fn settings(composer: &Entity<Composer>, bar: &BarState, capability: &models::Capability, theme: &Theme) -> AnyElement {
    let levels = &capability.efforts;
    let index = bar.effort_id.and_then(|effort| levels.iter().position(|level| *level == effort)).unwrap_or(0);
    let mut column = div()
        .debug_selector(|| "model-settings".into())
        .flex()
        .flex_col()
        .flex_1()
        .min_w_0()
        .gap(px(12.0))
        .px(px(12.0))
        .pt(px(10.0))
        .pb(px(12.0));
    if let Some(current) = levels.get(index) {
        let copy = effort_copy(current);
        let mut block = div()
            .flex()
            .flex_col()
            .child(div().pb(px(8.0)).text_step(TEXT_11).font_weight(FontWeight::MEDIUM).text_color(theme.ink3).child("Thinking effort"));
        if levels.len() > 1 {
            let levels_for_change = levels.clone();
            let composer = composer.clone();
            block = block
                .child(RangeSlider::new("model-effort", index, levels.len()).on_change(move |ix, window, cx| {
                    if let Some(level) = levels_for_change.get(ix) {
                        apply(&composer, window, cx, |c, cx| c.set_effort(level, cx));
                    }
                }))
                .child(
                    div()
                        .flex()
                        .justify_between()
                        .pt(px(6.0))
                        .text_step(TEXT_11)
                        .text_color(theme.ink3)
                        .child(effort_copy(levels[0]).name)
                        .child(effort_copy(levels[levels.len() - 1]).name),
                );
        }
        let name_color = if *current == "ultra" { theme.purple_ink } else { theme.ink };
        block = block.child(
            div().debug_selector(|| "model-effort-caption".into()).pt(px(6.0)).text_step(TEXT_11).text_color(theme.ink3).child(
                div().child(
                    gpui::StyledText::new(if copy.description.is_empty() {
                        copy.name.clone()
                    } else {
                        format!("{} \u{b7} {}", copy.name, copy.description)
                    })
                    .with_highlights(vec![(
                        0..copy.name.len(),
                        gpui::HighlightStyle {
                            color: Some(name_color.into()),
                            font_weight: Some(FontWeight::SEMIBOLD),
                            ..Default::default()
                        },
                    )]),
                ),
            ),
        );
        column = column.child(block);
    }
    if capability.fast_mode || capability.ultracode {
        let mut tiles = div().flex().flex_col().gap(px(6.0));
        if capability.fast_mode {
            let composer = composer.clone();
            tiles = tiles.child(tile(
                "model-fast",
                IconName::Flash,
                "Fast",
                "Quicker replies, higher usage",
                bar.fast,
                (theme.orange, theme.orange_ink, theme.orange_tint),
                move |on, window, cx| apply(&composer, window, cx, |c, cx| c.set_fast_mode(on, cx)),
            ));
        }
        if capability.ultracode {
            let composer = composer.clone();
            tiles = tiles.child(tile(
                "model-ultracode",
                IconName::UserMultiple,
                "Ultracode",
                "Parallel agents for big work",
                bar.ultracode,
                (theme.purple, theme.purple_ink, theme.purple_tint),
                move |on, window, cx| apply(&composer, window, cx, |c, cx| c.set_ultracode(on, cx)),
            ));
        }
        column = column.child(tiles);
    }
    column.into_any_element()
}

type Toggle = std::rc::Rc<dyn Fn(bool, &mut Window, &mut App)>;

/// A bordered tile with a checkbox role: `line` border at rest, the tint (no border) when on.
#[derive(IntoElement)]
struct Tile {
    id: &'static str,
    icon: IconName,
    title: &'static str,
    detail: &'static str,
    on: bool,
    colors: (Rgba, Rgba, Rgba),
    toggle: Toggle,
}

fn tile(
    id: &'static str,
    icon: IconName,
    title: &'static str,
    detail: &'static str,
    on: bool,
    colors: (Rgba, Rgba, Rgba),
    toggle: impl Fn(bool, &mut Window, &mut App) + 'static,
) -> Tile {
    Tile { id, icon, title, detail, on, colors, toggle: std::rc::Rc::new(toggle) }
}

impl RenderOnce for Tile {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = *cx.theme();
        let (id, on, (fill, ink, tint)) = (self.id, self.on, self.colors);
        let handle = item_focus(&id.into(), window, cx);
        let (toggle, key_toggle) = (self.toggle.clone(), self.toggle);
        let (hover, accent) = (theme.hover, theme.accent);
        div()
            .id(id)
            .debug_selector(move || id.to_string())
            .track_focus(&handle)
            .flex()
            .flex_none()
            .items_center()
            .gap(px(8.0))
            .w_full()
            .px(px(10.0))
            .py(px(8.0))
            .rounded(RADIUS_CONTROL)
            .border_1()
            .cursor_pointer()
            .when(on, |el| el.border_color(gpui::transparent_black()).bg(tint))
            .when(!on, |el| el.border_color(theme.line).hover(move |style| style.bg(hover)))
            .focus_visible(move |style| style.shadow(crate::ui::inset_ring(accent)))
            .on_click(move |_, window, cx| toggle(!on, window, cx))
            .on_key_down(move |event, window, cx| {
                if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                    key_toggle(!on, window, cx);
                    cx.stop_propagation();
                }
            })
            .child(Icon::new(self.icon).size(IconSize::S16).color(if on { fill } else { theme.ink2 }))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .child(
                        div()
                            .text_step(TEXT_12)
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(if on { ink } else { theme.ink })
                            .child(self.title),
                    )
                    .child(div().truncate().text_step(TEXT_11).text_color(theme.ink3).child(self.detail)),
            )
    }
}

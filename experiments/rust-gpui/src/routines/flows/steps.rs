//! The step list (R-06: `FlowSteps.tsx`): the trigger's card, then each step's card with a + on the rail between them,
//! an If's two paths indented under it on their own rail, an empty path as a dashed row, and for a flow with no steps a
//! tile for each step type. Also the card itself (`FlowCard`), shared with the Run view, and the Add step menu.
//!
//! Stateless: every piece takes the Routines view and calls its `flow_*` actions.

use std::collections::HashMap;

use gpui::{AnyElement, App, Entity, FontWeight, IntoElement, Rgba, SharedString, Window, div, prelude::*, px};

use super::look::{field_icon, step_look};
use super::ops::{STEP_TYPES, Where, step_subtitle, step_title};
use super::types::*;
use crate::routines::RoutinesView;
use crate::routines::list::card_shadow;
use crate::theme::{ActiveTheme, RADIUS_CARD, RADIUS_CHIP, RADIUS_CONTROL, TEXT_11, TEXT_12, TEXT_13, TEXT_15, TextStepExt, Theme};
use crate::ui::{Icon, IconButton, IconButtonSize, IconName, IconSize, MenuList, MenuRow, Popover};

/// The rail's x inside a column: the tile's centre (12px padding, 32px tile).
pub(crate) const RAIL: f32 = 27.0;
/// How far an If's path is indented.
pub(crate) const INDENT: f32 = 44.0;

/// A step type's tile: its icon on its colour.
pub(crate) fn step_tile(kind: Option<StepKind>, dim: bool, theme: &Theme) -> AnyElement {
    let (icon, fill, ink) = step_look(kind, theme);
    div()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(px(32.0))
        .rounded(RADIUS_CONTROL)
        .bg(fill)
        .when(dim, |el| el.opacity(0.6))
        .child(Icon::new(icon).size(IconSize::S16).color(ink))
        .into_any_element()
}

/// A field a step gives, as a small chip on its card: its type's glyph and its name.
pub(crate) fn field_chip(label: &str, icon: IconName, theme: &Theme) -> AnyElement {
    let selector = format!("flow-field-chip-{label}");
    div()
        .debug_selector(move || selector.clone())
        .flex()
        .flex_none()
        .items_center()
        .gap(px(4.0))
        .h(px(24.0))
        .max_w(px(140.0))
        .px(px(6.0))
        .rounded(RADIUS_CHIP)
        .border_1()
        .border_color(theme.line)
        .text_step(TEXT_11)
        .text_color(theme.ink2)
        .child(Icon::new(icon).size(IconSize::S12).color(theme.ink3))
        .child(div().min_w_0().truncate().child(label.to_string()))
        .into_any_element()
}

/// The chips a step's card shows: an agent step's output fields, a pull request's link.
fn step_chips(step: &FlowStep) -> Vec<(String, IconName)> {
    match &step.body {
        StepBody::Agent(agent) => agent
            .output
            .iter()
            .map(|field| (if field.name.is_empty() { "field".to_string() } else { field.name.clone() }, field_icon(field.ty)))
            .collect(),
        StepBody::PullRequest(_) => vec![("url".into(), IconName::Link01)],
        _ => Vec::new(),
    }
}

/// What a card holds.
pub(crate) struct Card {
    pub selector: String,
    pub kind: Option<StepKind>,
    pub title: SharedString,
    pub subtitle: SharedString,
    pub subtitle_ink: Option<Rgba>,
    pub selected: bool,
    /// A ring that says the card's state (waiting, failed), over the selected one's.
    pub ring: Option<Rgba>,
    pub dim: bool,
    pub trailing: Vec<AnyElement>,
    pub menu: Option<AnyElement>,
}

impl Card {
    pub fn new(
        selector: impl Into<String>,
        kind: Option<StepKind>,
        title: impl Into<SharedString>,
        subtitle: impl Into<SharedString>,
    ) -> Self {
        Card {
            selector: selector.into(),
            kind,
            title: title.into(),
            subtitle: subtitle.into(),
            subtitle_ink: None,
            selected: false,
            ring: None,
            dim: false,
            trailing: Vec::new(),
            menu: None,
        }
    }
}

fn ring_shadow(color: Rgba) -> Vec<gpui::BoxShadow> {
    vec![gpui::BoxShadow {
        color: color.into(),
        offset: gpui::point(px(0.0), px(0.0)),
        blur_radius: px(0.0),
        spread_radius: px(2.0),
        inset: false,
    }]
}

/// A card in the flow: tile, title and subtitle, then the trailing chips and state. The card's body selects it; the
/// menu sits beside it.
pub(crate) fn flow_card(card: Card, on_select: impl Fn(&mut Window, &mut App) + 'static, theme: &Theme) -> AnyElement {
    let selector = card.selector.clone();
    let group = SharedString::from(format!("{}-group", card.selector));
    let ring = card.ring.or(card.selected.then_some(theme.accent));
    let has_menu = card.menu.is_some();
    let has_trailing = !card.trailing.is_empty();
    div()
        .id(SharedString::from(card.selector.clone()))
        .debug_selector(move || selector.clone())
        .group(group)
        .relative()
        .flex()
        .items_center()
        .min_h(px(64.0))
        .rounded(RADIUS_CARD)
        .bg(theme.surface)
        .shadow(match ring {
            Some(color) => ring_shadow(color),
            None => card_shadow(theme),
        })
        .child(
            div()
                .id(SharedString::from(format!("{}-body", card.selector)))
                .flex()
                .flex_1()
                .min_w_0()
                .items_center()
                .gap(px(12.0))
                .py(px(12.0))
                .pl(px(12.0))
                .pr(px(if has_menu { 4.0 } else { 12.0 }))
                .rounded(RADIUS_CARD)
                .cursor_pointer()
                .on_click(move |_, window, cx| on_select(window, cx))
                .child(step_tile(card.kind, card.dim, theme))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .flex_1()
                        .min_w_0()
                        .gap(px(2.0))
                        .child(
                            div()
                                .truncate()
                                .text_step(TEXT_13)
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(if card.dim { theme.ink3 } else { theme.ink })
                                .child(card.title),
                        )
                        .child(
                            div().truncate().text_step(TEXT_12).text_color(card.subtitle_ink.unwrap_or(theme.ink3)).child(card.subtitle),
                        ),
                )
                .when(has_trailing, |el| el.child(div().flex().flex_none().items_center().gap(px(8.0)).children(card.trailing))),
        )
        .when_some(card.menu, |el, menu| el.child(div().flex().flex_none().items_center().pr(px(8.0)).child(menu)))
        .into_any_element()
}

/// The ⋯ on a step's card and in its inspector: Move up, Move down, Delete. On a card it shows on hover.
pub(crate) fn step_menu(
    view: &Entity<RoutinesView>,
    step: &FlowStep,
    can_up: bool,
    can_down: bool,
    inline: bool,
    group: Option<SharedString>,
) -> AnyElement {
    let (id, name) = (step.id.clone(), step.name.clone());
    let content_view = view.clone();
    let content_id = id.clone();
    let _ = name;
    Popover::new(SharedString::from(format!("flow-step-menu-{id}-{}", if inline { "inspector" } else { "card" })))
        .width(px(192.0))
        .trigger(move |open| {
            let button = IconButton::new(SharedString::from(format!("flow-step-more-{id}-{inline}")), IconName::MoreHorizontal)
                .size(IconButtonSize::S28)
                .pressed(open);
            div()
                .when(!inline && !open, |el| {
                    let group = group.clone().expect("a card's menu has its card's group");
                    el.opacity(0.0).group_hover(group, |style| style.opacity(1.0))
                })
                .child(button)
                .into_any_element()
        })
        .content(move |dismiss, _window, _cx| {
            let (up, down, delete) = (content_view.clone(), content_view.clone(), content_view.clone());
            let (up_id, down_id, delete_id) = (content_id.clone(), content_id.clone(), content_id.clone());
            MenuList::new("flow-step-menu")
                .dismiss(dismiss)
                .row(MenuRow::new("flow-action-up", "Move up").icon(IconName::ArrowUp01).disabled(!can_up).on_click(move |_, _, cx| {
                    up.update(cx, |this, cx| this.flow_move(&up_id, -1, cx));
                }))
                .row(MenuRow::new("flow-action-down", "Move down").icon(IconName::ArrowDown01).disabled(!can_down).on_click(
                    move |_, _, cx| {
                        down.update(cx, |this, cx| this.flow_move(&down_id, 1, cx));
                    },
                ))
                .row(MenuRow::new("flow-action-delete", "Delete").icon(IconName::Delete02).danger().on_click(move |_, _, cx| {
                    delete.update(cx, |this, cx| this.flow_delete(&delete_id, cx));
                }))
                .into_any_element()
        })
        .into_any_element()
}

fn path_heading(where_: &Where) -> String {
    match (&where_.parent_id, where_.branch) {
        (Some(_), Some(branch)) => format!("Add to the {} path", branch.label()),
        _ => "Add a step here".into(),
    }
}

/// The Add step menu: every step type with its tile and what it does.
fn add_menu(view: &Entity<RoutinesView>, where_: &Where, dismiss: &crate::ui::Dismiss, theme: &Theme) -> AnyElement {
    let rows = STEP_TYPES.iter().map(|ty| {
        let (view, where_, dismiss, kind) = (view.clone(), where_.clone(), dismiss.clone(), ty.kind);
        let selector = format!("flow-add-{}", ty.kind.id());
        div()
            .id(SharedString::from(selector.clone()))
            .debug_selector(move || selector.clone())
            .flex()
            .items_center()
            .gap(px(12.0))
            .min_h(px(48.0))
            .px(px(8.0))
            .py(px(6.0))
            .flex_none()
            .rounded(RADIUS_CONTROL)
            .cursor_pointer()
            .hover({
                let hover = theme.hover;
                move |style| style.bg(hover)
            })
            .on_click(move |_, window, cx| {
                dismiss.call(window, cx);
                let where_ = where_.clone();
                view.update(cx, |this, cx| this.flow_add(kind, &where_, cx));
            })
            .child(step_tile(Some(ty.kind), false, theme))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .child(div().truncate().text_step(TEXT_13).font_weight(FontWeight::MEDIUM).text_color(theme.ink).child(ty.name))
                    .child(div().truncate().text_step(TEXT_12).text_color(theme.ink3).child(ty.description)),
            )
    });
    div()
        .debug_selector(|| "flow-add-menu".into())
        .flex()
        .flex_col()
        .child(
            div()
                .px(px(8.0))
                .pt(px(4.0))
                .pb(px(6.0))
                .text_step(TEXT_12)
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.ink3)
                .child(path_heading(where_)),
        )
        .children(rows)
        .into_any_element()
}

/// The rail between two cards, with its + that opens the Add step menu for that place.
fn connector(view: &Entity<RoutinesView>, where_: Where, tall: bool, theme: &Theme) -> AnyElement {
    let theme = *theme;
    let key =
        format!("{}:{}:{}", where_.parent_id.as_deref().unwrap_or("top"), where_.branch.map_or("", |b| b.id()), where_.index.unwrap_or(0));
    let content_view = view.clone();
    let content_where = where_.clone();
    div()
        .debug_selector({
            let key = key.clone();
            move || format!("flow-connector-{key}")
        })
        .relative()
        .h(px(if tall { 32.0 } else { 24.0 }))
        .child(div().absolute().top_0().bottom_0().left(px(RAIL)).w(px(1.0)).bg(theme.line_strong))
        .child(
            div().absolute().top(px(if tall { 4.0 } else { 0.0 })).left(px(16.0)).h(px(24.0)).w(px(24.0)).child(
                Popover::new(SharedString::from(format!("flow-add-{key}")))
                    .align_start()
                    .width(px(360.0))
                    .trigger(move |open| {
                        let (border, ink) = if open { (theme.accent, theme.accent_ink) } else { (theme.line_strong, theme.ink3) };
                        div()
                            .id(SharedString::from(format!("flow-add-here-{key}")))
                            .debug_selector({
                                let key = key.clone();
                                move || format!("flow-add-here-{key}")
                            })
                            .flex()
                            .items_center()
                            .justify_center()
                            .size(px(24.0))
                            .rounded_full()
                            .cursor_pointer()
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .size(px(16.0))
                                    .rounded_full()
                                    .border_1()
                                    .border_color(border)
                                    .bg(theme.surface)
                                    .hover(move |style| style.border_color(theme.accent))
                                    .child(Icon::new(IconName::PlusSign).size(IconSize::S12).color(ink)),
                            )
                            .into_any_element()
                    })
                    .content(move |dismiss, _window, cx| add_menu(&content_view, &content_where, dismiss, cx.theme())),
            ),
        )
        .into_any_element()
}

/// An empty path's dashed row: it opens the Add step menu for the path.
fn empty_path(view: &Entity<RoutinesView>, where_: Where, theme: &Theme) -> AnyElement {
    let theme = *theme;
    let key = format!("{}:{}", where_.parent_id.as_deref().unwrap_or(""), where_.branch.map_or("", |b| b.id()));
    let content_view = view.clone();
    let content_where = where_.clone();
    Popover::new(SharedString::from(format!("flow-empty-path-{key}")))
        .align_start()
        .width(px(360.0))
        .trigger(move |open| {
            let (border, ink) = if open { (theme.accent, theme.accent_ink) } else { (theme.line_strong, theme.ink3) };
            div()
                .id(SharedString::from(format!("flow-empty-path-{key}")))
                .debug_selector({
                    let key = key.clone();
                    move || format!("flow-empty-path-{key}")
                })
                .flex()
                .items_center()
                .gap(px(8.0))
                .h(px(36.0))
                .w_full()
                .px(px(12.0))
                .rounded(RADIUS_CONTROL)
                .border_1()
                .border_dashed()
                .border_color(border)
                .when(open, |el| el.bg(theme.accent_tint))
                .text_step(TEXT_12)
                .text_color(ink)
                .cursor_pointer()
                .hover(move |style| style.border_color(theme.accent).bg(theme.accent_tint).text_color(theme.accent_ink))
                .child(Icon::new(IconName::PlusSign).size(IconSize::S14).color(ink))
                .child(div().min_w_0().truncate().child("Add step to this path, or leave it empty to go straight on"))
                .into_any_element()
        })
        .content(move |dismiss, _window, cx| add_menu(&content_view, &content_where, dismiss, cx.theme()))
        .into_any_element()
}

/// A path's label on the rail under its If: "Yes", "Otherwise", or in the Run view "Yes, taken".
pub(crate) fn path_label(text: &str, fill: Rgba, ink: Rgba, theme: &Theme) -> AnyElement {
    let selector = format!("flow-path-label-{text}");
    div()
        .debug_selector(move || selector.clone())
        .relative()
        .flex()
        .items_center()
        .h(px(32.0))
        .pl(px(36.0))
        .child(div().absolute().top(px(16.0)).left(px(RAIL)).h(px(1.0)).w(px(9.0)).bg(theme.line_strong))
        .child(
            div()
                .flex()
                .items_center()
                .h(px(24.0))
                .px(px(8.0))
                .rounded(RADIUS_CHIP)
                .bg(fill)
                .text_step(TEXT_12)
                .font_weight(FontWeight::MEDIUM)
                .text_color(ink)
                .child(text.to_string()),
        )
        .into_any_element()
}

fn rail(left: f32, theme: &Theme) -> AnyElement {
    div().absolute().top_0().bottom_0().left(px(left)).w(px(1.0)).bg(theme.line_strong).into_any_element()
}

/// What the list draws.
pub(crate) struct ListData<'a> {
    pub steps: &'a [FlowStep],
    pub selected: Option<&'a str>,
    /// The first problem of each step that has one, by step id.
    pub problems: &'a HashMap<String, String>,
}

/// The draft as a list: the trigger's card, then each step's card with a + on the rail between them, an If's paths
/// indented under it. A card selects its step; its ⋯ moves or deletes it.
pub(crate) fn step_list(view: &Entity<RoutinesView>, data: &ListData<'_>, trigger: AnyElement, theme: &Theme) -> AnyElement {
    let model_name = |provider, model: &str| crate::routines::model::model_name(provider, model);
    #[allow(clippy::too_many_arguments)]
    fn items(
        view: &Entity<RoutinesView>,
        data: &ListData<'_>,
        list: &[FlowStep],
        parent: Option<&str>,
        branch: Option<Branch>,
        theme: &Theme,
        model_name: &dyn Fn(Option<crate::data::Provider>, &str) -> String,
        out: &mut Vec<AnyElement>,
    ) {
        for (index, step) in list.iter().enumerate() {
            if index > 0 || parent.is_none() {
                out.push(connector(view, Where { parent_id: parent.map(str::to_string), branch, index: Some(index) }, false, theme));
            }
            out.push(card(view, data, step, index, list.len(), theme, model_name));
            if let StepBody::If(branching) = &step.body {
                let mut block = div().relative().child(rail(RAIL, theme));
                for path in [Branch::Yes, Branch::Otherwise] {
                    block = block.child(path_label(path.label(), theme.field, theme.ink2, theme));
                    let steps = branching.path(path);
                    let mut inner = Vec::new();
                    if steps.is_empty() {
                        inner.push(empty_path(view, Where::path(&step.id, path, 0), theme));
                    } else {
                        items(view, data, steps, Some(&step.id), Some(path), theme, model_name, &mut inner);
                        inner.push(connector(view, Where::path(&step.id, path, steps.len()), false, theme));
                    }
                    let selector = format!("flow-path-{}:{}", step.id, path.id());
                    block = block.child(div().debug_selector(move || selector.clone()).pl(px(INDENT)).children(inner));
                }
                out.push(block.child(div().h(px(8.0))).into_any_element());
            }
        }
    }
    fn card(
        view: &Entity<RoutinesView>,
        data: &ListData<'_>,
        step: &FlowStep,
        index: usize,
        count: usize,
        theme: &Theme,
        model_name: &dyn Fn(Option<crate::data::Provider>, &str) -> String,
    ) -> AnyElement {
        let title = step_title(step);
        let mut card = Card::new(
            format!("flow-step-{}", step.id),
            Some(step.kind()),
            if title.is_empty() { "Untitled step".to_string() } else { title },
            step_subtitle(step, model_name),
        );
        card.selected = data.selected == Some(step.id.as_str());
        let chips = step_chips(step);
        for (label, icon) in chips.iter().take(3) {
            card.trailing.push(field_chip(label, *icon, theme));
        }
        if chips.len() > 3 {
            card.trailing.push(div().text_step(TEXT_11).text_color(theme.ink3).child(format!("+{}", chips.len() - 3)).into_any_element());
        }
        if data.problems.contains_key(&step.id) {
            let selector = format!("flow-step-problem-{}", step.id);
            card.trailing.push(
                div()
                    .debug_selector(move || selector.clone())
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(20.0))
                    .child(Icon::new(IconName::Alert02).size(IconSize::S14).color(theme.red_ink))
                    .into_any_element(),
            );
        }
        let group = SharedString::from(format!("flow-step-{}-group", step.id));
        card.menu = Some(step_menu(view, step, index > 0, index + 1 < count, false, Some(group)));
        let (view, id) = (view.clone(), step.id.clone());
        flow_card(card, move |_, cx| view.update(cx, |this, cx| this.flow_select(&id, cx)), theme)
    }
    let mut out = vec![trigger];
    items(view, data, data.steps, None, None, theme, &model_name, &mut out);
    out.push(connector(view, Where::top(data.steps.len()), true, theme));
    div().debug_selector(|| "flow-step-list".into()).children(out).into_any_element()
}

/// A flow with no steps yet: under the trigger, a tile for each step type.
pub(crate) fn next_step_tiles(view: &Entity<RoutinesView>, theme: &Theme) -> AnyElement {
    let theme = *theme;
    let tiles = STEP_TYPES.iter().map(|ty| {
        let (view, kind) = (view.clone(), ty.kind);
        let selector = format!("flow-tile-{}", ty.kind.id());
        div()
            .id(SharedString::from(selector.clone()))
            .debug_selector(move || selector.clone())
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(px(8.0))
            .h(px(80.0))
            .rounded(RADIUS_CONTROL)
            .bg(theme.surface)
            .shadow(card_shadow(&theme))
            .cursor_pointer()
            .hover(move |style| style.bg(theme.hover))
            .on_click(move |_, _, cx| view.update(cx, |this, cx| this.flow_add_first(kind, cx)))
            .child(step_tile(Some(ty.kind), false, &theme))
            .child(div().text_step(TEXT_12).font_weight(FontWeight::MEDIUM).text_color(theme.ink).child(ty.short))
    });
    div()
        .debug_selector(|| "flow-empty".into())
        .p(px(16.0))
        .rounded(RADIUS_CARD)
        .bg(theme.accent_tint)
        .child(div().text_step(TEXT_15).font_weight(FontWeight::SEMIBOLD).text_color(theme.ink).child("What should happen next?"))
        .child(
            div()
                .mt(px(4.0))
                .text_step(TEXT_12)
                .text_color(theme.ink2)
                .child("Each step can read what the trigger and earlier steps give."),
        )
        .child(div().mt(px(16.0)).grid().grid_cols(3).gap(px(8.0)).children(tiles))
        .into_any_element()
}

/// The rail between the trigger and the tiles.
pub(crate) fn short_rail(theme: &Theme) -> AnyElement {
    div().relative().h(px(24.0)).child(rail(RAIL, theme)).into_any_element()
}

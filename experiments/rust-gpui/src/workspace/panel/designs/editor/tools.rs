//! The tool rail and the Layers panel (`DesignTools.tsx`): Layers and the six add buttons in a raised column at the
//! viewport's top-left; the panel beside it lists the layer tree (every design's when the page has several, the
//! active one expanded), and the main components to place.

use std::collections::HashSet;

use gpui::{AnyElement, ClickEvent, Context, FontWeight, SharedString, div, prelude::*, px};

use super::DesignEditor;
use crate::logic::design_ops::editor::{self as ops, LayerRow, TOOLS};
use crate::theme::{RADIUS_CARD, RADIUS_CONTROL, TEXT_10, TEXT_11, TEXT_12, TextStepExt, Theme};
use crate::ui::{Icon, IconButton, IconButtonSize, IconName, IconSize, ScrollArea, SectionLabel, Tooltip};

/// The rail's place in the viewport, its buttons, and the Layers panel's place and width (`left-[72px] w-56`).
const INSET: f32 = 16.0;
const RAIL_BUTTON: f32 = 32.0;
const PANEL_LEFT: f32 = 72.0;
const PANEL_WIDTH: f32 = 224.0;
/// A layer row (`h-7 my-0.5`), a design's row (`h-8 my-0.5`), the header, and a depth step.
const ROW: f32 = 32.0;
const ROOT_ROW: f32 = 36.0;
const HEADER: f32 = 41.0;
const INDENT: f32 = 12.0;

/// A glyph for a rail button.
enum Glyph {
    App(IconName),
}

fn glyph_element(glyph: Glyph, theme: &Theme) -> AnyElement {
    match glyph {
        Glyph::App(name) => Icon::new(name).size(IconSize::S16).color(theme.ink2).into_any_element(),
    }
}

fn rail_button(id: &str, label: &'static str, glyph: Glyph, pressed: bool, theme: &Theme) -> gpui::Stateful<gpui::Div> {
    let (hover, hover2) = (theme.hover, theme.hover2);
    let selector = id.to_string();
    div()
        .id(SharedString::from(id.to_string()))
        .debug_selector(move || selector.clone())
        .size(px(RAIL_BUTTON))
        .flex()
        .items_center()
        .justify_center()
        .rounded(RADIUS_CONTROL)
        .cursor_pointer()
        .when(pressed, |el| el.bg(hover2))
        .when(!pressed, |el| el.hover(move |s| s.bg(hover)))
        .tooltip(Tooltip::text(label))
        .child(glyph_element(glyph, theme))
}

pub fn rail(editor: &mut DesignEditor, theme: &Theme, cx: &mut Context<DesignEditor>) -> AnyElement {
    let layers = Glyph::App(IconName::Layers01);
    let open = editor.layers_open;
    let mut column = div()
        .debug_selector(|| "design-tool-rail".to_string())
        .absolute()
        .left(px(INSET))
        .top(px(INSET))
        .flex()
        .flex_col()
        .gap_1()
        .p_1()
        .rounded(RADIUS_CARD)
        .bg(theme.surface)
        .shadow(theme.shadow_raised())
        .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .child(
            rail_button("design-layers-toggle", "Layers", layers, open, theme)
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.set_layers_open(!open, cx))),
        )
        .child(div().mx_1().my(px(2.0)).h(px(1.0)).bg(theme.line));
    for (kind, label) in TOOLS {
        let glyph = match kind {
            "frame" => Glyph::App(IconName::Frame),
            "rectangle" => Glyph::App(IconName::Square),
            "ellipse" => Glyph::App(IconName::Circle),
            "text" => Glyph::App(IconName::TextFont),
            "image" => Glyph::App(IconName::Image01),
            _ => Glyph::App(IconName::Star),
        };
        column = column.child(
            rail_button(&format!("design-add-{kind}"), label, glyph, false, theme)
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.add(kind, cx))),
        );
    }
    column.into_any_element()
}

fn layer_row(row: &LayerRow, selected: bool, collapsed: bool, theme: &Theme, cx: &mut Context<DesignEditor>) -> AnyElement {
    let id = row.id.clone();
    let toggle: AnyElement = if row.has_children {
        let target = id.clone();
        IconButton::new(
            SharedString::from(format!("design-layer-fold-{id}")),
            if collapsed { IconName::ArrowRight01 } else { IconName::ArrowDown01 },
        )
        .size(IconButtonSize::S20)
        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.toggle_collapsed(&target, cx)))
        .into_any_element()
    } else {
        div().w(px(20.0)).flex_none().into_any_element()
    };
    let (hover, ink) = (theme.hover, theme.ink);
    let selector = format!("design-layer-{id}");
    let target = id.clone();
    div()
        .flex()
        .items_center()
        .gap(px(2.0))
        .pl(px(row.depth.min(8) as f32 * INDENT))
        .child(toggle)
        .child(
            div()
                .id(SharedString::from(selector.clone()))
                .debug_selector(move || selector.clone())
                .my(px(2.0))
                .h(px(28.0))
                .flex_1()
                .min_w_0()
                .flex()
                .items_center()
                .gap_2()
                .px_2()
                .rounded(RADIUS_CONTROL)
                .text_step(TEXT_12)
                .cursor_pointer()
                .when(selected, |el| el.bg(theme.hover2).text_color(theme.ink))
                .when(!selected, |el| el.text_color(theme.ink2).hover(move |s| s.bg(hover).text_color(ink)))
                .child(div().w(px(12.0)).flex_none().text_center().text_step(TEXT_10).child(ops::layer_glyph(row)))
                .child(div().min_w_0().truncate().when(row.hidden, |el| el.opacity(0.5)).child(row.name.clone()))
                .on_click(cx.listener(move |this, event: &ClickEvent, _, cx| {
                    let m = event.modifiers();
                    this.select(Some(&target), m.shift || m.platform || m.control, cx);
                })),
        )
        .into_any_element()
}

pub fn layers(editor: &mut DesignEditor, theme: &Theme, cx: &mut Context<DesignEditor>) -> AnyElement {
    let Some(active) = editor.active() else { return div().into_any_element() };
    let nodes = active.nodes();
    let selected: HashSet<String> = active.selected().into_iter().collect();
    let rows = ops::layer_rows(&nodes, &editor.collapsed);
    let components: Vec<(String, String)> = nodes
        .iter()
        .filter(|n| n.get("component").and_then(|c| c.as_bool()) == Some(true))
        .filter_map(|n| {
            let id = n.get("id")?.as_str()?.to_string();
            Some((id.clone(), n.get("name").and_then(|v| v.as_str()).unwrap_or(&id).to_string()))
        })
        .collect();
    let total: usize = editor.sessions.iter().map(|s| s.nodes().len()).sum();
    let many = editor.sessions.len() > 1;
    let layer_rows: Vec<AnyElement> =
        rows.iter().map(|row| layer_row(row, selected.contains(&row.id), editor.collapsed.contains(&row.id), theme, cx)).collect();
    let mut list: Vec<AnyElement> = Vec::new();
    let mut height = HEADER + 8.0;
    if many {
        let mut layer_rows = Some(layer_rows);
        for session in &editor.sessions {
            let open = session.id == editor.active;
            let id = session.id.clone();
            let selector = format!("design-layer-root-{id}");
            let (hover, ink) = (theme.hover, theme.ink);
            list.push(
                div()
                    .id(SharedString::from(selector.clone()))
                    .debug_selector(move || selector.clone())
                    .my(px(2.0))
                    .h(px(32.0))
                    .w_full()
                    .flex()
                    .items_center()
                    .gap_2()
                    .px_2()
                    .rounded(RADIUS_CONTROL)
                    .text_step(TEXT_12)
                    .cursor_pointer()
                    .when(open, |el| el.bg(theme.hover2).text_color(theme.ink))
                    .when(!open, |el| el.text_color(theme.ink2).hover(move |s| s.bg(hover).text_color(ink)))
                    .child(
                        Icon::new(if open { IconName::ArrowDown01 } else { IconName::ArrowRight01 }).size(IconSize::S12).color(theme.ink3),
                    )
                    .child(div().flex_1().min_w_0().truncate().font_weight(FontWeight::MEDIUM).child(session.title.clone()))
                    .child(div().flex_none().text_step(TEXT_11).text_color(theme.ink3).child(session.nodes().len().to_string()))
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.activate(&id, cx)))
                    .into_any_element(),
            );
            height += ROOT_ROW;
            if open && let Some(rows) = layer_rows.take() {
                height += ROW * rows.len() as f32;
                list.push(div().ml_2().pl_1().border_l_1().border_color(theme.line).children(rows).into_any_element());
            }
        }
    } else {
        height += ROW * layer_rows.len() as f32;
        list.extend(layer_rows);
    }
    let components_height = if components.is_empty() { 0.0 } else { 36.0 + 32.0 * components.len().min(5) as f32 + 16.0 };
    let room = (editor.room.1 as f32 - 2.0 * INSET).max(120.0);
    let list_height = height.min(room - components_height) - HEADER;
    let close = cx.listener(|this, _: &ClickEvent, _, cx| this.set_layers_open(false, cx));
    div()
        .debug_selector(|| "design-layers-panel".to_string())
        .absolute()
        .left(px(PANEL_LEFT))
        .top(px(INSET))
        .w(px(PANEL_WIDTH))
        .flex()
        .flex_col()
        .overflow_hidden()
        .rounded(RADIUS_CARD)
        .bg(theme.surface)
        .shadow(theme.shadow_raised())
        .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_scroll(|_, _, cx| cx.stop_propagation())
        .child(
            div()
                .flex_none()
                .h(px(HEADER))
                .flex()
                .items_center()
                .gap_2()
                .px_3()
                .border_b_1()
                .border_color(theme.line)
                .child(
                    div().flex_1().flex().items_baseline().text_step(TEXT_12).font_weight(FontWeight::MEDIUM).child("Layers").child(
                        div().ml_1().font_weight(FontWeight::NORMAL).text_color(theme.ink3).child(total.to_string()).into_any_element(),
                    ),
                )
                .child(IconButton::new("design-layers-close", IconName::Cancel01).size(IconButtonSize::S24).on_click(close)),
        )
        .child(
            div()
                .flex_none()
                .h(px(list_height.max(40.0)))
                .p_1()
                .child(ScrollArea::new("design-layers-list", &editor.layers_scroll).children(list)),
        )
        .when(!components.is_empty(), |el| {
            el.child(
                div()
                    .flex_none()
                    .border_t_1()
                    .border_color(theme.line)
                    .child(div().px_3().pt_3().child(SectionLabel::new("Components")))
                    .child(div().p_2().flex().flex_col().children(components.into_iter().map(|(id, name)| {
                        let (hover, ink) = (theme.hover, theme.ink);
                        let target = id.clone();
                        div()
                            .id(SharedString::from(format!("design-insert-{id}")))
                            .mb_1()
                            .h(px(28.0))
                            .px_2()
                            .flex()
                            .items_center()
                            .rounded(RADIUS_CONTROL)
                            .text_step(TEXT_12)
                            .text_color(theme.ink2)
                            .cursor_pointer()
                            .hover(move |s| s.bg(hover).text_color(ink))
                            .child(div().truncate().child(format!("◇ {name}")))
                            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.insert_instance(&target, cx)))
                    }))),
            )
        })
        .into_any_element()
}

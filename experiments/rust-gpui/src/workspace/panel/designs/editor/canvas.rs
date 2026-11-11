//! The board: group blocks and names, each design's artboard under its title, and on the active one the selection
//! the preview controller draws (`design-controller-script.mjs`): a 2px outline around the selection, a 1px box per
//! layer when there are several, the resize handle at the corner of a single unlocked layer, and the snap guides.

use gpui::{AnyElement, Context, FontWeight, Pixels, Rgba, SharedString, div, prelude::*, px, rgb};

use super::page::{self, TITLE};
use super::{DesignEditor, GUIDE, SELECTION};
use crate::logic::design_ops::editor::{self as ops, Rect};
use crate::logic::design_ops::schema::Node;
use crate::theme::{RADIUS_CARD, TEXT_13, TextStepExt, Theme};
use crate::workspace::panel::designs::render;

/// The resize handle's size and how far it sticks out past the corner, in design px.
const HANDLE: f64 = 10.0;
const HANDLE_OUT: f64 = 5.0;

fn p(value: f64) -> Pixels {
    px(value as f32)
}

/// Whether a design point is on the resize handle: one selected layer, unlocked, not an instance.
pub fn handle_hit(nodes: &[Node], roots: &[String], bounds: &[(String, Rect)], (x, y): (f64, f64), _scale: f64) -> bool {
    let Some(rect) = handle_rect(nodes, roots, bounds) else { return false };
    x >= rect.x && x <= rect.right() && y >= rect.y && y <= rect.bottom()
}

fn handle_rect(nodes: &[Node], roots: &[String], bounds: &[(String, Rect)]) -> Option<Rect> {
    let [id] = roots else { return None };
    let node = nodes.iter().find(|n| n.get("id").and_then(|v| v.as_str()) == Some(id.as_str()))?;
    if !ops::unlocked(nodes, id) || node.get("componentId").is_some_and(|c| !c.is_null()) {
        return None;
    }
    let rect = bounds.iter().find(|(b, _)| b == id)?.1;
    Some(Rect { x: rect.right() - HANDLE_OUT, y: rect.bottom() - HANDLE_OUT, width: HANDLE, height: HANDLE })
}

/// The selection drawn over the active design's screen, at the zoom.
fn selection(editor: &mut DesignEditor, id: &str, scale: f64, cx: &mut Context<DesignEditor>) -> Vec<AnyElement> {
    let bounds = editor.bounds(id, cx);
    let Some(session) = editor.session(id) else { return Vec::new() };
    let nodes = session.nodes();
    let roots = ops::selection_roots(&nodes, &session.selected());
    let (width, height) = session.size();
    let boxes: Vec<Rect> = roots.iter().filter_map(|r| bounds.iter().find(|(b, _)| b == r).map(|(_, rect)| *rect)).collect();
    let Some(outline) = Rect::union(&boxes) else { return Vec::new() };
    let blue = rgb(SELECTION);
    let at =
        |rect: Rect| div().absolute().left(p(rect.x * scale)).top(p(rect.y * scale)).w(p(rect.width * scale)).h(p(rect.height * scale));
    let mut out = Vec::new();
    if boxes.len() > 1 {
        for rect in &boxes {
            out.push(at(*rect).border_1().border_color(blue).into_any_element());
        }
    }
    out.push(
        at(outline)
            .debug_selector(|| "design-selection".to_string())
            .border(p((2.0 * scale).max(1.0)))
            .border_color(blue)
            .into_any_element(),
    );
    if let Some(handle) = handle_rect(&nodes, &roots, &bounds) {
        out.push(
            at(handle).debug_selector(|| "design-resize".to_string()).border_1().border_color(blue).bg(gpui::white()).into_any_element(),
        );
    }
    if let Some((x, y)) = editor.guides() {
        let pink = rgb(GUIDE);
        if let Some(x) = x {
            out.push(div().absolute().left(p(x * scale)).top_0().w(px(1.0)).h(p(height * scale)).bg(pink).into_any_element());
        }
        if let Some(y) = y {
            out.push(div().absolute().top(p(y * scale)).left_0().h(px(1.0)).w(p(width * scale)).bg(pink).into_any_element());
        }
    }
    out
}

/// Every group and artboard in view.
pub fn board(editor: &mut DesignEditor, theme: &Theme, cx: &mut Context<DesignEditor>) -> AnyElement {
    let view = editor.view;
    let page = editor.page();
    let room = editor.room;
    let mut children: Vec<AnyElement> = Vec::new();
    for group in &page.groups {
        let (x, y) = view.to_screen(group.x, group.y);
        children.push(
            div()
                .absolute()
                .left(p(x))
                .top(p(y))
                .w(p(group.width * view.scale))
                .h(p(group.height * view.scale))
                .rounded(p(f64::from(f32::from(RADIUS_CARD)) * view.scale))
                .bg(theme.hover)
                .into_any_element(),
        );
        let name: SharedString = group.name.clone().unwrap_or_else(|| "Ungrouped".into()).into();
        let selector = format!("design-page-group-{name}");
        children.push(
            div()
                .debug_selector(move || selector.clone())
                .absolute()
                .left(p(x))
                .top(p(y - page::GROUP_LABEL))
                .h(p(page::GROUP_LABEL))
                .pb_2()
                .flex()
                .items_end()
                .gap_2()
                .whitespace_nowrap()
                .text_step(TEXT_13)
                .child(
                    div().font_weight(FontWeight::MEDIUM).text_color(if group.name.is_some() { theme.ink } else { theme.ink3 }).child(name),
                )
                .child(div().text_color(theme.ink3).child(group.count.to_string()))
                .into_any_element(),
        );
    }
    for artboard in &page.artboards {
        let (x, y) = view.to_screen(artboard.x, artboard.y);
        let (w, h) = (artboard.width * view.scale, (TITLE + artboard.height) * view.scale);
        if room != (0.0, 0.0) && (x > room.0 || y > room.1 || x + w < 0.0 || y + h < 0.0) {
            continue;
        }
        children.push(artboard_element(editor, &artboard.id, x, y, artboard.width, artboard.height, theme, cx));
    }
    div().absolute().size_full().children(children).into_any_element()
}

#[allow(clippy::too_many_arguments)]
fn artboard_element(
    editor: &mut DesignEditor,
    id: &str,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    theme: &Theme,
    cx: &mut Context<DesignEditor>,
) -> AnyElement {
    let scale = editor.view.scale;
    let active = editor.active == id;
    let scene = editor.scene(id, cx);
    let Some(session) = editor.session(id) else { return div().into_any_element() };
    let title: SharedString = session.title.clone().into();
    let kit = scene.as_ref().map(|s| s.document.kit_label()).unwrap_or_default();
    let overlay = if active { selection(editor, id, scale, cx) } else { Vec::new() };
    let accent = Rgba { a: 0.4, ..theme.accent };
    let font = (13.0 * scale).max(1.0);
    let frame_selector = format!("design-page-frame-{id}");
    let preview_selector = format!("design-editor-preview-{id}");
    div()
        .debug_selector(move || frame_selector.clone())
        .absolute()
        .left(p(x))
        .top(p(y))
        .w(p(width * scale))
        .h(p((TITLE + height) * scale))
        .child(
            div()
                .absolute()
                .left_0()
                .top_0()
                .w_full()
                .h(p(18.0 * scale))
                .flex()
                .items_center()
                .whitespace_nowrap()
                .overflow_hidden()
                .text_size(p(font))
                .line_height(p(18.0 * scale))
                .text_color(if active { theme.ink } else { theme.ink3 })
                .child(title)
                .when(!kit.is_empty(), |el| el.child(div().ml(p(8.0 * scale)).text_color(theme.ink3).child(kit))),
        )
        .child(
            div()
                .debug_selector(move || preview_selector.clone())
                .absolute()
                .left_0()
                .top(p(TITLE * scale))
                .w(p(width * scale))
                .h(p(height * scale))
                .bg(gpui::white())
                .shadow(theme.shadow_raised())
                .when_some(scene, |el, scene| el.child(div().absolute().size_full().overflow_hidden().child(render::scene(&scene, scale))))
                .children(overlay)
                .when(active, |el| {
                    el.child(
                        div()
                            .absolute()
                            .top(px(-1.0))
                            .left(px(-1.0))
                            .w(p(width * scale + 2.0))
                            .h(p(height * scale + 2.0))
                            .border_1()
                            .border_color(accent),
                    )
                }),
        )
        .into_any_element()
}

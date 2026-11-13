//! WP-55: the page's geometry, and the editor in the headless window: Edit opens it over the panel, a click selects
//! a layer, a drag moves it with snapping as one undo step, the resize handle, keys, the inspector's fields and
//! selects, the Layers panel, Save adding a version to the canvas, and the close confirmation.

use gpui::{Entity, Modifiers, MouseButton, TestAppContext, VisualTestContext, point, px};
use serde_json::Value;

use super::page::{self, View};
use super::{DesignEditor, PAGE_HEADER};
use crate::logic::design_ops::nodes_of;
use crate::testing;
use crate::theme::HEADER_HEIGHT;
use crate::workspace::panel::designs::DesignsView;
use crate::workspace::panel::designs::board::Item;

fn item(id: &str, group: Option<&str>, width: f64, height: f64) -> Item {
    Item { id: id.into(), group: group.map(Into::into), width, height }
}

#[test]
fn the_page_lays_groups_out_with_titles_on_the_artboards() {
    let items = [item("a", Some("One"), 390.0, 844.0), item("b", Some("One"), 390.0, 844.0), item("c", None, 480.0, 360.0)];
    let scale = 0.5;
    let page = page::layout(&items, scale);
    let label = page::GROUP_LABEL / scale;
    assert_eq!(page.groups.len(), 2);
    assert_eq!((page.artboards[0].x, page.artboards[0].y), (page::GROUP_PADDING, label + page::GROUP_PADDING));
    assert_eq!(page.artboards[1].x, page::GROUP_PADDING + 390.0 + page::GAP);
    assert_eq!(page.groups[0].height, page::TITLE + 844.0 + 2.0 * page::GROUP_PADDING);
    let second = page.groups[0].y + page.groups[0].height + page::GAP + label;
    assert_eq!(page.groups[1].y, second);
    assert_eq!(page.artboards[0].screen_y(), page.artboards[0].y + page::TITLE);
    assert!(page::artboard_at(&page, 100.0, page.artboards[0].screen_y() + 10.0).is_some_and(|a| a.id == "a"));
    assert!(page::artboard_at(&page, 100.0, page.artboards[0].y + 2.0).is_none(), "the title is not the design");
}

#[test]
fn the_fit_leaves_room_for_the_panels_and_never_zooms_past_one() {
    let items = [item("a", None, 390.0, 844.0)];
    let view = page::fit(&items, (1440.0, 800.0), 0.5, false).unwrap();
    let height = 800.0 - page::FIT_TOP - page::FIT_BOTTOM;
    assert!((view.scale - height / (page::TITLE + 844.0)).abs() < 1e-9);
    let width = 1440.0 - page::FIT_LEFT - page::FIT_RIGHT;
    assert!((view.x - (page::FIT_LEFT + (width - 390.0 * view.scale) / 2.0)).abs() < 1e-9);
    let small = page::fit(&[item("a", None, 100.0, 100.0)], (1440.0, 800.0), 0.5, true).unwrap();
    assert_eq!(small.scale, 1.0);
    let zoomed = View { x: 0.0, y: 0.0, scale: 1.0 }.zoom_at(100.0, 10.0, 10.0);
    assert_eq!(zoomed.scale, page::MAX_SCALE);
}

fn mount(cx: &mut TestAppContext) -> (Entity<DesignsView>, Entity<DesignEditor>, &mut VisualTestContext) {
    let (view, cx) = testing::mount_in_root(cx, |_, cx| DesignsView::new(cx));
    cx.simulate_resize(gpui::size(px(1440.0), px(900.0)));
    // Fitted on one design, its title row has room for Edit.
    view.update(cx, |v, cx| v.open_design("sign-in", cx));
    cx.run_until_parked();
    let edit = testing::bounds(cx, "design-edit-sign-in");
    cx.simulate_click(edit.center(), Modifiers::none());
    cx.run_until_parked();
    let editor = view.read_with(cx, |v, _| v.editor().cloned()).expect("Edit opens the editor");
    (view, editor, cx)
}

/// A point of a design's own pixels on screen, from the editor's view.
fn design_point(editor: &Entity<DesignEditor>, cx: &mut VisualTestContext, design: &str, x: f64, y: f64) -> gpui::Point<gpui::Pixels> {
    editor.read_with(cx, |e, _| {
        let page = e.page();
        let board = page.artboards.iter().find(|a| a.id == design).unwrap();
        let view = e.view();
        let (sx, sy) = view.to_screen(board.x + x, board.screen_y() + y);
        point(px(sx as f32), px((sy + f64::from(f32::from(HEADER_HEIGHT)) + PAGE_HEADER) as f32))
    })
}

fn node(editor: &Entity<DesignEditor>, cx: &mut VisualTestContext, id: &str) -> serde_json::Map<String, Value> {
    editor.read_with(cx, |e, _| nodes_of(e.active().unwrap().document()).into_iter().find(|n| n["id"] == id).unwrap())
}

#[gpui::test]
fn edit_opens_the_page_on_every_design_with_the_first_text_selected(cx: &mut TestAppContext) {
    let (_, editor, cx) = mount(cx);
    testing::bounds(cx, "design-editor");
    testing::bounds(cx, "design-tool-rail");
    testing::bounds(cx, "design-editor-inspector");
    testing::bounds(cx, "design-selection");
    editor.read_with(cx, |e, _| {
        assert_eq!(e.active_id(), "sign-in");
        assert_eq!(e.sessions().len(), 4);
        assert_eq!(e.status(), "Saved · version 1");
        let first_text = nodes_of(e.active().unwrap().document()).into_iter().find(|n| n["type"] == "text").unwrap();
        assert_eq!(e.selection(), vec![first_text["id"].as_str().unwrap().to_string()]);
    });
}

#[gpui::test]
fn a_drag_moves_the_layer_snapped_as_one_undo_step(cx: &mut TestAppContext) {
    let (_, editor, cx) = mount(cx);
    // The sign-in card's free-positioned layers: pick one in a free parent.
    let (id, rect) = editor.update(cx, |e, cx| {
        let nodes = nodes_of(e.active().unwrap().document());
        let id = nodes
            .iter()
            .filter_map(|n| n["id"].as_str())
            .find(|id| crate::logic::design_ops::editor::movable(&nodes, id))
            .unwrap()
            .to_string();
        let rect = e.bounds("sign-in", cx).into_iter().find(|(b, _)| *b == id).unwrap().1;
        (id, rect)
    });
    let before = node(&editor, cx, &id);
    let start = design_point(&editor, cx, "sign-in", rect.x + rect.width / 2.0, rect.y + rect.height / 2.0);
    let scale = editor.read_with(cx, |e, _| e.view().scale) as f32;
    let end = point(start.x + px(40.0 * scale), start.y + px(23.0 * scale));
    cx.simulate_mouse_down(start, MouseButton::Left, Modifiers::none());
    cx.simulate_mouse_move(end, Some(MouseButton::Left), Modifiers::none());
    assert!(editor.read_with(cx, |e, _| e.guides().is_some()), "a live drag shows its guides");
    cx.simulate_mouse_up(end, MouseButton::Left, Modifiers::none());
    cx.run_until_parked();
    let after = node(&editor, cx, &id);
    let dx = after["x"].as_f64().unwrap_or(0.0) - before["x"].as_f64().unwrap_or(0.0);
    let dy = after["y"].as_f64().unwrap_or(0.0) - before["y"].as_f64().unwrap_or(0.0);
    assert!((dx - 40.0).abs() <= 6.0 && (dy - 23.0).abs() <= 6.0, "moved by about the drag, snapped within 6px: {dx}, {dy}");
    editor.read_with(cx, |e, _| {
        assert_eq!(e.selection(), vec![id.clone()]);
        assert_eq!(e.status(), "Unsaved changes in 1 design");
        assert!(e.guides().is_none());
    });
    editor.update(cx, |e, cx| e.undo(cx));
    assert_eq!(node(&editor, cx, &id), before);
    editor.update(cx, |e, cx| e.redo(cx));
    assert_eq!(node(&editor, cx, &id)["x"], after["x"]);
}

#[gpui::test]
fn the_handle_resizes_and_fixes_the_size(cx: &mut TestAppContext) {
    let (_, editor, cx) = mount(cx);
    let (id, rect) = editor.update(cx, |e, cx| {
        let id = e.selection()[0].clone();
        let rect = e.bounds("sign-in", cx).into_iter().find(|(b, _)| *b == id).unwrap().1;
        (id, rect)
    });
    let corner = design_point(&editor, cx, "sign-in", rect.right(), rect.bottom());
    let scale = editor.read_with(cx, |e, _| e.view().scale) as f32;
    let end = point(corner.x - px(30.0 * scale), corner.y + px(17.0 * scale));
    cx.simulate_mouse_down(corner, MouseButton::Left, Modifiers::none());
    cx.simulate_mouse_move(end, Some(MouseButton::Left), Modifiers::none());
    cx.simulate_mouse_up(end, MouseButton::Left, Modifiers::none());
    let after = node(&editor, cx, &id);
    assert_eq!(after["widthMode"], "fixed");
    assert!((after["width"].as_f64().unwrap() - (rect.width - 30.0)).abs() <= 6.0);
}

#[gpui::test]
fn clicks_select_and_shift_adds(cx: &mut TestAppContext) {
    let (_, editor, cx) = mount(cx);
    let boxes = editor.update(cx, |e, cx| e.bounds("sign-in", cx));
    let leaves: Vec<_> = boxes.iter().rev().take(2).cloned().collect();
    let a = design_point(&editor, cx, "sign-in", leaves[0].1.x + 1.0, leaves[0].1.y + 1.0);
    cx.simulate_click(a, Modifiers::none());
    let first = editor.read_with(cx, |e, _| e.selection());
    assert_eq!(first.len(), 1);
    let b = design_point(&editor, cx, "sign-in", leaves[1].1.x + 1.0, leaves[1].1.y + 1.0);
    cx.simulate_click(b, Modifiers::shift());
    assert_eq!(editor.read_with(cx, |e, _| e.selection().len()), 2);
    // A click on another design makes it the active one.
    let other = design_point(&editor, cx, "welcome", 5.0, 5.0);
    cx.simulate_click(other, Modifiers::none());
    assert_eq!(editor.read_with(cx, |e, _| e.active_id().to_string()), "welcome");
}

#[gpui::test]
fn keys_nudge_duplicate_delete_and_undo(cx: &mut TestAppContext) {
    let (_, editor, cx) = mount(cx);
    let id = editor.read_with(cx, |e, _| e.selection()[0].clone());
    let x = node(&editor, cx, &id)["x"].as_f64().unwrap_or(0.0);
    let movable = editor.read_with(cx, |e, _| crate::logic::design_ops::editor::movable(&e.active().unwrap().nodes(), &id));
    cx.simulate_keystrokes("shift-right");
    let moved = node(&editor, cx, &id)["x"].as_f64().unwrap_or(0.0);
    assert_eq!(moved, if movable { x + 10.0 } else { x });
    let count = editor.read_with(cx, |e, _| e.active().unwrap().nodes().len());
    cx.simulate_keystrokes("cmd-d");
    let selection = editor.read_with(cx, |e, _| e.selection());
    assert_ne!(selection, vec![id.clone()]);
    assert_eq!(editor.read_with(cx, |e, _| e.active().unwrap().nodes().len()), count + 1);
    cx.simulate_keystrokes("backspace");
    assert_eq!(editor.read_with(cx, |e, _| e.active().unwrap().nodes().len()), count);
    cx.simulate_keystrokes("cmd-z cmd-z");
    assert_eq!(editor.read_with(cx, |e, _| e.active().unwrap().nodes().len()), count);
    cx.simulate_keystrokes("cmd-shift-z");
    assert_eq!(editor.read_with(cx, |e, _| e.active().unwrap().nodes().len()), count + 1);
}

#[gpui::test]
fn the_rail_adds_layers_and_the_layers_panel_selects(cx: &mut TestAppContext) {
    let (_, editor, cx) = mount(cx);
    let add = testing::bounds(cx, "design-add-rectangle");
    cx.simulate_click(add.center(), Modifiers::none());
    let id = editor.read_with(cx, |e, _| e.selection()[0].clone());
    assert!(id.starts_with("rectangle-"), "{id}");
    assert_eq!(node(&editor, cx, &id)["fill"], "#dce6df");
    let toggle = testing::bounds(cx, "design-layers-toggle");
    cx.simulate_click(toggle.center(), Modifiers::none());
    assert!(editor.read_with(cx, |e, _| e.layers_open()));
    testing::bounds(cx, "design-layers-panel");
    let first = editor.read_with(cx, |e, _| nodes_of(e.active().unwrap().document())[0]["id"].as_str().unwrap().to_string());
    let row = testing::bounds(cx, testing::leak(format!("design-layer-{first}")));
    cx.simulate_click(row.center(), Modifiers::none());
    assert_eq!(editor.read_with(cx, |e, _| e.selection()), vec![first]);
    cx.simulate_keystrokes("escape");
    assert!(!editor.read_with(cx, |e, _| e.layers_open()), "Escape closes Layers first");
}

#[gpui::test]
fn inspector_fields_commit_on_enter_and_reject_out_of_range(cx: &mut TestAppContext) {
    let (_, editor, cx) = mount(cx);
    let id = editor.read_with(cx, |e, _| e.selection()[0].clone());
    let field = testing::bounds(cx, "design-field-font-size");
    cx.simulate_click(field.center(), Modifiers::none());
    cx.simulate_keystrokes("cmd-a");
    cx.simulate_input("31");
    cx.simulate_keystrokes("enter");
    assert_eq!(node(&editor, cx, &id)["fontSize"].as_f64(), Some(31.0));
    let weight = testing::bounds(cx, "design-field-font-weight");
    cx.simulate_click(weight.center(), Modifiers::none());
    cx.simulate_keystrokes("cmd-a");
    cx.simulate_input("1200");
    cx.simulate_keystrokes("enter");
    assert_ne!(node(&editor, cx, &id)["fontWeight"].as_f64(), Some(1200.0), "out of range goes back");
    let name = testing::bounds(cx, "design-field-layer-name");
    cx.simulate_click(name.center(), Modifiers::none());
    cx.simulate_keystrokes("cmd-a");
    cx.simulate_input("Headline");
    cx.simulate_keystrokes("enter");
    assert_eq!(node(&editor, cx, &id)["name"], "Headline");
}

#[gpui::test]
fn save_adds_a_version_to_the_canvas(cx: &mut TestAppContext) {
    let (view, editor, cx) = mount(cx);
    editor.update(cx, |e, cx| e.nudge(0.0, 4.0, cx));
    editor.update(cx, |e, cx| e.add("text", cx));
    cx.simulate_keystrokes("cmd-s");
    cx.run_until_parked();
    editor.read_with(cx, |e, _| {
        assert_eq!(e.changed(), 0);
        assert_eq!(e.status(), "Saved · version 2");
    });
    view.read_with(cx, |v, _| {
        let design = v.design("sign-in").unwrap();
        assert_eq!(design.latest(), 2);
        assert_eq!(v.shown_version("sign-in"), 2);
        assert_eq!(nodes_of(design.source(2).unwrap()).len(), nodes_of(design.source(1).unwrap()).len() + 1);
    });
}

#[gpui::test]
fn closing_with_changes_asks_first(cx: &mut TestAppContext) {
    let (view, editor, cx) = mount(cx);
    editor.update(cx, |e, cx| e.add("ellipse", cx));
    let close = testing::bounds(cx, "design-close");
    cx.simulate_click(close.center(), Modifiers::none());
    assert!(editor.read_with(cx, |e, _| e.confirming()));
    let keep = testing::bounds(cx, "design-keep-editing");
    cx.simulate_click(keep.center(), Modifiers::none());
    assert!(view.read_with(cx, |v, _| v.editor().is_some()));
    let close = testing::bounds(cx, "design-close");
    cx.simulate_click(close.center(), Modifiers::none());
    let discard = testing::bounds(cx, "design-discard");
    cx.simulate_click(discard.center(), Modifiers::none());
    cx.run_until_parked();
    assert!(view.read_with(cx, |v, _| v.editor().is_none()));
    assert_eq!(view.read_with(cx, |v, _| v.design("sign-in").unwrap().latest()), 1, "discarding saves nothing");
}

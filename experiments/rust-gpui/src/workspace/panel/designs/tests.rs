//! WP-36: the board's geometry (rows, fit, zoom about a point), the scenes built from the fixture designs, and the
//! Designs tab in the headless window: frames drawn per group, the version picker, choosing and sending, Delete,
//! handing a design the mouse, panning and the zoom bar.

use gpui::{Modifiers, MouseButton, TestAppContext, VisualTestContext, point, px};

use super::board::{self, Item, View};
use super::scene::{Content, Scene};
use super::{DesignsView, fixture};
use crate::testing;

fn item(id: &str, group: Option<&str>, width: f64, height: f64) -> Item {
    Item { id: id.into(), group: group.map(Into::into), width, height }
}

// The board.

#[test]
fn rows_follow_the_order_groups_first_appear() {
    let items = [
        item("a", Some("Onboarding"), 390.0, 844.0),
        item("b", None, 480.0, 360.0),
        item("c", Some(" Onboarding "), 390.0, 844.0),
        item("d", Some(""), 10.0, 10.0),
    ];
    let rows = board::rows(&items);
    let shape: Vec<(Option<&str>, Vec<&str>)> =
        rows.iter().map(|(g, m)| (g.as_deref(), m.iter().map(|i| i.id.as_str()).collect())).collect();
    // A blank group is no group; names are trimmed (`designGroups`).
    assert_eq!(shape, vec![(Some("Onboarding"), vec!["a", "c"]), (None, vec!["b", "d"])]);
}

#[test]
fn an_ungrouped_board_is_one_row_with_no_blocks() {
    let items = [item("a", None, 390.0, 844.0), item("b", None, 1280.0, 800.0)];
    let board = board::layout(&items, 0.5);
    assert!(board.groups.is_empty());
    let header = board::HEADER / 0.5;
    assert_eq!(board.frames[0].frame, board::Rect { x: 0.0, y: 0.0, width: 390.0, height: header + 844.0 });
    assert_eq!(board.frames[1].body, board::Rect { x: 390.0 + board::GAP, y: header, width: 1280.0, height: 800.0 });
    assert_eq!((board.frames[0].number, board.frames[1].number), (1, 2));
}

#[test]
fn grouped_rows_stack_with_their_names_and_padding() {
    let items = [item("a", Some("One"), 400.0, 300.0), item("b", Some("Two"), 200.0, 100.0), item("c", None, 100.0, 100.0)];
    let scale = 0.5;
    let board = board::layout(&items, scale);
    assert_eq!(board.groups.len(), 3);
    let label = board::GROUP_LABEL / scale;
    let header = board::HEADER / scale; // 400 * 0.5 = 200 on screen: compact, one row
    let first = &board.groups[0];
    assert_eq!(
        first.block,
        board::Rect { x: 0.0, y: label, width: 400.0 + 2.0 * board::GROUP_PADDING, height: header + 300.0 + 2.0 * board::GROUP_PADDING }
    );
    assert_eq!(board.frames[0].body.x, board::GROUP_PADDING);
    assert_eq!(board.frames[0].body.y, label + board::GROUP_PADDING + header);
    // The next section starts a gap below the block.
    assert_eq!(board.groups[1].section.y, first.block.bottom() + board::GAP);
    assert_eq!(board.groups[2].name, None);
    assert_eq!(board.frames[2].number, 3);
}

#[test]
fn a_frame_narrow_on_screen_wraps_then_floats_its_controls() {
    assert_eq!(board::header_fit(390.0, 1.0), board::HeaderFit::Row);
    assert_eq!(board::header_fit(390.0, 0.7), board::HeaderFit::Narrow);
    assert_eq!(board::header_height(390.0, 0.7), board::HEADER * 2.0);
    assert_eq!(board::header_fit(390.0, 0.5), board::HeaderFit::Compact);
    assert_eq!(board::header_height(390.0, 0.5), board::HEADER);
}

#[test]
fn zooming_keeps_the_point_under_the_pointer() {
    let view = View { x: 40.0, y: 30.0, scale: 0.5 };
    let (px, py) = (300.0, 200.0);
    let canvas = ((px - view.x) / view.scale, (py - view.y) / view.scale);
    let zoomed = view.zoom_at(1.25, px, py);
    assert!((zoomed.scale - 0.625).abs() < 1e-12);
    let (sx, sy) = zoomed.to_screen(canvas.0, canvas.1);
    assert!((sx - px).abs() < 1e-9 && (sy - py).abs() < 1e-9);
    // Clamped at both ends.
    assert_eq!(view.zoom_at(100.0, 0.0, 0.0).scale, board::MAX_SCALE);
    assert_eq!(view.zoom_at(0.0001, 0.0, 0.0).scale, board::MIN_SCALE);
}

#[test]
fn the_dot_grid_never_packs_closer_than_twelve_pixels() {
    assert_eq!(board::dot_step(1.0), 24.0);
    assert_eq!(board::dot_step(0.5), 12.0);
    assert_eq!(board::dot_step(0.4), 19.200000000000003);
    assert_eq!(board::dot_step(0.05), 19.200000000000003);
}

#[test]
fn fit_centres_the_designs_and_settles_with_the_title_rows() {
    let items = [item("a", None, 390.0, 844.0), item("b", None, 390.0, 844.0)];
    let room = (900.0, 800.0);
    let view = board::fit(&items, None, room, 0.4).unwrap();
    // The title rows keep their screen size, so the fit is measured again at the zoom it lands on.
    let board = board::layout(&items, view.scale);
    let (left, top) = view.to_screen(0.0, 0.0);
    let right = view.to_screen(board.frames[1].frame.right(), 0.0).0;
    let bottom = view.to_screen(0.0, board.frames[0].frame.bottom()).1;
    assert!((left - (room.0 - right)).abs() < 1.0, "centred across: {left} .. {right}");
    let space = room.1 - board::FIT_MARGIN - board::FIT_BOTTOM;
    // Within a pixel: the last pass measures at the zoom before the one it lands on, within 0.5% of it.
    assert!((top - board::FIT_MARGIN - (space - (bottom - top)) / 2.0).abs() < 1.0);
    assert!(bottom <= room.1 - board::FIT_BOTTOM + 1.0 && top >= board::FIT_MARGIN - 1.0);
    // Never past 100%, and fitting one design frames it alone.
    assert_eq!(board::fit(&[item("a", None, 100.0, 100.0)], None, (2000.0, 2000.0), 0.4).unwrap().scale, 1.0);
    let one = board::fit(&items, Some("b"), room, 0.4).unwrap();
    assert!(one.to_screen(board::layout(&items, one.scale).frames[1].body.x, 0.0).0 > 0.0);
    assert!(board::fit(&items, Some("missing"), room, 0.4).is_none());
}

// The fixture and its scenes.

#[test]
fn the_fixture_has_phone_and_desktop_screens_in_groups() {
    let designs = fixture::designs();
    let sizes: Vec<(&str, f64, f64, u32)> =
        designs.iter().map(|d| (d.id.as_str(), d.versions[0].width, d.versions[0].height, d.latest())).collect();
    assert_eq!(
        sizes,
        vec![("welcome", 390.0, 844.0, 2), ("sign-in", 390.0, 844.0, 1), ("settings", 1280.0, 800.0, 3), ("empty-state", 480.0, 360.0, 1)]
    );
    assert_eq!(designs[2].group.as_deref(), Some("Settings"));
    assert_eq!(designs[3].group, None);
    assert_eq!(designs[2].versions[2].kit_label(), "Strict · Studio · kit v3");
}

#[gpui::test]
fn scenes_resolve_paint_text_icons_and_images(cx: &mut TestAppContext) {
    testing::init(cx);
    cx.update(|cx| {
        super::assets::register_fonts(cx);
        let mut icons = Default::default();
        for design in fixture::designs() {
            for document in &design.versions {
                let scene = Scene::build(document.clone(), &mut icons, cx);
                assert_eq!(scene.layers.len(), document.nodes.iter().filter(|n| !n.hidden).count(), "{}", design.id);
                for layer in &scene.layers {
                    match &layer.content {
                        Content::Icon(image) => assert!(image.is_some(), "{} {} icon decoded", design.id, layer.id),
                        Content::Text(text) => assert!(!text.lines.is_empty() && text.color.is_some(), "{} {}", design.id, layer.id),
                        _ => {}
                    }
                }
            }
        }
        let welcome = &fixture::designs()[0];
        let scene = Scene::build(welcome.versions[0].clone(), &mut icons, cx);
        let layer = |id: &str| scene.layers.iter().find(|l| l.id == id).unwrap();
        assert!(matches!(layer("hero").content, Content::Image(Some(_))), "the inline PNG decodes");
        assert!(layer("blob").ellipse);
        assert_eq!(layer("blob2").opacity, 0.6);
        assert_eq!(layer("badge").stroke.map(|s| s.0), Some(1.0));
        // A token fill resolves through the document's tokens.
        assert_eq!(layer("primary").fill, super::scene::rgba("#2f6b4f"));
        let Content::Text(title) = &layer("title").content else { panic!() };
        assert_eq!(&*title.family, super::scene::INTER);
        assert_eq!(title.weight, 700.0);
        // The hit test a comment's anchor uses: the button, not the label in it.
        assert_eq!(scene.layer_at(40.0, 710.0), Some("primary"));
    });
}

// The tab in a window.

fn mount(cx: &mut TestAppContext) -> (gpui::Entity<DesignsView>, &mut VisualTestContext) {
    let (view, cx) = testing::mount_in_root(cx, |_, cx| DesignsView::new(cx));
    settle(cx);
    (view, cx)
}

/// Draws again until nothing changes: the canvas measures itself while it paints and fits on the next frame.
fn settle(cx: &mut VisualTestContext) {
    for _ in 0..3 {
        cx.update(|window, _| window.refresh());
        cx.run_until_parked();
    }
}

fn sel(name: String) -> &'static str {
    testing::leak(name)
}

#[gpui::test]
fn every_design_is_drawn_in_its_group_and_fitted(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    for id in ["welcome", "sign-in", "settings", "empty-state"] {
        testing::bounds(cx, sel(format!("design-body-{id}")));
    }
    for group in ["Onboarding", "Settings", "Ungrouped"] {
        testing::bounds(cx, sel(format!("design-group-{group}")));
    }
    // Fitted into the canvas: every frame is inside it.
    let canvas = testing::bounds(cx, "designs-canvas");
    for id in ["welcome", "settings", "empty-state"] {
        let frame = testing::bounds(cx, sel(format!("design-frame-{id}")));
        assert!(
            frame.origin.x >= canvas.origin.x && frame.bottom_right().x <= canvas.bottom_right().x + px(1.0),
            "{id} {frame:?} in {canvas:?}"
        );
        assert!(
            frame.origin.y >= canvas.origin.y && frame.bottom_right().y <= canvas.bottom_right().y + px(1.0),
            "{id} {frame:?} in {canvas:?}"
        );
    }
    let scale = view.read_with(cx, |v, _| v.view().scale);
    assert!((board::MIN_SCALE..1.0).contains(&scale));
    // The phone screen is drawn at its aspect.
    let phone = testing::bounds(cx, "design-body-welcome");
    assert!((f32::from(phone.size.height) / f32::from(phone.size.width) - 844.0 / 390.0).abs() < 0.02);
}

#[gpui::test]
fn the_version_picker_steps_through_versions(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    // Zoom in so the settings frame's title row has its controls on one row.
    view.update(cx, |v, cx| v.open_design("settings", cx));
    settle(cx);
    assert_eq!(view.read_with(cx, |v, _| v.shown_version("settings")), 3);
    let prev = testing::bounds(cx, "design-prev-settings");
    cx.simulate_click(prev.center(), Modifiers::none());
    settle(cx);
    assert_eq!(view.read_with(cx, |v, _| v.shown_version("settings")), 2);
    let prev = testing::bounds(cx, "design-prev-settings");
    cx.simulate_click(prev.center(), Modifiers::none());
    settle(cx);
    assert_eq!(view.read_with(cx, |v, _| v.shown_version("settings")), 1);
    // At v1 the previous arrow is disabled.
    let prev = testing::bounds(cx, "design-prev-settings");
    cx.simulate_click(prev.center(), Modifiers::none());
    settle(cx);
    assert_eq!(view.read_with(cx, |v, _| v.shown_version("settings")), 1);
    let next = testing::bounds(cx, "design-next-settings");
    cx.simulate_click(next.center(), Modifiers::none());
    settle(cx);
    cx.simulate_click(next.center(), Modifiers::none());
    settle(cx);
    // Back on the newest: it follows later versions again.
    assert_eq!(view.read_with(cx, |v, _| (v.shown_version("settings"), v.versions.contains_key("settings"))), (3, false));
    // Stepping versions did not pan the canvas.
    assert!(!view.read_with(cx, |v, _| v.moved));
}

#[gpui::test]
fn choosing_then_sending_marks_the_design_chosen(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    view.update(cx, |v, cx| v.open_design("welcome", cx));
    settle(cx);
    assert!(cx.debug_bounds("designs-send").is_none());
    let choose = testing::bounds(cx, "design-choose-welcome");
    cx.simulate_click(choose.center(), Modifiers::none());
    settle(cx);
    assert_eq!(view.read_with(cx, |v, _| v.pending().map(|(id, v)| (id.to_string(), v))), Some(("welcome".into(), 2)));
    let send = testing::bounds(cx, "designs-send");
    cx.simulate_click(send.center(), Modifiers::none());
    settle(cx);
    assert_eq!(
        view.read_with(cx, |v, _| (v.pending().is_none(), v.sent().map(|(id, v)| (id.to_string(), v)))),
        (true, Some(("welcome".into(), 2)))
    );
    testing::bounds(cx, "design-chosen-welcome");
    // Another version of it is not the chosen one.
    view.update(cx, |v, cx| v.go("welcome", 1, cx));
    settle(cx);
    assert!(cx.debug_bounds("design-chosen-welcome").is_none());
}

#[gpui::test]
fn delete_asks_once_more_then_removes_the_design(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    view.update(cx, |v, cx| v.open_design("sign-in", cx));
    settle(cx);
    let delete = testing::bounds(cx, "design-delete-sign-in");
    cx.simulate_click(delete.center(), Modifiers::none());
    settle(cx);
    let cancel = testing::bounds(cx, "design-delete-cancel-sign-in");
    cx.simulate_click(cancel.center(), Modifiers::none());
    settle(cx);
    assert_eq!(view.read_with(cx, |v, _| v.designs().len()), 4);
    let delete = testing::bounds(cx, "design-delete-sign-in");
    cx.simulate_click(delete.center(), Modifiers::none());
    settle(cx);
    let confirm = testing::bounds(cx, "design-delete-confirm-sign-in");
    cx.simulate_click(confirm.center(), Modifiers::none());
    settle(cx);
    assert_eq!(
        view.read_with(cx, |v, _| v.designs().iter().map(|d| d.id.clone()).collect::<Vec<_>>()),
        ["welcome", "settings", "empty-state"]
    );
    assert!(cx.debug_bounds("design-body-sign-in").is_none());
}

#[gpui::test]
fn a_click_hands_a_design_the_mouse_and_a_drag_pans(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    let body = testing::bounds(cx, "design-body-empty-state");
    cx.simulate_click(body.center(), Modifiers::none());
    settle(cx);
    assert_eq!(view.read_with(cx, |v, _| v.active().map(str::to_string)), Some("empty-state".into()));
    cx.simulate_keystrokes("escape");
    settle(cx);
    assert_eq!(view.read_with(cx, |v, _| v.active().map(str::to_string)), None);
    // A drag from a design pans instead of selecting it.
    let before = view.read_with(cx, |v, _| v.view());
    let start = body.center();
    cx.simulate_mouse_down(start, MouseButton::Left, Modifiers::none());
    cx.simulate_mouse_move(point(start.x + px(60.0), start.y + px(25.0)), MouseButton::Left, Modifiers::none());
    cx.simulate_mouse_up(point(start.x + px(60.0), start.y + px(25.0)), MouseButton::Left, Modifiers::none());
    let after = view.read_with(cx, |v, _| v.view());
    assert!((after.x - before.x - 60.0).abs() < 0.5 && (after.y - before.y - 25.0).abs() < 0.5, "{before:?} -> {after:?}");
    assert_eq!(view.read_with(cx, |v, _| v.active().map(str::to_string)), None);
}

#[gpui::test]
fn the_zoom_bar_zooms_about_the_middle_and_fits(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    let fitted = view.read_with(cx, |v, _| v.view());
    let zoom_in = testing::bounds(cx, "designs-zoom-in");
    cx.simulate_click(zoom_in.center(), Modifiers::none());
    settle(cx);
    let zoomed = view.read_with(cx, |v, _| v.view());
    assert!((zoomed.scale / fitted.scale - board::ZOOM_STEP).abs() < 1e-9);
    let reset = testing::bounds(cx, "designs-zoom");
    cx.simulate_click(reset.center(), Modifiers::none());
    settle(cx);
    assert!((view.read_with(cx, |v, _| v.view().scale) - 1.0).abs() < 1e-9, "reset to 100%");
    let fit = testing::bounds(cx, "designs-fit");
    cx.simulate_click(fit.center(), Modifiers::none());
    settle(cx);
    let refitted = view.read_with(cx, |v, _| v.view());
    // Back to the fit, measured from 100% this time: the same within the fit's settling tolerance.
    assert!((refitted.scale - fitted.scale).abs() < 0.006, "{fitted:?} vs {refitted:?}");
    assert_eq!(&*super::zoom_label(0.444), "44%");
}

// A data layer's designs (live).

fn live_designs() -> Vec<super::fixture::DesignArtifact> {
    // As the host keeps them: "settings" with only versions 2 and 3 kept.
    let mut designs = super::fixture::designs();
    let settings = designs.iter_mut().find(|d| d.id == "settings").unwrap();
    let sources: Vec<serde_json::Value> = settings.sources[1..].iter().map(|s| (**s).clone()).collect();
    *settings =
        super::fixture::DesignArtifact::from_documents(settings.id.clone(), settings.title.clone(), settings.group.clone(), 2, sources)
            .unwrap();
    designs
}

#[gpui::test]
fn live_designs_load_as_a_skeleton_then_draw_with_their_kept_versions_and_pins(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    view.update(cx, |v, cx| v.start_live(cx));
    settle(cx);
    assert!(view.read_with(cx, |v, _| v.is_loading() && v.designs().is_empty()));
    testing::bounds(cx, "designs-skeleton");
    let pin = super::DesignPin {
        id: "c1".into(),
        design: "welcome".into(),
        version: 2,
        x: 0.5,
        y: 0.25,
        number: 1,
        text: "Bigger title".into(),
        resolved: true,
        note: Some("Made it 32px".into()),
    };
    view.update(cx, |v, cx| v.set_live(live_designs(), vec![pin], cx));
    settle(cx);
    assert!(cx.debug_bounds("designs-skeleton").is_none());
    // A resolved comment shows only with "Show resolved comments" (right-click on the comment button).
    assert!(cx.debug_bounds("design-pin-c1").is_none(), "resolved: hidden");
    let button = testing::bounds(cx, "designs-comment");
    cx.simulate_mouse_down(button.center(), MouseButton::Right, Modifiers::none());
    cx.simulate_mouse_up(button.center(), MouseButton::Right, Modifiers::none());
    settle(cx);
    let row = testing::bounds(cx, "designs-show-resolved");
    cx.simulate_click(row.center(), Modifiers::none());
    settle(cx);
    assert!(view.read_with(cx, |v, _| v.comments_state().show_resolved));
    let body = testing::bounds(cx, "design-body-welcome");
    let drawn = testing::bounds(cx, "design-pin-c1");
    assert!((drawn.origin.x - (body.origin.x + body.size.width * 0.5)).abs() < px(1.0), "{drawn:?} on {body:?}");
    assert!((drawn.origin.y - (body.origin.y + body.size.height * 0.25)).abs() < px(1.0));
    // The kept versions only: 2 and 3; the previous arrow stops at 2.
    let (first, latest) = view.read_with(cx, |v, _| (v.design("settings").unwrap().first, v.design("settings").unwrap().latest()));
    assert_eq!((first, latest), (2, 3));
    view.update(cx, |v, cx| v.go("settings", 1, cx));
    assert_eq!(view.read_with(cx, |v, _| v.shown_version("settings")), 2);
    // Live, Edit is hidden (its Save would need `artifact:apply`).
    view.update(cx, |v, cx| v.open_design("welcome", cx));
    settle(cx);
    assert!(cx.debug_bounds("design-edit-welcome").is_none());
}

#[gpui::test]
fn live_delete_and_send_are_events_for_the_data_layer(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    view.update(cx, |v, cx| v.set_live(live_designs(), Vec::new(), cx));
    let events = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    {
        let events = events.clone();
        cx.update(|_, cx| {
            cx.subscribe(&view, move |_, event: &super::DesignsEvent, _| events.borrow_mut().push(event.clone())).detach();
        });
    }
    view.update(cx, |v, cx| {
        v.choose("welcome", cx);
        v.send(cx);
        v.delete("sign-in", cx);
    });
    cx.run_until_parked();
    assert_eq!(
        *events.borrow(),
        vec![super::DesignsEvent::Send(super::choice_message("welcome", "Welcome", 2)), super::DesignsEvent::Delete("sign-in".into()),]
    );
    assert_eq!(
        super::choice_message("welcome", "Welcome", 2),
        "I chose the design \"Welcome\" (welcome, version 2). Continue from this one.",
        "Electron's designFeedbackMessage for a choice"
    );
    assert!(view.read_with(cx, |v, _| v.design("sign-in").is_none()), "gone from the board at once");
}

// Comment mode.

fn events(view: &gpui::Entity<DesignsView>, cx: &mut VisualTestContext) -> std::rc::Rc<std::cell::RefCell<Vec<super::DesignsEvent>>> {
    let events = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    let sink = events.clone();
    cx.update(|_, cx| {
        cx.subscribe(view, move |_, event: &super::DesignsEvent, _| sink.borrow_mut().push(event.clone())).detach();
    });
    events
}

/// `ArtifactCanvas`'s comment mode: the comment button (or C) arms it, a click on a design pins a comment there (with
/// the layer under it) and opens its bubble with the text field focused; Enter keeps it, its pin stays; Send sends the
/// choice and the comment as Electron's message and records the comment; comment mode ends.
#[gpui::test]
fn a_click_in_comment_mode_pins_a_comment_and_send_sends_it(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    view.update(cx, |v, cx| v.set_live(live_designs(), Vec::new(), cx));
    settle(cx);
    let events = events(&view, cx);
    let at = testing::bounds(cx, "designs-comment").center();
    cx.simulate_click(at, Modifiers::none());
    settle(cx);
    assert!(view.read_with(cx, |v, _| v.comments_state().commenting));
    let body = testing::bounds(cx, "design-body-welcome");
    let spot = point(body.origin.x + body.size.width * 0.5, body.origin.y + body.size.height * 0.1);
    cx.simulate_click(spot, Modifiers::none());
    settle(cx);
    testing::bounds(cx, "comment-bubble");
    assert_eq!(view.read_with(cx, |v, _| v.active().map(str::to_string)), None, "a click in comment mode hands no design the mouse");
    cx.simulate_input("Bigger title");
    settle(cx);
    cx.simulate_keystrokes("enter");
    settle(cx);
    assert!(cx.debug_bounds("comment-bubble").is_none(), "Enter keeps it and closes the bubble");
    let draft = view.read_with(cx, |v, _| v.comments_state().drafts.clone());
    assert_eq!(draft.len(), 1);
    assert_eq!((draft[0].target.id.as_str(), draft[0].target.version, draft[0].text.as_str()), ("welcome", 2, "Bigger title"));
    assert!((draft[0].x - 0.5).abs() < 0.01 && (draft[0].y - 0.1).abs() < 0.01, "{:?}", (draft[0].x, draft[0].y));
    // The Send bar came (feedback waits), so the board refitted: the pin keeps its spot on the design.
    let pin = testing::bounds(cx, "design-draft-1");
    let body = testing::bounds(cx, "design-body-welcome");
    let spot = point(body.origin.x + body.size.width * draft[0].x as f32, body.origin.y + body.size.height * draft[0].y as f32);
    assert!(
        (pin.origin.x - spot.x).abs() < px(1.0) && (pin.origin.y - spot.y).abs() < px(1.0),
        "the pin point is the spot: {pin:?} vs {spot:?}"
    );
    assert_eq!(view.read_with(cx, |v, _| v.feedback()), 1);

    // C leaves comment mode; the comment waits. Choose a design too, then Send.
    cx.simulate_keystrokes("c");
    assert!(!view.read_with(cx, |v, _| v.comments_state().commenting));
    view.update(cx, |v, cx| v.choose("sign-in", cx));
    settle(cx);
    let at = testing::bounds(cx, "designs-send").center();
    cx.simulate_click(at, Modifiers::none());
    settle(cx);
    let sent = events.borrow().clone();
    let [super::DesignsEvent::Send(message), super::DesignsEvent::AddComments(recorded)] = sent.as_slice() else { panic!("{sent:?}") };
    let id = &draft[0].key;
    assert!(
        message
            .starts_with("I chose the design \"Sign in\" (sign-in, version 1). Continue from this one.\n\nA comment on the designs:\n\n"),
        "{message}"
    );
    assert!(
        message.contains(&format!("1. (comment {id}) On the design \"Welcome\" (welcome, version 2), 50% across and 10% down")),
        "{message}"
    );
    assert!(
        message.ends_with("Keep its id. Once you have addressed a comment, resolve it with artifact_resolve_comment and its comment id.")
    );
    assert_eq!(recorded.len(), 1);
    assert_eq!(recorded[0]["id"], serde_json::json!(id));
    assert_eq!(recorded[0]["design"], serde_json::json!({"id": "welcome", "title": "Welcome", "version": 2}));
    assert_eq!(recorded[0]["text"], serde_json::json!("Bigger title"));
    assert!(view.read_with(cx, |v, _| v.feedback() == 0 && v.comments_state().drafts.is_empty()));
}

/// A bubble closed empty drops its pin; Escape closes the bubble, then leaves comment mode; Delete removes a comment;
/// a sent comment's pin opens its text read back.
#[gpui::test]
fn bubbles_close_drop_and_read_back(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    let pin = super::DesignPin {
        id: "c9".into(),
        design: "welcome".into(),
        version: 2,
        x: 0.3,
        y: 0.6,
        number: 1,
        text: "Too dark".into(),
        resolved: false,
        note: None,
    };
    view.update(cx, |v, cx| v.set_live(live_designs(), vec![pin], cx));
    settle(cx);
    // C arms comment mode once the canvas has the keyboard (a press on it).
    let body = testing::bounds(cx, "design-body-welcome");
    cx.simulate_click(point(body.origin.x - px(30.0), body.origin.y - px(80.0)), Modifiers::none());
    cx.simulate_keystrokes("c");
    assert!(view.read_with(cx, |v, _| v.comments_state().commenting));
    let body = testing::bounds(cx, "design-body-welcome");
    let spot = point(body.origin.x + body.size.width * 0.7, body.origin.y + body.size.height * 0.2);
    cx.simulate_click(spot, Modifiers::none());
    settle(cx);
    testing::bounds(cx, "comment-bubble");
    cx.simulate_keystrokes("escape");
    settle(cx);
    assert!(cx.debug_bounds("comment-bubble").is_none());
    assert!(view.read_with(cx, |v, _| v.comments_state().drafts.is_empty()), "closed empty: dropped");
    assert!(view.read_with(cx, |v, _| v.comments_state().commenting), "the first Escape only closed the bubble");
    // Write one, then Delete it.
    cx.simulate_click(spot, Modifiers::none());
    settle(cx);
    cx.simulate_input("x");
    let at = testing::bounds(cx, "comment-delete").center();
    cx.simulate_click(at, Modifiers::none());
    settle(cx);
    assert!(view.read_with(cx, |v, _| v.comments_state().drafts.is_empty()), "Delete removes it");
    cx.simulate_keystrokes("escape");
    assert!(!view.read_with(cx, |v, _| v.comments_state().commenting), "Escape leaves comment mode");
    // The sent comment's pin (ink) opens its text, "Sent to the agent".
    let at = testing::bounds(cx, "design-pin-c9").center();
    cx.simulate_click(at, Modifiers::none());
    settle(cx);
    testing::bounds(cx, "comment-bubble");
    assert_eq!(view.read_with(cx, |v, _| v.comments_state().open.clone()), Some("sent:c9".into()));
    // A press on the canvas closes it.
    cx.simulate_click(point(body.origin.x - px(30.0), body.origin.y - px(80.0)), Modifiers::none());
    settle(cx);
    assert!(cx.debug_bounds("comment-bubble").is_none());
}

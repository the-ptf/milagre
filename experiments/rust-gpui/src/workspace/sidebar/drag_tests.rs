//! WP-49 tests: drags of a row (Pinned reorder, a Link on a row, onto the Chat view), the keyboard drag and its
//! announcements, Escape, the Link popovers and their writes and undo, the top bar's Link Projects, and the Link rules
//! (`shared/chat-links.test.ts`).

use gpui::{Entity, Modifiers, MouseButton, Pixels, Point, TestAppContext, VisualTestContext, point, px};

use super::Sidebar;
use super::actions::SidebarCall;
use super::drag::{DropIntent, DropZone};
use super::link_popover::PickerMode;
use super::links::{
    AskTarget, CanvasLink, LinkEnd, LinkProblem, LinkScope, can_link_projects, link_ask_message, link_between, link_endpoints,
    link_problem, linked_end_label, linked_ends,
};
use crate::testing;
use crate::workspace::Workspace;

fn mount(cx: &mut TestAppContext) -> (Entity<Workspace>, Entity<Sidebar>, &mut VisualTestContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let sidebar = workspace.read_with(cx, |workspace, _| workspace.sidebar.clone());
    (workspace, sidebar, cx)
}

fn key(sidebar: &Entity<Sidebar>, cx: &VisualTestContext, ix: usize) -> String {
    sidebar.read_with(cx, |s, _| s.row(ix).expect("a row").key.to_string())
}

fn row(cx: &mut VisualTestContext, ix: usize) -> gpui::Bounds<Pixels> {
    testing::bounds(cx, testing::leak(format!("chat-row-{ix}")))
}

/// A press at `from`, two moves to `to` (the first starts GPUI's drag, the second is its first move) and a release.
fn drag(cx: &mut VisualTestContext, from: Point<Pixels>, to: Point<Pixels>) {
    drag_to(cx, from, to);
    cx.simulate_mouse_up(to, MouseButton::Left, Modifiers::none());
    cx.run_until_parked();
}

fn drag_to(cx: &mut VisualTestContext, from: Point<Pixels>, to: Point<Pixels>) {
    cx.simulate_mouse_down(from, MouseButton::Left, Modifiers::none());
    cx.simulate_mouse_move(point(from.x, from.y + px(6.0)), Some(MouseButton::Left), Modifiers::none());
    cx.simulate_mouse_move(to, Some(MouseButton::Left), Modifiers::none());
    cx.run_until_parked();
}

/// A point `fraction` of the way down row `ix`.
fn at(cx: &mut VisualTestContext, ix: usize, fraction: f32) -> Point<Pixels> {
    let bounds = row(cx, ix);
    point(bounds.center().x, bounds.origin.y + bounds.size.height * fraction)
}

fn pins(sidebar: &Entity<Sidebar>, cx: &VisualTestContext) -> Vec<String> {
    sidebar.read_with(cx, |s, _| (0..s.pinned_count()).map(|ix| s.row(ix).unwrap().key.to_string()).collect())
}

fn same_scope(a: &str, b: &str) -> bool {
    a.rsplit_once('#').map(|(scope, _)| scope) == b.rsplit_once('#').map(|(scope, _)| scope)
}

#[gpui::test]
fn dragging_a_pinned_row_below_the_other_reorders_the_pins(cx: &mut TestAppContext) {
    let (_, sidebar, cx) = mount(cx);
    let before = pins(&sidebar, cx);
    assert_eq!(before.len(), 2);
    assert!(same_scope(&before[0], &before[1]), "the fixture pins two Chats of one Project: {before:?}");
    let (from, to) = (at(cx, 0, 0.5), at(cx, 1, 0.9));
    drag_to(cx, from, to);
    assert_eq!(sidebar.read_with(cx, |s, _| s.dragging().map(str::to_string)), Some(before[0].clone()));
    assert_eq!(sidebar.read_with(cx, |s, _| s.drop_target().map(|t| (t.key.clone(), t.zone))), Some((before[1].clone(), DropZone::After)));
    assert_eq!(sidebar.read_with(cx, |s, _| s.drop_intent_now()), DropIntent::Reorder);
    assert!(cx.debug_bounds("drop-line").is_some(), "the line under the target row");
    cx.simulate_mouse_up(to, MouseButton::Left, Modifiers::none());
    cx.run_until_parked();
    assert_eq!(pins(&sidebar, cx), vec![before[1].clone(), before[0].clone()], "the dragged row went after the other");
    assert!(sidebar.read_with(cx, |s, _| s.dragging().is_none()));
    let pinned = sidebar
        .read_with(cx, |s, _| s.calls())
        .into_iter()
        .any(|call| matches!(call, SidebarCall::Pin { chat, order: Some(_) } if chat == before[0]));
    assert!(pinned, "the new order went out as this device's pin");
    assert_eq!(sidebar.read_with(cx, |s, _| s.selected()), Some(sidebar.read_with(cx, |s, _| s.selected().unwrap())));
}

#[gpui::test]
fn a_drop_on_the_middle_of_a_row_asks_for_a_link_and_creating_it_can_be_undone(cx: &mut TestAppContext) {
    let (_, sidebar, cx) = mount(cx);
    let before = pins(&sidebar, cx);
    let linkable = sidebar.read_with(cx, |s, _| s.link_end(&before[0]).is_some() && s.link_end(&before[1]).is_some());
    assert!(linkable, "the pinned Chats have Worktrees in a local Git Project");
    let (from, to) = (at(cx, 0, 0.5), at(cx, 1, 0.5));
    drag_to(cx, from, to);
    assert_eq!(sidebar.read_with(cx, |s, _| s.drop_target().map(|t| t.zone)), Some(DropZone::On));
    assert_eq!(sidebar.read_with(cx, |s, _| s.drop_intent_now()), DropIntent::Link);
    assert!(cx.debug_bounds("drop-target").is_some(), "the row is outlined");
    cx.simulate_mouse_up(to, MouseButton::Left, Modifiers::none());
    cx.run_until_parked();
    assert_eq!(pins(&sidebar, cx), before, "a Link moves nothing");
    assert_eq!(sidebar.read_with(cx, |s, _| s.link_overlay()), Some("ask"));
    assert!(cx.debug_bounds("link-popover").is_some());
    let popover = sidebar.read_with(cx, |s, _| s.link_popover().expect("open"));
    assert_eq!(
        popover.read_with(cx, |p, _| (p.ask().source.key.clone(), p.ask().target.key.clone())),
        (before[0].clone(), before[1].clone())
    );
    // Always allow, and a message: "Create Link and ask".
    cx.update(|window, cx| {
        popover.update(cx, |p, cx| {
            p.set_allow(true, cx);
            p.set_text("Rebase on main", window, cx);
        })
    });
    assert_eq!(popover.read_with(cx, |p, cx| p.confirm_label(cx)), "Create Link and ask");
    let confirm = testing::bounds(cx, "link-confirm");
    cx.simulate_click(confirm.center(), Modifiers::none());
    cx.run_until_parked();
    assert_eq!(sidebar.read_with(cx, |s, _| s.link_overlay()), None);
    let links = sidebar.read_with(cx, |s, _| s.links().to_vec());
    assert_eq!(links.len(), 1);
    let calls = sidebar.read_with(cx, |s, _| s.calls());
    assert!(calls.iter().any(|call| matches!(call, SidebarCall::AddLink { .. })));
    assert!(
        calls.iter().any(|call| matches!(call, SidebarCall::GrantDelegations { chat, link } if *chat == before[0] && *link == links[0].id))
    );
    let asked = calls.iter().find_map(|call| match call {
        SidebarCall::AskChat { chat, body, .. } if *chat == before[0] => Some(body.clone()),
        _ => None,
    });
    assert!(asked.is_some_and(|body| body.starts_with("Rebase on main\n\nDestination: “")));
    assert!(sidebar.read_with(cx, |s, _| s.toast_text()).is_some_and(|text| text.starts_with("Link created. Asked")));
    assert!(sidebar.read_with(cx, |s, _| s.linked_ends_of(&before[0]).len()) == 1, "the row now names its Link");
    // A second drop on the same row says "Already linked" and changes nothing.
    drag_to(cx, from, to);
    assert_eq!(sidebar.read_with(cx, |s, _| s.drop_intent_now()), DropIntent::Invalid(LinkProblem::Linked));
    assert!(cx.debug_bounds("drop-hint").is_some());
    cx.simulate_mouse_up(to, MouseButton::Left, Modifiers::none());
    cx.run_until_parked();
    assert_eq!(sidebar.read_with(cx, |s, _| s.link_overlay()), None);
    // Undo takes the Link away.
    sidebar.update(cx, |s, cx| s.undo(cx));
    assert!(sidebar.read_with(cx, |s, _| s.links().is_empty()));
    assert!(
        sidebar.read_with(cx, |s, _| s.calls()).iter().any(|call| matches!(call, SidebarCall::RemoveLink { id } if *id == links[0].id))
    );
}

#[gpui::test]
fn dragging_a_row_onto_the_chat_opens_it_beside_and_escape_calls_a_drag_off(cx: &mut TestAppContext) {
    let (workspace, sidebar, cx) = mount(cx);
    let grid = workspace.read_with(cx, |w, _| w.grid.clone());
    let moved = key(&sidebar, cx, 3);
    let from = at(cx, 3, 0.5);
    // The right part of the Chat column, left of the side panel.
    let panel = workspace.read_with(cx, |w, cx| {
        let panel = w.panel.read(cx);
        if panel.is_open() && !panel.is_expanded() { panel.width() } else { 0.0 }
    });
    let size = cx.update(|window, _| window.viewport_size());
    let right = point(size.width - px(panel + 60.0), size.height / 2.0);
    // Escape first: nothing lands.
    drag_to(cx, from, right);
    assert!(sidebar.read_with(cx, |s, _| s.dragging().is_some()));
    assert!(cx.debug_bounds("grid-drop").is_some(), "the drop overlay shows where it would land");
    cx.simulate_keystrokes("escape");
    cx.run_until_parked();
    assert!(sidebar.read_with(cx, |s, _| s.dragging().is_none()));
    assert!(cx.debug_bounds("grid-drop").is_none());
    cx.simulate_mouse_up(right, MouseButton::Left, Modifiers::none());
    cx.run_until_parked();
    assert!(grid.read_with(cx, |g, _| g.split_keys().is_empty()), "the cancelled drag dropped nothing");
    // Then the drop: the split opens with the dragged Chat after the open one.
    drag(cx, from, right);
    let split = grid.read_with(cx, |g, _| g.split_keys().to_vec());
    assert_eq!(split.len(), 2, "the open Chat and the dropped one: {split:?}");
    assert_eq!(split[1], moved);
}

#[gpui::test]
fn the_keyboard_drag_moves_a_pin_and_announces_each_step(cx: &mut TestAppContext) {
    let (_, sidebar, cx) = mount(cx);
    let before = pins(&sidebar, cx);
    let handle = sidebar.read_with(cx, |s, _| s.focus_handle().clone());
    cx.update(|window, cx| window.focus(&handle, cx));
    let first = row(cx, 0).center();
    cx.simulate_click(first, Modifiers::none());
    cx.simulate_keystrokes("space");
    let label = sidebar.read_with(cx, |s, _| s.row(0).unwrap().title.to_string());
    assert_eq!(
        sidebar.read_with(cx, |s, _| s.drag_announcement().to_string()),
        format!("Picked up {label}. Arrow keys move it, Space drops it, Escape cancels.")
    );
    // Before the other pin, on it (a Link), after it.
    cx.simulate_keystrokes("down");
    assert_eq!(sidebar.read_with(cx, |s, _| s.drag_announcement().to_string()), "Pinned, position 1 of 2");
    cx.simulate_keystrokes("down");
    let other = sidebar.read_with(cx, |s, _| s.row(1).unwrap().title.to_string());
    assert_eq!(sidebar.read_with(cx, |s, _| s.drag_announcement().to_string()), format!("On {other}: create Link"));
    cx.simulate_keystrokes("down");
    assert_eq!(sidebar.read_with(cx, |s, _| s.drag_announcement().to_string()), "Pinned, position 2 of 2");
    cx.simulate_keystrokes("down");
    assert_eq!(sidebar.read_with(cx, |s, _| s.drop_target().map(|t| t.zone)), Some(DropZone::After), "the last place holds");
    cx.simulate_keystrokes("space");
    assert_eq!(sidebar.read_with(cx, |s, _| s.drag_announcement().to_string()), "Dropped. Pinned, position 2 of 2");
    assert_eq!(pins(&sidebar, cx), vec![before[1].clone(), before[0].clone()]);
    // Picked up again and Escape: nothing moves.
    let moved = sidebar.read_with(cx, |s, _| s.selected());
    assert_eq!(moved, Some(1), "the selection follows the moved row");
    cx.simulate_keystrokes("space up escape");
    assert_eq!(sidebar.read_with(cx, |s, _| s.drag_announcement().to_string()), "Cancelled");
    assert_eq!(pins(&sidebar, cx), vec![before[1].clone(), before[0].clone()]);
}

#[gpui::test]
fn link_with_lists_other_chats_and_remove_link_with_takes_one_away_with_undo(cx: &mut TestAppContext) {
    let (_, sidebar, cx) = mount(cx);
    let source = key(&sidebar, cx, 0);
    let top = row(cx, 0).origin.y;
    cx.update(|window, cx| sidebar.update(cx, |s, cx| s.pick_link(&source, PickerMode::Link, top, window, cx)));
    cx.run_until_parked();
    assert_eq!(sidebar.read_with(cx, |s, _| s.link_overlay()), Some("link"));
    assert!(cx.debug_bounds("link-picker").is_some());
    let picker = sidebar.read_with(cx, |s, _| s.link_picker().expect("open"));
    let all = picker.read_with(cx, |p, cx| p.shown(cx));
    assert!(!all.is_empty() && all.iter().all(|entry| entry.key != source), "every other Chat with a Worktree");
    // Typing filters by every word; Down moves the highlight; Return picks it and the Create Link popover opens.
    let wanted = all[1].clone();
    let word = wanted.title.split_whitespace().next().unwrap().to_lowercase();
    cx.update(|window, cx| picker.update(cx, |p, cx| p.set_query(&word, window, cx)));
    let shown = picker.read_with(cx, |p, cx| p.shown(cx));
    assert!(shown.len() < all.len() && shown.iter().any(|entry| entry.key == wanted.key));
    let target = picker.read_with(cx, |p, cx| p.active_key(cx)).expect("a highlighted entry");
    picker.update(cx, |p, cx| p.pick_active(cx));
    cx.run_until_parked();
    assert_eq!(sidebar.read_with(cx, |s, _| s.link_overlay()), Some("ask"));
    let popover = sidebar.read_with(cx, |s, _| s.link_popover().unwrap());
    assert_eq!(popover.read_with(cx, |p, _| p.ask().target.key.clone()), target);
    // The whole Projects, when the two are in different ones.
    let projects = popover.read_with(cx, |p, _| p.ask().projects);
    if projects {
        popover.update(cx, |p, cx| p.set_scope(LinkScope::Projects, cx));
    }
    popover.update(cx, |p, cx| p.confirm(cx));
    cx.run_until_parked();
    let link = sidebar.read_with(cx, |s, _| s.links()[0].clone());
    assert_eq!(link.a.worktree_path.is_none(), projects, "a Projects Link joins whole Projects");
    // Remove Link with…: the Chat's one Link; picking it removes it, Undo brings the same one back.
    cx.update(|window, cx| sidebar.update(cx, |s, cx| s.pick_link(&source, PickerMode::Remove, top, window, cx)));
    let picker = sidebar.read_with(cx, |s, _| s.link_picker().unwrap());
    assert_eq!(picker.read_with(cx, |p, cx| p.shown(cx).len()), 1);
    picker.update(cx, |p, cx| p.pick(&link.id, cx));
    cx.run_until_parked();
    assert!(sidebar.read_with(cx, |s, _| s.links().is_empty()));
    assert_eq!(sidebar.read_with(cx, |s, _| s.toast_text()), Some("Link removed".into()));
    sidebar.update(cx, |s, cx| s.undo(cx));
    assert_eq!(sidebar.read_with(cx, |s, _| s.links().to_vec()), vec![link.clone()]);
    assert!(sidebar.read_with(cx, |s, _| s.calls()).contains(&SidebarCall::RestoreLink { link }));
    // Escape closes a picker.
    cx.update(|window, cx| sidebar.update(cx, |s, cx| s.pick_link(&source, PickerMode::Link, top, window, cx)));
    cx.run_until_parked();
    cx.simulate_keystrokes("escape");
    cx.run_until_parked();
    assert_eq!(sidebar.read_with(cx, |s, _| s.link_overlay()), None);
}

#[gpui::test]
fn the_menus_link_items_open_the_pickers(cx: &mut TestAppContext) {
    let (_, sidebar, cx) = mount(cx);
    let target = key(&sidebar, cx, 1);
    cx.update(|window, cx| {
        sidebar.update(cx, |s, cx| {
            s.open_menu(0, point(px(100.0), px(100.0)), window, cx);
            s.run_menu(super::menu::MenuAction::LinkWith, window, cx);
        })
    });
    cx.run_until_parked();
    assert_eq!(sidebar.read_with(cx, |s, _| s.link_overlay()), Some("link"));
    let picker = sidebar.read_with(cx, |s, _| s.link_picker().unwrap());
    assert!(picker.read_with(cx, |p, cx| p.shown(cx).iter().any(|entry| entry.key == target)));
}

#[gpui::test]
fn the_top_bars_link_projects_opens_the_dialog(cx: &mut TestAppContext) {
    let (_, _, cx) = mount(cx);
    let button = testing::bounds(cx, "bar-link-projects");
    cx.simulate_click(button.center(), Modifiers::none());
    cx.run_until_parked();
    assert!(cx.debug_bounds("link-count").is_some(), "the Link Projects dialog is open");
}

// ---- the Link rules: `shared/chat-links.test.ts` ---------------------------------------------------------------------

fn wt(project: &str, path: &str) -> LinkEnd {
    LinkEnd::worktree(project, path)
}

fn whole(project: &str) -> LinkEnd {
    LinkEnd { project_id: project.into(), worktree_path: None }
}

fn link(id: &str, a: LinkEnd, b: LinkEnd) -> CanvasLink {
    CanvasLink { id: id.into(), a, b }
}

#[test]
fn a_link_reaches_a_worktree_through_it_or_its_whole_project() {
    let links = vec![link("l1", wt("web", "/w/a"), wt("api", "/a/x")), link("l2", whole("web"), whole("docs"))];
    let ends: Vec<(&str, &LinkEnd)> = linked_ends(&links, &wt("web", "/w/a")).into_iter().map(|(l, end)| (l.id.as_str(), end)).collect();
    assert_eq!(ends, vec![("l1", &wt("api", "/a/x")), ("l2", &whole("docs"))]);
    assert_eq!(linked_ends(&links, &wt("web", "/w/b")).len(), 1, "only the Project Link");
    assert!(link_between(&links, &wt("api", "/a/x"), &wt("web", "/w/a")).is_some(), "either way round");
    assert!(link_between(&links, &wt("docs", "/d"), &wt("web", "/w/z")).is_some(), "Project ends cover every Worktree");
    assert!(link_between(&links, &wt("api", "/a/y"), &wt("web", "/w/a")).is_none());
}

#[test]
fn problems_endpoints_labels_and_the_ask_message() {
    let links = vec![link("l1", wt("web", "/w/a"), wt("api", "/a/x"))];
    assert_eq!(link_problem(&links, &wt("web", "/w/a"), &wt("web", "/w/a")), Some(LinkProblem::SameWorktree));
    assert_eq!(link_problem(&links, &wt("web", "/w/a"), &wt("api", "/a/x")), Some(LinkProblem::Linked));
    assert_eq!(link_problem(&links, &wt("web", "/w/b"), &wt("api", "/a/x")), None);
    assert_eq!(LinkProblem::Linked.label(), "Already linked");
    assert!(can_link_projects("web", "api") && !can_link_projects("web", "web"));
    assert_eq!(link_endpoints(&wt("web", "/w/a"), &wt("api", "/a/x"), LinkScope::Projects), (whole("web"), whole("api")));
    assert_eq!(link_endpoints(&wt("web", "/w/a"), &wt("web", "/w/b"), LinkScope::Projects), (wt("web", "/w/a"), wt("web", "/w/b")));
    assert_eq!(linked_end_label(&wt("web", "/w/login-form/"), Some("web"), None), "web / login-form");
    assert_eq!(linked_end_label(&wt("web", "/w/x"), Some("web"), Some("feat/login")), "web / feat/login");
    assert_eq!(linked_end_label(&whole("web"), Some("web"), None), "All of web");
    assert_eq!(linked_end_label(&whole("gone"), None, None), "All of Unavailable Project");
    let target = AskTarget { label: "Login", chat_ref: "/p/api#4", worktree_path: "/a/x", project_name: Some("api"), branch: Some("feat") };
    let (body, prompt) = link_ask_message("  Add the endpoint ", &target);
    assert_eq!(body, "Add the endpoint\n\nDestination: “Login” (api / feat), in a linked Worktree.");
    assert!(prompt.starts_with(&body) && prompt.contains("That Chat is /p/api#4 in the linked Worktree /a/x."));
}

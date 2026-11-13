//! The pill row: the morph's timing, the panels' state and content, in the headless test platform with the real
//! workspace. Geometry and state, not text metrics.

use std::cell::RefCell;
use std::collections::HashSet;
use std::rc::Rc;
use std::time::Duration;

use gpui::{Entity, Modifiers, TestAppContext, VisualTestContext};

use super::bookmark::{FamilyChat, bookmark, family_menu};
use super::data::{AgentStatus, NOW, pills_for};
use super::morph::{self, BOX_MS};
use super::subagents::{line, listing, meta};
use super::tasks::visible_rows;
use super::{Kind, PillEvent, PillRow};
use crate::logic::activity::subchat_states::SubchatKind;
use crate::logic::marks::chat_mark::ChatMark;
use crate::logic::plan::{TaskStatus, task_counts};
use crate::testing;
use crate::workspace::chat::ChatView;
use crate::workspace::chat::fixture::DEFAULT_TITLE;

fn ms(value: f32) -> Duration {
    Duration::from_secs_f32(value / 1000.0)
}

// ---- the morph, at fixed times ----

#[test]
fn the_morph_opens_from_the_pill_and_ends_on_the_panel() {
    let start = morph::frame(true, ms(0.0));
    assert_eq!((start.grown, start.pill_opacity, start.panel_opacity, start.done), (0.0, 1.0, 0.0, false));
    let mid = morph::frame(true, ms(90.0));
    assert!(mid.grown > 0.5 && mid.grown < 1.0, "ease-out is past half at 30%: {}", mid.grown);
    assert!(mid.pill_opacity < 0.15, "the pill face is nearly gone: {}", mid.pill_opacity);
    assert_eq!(morph::frame(true, ms(100.0)).pill_opacity, 0.0, "and gone after 100ms");
    assert!(mid.panel_opacity > 0.0 && mid.panel_opacity < 1.0, "the panel face waits 60ms then fades: {}", mid.panel_opacity);
    let end = morph::frame(true, ms(BOX_MS));
    assert_eq!((end.grown, end.pill_opacity, end.panel_opacity, end.done), (1.0, 0.0, 1.0, true));
    assert_eq!(morph::frame(true, ms(60.0)).panel_opacity, 0.0);
    let times = [0.0, 30.0, 60.0, 120.0, 200.0, 300.0];
    assert!(times.windows(2).all(|w| morph::frame(true, ms(w[0])).grown <= morph::frame(true, ms(w[1])).grown), "grows monotonically");
}

#[test]
fn closing_mirrors_opening() {
    for t in [0.0, 50.0, 150.0, 300.0] {
        let open = morph::frame(true, ms(t));
        let close = morph::frame(false, ms(t));
        assert!((open.grown + close.grown - 1.0).abs() < 1e-6, "at {t}ms");
        assert_eq!((open.pill_opacity, open.panel_opacity), (close.panel_opacity, close.pill_opacity));
    }
    assert_eq!(morph::at_rest(true).grown, 1.0);
    assert!(morph::at_rest(false).done);
}

#[test]
fn the_surface_goes_from_pill_to_panel_with_round_corners_becoming_cards() {
    let (w, h, r) = morph::surface((80.0, 28.0), (380.0, 300.0), 0.0);
    assert_eq!((w, h, r), (80.0, 28.0, 14.0));
    let (w, h, r) = morph::surface((80.0, 28.0), (380.0, 300.0), 1.0);
    assert_eq!((w, h, r), (380.0, 300.0, 10.0));
    let (w, h, _) = morph::surface((80.0, 28.0), (380.0, 300.0), 0.5);
    assert_eq!((w, h), (230.0, 164.0));
}

#[test]
fn the_panel_keeps_clear_of_the_windows_edges() {
    // A narrow window: 380 does not fit 360 - 2 * 12.
    assert_eq!(morph::room((380.0, 520.0), (360.0, 800.0), 700.0).0, 336.0);
    // 70% of a 600px window, then the space above the pill less an edge.
    assert_eq!(morph::room((380.0, 520.0), (1000.0, 600.0), 900.0).1, 420.0);
    assert_eq!(morph::room((380.0, 520.0), (1000.0, 900.0), 300.0).1, 288.0);
    assert_eq!(morph::right_shift(200.0, 380.0), 192.0, "the right edge at 200 pushes a 380 panel off the left: moves right");
    assert_eq!(morph::right_shift(500.0, 380.0), 0.0);
    assert_eq!(morph::left_shift(100.0, 440.0, 500.0), 52.0);
}

// ---- data and logic ----

#[test]
fn the_tree_hides_the_children_of_a_folded_parent() {
    let plan = pills_for("k", DEFAULT_TITLE).plan.unwrap();
    let all = visible_rows(&plan.tasks, &HashSet::new());
    assert_eq!(all.len(), 6);
    assert_eq!((all[1].id.as_str(), all[1].parent, all[1].open, all[1].depth), ("2", true, true, 0));
    assert_eq!(all[3].text, "Adding the timer fallback", "a leaf in progress says what it does now");
    let folded = visible_rows(&plan.tasks, &HashSet::from(["2".to_string()]));
    assert_eq!(folded.len(), 3);
    assert!(!folded[1].open);
    assert_eq!(task_counts(&plan.tasks), (2, 5));
    assert_eq!(plan.tasks[2].status, TaskStatus::Pending);
}

#[test]
fn the_subagent_list_splits_visible_and_archived() {
    let data = pills_for("k", DEFAULT_TITLE);
    let list = listing(&data.subagents, false);
    assert_eq!((list.visible, list.running, list.done, list.archived, list.rows.len()), (4, 2, 2, 1, 4));
    assert_eq!(listing(&data.subagents, true).rows.len(), 1);
    assert_eq!(line(&data.subagents[0]), "Reading the Dawn intro's transition code.");
    assert_eq!(line(&data.subagents[2]), "The onboarding check passes on Linux.", "a finished one says how it ended");
    assert_eq!(line(&data.subagents[3]), "The Windows runner is offline.");
    assert_eq!(meta(&data.subagents[1]), "1 of 3 \u{b7} 4 files read \u{b7} 1 edit");
    assert!(AgentStatus::Running.active() && AgentStatus::Failed.finished() && !AgentStatus::Waiting.finished());
}

#[test]
fn other_chats_get_some_of_the_pills_chosen_from_their_key() {
    let a = pills_for("milagre#1", "Something else");
    let b = pills_for("milagre#2", "Something else");
    assert_eq!(pills_for("milagre#1", "Something else").ports, a.ports, "deterministic");
    let shapes: HashSet<_> = (0..8)
        .map(|n| {
            let d = pills_for(&format!("milagre#{n}"), "Other");
            (d.plan.is_some(), d.ports.len(), d.pr_action.is_some(), d.review_comments, d.subagents.len())
        })
        .collect();
    assert!(shapes.len() > 1, "keys give different rows");
    let _ = b;
    assert_eq!(pills_for("x", DEFAULT_TITLE).now, NOW);
}

// ---- in the window ----

type Log = Rc<RefCell<Vec<PillEvent>>>;

fn mount(cx: &mut TestAppContext) -> (Entity<PillRow>, Entity<ChatView>, Log, &mut VisualTestContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let chat = workspace.read_with(cx, |w, _| w.chat.clone());
    let pills = chat.read_with(cx, |c, _| c.pills.clone());
    let log: Log = Rc::default();
    let sink = log.clone();
    cx.update(|_, cx| {
        cx.subscribe(&pills, move |_, event: &PillEvent, _| sink.borrow_mut().push(event.clone())).detach();
    });
    (pills, chat, log, cx)
}

fn click(cx: &mut VisualTestContext, selector: &'static str) {
    let bounds = cx.debug_bounds(selector).unwrap_or_else(|| panic!("{selector} drawn"));
    cx.simulate_click(bounds.center(), Modifiers::none());
}

#[gpui::test]
fn the_default_chat_shows_every_pill_in_the_composers_column(cx: &mut TestAppContext) {
    let (_, _, _, cx) = mount(cx);
    let composer = cx.debug_bounds("composer").expect("composer");
    let action = cx.debug_bounds("pill-pr-action").expect("PR action pill");
    let review = cx.debug_bounds("pill-review").expect("review comments pill");
    let subagents = cx.debug_bounds("slot-pill-subagents").expect("Subagents pill");
    assert_eq!(action.origin.x, composer.origin.x, "the PR action at the row's left edge");
    assert!(review.origin.x > action.right(), "the review pill follows it");
    assert_eq!(subagents.right(), composer.right(), "the last right-hand pill at its right edge");
    assert!(
        cx.debug_bounds("slot-pill-ports").is_none() && cx.debug_bounds("slot-pill-subchats").is_none(),
        "Ports and Subchats live in the Details panel"
    );
    let order: Vec<f32> =
        ["slot-pill-tasks", "slot-pill-subagents"].iter().map(|s| f32::from(cx.debug_bounds(s).unwrap().origin.x)).collect();
    assert!(order.windows(2).all(|w| w[0] < w[1]), "Tasks, Subagents left to right: {order:?}");
    for id in ["slot-pill-tasks", "slot-pill-subagents", "pill-pr-action", "pill-review"] {
        assert_eq!(cx.debug_bounds(id).unwrap().size.height, crate::theme::CONTROL_SM);
    }
    // A pill hugs its content: the Tasks pill is its icon, its count and the padding, nothing more.
    let tasks = cx.debug_bounds("pill-tasks-button").unwrap();
    assert_eq!(cx.debug_bounds("slot-pill-tasks").unwrap().size.width, tasks.size.width, "the slot is the pill");
    assert!(tasks.size.width < gpui::px(70.0), "{:?}", tasks.size);
    assert!(cx.debug_bounds("pill-jump").is_none(), "pinned to the bottom: no Go to bottom");
}

#[gpui::test]
fn a_pill_opens_its_panel_and_escape_closes_it(cx: &mut TestAppContext) {
    let (pills, _, log, cx) = mount(cx);
    click(cx, "pill-tasks-button");
    assert_eq!(pills.read_with(cx, |p, _| p.open_kind()), Some(Kind::Tasks));
    let surface = cx.debug_bounds("panel-tasks-surface").expect("the surface");
    assert_eq!(surface.size.width, gpui::px(380.0));
    assert!(surface.size.height <= gpui::px(520.0) && surface.size.height > gpui::px(100.0), "{:?}", surface.size);
    assert!(cx.debug_bounds("panel-tasks").is_some());
    let pill = cx.debug_bounds("slot-pill-tasks").unwrap();
    assert_eq!(surface.bottom(), pill.bottom(), "the surface hangs from the pill's bottom");
    assert_eq!(surface.right(), pill.right(), "and from its right corner");
    cx.simulate_keystrokes("escape");
    assert_eq!(pills.read_with(cx, |p, _| p.open_kind()), None);
    assert!(cx.debug_bounds("panel-tasks").is_none());
    assert!(log.borrow().contains(&PillEvent::Closed));
}

#[gpui::test]
fn a_press_outside_closes_the_panel_and_another_pill_replaces_it(cx: &mut TestAppContext) {
    let (pills, _, _, cx) = mount(cx);
    click(cx, "pill-tasks-button");
    assert_eq!(pills.read_with(cx, |p, _| p.open_kind()), Some(Kind::Tasks));
    let outside = cx.debug_bounds("composer").expect("composer");
    cx.simulate_click(outside.center(), Modifiers::none());
    assert_eq!(pills.read_with(cx, |p, _| p.open_kind()), None);
    click(cx, "pill-tasks-button");
    click(cx, "pill-subagents-button");
    assert_eq!(pills.read_with(cx, |p, _| p.open_kind()), Some(Kind::Subagents), "one panel at a time");
    assert!(cx.debug_bounds("panel-tasks").is_none());
}

#[gpui::test]
fn the_tasks_panel_folds_a_parent_and_draws_the_phase_graph(cx: &mut TestAppContext) {
    let (pills, _, _, cx) = mount(cx);
    click(cx, "pill-tasks-button");
    assert!(cx.debug_bounds("task-row-2.3").is_some());
    assert!(cx.debug_bounds("phase-graph").is_some(), "the graph is under the tree");
    let plot = cx.debug_bounds("phase-plot").unwrap();
    assert_eq!(plot.size.width, gpui::px(super::phase::plot_width(380.0)));
    assert_eq!(plot.size.height, gpui::px(super::phase::HEIGHT + 18.0));
    let build = cx.debug_bounds("phase-legend-build").unwrap();
    let start = cx.debug_bounds("phase-legend-start").unwrap();
    assert_eq!(start.origin.y - build.origin.y, gpui::px(2.0 * super::phase::ROW), "rows sit 21px apart, start at the bottom");
    click(cx, "task-fold-2");
    assert!(pills.read_with(cx, |p, _| p.folded().contains("2")));
    assert!(cx.debug_bounds("task-row-2.3").is_none());
    click(cx, "task-fold-2");
    assert!(cx.debug_bounds("task-row-2.3").is_some());
}

#[gpui::test]
fn the_subagents_panel_opens_a_detail_and_archives_finished_ones(cx: &mut TestAppContext) {
    let (pills, _, _, cx) = mount(cx);
    click(cx, "pill-subagents-button");
    assert!(cx.debug_bounds("subagent-row-a1").is_some());
    click(cx, "subagent-open-a2");
    assert_eq!(pills.read_with(cx, |p, _| p.selected_agent().map(str::to_string)), Some("a2".into()));
    assert!(cx.debug_bounds("subagent-plan").is_some(), "an agent with a plan shows it");
    let wide = cx.debug_bounds("panel-subagents-surface").unwrap();
    assert_eq!(wide.size.width, gpui::px(440.0), "the detail is 440 wide");
    click(cx, "subagent-back");
    assert!(cx.debug_bounds("subagent-row-a3").is_some());
    click(cx, "subagent-open-a1");
    assert!(cx.debug_bounds("subagent-now").is_some(), "no plan: what it does now");
    assert!(cx.debug_bounds("subagent-log-toggle").is_some());
    click(cx, "subagent-back");
    click(cx, "subagent-archive-finished");
    let (visible, archived) = pills.read_with(cx, |p, _| {
        let l = listing(&p.data().subagents, false);
        (l.visible, l.archived)
    });
    assert_eq!((visible, archived), (2, 3));
    assert!(cx.debug_bounds("subagent-row-a3").is_none());
}

#[gpui::test]
fn go_to_bottom_shows_once_the_reader_is_away_and_scrolls_back(cx: &mut TestAppContext) {
    let (pills, chat, log, cx) = mount(cx);
    let transcript = chat.read_with(cx, |c, _| c.transcript.clone());
    transcript.update(cx, |t, cx| {
        t.list_state().scroll_to(gpui::ListOffset { item_ix: 800, offset_in_item: gpui::px(0.0) });
        cx.notify();
    });
    chat.update(cx, |_, cx| cx.notify());
    cx.run_until_parked();
    assert!(pills.read_with(cx, |p, _| p.jump_shown()));
    click(cx, "pill-jump");
    assert!(log.borrow().contains(&PillEvent::JumpToBottom));
    cx.run_until_parked();
    let top = transcript.read_with(cx, |t, _| t.list_state().logical_scroll_top().item_ix);
    assert!(top > 1900, "back at the end (top item {top})");
}

#[gpui::test]
fn switching_chats_changes_the_row(cx: &mut TestAppContext) {
    let (pills, _, _, cx) = mount(cx);
    let before = pills.read_with(cx, |p, _| (p.is_shown(Kind::Tasks), p.data().review_comments));
    pills.update(cx, |p, cx| p.set_chat("milagre#999", "Another chat", cx));
    let after = pills.read_with(cx, |p, _| (p.is_shown(Kind::Tasks), p.data().review_comments));
    assert_ne!(before, after);
    assert_eq!(pills.read_with(cx, |p, _| p.open_kind()), None);
}

// ---- C-06 ----

fn chat(id: u64, title: &str, parent: Option<u64>, mark: ChatMark, kind: SubchatKind) -> FamilyChat {
    FamilyChat {
        key: format!("milagre#{id}"),
        title: title.into(),
        parent: parent.map(|p| format!("milagre#{p}")),
        archived: false,
        done: false,
        kind,
        mark,
        background: 0,
    }
}

fn family() -> Vec<FamilyChat> {
    vec![
        chat(1, "Top", None, ChatMark::Idle, SubchatKind::Done),
        chat(2, "Middle", Some(1), ChatMark::Question, SubchatKind::NeedsYou),
        chat(3, "Leaf", Some(2), ChatMark::Running, SubchatKind::Working),
        chat(4, "Sibling", Some(2), ChatMark::Idle, SubchatKind::Done),
    ]
}

#[test]
fn the_bookmark_names_the_nearest_parent_and_counts_what_it_hides() {
    let chats = family();
    assert!(bookmark(&chats, "milagre#1").is_none(), "a top-level Chat has none");
    let b = bookmark(&chats, "milagre#3").unwrap();
    assert_eq!((b.parent.title.as_str(), b.above, b.title.as_str(), b.needs_you), ("Middle", 1, "Leaf", true));
    let b = bookmark(&chats, "milagre#2").unwrap();
    assert_eq!((b.parent.title.as_str(), b.above, b.needs_you), ("Top", 0, false));
}

#[test]
fn the_family_menu_lists_the_chats_above_then_the_family() {
    let menu = family_menu(&family(), "milagre#3").unwrap();
    assert_eq!(
        menu.ancestors.iter().map(|e| (e.title.as_str(), e.role)).collect::<Vec<_>>(),
        vec![("Top", Some("Top Chat")), ("Middle", Some("Parent"))]
    );
    assert_eq!(menu.ancestors[0].word, "Idle", "a finished turn above is idle, not done");
    assert_eq!(menu.ancestors[1].word, "Needs you");
    assert_eq!(menu.subchats.iter().map(|e| e.title.as_str()).collect::<Vec<_>>(), vec!["Leaf", "Sibling"]);
    assert_eq!(menu.subchats[1].word, "Done");
    assert_eq!(menu.size, 4);
    assert!(family_menu(&[chat(9, "Alone", None, ChatMark::Idle, SubchatKind::Done)], "milagre#9").is_none());
}

#[gpui::test]
fn a_subchat_shows_its_bookmark_and_the_family_menu_opens_it(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let chat = workspace.read_with(cx, |w, _| w.chat.clone());
    let title_x = cx.debug_bounds("chat-identity-title").expect("the open top-level Chat's title").origin.x;
    // The fixture's Subchat of a Subchat, "Sidebar snapshot check", has no sidebar row: the Details panel opens it.
    let key = workspace
        .read_with(cx, |w, cx| w.sidebar.read(cx).family_chats())
        .into_iter()
        .find(|chat| chat.title == "Sidebar snapshot check")
        .expect("the data has it")
        .key;
    cx.update(|_, cx| workspace.update(cx, |w, cx| w.open_chat_key(&key, cx)));
    cx.run_until_parked();
    let b = chat.read_with(cx, |c, _| c.bookmark().cloned()).expect("a Subchat has a bookmark");
    assert_eq!(b.parent.title, "Port the sidebar to GPUI");
    assert_eq!(b.above, 1, "the top Chat collapses into the dots");
    assert!(cx.debug_bounds("bookmark-more").is_some() && cx.debug_bounds("bookmark-parent").is_some());
    assert!(cx.debug_bounds("chat-identity-title").is_none(), "the bookmark replaces the identity");
    click(cx, "bookmark-current");
    assert!(chat.read_with(cx, |c, _| c.family_menu_open()));
    assert!(cx.debug_bounds("family-menu").is_some());
    assert!(cx.debug_bounds("family-beside").is_none() && cx.debug_bounds("family-all").is_none(), "the split entries are gone");
    // Picking the parent opens it alone: the sidebar selection follows.
    click(cx, "bookmark-parent");
    let title = chat.read_with(cx, |c, _| c.title().to_string());
    assert_eq!(title, "Port the sidebar to GPUI");
    assert!(chat.read_with(cx, |c, _| c.bookmark().is_some()), "it is a Subchat of the top Chat itself");
    // No back button: with nothing collapsed above it, the parent's title starts where a top-level title does.
    assert!(cx.debug_bounds("bookmark-more").is_none());
    let parent = cx.debug_bounds("bookmark-parent").expect("the parent crumb");
    assert_eq!(parent.origin.x, title_x, "the parent crumb is flush with a Chat title");
}

#[gpui::test]
fn a_top_level_chat_shows_its_title_then_its_project(cx: &mut TestAppContext) {
    let (_, cx) = testing::mount_workspace(cx);
    let title = cx.debug_bounds("chat-identity-title").expect("title");
    let project = cx.debug_bounds("chat-identity-project").expect("project");
    assert!(project.origin.x > title.right(), "the Project follows the title");
}

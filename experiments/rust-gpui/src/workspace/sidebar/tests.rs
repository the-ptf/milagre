//! Sidebar tests in GPUI's headless test platform, and the list rules on the fixture's data.

use std::sync::Arc;

use gpui::{Modifiers, TestAppContext, px};

use super::list::{ListFilters, SidebarData, chat_lists_with};
use super::{ChatRow, RowState, Sidebar};
use crate::data::fixture::{DONE_CHATS, LISTED_ROWS};
use crate::data::{FixtureSource, now};
use crate::logic::lists::order::ChatOrder;
use crate::logic::marks::ChatMark;
use crate::testing;

fn mount(cx: &mut TestAppContext) -> (gpui::Entity<Sidebar>, &mut gpui::VisualTestContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let sidebar = workspace.read_with(cx, |workspace, _| workspace.sidebar.clone());
    (sidebar, cx)
}

fn fixture_data() -> SidebarData {
    now(SidebarData::load(Arc::new(FixtureSource::new()))).expect("the fixture answers")
}

fn rows() -> Vec<ChatRow> {
    let data = fixture_data();
    let lists = chat_lists_with(&data, ChatOrder::Created, &ListFilters::default());
    lists.pinned.iter().chain(&lists.rows).map(|shown| ChatRow::new(shown, &data)).collect()
}

/// The row the window opens on: the Chat the Chat column shows.
const OPEN_ROW: usize = 3;

#[gpui::test]
fn the_chat_on_screen_is_selected_and_clicking_row_three_selects_it(cx: &mut TestAppContext) {
    let (sidebar, cx) = mount(cx);
    let selected = sidebar.read_with(cx, |s, _| s.selected().and_then(|ix| s.row(ix).map(|row| (ix, row.title.clone()))));
    assert_eq!(selected, Some((OPEN_ROW, "Fix Linux onboarding intro hang".into())));
    let row = cx.debug_bounds("chat-row-3").expect("row 3 is drawn");
    cx.simulate_click(row.center(), Modifiers::none());
    assert_eq!(sidebar.read_with(cx, |s, _| s.selected()), Some(3));
}

#[gpui::test]
fn the_list_holds_500_rows_but_builds_only_the_visible_ones(cx: &mut TestAppContext) {
    let (sidebar, cx) = mount(cx);
    let (count, built, visible) = sidebar.read_with(cx, |s, _| (s.row_count(), s.rows_built(), s.visible_range()));
    assert_eq!(LISTED_ROWS, 500);
    assert_eq!(count, LISTED_ROWS - 3, "the fixture's three Subchats are not listed");
    assert!(built > 0 && built < 40, "built {built} rows for the first frames, of 500");
    assert!(visible.end < 40, "visible range {visible:?}");
    assert!(cx.debug_bounds("chat-row-0").is_some());
    assert!(cx.debug_bounds("chat-row-300").is_none(), "row 300 is far outside the viewport and not built");
}

#[gpui::test]
fn pinned_rows_lead_the_list_with_no_heading_and_each_shows_a_pin(cx: &mut TestAppContext) {
    let (sidebar, cx) = mount(cx);
    assert_eq!(sidebar.read_with(cx, |s, _| s.pinned_count()), 2);
    let pinned = cx.debug_bounds("sidebar-pinned").expect("the Pinned rows are drawn");
    let first_listed = cx.debug_bounds("chat-row-2").expect("the first unpinned row");
    assert!(cx.debug_bounds("section-label").is_none(), "no All Chats heading");
    assert_eq!(first_listed.top() - pinned.bottom(), px(super::row::ROW_GAP / 2.0), "rows 2px apart across the pinned rows' end");
    assert_eq!(cx.debug_bounds("chat-row-1").unwrap().size.height, px(54.0));
    assert!(cx.debug_bounds("chat-pinned").is_some(), "a pinned row shows the pin icon before its title");
}

#[gpui::test]
fn arrow_keys_move_the_selection_across_pinned_rows_and_scroll_it_into_view(cx: &mut TestAppContext) {
    let (sidebar, cx) = mount(cx);
    let handle = sidebar.read_with(cx, |s, _| s.focus_handle().clone());
    cx.update(|window, cx| window.focus(&handle, cx));
    cx.simulate_keystrokes("down");
    assert_eq!(sidebar.read_with(cx, |s, _| s.selected()), Some(OPEN_ROW + 1));
    for _ in 0..=OPEN_ROW + 1 {
        cx.simulate_keystrokes("up");
    }
    assert_eq!(sidebar.read_with(cx, |s, _| s.selected()), Some(0), "up through the list into the pinned rows, stopping at the first");

    for _ in 0..60 {
        cx.simulate_keystrokes("down");
    }
    assert_eq!(sidebar.read_with(cx, |s, _| s.selected()), Some(60));
    let row = cx.debug_bounds("chat-row-60").expect("the selected row was scrolled into view");
    let bottom = cx.update(|window, _| window.viewport_size().height);
    assert!(row.bottom() <= bottom && row.top() >= px(0.0), "row 60 at {row:?} inside the window");
    // Every frame rebuilds only the visible rows (about 19 here), never the 500.
    let (built, visible) = sidebar.read_with(cx, |s, _| (s.rows_built(), s.visible_range()));
    assert!(visible.len() < 40, "last frame built {visible:?}");
    assert!(built < 70 * 40, "built {built} rows over the key presses");
}

#[gpui::test]
fn the_bottom_group_is_pinned_under_the_list(cx: &mut TestAppContext) {
    let (sidebar, cx) = mount(cx);
    assert_eq!(sidebar.read_with(cx, |s, _| s.done_count()), DONE_CHATS);
    let done = cx.debug_bounds("sidebar-done").expect("Done row is drawn");
    let usage = cx.debug_bounds("sidebar-usage").expect("usage block is drawn");
    let footer = cx.debug_bounds("sidebar-footer").expect("footer is drawn");
    let window = cx.update(|window, _| window.viewport_size());
    assert_eq!(done.size.height, px(36.0));
    assert_eq!(usage.size.height, px(116.0), "8 + 3 x 32 + 2 x 2 + 8: Kiro has no numbers and is left out");
    assert_eq!(footer.size.height, px(44.0));
    assert!(done.bottom() <= usage.top(), "Done above usage");
    assert!(usage.bottom() <= footer.top(), "usage above footer");
    assert_eq!(footer.bottom(), window.height, "footer bottom is the window bottom");
}

#[gpui::test]
fn header_buttons_sit_at_their_x_positions(cx: &mut TestAppContext) {
    let (_sidebar, cx) = mount(cx);
    // The toggle and Search moved to the window's bar (`workspace/shell/tests.rs` places them).
    let b = cx.debug_bounds("new-chat").expect("new-chat is drawn");
    assert_eq!(b.origin.x + px(4.0), px(272.0), "new-chat glyph left edge");
    assert_eq!(b.size.width, px(24.0));
}

#[gpui::test]
fn usage_rows_are_32px_with_meters(cx: &mut TestAppContext) {
    let (_sidebar, cx) = mount(cx);
    for name in ["usage-row-Claude", "usage-row-Codex", "usage-row-Antigravity"] {
        let row = cx.debug_bounds(name).expect("usage row is drawn");
        assert_eq!(row.size.height, px(32.0), "{name} height");
    }
    assert!(cx.debug_bounds("usage-row-Kiro").is_none(), "no numbers, no row");
    assert!(cx.debug_bounds("usage-meter-Claude-0").is_some() && cx.debug_bounds("usage-meter-Claude-1").is_some());
    assert!(cx.debug_bounds("usage-meter-Codex-0").is_some() && cx.debug_bounds("usage-meter-Codex-1").is_none());
    let a = cx.debug_bounds("usage-track-Claude-0").unwrap();
    let b = cx.debug_bounds("usage-track-Claude-1").unwrap();
    assert_eq!(a.size.width, b.size.width, "two columns share the meters' width");
    assert_eq!(b.origin.x - a.origin.x, a.size.width + px(8.0), "columns 8px apart");
    assert_eq!(a.size.height, px(2.0));
    let label = cx.debug_bounds("usage-meter-Claude-0").unwrap();
    assert!(label.size.width <= a.size.width, "the bar is the column's width, under the label");
    let track = cx.debug_bounds("usage-track-Codex-0").unwrap();
    let fill = cx.debug_bounds("usage-fill-Codex-0").expect("Codex fill is drawn");
    assert_eq!(track.size.width, a.size.width * 2.0 + px(8.0), "one window spans both columns");
    assert!((fill.size.width - track.size.width * 0.86).abs() <= px(1.0), "fill is 86% of the track");
    assert!(cx.debug_bounds("usage-fill-Antigravity-0").is_none(), "no fill at 0%");
    assert!(cx.debug_bounds("usage-fill-Antigravity-1").is_some());
}

/// Rows are cached views: a sidebar re-render reuses them, and a selection change renders only the two
/// rows it touches. (A focus change or a mouse/keyboard switch still refreshes every view: GPUI.)
#[gpui::test]
fn a_sidebar_re_render_reuses_its_rows(cx: &mut TestAppContext) {
    let (sidebar, cx) = mount(cx);
    cx.run_until_parked();
    let alive = sidebar.read_with(cx, |s, _| s.row_views_alive());
    assert!(alive > 0 && alive < 100, "views exist only near the viewport: {alive} of {LISTED_ROWS}");

    let before = sidebar.read_with(cx, |s, _| s.rows_built());
    sidebar.update(cx, |_, cx| cx.notify());
    cx.run_until_parked();
    assert_eq!(sidebar.read_with(cx, |s, _| s.rows_built()), before, "re-rendering the sidebar rebuilt no row");

    // Focus first, so the selection below is not also a focus change (which refreshes the window).
    let handle = sidebar.read_with(cx, |s, _| s.focus_handle().clone());
    cx.update(|window, cx| window.focus(&handle, cx));
    // And one key the sidebar ignores, to make the mouse-to-keyboard switch (another refresh) first.
    cx.simulate_keystrokes("x");
    cx.run_until_parked();
    let before = sidebar.read_with(cx, |s, _| s.rows_built());
    cx.simulate_keystrokes("down");
    let after = sidebar.read_with(cx, |s, _| s.rows_built());
    assert_eq!(sidebar.read_with(cx, |s, _| s.selected()), Some(OPEN_ROW + 1));
    assert_eq!(after - before, 2, "moving the selection renders the old and the new row only");
}

#[gpui::test]
fn subchats_are_not_listed_and_no_row_has_a_family_badge_or_indent(cx: &mut TestAppContext) {
    let (sidebar, cx) = mount(cx);
    let titles: Vec<String> = (0..sidebar.read_with(cx, |s, _| s.row_count()))
        .map(|ix| sidebar.read_with(cx, |s, _| s.row(ix).unwrap().title.to_string()))
        .collect();
    for subchat in ["Align the data layer with the app", "Port the sidebar to GPUI", "Sidebar snapshot check"] {
        assert!(!titles.iter().any(|title| title == subchat), "{subchat} lives in the Details panel");
    }
    for id in ["chat-family-2", "chat-family-3"] {
        assert!(cx.debug_bounds(id).is_none(), "{id}: no count badge");
    }
    let (first, second) = (cx.debug_bounds("chat-row-2").unwrap(), cx.debug_bounds("chat-row-3").unwrap());
    assert_eq!(first.left(), second.left(), "no Subchat indent");
    // A Subchat opens by key even without a row, and nothing in the list is selected then.
    let (workspace, cx) = crate::testing::mount_workspace(cx);
    let sidebar = workspace.read_with(cx, |w, _| w.sidebar.clone());
    let subchat = sidebar
        .read_with(cx, |s, _| s.family_chats())
        .into_iter()
        .find(|chat| chat.title == "Port the sidebar to GPUI")
        .expect("the data has it")
        .key;
    cx.update(|_, cx| workspace.update(cx, |w, cx| w.open_chat_key(&subchat, cx)));
    cx.run_until_parked();
    assert_eq!(sidebar.read_with(cx, |s, _| s.selected()), None);
    assert_eq!(sidebar.read_with(cx, |s, _| s.selected_row().map(|row| row.key.to_string())), Some(subchat.clone()));
    let chat = workspace.read_with(cx, |w, _| w.chat.clone());
    assert_eq!(chat.read_with(cx, |c, _| c.key().map(str::to_owned)), Some(subchat), "the Chat column shows it");
}

/// The rows the sidebar builds from the fixture's domain data through the shared rules: the first screen.
#[test]
fn rows_come_from_the_domain_data_through_the_list_and_mark_rules() {
    let rows = rows();
    let shown: Vec<(&str, &str, &str, ChatMark)> =
        rows.iter().take(13).map(|row| (row.initial.as_ref(), row.title.as_ref(), row.detail.as_ref(), row.mark)).collect();
    use ChatMark::*;
    assert_eq!(
        shown,
        [
            // Pinned, in pin order.
            ("M", "Release train v0.233", "milagre-ade · #1022 · Victor XPro", Waiting),
            ("M", "Relay Durable Object backoff", "milagre-ade · Victor XPro", Background),
            // Top-level Chats only, newest first: Subchats are in the Details panel.
            ("M", "Migrate desktop to Rust PoC", "milagre-ade · Victor XPro", Running),
            ("M", "Fix Linux onboarding intro hang", "milagre-ade · #1020 · +1 · Victor XPro", Waiting),
            ("M", "Fix Windows port listener cleanup", "milagre · tianxu, offline", Unread),
            // Blocked PRs first (`rowPullRequests`): #1015's CI failed.
            ("M", "Codebase analysis and fixes", "milagre-ade · #1015 · +3 · Victor XPro", Running),
            ("M", "Rust terminal owner migration", "milagre-ade · Victor XPro", Idle),
            ("R", "RDCar ops", "rd-car · deer", Question),
            ("R", "Tailscale routes for phone", "rd-car · #557 · +2 · deer", Running),
            ("G", "Gestor RDCar", "Chats · deer", Unread),
            // The two Chats marked Done minutes ago are in the Done list only.
            ("M", "Identify issues to close", "milagre-ade · Victor XPro", Idle),
            ("H", "Nightly dependency check", "happiergym · Victor XPro", Waiting),
            ("M", "Babysit PR #1013", "milagre-ade · #1013 · Victor XPro", Idle),
        ]
    );
    // What each row's edges show (design `gpui-sidebar-v-a`).
    let states: Vec<RowState> = rows.iter().take(13).map(ChatRow::state).collect();
    assert_eq!(
        states,
        [
            RowState::Approval,
            RowState::Working,
            RowState::Working,
            RowState::Approval,
            RowState::Idle { unread: true },
            RowState::Working,
            RowState::Failed,
            RowState::Question,
            RowState::Working,
            RowState::Idle { unread: true },
            RowState::Idle { unread: false },
            RowState::Approval,
            RowState::Idle { unread: false }
        ]
    );
    assert!(rows[6].failed, "an idle Chat whose last turn failed shows the red alert");
    assert_eq!(rows[1].background, 2);
    assert_eq!(rows[0].prs.as_deref(), Some("1022"));
    assert_eq!(rows[5].prs.as_deref(), Some("+4"), "several PRs: how many");
    assert_eq!(rows[8].computer.as_deref(), Some("deer"), "working on another computer");
    assert_eq!(rows[2].computer.as_deref(), Some("Victor XPro"));
    assert_eq!(rows[10].recency.as_deref(), Some("14m"), "an idle row's right edge: when it last moved");
    assert!(rows[9].chats_home && rows[9].project.as_ref() == "Chat", "a Chat without a Project");
    assert!(rows[10].dimmed() && rows[12].dimmed() && !rows[4].dimmed(), "read idle rows are dimmed");
    let offline = rows[4].offline.clone().expect("tianxu is offline");
    assert_eq!(&rows[4].detail[offline], "tianxu, offline");
    assert_eq!(rows[4].computer.as_deref(), Some("tianxu, offline"));
    assert!(rows[4].tile.is_some() && rows[2].tile.is_none(), "milagre has an identity colour, milagre-ade the neutral tile");
    assert!(rows.iter().all(|row| row.title.as_ref() != "Scratch idea 0"), "a hidden Project's Chats are left out");
    assert!(rows.iter().all(|row| !row.title.starts_with("Finished:") && !row.title.starts_with("Archived")), "Done and archived Chats");
}

#[gpui::test]
fn the_pinned_rows_start_right_under_the_header_with_no_destination_rows(cx: &mut TestAppContext) {
    let (_sidebar, cx) = mount(cx);
    let pinned = cx.debug_bounds("sidebar-pinned").expect("the pinned rows");
    assert_eq!(pinned.top(), crate::theme::HEADER_HEIGHT, "Canvas, Routines and Links live only in the top bar");
    for id in ["bar-routines", "bar-link-projects"] {
        assert!(cx.debug_bounds(id).is_some(), "{id} is in the top bar");
    }
}

#[gpui::test]
fn the_done_footer_opens_a_list_and_a_done_row_opens_its_chat(cx: &mut TestAppContext) {
    let (workspace, cx) = crate::testing::mount_workspace(cx);
    let sidebar = workspace.read_with(cx, |w, _| w.sidebar.clone());
    let done = sidebar.read_with(cx, |s, _| s.done_count());
    assert!(done > 1);
    assert!(cx.debug_bounds("done-row-0").is_none(), "folded by default");
    let footer = cx.debug_bounds("sidebar-done").expect("the Done footer").center();
    cx.simulate_click(footer, Modifiers::none());
    assert!(sidebar.read_with(cx, |s, _| s.done_open()));
    let first = cx.debug_bounds("done-row-0").expect("the list is open");
    assert!(cx.debug_bounds("done-row-1").is_some());
    assert!(cx.debug_bounds("done-row-30").is_none(), "the list is virtualized");
    assert!(first.size.height <= px(30.0));
    let key = sidebar.read_with(cx, |s, _| s.done_rows()[0].key.to_string());
    cx.simulate_click(first.center(), Modifiers::none());
    assert_eq!(sidebar.read_with(cx, |s, _| s.selected_row().map(|row| row.key.to_string())), Some(key.clone()));
    assert_eq!(sidebar.read_with(cx, |s, _| s.selected()), None, "no list row is selected");
    cx.run_until_parked();
    let chat = workspace.read_with(cx, |w, _| w.chat.clone());
    assert_eq!(chat.read_with(cx, |c, _| c.key().map(str::to_owned)), Some(key.clone()), "the Chat column shows it");
    // Its menu offers Reopen, and the footer folds the list again.
    let context = sidebar.read_with(cx, |s, _| s.menu_context(&key)).expect("a menu");
    assert!(
        super::menu::entries(&context).iter().any(|entry| matches!(entry, super::menu::MenuEntry::Row(item) if item.label == "Reopen"))
    );
    let footer = cx.debug_bounds("sidebar-done").expect("the Done footer").center();
    cx.simulate_click(footer, Modifiers::none());
    assert!(cx.debug_bounds("done-row-0").is_none());
}

/// Resting on a row swaps its state for "Done" (never "Reopen": that is the Done list's); clicking it moves the Chat
/// to the Done list at once, and ⌘Z takes it back to its place.
#[gpui::test]
fn the_hover_action_moves_the_chat_to_done_and_cmd_z_brings_it_back(cx: &mut TestAppContext) {
    let (sidebar, cx) = mount(cx);
    // Row 10 is idle: its right edge shows when it last moved.
    let ix = 10;
    let key = sidebar.read_with(cx, |s, _| s.row(ix).unwrap().key.to_string());
    let selector: &'static str = "chat-row-state-10";
    assert!(cx.debug_bounds(selector).is_some(), "the state shows while the pointer is away");
    assert!(cx.debug_bounds("chat-row-action-10").is_none());
    let row = cx.debug_bounds("chat-row-10").expect("row 10 is drawn");
    cx.simulate_mouse_move(row.center(), None, Modifiers::none());
    cx.run_until_parked();
    assert!(cx.debug_bounds(selector).is_none(), "the pointer on the row swaps the state for the action");
    let action = cx.debug_bounds("chat-row-action-10").expect("Done shows on hover");
    assert!(action.right() <= row.right() - px(13.0) && action.left() > row.center().x, "at the right edge, inside the padding");
    let selected = sidebar.read_with(cx, |s, _| s.selected());
    let (rows, done) = sidebar.read_with(cx, |s, _| (s.row_count(), s.done_count()));
    cx.simulate_click(action.center(), Modifiers::none());
    assert!(sidebar.read_with(cx, |s, _| s.is_done_key(&key)));
    assert_eq!(sidebar.read_with(cx, |s, _| s.selected()), selected, "the action does not select the row");
    assert_eq!(sidebar.read_with(cx, |s, _| (s.row_count(), s.done_count())), (rows - 1, done + 1), "it moves to Done at once");
    assert_eq!(sidebar.read_with(cx, |s, _| s.done_rows()[0].key.to_string()), key, "at the top of the Done list");
    assert_eq!(sidebar.read_with(cx, |s, _| s.toast_text()), Some("Moved to Done".into()));
    cx.simulate_keystrokes("cmd-z");
    assert!(!sidebar.read_with(cx, |s, _| s.is_done_key(&key)), "⌘Z takes it back");
    assert_eq!(sidebar.read_with(cx, |s, _| s.row(ix).map(|row| row.key.to_string())), Some(key), "to its place");
    assert!((0..rows).all(|ix| sidebar.read_with(cx, |s, _| !s.row(ix).unwrap().done)), "no list row is Done");
}

/// Rows are 54px boxes 2px apart, 14px in, the first 8px under the header.
#[gpui::test]
fn rows_are_54px_two_apart_with_their_content_14px_in(cx: &mut TestAppContext) {
    let (_sidebar, cx) = mount(cx);
    let first = cx.debug_bounds("chat-row-0").expect("row 0");
    let second = cx.debug_bounds("chat-row-1").expect("row 1");
    let third = cx.debug_bounds("chat-row-2").expect("row 2, the list's first");
    let fourth = cx.debug_bounds("chat-row-3").expect("row 3");
    assert_eq!(first.top(), crate::theme::HEADER_HEIGHT + px(8.0));
    assert_eq!(first.size.height, px(54.0));
    for (a, b) in [(first, second), (second, third), (third, fourth)] {
        assert_eq!(b.top() - a.bottom(), px(2.0));
    }
    let prs = cx.debug_bounds("chat-row-prs-0").expect("row 0's PR");
    assert_eq!(first.right() - prs.right(), px(14.0), "the PR ends 14px from the row's edge");
    let state = cx.debug_bounds("chat-row-state-0").expect("row 0's state");
    assert_eq!(first.right() - state.right(), px(14.0));
}

/// Every Done Chat is in the Done section, the ones marked minutes ago too; none stays in the list.
#[test]
fn every_done_chat_is_in_the_done_section_and_none_in_the_list() {
    let data = fixture_data();
    let lists = chat_lists_with(&data, ChatOrder::Created, &ListFilters::default());
    assert_eq!(lists.done.len(), DONE_CHATS);
    assert!(lists.rows.iter().chain(&lists.pinned).all(|row| !row.item.chat.is_done()));
    let first: Vec<_> = lists.done.iter().take(2).map(|row| row.chat.display_title(&[]).to_string()).collect();
    assert_eq!(first, ["Ship the Lighthouse budget", "What's a good name for a CLI?"], "most recently marked first");
}

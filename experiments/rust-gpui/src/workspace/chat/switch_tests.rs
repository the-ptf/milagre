//! Picking another Chat in the sidebar changes the Chat column: title, Project, transcript, running row, draft.

use gpui::{Entity, Modifiers, TestAppContext, VisualTestContext};

use crate::logic::marks::chat_mark::ChatMark;
use crate::testing;
use crate::workspace::Workspace;
use crate::workspace::chat::transcript::Item;

fn click_row(workspace: &Entity<Workspace>, ix: usize, cx: &mut VisualTestContext) {
    let _ = workspace;
    let row = cx.debug_bounds(testing::leak(format!("chat-row-{ix}"))).unwrap_or_else(|| panic!("row {ix} drawn"));
    cx.simulate_click(row.center(), Modifiers::none());
}

/// Two drawn rows, one running and one not, other than the selected one.
fn rows(workspace: &Entity<Workspace>, cx: &mut VisualTestContext) -> (usize, usize, usize) {
    workspace.read_with(cx, |w, cx| {
        let sidebar = w.sidebar.read(cx);
        let selected = sidebar.selected().expect("a row is selected");
        let find = |running: bool| {
            (0..sidebar.row_count().min(12))
                .find(|ix| *ix != selected && (sidebar.row(*ix).unwrap().mark == ChatMark::Running) == running)
                .expect("fixture has both kinds")
        };
        (selected, find(true), find(false))
    })
}

#[gpui::test]
fn switching_changes_title_and_items(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let chat = workspace.read_with(cx, |w, _| w.chat.clone());
    let first_key = chat.read_with(cx, |c, _| c.key().map(str::to_string));
    assert!(first_key.is_some(), "the selected row named the Chat on the first frame");
    let (selected, _, idle) = rows(&workspace, cx);
    assert!(chat.read_with(cx, |c, cx| c.transcript.read(cx).items().len()) >= 2000, "the default Chat keeps the fixture");
    click_row(&workspace, idle, cx);
    let (title, row_title, count, first) = workspace.read_with(cx, |w, cx| {
        let chat = w.chat.read(cx);
        let items = chat.transcript.read(cx).items();
        let first = match &items[0] {
            Item::User(text) => text.to_string(),
            _ => String::new(),
        };
        (chat.title().to_string(), w.sidebar.read(cx).row(idle).unwrap().title.to_string(), items.len(), first)
    });
    assert_eq!(title, row_title);
    assert!(count < 200, "a deterministic short transcript, got {count}");
    assert!(first.contains(&row_title), "first user message names the title: {first}");
    assert_ne!(selected, idle);
    let top = chat.read_with(cx, |c, cx| c.transcript.read(cx).list_state().logical_scroll_top().item_ix);
    assert!(top + 40 > count, "opens at the bottom (top {top} of {count})");
}

#[gpui::test]
fn switching_back_restores_the_draft(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let chat = workspace.read_with(cx, |w, _| w.chat.clone());
    let (selected, _, idle) = rows(&workspace, cx);
    let composer = chat.read_with(cx, |c, _| c.composer.clone());
    cx.update(|window, cx| composer.update(cx, |c, cx| c.set_text("half a thought", window, cx)));
    click_row(&workspace, idle, cx);
    assert_eq!(composer.read_with(cx, |c, _| c.text().to_string()), "", "the other Chat has no draft");
    cx.update(|window, cx| composer.update(cx, |c, cx| c.set_text("other draft", window, cx)));
    click_row(&workspace, selected, cx);
    assert_eq!(composer.read_with(cx, |c, _| c.text().to_string()), "half a thought");
    click_row(&workspace, idle, cx);
    assert_eq!(composer.read_with(cx, |c, _| c.text().to_string()), "other draft");
}

#[gpui::test]
fn the_running_row_follows_the_chat(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let chat = workspace.read_with(cx, |w, _| w.chat.clone());
    let (_, running, idle) = rows(&workspace, cx);
    click_row(&workspace, idle, cx);
    assert!(chat.read_with(cx, |c, _| c.running.is_none()));
    assert!(cx.debug_bounds("running-row").is_none());
    click_row(&workspace, running, cx);
    assert!(chat.read_with(cx, |c, _| c.running.is_some()));
}

#[gpui::test]
fn the_new_chat_button_opens_the_new_chat_composer(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let composer = workspace.read_with(cx, |w, cx| w.chat.read(cx).composer.clone());
    assert!(composer.read_with(cx, |c, _| c.new_chat().is_none()));
    let button = cx.debug_bounds("new-chat").expect("button drawn");
    cx.simulate_click(button.center(), Modifiers::none());
    assert!(composer.read_with(cx, |c, _| c.new_chat().is_some()));
}

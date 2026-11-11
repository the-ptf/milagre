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

fn on_the_empty_screen(workspace: &Entity<Workspace>, cx: &mut VisualTestContext) {
    let (chat, sidebar, panel) = workspace.read_with(cx, |w, _| (w.chat.clone(), w.sidebar.clone(), w.panel.clone()));
    assert!(chat.read_with(cx, |c, _| c.is_new_chat()));
    assert_eq!(chat.read_with(cx, |c, _| c.key().map(str::to_owned)), None);
    assert_eq!(chat.read_with(cx, |c, _| c.title().to_owned()), "New Chat");
    assert!(chat.read_with(cx, |c, cx| c.transcript.read(cx).items().is_empty()), "no transcript");
    assert!(chat.read_with(cx, |c, _| c.running.is_none()));
    assert!(cx.debug_bounds("running-row").is_none() && cx.debug_bounds("composer-pills").is_none());
    assert_eq!(sidebar.read_with(cx, |s, _| s.selected()), None, "the sidebar selection clears");
    assert!(sidebar.read_with(cx, |s, _| s.selected_row().is_none()));
    assert!(!panel.read_with(cx, |p, _| p.is_open()), "the panel follows: no Chat, no panel");
    let composer = chat.read_with(cx, |c, _| c.composer.clone());
    assert!(composer.read_with(cx, |c, _| c.new_chat().is_some() && !c.starters().is_empty()), "the tray and the starters");
    let body = cx.debug_bounds("new-chat-body").expect("the empty screen");
    let tray = cx.debug_bounds("new-chat-tray").expect("the tray");
    let (above, below) = (tray.top() - body.top(), body.bottom() - tray.bottom());
    // The starters sit above the tray inside the centred group, so the tray is a little low: not docked at the bottom.
    assert!(above > gpui::px(150.0) && below > gpui::px(150.0), "the composer floats in the middle: {above:?} above, {below:?} below");
}

#[gpui::test]
fn new_chat_clears_the_column_and_a_row_brings_its_chat_back(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let (chat, sidebar) = workspace.read_with(cx, |w, _| (w.chat.clone(), w.sidebar.clone()));
    let before = chat.read_with(cx, |c, _| c.key().map(str::to_owned));
    let button = cx.debug_bounds("new-chat").expect("button drawn");
    cx.simulate_click(button.center(), Modifiers::none());
    cx.run_until_parked();
    on_the_empty_screen(&workspace, cx);
    // ⌘N from a Chat does the same.
    click_row(&workspace, 4, cx);
    cx.run_until_parked();
    assert!(!chat.read_with(cx, |c, _| c.is_new_chat()));
    cx.simulate_keystrokes("cmd-n");
    cx.run_until_parked();
    on_the_empty_screen(&workspace, cx);
    // A row brings its Chat back.
    click_row(&workspace, 4, cx);
    cx.run_until_parked();
    let key = sidebar.read_with(cx, |s, _| s.row(4).unwrap().key.to_string());
    assert_eq!(chat.read_with(cx, |c, _| c.key().map(str::to_owned)), Some(key));
    assert!(!chat.read_with(cx, |c, _| c.is_new_chat()) && cx.debug_bounds("new-chat-body").is_none());
    assert!(chat.read_with(cx, |c, cx| c.composer.read(cx).new_chat().is_none()), "the tray is gone");
    assert_ne!(before, chat.read_with(cx, |c, _| c.key().map(str::to_owned)));
}

#[gpui::test]
fn sending_from_the_empty_screen_makes_a_chat_that_the_sidebar_lists_and_selects(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let (chat, sidebar) = workspace.read_with(cx, |w, _| (w.chat.clone(), w.sidebar.clone()));
    let rows = sidebar.read_with(cx, |s, _| s.row_count());
    cx.simulate_keystrokes("cmd-n");
    cx.run_until_parked();
    let composer = chat.read_with(cx, |c, _| c.composer.clone());
    cx.update(|window, cx| {
        let handle = gpui::Focusable::focus_handle(composer.read(cx), cx);
        window.focus(&handle, cx);
    });
    cx.simulate_input("Plan the release notes");
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    assert_eq!(sidebar.read_with(cx, |s, _| s.row_count()), rows + 1, "the new Chat is in the list");
    let selected =
        sidebar.read_with(cx, |s, _| s.selected().and_then(|ix| s.row(ix)).map(|row| (row.key.to_string(), row.title.to_string())));
    let (key, title) = selected.expect("and selected");
    assert_eq!(title, "Plan the release notes");
    assert_eq!(chat.read_with(cx, |c, _| c.key().map(str::to_owned)), Some(key));
    assert!(!chat.read_with(cx, |c, _| c.is_new_chat()));
    let items = chat.read_with(cx, |c, cx| c.transcript.read(cx).items().to_vec());
    assert!(matches!(items.as_slice(), [Item::User(text)] if text.as_ref() == "Plan the release notes"), "{items:?}");
}

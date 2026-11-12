//! WP-20 tests: the context menu's items and what each sends, the hover card, rename, Done, Delete and Pin with the
//! undo book (three steps, ⌘Z and ⇧⌘Z, the 6-second window), Filters and the collapsed rail.

use std::time::Duration;

use gpui::{Entity, Modifiers, MouseButton, TestAppContext, VisualTestContext, point, px};

use super::actions::{ArchiveMode, ChatPatch, SidebarCall};
use super::filters::{self, FilterAction, Sub};
use super::menu::{MenuAction, MenuContext, MenuEntry, entries};
use super::undo::{Op, UndoBook};
use super::{Sidebar, rail};
use crate::testing;

fn mount(cx: &mut TestAppContext) -> (Entity<Sidebar>, &mut VisualTestContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let sidebar = workspace.read_with(cx, |workspace, _| workspace.sidebar.clone());
    (sidebar, cx)
}

fn calls(sidebar: &Entity<Sidebar>, cx: &VisualTestContext) -> Vec<SidebarCall> {
    sidebar.read_with(cx, |s, _| s.calls())
}

fn key(sidebar: &Entity<Sidebar>, cx: &VisualTestContext, ix: usize) -> String {
    sidebar.read_with(cx, |s, _| s.row(ix).expect("a row").key.to_string())
}

fn right_click(cx: &mut VisualTestContext, selector: &'static str) {
    let at = cx.debug_bounds(selector).expect("the row is drawn").center();
    cx.simulate_mouse_down(at, MouseButton::Right, Modifiers::none());
    cx.simulate_mouse_up(at, MouseButton::Right, Modifiers::none());
}

fn run(sidebar: &Entity<Sidebar>, cx: &mut VisualTestContext, ix: usize, action: MenuAction) {
    cx.update(|window, cx| {
        sidebar.update(cx, |s, cx| {
            s.open_menu(ix, point(px(100.0), px(100.0)), window, cx);
            s.run_menu(action, window, cx);
        })
    });
    cx.run_until_parked();
}

/// Deleting has no menu item any more; the undo book and the toast still handle it.
fn delete(sidebar: &Entity<Sidebar>, cx: &mut VisualTestContext, ix: usize) {
    let key = key(sidebar, cx, ix);
    cx.update(|_, cx| sidebar.update(cx, |s, cx| s.delete(&key, true, cx)));
    cx.run_until_parked();
}

fn labels(context: &MenuContext) -> Vec<String> {
    entries(context)
        .into_iter()
        .map(|entry| match entry {
            MenuEntry::Row(item) => item.label.to_string(),
            MenuEntry::Divider => "-".to_owned(),
        })
        .collect()
}

fn context() -> MenuContext {
    MenuContext {
        key: "/p#1".into(),
        path: Some("/w/one".into()),
        branch: Some("milagre/one".into()),
        linkable: true,
        ..MenuContext::default()
    }
}

#[test]
fn the_menu_lists_the_kept_items_in_order() {
    assert_eq!(
        labels(&context()),
        ["Copy branch name", "Rename Chat", "Reload Chat", "Mark as unread", "Pin", "Link with…", "-", "Mark Done"]
    );
    // Every conditional item at once: the other flavour of each pair left out.
    let all = MenuContext {
        linear_key: Some("MIL-1".into()),
        unread: true,
        pinned: true,
        has_parent: true,
        linked: true,
        done: true,
        ..context()
    };
    assert_eq!(
        labels(&all),
        [
            "Copy branch name",
            "Rename Chat",
            "Reload Chat",
            "Unlink issue",
            "Unpin",
            "Link with…",
            "Remove Link with…",
            "Detach from parent",
            "-",
            "Reopen"
        ]
    );
    // The removed items never show, whatever the Chat is.
    for context in [context(), all] {
        let shown = labels(&context);
        for gone in ["Copy path", "Report a Milagre bug", "Link issue…", "Mark as read", "Open in Finder", "Commit and open PR…", "Delete"]
        {
            assert!(!shown.iter().any(|label| label == gone), "{gone}");
        }
        assert!(!shown.iter().any(|label| label.starts_with("Open in") || label == "No editor found"));
        assert_ne!(shown.first().map(String::as_str), Some("-"));
        assert!(shown.windows(2).all(|pair| !(pair[0] == "-" && pair[1] == "-")) && shown.last().map(String::as_str) != Some("-"));
    }
}

#[test]
fn a_chat_without_a_project_or_on_another_computer_loses_the_items_that_need_a_folder() {
    let home = MenuContext { gitless: true, path: None, branch: None, linkable: false, ..context() };
    assert_eq!(labels(&home), ["Rename Chat", "Reload Chat", "Mark as unread", "Pin", "-", "Mark Done"]);
    let remote = labels(&MenuContext { remote: true, ..context() });
    assert!(!remote.iter().any(|label| label == "Link with…"));
    assert!(remote.contains(&"Copy branch name".to_owned()));
    // No branch: Copy branch name stays but cannot be pressed.
    let none = MenuContext { path: None, branch: None, ..context() };
    let items: Vec<_> = entries(&none)
        .into_iter()
        .filter_map(|entry| match entry {
            MenuEntry::Row(item) => Some(item),
            MenuEntry::Divider => None,
        })
        .collect();
    let find = |label: &str| items.iter().find(|item| item.label == label).unwrap_or_else(|| panic!("{label}"));
    assert!(find("Copy branch name").disabled && !find("Rename Chat").disabled);
}

#[gpui::test]
fn a_right_press_opens_the_menu_at_the_pointer_and_escape_closes_it(cx: &mut TestAppContext) {
    let (sidebar, cx) = mount(cx);
    right_click(cx, "chat-row-3");
    assert!(sidebar.read_with(cx, |s, _| s.menu_open()));
    assert_eq!(sidebar.read_with(cx, |s, _| s.selected()), Some(3), "the row under the pointer is selected");
    let menu = cx.debug_bounds("chat-menu").expect("the menu is drawn");
    assert_eq!(menu.size.width, px(240.0));
    let row = cx.debug_bounds("chat-row-3").unwrap();
    assert!(menu.left() <= row.center().x + px(1.0) && menu.top() >= row.top());
    for id in ["menu-rename", "menu-reload", "menu-pin", "menu-done"] {
        assert!(cx.debug_bounds(id).is_some(), "{id} is in the row's menu");
    }
    cx.simulate_keystrokes("escape");
    assert!(!sidebar.read_with(cx, |s, _| s.menu_open()));
    // A press outside closes it too.
    right_click(cx, "chat-row-3");
    cx.simulate_click(point(px(700.0), px(500.0)), Modifiers::none());
    assert!(!sidebar.read_with(cx, |s, _| s.menu_open()));
}

#[gpui::test]
fn the_menu_opens_upwards_near_the_window_bottom(cx: &mut TestAppContext) {
    let (_, cx) = mount(cx);
    let size = cx.update(|window, _| window.viewport_size());
    let items = entries(&context());
    let (anchor, at) =
        super::menu::placement(point(px(40.0), size.height - px(20.0)), size.width, size.height, super::menu::height_of(&items));
    assert_eq!(anchor, gpui::Anchor::BottomLeft);
    assert!(at.y < size.height);
    let (anchor, _) = super::menu::placement(point(px(40.0), px(20.0)), size.width, size.height, super::menu::height_of(&items));
    assert_eq!(anchor, gpui::Anchor::TopLeft);
}

#[gpui::test]
fn clicking_a_menu_item_runs_it_and_closes_the_menu(cx: &mut TestAppContext) {
    let (sidebar, cx) = mount(cx);
    let chat = key(&sidebar, cx, 2);
    right_click(cx, "chat-row-2");
    let reload = cx.debug_bounds("menu-reload").expect("Reload Chat").center();
    cx.simulate_click(reload, Modifiers::none());
    assert_eq!(calls(&sidebar, cx), [SidebarCall::Reload { chat }]);
    assert!(!sidebar.read_with(cx, |s, _| s.menu_open()));
}

#[gpui::test]
fn each_menu_item_sends_its_call(cx: &mut TestAppContext) {
    let (sidebar, cx) = mount(cx);
    let two = key(&sidebar, cx, 2);

    run(&sidebar, cx, 2, MenuAction::Reload);
    run(&sidebar, cx, 2, MenuAction::LinkWith);
    run(&sidebar, cx, 2, MenuAction::MarkUnread);
    assert_eq!(
        calls(&sidebar, cx),
        [
            SidebarCall::Reload { chat: two.clone() },
            SidebarCall::LinkWith { chat: two.clone() },
            SidebarCall::Patch { chat: two.clone(), patch: ChatPatch::Unread(true) },
        ]
    );
}

#[gpui::test]
fn copy_branch_puts_the_branch_on_the_clipboard(cx: &mut TestAppContext) {
    let (sidebar, cx) = mount(cx);
    run(&sidebar, cx, 2, MenuAction::CopyBranch);
    assert_eq!(cx.read_from_clipboard().and_then(|item| item.text()), Some("milagre/migrate-desktop-to-rust".into()));
    assert!(calls(&sidebar, cx).is_empty(), "copying asks the host for nothing");
}

#[gpui::test]
fn detach_patches_a_subchat_that_has_no_row(cx: &mut TestAppContext) {
    let (sidebar, cx) = mount(cx);
    let child = sidebar
        .read_with(cx, |s, _| s.family_chats())
        .into_iter()
        .find(|chat| chat.title == "Port the sidebar to GPUI")
        .expect("the data has it")
        .key;
    assert!(!sidebar.read_with(cx, |s, _| s.row_keys().contains(&child)), "Subchats are not listed");
    let offered = sidebar.read_with(cx, |s, _| s.menu_context(&child)).map(|context| labels(&context)).expect("a menu");
    assert!(offered.contains(&"Detach from parent".to_owned()));
    cx.update(|window, cx| {
        sidebar.update(cx, |s, cx| {
            s.open_menu_key(&child, point(px(100.0), px(100.0)), window, cx);
            s.run_menu(MenuAction::Detach, window, cx);
        })
    });
    assert_eq!(calls(&sidebar, cx), [SidebarCall::Patch { chat: child.clone(), patch: ChatPatch::Detach }]);
    assert!(sidebar.read_with(cx, |s, _| s.row_keys().contains(&child)), "detached, it is a top-level Chat in the list");
}

#[gpui::test]
fn done_moves_the_chat_to_the_done_list_at_once_and_cmd_z_takes_it_back(cx: &mut TestAppContext) {
    let (sidebar, cx) = mount(cx);
    let chat = key(&sidebar, cx, 11);
    let (rows, done) = sidebar.read_with(cx, |s, _| (s.row_count(), s.done_count()));
    run(&sidebar, cx, 11, MenuAction::Done);
    // It leaves the list at once and heads the Done list (most recently marked first).
    assert_eq!(sidebar.read_with(cx, |s, _| (s.row_count(), s.done_count())), (rows - 1, done + 1));
    assert!(sidebar.read_with(cx, |s, _| s.is_done_key(&chat)));
    assert!(!sidebar.read_with(cx, |s, _| s.row_keys().contains(&chat)));
    assert_eq!(sidebar.read_with(cx, |s, _| s.done_rows()[0].key.to_string()), chat);
    // The menu selected it: it stays on screen, picked, with no list row selected.
    assert_eq!(sidebar.read_with(cx, |s, _| (s.selected(), s.selected_row().map(|row| row.key.to_string()))), (None, Some(chat.clone())));
    assert!(matches!(calls(&sidebar, cx)[..], [SidebarCall::Patch { patch: ChatPatch::DoneAt(Some(_)), .. }]));
    assert_eq!(sidebar.read_with(cx, |s, _| s.toast_text()), Some("Moved to Done".into()));
    assert!(cx.debug_bounds("toast-undo").is_some(), "the toast offers Undo");

    cx.simulate_keystrokes("cmd-z");
    assert_eq!(sidebar.read_with(cx, |s, _| (s.row_count(), s.done_count())), (rows, done));
    assert_eq!(sidebar.read_with(cx, |s, _| s.selected()), Some(11), "back in its place, selected again");
    assert_eq!(calls(&sidebar, cx).last(), Some(&SidebarCall::Patch { chat: chat.clone(), patch: ChatPatch::DoneAt(None) }));
    assert_eq!(sidebar.read_with(cx, |s, _| s.toast_text()), Some("Back in Chats".into()));
    assert!(cx.debug_bounds("toast-redo").is_some());
    cx.simulate_keystrokes("cmd-shift-z");
    assert!(sidebar.read_with(cx, |s, _| s.is_done_key(&chat)));
    assert_eq!(sidebar.read_with(cx, |s, _| s.toast_text()), Some("Moved to Done".into()));
}

#[gpui::test]
fn reopen_from_the_done_section_is_a_step_too(cx: &mut TestAppContext) {
    let (sidebar, cx) = mount(cx);
    let chat = key(&sidebar, cx, 2);
    run(&sidebar, cx, 2, MenuAction::Done);
    cx.update(|_, cx| sidebar.update(cx, |s, cx| s.reopen(&chat, true, cx)));
    assert_eq!(sidebar.read_with(cx, |s, _| s.toast_text()), Some("Back in Chats".into()));
    assert!(!sidebar.read_with(cx, |s, _| s.is_done_key(&chat)));
    cx.simulate_keystrokes("cmd-z");
    assert!(sidebar.read_with(cx, |s, _| s.is_done_key(&chat)), "undoing a Reopen moves it back to Done");
    assert_eq!(sidebar.read_with(cx, |s, _| s.toast_text()), Some("Moved to Done".into()));
}

#[gpui::test]
fn delete_hides_the_chat_only_and_the_toast_undo_takes_it_back(cx: &mut TestAppContext) {
    let (sidebar, cx) = mount(cx);
    let chat = key(&sidebar, cx, 8);
    let rows = sidebar.read_with(cx, |s, _| s.row_count());
    delete(&sidebar, cx, 8);
    assert_eq!(calls(&sidebar, cx), [SidebarCall::Archive { chat: chat.clone(), mode: ArchiveMode::HideOnly }]);
    assert_eq!(sidebar.read_with(cx, |s, _| s.row_count()), rows - 1);
    assert!(sidebar.read_with(cx, |s, _| s.is_archived_key(&chat)));
    assert_eq!(sidebar.read_with(cx, |s, _| s.toast_text()), Some("Chat deleted".into()));
    let undo = cx.debug_bounds("toast-undo").expect("Undo").center();
    cx.simulate_click(undo, Modifiers::none());
    assert_eq!(calls(&sidebar, cx).last(), Some(&SidebarCall::UndoArchive { chat: chat.clone() }));
    assert_eq!(sidebar.read_with(cx, |s, _| s.row_count()), rows);
    assert_eq!(sidebar.read_with(cx, |s, _| s.toast_text()), Some("Chat restored".into()));
    // A restored deletion has no redo: ⇧⌘Z never deletes a Worktree.
    assert!(cx.debug_bounds("toast-redo").is_none());
}

#[gpui::test]
fn a_deletion_cannot_be_undone_after_six_seconds(cx: &mut TestAppContext) {
    let (sidebar, cx) = mount(cx);
    let chat = key(&sidebar, cx, 8);
    delete(&sidebar, cx, 8);
    cx.update(|_, cx| sidebar.update(cx, |s, _| s.advance_clock(6_500)));
    cx.simulate_keystrokes("cmd-z");
    assert!(sidebar.read_with(cx, |s, _| s.is_archived_key(&chat)), "still deleted");
    assert!(!calls(&sidebar, cx).iter().any(|call| matches!(call, SidebarCall::UndoArchive { .. })));
}

#[gpui::test]
fn the_toast_goes_after_six_seconds(cx: &mut TestAppContext) {
    let (sidebar, cx) = mount(cx);
    run(&sidebar, cx, 2, MenuAction::Done);
    assert!(sidebar.read_with(cx, |s, _| s.toast_text()).is_some());
    cx.executor().advance_clock(Duration::from_millis(5_900));
    cx.run_until_parked();
    assert!(sidebar.read_with(cx, |s, _| s.toast_text()).is_some(), "still showing at 5.9s");
    cx.executor().advance_clock(Duration::from_millis(200));
    cx.run_until_parked();
    assert_eq!(sidebar.read_with(cx, |s, _| s.toast_text()), None);
    assert!(cx.debug_bounds("toast").is_none());
}

#[gpui::test]
fn pin_and_unpin_are_this_devices_and_move_the_row_between_sections(cx: &mut TestAppContext) {
    let (sidebar, cx) = mount(cx);
    let chat = key(&sidebar, cx, 2);
    assert_eq!(sidebar.read_with(cx, |s, _| s.pinned_count()), 2);
    run(&sidebar, cx, 2, MenuAction::Pin);
    assert_eq!(sidebar.read_with(cx, |s, _| s.pinned_count()), 3);
    assert!(sidebar.read_with(cx, |s, _| s.is_pinned_key(&chat)));
    let pin = calls(&sidebar, cx);
    assert!(matches!(&pin[..], [SidebarCall::Pin { chat: pinned, order: Some(_) }] if *pinned == chat), "{pin:?}");
    assert_eq!(sidebar.read_with(cx, |s, _| s.toast_text()), Some("Pinned".into()));

    // The menu now offers Unpin for it.
    let index = sidebar.read_with(cx, |s, _| s.row_keys().iter().position(|k| *k == chat)).unwrap();
    let offers = sidebar.read_with(cx, |s, _| labels(&s.menu_context(&chat).unwrap()));
    assert!(offers.contains(&"Unpin".to_owned()) && !offers.contains(&"Pin".to_owned()));
    run(&sidebar, cx, index, MenuAction::Unpin);
    assert_eq!(sidebar.read_with(cx, |s, _| s.pinned_count()), 2);
    assert_eq!(calls(&sidebar, cx).last(), Some(&SidebarCall::Pin { chat, order: None }));
    assert_eq!(sidebar.read_with(cx, |s, _| s.toast_text()), Some("Unpinned".into()));
}

#[gpui::test]
fn undo_walks_back_three_steps_and_redo_forward_again(cx: &mut TestAppContext) {
    let (sidebar, cx) = mount(cx);
    let (pin, done, delete) = (key(&sidebar, cx, 2), key(&sidebar, cx, 4), key(&sidebar, cx, 8));
    let initial = sidebar.read_with(cx, |s, _| (s.row_count(), s.pinned_count(), s.done_count()));

    run(&sidebar, cx, 2, MenuAction::Pin);
    let at = |cx: &VisualTestContext, key: &str| sidebar.read_with(cx, |s, _| s.row_keys().iter().position(|k| k == key)).expect("listed");
    run(&sidebar, cx, at(cx, &done), MenuAction::Done);
    let delete_ix = at(cx, &delete);
    super::menu_tests::delete(&sidebar, cx, delete_ix);
    let after = sidebar.read_with(cx, |s, _| (s.row_count(), s.pinned_count(), s.done_count()));
    // The Done Chat and the deleted one both leave the list; Done counts one more.
    assert_eq!(after, (initial.0 - 2, initial.1 + 1, initial.2 + 1));

    cx.simulate_keystrokes("cmd-z");
    assert!(!sidebar.read_with(cx, |s, _| s.is_archived_key(&delete)), "the deletion is taken back first");
    cx.simulate_keystrokes("cmd-z");
    assert!(!sidebar.read_with(cx, |s, _| s.is_done_key(&done)), "then Done");
    cx.simulate_keystrokes("cmd-z");
    assert!(!sidebar.read_with(cx, |s, _| s.is_pinned_key(&pin)), "then the pin");
    assert_eq!(sidebar.read_with(cx, |s, _| (s.row_count(), s.pinned_count(), s.done_count())), initial);
    assert_eq!(sidebar.read_with(cx, |s, _| s.toast_text()), Some("Unpinned".into()));

    cx.simulate_keystrokes("cmd-shift-z");
    assert!(sidebar.read_with(cx, |s, _| s.is_pinned_key(&pin)));
    cx.simulate_keystrokes("cmd-shift-z");
    assert!(sidebar.read_with(cx, |s, _| s.is_done_key(&done)));
    // The deletion has no redo: the chain ends at Done.
    cx.simulate_keystrokes("cmd-shift-z");
    assert!(!sidebar.read_with(cx, |s, _| s.is_archived_key(&delete)));
}

#[test]
fn the_book_queues_the_opposite_of_each_step() {
    let mut book = UndoBook::new();
    book.done("/p#1");
    book.pin("/p#2", None, Some(3.0));
    book.pin("/p#3", Some(1.0), Some(2.0));
    book.delete("/p#4");
    assert!(book.history.undo());
    assert_eq!(book.drain(), [Op::UndoArchive("/p#4".into())]);
    assert!(book.history.undo());
    assert_eq!(book.drain(), [Op::Pin("/p#2".into(), None)], "reordering a pin is not a step");
    assert!(book.history.undo());
    assert_eq!(book.drain(), [Op::Reopen("/p#1".into())]);
    assert!(book.history.redo());
    assert_eq!(book.drain(), [Op::Done("/p#1".into())]);
}

#[gpui::test]
fn rename_edits_the_title_in_place_and_enter_keeps_it(cx: &mut TestAppContext) {
    let (sidebar, cx) = mount(cx);
    let chat = key(&sidebar, cx, 2);
    cx.update(|window, cx| sidebar.update(cx, |s, cx| s.start_rename(&chat, window, cx)));
    cx.run_until_parked();
    assert_eq!(sidebar.read_with(cx, |s, _| s.renaming_key().map(str::to_owned)), Some(chat.clone()));
    assert!(cx.debug_bounds("rename-field").is_some(), "the field takes the title's place");
    cx.simulate_input("Port the whole sidebar");
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    assert_eq!(sidebar.read_with(cx, |s, _| s.renaming_key().map(str::to_owned)), None);
    assert_eq!(sidebar.read_with(cx, |s, _| s.row_title(&chat)), Some("Port the whole sidebar".into()));
    assert_eq!(calls(&sidebar, cx), [SidebarCall::Patch { chat, patch: ChatPatch::Title("Port the whole sidebar".into()) }]);
    assert!(cx.debug_bounds("rename-field").is_none());
}

#[gpui::test]
fn escape_drops_a_rename_and_an_emptied_name_restores_the_generated_title(cx: &mut TestAppContext) {
    let (sidebar, cx) = mount(cx);
    let chat = key(&sidebar, cx, 2);
    let title = sidebar.read_with(cx, |s, _| s.row_title(&chat)).unwrap();
    cx.update(|window, cx| sidebar.update(cx, |s, cx| s.start_rename(&chat, window, cx)));
    cx.run_until_parked();
    cx.simulate_input("Something else");
    cx.simulate_keystrokes("escape");
    cx.run_until_parked();
    assert_eq!(sidebar.read_with(cx, |s, _| s.renaming_key().map(str::to_owned)), None);
    assert_eq!(sidebar.read_with(cx, |s, _| s.row_title(&chat)), Some(title));
    assert!(calls(&sidebar, cx).is_empty());

    cx.update(|window, cx| sidebar.update(cx, |s, cx| s.start_rename(&chat, window, cx)));
    cx.run_until_parked();
    cx.simulate_keystrokes("backspace enter");
    cx.run_until_parked();
    assert_eq!(calls(&sidebar, cx), [SidebarCall::Patch { chat, patch: ChatPatch::Title("".into()) }]);
}

#[gpui::test]
fn the_hover_card_opens_after_150ms_and_closes_after_its_grace(cx: &mut TestAppContext) {
    let (sidebar, cx) = mount(cx);
    let chat = key(&sidebar, cx, 2);
    let row = cx.debug_bounds("chat-row-2").unwrap();
    cx.simulate_mouse_move(row.center(), None, Modifiers::none());
    cx.executor().advance_clock(Duration::from_millis(100));
    cx.run_until_parked();
    assert!(cx.debug_bounds("hover-card").is_none(), "not yet at 100ms");
    cx.executor().advance_clock(Duration::from_millis(60));
    cx.run_until_parked();
    assert_eq!(sidebar.read_with(cx, |s, _| s.card_key().map(str::to_owned)), Some(chat));
    let card = cx.debug_bounds("hover-card").expect("the card");
    assert_eq!(card.size.width, px(256.0));
    assert_eq!(card.left(), px(super::SIDEBAR_WIDTH + 8.0), "beside the sidebar");
    assert!(cx.debug_bounds("hover-card-status").is_some(), "a running Chat says so");

    cx.simulate_mouse_move(point(px(900.0), px(400.0)), None, Modifiers::none());
    cx.executor().advance_clock(Duration::from_millis(200));
    cx.run_until_parked();
    assert!(cx.debug_bounds("hover-card").is_some(), "the grace lets the pointer cross to the card");
    cx.executor().advance_clock(Duration::from_millis(100));
    cx.run_until_parked();
    assert!(cx.debug_bounds("hover-card").is_none());
}

#[gpui::test]
fn the_hover_card_is_not_opened_over_a_menu(cx: &mut TestAppContext) {
    let (sidebar, cx) = mount(cx);
    right_click(cx, "chat-row-2");
    let row = cx.debug_bounds("chat-row-4").unwrap();
    cx.simulate_mouse_move(row.center(), None, Modifiers::none());
    cx.executor().advance_clock(Duration::from_millis(600));
    cx.run_until_parked();
    assert_eq!(sidebar.read_with(cx, |s, _| s.card_key().map(str::to_owned)), None);
}

#[gpui::test]
fn the_card_model_reads_state_prs_diff_branch_and_folder(cx: &mut TestAppContext) {
    let (sidebar, cx) = mount(cx);
    let model = sidebar.read_with(cx, |s, _| {
        let row = s.row(0).unwrap();
        super::hover_card::CardModel::build(row, s.meta[0], &s.data, vec!["Relay".into()])
    });
    assert_eq!(model.title, "Release train v0.233");
    assert_eq!(model.branch.as_deref(), Some("milagre/release-train-v0-233"));
    assert_eq!(model.folder.as_deref(), Some("release-train-v0-233-61"));
    assert_eq!(model.linked, ["Relay"]);
    let home = sidebar.read_with(cx, |s, _| {
        let ix = s.row_keys().iter().position(|k| k.ends_with("chats#70")).expect("the Chats home row");
        super::hover_card::CardModel::build(s.row(ix).unwrap(), s.meta[ix], &s.data, Vec::new())
    });
    assert!(home.branch.is_none() && home.folder.is_none(), "a Chat without a Project has no folder to show");
}

#[gpui::test]
fn the_filters_button_opens_a_menu_with_computers_projects_and_show(cx: &mut TestAppContext) {
    let (sidebar, cx) = mount(cx);
    let button = cx.debug_bounds("filters").expect("the footer's Filters button").center();
    cx.simulate_click(button, Modifiers::none());
    assert_eq!(sidebar.read_with(cx, |s, _| s.filters_state()), Some(None));
    let panel = cx.debug_bounds("filters-panel").expect("the panel");
    let button = cx.debug_bounds("filters").unwrap();
    assert!(panel.bottom() <= button.top(), "it opens above the button");
    for id in ["filters-computers", "filters-projects", "filters-show"] {
        assert!(cx.debug_bounds(id).is_some(), "{id}");
    }
    let show = cx.debug_bounds("filters-show").unwrap().center();
    cx.simulate_click(show, Modifiers::none());
    assert_eq!(sidebar.read_with(cx, |s, _| s.filters_state()), Some(Some(Sub::Show)));
    let sub = cx.debug_bounds("filters-sub-panel").expect("the submenu beside the menu");
    assert!(sub.left() >= panel.right());
    assert_eq!(sub.size.width, px(208.0));
    cx.simulate_keystrokes("escape");
    assert_eq!(sidebar.read_with(cx, |s, _| s.filters_state()), Some(None), "Escape in a submenu goes back to the menu");
    let button = cx.debug_bounds("filters").unwrap().center();
    cx.simulate_click(button, Modifiers::none());
    assert_eq!(sidebar.read_with(cx, |s, _| s.filters_state()), None, "the button toggles it closed");
    // A press anywhere else closes it too.
    cx.simulate_click(button, Modifiers::none());
    cx.simulate_click(point(px(900.0), px(300.0)), Modifiers::none());
    assert_eq!(sidebar.read_with(cx, |s, _| s.filters_state()), None);
}

#[gpui::test]
fn show_toggles_what_a_rows_second_line_carries(cx: &mut TestAppContext) {
    let (sidebar, cx) = mount(cx);
    assert!(sidebar.read_with(cx, |s, _| s.show_field_ids()).contains(&"computer"), "the fixture has several computers");
    let before = sidebar.read_with(cx, |s, _| s.row(2).unwrap().detail.to_string());
    cx.update(|window, cx| {
        sidebar.update(cx, |s, cx| {
            s.toggle_filters(cx);
            s.filter_action(FilterAction::OpenSub(Sub::Show), window, cx);
            s.filter_action(FilterAction::ToggleField(crate::logic::lists::chat_row::ChatRowField::Branch), window, cx);
        })
    });
    let after = sidebar.read_with(cx, |s, _| s.row(2).unwrap().detail.to_string());
    assert_ne!(before, after);
    assert!(after.contains("milagre/migrate-desktop-to-rust"), "{after}");
    assert_eq!(calls(&sidebar, cx), [SidebarCall::SetRowField { field: "branch", shown: true }]);
    // Click the Branch row again in the open submenu: off.
    cx.run_until_parked();
    let row = cx.debug_bounds("show-branch").expect("the Branch row").center();
    cx.simulate_click(row, Modifiers::none());
    assert_eq!(sidebar.read_with(cx, |s, _| s.row(2).unwrap().detail.to_string()), before);
}

#[gpui::test]
fn hiding_a_project_or_a_computer_leaves_its_chats_out_of_the_lists(cx: &mut TestAppContext) {
    let (sidebar, cx) = mount(cx);
    let rows = sidebar.read_with(cx, |s, _| s.row_count());
    let remote = sidebar.read_with(cx, |s, _| s.row_keys().iter().filter(|k| k.starts_with("tianxu-mini|")).count());
    assert!(remote > 0);
    cx.update(|window, cx| sidebar.update(cx, |s, cx| s.filter_action(FilterAction::ToggleComputer("tianxu-mini".into()), window, cx)));
    assert_eq!(sidebar.read_with(cx, |s, _| s.row_count()), rows - remote);
    assert_eq!(sidebar.read_with(cx, |s, _| s.hidden_computers()), ["tianxu-mini"]);
    assert_eq!(calls(&sidebar, cx), [SidebarCall::SetComputerHidden { computer: "tianxu-mini".into(), hidden: true }]);
    let projects = sidebar.read_with(cx, |s, _| s.hidden_project_names().len());
    assert_eq!(
        sidebar.read_with(cx, |s, _| s.filters_tooltip()),
        format!(
            "Filters (1 computer hidden{})",
            if projects > 0 { format!(", {projects} Project{} hidden", if projects == 1 { "" } else { "s" }) } else { String::new() }
        )
    );
    cx.update(|window, cx| sidebar.update(cx, |s, cx| s.filter_action(FilterAction::ToggleComputer("tianxu-mini".into()), window, cx)));
    assert_eq!(sidebar.read_with(cx, |s, _| s.row_count()), rows);

    let (scope, name) = sidebar.read_with(cx, |s, _| {
        let choice =
            filters::project_choices(&s.data, None).into_iter().find(|c| c.computer == crate::data::LOCAL).expect("a local Project");
        (choice.scope, choice.name.to_string())
    });
    cx.update(|window, cx| sidebar.update(cx, |s, cx| s.filter_action(FilterAction::ToggleProject(scope), window, cx)));
    assert!(sidebar.read_with(cx, |s, _| s.row_count()) < rows);
    assert!(sidebar.read_with(cx, |s, _| s.hidden_project_names()).contains(&name));
    assert!(matches!(calls(&sidebar, cx).last(), Some(SidebarCall::SetProjectHidden { hidden: true, .. })));
}

#[test]
fn the_filters_tooltip_and_choices_follow_the_data() {
    assert_eq!(filters::tooltip(0, 0), "Filters");
    assert_eq!(filters::tooltip(2, 1), "Filters (2 computers hidden, 1 Project hidden)");
    assert_eq!(filters::show_fields(false).len(), 5);
    assert_eq!(filters::show_fields(true)[0].0, crate::logic::lists::chat_row::ChatRowField::Computer);
}

#[gpui::test]
fn the_collapsed_sidebar_is_a_rail_with_a_badge_and_a_card(cx: &mut TestAppContext) {
    let (sidebar, cx) = mount(cx);
    let expanded = cx.debug_bounds("sidebar").map(|b| b.size.width);
    let _ = expanded;
    cx.update(|_, cx| sidebar.update(cx, |s, cx| s.toggle_collapsed(cx)));
    cx.run_until_parked();
    assert!(sidebar.read_with(cx, |s, _| s.is_collapsed()));
    let icon = cx.debug_bounds("rail-item-0").expect("the first Chat's icon");
    assert_eq!((icon.size.width, icon.size.height), (px(32.0), px(32.0)));
    assert!(icon.right() <= px(rail::RAIL_WIDTH));
    // Row 2 runs (a spinner badge), row 3 asks (an orange dot).
    assert!(cx.debug_bounds("rail-running-2").is_some());
    assert!(cx.debug_bounds("rail-attention-3").is_some());
    assert!(cx.debug_bounds("rail-running-3").is_none(), "attention wins over running");
    assert!(cx.debug_bounds("rail-attention-0").is_some(), "the pinned Release train waits on an approval");
    assert!(cx.debug_bounds("rail-attention-1").is_none());

    let at = cx.debug_bounds("rail-item-2").unwrap().center();
    cx.simulate_mouse_move(at, None, Modifiers::none());
    cx.executor().advance_clock(Duration::from_millis(350));
    cx.run_until_parked();
    assert_eq!(sidebar.read_with(cx, |s, _| s.rail_card_row()), Some(2));
    let card = cx.debug_bounds("rail-popover").expect("the card beside the rail");
    assert!(card.left() >= px(rail::RAIL_WIDTH));

    // Clicking an icon opens that Chat.
    cx.simulate_click(at, Modifiers::none());
    assert_eq!(sidebar.read_with(cx, |s, _| s.selected()), Some(2));
    assert_eq!(sidebar.read_with(cx, |s, _| s.rail_card_row()), None);
    cx.update(|_, cx| sidebar.update(cx, |s, cx| s.toggle_collapsed(cx)));
    cx.run_until_parked();
    assert!(cx.debug_bounds("chat-row-2").is_some(), "expanded again");
}

#[test]
fn the_rail_badge_follows_the_mark() {
    use crate::logic::marks::ChatMark as M;
    use rail::RailStatus as R;
    for (mark, status) in [
        (M::Question, R::Attention),
        (M::Waiting, R::Attention),
        (M::Running, R::Running),
        (M::Background, R::Running),
        (M::Delegated, R::Running),
        (M::Idle, R::Idle),
        (M::Unread, R::Idle),
    ] {
        assert_eq!(rail::rail_status(mark), status, "{mark:?}");
    }
}

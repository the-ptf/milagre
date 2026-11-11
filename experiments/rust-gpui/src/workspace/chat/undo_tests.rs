//! The Undo panel: its text helpers (ports of `checkpoints.ts`), its state and keys, and its place over the composer.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use gpui::{Entity, Focusable as _, Modifiers, TestAppContext, VisualTestContext};

use super::undo_panel::*;
use crate::testing;

const MIN: i64 = 60_000;
const HOUR: i64 = 3_600_000;
const DAY: i64 = 86_400_000;

fn item(id: &str, changed: Option<usize>, files: Vec<CheckpointFile>) -> Checkpoint {
    Checkpoint { id: id.into(), created_at: NOW - 5 * MIN, message_id: Some(1), prompt: Some(format!("Task {id}\nmore")), changed, files }
}

fn file(key: &str, action: Action, conflict: bool) -> CheckpointFile {
    CheckpointFile { key: key.into(), path: format!("src/auth/{key}.ts"), action, conflict }
}

#[test]
fn time_reads_today_yesterday_or_the_date() {
    let noon = 12 * HOUR + 5 * MIN;
    let now = 20 * DAY + 15 * HOUR;
    assert_eq!(checkpoint_time(20 * DAY + 8 * HOUR, now), "8:00 AM");
    assert_eq!(checkpoint_time(20 * DAY + noon, now), "12:05 PM");
    assert_eq!(checkpoint_time(19 * DAY + 23 * HOUR, now), "Yesterday");
    // 1970-01-01 + 20 days is January 21.
    assert_eq!(checkpoint_time(17 * DAY, now), "Jan 18");
    assert_eq!(checkpoint_time(60 * DAY, 70 * DAY), "Mar 2");
}

#[test]
fn the_task_is_the_first_line_and_the_meta_counts_files() {
    let mut task = item("a", Some(3), vec![]);
    assert_eq!(checkpoint_task(&task), "Task a");
    task.prompt = Some("\n  \nsecond line".into());
    assert_eq!(checkpoint_task(&task), "second line");
    task.prompt = None;
    assert_eq!(checkpoint_task(&task), "Task");
    assert!(checkpoint_meta(&item("a", Some(1), vec![]), NOW).starts_with("1 file \u{b7} "));
    assert!(checkpoint_meta(&item("a", Some(3), vec![]), NOW).starts_with("3 files \u{b7} "));
    assert!(checkpoint_meta(&item("a", None, vec![]), NOW).starts_with("Interrupted \u{b7} "));
}

#[test]
fn effects_and_paths() {
    assert_eq!(checkpoint_effect(&file("a", Action::Replace, false)), "Revert");
    assert_eq!(checkpoint_effect(&file("a", Action::Delete, false)), "Delete");
    assert_eq!(checkpoint_effect(&file("a", Action::Create, false)), "Restore");
    assert_eq!(split_path("src/auth/login.ts"), ("login.ts", "src/auth"));
    assert_eq!(split_path("login.ts"), ("login.ts", ""));
}

#[test]
fn undoable_tasks_leave_out_the_ones_that_changed_nothing() {
    let items = vec![item("a", Some(2), vec![]), item("b", Some(0), vec![]), item("c", None, vec![])];
    assert_eq!(undoable(&items).iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), vec!["a", "c"]);
}

#[test]
fn the_button_waits_for_every_conflict_and_says_what_it_will_do() {
    let preview =
        item("a", Some(3), vec![file("f1", Action::Replace, false), file("f2", Action::Replace, true), file("f3", Action::Create, false)]);
    let mut decisions = initial_decisions(&preview);
    assert_eq!(decisions.len(), 2, "non-conflicting files start as restore");
    assert_eq!(conflicts(&preview, &decisions), 1);
    assert_eq!(restore_label(Intent::Undo, Some(&preview), &decisions), "Undo 3 files", "every file until the conflicts are answered");
    decisions.insert("f2".into(), Decision::Keep);
    assert_eq!((conflicts(&preview, &decisions), restore_count(&preview, &decisions)), (0, 2));
    assert_eq!(restore_label(Intent::Undo, Some(&preview), &decisions), "Undo 2 files");
    assert_eq!(restore_label(Intent::Redo, Some(&preview), &decisions), "Redo 2 files");
    let lone = item("b", Some(1), vec![file("g", Action::Replace, true)]);
    let mut keep: HashMap<String, Decision> = HashMap::new();
    assert_eq!(restore_label(Intent::Undo, Some(&lone), &keep), "Undo 1 file");
    keep.insert("g".into(), Decision::Keep);
    assert_eq!(restore_label(Intent::Undo, Some(&lone), &keep), "Nothing to undo");
}

type Log = Rc<RefCell<Vec<UndoEvent>>>;

fn panel(intent: Intent, cx: &mut TestAppContext) -> (Entity<UndoPanel>, Log, &mut VisualTestContext) {
    testing::init(cx);
    let (panel, vcx) = cx.add_window_view(|_, cx| UndoPanel::new(intent, fixture(), cx));
    let log: Log = Rc::default();
    let sink = log.clone();
    vcx.update(|window, cx| {
        cx.subscribe(&panel, move |_, event: &UndoEvent, _| sink.borrow_mut().push(event.clone())).detach();
        window.focus(&panel.focus_handle(cx), cx);
    });
    (panel, log, vcx)
}

#[gpui::test]
fn the_list_walks_with_the_arrow_keys_and_enter_previews(cx: &mut TestAppContext) {
    let (panel, log, cx) = panel(Intent::Undo, cx);
    assert_eq!(panel.read_with(cx, |p, _| (p.view(), p.tasks().len(), p.active())), (View::List, 4, 0));
    cx.simulate_keystrokes("down down");
    assert_eq!(panel.read_with(cx, |p, _| p.active()), 2);
    cx.simulate_keystrokes("up up up");
    assert_eq!(panel.read_with(cx, |p, _| p.active()), 3, "wraps");
    assert!(log.borrow().iter().any(|e| matches!(e, UndoEvent::Highlight(Some(7)))), "the task in view highlights its message");
    cx.simulate_keystrokes("enter");
    assert_eq!(panel.read_with(cx, |p, _| (p.view(), p.preview().map(|c| c.id.clone()))), (View::Preview, Some("c1".into())));
    cx.simulate_keystrokes("escape");
    assert_eq!(panel.read_with(cx, |p, _| p.view()), View::List, "Escape in a preview goes back to the list");
    cx.simulate_keystrokes("escape");
    assert_eq!(log.borrow().last(), Some(&UndoEvent::Closed));
}

#[gpui::test]
fn a_conflict_keeps_restore_off_until_it_is_answered(cx: &mut TestAppContext) {
    let (panel, log, cx) = panel(Intent::Undo, cx);
    panel.update(cx, |p, cx| p.inspect("c4", cx));
    cx.run_until_parked();
    assert!(cx.debug_bounds("checkpoint-file-f2").is_some() && cx.debug_bounds("checkpoint-file-f1").is_some());
    assert!(!panel.read_with(cx, |p, _| p.can_restore()), "one file edited after the task has no answer yet");
    panel.update(cx, |p, cx| p.restore(cx));
    assert!(log.borrow().iter().all(|e| !matches!(e, UndoEvent::Restored { .. })), "restore does nothing while it is off");
    panel.update(cx, |p, cx| p.choose("f2", Decision::Keep, cx));
    assert!(panel.read_with(cx, |p, _| p.can_restore()));
    panel.update(cx, |p, cx| p.restore(cx));
    assert!(log.borrow().contains(&UndoEvent::Restored { files: 2 }));
    assert_eq!(log.borrow().last(), Some(&UndoEvent::Closed));
    assert_eq!(panel.read_with(cx, |p, _| p.tasks().len()), 3, "a restored task leaves the list");
}

#[gpui::test]
fn clicking_a_task_previews_it_and_the_chooser_goes_back(cx: &mut TestAppContext) {
    let (panel, _, cx) = panel(Intent::Undo, cx);
    let row = cx.debug_bounds("checkpoint-c3").expect("row");
    cx.simulate_click(row.center(), Modifiers::none());
    assert_eq!(panel.read_with(cx, |p, _| p.view()), View::Preview);
    let chooser = cx.debug_bounds("undo-choose-task").expect("Choose another task");
    cx.simulate_click(chooser.center(), Modifiers::none());
    assert_eq!(panel.read_with(cx, |p, _| p.view()), View::List);
}

#[gpui::test]
fn redo_opens_on_the_preview_and_has_no_chooser(cx: &mut TestAppContext) {
    let (panel, _, cx) = panel(Intent::Redo, cx);
    assert_eq!(panel.read_with(cx, |p, _| p.view()), View::Preview);
    assert!(cx.debug_bounds("undo-choose-task").is_none());
    cx.simulate_keystrokes("escape");
    assert_eq!(panel.read_with(cx, |p, _| p.view()), View::Preview, "Escape closes it: there is no list to go back to");
}

#[gpui::test]
fn slash_undo_takes_the_composers_place(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let chat = workspace.read_with(cx, |w, _| w.chat.clone());
    assert!(cx.debug_bounds("composer").is_some() && cx.debug_bounds("undo-panel").is_none());
    chat.update_in(cx, |chat, window, cx| chat.open_undo(Intent::Undo, window, cx));
    assert!(cx.debug_bounds("undo-panel").is_some());
    assert!(cx.debug_bounds("composer").is_none(), "the panel replaces the composer");
    let panel_bounds = cx.debug_bounds("undo-panel").unwrap();
    assert!(panel_bounds.size.width <= gpui::px(super::transcript::COLUMN_WIDTH));
    cx.simulate_keystrokes("escape");
    assert!(cx.debug_bounds("undo-panel").is_none());
    assert!(cx.debug_bounds("composer").is_some(), "the composer is back");
}

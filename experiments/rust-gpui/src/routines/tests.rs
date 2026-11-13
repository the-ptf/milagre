//! Headless tests of the Routines views: what each page draws, what a click does, and the form's problems.

use gpui::{Modifiers, TestAppContext, VisualTestContext};

use super::editor::RoutineEditor;
use super::model::{LOCAL, Trigger};
use super::{Editing, Kind, RoutinesView, fixture, words};
use crate::testing;

fn mount(cx: &mut TestAppContext) -> (gpui::Entity<RoutinesView>, &mut VisualTestContext) {
    testing::init(cx);
    testing::mount_in_root(cx, RoutinesView::new)
}

fn click(cx: &mut VisualTestContext, selector: &'static str) {
    let bounds = cx.debug_bounds(selector).unwrap_or_else(|| panic!("{selector} is drawn"));
    cx.simulate_click(bounds.center(), Modifiers::none());
}

#[gpui::test]
fn the_list_groups_heartbeats_and_triggers_with_a_row_each(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    for selector in ["routine-group-heartbeats", "routine-group-triggers", "routine-filters", "routine-new"] {
        assert!(cx.debug_bounds(selector).is_some(), "{selector}");
    }
    let count = view.read_with(cx, |view, _| view.routines.len());
    assert_eq!(count, fixture::routines().len());
    for routine in fixture::routines() {
        assert!(cx.debug_bounds(Box::leak(format!("routine-row-{}", routine.id).into_boxed_str())).is_some(), "{}", routine.id);
    }
    // Rows are 56 high, in a 72px status column.
    let row = cx.debug_bounds("routine-row-hb-pr-1013").expect("row");
    assert!(f32::from(row.size.height) >= 56.0);
}

#[gpui::test]
fn a_row_opens_the_routine_page_and_back_returns(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    click(cx, "routine-open-rt-nightly");
    assert_eq!(view.read_with(cx, |v, _| v.open.clone()).as_deref(), Some("rt-nightly"));
    for selector in
        ["routine-page-rt-nightly", "routine-chips", "routine-toolbar", "routine-runs", "routine-run-list", "routine-status-pill"]
    {
        assert!(cx.debug_bounds(selector).is_some(), "{selector}");
    }
    click(cx, "routine-back");
    assert_eq!(view.read_with(cx, |v, _| v.open.clone()), None);
    assert!(cx.debug_bounds("routine-group-triggers").is_some());
}

#[gpui::test]
fn pause_and_resume_change_the_status_column(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    view.update(cx, |v, cx| v.set_enabled("rt-triage", false, cx));
    cx.run_until_parked();
    let status = view.read_with(cx, |v, _| words::routine_status(v.routine("rt-triage").expect("routine"), v.now, &words::ZONE));
    assert_eq!(status, "Paused");
    view.update(cx, |v, cx| v.set_enabled("rt-triage", true, cx));
    assert!(view.read_with(cx, |v, _| v.routine("rt-triage").is_some_and(|r| r.enabled)));
}

#[gpui::test]
fn the_show_filter_narrows_the_list(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    view.update(cx, |v, cx| {
        v.kind = Kind::Triggers;
        cx.notify();
    });
    cx.run_until_parked();
    assert!(cx.debug_bounds("routine-group-heartbeats").is_none());
    assert!(cx.debug_bounds("routine-group-triggers").is_some());
    view.update(cx, |v, cx| {
        v.kind = Kind::Paused;
        cx.notify();
    });
    cx.run_until_parked();
    assert!(cx.debug_bounds("routine-group-heartbeats").is_none());
    assert!(cx.debug_bounds("routine-row-rt-changelog").is_some());
    assert!(cx.debug_bounds("routine-row-rt-triage").is_none());
    view.update(cx, |v, cx| {
        v.kind = Kind::All;
        v.computer = "studio".into();
        cx.notify();
    });
    cx.run_until_parked();
    assert!(cx.debug_bounds("routine-row-rt-triage").is_none());
    assert!(cx.debug_bounds("routine-row-studio:rt-backup").is_some());
    // Another computer's row names it only while every computer is listed.
    assert!(cx.debug_bounds("routine-computer").is_none());
}

#[gpui::test]
fn another_computers_row_names_it(cx: &mut TestAppContext) {
    let (_view, cx) = mount(cx);
    assert!(cx.debug_bounds("routine-computer").is_some());
}

#[gpui::test]
fn delete_asks_first_then_removes_the_row(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    view.update(cx, |v, cx| {
        v.confirming = Some("rt-changelog".into());
        cx.notify();
    });
    cx.run_until_parked();
    assert!(cx.debug_bounds("routine-delete-question").is_some());
    click(cx, "routine-delete-confirm");
    assert!(view.read_with(cx, |v, _| v.routine("rt-changelog").is_none()));
    assert!(cx.debug_bounds("routine-row-rt-changelog").is_none());
}

#[gpui::test]
fn an_empty_list_shows_the_empty_state(cx: &mut TestAppContext) {
    testing::init(cx);
    let (_view, cx) = testing::mount_in_root(cx, |_, _| RoutinesView::with_routines(Vec::new(), super::model::fixture_now()));
    assert!(cx.debug_bounds("empty-state").is_some());
    assert!(cx.debug_bounds("routine-filters").is_none());
    assert!(cx.debug_bounds("routine-new").is_some());
}

#[gpui::test]
fn flow_rows_say_where_they_stand(cx: &mut TestAppContext) {
    let (_view, cx) = mount(cx);
    assert!(cx.debug_bounds("routine-flow-chip").is_some());
    assert!(cx.debug_bounds("routine-waiting").is_some());
    assert!(cx.debug_bounds("routine-unread").is_some());
    assert!(cx.debug_bounds("routine-problem").is_some());
}

#[gpui::test]
fn the_runs_list_folds_quiet_runs_and_expands_them(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    view.update(cx, |v, cx| v.open_page("hb-chimes", cx));
    cx.run_until_parked();
    // Today holds a fold of two quiet runs, an acted Run, and a fold under it.
    assert!(cx.debug_bounds("routine-run-hb-chimes-6").is_some());
    assert!(cx.debug_bounds("routine-fold-hb-chimes-7").is_some());
    assert!(cx.debug_bounds("routine-run-hb-chimes-9").is_none());
    click(cx, "routine-fold-hb-chimes-7");
    assert!(cx.debug_bounds("routine-run-hb-chimes-9").is_some());
}

#[gpui::test]
fn older_days_are_one_summary_line_until_opened(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    view.update(cx, |v, cx| v.open_page("rt-nightly", cx));
    cx.run_until_parked();
    assert!(cx.debug_bounds("routine-run-day-summary-Mon, Nov 9").is_some());
    assert!(cx.debug_bounds("routine-run-rt-nightly-7").is_none());
    click(cx, "routine-run-day-summary-Mon, Nov 9");
    assert!(cx.debug_bounds("routine-fold-rt-nightly-7").is_some());
}

#[gpui::test]
fn a_run_opens_its_chat_beside_the_page_which_narrows(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    view.update(cx, |v, cx| v.open_page("rt-nightly", cx));
    cx.run_until_parked();
    let wide = cx.debug_bounds("routine-page-rt-nightly").expect("page").size.width;
    click(cx, "routine-run-rt-nightly-9");
    assert!(view.read_with(cx, |v, _| v.run_pane_open()));
    for selector in ["routine-split", "run-chat-pane", "run-chat-header", "run-chat-meta"] {
        assert!(cx.debug_bounds(selector).is_some(), "{selector}");
    }
    let narrow = cx.debug_bounds("routine-page-rt-nightly").expect("page").size.width;
    assert!(narrow < wide);
    // Opening it read the Chat: its dot is gone.
    assert!(view.read_with(cx, |v, _| !v.unread_chats.contains(fixture::NIGHTLY_RUN_CHAT)));
    click(cx, "run-chat-close");
    assert!(!view.read_with(cx, |v, _| v.run_pane_open()));
}

#[gpui::test]
fn run_now_adds_a_running_run_and_edit_closes_the_pane(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    view.update(cx, |v, cx| v.open_page("rt-nightly", cx));
    let before = view.read_with(cx, |v, _| v.routine("rt-nightly").map(|r| r.runs.len()));
    click(cx, "routine-run-now");
    let after = view.read_with(cx, |v, _| v.routine("rt-nightly").map(|r| r.runs.len()));
    assert_eq!(after, before.map(|n| n + 1));
    click(cx, "routine-run-rt-nightly-9");
    click(cx, "routine-edit");
    assert!(view.read_with(cx, |v, _| v.run_chat.is_none() && v.editing.is_some()));
    assert!(cx.debug_bounds("routine-form").is_some());
}

#[gpui::test]
fn new_routine_opens_the_form_and_save_names_the_missing_field(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    click(cx, "routine-new");
    assert_eq!(view.read_with(cx, |v, _| v.editing.clone()), Some(Editing::New));
    for selector in ["routine-form", "routine-chips", "routine-prompt-hint", "routine-runs-placeholder"] {
        assert!(cx.debug_bounds(selector).is_some(), "{selector}");
    }
    let editor = view.read_with(cx, |v, _| v.editor.clone()).expect("editor");
    editor.update(cx, |editor, cx| editor.save(cx));
    cx.run_until_parked();
    assert_eq!(editor.read_with(cx, |e, _| e.errors.get(&super::form::Field::Name).cloned()).as_deref(), Some("Give the Routine a name"));
    assert!(cx.debug_bounds("routine-error").is_some());
}

fn open_editor(view: &gpui::Entity<RoutinesView>, editing: Editing, cx: &mut VisualTestContext) -> gpui::Entity<RoutineEditor> {
    cx.update(|window, cx| view.update(cx, |v, cx| v.start_editor(Some(editing), window, cx)));
    cx.run_until_parked();
    view.read_with(cx, |v, _| v.editor.clone()).expect("editor")
}

#[gpui::test]
fn creating_a_routine_opens_its_page(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    let editor = open_editor(&view, Editing::New, cx);
    cx.update(|window, cx| editor.update(cx, |e, cx| e.type_into("Weekly digest", "Summarise the week.", window, cx)));
    editor.update(cx, |e, cx| e.save(cx));
    cx.run_until_parked();
    let (open, editing, count) = view.read_with(cx, |v, _| (v.open.clone(), v.editing.clone(), v.routines.len()));
    assert_eq!((open.as_deref(), editing, count), (Some("rt-new-1"), None, fixture::routines().len() + 1));
    let made = view.read_with(cx, |v, _| v.routine("rt-new-1").cloned()).expect("created");
    assert_eq!((made.name.as_str(), made.computer.as_str()), ("Weekly digest", LOCAL));
    assert!(matches!(made.trigger, Trigger::Schedule { .. }));
    assert!(cx.debug_bounds("routine-page-rt-new-1").is_some());
}

#[gpui::test]
fn saving_an_edit_changes_the_routine(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    let editor = open_editor(&view, Editing::Routine("rt-triage".into()), cx);
    cx.update(|window, cx| editor.update(cx, |e, cx| e.type_into("Triage everything", "Go.", window, cx)));
    editor.update(cx, |e, cx| e.save(cx));
    cx.run_until_parked();
    let routine = view.read_with(cx, |v, _| v.routine("rt-triage").cloned()).expect("routine");
    assert_eq!((routine.name.as_str(), routine.prompt.as_str()), ("Triage everything", "Go."));
    assert!(view.read_with(cx, |v, _| v.editing.is_none()));
}

#[gpui::test]
fn cancel_with_changes_asks_to_discard(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    let editor = open_editor(&view, Editing::Routine("rt-triage".into()), cx);
    // Nothing changed: Cancel leaves at once.
    click(cx, "routine-cancel");
    assert!(view.read_with(cx, |v, _| v.editing.is_none()));
    let editor2 = open_editor(&view, Editing::Routine("rt-triage".into()), cx);
    drop(editor);
    cx.update(|window, cx| editor2.update(cx, |e, cx| e.type_into("Other name", "Go.", window, cx)));
    click(cx, "routine-cancel");
    assert!(cx.debug_bounds("routine-discard").is_some());
    click(cx, "routine-discard-keep");
    assert!(cx.debug_bounds("routine-discard").is_none());
    click(cx, "routine-cancel");
    click(cx, "routine-discard-confirm");
    assert!(view.read_with(cx, |v, _| v.editing.is_none()));
    assert_eq!(view.read_with(cx, |v, _| v.routine("rt-triage").map(|r| r.name.clone())).as_deref(), Some("Triage new issues"));
}

#[gpui::test]
fn the_webhook_form_shows_its_url_and_signing_rows(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    open_editor(&view, Editing::Routine("rt-sentry".into()), cx);
    assert!(cx.debug_bounds("routine-webhook").is_some());
    assert!(cx.debug_bounds("routine-hook-copy").is_some());
    assert!(cx.debug_bounds("routine-check-signature").is_some());
    assert!(cx.debug_bounds("routine-delete").is_some());
}

#[gpui::test]
fn typing_braces_lists_placeholders_and_enter_inserts(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    let editor = open_editor(&view, Editing::New, cx);
    let prompt = editor.read_with(cx, |e, _| e.prompt_field());
    cx.update(|window, cx| prompt.update(cx, |p, cx| p.type_text("At {{ti", window, cx)));
    cx.run_until_parked();
    assert!(cx.debug_bounds("routine-placeholders").is_some());
    assert!(cx.debug_bounds("routine-placeholder-time").is_some());
    assert!(cx.debug_bounds("routine-placeholder-date").is_none());
    click(cx, "routine-placeholder-time");
    assert_eq!(prompt.read_with(cx, |p, cx| p.value(cx)), "At {{time}}");
    assert!(cx.debug_bounds("routine-placeholders").is_none());
}

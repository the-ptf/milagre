//! The activity fold and the tool rows in the transcript: folding, opening a row, every kind drawn, the clip on
//! long console output, and that a click re-measures only its own item.

use gpui::{Entity, Modifiers, TestAppContext, VisualTestContext};

use crate::data::{StepKind, StepStatus};
use crate::logic::lists::chat_display::ToolCallDisplay;
use crate::testing::{self, leak};
use crate::workspace::chat::fixture::{self, NOW};
use crate::workspace::chat::transcript::{Activity, Entry, Item, Prose, StepItem, Transcript};

fn mount(cx: &mut TestAppContext, items: Vec<Item>) -> (Entity<Transcript>, &mut VisualTestContext) {
    let (transcript, cx) = testing::mount_in_root(cx, move |_, cx| Transcript::with_items(items, cx));
    cx.run_until_parked();
    cx.update(|window, cx| {
        let _ = window.draw(cx);
    });
    (transcript, cx)
}

fn click(cx: &mut VisualTestContext, selector: &'static str) {
    let at = testing::bounds(cx, selector).center();
    cx.simulate_click(at, Modifiers::none());
    cx.run_until_parked();
}

fn reply() -> Vec<Item> {
    let entries = fixture::every_kind().into_iter().map(Entry::Step).collect();
    vec![Item::User("go".into()), Item::Activity(Activity::new(entries, NOW)), Item::Prose(Prose::new("Done."))]
}

#[gpui::test]
fn a_finished_reply_is_one_folded_line_that_opens_and_folds_on_click(cx: &mut TestAppContext) {
    let (transcript, cx) = mount(cx, reply());
    assert!(cx.debug_bounds("activity-line").is_some(), "the summary line is drawn");
    assert!(cx.debug_bounds("activity-body").is_none(), "folded by default (Compact)");
    let marks = testing::bounds(cx, "activity-marks");
    assert_eq!(marks.size.width, gpui::px(20.0 + 3.0 * 14.0), "four marks, 6px overlap, never more than four");
    let before = transcript.read_with(cx, |t, _| t.list_state().item_count());

    click(cx, "activity-line");
    assert!(cx.debug_bounds("activity-body").is_some(), "a click opens the steps");
    // Every kind of row the app draws has a row of its own.
    for n in 0..fixture::every_kind().len() {
        assert!(cx.debug_bounds(leak(format!("step-row-1-{n}"))).is_some(), "row {n} is drawn");
    }
    assert_eq!(transcript.read_with(cx, |t, _| t.list_state().item_count()), before, "a fold is one item however many rows");

    click(cx, "activity-line");
    assert!(cx.debug_bounds("activity-body").is_none(), "a second click folds it");
}

#[gpui::test]
fn opening_a_fold_re_measures_only_that_item(cx: &mut TestAppContext) {
    let (_, cx) = mount(cx, reply());
    let height = |cx: &mut VisualTestContext, ix: usize| cx.debug_bounds(leak(format!("transcript-item-{ix}"))).map(|b| b.size.height);
    let (fold_before, prose_before) = (height(cx, 1), height(cx, 2));
    click(cx, "activity-line");
    let (fold, prose) = (height(cx, 1), height(cx, 2));
    assert!(fold > fold_before, "the fold item grew to hold its rows ({fold:?} vs {fold_before:?})");
    assert_eq!(prose, prose_before, "the neighbour kept its height");
}

#[gpui::test]
fn a_row_with_output_opens_to_its_detail_and_a_plain_read_does_not(cx: &mut TestAppContext) {
    let (transcript, cx) = mount(cx, reply());
    click(cx, "activity-line");
    // The edit (row 3) opens to its diff placeholder; the read (row 1) has nothing to open.
    assert!(cx.debug_bounds("step-diff-placeholder").is_none());
    click(cx, "step-row-1-3");
    assert!(cx.debug_bounds("step-diff-placeholder").is_some(), "the edit's detail names the diff view");
    assert!(transcript.read_with(cx, |t, _| t.step_open(1, "k-edit")));
    click(cx, "step-row-1-3");
    assert!(cx.debug_bounds("step-diff-placeholder").is_none(), "a second click closes it");
    click(cx, "step-row-1-1");
    assert!(!transcript.read_with(cx, |t, _| t.step_open(1, "k-read")), "a read with no detail does not open");
}

#[gpui::test]
fn long_console_output_shows_its_last_forty_lines_until_asked(cx: &mut TestAppContext) {
    let mut step = fixture::every_kind().remove(5);
    let log: String = (0..100).map(|n| format!("line {n}\n")).collect();
    step.detail = Some(format!("$ npm test\n{log}").into());
    step.input = Some("npm test".into());
    let (_, cx) = mount(cx, vec![Item::Step(StepItem::new(step, NOW))]);
    click(cx, "step-row-0-0");
    assert!(cx.debug_bounds("step-show-all").is_some(), "100 lines are clipped");
    click(cx, "step-show-all");
    assert!(cx.debug_bounds("step-show-all").is_none(), "asked for, the whole output shows");
}

#[gpui::test]
fn a_lone_step_has_no_fold_and_full_detail_skips_it(cx: &mut TestAppContext) {
    let one = vec![Item::Activity(Activity::new(vec![Entry::Step(fixture::every_kind().remove(5))], NOW))];
    let (_, cx) = mount(cx, one);
    assert!(cx.debug_bounds("activity-line").is_none());
    assert!(cx.debug_bounds("step-row-0-0").is_some(), "its row stands alone");

    let (transcript, cx) = mount(cx, reply());
    transcript.update(cx, |t, cx| t.set_display(ToolCallDisplay::Full, false, cx));
    cx.run_until_parked();
    cx.update(|window, cx| {
        let _ = window.draw(cx);
    });
    assert!(cx.debug_bounds("activity-line").is_none(), "Full detail draws every call as its own row");
    assert!(cx.debug_bounds("step-row-1-0").is_some());
}

#[gpui::test]
fn a_running_step_shows_its_title_in_the_present_tense_and_a_streaming_line_says_working(cx: &mut TestAppContext) {
    let running = fixture::activity_demo().pop().expect("the demo ends with the running step");
    let Item::Step(StepItem { step, .. }) = &running else { panic!("a standalone step") };
    assert_eq!(step.status, StepStatus::Running);
    assert_eq!(super::transcript::summary::step_display_title(step, true), "Running `npm run typecheck`");
    let mut streaming = Activity::new(vec![Entry::Step(step.clone()), Entry::Step(fixture::every_kind().remove(1))], NOW);
    streaming.streaming = true;
    let (_, cx) = mount(cx, vec![running, Item::Activity(streaming)]);
    assert!(cx.debug_bounds("step-row-0-0").is_some());
    assert!(cx.debug_bounds("activity-line").is_some(), "the streaming fold keeps its line, naming the running call");
}

#[test]
fn the_fixture_has_one_row_of_every_kind_the_app_draws_in_a_fold() {
    let kinds: Vec<_> = fixture::every_kind().iter().filter_map(|s| s.kind).collect();
    for kind in [StepKind::Thinking, StepKind::Read, StepKind::Search, StepKind::Edit, StepKind::Shell, StepKind::Other] {
        assert!(kinds.contains(&kind), "{kind:?}");
    }
}

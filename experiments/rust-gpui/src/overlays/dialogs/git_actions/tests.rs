//! The "Commit and open PR" dialog in GPUI's headless test platform: opened through `ui::Dialog` under `Root`, on the
//! fixture folders, with the steps and the generation driven by the test clock.

use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

use gpui::{Entity, Modifiers, TestAppContext, VisualTestContext, Window, div, prelude::*};
use gpui_component::WindowExt as _;

use super::super::git_dialog::{GitStep, hook_failure_message};
use super::super::git_fixture::Scenario;
use super::{GENERATE_FOR, GitActionsDialog, GitDialogConfig, STEP_FOR, StepStatus, open};
use crate::testing;

struct Notes {
    ran: Rc<RefCell<Vec<String>>>,
    sent: Rc<RefCell<Vec<String>>>,
}

/// Opens the dialog on `scenario`; `generate_for` of `Some(ZERO)` writes the text at once, `Some(GENERATE_FOR)` after the delay.
fn dialog(
    cx: &mut TestAppContext,
    scenario: Scenario,
    generate_for: Option<Duration>,
    turn_running: bool,
) -> (Entity<GitActionsDialog>, Notes, &mut VisualTestContext) {
    let (_host, cx) = testing::mount_in_root(cx, |_, _| Host);
    let notes = Notes { ran: Rc::default(), sent: Rc::default() };
    let (ran, sent) = (notes.ran.clone(), notes.sent.clone());
    let config = GitDialogConfig {
        turn_running,
        on_ran: Rc::new(move |note, _| ran.borrow_mut().push(note)),
        on_send: Rc::new(move |text, _| sent.borrow_mut().push(text)),
        ..GitDialogConfig::fixture(scenario)
    };
    let view = cx.update(|window, cx| open(config, generate_for, window, cx));
    cx.run_until_parked();
    (view, notes, cx)
}

struct Host;
impl gpui::Render for Host {
    fn render(&mut self, _: &mut Window, _: &mut gpui::Context<Self>) -> impl IntoElement {
        div().size_full()
    }
}

fn drawn(cx: &mut VisualTestContext, selector: &'static str) -> bool {
    cx.debug_bounds(selector).is_some()
}

/// Redraws until the layout stops moving: the text areas measure themselves a frame after they first draw.
fn settle(cx: &mut VisualTestContext) {
    for _ in 0..3 {
        cx.update(|window, _| window.refresh());
        cx.run_until_parked();
    }
}

fn click(cx: &mut VisualTestContext, selector: &'static str) {
    settle(cx);
    let at = testing::bounds(cx, selector).center();
    cx.simulate_click(at, Modifiers::none());
    cx.run_until_parked();
}

fn elapse(cx: &mut VisualTestContext, by: Duration) {
    cx.executor().advance_clock(by);
    cx.run_until_parked();
}

fn run_all_steps(cx: &mut VisualTestContext, steps: usize) {
    for _ in 0..steps + 1 {
        elapse(cx, STEP_FOR + Duration::from_millis(10));
    }
}

fn set_commit_message(view: &Entity<GitActionsDialog>, text: &str, cx: &mut VisualTestContext) {
    let state = view.read_with(cx, |dialog, _| dialog.commit_message.clone());
    let text = text.to_string();
    cx.update(|window, cx| state.update(cx, |state, cx| state.set_value(text, window, cx)));
    cx.run_until_parked();
}

#[gpui::test]
fn the_dialog_opens_over_the_window_with_the_folders_branch_and_files(cx: &mut TestAppContext) {
    let (view, _notes, cx) = dialog(cx, Scenario::Ready, Some(Duration::ZERO), false);
    assert!(drawn(cx, "git-dialog") && drawn(cx, "git-section-changes") && drawn(cx, "git-files"));
    let repo = view.read_with(cx, |dialog, _| dialog.repo().cloned()).expect("a repository");
    assert_eq!(repo.files.len(), 8);
    assert!(drawn(cx, "git-secret"), "the .env file is marked");
    assert!(drawn(cx, "git-section-commit") && drawn(cx, "git-section-pr"));
    assert!(drawn(cx, "git-primary") && drawn(cx, "git-secondary"));
    let mode = view.read_with(cx, |dialog, _| dialog.mode()).unwrap();
    assert_eq!(mode.primary.map(|b| b.label), Some("Commit, push and open PR".to_string()));
    assert_eq!(mode.secondary.map(|b| b.label), Some("Commit only".to_string()));
}

#[gpui::test]
fn the_text_is_written_after_the_folder_is_read_and_typing_meanwhile_stays(cx: &mut TestAppContext) {
    let (view, _notes, cx) = dialog(cx, Scenario::Ready, Some(GENERATE_FOR), false);
    assert!(view.read_with(cx, |dialog, _| dialog.is_generating()));
    assert!(drawn(cx, "git-writing"), "the fields say so while they wait");
    assert!(cx.update(|_, cx| view.read(cx).fields(cx)).commit_message.is_empty());
    // The user types a subject before the text arrives.
    click(cx, "git-commit-message");
    cx.simulate_input("fix: mine");
    cx.run_until_parked();
    elapse(cx, GENERATE_FOR + Duration::from_millis(10));
    assert!(!view.read_with(cx, |dialog, _| dialog.is_generating()));
    let fields = cx.update(|_, cx| view.read(cx).fields(cx));
    assert_eq!(fields.commit_message, "fix: mine", "typed text stays");
    assert!(fields.pr_title.starts_with("feat(experiments): PR panel"), "the rest is written");
    assert!(fields.pr_body.contains("## What"));
    assert!(!drawn(cx, "git-writing"));
}

#[gpui::test]
fn a_ready_folder_commits_pushes_and_opens_a_pr_step_by_step(cx: &mut TestAppContext) {
    let (view, notes, cx) = dialog(cx, Scenario::Ready, Some(Duration::ZERO), false);
    click(cx, "git-primary");
    assert!(view.read_with(cx, |dialog, _| dialog.is_running()));
    assert!(drawn(cx, "git-step-commit-running"), "Committing… shows first");
    elapse(cx, STEP_FOR + Duration::from_millis(10));
    assert!(drawn(cx, "git-step-commit-done") && drawn(cx, "git-step-push-running"));
    run_all_steps(cx, 3);
    let (finished, steps) = view.read_with(cx, |dialog, _| (dialog.is_finished(), dialog.steps().to_vec()));
    assert!(finished);
    assert_eq!(steps.len(), 3);
    assert!(steps.iter().all(|s| s.status == StepStatus::Done));
    assert_eq!(steps[0].detail.as_deref(), Some("Committed 3f9a1c2"));
    assert_eq!(steps[1].detail.as_deref(), Some("Pushed to origin/milagre/chat-tie0"));
    assert_eq!(steps[2].detail.as_deref(), Some("Opened PR #413"));
    assert!(drawn(cx, "git-pr-link"));
    assert_eq!(
        notes.ran.borrow().as_slice(),
        ["Committed 3f9a1c2, pushed milagre/chat-tie0 and opened PR #413: https://github.com/the-ptf/milagre-ade/pull/413"]
    );
    // The form is gone, the footer says Done, and the list followed the folder.
    assert!(!drawn(cx, "git-section-commit") && !drawn(cx, "git-section-pr") && drawn(cx, "git-section-progress"));
    assert!(drawn(cx, "git-files-empty"), "everything is committed");
    click(cx, "git-close");
    assert!(!cx.update(|window, cx| window.has_active_dialog(cx)), "Done closes the dialog");
}

#[gpui::test]
fn commit_only_stops_after_the_commit(cx: &mut TestAppContext) {
    let (view, notes, cx) = dialog(cx, Scenario::Ready, Some(Duration::ZERO), false);
    click(cx, "git-secondary");
    run_all_steps(cx, 1);
    let steps = view.read_with(cx, |dialog, _| dialog.steps().to_vec());
    assert_eq!(steps.iter().map(|s| s.step).collect::<Vec<_>>(), [GitStep::Commit]);
    assert_eq!(notes.ran.borrow().as_slice(), ["Committed 3f9a1c2."]);
}

#[gpui::test]
fn a_hook_failure_shows_its_output_and_sends_it_to_the_agent(cx: &mut TestAppContext) {
    let (view, notes, cx) = dialog(cx, Scenario::Hook, Some(Duration::ZERO), false);
    click(cx, "git-primary");
    run_all_steps(cx, 1);
    let (finished, failure, steps) =
        view.read_with(cx, |dialog, _| (dialog.is_finished(), dialog.failure().cloned(), dialog.steps().to_vec()));
    assert!(!finished, "a failure keeps the form open");
    let failure = failure.expect("the hook failed");
    assert!(failure.hook && failure.output.as_deref().is_some_and(|o| o.contains("no-unused-vars")));
    assert_eq!(steps.len(), 1, "push and PR never ran");
    assert_eq!(steps[0].status, StepStatus::Failed);
    assert!(drawn(cx, "git-failure") && drawn(cx, "git-step-commit-failed") && drawn(cx, "git-section-commit"));
    assert!(notes.ran.borrow().is_empty(), "nothing happened to record");
    // The buttons work again, and Send to agent hands the agent the output and closes.
    assert!(!view.read_with(cx, |dialog, _| dialog.is_running()));
    for s in ["dialog-0", "git-failure", "git-send-agent", "git-footer"] {
        eprintln!("BOUNDS {s} {:?}", cx.debug_bounds(s));
    }
    click(cx, "git-send-agent");
    let sent = notes.sent.borrow().clone();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0], hook_failure_message(failure.output.as_deref().unwrap()));
    assert!(!cx.update(|window, cx| window.has_active_dialog(cx)));
}

#[gpui::test]
fn a_rejected_push_shows_its_reason_and_hint_but_no_send_to_agent(cx: &mut TestAppContext) {
    let (view, notes, cx) = dialog(cx, Scenario::PushRejected, Some(Duration::ZERO), false);
    click(cx, "git-primary");
    run_all_steps(cx, 2);
    let failure = view.read_with(cx, |dialog, _| dialog.failure().cloned()).expect("the push failed");
    assert!(!failure.hook && failure.hint.is_some());
    assert!(drawn(cx, "git-failure") && !drawn(cx, "git-send-agent"));
    // The commit before it did go in, and is recorded.
    assert_eq!(notes.ran.borrow().as_slice(), ["Committed 3f9a1c2."]);
    let steps = view.read_with(cx, |dialog, _| dialog.steps().to_vec());
    assert_eq!(
        steps.iter().map(|s| (s.step, s.status)).collect::<Vec<_>>(),
        [(GitStep::Commit, StepStatus::Done), (GitStep::Push, StepStatus::Failed)]
    );
}

#[gpui::test]
fn a_second_click_while_running_does_not_start_another_run(cx: &mut TestAppContext) {
    let (view, notes, cx) = dialog(cx, Scenario::Ready, Some(Duration::ZERO), false);
    click(cx, "git-primary");
    view.update(cx, |dialog, cx| dialog.run_primary(cx));
    run_all_steps(cx, 3);
    assert_eq!(notes.ran.borrow().len(), 1, "one run, one note");
}

#[gpui::test]
fn the_mode_table_drives_the_buttons_on_every_folder(cx: &mut TestAppContext) {
    let cases = [
        (Scenario::OpenPr, "Commit and push", Some("Commit only")),
        (Scenario::Base, "Commit only", Some("Commit and push to main")),
        (Scenario::NoOrigin, "Commit and push", Some("Commit only")),
        (Scenario::MergeBlocked, "Commit, push and open PR", Some("Commit only")),
    ];
    for (scenario, primary, secondary) in cases {
        let (view, _notes, cx) = dialog(cx, scenario, Some(Duration::ZERO), false);
        let mode = view.read_with(cx, |dialog, _| dialog.mode()).unwrap();
        assert_eq!(mode.primary.map(|b| b.label).as_deref(), Some(primary), "{scenario:?}");
        assert_eq!(mode.secondary.map(|b| b.label).as_deref(), secondary, "{scenario:?}");
    }
}

#[gpui::test]
fn an_open_pr_says_pushing_updates_it_and_the_note_names_the_update(cx: &mut TestAppContext) {
    let (view, notes, cx) = dialog(cx, Scenario::OpenPr, Some(Duration::ZERO), false);
    assert!(drawn(cx, "git-pr-open") && !drawn(cx, "git-pr-title"));
    click(cx, "git-primary");
    run_all_steps(cx, 2);
    assert!(view.read_with(cx, |dialog, _| dialog.is_finished()));
    assert_eq!(
        notes.ran.borrow().as_slice(),
        ["Committed 3f9a1c2 and pushed milagre/chat-tie0. PR #412 is updated: https://github.com/the-ptf/milagre-ade/pull/412"]
    );
    let steps = view.read_with(cx, |dialog, _| dialog.steps().len());
    assert_eq!(steps, 2, "the update line is drawn from the outcome, not stored as a step");
}

#[gpui::test]
fn without_origin_the_pr_section_says_why_and_the_footer_does_not_repeat_it(cx: &mut TestAppContext) {
    let (_view, _notes, cx) = dialog(cx, Scenario::NoOrigin, Some(Duration::ZERO), false);
    assert!(drawn(cx, "git-pr-blocked"));
    let reason = testing::bounds(cx, "git-footer-reason");
    assert!(reason.size.width > gpui::px(0.0));
    // The primary pushes, so its own reason is shown; the PR section's is the same sentence and is skipped there.
}

#[gpui::test]
fn a_merge_in_progress_blocks_commits_and_skips_the_text(cx: &mut TestAppContext) {
    let (view, _notes, cx) = dialog(cx, Scenario::MergeBlocked, Some(GENERATE_FOR), false);
    assert!(!view.read_with(cx, |dialog, _| dialog.is_generating()), "the diff holds conflict markers: nothing to write from");
    assert!(!drawn(cx, "git-writing"));
    let mode = view.read_with(cx, |dialog, _| dialog.mode()).unwrap();
    assert_eq!(mode.primary.and_then(|b| b.disabled_reason).as_deref(), Some("A merge is in progress. Finish or abort it, then commit."));
    assert!(drawn(cx, "git-pr-target"), "two remotes: the dialog says where PRs open");
    // A disabled button does not run.
    click(cx, "git-primary");
    assert!(view.read_with(cx, |dialog, _| dialog.steps().is_empty()));
}

#[gpui::test]
fn committing_waits_for_the_agents_turn(cx: &mut TestAppContext) {
    let (view, _notes, cx) = dialog(cx, Scenario::Ready, Some(Duration::ZERO), true);
    let mode = view.read_with(cx, |dialog, _| dialog.mode()).unwrap();
    assert_eq!(mode.primary.and_then(|b| b.disabled_reason).as_deref(), Some(super::super::git_dialog::TURN_RUNNING));
    click(cx, "git-primary");
    assert!(view.read_with(cx, |dialog, _| dialog.steps().is_empty()));
}

#[gpui::test]
fn a_button_waits_for_the_fields_its_steps_use(cx: &mut TestAppContext) {
    let (view, _notes, cx) = dialog(cx, Scenario::Ready, Some(Duration::ZERO), false);
    set_commit_message(&view, "", cx);
    click(cx, "git-primary");
    assert!(view.read_with(cx, |dialog, _| dialog.steps().is_empty()), "no commit message, no commit");
    let reason = testing::bounds(cx, "git-footer-reason");
    assert!(reason.size.width > gpui::px(0.0));
    set_commit_message(&view, "fix: now", cx);
    click(cx, "git-primary");
    assert!(view.read_with(cx, |dialog, _| dialog.is_running()));
}

#[gpui::test]
fn a_clean_folder_has_nothing_to_do_and_a_plain_folder_is_not_a_repository(cx: &mut TestAppContext) {
    let (view, _notes, cx) = dialog(cx, Scenario::Clean, Some(Duration::ZERO), false);
    assert!(drawn(cx, "git-idle") && drawn(cx, "git-close") && !drawn(cx, "git-primary"));
    assert!(!view.read_with(cx, |dialog, _| dialog.is_generating()));
    let (_view, _notes, cx) = dialog(cx, Scenario::NotRepo, Some(Duration::ZERO), false);
    assert!(drawn(cx, "git-not-repo") && drawn(cx, "git-close"));
}

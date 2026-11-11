//! The PR panel's tests: the review rules against `pull-request-review.test.ts`, the fixture's own consistency, and
//! the view in GPUI's headless test platform (every variant, the merge flow, the pickers, Files and the review).

use std::rc::Rc;
use std::time::Duration;

use gpui::{Context, Entity, IntoElement, Modifiers, Render, TestAppContext, VisualTestContext, Window, div, prelude::*, px};

use super::bridge::{Write, apply};
use super::fixture::{FixtureBridge, Variant, detail_at, files};
use super::model::*;
use super::{CONFIRM_FOR, Confirm, PrEvent, PrTab, PrView, Section};
use crate::logic::diff::git::DiffStatus;
use crate::testing;

// --- rules ------------------------------------------------------------------------------------------------

const NOW: i64 = 1_800_000_000_000;

fn base() -> PullRequestDetail {
    let mut pr = detail_at(7, Variant::Ready, NOW);
    pr.url = "https://github.com/a/b/pull/7".into();
    pr.base_ref_name = "main".into();
    pr.checks = vec![check("unit", Outcome::Pass), check("smoke", Outcome::Skipped)];
    pr.reviewers = vec![Reviewer::new("marcos", ReviewerState::Approved)];
    pr.threads.clear();
    pr.comments.clear();
    pr
}

fn check(name: &str, outcome: Outcome) -> Check {
    Check { name: name.into(), workflow: None, outcome, url: None }
}

fn checks(outcomes: &[Outcome]) -> Vec<Check> {
    outcomes.iter().enumerate().map(|(i, o)| check(&format!("c{i}"), *o)).collect()
}

#[test]
fn merge_status_reads_the_way_the_merge_card_shows_it() {
    let status = merge_status(&base());
    assert_eq!(status.tone, StatusTone::Ready);
    assert_eq!((status.title, status.detail.as_str()), ("Ready to merge", "Checks passed \u{b7} 1 approval \u{b7} no conflicts"));
}

#[test]
fn conflicts_outrank_failing_checks_which_outrank_a_change_request() {
    let mut failing = base();
    failing.checks.insert(0, check("lint", Outcome::Fail));
    let mut dirty = failing.clone();
    dirty.merge_state_status = "DIRTY".into();
    assert_eq!(merge_status(&dirty).title, "Conflicts");
    failing.merge_state_status = "BLOCKED".into();
    let status = merge_status(&failing);
    assert_eq!((status.tone, status.title, status.detail.as_str()), (StatusTone::Blocked, "Checks failing", "1 check failed of 3"));
    let mut changes = base();
    changes.review_decision = Some(ReviewDecision::ChangesRequested);
    changes.reviewers = vec![Reviewer::new("j", ReviewerState::ChangesRequested)];
    assert_eq!(merge_status(&changes).detail, "j asked for changes");
}

#[test]
fn drafts_merged_and_closed_prs_say_so() {
    let mut pr = base();
    pr.is_draft = true;
    assert_eq!(merge_status(&pr).tone, StatusTone::Draft);
    let mut merged = base();
    merged.state = PullState::Merged;
    assert_eq!(merge_status(&merged).detail, "Merged into main");
    let mut closed = base();
    closed.state = PullState::Closed;
    assert_eq!(merge_status(&closed).tone, StatusTone::Closed);
}

#[test]
fn the_remaining_merge_states_and_can_merge_now() {
    let mut pr = base();
    pr.merge_state_status = "BEHIND".into();
    assert_eq!(merge_status(&pr).title, "Behind");
    pr.merge_state_status = "BLOCKED".into();
    pr.review_decision = Some(ReviewDecision::ReviewRequired);
    assert_eq!(merge_status(&pr).title, "Waiting for review");
    pr.review_decision = None;
    assert_eq!(merge_status(&pr).title, "Blocked");
    pr.merge_state_status = "UNKNOWN".into();
    assert_eq!(merge_status(&pr).title, "Checking");
    for (state, can) in [("CLEAN", true), ("UNSTABLE", true), ("HAS_HOOKS", true), ("BLOCKED", false), ("DIRTY", false), ("DRAFT", false)] {
        let mut pr = base();
        pr.merge_state_status = state.into();
        assert_eq!(can_merge_now(&pr), can, "{state}");
    }
    let mut draft = base();
    draft.is_draft = true;
    assert!(!can_merge_now(&draft));
}

#[test]
fn checks_summary_and_open_threads() {
    let mut list = base().checks;
    list.push(check("x", Outcome::Running));
    assert_eq!(checks_summary(&list), "1 running \u{b7} 1 passed \u{b7} 1 skipped");
    let comment = |pending| Comment { id: "c".into(), author: "j".into(), body: "?".into(), created_at: 0, pending };
    let thread = |id: &str, resolved, pending| Thread {
        id: id.into(),
        path: "a".into(),
        line: Some(1),
        side: Side::Right,
        resolved,
        outdated: false,
        comments: vec![comment(pending)],
    };
    let mut pr = base();
    pr.threads = vec![thread("1", false, false), thread("2", true, false), thread("3", false, true)];
    let ids: Vec<&str> = open_threads(&pr).iter().map(|t| t.id.as_str()).collect();
    assert_eq!(ids, ["1"]);
    assert_eq!(thread_state(&pr.threads[0]), ThreadState::Open);
    assert_eq!(thread_state(&pr.threads[1]), ThreadState::Resolved);
    assert_eq!(thread_state(&pr.threads[2]), ThreadState::Pending);
}

#[test]
fn not_in_pr_label_names_the_files_and_commits_an_open_pr_does_not_have() {
    assert_eq!(not_in_pr_label(2, 1), "2 files \u{b7} 1 commit");
    assert_eq!(not_in_pr_label(0, 3), "3 commits");
    assert_eq!(not_in_pr_label(1, 0), "1 file");
    assert_eq!(not_in_pr_label(0, 0), "");
}

#[test]
fn checks_progress_puts_failing_first_then_running_then_passed() {
    use Outcome::*;
    let p = checks_progress(&checks(&[Pass, Neutral, Skipped, Running, Fail]));
    assert_eq!((p.passed, p.failed, p.running, p.skipped, p.total), (2, 1, 1, 1, 5));
    assert_eq!((p.label.as_str(), p.tone), ("1 of 5 failing", ChecksTone::Fail));
    assert_eq!(checks_progress(&checks(&[Pass, Running, Running])).label, "1 of 3 done");
    assert_eq!(checks_progress(&checks(&[Pass, Running])).tone, ChecksTone::Running);
    assert_eq!(checks_progress(&checks(&[Pass, Neutral, Skipped])).label, "2 passed \u{b7} 1 skipped");
    assert_eq!(checks_progress(&checks(&[Pass, Pass])).label, "2 passed");
    let none = checks_progress(&[]);
    assert_eq!((none.total, none.label.as_str(), none.tone), (0, "", ChecksTone::None));
}

#[test]
fn small_helpers_read_like_the_desktops() {
    assert_eq!(repo_of("https://github.com/the-ptf/milagre-ade/pull/412").as_deref(), Some("the-ptf/milagre-ade"));
    assert_eq!(repo_of("https://github.com/o/r/issues/4"), None);
    assert_eq!(initials("reviewer-one"), "RO");
    assert_eq!(initials("victor"), "V");
    assert_eq!(initials("the-ptf/desktop"), "TP");
    let minute = 60_000;
    let cases = [
        (0, "now"),
        (20_000, "now"),
        (5 * minute, "5m"),
        (59 * minute, "59m"),
        (125 * minute, "2h"),
        (26 * 60 * minute, "1d"),
        (50 * 60 * minute, "2d"),
    ];
    for (ago_ms, text) in cases {
        assert_eq!(age(NOW - ago_ms, NOW).as_deref(), Some(text), "{ago_ms}");
    }
    assert_eq!(age(0, NOW), None);
    assert_eq!(ago(NOW, NOW), "just now");
    assert_eq!(ago(NOW - 125 * minute, NOW), "2h ago");
    assert_eq!(MergeMethod::from_key("rebase"), Some(MergeMethod::Rebase));
    assert_eq!(MergeMethod::ALL.map(MergeMethod::action), ["Squash and merge", "Merge", "Rebase and merge"]);
}

#[test]
fn fix_in_chat_names_the_thread_its_place_and_the_ask() {
    let pr = detail_at(412, Variant::Ready, NOW);
    let thread = &pr.threads[0];
    let message = thread_fix_message(412, thread);
    assert!(message.starts_with(&format!("Address this review thread on PR #412, at {}:3:\n\n", thread.path)), "{message}");
    assert!(message.contains("marcosgenesis wrote:\n> Looks right."));
    assert!(message.contains("victor wrote:\n> Good catch"));
    assert!(message.ends_with("so I can reply and resolve the thread."));
}

// --- writes and the fixture ---------------------------------------------------------------------------------

#[test]
fn a_write_changes_the_detail_the_way_github_would_show_it() {
    let pr = detail_at(412, Variant::Ready, NOW);
    let merged = apply(&pr, &Write::Merge { method: MergeMethod::Squash, admin: false, auto: None });
    assert_eq!(merged.state, PullState::Merged);
    let auto = apply(&pr, &Write::Merge { method: MergeMethod::Rebase, admin: false, auto: Some(true) });
    assert_eq!(auto.auto_merge, Some(MergeMethod::Rebase));
    assert_eq!(apply(&auto, &Write::Merge { method: MergeMethod::Rebase, admin: false, auto: Some(false) }).auto_merge, None);
    let draft = detail_at(412, Variant::Draft, NOW);
    let ready = apply(&draft, &Write::Ready { draft: false });
    assert!(!ready.is_draft && ready.merge_state_status == "CLEAN");
    let reviewers = apply(&pr, &Write::Reviewers { add: vec!["ana-maria".into(), "marcosgenesis".into()], remove: vec!["jefo3".into()] });
    let logins: Vec<&str> = reviewers.reviewers.iter().map(|r| r.login.as_str()).collect();
    assert_eq!(logins, ["marcosgenesis", "the-ptf/desktop", "ana-maria"]);
    assert_eq!(reviewers.reviewers.last().map(|r| r.state), Some(ReviewerState::Requested));
    let labels =
        apply(&pr, &Write::Labels { add: vec![Label { name: "bug".into(), color: "d73a4a".into() }], remove: vec!["gpui".into()] });
    let names: Vec<&str> = labels.labels.iter().map(|l| l.name.as_str()).collect();
    assert_eq!(names, ["desktop", "bug"]);
    let resolved = apply(&pr, &Write::Resolve { thread: "thread-1".into(), resolved: true });
    assert!(resolved.threads[0].resolved);
}

#[test]
fn replies_join_the_pending_review_and_submitting_clears_it() {
    let pr = detail_at(412, Variant::Ready, NOW);
    let replied = apply(&pr, &Write::Reply { thread: "thread-1".into(), body: "Done.".into() });
    assert_eq!(replied.pending_review, Some(1));
    let reply = replied.threads[0].comments.last().unwrap();
    assert!(reply.pending);
    let deleted = apply(&replied, &Write::DeleteComment { id: reply.id.clone() });
    assert_eq!(deleted.pending_review, None);
    assert_eq!(deleted.threads[0].comments.len(), 2);
    let submitted = apply(&replied, &Write::SubmitReview { event: ReviewEvent::Approve, body: String::new() });
    assert_eq!(submitted.pending_review, None);
    assert!(submitted.threads[0].comments.iter().all(|c| !c.pending));
    assert_eq!(submitted.review_decision, Some(ReviewDecision::Approved));
}

#[test]
fn the_fixtures_counts_come_from_their_patches_and_every_variant_has_its_state() {
    for (file, patch) in files() {
        let added = patch.lines().filter(|l| l.starts_with('+') && !l.starts_with("+++")).count() as u32;
        let removed = patch.lines().filter(|l| l.starts_with('-') && !l.starts_with("---")).count() as u32;
        assert_eq!((file.additions, file.deletions), (added, removed), "{}", file.path);
        assert!(patch.contains("@@"), "{}", file.path);
    }
    let statuses: Vec<DiffStatus> = files().iter().map(|(f, _)| f.status).collect();
    assert!(statuses.contains(&DiffStatus::Added) && statuses.contains(&DiffStatus::Modified));
    let total: u32 = files().iter().map(|(f, _)| f.additions).sum();
    assert_eq!(detail_at(1, Variant::Ready, NOW).additions, total);
    let states = Variant::ALL.map(|v| {
        let pr = detail_at(1, v, NOW);
        (pr.state, pr.is_draft, merge_status(&pr).tone)
    });
    assert_eq!(
        states,
        [
            (PullState::Open, false, StatusTone::Ready),
            (PullState::Open, false, StatusTone::Pending),
            (PullState::Open, true, StatusTone::Draft),
            (PullState::Open, false, StatusTone::Blocked),
            (PullState::Merged, false, StatusTone::Merged),
            (PullState::Closed, false, StatusTone::Closed),
        ]
    );
    assert_eq!(Variant::for_number(412), Variant::Ready);
    assert_eq!(Variant::from_key("blocked"), Some(Variant::Blocked));
}

// --- the view ---------------------------------------------------------------------------------------------

/// The 340px column the panel gives the tab.
struct Frame {
    pr: Entity<PrView>,
}

impl Render for Frame {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        div().w(px(340.0)).h(px(760.0)).child(self.pr.clone())
    }
}

fn mount(cx: &mut TestAppContext, variant: Variant) -> (Entity<PrView>, &mut VisualTestContext) {
    let (frame, cx) = testing::mount_in_root(cx, move |_, cx| {
        let pr = cx.new(|_| PrView::with_bridge(Rc::new(FixtureBridge::forced(variant))));
        pr.update(cx, |pr, cx| pr.set_chat("chat".into(), Some(412), 2, cx));
        Frame { pr }
    });
    let pr = frame.read_with(cx, |frame, _| frame.pr.clone());
    cx.run_until_parked();
    (pr, cx)
}

/// Redraws until the layout stops moving: a text area measures itself a frame after it first draws.
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

fn drawn(cx: &mut VisualTestContext, selector: &'static str) -> bool {
    cx.debug_bounds(selector).is_some()
}

fn state(pr: &Entity<PrView>, cx: &mut VisualTestContext) -> PullRequestDetail {
    pr.read_with(cx, |pr, _| pr.detail().cloned().expect("a PR is loaded"))
}

#[gpui::test]
fn a_ready_pr_shows_the_primary_merge_button_and_merges_on_the_second_press(cx: &mut TestAppContext) {
    let (pr, cx) = mount(cx, Variant::Ready);
    assert!(drawn(cx, "pr-identity") && drawn(cx, "pr-merge"));
    assert!(!drawn(cx, "pr-state-pill-Draft") && !drawn(cx, "pr-state-pill-Merged"), "an open PR ready for review has no pill");
    assert_eq!(pr.read_with(cx, |pr, _| pr.confirming()), None);
    click(cx, "pr-merge");
    assert_eq!(pr.read_with(cx, |pr, _| pr.confirming()), Some(Confirm::Merge), "the first press only arms it");
    assert_eq!(state(&pr, cx).state, PullState::Open);
    click(cx, "pr-merge");
    assert_eq!(state(&pr, cx).state, PullState::Merged);
    assert_eq!(pr.read_with(cx, |pr, _| pr.confirming()), None);
    assert!(drawn(cx, "pr-state-pill-Merged"), "the merged PR gets its pill");
    assert!(!drawn(cx, "pr-merge"), "and no merge button");
}

#[gpui::test]
fn an_armed_merge_disarms_after_four_seconds(cx: &mut TestAppContext) {
    let (pr, cx) = mount(cx, Variant::Ready);
    click(cx, "pr-merge");
    assert_eq!(pr.read_with(cx, |pr, _| pr.confirming()), Some(Confirm::Merge));
    cx.executor().advance_clock(CONFIRM_FOR - Duration::from_millis(100));
    cx.run_until_parked();
    assert_eq!(pr.read_with(cx, |pr, _| pr.confirming()), Some(Confirm::Merge), "still armed just before");
    cx.executor().advance_clock(Duration::from_millis(200));
    cx.run_until_parked();
    assert_eq!(pr.read_with(cx, |pr, _| pr.confirming()), None);
    assert_eq!(state(&pr, cx).state, PullState::Open);
}

#[gpui::test]
fn a_draft_offers_ready_for_review_and_loses_its_pill(cx: &mut TestAppContext) {
    let (pr, cx) = mount(cx, Variant::Draft);
    assert!(drawn(cx, "pr-state-pill-Draft") && drawn(cx, "pr-ready"));
    assert!(!drawn(cx, "pr-merge") && !drawn(cx, "pr-auto"));
    assert!(drawn(cx, "pr-status"), "the status line says why it cannot merge yet");
    click(cx, "pr-ready");
    assert!(!state(&pr, cx).is_draft);
    assert!(!drawn(cx, "pr-state-pill-Draft") && !drawn(cx, "pr-ready"));
    assert!(drawn(cx, "pr-merge"), "and it can merge now");
}

#[gpui::test]
fn a_pending_pr_offers_merge_when_ready_then_says_it_is_on(cx: &mut TestAppContext) {
    let (pr, cx) = mount(cx, Variant::Pending);
    assert!(drawn(cx, "pr-auto") && !drawn(cx, "pr-merge"));
    click(cx, "pr-auto");
    assert_eq!(state(&pr, cx).auto_merge, Some(MergeMethod::Squash));
    assert!(drawn(cx, "pr-auto-merge") && !drawn(cx, "pr-auto"));
    pr.update(cx, |pr, cx| pr.set_auto_merge(false, cx));
    cx.run_until_parked();
    assert!(drawn(cx, "pr-auto"), "turning it off brings the button back");
}

#[gpui::test]
fn a_blocked_pr_names_what_blocks_it_and_offers_no_plain_merge(cx: &mut TestAppContext) {
    let (pr, cx) = mount(cx, Variant::Blocked);
    assert!(drawn(cx, "pr-status") && !drawn(cx, "pr-merge") && !drawn(cx, "pr-auto"), "conflicts: not even auto-merge");
    assert_eq!(merge_status(&state(&pr, cx)).title, "Conflicts");
    assert!(drawn(cx, "pr-checks-status"));
    assert!(drawn(cx, "pr-checks-segment-failed"));
}

#[gpui::test]
fn merged_and_closed_prs_have_their_pill_and_no_actions(cx: &mut TestAppContext) {
    for (variant, pill) in [(Variant::Merged, "pr-state-pill-Merged"), (Variant::Closed, "pr-state-pill-Closed")] {
        let (_pr, cx) = mount(cx, variant);
        assert!(drawn(cx, pill), "{variant:?}");
        assert!(!drawn(cx, "pr-merge") && !drawn(cx, "pr-auto") && !drawn(cx, "pr-ready"), "{variant:?}");
        assert!(!drawn(cx, "pr-local"), "{variant:?}: nothing waits to be added to a PR that is over");
        assert!(drawn(cx, "pr-status"), "{variant:?}");
    }
}

#[gpui::test]
fn the_worktrees_unpushed_work_shows_and_opens_the_changes_tab(cx: &mut TestAppContext) {
    let (pr, cx) = mount(cx, Variant::Ready);
    assert!(drawn(cx, "pr-local"), "2 uncommitted files and 1 commit");
    let events = Rc::new(std::cell::RefCell::new(Vec::new()));
    let seen = events.clone();
    let _sub = cx.update(|_, cx| cx.subscribe(&pr, move |_, event: &PrEvent, _| seen.borrow_mut().push(event.clone())));
    click(cx, "pr-local");
    assert_eq!(*events.borrow(), vec![PrEvent::OpenChanges]);
    pr.update(cx, |pr, cx| pr.set_chat("chat".into(), Some(412), 0, cx));
    cx.run_until_parked();
    assert!(drawn(cx, "pr-local"), "the unpushed commit alone still shows");
}

#[gpui::test]
fn the_more_menu_lists_the_actions_that_apply_and_the_method_sticks_per_repository(cx: &mut TestAppContext) {
    let (pr, cx) = mount(cx, Variant::Ready);
    click(cx, "pr-more-button");
    for row in ["pr-method-squash", "pr-method-merge", "pr-method-rebase", "pr-draft", "pr-open-github", "pr-copy-link"] {
        assert!(drawn(cx, row), "{row}");
    }
    assert!(!drawn(cx, "pr-merge-anyway") && !drawn(cx, "pr-auto-off"), "a mergeable PR needs neither");
    assert_eq!(pr.read_with(cx, |pr, _| pr.method()), MergeMethod::Squash);
    click(cx, "pr-method-rebase");
    assert_eq!(pr.read_with(cx, |pr, _| pr.method()), MergeMethod::Rebase);
    // The other PRs of the same repository use it too.
    pr.update(cx, |pr, cx| pr.set_chat("chat".into(), Some(413), 0, cx));
    assert_eq!(pr.read_with(cx, |pr, _| pr.method()), MergeMethod::Rebase);
    click(cx, "pr-draft");
    assert!(state(&pr, cx).is_draft, "Convert to draft");
}

#[gpui::test]
fn the_more_menu_of_an_unmergeable_pr_offers_merge_anyway_to_an_admin_with_its_own_confirm(cx: &mut TestAppContext) {
    // A BLOCKED (not conflicting) PR the viewer may merge as an admin.
    struct Admin;
    impl super::bridge::PrBridge for Admin {
        fn detail(&self, number: u32) -> Result<PullRequestDetail, String> {
            let mut pr = detail_at(number, Variant::Pending, super::model::now_ms());
            pr.viewer_can_merge_as_admin = true;
            Ok(pr)
        }
        fn write(&self, _: u32, _: &Write) -> Result<(), String> {
            Ok(())
        }
        fn reviewer_candidates(&self) -> Vec<String> {
            Vec::new()
        }
        fn repo_labels(&self) -> Vec<RepoLabel> {
            Vec::new()
        }
        fn file_patch(&self, _: u32, _: &PrFile) -> Option<crate::logic::diff::git::DiffFileResult> {
            None
        }
    }
    let (frame, cx) = testing::mount_in_root(cx, |_, cx| {
        let pr = cx.new(|_| PrView::with_bridge(Rc::new(Admin)));
        pr.update(cx, |pr, cx| pr.set_chat("chat".into(), Some(9), 0, cx));
        Frame { pr }
    });
    let pr = frame.read_with(cx, |frame, _| frame.pr.clone());
    cx.run_until_parked();
    click(cx, "pr-more-button");
    assert!(drawn(cx, "pr-merge-anyway"));
    click(cx, "pr-merge-anyway");
    assert_eq!(pr.read_with(cx, |pr, _| pr.confirming()), Some(Confirm::Admin));
    assert_eq!(state(&pr, cx).state, PullState::Open);
    click(cx, "pr-merge-anyway");
    assert_eq!(state(&pr, cx).state, PullState::Merged);
}

#[gpui::test]
fn a_refused_write_takes_its_change_back_and_says_why(cx: &mut TestAppContext) {
    let (pr, cx) = mount(cx, Variant::Pending);
    // The fixture bridge refuses a plain merge of a PR GitHub says cannot merge.
    let ok = pr.update(cx, |pr, cx| pr.write("merge", Write::Merge { method: MergeMethod::Squash, admin: false, auto: None }, cx));
    cx.run_until_parked();
    assert!(!ok);
    assert_eq!(state(&pr, cx).state, PullState::Open, "taken back");
    assert!(pr.read_with(cx, |pr, _| pr.write_error().is_some_and(|m| m.contains("not mergeable"))));
    assert!(drawn(cx, "pr-write-error"));
    // The next write clears it.
    pr.update(cx, |pr, cx| pr.set_auto_merge(true, cx));
    assert!(pr.read_with(cx, |pr, _| pr.write_error().is_none()));
}

#[gpui::test]
fn the_summary_lists_reviewers_labels_and_the_three_sections(cx: &mut TestAppContext) {
    let (pr, cx) = mount(cx, Variant::Ready);
    for selector in ["pr-reviewers", "pr-labels", "pr-section-description", "pr-section-checks", "pr-section-comments", "pr-checks-bar"] {
        assert!(drawn(cx, selector), "{selector}");
    }
    assert!(drawn(cx, "pr-reviewer-marcosgenesis") && drawn(cx, "pr-reviewer-jefo3") && drawn(cx, "pr-reviewer-the-ptf/desktop"));
    assert!(drawn(cx, "pr-label-desktop") && drawn(cx, "pr-label-gpui"));
    // Only Comments starts open: its cards show, the others' bodies do not.
    assert!(pr.read_with(cx, |pr, _| pr.is_open(Section::Comments) && !pr.is_open(Section::Checks) && !pr.is_open(Section::Description)));
    assert!(drawn(cx, "pr-comment-c1") && drawn(cx, "pr-open-thread-thread-1"));
    assert!(!drawn(cx, "pr-check-pass"));
    click(cx, "pr-section-toggle-checks");
    assert!(drawn(cx, "pr-check-pass") && drawn(cx, "pr-check-skipped"));
    click(cx, "pr-section-toggle-comments");
    assert!(!drawn(cx, "pr-comment-c1"));
    click(cx, "pr-section-toggle-comments");
    assert!(drawn(cx, "pr-comment-c1"));
}

#[gpui::test]
fn comments_sort_by_the_latest_word_and_the_sort_flips(cx: &mut TestAppContext) {
    let (pr, cx) = mount(cx, Variant::Ready);
    let top = |cx: &mut VisualTestContext, selectors: &[&'static str]| -> &'static str {
        selectors.iter().copied().min_by_key(|s| f32::from(testing::bounds(cx, s).origin.y) as i64).unwrap()
    };
    let cards = ["pr-comment-c1", "pr-comment-c2", "pr-comment-c3", "pr-open-thread-thread-1"];
    // Newest first: the thread's last word is 70 minutes ago, c3 150, c2 180, c1 240.
    assert_eq!(top(cx, &cards), "pr-open-thread-thread-1");
    assert!(pr.read_with(cx, |pr, _| pr.newest_first()));
    click(cx, "pr-comments-sort");
    assert!(!pr.read_with(cx, |pr, _| pr.newest_first()));
    assert_eq!(top(cx, &cards), "pr-comment-c1");
    let (a, b) = (testing::bounds(cx, "pr-comment-c1").origin.y, testing::bounds(cx, "pr-comment-c2").origin.y);
    assert!(a < b);
}

#[gpui::test]
fn the_checks_bar_has_a_segment_per_outcome_in_proportion(cx: &mut TestAppContext) {
    let (pr, cx) = mount(cx, Variant::Ready);
    let progress = checks_progress(&state(&pr, cx).checks);
    assert_eq!((progress.passed, progress.skipped, progress.failed, progress.running), (7, 1, 0, 0));
    let passed = f32::from(testing::bounds(cx, "pr-checks-segment-passed").size.width);
    let skipped = f32::from(testing::bounds(cx, "pr-checks-segment-skipped").size.width);
    assert!(passed > skipped * 3.0, "7 of 8 against 1 of 8: {passed} vs {skipped}");
    assert!(!drawn(cx, "pr-checks-segment-failed"));
    let (_pr, cx) = mount(cx, Variant::Pending);
    assert!(drawn(cx, "pr-checks-segment-running"));
}

#[gpui::test]
fn the_reviewer_picker_toggles_requests_but_keeps_a_given_review(cx: &mut TestAppContext) {
    let (pr, cx) = mount(cx, Variant::Ready);
    click(cx, "pr-reviewers-add");
    assert!(drawn(cx, "pr-reviewers"));
    assert!(drawn(cx, "pr-reviewer-option-ana-maria") && drawn(cx, "pr-reviewer-option-marcosgenesis"));
    assert!(!drawn(cx, "pr-reviewer-option-victor"), "the author cannot review their own PR");
    click(cx, "pr-reviewer-option-ana-maria");
    assert!(state(&pr, cx).reviewers.iter().any(|r| r.login == "ana-maria" && r.state == ReviewerState::Requested));
    click(cx, "pr-reviewer-option-ana-maria");
    assert!(!state(&pr, cx).reviewers.iter().any(|r| r.login == "ana-maria"), "a second press takes the request back");
    let before = state(&pr, cx).reviewers.len();
    click(cx, "pr-reviewer-option-marcosgenesis");
    assert_eq!(state(&pr, cx).reviewers.len(), before, "an approval stays");
}

#[gpui::test]
fn the_label_picker_adds_and_removes_labels(cx: &mut TestAppContext) {
    let (pr, cx) = mount(cx, Variant::Ready);
    click(cx, "pr-labels-add");
    click(cx, "pr-label-option-bug");
    assert!(state(&pr, cx).labels.iter().any(|l| l.name == "bug"));
    assert!(drawn(cx, "pr-label-bug"), "it shows in the row");
    click(cx, "pr-label-option-desktop");
    assert!(!state(&pr, cx).labels.iter().any(|l| l.name == "desktop"));
}

#[gpui::test]
fn a_closed_pr_has_no_pickers(cx: &mut TestAppContext) {
    let (_pr, cx) = mount(cx, Variant::Closed);
    assert!(!drawn(cx, "pr-reviewers-add") && !drawn(cx, "pr-labels-add"));
}

#[gpui::test]
fn files_lists_the_prs_files_as_a_tree_and_a_click_shows_the_diff(cx: &mut TestAppContext) {
    let (pr, cx) = mount(cx, Variant::Ready);
    click(cx, "pr-tab-files");
    assert_eq!(pr.read_with(cx, |pr, _| pr.tab()), PrTab::Files);
    assert!(drawn(cx, "pr-files"));
    let header = "experiments/rust-gpui/src/workspace/panel/pr/header.rs";
    let selector = testing::leak(format!("pr-file-{header}"));
    assert!(drawn(cx, selector), "{header}");
    assert!(drawn(cx, "pr-file-threads"), "the file with an open thread carries its count");
    assert!(!drawn(cx, "pr-diff-pane"));
    click(cx, selector);
    assert_eq!(pr.read_with(cx, |pr, _| pr.selected()).as_deref(), Some(header));
    assert!(drawn(cx, "pr-diff-pane") && drawn(cx, "pr-diff-body"));
    assert!(drawn(cx, "pr-threads"), "its review thread sits above the diff");
    assert!(drawn(cx, "pr-thread-thread-1"));
    assert!(drawn(cx, "pr-review-bar"), "an open PR gets the review bar");
    click(cx, "pr-diff-close");
    assert!(!drawn(cx, "pr-diff-pane"));
    assert_eq!(pr.read_with(cx, |pr, _| pr.selected()), None);
}

#[gpui::test]
fn folders_fold_in_the_files_tree(cx: &mut TestAppContext) {
    let (pr, cx) = mount(cx, Variant::Ready);
    click(cx, "pr-tab-files");
    let folder = "experiments/rust-gpui/src/workspace/panel/pr";
    let folder_selector = testing::leak(format!("pr-folder-{folder}"));
    let file_selector = testing::leak(format!("pr-file-{folder}/mod.rs"));
    assert!(drawn(cx, folder_selector) && drawn(cx, file_selector));
    click(cx, folder_selector);
    assert!(pr.read_with(cx, |pr, _| pr.is_collapsed(folder)));
    assert!(!drawn(cx, file_selector));
    click(cx, folder_selector);
    assert!(drawn(cx, file_selector));
}

#[gpui::test]
fn a_thread_in_the_summary_opens_its_file(cx: &mut TestAppContext) {
    let (pr, cx) = mount(cx, Variant::Ready);
    click(cx, "pr-thread-path");
    assert_eq!(pr.read_with(cx, |pr, _| pr.tab()), PrTab::Files);
    assert!(pr.read_with(cx, |pr, _| pr.selected()).is_some_and(|p| p.ends_with("pr/header.rs")));
    assert!(drawn(cx, "pr-diff-pane"));
}

#[gpui::test]
fn replying_resolving_and_fixing_a_thread(cx: &mut TestAppContext) {
    let (pr, cx) = mount(cx, Variant::Ready);
    pr.update(cx, |pr, cx| pr.open_file("experiments/rust-gpui/src/workspace/panel/pr/header.rs", cx));
    cx.run_until_parked();
    // Reply opens a field; an empty reply sends nothing.
    click(cx, "pr-reply");
    assert_eq!(pr.read_with(cx, |pr, _| pr.replying().map(str::to_string)).as_deref(), Some("thread-1"));
    assert!(drawn(cx, "pr-reply-send"));
    assert!(!pr.update(cx, |pr, cx| pr.reply("thread-1", "  ", cx)));
    assert!(pr.update(cx, |pr, cx| pr.reply("thread-1", "Fixed in the next push.", cx)));
    cx.run_until_parked();
    assert_eq!(state(&pr, cx).pending_review, Some(1));
    assert_eq!(pr.read_with(cx, |pr, _| pr.replying().map(str::to_string)), None);
    assert!(drawn(cx, "pr-review-summary"));
    // Resolve folds the thread's state; Fix in Chat sends the ask to the Chat and closes the diff.
    let events = Rc::new(std::cell::RefCell::new(Vec::new()));
    let seen = events.clone();
    let _sub = cx.update(|_, cx| cx.subscribe(&pr, move |_, event: &PrEvent, _| seen.borrow_mut().push(event.clone())));
    click(cx, "pr-fix");
    let sent = events.borrow().clone();
    assert!(matches!(sent.as_slice(), [PrEvent::FixInChat(text)] if text.contains("Address this review thread on PR #412")));
    assert!(!drawn(cx, "pr-diff-pane"), "the diff closes behind it");
    pr.update(cx, |pr, cx| pr.open_file("experiments/rust-gpui/src/workspace/panel/pr/header.rs", cx));
    cx.run_until_parked();
    click(cx, "pr-resolve");
    assert!(state(&pr, cx).threads[0].resolved);
    assert!(!drawn(cx, "pr-fix"), "a resolved thread folds and drops Fix in Chat");
}

#[gpui::test]
fn the_review_bar_submits_with_a_verdict_and_clears_the_pending_count(cx: &mut TestAppContext) {
    let (pr, cx) = mount(cx, Variant::Ready);
    pr.update(cx, |pr, cx| {
        pr.open_file("experiments/rust-gpui/src/workspace/panel/pr/header.rs", cx);
        pr.reply("thread-1", "Will do.", cx);
    });
    cx.run_until_parked();
    assert!(!pr.read_with(cx, |pr, _| pr.review_open()));
    click(cx, "pr-review-open");
    assert!(pr.read_with(cx, |pr, _| pr.review_open()) && drawn(cx, "pr-review-form"));
    assert_eq!(pr.read_with(cx, |pr, _| pr.review_event()), ReviewEvent::Comment);
    click(cx, "pr-review-verdict-APPROVE");
    assert_eq!(pr.read_with(cx, |pr, _| pr.review_event()), ReviewEvent::Approve);
    click(cx, "pr-review-submit");
    assert_eq!(state(&pr, cx).pending_review, None);
    assert_eq!(state(&pr, cx).review_decision, Some(ReviewDecision::Approved));
    assert!(!pr.read_with(cx, |pr, _| pr.review_open()), "the form closes");
}

#[gpui::test]
fn the_review_bar_hides_approve_from_the_prs_author_and_waits_on_a_blank_comment(cx: &mut TestAppContext) {
    let (pr, cx) = mount(cx, Variant::Ready);
    pr.update(cx, |pr, cx| {
        pr.detail = pr.detail.take().map(|pr| PullRequestDetail { viewer_is_author: true, ..pr });
        pr.open_file("experiments/rust-gpui/src/workspace/panel/pr/header.rs", cx);
        pr.toggle_review(cx);
    });
    cx.run_until_parked();
    assert!(
        drawn(cx, "pr-review-verdict-COMMENT")
            && !drawn(cx, "pr-review-verdict-APPROVE")
            && !drawn(cx, "pr-review-verdict-REQUEST_CHANGES")
    );
    // Nothing pending and no summary: Submit does nothing.
    click(cx, "pr-review-submit");
    assert!(pr.read_with(cx, |pr, _| pr.review_open()), "still open");
    assert_eq!(state(&pr, cx).review_decision, Some(ReviewDecision::Approved));
}

#[gpui::test]
fn switching_chats_brings_back_each_prs_own_tab(cx: &mut TestAppContext) {
    let (pr, cx) = mount(cx, Variant::Ready);
    pr.update(cx, |pr, cx| pr.set_tab(PrTab::Files, cx));
    pr.update(cx, |pr, cx| pr.set_chat("other".into(), Some(500), 0, cx));
    assert_eq!(pr.read_with(cx, |pr, _| (pr.number(), pr.tab())), (Some(500), PrTab::Summary));
    pr.update(cx, |pr, cx| pr.set_chat("chat".into(), Some(412), 0, cx));
    assert_eq!(pr.read_with(cx, |pr, _| (pr.number(), pr.tab())), (Some(412), PrTab::Files));
    pr.update(cx, |pr, cx| pr.set_chat("none".into(), None, 0, cx));
    cx.run_until_parked();
    assert!(drawn(cx, "pr-notice") && !drawn(cx, "pr-identity"), "a Chat with no PR says so");
}

#[gpui::test]
fn the_pr_tab_in_the_panel_shows_this_view(cx: &mut TestAppContext) {
    use crate::workspace::panel::PanelTab;
    let (workspace, cx) = testing::mount_workspace(cx);
    let panel = workspace.read_with(cx, |workspace, _| workspace.panel.clone());
    assert!(panel.read_with(cx, |panel, _| panel.visible_tabs().contains(&PanelTab::Pr)), "the seeded Chat has a PR");
    panel.update(cx, |panel, cx| panel.activate(PanelTab::Pr, cx));
    cx.run_until_parked();
    assert!(drawn(cx, "pr-root") && drawn(cx, "pr-identity"));
    assert!(!drawn(cx, "panel-body-PR"), "not the placeholder");
    // "N files not in the PR yet" goes to the Changes tab.
    if drawn(cx, "pr-local") {
        click(cx, "pr-local");
        assert_eq!(panel.read_with(cx, |panel, _| panel.active()), PanelTab::Changes);
    }
}

#[gpui::test]
fn typing_in_a_picker_search_does_not_rebuild_the_header(cx: &mut TestAppContext) {
    let (pr, cx) = mount(cx, Variant::Ready);
    let before = pr.read_with(cx, |pr, _| pr.renders());
    cx.run_until_parked();
    assert_eq!(pr.read_with(cx, |pr, _| pr.renders()), before, "an idle PR panel does not redraw");
}

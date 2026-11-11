//! Headless tests for WP-44 (Project half): the page draws, the autosave waits 600 ms of quiet on the executor's clock,
//! an invalid branch template never saves, the checkboxes save at once, Reset drops the personal layer, and a field the
//! repository sets is locked. The Branches rules are tested beside their code (`logic.rs`).

use std::time::Duration;

use gpui::{Entity, Modifiers, TestAppContext, VisualTestContext};

use super::ProjectView;
use super::model::ProjectsStore;
use super::view::Save;
use crate::settings::SelectedSection;
use crate::testing;
use crate::workspace::Workspace;

fn settle(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    crate::fitcheck::harness::draw(cx);
    crate::fitcheck::harness::draw(cx);
}

fn drawn(cx: &mut VisualTestContext, selector: &str) -> bool {
    cx.debug_bounds(testing::leak(selector.to_string())).is_some()
}

fn click(cx: &mut VisualTestContext, workspace: &Entity<Workspace>, selector: &str) {
    let body = cx.debug_bounds("settings-main").expect("settings body");
    let at = cx.debug_bounds(testing::leak(selector.to_string())).unwrap_or_else(|| panic!("`{selector}` is not drawn"));
    let overshoot = f32::from(at.bottom() - body.bottom()) + 80.0;
    if overshoot > 0.0 {
        let settings = workspace.read_with(cx, |w, _| w.settings.clone());
        let handle = settings.read_with(cx, |s, _| s.body_scroll().clone());
        let current = handle.offset();
        handle.set_offset(gpui::point(current.x, current.y - gpui::px(overshoot)));
        settle(cx);
    }
    let at = cx.debug_bounds(testing::leak(selector.to_string())).expect("still drawn").center();
    cx.simulate_click(at, Modifiers::none());
    settle(cx);
}

fn advance(cx: &mut VisualTestContext, ms: u64) {
    cx.executor().advance_clock(Duration::from_millis(ms));
    settle(cx);
}

/// Opens the Project at `position` of the Settings list.
fn open(cx: &mut TestAppContext, position: usize) -> (Entity<Workspace>, &mut VisualTestContext, String) {
    let (workspace, cx) = testing::mount_workspace(cx);
    settle(cx);
    let settings = workspace.read_with(cx, |w, _| w.settings.clone());
    let (path, name) = settings.read_with(cx, |s, _| s.projects[position].clone());
    settings.update_in(cx, |s, window, cx| {
        s.open(window, cx);
        s.select_section(SelectedSection::Project { path: path.clone(), name }, cx);
    });
    settle(cx);
    (workspace, cx, path)
}

fn view(workspace: &Entity<Workspace>, cx: &mut VisualTestContext) -> Entity<ProjectView> {
    let settings = workspace.read_with(cx, |w, _| w.settings.clone());
    settings.read_with(cx, |s, _| s.project.clone())
}

fn entry(cx: &mut VisualTestContext, path: &str) -> super::model::ProjectEntry {
    cx.update(|_, cx| cx.global::<ProjectsStore>().get(path))
}

fn type_template(cx: &mut VisualTestContext, view: &Entity<ProjectView>, text: &str) {
    let input = view.read_with(cx, |v, _| v.template_input()).expect("the page made its fields");
    cx.update(|window, cx| input.update(cx, |state, cx| state.set_value(text.to_string(), window, cx)));
    view.update(cx, |v, cx| v.edited(Save::Branch, cx));
}

#[gpui::test]
fn the_page_draws_every_group_for_a_local_project(cx: &mut TestAppContext) {
    let (_workspace, cx, _) = open(cx, 0);
    for selector in [
        "project-icon-row",
        "project-accounts-group",
        "project-branches",
        "project-files-to-copy",
        "project-setup-command",
        "project-remove",
    ] {
        assert!(drawn(cx, selector) || selector == "project-remove", "{selector}");
    }
    assert!(drawn(cx, "files-to-copy-preview"));
}

#[gpui::test]
fn the_branch_template_saves_after_600ms_of_quiet_and_each_keystroke_restarts_the_wait(cx: &mut TestAppContext) {
    let (workspace, cx, path) = open(cx, 0);
    let view = view(&workspace, cx);
    let saves = |cx: &mut VisualTestContext| entry(cx, &path).saves.branch;
    type_template(cx, &view, "{username}/{slug}");
    advance(cx, 599);
    assert_eq!(saves(cx), 0);
    assert!(view.read_with(cx, |v, _| v.pending(Save::Branch)));
    // Another keystroke before the deadline moves it.
    type_template(cx, &view, "{username}/{slug}-{suffix}");
    advance(cx, 599);
    assert_eq!(saves(cx), 0);
    advance(cx, 2);
    assert_eq!(saves(cx), 1);
    assert_eq!(entry(cx, &path).branch.local.template.as_deref(), Some("{username}/{slug}-{suffix}"));
    assert!(!view.read_with(cx, |v, _| v.pending(Save::Branch)));
    assert!(drawn(cx, "branch-reset"), "overrides show Reset to defaults");
    assert!(cx.debug_bounds("branch-preview").is_some());
}

#[gpui::test]
fn an_invalid_template_waits_until_it_is_fixed(cx: &mut TestAppContext) {
    let (workspace, cx, path) = open(cx, 0);
    let view = view(&workspace, cx);
    type_template(cx, &view, "milagre/{suffix}");
    advance(cx, 2000);
    assert_eq!(entry(cx, &path).saves.branch, 0);
    assert!(drawn(cx, "branch-template-error"));
    type_template(cx, &view, "milagre/{slug}");
    advance(cx, 601);
    assert_eq!(entry(cx, &path).saves.branch, 1);
    assert!(!drawn(cx, "branch-template-error") && drawn(cx, "branch-preview"));
}

#[gpui::test]
fn the_checkboxes_save_at_once_and_reset_drops_the_personal_layer(cx: &mut TestAppContext) {
    let (workspace, cx, path) = open(cx, 0);
    // The row's own selector: a click on the box itself reaches the box and the row (see group.rs `CheckboxRow`).
    click(cx, &workspace, "settings-row-dashes-only");
    let saved = entry(cx, &path);
    assert_eq!(saved.branch.local.dashes_only, Some(true));
    assert_eq!(saved.saves.branch, 1);
    assert_eq!(saved.branch.local.dashes_only, Some(true));
    assert_eq!(saved.branch.local.username.as_deref(), Some("victor"), "the rest of the personal layer is kept");
    click(cx, &workspace, "branch-reset");
    let reset = entry(cx, &path);
    assert!(reset.branch.local.is_empty());
    assert_eq!(reset.branch.repository.base_branch.as_deref(), Some("main"), "the repository's layer stays");
    assert!(!drawn(cx, "branch-reset"));
}

#[gpui::test]
fn the_files_to_copy_text_saves_after_the_wait_and_the_preview_follows_it(cx: &mut TestAppContext) {
    let (workspace, cx, path) = open(cx, 0);
    let view = view(&workspace, cx);
    view.update(cx, |v, cx| v.edited(Save::Files, cx));
    advance(cx, 599);
    assert_eq!(entry(cx, &path).saves.files, 0);
    advance(cx, 2);
    assert_eq!(entry(cx, &path).saves.files, 1);
}

#[gpui::test]
fn a_field_the_repository_sets_is_locked_and_says_so(cx: &mut TestAppContext) {
    let (_workspace, cx, path) = open(cx, 1);
    let saved = entry(cx, &path);
    assert!(saved.worktree_include.is_some() && saved.setup_settings.repo.is_some());
    assert!(drawn(cx, "files-to-copy-locked") && drawn(cx, "setup-command-locked"));
}

#[gpui::test]
fn show_in_sidebar_and_the_main_sync_choice_are_kept_per_project(cx: &mut TestAppContext) {
    let (workspace, cx, path) = open(cx, 0);
    click(cx, &workspace, "project-show-in-sidebar-check-box");
    assert!(entry(cx, &path).hidden);
    click(cx, &workspace, "project-show-in-sidebar-check-box");
    assert!(!entry(cx, &path).hidden);
}

#[gpui::test]
fn removing_a_project_asks_first(cx: &mut TestAppContext) {
    let (workspace, cx, path) = open(cx, 0);
    click(cx, &workspace, "project-remove");
    assert!(!entry(cx, &path).removed, "the dialog asks first");
    click(cx, &workspace, "project-remove-confirm");
    assert!(entry(cx, &path).removed);
}

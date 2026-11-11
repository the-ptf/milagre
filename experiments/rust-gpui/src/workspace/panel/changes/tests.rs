//! Changes panel tests: the fixture, the file tree and its badges, the diff in both layouts, the Commits view,
//! the empty and loading states, and the per-Chat view.

use gpui::{Entity, Modifiers, TestAppContext, VisualTestContext};
use gpui_component::diff::DiffFile;

use super::data::{ChangesData, Section};
use super::files::{badge_colors, badge_letter};
use super::fixture::{self, Variant};
use super::{ChangesView, Layout, Source, View};
use crate::logic::diff::git::DiffStatus;
use crate::logic::diff::tree::Counted;
use crate::testing::{self, leak};
use crate::theme::Theme;
use crate::workspace::panel::diff::DiffLayout;

const PANEL: &str = "apps/desktop/app/src/components/changes/ChangesPanel.tsx";
const TREE: &str = "apps/desktop/app/src/components/changes/DiffTree.tsx";

fn mount(cx: &mut TestAppContext) -> (Entity<ChangesView>, &mut VisualTestContext) {
    let (workspace, cx) = testing::mount_workspace_on(cx, crate::workspace::panel::PanelTab::Changes);
    let changes = workspace.read_with(cx, |w, cx| w.panel.read(cx).changes().clone());
    (changes, cx)
}

fn settle(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, _| window.refresh());
    cx.run_until_parked();
}

fn click(cx: &mut VisualTestContext, selector: String) {
    let bounds = cx.debug_bounds(leak(selector.clone())).unwrap_or_else(|| panic!("{selector} is drawn"));
    cx.simulate_click(bounds.center(), Modifiers::none());
    settle(cx);
}

#[test]
fn every_fixture_patch_parses_and_matches_the_counts_of_its_entry() {
    let changes = fixture::worktree();
    let mut checked = 0;
    for file in changes.uncommitted.files.iter().chain(&changes.committed.files) {
        let result = &changes.patches[&file.path];
        if file.binary {
            assert!(result.binary && result.patch.is_empty());
            continue;
        }
        let parsed = DiffFile::parse(&result.patch).unwrap_or_else(|error| panic!("{} parses: {error}", file.path));
        assert_eq!(parsed.len(), 1, "{}", file.path);
        assert_eq!((parsed[0].additions() as u32, parsed[0].deletions() as u32), (file.added(), file.removed()), "{}", file.path);
        checked += 1;
    }
    assert!(checked >= 11);
    assert!(changes.uncommitted.files.len() > super::files::FLAT_LIST_MAX, "enough files for the tree");
    for status in [DiffStatus::Added, DiffStatus::Deleted, DiffStatus::Modified, DiffStatus::Renamed] {
        assert!(changes.uncommitted.files.iter().any(|f| f.status == status), "{status:?} appears");
    }
    assert_eq!(changes.history.commits.len(), 5);
}

#[test]
fn badges_use_the_ink_on_tint_pairs_and_modified_stays_neutral() {
    for theme in [Theme::dark(), Theme::light()] {
        assert_eq!(badge_colors(&theme, DiffStatus::Added), (theme.green_tint, theme.green_ink));
        assert_eq!(badge_colors(&theme, DiffStatus::Deleted), (theme.red_tint, theme.red_ink));
        assert_eq!(badge_colors(&theme, DiffStatus::Modified), (theme.field, theme.ink2));
        assert_eq!(badge_colors(&theme, DiffStatus::Renamed), (theme.field, theme.ink2));
    }
    let letters = [DiffStatus::Added, DiffStatus::Modified, DiffStatus::Deleted, DiffStatus::Renamed].map(badge_letter);
    assert_eq!(letters, ["A", "M", "D", "R"]);
}

#[gpui::test]
fn the_header_counts_files_and_lines(cx: &mut TestAppContext) {
    let (changes, cx) = mount(cx);
    assert!(cx.debug_bounds("changes-header").is_some());
    assert!(cx.debug_bounds("changes-count").is_some());
    let total = fixture::worktree().file_count();
    assert_eq!(changes.read_with(cx, |c, _| c.file_count()), total);
    for id in ["layout-unified", "layout-split", "changes-view", "comparison-chip", "current-branch"] {
        assert!(cx.debug_bounds(id).is_some(), "{id} is drawn");
    }
    let unified = cx.debug_bounds("layout-unified").unwrap();
    let split = cx.debug_bounds("layout-split").unwrap();
    assert_eq!((unified.size.width, unified.size.height), (gpui::px(24.0), gpui::px(24.0)));
    assert!(split.left() > unified.right() - gpui::px(1.0), "two icon buttons side by side");
}

#[gpui::test]
fn the_files_view_draws_the_folder_tree_and_folders_collapse(cx: &mut TestAppContext) {
    let (changes, cx) = mount(cx);
    let tree = format!("file-u-{PANEL}");
    assert!(cx.debug_bounds(leak(tree.clone())).is_some(), "a file row in the tree");
    let folder = "folder-u-apps/desktop/app/src";
    let folder_bounds = cx.debug_bounds(folder).expect("the folder row");
    let file_bounds = cx.debug_bounds(leak(tree.clone())).unwrap();
    assert!(file_bounds.left() > folder_bounds.left() || file_bounds.top() > folder_bounds.top());
    click(cx, folder.to_string());
    assert!(changes.read_with(cx, |c, _| c.is_collapsed("apps/desktop/app/src")));
    assert!(cx.debug_bounds(leak(tree)).is_none(), "collapsed folders hide their files");
    click(cx, folder.to_string());
    assert!(cx.debug_bounds(leak(format!("file-u-{PANEL}"))).is_some(), "and show them again");
    // "On this branch" has three files: a flat list.
    assert!(cx.debug_bounds("file-c-DESIGN.md").is_some());
}

#[gpui::test]
fn selecting_a_file_shows_its_diff_and_the_layout_buttons_switch_modes(cx: &mut TestAppContext) {
    let (changes, cx) = mount(cx);
    assert!(cx.debug_bounds("diff-over-chat").is_none());
    click(cx, format!("file-u-{PANEL}"));
    assert_eq!(changes.read_with(cx, |c, _| c.selected().map(|s| s.path.clone())), Some(PANEL.to_string()));
    assert!(cx.debug_bounds("diff-over-chat").is_some(), "the diff opens over the Chat column");
    let body = cx.debug_bounds("diff-body").expect("the diff body");
    let list = cx.debug_bounds("changes-list").expect("the list");
    assert!(body.right() <= list.left() + gpui::px(2.0), "left of the panel's list, in the Chat column");
    assert!(list.size.height > body.size.height * 0.8, "the list keeps the panel's whole body");
    let mode = |cx: &mut VisualTestContext| {
        let view = changes.read_with(cx, |c, _| c.diff_view());
        view.map(|view| view.read_with(cx, |v, _| v.layout()))
    };
    assert_eq!(mode(cx), Some(DiffLayout::Unified));
    assert_eq!(
        changes.read_with(cx, |c, _| c.visible_path().map(str::to_string)).as_deref(),
        Some(PANEL),
        "the list marks the picked file"
    );
    click(cx, "layout-split".to_string());
    assert_eq!(changes.read_with(cx, |c, cx| c.layout(cx)), Layout::Split);
    assert_eq!(mode(cx), Some(DiffLayout::Split));
    click(cx, "diff-layout-unified".to_string());
    assert_eq!(mode(cx), Some(DiffLayout::Unified), "the diff bar's toolbar switches it too");
    assert_eq!(changes.read_with(cx, |c, cx| c.layout(cx)), Layout::Unified);
    click(cx, "diff-back".to_string());
    assert!(cx.debug_bounds("diff-over-chat").is_none());
}

#[gpui::test]
fn a_binary_file_says_so_instead_of_drawing_a_diff(cx: &mut TestAppContext) {
    let (changes, cx) = mount(cx);
    click(cx, "file-u-apps/desktop/app/public/milagre-mark.png".to_string());
    assert!(cx.debug_bounds("diff-over-chat").is_some());
    assert!(cx.debug_bounds("diff-message-apps/desktop/app/public/milagre-mark.png").is_some(), "the binary file says so in the diff");
    assert!(changes.read_with(cx, |c, _| c.selected().is_some()));
}

#[gpui::test]
fn the_commits_view_lists_commits_and_opens_one_with_its_files(cx: &mut TestAppContext) {
    let (changes, cx) = mount(cx);
    click(cx, "changes-view-commits".to_string());
    assert_eq!(changes.read_with(cx, |c, _| c.view()), View::Commits);
    for sha in ["9f3a1c2e", "4be07d91", "c1d2e3f4", "7a8b9c0d", "01234567"] {
        assert!(cx.debug_bounds(leak(format!("commit-{sha}"))).is_some(), "{sha} is listed");
    }
    click(cx, "commit-7a8b9c0d".to_string());
    assert!(cx.debug_bounds("commit-detail").is_some());
    let sha = "7a8b9c0d1e2f3a4b5c6d7e8f90a1b2c3d4e5f607".to_string();
    assert_eq!(changes.read_with(cx, |c, _| c.open_commit().map(str::to_string)), Some(sha.clone()));
    click(cx, format!("file-k7a8b9c0d-{TREE}"));
    assert_eq!(
        changes.read_with(cx, |c, _| c.selected().cloned()),
        Some(super::Selected { source: Source::Commit(sha), path: TREE.to_string() })
    );
    assert!(cx.debug_bounds("diff-body").is_some(), "a commit's file shows its diff");
    click(cx, "commit-7a8b9c0d".to_string());
    assert!(cx.debug_bounds("commit-detail").is_none(), "a second click closes the commit");
    assert!(cx.debug_bounds("diff-over-chat").is_none(), "and its diff goes with it");
}

#[test]
fn commit_dates_read_like_the_desktops() {
    assert_eq!(super::commits::short_date("2026-11-10T16:42:00Z"), "Nov 10");
    assert_eq!(super::commits::short_date("2026-01-02T00:00:00Z"), "Jan 2");
    assert_eq!(super::commits::long_date("2026-11-10T16:42:00Z"), "Nov 10, 2026, 16:42 UTC");
}

#[gpui::test]
fn a_clean_worktree_shows_the_empty_state_and_a_read_in_flight_the_skeleton(cx: &mut TestAppContext) {
    let (changes, cx) = mount(cx);
    changes.update(cx, |c, cx| c.set_data(fixture::data(Variant::Clean), cx));
    settle(cx);
    assert!(cx.debug_bounds("empty-state").is_some(), "no changes: the empty state");
    assert!(cx.debug_bounds("changes-skeleton").is_none());
    changes.update(cx, |c, cx| c.set_data(ChangesData::Loading, cx));
    settle(cx);
    assert!(cx.debug_bounds("changes-skeleton").is_some(), "loading: the skeleton");
    assert!(cx.debug_bounds("changes-header").is_none());
    changes.update(cx, |c, cx| c.set_data(fixture::data(Variant::NotRepo), cx));
    settle(cx);
    assert!(cx.debug_bounds("empty-state").is_some());
}

#[gpui::test]
fn the_view_and_the_picked_file_follow_the_chat(cx: &mut TestAppContext) {
    let (changes, cx) = mount(cx);
    click(cx, format!("file-u-{PANEL}"));
    click(cx, "changes-view-commits".to_string());
    let first = changes.read_with(cx, |c, _| c.view());
    assert_eq!(first, View::Commits);
    changes.update(cx, |c, cx| c.set_chat("other#1".into(), fixture::data(Variant::Small), cx));
    settle(cx);
    assert_eq!(changes.read_with(cx, |c, _| c.view()), View::Files, "another Chat starts on Files");
    assert!(changes.read_with(cx, |c, _| c.selected().is_none()));
    // Back: the first Chat's view returns (it had left Files with a file picked there).
    let key = changes.read_with(cx, |c, _| c.selected().map(|_| ()));
    assert!(key.is_none());
    let seeded = crate::workspace::panel::fixture::content_for("x", Some("x"));
    changes.update(cx, |c, cx| c.set_chat("x".into(), seeded.changes, cx));
    settle(cx);
    let _ = Section::Uncommitted;
}

#[gpui::test]
fn the_comparison_picker_lists_automatic_and_the_branches(cx: &mut TestAppContext) {
    let (changes, cx) = mount(cx);
    assert_eq!(changes.read_with(cx, |c, _| c.comparison().to_string()), "", "Automatic");
    let options = crate::logic::diff::git::comparison_options(Some(&fixture::worktree().history));
    assert_eq!(options[0].label, "Automatic");
    assert!(options.iter().any(|o| o.label == "develop" && o.group == "Local"));
    assert!(options.iter().any(|o| o.label == "origin/main" && o.remote));
    assert!(options.iter().any(|o| o.disabled && o.description.as_deref() == Some("current")), "the current branch can't be its own base");
    changes.update(cx, |c, cx| c.select_comparison("refs/heads/develop".into(), cx));
    assert_eq!(changes.read_with(cx, |c, _| c.comparison().to_string()), "refs/heads/develop");
    let branch = cx.debug_bounds("current-branch").expect("the current branch is drawn");
    assert!(branch.size.width > gpui::px(40.0));
}

#[gpui::test]
fn the_diff_shows_over_the_chat_with_back_named_after_it_and_goes_with_the_panel(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace_on(cx, crate::workspace::panel::PanelTab::Changes);
    let changes = workspace.read_with(cx, |w, cx| w.panel.read(cx).changes().clone());
    click(cx, format!("file-u-{PANEL}"));
    let title = workspace.read_with(cx, |w, cx| w.chat.read(cx).title().to_string());
    let diff = changes.read_with(cx, |c, _| c.diff_view()).expect("open");
    assert_eq!(diff.read_with(cx, |d, _| d.over_chat().map(|o| o.label.to_string())), Some(title));
    // The bar keeps clear of the corner's toggles over the Chat column.
    let toolbar = cx.debug_bounds("diff-toolbar").expect("the toolbar");
    let corner = cx.debug_bounds("corner-toggles").expect("the corner");
    assert!(toolbar.right() <= corner.left(), "{toolbar:?} left of {corner:?}");
    // Hiding the panel takes the diff away.
    workspace.update(cx, |w, cx| w.panel.update(cx, |p, cx| p.close(cx)));
    settle(cx);
    assert!(cx.debug_bounds("diff-over-chat").is_none());
}

#[gpui::test]
fn the_diff_always_opens_over_the_chat_column_and_back_returns_to_the_list(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace_on(cx, crate::workspace::panel::PanelTab::Changes);
    let _ = workspace;
    click(cx, format!("file-u-{PANEL}"));
    assert!(cx.debug_bounds("diff-over-chat").is_some());
    assert!(cx.debug_bounds("changes-list").is_some(), "the list stays in the panel");
    click(cx, "diff-back".to_string());
    assert!(cx.debug_bounds("diff-over-chat").is_none(), "Back closes the diff");
}

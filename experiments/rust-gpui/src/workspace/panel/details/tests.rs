//! Details tab tests in GPUI's headless test platform.

use gpui::{Modifiers, TestAppContext};

use super::data::{DetailsData, middle_truncate, repo_name};
use super::{DetailsEvent, DetailsView, Request};
use crate::testing;
use crate::workspace::panel::{Panel, PanelTab};

fn mount(cx: &mut TestAppContext) -> (gpui::Entity<Panel>, &mut gpui::VisualTestContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let panel = workspace.read_with(cx, |workspace, _| workspace.panel.clone());
    panel.update(cx, |panel, cx| panel.activate(PanelTab::Details, cx));
    cx.run_until_parked();
    (panel, cx)
}

fn details(panel: &gpui::Entity<Panel>, cx: &mut gpui::VisualTestContext) -> gpui::Entity<DetailsView> {
    panel.read_with(cx, |panel, _| panel.details().clone())
}

fn click(cx: &mut gpui::VisualTestContext, selector: &'static str) {
    let at = testing::bounds(cx, selector).center();
    cx.simulate_click(at, Modifiers::none());
    cx.run_until_parked();
}

#[test]
fn middle_truncation_keeps_both_ends() {
    assert_eq!(middle_truncate("short", 10), "short");
    let cut = middle_truncate("milagre/fix-linux-onboarding-intro-hang", 20);
    assert_eq!(cut.chars().count(), 20);
    assert!(cut.starts_with("milagre/fi") && cut.ends_with("ro-hang") && cut.contains('\u{2026}'));
    assert_eq!(repo_name("github.com/the-ptf/milagre-ade"), "the-ptf/milagre-ade");
    assert_eq!(repo_name("milagre"), "milagre");
}

#[gpui::test]
fn the_tab_is_registered_as_rail_with_a_list_icon(cx: &mut TestAppContext) {
    let (panel, _cx) = mount(cx);
    assert!(panel.read_with(&*_cx, |p, _| p.visible_tabs().contains(&PanelTab::Details)));
    assert_eq!(PanelTab::Details.label(), "Rail");
    assert_eq!(PanelTab::Details.icon(), crate::ui::IconName::LeftToRightListBullet);
    assert_eq!(panel.read_with(&*_cx, |p, _| p.active()), PanelTab::Details);
}

#[gpui::test]
fn environment_rows_show_the_computer_repo_branch_and_path(cx: &mut TestAppContext) {
    let (panel, cx) = mount(cx);
    let view = details(&panel, cx);
    let data = view.read_with(cx, |v, _| v.data().clone());
    assert_eq!(data.computer.as_ref().map(|c| c.name.as_str()), Some("This Mac"));
    assert!(data.repo.is_some() && data.branch.is_some() && data.path.is_some());
    for selector in ["details-computer", "details-repo", "details-branch", "details-path", "details-finder", "details-editor"] {
        assert!(cx.debug_bounds(selector).is_some(), "{selector} is drawn");
    }
}

#[gpui::test]
fn the_path_copies_and_the_buttons_only_record(cx: &mut TestAppContext) {
    let (panel, cx) = mount(cx);
    let view = details(&panel, cx);
    click(cx, "details-finder");
    click(cx, "details-editor");
    let requests = view.read_with(cx, |v, _| v.requests().to_vec());
    assert!(matches!(requests[0], Request::Finder(_)) && matches!(requests[1], Request::Editor { .. }));
    click(cx, "details-path");
    let (copied, text) = view.read_with(cx, |v, _| (v.is_copied(), v.copied_text().map(str::to_owned)));
    assert!(copied);
    assert_eq!(text, view.read_with(cx, |v, _| v.data().path.clone()));
    assert!(cx.debug_bounds("details-finder").is_none(), "Copied replaces the buttons for a moment");
}

#[gpui::test]
fn context_expands_to_the_ring_data(cx: &mut TestAppContext) {
    let (panel, cx) = mount(cx);
    let view = details(&panel, cx);
    assert!(cx.debug_bounds("details-context-body").is_none());
    click(cx, "details-context");
    assert!(view.read_with(cx, |v, _| v.context_open()));
    assert!(cx.debug_bounds("details-context-body").is_some());
    let context = view.read_with(cx, |v, _| v.data().context.clone()).expect("the Chat has a context");
    assert!(context.tokens.contains(" of ") && context.percent > 0);
    if context.claude {
        click(cx, "details-compact");
        assert!(view.read_with(cx, |v, _| v.requests().contains(&Request::Compact)));
    }
}

#[gpui::test]
fn stopping_a_task_removes_it_and_finished_expands(cx: &mut TestAppContext) {
    let (panel, cx) = mount(cx);
    let view = details(&panel, cx);
    let before = view.read_with(cx, |v, _| v.data().running_count());
    assert!(before > 0, "the startup Chat has background work");
    let (pid, agent) =
        view.read_with(cx, |v, _| (v.data().ports.first().map(|p| p.pid), v.data().running_agents().next().map(|a| a.id.clone())));
    let pid = pid.expect("a port");
    click(cx, testing::leak(format!("details-stop-port-{pid}")));
    assert_eq!(view.read_with(cx, |v, _| v.data().running_count()), before - 1);
    let finished = view.read_with(cx, |v, _| v.data().finished_count());
    let agent = agent.expect("a running subagent");
    click(cx, testing::leak(format!("details-stop-agent-{agent}")));
    assert_eq!(view.read_with(cx, |v, _| v.data().finished_count()), finished + 1, "a stopped subagent is finished");
    assert!(cx.debug_bounds(testing::leak(format!("details-done-{agent}"))).is_none());
    click(cx, "details-finished");
    assert!(cx.debug_bounds(testing::leak(format!("details-done-{agent}"))).is_some());
}

#[gpui::test]
fn links_show_only_when_present(cx: &mut TestAppContext) {
    let (panel, cx) = mount(cx);
    let view = details(&panel, cx);
    assert!(cx.debug_bounds("details-linear").is_some() && cx.debug_bounds("details-pr").is_some());
    click(cx, "details-pr");
    assert!(view.read_with(cx, |v, _| v.requests().contains(&Request::OpenPr(412))));
    let bare = DetailsData::load("nowhere#1", None, false, None);
    assert!(!bare.has_links_section());
}

#[gpui::test]
fn rows_follow_the_chat(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let (sidebar, panel) = workspace.read_with(cx, |w, _| (w.sidebar.clone(), w.panel.clone()));
    let view = details(&panel, cx);
    let first = view.read_with(cx, |v, _| (v.key().to_owned(), v.data().branch.clone()));
    let other = (0..12)
        .filter_map(|ix| sidebar.read_with(cx, |s, _| s.row(ix).map(|r| r.key.to_string())))
        .find(|key| *key != first.0)
        .expect("another Chat");
    sidebar.update(cx, |s, cx| s.select_key(&other, cx));
    cx.run_until_parked();
    let now = view.read_with(cx, |v, _| (v.key().to_owned(), v.data().branch.clone()));
    assert_eq!(now.0, other);
    assert_ne!(now.1, first.1);
}

#[gpui::test]
fn subchat_rows_nest_and_open_their_chat(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let (sidebar, panel) = workspace.read_with(cx, |w, _| (w.sidebar.clone(), w.panel.clone()));
    let chats = sidebar.read_with(cx, |s, _| s.family_chats());
    let parent =
        chats.iter().find(|c| chats.iter().any(|k| k.parent.as_deref() == Some(c.key.as_str()))).expect("a Chat with Subchats").key.clone();
    let view = details(&panel, cx);
    // The Workspace keeps the panel on the selected row, so drive the view itself.
    view.update(cx, |v, cx| {
        v.set_chat(parent.clone(), None, false, cx);
        v.set_family(&chats, cx);
    });
    panel.update(cx, |p, cx| p.activate(PanelTab::Details, cx));
    cx.run_until_parked();
    let rows = view.read_with(cx, |v, _| v.family().subchats.clone());
    assert!(!rows.is_empty());
    let events = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    let seen = events.clone();
    cx.update(|_, cx| {
        cx.subscribe(&view, move |_, event: &DetailsEvent, _| {
            let DetailsEvent::OpenChat(key) = event;
            seen.borrow_mut().push(key.clone());
        })
        .detach()
    });
    click(cx, "details-subchat-0");
    assert_eq!(events.borrow().as_slice(), [rows[0].key.clone()]);
    // The Workspace opened that Chat (it has no sidebar row); its panel starts on Changes, so come back to Details.
    panel.update(cx, |p, cx| p.activate(PanelTab::Details, cx));
    // From a Subchat, the parent row opens the parent.
    view.update(cx, |v, cx| v.set_chat(rows[0].key.clone(), None, false, cx));
    cx.run_until_parked();
    assert!(view.read_with(cx, |v, _| v.family().parent.as_ref().map(|p| p.key.clone())) == Some(parent.clone()));
    click(cx, "details-parent");
    assert_eq!(events.borrow().last(), Some(&parent));
}

#[gpui::test]
fn children_and_background_toggle_and_stay_folded_across_chats(cx: &mut TestAppContext) {
    let (panel, cx) = mount(cx);
    let view = details(&panel, cx);
    assert!(view.read_with(cx, |v, _| v.background_open() && v.children_open()), "open by default");
    let tasks = view.read_with(cx, |v, _| v.data().ports.first().map(|p| p.pid)).expect("a port");
    let row = testing::leak(format!("details-port-{tasks}"));
    assert!(cx.debug_bounds(row).is_some());
    click(cx, "details-background-toggle");
    assert!(!view.read_with(cx, |v, _| v.background_open()));
    assert!(cx.debug_bounds(row).is_none(), "folded: the rows are gone");
    // Switching Chats keeps the choice for the session.
    view.update(cx, |v, cx| v.set_chat("other#1", None, false, cx));
    assert!(!view.read_with(cx, |v, _| v.background_open()));
    click(cx, "details-background-toggle");
    assert!(view.read_with(cx, |v, _| v.background_open()));
    view.update(cx, |v, cx| v.toggle_children(cx));
    assert!(!view.read_with(cx, |v, _| v.children_open()));
}

#[gpui::test]
fn links_fold_and_stay_folded_across_chats(cx: &mut TestAppContext) {
    let (panel, cx) = mount(cx);
    let view = details(&panel, cx);
    assert!(view.read_with(cx, |v, _| v.links_open()), "open by default");
    assert!(cx.debug_bounds("details-pr").is_some(), "the PR row shows while open");
    click(cx, "details-links-toggle");
    assert!(!view.read_with(cx, |v, _| v.links_open()));
    assert!(cx.debug_bounds("details-pr").is_none(), "folded: the rows are gone");
    click(cx, "details-links-toggle");
    assert!(view.read_with(cx, |v, _| v.links_open()));
}

#[gpui::test]
fn a_folded_section_is_just_its_heading_row(cx: &mut TestAppContext) {
    let (panel, cx) = mount(cx);
    let view = details(&panel, cx);
    view.update(cx, |v, cx| {
        v.toggle_children(cx);
        v.toggle_background(cx);
        v.toggle_links(cx);
    });
    cx.run_until_parked();
    let mut checked = 0;
    for (section, heading) in [
        ("details-section-children", "details-children-toggle"),
        ("details-section-background", "details-background-toggle"),
        ("details-section-links", "details-links-toggle"),
    ] {
        // The fixture Chat may have no Children.
        let Some(section_bounds) = cx.debug_bounds(section) else { continue };
        checked += 1;
        let heading = testing::bounds(cx, heading);
        assert_eq!(section_bounds.size.height, heading.size.height, "{section}: a folded section is only its heading row");
    }
    assert!(checked >= 2, "Background tasks and Links are drawn");
}

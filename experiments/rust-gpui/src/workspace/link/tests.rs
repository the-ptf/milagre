//! The Link workspace on fixture data, in the headless test platform.

use gpui::{Modifiers, TestAppContext};

use super::changes::{Mode, changed_count};
use super::fixture;
use crate::testing;

#[test]
fn fixture_members_and_counts() {
    let link = fixture::link();
    let shared = &link.chats[0];
    assert_eq!(shared.members.len(), 2, "the shared Chat has a Worktree in two of three Projects");
    assert_eq!(changed_count(shared), 7);
    assert_eq!(shared.members[0].counts(), (159, 42));
    assert_eq!(link.chat_key(3), "milagre-link:k7f2#3");
}

#[gpui::test]
fn opens_in_place_of_the_columns_and_escape_leaves(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    workspace.update_in(cx, |w, window, cx| w.open_link(window, cx));
    cx.run_until_parked();
    assert!(cx.debug_bounds("link-workspace").is_some());
    assert!(cx.debug_bounds("link-sidebar").is_some());
    assert!(cx.debug_bounds("chat-row-0").is_none(), "the window's sidebar makes way");
    assert!(cx.debug_bounds("link-changes").is_some(), "Changes open by default");
    for project in ["web", "api"] {
        assert!(cx.debug_bounds(testing::leak(format!("link-changes-project-{project}"))).is_some(), "{project} has a section");
    }
    assert!(cx.debug_bounds("link-changes-pending-mobile").is_some(), "a Project without a Worktree says so");
    // Escape from the Link's composer leaves it.
    let chat = workspace.read_with(cx, |w, cx| w.link.as_ref().unwrap().view.read(cx).chat.clone());
    cx.update(|window, cx| {
        let handle = chat.read(cx).composer_focus_handle(cx);
        window.focus(&handle, cx);
    });
    cx.simulate_keystrokes("escape");
    cx.run_until_parked();
    // The composer may take the first Escape (it has nothing to clear here); the Link takes the next.
    if workspace.read_with(cx, |w, _| w.link.is_some()) {
        cx.simulate_keystrokes("escape");
        cx.run_until_parked();
    }
    assert!(workspace.read_with(cx, |w, _| w.link.is_none()));
    assert!(cx.debug_bounds("chat-row-0").is_some(), "the window's sidebar is back");
}

#[gpui::test]
fn picking_a_file_remembers_its_member(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    workspace.update_in(cx, |w, window, cx| w.open_link(window, cx));
    cx.run_until_parked();
    let view = workspace.read_with(cx, |w, _| w.link.as_ref().unwrap().view.clone());
    let file = cx.debug_bounds("link-file-api-internal/checkout/totals.go").expect("api's committed file");
    cx.simulate_click(file.center(), Modifiers::none());
    cx.run_until_parked();
    let picked = view.read_with(cx, |v, _| v.picked().cloned()).expect("picked");
    assert_eq!((picked.project_id, picked.mode, picked.path), ("api", Mode::Committed, "internal/checkout/totals.go"));
    // Folding a member hides its files.
    let header = cx.debug_bounds("link-project-header-web").expect("web's header");
    cx.simulate_click(header.center(), Modifiers::none());
    cx.run_until_parked();
    assert!(view.read_with(cx, |v, _| v.collapsed("web")));
    assert!(cx.debug_bounds("link-file-web-src/checkout/api.ts").is_none());
    assert!(cx.debug_bounds("link-file-api-internal/checkout/handler.go").is_some());
}

#[gpui::test]
fn switching_link_chats_and_the_changes_toggle(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    workspace.update_in(cx, |w, window, cx| w.open_link(window, cx));
    cx.run_until_parked();
    let view = workspace.read_with(cx, |w, _| w.link.as_ref().unwrap().view.clone());
    let row = cx.debug_bounds("link-chat-2").expect("second Link Chat");
    cx.simulate_click(row.center(), Modifiers::none());
    cx.run_until_parked();
    let (title, key) = view.read_with(cx, |v, cx| (v.chat.read(cx).title().to_string(), v.chat.read(cx).key().map(str::to_string)));
    assert_eq!(title, "Rename the cart events");
    assert_eq!(key.as_deref(), Some("milagre-link:k7f2#2"));
    assert!(cx.debug_bounds("link-changes-pending-api").is_some(), "this Chat changed only the web Project");
    let toggle = cx.debug_bounds("link-corner").expect("the corner's Changes toggle");
    cx.simulate_click(toggle.center(), Modifiers::none());
    cx.run_until_parked();
    assert!(!view.read_with(cx, |v, _| v.changes_open()));
    assert!(cx.debug_bounds("link-changes").is_none());
}

#[gpui::test]
fn find_goes_to_the_link_chat(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    workspace.update_in(cx, |w, window, cx| w.open_link(window, cx));
    cx.run_until_parked();
    let focus = workspace.read_with(cx, |w, _| w.focus.clone());
    cx.update(|window, cx| window.focus(&focus, cx));
    cx.simulate_keystrokes("cmd-f");
    cx.run_until_parked();
    let chat = workspace.read_with(cx, |w, cx| w.link.as_ref().unwrap().view.read(cx).chat.clone());
    assert!(chat.read_with(cx, |c, _| c.find_open()));
    assert!(!workspace.read_with(cx, |w, cx| w.chat.read(cx).find_open()), "not the hidden window Chat's");
}

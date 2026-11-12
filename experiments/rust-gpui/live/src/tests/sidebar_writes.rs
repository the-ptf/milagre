//! The sidebar's other writes on a fake Node daemon ([`super::fake_daemon`]), each made as a person would (the row's
//! menu, the toast's Undo, Filters) and checked on the fake's request log and its saved state:
//!
//! - `the_sidebar_writes_reach_the_daemon`: Pin (this device's, saved to the Preview's own file, never sent), Delete
//!   (a running turn stopped, hidden at once, Undo restores; after the window `chat:delete`), Reload, Detach, Unlink
//!   issue, Filters › Projects (`project:set-hidden`, the Chats gone and back) and Show (saved), and Add Project
//!   (refused with a plain line when the daemon does not list `project:open` even to `{commands: true}`; listed, `project:open` of the picked folder, then a new sync lists it).
//! - `a_read_only_window_refuses_the_sidebar_writes`: saved pins still show; Delete, Pin and Reload are not offered;
//!   every write that reaches the layer anyway is refused before a connection; nothing is saved.

use std::path::{Path, PathBuf};
use std::time::Duration;

use gpui::{AnyView, AppContext as _, Entity, Modifiers, MouseButton, TestAppContext};
use gpui_component::Root;
use milagre_gpui_spike::workspace::Workspace;
use milagre_gpui_spike::workspace::sidebar::filters::FilterAction;
use milagre_gpui_spike::workspace::sidebar::{Actions, ChatPatch, Sidebar, SidebarCall};
use serde_json::{Value, json};

use super::fake_daemon::{FakeDaemon, World, data_folder};
use super::owned::Mounted;
use crate::controller::{DaemonSession, LiveController, install_daemon_globals};
use crate::daemon::Daemon;
use crate::sidebar_writes::{PickedFolder, PrefsPath, SidebarWrites, Writes};

const ALPHA: &str = "/fake-node/alpha";
const BETA: &str = "/fake-node/beta";
const DELTA: &str = "/fake-node/delta";

fn world() -> World {
    World::with(vec![
        (
            ALPHA,
            "alpha",
            true,
            vec![
                (1, "Alpha first", vec![("user", "Alpha question"), ("assistant", "Alpha answer")]),
                (2, "Alpha second", vec![("user", "Second question"), ("assistant", "Second answer")]),
            ],
        ),
        (
            BETA,
            "beta",
            true,
            vec![
                (1, "Beta first", vec![("user", "Beta question"), ("assistant", "Beta answer")]),
                (2, "Beta second", vec![("user", "Beta again"), ("assistant", "Beta reply")]),
            ],
        ),
    ])
}

fn mount<'a>(cx: &'a mut TestAppContext, session: DaemonSession, prefs: &Path) -> Mounted<'a> {
    let wiring = cx.update(|cx| {
        cx.set_global(milagre_gpui_spike::theme::Theme::dark());
        gpui_component::init(cx);
        milagre_gpui_spike::theme::component_bridge::init(cx);
        cx.set_global(PrefsPath(Some(prefs.to_owned())));
        cx.set_global(PickedFolder(PathBuf::from(DELTA)));
        install_daemon_globals(&session, cx)
    });
    let (root, vcx) = cx.add_window_view(|window, cx| {
        let workspace = cx.new(|cx| Workspace::new(window, cx));
        Root::new(AnyView::from(workspace), window, cx)
    });
    let workspace = root.read_with(vcx, |root, _| root.view().clone().downcast::<Workspace>().expect("the workspace"));
    vcx.run_until_parked();
    let controller = vcx.update(|window, cx| LiveController::attach_daemon(&workspace, session, wiring, window, cx));
    vcx.run_until_parked();
    Mounted { vcx, workspace, controller }
}

impl Mounted<'_> {
    /// Opens a Chat as a click on its row does.
    fn go_to(&mut self, key: &str) {
        self.workspace.update(self.vcx, |w, cx| w.open_chat_key(key, cx));
        let (sidebar, chat) = self.workspace.read_with(self.vcx, |w, _| (w.sidebar.clone(), w.chat.clone()));
        let row = sidebar.read_with(self.vcx, |s, _| s.selected_row().cloned()).expect("the row");
        self.vcx.update(|window, cx| chat.update(cx, |c, cx| c.set_chat(&row, window, cx)));
        self.vcx.run_until_parked();
    }

    fn sidebar(&mut self) -> Entity<Sidebar> {
        self.workspace.read_with(self.vcx, |w, _| w.sidebar.clone())
    }

    fn writes(&mut self) -> Entity<SidebarWrites> {
        self.vcx.update(|_, cx| cx.global::<Writes>().0.clone())
    }

    fn keys(&mut self) -> Vec<String> {
        let sidebar = self.sidebar();
        sidebar.read_with(self.vcx, |s, _| s.row_keys())
    }

    fn pinned(&mut self, key: &str) -> bool {
        let sidebar = self.sidebar();
        sidebar.read_with(self.vcx, |s, _| s.is_pinned_key(key))
    }

    fn notice(&mut self) -> Option<String> {
        let sidebar = self.sidebar();
        sidebar.read_with(self.vcx, |s, _| s.notice().map(|n| n.to_string()))
    }

    /// Right-clicks the Chat's row.
    fn open_menu(&mut self, key: &str) {
        let ix = self.keys().iter().position(|k| k == key).unwrap_or_else(|| panic!("{key} has a row"));
        let selector: &'static str = Box::leak(format!("chat-row-{ix}").into_boxed_str());
        let at = self.vcx.debug_bounds(selector).expect("the row is drawn").center();
        self.vcx.simulate_mouse_down(at, MouseButton::Right, Modifiers::none());
        self.vcx.simulate_mouse_up(at, MouseButton::Right, Modifiers::none());
        self.vcx.run_until_parked();
    }

    /// The row's menu item `id` (`menu-<id>`), clicked.
    fn menu(&mut self, key: &str, id: &str) {
        self.open_menu(key);
        let selector: &'static str = Box::leak(format!("menu-{id}").into_boxed_str());
        let at = self.vcx.debug_bounds(selector).unwrap_or_else(|| panic!("{selector} is offered")).center();
        self.vcx.simulate_click(at, Modifiers::none());
        self.vcx.run_until_parked();
    }

    fn offered(&mut self, key: &str, id: &str) -> bool {
        self.open_menu(key);
        let selector: &'static str = Box::leak(format!("menu-{id}").into_boxed_str());
        let offered = self.vcx.debug_bounds(selector).is_some();
        self.vcx.simulate_keystrokes("escape");
        offered
    }

    fn call(&mut self, call: SidebarCall) {
        let actions = self.vcx.update(|_, cx| cx.global::<Actions>().0.clone());
        actions.call(call);
    }

    fn filter(&mut self, action: FilterAction) {
        let sidebar = self.sidebar();
        self.vcx.update(|window, cx| sidebar.update(cx, |s, cx| s.filter_action(action, window, cx)));
    }

    fn errors(&mut self) -> Vec<String> {
        let writes = self.writes();
        writes.read_with(self.vcx, |w, _| w.errors().to_vec())
    }
}

fn calls(fake: &FakeDaemon, method: &str) -> Vec<Value> {
    fake.log().into_iter().filter(|(m, _)| m == method).map(|(_, args)| args).collect()
}

fn session(fake: &FakeDaemon, project: &str, id: u64) -> Option<Value> {
    fake.world().projects[project].sessions.get(&id).cloned()
}

fn saved(prefs: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(prefs).unwrap_or_default()).unwrap_or(Value::Null)
}

#[gpui::test]
fn the_sidebar_writes_reach_the_daemon(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let data = data_folder("sidebar-writes");
    let prefs = data.join("preview/sidebar.json");
    let fake = FakeDaemon::start(&data, world());
    let mut m = mount(cx, DaemonSession::start(Daemon::new(Some(data.clone()), false)), &prefs);
    m.until("the rows", |m| m.keys().len() == 4);
    let (alpha1, alpha2, beta1) = (format!("{ALPHA}#1"), format!("{ALPHA}#2"), format!("{BETA}#1"));
    assert!(m.vcx.debug_bounds("preview-note").is_none(), "no status text under the rows");

    // 1. Pin: this device's own, saved to the Preview's file; nothing is sent for a Chat that is not a Run Chat.
    m.menu(&alpha1, "pin");
    m.until("the saved pin", |m| m.pinned(&alpha1) && saved(&prefs)["chatPins"][ALPHA]["1"].is_number());
    assert!(calls(&fake, "chat:patch").is_empty(), "a pin is never the host's");
    m.menu(&alpha1, "unpin");
    m.until("the saved unpin", |m| !m.pinned(&alpha1) && saved(&prefs)["chatPins"][ALPHA].get("1").is_none());

    // 2. Delete: hidden at once, the toast's Undo brings it back; nothing is deleted.
    m.menu(&beta1, "delete");
    assert!(!m.keys().contains(&beta1), "the row goes at once");
    m.until("the hidden Chat", |_| session(&fake, BETA, 1).is_some_and(|s| s["archived"] == true));
    assert_eq!(calls(&fake, "chat:patch").last().unwrap(), &json!([BETA, 1, {"archived": true, "unread": false}]));
    let undo = m.vcx.debug_bounds("toast-undo").expect("the toast's Undo").center();
    m.vcx.simulate_click(undo, Modifiers::none());
    m.until("the restored Chat", |m| session(&fake, BETA, 1).is_some_and(|s| s["archived"] == false) && m.keys().contains(&beta1));
    assert!(calls(&fake, "chat:delete").is_empty(), "an undone deletion deletes nothing");

    // 3. Delete again and let the window run out: the conversation goes.
    m.menu(&beta1, "delete");
    m.until("the hidden Chat", |_| session(&fake, BETA, 1).is_some_and(|s| s["archived"] == true));
    m.vcx.executor().advance_clock(Duration::from_secs(7));
    m.until("the deleted Chat", |m| session(&fake, BETA, 1).is_none() && !m.keys().contains(&beta1));
    assert_eq!(calls(&fake, "chat:delete"), [json!([BETA, 1])]);
    let undoable = m.writes().read_with(m.vcx, |w, _| w.undoable());
    assert_eq!(undoable, 0);

    // 4. Deleting a Chat mid-turn stops the turn first (as Stop does), then hides it.
    m.go_to(&alpha2);
    m.type_and_send("[hold] keep going");
    m.until("the running turn", |m| m.running());
    m.menu(&alpha2, "delete");
    m.until("the hidden Chat", |_| session(&fake, ALPHA, 2).is_some_and(|s| s["archived"] == true));
    let order: Vec<String> = fake.methods().into_iter().filter(|m| m == "agent:interrupt" || m == "chat:patch").collect();
    assert_eq!(order[order.len() - 2..], ["agent:interrupt", "chat:patch"], "stopped, then hidden");
    let undo = m.vcx.debug_bounds("toast-undo").expect("the toast's Undo").center();
    m.vcx.simulate_click(undo, Modifiers::none());
    m.until("the restored Chat", |_| session(&fake, ALPHA, 2).is_some_and(|s| s["archived"] == false));

    // 5. Reload, Detach from parent and Unlink issue, each on the Chat's own Project, loaded first.
    m.menu(&alpha1, "reload");
    m.until("the reload", |m| {
        calls(&fake, "chat:reload") == [json!([alpha1])] && m.notice().is_some_and(|n| n.starts_with("Chat reloaded"))
    });
    m.call(SidebarCall::Patch { chat: alpha1.clone(), patch: ChatPatch::Detach });
    m.until("the detach", |m| calls(&fake, "chat:detach") == [json!([ALPHA, 1])] && m.notice().as_deref() == Some("Detached."));
    m.call(SidebarCall::UnlinkIssue { chat: alpha1.clone() });
    m.until("the unlink", |_| calls(&fake, "worktree:unlink-issue") == [json!([{"projectPath": ALPHA, "worktreeId": 1}])]);
    for method in ["chat:reload", "chat:detach", "worktree:unlink-issue"] {
        let connection = fake.connections().into_iter().rev().find(|(_, m)| m == method).unwrap().0;
        let on: Vec<String> = fake.connections().into_iter().filter(|(c, _)| *c == connection).map(|(_, m)| m).collect();
        assert_eq!(on[..4], ["daemon:status", "daemon:status", "project:read", method], "{method}: request-only, loaded first");
    }

    // 6. Filters › Projects: beta hidden on the host, its Chats leave the lists; shown again, they come back.
    assert!(m.keys().contains(&format!("{BETA}#2")));
    m.filter(FilterAction::ToggleProject(1));
    m.until("beta hidden", |m| fake.world().projects[BETA].hidden && !m.keys().iter().any(|k| k.starts_with(BETA)));
    let names = m.sidebar().read_with(m.vcx, |s, _| s.hidden_project_names());
    assert_eq!(names, ["beta"]);
    assert_eq!(calls(&fake, "project:set-hidden"), [json!([BETA, true])]);
    m.filter(FilterAction::ToggleProject(1));
    m.until("beta shown", |m| !fake.world().projects[BETA].hidden && m.keys().contains(&format!("{BETA}#2")));

    // 7. Filters › Show: this device's, saved with the pins.
    m.filter(FilterAction::ToggleField(milagre_gpui_spike::logic::lists::chat_row::ChatRowField::Branch));
    m.until("the saved Show", |_| saved(&prefs)["chatRowShow"]["branch"] == true);

    // 8. Add Project. The installed daemon does not list `project:open` to this client: refused before a request.
    fake.world().unlisted = vec!["project:open".into()];
    m.call(SidebarCall::AddProject);
    m.until("the refusal", |m| m.notice().is_some_and(|n| n.contains("add it in Milagre")));
    assert!(calls(&fake, "project:open").is_empty());
    assert_eq!(m.errors().len(), 1);
    fake.world().unlisted.clear();
    // Listed: the picked folder opened on the host (registered and first), then a new sync lists it.
    let syncs = m.controller.read_with(m.vcx, |c, _| c.syncs());
    m.call(SidebarCall::AddProject);
    m.until("the opened Project", |m| {
        calls(&fake, "project:open") == [json!([DELTA, {"takeNotice": true}])] && m.controller.read_with(m.vcx, |c, _| c.syncs()) > syncs
    });
    assert_eq!(fake.world().known.first().map(String::as_str), Some(DELTA));

    assert_eq!(m.errors().len(), 1, "only the refused Add Project: {:?}", m.errors());
    drop(m);
    drop(fake);
    let _ = std::fs::remove_dir_all(&data);
}

#[gpui::test]
fn a_read_only_window_refuses_the_sidebar_writes(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let data = data_folder("sidebar-read-only");
    let prefs = data.join("preview/sidebar.json");
    std::fs::create_dir_all(prefs.parent().unwrap()).unwrap();
    let kept = json!({"chatPins": {ALPHA: {"2": 1.0}}, "hiddenComputers": [], "chatRowShow": {"branch": true}});
    std::fs::write(&prefs, kept.to_string()).unwrap();
    let fake = FakeDaemon::start(&data, world());
    let mut m = mount(cx, DaemonSession::start(Daemon::new(Some(data.clone()), true)), &prefs);
    m.until("the rows", |m| m.keys().len() == 4);
    let (alpha2, beta1) = (format!("{ALPHA}#2"), format!("{BETA}#1"));
    assert!(m.pinned(&alpha2), "this device's saved pin shows");
    assert!(m.sidebar().read_with(m.vcx, |s, _| s.show_fields().branch), "and its Show fields");
    for id in ["delete", "pin", "reload"] {
        assert!(!m.offered(&beta1, id), "{id} is not offered read-only");
    }
    assert!(m.offered(&beta1, "copy-branch"));

    // Whatever reaches the layer anyway is refused before a connection.
    m.call(SidebarCall::Archive { chat: beta1.clone(), mode: milagre_gpui_spike::workspace::sidebar::ArchiveMode::HideOnly });
    m.call(SidebarCall::Reload { chat: beta1.clone() });
    m.call(SidebarCall::SetProjectHidden { scope: BETA.into(), hidden: true });
    m.call(SidebarCall::AddProject);
    m.call(SidebarCall::Pin { chat: beta1.clone(), order: Some(2.0) });
    m.until("the refusals", |m| m.writes().read_with(m.vcx, |w, _| w.refused().len()) == 4);
    std::thread::sleep(Duration::from_millis(200));
    m.vcx.run_until_parked();
    let methods = fake.methods();
    // Adoption, the snapshot, transcripts and the Preview's other reads (`Daemon::read`): never a sidebar write.
    let allowed = ["daemon:status", "project:known", "daemon:snapshot", "daemon:snapshot-page", "chat:messages"];
    assert!(
        methods.iter().all(|m| allowed.contains(&m.as_str()) || crate::daemon::READS.contains(&m.as_str())),
        "read-only reached the daemon with: {methods:?}"
    );
    assert_eq!(saved(&prefs), kept, "nothing is saved read-only");
    assert_eq!(m.writes().read_with(m.vcx, |w, _| w.saves()), 0);
    drop(m);
    drop(fake);
    let _ = std::fs::remove_dir_all(&data);
}

#[test]
fn this_devices_choices_round_trip() {
    use crate::sidebar_writes::{parse_prefs, prefs_json};
    use milagre_gpui_spike::logic::lists::chat_row::{ChatRowShow, DESKTOP_CHAT_ROW_SHOW};
    let mut pins = milagre_gpui_spike::logic::lists::pins::DevicePins::new();
    pins.entry(ALPHA.into()).or_default().insert("3".into(), 0.5);
    let show = ChatRowShow { diff: true, computer: false, ..DESKTOP_CHAT_ROW_SHOW };
    let value = prefs_json(&pins, &["mac-2".into(), "local".into()], show);
    assert_eq!(value["hiddenComputers"], json!(["local", "mac-2"]));
    let (back, computers, shown) = parse_prefs(&value);
    assert_eq!((back, shown), (pins, show));
    assert_eq!(computers.len(), 2);
    // Missing or malformed: nothing pinned or hidden, the desktop's Show.
    let (none, hidden, default) = parse_prefs(&json!({"chatPins": 3, "chatRowShow": {"diff": "yes"}}));
    assert!(none.is_empty() && hidden.is_empty());
    assert_eq!(default, DESKTOP_CHAT_ROW_SHOW);
    assert_eq!(crate::sidebar_writes::hidden_in(&json!([{"path":"/a","hidden":true},{"path":"/b"}])), ["/a".to_owned()].into());
}

/// Delete's Worktree cleanup, as Electron's `checkArchive` and `archiveChat` decide it: a Worktree Milagre made (a base,
/// under `worktree:roots`) that no other Chat uses and that `worktree:status` reports removable goes with the Chat
/// (`worktree:remove`, no `chat:delete`); a shared one, one with work to lose, and the Project's own folder stay (the
/// conversation goes with `chat:delete`); a refused removal brings the Chat back and says why.
#[gpui::test]
fn delete_removes_a_milagre_worktree_only_when_safe(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let data = data_folder("delete-worktree");
    let prefs = data.join("sidebar.json");
    let mut world = World::with(vec![(
        ALPHA,
        "alpha",
        true,
        (1..=7)
            .map(|id| {
                (
                    id,
                    ["", "Own folder", "Clean", "Shared a", "Shared b", "Dirty", "Refused", "Spare"][id as usize],
                    vec![("user", "hi"), ("assistant", "hello")],
                )
            })
            .collect(),
    )]);
    world.roots = vec!["/fake-roots/".into()];
    let w = |id: u64| (id, format!("/fake-roots/alpha/w{id}"), "main".to_owned());
    world.worktrees.insert(ALPHA.into(), vec![w(2), w(3), w(4), w(5)]);
    for (chat, worktree) in [(2, 2), (3, 3), (4, 3), (5, 4), (6, 5)] {
        world.projects.get_mut(ALPHA).unwrap().sessions.get_mut(&chat).unwrap()["worktree_id"] = json!(worktree);
    }
    let clean = json!({"removable": true, "uncommitted": 0, "unpushed": 0});
    for id in [2, 3, 5] {
        world.statuses.insert(format!("/fake-roots/alpha/w{id}"), clean.clone());
    }
    world.statuses.insert("/fake-roots/alpha/w4".into(), json!({"removable": false, "uncommitted": 2, "unpushed": 0}));
    let fake = FakeDaemon::start(&data, world);
    let mut m = mount(cx, DaemonSession::start(Daemon::new(Some(data.clone()), false)), &prefs);
    m.until("the rows", |m| m.keys().len() == 7);
    let key = |id: u64| format!("{ALPHA}#{id}");
    let delete = |m: &mut Mounted, id: u64| {
        m.call(SidebarCall::Archive { chat: key(id), mode: milagre_gpui_spike::workspace::sidebar::ArchiveMode::HideOnly });
        m.until("hidden", |_| session(&fake, ALPHA, id).is_some_and(|s| s["archived"] == true));
        m.vcx.executor().advance_clock(Duration::from_secs(7));
    };

    // A clean Worktree Milagre made, used by this Chat only: removed with it.
    delete(&mut m, 2);
    m.until("the Worktree removed", |_| !calls(&fake, "worktree:remove").is_empty() && session(&fake, ALPHA, 2).is_none());
    assert_eq!(
        calls(&fake, "worktree:remove"),
        [json!(["/fake-roots/alpha/w2", {"force": false, "base": "main", "projectPath": ALPHA, "chatId": key(2), "seen": clean}])]
    );
    assert!(calls(&fake, "chat:delete").is_empty(), "the removal drops the Chat");
    assert!(!fake.world().worktrees[ALPHA].iter().any(|(id, _, _)| *id == 2));

    // Shared with another Chat: the Worktree stays, its status is not even read; the conversation goes.
    delete(&mut m, 3);
    m.until("the conversation deleted", |_| calls(&fake, "chat:delete") == [json!([ALPHA, 3])]);
    assert!(!calls(&fake, "worktree:status").iter().any(|a| a[0] == "/fake-roots/alpha/w3"));
    // Work to lose: stays.
    delete(&mut m, 5);
    m.until("deleted, Worktree kept", |_| calls(&fake, "chat:delete").contains(&json!([ALPHA, 5])));
    // The Project's own folder (no base): stays, nothing read about it.
    delete(&mut m, 1);
    m.until("deleted", |_| calls(&fake, "chat:delete").contains(&json!([ALPHA, 1])));
    assert_eq!(calls(&fake, "worktree:remove").len(), 1, "only the clean one was removed");

    // A refused removal: the Chat comes back and the sidebar says why.
    fake.world().remove_error = Some("fatal: worktree is locked.".into());
    delete(&mut m, 6);
    m.until("the Chat back", |m| session(&fake, ALPHA, 6).is_some_and(|s| s["archived"] == false) && m.keys().contains(&key(6)));
    m.until("the notice", |m| {
        m.notice().is_some_and(|n| n.starts_with("Couldn't remove the worktree") && n.ends_with("The chat stays so you can find it."))
    });
    assert!(fake.world().worktrees[ALPHA].iter().any(|(id, _, _)| *id == 5), "the Worktree stays");
    drop(m);
    drop(fake);
    let _ = std::fs::remove_dir_all(&data);
}

/// Links on the daemon (`SidebarLinks.tsx`): the menu offers "Link with…" and "Remove Link with…"; the Link popover's
/// Link, Always allow and ask go as one (`canvas:link-add`, then `linked:grant` on the id the daemon gave it, then
/// `chat:send` with the shown body and the sent prompt); the sidebar holds the daemon's Links (read, and followed
/// through `canvas:links-changed`); a removal (`canvas:link-remove`) is undone with the same Link as the daemon listed it
/// (`canvas:link-restore`).
#[gpui::test]
fn links_reach_the_daemon(cx: &mut TestAppContext) {
    use milagre_gpui_spike::workspace::sidebar::links::LinkEnd;
    cx.executor().allow_parking();
    let data = data_folder("links");
    let prefs = data.join("sidebar.json");
    let fake = FakeDaemon::start(&data, world());
    let mut m = mount(cx, DaemonSession::start(Daemon::new(Some(data.clone()), false)), &prefs);
    m.until("the rows", |m| m.keys().len() == 4);
    let alpha1 = format!("{ALPHA}#1");
    assert!(m.offered(&alpha1, "link-with"), "Link with… is offered");
    m.until("the Links read", |_| !calls(&fake, "canvas:links").is_empty());

    // The popover's three writes, as `create_link` sends them (its own fixture id on the grant).
    let (a, b) = (LinkEnd::worktree(ALPHA, ALPHA), LinkEnd::worktree(BETA, BETA));
    m.call(SidebarCall::AddLink { a: a.clone(), b: b.clone() });
    m.call(SidebarCall::GrantDelegations { chat: alpha1.clone(), link: "link-1".into() });
    m.call(SidebarCall::AskChat { chat: alpha1.clone(), body: "Ask beta".into(), prompt: "Ask beta (linked)".into() });
    m.until("the Link, grant and ask", |_| !fake.world().grants.is_empty() && !calls(&fake, "chat:send").is_empty());
    assert_eq!(
        calls(&fake, "canvas:link-add"),
        [json!([{"project_id": ALPHA, "worktree_path": ALPHA}, {"project_id": BETA, "worktree_path": BETA}])]
    );
    assert_eq!(fake.world().grants, [(alpha1.clone(), "fake-link-1".to_owned())], "the daemon's id, not the sidebar's");
    let ask = calls(&fake, "chat:send").pop().unwrap();
    assert_eq!(
        (ask[0]["sessionId"].clone(), ask[0]["body"].clone(), ask[0]["prompt"].clone()),
        (json!(1), json!("Ask beta"), json!("Ask beta (linked)"))
    );
    let sidebar = m.sidebar();
    m.until("the sidebar's Links", |m| {
        sidebar.read_with(m.vcx, |s, _| s.links().iter().map(|l| l.id.clone()).collect::<Vec<_>>()) == ["fake-link-1"]
    });
    assert!(m.offered(&alpha1, "remove-link"), "Remove Link with… is offered once a Link reaches the Chat");

    // A Link made elsewhere (Electron, the canvas) arrives through `canvas:links-changed`.
    {
        let mut world = fake.world();
        let other = json!({"id":"fake-link-9","a":{"project_id":BETA},"b":{"project_id":ALPHA},"created_at":"2026-11-12T00:00:00.000Z"});
        world.links.push(other);
        let links = world.links.clone();
        world.emit("canvas:links-changed", json!({"links": links}));
    }
    m.until("the other Link", |m| sidebar.read_with(m.vcx, |s, _| s.links().len()) == 2);

    // Remove, then Undo: the same Link back, as the daemon listed it.
    m.call(SidebarCall::RemoveLink { id: "fake-link-1".into() });
    m.until("removed", |_| !fake.world().links.iter().any(|l| l["id"] == "fake-link-1"));
    let removed = milagre_gpui_spike::workspace::sidebar::links::CanvasLink { id: "fake-link-1".into(), a: a.clone(), b: b.clone() };
    m.call(SidebarCall::RestoreLink { link: removed });
    m.until("restored", |_| fake.world().links.iter().any(|l| l["id"] == "fake-link-1"));
    assert_eq!(calls(&fake, "canvas:link-restore")[0][0]["created_at"], "2026-11-12T00:00:00.000Z");
    assert!(m.errors().is_empty(), "{:?}", m.errors());
    drop(m);
    drop(fake);
    let _ = std::fs::remove_dir_all(&data);
}

/// A new install: Milagre's daemon runs but knows no Project. The window says so (not "Couldn't reach"), and Add
/// Project makes the first one, after which the window syncs and lists it.
#[gpui::test]
fn a_daemon_without_projects_starts_with_add_project(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let data = data_folder("no-projects");
    let prefs = data.join("sidebar.json");
    let fake = FakeDaemon::start(&data, World::with(Vec::new()));
    let session = DaemonSession::start(Daemon::new(Some(data.clone()), false));
    assert_eq!(session.error.as_deref(), Some(crate::daemon::NO_PROJECTS));
    let mut m = mount(cx, session, &prefs);
    assert_eq!(m.notice().as_deref(), Some(crate::daemon::NO_PROJECTS));
    m.call(SidebarCall::AddProject);
    m.until("the first Project opened", |_| calls(&fake, "project:open") == [json!([DELTA, {"takeNotice": true}])]);
    m.until("synced on it", |m| {
        m.controller.read_with(m.vcx, |c, _| c.unavailable().is_none()) && m.notice().as_deref() != Some(crate::daemon::NO_PROJECTS)
    });
    drop(m);
    drop(fake);
    let _ = std::fs::remove_dir_all(&data);
}

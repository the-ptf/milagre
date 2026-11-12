//! Paired computers on a fake Node daemon, unlocked with the shared client's stand-in password flow
//! (`unlock_computers_with_stand_in`, through `Daemon::set_unlocker(Unlocker::StandIn)`): the client's own sealing and
//! `computers:unlock` run against the fake, and nothing here reads this Mac's Keychain or touches a real vault.
//!
//! - `a_locked_vault_is_unlocked_and_the_computers_show`: locked at launch, unlocked once (the stand-in flips the fake's
//!   vault), then `computers:list` fills Settings and the sidebar lists the online computer's Chat (`tianxu|/remote/p#1`),
//!   read with `computers:invoke` on a connection of its own; its transcript is read the same way; a `computers:event`
//!   turn end notifies; `computers:forgotten` drops it. Pairing (`computers:add`) unlocks first.
//! - `a_refused_keychain_says_so`: `KEYCHAIN_UNAVAILABLE` → "Allow Keychain access …", computers stay hidden.
//! - `an_unlocked_vault_is_never_unlocked_again`: Electron already unlocked it: no unlock at all.
//! - `a_first_vault_key_is_created_without_milagre`: no vault and no key (a computer without Milagre.app): the client's
//!   stand-in unlock creates them (`ComputerUnlock::Created`: a 0600 `computer-vault-key.json` in the throwaway data
//!   folder), no notice, and the computers show; the same stand-in opens that key again.

use std::sync::Arc;

use gpui::TestAppContext;
use serde_json::{Value, json};

use super::daemon::{Recorder, Seen, mount_daemon_full};
use super::fake_daemon::{FakeDaemon, World, data_folder};
use crate::controller::DaemonSession;
use crate::daemon::{Daemon, Unlocker};

/// The stand-in for the "Milagre Safe Storage" Keychain password in every test here.
const STAND_IN: &[u8] = b"test-password";

fn stand_in() -> Unlocker {
    Unlocker::StandIn(STAND_IN.to_vec())
}

const ALPHA: &str = "/fake-node/alpha";
const REMOTE: &str = "/remote/p";

fn world(unlocked: bool) -> World {
    let mut world = World::with(vec![(ALPHA, "alpha", true, vec![(1, "Alpha", vec![("user", "Q"), ("assistant", "A")])])]);
    world.vault = json!({"unlocked": unlocked, "configuredFile": false, "hasVault": true, "needsLegacyImport": false});
    world.computers = json!({"thisMac": "Here", "enabled": true, "computers": [
        {"id": "tianxu", "name": "Tianxu", "state": "online"}, {"id": "santo", "name": "Santo", "state": "offline"}]});
    world.remote.insert("tianxu project:recent".into(), json!([{"path": REMOTE, "name": "remote-p"}]));
    world.remote.insert(
        "tianxu state:read".into(),
        json!({"version": 1, "epoch": "e", "state": {"next_id": 2, "messages": [], "tasks": {}, "projects": {"1": {"id": 1, "name": "p"}},
            "worktrees": {"1": {"id": 1, "name": "p", "path": REMOTE, "project_id": 1}},
            "sessions": {"1": {"id": 1, "worktree_id": 1, "agent_name": "fake", "provider": "claude", "title": "Remote chat",
                "summary": {"count": 2, "lastAt": 1_700_000_100_000i64, "firstAt": 1_700_000_000_000i64, "titleLine": "Remote question"}}}}}),
    );
    world.remote.insert("tianxu chat:runs".into(), json!({"runs": {}, "seq": 0}));
    world.remote.insert(
        "tianxu chat:messages".into(),
        json!({"messages": [{"id": 1, "session_id": 1, "body": "Remote question", "role": "user", "images": []},
                            {"id": 2, "session_id": 1, "body": "Remote answer", "role": "assistant", "images": []}], "hasMore": false, "total": 2}),
    );
    world
}

fn calls(fake: &FakeDaemon, method: &str) -> Vec<Value> {
    fake.log().into_iter().filter(|(m, _)| m == method).map(|(_, a)| a).collect()
}

fn mount<'a>(cx: &'a mut TestAppContext, daemon: Arc<Daemon>, seen: std::rc::Rc<std::cell::RefCell<Seen>>) -> super::owned::Mounted<'a> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let prefs = std::env::temp_dir().join(format!("gpui-computers-prefs-{}-{n}.json", std::process::id()));
    let session = DaemonSession::start(daemon);
    mount_daemon_full(cx, session, prefs, "/nonexistent/electron-preferences.json".into(), Some(Box::new(Recorder(seen))))
}

#[gpui::test]
fn a_locked_vault_is_unlocked_and_the_computers_show(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let data = data_folder("computers");
    let fake = FakeDaemon::start(&data, world(false));
    let daemon = Daemon::new(Some(data.clone()), false);
    daemon.set_unlocker(stand_in());
    // An existing vault and its sealed key, as Electron left them: the stand-in's first key, then locked again.
    {
        let mut w = fake.world();
        w.vault["hasVault"] = json!(false);
    }
    let first = futures::executor::block_on(daemon.unlock_computers(ALPHA)).unwrap();
    assert_eq!(first, crate::computers::Unlock::Done(milagre_daemon_client::ComputerUnlock::Created));
    {
        let mut w = fake.world();
        w.vault = json!({"unlocked": false, "configuredFile": false, "hasVault": true, "needsLegacyImport": false});
    }
    let seen = std::rc::Rc::new(std::cell::RefCell::new(Seen::default()));
    let mut m = mount(cx, daemon.clone(), seen.clone());

    m.wait_for("the computers", |m| m.vcx.update(|_, cx| cx.has_global::<milagre_gpui_spike::workspace::preview::PreviewComputers>()));
    assert_eq!(calls(&fake, "computers:unlock").len(), 2, "unlocked once at launch (after the setup's first key)");
    assert!(matches!(
        m.controller.read_with(m.vcx, |c, _| c.unlocked().cloned()),
        Some(crate::computers::Unlock::Done(milagre_daemon_client::ComputerUnlock::Unlocked { .. }))
    ));
    let remote_key = format!("tianxu|{REMOTE}#1");
    m.wait_for("the remote read", |_| daemon.remote("tianxu").is_some_and(|r| !r.states.is_empty()));
    m.wait_for("the remote Chat's row", |m| m.row_keys().contains(&remote_key));
    // `computers:invoke` went on its own connection: nothing else the window asked used it.
    let connections = fake.connections();
    let lanes: std::collections::BTreeSet<u64> = connections.iter().filter(|(_, m)| m == "computers:invoke").map(|(c, _)| *c).collect();
    assert_eq!(lanes.len(), 1, "one lane: {connections:?}");
    let lane = *lanes.iter().next().unwrap();
    assert!(
        connections.iter().filter(|(c, _)| *c == lane).all(|(_, m)| m == "computers:invoke" || m.starts_with("daemon:") || m == "hello"),
        "the lane carries only computers:invoke: {connections:?}"
    );
    assert!(calls(&fake, "computers:invoke").iter().all(|a| a[0] == "tianxu"), "only the online computer is asked");
    assert_eq!(calls(&fake, "computers:invoke").iter().find(|a| a[1] == "state:read").map(|a| a[2].clone()), Some(json!([REMOTE])));

    // The remote Chat's transcript, read on the lane.
    m.open(&remote_key);
    m.wait_for("the remote transcript", |m| m.items().iter().any(|i| i == "reply: Remote answer"));
    assert!(calls(&fake, "computers:invoke").iter().any(|a| a[1] == "chat:messages" && a[2][0] == REMOTE && a[2][1] == 1));

    // A remote turn's end notifies (the window is not focused in tests).
    fake.world().emit(
        "computers:event",
        json!({"computerId": "tianxu", "channel": "agent:event",
        "payload": {"chatId": remote_key, "event": {"type": "turn-started", "turnId": "x"}}}),
    );
    fake.world().emit(
        "computers:event",
        json!({"computerId": "tianxu", "channel": "agent:event",
        "payload": {"chatId": remote_key, "event": {"type": "text-delta", "text": "Done remotely"}}}),
    );
    fake.world().emit(
        "computers:event",
        json!({"computerId": "tianxu", "channel": "agent:event",
        "payload": {"chatId": remote_key, "event": {"type": "turn-completed"}}}),
    );
    m.wait_for("the remote notification", |_| seen.borrow().posts.iter().any(|p| p.chat == remote_key));
    assert_eq!(seen.borrow().posts.iter().find(|p| p.chat == remote_key).map(|p| p.title.clone()).as_deref(), Some("Remote chat"));

    // Pairing another computer unlocks first (already unlocked now: no Keychain read), then `computers:add`.
    m.controller.update(m.vcx, |c, cx| c.open_link("milagre://pair?x=1", cx));
    m.wait_for("computers:add", |_| !calls(&fake, "computers:add").is_empty());
    assert_eq!(calls(&fake, "computers:unlock").len(), 2, "an unlocked vault is not unlocked again");
    m.controller.update(m.vcx, |c, cx| c.set_computers_enabled(true, cx));
    m.wait_for("computers:set-enabled", |_| calls(&fake, "computers:set-enabled") == vec![json!([true])]);

    // Forgotten: its Chats go.
    {
        let mut w = fake.world();
        w.computers = json!({"thisMac": "Here", "enabled": true, "computers": []});
        w.emit("computers:forgotten", json!({"computerId": "tianxu"}));
    }
    m.wait_for("the remote row gone", |m| !m.row_keys().contains(&remote_key));
    assert!(daemon.remote("tianxu").is_none());

    m.controller.update(m.vcx, |c, _| c.disconnect());
    drop(m);
    drop(fake);
    let _ = std::fs::remove_dir_all(&data);
}

#[gpui::test]
fn a_refused_keychain_says_so(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let data = data_folder("computers-keychain");
    let fake = FakeDaemon::start(&data, world(false));
    let daemon = Daemon::new(Some(data.clone()), false);
    // A refused Keychain read: the one outcome the stand-in cannot produce.
    daemon.set_unlocker(Unlocker::Fail { code: "KEYCHAIN_UNAVAILABLE".into(), message: "Allow access".into() });
    let seen = std::rc::Rc::new(std::cell::RefCell::new(Seen::default()));
    let mut m = mount(cx, daemon, seen);
    let sidebar = m.workspace.read_with(m.vcx, |w, _| w.sidebar.clone());
    m.wait_for("the Keychain notice", |m| {
        sidebar.read_with(m.vcx, |s, _| s.notice().map(|n| n.to_string())).as_deref() == Some(crate::computers::ALLOW_KEYCHAIN)
    });
    assert!(m.vcx.update(|_, cx| !cx.has_global::<milagre_gpui_spike::workspace::preview::PreviewComputers>()), "hidden while locked");
    assert!(calls(&fake, "computers:invoke").is_empty() && calls(&fake, "computers:list").is_empty());
    m.controller.update(m.vcx, |c, _| c.disconnect());
    drop(m);
    drop(fake);
    let _ = std::fs::remove_dir_all(&data);
}

#[gpui::test]
fn an_unlocked_vault_is_never_unlocked_again(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let data = data_folder("computers-unlocked");
    let fake = FakeDaemon::start(&data, world(true));
    let daemon = Daemon::new(Some(data.clone()), false);
    daemon.set_unlocker(stand_in());
    let seen = std::rc::Rc::new(std::cell::RefCell::new(Seen::default()));
    let mut m = mount(cx, daemon, seen);
    m.wait_for("the computers", |m| m.vcx.update(|_, cx| cx.has_global::<milagre_gpui_spike::workspace::preview::PreviewComputers>()));
    assert!(matches!(
        m.controller.read_with(m.vcx, |c, _| c.unlocked().cloned()),
        Some(crate::computers::Unlock::Done(milagre_daemon_client::ComputerUnlock::AlreadyUnlocked))
    ));
    assert!(calls(&fake, "computers:unlock").is_empty(), "never unlocked again");
    assert!(!data.join("computer-vault-key.json").exists(), "no key written");
    m.controller.update(m.vcx, |c, _| c.disconnect());
    drop(m);
    drop(fake);
    let _ = std::fs::remove_dir_all(&data);
}

#[gpui::test]
fn a_first_vault_key_is_created_without_milagre(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let data = data_folder("computers-created");
    let mut first = world(false);
    first.vault = json!({"unlocked": false, "configuredFile": false, "hasVault": false, "needsLegacyImport": false});
    let fake = FakeDaemon::start(&data, first);
    let daemon = Daemon::new(Some(data.clone()), false);
    daemon.set_unlocker(stand_in());
    let seen = std::rc::Rc::new(std::cell::RefCell::new(Seen::default()));
    let mut m = mount(cx, daemon.clone(), seen);
    m.wait_for("the computers", |m| m.vcx.update(|_, cx| cx.has_global::<milagre_gpui_spike::workspace::preview::PreviewComputers>()));
    assert_eq!(calls(&fake, "computers:unlock").len(), 1, "created and unlocked once");
    let key = data.join("computer-vault-key.json");
    assert!(key.exists(), "the sealed key is in the throwaway data folder");
    assert_eq!(std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(&key).unwrap().permissions()) & 0o777, 0o600);
    let unlocked = m.controller.read_with(m.vcx, |c, _| c.unlocked().cloned());
    assert_eq!(unlocked, Some(crate::computers::Unlock::Done(milagre_daemon_client::ComputerUnlock::Created)));
    assert_eq!(unlocked.and_then(|u| u.notice()), None, "nothing to say");
    let notice = m.workspace.read_with(m.vcx, |w, cx| w.sidebar.read(cx).notice().cloned());
    assert_eq!(notice, None);
    m.controller.update(m.vcx, |c, _| c.disconnect());
    drop(m);
    drop(fake);
    let _ = std::fs::remove_dir_all(&data);
}

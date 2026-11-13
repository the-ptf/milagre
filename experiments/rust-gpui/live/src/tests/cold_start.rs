//! The window on a daemon that was not running when it opened, or had loaded nothing yet (Milagre.app closed, the
//! Preview started its daemon), and the Projects' pictures.
//!
//! - `a_cold_start_lands_on_the_chats_not_onboarding`: the window opens with no daemon; the daemon comes up later with
//!   Projects it has not loaded. Onboarding never shows (not before the sync, not after); the most recently opened
//!   Project is loaded (`project:read {state:false}`, never `project:open`), shown as "Loading…" meanwhile, then its
//!   Chats are listed and its newest Chat opens.
//! - `a_synced_daemon_with_nothing_loaded_is_not_onboarding`: the first sync before the window succeeded with an empty
//!   snapshot (the case that opened onboarding): no onboarding, the first Project loads and its newest Chat opens.
//! - `an_empty_daemon_shows_add_project`: a daemon with no Project at all: the sidebar says to add one (Add Project),
//!   no Project is loaded, nothing loops.
//! - `project_pictures_replace_the_letter`: `project:image` once per loaded Project; a picture lands in that
//!   Project's rows and in the new-Chat picker; a Project without one keeps its letter.

use std::time::Duration;

use gpui::TestAppContext;
use serde_json::json;

use super::daemon::mount_daemon;
use super::fake_daemon::{FakeDaemon, World, data_folder};
use super::owned::Mounted;
use crate::controller::DaemonSession;
use crate::daemon::{self, Daemon};

const ALPHA: &str = "/fake-node/alpha";
const BETA: &str = "/fake-node/beta";

/// A 1×1 PNG.
const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

/// Two Projects, both known and loaded as `loaded` says; alpha is the most recently opened.
fn world(loaded: bool) -> World {
    World::with(vec![
        (
            ALPHA,
            "alpha",
            loaded,
            vec![
                (1, "Alpha first", vec![("user", "Alpha question"), ("assistant", "Alpha answer")]),
                (2, "Alpha second", vec![("user", "Second question"), ("assistant", "Second answer")]),
            ],
        ),
        (BETA, "beta", loaded, vec![(1, "Beta only", vec![("user", "Beta question"), ("assistant", "Beta answer")])]),
    ])
}

fn onboarding(m: &mut Mounted<'_>) -> bool {
    m.workspace.read_with(m.vcx, |w, cx| w.onboarding.read(cx).is_active())
}

fn loads(fake: &FakeDaemon) -> Vec<serde_json::Value> {
    fake.log().into_iter().filter(|(method, _)| method == "project:read").map(|(_, args)| args).collect()
}

#[gpui::test]
fn a_cold_start_lands_on_the_chats_not_onboarding(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let data = data_folder("cold-start");
    let daemon = Daemon::new(Some(data.clone()), false);
    let session = DaemonSession::start(daemon.clone());
    assert!(session.error.is_some(), "no daemon when the window opens");
    let mut m = mount_daemon(cx, session);
    assert!(!onboarding(&mut m), "no onboarding before the first sync");
    assert!(m.row_keys().is_empty());

    // The daemon comes up (the Preview started it) with Projects it has not loaded.
    let fake = FakeDaemon::start(&data, world(false));
    let mut saw_loading = false;
    m.wait_for("the first Project's Chats", |m| {
        assert!(!onboarding(m), "no onboarding while syncing and loading");
        let sidebar = m.workspace.read_with(m.vcx, |w, _| w.sidebar.clone());
        saw_loading |= sidebar.read_with(m.vcx, |s, _| s.unloaded_projects().iter().any(|p| p.loading && p.name.as_ref() == "alpha"));
        m.row_keys().contains(&format!("{ALPHA}#1"))
    });
    m.wait_for("the newest Chat open", |m| m.open_key().as_deref() == Some(format!("{ALPHA}#2").as_str()));
    assert!(!onboarding(&mut m));
    let sidebar = m.workspace.read_with(m.vcx, |w, _| w.sidebar.clone());
    assert!(sidebar.read_with(m.vcx, |s, _| s.unloaded_projects().is_empty()), "the loading row goes once its Chats arrive");
    let loads = loads(&fake);
    assert!(loads.contains(&json!([ALPHA, {"state": false}])), "{loads:?}");
    assert!(!loads.iter().any(|a| a[0] == BETA), "only the most recent Project is loaded: {loads:?}");
    assert!(!fake.methods().iter().any(|m| m == "project:open"), "never project:open");
    println!("GPUI_COLD_START loads={loads:?} saw_loading={saw_loading}");
    m.controller.update(m.vcx, |c, _| c.disconnect());
    drop(m);
    drop(fake);
    let _ = std::fs::remove_dir_all(&data);
}

#[gpui::test]
fn a_synced_daemon_with_nothing_loaded_is_not_onboarding(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let data = data_folder("cold-synced");
    let fake = FakeDaemon::start(&data, world(false));
    let session = DaemonSession::start(Daemon::new(Some(data.clone()), false));
    assert!(session.error.is_none(), "synced before the window: {:?}", session.error);
    let mut m = mount_daemon(cx, session);
    assert!(!onboarding(&mut m), "an empty snapshot is not a daemon without Projects");
    m.wait_for("the newest Chat open", |m| {
        assert!(!onboarding(m));
        m.open_key().as_deref() == Some(format!("{ALPHA}#2").as_str()) && m.items().len() == 2
    });
    m.controller.update(m.vcx, |c, _| c.disconnect());
    drop(m);
    drop(fake);
    let _ = std::fs::remove_dir_all(&data);
}

#[gpui::test]
fn an_empty_daemon_shows_add_project(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let data = data_folder("cold-empty");
    let fake = FakeDaemon::start(&data, World::with(Vec::new()));
    let session = DaemonSession::start(Daemon::new(Some(data.clone()), false));
    assert_eq!(session.error.as_deref(), Some(daemon::NO_PROJECTS));
    let mut m = mount_daemon(cx, session);
    std::thread::sleep(Duration::from_millis(300));
    m.vcx.run_until_parked();
    let notice = m.workspace.read_with(m.vcx, |w, cx| w.sidebar.read(cx).notice().cloned());
    assert_eq!(notice.as_deref(), Some(daemon::NO_PROJECTS), "the sidebar says to add a Project");
    assert!(m.row_keys().is_empty());
    assert!(loads(&fake).is_empty(), "nothing to load");
    m.controller.update(m.vcx, |c, _| c.disconnect());
    drop(m);
    drop(fake);
    let _ = std::fs::remove_dir_all(&data);
}

#[gpui::test]
fn project_pictures_replace_the_letter(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let data = data_folder("pictures");
    let mut world = world(true);
    world.images.insert(ALPHA.to_owned(), json!(format!("data:image/png;base64,{PNG}")));
    let fake = FakeDaemon::start(&data, world);
    let daemon = Daemon::new(Some(data.clone()), false);
    let session = DaemonSession::start(daemon.clone());
    let mut m = mount_daemon(cx, session);
    let sidebar = m.workspace.read_with(m.vcx, |w, _| w.sidebar.clone());
    m.wait_for("alpha's picture in its rows", |m| {
        sidebar.read_with(m.vcx, |s, _| s.rows().iter().any(|row| row.key.starts_with(ALPHA) && row.image.is_some()))
    });
    let rows: Vec<(String, bool)> =
        sidebar.read_with(m.vcx, |s, _| s.rows().iter().map(|row| (row.key.to_string(), row.image.is_some())).collect());
    for (key, has) in &rows {
        assert_eq!(*has, key.starts_with(ALPHA), "{key}: only alpha has a picture: {rows:?}");
    }
    let image = sidebar.read_with(m.vcx, |s, _| s.rows().iter().find_map(|row| row.image.clone())).unwrap();
    assert_eq!(image.format, gpui::ImageFormat::Png);

    // The new-Chat picker draws it too.
    m.vcx.update(|window, cx| m.workspace.update(cx, |w, cx| w.show_new_chat(window, cx)));
    m.vcx.run_until_parked();
    let composer = m.workspace.read_with(m.vcx, |w, cx| w.chat.read(cx).composer.clone());
    m.wait_for("the picker's Projects", |m| composer.read_with(m.vcx, |c, cx| c.new_chat_options(cx).projects.len() == 2));
    let pictures: Vec<(String, bool)> = composer.read_with(m.vcx, |c, cx| {
        c.new_chat_options(cx).projects.iter().map(|p| (p.path.to_string(), p.image.is_some())).collect()
    });
    assert_eq!(pictures, [(ALPHA.to_owned(), true), (BETA.to_owned(), false)]);

    // Read once per Project per run, even across another sync.
    daemon.resync();
    m.wait_for("a second sync", |m| m.controller.read_with(m.vcx, |c, _| c.syncs() >= 1));
    std::thread::sleep(Duration::from_millis(200));
    m.vcx.run_until_parked();
    let mut asked: Vec<String> =
        fake.log().into_iter().filter(|(method, _)| method == "project:image").map(|(_, args)| args.to_string()).collect();
    asked.sort();
    assert_eq!(asked, [json!([ALPHA]).to_string(), json!([BETA]).to_string()], "once per loaded Project");
    println!("GPUI_PROJECT_PICTURES rows={rows:?} picker={pictures:?}");
    m.controller.update(m.vcx, |c, _| c.disconnect());
    drop(m);
    drop(fake);
    let _ = std::fs::remove_dir_all(&data);
}

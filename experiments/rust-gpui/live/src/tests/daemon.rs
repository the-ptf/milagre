//! Node-daemon mode on a fake Node daemon ([`super::fake_daemon`]): adoption through the public path on a throwaway
//! data folder's derived socket, never the installed Milagre's. The window is driven through its views as a person
//! would; every assertion about the wire reads the fake's request log.
//!
//! - `adopt_fails_then_follows_a_restarted_daemon`: no daemon (`DAEMON_UNAVAILABLE`), adoption, and a restarted daemon
//!   (another process, so another PID: `INSTALLED_OWNER_CHANGED`) adopted again on the next connection.
//! - `the_window_runs_chats_on_the_node_daemon`: the loaded Projects' Chats in one sidebar (an unloaded one is never
//!   read), transcripts on each Project's own client, the Chat's own provider and model on sends, an approval, a
//!   question, Stop, Rename, Done, Reopen, a Terminal, Changes and a new Chat on the picker's model.
//! - `a_read_only_window_writes_nothing`: the `--snapshot` mode: nothing but adoption, the snapshot and reads.
//! - `the_window_waits_for_milagre_and_follows_a_restart`: "Open Milagre first", then the daemon starts, then it
//!   restarts in another process and the window syncs again on its own.

use std::path::Path;
use std::process::{Child, Command};
use std::time::{Duration, Instant};

use futures::executor::block_on;
use gpui::{AnyView, AppContext as _, Modifiers, TestAppContext};
use gpui_component::Root;
use milagre_gpui_spike::data::Provider;
use milagre_gpui_spike::workspace::Workspace;
use milagre_gpui_spike::workspace::chat::transcript::CardDecision;
use serde_json::Value;

use super::fake_daemon::{FakeDaemon, World, data_folder, socket_for};
use super::owned::Mounted;
use crate::controller::{DaemonSession, LiveController, install_daemon_globals};
use crate::daemon::{self, Daemon};

const ALPHA: &str = "/fake-node/alpha";
const BETA: &str = "/fake-node/beta";
const GAMMA: &str = "/fake-node/gamma";

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
        (BETA, "beta", true, vec![(1, "Beta only", vec![("user", "Beta question"), ("assistant", "Beta answer")])]),
        (GAMMA, "gamma", false, vec![(1, "Gamma unloaded", vec![("user", "never read"), ("assistant", "never read")])]),
    ])
}

/// The test binary itself, serving [`world`] as a fake daemon of its own process (another PID).
fn fake_process(data: &Path) -> Child {
    let child = Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--exact", "tests::daemon::fake_daemon_process", "--nocapture", "--test-threads=1"])
        .env("GPUI_FAKE_DAEMON_DATA", data)
        .stdout(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let until = Instant::now() + Duration::from_secs(20);
    while std::os::unix::net::UnixStream::connect(socket_for(data)).is_err() {
        assert!(Instant::now() < until, "the fake daemon process did not listen");
        std::thread::sleep(Duration::from_millis(20));
    }
    child
}

fn stop_process(mut child: Child, data: &Path) {
    // A process this test started, and only that one.
    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_file(socket_for(data));
}

/// Entry point of [`fake_process`] (does nothing when run on its own). Exits when its parent test does.
#[test]
#[ignore = "the fake daemon process: started by the daemon tests"]
fn fake_daemon_process() {
    let Some(data) = std::env::var_os("GPUI_FAKE_DAEMON_DATA") else { return };
    let parent = unsafe { libc::getppid() };
    let _daemon = FakeDaemon::start(Path::new(&data), world());
    while unsafe { libc::getppid() } == parent {
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[test]
fn adopt_fails_then_follows_a_restarted_daemon() {
    let data = data_folder("adopt");
    let daemon = Daemon::new(Some(data.clone()), false);
    // No daemon: unavailable, nothing launched.
    let error = block_on(daemon.sync()).err().expect("no daemon yet");
    assert_eq!(daemon::code(&error), Some(daemon::UNAVAILABLE), "{error:#}");
    assert!(daemon::unavailable(&error));

    let first = fake_process(&data);
    let synced = block_on(daemon.sync()).expect("adopt and sync");
    assert_eq!(synced.pid, first.id());
    assert_eq!(daemon.known().iter().map(|k| k.path.as_str()).collect::<Vec<_>>(), [ALPHA, BETA, GAMMA]);
    let projects = synced.reducer.state().unwrap().projects.iter().map(|o| o.project.path.to_string()).collect::<Vec<_>>();
    assert_eq!(projects, [ALPHA, BETA], "only the loaded Projects are in the snapshot");
    drop(synced);

    // The daemon restarts (another process): the pinned owner no longer matches and is adopted again.
    stop_process(first, &data);
    let second = fake_process(&data);
    let installed = block_on(async {
        let owner = milagre_daemon_client::InstalledOwner::adopt_profile(&data).await.unwrap();
        owner.info().pid
    });
    assert_eq!(installed, second.id());
    let (client, _, _) = block_on(daemon.connect(BETA)).expect("adopted again after INSTALLED_OWNER_CHANGED");
    assert_eq!(daemon.pid(), Some(second.id()), "the new daemon is the one adopted");
    client.disconnect();
    // A write connection opens its view; a read-only Daemon refuses before connecting.
    let writer = block_on(daemon.writer(BETA)).expect("a write connection");
    drop(writer);
    let read_only = Daemon::new(Some(data.clone()), true);
    assert!(block_on(read_only.writer(BETA)).is_err());
    stop_process(second, &data);
    let _ = std::fs::remove_dir_all(&data);
}

fn mount_daemon(cx: &mut TestAppContext, session: DaemonSession) -> Mounted<'_> {
    let wiring = cx.update(|cx| {
        cx.set_global(milagre_gpui_spike::theme::Theme::dark());
        gpui_component::init(cx);
        milagre_gpui_spike::theme::component_bridge::init(cx);
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
    fn row_keys(&mut self) -> Vec<String> {
        let sidebar = self.workspace.read_with(self.vcx, |w, _| w.sidebar.clone());
        sidebar.read_with(self.vcx, |s, _| s.row_keys())
    }

    /// Opens a Chat as a click on its row does (the window follows its sidebar when it draws; here at once).
    fn open(&mut self, key: &str) {
        self.workspace.update(self.vcx, |w, cx| w.open_chat_key(key, cx));
        let (sidebar, chat) = self.workspace.read_with(self.vcx, |w, _| (w.sidebar.clone(), w.chat.clone()));
        let row = sidebar.read_with(self.vcx, |s, _| s.selected_row().cloned()).expect("the row");
        self.vcx.update(|window, cx| chat.update(cx, |c, cx| c.set_chat(&row, window, cx)));
        self.vcx.run_until_parked();
    }

    fn open_key(&mut self) -> Option<String> {
        self.controller.read_with(self.vcx, |c, _| c.open_key().map(str::to_owned))
    }

    fn composer_model(&mut self) -> (Provider, String, bool) {
        let composer = self.workspace.read_with(self.vcx, |w, cx| w.chat.read(cx).composer.clone());
        composer.read_with(self.vcx, |c, _| {
            let (provider, model) = c.model();
            (provider, model.to_string(), c.limits().model_locked)
        })
    }

    fn wait_for(&mut self, what: &str, mut done: impl FnMut(&mut Self) -> bool) {
        self.until(what, |m| done(m));
    }
}

fn sent(fake: &FakeDaemon) -> Vec<Value> {
    fake.log().into_iter().filter(|(method, _)| method == "chat:send").map(|(_, args)| args[0].clone()).collect()
}

#[gpui::test]
fn the_window_runs_chats_on_the_node_daemon(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let data = data_folder("window");
    let fake = FakeDaemon::start(&data, world());
    let session = DaemonSession::start(Daemon::new(Some(data.clone()), false));
    assert!(session.error.is_none(), "{:?}", session.error);
    let mut m = mount_daemon(cx, session);

    // 1. One sidebar over the loaded Projects; the unloaded one is never read; nothing is opened by reading.
    m.wait_for("the rows", |m| m.row_keys().len() == 3);
    let mut keys = m.row_keys();
    keys.sort();
    assert_eq!(keys, [format!("{ALPHA}#1"), format!("{ALPHA}#2"), format!("{BETA}#1")]);
    let reads = fake.methods();
    assert!(!reads.iter().any(|m| m == "project:open"), "no project:open for reads: {reads:?}");
    assert!(!fake.log().iter().any(|(m, a)| m == "project:read" && a[0] == GAMMA), "the unloaded Project is never read");
    assert!(m.vcx.debug_bounds("preview-note").is_some(), "Preview mode: Routines, Settings and the rest are off");

    // 2. The newest Chat opens with its saved transcript, on its own provider and model (locked).
    m.wait_for("the newest Chat's transcript", |m| m.items().len() == 2);
    let newest = m.open_key().expect("a Chat is open");
    assert_eq!(newest, format!("{ALPHA}#2"), "the newest activity across Projects");
    assert_eq!(m.items(), ["user: Second question", "reply: Second answer"]);
    assert_eq!(m.composer_model(), (Provider::Codex, "gpt-5.5".into(), true));

    // 3. Another Project's Chat: its transcript is read on that Project's own client; then back to alpha.
    m.open(&format!("{BETA}#1"));
    m.wait_for("beta's transcript", |m| m.items() == ["user: Beta question", "reply: Beta answer"]);
    assert!(fake.log().iter().any(|(m, a)| m == "chat:messages" && a[0] == BETA && a[1] == 1), "beta's messages were read");
    m.open(&format!("{ALPHA}#1"));
    m.wait_for("alpha's transcript", |m| m.items() == ["user: Alpha question", "reply: Alpha answer"]);

    // 4. Changes: the daemon's Git reads need the Project's view: one project:open, then the reads.
    let panel = m.workspace.read_with(m.vcx, |w, _| w.panel.clone());
    m.wait_for("the live Changes", |m| panel.read_with(m.vcx, |p, _| p.is_live()));
    assert!(fake.methods().iter().any(|m| m == "git:diff-files"));

    // 5. A send to an existing Chat: its own provider and model, its id, after project:open.
    m.type_and_send("hello daemon");
    m.wait_for("the saved reply", |m| {
        !m.running() && m.items().last().is_some_and(|i| i == "reply: codex gpt-5.5 replied to: hello daemon")
    });
    let send = sent(&fake).pop().unwrap();
    assert_eq!((send["provider"].as_str(), send["model"].as_str(), send["sessionId"].as_u64()), (Some("codex"), Some("gpt-5.5"), Some(1)));
    assert_eq!(send["permissionMode"], "auto", "the Chat's own permission mode");
    let opened = fake.log().iter().filter(|(m, a)| m == "project:open" && a[0] == ALPHA).count();
    assert!(opened >= 1, "writes open the Project's view first");

    // 6. An approval: the card, Allow once.
    m.type_and_send("[approve] run it");
    m.wait_for("the approval card", |m| m.items().iter().any(|i| i.starts_with("approval Waiting")));
    assert!(m.running());
    let at = m.vcx.debug_bounds("approval-allow-once").expect("the Allow once button").center();
    m.vcx.simulate_click(at, Modifiers::none());
    m.wait_for("the allowed reply", |m| !m.running() && m.items().last().is_some_and(|i| i == "reply: Allowed (allow)"));
    let decisions = m.controller.read_with(m.vcx, |c, _| c.decisions().to_vec());
    assert_eq!(decisions.last().map(|d| d.1.as_str()), Some("AllowOnce"));

    // 7. A question, answered from its card.
    m.type_and_send("[ask] pick one");
    m.wait_for("the question card", |m| m.items().iter().any(|i| i.starts_with("question q-")));
    let (ix, request) = {
        let items = m.items();
        let ix = items.iter().position(|i| i.starts_with("question q-")).unwrap();
        (ix, items[ix].split_whitespace().nth(1).unwrap().trim_end_matches(':').to_owned())
    };
    let transcript = m.workspace.read_with(m.vcx, |w, cx| w.chat.read(cx).transcript.clone());
    transcript.update(m.vcx, |_, cx| {
        cx.emit(CardDecision::Question { ix, request_id: request.clone().into(), answers: Some(vec![("pick".into(), vec!["A".into()])]) })
    });
    m.wait_for("the answered reply", |m| !m.running() && m.items().last().is_some_and(|i| i.starts_with("reply: Answered")));
    let answered = fake.log().into_iter().find(|(m, _)| m == "agent:answer-question").expect("answered").1;
    assert_eq!(answered[0]["answers"]["pick"][0], "A");

    // 8. Stop on a running turn.
    m.type_and_send("[hold] keep going");
    m.wait_for("the streamed text", |m| m.running() && m.items().iter().any(|i| i == "reply: Working"));
    let composer = m.workspace.read_with(m.vcx, |w, cx| w.chat.read(cx).composer.clone());
    m.vcx.update(|window, cx| composer.update(cx, |c, cx| c.press_send(window, cx)));
    m.wait_for("the interrupted turn", |m| {
        !m.running()
            && fake.log().iter().any(|(m, a)| m == "agent:interrupt" && a[0] == format!("{ALPHA}#1"))
            && fake.world().runs.is_empty()
    });

    // 9. Sidebar writes: Rename, Done, Reopen, on the Chat's own Project.
    let key = format!("{ALPHA}#1");
    let actions = m.vcx.update(|_, cx| cx.global::<milagre_gpui_spike::workspace::sidebar::Actions>().0.clone());
    actions.call(milagre_gpui_spike::workspace::sidebar::SidebarCall::Patch {
        chat: key.clone(),
        patch: milagre_gpui_spike::workspace::sidebar::ChatPatch::Title("Renamed on Node".into()),
    });
    m.wait_for("the saved title", |m| {
        fake.world().projects[ALPHA].sessions[&1]["title"] == "Renamed on Node"
            && m.row_keys().contains(&key)
            && m.workspace.read_with(m.vcx, |w, cx| {
                let s = w.sidebar.read(cx);
                (0..s.row_count()).filter_map(|ix| s.row(ix)).any(|r| r.key.as_ref() == key && r.title.as_ref() == "Renamed on Node")
            })
    });
    let sidebar = m.workspace.read_with(m.vcx, |w, _| w.sidebar.clone());
    let row = sidebar.read_with(m.vcx, |s, _| (0..s.row_count()).position(|ix| s.row(ix).is_some_and(|r| r.key.as_ref() == key))).unwrap();
    sidebar.update(m.vcx, |s, cx| s.toggle_done_row(row, cx));
    m.wait_for("the saved Done", |m| !fake.world().projects[ALPHA].sessions[&1]["done_at"].is_null() && !m.row_keys().contains(&key));
    sidebar.update(m.vcx, |s, cx| s.reopen(&key, true, cx));
    m.wait_for("the saved Reopen", |m| fake.world().projects[ALPHA].sessions[&1]["done_at"].is_null() && m.row_keys().contains(&key));
    let patches: Vec<Value> = fake.log().into_iter().filter(|(m, _)| m == "chat:patch").map(|(_, a)| a).collect();
    assert!(patches.iter().all(|a| a[0] == ALPHA && a[1] == 1), "{patches:?}");

    // 10. A Terminal on the Chat's Project: opened, typed into, its output in the grid.
    let drawer = m.workspace.read_with(m.vcx, |w, _| w.terminals.clone());
    drawer.update(m.vcx, |d, cx| d.set_chat(key.clone().into(), cx));
    let view = drawer.update(m.vcx, |d, cx| d.add(cx)).expect("a Terminal tab");
    view.update(m.vcx, |v, cx| v.input(b"echo node-terminal\r".to_vec(), cx));
    let screen = |m: &mut Mounted| {
        view.read_with(m.vcx, |v, _| {
            use alacritty_terminal::grid::Dimensions as _;
            let term = v.session().term.lock();
            let (lines, cols) = (term.screen_lines() as i32, term.columns());
            (0..lines)
                .map(|line| milagre_gpui_spike::workspace::panel::terminal::grid::grid_text(&*term, line, 0..=cols - 1))
                .collect::<Vec<_>>()
                .join("\n")
        })
    };
    m.wait_for("the Terminal's output", |m| screen(m).contains("echo node-terminal"));
    assert!(fake.log().iter().any(|(m, a)| m == "terminal:open" && a[0]["chatId"] == key));
    drawer.update(m.vcx, |d, cx| d.hide(cx));
    drop(view);

    // 11. A new Chat on the picker's model, in the most recent Project.
    m.vcx.update(|window, cx| m.workspace.update(cx, |w, cx| w.show_new_chat(window, cx)));
    m.vcx.run_until_parked();
    assert!(!m.composer_model().2, "a new Chat's model is the picker's");
    let kiro = milagre_gpui_spike::workspace::chat::composer::models::find(Provider::Kiro, "kiro:auto").unwrap();
    composer.update(m.vcx, |c, cx| c.pick_model(&kiro, cx));
    m.vcx.run_until_parked();
    m.type_and_send("a brand new Chat");
    let new_key = format!("{ALPHA}#3");
    m.wait_for("the new Chat open", |m| m.open_key().as_deref() == Some(new_key.as_str()) && !m.running() && m.items().len() == 2);
    let send = sent(&fake).pop().unwrap();
    assert_eq!((send["provider"].as_str(), send["model"].as_str()), (Some("kiro"), Some("kiro:auto")));
    assert!(send.get("sessionId").is_none(), "a new Chat names none");
    assert_eq!(m.items().last().map(String::as_str), Some("reply: kiro kiro:auto replied to: a brand new Chat"));

    // Quit closes this window's connections only.
    m.controller.update(m.vcx, |c, _| c.disconnect());
    assert!(std::os::unix::net::UnixStream::connect(&fake.socket).is_ok(), "the daemon keeps running");
    let errors = m.controller.read_with(m.vcx, |c, _| c.errors().to_vec());
    assert!(errors.is_empty(), "{errors:?}");
    drop(m);
    drop(fake);
    let _ = std::fs::remove_dir_all(&data);
}

#[gpui::test]
fn a_read_only_window_writes_nothing(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let data = data_folder("readonly");
    let fake = FakeDaemon::start(&data, world());
    let session = DaemonSession::start(Daemon::new(Some(data.clone()), true));
    let mut m = mount_daemon(cx, session);
    m.wait_for("the transcript", |m| m.items().len() == 2);
    // Every write path a person could take: a send, a sidebar patch, a permission-mode change, a Terminal.
    m.type_and_send("must not be sent");
    let actions = m.vcx.update(|_, cx| cx.global::<milagre_gpui_spike::workspace::sidebar::Actions>().0.clone());
    actions.call(milagre_gpui_spike::workspace::sidebar::SidebarCall::Patch {
        chat: format!("{BETA}#1"),
        patch: milagre_gpui_spike::workspace::sidebar::ChatPatch::Unread(true),
    });
    let composer = m.workspace.read_with(m.vcx, |w, cx| w.chat.read(cx).composer.clone());
    composer.update(m.vcx, |c, cx| c.set_permission_mode(milagre_gpui_spike::data::PermissionMode::Full, cx));
    let drawer = m.workspace.read_with(m.vcx, |w, _| w.terminals.clone());
    drawer.update(m.vcx, |d, cx| d.set_chat(format!("{BETA}#1").into(), cx));
    let _view = drawer.update(m.vcx, |d, cx| d.add(cx));
    m.wait_for("the refusals", |m| m.controller.read_with(m.vcx, |c, _| c.refused().len()) >= 2);
    std::thread::sleep(Duration::from_millis(200));
    m.vcx.run_until_parked();
    let methods = fake.methods();
    let allowed = ["daemon:status", "project:known", "daemon:snapshot", "daemon:snapshot-page", "chat:messages"];
    assert!(methods.iter().all(|m| allowed.contains(&m.as_str())), "read-only reached the daemon with: {methods:?}");
    println!("GPUI_DAEMON_READ_ONLY methods={methods:?} refused={:?}", m.controller.read_with(m.vcx, |c, _| c.refused().to_vec()));
    drop(m);
    drop(fake);
    let _ = std::fs::remove_dir_all(&data);
}

#[gpui::test]
fn the_window_waits_for_milagre_and_follows_a_restart(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let data = data_folder("waits");
    let daemon = Daemon::new(Some(data.clone()), false);
    let session = DaemonSession::start(daemon.clone());
    assert_eq!(session.error.as_deref(), Some(daemon::OPEN_MILAGRE_FIRST));
    let mut m = mount_daemon(cx, session);
    // No daemon: the window says so (no crash, nothing to send to).
    assert_eq!(m.controller.read_with(m.vcx, |c, _| c.unavailable().map(str::to_owned)).as_deref(), Some(daemon::OPEN_MILAGRE_FIRST));
    let notice = m.workspace.read_with(m.vcx, |w, cx| w.sidebar.read(cx).notice().cloned());
    assert_eq!(notice.as_deref(), Some(daemon::OPEN_MILAGRE_FIRST));
    assert!(m.row_keys().is_empty());

    // Milagre starts: the window connects on its own and opens the newest Chat.
    let fake = FakeDaemon::start(&data, world());
    m.wait_for("the first sync", |m| m.controller.read_with(m.vcx, |c, _| c.unavailable().is_none()) && m.row_keys().len() == 3);
    m.wait_for("the newest Chat", |m| m.open_key().is_some() && m.items().len() == 2);
    let first_pid = daemon.pid();
    assert_eq!(first_pid, Some(std::process::id()));

    // Milagre restarts (another process): the stream closes and the window adopts the new daemon by itself.
    fake.stop();
    drop(fake);
    let restarted = fake_process(&data);
    m.wait_for("the sync after the restart", |m| {
        // Reads cut by the restart are reported, then retried by the next sync.
        let _ = m.controller.update(m.vcx, |c, _| c.take_errors());
        daemon.pid() == Some(restarted.id()) && m.controller.read_with(m.vcx, |c, _| c.unavailable().is_none()) && m.row_keys().len() == 3
    });
    let syncs = m.controller.read_with(m.vcx, |c, _| c.syncs());
    assert!(syncs >= 2, "synced at start and after the restart: {syncs}");
    m.controller.update(m.vcx, |c, _| c.disconnect());
    drop(m);
    stop_process(restarted, &data);
    let _ = std::fs::remove_dir_all(&data);
}

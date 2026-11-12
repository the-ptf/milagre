//! Node-daemon mode on a fake Node daemon ([`super::fake_daemon`]): adoption through the public path on a throwaway
//! data folder's derived socket, never the installed Milagre's. The window is driven through its views as a person
//! would; every assertion about the wire reads the fake's request log.
//!
//! - `adopt_fails_then_follows_a_restarted_daemon`: no daemon (`DAEMON_UNAVAILABLE`), adoption, and a restarted daemon
//!   (another process, so another PID: `INSTALLED_OWNER_CHANGED`) adopted again on the next connection.
//! - `the_window_runs_chats_on_the_node_daemon`: the loaded Projects' Chats in one sidebar (an unloaded one gets no
//!   row and is never read; no status text under the rows), transcripts on each Project's own client, the Chat's own provider and model on sends, an
//!   approval, a question, Stop, Rename, Done, Reopen, a Terminal (one request-only connection, no snapshot), Changes
//!   and a new Chat on the picker's model; never a `project:open`, every write's connection loaded with
//!   `project:read [path, {state:false}]`.
//! - `an_unloaded_project_loads_when_opened`: no row and never loaded by itself; opened on purpose (`load_project`,
//!   the path a ⌘K search takes), then loaded (`load_view`), synced
//!   again, its Chats listed and its newest one open; `project:known` order unchanged.
//! - `a_chat_with_no_model_sends_on_the_recommended_one`: the provider's first recommended model from `agent:models`;
//!   a provider it lists none for, the maintained list's first model of it (as Electron's `resolveModel`).
//! - `details_pills_and_a_model_switch`: the Details tab and the pills from the state, `agent:ports` and
//!   `pull-requests:snapshot`; the chip's label from `agent:models`; a pick on an open Chat sent with its next
//!   message (another provider: the daemon switches it), kept for that Chat, with the picked effort; Settings with
//!   Appearance, the daemon's accounts read-only (`accounts:list`) and no other section listed; the PR
//!   pill's fix sent as `chat:send` with `prAction`.
//! - `appearance_preferences_round_trip`: the Preview's own `preferences.json` (Settings › Appearance).
//! - `a_read_only_window_writes_nothing`: the `--snapshot` mode: nothing but adoption, the snapshot and reads; an
//!   unloaded Project opened on purpose is refused.
//! - `the_window_waits_for_milagre_and_follows_a_restart`: "Open Milagre first", then the daemon starts, then it
//!   restarts in another process and the window syncs again on its own.

use std::path::{Path, PathBuf};
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
use crate::controller::{DaemonSession, LiveController, install_daemon_app};
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
    // A write connection loads its Project (project:read, never project:open); a read-only Daemon refuses first.
    let writer = block_on(daemon.writer(BETA)).expect("a write connection");
    drop(writer);
    let read_only = Daemon::new(Some(data.clone()), true);
    assert!(block_on(read_only.load(GAMMA)).is_err(), "no load in read-only mode");
    assert!(block_on(read_only.writer(BETA)).is_err());
    stop_process(second, &data);
    let _ = std::fs::remove_dir_all(&data);
}

fn mount_daemon(cx: &mut TestAppContext, session: DaemonSession) -> Mounted<'_> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    // A preferences file nobody wrote: the window starts on the defaults, as on a first launch.
    let prefs = std::env::temp_dir().join(format!("gpui-daemon-prefs-{}-{n}.json", std::process::id()));
    let mounted = mount_daemon_with_prefs(cx, session, prefs.clone());
    let _ = std::fs::remove_file(&prefs);
    mounted
}

/// Mounts the window through `main`'s own daemon-mode startup ([`install_daemon_app`]): no Settings store exists
/// before it, as in the app, where only the window's `Workspace` would install one.
fn mount_daemon_with_prefs(cx: &mut TestAppContext, session: DaemonSession, prefs: PathBuf) -> Mounted<'_> {
    let wiring = cx.update(|cx| {
        cx.set_global(milagre_gpui_spike::theme::Theme::dark());
        gpui_component::init(cx);
        milagre_gpui_spike::theme::component_bridge::init(cx);
        assert!(!cx.has_global::<milagre_gpui_spike::settings::SettingsStore>(), "main's startup has no Settings store yet");
        install_daemon_app(&session, prefs, cx)
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

    /// The sidebar's name-only Projects: name and whether it is loading.
    fn unloaded(&mut self) -> Vec<(String, bool)> {
        let sidebar = self.workspace.read_with(self.vcx, |w, _| w.sidebar.clone());
        sidebar.read_with(self.vcx, |s, _| s.unloaded_projects().iter().map(|p| (p.name.to_string(), p.loading)).collect())
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
    // As Electron's sidebar: an unloaded Project gets no row at all, and no status text sits under the rows.
    assert!(m.unloaded().is_empty(), "no name-only list");
    assert!(m.vcx.debug_bounds("sidebar-unloaded").is_none(), "no Not loaded section");
    assert!(m.vcx.debug_bounds("preview-note").is_none() && m.vcx.debug_bounds("sidebar-notice").is_none(), "no status text");
    assert!(m.vcx.debug_bounds("bar-routines").is_none(), "no Routines button");

    // 2. The newest Chat opens with its saved transcript, on its own provider and model (the picker open to change it).
    m.wait_for("the newest Chat's transcript", |m| m.items().len() == 2);
    let newest = m.open_key().expect("a Chat is open");
    assert_eq!(newest, format!("{ALPHA}#2"), "the newest activity across Projects");
    assert_eq!(m.items(), ["user: Second question", "reply: Second answer"]);
    assert_eq!(m.composer_model(), (Provider::Codex, "gpt-5.5".into(), false));

    // 3. Another Project's Chat: its transcript is read on that Project's own client; then back to alpha.
    m.open(&format!("{BETA}#1"));
    m.wait_for("beta's transcript", |m| m.items() == ["user: Beta question", "reply: Beta answer"]);
    assert!(fake.log().iter().any(|(m, a)| m == "chat:messages" && a[0] == BETA && a[1] == 1), "beta's messages were read");
    m.open(&format!("{ALPHA}#1"));
    m.wait_for("alpha's transcript", |m| m.items() == ["user: Alpha question", "reply: Alpha answer"]);

    // 4. Changes: the daemon's Git reads on a request-only connection that loads the Project first (load_view).
    let panel = m.workspace.read_with(m.vcx, |w, _| w.panel.clone());
    m.wait_for("the live Changes", |m| {
        panel.read_with(m.vcx, |p, _| {
            p.visible_tabs()
                == [milagre_gpui_spike::workspace::panel::PanelTab::Details, milagre_gpui_spike::workspace::panel::PanelTab::Changes]
        })
    });
    let git = fake.connections().into_iter().find(|(_, m)| m == "git:diff-files").expect("a Git read").0;
    let on_git: Vec<String> = fake.connections().into_iter().filter(|(c, _)| *c == git).map(|(_, m)| m).collect();
    // The client's two-step handshake (`daemon:status []`, then `[{commands: true}]`), then the load.
    assert_eq!(on_git[..2], ["daemon:status", "daemon:status"], "{on_git:?}");
    assert_eq!(on_git.get(2).map(String::as_str), Some("project:read"), "loaded before the read: {on_git:?}");
    assert!(!on_git.iter().any(|m| m == "daemon:snapshot"), "request-only: {on_git:?}");

    // 5. A send to an existing Chat: its own provider and model, its id, after project:open.
    m.type_and_send("hello daemon");
    m.wait_for("the saved reply", |m| {
        !m.running() && m.items().last().is_some_and(|i| i == "reply: codex gpt-5.5 replied to: hello daemon")
    });
    let send = sent(&fake).pop().unwrap();
    assert_eq!((send["provider"].as_str(), send["model"].as_str(), send["sessionId"].as_u64()), (Some("codex"), Some("gpt-5.5"), Some(1)));
    assert_eq!(send["permissionMode"], "auto", "the Chat's own permission mode");
    let loads =
        fake.log().iter().filter(|(m, a)| m == "project:read" && a[0] == ALPHA && a[1] == serde_json::json!({"state": false})).count();
    assert!(loads >= 1, "writes load the Project first (load_view)");
    assert!(!fake.methods().iter().any(|m| m == "project:open"), "never project:open");

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
    // One request-only connection for the Terminal: its open, input and reads; no snapshot was taken on it.
    let terminal: Vec<u64> = {
        let mut on: Vec<u64> = fake.connections().into_iter().filter(|(_, m)| m.starts_with("terminal:")).map(|(c, _)| c).collect();
        on.dedup();
        on
    };
    assert_eq!(terminal.len(), 1, "one Terminal connection: {terminal:?}");
    let on_terminal: Vec<String> = fake.connections().into_iter().filter(|(c, _)| *c == terminal[0]).map(|(_, m)| m).collect();
    assert!(on_terminal.iter().any(|m| m == "terminal:read") && on_terminal.iter().any(|m| m == "terminal:input"), "{on_terminal:?}");
    assert!(!on_terminal.iter().any(|m| m == "daemon:snapshot"), "no daemon:snapshot on the Terminal's connection: {on_terminal:?}");
    assert_eq!(
        on_terminal.get(2).map(String::as_str),
        Some("project:read"),
        "loaded with load_view after the two-step handshake: {on_terminal:?}"
    );
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

    assert!(!fake.methods().iter().any(|m| m == "project:open"), "never project:open in daemon mode");
    assert!(!fake.log().iter().any(|(m, a)| m == "project:read" && a[0] == GAMMA), "the unloaded Project was never opened");

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
    // An unloaded Project opened on purpose is refused here: no load in read-only mode.
    m.controller.update(m.vcx, |c, cx| c.load_project(GAMMA.to_owned(), cx));
    m.vcx.run_until_parked();
    assert!(!m.row_keys().iter().any(|k| k.starts_with(GAMMA)), "still not loaded");
    m.wait_for("the refusals", |m| m.controller.read_with(m.vcx, |c, _| c.refused().len()) >= 3);
    assert!(m.controller.read_with(m.vcx, |c, _| c.refused().iter().any(|r| r == &format!("load the Project {GAMMA}"))));
    std::thread::sleep(Duration::from_millis(200));
    m.vcx.run_until_parked();
    let methods = fake.methods();
    // Reads only: the transcript, and the model lists, ports and PR poll the picker, Details and pills show.
    let allowed = [
        "daemon:status",
        "project:known",
        "daemon:snapshot",
        "daemon:snapshot-page",
        "chat:messages",
        "agent:models",
        "agent:ports",
        "pull-requests:snapshot",
        "accounts:list",
        "usage:cached",
        "usage:accounts:cached",
    ];
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

#[gpui::test]
fn an_unloaded_project_loads_when_opened(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let data = data_folder("unloaded");
    let fake = FakeDaemon::start(&data, world());
    let session = DaemonSession::start(Daemon::new(Some(data.clone()), false));
    let mut m = mount_daemon(cx, session);
    m.wait_for("the loaded Projects' rows", |m| m.row_keys().len() == 3);
    let known_before = fake.world().known.clone();

    // No row, and nothing loads in the background: nothing about gamma was read.
    std::thread::sleep(Duration::from_millis(200));
    m.vcx.run_until_parked();
    assert!(m.unloaded().is_empty() && !m.row_keys().iter().any(|k| k.starts_with(GAMMA)));
    assert!(!fake.log().iter().any(|(_, a)| a[0] == GAMMA), "gamma untouched: {:?}", fake.methods());
    assert!(!fake.world().projects[GAMMA].loaded);
    let syncs = fake.methods().iter().filter(|m| *m == "daemon:snapshot").count();

    // Opened on purpose (the path a ⌘K search takes): loaded with load_view (never project:open), synced again, its
    // Chats listed, its newest open.
    m.controller.update(m.vcx, |c, cx| c.load_project(GAMMA.to_owned(), cx));
    m.vcx.run_until_parked();
    m.wait_for("gamma's Chats", |m| m.row_keys().contains(&format!("{GAMMA}#1")));
    m.wait_for("gamma's newest Chat open", |m| {
        m.open_key().as_deref() == Some(format!("{GAMMA}#1").as_str()) && m.items() == ["user: never read", "reply: never read"]
    });
    let loads: Vec<Value> = fake.log().into_iter().filter(|(m, a)| m == "project:read" && a[0] == GAMMA).map(|(_, a)| a).collect();
    // The load, then (gamma's Chat open) its Changes read's own load_view: every one `{state:false}`.
    assert!(!loads.is_empty() && loads.iter().all(|a| *a == serde_json::json!([GAMMA, {"state": false}])), "{loads:?}");
    let first = fake.log().into_iter().find(|(_, a)| a[0] == GAMMA).map(|(m, _)| m);
    assert_eq!(first.as_deref(), Some("project:read"), "gamma is loaded before anything else reads it");
    assert!(!fake.methods().iter().any(|m| m == "project:open"), "never project:open");
    assert!(fake.methods().iter().filter(|m| *m == "daemon:snapshot").count() > syncs, "synced again after the load");
    assert_eq!(fake.world().known, known_before, "project:known order unchanged");
    let errors = m.controller.read_with(m.vcx, |c, _| c.errors().to_vec());
    assert!(errors.is_empty(), "{errors:?}");
    println!("GPUI_DAEMON_LOAD_ON_OPEN loads={loads:?}");
    m.controller.update(m.vcx, |c, _| c.disconnect());
    drop(m);
    drop(fake);
    let _ = std::fs::remove_dir_all(&data);
}

#[gpui::test]
fn a_chat_with_no_model_sends_on_the_recommended_one(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let data = data_folder("models");
    let mut world = world();
    {
        let alpha = world.projects.get_mut(ALPHA).unwrap();
        // alpha#1: a Claude Chat with no recorded model; alpha#2 (the newest): a Kiro one, and Kiro has no catalog.
        for (id, provider) in [(1u64, "claude"), (2, "kiro")] {
            let chat = alpha.sessions.get_mut(&id).unwrap();
            chat["provider"] = serde_json::json!(provider);
            chat["summary"].as_object_mut().unwrap().remove("lastModel");
        }
    }
    let fake = FakeDaemon::start(&data, world);
    let session = DaemonSession::start(Daemon::new(Some(data.clone()), false));
    let mut m = mount_daemon(cx, session);
    m.wait_for("the newest Chat", |m| m.open_key().as_deref() == Some(format!("{ALPHA}#2").as_str()) && m.items().len() == 2);

    // Kiro: the daemon lists none, so the picker keeps the maintained list (`mergeModels`) and the Chat shows and
    // sends on its provider's first model there (`resolveModel`), as Electron does.
    m.wait_for("the Kiro chip", |m| m.composer_model().1 == "kiro:auto");
    m.type_and_send("on kiro's first model");
    m.wait_for("the Kiro reply", |m| !m.running() && m.items().last().is_some_and(|i| i.starts_with("reply: kiro kiro:auto replied")));
    let send = sent(&fake).pop().unwrap();
    assert_eq!((send["provider"].as_str(), send["model"].as_str()), (Some("kiro"), Some("kiro:auto")));
    assert!(fake.methods().iter().any(|m| m == "agent:models"));

    // A Claude Chat with no recorded model: Claude's first recommended model.
    m.open(&format!("{ALPHA}#1"));
    m.wait_for("alpha#1's transcript", |m| m.items() == ["user: Alpha question", "reply: Alpha answer"]);
    m.type_and_send("on the recommended model");
    m.wait_for("the reply", |m| !m.running() && m.items().last().is_some_and(|i| i.starts_with("reply: claude claude-opus-5-5 replied")));
    let send = sent(&fake).pop().unwrap();
    assert_eq!(
        (send["provider"].as_str(), send["model"].as_str(), send["sessionId"].as_u64()),
        (Some("claude"), Some("claude-opus-5-5"), Some(1))
    );
    let errors = m.controller.read_with(m.vcx, |c, _| c.errors().to_vec());
    assert!(errors.is_empty(), "{errors:?}");
    println!("GPUI_DAEMON_MODEL_FALLBACK send={send}");
    m.controller.update(m.vcx, |c, _| c.disconnect());
    drop(m);
    drop(fake);
    let _ = std::fs::remove_dir_all(&data);
}

#[gpui::test]
fn details_pills_and_a_model_switch(cx: &mut TestAppContext) {
    use milagre_gpui_spike::workspace::chat::composer::models;
    use milagre_gpui_spike::workspace::panel::PanelTab;
    cx.executor().allow_parking();
    let data = data_folder("details");
    let mut world = world();
    let key = format!("{ALPHA}#2");
    {
        let alpha = world.projects.get_mut(ALPHA).unwrap();
        let chat = alpha.sessions.get_mut(&2).unwrap();
        chat["provider"] = serde_json::json!("claude");
        chat["contextUsage"] = serde_json::json!({"used": 50_000, "size": 200_000});
        chat["backgroundTasks"] =
            serde_json::json!([{"id":"bg1","kind":"local_bash","title":"npm run dev","startedAt":1_700_000_000_000i64}]);
        chat["subagents"] = serde_json::json!([
            {"id":"a1","title":"Map the waits","status":"running","startedAt":1_700_000_000_000i64,"updatedAt":1_700_000_000_000i64,"latestActivity":"Reading","model":"claude-opus-5-5","provider":"claude"},
            {"id":"a2","title":"Run the check","status":"completed","startedAt":1_700_000_000_000i64,"updatedAt":1_700_000_000_000i64,"endedAt":1_700_000_060_000i64}
        ]);
        chat["plan"] = serde_json::json!({"source":"milagre","updatedAt":1,"tasks":[
            {"id":"1","title":"Reproduce","status":"completed"},
            {"id":"2","title":"Fix","status":"in_progress","activeForm":"Fixing","children":[{"id":"2.1","title":"Find it","status":"completed"}]}
        ],"phases":[{"phase":"start","at":1},{"phase":"build","at":2},{"phase":"warp","at":3}]});
        world.ports = serde_json::json!({ (key.clone()): [{"port":5173,"pid":4121,"command":"vite","address":"127.0.0.1"}] });
    }
    // The Chat names PR #12 (conflicts: the pill's fix); the Worktree's branch PR is the same one.
    let url = "https://github.com/o/alpha/pull/12";
    let pr = serde_json::json!({"number":12,"title":"Fix","url":url,"state":"OPEN","readyToMerge":false,"hasConflicts":true,"conflictStatusKnown":true});
    world.prs.insert(ALPHA.into(), serde_json::json!({"worktrees":{(ALPHA):pr},"chats":{(ALPHA):{(url):pr}},"pending":false}));
    world.projects.get_mut(ALPHA).unwrap().sessions.get_mut(&2).unwrap()["summary"]["pullRequests"] = serde_json::json!([url]);
    let fake = FakeDaemon::start(&data, world);
    {
        // The summary is rebuilt from the messages on every change; keep its PR ref.
        let mut w = fake.world();
        w.projects.get_mut(ALPHA).unwrap().sessions.get_mut(&2).unwrap()["summary"]["pullRequests"] = serde_json::json!([url]);
    }
    let session = DaemonSession::start(Daemon::new(Some(data.clone()), false));
    let mut m = mount_daemon(cx, session);
    m.wait_for("the newest Chat", |m| m.open_key().as_deref() == Some(key.as_str()) && m.items().len() == 2);

    // Details: the panel's Details tab, from the state and the two reads.
    let panel = m.workspace.read_with(m.vcx, |w, _| w.panel.clone());
    m.wait_for("live Details with the reads", |m| {
        panel.read_with(m.vcx, |p, cx| p.visible_tabs().contains(&PanelTab::Details) && !p.details().read(cx).data().ports.is_empty())
    });
    let details = panel.read_with(m.vcx, |p, cx| p.details().read(cx).data().clone());
    assert_eq!(details.branch.as_deref(), Some("alpha"));
    assert_eq!(details.path.as_deref(), Some(ALPHA));
    assert_eq!(details.context.as_ref().map(|c| c.percent), Some(25));
    assert_eq!(details.commands.iter().map(|c| c.title.as_str()).collect::<Vec<_>>(), ["npm run dev"]);
    assert_eq!(details.ports.iter().map(|p| (p.port, p.command.as_str())).collect::<Vec<_>>(), [(5173, "vite")]);
    assert_eq!((details.running_agents().count(), details.finished_count()), (1, 1));
    assert_eq!(details.pr.map(|pr| (pr.number, pr.state)), Some((12, "Open")));
    assert!(details.links.is_empty() && details.linear.is_none(), "nothing the state does not hold");
    assert_eq!(panel.read_with(m.vcx, |p, _| p.active()), PanelTab::Details);
    m.vcx.run_until_parked();
    assert!(m.vcx.debug_bounds("details-port-4121").is_some(), "the port row is drawn");
    assert!(m.vcx.debug_bounds("details-stop-port-4121").is_none(), "no stop the window cannot send");

    // Pills: the PR blocker's fix, the plan (an unknown phase left out) and the subagents.
    let pills = m.workspace.read_with(m.vcx, |w, cx| w.chat.read(cx).pills.clone());
    let data_now = pills.read_with(m.vcx, |p, _| p.data().clone());
    assert!(pills.read_with(m.vcx, |p, _| p.is_live()));
    assert_eq!(data_now.pr_action.as_ref().map(|a| a.label.as_str()), Some("Resolve conflicts"));
    let plan = data_now.plan.expect("the plan");
    assert_eq!((plan.tasks.len(), plan.tasks[1].children.len(), plan.phases.len()), (2, 1, 2));
    assert_eq!(data_now.subagents.iter().map(|a| a.title.as_str()).collect::<Vec<_>>(), ["Map the waits", "Run the check"]);
    assert!(m.vcx.debug_bounds("slot-pill-subagents").is_some() && m.vcx.debug_bounds("slot-pill-tasks").is_some(), "drawn");

    // The chip: no recorded model, so Claude's recommended one from `agent:models`, by its name; the picker open.
    m.wait_for("the reported catalog", |m| m.composer_model().1 == "claude-opus-5-5");
    let composer = m.workspace.read_with(m.vcx, |w, cx| w.chat.read(cx).composer.clone());
    assert_eq!(composer.read_with(m.vcx, |c, _| c.model_label().to_string()), "Opus 5.5");
    assert!(!m.composer_model().2, "the picker is open on an existing Chat");

    // A pick on the open Chat: Codex's GPT-6.1-Sol (its reported efforts), sent with the next message.
    let sol = models::find(Provider::Codex, "gpt-6.1-sol").expect("reported");
    assert_eq!(sol.efforts, ["low", "medium", "high"], "the daemon's efforts, not the maintained list's");
    composer.update(m.vcx, |c, cx| c.pick_model(&sol, cx));
    m.vcx.run_until_parked();
    m.type_and_send("switch to sol");
    m.wait_for("the reply on sol", |m| !m.running() && m.items().last().is_some_and(|i| i.starts_with("reply: codex gpt-6.1-sol replied")));
    let send = sent(&fake).pop().unwrap();
    assert_eq!(
        (send["provider"].as_str(), send["model"].as_str(), send["sessionId"].as_u64(), send["effort"].as_str()),
        (Some("codex"), Some("gpt-6.1-sol"), Some(2), Some("high"))
    );
    assert_eq!(fake.world().projects[ALPHA].sessions[&2]["provider"], "codex", "the daemon switched the Chat");

    // The PR pill: Resolve conflicts, sent as Electron's pill sends it (`chat:send` with `prAction`), on the pick.
    let at = m.vcx.debug_bounds("pill-pr-action").expect("the PR pill").center();
    m.vcx.simulate_click(at, Modifiers::none());
    m.wait_for("the PR action's reply", |m| !m.running() && sent(&fake).iter().any(|s| s.get("prAction").is_some()));
    let action = sent(&fake).into_iter().find(|s| s.get("prAction").is_some()).unwrap();
    assert_eq!(action["prAction"], serde_json::json!({"action":"conflicts","pr":12,"url":url}));
    assert_eq!((action["sessionId"].as_u64(), action["model"].as_str()), (Some(2), Some("gpt-6.1-sol")));
    assert_eq!(action["body"], "Resolve the conflicts on pull request #12");

    // The pick stays with that Chat: away and back, the chip still names it.
    m.open(&format!("{BETA}#1"));
    m.wait_for("beta's own model", |m| m.composer_model().1 == "gpt-5.5");
    m.open(&key);
    m.wait_for("the picked model again", |m| m.composer_model() == (Provider::Codex, "gpt-6.1-sol".into(), false));
    assert_eq!(composer.read_with(m.vcx, |c, _| c.model_label().to_string()), "GPT-6.1-Sol");

    // Settings: Appearance (this window's), the accounts read from the daemon (read-only); no other section listed.
    use milagre_gpui_spike::settings::SettingsSectionId;
    let settings = m.workspace.read_with(m.vcx, |w, _| w.settings.clone());
    m.wait_for("the accounts", |m| m.vcx.update(|_, cx| cx.has_global::<milagre_gpui_spike::workspace::preview::PreviewAccounts>()));
    let accounts = m.vcx.update(|_, cx| cx.global::<milagre_gpui_spike::workspace::preview::PreviewAccounts>().0.clone());
    assert_eq!(
        accounts.iter().map(|a| (a.provider.as_ref(), a.label.as_ref(), a.selected)).collect::<Vec<_>>(),
        [("claude", "Connected CLI account", true), ("claude", "Work", false)],
        "kiro is not installed"
    );
    m.vcx.update(|window, cx| settings.update(cx, |s, cx| s.open_section(SettingsSectionId::Accounts, window, cx)));
    m.vcx.run_until_parked();
    assert!(m.vcx.debug_bounds("preview-account-claude-1").is_some(), "the accounts are drawn");
    m.vcx.update(|_, cx| {
        settings.update(cx, |s, cx| s.select_section(milagre_gpui_spike::settings::SelectedSection::Section(SettingsSectionId::Mcp), cx))
    });
    m.vcx.run_until_parked();
    // Only the backed sections are listed: MCP is not, and asking for it shows Appearance.
    assert!(m.vcx.debug_bounds("settings-nav-mcp").is_none() && m.vcx.debug_bounds("settings-nav-accounts").is_some());
    assert_eq!(settings.read_with(m.vcx, |s, _| s.selected_section_id()), SettingsSectionId::Appearance);
    m.vcx.update(|_, cx| {
        settings
            .update(cx, |s, cx| s.select_section(milagre_gpui_spike::settings::SelectedSection::Section(SettingsSectionId::Appearance), cx))
    });
    m.vcx.run_until_parked();
    assert!(m.vcx.debug_bounds("settings-unavailable").is_none(), "Appearance is this window's own");
    m.vcx.update(|window, cx| settings.update(cx, |s, cx| s.close(window, cx)));
    assert!(!fake.methods().iter().any(|m| m.starts_with("accounts:") && m != "accounts:list"), "Accounts only read");

    let errors = m.controller.read_with(m.vcx, |c, _| c.errors().to_vec());
    assert!(errors.is_empty(), "{errors:?}");
    println!("GPUI_DAEMON_DETAILS details={details:?} send={send}");
    m.controller.update(m.vcx, |c, _| c.disconnect());
    models::set_reported(None);
    drop(m);
    drop(fake);
    let _ = std::fs::remove_dir_all(&data);
}

#[gpui::test]
fn appearance_preferences_round_trip(cx: &mut TestAppContext) {
    use gpui::BorrowAppContext as _;
    use milagre_gpui_spike::settings::SettingsStore;
    use milagre_gpui_spike::settings::appearance::ThemePreference;
    let folder = data_folder("prefs");
    let path = folder.join(crate::prefs::FILE);
    cx.update(|cx| {
        cx.set_global(SettingsStore::default());
        crate::prefs::install(path.clone(), false, cx);
    });
    // A new observer is active from the next update on.
    cx.update(|cx| {
        cx.update_global::<SettingsStore, _>(|store, _| {
            store.appearance.theme = ThemePreference::Dark;
            store.appearance.options.chat_size = "larger".into();
            store.appearance.options.chat_width_px = 5000;
        });
    });
    cx.run_until_parked();
    let saved: Value = serde_json::from_slice(&std::fs::read(&path).expect("saved")).unwrap();
    assert_eq!((saved["appearance"]["theme"].as_str(), saved["appearance"]["chatSize"].as_str()), (Some("dark"), Some("larger")));
    // Read back into a fresh store; a read-only window never writes.
    let mut state = milagre_gpui_spike::settings::appearance::AppearanceState::default();
    crate::prefs::apply_json(&mut state, &saved);
    assert_eq!((state.theme, state.options.chat_size.as_str()), (ThemePreference::Dark, "larger"));
    // A read-only window reads its file and never writes one.
    let other = folder.join("read-only.json");
    cx.update(|cx| {
        crate::prefs::install(other.clone(), true, cx);
    });
    cx.update(|cx| {
        cx.update_global::<SettingsStore, _>(|store, _| store.appearance.theme = ThemePreference::Light);
    });
    cx.run_until_parked();
    assert!(!other.exists(), "nothing written in read-only mode");
    let _ = std::fs::remove_dir_all(&folder);
}

/// The daemon-mode startup `main` runs (regression: the installed Preview panicked on launch with "no state of type
/// SettingsStore" because the saved Appearance was read before the window installed Settings' store). A saved
/// preferences file is read into the store before the window opens, the window opens and syncs, and a change is saved.
#[gpui::test]
fn the_daemon_startup_reads_preferences_before_the_window_opens(cx: &mut TestAppContext) {
    use milagre_gpui_spike::settings::SettingsStore;
    use milagre_gpui_spike::settings::appearance::ThemePreference;
    cx.executor().allow_parking();
    let data = data_folder("startup");
    let prefs = data.join(crate::prefs::FILE);
    std::fs::write(&prefs, r#"{"appearance":{"theme":"light","chatSize":"larger"}}"#).unwrap();
    let fake = FakeDaemon::start(&data, world());
    let session = DaemonSession::start(Daemon::new(Some(data.clone()), false));
    let mut m = mount_daemon_with_prefs(cx, session, prefs.clone());
    let theme = m
        .vcx
        .update(|_, cx| (cx.global::<SettingsStore>().appearance.theme, cx.global::<SettingsStore>().appearance.options.chat_size.clone()));
    assert_eq!(theme, (ThemePreference::Light, "larger".to_owned()), "read before the window opened");
    m.wait_for("the transcript", |m| m.items().len() == 2);
    m.vcx.update(|_, cx| {
        use gpui::BorrowAppContext as _;
        cx.update_global::<SettingsStore, _>(|store, _| store.appearance.theme = ThemePreference::Dark);
    });
    m.vcx.run_until_parked();
    let saved: Value = serde_json::from_slice(&std::fs::read(&prefs).unwrap()).unwrap();
    assert_eq!(saved["appearance"]["theme"], "dark");
    drop(m);
    drop(fake);
    let _ = std::fs::remove_dir_all(&data);
}

/// The start path (`InstalledOwner::adopt_or_start` through the client's real launcher) on a throwaway data folder:
/// with no daemon running, a writable window starts one (here a launch of this test binary serving the fake daemon,
/// standing in for Milagre.app in Node mode) with `serve --data-dir D --app-version V --cwd /`, adopts it and syncs;
/// a second window adopts the running one instead of starting another; a read-only window never starts one; without
/// Milagre.app the window says to install it. The started fake is stopped by its exact PID at the end.
#[test]
fn a_window_starts_the_daemon_when_none_runs() {
    use crate::daemon::{INSTALL_MILAGRE, Start};
    let data = data_folder("start");
    let script = data.with_extension("launch.sh");
    let argv = data.with_extension("argv");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\nGPUI_FAKE_DAEMON_DATA=\"$3\" exec '{}' --ignored --exact tests::daemon::fake_daemon_process --nocapture --test-threads=1 >/dev/null\n",
            argv.display(),
            std::env::current_exe().unwrap().display()
        ),
    )
    .unwrap();
    let launch = milagre_daemon_client::DaemonLaunch::node(Path::new("/bin/sh"), &script, "9.9.9-test", None)
        .unwrap()
        .with_startup_timeout(Duration::from_secs(20));

    // Read-only: never started, so there is still no daemon.
    let read_only = Daemon::starting(Some(data.clone()), true, Start::Installed(launch.clone()));
    assert!(!read_only.starts());
    let error = block_on(read_only.sync()).err().expect("no daemon");
    assert!(daemon::unavailable(&error), "{error:#}");
    assert!(!argv.exists(), "a read-only window started nothing");

    // Writable: started once, adopted, synced.
    let daemon = Daemon::starting(Some(data.clone()), false, Start::Installed(launch.clone()));
    assert!(daemon.starts());
    let synced = block_on(daemon.sync()).expect("started and synced");
    let pid = synced.pid;
    assert_ne!(pid, std::process::id(), "another process: the started daemon");
    assert_eq!(synced.version, "fake-node");
    assert_eq!(daemon.known().iter().map(|k| k.path.as_str()).collect::<Vec<_>>(), [ALPHA, BETA, GAMMA]);
    let started = std::fs::read_to_string(&argv).unwrap();
    assert_eq!(started.lines().collect::<Vec<_>>(), [format!("serve --data-dir {} --app-version 9.9.9-test --cwd /", data.display())]);
    drop(synced);

    // Another window adopts the running daemon: nothing more is started.
    let other = Daemon::starting(Some(data.clone()), false, Start::Installed(launch));
    let again = block_on(other.sync()).expect("adopted");
    assert_eq!(again.pid, pid);
    assert_eq!(std::fs::read_to_string(&argv).unwrap().lines().count(), 1, "started once");
    drop(again);
    other.disconnect();
    daemon.disconnect();

    // Without Milagre.app: adopt only, and the window says to install it.
    let empty = data_folder("start-missing");
    let missing = Daemon::starting(Some(empty.clone()), false, Start::Missing("Milagre.app is not installed".into()));
    assert!(missing.app_missing() && !missing.starts());
    let session = DaemonSession::start(missing);
    assert_eq!(session.error.as_deref(), Some(INSTALL_MILAGRE));

    // Only the process this test started, by its exact PID.
    unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
    let until = Instant::now() + Duration::from_secs(10);
    while unsafe { libc::kill(pid as libc::pid_t, 0) } == 0 && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = std::fs::remove_file(socket_for(&data));
    for path in [&script, &argv] {
        let _ = std::fs::remove_file(path);
    }
    let _ = std::fs::remove_dir_all(&data);
    let _ = std::fs::remove_dir_all(&empty);
}

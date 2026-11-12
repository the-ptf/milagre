//! The live GPUI app ("Milagre GPUI Preview"): the base crate's window on the installed Milagre's running Node daemon
//! (the default), or on the owned dedicated Chat runtime.
//!
//! ```text
//! milagre-gpui-live                                   # the Preview on Milagre's running daemon (its Projects and Chats)
//!     [--snapshot PNG]                                # read-only: open, draw, save the window, quit (writes nothing)
//!     [--read-only] [--profile DIR]                   # refuse every write; another Milagre data folder (tests)
//! milagre-gpui-live --owned                           # the owned runtime: its base folder, set up on first launch
//! milagre-gpui-live --owned --base DIR                # the same with another base folder
//! milagre-gpui-live --root ROOT [--create LAUNCH.json] # an explicit dedicated root (create it from a manifest)
//!     [--smoke PROMPT]... [--approve] --smoke-report NEW.json   # drive a few turns, write a report, quit
//! milagre-gpui-live setup --base DIR --claude PATH --config-dir DIR --account-id ID [--account-label L]
//!                         [--model sonnet] [--skills DIR] [--user NAME] [--path PATH]
//! ```
//!
//! Daemon mode adopts Milagre's running daemon, or starts the installed Milagre.app's own daemon in Node mode when none
//! runs (no Electron window; never in read-only mode), and never stops, replaces or signals it: quitting closes only this
//! window's connections and leaves the daemon running. Without Milagre.app the window says "Install Milagre to use
//! this preview". No setup window: the daemon owns the accounts.
//!
//! Owned mode: the base folder (default `~/Library/Application Support/Milagre GPUI Preview`) holds `launch.json` (the private
//! manifest: which Claude, which signed-in account folder, which model) and `root/` (the dedicated data root the
//! runtime creates from it on first launch and opens afterwards). The runtime is the fixed sibling `chat-runtime` of
//! this executable (in the bundle: `Contents/MacOS/chat-runtime`). No production profile, socket or account is ever
//! discovered by the runtime; the first-run setup only proposes values, which the user confirms.

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use gpui::App;
use milagre_gpui_live::controller::{DaemonSession, LiveController, install_daemon_app, install_globals};
use milagre_gpui_live::daemon::{Daemon, Start};
use milagre_gpui_live::session::{self, Root, Session};
use milagre_gpui_live::setup::{self, Detected};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("milagre-gpui-live: {error:#}");
            ExitCode::FAILURE
        }
    }
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|ix| args.get(ix + 1)).cloned()
}

fn run(args: &[String]) -> anyhow::Result<()> {
    if args.first().map(String::as_str) == Some("setup") {
        let base = PathBuf::from(flag(args, "--base").ok_or_else(|| anyhow::anyhow!("--base is required"))?);
        let detected = Detected {
            claude: flag(args, "--claude").map(PathBuf::from).ok_or_else(|| anyhow::anyhow!("--claude is required"))?,
            config_directory: flag(args, "--config-dir").map(PathBuf::from).ok_or_else(|| anyhow::anyhow!("--config-dir is required"))?,
            account_id: flag(args, "--account-id").ok_or_else(|| anyhow::anyhow!("--account-id is required"))?,
            account_label: flag(args, "--account-label").unwrap_or_else(|| "Selected Claude account".into()),
            model: flag(args, "--model").unwrap_or_else(|| "sonnet".into()),
            skills: flag(args, "--skills").map(PathBuf::from).unwrap_or_else(setup::skills_directory),
            user: flag(args, "--user").unwrap_or_else(setup::user_name),
            path: flag(args, "--path").unwrap_or_else(setup::default_path),
            home: setup::home(),
        };
        let manifest = setup::write_manifest(&base, &detected)?;
        println!("{}", manifest.display());
        return Ok(());
    }
    let owned = ["--owned", "--root", "--base", "--create"].iter().any(|name| args.iter().any(|a| a == name));
    if !owned {
        let snapshot = flag(args, "--snapshot").map(PathBuf::from);
        let read_only = snapshot.is_some() || args.iter().any(|a| a == "--read-only");
        // With Milagre.app closed, its daemon is started in Node mode (never in read-only mode); one running is adopted.
        let start = if read_only { Start::Never } else { Start::installed_app() };
        if let Start::Missing(why) = &start {
            eprintln!("live: {why}: {}", milagre_gpui_live::daemon::INSTALL_MILAGRE);
        }
        let daemon = Daemon::starting(flag(args, "--profile").map(PathBuf::from), read_only, start);
        let session = DaemonSession::start(daemon);
        run_daemon_app(session, snapshot);
        return Ok(());
    }
    let (root, manifest) = match flag(args, "--root") {
        Some(root) => (PathBuf::from(root), flag(args, "--create").map(PathBuf::from)),
        None => {
            let base = flag(args, "--base").map(PathBuf::from).unwrap_or_else(setup::preview_base);
            let root = base.join("root");
            let manifest = base.join(setup::MANIFEST);
            if root.exists() {
                (root, None)
            } else if manifest.exists() {
                (root, Some(manifest))
            } else {
                // First launch: propose this Mac's values; the setup window writes the manifest on Continue.
                return run_setup_window(base, flag(args, "--snapshot").map(PathBuf::from));
            }
        }
    };
    let create = manifest.is_some();
    let guard = futures::executor::block_on(session::launch(match &manifest {
        Some(manifest) => Root::Create { root: &root, manifest },
        None => Root::Open { root: &root },
    }))
    .map_err(|error| {
        // The runtime refuses a root another owner holds (`CHAT_ROOT_BUSY`).
        let busy = error.chain().any(|cause| {
            matches!(cause.downcast_ref::<milagre_daemon_client::Error>(), Some(milagre_daemon_client::Error::Remote { code, .. }) if code == "CHAT_ROOT_BUSY")
        });
        if busy {
            anyhow::anyhow!(
                "This root is already open: {} is in use by another Milagre GPUI Preview (or its runtime is still stopping). Quit that one, then open again.",
                root.display()
            )
        } else {
            error
        }
    })?;
    let guard = Arc::new(guard);
    eprintln!(
        "live: {} {} (pid {}, profile {}, socket {}, launch {}, model {}, account {})",
        if create { "created" } else { "opened" },
        root.display(),
        guard.info().pid,
        guard.info().profile.display(),
        guard.info().socket.display(),
        guard.info().launch_root.display(),
        guard.info().model,
        guard.info().account_id
    );
    let session = match futures::executor::block_on(Session::connect(guard.clone())) {
        Ok(session) => session,
        Err(error) => {
            let report = session::shutdown_blocking(&guard, Duration::from_secs(20));
            eprintln!("live: shutdown {report:?}");
            return Err(error);
        }
    };
    let smoke = flag(args, "--smoke-report").map(|report| milagre_gpui_live::smoke::Smoke {
        prompts: args.iter().enumerate().filter(|(ix, _)| *ix > 0 && args[ix - 1] == "--smoke").map(|(_, p)| p.clone()).collect(),
        approve: args.iter().any(|a| a == "--approve"),
        report: PathBuf::from(report),
    });
    let snapshot = flag(args, "--snapshot").map(PathBuf::from);
    run_app(session, guard, smoke, snapshot);
    Ok(())
}

fn run_app(
    session: Session,
    guard: Arc<milagre_daemon_client::OwnedChatGuard>,
    smoke: Option<milagre_gpui_live::smoke::Smoke>,
    snapshot: Option<PathBuf>,
) {
    let client = session.client.clone();
    let reader = session.reader.clone();
    // Snapshot: the open Chat's first page is read before the window opens, so its first frames show it.
    let preloaded = snapshot.as_ref().and_then(|_| {
        let key = milagre_gpui_live::controller::newest_chat(&session.store, Some(&session.project))?;
        let id = milagre_gpui_live::sinks::chat_id(&session.project, &key)?;
        let adapter = milagre_gpui_live::DaemonAdapter::new(session.client.clone());
        let scope = milagre_gpui_spike::data::ScopeKey::project(milagre_gpui_spike::data::LOCAL, &session.project);
        use milagre_gpui_spike::data::DataSource as _;
        let page = futures::executor::block_on(adapter.chat_messages(scope, id, milagre_gpui_spike::data::PageRequest::OPEN)).ok()?;
        Some((key, page))
    });
    gpui_platform::application().with_assets(milagre_gpui_spike::assets::Assets).run(move |cx: &mut App| {
        milagre_gpui_spike::app::init(cx);
        let mut wiring = install_globals(&session, cx);
        wiring.preloaded = preloaded;
        if snapshot.is_some() {
            // As the base app's snapshot does: images decoded before the window, which may draw only its first frames.
            for _ in 0..200 {
                if milagre_gpui_spike::ui::preload_logos(cx) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        let window = milagre_gpui_spike::app::open_main_window(cx);
        let workspace = window.read_with(cx, |root, _| milagre_gpui_spike::app::workspace_of(root)).ok().flatten().expect("the workspace");
        let controller = window
            .update(cx, |_, window, cx| LiveController::attach(&workspace, session, wiring, window, cx))
            .expect("attach the live controller");
        if let Some(path) = snapshot.clone() {
            snapshot_then_quit(window.into(), path, cx);
        } else if let Some(smoke) = smoke {
            milagre_gpui_live::smoke::start(smoke, window, workspace.clone(), controller.clone(), cx);
        }
        // Kept for the app's lifetime.
        std::mem::forget(controller);
        cx.on_app_quit(move |_| {
            client.disconnect();
            reader.disconnect();
            let report = session::shutdown_blocking(&guard, Duration::from_secs(20));
            eprintln!("live: shutdown {report:?}");
            async {}
        })
        .detach();
        quit_on_signals(cx);
        // `MILAGRE_GPUI_NO_ACTIVATE=1` (checks on a Mac someone is using) and snapshots: the window opens behind.
        if std::env::var_os("MILAGRE_GPUI_NO_ACTIVATE").is_none() && snapshot.is_none() {
            cx.activate(true);
        }
    });
}

fn run_daemon_app(session: DaemonSession, snapshot: Option<PathBuf>) {
    let daemon = session.daemon.clone();
    // Snapshot: the newest Chat's first page is read before the window opens (a read on its Project's client).
    let preloaded = snapshot.as_ref().and_then(|_| {
        let key = milagre_gpui_live::controller::newest_chat(&session.store, None)?;
        let (project, id) = milagre_gpui_live::sinks::split_key(&key)?;
        let source = milagre_gpui_live::source::LiveSource::daemon(session.store.clone(), daemon.clone());
        let scope = milagre_gpui_spike::data::ScopeKey::project(milagre_gpui_spike::data::LOCAL, &project);
        use milagre_gpui_spike::data::DataSource as _;
        match futures::executor::block_on(source.chat_messages(scope, id, milagre_gpui_spike::data::PageRequest::OPEN)) {
            Ok(page) => Some((key, page)),
            Err(error) => {
                eprintln!("live: couldn't read {key}: {error:#}");
                None
            }
        }
    });
    let application = gpui_platform::application().with_assets(milagre_gpui_spike::assets::Assets);
    // `milagre://` links (the bundle registers the scheme): kept until the window takes them.
    application.on_open_urls(milagre_gpui_live::deeplinks::push);
    application.run(move |cx: &mut App| {
        milagre_gpui_spike::app::init(cx);
        // Settings › Appearance is this window's own: read back, and saved unless read-only.
        let mut wiring =
            install_daemon_app(&session, milagre_gpui_live::prefs::default_path(), &milagre_gpui_live::notify::electron_preferences(), cx);
        // The window's frame and the sidebar's collapse, restored and kept in the Preview's own folder (not in
        // snapshots, which always open at the default size and save nothing).
        if snapshot.is_none() {
            cx.set_global(milagre_gpui_spike::workspace::shell::window_state::StateFile(
                milagre_gpui_live::setup::preview_base().join("window-state.json"),
            ));
        }
        wiring.preloaded = preloaded;
        if snapshot.is_some() {
            for _ in 0..200 {
                if milagre_gpui_spike::ui::preload_logos(cx) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        let window = milagre_gpui_spike::app::open_main_window(cx);
        let workspace = window.read_with(cx, |root, _| milagre_gpui_spike::app::workspace_of(root)).ok().flatten().expect("the workspace");
        let controller = window
            .update(cx, |_, window, cx| LiveController::attach_daemon(&workspace, session, wiring, window, cx))
            .expect("attach the live controller");
        if let Some(path) = snapshot.clone() {
            let refused = controller.clone();
            cx.on_app_quit(move |cx| {
                let refused = refused.read(cx).refused().to_vec();
                eprintln!("live: read-only check: {} write(s) refused before reaching the daemon: {refused:?}", refused.len());
                async {}
            })
            .detach();
            snapshot_then_quit(window.into(), path, cx);
        }
        std::mem::forget(controller);
        cx.on_app_quit(move |_| {
            // Only this window's connections close: Milagre's daemon keeps running.
            daemon.disconnect();
            eprintln!("live: disconnected from Milagre's daemon (left running)");
            async {}
        })
        .detach();
        quit_on_signals(cx);
        if std::env::var_os("MILAGRE_GPUI_NO_ACTIVATE").is_none() && snapshot.is_none() {
            cx.activate(true);
        }
    });
}

fn run_setup_window(base: PathBuf, snapshot: Option<PathBuf>) -> anyhow::Result<()> {
    let detected = setup::detect();
    gpui_platform::application().with_assets(milagre_gpui_spike::assets::Assets).run(move |cx: &mut App| {
        milagre_gpui_spike::app::init(cx);
        let window = setup::open_window(base, detected, cx);
        match snapshot {
            Some(path) => snapshot_then_quit(window, path, cx),
            None => cx.activate(true),
        }
    });
    Ok(())
}

/// `--snapshot PNG`: waits for the first frames, saves the window (never activated) and quits through the normal path.
fn snapshot_then_quit(window: gpui::AnyWindowHandle, path: PathBuf, cx: &mut App) {
    cx.spawn(async move |cx| {
        cx.background_executor().timer(Duration::from_millis(2000)).await;
        let saved = window.update(cx, |_, window, _| milagre_gpui_spike::snapshot::save_window_png(window, &path));
        match saved {
            Ok(Ok((w, h))) => eprintln!("live: snapshot {} ({w}x{h} px)", path.display()),
            Ok(Err(error)) => eprintln!("live: snapshot failed: {error}"),
            Err(error) => eprintln!("live: snapshot failed: window gone: {error}"),
        }
        cx.update(|cx| cx.quit());
    })
    .detach();
}

static SIGNALLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

extern "C" fn on_signal(_: libc::c_int) {
    SIGNALLED.store(true, std::sync::atomic::Ordering::SeqCst);
}

/// SIGTERM, SIGINT and SIGHUP quit through the app's normal path, so the runtime is stopped and its temporary storage
/// removed (`on_app_quit`). SIGKILL cannot be caught: the runtime still stops on its closed stdin and removes its
/// profile and socket; only the client's empty launch folder under /tmp stays.
fn quit_on_signals(cx: &mut App) {
    for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
        // SAFETY: the handler only stores to an atomic.
        unsafe { libc::signal(signal, on_signal as *const () as libc::sighandler_t) };
    }
    cx.spawn(async move |cx| {
        loop {
            cx.background_executor().timer(Duration::from_millis(100)).await;
            if SIGNALLED.load(std::sync::atomic::Ordering::SeqCst) {
                eprintln!("live: quitting on a signal");
                cx.update(|cx| cx.quit());
                break;
            }
        }
    })
    .detach();
}

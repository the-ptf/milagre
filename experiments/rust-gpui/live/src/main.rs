//! The live GPUI app ("Milagre GPUI Preview"): the base crate's window on the owned dedicated Chat runtime.
//!
//! ```text
//! milagre-gpui-live                                   # the Preview: its base folder, set up on first launch
//! milagre-gpui-live --base DIR                        # the same with another base folder
//! milagre-gpui-live --root ROOT [--create LAUNCH.json] # an explicit dedicated root (create it from a manifest)
//! milagre-gpui-live setup --base DIR --claude PATH --config-dir DIR --account-id ID [--account-label L]
//!                         [--model sonnet] [--skills DIR] [--user NAME] [--path PATH]
//! ```
//!
//! The base folder (default `~/Library/Application Support/Milagre GPUI Preview`) holds `launch.json` (the private
//! manifest: which Claude, which signed-in account folder, which model) and `root/` (the dedicated data root the
//! runtime creates from it on first launch and opens afterwards). The runtime is the fixed sibling `chat-runtime` of
//! this executable (in the bundle: `Contents/MacOS/chat-runtime`). No production profile, socket or account is ever
//! discovered by the runtime; the first-run setup only proposes values, which the user confirms.

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use gpui::App;
use milagre_gpui_live::controller::{LiveController, install_globals};
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
                return run_setup_window(base);
            }
        }
    };
    let create = manifest.is_some();
    let guard = futures::executor::block_on(session::launch(match &manifest {
        Some(manifest) => Root::Create { root: &root, manifest },
        None => Root::Open { root: &root },
    }))?;
    let guard = Arc::new(guard);
    eprintln!(
        "live: {} {} (pid {}, model {}, account {})",
        if create { "created" } else { "opened" },
        root.display(),
        guard.info().pid,
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
    run_app(session, guard);
    Ok(())
}

fn run_app(session: Session, guard: Arc<milagre_daemon_client::OwnedChatGuard>) {
    let client = session.client.clone();
    gpui_platform::application().with_assets(milagre_gpui_spike::assets::Assets).run(move |cx: &mut App| {
        milagre_gpui_spike::app::init(cx);
        let wiring = install_globals(&session, cx);
        let window = milagre_gpui_spike::app::open_main_window(cx);
        let workspace = window.read_with(cx, |root, _| milagre_gpui_spike::app::workspace_of(root)).ok().flatten().expect("the workspace");
        let controller = window
            .update(cx, |_, window, cx| LiveController::attach(&workspace, session, wiring, window, cx))
            .expect("attach the live controller");
        // Kept for the app's lifetime.
        std::mem::forget(controller);
        cx.on_app_quit(move |_| {
            client.disconnect();
            let report = session::shutdown_blocking(&guard, Duration::from_secs(20));
            eprintln!("live: shutdown {report:?}");
            async {}
        })
        .detach();
        cx.activate(true);
    });
}

fn run_setup_window(base: PathBuf) -> anyhow::Result<()> {
    let detected = setup::detect();
    gpui_platform::application().with_assets(milagre_gpui_spike::assets::Assets).run(move |cx: &mut App| {
        milagre_gpui_spike::app::init(cx);
        setup::open_window(base, detected, cx);
        cx.activate(true);
    });
    Ok(())
}

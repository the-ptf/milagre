//! The Preview's own bundled daemon (`Contents/Resources/milagre-daemon`), live and by hand only: never on a real
//! profile. A check script starts the built app with a throwaway HOME, `--profile` and `--no-installed-app`, so the app
//! starts the bundled daemon; this test then adopts that daemon (it starts nothing: the bundle it is given is used only if
//! none runs, and the caller checks one does), opens a Terminal in the Project's first Chat through the window's own
//! [`LiveTerminals`] path (a request-only writer connection, `terminal:open`, `terminal:read` polling) and waits for a
//! shell command's output, proving node-pty works under the bundled Node.
//!
//! ```text
//! GPUI_BUNDLE_DIR=<app>/Contents/Resources/milagre-daemon GPUI_BUNDLE_PROFILE=<throwaway data dir> \
//! GPUI_BUNDLE_PROJECT=<throwaway git repo the daemon has opened> \
//!   cargo test --lib tests::bundled -- --ignored --nocapture
//! ```

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::executor::block_on;
use milagre_gpui_spike::workspace::panel::terminal::remote::{RemoteOutput, TerminalHost};
use milagre_gpui_spike::workspace::panel::terminal::session::GridSize;

use crate::daemon::{Daemon, Start};
use crate::terminals::LiveTerminals;

#[test]
#[ignore]
fn bundled_daemon_runs_a_terminal() {
    let var = |name: &str| PathBuf::from(std::env::var_os(name).unwrap_or_else(|| panic!("{name} is required")));
    let (bundle, profile, project) = (var("GPUI_BUNDLE_DIR"), var("GPUI_BUNDLE_PROFILE"), var("GPUI_BUNDLE_PROJECT"));
    let home = std::env::var("HOME").unwrap_or_default();
    assert!(!profile.starts_with(format!("{home}/Library")), "never a real profile");
    let start = Start::choose(Err("Milagre.app is not used here".into()), Some(bundle));
    assert!(matches!(start, Start::Bundled(_)), "{start:?}");
    let daemon = Daemon::starting(Some(profile), false, start);
    let synced = block_on(daemon.sync()).expect("adopt the bundled daemon");
    let project = project.to_string_lossy().into_owned();
    let chat = synced
        .reducer
        .state()
        .unwrap()
        .projects
        .iter()
        .find(|open| open.project.path.as_ref() == project)
        .and_then(|open| open.state.as_ref()?.sessions.keys().min().copied())
        .expect("the Project's first Chat");
    println!("bundled daemon {} (pid {}), Chat {chat} of {project}", synced.version, synced.pid);
    drop(synced);

    let terminals = Arc::new(LiveTerminals::daemon(daemon.clone()));
    let (terminal, output) = terminals.open(&format!("{project}#{chat}"), GridSize { cols: 80, lines: 24 });
    terminal.input(b"echo bundled-pty-$((6*7))\r".to_vec());
    let mut seen = String::new();
    let until = Instant::now() + Duration::from_secs(20);
    while !seen.contains("bundled-pty-42") && Instant::now() < until {
        match output.try_recv() {
            Ok(RemoteOutput::Data(bytes)) => seen.push_str(&String::from_utf8_lossy(&bytes)),
            Ok(RemoteOutput::Reset) => {}
            Ok(other) => panic!("the Terminal stopped: {other:?}; saw {seen:?}"),
            Err(async_channel::TryRecvError::Empty) => std::thread::sleep(Duration::from_millis(20)),
            Err(async_channel::TryRecvError::Closed) => break,
        }
    }
    terminal.close();
    daemon.disconnect();
    assert!(seen.contains("bundled-pty-42"), "no output from the bundled daemon's Terminal: {seen:?}");
    println!("terminal ok: the bundled daemon's node-pty ran the command");
}

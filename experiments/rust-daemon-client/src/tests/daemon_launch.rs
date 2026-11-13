use super::*;
use crate::{DaemonLaunch, InstalledOwner};
use std::path::{Path, PathBuf};

fn fake() -> DaemonLaunch {
    let entry = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake_daemon.py");
    DaemonLaunch::node(
        Path::new("/usr/bin/python3"),
        &entry,
        "9.9.9-test",
        Some(Path::new("/opt/bin")),
    )
    .unwrap()
    .with_startup_timeout(Duration::from_secs(10))
}
fn starts(data: &Path) -> Vec<Value> {
    std::fs::read_to_string(data.join("starts.log"))
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}
struct Cleanup(PathBuf);
impl Drop for Cleanup {
    fn drop(&mut self) {
        for start in starts(&self.0) {
            unsafe { libc::kill(start["pid"].as_i64().unwrap() as libc::pid_t, libc::SIGTERM) };
        }
    }
}

#[test]
fn starts_the_daemon_once_then_adopts_it() {
    let dir = tempfile::tempdir().unwrap();
    let data = std::fs::canonicalize(dir.path()).unwrap().join("profile");
    let _cleanup = Cleanup(data.clone());
    let owner = block_on(InstalledOwner::adopt_or_start_profile(&data, &fake())).unwrap();
    assert_eq!(owner.info().version, "9.9.9-test");
    let first = starts(&data);
    assert_eq!(first.len(), 1);
    assert_eq!(first[0]["pid"].as_u64(), Some(owner.info().pid as u64));
    assert_eq!(
        first[0]["argv"],
        json!([
            "serve",
            "--data-dir",
            data.to_str().unwrap(),
            "--app-version",
            "9.9.9-test",
            "--cwd",
            "/"
        ])
    );
    assert_eq!(
        first[0]["electron"],
        Value::Null,
        "a plain Node launch is not Electron's Node mode"
    );
    assert_eq!(first[0]["bin"], "/opt/bin");
    assert_eq!(first[0]["sid"], true, "detached into its own session");
    let mode = std::fs::metadata(&data).unwrap().permissions();
    assert_eq!(
        std::os::unix::fs::PermissionsExt::mode(&mode) & 0o777,
        0o700
    );
    let again = block_on(InstalledOwner::adopt_or_start_profile(&data, &fake())).unwrap();
    assert_eq!(again.info().pid, owner.info().pid);
    assert_eq!(
        starts(&data).len(),
        1,
        "a running daemon is adopted, never restarted"
    );
}

#[test]
fn a_live_lock_owner_is_waited_for_not_raced() {
    let dir = tempfile::tempdir().unwrap();
    let data = std::fs::canonicalize(dir.path()).unwrap();
    std::fs::create_dir(data.join("runtime.lock")).unwrap();
    std::fs::write(
        data.join("runtime.lock/owner.json"),
        json!({"pid": std::process::id(), "startedAt": "2026-01-01T00:00:00Z"}).to_string(),
    )
    .unwrap();
    let launch = fake().with_startup_timeout(Duration::from_millis(300));
    assert!(matches!(
        block_on(InstalledOwner::adopt_or_start_profile(&data, &launch)),
        Err(Error::Launch {
            code: "DAEMON_START_TIMEOUT",
            ..
        })
    ));
    assert!(starts(&data).is_empty());
}

#[test]
fn a_dead_lock_owner_does_not_block_a_start() {
    let dir = tempfile::tempdir().unwrap();
    let data = std::fs::canonicalize(dir.path()).unwrap();
    let _cleanup = Cleanup(data.clone());
    std::fs::create_dir(data.join("runtime.lock")).unwrap();
    std::fs::write(
        data.join("runtime.lock/owner.json"),
        json!({"pid": i32::MAX}).to_string(),
    )
    .unwrap();
    block_on(InstalledOwner::adopt_or_start_profile(&data, &fake())).unwrap();
    assert_eq!(starts(&data).len(), 1);
}

#[test]
fn launch_inputs_are_checked() {
    assert!(DaemonLaunch::node(Path::new("node"), Path::new("/cli.cjs"), "1.0.0", None).is_err());
    assert!(DaemonLaunch::node(Path::new("/node"), Path::new("/cli.cjs"), "1 0", None).is_err());
    assert!(DaemonLaunch::installed_app(Path::new("/nonexistent/Milagre.app")).is_err());
}

#[test]
fn the_installed_app_launch_runs_its_own_daemon_in_node_mode() {
    let Ok(launch) = DaemonLaunch::find_installed_app() else {
        eprintln!("Milagre.app not installed; skipped");
        return;
    };
    let debug = format!("{launch:?}");
    assert!(debug.contains("electron_node: true"));
    assert!(debug.contains("app.asar/node_modules/@milagre/daemon/src/cli.cjs"));
    assert!(!launch.version().is_empty());
}

#[test]
fn a_bundle_manifest_stays_inside_its_folder() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::create_dir_all(root.join("bin")).unwrap();
    std::fs::create_dir_all(root.join("app")).unwrap();
    std::fs::write(root.join("bin/node"), "").unwrap();
    std::fs::write(root.join("app/cli.cjs"), "").unwrap();
    let write =
        |manifest: Value| std::fs::write(root.join("manifest.json"), manifest.to_string()).unwrap();
    write(json!({"schema":1,"version":"1.2.3","node":"bin/node","entry":"app/cli.cjs"}));
    let launch = DaemonLaunch::bundle(root).unwrap();
    assert_eq!(launch.version(), "1.2.3");
    assert!(format!("{launch:?}").contains("electron_node: false"));
    for bad in [
        json!({"schema":1,"version":"1","node":"../bin/node","entry":"app/cli.cjs"}),
        json!({"schema":1,"version":"1","node":"/usr/bin/python3","entry":"app/cli.cjs"}),
        json!({"schema":1,"version":"1","node":"bin/missing","entry":"app/cli.cjs"}),
        json!({"schema":2,"version":"1","node":"bin/node","entry":"app/cli.cjs"}),
        json!({"schema":1,"version":"1 2","node":"bin/node","entry":"app/cli.cjs"}),
    ] {
        write(bad);
        assert!(DaemonLaunch::bundle(root).is_err());
    }
    assert!(DaemonLaunch::bundle(&root.join("missing")).is_err());
}

#[test]
fn only_electrons_milagre_app_runs_the_daemon() {
    let home = std::env::var_os("HOME").unwrap();
    let gpui = Path::new(&home).join("Applications/Milagre.app");
    if gpui.is_dir() {
        // The GPUI app installed under the same name is never taken for Electron's.
        assert!(DaemonLaunch::installed_app(&gpui).is_err());
    }
    if let Ok(found) = DaemonLaunch::find_installed_app() {
        assert!(format!("{found:?}").contains("/Applications/Milagre.app/Contents/MacOS/Milagre"));
    }
}

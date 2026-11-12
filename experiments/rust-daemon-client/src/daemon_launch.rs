//! Start the Node daemon when none runs, the way `apps/daemon/src/bootstrap.cjs` does, so a native frontend works
//! without Electron's window process. A running daemon is always adopted, never stopped or replaced: the installed
//! Electron app replaces a host older than itself, so a frontend must not fight it over versions.
use crate::installed_owner::{adopt_blocking, blocking, failure};
use crate::{Error, InstalledOwner, Result};
use std::{
    fs::{self, OpenOptions},
    os::unix::{
        fs::{DirBuilderExt, OpenOptionsExt},
        process::CommandExt,
    },
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

const LOG_ROTATE_BYTES: u64 = 10 * 1024 * 1024;

/// How to start the daemon. Only the two constructors below exist: the installed app's own daemon, or an explicit
/// Node runtime and daemon entry shipped with the frontend.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DaemonLaunch {
    executable: PathBuf,
    entry: PathBuf,
    version: String,
    bin_dir: Option<PathBuf>,
    electron_node: bool,
    startup_timeout: Duration,
}

impl DaemonLaunch {
    /// The daemon an installed Milagre.app ships, run on that app's executable in Node mode
    /// (`ELECTRON_RUN_AS_NODE=1`): no window and no Electron UI process, and always the version that app expects.
    pub fn installed_app(app: &Path) -> Result<Self> {
        let plist = app.join("Contents/Info.plist");
        let read = |key: &str| -> Result<String> {
            let output = Command::new("/usr/bin/plutil")
                .args(["-extract", key, "raw", "-o", "-"])
                .arg(&plist)
                .output()
                .map_err(|_| {
                    failure("APP_UNAVAILABLE", "Could not read Milagre.app's Info.plist")
                })?;
            let value = String::from_utf8(output.stdout)
                .unwrap_or_default()
                .trim()
                .to_owned();
            if !output.status.success() || value.is_empty() || value.contains('/') {
                return Err(failure(
                    "APP_UNAVAILABLE",
                    "Milagre.app's Info.plist is incomplete",
                ));
            }
            Ok(value)
        };
        let executable = app.join("Contents/MacOS").join(read("CFBundleExecutable")?);
        let asar = app.join("Contents/Resources/app.asar");
        if !executable.is_file() || !asar.is_file() {
            return Err(failure("APP_UNAVAILABLE", "Milagre.app is incomplete"));
        }
        let bin_dir = app.join("Contents/Resources/bin");
        Ok(Self {
            executable,
            entry: asar.join("node_modules/@milagre/daemon/src/cli.cjs"),
            version: read("CFBundleShortVersionString")?,
            bin_dir: bin_dir.is_dir().then_some(bin_dir),
            electron_node: true,
            startup_timeout: Duration::from_secs(15),
        })
    }

    /// The first installed Milagre.app: `/Applications`, then `~/Applications`.
    pub fn find_installed_app() -> Result<Self> {
        let mut candidates = vec![PathBuf::from("/Applications/Milagre.app")];
        if let Some(home) = std::env::var_os("HOME") {
            candidates.push(PathBuf::from(home).join("Applications/Milagre.app"));
        }
        candidates
            .iter()
            .find(|app| app.is_dir())
            .ok_or_else(|| failure("APP_UNAVAILABLE", "Milagre.app is not installed"))
            .and_then(|app| Self::installed_app(app))
    }

    /// A Node runtime and daemon entry shipped with the frontend, for a computer without Milagre.app.
    pub fn node(
        executable: &Path,
        entry: &Path,
        version: &str,
        bin_dir: Option<&Path>,
    ) -> Result<Self> {
        if !executable.is_absolute()
            || !entry.is_absolute()
            || bin_dir.is_some_and(|dir| !dir.is_absolute())
        {
            return Err(Error::InvalidInput {
                field: "launch",
                message: "Expected absolute paths",
            });
        }
        if version.is_empty() || version.len() > 64 || version.chars().any(char::is_whitespace) {
            return Err(Error::InvalidInput {
                field: "version",
                message: "Expected a version without spaces",
            });
        }
        Ok(Self {
            executable: executable.to_owned(),
            entry: entry.to_owned(),
            version: version.to_owned(),
            bin_dir: bin_dir.map(Path::to_owned),
            electron_node: false,
            startup_timeout: Duration::from_secs(15),
        })
    }

    /// A daemon bundle made by `scripts/bundle-node-daemon.sh`: `manifest.json` names its Node, daemon entry and
    /// app version, all inside `dir`. For a computer without Milagre.app.
    pub fn bundle(dir: &Path) -> Result<Self> {
        let unavailable = |message: &'static str| failure("BUNDLE_UNAVAILABLE", message);
        let dir = fs::canonicalize(dir)
            .map_err(|_| unavailable("The daemon bundle folder is missing"))?;
        let text = fs::read(dir.join("manifest.json"))
            .map_err(|_| unavailable("The daemon bundle has no manifest"))?;
        let manifest: serde_json::Value = serde_json::from_slice(&text)
            .map_err(|_| unavailable("The daemon bundle manifest is damaged"))?;
        let inside = |key: &str| -> Result<PathBuf> {
            let relative = manifest[key].as_str().filter(|path| {
                !path.is_empty()
                    && !Path::new(path).is_absolute()
                    && Path::new(path)
                        .components()
                        .all(|part| matches!(part, std::path::Component::Normal(_)))
            });
            let path = dir.join(
                relative.ok_or_else(|| unavailable("The daemon bundle manifest is damaged"))?,
            );
            if !path.is_file() {
                return Err(unavailable("The daemon bundle is incomplete"));
            }
            Ok(path)
        };
        if manifest["schema"] != 1 {
            return Err(unavailable(
                "The daemon bundle manifest is from another version",
            ));
        }
        Self::node(
            &inside("node")?,
            &inside("entry")?,
            manifest["version"].as_str().unwrap_or_default(),
            None,
        )
    }

    /// How long to wait for a started daemon to answer (default 15 s, as bootstrap.cjs).
    pub fn with_startup_timeout(mut self, timeout: Duration) -> Self {
        self.startup_timeout = timeout.clamp(Duration::from_millis(100), Duration::from_secs(60));
        self
    }

    pub fn version(&self) -> &str {
        &self.version
    }
}

impl InstalledOwner {
    /// Adopt the installed Milagre's daemon, starting it with `launch` when none runs.
    pub async fn adopt_or_start(launch: &DaemonLaunch) -> Result<Self> {
        let home = std::env::var_os("HOME")
            .ok_or_else(|| failure("PROFILE_UNAVAILABLE", "HOME is not set"))?;
        Self::adopt_or_start_profile(
            &PathBuf::from(home).join("Library/Application Support/Milagre"),
            launch,
        )
        .await
    }

    /// [`Self::adopt_or_start`] for an explicit data directory.
    pub async fn adopt_or_start_profile(data_dir: &Path, launch: &DaemonLaunch) -> Result<Self> {
        let (data_dir, launch) = (data_dir.to_owned(), launch.clone());
        blocking(move || start_blocking(&data_dir, &launch)).await
    }
}

/// Retried while the daemon is absent, starting or stopping. Anything else (a foreign socket, an unsafe directory)
/// is final.
fn waiting(error: &Error) -> bool {
    match error {
        Error::Launch { code, .. } => matches!(*code, "DAEMON_UNAVAILABLE" | "DAEMON_CLOSING"),
        Error::Disconnected | Error::TimedOut { .. } => true,
        Error::Protocol { .. } => true,
        _ => false,
    }
}

fn start_blocking(data_dir: &Path, launch: &DaemonLaunch) -> Result<InstalledOwner> {
    if !data_dir.is_absolute() {
        return Err(failure(
            "PROFILE_UNAVAILABLE",
            "Use an absolute data directory",
        ));
    }
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(data_dir)
        .map_err(|_| {
            failure(
                "PROFILE_UNAVAILABLE",
                "Could not create the Milagre data directory",
            )
        })?;
    let data_dir = fs::canonicalize(data_dir).map_err(|_| {
        failure(
            "PROFILE_UNAVAILABLE",
            "The Milagre data directory does not exist",
        )
    })?;
    match adopt_blocking(&data_dir) {
        Ok(owner) => return Ok(owner),
        Err(error) if waiting(&error) => {}
        Err(error) => return Err(error),
    }
    let lock = data_dir.join("runtime.lock");
    let until = Instant::now() + launch.startup_timeout;
    let mut started = false;
    loop {
        // A live lock owner is a host still starting or stopping: wait for it instead of starting a second one. A dead
        // owner's lock doesn't block a start: the new host takes it over (packages/core/src/ownership.cjs).
        if !started && !owner_alive(&lock) {
            spawn(&data_dir, launch)?;
            started = true;
        }
        match adopt_blocking(&data_dir) {
            Ok(owner) => return Ok(owner),
            Err(error) if waiting(&error) => {}
            Err(error) => return Err(error),
        }
        if Instant::now() >= until {
            return Err(failure(
                "DAEMON_START_TIMEOUT",
                format!(
                    "Milagre's daemon did not start. Check {} and never remove a live owner's lock.",
                    data_dir.join("daemon.log").display()
                ),
            ));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn owner_alive(lock: &Path) -> bool {
    let Ok(text) = fs::read_to_string(lock.join("owner.json")) else {
        // A lock without a record is a host that just made it, unless it is over a minute old (a crash between the two).
        return fs::metadata(lock)
            .and_then(|meta| meta.modified())
            .is_ok_and(|made| made.elapsed().unwrap_or_default() < Duration::from_secs(60));
    };
    let Some(pid) = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|owner| owner["pid"].as_u64())
        .filter(|pid| *pid > 0 && *pid <= i32::MAX as u64)
    else {
        return false;
    };
    // Signal 0 checks existence; EPERM still means alive.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 || *libc::__error() == libc::EPERM }
}

fn spawn(data_dir: &Path, launch: &DaemonLaunch) -> Result<()> {
    let log_path = data_dir.join("daemon.log");
    if let Ok(meta) = fs::symlink_metadata(&log_path) {
        if !meta.is_file() {
            return Err(failure(
                "UNSAFE_LOG",
                "The daemon log must be a regular file",
            ));
        }
        if meta.len() > LOG_ROTATE_BYTES {
            let _ = fs::rename(&log_path, data_dir.join("daemon.log.1"));
        }
    }
    let log = OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&log_path)
        .map_err(|_| failure("UNSAFE_LOG", "Could not open the daemon log"))?;
    let err = log
        .try_clone()
        .map_err(|_| failure("UNSAFE_LOG", "Could not open the daemon log"))?;
    let mut command = Command::new(&launch.executable);
    command
        .arg(&launch.entry)
        .args(["serve", "--data-dir"])
        .arg(data_dir)
        .args(["--app-version", &launch.version, "--cwd", "/"])
        .current_dir("/")
        .stdin(Stdio::null())
        .stdout(log)
        .stderr(err);
    // Set or cleared explicitly: a frontend started from a Milagre terminal or agent inherits both.
    if launch.electron_node {
        command.env("ELECTRON_RUN_AS_NODE", "1");
    } else {
        command.env_remove("ELECTRON_RUN_AS_NODE");
    }
    match &launch.bin_dir {
        Some(bin_dir) => command.env("MILAGRE_BUNDLED_BIN_DIR", bin_dir),
        None => command.env_remove("MILAGRE_BUNDLED_BIN_DIR"),
    };
    // Its own session, like Node's `detached: true`: the daemon outlives this frontend and its terminal.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command
        .spawn()
        .map_err(|_| failure("DAEMON_START_FAILED", "Could not start Milagre's daemon"))?;
    // Reap it if it exits while this frontend runs; it is never signalled from here.
    std::thread::Builder::new()
        .name("milagre-daemon-reaper".into())
        .spawn(move || {
            let _ = child.wait();
        })
        .map_err(|_| failure("DAEMON_START_FAILED", "Could not watch the started daemon"))?;
    Ok(())
}

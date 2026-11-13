//! A Rust owner for one isolated Milagre data directory, behind the Node daemon's socket and client API.
//!
//! `profile-owner serve --data-dir D --app-version V [--chats-home H] [--worktree-root W] [--cwd C]` (the Node daemon's
//! `apps/daemon/src/cli.cjs serve` arguments):
//!
//! 1. D, the chats home and the Worktree root must be inside one isolated copy folder (`MILAGRE-ISOLATED-COPY`, see
//!    `milagre-owner-store`'s `Isolation`), opened with its refusals of Milagre's own folders and registered Projects.
//! 2. D's `runtime.lock` is taken as Node's runtime takes it (`realpath(D)/runtime.lock`, `ownership.cjs` format), so a
//!    Node daemon and this owner exclude each other on D. A lock already there, live or not, is refused.
//! 3. The socket Node derives for D is bound (a crashed owner's socket file removed first, under the lock).
//! 4. Reads are served in Node's shapes until `daemon:stop`, end of stdin, SIGTERM or SIGINT; then every Project lock,
//!    the socket and D's lock are released, in that order.
//!
//! See README.md for what is served and every known difference from Node.
mod chats;
pub mod handler;
pub mod image;
pub mod keybindings;
pub mod origin;
pub mod policy;
pub mod reconcile;
pub mod settings;

use handler::{DataLock, Profile};
use milagre_owner_store::{
    ownership::{OwnerGuard, RustOwnerLock},
    write::OwnerLock,
};
use milagre_owner_wire::{Config, DataDirEndpoint, Server};
use serde_json::json;
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

/// `serve`'s arguments, as `cli.cjs` parses them.
#[derive(Clone, Debug, PartialEq)]
pub struct Options {
    pub data_dir: PathBuf,
    pub app_version: String,
    pub chats_home: Option<PathBuf>,
    pub worktree_root: Option<PathBuf>,
    pub cwd: Option<PathBuf>,
}

const USAGE: &str = "profile-owner serve --data-dir /absolute/path --app-version VERSION [--chats-home /absolute/path] [--worktree-root /absolute/path] [--cwd /absolute/path]\n\nServes an isolated Milagre data directory (one inside a MILAGRE-ISOLATED-COPY folder) at the Node daemon's socket, reads and file-backed settings. Stops on daemon:stop, end of stdin, SIGTERM or SIGINT.";

/// Parses `serve` arguments (`--name value` or `--name=value`). `Ok(None)` is `--help`.
pub fn parse_args(args: &[String]) -> Result<Option<Options>, String> {
    let mut positionals = Vec::new();
    let mut values: Vec<(String, String)> = Vec::new();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == "--help" || arg == "-h" {
            return Ok(None);
        }
        if let Some(option) = arg.strip_prefix("--") {
            let (name, value) = match option.split_once('=') {
                Some((name, value)) => (name.to_owned(), value.to_owned()),
                None => (
                    option.to_owned(),
                    iter.next()
                        .ok_or_else(|| format!("Option '--{option} <value>' argument missing"))?
                        .clone(),
                ),
            };
            if !matches!(
                name.as_str(),
                "data-dir" | "app-version" | "chats-home" | "worktree-root" | "cwd"
            ) {
                return Err(format!("Unknown option '--{name}'. {USAGE}"));
            }
            values.retain(|(known, _)| known != &name);
            values.push((name, value));
        } else {
            positionals.push(arg.clone());
        }
    }
    if positionals.first().map(String::as_str) != Some("serve") {
        return Err(format!("Only serve is supported. {USAGE}"));
    }
    if positionals.len() != 1 {
        return Err("Unexpected serve arguments".into());
    }
    let value = |name: &str| {
        values
            .iter()
            .find(|(known, _)| known == name)
            .map(|(_, value)| value.clone())
    };
    let absolute = |name: &str| -> Result<Option<PathBuf>, String> {
        match value(name) {
            None => Ok(None),
            Some(path) if Path::new(&path).is_absolute() => Ok(Some(PathBuf::from(path))),
            Some(_) => Err(format!("Pass an absolute --{name}")),
        }
    };
    let data_dir = absolute("data-dir")?.ok_or("Pass an absolute --data-dir")?;
    let app_version = value("app-version")
        .filter(|version| !version.is_empty())
        .ok_or("Pass --app-version: the version daemon:status reports")?;
    Ok(Some(Options {
        data_dir,
        app_version,
        chats_home: absolute("chats-home")?,
        worktree_root: absolute("worktree-root")?,
        cwd: absolute("cwd")?,
    }))
}

pub fn usage() -> &'static str {
    USAGE
}

/// A running owner: the server, and D's lock to release once the server finished.
pub struct Owner {
    pub server: Arc<Server>,
    data_lock: DataLock,
    ready: serde_json::Value,
}

impl Owner {
    /// The first stdout line, as `cli.cjs serve` prints it: `{ status, pid, dataDir (as passed), socketPath }`.
    pub fn ready_line(&self) -> String {
        self.ready.to_string()
    }

    /// After the server stopped: waits for its socket to go, then releases D's lock.
    ///
    /// The lock is released once the server stopped even if waiting for its socket or its last request threads timed
    /// out: the owner's work (Project and repository locks) ended with the stop and no command is admitted any more; a
    /// socket file left behind is a stale endpoint the next owner removes under its own lock. Only a server that never
    /// stopped keeps the lock, and the error says so: this process then still owns D until it exits, after which the
    /// lock names a dead process (Node takes that over; this owner refuses it until an operator removes it).
    pub fn finish(self) -> Result<(), String> {
        let server = Arc::downgrade(&self.server);
        let finished = Server::finish(self.server).map_err(|error| error.to_string());
        if let Err(error) = &finished {
            if server.upgrade().is_some_and(|server| !server.is_stopped()) {
                return Err(format!(
                    "{error}; the owner didn't stop, so the data directory's runtime.lock stays held by this process"
                ));
            }
        }
        let guard = self
            .data_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        let released = match guard {
            Some(mut guard) => guard.release().map_err(|error| error.to_string()),
            None => Ok(()),
        };
        finished.and(released)
    }
}

/// The real path of `path`, or of its nearest existing ancestor with the rest appended (`fs.realpath` where it can,
/// `path.resolve` beyond), so `/var/...` and `/private/var/...` name the same folder.
fn real_or_resolved(path: &Path) -> PathBuf {
    let mut rest = Vec::new();
    let mut current = path.to_path_buf();
    loop {
        if let Ok(real) = std::fs::canonicalize(&current) {
            return rest
                .into_iter()
                .rev()
                .fold(real, |path, part| path.join(part));
        }
        match (
            current.file_name().map(|name| name.to_owned()),
            current.parent(),
        ) {
            (Some(name), Some(parent)) => {
                rest.push(name);
                current = parent.to_path_buf();
            }
            _ => return path.to_path_buf(),
        }
    }
}

fn home_default(path: Option<&PathBuf>, under: &str) -> Result<PathBuf, String> {
    match path {
        Some(path) => Ok(path.clone()),
        None => std::env::var_os("HOME")
            .map(|home| PathBuf::from(home).join(under))
            .ok_or_else(|| {
                format!(
                    "HOME is not set; pass --{}",
                    under.rsplit('/').next().unwrap_or(under)
                )
            }),
    }
}

/// Opens the isolation, takes D's lock and binds D's socket. Nothing is written before every check passed, and a
/// failure after the lock was taken releases it.
pub fn start(options: &Options) -> Result<Owner, String> {
    start_inner(options, Vec::new())
}

/// Explicit synthetic provider composition for isolated tests. No CLI flag enables it.
#[cfg(feature = "chat-fixture")]
pub fn start_with_providers(
    options: &Options,
    providers: Vec<Box<dyn milagre_owner_store::chat_host::Provider>>,
) -> Result<Owner, String> {
    if providers.is_empty() {
        return Err("Pass at least one synthetic provider".into());
    }
    start_inner(options, providers)
}

fn start_inner(
    options: &Options,
    providers: Vec<Box<dyn milagre_owner_store::chat_host::Provider>>,
) -> Result<Owner, String> {
    let data_dir = std::fs::canonicalize(&options.data_dir).map_err(|error| {
        format!(
            "The data directory {} must exist: {error}",
            options.data_dir.display()
        )
    })?;
    if !data_dir.is_dir() {
        return Err(format!("{} isn't a folder", data_dir.display()));
    }
    let isolation = policy::isolation_for(&data_dir, &policy::owner_policy())?;
    isolation
        .resolve(&data_dir)
        .map_err(|error| error.to_string())?;
    // Node's defaults (~/.milagre/chats, ~/.milagre/worktrees) are never inside an isolated copy: pass them explicitly.
    let chats_home = real_or_resolved(&home_default(
        options.chats_home.as_ref(),
        ".milagre/chats",
    )?);
    let worktree_root = real_or_resolved(&home_default(
        options.worktree_root.as_ref(),
        ".milagre/worktrees",
    )?);
    for (name, path) in [
        ("chats home", &chats_home),
        ("Worktree root", &worktree_root),
    ] {
        isolation
            .resolve(path)
            .map_err(|error| format!("The {name} must be inside the isolated copy: {error}"))?;
    }
    let guard: OwnerGuard = RustOwnerLock
        .acquire(&data_dir, &data_dir.join("runtime.lock"))
        .map_err(|error| error.to_string())?;
    let token = guard.token().to_owned();
    let data_lock: DataLock = Arc::new(Mutex::new(Some(guard)));
    let release = |data_lock: &DataLock| {
        if let Some(mut guard) = data_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        {
            let _ = guard.release();
        }
    };
    let started = (|| {
        let endpoint = DataDirEndpoint::claim(&options.data_dir, &token, &options.app_version)
            .map_err(|error| error.to_string())?;
        let profile = Arc::new(Profile::new(
            isolation,
            data_dir.clone(),
            chats_home,
            data_lock.clone(),
            options.app_version.clone(),
        )?);
        profile.register_providers(providers);
        let server = Server::bind_data_dir(endpoint, profile.clone(), Config::default())
            .map_err(|error| error.to_string())?;
        profile.watch_keybindings(server.events());
        profile.watch_chats(server.events());
        Ok::<_, String>(server)
    })();
    let server = match started {
        Ok(server) => Arc::new(server),
        Err(error) => {
            release(&data_lock);
            return Err(error);
        }
    };
    let ready = json!({
        "status": "ready",
        "pid": std::process::id(),
        "dataDir": options.data_dir,
        "socketPath": server.socket_path(),
    });
    Ok(Owner {
        server,
        data_lock,
        ready,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| arg.to_string()).collect()
    }

    #[test]
    fn parses_node_serve_arguments() {
        let parsed = parse_args(&args(&[
            "serve",
            "--data-dir",
            "/d",
            "--app-version=1.2.3",
            "--cwd",
            "/",
            "--chats-home",
            "/c",
            "--worktree-root",
            "/w",
        ]))
        .unwrap()
        .unwrap();
        assert_eq!(
            parsed,
            Options {
                data_dir: "/d".into(),
                app_version: "1.2.3".into(),
                chats_home: Some("/c".into()),
                worktree_root: Some("/w".into()),
                cwd: Some("/".into()),
            }
        );
        assert_eq!(parse_args(&args(&["--help"])).unwrap(), None);
        for bad in [
            &["serve", "--data-dir", "relative", "--app-version", "1"][..],
            &["serve", "--app-version", "1"],
            &["serve", "--data-dir", "/d"],
            &["status", "--data-dir", "/d", "--app-version", "1"],
            &["serve", "extra", "--data-dir", "/d", "--app-version", "1"],
            &[
                "serve",
                "--data-dir",
                "/d",
                "--app-version",
                "1",
                "--port",
                "1",
            ],
            &["serve", "--data-dir"],
        ] {
            assert!(parse_args(&args(bad)).is_err(), "{bad:?}");
        }
    }
}

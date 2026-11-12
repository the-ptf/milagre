//! Interim attachment to the installed Milagre's running Node daemon (feature `installed-owner`).
//!
//! The GPUI Preview uses this while the Rust owner lacks phone, upgrade and service parity, so its
//! Chats are the same Chats Electron and paired phones see. The daemon stays the only writer: this
//! client never launches, stops, restarts or replaces it, and has no shutdown method.
//!
//! Every connection re-checks the socket owner's uid and PID against the daemon adopted here. A
//! restarted daemon is refused with `INSTALLED_OWNER_CHANGED`; adopt again to follow it.
use crate::{
    launcher, Authority, Client, ClientOptions, Error, FixtureEndpoint, Hello, Notifications,
    Result,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::{BufRead, BufReader, Read, Write},
    os::unix::{
        fs::{FileTypeExt, MetadataExt},
        net::UnixStream,
    },
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const PROBE_LIMIT: u64 = 16 * 1024 * 1024;

fn failure(code: &'static str, message: impl Into<String>) -> Error {
    Error::Launch {
        code,
        message: message.into(),
    }
}

/// What was adopted. Paths are diagnostics; they do not mint authority.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstalledOwnerInfo {
    pub pid: u32,
    pub version: String,
    pub data_dir: PathBuf,
    pub socket: PathBuf,
}

/// One Project the daemon knows, from `project:known`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KnownProject {
    pub path: String,
    pub name: String,
}

/// The installed daemon, adopted by uid and PID. Never launches or stops it.
///
/// ```compile_fail
/// use milagre_daemon_client::InstalledOwner;
/// let owner = InstalledOwner::from_socket("/tmp/daemon.sock");
/// ```
pub struct InstalledOwner {
    info: InstalledOwnerInfo,
}

/// Project-scoped authority on the adopted daemon. Each Client connects to one Project, as with
/// the owned runtimes; open one per Project the frontend shows.
pub struct InstalledProject {
    authority: Arc<Authority>,
}

impl InstalledOwner {
    /// Adopt the daemon of the installed Milagre (`~/Library/Application Support/Milagre`).
    /// Fails with `DAEMON_UNAVAILABLE` when Milagre is not running.
    pub async fn adopt() -> Result<Self> {
        let home = std::env::var_os("HOME")
            .ok_or_else(|| failure("PROFILE_UNAVAILABLE", "HOME is not set"))?;
        Self::adopt_profile(&PathBuf::from(home).join("Library/Application Support/Milagre")).await
    }

    /// Adopt the daemon already running for an explicit Milagre data directory (a throwaway
    /// profile in tests). Same checks as [`Self::adopt`]; nothing is started.
    pub async fn adopt_profile(data_dir: &Path) -> Result<Self> {
        let data_dir = data_dir.to_owned();
        blocking(move || adopt_blocking(&data_dir)).await
    }

    pub fn info(&self) -> &InstalledOwnerInfo {
        &self.info
    }

    /// The daemon's known Projects (`project:known`), most recently opened first.
    pub async fn known_projects(&self) -> Result<Vec<KnownProject>> {
        let info = self.info.clone();
        blocking(move || {
            let mut stream = open(&info.socket, info.pid)?;
            let value = probe(&mut stream, "project:known", json!([]))?;
            let list = value
                .as_array()
                .ok_or_else(|| crate::protocol("project:known did not return a list"))?;
            Ok(list
                .iter()
                .filter_map(|entry| {
                    Some(KnownProject {
                        path: entry["path"].as_str()?.to_owned(),
                        name: entry["name"].as_str().unwrap_or_default().to_owned(),
                    })
                })
                .collect())
        })
        .await
    }

    /// Authority for one registered Project path. The daemon validates the path on use.
    pub fn project(&self, path: &str) -> Result<InstalledProject> {
        if path.is_empty() || path.len() > 4096 || path.contains('\0') || !path.starts_with('/') {
            return Err(Error::InvalidInput {
                field: "project",
                message: "Expected an absolute Project path",
            });
        }
        let (socket, pid) = (self.info.socket.clone(), self.info.pid);
        Ok(InstalledProject {
            authority: Arc::new(Authority {
                project: path.to_owned(),
                pid,
                connect: Box::new(move || open(&socket, pid)),
                launcher: None,
            }),
        })
    }
}

impl Client {
    /// Load this Project in the installed daemon without `project:open`: no recents reorder, no current-Project change.
    /// It is the read Electron's every-Project sidebar makes (`project:read` with `{state:false}`), so on the first load
    /// in a daemon run the daemon reconciles Worktrees and resumes Chats a quit stopped, as opening it in Electron does.
    /// Afterwards actions are allowed on this Client, as after [`Client::open_view`].
    #[cfg(feature = "installed-owner")]
    pub async fn load_view(&self, path: &str) -> Result<Value> {
        self.scope(path)?;
        let result = self.project_result(
            self.read("project:read", json!([path, {"state": false}]))
                .await?,
        )?;
        self.mark_view_opened();
        Ok(result)
    }
}

impl InstalledProject {
    #[cfg(test)]
    pub(crate) fn for_test(authority: Arc<Authority>) -> Self {
        Self { authority }
    }
    pub fn project(&self) -> &str {
        &self.authority.project
    }
    /// Connect to the adopted daemon for this Project. Never launches or attaches elsewhere.
    pub async fn connect(&self, options: ClientOptions) -> Result<(Client, Hello, Notifications)> {
        Client::connect(
            FixtureEndpoint {
                authority: self.authority.clone(),
            },
            options,
        )
        .await
    }
    /// Sends, interrupts, approvals and questions for this Client. New Chats start in the main
    /// Worktree with the given provider and model; existing Chats keep their own.
    pub fn chat_actions(
        &self,
        client: &Client,
        provider: &str,
        model: &str,
    ) -> Result<crate::ChatActions> {
        client.installed_actions_for(&self.authority, provider, model)
    }
    pub fn terminal_actions(&self, client: &Client) -> Result<crate::TerminalActions> {
        client.owned_terminals_for(&self.authority)
    }
    pub fn git_reads(&self, client: &Client) -> Result<crate::GitReads> {
        client.owned_git_for(&self.authority)
    }
    /// The daemon's model catalog for this Project's accounts: `{claude|codex|antigravity|kiro: [{id, name,
    /// recommended, efforts, defaultEffort?, ...}] | null}`. Use the first `recommended` model of a Chat's provider
    /// when the Chat has no recorded model.
    pub async fn models(&self, client: &Client) -> Result<Value> {
        if !client.bound_to(&self.authority) {
            return Err(Error::InvalidScope);
        }
        client
            .read("agent:models", json!([self.authority.project]))
            .await
    }
    /// Any command Electron's window may send the daemon ([`crate::renderer_commands`]), for the screens the typed
    /// capabilities don't cover yet: Settings, Details, the composer pills, PR details, changing a Chat's model.
    /// Arguments are the preload's, as a JSON array. The daemon checks them and its own Project scope, as it does
    /// for Electron. Refused without a request: a command outside that set, `app-update:install`, or one the daemon
    /// doesn't advertise. Paged replies are assembled like every other read.
    pub async fn call(&self, client: &Client, method: &str, args: Value) -> Result<Value> {
        if !client.bound_to(&self.authority) {
            return Err(Error::InvalidScope);
        }
        let method =
            crate::renderer_commands::allowed(method).ok_or_else(|| Error::Capability {
                required: format!("renderer:{method}"),
            })?;
        if !args.is_array() {
            return Err(Error::InvalidInput {
                field: "args",
                message: "Expected a JSON array of command arguments",
            });
        }
        if args.to_string().len() > 4 * 1024 * 1024 {
            return Err(Error::InvalidInput {
                field: "args",
                message: "Encoded command arguments exceed 4 MiB",
            });
        }
        client.read(method, args).await
    }
    pub fn sidebar_actions(&self, client: &Client) -> Result<crate::SidebarActions> {
        client.owned_sidebar_for(&self.authority)
    }
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    let (reply, wait) = crate::reply::channel();
    std::thread::Builder::new()
        .name("milagre-installed-owner".into())
        .spawn(move || reply.send(work()))
        .map_err(|_| crate::protocol("could not start the adoption thread"))?;
    wait.await
}

/// The socket path the Node daemon derives from its data directory (`apps/daemon/src/bootstrap.cjs`).
fn socket_path(data_dir: &Path) -> Result<PathBuf> {
    let uid = unsafe { libc::getuid() };
    let directory = PathBuf::from(format!("/tmp/milagre-{uid}"));
    let meta = std::fs::symlink_metadata(&directory).map_err(|_| {
        failure(
            "DAEMON_UNAVAILABLE",
            "Open Milagre first: its daemon is not running",
        )
    })?;
    if !meta.is_dir() || meta.uid() != uid || meta.mode() & 0o777 != 0o700 {
        return Err(failure(
            "UNSAFE_SOCKET",
            "The daemon socket directory must be owned by you with mode 0700",
        ));
    }
    let digest = format!(
        "{:x}",
        Sha256::digest(data_dir.as_os_str().as_encoded_bytes())
    );
    let path = directory.join(format!("{}.sock", &digest[..24]));
    let meta = std::fs::symlink_metadata(&path).map_err(|_| {
        failure(
            "DAEMON_UNAVAILABLE",
            "Open Milagre first: its daemon is not running",
        )
    })?;
    if !meta.file_type().is_socket() || meta.uid() != uid {
        return Err(failure(
            "UNSAFE_SOCKET",
            "The daemon endpoint must be a socket owned by you",
        ));
    }
    Ok(path)
}

fn adopt_blocking(data_dir: &Path) -> Result<InstalledOwner> {
    let data_dir = std::fs::canonicalize(data_dir).map_err(|_| {
        failure(
            "PROFILE_UNAVAILABLE",
            "The Milagre data directory does not exist",
        )
    })?;
    let socket = socket_path(&data_dir)?;
    let mut stream = UnixStream::connect(&socket).map_err(|_| {
        failure(
            "DAEMON_UNAVAILABLE",
            "Open Milagre first: its daemon is not running",
        )
    })?;
    let pid = launcher::peer_pid(&stream)?;
    let status = probe(&mut stream, "daemon:status", json!([]))?;
    if status["protocolVersion"] != 1
        || status["closing"] != false
        || status["pid"].as_u64() != Some(pid as u64)
        || status["dataDir"].as_str().map(Path::new) != Some(data_dir.as_path())
    {
        return Err(failure(
            "INSTALLED_OWNER_MISMATCH",
            "The socket does not belong to a compatible running Milagre daemon for this data directory",
        ));
    }
    Ok(InstalledOwner {
        info: InstalledOwnerInfo {
            pid,
            version: status["version"].as_str().unwrap_or_default().to_owned(),
            data_dir,
            socket,
        },
    })
}

fn open(socket: &Path, pid: u32) -> Result<UnixStream> {
    let stream = UnixStream::connect(socket).map_err(|_| Error::Disconnected)?;
    if launcher::peer_pid(&stream)? != pid {
        return Err(failure(
            "INSTALLED_OWNER_CHANGED",
            "Milagre's daemon restarted; adopt it again",
        ));
    }
    Ok(stream)
}

/// One unpaged request on a private stream, for adoption and Project listing only.
fn probe(stream: &mut UnixStream, method: &str, args: Value) -> Result<Value> {
    stream
        .set_read_timeout(Some(PROBE_TIMEOUT))
        .and_then(|()| stream.set_write_timeout(Some(PROBE_TIMEOUT)))
        .map_err(|_| Error::Disconnected)?;
    let mut frame = serde_json::to_vec(&json!({"v":1,"id":1,"method":method,"args":args}))
        .map_err(|_| crate::protocol("request encoding failed"))?;
    frame.push(b'\n');
    stream.write_all(&frame).map_err(|_| Error::Disconnected)?;
    let mut reader = BufReader::new(
        stream
            .try_clone()
            .map_err(|_| Error::Disconnected)?
            .take(PROBE_LIMIT),
    );
    // Pushed event frames carry no id; skip a bounded number before the reply.
    let response = (0..64)
        .find_map(|_| {
            let mut line = Vec::new();
            match reader.read_until(b'\n', &mut line) {
                Ok(0) => Some(Err(Error::Disconnected)),
                Err(_) => Some(Err(Error::TimedOut { submitted: true })),
                Ok(_) => match serde_json::from_slice::<Value>(&line) {
                    Err(_) => Some(Err(crate::protocol("invalid daemon response"))),
                    Ok(frame) if frame.get("id").is_none() => None,
                    Ok(frame) => Some(Ok(frame)),
                },
            }
        })
        .unwrap_or_else(|| Err(crate::protocol("no daemon response")))?;
    if response["id"] != 1 {
        return Err(crate::protocol("unexpected daemon response id"));
    }
    if let Some(error) = response.get("error").filter(|value| !value.is_null()) {
        return Err(Error::Remote {
            code: error["code"].as_str().unwrap_or("REMOTE_ERROR").to_owned(),
            message: error["message"].as_str().unwrap_or_default().to_owned(),
            payload: error.clone(),
        });
    }
    Ok(response["result"].clone())
}

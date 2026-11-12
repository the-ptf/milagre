//! Signal-free owner of one fixed-sibling app-fixture child.
use crate::{reply, Authority, Error, FixtureGuard, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::{
        fd::AsRawFd,
        unix::{
            fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
            net::UnixStream,
        },
    },
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    thread,
    time::{Duration, Instant},
};

const RECEIPT_LIMIT: usize = 4096;
const RECEIPT_WAIT: Duration = Duration::from_secs(5);
const STOP_WAIT: Duration = Duration::from_secs(3);
const POLL: Duration = Duration::from_millis(10);
mod connect;

fn failure(code: &'static str, message: impl Into<String>) -> Error {
    Error::Launch {
        code,
        message: message.into(),
    }
}
fn invalid() -> Error {
    failure(
        "FIXTURE_IDENTITY_CHANGED",
        "Owned fixture identity is invalid or changed",
    )
}
fn io(_: std::io::Error) -> Error {
    failure("FIXTURE_IO", "Private fixture I/O failed")
}
fn uid() -> u32 {
    unsafe { libc::getuid() }
}
fn absent(path: &Path) -> bool {
    matches!(fs::symlink_metadata(path), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
}

/// Generated paths are diagnostics, never accepted as authority by another API.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FixtureInfo {
    pub pid: u32,
    pub project: PathBuf,
    pub profile: PathBuf,
    pub socket: PathBuf,
    pub launch_root: PathBuf,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cleanup {
    pub pid: u32,
    pub exit_code: Option<i32>,
    pub stop_acknowledged: bool,
    pub profile_removed: bool,
    pub socket_removed: bool,
    pub launch_storage_removed: bool,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ShutdownReport {
    Complete(Cleanup),
    Pending {
        stop_acknowledged: bool,
        reason: Option<String>,
    },
    Unknown {
        reason: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Directory,
    Socket,
    Executable,
    #[cfg(feature = "owned-chat")]
    File,
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct Identity {
    dev: u64,
    ino: u64,
    mode: u32,
    uid: u32,
    kind: Kind,
}
impl Identity {
    fn metadata(metadata: &fs::Metadata, kind: Kind) -> Result<Self> {
        let correct = match kind {
            Kind::Directory => metadata.is_dir(),
            Kind::Socket => metadata.file_type().is_socket(),
            #[cfg(feature = "owned-chat")]
            Kind::File => metadata.is_file() && metadata.nlink() == 1,
            Kind::Executable => {
                metadata.is_file() && metadata.nlink() == 1 && metadata.mode() & 0o111 != 0
            }
        };
        if !correct || metadata.uid() != uid() || metadata.mode() & 0o022 != 0 {
            return Err(invalid());
        }
        Ok(Self {
            dev: metadata.dev(),
            ino: metadata.ino(),
            mode: metadata.mode() & 0o7777,
            uid: metadata.uid(),
            kind,
        })
    }
    fn read(path: &Path, kind: Kind) -> Result<Self> {
        Self::metadata(&fs::symlink_metadata(path).map_err(io)?, kind)
    }
    fn receipt(&self, value: &Value) -> bool {
        keys(value, &["dev", "ino", "mode", "uid", "kind"])
            && value["dev"].as_str() == Some(self.dev.to_string().as_str())
            && value["ino"].as_str() == Some(self.ino.to_string().as_str())
            && value["mode"].as_u64() == Some(self.mode.into())
            && value["uid"].as_u64() == Some(self.uid.into())
            && value["kind"]
                == if self.kind == Kind::Socket {
                    "socket"
                } else {
                    "directory"
                }
    }
}
struct Pin {
    path: PathBuf,
    real: PathBuf,
    identity: Identity,
    held: Option<File>,
}
impl Pin {
    fn capture(path: &Path, kind: Kind) -> Result<Self> {
        let identity = Identity::read(path, kind)?;
        let real = fs::canonicalize(path).map_err(io)?;
        let held = if kind == Kind::Socket {
            None
        } else {
            Some(
                OpenOptions::new()
                    .read(true)
                    .custom_flags(
                        libc::O_NOFOLLOW
                            | libc::O_NONBLOCK
                            | if kind == Kind::Directory {
                                libc::O_DIRECTORY
                            } else {
                                0
                            },
                    )
                    .open(&real)
                    .map_err(io)?,
            )
        };
        let pin = Self {
            path: path.to_owned(),
            real,
            identity,
            held,
        };
        pin.check()?;
        Ok(pin)
    }
    fn check(&self) -> Result<()> {
        if Identity::read(&self.path, self.identity.kind)? != self.identity
            || fs::canonicalize(&self.path).map_err(io)? != self.real
        {
            return Err(invalid());
        }
        if let Some(file) = &self.held {
            if Identity::metadata(&file.metadata().map_err(io)?, self.identity.kind)?
                != self.identity
            {
                return Err(invalid());
            }
        }
        Ok(())
    }
}
struct Executable {
    file: Pin,
    parent: Pin,
}
impl Executable {
    fn fixed() -> Result<Self> {
        let current = fs::canonicalize(std::env::current_exe().map_err(io)?).map_err(io)?;
        Self::sibling(current.parent().ok_or_else(invalid)?)
    }
    fn sibling(parent: &Path) -> Result<Self> {
        Self::sibling_named(parent, "app-fixture")
    }
    fn sibling_named(parent: &Path, name: &str) -> Result<Self> {
        let parent = Pin::capture(parent, Kind::Directory)?;
        let file = Pin::capture(&parent.real.join(name), Kind::Executable)?;
        Ok(Self { file, parent })
    }
    fn check(&self) -> Result<()> {
        self.parent.check()?;
        self.file.check()
    }
}

struct Storage {
    root: Pin,
}
impl Storage {
    fn create() -> Result<Self> {
        let temp = tempfile::Builder::new()
            .prefix("milagre-client-launch-")
            .tempdir_in(fs::canonicalize("/tmp").map_err(io)?)
            .map_err(io)?;
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700)).map_err(io)?;
        for name in ["home", "config", "cache", "tmp"] {
            fs::create_dir(temp.path().join(name)).map_err(io)?;
            fs::set_permissions(temp.path().join(name), fs::Permissions::from_mode(0o700))
                .map_err(io)?;
        }
        let root = Pin::capture(temp.path(), Kind::Directory)?;
        let _retained = temp.keep(); // No destructor can delete a replacement directory or unproven live child's HOME.
        Ok(Self { root })
    }
    fn remove(&self) -> bool {
        if absent(&self.root.path) {
            return true;
        }
        self.root.check().is_ok() && fs::remove_dir_all(&self.root.path).is_ok()
    }
}

struct Endpoint {
    profile: PathBuf,
    project: PathBuf,
    socket: PathBuf,
    pins: Vec<Pin>,
    pid: u32,
    #[cfg(feature = "owned-chat")]
    owned: Option<Arc<owned_chat_launch::Selection>>,
}
impl Endpoint {
    fn receipt(value: &Value, pid: u32) -> Result<Self> {
        let actor_keys = [
            "project",
            "scriptedProvider",
            "provider",
            "tickMs",
            "debounceMs",
            "idleMs",
            "interruptGraceMs",
            "appFixture",
            "handoff",
            "steering",
            "transcriptPreset",
        ];
        let actor_key_count = if value["actor"].get("transcriptPreset").is_some() {
            if value["actor"]["transcriptPreset"] != "three-turns" {
                return Err(invalid());
            }
            11
        } else {
            10
        };
        if !keys(
            value,
            &[
                "profile",
                "socket",
                "fixture",
                "scriptedOwner",
                "bootstrapVersion",
                "protocolVersion",
                "pid",
                "uid",
                "appFixture",
                "ownedCopies",
                "actor",
                "identities",
            ],
        ) || value["bootstrapVersion"] != 1
            || value["protocolVersion"] != 1
            || value["pid"].as_u64() != Some(pid.into())
            || value["uid"].as_u64() != Some(uid().into())
            || ["fixture", "scriptedOwner", "appFixture", "ownedCopies"]
                .iter()
                .any(|key| value[*key] != true)
            || !keys(&value["actor"], &actor_keys[..actor_key_count])
            || value["actor"]["appFixture"] != true
            || value["actor"]["scriptedProvider"] != true
            || value["actor"]["provider"] != "kiro"
            || value["actor"]["handoff"] != "gated"
            || value["actor"]["steering"] != "gated"
            || !keys(
                &value["identities"],
                &["profile", "project", "socketDirectory", "socket"],
            )
        {
            return Err(invalid());
        }
        let path = |value: &Value| {
            value
                .as_str()
                .filter(|s| s.len() < 1024)
                .map(PathBuf::from)
                .ok_or_else(invalid)
        };
        let profile = path(&value["profile"])?;
        let project = path(&value["actor"]["project"])?;
        let socket = path(&value["socket"])?;
        let tmp = fs::canonicalize("/tmp").map_err(io)?;
        if profile.parent() != Some(tmp.as_path())
            || !profile
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with("milagre-rust-wire-"))
            || fs::canonicalize(&profile).map_err(io)? != profile
            || project != profile.join("fixture")
            || fs::canonicalize(&project).map_err(io)? != project
        {
            return Err(invalid());
        }
        let directory = PathBuf::from(format!("/tmp/milagre-{}", uid()));
        let hash = format!(
            "{:x}",
            Sha256::digest(profile.as_os_str().as_encoded_bytes())
        );
        if socket != directory.join(format!("{}.sock", &hash[..24])) {
            return Err(invalid());
        }
        let mut pins = Vec::new();
        for (name, path, kind) in [
            ("profile", &profile, Kind::Directory),
            ("project", &project, Kind::Directory),
            ("socketDirectory", &directory, Kind::Directory),
            ("socket", &socket, Kind::Socket),
        ] {
            let pin = Pin::capture(path, kind)?;
            if !pin.identity.receipt(&value["identities"][name])
                || (name != "project"
                    && pin.identity.mode != if kind == Kind::Socket { 0o600 } else { 0o700 })
            {
                return Err(invalid());
            }
            pins.push(pin);
        }
        Ok(Self {
            profile,
            project,
            socket,
            pins,
            pid,
            #[cfg(feature = "owned-chat")]
            owned: None,
        })
    }
    fn connect(&self, until: Instant) -> Result<UnixStream> {
        #[cfg(feature = "owned-chat")]
        if let Some(owned) = &self.owned {
            owned.check()?;
        }
        for pin in &self.pins {
            pin.check()?;
        }
        let stream = connect::until(&self.socket, until)?;
        peer(&stream, self.pid)?;
        #[cfg(feature = "owned-chat")]
        if let Some(owned) = &self.owned {
            owned.check()?;
        }
        for pin in &self.pins {
            pin.check()?;
        }
        Ok(stream)
    }
}
fn keys(value: &Value, expected: &[&str]) -> bool {
    value.as_object().is_some_and(|object| {
        object.len() == expected.len() && expected.iter().all(|key| object.contains_key(*key))
    })
}
fn peer(stream: &UnixStream, pid: u32) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        let (mut user, mut group) = (0, 0);
        if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut user, &mut group) } != 0
            || user != uid()
        {
            return Err(invalid());
        }
        let mut actual: libc::pid_t = 0;
        let mut size = std::mem::size_of_val(&actual) as libc::socklen_t;
        if unsafe {
            libc::getsockopt(
                stream.as_raw_fd(),
                0,
                libc::LOCAL_PEERPID,
                (&mut actual as *mut libc::pid_t).cast(),
                &mut size,
            )
        } != 0
            || size as usize != std::mem::size_of_val(&actual)
            || actual as u32 != pid
        {
            return Err(invalid());
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (stream, pid);
        Err(failure(
            "FIXTURE_PLATFORM_UNSUPPORTED",
            "Exact fixture peer PID verification is enabled only on macOS",
        ))
    }
}
fn read_line(reader: &mut impl Read, fd: libc::c_int, until: Instant) -> Result<Value> {
    let mut bytes = Vec::new();
    loop {
        let remaining = until.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(failure(
                "FIXTURE_RECEIPT_TIMEOUT",
                "Owned child reply timed out",
            ));
        }
        let mut p = libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        };
        let count = unsafe { libc::poll(&mut p, 1, remaining.as_millis().clamp(1, 100) as i32) };
        if count < 0 {
            if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(io(std::io::Error::last_os_error()));
        }
        if count == 0 {
            continue;
        }
        let mut byte = [0];
        match reader.read(&mut byte) {
            Ok(1) => {}
            Ok(_) => {
                return Err(failure(
                    "FIXTURE_RECEIPT_EOF",
                    "Owned child reply pipe closed",
                ))
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(io(error)),
        }
        bytes.push(byte[0]);
        if bytes.len() > RECEIPT_LIMIT {
            return Err(failure(
                "FIXTURE_RECEIPT_TOO_LARGE",
                "Owned child reply exceeds 4096 bytes",
            ));
        }
        if byte[0] == b'\n' {
            return serde_json::from_slice(&bytes).map_err(|_| invalid());
        }
    }
}

trait Process {
    fn id(&self) -> u32;
    fn probe(&mut self) -> std::io::Result<Option<ExitStatus>>;
    fn close_input(&mut self);
}
struct OwnedChild {
    child: Child,
    stdin: Option<ChildStdin>,
}
impl Process for OwnedChild {
    fn id(&self) -> u32 {
        self.child.id()
    }
    fn probe(&mut self) -> std::io::Result<Option<ExitStatus>> {
        self.child.try_wait()
    }
    fn close_input(&mut self) {
        self.stdin.take();
    }
}
#[derive(Clone)]
enum Wait {
    Running,
    Exited(ExitStatus),
    Unknown,
}
struct State<P: Process> {
    process: P,
    wait: Wait,
    stop_ack: bool,
    closing: bool,
    storage: Storage,
    endpoint: Option<Endpoint>,
    cleanup: Option<Cleanup>,
}
impl<P: Process> State<P> {
    fn probe(&mut self) -> Wait {
        if matches!(self.wait, Wait::Running) {
            loop {
                match self.process.probe() {
                    Ok(Some(status)) => {
                        self.wait = Wait::Exited(status);
                        break;
                    }
                    Ok(None) => break,
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => {
                        self.wait = Wait::Unknown;
                        break;
                    }
                }
            }
        }
        self.wait.clone()
    }
    fn completed(&mut self, status: ExitStatus) -> ShutdownReport {
        if self.cleanup.is_none() {
            self.process.close_input();
            self.cleanup = Some(Cleanup {
                pid: self.process.id(),
                exit_code: status.code(),
                stop_acknowledged: self.stop_ack,
                profile_removed: self.endpoint.as_ref().is_some_and(|e| absent(&e.profile)),
                socket_removed: self.endpoint.as_ref().is_some_and(|e| absent(&e.socket)),
                launch_storage_removed: self.storage.remove(),
            });
        }
        ShutdownReport::Complete(self.cleanup.clone().expect("completion stored"))
    }
    fn connect(&mut self, until: Instant) -> Result<UnixStream> {
        if self.closing || self.stop_ack || !matches!(self.probe(), Wait::Running) {
            return Err(Error::Disconnected);
        }
        self.endpoint.as_ref().ok_or_else(invalid)?.connect(until)
    }
    fn shutdown(&mut self, until: Instant) -> ShutdownReport {
        self.closing = true;
        match self.probe() {
            Wait::Exited(status) => return self.completed(status),
            Wait::Unknown => return unknown(),
            Wait::Running => {}
        }
        if !self.stop_ack && Instant::now() < until {
            let result = (|| {
                let mut socket = self.endpoint.as_ref().ok_or_else(invalid)?.connect(until)?;
                socket
                    .set_write_timeout(Some(
                        until
                            .saturating_duration_since(Instant::now())
                            .max(Duration::from_millis(1)),
                    ))
                    .map_err(io)?;
                writeln!(
                    socket,
                    "{}",
                    json!({"v":1,"id":"client-fixture-stop","method":"daemon:stop","args":[]})
                )
                .map_err(io)?;
                loop {
                    let fd = socket.as_raw_fd();
                    let frame = read_line(&mut socket, fd, until)?;
                    if frame["id"] != "client-fixture-stop" {
                        continue;
                    }
                    if frame["v"] != 1 {
                        return Err(invalid());
                    }
                    if let Some(error) = frame.get("error").filter(|value| !value.is_null()) {
                        return Err(Error::Remote {
                            code: error["code"].as_str().unwrap_or("INVALID_RESPONSE").into(),
                            message: error["message"]
                                .as_str()
                                .unwrap_or("Stop was refused")
                                .into(),
                            payload: error.clone(),
                        });
                    }
                    if frame["result"]["stopping"] != true {
                        return Err(invalid());
                    }
                    return Ok(());
                }
            })();
            match result {
                Ok(()) => self.stop_ack = true,
                Err(error) => {
                    return ShutdownReport::Pending {
                        stop_acknowledged: false,
                        reason: Some(error.to_string()),
                    }
                }
            }
        }
        loop {
            match self.probe() {
                Wait::Exited(status) => return self.completed(status),
                Wait::Unknown => return unknown(),
                Wait::Running => {}
            }
            if Instant::now() >= until {
                return ShutdownReport::Pending {
                    stop_acknowledged: self.stop_ack,
                    reason: None,
                };
            }
            thread::sleep(POLL.min(until.saturating_duration_since(Instant::now())));
        }
    }
}
fn unknown() -> ShutdownReport {
    ShutdownReport::Unknown {
        reason: "Child reap ownership is unknown; no further PID operation or cleanup is allowed"
            .into(),
    }
}

enum Control {
    Connect {
        until: Instant,
        reply: mpsc::SyncSender<Result<UnixStream>>,
    },
    Shutdown {
        until: Instant,
        reply: reply::Sender<ShutdownReport>,
    },
}
pub(crate) struct Handle {
    sender: mpsc::SyncSender<Control>,
    closing: AtomicBool,
    pub(crate) info: FixtureInfo,
}
impl Handle {
    fn connect(&self) -> Result<UnixStream> {
        if self.closing.load(Ordering::Acquire) {
            return Err(Error::Disconnected);
        }
        let (send, receive) = mpsc::sync_channel(1);
        self.sender
            .try_send(Control::Connect {
                until: Instant::now() + STOP_WAIT,
                reply: send,
            })
            .map_err(|error| match error {
                mpsc::TrySendError::Full(_) => Error::Busy,
                mpsc::TrySendError::Disconnected(_) => Error::Disconnected,
            })?;
        receive
            .recv_timeout(STOP_WAIT)
            .map_err(|_| Error::Disconnected)?
    }
    pub(crate) async fn shutdown(&self) -> Result<ShutdownReport> {
        self.closing.store(true, Ordering::Release);
        let (reply, wait) = reply::channel();
        self.sender
            .try_send(Control::Shutdown {
                until: Instant::now() + STOP_WAIT,
                reply,
            })
            .map_err(|error| match error {
                mpsc::TrySendError::Full(_) => Error::Busy,
                mpsc::TrySendError::Disconnected(_) => Error::Disconnected,
            })?;
        wait.await
    }
}
pub(crate) async fn launch(populated: bool) -> Result<FixtureGuard> {
    let (ready, wait) = reply::channel();
    thread::Builder::new()
        .name("milagre-fixture-owner".into())
        .spawn(move || {
            launch_worker(
                ready,
                populated,
                #[cfg(test)]
                None,
            )
        })
        .map_err(io)?;
    wait.await
}
#[cfg(test)]
struct AdmissionPause {
    admitted: mpsc::SyncSender<FixtureInfo>,
    release: mpsc::Receiver<()>,
}
fn preset_matches(receipt: &Value, populated: bool) -> bool {
    match receipt["actor"].get("transcriptPreset") {
        None => !populated,
        Some(value) => populated && value == "three-turns",
    }
}
fn launch_worker(
    ready: reply::Sender<FixtureGuard>,
    populated: bool,
    #[cfg(test)] pause: Option<AdmissionPause>,
) {
    let start = (|| {
        let executable = Executable::fixed()?;
        executable.check()?;
        let storage = Storage::create()?;
        let root = &storage.root.path;
        let mut command = Command::new(&executable.file.real);
        if populated {
            command.arg("--populated-transcript");
        }
        let child = command
            .env_clear()
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .env("HOME", root.join("home"))
            .env("XDG_CONFIG_HOME", root.join("config"))
            .env("XDG_CACHE_HOME", root.join("cache"))
            .env("TMPDIR", root.join("tmp"))
            .env("LANG", "en_US.UTF-8")
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn();
        let mut child = match child {
            Ok(child) => child,
            Err(error) => {
                storage.remove();
                return Err(io(error));
            }
        };
        let stdin = child.stdin.take();
        let state = State {
            process: OwnedChild { child, stdin },
            wait: Wait::Running,
            stop_ack: false,
            closing: false,
            storage,
            endpoint: None,
            cleanup: None,
        };
        Ok((state, executable))
    })();
    let (mut state, executable) = match start {
        Ok(value) => value,
        Err(error) => {
            ready.send(Err(error));
            return;
        }
    };
    let admission = (|| {
        if state.process.stdin.is_none() {
            return Err(invalid());
        }
        executable.check()?;
        let mut stdout = state.process.child.stdout.take().ok_or_else(invalid)?;
        let fd = stdout.as_raw_fd();
        let receipt = read_line(&mut stdout, fd, Instant::now() + RECEIPT_WAIT)?;
        if !preset_matches(&receipt, populated) {
            return Err(invalid());
        }
        let endpoint = Endpoint::receipt(&receipt, state.process.id())?;
        if !matches!(state.probe(), Wait::Running) {
            return Err(invalid());
        }
        endpoint.connect(Instant::now() + STOP_WAIT)?;
        executable.check()?;
        Ok(endpoint)
    })();
    let endpoint = match admission {
        Ok(endpoint) => endpoint,
        Err(error) => {
            ready.send(Err(error));
            abandon(state);
            return;
        }
    };
    let info = FixtureInfo {
        pid: state.process.id(),
        project: endpoint.project.clone(),
        profile: endpoint.profile.clone(),
        socket: endpoint.socket.clone(),
        launch_root: state.storage.root.path.clone(),
    };
    state.endpoint = Some(endpoint);
    #[cfg(test)]
    if let Some(pause) = pause {
        let _ = pause.admitted.send(info.clone());
        let _ = pause.release.recv();
    }
    let (sender, receiver) = mpsc::sync_channel(32);
    let handle = Arc::new(Handle {
        sender,
        closing: AtomicBool::new(false),
        info,
    });
    let connector = handle.clone();
    let authority = Arc::new(Authority {
        project: handle.info.project.to_string_lossy().into_owned(),
        pid: handle.info.pid,
        connect: Box::new(move || connector.connect()),
        launcher: Some(handle),
    });
    ready.send(Ok(FixtureGuard { authority }));
    loop {
        match receiver.recv_timeout(POLL) {
            Ok(Control::Connect { until, reply }) => {
                let _ = reply.send(state.connect(until));
            }
            Ok(Control::Shutdown { until, reply }) => reply.send(Ok(state.shutdown(until))),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Wait::Exited(status) = state.probe() {
                    state.completed(status);
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                abandon(state);
                return;
            }
        }
    }
}
fn abandon<P: Process>(mut state: State<P>) {
    // Dropping the last authority is a request, not evidence of clean completion.
    // Once Stop was acknowledged, preserve stdin while the owner finishes.
    if matches!(state.probe(), Wait::Running) && !state.stop_ack {
        state.process.close_input();
    }
    loop {
        match state.probe() {
            Wait::Exited(status) => {
                state.completed(status);
                return;
            }
            Wait::Unknown => {
                std::mem::forget(state);
                return;
            }
            Wait::Running => thread::sleep(POLL),
        }
    }
}

#[cfg(feature = "owned-chat")]
#[path = "owned_chat_launch.rs"]
pub(crate) mod owned_chat_launch;

#[cfg(test)]
mod tests;

//! Dedicated-runtime admission over the same retained child supervisor as fixtures.
use super::*;
use crate::owned_chat::{OwnedChatGuard, OwnedChatInfo};

const MANIFEST: &str = "rust-chat-runtime.json";
const MANIFEST_LIMIT: u64 = 32 * 1024;

pub(crate) struct Selection {
    root: Pin,
    manifest: Pin,
    bytes: Vec<u8>,
    pub(crate) model: String,
    pub(crate) account_id: String,
}
impl Selection {
    fn capture(root: &Path, fixture: bool) -> Result<Self> {
        let root = Pin::capture(root, Kind::Directory)?;
        if root.path != root.real || root.identity.mode != 0o700 {
            return Err(invalid());
        }
        let manifest = Pin::capture(&root.real.join(MANIFEST), Kind::File)?;
        let bytes = private_bytes(&manifest)?;
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        if !keys(&value, &["schema", "kind", "root", "fixture", "launch"])
            || value["schema"] != 1
            || value["kind"] != "milagre-rust-chat"
            || value["root"].as_str() != root.real.to_str()
            || value["fixture"] != fixture
        {
            return Err(invalid());
        }
        let text = |key: &str| {
            value["launch"][key]
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 256 && !s.contains('\0'))
                .map(str::to_owned)
                .ok_or_else(invalid)
        };
        let selection = Self {
            model: text("model")?,
            account_id: text("accountId")?,
            root,
            manifest,
            bytes,
        };
        selection.check()?;
        Ok(selection)
    }
    pub(crate) fn check(&self) -> Result<()> {
        self.root.check()?;
        self.manifest.check()?;
        if private_bytes(&self.manifest)? != self.bytes {
            return Err(invalid());
        }
        Ok(())
    }
}

fn private_bytes(pin: &Pin) -> Result<Vec<u8>> {
    pin.check()?;
    if pin.identity.mode != 0o600 {
        return Err(invalid());
    }
    let file = pin.held.as_ref().ok_or_else(invalid)?;
    if file.metadata().map_err(io)?.len() > MANIFEST_LIMIT {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    // Independent descriptor avoids a shared seek position between concurrent connections.
    let mut reader = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(&pin.real)
        .map_err(io)?;
    if Identity::metadata(&reader.metadata().map_err(io)?, Kind::File)? != pin.identity {
        return Err(invalid());
    }
    (&mut reader)
        .take(MANIFEST_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(io)?;
    if bytes.len() as u64 > MANIFEST_LIMIT {
        return Err(invalid());
    }
    pin.check()?;
    Ok(bytes)
}

struct Request {
    root: PathBuf,
    parent: Pin,
    initial: Option<Arc<Selection>>,
    launch: Option<(Pin, Vec<u8>)>,
    fixture: bool,
    create: bool,
}
impl Request {
    fn prepare(root: &Path, manifest: Option<&Path>, fixture: bool) -> Result<Self> {
        let protected = protected();
        let root = location(root, &protected)?;
        let parent = Pin::capture(root.parent().ok_or_else(invalid)?, Kind::Directory)?;
        let create = manifest.is_some();
        if create && !absent(&root) {
            return Err(failure(
                "CHAT_ROOT_EXISTS",
                "Create requires a nonexistent dedicated root",
            ));
        }
        let initial = if create {
            None
        } else {
            Some(Arc::new(Selection::capture(&root, fixture)?))
        };
        let launch = if let Some(path) = manifest {
            if fixture {
                None
            } else {
                if !path.is_absolute() {
                    return Err(invalid());
                }
                let pin = Pin::capture(path, Kind::File)?;
                let bytes = private_bytes(&pin)?;
                let _: Value = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
                Some((pin, bytes))
            }
        } else {
            None
        };
        Ok(Self {
            root,
            parent,
            initial,
            launch,
            fixture,
            create,
        })
    }
    fn check(&self) -> Result<()> {
        self.parent.check()?;
        if let Some(selection) = &self.initial {
            selection.check()?;
        }
        if let Some((pin, bytes)) = &self.launch {
            if private_bytes(pin)? != *bytes {
                return Err(invalid());
            }
        }
        if self.create && !absent(&self.root) {
            return Err(failure(
                "CHAT_ROOT_EXISTS",
                "Create requires a nonexistent dedicated root",
            ));
        }
        Ok(())
    }
    fn command(&self, command: &mut Command) {
        let mode = match (self.fixture, self.create) {
            (false, true) => "create",
            (false, false) => "open",
            (true, true) => "fixture-create",
            (true, false) => "fixture-open",
        };
        command.arg(mode).arg(&self.root);
        if let Some((pin, _)) = &self.launch {
            command.arg(&pin.real);
        }
    }
}

fn protected() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        paths.extend([
            home.join(".milagre"),
            home.join("Library/Application Support/Milagre"),
            home.join(".config/Milagre"),
        ]);
    }
    if let Some(custom) = std::env::var_os("MILAGRE_DATA_DIR") {
        paths.push(PathBuf::from(custom));
    }
    paths
}
fn location(root: &Path, protected: &[PathBuf]) -> Result<PathBuf> {
    if !root.is_absolute()
        || root.components().any(|p| {
            matches!(
                p,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
    {
        return Err(invalid());
    }
    let parent = fs::canonicalize(root.parent().ok_or_else(invalid)?).map_err(io)?;
    let root = parent.join(root.file_name().ok_or_else(invalid)?);
    for path in protected {
        let path = fs::canonicalize(path).unwrap_or_else(|_| path.clone());
        if root.starts_with(&path) || path.starts_with(&root) {
            return Err(failure(
                "CHAT_PROFILE_REFUSED",
                "Dedicated data must not overlap a Milagre profile",
            ));
        }
    }
    Ok(root)
}

fn endpoint(
    value: &Value,
    pid: u32,
    request: &Request,
    executable: &Executable,
) -> Result<(Endpoint, Arc<Selection>)> {
    if !keys(
        value,
        &[
            "profile",
            "socket",
            "pid",
            "protocolVersion",
            "restartable",
            "fixture",
            "fakeClaude",
            "dataRoot",
            "actor",
        ],
    ) || value["pid"].as_u64() != Some(pid.into())
        || value["protocolVersion"] != 1
        || value["restartable"] != true
        || value["fixture"] != request.fixture
        || value["fakeClaude"] != request.fixture
        || value["dataRoot"].as_str() != request.root.to_str()
        || value["actor"]["project"].as_str() != request.root.join("project").to_str()
        || value["actor"]["provider"] != "claude"
        || value["actor"]["scriptedProvider"] != false
        || value["actor"]["configuredProvider"] != true
        || value["actor"]["restartable"] != true
    {
        return Err(invalid());
    }
    request.parent.check()?;
    let selection = Arc::new(Selection::capture(&request.root, request.fixture)?);
    if let Some(initial) = &request.initial {
        initial.check()?;
        if initial.bytes != selection.bytes {
            return Err(invalid());
        }
    }
    if let Some((pin, bytes)) = &request.launch {
        if private_bytes(pin)? != *bytes {
            return Err(invalid());
        }
        let input: Value = serde_json::from_slice(bytes).map_err(|_| invalid())?;
        let stored: Value = serde_json::from_slice(&selection.bytes).map_err(|_| invalid())?;
        if input != stored["launch"] {
            return Err(invalid());
        }
    }
    if value["actor"]["model"] != selection.model
        || value["actor"]["accountId"] != selection.account_id
    {
        return Err(invalid());
    }
    let path = |key: &str| {
        value[key]
            .as_str()
            .filter(|s| s.len() < 1024)
            .map(PathBuf::from)
            .ok_or_else(invalid)
    };
    let profile = path("profile")?;
    let socket = path("socket")?;
    let tmp = fs::canonicalize("/tmp").map_err(io)?;
    if profile.parent() != Some(tmp.as_path())
        || !profile
            .file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with("milagre-rust-wire-"))
        || fs::canonicalize(&profile).map_err(io)? != profile
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
    let project = request.root.join("project");
    let mut pins = Vec::new();
    for (path, kind, mode) in [
        (&profile, Kind::Directory, Some(0o700)),
        (&project, Kind::Directory, None),
        (&directory, Kind::Directory, Some(0o700)),
        (&socket, Kind::Socket, Some(0o600)),
    ] {
        let pin = Pin::capture(path, kind)?;
        if mode.is_some_and(|mode| mode != pin.identity.mode) {
            return Err(invalid());
        }
        pins.push(pin);
    }
    pins.push(Pin::capture(&executable.file.real, Kind::Executable)?);
    pins.push(Pin::capture(&executable.parent.real, Kind::Directory)?);
    Ok((
        Endpoint {
            profile,
            project,
            socket,
            pins,
            pid,
            owned: Some(selection.clone()),
        },
        selection,
    ))
}

pub(crate) async fn launch(root: &Path, manifest: Option<&Path>) -> Result<OwnedChatGuard> {
    let root = root.to_owned();
    let manifest = manifest.map(Path::to_owned);
    let (ready, wait) = reply::channel();
    thread::Builder::new()
        .name("milagre-chat-owner".into())
        .spawn(
            move || match Request::prepare(&root, manifest.as_deref(), false) {
                Ok(request) => worker(ready, request),
                Err(error) => ready.send(Err(error)),
            },
        )
        .map_err(io)?;
    wait.await
}
#[cfg(test)]
async fn launch_request(request: Request) -> Result<OwnedChatGuard> {
    let (ready, wait) = reply::channel();
    thread::Builder::new()
        .name("milagre-chat-owner".into())
        .spawn(move || worker(ready, request))
        .map_err(io)?;
    wait.await
}
fn worker(ready: reply::Sender<OwnedChatGuard>, request: Request) {
    let start = (|| {
        request.check()?;
        let current = fs::canonicalize(std::env::current_exe().map_err(io)?).map_err(io)?;
        let executable =
            Executable::sibling_named(current.parent().ok_or_else(invalid)?, "chat-runtime")?;
        executable.check()?;
        let storage = Storage::create()?;
        let root = &storage.root.path;
        let mut command = Command::new(&executable.file.real);
        request.command(&mut command);
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
        Ok((
            State {
                process: OwnedChild { child, stdin },
                wait: Wait::Running,
                stop_ack: false,
                closing: false,
                storage,
                endpoint: None,
                cleanup: None,
            },
            executable,
        ))
    })();
    let (mut state, executable) = match start {
        Ok(value) => value,
        Err(error) => {
            ready.send(Err(error));
            return;
        }
    };
    let admission = (|| {
        let mut stdout = state.process.child.stdout.take().ok_or_else(invalid)?;
        let fd = stdout.as_raw_fd();
        let receipt = read_line(&mut stdout, fd, Instant::now() + RECEIPT_WAIT)?;
        let (endpoint, selection) = endpoint(&receipt, state.process.id(), &request, &executable)?;
        if !matches!(state.probe(), Wait::Running) {
            return Err(invalid());
        }
        endpoint.connect(Instant::now() + STOP_WAIT)?;
        executable.check()?;
        Ok((endpoint, selection))
    })();
    let (endpoint, selection) = match admission {
        Ok(value) => value,
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
    let owned_info = OwnedChatInfo {
        pid: info.pid,
        project: info.project.clone(),
        data_root: request.root.clone(),
        profile: info.profile.clone(),
        socket: info.socket.clone(),
        launch_root: info.launch_root.clone(),
        model: selection.model.clone(),
        account_id: selection.account_id.clone(),
    };
    state.endpoint = Some(endpoint);
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
    ready.send(Ok(OwnedChatGuard {
        authority,
        info: owned_info,
        selection,
    }));
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

#[cfg(test)]
#[path = "owned_chat_launch/tests.rs"]
mod tests;

//! Fixed direct-child fixture authority. No supplied path, environment or endpoint constructor.
use serde_json::{json, Map, Value};
use std::{
    fs::{self, File},
    io::{Read, Write},
    os::{
        fd::AsRawFd,
        unix::{
            fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
            net::UnixStream,
        },
    },
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

pub type Result<T> = std::result::Result<T, Value>;
fn fail(code: &str, message: &str) -> Value {
    json!({"code":code,"message":message})
}
fn io(_: std::io::Error) -> Value {
    fail("FIXTURE_IO", "Private fixture I/O failed")
}
fn invalid() -> Value {
    fail(
        "FIXTURE_ENDPOINT_INVALID",
        "Owned child endpoint identity is invalid or changed",
    )
}

#[derive(Clone, Debug, PartialEq)]
struct Identity {
    dev: u64,
    ino: u64,
    mode: u32,
    uid: u32,
    socket: bool,
}
impl Identity {
    fn read(path: &Path, socket: bool) -> Result<Self> {
        let m = fs::symlink_metadata(path).map_err(io)?;
        if m.uid() != unsafe { libc::getuid() }
            || if socket {
                !m.file_type().is_socket()
            } else {
                !m.is_dir()
            }
        {
            return Err(invalid());
        }
        Ok(Self {
            dev: m.dev(),
            ino: m.ino(),
            mode: m.mode() & 0o7777,
            uid: m.uid(),
            socket,
        })
    }
    fn matches(&self, v: &Value) -> bool {
        v["dev"].as_str() == Some(self.dev.to_string().as_str())
            && v["ino"].as_str() == Some(self.ino.to_string().as_str())
            && v["mode"].as_u64() == Some(self.mode.into())
            && v["uid"].as_u64() == Some(self.uid.into())
            && v["kind"] == if self.socket { "socket" } else { "directory" }
    }
}
struct Endpoint {
    socket: PathBuf,
    project: PathBuf,
    pins: Vec<(PathBuf, Identity)>,
    pid: u32,
}
impl Endpoint {
    fn receipt(value: &Value, pid: u32) -> Result<Self> {
        if value["bootstrapVersion"] != 1
            || value["protocolVersion"] != 1
            || value["pid"].as_u64() != Some(pid.into())
            || value["uid"].as_u64() != Some(unsafe { libc::getuid() }.into())
            || ["fixture", "appFixture", "scriptedOwner", "ownedCopies"]
                .iter()
                .any(|k| value[*k] != true)
            || value["actor"]["appFixture"] != true
            || value["actor"]["scriptedProvider"] != true
            || value["actor"]["provider"] != "kiro"
            || value["actor"]["handoff"] != "gated"
            || value["actor"]["steering"] != "gated"
        {
            return Err(invalid());
        }
        let path = |v: &Value| {
            v.as_str()
                .filter(|s| s.len() < 1024)
                .map(PathBuf::from)
                .ok_or_else(invalid)
        };
        let profile = path(&value["profile"])?;
        let project = path(&value["actor"]["project"])?;
        let socket = path(&value["socket"])?;
        let tmp = fs::canonicalize("/tmp").map_err(io)?;
        if !profile.is_absolute()
            || profile.parent() != Some(tmp.as_path())
            || !profile
                .file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with("milagre-rust-wire-"))
            || fs::canonicalize(&profile).map_err(io)? != profile
            || project != profile.join("fixture")
            || fs::canonicalize(&project).map_err(io)? != project
        {
            return Err(invalid());
        }
        use sha2::{Digest, Sha256};
        let directory = PathBuf::from(format!("/tmp/milagre-{}", unsafe { libc::getuid() }));
        let hash = format!(
            "{:x}",
            Sha256::digest(profile.as_os_str().as_encoded_bytes())
        );
        if socket != directory.join(format!("{}.sock", &hash[..24])) {
            return Err(invalid());
        }
        let mut pins = vec![];
        for (name, path, is_socket) in [
            ("profile", profile, false),
            ("project", project.clone(), false),
            ("socketDirectory", directory, false),
            ("socket", socket.clone(), true),
        ] {
            let identity = Identity::read(&path, is_socket)?;
            if !identity.matches(&value["identities"][name])
                || (name != "project" && identity.mode != if is_socket { 0o600 } else { 0o700 })
            {
                return Err(invalid());
            }
            pins.push((path, identity));
        }
        Ok(Self {
            socket,
            project,
            pins,
            pid,
        })
    }
    fn check(&self) -> Result<()> {
        for (path, id) in &self.pins {
            if Identity::read(path, id.socket)? != *id {
                return Err(invalid());
            }
        }
        Ok(())
    }
    fn connect(&self) -> Result<UnixStream> {
        self.check()?;
        let stream = UnixStream::connect(&self.socket).map_err(io)?;
        verify_peer(&stream, self.pid)?;
        self.check()?;
        Ok(stream)
    }
}
fn verify_peer(socket: &UnixStream, pid: u32) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        let (mut uid, mut gid) = (0, 0);
        if unsafe { libc::getpeereid(socket.as_raw_fd(), &mut uid, &mut gid) } != 0
            || uid != unsafe { libc::getuid() }
        {
            return Err(invalid());
        }
        let mut peer: libc::pid_t = 0;
        let mut len = std::mem::size_of_val(&peer) as libc::socklen_t;
        if unsafe {
            libc::getsockopt(
                socket.as_raw_fd(),
                0,
                libc::LOCAL_PEERPID,
                (&mut peer as *mut libc::pid_t).cast(),
                &mut len,
            )
        } != 0
            || peer as u32 != pid
        {
            return Err(invalid());
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (socket, pid);
        Err(fail(
            "FIXTURE_PLATFORM_UNSUPPORTED",
            "Fixture peer PID check is implemented only on macOS",
        ))
    }
}
fn read_line(reader: &mut impl Read, fd: libc::c_int, timeout: Duration) -> Result<Value> {
    let until = Instant::now() + timeout;
    let mut bytes = vec![];
    loop {
        let remaining = until.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(fail(
                "FIXTURE_RECEIPT_TIMEOUT",
                "Fixed child receipt timed out",
            ));
        }
        let mut poll = libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        };
        let result = unsafe { libc::poll(&mut poll, 1, remaining.as_millis().min(100) as i32) };
        if result < 0 {
            if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(io(std::io::Error::last_os_error()));
        }
        if result == 0 {
            continue;
        }
        let mut byte = [0];
        if reader.read(&mut byte).map_err(io)? != 1 {
            return Err(fail(
                "FIXTURE_RECEIPT_EOF",
                "Fixed child closed its receipt pipe",
            ));
        }
        bytes.push(byte[0]);
        if bytes.len() > 4096 {
            return Err(fail(
                "FIXTURE_RECEIPT_TOO_LARGE",
                "Child receipt exceeds 4096 bytes",
            ));
        }
        if byte[0] == b'\n' {
            return serde_json::from_slice(&bytes).map_err(|_| invalid());
        }
    }
}

struct ChildState {
    child: Child,
    stdin: Option<ChildStdin>,
    stop_ack: bool,
    clean: bool,
}
impl ChildState {
    fn live(&mut self) -> Result<()> {
        if self.child.try_wait().map_err(io)?.is_some() {
            return Err(fail(
                "FIXTURE_CHILD_EXITED",
                "Fixture child exited; no production fallback is allowed",
            ));
        }
        Ok(())
    }
}
pub struct LaunchContext {
    child: Mutex<Option<ChildState>>,
    endpoint: Endpoint,
    storage: Arc<tempfile::TempDir>,
    _lock: File,
    preferences: Mutex<Map<String, Value>>,
    clean: AtomicBool,
    failure_exit: AtomicBool,
    shell_io: Mutex<()>,
    storage_identity: Identity,
    storage_removed: AtomicBool,
}
impl LaunchContext {
    pub fn spawn_fixed() -> Result<Arc<Self>> {
        let executable = std::env::current_exe()
            .map_err(io)?
            .parent()
            .ok_or_else(invalid)?
            .join("app-fixture");
        Self::spawn(&executable)
    }
    fn spawn(executable: &Path) -> Result<Arc<Self>> {
        let executable_meta = fs::symlink_metadata(executable).map_err(io)?;
        if !executable_meta.is_file()
            || executable_meta.uid() != unsafe { libc::getuid() }
            || executable_meta.mode() & 0o022 != 0
            || executable_meta.mode() & 0o111 == 0
        {
            return Err(fail("FIXTURE_EXECUTABLE_INVALID","Fixed sibling app-fixture must be an owned executable, not writable by other users"));
        }
        let storage = Arc::new(
            tempfile::Builder::new()
                .prefix("milagre-rust-shell-")
                .tempdir_in(fs::canonicalize("/tmp").map_err(io)?)
                .map_err(io)?,
        );
        fs::set_permissions(storage.path(), fs::Permissions::from_mode(0o700)).map_err(io)?;
        for dir in ["home", "config", "cache", "tmp", "window", "smoke"] {
            fs::create_dir(storage.path().join(dir)).map_err(io)?;
        }
        let lock = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(storage.path().join("desktop.lock"))
            .map_err(io)?;
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(io(std::io::Error::last_os_error()));
        }
        let storage_identity = Identity::read(storage.path(), false)?;
        let mut child = Command::new(executable)
            .env_clear()
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .env("HOME", storage.path().join("home"))
            .env("XDG_CONFIG_HOME", storage.path().join("config"))
            .env("XDG_CACHE_HOME", storage.path().join("cache"))
            .env("TMPDIR", storage.path().join("tmp"))
            .env("LANG", "en_US.UTF-8")
            .current_dir(storage.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(io)?;
        let admitted = (|| {
            let mut stdout = child.stdout.take().ok_or_else(invalid)?;
            let fd = stdout.as_raw_fd();
            let receipt = read_line(&mut stdout, fd, Duration::from_secs(5))?;
            let endpoint = Endpoint::receipt(&receipt, child.id())?;
            endpoint.connect()?;
            Ok(endpoint)
        })();
        let endpoint = match admitted {
            Ok(v) => v,
            Err(e) => {
                // Admission has not entered a UI loop. Do not return while a detached
                // reaper races main's process exit; finish bounded cleanup here.
                if !crash_exit_bounded(&mut child, Duration::from_secs(3)) {
                    std::mem::forget(storage);
                    return Err(fail("FIXTURE_START_CLEANUP_UNKNOWN", "Child startup failed and exit could not be confirmed; private shell storage retained"));
                }
                return Err(e);
            }
        };
        let stdin = child.stdin.take();
        Ok(Arc::new(Self {
            child: Mutex::new(Some(ChildState {
                child,
                stdin,
                stop_ack: false,
                clean: false,
            })),
            endpoint,
            storage_identity,
            storage,
            _lock: lock,
            preferences: Mutex::new(Map::new()),
            clean: AtomicBool::new(false),
            failure_exit: AtomicBool::new(false),
            shell_io: Mutex::new(()),
            storage_removed: AtomicBool::new(false),
        }))
    }
    pub fn connect(&self) -> Result<UnixStream> {
        self.child
            .lock()
            .map_err(|_| invalid())?
            .as_mut()
            .ok_or_else(invalid)?
            .live()?;
        self.endpoint.connect()
    }
    pub fn project(&self) -> &Path {
        &self.endpoint.project
    }
    #[cfg(feature = "fixture-native-smoke")]
    pub fn smoke_identity(&self) -> Value {
        json!({"shellPid":std::process::id(),"daemonPid":self.endpoint.pid,"shellRoot":self.storage.path(),"profile":self.endpoint.pins[0].0,"project":self.endpoint.project})
    }
    pub fn clean(&self) -> bool {
        self.clean.load(Ordering::Acquire)
    }
    pub fn failure_exit_allowed(&self) -> bool {
        self.failure_exit.load(Ordering::Acquire)
    }
    /// Tauri/tao can process::exit without returning from App::run. Call explicitly
    /// from RunEvent::Exit; retained Arcs and destructor timing do not control cleanup.
    pub fn remove_shell_storage(&self) -> Result<()> {
        if !self.clean() {
            return Err(fail(
                "FIXTURE_NOT_CLEAN",
                "Owner shutdown has not completed cleanly",
            ));
        }
        let _io = self.shell_io.try_lock().map_err(|_| {
            fail(
                "FIXTURE_STORAGE_BUSY",
                "A shell write is still active; cleanup is unconfirmed",
            )
        })?;
        if self.storage_removed.load(Ordering::Acquire) {
            return Ok(());
        }
        if Identity::read(self.storage.path(), false)? != self.storage_identity {
            return Err(invalid());
        }
        fs::remove_dir_all(self.storage.path()).map_err(io)?;
        self.storage_removed.store(true, Ordering::Release);
        Ok(())
    }
    fn writable(&self) -> Result<()> {
        if self.clean() || self.failure_exit_allowed() {
            Err(fail("FIXTURE_CLOSED", "Fixture shell storage is closed"))
        } else {
            Ok(())
        }
    }
    /// Startup/build failure is a crash boundary, never a graceful completion.
    pub fn abandon_on_shell_failure(&self) -> bool {
        if let Some(state) = self.child.lock().unwrap_or_else(|p| p.into_inner()).take() {
            if !state.clean {
                let mut child = state.child;
                if !crash_exit_bounded(&mut child, Duration::from_secs(3)) {
                    // Never ask Drop to signal an identity whose wait became unknown.
                    std::mem::forget(self.storage.clone());
                    return false;
                }
            }
            self.failure_exit.store(true, Ordering::Release);
            return true;
        }
        self.failure_exit_allowed()
    }
    pub fn preferences(&self) -> Result<Value> {
        Ok(json!(*self.preferences.lock().map_err(|_| invalid())?))
    }
    pub fn write_preference(&self, key: String, value: Value) -> Result<()> {
        let _io = self.shell_io.lock().map_err(|_| invalid())?;
        self.writable()?;
        if !(key.starts_with("milagre-")
            || key.starts_with("milagre.")
            || key.starts_with("milagre:"))
            || !(value.is_string() || value.is_null())
        {
            return Err(invalid());
        }
        let mut prefs = self.preferences.lock().map_err(|_| invalid())?;
        let mut next = prefs.clone();
        next.insert(key, value);
        let bytes = serde_json::to_vec(&next).map_err(|_| invalid())?;
        if bytes.len() > 1024 * 1024 {
            return Err(fail(
                "FIXTURE_PREFERENCES_FULL",
                "Fixture preferences exceed 1 MiB",
            ));
        }
        // The temporary file stays owned until rename succeeds. A failed write,
        // sync or rename removes it and leaves the previous preferences intact.
        let mut file = tempfile::Builder::new()
            .prefix("preferences-")
            .suffix(".tmp")
            .tempfile_in(self.storage.path())
            .map_err(io)?;
        file.write_all(&bytes).map_err(io)?;
        file.as_file().sync_all().map_err(io)?;
        file.persist(self.storage.path().join("preferences.json"))
            .map_err(|error| io(error.error))?;
        *prefs = next;
        Ok(())
    }
    pub fn save_window(&self, value: &Value) -> Result<()> {
        let _io = self.shell_io.lock().map_err(|_| invalid())?;
        self.writable()?;
        fs::write(
            self.storage.path().join("window/state.json"),
            serde_json::to_vec(value).map_err(|_| invalid())?,
        )
        .map_err(io)
    }
    /// Refusal or pending keeps the child/stdin/storage alive. Never force-cancels work.
    pub fn request_quit(&self) -> Result<()> {
        let mut guard = self.child.lock().map_err(|_| invalid())?;
        let state = guard.as_mut().ok_or_else(invalid)?;
        if state.clean {
            return Ok(());
        }
        if !state.stop_ack {
            state.live()?;
            let mut stream = self.endpoint.connect()?;
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .map_err(io)?;
            stream
                .set_write_timeout(Some(Duration::from_secs(3)))
                .map_err(io)?;
            writeln!(
                stream,
                "{}",
                json!({"v":1,"id":"fixture-stop","method":"daemon:stop","args":[]})
            )
            .map_err(io)?;
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                let fd = stream.as_raw_fd();
                let value = read_line(
                    &mut stream,
                    fd,
                    deadline.saturating_duration_since(Instant::now()),
                )?;
                if value["id"] != "fixture-stop" {
                    continue;
                }
                if let Some(e) = value.get("error") {
                    return Err(e.clone());
                }
                if value["v"] != 1 || value["result"]["stopping"] != true {
                    return Err(invalid());
                }
                state.stop_ack = true;
                break;
            }
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if let Some(status) = state.child.try_wait().map_err(io)? {
                state.stdin.take();
                if status.success() {
                    state.clean = true;
                    self.clean.store(true, Ordering::Release);
                    return Ok(());
                }
                return Err(fail(
                    "FIXTURE_CHILD_CRASHED",
                    "Fixture child exited unsuccessfully after Stop",
                ));
            }
            if Instant::now() >= deadline {
                return Err(fail(
                    "QUIT_PENDING",
                    "Owner acknowledged Stop; child cleanup has not exited yet",
                ));
            }
            thread::sleep(Duration::from_millis(10));
        }
    }
}
trait CleanupChild {
    fn probe(&mut self) -> std::io::Result<Option<std::process::ExitStatus>>;
    fn kill_owned(&mut self) -> std::io::Result<()>;
    fn reap(&mut self) -> std::io::Result<std::process::ExitStatus>;
}
impl CleanupChild for Child {
    fn probe(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
        self.try_wait()
    }
    fn kill_owned(&mut self) -> std::io::Result<()> {
        self.kill()
    }
    fn reap(&mut self) -> std::io::Result<std::process::ExitStatus> {
        self.wait()
    }
}
fn crash_exit_confirmed(child: &mut impl CleanupChild) -> bool {
    match child.probe() {
        Ok(Some(_)) => true, // Known exit: neither signal nor wait again.
        Err(_) => false,     // ECHILD/unknown: no PID-based action is safe.
        Ok(None) => {
            let _ = child.kill_owned();
            child.reap().is_ok()
        }
    }
}
fn crash_exit_bounded(child: &mut impl CleanupChild, budget: Duration) -> bool {
    match child.probe() {
        Ok(Some(_)) => return true,
        Err(_) => return false,
        Ok(None) => {}
    }
    let until = Instant::now() + budget;
    let signalled = child.kill_owned().is_ok();
    loop {
        match child.probe() {
            Ok(Some(_)) => return true,
            Err(_) => return false,
            Ok(None) => {}
        }
        if !signalled || Instant::now() >= until {
            return false;
        }
        thread::sleep(Duration::from_millis(10));
    }
}
fn reap_after_crash(mut child: Child, storage: Arc<tempfile::TempDir>) {
    thread::spawn(move || {
        if !crash_exit_confirmed(&mut child) {
            // Unknown reaping outcome cannot authorize deleting the child's private HOME.
            // Deliberately retain the lease; do not retry a possibly reused PID or claim clean.
            eprintln!("Fixture crash cleanup could not confirm child exit; private shell storage retained");
            std::mem::forget(storage);
        }
    });
}
impl Drop for LaunchContext {
    fn drop(&mut self) {
        if let Some(state) = self
            .child
            .get_mut()
            .unwrap_or_else(|p| p.into_inner())
            .take()
        {
            if !state.clean {
                reap_after_crash(state.child, self.storage.clone());
            }
        }
    }
}

#[cfg(test)]
pub(crate) fn test_context() -> Arc<LaunchContext> {
    // Fixed test-only sibling crate artifact; not an environment or caller input.
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("rust-runtime/target/debug/app-fixture");
    LaunchContext::spawn(&path).expect("build the fixed rust-runtime app-fixture first")
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Arc<LaunchContext> {
        test_context()
    }
    fn call(context: &LaunchContext, method: &str, args: Value) -> Result<Value> {
        let mut stream = context.connect()?;
        writeln!(
            stream,
            "{}",
            json!({"v":1,"id":"open","method":"project:open","args":[context.project()]})
        )
        .map_err(io)?;
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let fd = stream.as_raw_fd();
            let value = read_line(
                &mut stream,
                fd,
                deadline.saturating_duration_since(Instant::now()),
            )?;
            if value["id"] == "open" {
                if let Some(error) = value.get("error") {
                    return Err(error.clone());
                }
                break;
            }
        }
        writeln!(
            stream,
            "{}",
            json!({"v":1,"id":1,"method":method,"args":args})
        )
        .map_err(io)?;
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let fd = stream.as_raw_fd();
            let v = read_line(
                &mut stream,
                fd,
                deadline.saturating_duration_since(Instant::now()),
            )?;
            if v["id"] == 1 {
                if let Some(e) = v.get("error") {
                    return Err(e.clone());
                }
                return Ok(v["result"].clone());
            }
        }
    }
    #[test]
    fn fixed_child_private_preferences_and_ack_plus_exit_cleanup() {
        let context = fixture();
        let root = context.storage.path().to_owned();
        let profile = context.endpoint.pins[0].0.clone();
        assert_ne!(root, profile);
        assert_eq!(context.preferences().unwrap(), json!({}));
        context
            .write_preference("milagre-fixture".into(), json!("local"))
            .unwrap();
        assert_eq!(
            fs::read_to_string(root.join("preferences.json")).unwrap(),
            "{\"milagre-fixture\":\"local\"}"
        );
        let status = call(&context, "daemon:status", json!([])).unwrap();
        assert_eq!(status["pid"], context.endpoint.pid);
        assert!(!context.clean());
        context.request_quit().unwrap();
        assert!(context.clean());
        context.request_quit().unwrap();
        assert!(!profile.exists());
        assert!(root.exists());
        drop(context);
        assert!(!root.exists());
    }
    #[test]
    fn a_failed_preference_rename_keeps_memory_and_allows_retry() {
        let context = fixture();
        let destination = context.storage.path().join("preferences.json");
        fs::create_dir(&destination).unwrap();
        assert!(context
            .write_preference("milagre-fixture".into(), json!("retry"))
            .is_err());
        assert_eq!(context.preferences().unwrap(), json!({}));
        assert!(destination.is_dir());
        assert!(!fs::read_dir(context.storage.path()).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp")
        }));
        fs::remove_dir(&destination).unwrap();
        context
            .write_preference("milagre-fixture".into(), json!("retry"))
            .unwrap();
        assert_eq!(
            context.preferences().unwrap(),
            json!({"milagre-fixture":"retry"})
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(destination).unwrap()).unwrap(),
            context.preferences().unwrap()
        );
        context.request_quit().unwrap();
        context.remove_shell_storage().unwrap();
    }
    #[test]
    fn refused_quit_preserves_owner_then_stop_and_retry_complete() {
        let context = fixture();
        let project = context.project().to_str().unwrap();
        call(&context,"chat:send",json!([{"projectPath":project,"sessionId":2,"provider":"kiro","model":"scripted","body":"fixture:ignore-stop","clientMessageId":"shell-stop"}])).unwrap();
        let error = context.request_quit().unwrap_err();
        assert_eq!(error["code"], "COMMAND_FAILED");
        assert!(error["message"]
            .as_str()
            .unwrap()
            .starts_with("Quitting while a turn runs"));
        assert!(!context.clean());
        assert!(context.storage.path().exists());
        assert!(call(&context, "daemon:status", json!([])).is_ok());
        call(&context, "agent:interrupt", json!([format!("{project}#2")])).unwrap();
        let until = Instant::now() + Duration::from_secs(3);
        loop {
            match context.request_quit() {
                Ok(()) => break,
                Err(e) if Instant::now() < until => {
                    assert!(
                        matches!(e["code"].as_str(), Some("QUIT_PENDING" | "COMMAND_FAILED")),
                        "{e}"
                    );
                    thread::sleep(Duration::from_millis(10));
                }
                Err(e) => panic!("{e}"),
            }
        }
        assert!(context.clean());
    }
    #[test]
    fn peer_pid_and_replaced_socket_are_refused_without_fallback() {
        let context = fixture();
        let stream = context.connect().unwrap();
        assert!(verify_peer(&stream, std::process::id()).is_err());
        let socket = &context.endpoint.socket;
        let held = socket.with_extension(format!("held-{}", std::process::id()));
        fs::rename(socket, &held).unwrap();
        let replacement = std::os::unix::net::UnixListener::bind(socket).unwrap();
        assert!(context.connect().is_err());
        drop(replacement);
        fs::remove_file(socket).unwrap();
        fs::rename(held, socket).unwrap();
        context.request_quit().unwrap();
    }
    #[test]
    fn receipt_reader_has_byte_deadline_and_eof_bounds() {
        for bytes in [vec![b'x'; 4097], b"{}".to_vec()] {
            let (mut reader, mut writer) = UnixStream::pair().unwrap();
            let thread = thread::spawn(move || {
                writer.write_all(&bytes).unwrap();
            });
            let fd = reader.as_raw_fd();
            assert!(read_line(&mut reader, fd, Duration::from_secs(1)).is_err());
            thread.join().unwrap();
        }
        let (mut reader, _writer) = UnixStream::pair().unwrap();
        let fd = reader.as_raw_fd();
        assert_eq!(
            read_line(&mut reader, fd, Duration::from_millis(20)).unwrap_err()["code"],
            "FIXTURE_RECEIPT_TIMEOUT"
        );
    }
    #[test]
    fn child_crash_never_becomes_clean() {
        let context = fixture();
        {
            let mut child = context.child.lock().unwrap();
            let child = child.as_mut().unwrap();
            child.child.kill().unwrap();
            child.child.wait().unwrap();
        }
        assert!(context.request_quit().is_err());
        assert!(!context.clean());
        assert!(context.connect().is_err());
        // This crash intentionally skips daemon destructors. Cleanup only its generated test profile.
        let profile = &context.endpoint.pins[0].0;
        fs::remove_dir_all(profile).unwrap();
        let _ = fs::remove_file(&context.endpoint.socket);
    }
    #[test]
    fn unknown_or_known_exit_never_signals_and_wait_error_never_confirms_cleanup() {
        use std::os::unix::process::ExitStatusExt;
        struct Probe {
            state: u8,
            calls: Vec<&'static str>,
        }
        impl CleanupChild for Probe {
            fn probe(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
                self.calls.push("probe");
                match self.state {
                    0 => Err(std::io::Error::from_raw_os_error(libc::ECHILD)),
                    1 => Ok(Some(std::process::ExitStatus::from_raw(0))),
                    _ => Ok(None),
                }
            }
            fn kill_owned(&mut self) -> std::io::Result<()> {
                self.calls.push("kill");
                Ok(())
            }
            fn reap(&mut self) -> std::io::Result<std::process::ExitStatus> {
                self.calls.push("wait");
                if self.state == 3 {
                    Err(std::io::Error::from_raw_os_error(libc::ECHILD))
                } else {
                    Ok(std::process::ExitStatus::from_raw(9))
                }
            }
        }
        for state in 0..4 {
            let mut process = Probe {
                state,
                calls: vec![],
            };
            assert_eq!(crash_exit_confirmed(&mut process), matches!(state, 1 | 2));
            assert_eq!(
                process.calls,
                if state < 2 {
                    vec!["probe"]
                } else {
                    vec!["probe", "kill", "wait"]
                }
            );
        }
    }
    #[test]
    fn externally_reaped_child_is_unknown_without_signal_or_retry() {
        let mut child = Command::new("/usr/bin/true").env_clear().spawn().unwrap();
        let mut status = 0;
        assert_eq!(
            unsafe { libc::waitpid(child.id() as libc::pid_t, &mut status, 0) },
            child.id() as libc::pid_t
        );
        assert!(!crash_exit_confirmed(&mut child));
    }
    #[test]
    fn explicit_clean_cleanup_works_with_retained_arcs_and_clean_check_never_locks_child() {
        let context = fixture();
        let retained = context.clone();
        let retained_storage = context.storage.clone();
        let root = context.storage.path().to_owned();
        assert_eq!(
            context.remove_shell_storage().unwrap_err()["code"],
            "FIXTURE_NOT_CLEAN"
        );
        let child_lock = context.child.lock().unwrap();
        let observed = context.clone();
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        let check = thread::spawn(move || {
            send.send(observed.clean()).unwrap();
        });
        let answer = receive.recv_timeout(Duration::from_secs(1));
        drop(child_lock);
        check.join().unwrap();
        assert!(!answer.unwrap());
        context.request_quit().unwrap();
        assert!(root.exists());
        let write = context.shell_io.lock().unwrap();
        assert_eq!(
            context.remove_shell_storage().unwrap_err()["code"],
            "FIXTURE_STORAGE_BUSY"
        );
        drop(write);
        let held = root.with_extension("held");
        fs::rename(&root, &held).unwrap();
        fs::create_dir(&root).unwrap();
        fs::write(root.join("sentinel"), b"not the owned shell root").unwrap();
        assert_eq!(
            context.remove_shell_storage().unwrap_err()["code"],
            "FIXTURE_ENDPOINT_INVALID"
        );
        assert_eq!(
            fs::read(root.join("sentinel")).unwrap(),
            b"not the owned shell root"
        );
        fs::remove_dir_all(&root).unwrap();
        fs::rename(&held, &root).unwrap();
        context.remove_shell_storage().unwrap();
        assert!(!root.exists());
        assert!(Arc::strong_count(&context) >= 2);
        assert!(Arc::strong_count(&retained_storage) >= 2);
        assert_eq!(
            retained
                .write_preference("milagre-fixture".into(), json!("late"))
                .unwrap_err()["code"],
            "FIXTURE_CLOSED"
        );
        assert_eq!(
            retained.save_window(&json!({})).unwrap_err()["code"],
            "FIXTURE_CLOSED"
        );
        retained.remove_shell_storage().unwrap();
        assert!(!root.exists());
    }
    #[test]
    fn setup_failure_reaps_before_return_and_never_claims_graceful_cleanup() {
        let context = fixture();
        let pid = context.endpoint.pid;
        assert!(context.abandon_on_shell_failure());
        assert!(context.failure_exit_allowed());
        assert!(!context.clean());
        assert!(context.abandon_on_shell_failure());
        assert_eq!(
            context.remove_shell_storage().unwrap_err()["code"],
            "FIXTURE_NOT_CLEAN"
        );
        assert_eq!(
            unsafe { libc::waitpid(pid as libc::pid_t, std::ptr::null_mut(), libc::WNOHANG) },
            -1
        );
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ECHILD)
        );
        // Abrupt child termination may leave only this freshly generated daemon profile.
        let profile = &context.endpoint.pins[0].0;
        if profile.exists() {
            fs::remove_dir_all(profile).unwrap();
        }
        let _ = fs::remove_file(&context.endpoint.socket);
    }
    #[test]
    fn bounded_failure_reap_stops_on_unknown_and_does_not_use_blocking_wait() {
        use std::{collections::VecDeque, os::unix::process::ExitStatusExt};
        struct Probe {
            states: VecDeque<i32>,
            calls: Vec<&'static str>,
        }
        impl CleanupChild for Probe {
            fn probe(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
                self.calls.push("probe");
                match self.states.pop_front().unwrap_or(0) {
                    -1 => Err(std::io::Error::from_raw_os_error(libc::ECHILD)),
                    1 => Ok(Some(std::process::ExitStatus::from_raw(9))),
                    _ => Ok(None),
                }
            }
            fn kill_owned(&mut self) -> std::io::Result<()> {
                self.calls.push("kill");
                Ok(())
            }
            fn reap(&mut self) -> std::io::Result<std::process::ExitStatus> {
                panic!("bounded setup path must not block in wait")
            }
        }
        for (states, expected, calls) in [
            (vec![-1], false, vec!["probe"]),
            (vec![1], true, vec!["probe"]),
            (vec![0, -1], false, vec!["probe", "kill", "probe"]),
            (vec![0, 0], false, vec!["probe", "kill", "probe"]),
            (vec![0, 1], true, vec!["probe", "kill", "probe"]),
        ] {
            let mut child = Probe {
                states: states.into(),
                calls: vec![],
            };
            assert_eq!(crash_exit_bounded(&mut child, Duration::ZERO), expected);
            assert_eq!(child.calls, calls);
        }
    }
}

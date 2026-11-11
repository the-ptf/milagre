//! Read-only inspection of Milagre's owner locks (`packages/core/src/ownership.cjs`).
//!
//! The runtime holds three kinds of lock, each a directory made with `mkdir` holding `owner.json`
//! (`{ pid, token, startedAt, processStartedAt, host }`):
//! `<dataDir>/runtime.lock`, `<git common dir>/milagre-runtime.lock` and `<project>/.milagre/runtime.lock`.
//!
//! This module only *reads* a lock and reports what Node's staleOwner/abandoned would decide. It never creates,
//! removes or takes over a lock: acquiring ownership belongs to the single writer, and this crate is not one
//! (see [`crate::write::OwnerLock`] for the contract a Rust owner must meet).

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime};

use serde_json::Value;

/// What a lock directory says about its owner.
#[derive(Clone, Debug, PartialEq)]
pub enum LockState {
    /// No lock directory: nobody owns this state.
    Absent,
    /// A lock whose owner record can't be trusted to show it gone (missing/garbled record, another host, an
    /// unreadable start time, or a live process that started no later than the owner). Node treats it as live.
    Live { owner: Option<Value> },
    /// The owner process is certainly gone (no such pid, or the pid was reused by a later process). Node would take
    /// the lock over on its next start.
    Stale { owner: Value },
    /// An empty lock directory older than a minute: a crash between mkdir and writing owner.json. Node takes it over.
    Abandoned,
}

impl LockState {
    pub fn label(&self) -> &'static str {
        match self {
            LockState::Absent => "absent",
            LockState::Live { .. } => "live",
            LockState::Stale { .. } => "stale",
            LockState::Abandoned => "abandoned",
        }
    }
}

/// Probes the operating system; replaceable in tests.
pub trait ProcessProbe {
    fn hostname(&self) -> String;
    /// `process.kill(pid, 0)` succeeds or fails with anything but ESRCH.
    fn alive(&self, pid: i64) -> bool;
    /// When the process started, in ms since the epoch, whole seconds (as `ps -o lstart=` reports); None if unknown.
    fn start_time_ms(&self, pid: i64) -> Option<i64>;
}

/// The real system, as ownership.cjs probes it on macOS and Linux.
pub struct SystemProbe;

impl ProcessProbe for SystemProbe {
    fn hostname(&self) -> String {
        let mut buffer = [0u8; 256];
        // SAFETY: gethostname writes at most buffer.len() bytes into a buffer we own.
        let result = unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) };
        if result != 0 {
            return String::new();
        }
        let end = buffer
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(buffer.len());
        String::from_utf8_lossy(&buffer[..end]).into_owned()
    }

    fn alive(&self, pid: i64) -> bool {
        let Ok(pid) = libc::pid_t::try_from(pid) else {
            return false;
        };
        // SAFETY: signal 0 performs only the existence and permission check.
        if unsafe { libc::kill(pid, 0) } == 0 {
            return true;
        }
        std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }

    fn start_time_ms(&self, pid: i64) -> Option<i64> {
        if pid <= 0 {
            return None;
        }
        let output = Command::new("ps")
            .args(["-o", "lstart=", "-p", &pid.to_string()])
            .env("LC_ALL", "C")
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&output.stdout);
        // "Tue Nov 10 09:00:00 2026", local time, as Date.parse reads it.
        let words: Vec<&str> = text.split_whitespace().collect();
        if words.len() != 5 {
            return None;
        }
        let parsed = chrono::NaiveDateTime::parse_from_str(
            &format!("{} {} {} {}", words[1], words[2], words[3], words[4]),
            "%b %d %H:%M:%S %Y",
        )
        .ok()?;
        let local = parsed.and_local_timezone(chrono::Local).earliest()?;
        Some(local.timestamp_millis())
    }
}

/// `Date.parse` for the ISO strings ownership.cjs writes (`new Date().toISOString()`).
fn parse_iso_ms(value: Option<&Value>) -> Option<i64> {
    let text = value?.as_str()?;
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|time| time.timestamp_millis())
}

/// staleOwner: the owner record when its process is certainly gone, else None.
pub fn stale_owner(lock: &Path, probe: &dyn ProcessProbe) -> Option<Value> {
    let owner: Value =
        serde_json::from_slice(&std::fs::read(lock.join("owner.json")).ok()?).ok()?;
    let pid = owner
        .get("pid")?
        .as_i64()
        .filter(|pid| *pid > 0 && *pid <= (1i64 << 53))?;
    if let Some(host) = owner.get("host") {
        if host.as_str() != Some(probe.hostname().as_str()) {
            return None;
        }
    }
    let started = parse_iso_ms(owner.get("processStartedAt").or(owner.get("startedAt")))?;
    if probe.alive(pid) {
        let running = probe.start_time_ms(pid)?;
        if running <= started {
            return None;
        }
    }
    Some(owner)
}

/// abandoned: an empty lock directory last modified over a minute ago.
pub fn abandoned(lock: &Path, now: SystemTime) -> bool {
    let Ok(mut entries) = std::fs::read_dir(lock) else {
        return false;
    };
    if entries.next().is_some() {
        return false;
    }
    let Ok(modified) = std::fs::metadata(lock).and_then(|meta| meta.modified()) else {
        return false;
    };
    now.duration_since(modified).unwrap_or(Duration::ZERO) > Duration::from_secs(60)
}

/// What Node would decide about `lock`, without touching it.
pub fn inspect(lock: &Path, probe: &dyn ProcessProbe) -> LockState {
    if !lock.is_dir() {
        return LockState::Absent;
    }
    if let Some(owner) = stale_owner(lock, probe) {
        return LockState::Stale { owner };
    }
    if abandoned(lock, SystemTime::now()) {
        return LockState::Abandoned;
    }
    let owner = std::fs::read(lock.join("owner.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok());
    LockState::Live { owner }
}

/// The Project lock ownership.cjs takes for a Project folder.
pub fn project_lock(project: &Path) -> PathBuf {
    project.join(".milagre").join("runtime.lock")
}

/// A random RFC 4122 version 4 id, like `crypto.randomUUID()`.
pub fn random_uuid() -> String {
    let mut bytes = [0u8; 16];
    use std::io::Read;
    std::fs::File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut bytes))
        .expect("/dev/urandom");
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = hex::encode(bytes);
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// `new Date(ms).toISOString()`.
pub fn iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .expect("valid time")
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|time| time.as_millis() as i64)
        .unwrap_or(0)
}

/// The Rust owner lock: ownership.cjs acquireOwnership's format and release, without its takeover. Any existing lock
/// (live, stale, abandoned or unreadable) is refused with what [`inspect`] makes of it; removing a dead owner's lock
/// stays an operator's decision.
pub struct RustOwnerLock;

/// A held lock. Released by [`OwnerGuard::release`] or, best effort, when dropped.
#[derive(Debug)]
pub struct OwnerGuard {
    lock: PathBuf,
    token: String,
    released: bool,
}

impl OwnerGuard {
    pub fn path(&self) -> &Path {
        &self.lock
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    /// Whether this process still owns the lock: not released, the lock a real folder (not a link), its
    /// `owner.json` a regular file naming this process with this guard's token. Errors say what is wrong with the lock,
    /// never the token.
    pub fn verify(&self) -> crate::Result<()> {
        let lost = |why: &str| crate::StoreError::OwnershipLost {
            lock: self.lock.clone(),
            why: why.into(),
        };
        if self.released {
            return Err(lost("the lock was released"));
        }
        match std::fs::symlink_metadata(&self.lock) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(lost("the lock is a symbolic link"))
            }
            Ok(meta) if !meta.is_dir() => return Err(lost("the lock isn't a folder")),
            Ok(_) => {}
            Err(_) => return Err(lost("the lock is gone")),
        }
        let file = self.lock.join("owner.json");
        match std::fs::symlink_metadata(&file) {
            Ok(meta) if !meta.is_file() => {
                return Err(lost("its owner record isn't a regular file"))
            }
            Ok(_) => {}
            Err(_) => return Err(lost("its owner record is gone")),
        }
        let owner = std::fs::read(&file)
            .ok()
            .and_then(|bytes| crate::jsjson::parse_bytes(&bytes).ok())
            .ok_or_else(|| lost("its owner record can't be read"))?;
        if owner.get("token").and_then(Value::as_str) != Some(self.token.as_str()) {
            return Err(lost("another owner's record replaced ours"));
        }
        if owner.get("pid").and_then(Value::as_u64) != Some(u64::from(std::process::id())) {
            return Err(lost("its owner record names another process"));
        }
        Ok(())
    }

    /// ownership.cjs release: removes the record and the lock when the record still holds our token. A record already
    /// gone counts as released (the empty lock stays for an operator); another token is an error and nothing is removed.
    pub fn release(&mut self) -> crate::Result<()> {
        if self.released {
            return Ok(());
        }
        let file = self.lock.join("owner.json");
        let current = match std::fs::read(&file) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.released = true;
                return Ok(());
            }
            Err(error) => return Err(crate::StoreError::io(error, "open", &file)),
        };
        let token = crate::jsjson::parse_bytes(&current).ok().and_then(|owner| {
            owner
                .get("token")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
        if token.as_deref() != Some(self.token.as_str()) {
            return Err(crate::StoreError::OwnershipChanged(self.lock.clone()));
        }
        std::fs::remove_file(&file)
            .map_err(|error| crate::StoreError::io(error, "unlink", &file))?;
        std::fs::remove_dir(&self.lock)
            .map_err(|error| crate::StoreError::io(error, "rmdir", &self.lock))?;
        self.released = true;
        Ok(())
    }
}

impl Drop for OwnerGuard {
    fn drop(&mut self) {
        let _ = self.release();
    }
}

impl crate::write::OwnerLock for RustOwnerLock {
    type Guard = OwnerGuard;

    fn acquire(&self, lock: &Path) -> crate::Result<OwnerGuard> {
        use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
        let parent = lock
            .parent()
            .ok_or_else(|| crate::StoreError::Invalid("A lock needs a parent folder.".into()))?;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(parent)
            .map_err(|error| crate::StoreError::io(error, "mkdir", parent))?;
        if let Err(error) = std::fs::DirBuilder::new().mode(0o700).create(lock) {
            if error.kind() != std::io::ErrorKind::AlreadyExists {
                return Err(crate::StoreError::io(error, "mkdir", lock));
            }
            let state = inspect(lock, &SystemProbe);
            let owner = match &state {
                LockState::Live { owner: Some(owner) } | LockState::Stale { owner } => {
                    Some(crate::jsjson::to_string(owner))
                }
                _ => None,
            };
            return Err(crate::StoreError::LockRefused {
                lock: lock.to_path_buf(),
                state: state.label(),
                owner,
            });
        }
        let token = random_uuid();
        let started = now_ms();
        // Node writes performance.timeOrigin. `ps` reports whole seconds; recording that (never later than the real
        // start) keeps a Node staleOwner check from ever reading this live lock as a reused pid.
        let process_started = SystemProbe
            .start_time_ms(std::process::id() as i64)
            .unwrap_or(started);
        let fields = [
            ("pid", Value::from(std::process::id())),
            ("token", Value::String(token.clone())),
            ("startedAt", Value::String(iso(started))),
            ("processStartedAt", Value::String(iso(process_started))),
            (
                "host",
                Value::String(crate::jsjson::js_string(&SystemProbe.hostname())),
            ),
        ];
        // JSON.stringify(owner, null, 2)
        let body = fields
            .iter()
            .map(|(key, value)| format!("  \"{key}\": {}", crate::jsjson::to_string(value)))
            .collect::<Vec<_>>()
            .join(",\n");
        let record = format!("{{\n{body}\n}}");
        let file = lock.join("owner.json");
        let written = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&file)
            .and_then(|mut handle| std::io::Write::write_all(&mut handle, record.as_bytes()));
        if let Err(error) = written {
            let _ = std::fs::remove_dir_all(lock);
            return Err(crate::StoreError::io(error, "open", &file));
        }
        Ok(OwnerGuard {
            lock: lock.to_path_buf(),
            token,
            released: false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Fake {
        alive: bool,
        start: Option<i64>,
    }
    impl ProcessProbe for Fake {
        fn hostname(&self) -> String {
            "this-mac".into()
        }
        fn alive(&self, _pid: i64) -> bool {
            self.alive
        }
        fn start_time_ms(&self, _pid: i64) -> Option<i64> {
            self.start
        }
    }

    fn lock_with(owner: &Value) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("runtime.lock")).unwrap();
        std::fs::write(
            dir.path().join("runtime.lock/owner.json"),
            serde_json::to_vec(owner).unwrap(),
        )
        .unwrap();
        dir
    }

    const STARTED: &str = "2026-11-10T12:00:00.000Z";
    const STARTED_MS: i64 = 1_794_312_000_000;

    #[test]
    fn mirrors_stale_owner() {
        let owner = json!({ "pid": 4242, "token": "t", "startedAt": STARTED, "processStartedAt": STARTED, "host": "this-mac" });
        let dir = lock_with(&owner);
        let lock = dir.path().join("runtime.lock");
        assert_eq!(
            inspect(
                &lock,
                &Fake {
                    alive: false,
                    start: None
                }
            ),
            LockState::Stale {
                owner: owner.clone()
            }
        );
        // Same pid still running, started before or with the owner: live.
        assert!(matches!(
            inspect(
                &lock,
                &Fake {
                    alive: true,
                    start: Some(STARTED_MS)
                }
            ),
            LockState::Live { .. }
        ));
        // Running but its start time can't be read: live.
        assert!(matches!(
            inspect(
                &lock,
                &Fake {
                    alive: true,
                    start: None
                }
            ),
            LockState::Live { .. }
        ));
        // The pid was reused by a later process: stale.
        assert!(matches!(
            inspect(
                &lock,
                &Fake {
                    alive: true,
                    start: Some(STARTED_MS + 5000)
                }
            ),
            LockState::Stale { .. }
        ));
        // Another computer's record is never stale here.
        let other = lock_with(&json!({ "pid": 4242, "startedAt": STARTED, "host": "other" }));
        assert!(matches!(
            inspect(
                &other.path().join("runtime.lock"),
                &Fake {
                    alive: false,
                    start: None
                }
            ),
            LockState::Live { .. }
        ));
        // No host (older records) and only startedAt: judged on this computer.
        let old = lock_with(&json!({ "pid": 4242, "startedAt": STARTED }));
        assert!(matches!(
            inspect(
                &old.path().join("runtime.lock"),
                &Fake {
                    alive: false,
                    start: None
                }
            ),
            LockState::Stale { .. }
        ));
        // Garbled record: live.
        let garbled = lock_with(&json!({ "pid": "x" }));
        assert!(matches!(
            inspect(
                &garbled.path().join("runtime.lock"),
                &Fake {
                    alive: false,
                    start: None
                }
            ),
            LockState::Live { .. }
        ));
    }

    #[test]
    fn absent_and_fresh_empty_locks() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            inspect(&dir.path().join("runtime.lock"), &SystemProbe),
            LockState::Absent
        );
        std::fs::create_dir(dir.path().join("runtime.lock")).unwrap();
        // Empty but younger than a minute: an owner may be writing its record right now.
        assert!(matches!(
            inspect(&dir.path().join("runtime.lock"), &SystemProbe),
            LockState::Live { owner: None }
        ));
        assert!(abandoned(
            &dir.path().join("runtime.lock"),
            SystemTime::now() + Duration::from_secs(61)
        ));
    }

    #[test]
    fn this_process_is_live() {
        let probe = SystemProbe;
        let pid = std::process::id() as i64;
        assert!(probe.alive(pid));
        let start = probe.start_time_ms(pid).expect("ps reports our own start");
        let now = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        assert!(
            start <= now && now - start < 3_600_000,
            "start {start} now {now}"
        );
    }
}

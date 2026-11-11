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

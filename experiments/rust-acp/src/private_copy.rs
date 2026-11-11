//! Opt-in cooperative same-UID macOS native fixture. This is not immutable-descriptor
//! execution, production authority, a fallback, or the account/owner host binding.
//! The exact sibling native artifact is the only source; no path/environment API exists.
use std::{
    future::poll_fn,
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU8, Ordering},
        Arc, Mutex,
    },
    task::{Poll, Waker},
};

#[cfg(target_os = "macos")]
mod files;
#[cfg(target_os = "macos")]
mod process;
mod wire;
#[cfg(target_os = "macos")]
mod worker;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    UnsupportedPlatform,
    Busy,
    Bounds,
    Artifact,
    Identity,
    Revoked,
    Spawn,
    Protocol,
    Deadline,
    WorkerPanic,
    CleanupUncertain,
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for Error {}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FixtureCase {
    Ready,
    IgnoreCancel,
}
/// Parent-validated native-child evidence. Digests describe input and the pinned copy,
/// not a production executable authorization or an immutable execution proof.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Execution {
    pub compiled_identity: &'static str,
    pub pid: u32,
    pub cwd_device: u64,
    pub cwd_inode: u64,
    pub nonce: String,
    pub frame_bytes: usize,
    pub frame_sha256: String,
    pub text_bytes: usize,
    pub text_sha256: String,
    pub parent_artifact_sha256: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Report {
    pub result: Result<Execution, Error>,
    pub reaped: bool,
    pub exit_code: Option<i32>,
    pub resources_removed: bool,
}
const PENDING: u8 = 0;
const COMMITTED: u8 = 1;
const REVOKED: u8 = 2;
static ACTIVE: AtomicBool = AtomicBool::new(false);
struct Slot;
impl Drop for Slot {
    fn drop(&mut self) {
        ACTIVE.store(false, Ordering::Release);
    }
}
struct Completion {
    report: Option<Report>,
    waker: Option<Waker>,
}
struct Shared {
    phase: AtomicU8,
    completion: Mutex<Completion>,
    pid: AtomicU32,
    parsed: AtomicBool,
    #[cfg(test)]
    before_commit: Mutex<Option<Arc<std::sync::Barrier>>>,
    #[cfg(test)]
    after_commit: Mutex<Option<Arc<std::sync::Barrier>>>,
}
impl Shared {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            phase: AtomicU8::new(PENDING),
            completion: Mutex::new(Completion { report: None, waker: None }),
            pid: AtomicU32::new(0),
            parsed: AtomicBool::new(false),
            #[cfg(test)]
            before_commit: Mutex::new(None),
            #[cfg(test)]
            after_commit: Mutex::new(None),
        })
    }
    fn publish(&self, report: Report) {
        let wake = {
            let mut state = self.completion.lock().unwrap_or_else(|p| p.into_inner());
            state.report = Some(report);
            state.waker.take()
        };
        if let Some(wake) = wake {
            wake.wake();
        }
    }
    fn active(&self) -> Result<(), Error> {
        if self.phase.load(Ordering::Acquire) == REVOKED {
            Err(Error::Revoked)
        } else {
            Ok(())
        }
    }
}

/// One independent fixture process, owned by a standard-library worker through reap.
/// Dropping this observer requests cancellation and never abandons the child.
/// ```compile_fail
/// use milagre_acp::private_copy::MacOsPrivateCopyFixture;
/// let fixture = MacOsPrivateCopyFixture::from_path("/tmp/provider");
/// ```
pub struct MacOsPrivateCopyFixture {
    shared: Arc<Shared>,
}
impl MacOsPrivateCopyFixture {
    pub fn start(case: FixtureCase, text: &str) -> Result<Self, Error> {
        if text.len() > wire::TEXT_LIMIT {
            return Err(Error::Bounds);
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = case;
            Err(Error::UnsupportedPlatform)
        }
        #[cfg(target_os = "macos")]
        {
            ACTIVE.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).map_err(|_| Error::Busy)?;
            let slot = Slot;
            let shared = Shared::new();
            let retained = shared.clone();
            let text = text.to_owned();
            std::thread::Builder::new()
                .name("milagre-acp-copy-fixture".into())
                .spawn(move || worker::run(retained, case, text, slot, worker::Fault::None))
                .map_err(|_| Error::Spawn)?;
            Ok(Self { shared })
        }
    }
    pub fn cancel(&self) {
        self.shared.phase.store(REVOKED, Ordering::Release);
    }
    /// CleanupUncertain is visible if bounded cleanup expires. The worker retains
    /// its slot/resources and continues waiting; lost ownership is never probed again.
    /// The mutable borrow admits only one waiting consumer, so a second task cannot
    /// replace another task's wakeup. Dropping the wait future abandons only that wait.
    pub async fn wait(&mut self) -> Report {
        poll_fn(|cx| {
            let mut state = self.shared.completion.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(report) = &state.report {
                return Poll::Ready(report.clone());
            }
            state.waker = Some(cx.waker().clone());
            Poll::Pending
        })
        .await
    }
}
impl Drop for MacOsPrivateCopyFixture {
    fn drop(&mut self) {
        self.cancel();
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests;

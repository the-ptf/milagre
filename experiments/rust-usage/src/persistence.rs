//! Explicit fresh temporary cache capability. No arbitrary directory adoption, account discovery or network.
//! One non-cancellable worker serializes atomic saves; failed latest snapshots survive owner close/reopen.
use crate::{accounts::Selection, pricing::Pricing, scan::ScanCache, store::UsageStore};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    io,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    time::Duration,
};
use tokio::sync::watch;

type Outcome = Result<(), String>;
type Reply = watch::Sender<Option<Outcome>>;
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Key {
    Quota(String),
    Scan,
    Pricing,
}
impl Key {
    fn quota(selection: &Selection) -> io::Result<Self> {
        fn hex(s: &str) -> String {
            s.as_bytes().iter().map(|b| format!("{b:02x}")).collect()
        }
        let name = format!("quota.{}.{}.{}.json", hex(&selection.claude), hex(&selection.codex), hex(&selection.antigravity));
        // Allow the .tmp prefix within the Unix 255-byte filename limit.
        if name.len() > 250 {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "account selection is too long for a cache slot"));
        }
        Ok(Self::Quota(name))
    }
    fn name(&self) -> &str {
        match self {
            Self::Quota(name) => name,
            Self::Scan => "token-usage.json",
            Self::Pricing => "token-prices.json",
        }
    }
}
struct Capability {
    disk: disk::Directory,
    leased: AtomicBool,
    retained: Mutex<BTreeMap<Key, Value>>,
}
/// Created only by fresh(). Clones name the same temporary cache and cannot create a second writer.
/// Keep this capability to reopen an owner. Dropping its final reference deletes only its own temp directory.
#[derive(Clone)]
pub struct TempCache(Arc<Capability>);
impl TempCache {
    pub fn fresh() -> io::Result<Self> {
        Ok(Self(Arc::new(Capability {
            disk: disk::Directory::fresh()?,
            leased: AtomicBool::new(false),
            retained: Mutex::new(BTreeMap::new()),
        })))
    }
    pub fn open(&self) -> io::Result<CacheOwner> {
        if self.0.leased.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() {
            return Err(io::Error::new(io::ErrorKind::AlreadyExists, "temporary cache already has a writer"));
        }
        let pending = self.0.retained.lock().unwrap().iter().map(|(k, v)| (k.clone(), Pending { version: 0, value: v.clone() })).collect();
        let shared = Arc::new(Shared { state: Mutex::new(State { pending, ..State::default() }), wake: Condvar::new() });
        let (closed, closed_rx) = watch::channel(None);
        let cap = self.0.clone();
        let thread_shared = shared.clone();
        let spawn = std::thread::Builder::new().name("usage-cache-writer".into()).spawn(move || {
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(&cap, &thread_shared)))
                .unwrap_or_else(|_| Err("cache writer panicked".into()));
            let mut state = thread_shared.state.lock().unwrap_or_else(|e| e.into_inner());
            *cap.retained.lock().unwrap() = state.pending.iter().map(|(k, v)| (k.clone(), v.value.clone())).collect();
            state.closing = true;
            for reply in state.waiters.drain(..) {
                reply.send_replace(Some(outcome.clone()));
            }
            cap.leased.store(false, Ordering::Release);
            closed.send_replace(Some(outcome));
        });
        if let Err(error) = spawn {
            self.0.leased.store(false, Ordering::Release);
            return Err(error);
        }
        Ok(CacheOwner { cap: self.0.clone(), shared, closed: closed_rx })
    }
}
#[derive(Clone)]
struct Pending {
    version: u64,
    value: Value,
}
#[derive(Default)]
struct State {
    pending: BTreeMap<Key, Pending>,
    version: u64,
    requested: bool,
    immediate: bool,
    closing: bool,
    waiters: Vec<Reply>,
}
struct Shared {
    state: Mutex<State>,
    wake: Condvar,
}
/// Saves are synchronous staging operations. flush/shutdown futures only observe a dedicated worker;
/// dropping them never cancels disk operations. shutdown seals writes and attempts a final save.
pub struct CacheOwner {
    cap: Arc<Capability>,
    shared: Arc<Shared>,
    closed: watch::Receiver<Option<Outcome>>,
}
impl CacheOwner {
    fn stage(&self, key: Key, value: Value) -> io::Result<()> {
        let mut state = self.shared.state.lock().unwrap();
        if state.closing {
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, "cache owner is closing"));
        }
        state.version += 1;
        let version = state.version;
        state.pending.insert(key, Pending { version, value });
        state.requested = true;
        self.shared.wake.notify_one();
        Ok(())
    }
    pub fn save_quota(&self, selection: &Selection, store: &UsageStore) -> io::Result<()> {
        self.stage(Key::quota(selection)?, store.to_json())
    }
    /// Accepts exports from UsageAccounts::stores(); each cache is sanitized as a UsageStore.
    pub fn save_accounts(&self, stores: &[(Selection, Value)]) -> io::Result<()> {
        // Validate every filename before staging anything.
        let entries =
            stores.iter().map(|(s, v)| Ok((Key::quota(s)?, UsageStore::from_json(v).to_json()))).collect::<io::Result<Vec<_>>>()?;
        let mut state = self.shared.state.lock().unwrap();
        if state.closing {
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, "cache owner is closing"));
        }
        for (key, value) in entries {
            state.version += 1;
            let version = state.version;
            state.pending.insert(key, Pending { version, value });
        }
        state.requested = true;
        self.shared.wake.notify_one();
        Ok(())
    }
    pub fn save_scan(&self, cache: &ScanCache) -> io::Result<()> {
        self.stage(Key::Scan, cache.to_json())
    }
    pub fn save_pricing(&self, prices: &Pricing) -> io::Result<()> {
        self.stage(Key::Pricing, prices.current().cloned().unwrap_or(Value::Null))
    }
    fn load(&self, key: Key) -> io::Result<Value> {
        let state = self.shared.state.lock().unwrap();
        if state.closing {
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, "cache owner is closing"));
        }
        if let Some(pending) = state.pending.get(&key) {
            return Ok(pending.value.clone());
        }
        // Hold the state lock to prevent staging while choosing a committed snapshot.
        self.cap.disk.load(key.name())
    }
    pub fn load_quota(&self, selection: &Selection) -> io::Result<UsageStore> {
        Ok(UsageStore::from_json(&self.load(Key::quota(selection)?)?))
    }
    pub fn load_scan(&self) -> io::Result<ScanCache> {
        Ok(ScanCache::from_json(self.load(Key::Scan)?))
    }
    pub fn load_pricing(&self) -> io::Result<Pricing> {
        Ok(Pricing::from_json(self.load(Key::Pricing)?))
    }
    pub fn dirty_count(&self) -> usize {
        self.shared.state.lock().unwrap().pending.len()
    }
    /// Completes after saving snapshots staged before this call. Later stages may still be pending.
    /// A failure retains the latest snapshot; an explicit flush or new stage retries it without a busy loop.
    pub fn flush(&self) -> impl std::future::Future<Output = Outcome> + Send + 'static {
        let (reply, rx) = watch::channel(None);
        {
            let mut state = self.shared.state.lock().unwrap();
            if state.closing {
                reply.send_replace(Some(Err("cache owner is closing".into())));
            } else {
                state.waiters.push(reply);
                state.requested = true;
                state.immediate = true;
                self.shared.wake.notify_one();
            }
        }
        wait(rx)
    }
    /// Seals immediately, even if the returned future is never polled. Failed snapshots remain in TempCache
    /// for a new owner; a successful close permits rehydration from committed disk files.
    pub fn shutdown(&self) -> impl std::future::Future<Output = Outcome> + Send + 'static {
        self.seal();
        wait(self.closed.clone())
    }
    fn seal(&self) {
        let mut state = self.shared.state.lock().unwrap();
        if !state.closing {
            state.closing = true;
            state.requested = true;
            state.immediate = true;
            self.shared.wake.notify_one();
        }
    }
}
impl Drop for CacheOwner {
    fn drop(&mut self) {
        self.seal();
    }
}
async fn wait(mut rx: watch::Receiver<Option<Outcome>>) -> Outcome {
    loop {
        if let Some(result) = rx.borrow().clone() {
            return result;
        }
        if rx.changed().await.is_err() {
            return Err("cache writer stopped without a result".into());
        }
    }
}
fn run(cap: &Capability, shared: &Shared) -> Outcome {
    loop {
        let (batch, replies, closing) = {
            let mut state = shared.state.lock().unwrap();
            while !state.requested {
                state = shared.wake.wait(state).unwrap();
            }
            if !state.immediate {
                // One bounded debounce interval coalesces bursts; notifications do not extend it indefinitely.
                state = shared.wake.wait_timeout_while(state, Duration::from_millis(10), |s| !s.immediate).unwrap().0;
            }
            state.requested = false;
            state.immediate = false;
            (state.pending.clone(), std::mem::take(&mut state.waiters), state.closing)
        };
        let mut outcome = Ok(());
        for (key, pending) in batch {
            match cap.disk.save(key.name(), &pending.value) {
                Ok(()) => {
                    let mut state = shared.state.lock().unwrap();
                    if state.pending.get(&key).is_some_and(|v| v.version == pending.version) {
                        state.pending.remove(&key);
                    }
                }
                Err(error) => outcome = Err(format!("could not save {}: {error}", key.name())),
            }
        }
        for reply in replies {
            reply.send_replace(Some(outcome.clone()));
        }
        if closing {
            return outcome;
        }
    }
}

#[cfg(unix)]
mod disk {
    use super::*;
    use std::{
        ffi::CString,
        fs::File,
        io::{Read, Write},
        os::fd::{AsRawFd, FromRawFd},
    };
    pub struct Directory {
        pub(super) _temp: tempfile::TempDir,
        #[cfg(test)]
        pub(super) gate: Mutex<Option<(std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>>,
        #[cfg(test)]
        pub(super) attempts: std::sync::atomic::AtomicUsize,
        dir: File,
    }
    impl Directory {
        pub fn fresh() -> io::Result<Self> {
            let temp = tempfile::Builder::new().prefix("milagre-usage-cache-").tempdir()?;
            let dir = File::open(temp.path())?;
            if unsafe { libc::fchmod(dir.as_raw_fd(), 0o700) } != 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(Self {
                _temp: temp,
                dir,
                #[cfg(test)]
                gate: Mutex::new(None),
                #[cfg(test)]
                attempts: std::sync::atomic::AtomicUsize::new(0),
            })
        }
        fn open(&self, name: &str, flags: i32) -> io::Result<File> {
            let name = CString::new(name).unwrap();
            let fd = unsafe {
                libc::openat(self.dir.as_raw_fd(), name.as_ptr(), flags | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK, 0o600)
            };
            if fd < 0 {
                Err(io::Error::last_os_error())
            } else {
                Ok(unsafe { File::from_raw_fd(fd) })
            }
        }
        pub fn load(&self, name: &str) -> io::Result<Value> {
            let mut file = match self.open(name, libc::O_RDONLY) {
                Ok(f) => f,
                Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Value::Null),
                Err(e) => return Err(e),
            };
            if !file.metadata()?.is_file() {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "cache is not a regular file"));
            }
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes)?;
            Ok(serde_json::from_slice(&bytes).unwrap_or(Value::Null))
        }
        pub fn save(&self, name: &str, value: &Value) -> io::Result<()> {
            #[cfg(test)]
            {
                self.attempts.fetch_add(1, Ordering::SeqCst);
                if let Some((entered, resume)) = self.gate.lock().unwrap_or_else(|e| e.into_inner()).take() {
                    let _ = entered.send(());
                    resume.recv_timeout(Duration::from_secs(5)).expect("test resumes writer");
                }
            }
            let temp = format!(".tmp.{name}");
            let temp_c = CString::new(temp.as_str()).unwrap();
            let dest = CString::new(name).unwrap();
            // Never follow stale temp links or truncate a hard-linked existing file.
            unsafe {
                libc::unlinkat(self.dir.as_raw_fd(), temp_c.as_ptr(), 0);
            }
            let result = (|| {
                let mut file = self.open(&temp, libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL)?;
                // Explicit private mode, independent of the host's umask; no process-global umask mutation.
                if unsafe { libc::fchmod(file.as_raw_fd(), 0o600) } != 0 {
                    return Err(io::Error::last_os_error());
                }
                file.write_all(&serde_json::to_vec(value)?)?;
                file.sync_all()?;
                if unsafe { libc::renameat(self.dir.as_raw_fd(), temp_c.as_ptr(), self.dir.as_raw_fd(), dest.as_ptr()) } != 0 {
                    return Err(io::Error::last_os_error());
                }
                self.dir.sync_all()
            })();
            if result.is_err() {
                unsafe {
                    libc::unlinkat(self.dir.as_raw_fd(), temp_c.as_ptr(), 0);
                }
            }
            result
        }
    }
}
#[cfg(not(unix))]
mod disk {
    use super::*;
    pub struct Directory;
    impl Directory {
        pub fn fresh() -> io::Result<Self> {
            Err(io::Error::new(io::ErrorKind::Unsupported, "temporary atomic caches require Unix directory handles"))
        }
        pub fn load(&self, _: &str) -> io::Result<Value> {
            unreachable!()
        }
        pub fn save(&self, _: &str, _: &Value) -> io::Result<()> {
            unreachable!()
        }
    }
}

#[cfg(all(test, unix))]
#[path = "persistence_tests.rs"]
mod tests;

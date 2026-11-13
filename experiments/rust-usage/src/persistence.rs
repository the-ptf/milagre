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

pub const MAX_CACHE_BYTES: u64 = 32 * 1024 * 1024;
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CacheDiagnostic {
    pub slot: String,
    pub issue: String,
}
// All persistence mutexes guard owned maps/flags only. Recover poison so shutdown can retain snapshots.
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}
fn validate_size(value: &Value) -> io::Result<()> {
    encoded_size(value, MAX_CACHE_BYTES).map(|_| ())
}
fn encoded_size(value: &Value, limit: u64) -> io::Result<u64> {
    struct Count {
        bytes: u64,
        limit: u64,
    }
    impl io::Write for Count {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.bytes += bytes.len() as u64;
            if self.bytes > self.limit {
                Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("cache exceeds load byte limit ({} bytes; maximum 32 MiB)", self.limit),
                ))
            } else {
                Ok(bytes.len())
            }
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut count = Count { bytes: 0, limit };
    serde_json::to_writer(&mut count, value).map_err(io::Error::other)?;
    Ok(count.bytes)
}
/// Aggregate input bytes retained by successful cache loads, charged once per structural slot.
/// Quota stores share a charge until their last owner drops. The two fixed scan/pricing slots are
/// reserved for this budget's lifetime; create a fresh budget for each service lifecycle.
/// Serialize loads under this budget on a blocking worker, never on an async runtime thread.
pub struct LoadBudget {
    limit: u64,
    state: Arc<Mutex<LoadState>>,
    // Only blocking loaders acquire this gate. Store destruction never waits for disk I/O.
    loading: Mutex<()>,
}
#[derive(Debug, Default)]
struct LoadState {
    slots: BTreeMap<String, (u64, usize)>,
    reservation: Option<(String, u64)>,
}
impl LoadState {
    fn charged(&self) -> u64 {
        let retained: u64 = self.slots.values().map(|v| v.0).sum();
        match &self.reservation {
            Some((slot, capacity)) => retained + capacity.saturating_sub(self.slots.get(slot).map_or(0, |v| v.0)),
            None => retained,
        }
    }
}
impl LoadBudget {
    pub fn new(limit: u64) -> Self {
        Self { limit, state: Arc::new(Mutex::new(LoadState::default())), loading: Mutex::new(()) }
    }
    /// Includes the capacity reserved by an in-flight load until it settles or rolls back.
    pub fn used_bytes(&self) -> u64 {
        lock(&self.state).charged()
    }
    fn reserve(&self, slot: &str) -> LoadReservation<'_> {
        let serial = lock(&self.loading);
        let mut state = lock(&self.state);
        let previous = state.slots.get(slot).map_or(0, |v| v.0);
        let capacity = self.limit.saturating_sub(state.charged().saturating_sub(previous)).min(MAX_CACHE_BYTES);
        state.reservation = Some((slot.to_owned(), capacity));
        LoadReservation { budget: self, slot: slot.to_owned(), capacity, _serial: serial }
    }
}
struct LoadReservation<'a> {
    budget: &'a LoadBudget,
    slot: String,
    capacity: u64,
    _serial: std::sync::MutexGuard<'a, ()>,
}
impl LoadReservation<'_> {
    fn settle(&self, bytes: u64, scoped: bool) -> io::Result<Option<Arc<LoadCharge>>> {
        if bytes > self.capacity {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "loaded cache exceeds reserved byte capacity"));
        }
        let mut state = lock(&self.budget.state);
        // Charges may have dropped during the read; consult current ownership, not the pre-read count.
        let (previous, owners) = state.slots.get(&self.slot).copied().unwrap_or_default();
        state.slots.insert(self.slot.clone(), (bytes.max(previous), owners + usize::from(scoped)));
        state.reservation = None;
        Ok(scoped.then(|| Arc::new(LoadCharge { state: self.budget.state.clone(), slot: self.slot.clone() })))
    }
}
impl Drop for LoadReservation<'_> {
    fn drop(&mut self) {
        // Also runs on I/O failure or panic, before another loader can acquire the serial gate.
        lock(&self.budget.state).reservation = None;
    }
}
/// A quota charge follows the loaded store, including clones and cancelled blocking-job results.
#[derive(Debug)]
pub(crate) struct LoadCharge {
    state: Arc<Mutex<LoadState>>,
    slot: String,
}
impl Drop for LoadCharge {
    fn drop(&mut self) {
        let mut state = lock(&self.state);
        if let Some((_, owners)) = state.slots.get_mut(&self.slot) {
            *owners -= 1;
            if *owners == 0 {
                state.slots.remove(&self.slot);
            }
        }
    }
}
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
    retained: Mutex<BTreeMap<Key, Arc<Value>>>,
    diagnostics: Mutex<Vec<CacheDiagnostic>>,
    #[cfg(test)]
    fail_stage: AtomicBool,
}
/// Created only by fresh(). Clones name the same temporary cache and cannot create a second writer.
/// Keep this capability to reopen an owner. Dropping its final reference deletes only its own temp directory.
#[derive(Clone)]
pub struct TempCache(Arc<Capability>);
impl TempCache {
    #[cfg(all(test, unix))]
    pub(crate) fn test_directory(&self) -> &std::path::Path {
        self.0.disk._temp.path()
    }
    #[cfg(all(test, unix))]
    pub(crate) fn test_block_load(&self) -> (std::sync::mpsc::Receiver<()>, std::sync::mpsc::Sender<()>) {
        let (tx, entered) = std::sync::mpsc::channel();
        let (resume, rx) = std::sync::mpsc::channel();
        *lock(&self.0.disk.load_gate) = Some((tx, rx));
        (entered, resume)
    }
    #[cfg(all(test, unix))]
    pub(crate) fn test_fail_stage(&self, fail: bool) {
        self.0.fail_stage.store(fail, Ordering::SeqCst);
    }
    #[cfg(all(test, unix))]
    pub(crate) fn test_write_attempts(&self) -> usize {
        self.0.disk.attempts.load(Ordering::SeqCst)
    }
    pub fn fresh() -> io::Result<Self> {
        Ok(Self(Arc::new(Capability {
            disk: disk::Directory::fresh()?,
            leased: AtomicBool::new(false),
            retained: Mutex::new(BTreeMap::new()),
            diagnostics: Mutex::new(Vec::new()),
            #[cfg(test)]
            fail_stage: AtomicBool::new(false),
        })))
    }
    pub fn open(&self) -> io::Result<CacheOwner> {
        if self.0.leased.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() {
            return Err(io::Error::new(io::ErrorKind::AlreadyExists, "temporary cache already has a writer"));
        }
        let pending = lock(&self.0.retained).iter().map(|(k, v)| (k.clone(), Pending { version: 1, value: v.clone() })).collect();
        let state = State { pending, version: 1, ..State::default() };
        let (changes, _) =
            watch::channel(CacheStatus { dirty: state.pending.len(), failed: !state.pending.is_empty(), ..CacheStatus::default() });
        let shared = Arc::new(Shared { state: Mutex::new(state), wake: Condvar::new(), changes });
        let (closed, closed_rx) = watch::channel(None);
        let cap = self.0.clone();
        let thread_shared = shared.clone();
        let spawn = std::thread::Builder::new().name("usage-cache-writer".into()).spawn(move || {
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(&cap, &thread_shared)))
                .unwrap_or_else(|_| Err("cache writer panicked".into()));
            let mut state = lock(&thread_shared.state);
            *lock(&cap.retained) = state.pending.iter().map(|(k, v)| (k.clone(), v.value.clone())).collect();
            state.closing = true;
            thread_shared.publish(&state);
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
    value: Arc<Value>,
}
#[derive(Default)]
struct State {
    failed: bool,
    pricing_committed: u64,
    pending: BTreeMap<Key, Pending>,
    version: u64,
    requested: bool,
    immediate: bool,
    closing: bool,
    waiters: Vec<Reply>,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct CacheStatus {
    pub dirty: usize,
    pub failed: bool,
    pub pricing_committed: u64,
    pub closing: bool,
}
struct Shared {
    state: Mutex<State>,
    wake: Condvar,
    changes: watch::Sender<CacheStatus>,
}
/// Saves are synchronous staging operations. flush/shutdown futures only observe a dedicated worker;
/// dropping them never cancels disk operations. shutdown seals writes and attempts a final save.
pub struct CacheOwner {
    cap: Arc<Capability>,
    shared: Arc<Shared>,
    closed: watch::Receiver<Option<Outcome>>,
}
impl Shared {
    fn publish(&self, state: &State) {
        self.changes.send_replace(CacheStatus {
            dirty: state.pending.len(),
            failed: state.failed,
            pricing_committed: state.pricing_committed,
            closing: state.closing,
        });
    }
}
impl CacheOwner {
    pub fn changes(&self) -> watch::Receiver<CacheStatus> {
        self.shared.changes.subscribe()
    }
    fn stage(&self, key: Key, value: Value) -> io::Result<()> {
        #[cfg(test)]
        if self.cap.fail_stage.load(Ordering::SeqCst) {
            return Err(io::Error::other("fixture staging failure"));
        }
        validate_size(&value)?;
        let mut state = lock(&self.shared.state);
        if state.closing {
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, "cache owner is closing"));
        }
        state.version += 1;
        let version = state.version;
        state.pending.insert(key, Pending { version, value: Arc::new(value) });
        state.requested = true;
        self.shared.publish(&state);
        self.shared.wake.notify_one();
        Ok(())
    }
    pub fn save_quota(&self, selection: &Selection, store: &UsageStore) -> io::Result<()> {
        self.stage(Key::quota(selection)?, store.to_json())
    }
    /// Accepts exports from UsageAccounts::stores(); each cache is sanitized as a UsageStore.
    pub fn save_accounts(&self, stores: &[(Selection, Value)]) -> io::Result<()> {
        #[cfg(test)]
        if self.cap.fail_stage.load(Ordering::SeqCst) {
            return Err(io::Error::other("fixture staging failure"));
        }
        // Validate every filename before staging anything.
        let entries =
            stores.iter().map(|(s, v)| Ok((Key::quota(s)?, UsageStore::from_json(v).to_json()))).collect::<io::Result<Vec<_>>>()?;
        for (_, value) in &entries {
            validate_size(value)?;
        }
        let mut state = lock(&self.shared.state);
        if state.closing {
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, "cache owner is closing"));
        }
        for (key, value) in entries {
            state.version += 1;
            let version = state.version;
            state.pending.insert(key, Pending { version, value: Arc::new(value) });
        }
        state.requested = true;
        self.shared.publish(&state);
        self.shared.wake.notify_one();
        Ok(())
    }
    pub fn save_scan(&self, cache: &ScanCache) -> io::Result<()> {
        self.stage(Key::Scan, cache.to_json())
    }
    pub fn save_pricing(&self, prices: &Pricing) -> io::Result<()> {
        self.stage(Key::Pricing, prices.current().cloned().unwrap_or(Value::Null))
    }
    fn diagnostic(&self, key: &Key, issue: &str) {
        self.record_diagnostic(key.name(), issue);
    }
    pub fn record_diagnostic(&self, slot: &str, issue: &str) {
        let diagnostic = CacheDiagnostic { slot: slot.into(), issue: issue.into() };
        let mut diagnostics = lock(&self.cap.diagnostics);
        if diagnostics.contains(&diagnostic) {
            return;
        }
        if diagnostics.len() == 32 {
            diagnostics.remove(0);
        }
        diagnostics.push(diagnostic);
    }
    pub fn diagnostics(&self) -> Vec<CacheDiagnostic> {
        lock(&self.cap.diagnostics).clone()
    }
    fn load(&self, key: Key) -> io::Result<Value> {
        self.load_with_limit(key, MAX_CACHE_BYTES).map(|v| v.0)
    }
    fn load_budgeted(&self, key: Key, budget: &LoadBudget) -> io::Result<(Value, Option<Arc<LoadCharge>>)> {
        let reservation = budget.reserve(key.name());
        let available = reservation.capacity;
        let (value, bytes) = self.load_with_limit(key.clone(), available).map_err(|error| {
            let message = format!("cache rehydration failed (available {available} bytes): {error}");
            self.diagnostic(&key, &message);
            io::Error::new(error.kind(), message)
        })?;
        let charge = reservation.settle(bytes, matches!(key, Key::Quota(_)))?;
        Ok((value, charge))
    }
    fn load_with_limit(&self, key: Key, limit: u64) -> io::Result<(Value, u64)> {
        let pending = {
            let state = lock(&self.shared.state);
            if state.closing {
                return Err(io::Error::new(io::ErrorKind::BrokenPipe, "cache owner is closing"));
            }
            state.pending.get(&key).map(|p| p.value.clone())
        };
        if let Some(pending) = pending {
            let bytes = encoded_size(&pending, limit)?;
            return Ok(((*pending).clone(), bytes));
        }
        // No state lock across filesystem reads or JSON parsing.
        let loaded = self.cap.disk.load(key.name(), limit);
        if let Err(error) = &loaded {
            self.diagnostic(&key, &error.to_string());
        }
        let (value, malformed, bytes) = loaded?;
        if malformed {
            self.diagnostic(&key, "invalid JSON; empty cache used");
        }
        let pending = {
            let state = lock(&self.shared.state);
            if state.closing {
                return Err(io::Error::new(io::ErrorKind::BrokenPipe, "cache owner is closing"));
            }
            state.pending.get(&key).map(|p| p.value.clone())
        };
        if let Some(pending) = pending {
            let bytes = encoded_size(&pending, limit)?;
            Ok(((*pending).clone(), bytes))
        } else {
            Ok((value, bytes))
        }
    }
    pub fn load_quota_budgeted(&self, selection: &Selection, budget: &LoadBudget) -> io::Result<UsageStore> {
        let key = Key::quota(selection)?;
        let (value, charge) = self.load_budgeted(key.clone(), budget)?;
        let mut store = self.parse_quota(&key, value);
        store.load_charge = charge;
        Ok(store)
    }
    pub fn load_scan_budgeted(&self, budget: &LoadBudget) -> io::Result<ScanCache> {
        let (value, _) = self.load_budgeted(Key::Scan, budget)?;
        Ok(self.parse_scan(value))
    }
    pub fn load_pricing_budgeted(&self, budget: &LoadBudget) -> io::Result<Pricing> {
        let (value, _) = self.load_budgeted(Key::Pricing, budget)?;
        Ok(self.parse_pricing(value))
    }
    pub fn load_quota(&self, selection: &Selection) -> io::Result<UsageStore> {
        let key = Key::quota(selection)?;
        let value = self.load(key.clone())?;
        Ok(self.parse_quota(&key, value))
    }
    fn parse_quota(&self, key: &Key, value: Value) -> UsageStore {
        if !value.is_null() && !value.is_object() {
            self.diagnostic(key, "invalid quota cache; empty cache used");
        }
        let store = UsageStore::from_json(&value);
        if crate::store::STORE_ORDER
            .iter()
            .any(|p| ["last", "blocked"].iter().any(|field| !value[*p][*field].is_null() && store.get(p)[*field].is_null()))
        {
            self.diagnostic(key, "invalid quota fields discarded");
        }
        store
    }
    pub fn load_scan(&self) -> io::Result<ScanCache> {
        let value = self.load(Key::Scan)?;
        Ok(self.parse_scan(value))
    }
    fn parse_scan(&self, value: Value) -> ScanCache {
        let nonempty = !value.is_null();
        let cache = ScanCache::validated(value);
        if nonempty && cache.is_none() {
            self.diagnostic(&Key::Scan, "invalid scanner cache; empty cache used");
        }
        cache.unwrap_or_default()
    }
    pub fn load_pricing(&self) -> io::Result<Pricing> {
        let value = self.load(Key::Pricing)?;
        Ok(self.parse_pricing(value))
    }
    fn parse_pricing(&self, value: Value) -> Pricing {
        let nonempty = !value.is_null();
        let pricing = Pricing::from_json(value);
        if nonempty && pricing.current().is_none() {
            self.diagnostic(&Key::Pricing, "invalid pricing cache; empty cache used");
        }
        pricing
    }
    pub fn dirty_count(&self) -> usize {
        lock(&self.shared.state).pending.len()
    }
    /// Completes after saving snapshots staged before this call. Later stages may still be pending.
    /// A failure retains the latest snapshot; an explicit flush or new stage retries it without a busy loop.
    pub fn flush(&self) -> impl std::future::Future<Output = Outcome> + Send + 'static {
        let (reply, rx) = watch::channel(None);
        {
            let mut state = lock(&self.shared.state);
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
        let mut state = lock(&self.shared.state);
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
            let mut state = lock(&shared.state);
            while !state.requested {
                state = shared.wake.wait(state).unwrap_or_else(|e| e.into_inner());
            }
            if !state.immediate {
                // One bounded debounce interval coalesces bursts; notifications do not extend it indefinitely.
                state =
                    shared.wake.wait_timeout_while(state, Duration::from_millis(10), |s| !s.immediate).unwrap_or_else(|e| e.into_inner()).0;
            }
            state.requested = false;
            state.immediate = false;
            (state.pending.clone(), std::mem::take(&mut state.waiters), state.closing)
        };
        let mut outcome = Ok(());
        for (key, pending) in batch {
            match cap.disk.save(key.name(), &pending.value) {
                Ok(()) => {
                    let mut state = lock(&shared.state);
                    if key == Key::Pricing {
                        state.pricing_committed = state.pricing_committed.max(pending.version);
                    }
                    if state.pending.get(&key).is_some_and(|v| v.version == pending.version) {
                        state.pending.remove(&key);
                    }
                }
                Err(error) => outcome = Err(format!("could not save {}: {error}", key.name())),
            }
        }
        {
            let mut state = lock(&shared.state);
            state.failed = outcome.is_err();
            shared.publish(&state);
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
        #[cfg(test)]
        pub(super) load_gate: Mutex<Option<(std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>>,
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
                #[cfg(test)]
                load_gate: Mutex::new(None),
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
        pub fn load(&self, name: &str, limit: u64) -> io::Result<(Value, bool, u64)> {
            #[cfg(test)]
            if let Some((entered, resume)) = lock(&self.load_gate).take() {
                let _ = entered.send(());
                resume.recv_timeout(Duration::from_secs(5)).unwrap();
            }
            let file = match self.open(name, libc::O_RDONLY) {
                Ok(f) => f,
                Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok((Value::Null, false, 0)),
                Err(e) => return Err(e),
            };
            if !file.metadata()?.is_file() {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "cache is not a regular file"));
            }
            if file.metadata()?.len() > limit {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("cache exceeds load byte limit ({limit} bytes; maximum 32 MiB)"),
                ));
            }
            let mut bytes = Vec::new();
            file.take(limit + 1).read_to_end(&mut bytes)?;
            if bytes.len() as u64 > limit {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("cache exceeds load byte limit ({limit} bytes; maximum 32 MiB)"),
                ));
            }
            Ok(match serde_json::from_slice(&bytes) {
                Ok(v) => (v, false, bytes.len() as u64),
                Err(_) => (Value::Null, true, 0),
            })
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
        pub fn load(&self, _: &str, _: u64) -> io::Result<(Value, bool, u64)> {
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

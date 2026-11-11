//! Isolated usage facade. Caller supplies trusted account callbacks, copied roots and a fresh cache capability.
use crate::{
    accounts::{self, UsageAccounts, UsageAccountsOptions},
    limits::provider_result,
    owner::{self, FutureResult, Projects, ScanResult, TokenUsage, TokenUsageOptions},
    persistence::{CacheDiagnostic, CacheOwner, LoadBudget, TempCache},
    pricing::Pricing,
    scan::{CopiedRoot, ScanCache, ScanCancellation, Scanner},
    supervisor::{self, guarded, guarded_sync, Supervisor},
};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tokio::sync::watch;

type ResultValue<T> = Result<T, String>;
type Signal<T> = watch::Receiver<Option<ResultValue<T>>>;
pub type Catalog = Arc<dyn Fn() -> FutureResult<Value> + Send + Sync>;
#[cfg(test)]
type ScanGate = Arc<Mutex<Option<(std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>>>;
type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;
/// No account service dependency or discovery. Selection IDs and provider directory resolution stay in accounts.read.
pub struct ServiceOptions {
    pub accounts: UsageAccountsOptions,
    pub roots: Vec<CopiedRoot>,
    pub projects: Projects,
    pub fetch_catalog: Catalog,
    pub home: String,
    pub worktree_root: String,
    pub default_time_zone: String,
}
#[derive(Clone, Copy)]
pub struct ServiceLimits {
    pub cache_load_bytes: u64,
}
impl Default for ServiceLimits {
    fn default() -> Self {
        Self { cache_load_bytes: 64 * 1024 * 1024 }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ShutdownReport {
    Complete(Result<(), String>),
    Pending,
}
pub struct UsageService {
    accounts: Arc<UsageAccounts>,
    jobs: Arc<crate::blocking::Jobs>,
    load_budget: Arc<LoadBudget>,
    token: Arc<TokenUsage>,
    scan: Arc<ScanOwner>,
    prices: Arc<PriceOwner>,
    cache: Arc<CacheOwner>,
    commands: Supervisor,
    retry: Supervisor,
    closing: Arc<AtomicBool>,
    shutdown: Mutex<Option<Signal<()>>>,
}
impl UsageService {
    /// Rehydrates scan/pricing before callbacks run; quota stores load lazily for each captured Selection.
    pub async fn open(capability: &TempCache, options: ServiceOptions) -> ResultValue<Arc<Self>> {
        Self::open_with_limits(capability, options, ServiceLimits::default()).await
    }
    pub async fn open_with_limits(capability: &TempCache, mut options: ServiceOptions, limits: ServiceLimits) -> ResultValue<Arc<Self>> {
        let cache = Arc::new(capability.open().map_err(|e| e.to_string())?);
        let jobs = Arc::new(crate::blocking::Jobs::default());
        let load_budget = Arc::new(LoadBudget::new(limits.cache_load_bytes));
        let disk = cache.clone();
        let budget = load_budget.clone();
        let loaded = jobs
            .run(move || {
                disk.load_scan_budgeted(&budget)
                    .and_then(|scan| {
                        disk.load_pricing_budgeted(&budget).map(|pricing| {
                            let pricing = pricing.current().cloned();
                            (scan.clone(), scan, pricing.clone(), pricing)
                        })
                    })
                    .map_err(|e| e.to_string())
            })
            .await;
        let (scan_cache, last_scan, pricing, last_prices) = match loaded {
            Ok(value) => value,
            Err(error) => {
                let _ = cache.shutdown().await;
                return Err(error.to_string());
            }
        };
        let closing = Arc::new(AtomicBool::new(false));
        let sink = options.accounts.emit.clone();
        let closed = closing.clone();
        let emit: accounts::Emit = Arc::new(move |name, payload| {
            if !closed.load(Ordering::Acquire) {
                let _ = guarded_sync(|| sink(name, payload));
            }
        });
        options.accounts.emit = emit.clone();
        let now = options.accounts.now.clone();
        // The ID remains pinned. Recheck metadata at invocation so removed/not-ready accounts cannot silently
        // resolve through an adapter's current default. Preparation completion never supplies readiness.
        let list = options.accounts.list.clone();
        let read = options.accounts.read.clone();
        let read_now = now.clone();
        options.accounts.read = Arc::new(move |provider, id| {
            let list = list.clone();
            let read = read.clone();
            let now = read_now.clone();
            Box::pin(async move {
                let identities = list().await.map_err(|_| ())?;
                let account =
                    identities.providers.iter().find(|p| p.provider == provider).and_then(|p| p.accounts.iter().find(|a| a.id == id));
                if let Some(account) = account.filter(|a| a.state == "ready") {
                    return read(provider, account.id.clone()).await;
                }
                let message = account.and_then(|a| a.message.as_deref()).filter(|s| !s.is_empty()).unwrap_or(
                    match account.map(|a| a.state.as_str()) {
                        None => "Account is no longer available.",
                        Some("unknown") => "Checking account sign-in…",
                        _ => "Account is not signed in.",
                    },
                );
                Ok(provider_result(&provider, now(), "unavailable", json!([]), Some(message)))
            })
        });
        let load_cache = cache.clone();
        let load_jobs = jobs.clone();
        let budget = load_budget.clone();
        let accounts = UsageAccounts::with_async_store_loader(
            options.accounts,
            Arc::new(move |selection| {
                let cache = load_cache.clone();
                let jobs = load_jobs.clone();
                let budget = budget.clone();
                Box::pin(async move { jobs.run(move || cache.load_quota_budgeted(&selection, &budget).map_err(|e| e.to_string())).await })
            }),
        );
        let last_scan = Arc::new(Mutex::new(last_scan));
        let scanner = Scanner::new(options.roots, scan_cache);
        let rows = scanner.rows();
        let finished = scanner.finished();
        let scan = Arc::new(ScanOwner {
            scanner: Arc::new(Mutex::new(scanner)),
            last_good: last_scan,
            recovered: Arc::new(AtomicBool::new(false)),
            state: Mutex::new(ScanState::default()),
            cancel: ScanCancellation::default(),
            cache: cache.clone(),
            #[cfg(test)]
            gate: Arc::new(Mutex::new(None)),
        });
        let prices = Arc::new(PriceOwner {
            last_good: Mutex::new(last_prices),
            recovered: AtomicBool::new(false),
            pricing: Mutex::new(Pricing::from_json(pricing.unwrap_or(Value::Null))),
            pending: Mutex::new(None),
            tasks: Supervisor::default(),
            fetch: options.fetch_catalog,
            now: now.clone(),
            emit: emit.clone(),
            cache: cache.clone(),
        });
        let scan_read = scan.clone();
        let scan_clock = now.clone();
        let price_read = prices.clone();
        let price_status = prices.clone();
        let token = TokenUsage::new(
            TokenUsageOptions {
                scan: Arc::new(move || {
                    let scan = scan_read.clone();
                    let now = scan_clock();
                    Box::pin(async move {
                        let (rows, changed) = scan.start(now).map_err(|_| ())?.await.map_err(|_| ())?;
                        Ok(ScanResult { rows, changed })
                    })
                }),
                projects: options.projects,
                prices: Arc::new(move || {
                    let _ = price_read.start();
                    price_read.models()
                }),
                pricing_status: Arc::new(move || price_status.status()),
                emit,
                now,
                home: options.home,
                worktree_root: options.worktree_root,
                default_time_zone: options.default_time_zone,
            },
            rows,
            finished,
        );
        let service = Arc::new(Self {
            accounts,
            jobs,
            load_budget,
            token,
            scan,
            prices,
            cache,
            commands: Supervisor::default(),
            retry: Supervisor::default(),
            closing,
            shutdown: Mutex::new(None),
        });
        let retry_cache = service.cache.clone();
        let retry_closed = service.closing.clone();
        let retry_emit = service.prices.emit.clone();
        service
            .retry
            .spawn(async move {
                retry_cache_changes(retry_cache, retry_closed, retry_emit).await;
            })
            .map_err(|_| "Cache retry owner stopped".to_owned())?;
        Ok(service)
    }
    /// The four usage commands plus token-usage:read. Routing and authorization remain the runtime owner's job.
    pub async fn handle(self: &Arc<Self>, command: &str, argument: &Value) -> ResultValue<Value> {
        if !accounts::COMMANDS.contains(&command) && command != "token-usage:read" {
            return Err(format!("Unknown usage command: {command}"));
        }
        let this = self.clone();
        let command = command.to_owned();
        let argument = argument.clone();
        self.commands
            .run(async move {
                this.ensure_open()?;
                if command == "token-usage:read" {
                    this.token.read(&argument).await
                } else {
                    let result = this.accounts.handle(&command, &argument).await;
                    // Also preserve any completed provider reads when a later metadata callback failed.
                    if command.ends_with(":read") {
                        let cache = this.cache.clone();
                        let accounts = this.accounts.clone();
                        if let Err(error) = this.jobs.run(move || cache.save_accounts(&accounts.stores()).map_err(|e| e.to_string())).await
                        {
                            this.cache.record_diagnostic("accounts", &error);
                        }
                    }
                    result
                }
            })
            .await
            .map_err(service_error)?
    }
    /// Uses the existing refresh/backoff policy. A failed fetch/panic is retryable after the normal backoff.
    pub async fn refresh_prices(self: &Arc<Self>) -> ResultValue<bool> {
        let this = self.clone();
        self.commands
            .run(async move {
                this.ensure_open()?;
                match this.prices.start()? {
                    Some(rx) => supervisor::wait(rx).await.map_err(|_| "Pricing stopped".to_owned())?,
                    None => Ok(false),
                }
            })
            .await
            .map_err(service_error)?
    }
    pub fn flush(&self) -> impl std::future::Future<Output = ResultValue<()>> + Send + 'static {
        self.cache.flush()
    }
    pub fn cache_diagnostics(&self) -> Vec<CacheDiagnostic> {
        self.cache.diagnostics()
    }
    pub fn loaded_cache_bytes(&self) -> u64 {
        self.load_budget.used_bytes()
    }
    pub fn dirty_count(&self) -> usize {
        self.cache.dirty_count()
    }
    fn ensure_open(&self) -> ResultValue<()> {
        if self.closing.load(Ordering::Acquire) {
            Err("Usage service stopped".into())
        } else {
            Ok(())
        }
    }
    /// Seals immediately. The retained shutdown task survives dropped waiters; cache closes only after callbacks
    /// stop, the scanner exits and every final state has been staged. Never stop Tokio while Pending.
    pub fn shutdown(self: &Arc<Self>) -> impl std::future::Future<Output = ShutdownReport> + Send + 'static {
        self.shutdown_report(std::time::Duration::from_secs(2))
    }
    pub fn shutdown_report(
        self: &Arc<Self>,
        timeout: std::time::Duration,
    ) -> impl std::future::Future<Output = ShutdownReport> + Send + 'static {
        let rx = self.begin_shutdown();
        async move {
            match tokio::time::timeout(timeout, wait(rx)).await {
                Ok(result) => ShutdownReport::Complete(result),
                Err(_) => ShutdownReport::Pending,
            }
        }
    }
    fn begin_shutdown(self: &Arc<Self>) -> Signal<()> {
        let mut pending = self.shutdown.lock().unwrap();
        let rx = if let Some(rx) = pending.as_ref() {
            rx.clone()
        } else {
            self.closing.store(true, Ordering::Release);
            self.scan.cancel.cancel();
            let (tx, rx) = watch::channel(None);
            let this = self.clone();
            tokio::spawn(async move {
                let result = guarded(this.finish()).await.unwrap_or_else(|_| Err("Usage service shutdown panicked".into()));
                // Idempotent even when an unexpected panic interrupted final export.
                let disk = this.cache.shutdown().await;
                tx.send_replace(Some(result.and(disk)));
            });
            *pending = Some(rx.clone());
            rx
        };
        rx
    }
    async fn finish(&self) -> ResultValue<()> {
        self.retry.shutdown().await;
        self.commands.shutdown().await;
        finalize(self.accounts.clone(), self.token.clone(), self.prices.clone(), self.scan.clone(), self.jobs.clone(), self.cache.clone())
            .await
    }
}
impl Drop for UsageService {
    fn drop(&mut self) {
        if self.closing.swap(true, Ordering::AcqRel) {
            return;
        }
        self.scan.cancel.cancel();
        self.retry.cancel();
        self.commands.cancel();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            let (accounts, token, prices, scan, jobs, cache) =
                (self.accounts.clone(), self.token.clone(), self.prices.clone(), self.scan.clone(), self.jobs.clone(), self.cache.clone());
            runtime.spawn(async move {
                let _ = finalize(accounts, token, prices, scan, jobs, cache).await;
            });
        } else {
            self.cache.record_diagnostic("service", "dropped_without_export: no Tokio runtime available for final export");
        }
    }
}
async fn finalize(
    accounts: Arc<UsageAccounts>,
    token: Arc<TokenUsage>,
    prices: Arc<PriceOwner>,
    scan: Arc<ScanOwner>,
    jobs: Arc<crate::blocking::Jobs>,
    cache: Arc<CacheOwner>,
) -> ResultValue<()> {
    accounts.shutdown().await;
    token.shutdown().await;
    prices.tasks.shutdown().await;
    scan.close().await;
    jobs.close().await;
    let disk = cache.clone();
    let mut errors = tokio::task::spawn_blocking(move || {
        let mut errors = Vec::new();
        export_state(&disk, "accounts", &mut errors, || disk.save_accounts(&accounts.stores()));
        export_state(&disk, "scanner", &mut errors, || {
            let (scanner, _) = recover_scanner(&scan.scanner, &scan.last_good, &scan.recovered, &disk);
            if scan.recovered.load(Ordering::Acquire) {
                disk.record_diagnostic("scanner", "recovered snapshot not exported; last good cache preserved until successful scan");
                Ok(())
            } else {
                disk.save_scan(scanner.cache())
            }
        });
        export_state(&disk, "pricing", &mut errors, || {
            let pricing = prices.lock_pricing();
            if prices.recovered.load(Ordering::Acquire) {
                disk.record_diagnostic(
                    "pricing",
                    "recovered snapshot not exported; last good cache preserved until successful catalog refresh",
                );
                Ok(())
            } else {
                disk.save_pricing(&pricing)
            }
        });
        errors
    })
    .await
    .unwrap_or_else(|_| vec!["Final cache export panicked".into()]);
    if let Err(error) = cache.shutdown().await {
        errors.push(error);
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

fn export_state(cache: &CacheOwner, slot: &str, errors: &mut Vec<String>, export: impl FnOnce() -> std::io::Result<()>) {
    let result = guarded_sync(export).map_err(|_| "export panicked".to_owned()).and_then(|result| result.map_err(|e| e.to_string()));
    if let Err(error) = result {
        cache.record_diagnostic(slot, &error);
        errors.push(format!("{slot}: {error}"));
    }
}

fn service_error(error: supervisor::TaskError) -> String {
    match error {
        supervisor::TaskError::Stopped => "Usage service stopped",
        supervisor::TaskError::Panicked => "Usage service callback panicked",
    }
    .into()
}
struct RetryBackoff {
    base: u64,
    seed: u64,
}
impl RetryBackoff {
    fn new(seed: u64) -> Self {
        Self { base: 1000, seed: seed.max(1) }
    }
    fn reset(&mut self) {
        self.base = 1000;
    }
    fn next(&mut self) -> std::time::Duration {
        self.seed ^= self.seed << 13;
        self.seed ^= self.seed >> 7;
        self.seed ^= self.seed << 17;
        let millis = (self.base * (80 + self.seed % 41) / 100).min(60_000);
        self.base = (self.base * 2).min(60_000);
        std::time::Duration::from_millis(millis)
    }
}
async fn retry_cache_changes(cache: Arc<CacheOwner>, closing: Arc<AtomicBool>, emit: accounts::Emit) {
    let mut changes = cache.changes();
    let mut committed = 0;
    let seed = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().subsec_nanos() as u64;
    let mut backoff = RetryBackoff::new(seed);
    let mut retry_at = None;
    loop {
        let status = *changes.borrow_and_update();
        if closing.load(Ordering::Acquire) || status.closing {
            return;
        }
        if status.pricing_committed > committed {
            committed = status.pricing_committed;
            let _ = guarded_sync(|| emit(owner::CHANGED, json!({})));
        }
        if status.dirty == 0 {
            retry_at = None;
            backoff.reset();
        } else if status.failed && retry_at.is_none() {
            retry_at = Some(tokio::time::Instant::now() + backoff.next());
        }
        tokio::select! {
            result=changes.changed()=>if result.is_err(){return;},
            _=async {if let Some(at)=retry_at {tokio::time::sleep_until(at).await;}else{std::future::pending::<()>().await;}}=>{
                if closing.load(Ordering::Acquire){return;}
                let _=cache.flush().await;retry_at=None;
            }
        }
    }
}
async fn wait<T: Clone>(mut rx: Signal<T>) -> ResultValue<T> {
    loop {
        if let Some(value) = rx.borrow().clone() {
            return value;
        }
        if rx.changed().await.is_err() {
            return Err("Usage service worker stopped".into());
        }
    }
}
#[derive(Default)]
struct ScanState {
    closed: bool,
    pending: Option<Signal<(Value, bool)>>,
}
struct ScanOwner {
    cancel: ScanCancellation,
    scanner: Arc<Mutex<Scanner>>,
    last_good: Arc<Mutex<ScanCache>>,
    recovered: Arc<AtomicBool>,
    state: Mutex<ScanState>,
    cache: Arc<CacheOwner>,
    #[cfg(test)]
    gate: ScanGate,
}
fn recover_scanner<'a>(
    scanner: &'a Mutex<Scanner>,
    last_good: &Mutex<ScanCache>,
    recovered: &AtomicBool,
    cache: &CacheOwner,
) -> (std::sync::MutexGuard<'a, Scanner>, bool) {
    match scanner.lock() {
        Ok(scanner) => (scanner, false),
        Err(poison) => {
            let mut guard = poison.into_inner();
            guard.restore_after_panic(last_good.lock().unwrap_or_else(|e| e.into_inner()).clone());
            recovered.store(true, Ordering::Release);
            cache.record_diagnostic("scanner", "poisoned scanner state discarded; last good snapshot restored, including retained history");
            scanner.clear_poison();
            (guard, true)
        }
    }
}
impl ScanOwner {
    fn start(&self, now: i64) -> ResultValue<impl std::future::Future<Output = ResultValue<(Value, bool)>> + Send + 'static> {
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return Err("Scanner stopped".into());
        }
        if let Some(rx) = state.pending.as_ref().filter(|rx| rx.borrow().is_none()) {
            return Ok(wait(rx.clone()));
        }
        let (tx, rx) = watch::channel(None);
        let scanner = self.scanner.clone();
        let last_good = self.last_good.clone();
        let recovery_pending = self.recovered.clone();
        let cancel = self.cancel.clone();
        let cache = self.cache.clone();
        #[cfg(test)]
        let gate = self.gate.clone();
        std::thread::Builder::new()
            .name("usage-copy-scan".into())
            .spawn(move || {
                let result = guarded_sync(|| {
                    #[cfg(test)]
                    if let Some((entered, resume)) = gate.lock().unwrap().take() {
                        let _ = entered.send(());
                        resume.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
                    }
                    let (mut scanner, recovered) = recover_scanner(&scanner, &last_good, &recovery_pending, &cache);
                    let changed = scanner.scan_cancellable(now, &cancel).map_err(|e| {
                        if e.kind() == std::io::ErrorKind::Interrupted {
                            "Scanner stopped".to_owned()
                        } else {
                            e.to_string()
                        }
                    })?;
                    *last_good.lock().unwrap_or_else(|e| e.into_inner()) = scanner.cache().clone();
                    let was_recovered = recovery_pending.swap(false, Ordering::AcqRel);
                    let changed = changed || recovered || was_recovered;
                    if changed {
                        if let Err(error) = cache.save_scan(scanner.cache()) {
                            cache.record_diagnostic("scanner", &error.to_string());
                        }
                    }
                    Ok((scanner.rows(), changed))
                })
                .unwrap_or_else(|_| Err("Copied-root scan panicked".into()));
                tx.send_replace(Some(result));
            })
            .map_err(|e| e.to_string())?;
        state.pending = Some(rx.clone());
        Ok(wait(rx))
    }
    async fn close(&self) {
        self.cancel.cancel();
        let pending = {
            let mut state = self.state.lock().unwrap();
            state.closed = true;
            state.pending.clone()
        };
        if let Some(rx) = pending {
            let _ = wait(rx).await;
        }
    }
}
struct PriceOwner {
    pricing: Mutex<Pricing>,
    last_good: Mutex<Option<Value>>,
    recovered: AtomicBool,
    pending: Mutex<Option<supervisor::Receiver<ResultValue<bool>>>>,
    tasks: Supervisor,
    fetch: Catalog,
    now: Clock,
    emit: accounts::Emit,
    cache: Arc<CacheOwner>,
}
struct PriceReset {
    owner: Arc<PriceOwner>,
    now: i64,
    done: bool,
}
impl PriceReset {
    fn finish(&mut self) {
        self.done = true;
    }
}
impl Drop for PriceReset {
    fn drop(&mut self) {
        if !self.done {
            self.owner.lock_pricing().complete(None, self.now);
        }
    }
}
impl PriceOwner {
    fn lock_pricing(&self) -> std::sync::MutexGuard<'_, Pricing> {
        self.pricing.lock().unwrap_or_else(|poison| {
            let mut pricing = poison.into_inner();
            *pricing = Pricing::from_json(self.last_good.lock().unwrap_or_else(|e| e.into_inner()).clone().unwrap_or(Value::Null));
            self.recovered.store(true, Ordering::Release);
            self.cache.record_diagnostic("pricing", "poisoned pricing state discarded; last good catalog restored with original timestamp");
            self.pricing.clear_poison();
            pricing
        })
    }
    fn start(self: &Arc<Self>) -> ResultValue<Option<supervisor::Receiver<ResultValue<bool>>>> {
        let now = (self.now)();
        let mut pending = self.pending.lock().unwrap();
        if let Some(rx) = pending.as_ref().filter(|rx| rx.borrow().is_none()) {
            return Ok(Some(rx.clone()));
        }
        if !self.lock_pricing().begin_refresh(now) {
            return Ok(None);
        }
        let mut reset = PriceReset { owner: self.clone(), now, done: false };
        let this = self.clone();
        let rx = self
            .tasks
            .spawn(async move {
                let catalog = guarded(async { (this.fetch)().await }).await.ok().and_then(Result::ok);
                let now = (this.now)();
                let changed = {
                    let mut pricing = this.lock_pricing();
                    let changed = pricing.complete(catalog.as_ref(), now);
                    reset.finish();
                    if changed {
                        *this.last_good.lock().unwrap_or_else(|e| e.into_inner()) = pricing.current().cloned();
                        this.recovered.store(false, Ordering::Release);
                        if let Err(error) = this.cache.save_pricing(&pricing) {
                            this.cache.record_diagnostic("pricing", &error.to_string());
                        }
                    }
                    changed
                };
                if changed {
                    if let Err(error) = this.cache.flush().await {
                        this.cache.record_diagnostic("pricing", &error);
                    }
                }
                Ok(changed)
            })
            .map_err(|_| "Pricing stopped".to_owned())?;
        *pending = Some(rx.clone());
        Ok(Some(rx))
    }
    fn models(&self) -> Value {
        self.lock_pricing().current().map(|s| s["models"].clone()).unwrap_or(Value::Null)
    }
    fn status(&self) -> Value {
        let now = (self.now)();
        self.lock_pricing().status(now)
    }
}

#[cfg(all(test, unix))]
#[path = "service_tests.rs"]
mod tests;

//! Isolated usage facade. Caller supplies trusted account callbacks, copied roots and a fresh cache capability.
use crate::{
    accounts::{self, UsageAccounts, UsageAccountsOptions},
    limits::provider_result,
    owner::{self, FutureResult, Projects, ScanResult, TokenUsage, TokenUsageOptions},
    persistence::{CacheDiagnostic, CacheOwner, LoadBudget, TempCache},
    pricing::Pricing,
    scan::{CopiedRoot, Scanner},
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
                    .and_then(|scan| disk.load_pricing_budgeted(&budget).map(|pricing| (scan, pricing.current().cloned())))
                    .map_err(|e| e.to_string())
            })
            .await;
        let (scan_cache, pricing) = match loaded {
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
        let scanner = Scanner::new(options.roots, scan_cache);
        let rows = scanner.rows();
        let finished = scanner.finished();
        let scan = Arc::new(ScanOwner {
            scanner: Arc::new(Mutex::new(scanner)),
            state: Mutex::new(ScanState::default()),
            cache: cache.clone(),
            #[cfg(test)]
            gate: Arc::new(Mutex::new(None)),
        });
        let prices = Arc::new(PriceOwner {
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
        service
            .retry
            .spawn(async move {
                let mut delay = std::time::Duration::from_millis(100);
                loop {
                    tokio::time::sleep(delay).await;
                    if retry_closed.load(Ordering::Acquire) {
                        break;
                    }
                    if retry_cache.dirty_count() == 0 {
                        delay = std::time::Duration::from_millis(100);
                        continue;
                    }
                    delay = if retry_cache.flush().await.is_ok() {
                        std::time::Duration::from_millis(100)
                    } else {
                        (delay * 2).min(std::time::Duration::from_secs(5))
                    };
                }
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
                        this.cache.save_accounts(&this.accounts.stores()).map_err(|e| e.to_string())?;
                    }
                    result
                }
            })
            .await
            .map_err(|_| "Usage service stopped or callback panicked".to_owned())?
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
            .map_err(|_| "Usage service stopped or callback panicked".to_owned())?
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
    /// stop, the non-cancellable scanner finishes and every final state has been staged.
    pub fn shutdown(self: &Arc<Self>) -> impl std::future::Future<Output = ResultValue<()>> + Send + 'static {
        let mut pending = self.shutdown.lock().unwrap();
        let rx = if let Some(rx) = pending.as_ref() {
            rx.clone()
        } else {
            self.closing.store(true, Ordering::Release);
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
        wait(rx)
    }
    async fn finish(&self) -> ResultValue<()> {
        self.retry.shutdown().await;
        self.commands.shutdown().await;
        self.accounts.shutdown().await;
        self.token.shutdown().await;
        self.prices.tasks.shutdown().await;
        self.scan.close().await;
        self.jobs.close().await;
        let mut errors = Vec::new();
        for result in [
            self.cache.save_accounts(&self.accounts.stores()),
            self.cache.save_scan(self.scan.scanner.lock().unwrap().cache()),
            self.cache.save_pricing(&self.prices.pricing.lock().unwrap()),
        ] {
            if let Err(error) = result {
                errors.push(error.to_string());
            }
        }
        if let Err(error) = self.cache.shutdown().await {
            errors.push(error);
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
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
    scanner: Arc<Mutex<Scanner>>,
    state: Mutex<ScanState>,
    cache: Arc<CacheOwner>,
    #[cfg(test)]
    gate: ScanGate,
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
                    let mut scanner = scanner.lock().unwrap();
                    let changed = scanner.scan(now).map_err(|e| e.to_string())?;
                    if changed {
                        cache.save_scan(scanner.cache()).map_err(|e| e.to_string())?;
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
            self.owner.pricing.lock().unwrap().complete(None, self.now);
        }
    }
}
impl PriceOwner {
    fn start(self: &Arc<Self>) -> ResultValue<Option<supervisor::Receiver<ResultValue<bool>>>> {
        let now = (self.now)();
        let mut pending = self.pending.lock().unwrap();
        if let Some(rx) = pending.as_ref().filter(|rx| rx.borrow().is_none()) {
            return Ok(Some(rx.clone()));
        }
        if !self.pricing.lock().unwrap().begin_refresh(now) {
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
                    let mut pricing = this.pricing.lock().unwrap();
                    let changed = pricing.complete(catalog.as_ref(), now);
                    reset.finish();
                    if changed {
                        this.cache.save_pricing(&pricing).map_err(|e| e.to_string())?;
                    }
                    changed
                };
                if changed {
                    this.cache.flush().await?;
                    let _ = guarded_sync(|| (this.emit)(owner::CHANGED, json!({})));
                }
                Ok(changed)
            })
            .map_err(|_| "Pricing stopped".to_owned())?;
        *pending = Some(rx.clone());
        Ok(Some(rx))
    }
    fn models(&self) -> Value {
        self.pricing.lock().unwrap().current().map(|s| s["models"].clone()).unwrap_or(Value::Null)
    }
    fn status(&self) -> Value {
        let now = (self.now)();
        self.pricing.lock().unwrap().status(now)
    }
}

#[cfg(all(test, unix))]
#[path = "service_tests.rs"]
mod tests;

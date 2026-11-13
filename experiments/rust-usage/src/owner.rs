//! In-memory token-usage owner. Inject scan, metadata and pricing; it never discovers profiles or performs I/O itself.
use crate::{report::build_report, scan::report_envelope};
use serde_json::{json, Value};
use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex, Weak},
};
pub const RESCAN_MS: i64 = 30_000;
pub const ATTRIBUTION_MS: i64 = 30_000;
pub const CHANGED: &str = "token-usage:changed";
pub type FutureResult<T> = Pin<Box<dyn Future<Output = Result<T, ()>> + Send>>;
pub type Scan = Arc<dyn Fn() -> FutureResult<ScanResult> + Send + Sync>;
pub type Emit = Arc<dyn Fn(&str, Value) + Send + Sync>;
pub type Projects = Arc<dyn Fn() -> FutureResult<Value> + Send + Sync>;
/// Return the complete current rows after scanning, including retained deleted files.
pub struct ScanResult {
    pub rows: Value,
    pub changed: bool,
}
pub struct TokenUsageOptions {
    pub scan: Scan,
    pub projects: Projects,
    /// Returns current models. The runtime may begin an independently injected pricing refresh here.
    pub prices: Arc<dyn Fn() -> Value + Send + Sync>,
    pub pricing_status: Arc<dyn Fn() -> Value + Send + Sync>,
    pub emit: Emit,
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
    pub home: String,
    pub worktree_root: String,
    pub default_time_zone: String,
}
struct State {
    rows: Value,
    scanning: bool,
    scanned_at: i64,
    finished: bool,
    projects: Option<(i64, Value)>,
}
pub struct TokenUsage {
    options: TokenUsageOptions,
    state: Mutex<State>,
    tasks: crate::supervisor::Supervisor,
}
struct ScanReset(Weak<TokenUsage>);
impl Drop for ScanReset {
    fn drop(&mut self) {
        if let Some(owner) = self.0.upgrade() {
            owner.state.lock().unwrap().scanning = false;
        }
    }
}
impl TokenUsage {
    pub fn new(options: TokenUsageOptions, cached_rows: Value, finished: bool) -> Arc<Self> {
        Arc::new(Self {
            options,
            state: Mutex::new(State { rows: cached_rows, scanning: false, scanned_at: 0, finished, projects: None }),
            tasks: crate::supervisor::Supervisor::default(),
        })
    }
    pub async fn read(self: &Arc<Self>, request: &Value) -> Result<Value, String> {
        let this = self.clone();
        let request = request.clone();
        self.tasks.run(async move { this.read_inner(&request).await }).await.map_err(|error| match error {
            crate::supervisor::TaskError::Stopped => "Token usage owner stopped".to_owned(),
            crate::supervisor::TaskError::Panicked => "Token usage callback panicked".to_owned(),
        })?
    }
    pub async fn shutdown(&self) {
        self.tasks.shutdown().await;
    }
    pub fn in_flight(&self) -> usize {
        self.tasks.active()
    }
    async fn read_inner(self: &Arc<Self>, request: &Value) -> Result<Value, String> {
        let now = (self.options.now)();
        let (first_scan, start) = {
            let mut state = self.state.lock().unwrap();
            let first = !state.finished;
            let start = !state.scanning && now - state.scanned_at >= RESCAN_MS;
            if start {
                state.scanning = true;
            }
            (first, start)
        };
        if start {
            let reset = ScanReset(Arc::downgrade(self));
            let this = self.clone();
            self.tasks
                .spawn(async move {
                    let result = crate::supervisor::guarded(async { (this.options.scan)().await }).await.ok().and_then(Result::ok);
                    let now = (this.options.now)();
                    let changed = {
                        let mut state = this.state.lock().unwrap();
                        match result {
                            Some(result) => {
                                state.rows = result.rows;
                                state.scanned_at = now;
                                state.finished = true;
                                result.changed
                            }
                            None => false,
                        }
                    };
                    drop(reset);
                    if changed {
                        let _ = crate::supervisor::guarded_sync(|| (this.options.emit)(CHANGED, json!({})));
                    }
                })
                .map_err(|_| "Token usage owner stopped")?;
        }
        // Node evaluates rows/prices before awaiting project metadata.
        let rows = self.state.lock().unwrap().rows.clone();
        let prices = crate::supervisor::guarded_sync(|| (self.options.prices)()).unwrap_or(Value::Null);
        let now = (self.options.now)();
        let cached = self.state.lock().unwrap().projects.clone().filter(|(at, _)| now - *at < ATTRIBUTION_MS);
        let projects = match cached {
            Some((_, projects)) => projects,
            None => {
                let projects = crate::supervisor::guarded(async { (self.options.projects)().await })
                    .await
                    .ok()
                    .and_then(Result::ok)
                    .unwrap_or(json!([]));
                let now = (self.options.now)();
                self.state.lock().unwrap().projects = Some((now, projects.clone()));
                projects
            }
        };
        let input = json!({"rows":rows,"prices":prices,"projects":projects,"range":request["range"],"days":request["days"],"timeZone":request["timeZone"],"now":(self.options.now)(),"home":self.options.home,"worktreeRoot":self.options.worktree_root,"defaultTimeZone":self.options.default_time_zone});
        let report = build_report(&input)?;
        let refreshing = self.state.lock().unwrap().scanning;
        let status = crate::supervisor::guarded_sync(|| (self.options.pricing_status)()).unwrap_or(json!({"status":"unavailable"}));
        Ok(report_envelope(report, refreshing, first_scan, status))
    }
}

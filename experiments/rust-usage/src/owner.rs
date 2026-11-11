//! In-memory token-usage owner. Inject scan, metadata and pricing; it never discovers profiles or performs I/O itself.
use crate::{report::build_report, scan::report_envelope};
use serde_json::{json, Value};
use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
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
}
impl TokenUsage {
    pub fn new(options: TokenUsageOptions, cached_rows: Value, finished: bool) -> Arc<Self> {
        Arc::new(Self { options, state: Mutex::new(State { rows: cached_rows, scanning: false, scanned_at: 0, finished, projects: None }) })
    }
    pub async fn read(self: &Arc<Self>, request: &Value) -> Result<Value, String> {
        let first_scan = {
            let mut state = self.state.lock().unwrap();
            let first = !state.finished;
            if !state.scanning && (self.options.now)() - state.scanned_at >= RESCAN_MS {
                state.scanning = true;
                let this = self.clone();
                tokio::spawn(async move {
                    let result = (this.options.scan)().await;
                    let changed = {
                        let mut state = this.state.lock().unwrap();
                        state.scanning = false;
                        match result {
                            Ok(result) => {
                                state.rows = result.rows;
                                state.scanned_at = (this.options.now)();
                                state.finished = true;
                                result.changed
                            }
                            Err(()) => false,
                        }
                    };
                    if changed {
                        (this.options.emit)(CHANGED, json!({}));
                    }
                });
            }
            first
        };
        // Node evaluates rows/prices before awaiting project metadata.
        let rows = self.state.lock().unwrap().rows.clone();
        let prices = (self.options.prices)();
        let cached = self.state.lock().unwrap().projects.clone().filter(|(at, _)| (self.options.now)() - *at < ATTRIBUTION_MS);
        let projects = match cached {
            Some((_, projects)) => projects,
            None => {
                let projects = (self.options.projects)().await.unwrap_or(json!([]));
                self.state.lock().unwrap().projects = Some(((self.options.now)(), projects.clone()));
                projects
            }
        };
        let input = json!({"rows":rows,"prices":prices,"projects":projects,"range":request["range"],"days":request["days"],"timeZone":request["timeZone"],"now":(self.options.now)(),"home":self.options.home,"worktreeRoot":self.options.worktree_root,"defaultTimeZone":self.options.default_time_zone});
        let report = build_report(&input)?;
        let refreshing = self.state.lock().unwrap().scanning;
        let status = (self.options.pricing_status)();
        Ok(report_envelope(report, refreshing, first_scan, status))
    }
}

//! Whitelisted quota persistence and per-provider request coalescing. Serialization is explicit; no disk I/O.
use crate::{
    limits::{banked, provider_result, with_last_good},
    util::*,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
};
pub const STORE_ORDER: [&str; 4] = ["kiro", "antigravity", "claude", "codex"];
pub const READ_ORDER: [&str; 4] = ["claude", "codex", "antigravity", "kiro"];
fn clean_last(last: &Value) -> Value {
    let Some(windows) = last["windows"].as_array().filter(|w| !w.is_empty()) else { return Value::Null };
    if date(&last["updatedAt"]).is_none() {
        return Value::Null;
    }
    let mut cleaned = Vec::new();
    for w in windows {
        if !["id", "label", "shortLabel"].iter().all(|key| w[*key].is_string()) || !w["usedPercent"].is_number() {
            return Value::Null;
        }
        cleaned.push(json!({"id":w["id"],"label":w["label"],"shortLabel":w["shortLabel"],"usedPercent":w["usedPercent"],"resetsAt":w["resetsAt"].as_str()}));
    }
    let mut v = json!({"windows":cleaned,"updatedAt":last["updatedAt"]});
    if let Some(n) = banked(&last["bankedResets"]) {
        v["bankedResets"] = n;
    }
    v
}
fn clean_blocked(v: &Value) -> Value {
    if !v["until"].is_number() {
        return Value::Null;
    }
    json!({"until":v["until"],"message":v["message"].as_str().unwrap_or("Claude is rate limiting usage checks.")})
}
#[derive(Clone, Debug)]
pub struct UsageStore {
    state: Value,
}
impl Default for UsageStore {
    fn default() -> Self {
        Self::from_json(&Value::Null)
    }
}
impl UsageStore {
    pub fn from_json(v: &Value) -> Self {
        let mut state = json!({});
        for p in STORE_ORDER {
            state[p] = json!({"last":clean_last(&v[p]["last"]),"blocked":clean_blocked(&v[p]["blocked"])});
        }
        Self { state }
    }
    pub fn to_json(&self) -> Value {
        self.state.clone()
    }
    pub fn get(&self, p: &str) -> Value {
        self.state.get(p).cloned().unwrap_or(json!({"last":null,"blocked":null}))
    }
    pub fn set_last(&mut self, p: &str, v: &Value) {
        let clean = clean_last(v);
        if STORE_ORDER.contains(&p) && !clean.is_null() {
            self.state[p]["last"] = clean;
        }
    }
    pub fn set_blocked(&mut self, p: &str, v: &Value) {
        if STORE_ORDER.contains(&p) {
            self.state[p]["blocked"] = clean_blocked(v);
        }
    }
    pub fn snapshot(&self, now: i64) -> Value {
        let providers: Vec<_> = STORE_ORDER
            .into_iter()
            .filter_map(|p| {
                let last = &self.state[p]["last"];
                let windows: Vec<_> = array(&last["windows"]).iter().filter(|w| live(w, now)).cloned().collect();
                if windows.is_empty() {
                    return None;
                }
                let mut v = json!({"provider":p,"status":"ok","windows":windows,"updatedAt":last["updatedAt"]});
                if let Some(n) = banked(&last["bankedResets"]) {
                    v["bankedResets"] = n;
                }
                Some(v)
            })
            .collect();
        json!({"providers":providers})
    }
}
/// State machine used by the async reader. begin returns a cached block response, otherwise call complete with the read.
#[derive(Default)]
pub struct UsageState {
    pub store: UsageStore,
    latest: HashMap<String, Value>,
    checked: HashMap<String, String>,
}
impl UsageState {
    pub fn new(store: UsageStore) -> Self {
        Self { store, ..Default::default() }
    }
    pub fn begin(&self, p: &str, now: i64) -> Option<Value> {
        let entry = self.store.get(p);
        let blocked = &entry["blocked"];
        (blocked["until"].as_f64().is_some_and(|until| (now as f64) < until))
            .then(|| provider_result(p, now, "error", json!([]), blocked["message"].as_str()))
    }
    pub fn complete(&mut self, p: &str, result: Value, now: i64, was_blocked: bool) -> Value {
        if !was_blocked {
            self.store.set_blocked(
                p,
                &if positive(&result["retryAfterMs"]) > 0. {
                    json!({"until":now as f64+positive(&result["retryAfterMs"]),"message":result["message"]})
                } else {
                    Value::Null
                },
            );
            if result["status"] == "ok" {
                self.store.set_last(p, &result);
            }
        }
        let result = with_last_good(result, &self.store.get(p)["last"], now);
        self.latest.insert(p.into(), result.clone());
        self.checked.insert(p.into(), iso(now));
        result
    }
    pub fn cached(&self, p: &str, now: i64) -> Option<Value> {
        if let Some(v) = self.latest.get(p) {
            let mut v = v.clone();
            v["windows"] = json!(array(&v["windows"]).iter().filter(|w| live(w, now)).cloned().collect::<Vec<_>>());
            Some(v)
        } else {
            array(&self.store.snapshot(now)["providers"]).iter().find(|v| v["provider"] == p).cloned()
        }
    }
    pub fn checked_at(&self, p: &str) -> Option<&str> {
        self.checked.get(p).map(String::as_str)
    }
}
pub type ReadFuture = Pin<Box<dyn Future<Output = Result<Value, ()>> + Send>>;
pub type ProviderRead = Arc<dyn Fn(String) -> ReadFuture + Send + Sync>;
pub type Ready = Arc<dyn Fn() -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;
/// One detached task per provider means cancelling a caller cannot strand the shared read. The runtime injects readiness.
pub struct UsageReader {
    state: Mutex<UsageState>,
    pending: Mutex<HashMap<String, tokio::sync::watch::Receiver<Option<Value>>>>,
    read: ProviderRead,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
    ready: Ready,
    environment: tokio::sync::OnceCell<()>,
}
impl UsageReader {
    pub fn new(store: UsageStore, read: ProviderRead, now: Arc<dyn Fn() -> i64 + Send + Sync>, ready: Ready) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(UsageState::new(store)),
            pending: Mutex::new(HashMap::new()),
            read,
            now,
            ready,
            environment: tokio::sync::OnceCell::new(),
        })
    }
    pub async fn provider(self: &Arc<Self>, p: &str) -> Result<Value, &'static str> {
        if !READ_ORDER.contains(&p) {
            return Err("Unknown usage provider");
        }
        let mut receiver = {
            let mut pending = self.pending.lock().unwrap();
            pending
                .entry(p.into())
                .or_insert_with(|| {
                    let (tx, rx) = tokio::sync::watch::channel(None);
                    let this = self.clone();
                    let p = p.to_owned();
                    tokio::spawn(async move {
                        this.environment.get_or_init(|| (this.ready)()).await;
                        let blocked = this.state.lock().unwrap().begin(&p, (this.now)());
                        let was_blocked = blocked.is_some();
                        let result = match blocked {
                            Some(v) => v,
                            None => (this.read)(p.clone())
                                .await
                                .unwrap_or_else(|_| provider_result(&p, (this.now)(), "error", json!([]), Some("Couldn't read usage."))),
                        };
                        let result = this.state.lock().unwrap().complete(&p, result, (this.now)(), was_blocked);
                        let mut pending = this.pending.lock().unwrap();
                        let _ = tx.send(Some(result));
                        pending.remove(&p);
                    });
                    rx
                })
                .clone()
        };
        loop {
            if let Some(v) = receiver.borrow().clone() {
                return Ok(v);
            }
            if receiver.changed().await.is_err() {
                return Err("Usage reader stopped");
            }
        }
    }
    pub async fn read(self: &Arc<Self>) -> Value {
        let (a, b, c, d) =
            tokio::join!(self.provider("claude"), self.provider("codex"), self.provider("antigravity"), self.provider("kiro"));
        json!({"providers":[a.unwrap(),b.unwrap(),c.unwrap(),d.unwrap()]})
    }
    pub fn cached(&self, p: &str) -> Option<Value> {
        self.state.lock().unwrap().cached(p, (self.now)())
    }
    pub fn checked_at(&self, p: &str) -> Option<String> {
        self.state.lock().unwrap().checked_at(p).map(str::to_owned)
    }
    pub fn store_json(&self) -> Value {
        self.state.lock().unwrap().store.to_json()
    }
}

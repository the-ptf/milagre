//! Owner-facing usage commands. Account metadata comes only from trusted injected snapshots, never renderer objects.
use crate::{
    limits::provider_result,
    store::{ReadFuture, Ready, UsageReader, UsageStore},
    supervisor::{guarded, guarded_sync, Supervisor},
    util::iso,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
};
pub const COMMANDS: [&str; 4] = ["usage:read", "usage:cached", "usage:accounts:read", "usage:accounts:cached"];
pub const CHANGED: &str = "usage:changed";
pub type MetadataFuture<T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send>>;
type BorrowedFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'a>>;
pub type AccountRead = Arc<dyn Fn(String, String) -> ReadFuture + Send + Sync>;
pub type AsyncStoreLoad = Arc<dyn Fn(Selection) -> MetadataFuture<UsageStore> + Send + Sync>;
pub type StoreLoad = Arc<dyn Fn(&Selection) -> Result<UsageStore, String> + Send + Sync>;
pub type Selected = Arc<dyn Fn(Option<&str>) -> Selection + Send + Sync>;
pub type Emit = Arc<dyn Fn(&str, Value) + Send + Sync>;
/// IDs already resolved by rust-accounts for a validated scope. Kiro is always default.
#[derive(Clone, Debug, Hash, PartialEq, Eq, Serialize, Deserialize)]
pub struct Selection {
    pub claude: String,
    pub codex: String,
    pub antigravity: String,
}
impl Default for Selection {
    fn default() -> Self {
        Self { claude: "default".into(), codex: "default".into(), antigravity: "default".into() }
    }
}
impl Selection {
    pub fn account_key(&self) -> String {
        format!(
            "{}-{}{}",
            self.claude,
            self.codex,
            if self.antigravity == "default" { String::new() } else { format!("-{}", self.antigravity) }
        )
    }
    pub fn id(&self, p: &str) -> &str {
        match p {
            "claude" => &self.claude,
            "codex" => &self.codex,
            "antigravity" => &self.antigravity,
            _ => "default",
        }
    }
    fn pinned(provider: &str, id: &str) -> Self {
        let mut s = Self::default();
        match provider {
            "claude" => s.claude = id.into(),
            "codex" => s.codex = id.into(),
            "antigravity" => s.antigravity = id.into(),
            _ => {}
        }
        s
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub provider: String,
    pub id: String,
    pub label: String,
    pub state: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAccounts {
    pub provider: String,
    pub selected_id: String,
    #[serde(default)]
    pub installed: Option<bool>,
    pub accounts: Vec<Account>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AccountSnapshot {
    pub providers: Vec<ProviderAccounts>,
}
pub struct UsageAccountsOptions {
    /// Equivalent of accountScopes(): only currently authorized Project/Link keys, including Chats home when present.
    pub scopes: Arc<dyn Fn() -> MetadataFuture<Vec<String>> + Send + Sync>,
    /// Synchronous capture after readiness. None means computer defaults. No environment values or credentials.
    pub selected: Selected,
    pub list: Arc<dyn Fn() -> MetadataFuture<AccountSnapshot> + Send + Sync>,
    /// Resolve the pinned ID at invocation, not a mutable current default.
    pub read: AccountRead,
    pub ready: Ready,
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
    pub emit: Emit,
    /// Node's injected runtime test/demo readUsage override: scope validated, no readiness/decorating/event.
    pub read_usage_override: Option<Arc<dyn Fn() -> MetadataFuture<Value> + Send + Sync>>,
}
pub struct UsageAccounts {
    #[cfg(feature = "fixture-admission")]
    admission: Option<Arc<dyn crate::admission::Admission>>,
    options: UsageAccountsOptions,
    readers: Mutex<HashMap<Selection, Arc<UsageReader>>>,
    seeds: Mutex<HashMap<Selection, UsageStore>>,
    load_store: Option<StoreLoad>,
    async_load: Option<AsyncStoreLoad>,
    load_gates: Mutex<HashMap<Selection, Arc<tokio::sync::Mutex<()>>>>,
    environment: Arc<tokio::sync::OnceCell<()>>,
    tasks: Supervisor,
}
impl UsageAccounts {
    pub fn new(options: UsageAccountsOptions, seeds: HashMap<Selection, UsageStore>) -> Arc<Self> {
        Self::with_store_loader(options, seeds, None)
    }
    /// Optional trusted lazy loader for selections first encountered after startup. Errors remain retryable.
    pub fn with_store_loader(
        options: UsageAccountsOptions,
        seeds: HashMap<Selection, UsageStore>,
        load_store: Option<StoreLoad>,
    ) -> Arc<Self> {
        Arc::new(Self {
            options,
            #[cfg(feature = "fixture-admission")]
            admission: None,
            load_store,
            async_load: None,
            load_gates: Mutex::new(HashMap::new()),
            readers: Mutex::new(HashMap::new()),
            seeds: Mutex::new(seeds),
            environment: Arc::new(tokio::sync::OnceCell::new()),
            tasks: Supervisor::default(),
        })
    }
    pub fn with_async_store_loader(options: UsageAccountsOptions, load: AsyncStoreLoad) -> Arc<Self> {
        let mut owner = Self::with_store_loader(options, HashMap::new(), None);
        Arc::get_mut(&mut owner).unwrap().async_load = Some(load);
        owner
    }
    #[cfg(feature = "fixture-admission")]
    pub fn with_admission(
        options: UsageAccountsOptions,
        seeds: HashMap<Selection, UsageStore>,
        admission: Arc<dyn crate::admission::Admission>,
    ) -> Arc<Self> {
        assert!(options.read_usage_override.is_none(), "admitted readers cannot bypass admission");
        let mut owner = Self::new(options, seeds);
        Arc::get_mut(&mut owner).unwrap().admission = Some(admission);
        owner
    }
    async fn ready(&self) {
        let _ = self
            .environment
            .get_or_init(|| async {
                let _ = guarded(async { (self.options.ready)().await }).await;
            })
            .await;
    }
    async fn reader(&self, selection: &Selection) -> Result<Arc<UsageReader>, String> {
        if let Some(reader) = self.readers.lock().unwrap().get(selection).cloned() {
            return Ok(reader);
        }
        let gate = self.load_gates.lock().unwrap().entry(selection.clone()).or_default().clone();
        let _guard = gate.lock().await;
        if let Some(reader) = self.readers.lock().unwrap().get(selection).cloned() {
            return Ok(reader);
        }
        let seed = self.seeds.lock().unwrap().remove(selection);
        let seed = match seed {
            Some(seed) => seed,
            None if self.async_load.is_some() => guarded(async { (self.async_load.as_ref().unwrap())(selection.clone()).await })
                .await
                .map_err(|_| "Usage cache loader panicked".to_owned())??,
            None => match &self.load_store {
                Some(load) => guarded_sync(|| load(selection)).map_err(|_| "Usage cache loader panicked".to_owned())??,
                None => UsageStore::default(),
            },
        };
        let pinned = selection.clone();
        let read = self.options.read.clone();
        let environment = self.environment.clone();
        let ready = self.options.ready.clone();
        let reader = UsageReader::new(
            seed,
            Arc::new(move |provider| {
                let id = pinned.id(&provider).to_owned();
                read(provider, id)
            }),
            self.options.now.clone(),
            Arc::new(move || {
                let environment = environment.clone();
                let ready = ready.clone();
                Box::pin(async move {
                    environment
                        .get_or_init(|| async {
                            let _ = guarded(async { ready().await }).await;
                        })
                        .await;
                })
            }),
        );
        #[cfg(feature = "fixture-admission")]
        let reader = if let Some(admission) = &self.admission { reader.admitted(admission.clone(), selection.clone()) } else { reader };
        self.readers.lock().unwrap().insert(selection.clone(), reader.clone());
        Ok(reader)
    }
    async fn validate_scope(&self, value: &Value) -> Result<Option<String>, String> {
        if value.is_null() {
            return Ok(None);
        }
        let key = value.as_str().filter(|s| !s.is_empty()).ok_or("Choose a valid Project or Link.")?;
        if !(self.options.scopes)().await?.iter().any(|scope| scope == key) {
            return Err("Project or Link is no longer available. Refresh and choose another.".into());
        }
        Ok(Some(key.into()))
    }
    /// Scope is the command's first positional argument; accounts commands ignore it, as Node does.
    pub async fn handle(self: &Arc<Self>, command: &str, scope: &Value) -> Result<Value, String> {
        if !COMMANDS.contains(&command) {
            return Err(format!("Unknown usage command: {command}"));
        }
        let this = self.clone();
        let command = command.to_owned();
        let scope = scope.clone();
        self.tasks.run(async move { this.handle_inner(&command, &scope).await }).await.map_err(|e| {
            match e {
                crate::supervisor::TaskError::Stopped => "Usage owner stopped",
                crate::supervisor::TaskError::Panicked => "Couldn't read usage.",
            }
            .to_owned()
        })?
    }
    async fn handle_inner(&self, command: &str, scope: &Value) -> Result<Value, String> {
        #[cfg(feature = "fixture-admission")]
        if let Some(admission) = &self.admission {
            admission.check(crate::admission::Target::Command { all_accounts: command.starts_with("usage:accounts:") }).await?;
        }
        if command.starts_with("usage:accounts:") {
            let refresh = command == "usage:accounts:read";
            if refresh {
                self.ready().await;
            }
            let snapshot = self.all_accounts(refresh).await?;
            return self.finish(snapshot, refresh.then(|| json!({})), true).await;
        }
        let scope = self.validate_scope(scope).await?;
        let refresh = command == "usage:read";
        if refresh {
            if let Some(read) = &self.options.read_usage_override {
                return read().await;
            }
            self.ready().await;
        }
        let selection = (self.options.selected)(scope.as_deref());
        let reader = self.reader(&selection).await?;
        let mut snapshot = if refresh { reader.read().await } else { reader.store_snapshot((self.options.now)()) };
        let identities = (self.options.list)().await?;
        snapshot["accountKey"] = json!(selection.account_key());
        for provider in snapshot["providers"].as_array_mut().expect("usage snapshot") {
            let p = provider["provider"].as_str().unwrap_or("");
            let id = selection.id(p);
            let account = identities.providers.iter().find(|g| g.provider == p).and_then(|g| g.accounts.iter().find(|a| a.id == id));
            let mut decoration =
                json!({"id":id,"label":account.map(|a|a.label.as_str()).filter(|s|!s.is_empty()).unwrap_or("Removed account")});
            if let Some(email) = account.and_then(|a| a.email.as_ref()).filter(|s| !s.is_empty()) {
                decoration["email"] = json!(email);
            }
            provider["account"] = decoration;
        }
        let event = refresh.then(|| scope.map(|key| json!({"scopeKey":key})).unwrap_or(json!({})));
        self.finish(snapshot, event, false).await
    }
    async fn finish(&self, snapshot: Value, event: Option<Value>, _all_accounts: bool) -> Result<Value, String> {
        let emit = self.options.emit.clone();
        let apply = move || {
            if let Some(event) = event {
                let _ = guarded_sync(|| emit(CHANGED, event));
            }
            snapshot
        };
        #[cfg(feature = "fixture-admission")]
        if let Some(admission) = &self.admission {
            return admission.commit(crate::admission::Target::Command { all_accounts: _all_accounts }, Box::new(apply)).await;
        }
        Ok(apply())
    }
    async fn all_accounts(&self, refresh: bool) -> Result<Value, String> {
        let identities = (self.options.list)().await?;
        let connected: Vec<_> = identities
            .providers
            .iter()
            .filter(|g| g.installed != Some(false))
            .flat_map(|g| {
                g.accounts.iter().cloned().map(|a| {
                    let default = a.id == g.selected_id;
                    (a, default)
                })
            })
            .collect();
        // Futures are polled together in input order, like Promise.all, without untracked child tasks.
        let futures: Vec<_> = connected
            .iter()
            .map(|(account, default)| {
                let account = account.clone();
                let default = *default;
                let selection = Selection::pinned(&account.provider, &account.id);
                Box::pin(async move {
                    let reader = self.reader(&selection).await?;
                    let result = if account.state == "ready" {
                        if refresh {
                            Some(reader.provider(&account.provider).await.map_err(str::to_owned)?)
                        } else {
                            reader.cached(&account.provider)
                        }
                    } else {
                        None
                    };
                    let message = account.message.as_deref().filter(|s| !s.is_empty()).unwrap_or(match account.state.as_str() {
                        "ready" => "Refresh to check usage.",
                        "unknown" => "Checking account sign-in…",
                        _ => "Account is not signed in.",
                    });
                    let mut result = result.unwrap_or_else(|| {
                        provider_result(&account.provider, (self.options.now)(), "unavailable", json!([]), Some(message))
                    });
                    if let Some(at) = reader.checked_at(&account.provider) {
                        result["checkedAt"] = json!(at);
                    }
                    let mut decoration = json!({"id":account.id,"label":account.label,"state":account.state});
                    if default {
                        decoration["default"] = json!(true);
                    }
                    if let Some(email) = account.email.filter(|s| !s.is_empty()) {
                        decoration["email"] = json!(email);
                    }
                    result["account"] = decoration;
                    Ok::<Value, String>(result)
                }) as BorrowedFuture<'_, Value>
            })
            .collect();
        let providers = join_ordered(futures).await?;
        let mut keys: Vec<_> = connected.iter().map(|(a, _)| format!("{}:{}:{}", a.provider, a.id, a.state)).collect();
        keys.sort_by_key(|s| s.encode_utf16().collect::<Vec<_>>());
        Ok(json!({"generatedAt":iso((self.options.now)()),"accountKey":format!("all:{}",keys.join(",")),"providers":providers}))
    }
    /// Export each isolated store without performing filesystem writes. Selection is structural, not a filename.
    pub fn stores(&self) -> Vec<(Selection, Value)> {
        let readers = self.readers.lock().unwrap();
        let mut stores: Vec<_> = self.seeds.lock().unwrap().iter().map(|(s, store)| (s.clone(), store.to_json())).collect();
        stores.extend(readers.iter().map(|(s, r)| (s.clone(), r.store_json())));
        stores
    }
    pub async fn shutdown(&self) {
        self.tasks.shutdown().await;
        let readers: Vec<_> = self.readers.lock().unwrap().values().cloned().collect();
        for reader in readers {
            reader.shutdown().await;
        }
    }
    pub fn in_flight(&self) -> usize {
        self.tasks.active() + self.readers.lock().unwrap().values().map(|r| r.in_flight()).sum::<usize>()
    }
}
async fn join_ordered<T>(mut futures: Vec<BorrowedFuture<'_, T>>) -> Result<Vec<T>, String> {
    let mut results: Vec<Option<T>> = (0..futures.len()).map(|_| None).collect();
    std::future::poll_fn(move |cx| {
        for (i, f) in futures.iter_mut().enumerate() {
            if results[i].is_some() {
                continue;
            }
            match f.as_mut().poll(cx) {
                std::task::Poll::Ready(Ok(v)) => results[i] = Some(v),
                std::task::Poll::Ready(Err(e)) => return std::task::Poll::Ready(Err(e)),
                std::task::Poll::Pending => {}
            }
        }
        if results.iter().all(Option::is_some) {
            std::task::Poll::Ready(Ok(results.iter_mut().map(|r| r.take().unwrap()).collect()))
        } else {
            std::task::Poll::Pending
        }
    })
    .await
}

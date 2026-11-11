use crate::pinned::{Directory, FixtureFile, MAX_FILE};
use milagre_accounts::{AccountSandbox, AccountService, EnvironmentContext, IdentityState};
use milagre_owner_store::{Isolation, Policy};
use milagre_registry::{
    writer::{RegistryCopy, Seeds, Writer},
    LinkGrant, ProjectGrant, Registry, Snapshot,
};
use milagre_usage::{
    accounts::{AccountSnapshot, Selection, UsageAccounts, UsageAccountsOptions},
    admission::{Admission, Apply, Target},
    persistence::{CacheOwner, TempCache},
    store::{UsageStore, READ_ORDER},
};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, Weak,
    },
};
use tokio::sync::{mpsc, oneshot, watch, Semaphore};
type Result<T> = std::result::Result<T, String>;
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn label(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
const MAX_SESSIONS: usize = 32;
#[derive(Clone)]
pub struct SyntheticQuota {
    pub provider: String,
    pub account: String,
    pub result: Value,
}
pub struct SyntheticSeed {
    pub accounts: Option<String>,
    pub projects: Vec<String>,
    pub links: Vec<(String, Vec<String>)>,
    pub quotas: Vec<SyntheticQuota>,
    /// Explicit trusted synthetic observations; preparation is never readiness.
    pub observations: Vec<(String, String, IdentityState)>,
    pub now: i64,
}
#[derive(Clone, Debug)]
pub enum FixtureScope {
    Computer,
    Project(String),
    Link(String),
}
#[derive(Clone, Copy)]
pub enum QuotaCommand {
    Read,
    Cached,
    AccountsRead,
    AccountsCached,
}
impl QuotaCommand {
    fn wire(self) -> &'static str {
        match self {
            Self::Read => "usage:read",
            Self::Cached => "usage:cached",
            Self::AccountsRead => "usage:accounts:read",
            Self::AccountsCached => "usage:accounts:cached",
        }
    }
}
pub enum FixtureMutation {
    Observe { provider: String, account: String, state: IdentityState },
    Select { provider: String, account: String },
    Assign { scope: FixtureScope, provider: String, account: Option<String> },
    Remove { provider: String, account: String },
    Position { project: String, x: i64, y: i64 },
    DeleteLink(String),
    CloseAccounts,
}
/// Owns the authority actor. No method accepts renderer-supplied owner IDs, generations or proofs.
pub struct FixtureOwner {
    tx: mpsc::Sender<Request>,
    done: watch::Receiver<Option<Result<()>>>,
    workers: Arc<Semaphore>,
    _cache: TempCache,
}
pub struct FixtureSession {
    owner: Arc<FixtureOwner>,
    accounts: Arc<UsageAccounts>,
    scope: Value,
}
struct Bridge {
    owner: Weak<FixtureOwner>,
    session: u64,
}
struct ReadTicket {
    file: Arc<FixtureFile>,
    #[cfg(test)]
    pause: Option<Arc<Pause>>,
    #[cfg(test)]
    blocking: Option<Arc<BlockingPause>>,
}
#[cfg(test)]
struct Pause {
    entered: Semaphore,
    resume: Semaphore,
}
#[cfg(test)]
struct BlockingPause {
    entered: Semaphore,
    released: Mutex<bool>,
    wake: std::sync::Condvar,
}
#[cfg(test)]
impl BlockingPause {
    fn wait(&self) {
        self.entered.add_permits(1);
        let mut released = self.released.lock().unwrap();
        while !*released {
            released = self.wake.wait(released).unwrap();
        }
    }
    fn release(&self) {
        *self.released.lock().unwrap() = true;
        self.wake.notify_all();
    }
}
enum Request {
    Capture(FixtureScope, oneshot::Sender<Result<(u64, Arc<UsageAccounts>, Value)>>),
    Check(u64, Target, Option<Apply>, oneshot::Sender<Result<Value>>),
    List(u64, oneshot::Sender<Result<AccountSnapshot>>),
    Read(u64, String, String, oneshot::Sender<Result<ReadTicket>>),
    Mutate(FixtureMutation, oneshot::Sender<Result<()>>),
    Close(oneshot::Sender<Result<()>>),
    #[cfg(test)]
    Block(String, Arc<BlockingPause>, oneshot::Sender<()>),
    #[cfg(test)]
    Pause(String, Arc<Pause>, oneshot::Sender<()>),
    #[cfg(test)]
    SeedHistory(Selection, Value, oneshot::Sender<Result<()>>),
    #[cfg(test)]
    Trace(oneshot::Sender<(Vec<Value>, Vec<Value>)>),
    #[cfg(test)]
    Inspect(oneshot::Sender<(Vec<Value>, HashMap<Selection, Value>)>),
    #[cfg(test)]
    Paths(oneshot::Sender<(PathBuf, PathBuf)>),
}
struct Captured {
    owner: String,
    generation: u64,
    readiness: u64,
    selection: Selection,
    pinned: milagre_accounts::Selection,
    scope: Option<String>,
    snapshot: Snapshot,
    grant: Grant,
    accounts: Arc<UsageAccounts>,
}
enum Grant {
    Computer,
    Project(ProjectGrant, PathBuf),
    Link(LinkGrant),
}
struct State {
    temp: Option<tempfile::TempDir>,
    root: Directory,
    context: EnvironmentContext,
    sandbox: AccountSandbox,
    account_root: Directory,
    accounts: AccountService,
    registry: Registry,
    writer: Option<Writer>,
    _registry_copy: RegistryCopy,
    active: Arc<AtomicBool>,
    projects: BTreeMap<String, PathBuf>,
    directories: Vec<Directory>,
    files: BTreeMap<(String, String), Arc<FixtureFile>>,
    readiness: u64,
    sessions: BTreeMap<u64, Captured>,
    next: u64,
    closed: bool,
    handle: Weak<FixtureOwner>,
    cache: Arc<CacheOwner>,
    stores: HashMap<Selection, Value>,
    events: Arc<Mutex<Vec<Value>>>,
    now: i64,
    #[cfg(test)]
    calls: Vec<Value>,
    #[cfg(test)]
    blocking: HashMap<String, Arc<BlockingPause>>,
    #[cfg(test)]
    pauses: HashMap<String, Arc<Pause>>,
}
impl Drop for State {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
        self.accounts.close();
        if self.account_root.check().is_ok() {
            let _ = fs::remove_dir_all(self.sandbox.path());
        }
        if self.root.check().is_err() {
            if let Some(temp) = self.temp.take() {
                let _ = temp.keep();
            }
        }
    }
}
impl State {
    fn create(seed: SyntheticSeed, cache: Arc<CacheOwner>, handle: Weak<FixtureOwner>) -> Result<Self> {
        if seed.projects.len() > 16
            || seed.links.len() > 16
            || seed.quotas.len() > 32
            || seed.observations.len() > 32
            || seed.accounts.as_ref().is_some_and(|s| s.len() > 1024 * 1024)
        {
            return Err("Fixture seed limit exceeded".into());
        }
        let temp = tempfile::Builder::new().prefix("usage-trusted-fixture-").tempdir_in("/tmp").map_err(err)?;
        let base = fs::canonicalize(temp.path()).map_err(err)?;
        // Explicit empty policy is only for this newly created, owned temporary root. Never Policy::system().
        let isolation = Isolation::create(&base, &Policy::default()).map_err(err)?;
        let root = Directory::pin(&base).map_err(err)?;
        for dir in ["projects", "home", "data"] {
            fs::create_dir(base.join(dir)).map_err(err)?;
        }
        let context = EnvironmentContext {
            home: base.join("home").to_string_lossy().into(),
            data_dir: base.join("data").to_string_lossy().into(),
            cwd: base.to_string_lossy().into(),
            env: BTreeMap::new(),
        };
        let mut projects = BTreeMap::new();
        for name in seed.projects {
            if !label(&name) || projects.contains_key(&name) {
                return Err("Invalid fixture Project name".into());
            }
            let path = base.join("projects").join(&name);
            fs::create_dir(&path).map_err(err)?;
            projects.insert(name, path);
        }
        let rows: Vec<_> = projects.iter().map(|(name, p)| json!({"id":p,"path":p,"name":name})).collect();
        let mut links = Vec::new();
        for (id, members) in seed.links {
            let members: Result<Vec<_>> =
                members.iter().map(|m| projects.get(m).cloned().ok_or("Unknown fixture Project".into())).collect();
            let group = json!({"id":id,"name":"Fixture Link","projectIds":members?});
            if !milagre_registry::links::valid_group(&group) {
                return Err("Invalid fixture Link".into());
            }
            links.push(group);
        }
        let copy = RegistryCopy::create(
            isolation,
            Seeds {
                registry: Some(serde_json::to_vec(&json!({"scanned":true,"projects":rows,"projectGroups":links,"links":[]})).map_err(err)?),
                recent: None,
            },
        )
        .map_err(err)?;
        let active = Arc::new(AtomicBool::new(true));
        let flag = active.clone();
        let check: milagre_registry::Active =
            Arc::new(move || if flag.load(Ordering::Acquire) { Ok(()) } else { Err("Fixture owner closed".into()) });
        let registry = copy.reader(check.clone()).map_err(err)?;
        let writer = copy.writer(check, Arc::new(|| "2026-10-30T00:00:00.000Z".into())).map_err(err)?;
        let sandbox = AccountSandbox::create(seed.accounts.as_deref()).map_err(err)?;
        let account_root = Directory::pin(sandbox.path()).map_err(err)?;
        let accounts = sandbox.open().map_err(err)?;
        let mut state = Self {
            temp: Some(temp),
            root,
            context,
            sandbox,
            account_root,
            accounts,
            registry,
            writer: Some(writer),
            _registry_copy: copy,
            active,
            projects,
            directories: vec![],
            files: BTreeMap::new(),
            readiness: 0,
            sessions: BTreeMap::new(),
            next: 0,
            closed: false,
            handle,
            cache,
            stores: HashMap::new(),
            events: Arc::new(Mutex::new(vec![])),
            now: seed.now,
            #[cfg(test)]
            calls: Vec::new(),
            #[cfg(test)]
            pauses: HashMap::new(),
            #[cfg(test)]
            blocking: HashMap::new(),
        };
        let count = state.accounts.snapshot().map_err(err)?["providers"]
            .as_array()
            .ok_or("Invalid account snapshot")?
            .iter()
            .map(|g| g["accounts"].as_array().map_or(0, Vec::len))
            .sum::<usize>();
        if count > 32 {
            return Err("Fixture account limit exceeded".into());
        }
        for path in [&state.context.home, &state.context.data_dir, &state.context.cwd] {
            state.directories.push(Directory::pin(std::path::Path::new(path)).map_err(err)?);
        }
        for path in state.projects.values() {
            state.directories.push(Directory::pin(path).map_err(err)?);
        }
        state.directories.push(Directory::pin(state._registry_copy.path()).map_err(err)?);
        for quota in seed.quotas {
            state.accounts.accounts().map_err(err)?.account(&quota.provider, &quota.account).map_err(err)?;
            let key = (quota.provider.clone(), quota.account.clone());
            if state.files.contains_key(&key) {
                return Err("Duplicate fixture binding".into());
            }
            if quota.result["provider"] != quota.provider {
                return Err("Fixture provider mismatch".into());
            }
            let path = PathBuf::from(state.context.directory(&quota.provider, &quota.account).map_err(err)?);
            if !path.starts_with(&base) {
                return Err("Fixture directory escaped owned root".into());
            }
            fs::create_dir_all(&path).map_err(err)?;
            let bytes = serde_json::to_vec(&quota.result).map_err(err)?;
            if bytes.len() as u64 > MAX_FILE {
                return Err("Fixture file limit exceeded".into());
            }
            let file_path = path.join("quota.json");
            use std::io::Write;
            fs::OpenOptions::new().write(true).create_new(true).open(file_path).map_err(err)?.write_all(&bytes).map_err(err)?;
            let directory = Directory::pin(&path).map_err(err)?;
            let file = Arc::new(directory.fixture(&bytes).map_err(err)?);
            state.files.insert(key, file);
            state.directories.push(directory);
        }
        for (provider, account, identity) in seed.observations {
            state.observe(&provider, &account, identity)?;
        }
        Ok(state)
    }
    fn observe(&mut self, p: &str, id: &str, state: IdentityState) -> Result<milagre_accounts::Readiness> {
        let ticket = self.accounts.begin_observation(p, id).map_err(err)?;
        let proof = self.accounts.observed(ticket, state).map_err(err)?;
        self.readiness = self.readiness.checked_add(1).ok_or("Readiness epoch exhausted")?;
        Ok(proof)
    }
    fn ready_proof(&mut self, provider: &str, account: &str) -> Result<milagre_accounts::Readiness> {
        let snapshot = self.accounts.snapshot().map_err(err)?;
        let ready = snapshot["providers"]
            .as_array()
            .and_then(|groups| groups.iter().find(|g| g["provider"] == provider))
            .and_then(|g| g["accounts"].as_array())
            .and_then(|accounts| accounts.iter().find(|a| a["id"] == account))
            .is_some_and(|a| a["state"] == "ready");
        if !ready {
            return Err("Account is not ready".into());
        }
        // Refresh a consumed, non-cloneable proof only from the service's explicit observation.
        self.observe(provider, account, IdentityState::Ready)
    }
    fn scope_key(&self, scope: &FixtureScope) -> Result<Option<String>> {
        Ok(match scope {
            FixtureScope::Computer => None,
            FixtureScope::Project(name) => Some(self.projects.get(name).ok_or("Unknown fixture Project")?.to_string_lossy().into()),
            FixtureScope::Link(id) => Some(format!("milagre-link:{id}")),
        })
    }
    fn live(&self) -> Result<()> {
        if self.closed {
            return Err("Fixture owner closed".into());
        }
        self.root.check().map_err(err)?;
        self.account_root.check().map_err(err)?;
        for directory in &self.directories {
            directory.check().map_err(err)?;
        }
        self.accounts.owner_id().map_err(err)?;
        Ok(())
    }
    async fn validate(&self, id: u64, target: &Target) -> Result<()> {
        self.live()?;
        let session = self.sessions.get(&id).ok_or("Unknown fixture session")?;
        if self.accounts.owner_id().map_err(err)?.to_string() != session.owner
            || self.accounts.generation().map_err(err)? != session.generation
            || self.readiness != session.readiness
        {
            return Err("Fixture authority revoked; capture again".into());
        }
        if self.accounts.pin(session.scope.as_deref()).map_err(err)? != session.pinned {
            return Err("Pinned selection changed".into());
        }
        session.snapshot.check()?;
        match &session.grant {
            Grant::Computer => {}
            Grant::Project(g, p) => {
                if !g.contains_folder(p).await? {
                    return Err("Project revoked".into());
                }
            }
            Grant::Link(g) => g.check().await?,
        }
        let snapshot = self.accounts.snapshot().map_err(err)?;
        let mut required = Vec::new();
        match target {
            Target::Command { all_accounts: true } => {
                for group in snapshot["providers"].as_array().ok_or("Invalid account snapshot")? {
                    for account in group["accounts"].as_array().ok_or("Invalid accounts")? {
                        required.push((
                            group["provider"].as_str().ok_or("Invalid provider")?.to_owned(),
                            account["id"].as_str().ok_or("Invalid id")?.to_owned(),
                        ));
                    }
                }
            }
            Target::Command { all_accounts: false } => {
                for p in READ_ORDER {
                    required.push((p.into(), session.selection.id(p).into()));
                }
            }
            Target::Provider { selection, provider } => {
                if !READ_ORDER.contains(&provider.as_str()) {
                    return Err("Unknown provider".into());
                }
                required.push((provider.clone(), selection.id(provider).into()));
            }
        }
        for (provider, account) in required {
            let identity = snapshot["providers"]
                .as_array()
                .unwrap()
                .iter()
                .find(|g| g["provider"] == provider)
                .and_then(|g| g["accounts"].as_array())
                .and_then(|a| a.iter().find(|a| a["id"] == account))
                .ok_or("Account removed")?;
            if identity["state"] != "ready" {
                return Err("Account is not ready".into());
            }
            self.files.get(&(provider, account)).ok_or("No synthetic fixture binding")?.check().map_err(err)?;
        }
        Ok(())
    }
    async fn capture(&mut self, scope: FixtureScope) -> Result<(u64, Arc<UsageAccounts>, Value)> {
        self.live()?;
        if self.sessions.len() >= MAX_SESSIONS {
            return Err("Fixture session limit exceeded".into());
        }
        let key = self.scope_key(&scope)?;
        let snapshot = self.registry.snapshot()?;
        let grant = match &scope {
            FixtureScope::Computer => Grant::Computer,
            FixtureScope::Project(name) => {
                let p = self.projects[name].clone();
                Grant::Project(snapshot.project(&p).await?, p)
            }
            FixtureScope::Link(id) => Grant::Link(snapshot.link(id).await?),
        };
        let pinned = self.accounts.pin(key.as_deref()).map_err(err)?;
        let selection = Selection {
            claude: pinned.account_id("claude").map_err(err)?.into(),
            codex: pinned.account_id("codex").map_err(err)?.into(),
            antigravity: pinned.account_id("antigravity").map_err(err)?.into(),
        };
        let id = self.next;
        self.next += 1;
        let admission = Arc::new(Bridge { owner: self.handle.clone(), session: id });
        let handle = self.handle.clone();
        let list = handle.clone();
        let read = handle.clone();
        let selected = selection.clone();
        let keys = key.clone().into_iter().collect::<Vec<_>>();
        let now = self.now;
        let events = self.events.clone();
        let options = UsageAccountsOptions {
            scopes: Arc::new(move || {
                let keys = keys.clone();
                Box::pin(async move { Ok(keys) })
            }),
            selected: Arc::new(move |_| selected.clone()),
            list: Arc::new(move || {
                let owner = list.clone();
                Box::pin(async move {
                    let owner = owner.upgrade().ok_or("Fixture owner closed")?;
                    let (tx, rx) = oneshot::channel();
                    owner.tx.send(Request::List(id, tx)).await.map_err(err)?;
                    rx.await.map_err(err)?
                })
            }),
            read: Arc::new(move |p, account| {
                let owner = read.clone();
                Box::pin(async move {
                    let owner = owner.upgrade().ok_or(())?;
                    let permit = owner.workers.clone().acquire_owned().await.map_err(|_| ())?;
                    let (tx, rx) = oneshot::channel();
                    owner.tx.send(Request::Read(id, p, account, tx)).await.map_err(|_| ())?;
                    let ticket = rx.await.map_err(|_| ())?.map_err(|_| ())?;
                    let file = ticket.file;
                    let result = tokio::task::spawn_blocking(move || {
                        let _permit = permit;
                        #[cfg(test)]
                        if let Some(gate) = ticket.blocking {
                            gate.wait();
                        }
                        file.read()
                    })
                    .await
                    .map_err(|_| ())?
                    .map_err(|_| ())?;
                    #[cfg(test)]
                    if let Some(pause) = ticket.pause {
                        pause.entered.add_permits(1);
                        pause.resume.acquire().await.map_err(|_| ())?.forget();
                    }
                    Ok(result)
                })
            }),
            // This compatibility callback is not an authority check. Admission explicitly rejects readiness.
            ready: Arc::new(|| Box::pin(async {})),
            now: Arc::new(move || now),
            emit: Arc::new(move |name, value| {
                let mut events = events.lock().unwrap();
                if events.len() == 128 {
                    events.remove(0);
                }
                events.push(json!([name, value]));
            }),
            read_usage_override: None,
        };
        let mut selections = vec![selection.clone()];
        let identities = self.accounts.snapshot().map_err(err)?;
        for group in identities["providers"].as_array().ok_or("Invalid snapshot")? {
            for account in group["accounts"].as_array().ok_or("Invalid snapshot")? {
                let mut s = Selection::default();
                let p = group["provider"].as_str().ok_or("Invalid provider")?;
                let a = account["id"].as_str().ok_or("Invalid id")?;
                match p {
                    "claude" => s.claude = a.into(),
                    "codex" => s.codex = a.into(),
                    "antigravity" => s.antigravity = a.into(),
                    _ => {}
                }
                if !selections.contains(&s) {
                    selections.push(s);
                }
            }
        }
        let mut seeds = HashMap::new();
        for selection in selections {
            if !self.stores.contains_key(&selection) {
                self.stores.insert(selection.clone(), self.cache.load_quota(&selection).map_err(err)?.to_json());
            }
            seeds.insert(selection.clone(), UsageStore::from_json(&self.stores[&selection]));
        }
        let accounts = UsageAccounts::with_admission(options, seeds, admission);
        self.sessions.insert(
            id,
            Captured {
                owner: self.accounts.owner_id().map_err(err)?.to_string(),
                generation: self.accounts.generation().map_err(err)?,
                readiness: self.readiness,
                selection,
                pinned,
                scope: key.clone(),
                snapshot,
                grant,
                accounts: accounts.clone(),
            },
        );
        Ok((id, accounts, json!(key)))
    }
    async fn mutate(&mut self, mutation: FixtureMutation) -> Result<()> {
        self.live()?;
        match mutation {
            FixtureMutation::Observe { provider, account, state } => {
                self.observe(&provider, &account, state)?;
            }
            FixtureMutation::Select { provider, account } => {
                let proof = self.ready_proof(&provider, &account)?;
                self.accounts.select(&provider, &account, proof).map_err(err)?;
            }
            FixtureMutation::Assign { scope, provider, account } => {
                let key = self.scope_key(&scope)?.ok_or("Assignment requires Project or Link")?;
                let proof = account.as_ref().map(|a| self.ready_proof(&provider, a)).transpose()?;
                self.accounts.assign(&key, &provider, account.as_deref(), proof).map_err(err)?;
            }
            FixtureMutation::Remove { provider, account } => {
                self.accounts.remove(&provider, &account).map_err(err)?;
            }
            FixtureMutation::Position { project, x, y } => {
                let path = self.projects.get(&project).ok_or("Unknown Project")?;
                self.writer
                    .as_mut()
                    .ok_or("Registry closed")?
                    .call("position", &json!({"id":path,"position":{"x":x,"y":y}}))
                    .await
                    .map_err(err)?;
            }
            FixtureMutation::DeleteLink(id) => {
                self.writer.as_mut().ok_or("Registry closed")?.call("group:delete", &json!({"id":id})).await.map_err(err)?;
            }
            FixtureMutation::CloseAccounts => self.accounts.close(),
        }
        Ok(())
    }
    async fn commit(&mut self, id: u64, target: Target, apply: Option<Apply>) -> Result<Value> {
        self.validate(id, &target).await?;
        // No await between final authority validation and apply. This actor also owns all mutations.
        let Some(apply) = apply else { return Ok(Value::Null) };
        let value = apply();
        if let Target::Provider { selection, provider } = target {
            let stored =
                self.sessions[&id].accounts.stores().into_iter().find(|(s, _)| s == &selection).ok_or("Missing committed reader")?.1;
            let merged = self.stores.entry(selection.clone()).or_insert_with(|| UsageStore::default().to_json());
            if value["status"] == "ok" {
                merged[&provider]["last"] = stored[&provider]["last"].clone();
            }
            merged[&provider]["blocked"] = stored[&provider]["blocked"].clone();
            if let Err(error) = self.cache.save_quota(&selection, &UsageStore::from_json(merged)) {
                self.cache.record_diagnostic("fixture-quota", &error.to_string());
            }
        }
        Ok(value)
    }
    async fn close(&mut self, workers: &Arc<Semaphore>) -> Result<()> {
        self.closed = true;
        self.active.store(false, Ordering::Release);
        self.accounts.close();
        self.writer.take();
        for session in self.sessions.values() {
            session.accounts.shutdown().await;
        }
        let _drained = workers.clone().acquire_many_owned(4).await.map_err(err)?;
        self.cache.shutdown().await
    }
    async fn run(&mut self, mut rx: mpsc::Receiver<Request>, workers: Arc<Semaphore>) -> Result<()> {
        while let Some(request) = rx.recv().await {
            match request {
                Request::Capture(scope, reply) => {
                    let value = self.capture(scope).await;
                    let _ = reply.send(value);
                }
                Request::Check(id, target, apply, reply) => {
                    let value = self.commit(id, target, apply).await;
                    let _ = reply.send(value);
                }
                Request::List(id, reply) => {
                    let result = async {
                        self.validate(id, &Target::Command { all_accounts: false }).await?;
                        serde_json::from_value(self.accounts.snapshot().map_err(err)?).map_err(err)
                    }
                    .await;
                    let _ = reply.send(result);
                }
                Request::Read(id, p, account, reply) => {
                    #[cfg(test)]
                    self.calls.push(json!([p, account]));
                    let mut selection = Selection::default();
                    match p.as_str() {
                        "claude" => selection.claude = account.clone(),
                        "codex" => selection.codex = account.clone(),
                        "antigravity" => selection.antigravity = account.clone(),
                        "kiro" if account == "default" => {}
                        _ => {
                            let _ = reply.send(Err("Invalid provider binding".into()));
                            continue;
                        }
                    }
                    let result = async {
                        self.validate(id, &Target::Provider { selection, provider: p.clone() }).await?;
                        Ok(ReadTicket {
                            file: self.files.get(&(p.clone(), account)).ok_or("Missing fixture")?.clone(),
                            #[cfg(test)]
                            pause: self.pauses.get(&p).cloned(),
                            #[cfg(test)]
                            blocking: self.blocking.get(&p).cloned(),
                        })
                    }
                    .await;
                    let _ = reply.send(result);
                }
                Request::Mutate(change, reply) => {
                    let result = self.mutate(change).await;
                    let _ = reply.send(result);
                }
                Request::Close(reply) => {
                    let result = self.close(&workers).await;
                    let _ = reply.send(result.clone());
                    return result;
                }
                #[cfg(test)]
                Request::Block(provider, gate, reply) => {
                    self.blocking.insert(provider, gate);
                    let _ = reply.send(());
                }
                #[cfg(test)]
                Request::Pause(provider, pause, reply) => {
                    self.pauses.insert(provider, pause);
                    let _ = reply.send(());
                }
                #[cfg(test)]
                Request::SeedHistory(selection, value, reply) => {
                    let store = UsageStore::from_json(&value);
                    let result = self.cache.save_quota(&selection, &store).map_err(err);
                    if result.is_ok() {
                        self.stores.insert(selection, store.to_json());
                    }
                    let _ = reply.send(result);
                }
                #[cfg(test)]
                Request::Trace(reply) => {
                    let _ = reply.send((std::mem::take(&mut *self.events.lock().unwrap()), std::mem::take(&mut self.calls)));
                }
                #[cfg(test)]
                Request::Inspect(reply) => {
                    let _ = reply.send((self.events.lock().unwrap().clone(), self.stores.clone()));
                }
                #[cfg(test)]
                Request::Paths(reply) => {
                    let _ = reply.send((PathBuf::from(&self.context.home), PathBuf::from(&self.context.data_dir)));
                }
            }
        }
        self.close(&workers).await
    }
}
impl FixtureOwner {
    pub async fn create(seed: SyntheticSeed) -> Result<Arc<Self>> {
        let cache = TempCache::fresh().map_err(err)?;
        let disk = Arc::new(cache.open().map_err(err)?);
        let (tx, rx) = mpsc::channel(32);
        let (done, done_rx) = watch::channel(None);
        let (ready, ready_rx) = oneshot::channel();
        let workers = Arc::new(Semaphore::new(4));
        let owner = Arc::new(Self { tx, done: done_rx, workers: workers.clone(), _cache: cache });
        let handle = Arc::downgrade(&owner);
        std::thread::Builder::new()
            .name("usage-trusted-fixture".into())
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(err)?;
                    runtime.block_on(async move {
                        match State::create(seed, disk, handle) {
                            Ok(mut state) => {
                                let _ = ready.send(Ok(()));
                                state.run(rx, workers).await
                            }
                            Err(error) => {
                                let _ = ready.send(Err(error.clone()));
                                Err(error)
                            }
                        }
                    })
                }))
                .unwrap_or_else(|_| Err("Fixture authority actor panicked".into()));
                done.send_replace(Some(result));
            })
            .map_err(err)?;
        ready_rx.await.map_err(err)??;
        Ok(owner)
    }
    pub async fn capture(self: &Arc<Self>, scope: FixtureScope) -> Result<FixtureSession> {
        let (tx, rx) = oneshot::channel();
        self.tx.send(Request::Capture(scope, tx)).await.map_err(err)?;
        let (_id, accounts, scope) = rx.await.map_err(err)??;
        Ok(FixtureSession { owner: self.clone(), accounts, scope })
    }
    pub async fn mutate(&self, change: FixtureMutation) -> Result<()> {
        let (tx, rx) = oneshot::channel();
        self.tx.send(Request::Mutate(change, tx)).await.map_err(err)?;
        rx.await.map_err(err)?
    }
    pub async fn close(&self) -> Result<()> {
        if let Some(result) = self.done.borrow().clone() {
            return result;
        }
        let (tx, rx) = oneshot::channel();
        if self.tx.send(Request::Close(tx)).await.is_ok() {
            let _ = rx.await;
        }
        let mut done = self.done.clone();
        loop {
            if let Some(result) = done.borrow().clone() {
                return result;
            }
            done.changed().await.map_err(err)?;
        }
    }
}
impl FixtureSession {
    pub async fn handle(&self, command: QuotaCommand) -> Result<Value> {
        // Keep the actual owner alive while supervised work is admitted.
        let _owner = &self.owner;
        self.accounts.handle(command.wire(), &self.scope).await
    }
}
impl Admission for Bridge {
    fn check(&self, target: Target) -> milagre_usage::accounts::MetadataFuture<()> {
        let owner = self.owner.clone();
        let id = self.session;
        Box::pin(async move {
            let owner = owner.upgrade().ok_or("Fixture owner closed")?;
            let (tx, rx) = oneshot::channel();
            owner.tx.send(Request::Check(id, target, None, tx)).await.map_err(err)?;
            rx.await.map_err(err)??;
            Ok(())
        })
    }
    fn commit(&self, target: Target, apply: Apply) -> milagre_usage::accounts::MetadataFuture<Value> {
        let owner = self.owner.clone();
        let id = self.session;
        Box::pin(async move {
            let owner = owner.upgrade().ok_or("Fixture owner closed")?;
            let (tx, rx) = oneshot::channel();
            owner.tx.send(Request::Check(id, target, Some(apply), tx)).await.map_err(err)?;
            rx.await.map_err(err)?
        })
    }
}
#[cfg(test)]
mod tests;

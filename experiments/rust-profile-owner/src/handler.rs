//! The commands this owner serves, in the Node daemon's shapes (`apps/daemon/src/server.cjs` and
//! `packages/core/src/runtime.cjs`), over `milagre-owner-store`'s `ProjectStates` and `milagre-registry`'s reads.
//!
//! Every Project is opened (locked) on its first `project:read`, as Node's every-Project sidebar read does, and stays
//! open until the owner stops. Its Worktrees are discovered on each `project:read` and every state answered is matched
//! with them as Node's `read` does (`reconcile`), in what is answered only: no Project is resumed, changed or saved.
use milagre_owner_store::{
    chat_page,
    chat_summaries::with_chat_summaries,
    jsjson,
    message_store::ProjectState,
    ownership::{random_uuid, OwnerGuard, RustOwnerLock},
    states::ProjectStates,
    write::OwnerLock,
    Isolation, PageOptions, ProjectReader, ProjectRepository, ProjectStore, StoreError,
};
use milagre_owner_wire::{ClientContext, Handler, RpcError, RpcResult};
use milagre_registry::{scopes, Registry};
use serde_json::{json, Map, Value};
use std::{
    collections::{HashMap, HashSet},
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};

/// What this owner serves besides the wire's own `daemon:*`, `chat:set-open` and paging methods.
pub const METHODS: &[&str] = &[
    "project:known",
    "project:recent",
    "project:read",
    "project:snapshot",
    "state:read",
    "chat:messages",
    "chat:message",
    "chat:runs",
];

/// The state number every reply carries. Nothing here changes a state after it is read, so the first state of a scope
/// is the only one ever sent (server.cjs `replyNumber`/`sentNumber` number from 1).
const STATE_VERSION: u64 = 1;

const SETTINGS_LIMIT: u64 = 4 * 1024 * 1024;

/// The data directory's `runtime.lock`, held for the owner's lifetime and released after its socket is gone.
pub type DataLock = Arc<Mutex<Option<OwnerGuard>>>;

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|time| time.as_millis() as i64)
        .unwrap_or(0)
}

fn failed(message: impl Into<String>) -> RpcError {
    RpcError::new("COMMAND_FAILED", message)
}

fn store(error: StoreError) -> RpcError {
    RpcError::new(error.code().unwrap_or("COMMAND_FAILED"), error.to_string())
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// runtime.cjs projectName.
fn project_name(path: &str) -> String {
    match Path::new(path).file_name() {
        Some(name) if !name.is_empty() => name.to_string_lossy().into_owned(),
        _ => "Untitled project".into(),
    }
}

/// `String(value)` for the values a registry's `openedAt` holds.
fn js_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Object(_) => "[object Object]".into(),
        other => jsjson::to_string(other),
    }
}

struct Loaded {
    git: bool,
    /// The Worktrees found at the last `project:read` (Node's `discovered`).
    worktrees: Vec<Value>,
    /// Chats saved without a summary: Node makes theirs after reconciling, so it follows the fields reconcile adds.
    unsummarized: HashSet<String>,
}

/// Node's key order for a Chat whose summary was made on read: last, after what reconcile added.
fn summaries_last(mut state: Value, unsummarized: &HashSet<String>) -> Value {
    if let Some(Value::Object(sessions)) = state.get_mut("sessions") {
        for id in unsummarized {
            if let Some(Value::Object(session)) = sessions.get_mut(id) {
                if let Some(summary) = session.shift_remove("summary") {
                    session.insert("summary".into(), summary);
                }
            }
        }
    }
    state
}

struct Core {
    states: ProjectStates,
    loaded: HashMap<PathBuf, Loaded>,
    /// Common Git directory -> its `milagre-runtime.lock`, shared by the Projects of one repository.
    repositories: HashMap<PathBuf, OwnerGuard>,
    closed: bool,
}

/// The owner of one isolated data directory's reads.
pub struct Profile {
    isolation: Isolation,
    chats_home: PathBuf,
    data_dir: PathBuf,
    registry: Registry,
    epoch: String,
    data_lock: DataLock,
    core: Mutex<Core>,
    origins: crate::origin::Origins,
    /// Drives the registry's bounded Git identity probes.
    runtime: tokio::runtime::Runtime,
}

impl Profile {
    pub fn new(
        isolation: Isolation,
        data_dir: PathBuf,
        chats_home: PathBuf,
        data_lock: DataLock,
    ) -> Result<Self, String> {
        let active_lock = data_lock.clone();
        let active: milagre_registry::Active = Arc::new(move || {
            locked(&active_lock)
                .as_ref()
                .ok_or_else(|| "The data directory's lock was released.".to_string())?
                .verify()
                .map_err(|error| error.to_string())
        });
        let registry = Registry::open(isolation.clone(), &data_dir, active)?;
        let states = ProjectStates::new(isolation.clone(), Default::default(), now_ms());
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .max_blocking_threads(8)
            .enable_all()
            .build()
            .map_err(|error| error.to_string())?;
        Ok(Self {
            origins: Default::default(),
            runtime,
            isolation,
            chats_home,
            data_dir,
            registry,
            epoch: random_uuid(),
            data_lock,
            core: Mutex::new(Core {
                states,
                loaded: HashMap::new(),
                repositories: HashMap::new(),
                closed: false,
            }),
        })
    }

    fn check_owned(&self) -> Result<(), RpcError> {
        let guard = locked(&self.data_lock);
        let guard = guard.as_ref().ok_or_else(|| {
            RpcError::new("OWNERSHIP_LOST", "The data directory's lock was released")
        })?;
        guard.verify().map_err(store)
    }

    /// chatsHome.isHome: the same folder, by real path when it exists.
    fn is_chats_home(&self, path: &str) -> bool {
        let candidate = Path::new(path);
        if !candidate.is_absolute() {
            return false;
        }
        let real = |path: &Path| std::fs::canonicalize(path).unwrap_or_else(|_| path.to_owned());
        real(candidate) == real(&self.chats_home)
    }

    fn recent(&self) -> Result<Vec<Value>, RpcError> {
        Ok(self
            .registry
            .recent()
            .map_err(failed)?
            .as_array()
            .cloned()
            .unwrap_or_default())
    }

    /// The real path of `path` when it exists and resolves strictly inside the copy.
    fn contained(&self, path: &Path) -> Option<PathBuf> {
        let real = std::fs::canonicalize(path).ok()?;
        let root = self.isolation.root();
        (real.starts_with(root) && real != root).then_some(real)
    }

    /// recentProjects().list() holds the path (runtime.cjs `project:read`'s check).
    fn is_recent(&self, path: &str) -> Result<bool, RpcError> {
        Ok(self
            .recent()?
            .iter()
            .any(|entry| entry["path"].as_str() == Some(path)))
    }

    /// project-settings.json hiddenPaths, read as Node reads it (anything unreadable is no setting).
    fn hidden_paths(&self) -> HashSet<String> {
        let file = self.data_dir.join("project-settings.json");
        let parsed = std::fs::symlink_metadata(&file)
            .ok()
            .filter(|meta| meta.is_file() && meta.len() <= SETTINGS_LIMIT)
            .and_then(|_| {
                let mut bytes = Vec::new();
                std::fs::File::open(&file)
                    .and_then(|handle| handle.take(SETTINGS_LIMIT).read_to_end(&mut bytes))
                    .ok()?;
                jsjson::parse_bytes(&bytes).ok()
            });
        let Some(Value::Object(projects)) = parsed.as_ref().and_then(|value| value.get("projects"))
        else {
            return HashSet::new();
        };
        projects
            .iter()
            .filter(|(_, entry)| entry.get("hidden") == Some(&Value::Bool(true)))
            .map(|(path, _)| path.clone())
            .collect()
    }

    /// `project:known`: the registry's Projects with their origins, the Chats home left out, newest opened first.
    fn known(&self) -> RpcResult {
        let snapshot = self.registry.snapshot().map_err(failed)?;
        let mut known: Vec<Value> = Vec::new();
        for entry in snapshot.value()["projects"]
            .as_array()
            .into_iter()
            .flatten()
        {
            let Some(path) = entry["path"].as_str() else {
                continue;
            };
            // Node stats each entry and drops the ones gone. Here an entry must resolve (links followed) inside the copy:
            // anything leading outside is left out unread, like registry.recent()'s entries.
            if self.is_chats_home(path) {
                continue;
            }
            let folder = self
                .contained(Path::new(path))
                .is_some_and(|real| real.is_dir());
            let id = entry["id"].as_str().unwrap_or_default();
            let repository = id == path || self.contained(Path::new(id)).is_some();
            if !folder || !repository {
                continue;
            }
            let name = if jsjson::truthy(entry.get("name")) {
                entry["name"].clone()
            } else {
                json!(Path::new(path)
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default())
            };
            let opened = match entry.get("openedAt") {
                None | Some(Value::Null) => json!(""),
                Some(value) => value.clone(),
            };
            known.push(json!({"path": path, "name": name, "openedAt": opened}));
        }
        // toSorted is stable; ISO timestamps compare the same by bytes as by localeCompare.
        known.sort_by(|a, b| js_text(&b["openedAt"]).cmp(&js_text(&a["openedAt"])));
        Ok(self.with_origins(known))
    }

    /// withOrigins: `{ ...project, origin }` for each Project with a Git origin.
    fn with_origins(&self, list: Vec<Value>) -> Value {
        Value::Array(
            list.into_iter()
                .map(|mut project| {
                    let origin = project["path"].as_str().and_then(|path| {
                        self.origins.of(path, || {
                            // A verified checkout inside the copy, read with the registry's locked-down Git.
                            self.runtime
                                .block_on(self.registry.origin_url(path))
                                .ok()
                                .flatten()
                        })
                    });
                    if let Some(origin) = origin {
                        project["origin"] = json!(origin);
                    }
                    project
                })
                .collect(),
        )
    }

    /// `project:recent`: the recent list with `hidden` marks and origins, the Chats home left out.
    fn recent_projects(&self) -> RpcResult {
        let hidden = self.hidden_paths();
        let mut list = Vec::new();
        for mut entry in self.recent()? {
            let path = entry["path"].as_str().unwrap_or_default().to_owned();
            if self.is_chats_home(&path) {
                continue;
            }
            if hidden.contains(&path) {
                entry["hidden"] = json!(true);
            }
            list.push(entry);
        }
        Ok(self.with_origins(list))
    }

    /// The Project's identity and Worktrees as Node's discoverWorktrees finds them (registry `identify`: Git's Worktree
    /// list, or the folder itself outside Git).
    fn discover(&self, key: &Path) -> Result<milagre_registry::Identity, RpcError> {
        self.runtime
            .block_on(self.registry.identify(key))
            .map_err(failed)
    }

    /// ownProject + the saved state: the repository's lock and the Project's lock, then readProjectState.
    fn open(&self, core: &mut Core, key: &Path) -> Result<(), RpcError> {
        if self.isolation.normalize(key).map_err(store)? != key {
            return Err(failed("Name the Project by its own path."));
        }
        let identity = self.discover(key)?;
        let git = identity.value["git"] == Value::Bool(true);
        let mut taken = None;
        if git {
            let common = identity.value["id"]
                .as_str()
                .map(PathBuf::from)
                .ok_or_else(|| failed("The Project's Git directory is unknown."))?;
            if !core.repositories.contains_key(&common) {
                let guard = RustOwnerLock
                    .acquire(&common, &common.join("milagre-runtime.lock"))
                    .map_err(store)?;
                core.repositories.insert(common.clone(), guard);
                taken = Some(common);
            }
        }
        if let Err(error) = core.states.get(key) {
            if let Some(mut guard) = taken.and_then(|common| core.repositories.remove(&common)) {
                let _ = guard.release();
            }
            return Err(store(error));
        }
        let unsummarized = ProjectStore::new(key)
            .read_raw()
            .ok()
            .and_then(|raw| {
                raw.get("sessions")
                    .and_then(Value::as_object)
                    .map(|sessions| {
                        sessions
                            .iter()
                            .filter(|(_, session)| session.get("summary").is_none())
                            .map(|(id, _)| id.clone())
                            .collect()
                    })
            })
            .unwrap_or_default();
        core.loaded.insert(
            key.to_owned(),
            Loaded {
                git,
                worktrees: identity.worktrees,
                unsummarized,
            },
        );
        Ok(())
    }

    /// The whole state Node holds for an open Project: the saved state matched with its Worktrees, Chat summaries kept
    /// current (a Chat made for a Worktree without one gets its summary as Node's compact step gives it).
    fn state(&self, core: &mut Core, key: &Path, project: &str) -> Result<Value, RpcError> {
        let saved = core.states.whole_state(key).map_err(store)?;
        Ok(Self::held(core, key, project, saved))
    }

    /// `saved` (a whole state these states hold) as Node holds it: reconciled, summaries current, in Node's key order.
    fn held(core: &Core, key: &Path, project: &str, saved: Value) -> Value {
        let loaded = &core.loaded[key];
        let reconciled =
            crate::reconcile::reconcile(Some(&saved), &project_name(project), &loaded.worktrees);
        let state = if reconciled == saved {
            saved
        } else {
            with_chat_summaries(
                ProjectState::from_value(&reconciled),
                None,
                core.states.now(),
            )
            .to_value()
        };
        summaries_last(state, &loaded.unsummarized)
    }

    /// `{ path, name, git, state }` of a Project open here.
    fn project(&self, core: &mut Core, path: &str) -> RpcResult {
        let key = PathBuf::from(path);
        let git = core
            .loaded
            .get(&key)
            .map(|loaded| loaded.git)
            .ok_or_else(|| failed("Open the project before reading its snapshot."))?;
        let state = self.state(core, &key, path)?;
        Ok(json!({"path": path, "name": project_name(path), "git": git, "state": state}))
    }

    /// `{ ...result, version, epoch }`, written as server.cjs `encode` writes it: the state last.
    fn stamp(&self, mut value: Value) -> Value {
        if let Some(object) = value.as_object_mut() {
            let state = object.shift_remove("state");
            object.insert("version".into(), json!(STATE_VERSION));
            object.insert("epoch".into(), json!(self.epoch));
            if let Some(state) = state {
                object.insert("state".into(), state);
            }
        }
        value
    }

    fn project_read(&self, core: &mut Core, args: &[Value]) -> RpcResult {
        let path = args.first().and_then(Value::as_str);
        if let Some(path) = path.filter(|path| self.is_chats_home(path)) {
            if Path::new(path).exists() {
                return Err(RpcError::new(
                    "NOT_SUPPORTED",
                    "The Rust profile owner doesn't serve the Chats home yet.",
                ));
            }
            return Err(failed("Open this project in Milagre first."));
        }
        let Some(path) = path else {
            return Err(failed("Open this project in Milagre first."));
        };
        if !self.is_recent(path)? {
            return Err(failed("Open this project in Milagre first."));
        }
        if let Some(loaded) = core.loaded.get_mut(Path::new(path)) {
            // readProject matches every read with the Worktrees found now.
            loaded.worktrees = self.discover(Path::new(path))?.worktrees;
        } else {
            self.open(core, Path::new(path))?;
        }
        let mut project = self.project(core, path)?;
        // server.cjs: `{ state: false }` answers { path, name, git } and the number of the state last sent.
        if args
            .get(1)
            .is_some_and(|read| read.get("state") == Some(&Value::Bool(false)))
        {
            project.as_object_mut().unwrap().shift_remove("state");
        }
        Ok(self.stamp(project))
    }

    fn state_read(&self, core: &mut Core, args: &[Value]) -> RpcResult {
        let owner = args
            .first()
            .and_then(Value::as_str)
            .filter(|owner| !owner.is_empty())
            .ok_or_else(|| failed("Choose a Project or Link"))?;
        if scopes::is_link(&json!(owner)) {
            return Err(RpcError::new(
                "NOT_SUPPORTED",
                "The Rust profile owner doesn't serve Links yet.",
            ));
        }
        Ok(self.stamp(self.project(core, owner)?))
    }

    fn chat_messages(&self, core: &mut Core, args: &[Value]) -> RpcResult {
        let scope = args.first().and_then(Value::as_str);
        let link = scope.is_some_and(|scope| scopes::is_link(&json!(scope)));
        let open = scope.is_some_and(|scope| core.loaded.contains_key(Path::new(scope)));
        let chat = args
            .get(1)
            .and_then(Value::as_f64)
            .filter(|chat| chat.fract() == 0.0 && chat.abs() <= 9_007_199_254_740_991.0);
        // A Chat of a recent Project this owner hasn't opened is read from its chats.db as it is, without opening it.
        if let (Some(path), Some(chat), false, false) = (scope, chat, link, open) {
            if !self.is_chats_home(path) && self.is_recent(path)? {
                let root = self.isolation.resolve(Path::new(path)).map_err(store)?;
                let db = root.join(".milagre").join("chats.db");
                if std::fs::symlink_metadata(&db).is_ok() {
                    return ProjectReader::new(ProjectStore::new(root))
                        .chat_messages(chat as i64, &PageOptions::from_value(args.get(2)))
                        .map_err(store);
                }
            }
        }
        if !(link || open) {
            return Err(failed("Open the Project before reading its messages."));
        }
        if link {
            return Err(RpcError::new(
                "NOT_SUPPORTED",
                "The Rust profile owner doesn't serve Links yet.",
            ));
        }
        let page = core.states.call("chat:messages", args).map_err(store)?;
        // A Chat whose Worktree went away isn't in the state Node holds: its page is empty there too.
        let path = scope.unwrap_or_default();
        let key = PathBuf::from(path);
        let mut current = core
            .states
            .current(&key)
            .map(|state| state.to_value())
            .unwrap_or(Value::Null);
        if let Some(object) = current.as_object_mut() {
            object.shift_remove("messages");
        }
        let reconciled = crate::reconcile::reconcile(
            Some(&current),
            &project_name(path),
            &core.loaded[&key].worktrees,
        );
        let kept = args.get(1).is_some_and(|chat| {
            reconciled["sessions"]
                .get(jsjson::property_key(Some(chat)))
                .is_some()
        });
        if kept {
            Ok(page)
        } else {
            Ok(chat_page(
                &[],
                args.get(1).unwrap_or(&Value::Null),
                &PageOptions::from_value(args.get(2)),
            ))
        }
    }

    fn chat_message(&self, core: &mut Core, args: &[Value]) -> RpcResult {
        let scope = args.first().and_then(Value::as_str);
        if scope.is_some_and(|scope| scopes::is_link(&json!(scope))) {
            return Err(RpcError::new(
                "NOT_SUPPORTED",
                "The Rust profile owner doesn't serve Links yet.",
            ));
        }
        if !scope.is_some_and(|scope| core.loaded.contains_key(Path::new(scope))) {
            return Err(failed("Open the Project before reading its messages."));
        }
        core.states.call("chat:message", args).map_err(store)
    }

    /// Stops reading: every Project saved (nothing is dirty here) and unlocked, then the repositories unlocked.
    fn close(&self) -> Result<(), RpcError> {
        let mut core = locked(&self.core);
        if core.closed {
            return Ok(());
        }
        core.states.close().map_err(store)?;
        core.loaded.clear();
        let mut result = Ok(());
        for (_, mut guard) in core.repositories.drain() {
            if let Err(error) = guard.release() {
                result = result.and(Err(store(error)));
            }
        }
        core.closed = true;
        result
    }
}

impl Handler for Profile {
    fn decode_request(&self, frame: &[u8]) -> Result<Value, RpcError> {
        jsjson::parse_bytes(frame)
            .map_err(|_| RpcError::new("INVALID_REQUEST", "Expected a JSON frame"))
    }
    fn encode_request_id(&self, id: &Value) -> Result<String, RpcError> {
        Ok(jsjson::to_string(id))
    }
    fn encode_result(&self, result: &Value) -> Result<String, RpcError> {
        Ok(jsjson::to_string(result))
    }
    fn string_len(&self, text: &str) -> usize {
        jsjson::utf16_len(text)
    }
    fn methods(&self) -> Vec<String> {
        METHODS.iter().map(|method| method.to_string()).collect()
    }
    fn invoke(&self, method: &str, args: &[Value], _context: &ClientContext) -> RpcResult {
        self.check_owned()?;
        let mut core = locked(&self.core);
        if core.closed {
            return Err(RpcError::new("CLOSING", "The daemon is closing"));
        }
        core.states.advance(now_ms());
        let core = &mut *core;
        match method {
            "project:known" => self.known(),
            "project:recent" => self.recent_projects(),
            "project:read" => self.project_read(core, args),
            "project:snapshot" => {
                let path = args.first().and_then(Value::as_str).unwrap_or_default();
                Ok(self.stamp(self.project(core, path)?))
            }
            "state:read" => self.state_read(core, args),
            "chat:messages" => self.chat_messages(core, args),
            "chat:message" => self.chat_message(core, args),
            "chat:runs" => Ok(json!({"runs": {}, "seq": 0})),
            other => Err(failed(format!("Unknown command: {other}"))),
        }
    }
    /// runtime.snapshot(): the Projects open here with every message, no Links, runs or ports.
    fn snapshot(&self, _context: &ClientContext) -> RpcResult {
        self.check_owned()?;
        let mut core = locked(&self.core);
        let mut projects = Vec::new();
        for key in core.states.projects() {
            let Some(saved) = core.states.current_whole_state(&key).map_err(store)? else {
                continue;
            };
            let path = key.to_string_lossy().into_owned();
            let state = Self::held(&core, &key, &path, saved);
            let mut project = Map::new();
            project.insert("path".into(), json!(path));
            project.insert("name".into(), json!(project_name(&path)));
            project.insert("state".into(), state);
            projects.push(Value::Object(project));
        }
        Ok(json!({"links": [], "projects": projects, "runs": {"runs": {}, "seq": 0}, "ports": {}}))
    }
    fn shutdown(&self) -> RpcResult {
        self.close().map(|()| Value::Null)
    }
}

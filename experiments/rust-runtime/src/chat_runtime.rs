//! Restartable single-Project Chat owner. A private manifest selects one Claude executable, account directory,
//! model and instruction bundle. The wire profile is fresh; the explicitly created marked data root persists.
//! No installed profile, registry, credential or executable is discovered. Fixed-child acceptance uses this same
//! configured provider/actor through a separate compile-time fixture feature.

use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    },
    path::{Component, Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use milagre_accounts::Accounts;
use milagre_claude::launch::LaunchOptions;
use milagre_owner_store::{ownership::RootPin, Isolation, Policy};
use milagre_owner_wire::{IsolatedProfile, RpcError, RpcResult, Server};
use serde_json::{json, Value};

use crate::claude_fixture::{
    ClaudeInstructionInputs, ClaudeLaunchContext, ClaudeProvider, FixtureMonitor,
};

const MANIFEST: &str = "rust-chat-runtime.json";
const LOCK: &str = ".rust-chat-runtime.lock";
#[cfg(all(test, feature = "routine-execution-fixture"))]
#[path = "routine_execution_fixture_tests.rs"]
mod routine_execution_tests;
const MANIFEST_LIMIT: usize = 32 * 1024;
pub(crate) const METHODS: &[&str] = &[
    "project:read",
    "chat:runs",
    "chat:patch",
    "project:known",
    "project:recent",
    "project:registry",
    "canvas:snapshot",
    "canvas:links",
    "link:list",
    "agent:models",
    "agent:cli-status",
    "accounts:list",
    "accounts:scope",
    "accounts:scopes",
];

fn refused(message: impl Into<String>) -> RpcError {
    RpcError::new("CHAT_RUNTIME_CONFIG", message.into())
}

fn strict_text<'a>(value: &'a Value, key: &str) -> Result<&'a str, RpcError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 4096 && !s.contains('\0'))
        .ok_or_else(|| refused(format!("Missing or invalid launch field: {key}")))
}

fn absolute(value: &Value, key: &str) -> Result<PathBuf, RpcError> {
    let path = PathBuf::from(strict_text(value, key)?);
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
    {
        return Err(refused(format!(
            "{key} must be an absolute normalized path"
        )));
    }
    Ok(path)
}

#[derive(Clone)]
struct LaunchConfig {
    value: Value,
    provider: String,
    program: PathBuf,
    home: PathBuf,
    config_directory: PathBuf,
    skills_directory: PathBuf,
    model: String,
    path: String,
    account_id: String,
    account_label: String,
    user_name: String,
    fixture: bool,
    github_read: Option<GithubReadConfig>,
}

#[derive(Clone)]
struct GithubReadConfig {
    program: PathBuf,
    home: PathBuf,
    config_directory: PathBuf,
    path: String,
    account_login: String,
    owner: String,
    repository: String,
}
impl GithubReadConfig {
    fn parse(value: &Value) -> Result<Self, RpcError> {
        const FIELDS: &[&str] = &[
            "program",
            "home",
            "configDirectory",
            "path",
            "accountLogin",
            "owner",
            "repository",
        ];
        let object = value
            .as_object()
            .ok_or_else(|| refused("githubRead must be an explicit object"))?;
        if object.len() != FIELDS.len() || FIELDS.iter().any(|k| !object.contains_key(*k)) {
            return Err(refused(
                "githubRead must contain only its seven explicit launch fields",
            ));
        }
        Ok(Self {
            program: absolute(value, "program")?,
            home: absolute(value, "home")?,
            config_directory: absolute(value, "configDirectory")?,
            path: strict_text(value, "path")?.into(),
            account_login: strict_text(value, "accountLogin")?.into(),
            owner: strict_text(value, "owner")?.into(),
            repository: strict_text(value, "repository")?.into(),
        })
    }
}
impl LaunchConfig {
    fn parse(value: Value, fixture: bool) -> Result<Self, RpcError> {
        const FIELDS: &[&str] = &[
            "program",
            "home",
            "configDirectory",
            "skillsDirectory",
            "model",
            "path",
            "accountId",
            "accountLabel",
            "userName",
        ];
        if value.as_object().is_none_or(|object| {
            !(FIELDS.len()..=FIELDS.len() + 2).contains(&object.len())
                || FIELDS.iter().any(|key| !object.contains_key(*key))
                || object.keys().any(|key| {
                    key != "provider" && key != "githubRead" && !FIELDS.contains(&key.as_str())
                })
        }) {
            return Err(refused("Launch manifest must contain exactly program, home, configDirectory, skillsDirectory, model, path, accountId, accountLabel and userName"));
        }
        let provider = match value.get("provider") {
            None => "claude",
            Some(Value::String(v)) if v == "claude" || v == "codex" => v.as_str(),
            _ => return Err(refused("Provider must be explicitly claude or codex")),
        }
        .to_owned();
        if fixture && provider != "claude" {
            return Err(refused("Fixed runtime fixture presets are Claude-only"));
        }
        let model = strict_text(&value, "model")?.to_string();
        let account_id = strict_text(&value, "accountId")?.to_string();
        let account_label = strict_text(&value, "accountLabel")?.to_string();
        let user_name = strict_text(&value, "userName")?.to_string();
        if user_name.len() > 256 || user_name.trim().is_empty() {
            return Err(refused("userName must be nonempty and at most 256 bytes"));
        }
        if model.len() > 256 || account_label.len() > 256 {
            return Err(refused("Model/account label exceeds 256 bytes"));
        }
        let github_read = value
            .get("githubRead")
            .map(GithubReadConfig::parse)
            .transpose()?;
        let config = Self {
            github_read,
            provider,
            program: absolute(&value, "program")?,
            home: absolute(&value, "home")?,
            config_directory: absolute(&value, "configDirectory")?,
            skills_directory: absolute(&value, "skillsDirectory")?,
            path: strict_text(&value, "path")?.to_string(),
            model,
            account_id,
            account_label,
            user_name,
            value,
            fixture,
        };
        config.accounts()?;
        Ok(config)
    }

    fn accounts(&self) -> Result<Accounts, RpcError> {
        let entries = if self.account_id == "default" {
            vec![]
        } else {
            vec![json!({"provider":self.provider,"id":self.account_id,"label":self.account_label})]
        };
        Accounts::parse(Some(
            &json!({"accounts":entries,"selected":{(self.provider.clone()):self.account_id},"scopes":{}})
                .to_string(),
        ))
        .map_err(|e| refused(e.to_string()))
    }
}

/// Path exclusions only. Unlike Policy::system this never reads installed profile registries.
fn protected_policy() -> Policy {
    let mut protected = milagre_owner_store::audit::default_data_dirs();
    if let Some(home) = std::env::var_os("HOME") {
        protected.push(PathBuf::from(home).join(".milagre"));
    }
    if let Some(custom) = std::env::var_os("MILAGRE_DATA_DIR") {
        protected.push(PathBuf::from(custom));
    }
    Policy {
        protected,
        registered: vec![],
    }
}

fn check_location(root: &Path, policy: &Policy) -> Result<PathBuf, RpcError> {
    if !root.is_absolute()
        || root
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
    {
        return Err(refused(
            "The dedicated data root must be an absolute normalized path",
        ));
    }
    let parent = fs::canonicalize(
        root.parent()
            .ok_or_else(|| refused("Name a new data directory"))?,
    )?;
    let path = parent.join(
        root.file_name()
            .ok_or_else(|| refused("Name a new data directory"))?,
    );
    for protected in &policy.protected {
        let protected = fs::canonicalize(protected).unwrap_or_else(|_| protected.clone());
        if path.starts_with(&protected) || protected.starts_with(&path) {
            return Err(refused(
                "A Rust Chat data root cannot overlap a Milagre profile",
            ));
        }
    }
    Ok(path)
}

fn plain(file: &File) -> Result<(), RpcError> {
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.nlink() != 1 || metadata.uid() != unsafe { libc::getuid() } {
        return Err(refused(
            "Expected a regular, single-link file owned by this user",
        ));
    }
    Ok(())
}

fn read_file(path: &Path) -> Result<Vec<u8>, RpcError> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)?;
    read_bounded(file)
}
// Coordination has the same unbounded JSON size contract as the owner store, including held queues.
// The strict 32 KiB limit belongs only to our private launch metadata.
fn read_coordination(path: &Path) -> Result<Vec<u8>, RpcError> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)?;
    plain(&file)?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(bytes)
}
fn read_bounded(file: File) -> Result<Vec<u8>, RpcError> {
    plain(&file)?;
    if file.metadata()?.len() > MANIFEST_LIMIT as u64 {
        return Err(refused("Runtime metadata exceeds 32 KiB"));
    }
    let mut bytes = Vec::new();
    file.take(MANIFEST_LIMIT as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MANIFEST_LIMIT {
        return Err(refused("Runtime metadata exceeds 32 KiB"));
    }
    Ok(bytes)
}

fn at(directory: &File, name: &str, flags: i32, mode: u32) -> Result<File, RpcError> {
    let name = std::ffi::CString::new(name).map_err(|_| refused("Invalid runtime file name"))?;
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            flags | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
            mode,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}
fn private_write(directory: &File, name: &str, bytes: &[u8]) -> Result<(), RpcError> {
    let mut file = at(
        directory,
        name,
        libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
        0o600,
    )?;
    file.write_all(bytes)?;
    file.sync_all()?;
    directory.sync_all()?;
    Ok(())
}

struct DataRoot {
    isolation: Isolation,
    pin: RootPin,
    directory: File,
    lock: File,
    config: LaunchConfig,
    manifest: Vec<u8>,
}
impl Drop for DataRoot {
    fn drop(&mut self) {
        // Closing alone leaves flock held by any concurrent fork's inherited open-file
        // description until exec. The final Arc is the authority boundary: all captured
        // actor/provider leases have ended, so release explicitly before closing our fd.
        while unsafe { libc::flock(self.lock.as_raw_fd(), libc::LOCK_UN) } != 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() != std::io::ErrorKind::Interrupted {
                eprintln!("CHAT_RUNTIME_UNLOCK_FAILED: {error}");
                break;
            }
        }
    }
}
impl DataRoot {
    fn directory(path: &Path) -> Result<(RootPin, File), RpcError> {
        let pin = RootPin::take(path).map_err(|e| refused(e.to_string()))?;
        pin.check().map_err(refused)?;
        let directory = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)?;
        let metadata = directory.metadata()?;
        if (metadata.dev(), metadata.ino()) != pin.identity()
            || metadata.uid() != unsafe { libc::getuid() }
            || metadata.mode() & 0o777 != 0o700
        {
            return Err(refused(
                "Dedicated data root must be owned by this user with mode 0700",
            ));
        }
        Ok((pin, directory))
    }
    fn lock(directory: &File) -> Result<File, RpcError> {
        let lock = at(directory, LOCK, libc::O_RDWR | libc::O_CREAT, 0o600)?;
        plain(&lock)?;
        loop {
            if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
                break;
            }
            let error = std::io::Error::last_os_error();
            match error.kind() {
                std::io::ErrorKind::Interrupted => continue,
                std::io::ErrorKind::WouldBlock => {
                    return Err(RpcError::new(
                        "CHAT_ROOT_BUSY",
                        "This dedicated Rust Chat data root is already running",
                    ));
                }
                _ => return Err(error.into()),
            }
        }
        Ok(lock)
    }

    fn create(root: &Path, config: LaunchConfig) -> Result<Arc<Self>, RpcError> {
        Self::create_inner(root, config, false)
    }
    fn create_inner(
        root: &Path,
        config: LaunchConfig,
        execution: bool,
    ) -> Result<Arc<Self>, RpcError> {
        Self::create_variant(root, config, execution, false, false)
    }
    fn create_variant(
        root: &Path,
        config: LaunchConfig,
        execution: bool,
        blocked: bool,
        quiet: bool,
    ) -> Result<Arc<Self>, RpcError> {
        if execution && (!cfg!(feature = "routine-execution-fixture") || !config.fixture) {
            return Err(refused(
                "Routine execution requires the explicit synthetic fixture",
            ));
        }
        let policy = protected_policy();
        let root = check_location(root, &policy)?;
        // Exclusive directory creation precedes every seed. An existing directory, even empty, is never adopted.
        fs::DirBuilder::new().mode(0o700).create(&root)?;
        let isolation = Isolation::create(&root, &policy).map_err(|e| refused(e.to_string()))?;
        let (pin, directory) = Self::directory(&root)?;
        let lock = Self::lock(&directory)?;
        let mut manifest = json!({"schema":1,"kind":"milagre-rust-chat","root":root,"fixture":config.fixture,"launch":config.value});
        if execution {
            manifest["routineExecutionFixture"] = json!(true);
            if blocked {
                manifest["routineFixtureBlocked"] = json!(true);
            }
            if quiet {
                manifest["routineFixtureQuiet"] = json!(true);
            }
        }
        let manifest = manifest.to_string().into_bytes();
        let project = isolation
            .project(Path::new("project"))
            .map_err(|e| refused(e.to_string()))?;
        fs::DirBuilder::new()
            .mode(0o700)
            .create(project.join(".milagre"))?;
        let metadata = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(project.join(".milagre"))?;
        let seed = crate::chat_bootstrap::seed(
            project
                .to_str()
                .ok_or_else(|| refused("Dedicated Project needs Unicode"))?,
        );
        private_write(&metadata, "coordination.json", seed.to_string().as_bytes())?;
        private_write(&directory, MANIFEST, &manifest)?;
        let data = Arc::new(Self {
            isolation,
            pin,
            directory,
            lock,
            config,
            manifest,
        });
        data.check()?;
        Ok(data)
    }

    fn open(root: &Path, fixture: bool) -> Result<Arc<Self>, RpcError> {
        let policy = protected_policy();
        let root = check_location(root, &policy)?;
        // Validate the pinned directory and dedicated marker before creating even a lock file.
        let (pin, directory) = Self::directory(&root)?;
        let manifest_file = at(&directory, MANIFEST, libc::O_RDONLY, 0)?;
        if manifest_file.metadata()?.mode() & 0o777 != 0o600 {
            return Err(refused("Dedicated launch manifest must have mode 0600"));
        }
        let bytes = read_bounded(manifest_file)?;
        let manifest: Value = serde_json::from_slice(&bytes)
            .map_err(|_| refused("Invalid dedicated runtime manifest"))?;
        if manifest["schema"] != 1
            || manifest["kind"] != "milagre-rust-chat"
            || manifest["root"].as_str() != root.to_str()
            || manifest["fixture"] != fixture
        {
            return Err(refused(
                "This is not the selected dedicated Rust Chat runtime root",
            ));
        }
        if manifest
            .get("routineExecutionFixture")
            .is_some_and(|v| v != true || !fixture || !cfg!(feature = "routine-execution-fixture"))
        {
            return Err(refused(
                "Routine execution fixture cannot be opened by this runtime",
            ));
        }
        let config = LaunchConfig::parse(manifest["launch"].clone(), fixture)?;
        let lock = Self::lock(&directory)?;
        let isolation = Isolation::open(&root, &policy).map_err(|e| refused(e.to_string()))?;
        let data = Arc::new(Self {
            isolation,
            pin,
            directory,
            lock,
            config,
            manifest: bytes,
        });
        data.check()?;
        let project = data.project();
        data.isolation
            .project(&project)
            .map_err(|e| refused(e.to_string()))?;
        let state: Value = milagre_owner_store::jsjson::parse_bytes(&read_coordination(
            &project.join(".milagre/coordination.json"),
        )?)
        .map_err(|_| refused("Invalid saved Chat coordination state"))?;
        if state["worktrees"]["1"]["path"].as_str() != project.to_str()
            || state["sessions"]["1"]["worktree_id"] != 1
        {
            return Err(refused("Saved Chat no longer names this dedicated Project"));
        }
        Ok(data)
    }

    fn project(&self) -> PathBuf {
        self.isolation.root().join("project")
    }
    fn check(&self) -> Result<(), RpcError> {
        self.pin.check().map_err(refused)?;
        let root = self.directory.metadata()?;
        if (root.dev(), root.ino()) != self.pin.identity() {
            return Err(refused("Dedicated runtime root identity changed"));
        }
        let current = at(&self.directory, LOCK, libc::O_RDONLY, 0)?;
        plain(&current)?;
        let actual = current.metadata()?;
        let expected = self.lock.metadata()?;
        if (actual.dev(), actual.ino()) != (expected.dev(), expected.ino()) {
            return Err(refused("Dedicated runtime lock identity changed"));
        }
        if read_bounded(at(&self.directory, MANIFEST, libc::O_RDONLY, 0)?)? != self.manifest {
            return Err(refused(
                "Dedicated runtime configuration changed; restart with explicit configuration",
            ));
        }
        Ok(())
    }
}

pub(crate) struct Bootstrap {
    root: Arc<DataRoot>,
    accounts: Accounts,
}
impl Bootstrap {
    pub(crate) fn pr_details(
        &self,
    ) -> Result<Option<Arc<crate::configured_pr_details::ConfiguredPrDetails>>, RpcError> {
        let Some(config) = &self.root.config.github_read else {
            return Ok(None);
        };
        let root = self.root.clone();
        crate::configured_pr_details::ConfiguredPrDetails::new(
            milagre_pr_details::CapturedContext {
                project: self.root.project(),
                program: config.program.clone(),
                home: config.home.clone(),
                config_directory: config.config_directory.clone(),
                owner: config.owner.clone(),
                repository: config.repository.clone(),
                account_login: config.account_login.clone(),
                path: config.path.clone(),
                computer_label: "this computer".into(),
                lifetime: self.root.clone(),
                check: Arc::new(move || root.check().map_err(|e| e.message)),
                local_commits: None,
            },
        )
        .map(Some)
    }
    #[cfg(feature = "routine-execution-fixture")]
    pub(crate) fn routine_execution_model(&self) -> Option<String> {
        let manifest: Value = serde_json::from_slice(&self.root.manifest).ok()?;
        (self.root.config.fixture && manifest["routineExecutionFixture"] == true)
            .then(|| self.root.config.model.clone())
    }
    pub(crate) fn data_root(&self) -> &Path {
        self.root.isolation.root()
    }
    pub(crate) fn retained_check(&self) -> crate::configured_terminals::Check {
        let root = self.root.clone();
        Arc::new(move || root.check())
    }
    pub(crate) fn check(&self) -> Result<(), RpcError> {
        self.root.check()
    }
    pub(crate) fn require_project(&self, value: Option<&Value>) -> Result<(), RpcError> {
        if value.and_then(Value::as_str) != self.root.project().to_str() {
            return Err(refused("Choose the configured dedicated Project"));
        }
        Ok(())
    }
    pub(crate) fn validate_send(&self, request: &Value) -> Result<(), RpcError> {
        self.check()?;
        self.require_project(request.get("projectPath"))?;
        if request.get("chatId").is_some() {
            return Err(refused(
                "Chat identity is assigned by the owner, not the send request",
            ));
        }
        if request["provider"] != self.root.config.provider
            || request["model"] != self.root.config.model
        {
            return Err(refused(
                "This runtime starts only its explicitly configured provider and model",
            ));
        }
        Ok(())
    }
    #[cfg(test)]
    pub(crate) fn call(&self, method: &str, args: &[Value], state: Value) -> RpcResult {
        self.call_with_git(method, args, state, false)
    }
    pub(crate) fn call_with_git(
        &self,
        method: &str,
        args: &[Value],
        state: Value,
        git: bool,
    ) -> RpcResult {
        self.check()?;
        let config = &self.root.config;
        let project = self.root.project();
        if matches!(
            method,
            "canvas:snapshot" | "canvas:links" | "link:list" | "accounts:scopes"
        ) && !args.is_empty()
        {
            return Err(refused(
                "Dedicated bootstrap reads do not accept caller scopes or state",
            ));
        }
        if matches!(
            method,
            "agent:models" | "agent:cli-status" | "accounts:scope"
        ) && args.first().is_some_and(|v| !v.is_null())
        {
            self.require_project(args.first())?;
        }
        if (method == "accounts:list" && args.first().is_some_and(|v| !v.is_null() && v != false))
            || (method == "accounts:scope"
                && args.get(1).is_some_and(|v| !v.is_null() && v != false))
        {
            return Err(refused(
                "This runtime does not inspect or refresh account authentication",
            ));
        }
        let row = json!({"id":project,"path":project,"name":"Rust Chat","git":git,"position":null});
        match method {
            "project:known" | "project:recent" | "project:registry" => Ok(json!([row])),
            // This dedicated root has exactly one Project and no Link/group/position writer.
            // The actor supplies its current owned state; no stale disk read or seeded transcript.
            "canvas:snapshot" => {
                if !state.is_object()
                    || state["worktrees"]["1"]["path"].as_str() != project.to_str()
                {
                    return Err(refused(
                        "Canvas snapshot needs the current owned Project state",
                    ));
                }
                Ok(
                    json!({"projects":[row],"links":[],"projectGroups":[],"worktreePositions":{},"states":[{"path":project,"state":state}]}),
                )
            }
            "canvas:links" | "link:list" => Ok(json!([])),
            "agent:models" => Ok(
                json!({(config.provider.clone()):[{"id":config.model,"name":config.model,"description":if config.fixture {"Configured fixed child; no model inference"} else {"Explicitly configured model; catalog discovery is not run"},"efforts":[],"ultracode":config.provider=="claude","fastMode":config.provider=="claude"}]}),
            ),
            "agent:cli-status" => Err(RpcError::new(
                "CLI_STATUS_UNAVAILABLE",
                "This runtime has not inspected the selected CLI or account authentication.",
            )),
            "accounts:list" => Ok(selected_accounts(
                self.accounts.snapshot(),
                &config.provider,
            )),
            "accounts:scopes" => Ok(
                json!([{"key":project,"name":row["name"],"kind":"project","projects":[{"id":project,"path":project,"name":row["name"]}]}]),
            ),
            "accounts:scope" => {
                self.require_project(args.first())?;
                self.accounts
                    .scope_snapshot(
                        project
                            .to_str()
                            .ok_or_else(|| refused("Project path isn't UTF-8"))?,
                    )
                    .map(|snapshot| selected_accounts(snapshot, &config.provider))
                    .map_err(|e| refused(e.to_string()))
            }
            _ => Err(refused("This runtime does not provide that service")),
        }
    }
}

fn selected_accounts(mut snapshot: Value, selected: &str) -> Value {
    if let Some(providers) = snapshot["providers"].as_array_mut() {
        providers.retain(|provider| provider["provider"] == selected);
    }
    snapshot
}

#[derive(Clone)]
enum ProviderMonitor {
    Claude(FixtureMonitor),
    Codex(crate::codex_fixture::FixtureMonitor),
}
impl ProviderMonitor {
    fn workers(&self) -> usize {
        match self {
            Self::Claude(v) => v.workers(),
            Self::Codex(v) => v.workers(),
        }
    }
    fn cleanup_failed(&self) -> bool {
        match self {
            Self::Claude(v) => v.cleanup_failed(),
            Self::Codex(v) => v.cleanup_failed(),
        }
    }
    fn wait_drained(&self, timeout: Duration) -> bool {
        match self {
            Self::Claude(v) => v.wait_drained(timeout),
            Self::Codex(v) => v.wait_drained(timeout),
        }
    }
}

/// Keeps the persistent-root lease through owner and captured provider cleanup. No destructor deletes data.
pub struct RunningChat {
    pub server: Arc<Server>,
    pub receipt: Value,
    monitor: ProviderMonitor,
    _root: Arc<DataRoot>,
}
impl RunningChat {
    /// Success means owner/wire cleanup and captured worker cleanup finished. Reopen may
    /// then acquire the dedicated root; Drop alone still honors any independently retained leases.
    pub fn finish(self) -> Result<(), Box<dyn std::error::Error>> {
        let Self {
            server,
            monitor,
            _root,
            ..
        } = self;
        let wire_result = Server::finish(server);
        if !monitor.wait_drained(Duration::from_secs(5)) {
            eprintln!("PROVIDER_CLEANUP_PENDING: retaining dedicated data-root ownership until captured workers exit");
            while !monitor.wait_drained(Duration::from_secs(30)) {}
            wire_result?;
            return Err("Provider cleanup exceeded its deadline".into());
        }
        wire_result?;
        if monitor.cleanup_failed() {
            return Err("Provider cleanup reported a failure".into());
        }
        Ok(())
    }
}

/// `create <root> <launch.json>` or `open <root>`. Fixture commands exist only in the separate test feature.
pub fn start(args: &[String]) -> Result<RunningChat, Box<dyn std::error::Error>> {
    let data = match args {
        [mode, root, launch] if mode == "create" => {
            let value = serde_json::from_slice(&read_file(Path::new(launch))?)
                .map_err(|_| refused("Invalid launch JSON"))?;
            DataRoot::create(Path::new(root), LaunchConfig::parse(value, false)?)?
        }
        [mode, root] if mode == "open" => DataRoot::open(Path::new(root), false)?,
        #[cfg(feature = "routine-execution-fixture")]
        [mode, root]
            if matches!(
                mode.as_str(),
                "routine-fixture-create"
                    | "routine-blocked-fixture-create"
                    | "routine-new-chat-fixture-create"
                    | "routine-quiet-fixture-create"
            ) =>
        {
            let root = check_location(Path::new(root), &protected_policy())?;
            let config = fixture_config(&root)?;
            let data = DataRoot::create_variant(
                &root,
                config,
                true,
                mode == "routine-blocked-fixture-create",
                mode == "routine-quiet-fixture-create",
            )?;
            fs::DirBuilder::new()
                .mode(0o700)
                .create(&data.config.home)?;
            fs::DirBuilder::new()
                .mode(0o700)
                .create(&data.config.config_directory)?;
            seed_due_routine(
                &data,
                matches!(
                    mode.as_str(),
                    "routine-new-chat-fixture-create" | "routine-quiet-fixture-create"
                ),
            )?;
            data
        }
        #[cfg(feature = "routine-execution-fixture")]
        [mode, root] if mode == "routine-fixture-open" => DataRoot::open(Path::new(root), true)?,
        #[cfg(feature = "chat-runtime-fixture")]
        [mode, root] if mode == "fixture-create" => {
            let root = check_location(Path::new(root), &protected_policy())?;
            let config = fixture_config(&root)?;
            let data = DataRoot::create(&root, config)?;
            fs::DirBuilder::new()
                .mode(0o700)
                .create(data.config.home.clone())?;
            fs::DirBuilder::new()
                .mode(0o700)
                .create(data.config.config_directory.clone())?;
            data
        }
        #[cfg(feature = "chat-runtime-fixture")]
        [mode, root] if mode == "fixture-open" => DataRoot::open(Path::new(root), true)?,
        _ => return Err(refused(
            "Usage: chat-runtime create <new-data-root> <launch.json> | open <dedicated-data-root>",
        )
        .into()),
    };
    let profile = IsolatedProfile::create()?;
    let project = data.project();
    let config = &data.config;
    let accounts = config.accounts()?;
    let selection = accounts.pin(project.to_str())?;
    if selection.account_id(&config.provider)? != config.account_id {
        return Err(refused("Configured account selection changed").into());
    }
    let mut selected_claude = None;
    let mut selected_codex = None;
    if config.provider == "claude" {
        #[allow(unused_mut)] // The fixture-only script adds one captured environment entry.
        let mut environment = BTreeMap::from([
            ("HOME".to_string(), config.home.clone().into_os_string()),
            (
                "CLAUDE_CONFIG_DIR".into(),
                config.config_directory.clone().into_os_string(),
            ),
            ("PATH".into(), config.path.clone().into()),
            ("USER".into(), config.user_name.clone().into()),
            ("LOGNAME".into(), config.user_name.clone().into()),
        ]);
        #[cfg(feature = "chat-runtime-fixture")]
        if config.fixture {
            let script = profile.path().join("fixed-child.json");
            let file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&script)?;
            serde_json::to_writer(file, &fixture_script(&data)?)?;
            environment.insert("FAKE_CLAUDE_SCRIPT".into(), script.into_os_string());
        }
        let mut launch = LaunchOptions::new(&config.program);
        launch.cwd = Some(project.clone());
        launch.env = Some(
            environment
                .into_iter()
                .map(|(key, value)| (key.into(), value))
                .collect(),
        );
        let ordinary = ClaudeInstructionInputs::bundled(
            &config.skills_directory,
            crate::instructions::HostNetwork::default(),
            true,
        )?;
        let provider = ClaudeProvider::configured(ClaudeLaunchContext {
            isolation: data.isolation.clone(),
            project: project.clone(),
            launch,
            ordinary,
            lifetime: Some(data.clone()),
        })?;
        selected_claude = Some(provider);
    } else {
        let skills = config.skills_directory.canonicalize()?;
        let writing = fs::read_to_string(skills.join("tldr/default.md"))?;
        let bundle = crate::instructions::Bundle::new(
            skills.to_str().ok_or("Skills path is not UTF-8")?,
            &writing,
        )?;
        let retained = data.clone();
        let provider = crate::codex_fixture::CodexFixture::configured(
            crate::configured_codex::CodexLaunchContext {
                isolation: data.isolation.clone(),
                project: project.clone(),
                program: config.program.clone(),
                home: config.home.clone(),
                config_directory: config.config_directory.clone(),
                path: config.path.clone(),
                user_name: config.user_name.clone(),
                model: config.model.clone(),
                developer_instructions: bundle.milagre_instructions(true, None, false),
                tldr_enabled: true,
                lifetime: data.clone(),
                check: Arc::new(move || retained.check().map_err(|e| e.message)),
            },
        )?;
        selected_codex = Some(provider);
    }
    let root = Arc::downgrade(&data);
    let content = crate::claude_content::SharedContent::configured(
        data.isolation.clone(),
        project.clone(),
        config.skills_directory.clone(),
        Arc::new(move || {
            root.upgrade()
                .ok_or_else(|| {
                    milagre_content_store::Error::coded(
                        "CONTENT_OWNER_INACTIVE",
                        "The dedicated owner was released",
                    )
                })?
                .check()
                .map_err(|error| milagre_content_store::Error::coded(&error.code, error.message))
        }),
    )?;
    // The content owner retains only monitor state, never the provider/context itself.
    let monitor = if let Some(provider) = &selected_claude {
        ProviderMonitor::Claude(provider.monitor())
    } else {
        ProviderMonitor::Codex(selected_codex.as_ref().unwrap().monitor())
    };
    let drain = monitor.clone();
    content.retain_native_drain(Arc::new(move || drain.workers() == 0));
    let provider: Box<dyn milagre_owner_store::chat_host::Provider> =
        if let Some(mut provider) = selected_claude {
            provider.content = Some(content.clone());
            Box::new(provider)
        } else {
            Box::new(selected_codex.take().unwrap())
        };
    let (server, mut metadata) = crate::actor::start_configured(
        profile,
        data.isolation.clone(),
        project,
        provider,
        content,
        Bootstrap {
            root: data.clone(),
            accounts,
        },
    )?;
    metadata["restartable"] = json!(true);
    metadata["configuredProvider"] = json!(true);
    metadata["provider"] = json!(config.provider);
    metadata["model"] = json!(config.model);
    metadata["accountId"] = json!(config.account_id);
    metadata["accountLabel"] = json!(config.account_label);
    let receipt = json!({"profile":server.profile_path(),"socket":server.socket_path(),"pid":std::process::id(),"protocolVersion":1,"restartable":true,"fixture":config.fixture,"fakeClaude":config.fixture,"dataRoot":data.isolation.root(),"actor":metadata});
    Ok(RunningChat {
        server: Arc::new(server),
        receipt,
        monitor,
        _root: data,
    })
}

#[cfg(feature = "chat-runtime-fixture")]
fn fixture_config(root: &Path) -> Result<LaunchConfig, Box<dyn std::error::Error>> {
    let executable = std::env::current_exe()?;
    let program = executable
        .parent()
        .ok_or("Missing executable parent")?
        .join("runtime-fake-claude")
        .canonicalize()?;
    let bundle = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/core/src/bundled-skills")
        .canonicalize()?;
    Ok(LaunchConfig::parse(
        json!({"program":program,"home":root.join("home"),"configDirectory":root.join("claude-account"),"skillsDirectory":bundle,"model":"sonnet","path":"/usr/bin:/bin","accountId":"11111111-1111-4111-8111-111111111111","accountLabel":"Fixed child account (not authenticated)","userName":"rust-chat-fixture-user"}),
        true,
    )?)
}

#[cfg(feature = "routine-execution-fixture")]
fn seed_due_routine(data: &Arc<DataRoot>, new_chat: bool) -> Result<(), RpcError> {
    let owned = data.clone();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let at = now - 60_000;
    let owner: milagre_routines::OwnerCheck =
        Arc::new(move || owned.check().map_err(|e| e.message));
    let mut store = milagre_routines::RoutineStore::open(data.isolation.root(), owner, at)
        .map_err(|e| refused(e.to_string()))?;
    let target = if new_chat {
        json!({"kind":"new-chat","projectPath":data.project(),"workspace":"project"})
    } else {
        json!({"kind":"chat","chatId":format!("{}#1",data.project().display())})
    };
    store.execute(milagre_routines::StoreCommand::Create(json!({"name":"Actor timer fixture","prompt":"Check the scheduled actor fixture","trigger":{"kind":"schedule","cron":"* * * * *","timezone":"UTC"},"target":target,"createdBy":{"kind":"user"},"provider":"claude","model":data.config.model,"permissionMode":"ask","maxRuns":1})), at).map_err(|e|refused(e.to_string()))?;
    store.close().map_err(|e| refused(e.to_string()))
}

#[cfg(feature = "chat-runtime-fixture")]
fn fixture_script(root: &DataRoot) -> Result<Value, RpcError> {
    #[cfg(feature = "routine-execution-fixture")]
    if serde_json::from_slice::<Value>(&root.manifest).map_err(|e| refused(e.to_string()))?
        ["routineExecutionFixture"]
        == true
    {
        let blocked = serde_json::from_slice::<Value>(&root.manifest)
            .map_err(|e| refused(e.to_string()))?["routineFixtureBlocked"]
            == true;
        let quiet = serde_json::from_slice::<Value>(&root.manifest)
            .map_err(|e| refused(e.to_string()))?["routineFixtureQuiet"]
            == true;
        let reply = if quiet {
            "(pass) Actor timer clean"
        } else {
            "Actor timer completed"
        };
        let mut script = json!([
            {"expect":{"subtype":"initialize"}}, {"reply":{}},
            {"expect":{"subtype":"set_max_thinking_tokens"}}, {"reply":{}},
            {"expect":{"type":"user","fields":{"/message/content":[{"type":"text","text":format!("Check the scheduled actor fixture{}","\n\nIf nothing needs doing, reply starting with \"(pass)\" and a short reason.")}]}}},
            {"emit":{"type":"system","subtype":"init","session_id":"actor-routine-native"}},
            {"emit":{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":reply}}}},
            {"emit":{"type":"result","subtype":"success","num_turns":1,"result":"done"}},
            {"wait_eof":true}
        ]);
        if blocked {
            script.as_array_mut().unwrap().truncate(6);
            script
                .as_array_mut()
                .unwrap()
                .push(json!({"wait_eof":true}));
        }
        return Ok(script);
    }
    let state: Value = milagre_owner_store::jsjson::parse_bytes(&read_coordination(
        &root.project().join(".milagre/coordination.json"),
    )?)
    .map_err(|_| refused("Invalid fixture coordination state"))?;
    let resume = state["sessions"].as_object().and_then(|sessions| {
        sessions
            .values()
            .find_map(|session| session["native_session_id"].as_str())
    });
    let mut launch = json!({"absent":["--no-session-persistence"],"env":{"USER":root.config.user_name,"LOGNAME":root.config.user_name}});
    if let Some(resume) = resume {
        launch["flags"] = json!([format!("--resume={resume}")]);
    } else {
        launch["absent"]
            .as_array_mut()
            .unwrap()
            .push(json!("--resume"));
    }
    let mut steps = vec![
        json!({"expect_launch":launch}),
        json!({"expect":{"subtype":"initialize"}}),
        json!({"reply":{}}),
        json!({"expect":{"subtype":"set_max_thinking_tokens"}}),
        json!({"reply":{}}),
    ];
    for turn in 0..1 {
        let id = format!("restart-permission-{turn}");
        steps.extend([
            json!({"expect":{"type":"user"}}),
            json!({"emit":{"type":"system","subtype":"init","session_id":"restartable-native-session"}}),
            json!({"request":{"id":id,"request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"printf synthetic-approved"}}}}),
            json!({"expect":{"type":"control_response","fields":{"/response/request_id":id,"/response/response/behavior":"allow"}}}),
        ]);
        let content_calls = if resume.is_some() {
            vec![
                ("artifact_read", json!({"id":"configured-report"})),
                ("design_read", json!({"id":"configured-screen"})),
            ]
        } else {
            vec![
                (
                    "artifact_show",
                    json!({"id":"configured-report","title":"Configured report","html":"<main>Configured native content</main>"}),
                ),
                (
                    "design_show",
                    json!({"id":"configured-screen","title":"Configured screen","document":{"schemaVersion":1,"width":390,"height":260,"background":"#ffffff","nodes":[{"id":"heading","type":"text","x":24,"y":32,"width":342,"height":96,"text":"Configured native design","fontFamily":"Inter","fontSize":28,"fill":"#29261f"}]}}),
                ),
            ]
        };
        for (index, (tool, arguments)) in content_calls.into_iter().enumerate() {
            let request = format!("configured-content-{index}");
            steps.extend([
                json!({"request":{"id":request,"request":{"subtype":"mcp_message","server_name":"milagre","message":{"jsonrpc":"2.0","id":index+1,"method":"tools/call","params":{"name":tool,"arguments":arguments}}}}}),
                json!({"expect":{"type":"control_response","fields":{"/response/request_id":request,"/response/response/mcp_response/result/isError":false}}}),
            ]);
        }
        steps.extend([
            json!({"emit":{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Restartable "}}}}),
            json!({"emit":{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Claude reply"}}}}),
            json!({"emit":{"type":"result","subtype":"success","num_turns":1,"result":"done"}}),
        ]);
    }
    steps.push(json!({"wait_eof":true}));
    Ok(json!(steps))
}

#[cfg(test)]
mod tests {
    use super::*;
    use milagre_owner_store::{
        chat_host::{ChatHost, MockProvider},
        jsjson,
        states::{ProjectStates, Timing},
    };

    fn config() -> LaunchConfig {
        LaunchConfig::parse(json!({"program":"/explicit/unused-claude","home":"/explicit/unused-home","configDirectory":"/explicit/unused-account","skillsDirectory":"/explicit/unused-bundle","model":"sonnet","path":"/usr/bin:/bin","accountId":"11111111-1111-4111-8111-111111111111","accountLabel":"Explicit selected account","userName":"explicit-user"}), false).unwrap()
    }

    #[test]
    fn launch_provider_is_optional_legacy_claude_or_explicit_codex_only() {
        let value = config().value;
        let legacy = LaunchConfig::parse(value.clone(), false).unwrap();
        assert_eq!(legacy.provider, "claude");
        assert!(legacy.value.get("provider").is_none());
        let mut codex = value.clone();
        codex["provider"] = json!("codex");
        let parsed = LaunchConfig::parse(codex.clone(), false).unwrap();
        assert_eq!(
            parsed
                .accounts()
                .unwrap()
                .pin(Some("/explicit/project"))
                .unwrap()
                .account_id("codex")
                .unwrap(),
            parsed.account_id
        );
        assert!(LaunchConfig::parse(codex, true).is_err());
        for unsupported in [json!(null), json!(true), json!("unknown"), json!("Codex")] {
            let mut bad = value.clone();
            bad["provider"] = unsupported;
            assert!(LaunchConfig::parse(bad, false).is_err());
        }
    }

    #[cfg(feature = "routine-execution-fixture")]
    #[test]
    fn execution_activation_rejects_normal_roots_before_creation_and_reopen() {
        let parent = IsolatedProfile::create().unwrap();
        let forbidden = parent.path().join("forbidden");
        assert!(DataRoot::create_inner(&forbidden, config(), true).is_err());
        assert!(!forbidden.exists());
        let path = parent.path().join("normal");
        let root = DataRoot::create(&path, config()).unwrap();
        let bootstrap = Bootstrap {
            accounts: root.config.accounts().unwrap(),
            root: root.clone(),
        };
        assert!(bootstrap.routine_execution_model().is_none());
        drop(bootstrap);
        drop(root);
        let mut manifest: Value =
            serde_json::from_slice(&fs::read(path.join(MANIFEST)).unwrap()).unwrap();
        manifest["routineExecutionFixture"] = json!(true);
        fs::write(path.join(MANIFEST), manifest.to_string()).unwrap();
        assert!(DataRoot::open(&path, false).is_err());
    }

    #[test]
    fn user_identity_is_explicit_bounded_and_not_nul() {
        let valid = config().value;
        for invalid in [
            Value::Null,
            json!(""),
            json!("   "),
            json!("user\0name"),
            json!("x".repeat(257)),
        ] {
            let mut value = valid.clone();
            value["userName"] = invalid;
            assert!(LaunchConfig::parse(value, false).is_err());
        }
        let mut missing = valid.clone();
        missing.as_object_mut().unwrap().remove("userName");
        assert!(LaunchConfig::parse(missing, false).is_err());
        assert_eq!(
            LaunchConfig::parse(valid, false).unwrap().user_name,
            "explicit-user"
        );
    }

    #[test]
    fn configured_bootstrap_reads_match_node_shapes_and_current_owner_state() {
        let parent = IsolatedProfile::create().unwrap();
        let root = DataRoot::create(&parent.path().join("durable"), config()).unwrap();
        let project = root.project();
        let bootstrap = Bootstrap {
            accounts: root.config.accounts().unwrap(),
            root: root.clone(),
        };
        let mut host = ChatHost::new(ProjectStates::new(
            root.isolation.clone(),
            Timing::default(),
            0,
        ));
        host.register(Box::new(MockProvider::new("claude")));
        host.open_project(&project).unwrap();
        let before = host.states.whole_state(&project).unwrap();
        host.send(&json!({"projectPath":project,"sessionId":1,"provider":"claude","model":"sonnet","body":"current owned canvas state","clientMessageId":"canvas-read"})).unwrap();
        let state = host.states.whole_state(&project).unwrap();
        assert_ne!(state, before);
        // Existing recorder runs actual Node runtime/project-registry/account implementations.
        // Only the known Project identity/name, absent historical timestamp and current owner
        // state differ here; retain all four recorded result shapes.
        let oracle: Value =
            serde_json::from_str(include_str!("../fixtures/app-bootstrap.json")).unwrap();
        fn replace(value: &mut Value, project: &str) {
            match value {
                Value::String(text) if text == "$PROJECT" => *text = project.into(),
                Value::String(text) if text == "fixture" => *text = "Rust Chat".into(),
                Value::Array(values) => values.iter_mut().for_each(|value| replace(value, project)),
                Value::Object(values) => {
                    values.remove("openedAt");
                    values
                        .values_mut()
                        .for_each(|value| replace(value, project));
                }
                _ => {}
            }
        }
        for method in [
            "canvas:snapshot",
            "canvas:links",
            "link:list",
            "accounts:scopes",
        ] {
            let mut expected = oracle["cases"]
                .as_array()
                .unwrap()
                .iter()
                .find(|case| case["method"] == method)
                .unwrap()["result"]
                .clone();
            replace(&mut expected, project.to_str().unwrap());
            if method == "canvas:snapshot" {
                expected["states"][0]["state"] = state.clone();
            }
            assert_eq!(
                bootstrap.call(method, &[], state.clone()).unwrap(),
                expected,
                "{method}"
            );
            assert_eq!(
                bootstrap
                    .call(method, &[json!("/foreign")], state.clone())
                    .unwrap_err()
                    .code,
                "CHAT_RUNTIME_CONFIG"
            );
        }
        assert!(bootstrap.call("canvas:snapshot", &[], Value::Null).is_err());
        assert_eq!(
            bootstrap
                .call("agent:cli-status", &[json!(project)], Value::Null)
                .unwrap_err()
                .code,
            "CLI_STATUS_UNAVAILABLE"
        );
        assert_eq!(
            bootstrap
                .call("agent:cli-status", &[json!("/foreign")], Value::Null)
                .unwrap_err()
                .code,
            "CHAT_RUNTIME_CONFIG"
        );
        assert!(bootstrap
            .call(
                "accounts:scope",
                &[json!(project), json!(true)],
                Value::Null
            )
            .is_err());
        fs::write(root.isolation.root().join(MANIFEST), b"{}").unwrap();
        for method in [
            "canvas:snapshot",
            "canvas:links",
            "link:list",
            "accounts:scopes",
        ] {
            assert!(
                bootstrap.call(method, &[], state.clone()).is_err(),
                "changed authority: {method}"
            );
        }
        host.shutdown(true).unwrap();
    }

    #[test]
    fn durable_root_reopens_without_seeding_and_refuses_competing_owner() {
        let parent = IsolatedProfile::create().unwrap();
        let path = parent.path().join("durable");
        let root = DataRoot::create(&path, config()).unwrap();
        let manifest = fs::read(path.join(MANIFEST)).unwrap();
        let state = fs::read(root.project().join(".milagre/coordination.json")).unwrap();
        let seeded: Value = serde_json::from_slice(&state).unwrap();
        assert_eq!(seeded["projects"]["1"], json!({"id":1,"name":"Rust Chat"}));
        assert_eq!(seeded["worktrees"]["1"]["project_id"], 1);
        assert_eq!(seeded["sessions"]["1"]["agent_name"], "main");
        assert_eq!(seeded["sessions"]["1"]["status"], "Created");
        assert_eq!(
            DataRoot::open(&path, false).err().unwrap().code,
            "CHAT_ROOT_BUSY"
        );
        assert!(DataRoot::create(&path, config()).is_err());
        assert_eq!(
            fs::metadata(path.join(MANIFEST)).unwrap().mode() & 0o777,
            0o600
        );
        let accounts = root.config.accounts().unwrap();
        assert!(accounts
            .snapshot()
            .to_string()
            .contains("Explicit selected account"));
        drop(root);
        let reopened = DataRoot::open(&path, false).unwrap();
        assert_eq!(fs::read(path.join(MANIFEST)).unwrap(), manifest);
        assert_eq!(
            fs::read(reopened.project().join(".milagre/coordination.json")).unwrap(),
            state
        );
    }

    #[test]
    fn final_root_lease_unlocks_even_while_an_inherited_description_exists() {
        let parent = IsolatedProfile::create().unwrap();
        let path = parent.path().join("durable");
        let root = DataRoot::create(&path, config()).unwrap();
        // dup shares the same open-file description, as a concurrent fork does until its exec
        // closes CLOEXEC descriptors. Such a descriptor is not another owner authority lease.
        let inherited = root.lock.try_clone().unwrap();
        let captured = root.clone();
        drop(root);
        assert!(DataRoot::open(&path, false).is_err());
        drop(captured);
        let reopened = DataRoot::open(&path, false).unwrap();
        drop(inherited);
        assert!(
            DataRoot::open(&path, false).is_err(),
            "closing the old description must not unlock the new owner"
        );
        drop(reopened);
    }

    #[test]
    fn unmarked_or_existing_root_is_never_adopted_or_seeded() {
        let parent = IsolatedProfile::create().unwrap();
        let path = parent.path().join("unmarked");
        fs::create_dir(&path).unwrap();
        fs::write(path.join("sentinel"), b"keep").unwrap();
        assert!(DataRoot::create(&path, config()).is_err());
        assert!(DataRoot::open(&path, false).is_err());
        assert_eq!(fs::read(path.join("sentinel")).unwrap(), b"keep");
        assert_eq!(fs::read_dir(path).unwrap().count(), 1);
    }

    #[test]
    fn changed_launch_manifest_revokes_the_captured_configuration() {
        let parent = IsolatedProfile::create().unwrap();
        let root = DataRoot::create(&parent.path().join("durable"), config()).unwrap();
        fs::write(root.isolation.root().join(MANIFEST), b"{}").unwrap();
        assert!(root
            .check()
            .unwrap_err()
            .message
            .contains("configuration changed"));
    }

    #[test]
    fn ordinary_create_and_open_need_no_provider_or_credential_execution() {
        let parent = IsolatedProfile::create().unwrap();
        let root = parent.path().join("ordinary");
        let launch = parent.path().join("launch.json");
        let mut value = config().value;
        value["skillsDirectory"] = json!(Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/core/src/bundled-skills")
            .canonicalize()
            .unwrap());
        fs::write(&launch, value.to_string()).unwrap();
        // The explicit unused executable/home/account do not exist. Startup reads only the selected
        // instruction bundle and our new data root; native execution starts only on an admitted send.
        let running = start(&[
            "create".into(),
            root.to_string_lossy().into(),
            launch.to_string_lossy().into(),
        ])
        .unwrap();
        assert_eq!(running.receipt["fixture"], false);
        assert_eq!(
            running.receipt["actor"]["accountLabel"],
            "Explicit selected account"
        );
        assert_eq!(running.monitor.workers(), 0);
        running.finish().unwrap();
        let reopened = start(&["open".into(), root.to_string_lossy().into()]).unwrap();
        assert_eq!(reopened.monitor.workers(), 0);
        drop(reopened);
        assert!(DataRoot::open(&root, false).is_ok());
    }

    #[test]
    fn clean_owner_shutdown_reopens_large_held_queue_with_lone_surrogate() {
        let parent = IsolatedProfile::create().unwrap();
        let path = parent.path().join("durable");
        let root = DataRoot::create(&path, config()).unwrap();
        let project = root.project();
        let mut host = ChatHost::new(ProjectStates::new(
            root.isolation.clone(),
            Timing::default(),
            0,
        ));
        let provider = MockProvider::new("claude");
        host.register(Box::new(provider.clone()));
        host.open_project(&project).unwrap();
        let request = json!({"projectPath":project,"sessionId":1,"provider":"claude","model":"sonnet","body":"first","clientMessageId":"first"});
        host.send(&request).unwrap();
        assert!(host.pump().is_empty());
        let mut queued = request.clone();
        queued["clientMessageId"] = json!("held");
        queued["delivery"] = json!("queue");
        queued["body"] = jsjson::parse(&format!("\"{}\\ud800\"", "q".repeat(40 * 1024))).unwrap();
        assert!(host.send(&queued).unwrap().queued);
        let chat = format!("{}#1", project.display());
        host.interrupt(&chat).unwrap();
        provider.emit(&chat, json!({"type":"turn-cancelled"}));
        assert!(host.pump().is_empty());
        host.shutdown(false).unwrap();
        drop(host);
        drop(root);
        let reopened = DataRoot::open(&path, false).unwrap();
        let saved = jsjson::parse_bytes(
            &read_coordination(&reopened.project().join(".milagre/coordination.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(saved["sessions"]["1"]["queued"][0]["body"], queued["body"]);
        assert_eq!(saved["sessions"]["1"]["queueHeld"], true);
        assert!(
            saved["sessions"]["1"]["queued"][0]["body"]
                .as_str()
                .unwrap()
                .len()
                > MANIFEST_LIMIT
        );
    }
}

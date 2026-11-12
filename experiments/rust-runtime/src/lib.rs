//! Isolated read/PTY and owner adapters. The optional chat-runtime entrypoint owns one explicit dedicated
//! persistent Project with a captured Claude configuration; it never adopts a production profile or socket.
#[cfg(feature = "acp-fixture")]
pub mod acp_fixture;
pub mod actor;
#[cfg(feature = "app-fixture")]
mod app_content;
#[cfg(feature = "app-fixture")]
pub mod app_fixture;
mod artifacts;
#[cfg(feature = "chat-runtime")]
mod chat_bootstrap;
#[cfg(feature = "chat-runtime")]
pub mod chat_runtime;
mod claude_content;
pub mod claude_fixture;
pub mod codex_fixture;
#[cfg(feature = "chat-runtime")]
mod configured_git;
#[cfg(feature = "chat-runtime")]
mod configured_routines;
#[cfg(feature = "chat-runtime")]
mod configured_terminals;
pub mod content_fixture;
mod copies;
mod executor;
mod git;
mod inbox;
pub mod instructions;
mod jobs;
mod owned;
mod ports;
#[cfg(all(test, feature = "routine-execution-fixture"))]
mod routine_execution_fixture;
mod terminals;

pub use copies::SavedCopies;
use milagre_owner_store::jsjson;
use milagre_owner_wire::{
    ClientContext, Config, Handler, IsolatedProfile, RpcError, RpcResult, Server,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

#[derive(Clone, Debug)]
pub struct ProjectInfo {
    pub path: String,
    pub name: String,
}

/// Replaceable boundary for the future ProjectStates owner adapter. The current implementation reads sealed copies.
pub trait ReadBackend: Send + Sync + 'static {
    fn projects(&self) -> Vec<ProjectInfo>;
    fn state(&self, path: &str) -> RpcResult;
    fn messages(&self, path: &str, chat: i64, options: Option<&Value>, opened: bool) -> RpcResult;
    fn message(&self, path: &str, id: &Value) -> RpcResult;
    fn send_status(&self, path: &str, identity: &str) -> RpcResult;
    fn has_database(&self, path: &str) -> Result<bool, RpcError>;
    fn inbox_state(&self, path: &str) -> RpcResult {
        self.state(path)
    }
    fn extra_methods(&self) -> Vec<String> {
        Vec::new()
    }
    fn call(&self, method: &str, _args: &[Value]) -> RpcResult {
        Err(RpcError::new(
            "COMMAND_FAILED",
            format!("Unknown command: {method}"),
        ))
    }
    fn assert_owned(&self, _path: &str) -> Result<(), RpcError> {
        Err(RpcError::new(
            "OWNERSHIP_UNVERIFIED",
            "This backend has no verified ownership adapter",
        ))
    }
    fn shutdown(&self) -> Result<(), RpcError> {
        Ok(())
    }
}

pub struct ReadHandler {
    backend: Arc<dyn ReadBackend>,
    opened: Arc<Mutex<Vec<String>>>,
    epoch: String,
    versions: Mutex<HashMap<String, (String, u64)>>,
    terminals: Option<terminals::TerminalService>,
    artifacts: Option<Arc<artifacts::ArtifactService>>,
    git: Option<git::GitService>,
}
impl ReadHandler {
    pub fn new(backend: Arc<dyn ReadBackend>, epoch: String) -> Self {
        Self {
            backend,
            opened: Arc::new(Mutex::new(Vec::new())),
            epoch,
            versions: Mutex::new(HashMap::new()),
            terminals: None,
            artifacts: None,
            git: None,
        }
    }
    fn info(&self, path: &str) -> Result<ProjectInfo, RpcError> {
        self.backend
            .projects()
            .into_iter()
            .find(|project| project.path == path)
            .ok_or_else(|| {
                RpcError::new(
                    "ISOLATED_SCOPE_ONLY",
                    "Only this runtime's embedded fixture copies can be read",
                )
            })
    }
    fn require_open(&self, path: &str, message: &str) -> Result<(), RpcError> {
        self.info(path)?;
        if self
            .opened
            .lock()
            .unwrap()
            .iter()
            .any(|opened| opened == path)
        {
            Ok(())
        } else {
            Err(RpcError::new("COMMAND_FAILED", message))
        }
    }
    fn project(&self, path: &str) -> RpcResult {
        let info = self.info(path)?;
        let state = self.backend.state(path)?;
        Ok(json!({"path":info.path,"name":info.name,"git":false,"state":state}))
    }
    fn open(&self, path: &str, context: &ClientContext) -> RpcResult {
        // Opens are subscription metadata only; fixture bytes and Project ownership never change.
        context.events.transaction(|_| {
            let result = self.project(path)?;
            let mut opened = self.opened.lock().unwrap();
            if !opened.iter().any(|current| current == path) {
                opened.push(path.into());
            }
            Ok(result)
        })
    }
    fn inbox_scopes(&self) -> Result<Vec<Value>, RpcError> {
        let paths = self.opened.lock().unwrap().clone();
        paths
            .iter()
            .map(|path| {
                let info = self.info(path)?;
                Ok(json!({"path":path,"name":info.name,"state":self.backend.inbox_state(path)?}))
            })
            .collect()
    }
    fn state_read(&self, path: &str) -> RpcResult {
        let state = self.backend.state(path)?;
        let digest = hex::encode(Sha256::digest(jsjson::to_string(&state).as_bytes()));
        let mut versions = self.versions.lock().unwrap();
        let (previous, version) = versions.entry(path.into()).or_insert((digest.clone(), 1));
        if *previous != digest {
            *previous = digest;
            *version += 1;
        }
        Ok(json!({"state":state,"version":version,"epoch":self.epoch}))
    }
    fn scopes(&self) -> Result<Vec<Value>, RpcError> {
        let paths: Vec<_> = self.opened.lock().unwrap().iter().cloned().collect();
        paths.iter().map(|path| self.project(path)).collect()
    }
}
const READ_METHODS: &[&str] = &[
    "project:open",
    "project:current",
    "project:switch",
    "project:snapshot",
    "project:read",
    "state:read",
    "chat:messages",
    "chat:message",
    "chat:send-status",
    "chat:inbox",
    "designs:enabled:read",
    "designs:enabled:save",
];
// Explicit failure beats a successful-looking empty response. These remain unsupported in the fixture runtime.
const UNSUPPORTED_MUTATIONS: &[&str] = &[
    "chat:send",
    "chat:stop",
    "chat:create",
    "chat:delete",
    "chat:archive",
    "chat:rename",
    "chat:mark-read",
    "chat:permission",
    "chat:answer",
    "worktree:create",
    "worktree:remove",
    "project:forget",
    "scope:retry-save",
    "link:open",
    "link:create",
    "command:run",
    "desktop:invoke",
    "artifact:apply",
    "artifact:delete",
    "artifact:add-comments",
];
impl Handler for ReadHandler {
    fn decode_request(&self, frame: &[u8]) -> Result<Value, RpcError> {
        jsjson::parse_bytes(frame)
            .map_err(|_| RpcError::new("INVALID_REQUEST", "Expected a JSON frame"))
    }
    fn encode_request_id(&self, id: &Value) -> Result<String, RpcError> {
        Ok(jsjson::to_string(id))
    }
    fn string_len(&self, text: &str) -> usize {
        jsjson::utf16_len(text)
    }

    fn methods(&self) -> Vec<String> {
        let mut methods: Vec<String> = READ_METHODS
            .iter()
            .chain(UNSUPPORTED_MUTATIONS)
            .chain(milagre_terminals::wire::COMMANDS.iter())
            .map(|name| (*name).into())
            .collect();
        methods.extend(self.backend.extra_methods());
        if self
            .terminals
            .as_ref()
            .is_some_and(|terminals| terminals.has_ports())
        {
            methods.extend(
                milagre_ports::wire::COMMANDS
                    .iter()
                    .map(|name| (*name).into()),
            );
        }
        if self.artifacts.is_some() {
            methods.extend(artifacts::METHODS.iter().map(|name| (*name).into()));
        }
        if self.git.is_some() {
            methods.extend(
                milagre_git_read::METHODS
                    .iter()
                    .map(|method| (*method).into()),
            );
        }
        methods.sort();
        methods.dedup();
        methods
    }
    fn encode_result(&self, result: &Value) -> Result<String, RpcError> {
        Ok(jsjson::to_string(result))
    }
    fn invoke(&self, method: &str, args: &[Value], context: &ClientContext) -> RpcResult {
        if milagre_git_read::METHODS.contains(&method) {
            return self
                .git
                .as_ref()
                .ok_or_else(|| {
                    RpcError::new(
                        "UNSUPPORTED_SERVICE",
                        "Git reads require the isolated Git fixture",
                    )
                })?
                .invoke(method, args, context);
        }

        if milagre_terminals::wire::COMMANDS.contains(&method) {
            return self
                .terminals
                .as_ref()
                .ok_or_else(|| {
                    RpcError::new(
                        "UNSUPPORTED_SERVICE",
                        "Terminals are not installed in this handler",
                    )
                })?
                .invoke(method, args, context.client_id());
        }
        if milagre_ports::wire::COMMANDS.contains(&method) {
            return self
                .terminals
                .as_ref()
                .ok_or_else(|| {
                    RpcError::new(
                        "UNSUPPORTED_SERVICE",
                        "Ports need the isolated terminal owner",
                    )
                })?
                .invoke_ports(method, args);
        }
        if artifacts::METHODS.contains(&method) {
            if let Some(artifacts) = &self.artifacts {
                return artifacts.invoke(method, args.first().unwrap_or(&Value::Null));
            }
            if method != "artifact:apply" {
                return Err(RpcError::new(
                    "UNSUPPORTED_SERVICE",
                    "Artifacts require verified isolated ownership",
                ));
            }
        }
        if matches!(method, "designs:enabled:read" | "designs:enabled:save") {
            // Production keeps Designs enabled even when an old client writes the retired switch.
            return Ok(json!({"enabled":true}));
        }
        if UNSUPPORTED_MUTATIONS.contains(&method) {
            return Err(RpcError::new(
                "UNSUPPORTED_MUTATION",
                "The isolated Rust read runtime does not execute mutations or start services",
            ));
        }
        if method == "project:current" {
            return match self.backend.projects().first() {
                Some(info) => self.open(&info.path, context),
                None => Ok(Value::Null),
            };
        }
        if method == "chat:inbox" {
            return inbox::snapshot(&self.inbox_scopes()?);
        }
        let scope = args
            .first()
            .and_then(Value::as_str)
            .ok_or_else(|| RpcError::new("COMMAND_FAILED", "Choose a Project path"))?;
        self.info(scope)?;
        match method {
            "project:open" | "project:switch" | "project:read" => self.open(scope, context),
            "project:snapshot" => {
                self.require_open(scope, "Open the project before reading its snapshot.")?;
                self.project(scope)
            }
            "state:read" => {
                self.require_open(scope, "Open the project before reading its snapshot.")?;
                self.state_read(scope)
            }
            "chat:messages" => {
                if !self.backend.has_database(scope)? {
                    self.require_open(scope, "Open the Project before reading its messages.")?;
                }
                let id = args
                    .get(1)
                    .and_then(Value::as_f64)
                    .filter(|n| {
                        n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0
                    })
                    .ok_or_else(|| {
                        RpcError::new(
                            "COMMAND_FAILED",
                            "Choose a Chat with a safe integer identity",
                        )
                    })? as i64;
                self.backend.messages(
                    scope,
                    id,
                    args.get(2),
                    self.opened
                        .lock()
                        .unwrap()
                        .iter()
                        .any(|opened| opened == scope),
                )
            }
            "chat:message" => {
                self.require_open(scope, "Open the Project before reading its messages.")?;
                self.backend
                    .message(scope, args.get(1).unwrap_or(&Value::Null))
            }
            "chat:send-status" => {
                self.require_open(scope, "Choose an open Chat and message identity.")?;
                let identity = args
                    .get(1)
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        RpcError::new(
                            "COMMAND_FAILED",
                            "Choose an open Chat and message identity.",
                        )
                    })?;
                self.backend.send_status(scope, identity)
            }
            _ if self
                .backend
                .extra_methods()
                .iter()
                .any(|name| name == method) =>
            {
                self.require_open(scope, "Open the Project before reading its messages.")?;
                self.backend.call(method, args)
            }
            _ => Err(RpcError::new(
                "COMMAND_FAILED",
                format!("Unknown command: {method}"),
            )),
        }
    }
    fn shutdown(&self) -> RpcResult {
        if let Some(terminals) = &self.terminals {
            terminals.shutdown();
        }
        if let Some(artifacts) = &self.artifacts {
            artifacts.shutdown()?;
        }
        self.backend.shutdown()?;
        Ok(Value::Null)
    }
    fn snapshot(&self, _: &ClientContext) -> RpcResult {
        Ok(
            json!({"projects":self.scopes()?,"links":[],"runs":{"runs":{},"seq":0},"ports":self.terminals.as_ref().map(|terminals| terminals.ports_snapshot()).transpose()?.unwrap_or(json!({}))}),
        )
    }
}

/// Always creates its own fresh private /tmp profile and copies only compile-time fixture bytes.
/// There is no existing-path constructor and no environment-selected profile.
pub fn start() -> Result<Server, RpcError> {
    start_mode(false)
}

/// Actual ProjectStates, owning only this run's freshly created marked fixture copies.
pub fn start_owned() -> Result<Server, RpcError> {
    start_mode(true)
}
/// Private standalone Git fixture attached to one copied Project. No caller supplies paths.
pub fn start_owned_git() -> Result<(Server, Value), RpcError> {
    let started = start_mode_with_git(true, true, None)?;
    Ok((
        started.server,
        started.git_metadata.expect("Git fixture requested"),
    ))
}
fn start_mode(owned: bool) -> Result<Server, RpcError> {
    Ok(start_mode_with_git(owned, false, None)?.server)
}
struct Started {
    server: Server,
    git_metadata: Option<Value>,
    content: Option<Arc<artifacts::ArtifactService>>,
}
fn start_mode_with_git(
    owned: bool,
    with_git: bool,
    raster: Option<Arc<milagre_content_store::design::raster::RasterRenderer>>,
) -> Result<Started, RpcError> {
    let profile = IsolatedProfile::create()?;
    // This profile has just been created empty in canonical /tmp. The policy is checked before
    // fixture copies exist, and there is no caller-supplied path or route to a live Project.
    let isolation = if owned {
        Some(
            milagre_owner_store::Isolation::create(
                profile.path(),
                &milagre_owner_store::Policy::system(),
            )
            .map_err(|error| RpcError::new("ISOLATION_FAILED", error.to_string()))?,
        )
    } else {
        None
    };
    let copies = SavedCopies::create(&profile)?;
    let content_isolation = isolation.clone();
    let backend: Arc<dyn ReadBackend> = match isolation {
        Some(isolation) => Arc::new(owned::OwnedCopies::new(
            copies.projects(),
            isolation,
            profile.lease(),
        )),
        None => Arc::new(copies),
    };
    let epoch = format!("isolated-read:{}", profile.path().display());
    let events = Arc::new(Mutex::new(None));
    let terminal_service = terminals::TerminalService::new(backend.clone(), events.clone(), owned)?;
    let mut handler = ReadHandler::new(backend.clone(), epoch);
    let git_metadata = if with_git {
        let project = backend
            .projects()
            .into_iter()
            .find(|project| project.name == "alpha")
            .expect("alpha fixture")
            .path;
        let git = git::GitService::new(project, backend.clone())?;
        let metadata = git.metadata();
        handler.git = Some(git);
        Some(metadata)
    } else {
        None
    };
    if let Some(isolation) = content_isolation {
        handler.artifacts = Some(Arc::new(artifacts::ArtifactService::new(
            isolation,
            backend,
            handler.opened.clone(),
            raster,
        )?));
    }
    handler.terminals = Some(terminal_service);
    let content = handler.artifacts.clone();
    let server = Server::bind(
        profile,
        Arc::new(handler),
        Config {
            // Intentionally small to exercise the real client's paging on ordinary saved state.
            max_frame_bytes: 4096,
            ..Config::default()
        },
    )?;
    *events.lock().unwrap() = Some(server.events());
    Ok(Started {
        server,
        git_metadata,
        content,
    })
}

#[cfg(test)]
mod profile_lifetime_tests {
    use super::*;
    #[test]
    fn retained_read_backends_keep_their_private_profile_after_server_drop() {
        for owned in [false, true] {
            let profile = IsolatedProfile::create().unwrap();
            let path = profile.path().to_path_buf();
            let isolation = owned.then(|| {
                milagre_owner_store::Isolation::create(
                    &path,
                    &milagre_owner_store::Policy::default(),
                )
                .unwrap()
            });
            let copies = SavedCopies::create(&profile).unwrap();
            let backend: Arc<dyn ReadBackend> = match isolation {
                Some(isolation) => {
                    let projects = copies.projects();
                    drop(copies);
                    Arc::new(owned::OwnedCopies::new(
                        projects,
                        isolation,
                        profile.lease(),
                    ))
                }
                None => Arc::new(copies),
            };
            let project = backend.projects()[0].path.clone();
            backend.state(&project).unwrap();
            let server = Server::bind(
                profile,
                Arc::new(ReadHandler::new(backend.clone(), "lease-fixture".into())),
                Config::default(),
            )
            .unwrap();
            drop(server);
            assert!(
                path.exists(),
                "a retained backend still owns this private profile"
            );
            if !owned {
                backend.state(&project).unwrap();
            }
            drop(backend);
            assert!(
                !path.exists(),
                "the final backend lease releases the profile"
            );
        }
    }
}

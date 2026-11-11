//! Isolated read adapter. No live profile, owner lock, provider, mutation, or arbitrary folder access.
mod copies;
mod inbox;

pub use copies::SavedCopies;
use milagre_owner_store::jsjson;
use milagre_owner_wire::{
    ClientContext, Config, Handler, IsolatedProfile, RpcError, RpcResult, Server,
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

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
}

pub struct ReadHandler {
    backend: Arc<dyn ReadBackend>,
    opened: Mutex<Vec<String>>,
    epoch: String,
}
impl ReadHandler {
    pub fn new(backend: Arc<dyn ReadBackend>, epoch: String) -> Self {
        Self {
            backend,
            opened: Mutex::new(Vec::new()),
            epoch,
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
];
impl Handler for ReadHandler {
    fn methods(&self) -> Vec<String> {
        READ_METHODS
            .iter()
            .chain(UNSUPPORTED_MUTATIONS)
            .map(|name| (*name).into())
            .collect()
    }
    fn encode_result(&self, result: &Value) -> Result<String, RpcError> {
        Ok(jsjson::to_string(result))
    }
    fn invoke(&self, method: &str, args: &[Value], context: &ClientContext) -> RpcResult {
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
            return inbox::snapshot(&self.scopes()?);
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
                // Versions remain 1 because SavedCopies rejects any external file change. A mutable adapter
                // must supply real versions/epochs before advertising state patch support.
                Ok(json!({"state":self.backend.state(scope)?,"version":1,"epoch":self.epoch}))
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
            _ => Err(RpcError::new(
                "COMMAND_FAILED",
                format!("Unknown command: {method}"),
            )),
        }
    }
    fn snapshot(&self, _: &ClientContext) -> RpcResult {
        Ok(json!({"projects":self.scopes()?,"links":[],"runs":{"runs":{},"seq":0},"ports":{}}))
    }
}

/// Always creates its own fresh private /tmp profile and copies only compile-time fixture bytes.
/// There is no existing-path constructor and no environment-selected profile.
pub fn start() -> Result<Server, RpcError> {
    let profile = IsolatedProfile::create()?;
    let backend = Arc::new(SavedCopies::create(&profile)?);
    let epoch = format!("isolated-read:{}", profile.path().display());
    Server::bind(
        profile,
        Arc::new(ReadHandler::new(backend, epoch)),
        Config {
            // Intentionally small to exercise the real client's paging on ordinary saved state.
            max_frame_bytes: 4096,
            ..Config::default()
        },
    )
}

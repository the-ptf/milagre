//! Native retained-content MCP tools. No listener, credentials, live-profile discovery or provider launch.
mod accepted;
pub use accepted::{AcceptedCall, CallPhase, CallReceipt, CallStatus, MutationOutcome};
mod feedback;
pub mod policy;
mod schema;
use milagre_content_store::{
    design::{self, raster::RasterRenderer, DesignKits, ProjectForChat},
    ActiveCheck, ArtifactStore, Error, Result, Runtime,
};
use milagre_owner_store::{jsjson, Isolation};
use policy::{BudgetStatus, HostPolicy, HostRole, HostTool, PolicyOptions};
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    collections::BTreeSet,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard, OnceLock, Weak,
    },
};

const MAX_BODY: usize = 1024 * 1024;
const MAX_DESIGN_BODY: usize = 6_000_000 + 64 * 1024;
const MAX_REPLY: usize = 32 * 1024 * 1024;
/// Immutable resource grant supplied by the owner, never parsed from MCP input.
#[derive(Clone)]
pub enum DesignScope {
    All,
    Ids(BTreeSet<String>),
}
#[derive(Clone)]
pub struct Caller {
    pub chat_id: String,
    pub project_id: String,
    pub roots: Vec<PathBuf>,
    pub read: bool,
    pub write: bool,
    pub html: bool,
    pub designs: bool,
    pub kits: bool,
    pub design_scope: DesignScope,
    pub bundled_skills: PathBuf,
    pub assert_active: ActiveCheck,
}
fn contract() -> &'static Value {
    static DATA: OnceLock<Value> = OnceLock::new();
    DATA.get_or_init(|| {
        jsjson::parse(include_str!("contract.json")).expect("generated tool contract")
    })
}
fn remove(value: &mut Value, key: &str) {
    if let Some(o) = value.as_object_mut() {
        o.shift_remove(key);
    }
}
fn text(value: Value) -> Value {
    json!({"content":[{"type":"text","text":jsjson::to_string(&value)}],"isError":false})
}
fn tool_error(message: impl Into<String>) -> Value {
    json!({"content":[{"type":"text","text":message.into()}],"isError":true})
}
fn protocol_error(id: Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}
struct Stores {
    artifacts: ArtifactStore,
    kits: DesignKits,
}
enum Work {
    Done(Value),
    Preview(Box<Preview>),
}
struct Preview {
    saved: Value,
    document: Value,
    crop: Option<Value>,
    intent: Option<Value>,
    inspection: Option<Value>,
}
/// One serialized owner shared by renderer requests and immutable MCP sessions.
pub struct ContentOwner {
    isolation: Isolation,
    stores: Mutex<Option<Stores>>,
    project_for_chat: ProjectForChat,
    owner_active: ActiveCheck,
    raster: Option<Arc<RasterRenderer>>,
    active: Arc<AtomicBool>,
    fault: Mutex<Option<String>>,
    wakes: Mutex<BTreeSet<String>>,
    calls: Arc<tokio::sync::Semaphore>,
}
/// Renderer authority minted only by its owning ContentOwner. MCP Caller values
/// and session handles cannot be converted into this capability.
#[derive(Clone)]
pub struct RendererScope {
    owner: Weak<ContentOwner>,
    caller: Caller,
}
#[derive(Clone)]
pub struct Dispatcher {
    caller: Caller,
    owner: Arc<ContentOwner>,
    policy: Arc<HostPolicy>,
}
impl ContentOwner {
    #[allow(clippy::too_many_arguments)]
    pub fn open(
        isolation: Isolation,
        artifacts: PathBuf,
        kits: PathBuf,
        project_for_chat: ProjectForChat,
        owner_active: ActiveCheck,
        runtime: Arc<dyn Runtime>,
        raster: Option<Arc<RasterRenderer>>,
    ) -> Result<Arc<Self>> {
        owner_active()?;
        let resolver = project_for_chat.clone();
        let store = ArtifactStore::open(
            isolation.clone(),
            &artifacts,
            Arc::new(move |chat| resolver(chat).map(|_| ())),
            owner_active.clone(),
            runtime,
        )?;
        let kits = DesignKits::open(
            isolation.clone(),
            &kits,
            project_for_chat.clone(),
            owner_active.clone(),
        )?;
        Ok(Arc::new(Self {
            isolation,
            stores: Mutex::new(Some(Stores {
                artifacts: store,
                kits,
            })),
            project_for_chat,
            owner_active,
            raster,
            active: Arc::new(AtomicBool::new(true)),
            fault: Mutex::new(None),
            wakes: Mutex::new(BTreeSet::new()),
            calls: Arc::new(tokio::sync::Semaphore::new(16)),
        }))
    }
    fn lock_fault(&self) -> MutexGuard<'_, Option<String>> {
        match self.fault.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                self.active.store(false, Ordering::Release);
                let mut guard = poisoned.into_inner();
                guard.get_or_insert_with(|| {
                    "Content owner stopped after a poisoned state lock.".into()
                });
                guard
            }
        }
    }
    fn latch_fault(&self, message: String) {
        self.active.store(false, Ordering::Release);
        self.lock_fault().get_or_insert(message);
    }
    fn lock_state<'a, T>(&self, mutex: &'a Mutex<T>) -> MutexGuard<'a, T> {
        match mutex.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                self.latch_fault("Content owner stopped after a poisoned state lock.".into());
                poisoned.into_inner()
            }
        }
    }
    fn isolated<T>(&self, operation: impl FnOnce() -> Result<T>) -> Result<T> {
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(operation)) {
            Ok(result) => result,
            Err(_) => {
                // Panic payloads can contain document content or callback secrets.
                // Never put them in the public tool/renderer error or fault latch.
                let message="Content owner stopped after an internal panic. Close it before reopening its stores.";
                self.latch_fault(message.into());
                Err(Error::coded("CONTENT_OWNER_PANIC", message))
            }
        }
    }
    fn notice_poison(&self) {
        if self.stores.is_poisoned() || self.wakes.is_poisoned() || self.fault.is_poisoned() {
            self.latch_fault("Content owner stopped after a poisoned state lock.".into());
        }
    }
    fn check(&self) -> Result<()> {
        self.notice_poison();
        if let Some(fault) = self.lock_fault().clone() {
            return Err(Error::new(fault));
        }
        if !self.active.load(Ordering::Acquire) {
            return Err(Error::coded(
                "CONTENT_OWNER_INACTIVE",
                "The content owner is closed.",
            ));
        }
        self.isolated(|| (self.owner_active)())
    }
    fn caller_check(&self, caller: &Caller) -> Result<()> {
        self.isolated(|| {
            self.check()?;
            (caller.assert_active)().map_err(caller_error)?;
            if (self.project_for_chat)(&caller.chat_id)? != caller.project_id {
                return Err(Error::new("Chat outside the caller's Project scope."));
            }
            Ok(())
        })
    }
    pub fn session(self: &Arc<Self>, caller: Caller) -> Result<Dispatcher> {
        self.session_with_policy(caller, PolicyOptions::default())
    }
    pub fn session_with_policy(
        self: &Arc<Self>,
        caller: Caller,
        options: PolicyOptions,
    ) -> Result<Dispatcher> {
        self.isolated(|| {
            let caller = normalize_caller(&self.isolation, caller)?;
            let _lane = self.lock_state(&self.stores);
            self.caller_check(&caller)?;
            let policy = HostPolicy::new(&caller, options)?;
            if let Some(wake) = policy.wake_id() {
                let mut wakes = self.lock_state(&self.wakes);
                self.check()?;
                if wakes.len() >= 256 || !wakes.insert(wake.into()) {
                    return Err(Error::coded(
                        "UNSUPPORTED_POLICY",
                        "Wake already admitted or owner wake limit reached.",
                    ));
                }
            }
            Ok(Dispatcher {
                caller,
                owner: self.clone(),
                policy: Arc::new(policy),
            })
        })
    }

    fn with_stores<T>(
        &self,
        caller: &Caller,
        operation: impl FnOnce(&mut ArtifactStore, &mut DesignKits) -> Result<T>,
    ) -> Result<T> {
        let mut lane = self.lock_state(&self.stores);
        let result = self.isolated(|| {
            self.caller_check(caller)?;
            let stores = lane
                .as_mut()
                .ok_or_else(|| Error::new("The content owner is closed."))?;
            let is_open = self.active.clone();
            let caller_guard = caller.assert_active.clone();
            let global = self.owner_active.clone();
            let project = self.project_for_chat.clone();
            let chat = caller.chat_id.clone();
            let expected = caller.project_id.clone();
            let guard: ActiveCheck = Arc::new(move || {
                if !is_open.load(Ordering::Acquire) {
                    return Err(Error::coded(
                        "CONTENT_OWNER_INACTIVE",
                        "The content owner is closed.",
                    ));
                }
                global()?;
                caller_guard().map_err(caller_error)?;
                if project(&chat)? != expected {
                    return Err(Error::new("Chat outside the caller's Project scope."));
                }
                Ok(())
            });
            let mut artifacts = stores.artifacts.authorized(guard.clone());
            let mut kits = stores.kits.authorized(guard);
            operation(&mut artifacts, &mut kits).and_then(|value| {
                self.caller_check(caller)?;
                Ok(value)
            })
        });
        if let Err(error) = &result {
            if fatal(error) {
                self.latch_fault(format!("Content storage stopped: {}", error.message));
            }
        }
        result
    }
    pub fn renderer_scope(
        self: &Arc<Self>,
        chat_id: &str,
        expected_project: &str,
        guard: ActiveCheck,
    ) -> Result<RendererScope> {
        let caller = normalize_caller(
            &self.isolation,
            Caller {
                chat_id: chat_id.into(),
                project_id: expected_project.into(),
                roots: vec![],
                read: true,
                write: true,
                html: true,
                designs: true,
                kits: true,
                design_scope: DesignScope::All,
                bundled_skills: self.isolation.root().into(),
                assert_active: guard,
            },
        )?;
        let _lane = self.lock_state(&self.stores);
        self.caller_check(&caller)?;
        Ok(RendererScope {
            owner: Arc::downgrade(self),
            caller,
        })
    }
    /// Existing renderer routes require a capability minted by this exact owner.
    pub fn renderer(&self, scope: &RendererScope, method: &str, request: &Value) -> Result<Value> {
        if !std::ptr::eq(scope.owner.as_ptr(), self) {
            return Err(Error::coded(
                "CALLER_SCOPE_ERROR",
                "Renderer scope belongs to another content owner.",
            ));
        }
        let caller = &scope.caller;
        if request["chatId"].as_str() != Some(&caller.chat_id) {
            return Err(Error::coded(
                "CALLER_SCOPE_ERROR",
                "Chat outside the renderer's scope.",
            ));
        }
        self.with_stores(caller, |store, kits| match method {
            "artifact:list" => store.list(request),
            "artifact:get" => store.get(request),
            "artifact:asset" => store.asset(request),
            "artifact:comments" => store.comments(request),
            "artifact:apply" => {
                let kits = RefCell::new(kits);
                let read = |r: &Value| kits.borrow_mut().read(r);
                let prepared = store.prepare_design_apply(request, &read)?;
                store.commit_design(prepared, &read, &design::render_html)
            }
            _ => Err(Error::coded(
                "COMMAND_FAILED",
                format!("Unknown command: {method}"),
            )),
        })
    }
    pub fn storage_fault(&self) -> Option<String> {
        self.notice_poison();
        self.lock_fault().clone()
    }
    /// Invalidates every retained session and releases content-store locks before
    /// the runtime releases its outer owner lock. Idempotent.
    pub fn shutdown(&self) {
        self.active.store(false, Ordering::Release);
        self.notice_poison();
        let stores = self.lock_state(&self.stores).take();
        // Release the lane before running any field destructors. Even a faulty
        // trusted Runtime destructor must not escape shutdown.
        let _ = self.isolated(|| {
            drop(stores);
            Ok(())
        });
    }
}
fn fatal(error: &Error) -> bool {
    [
        "INVALID_CONTENT_STORAGE",
        "UNSAFE_FILE",
        "IO_ERROR",
        "OWNERSHIP_LOST",
        "OWNERSHIP_UNVERIFIED",
        "CONTENT_OWNER_INACTIVE",
    ]
    .contains(&error.code.as_str())
}
fn caller_error(error: Error) -> Error {
    Error::coded("CALLER_SCOPE_ERROR", error.message)
}
fn normalize_caller(isolation: &Isolation, mut caller: Caller) -> Result<Caller> {
    if caller.chat_id.is_empty()
        || caller.project_id.is_empty()
        || !caller.bundled_skills.is_absolute()
    {
        return Err(Error::new(
            "Content tools need an explicit Chat, Project and bundled skill directory.",
        ));
    }
    for root in &mut caller.roots {
        let canonical = std::fs::canonicalize(&*root).map_err(|e| caller_error(e.into()))?;
        if !canonical.starts_with(isolation.root())
            || canonical == isolation.root()
            || !canonical.is_dir()
        {
            return Err(Error::new(
                "Tool Worktrees must be directories inside the isolated copy.",
            ));
        }
        *root = canonical;
    }
    let previous = caller.assert_active.clone();
    let roots = caller.roots.clone();
    caller.assert_active = Arc::new(move || {
        (||{
            previous()?;
            for root in &roots {
                let canonical=std::fs::canonicalize(root)?;
                if canonical!=*root||!std::fs::metadata(&canonical)?.is_dir(){return Err(Error::new("An admitted Tool Worktree changed its location or is no longer a directory."));}
            }
            Ok(())
        })().map_err(caller_error)
    });
    Ok(caller)
}
fn available(caller: &Caller, tool: &Value) -> bool {
    let name = tool["name"].as_str().unwrap();
    let Some(read_only) = policy::read_only(name) else {
        return false;
    };
    if read_only {
        if !caller.read {
            return false;
        }
    } else if !caller.write {
        return false;
    }
    if name.starts_with("design_kit_") {
        return caller.kits;
    }
    if name.starts_with("design_") {
        return caller.designs;
    }
    if ["artifact_comments", "artifact_resolve_comment"].contains(&name) {
        return caller.html || caller.designs;
    }
    caller.html
}
impl Dispatcher {
    /// Convenience single-Chat fixture constructor. Runtime integration shares a ContentOwner.
    pub fn open(
        isolation: Isolation,
        artifacts: PathBuf,
        kits: PathBuf,
        caller: Caller,
        runtime: Arc<dyn Runtime>,
        raster: Option<Arc<RasterRenderer>>,
    ) -> Result<Self> {
        let chat = caller.chat_id.clone();
        let project = caller.project_id.clone();
        let resolve = Arc::new(move |id: &str| {
            if id == chat {
                Ok(project.clone())
            } else {
                Err(Error::new("Chat outside the caller's scope."))
            }
        });
        let owner = ContentOwner::open(
            isolation,
            artifacts,
            kits,
            resolve,
            caller.assert_active.clone(),
            runtime,
            raster,
        )?;
        owner.session(caller)
    }
    fn active(&self) -> Result<()> {
        self.owner.caller_check(&self.caller)
    }
    pub fn storage_fault(&self) -> Option<String> {
        self.owner.storage_fault()
    }
    pub fn list(&self) -> Result<Value> {
        self.active()?;
        Ok(
            json!({"tools":contract()["tools"].as_array().unwrap().iter().filter(|tool|self.policy.manifest().iter().any(|entry|entry.name==tool["name"].as_str().unwrap())).map(|tool|{let mut tool=tool.clone();tool["annotations"]["readOnlyHint"]=json!(self.policy.manifest().iter().find(|entry|entry.name==tool["name"].as_str().unwrap()).unwrap().read_only);tool["description"]=json!(tool["description"].as_str().unwrap().replace("$BUNDLED_SKILLS",&self.caller.bundled_skills.to_string_lossy()));tool}).collect::<Vec<_>>()}),
        )
    }
    /// One complete in-process JSON-RPC frame. Notifications produce no reply.
    /// Transport adapters enforce framing/authentication before passing a frame.
    pub async fn dispatch(&self, bytes: &[u8]) -> Option<Vec<u8>> {
        if bytes.len() > MAX_DESIGN_BODY {
            return Some(
                jsjson::to_string(&protocol_error(
                    Value::Null,
                    -32000,
                    &format!("Request exceeds the {MAX_DESIGN_BODY}-byte MCP limit."),
                ))
                .into_bytes(),
            );
        }
        let permit = match self.owner.calls.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                return Some(
                    jsjson::to_string(&protocol_error(
                        Value::Null,
                        -32000,
                        "Content frame capacity reached; request was not accepted.",
                    ))
                    .into_bytes(),
                )
            }
        };
        let this = self.clone();
        let bytes = bytes.to_vec();
        let runtime = tokio::runtime::Handle::current();
        let receipt = CallReceipt::new();
        let observed = receipt.clone();
        let _cancel = accepted::CancelOnDrop(receipt);
        // Parsing, callbacks, serialization and sync layout stay off executor threads.
        // An accepted frame can finish after its waiter disappears. Adapters must
        // treat a lost RPC reply as uncertain and never automatically replay it.
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                runtime.block_on(this.dispatch_inline(&bytes, &observed))
            }));
            observed.finish();
            match result {
                Ok(reply) => reply,
                Err(_) => {
                    this.owner.latch_fault(
                        "Content owner stopped after an internal frame worker panic.".into(),
                    );
                    Some(
                        jsjson::to_string(&protocol_error(
                            Value::Null,
                            -32000,
                            "Content frame worker stopped; do not replay mutations.",
                        ))
                        .into_bytes(),
                    )
                }
            }
        })
        .await
        .unwrap_or_else(|_| {
            Some(
                jsjson::to_string(&protocol_error(
                    Value::Null,
                    -32000,
                    "Content frame worker stopped; do not replay mutations.",
                ))
                .into_bytes(),
            )
        })
    }
    async fn dispatch_inline(&self, bytes: &[u8], receipt: &CallReceipt) -> Option<Vec<u8>> {
        let value = if bytes.len() > MAX_DESIGN_BODY {
            protocol_error(
                Value::Null,
                -32000,
                &format!("Request exceeds the {MAX_DESIGN_BODY}-byte MCP limit."),
            )
        } else {
            match jsjson::parse_bytes(bytes) {
                Err(_) => protocol_error(Value::Null, -32700, "Parse error"),
                Ok(message) => {
                    let large = message["method"] == "tools/call"
                        && matches!(
                            message["params"]["name"].as_str(),
                            Some("design_show" | "design_apply")
                        );
                    if bytes.len() > MAX_BODY && !large {
                        protocol_error(
                            Value::Null,
                            -32000,
                            &format!("Request exceeds the {MAX_BODY}-byte MCP limit."),
                        )
                    } else if !message.is_object()
                        || message["jsonrpc"] != "2.0"
                        || !message["method"].is_string()
                        || message
                            .get("id")
                            .is_some_and(|id| !id.is_string() && !id.is_number())
                    {
                        protocol_error(Value::Null, -32600, "Invalid Request")
                    } else if message.get("id").is_none() {
                        return None;
                    } else {
                        let id = message["id"].clone();
                        match self.active() {
                            Err(e) => protocol_error(id, -32000, &e.message),
                            Ok(()) => {
                                let result = match message["method"].as_str().unwrap() {
                                    "initialize" => {
                                        let requested = message["params"]["protocolVersion"]
                                            .as_str()
                                            .unwrap_or("");
                                        json!({"protocolVersion":if ["2025-03-26","2025-06-18"].contains(&requested){requested}else{"2025-06-18"},"capabilities":{"tools":{}},"serverInfo":{"name":"milagre","version":"1"}})
                                    }
                                    "ping" => json!({}),
                                    "tools/list" => match self.list() {
                                        Ok(v) => v,
                                        Err(e) => {
                                            return Some(
                                                jsjson::to_string(&protocol_error(
                                                    id, -32000, &e.message,
                                                ))
                                                .into_bytes(),
                                            )
                                        }
                                    },
                                    "tools/call" => {
                                        let name = message["params"]["name"].as_str().unwrap_or("");
                                        let empty = json!({});
                                        let args =
                                            message["params"].get("arguments").unwrap_or(&empty);
                                        match self.policy.authorize(name, args) {
                                            Ok(()) => self.call_inline(name, args, receipt).await,
                                            Err(error) => tool_error(error.message),
                                        }
                                    }
                                    _ => {
                                        return Some(
                                            jsjson::to_string(&protocol_error(
                                                id,
                                                -32601,
                                                "Method not found",
                                            ))
                                            .into_bytes(),
                                        )
                                    }
                                };
                                json!({"jsonrpc":"2.0","id":id,"result":result})
                            }
                        }
                    }
                }
            }
        };
        let encoded = jsjson::to_string(&value);
        if encoded.len() > MAX_REPLY {
            Some(
                jsjson::to_string(&protocol_error(
                    value["id"].clone(),
                    -32000,
                    "MCP reply exceeds the 33554432-byte limit.",
                ))
                .into_bytes(),
            )
        } else {
            Some(encoded.into_bytes())
        }
    }
    pub fn provider_manifest(&self) -> Vec<HostTool> {
        self.policy.manifest().to_vec()
    }
    pub fn role(&self) -> &HostRole {
        self.policy.role()
    }
    pub fn budget_status(&self) -> BudgetStatus {
        self.policy.status()
    }
    pub fn start_call(&self, name: &str, args: &Value) -> Result<AcceptedCall> {
        // This bound covers queued work and feedback, shared across all sessions.
        let permit = self.owner.calls.clone().try_acquire_owned().map_err(|_| {
            Error::coded(
                "CONTENT_BUSY",
                "Content call capacity reached; request was not accepted.",
            )
        })?;
        self.policy.authorize(name, args)?;
        let runtime = tokio::runtime::Handle::try_current()
            .map_err(|_| Error::new("Content calls require a Tokio runtime."))?;
        let this = self.clone();
        let name = name.to_owned();
        let args = args.clone();
        let receipt = CallReceipt::new();
        let observed = receipt.clone();
        let (send, reply) = tokio::sync::oneshot::channel();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                runtime.block_on(this.call_inline(&name, &args, &observed))
            }));
            let value = match result {
                Ok(value) => value,
                Err(_) => {
                    this.owner.latch_fault(
                        "Content owner stopped after an internal tool worker panic.".into(),
                    );
                    tool_error(
                        "Content worker panicked; inspect saved state and do not replay mutations.",
                    )
                }
            };
            observed.finish();
            let _ = send.send(value);
        });
        Ok(AcceptedCall { receipt, reply })
    }
    pub async fn call(&self, name: &str, args: &Value) -> Value {
        match self.start_call(name, args) {
            Ok(call) => call.wait().await,
            Err(e) => tool_error(e.message),
        }
    }
    async fn call_inline(&self, name: &str, args: &Value, receipt: &CallReceipt) -> Value {
        if let Err(e) = self.active() {
            return tool_error(e.message);
        }
        let limit = if ["design_show", "design_apply"].contains(&name) {
            MAX_DESIGN_BODY
        } else {
            MAX_BODY
        };
        if jsjson::to_string(args).len() > limit {
            return tool_error(format!("Request exceeds the {limit}-byte MCP limit."));
        }
        let empty = json!({});
        let args = match schema::parse(
            &contract()["parsing"][name],
            if args.is_null() { &empty } else { args },
        ) {
            Ok(v) => v,
            Err(e) => return tool_error(e),
        };
        let mutating = policy::read_only(name) == Some(false);
        let work = self.owner.with_stores(&self.caller, |artifacts, kits| {
            receipt.begin(mutating)?;
            let result = Execution {
                caller: &self.caller,
                artifacts,
                kits: RefCell::new(kits),
            }
            .run(name, &args);
            if mutating && result.is_ok() {
                receipt.committed();
            }
            result
        });
        let result = match work {
            Ok(Work::Done(value)) => Ok(value),
            Ok(Work::Preview(preview)) => {
                let Preview {
                    saved,
                    document,
                    crop,
                    intent,
                    inspection,
                } = *preview;
                let value = feedback::feedback(
                    saved,
                    &document,
                    self.owner.raster.as_deref(),
                    crop.as_ref(),
                    intent.as_ref(),
                )
                .await;
                value.map(|mut value| {
                    if let Some(inspection) = inspection {
                        let line = value["content"][0]["text"].as_str().unwrap();
                        value["content"][0]["text"] = json!(format!(
                            "{line}\n{}",
                            jsjson::to_string(&json!({"inspection":inspection}))
                        ));
                    }
                    value
                })
            }
            Err(e) => Err(e),
        };
        // A committed write remains saved when the grant is revoked during preview.
        // Do not return its saved content/image to a revoked caller.
        if let Err(e) = self.active() {
            return tool_error(e.message);
        }
        match result {
            Ok(value) => value,
            Err(e) => tool_error(if name.starts_with("design_") {
                concise(&e)
            } else {
                e.message
            }),
        }
    }
}
struct Execution<'a> {
    caller: &'a Caller,
    artifacts: &'a mut ArtifactStore,
    kits: RefCell<&'a mut DesignKits>,
}
impl Execution<'_> {
    fn permit(&self, id: Option<&str>) -> Result<()> {
        match &self.caller.design_scope {
            DesignScope::All => Ok(()),
            DesignScope::Ids(ids) if id.is_some_and(|id| ids.contains(id)) => Ok(()),
            _ => Err(Error::new("This design is outside the connection's scope.")),
        }
    }
    fn request(&self, args: &Value, format: Option<&str>) -> Value {
        let mut r = json!({"chatId":self.caller.chat_id});
        for (key, value) in args.as_object().unwrap() {
            r[key] = value.clone();
        }
        if let Some(format) = format {
            r["format"] = json!(format);
        }
        r
    }
    fn filtered_comments(&mut self) -> Result<Value> {
        let mut query = json!({"chatId":self.caller.chat_id});
        if !self.caller.html {
            query["format"] = json!("design");
        } else if !self.caller.designs {
            query["format"] = json!("html");
        }
        let designs = self
            .artifacts
            .list(&json!({"chatId":self.caller.chat_id,"format":"design"}))?;
        let design_ids = designs
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|d| d["id"].as_str())
            .collect::<BTreeSet<_>>();
        let mut comments = self.artifacts.comments(&query)?;
        comments.as_array_mut().unwrap().retain(|c| {
            let id = c["design"]["id"].as_str();
            if id.is_some_and(|id| design_ids.contains(id)) {
                self.caller.designs && self.permit(id).is_ok()
            } else {
                self.caller.html
            }
        });
        Ok(comments)
    }
    fn run(&mut self, name: &str, args: &Value) -> Result<Work> {
        if name.starts_with("design_")
            && !name.starts_with("design_kit_")
            && name != "design_list"
            && !(name == "design_validate"
                && args.get("document").is_some()
                && args.get("id").is_none())
        {
            self.permit(args["id"].as_str())?;
            if args.get("from").is_some() {
                self.permit(args["from"]["id"].as_str())?;
            }
        }
        let request = self.request(args, None);
        let result = match name {
            "artifact_show" => Ok(text(self.artifacts.show(&request, &self.caller.roots)?)),
            "artifact_read" => Ok(text(self.artifacts.artifact_read(&request)?)),
            "artifact_list" | "design_list" => {
                let mut list = self.artifacts.list(&self.request(
                    args,
                    Some(if name == "design_list" {
                        "design"
                    } else {
                        "html"
                    }),
                ))?;
                if name == "design_list" {
                    list.as_array_mut()
                        .unwrap()
                        .retain(|d| self.permit(d["id"].as_str()).is_ok());
                }
                Ok(text(list))
            }
            "artifact_comments" => {
                let mut comments = self.filtered_comments()?;
                if args["all"] != true {
                    comments
                        .as_array_mut()
                        .unwrap()
                        .retain(|c| !jsjson::truthy(c.get("resolved")));
                }
                Ok(text(comments))
            }
            "artifact_resolve_comment" => {
                if !(self.caller.html
                    && self.caller.designs
                    && matches!(self.caller.design_scope, DesignScope::All))
                    && !self
                        .filtered_comments()?
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|c| c["id"] == args["id"])
                {
                    return Err(Error::new(
                        "This comment is outside the connection's scope or is unavailable.",
                    ));
                }
                (self.caller.assert_active)()?;
                Ok(text(self.artifacts.resolve_comment(&request)?))
            }
            "design_kit_read" => Ok(text(self.kits.borrow_mut().read(&request)?)),
            "design_kit_save" => Ok(text(self.kits.borrow_mut().save(&request)?)),
            "design_read" => {
                let mut saved = self.artifacts.get(&self.request(args, Some("design")))?;
                remove(&mut saved, "html");
                Ok(text(saved))
            }
            "design_export" => Ok(text(self.artifacts.export_design(&request)?)),
            "design_validate" => self.validate(args).map(text),
            "design_show" | "design_apply" => {
                if name == "design_show"
                    && args.get("document").is_some() == args.get("from").is_some()
                {
                    return Err(Error::new("Send document OR from (with operations)."));
                }
                let kit = |r: &Value| self.kits.borrow_mut().read(r);
                let prepared = if name == "design_show" {
                    self.artifacts.prepare_design_show(&request, &kit)?
                } else {
                    self.artifacts.prepare_design_apply(&request, &kit)?
                };
                let document = prepared.document().clone();
                let mut saved =
                    self.artifacts
                        .commit_design(prepared, &kit, &design::render_html)?;
                remove(&mut saved, "html");
                remove(&mut saved, "document");
                return Ok(Work::Preview(Box::new(Preview {
                    saved,
                    document,
                    crop: None,
                    intent: args.get("intent").cloned(),
                    inspection: None,
                })));
            }
            "design_inspect" => {
                let mut saved = self.artifacts.get(&self.request(args, Some("design")))?;
                let document = saved["document"].clone();
                remove(&mut saved, "html");
                remove(&mut saved, "document");
                let bounds = design::layout(&document)?;
                let crop = args["nodeId"]
                    .as_str()
                    .map(|id| {
                        bounds.get(id).ok_or_else(|| {
                            Error::new(format!("Layer \"{id}\" is missing or hidden."))
                        })
                    })
                    .transpose()?;
                let crop = crop.map(|b| json!({"x":b.x,"y":b.y,"width":b.width,"height":b.height}));
                let version = saved["version"].clone();
                let diagnostics = match design::diagnostics(&document) {
                    Ok(mut d) => {
                        let mut out = json!({"status":"checked"});
                        for (k, v) in d.as_object_mut().unwrap() {
                            out[k] = v.clone();
                        }
                        out
                    }
                    Err(e) => json!({"status":"failed","error":e.message}),
                };
                let mut inspection = json!({"version":version,"bounds":bounds.into_iter().map(|(k,b)|(k,json!({"x":b.x,"y":b.y,"width":b.width,"height":b.height}))).collect::<serde_json::Map<_,_>>(),"diagnostics":diagnostics,"preview":{"renderer":"resvg","remoteImages":"placeholder","unbundledFonts":feedback::families(&document),"undrawableText":feedback::undrawable(&document)}});
                if let Some(id) = args.get("nodeId") {
                    inspection["nodeId"] = id.clone();
                }
                if let Some(crop) = &crop {
                    inspection["preview"]["crop"] = crop.clone();
                }
                return Ok(Work::Preview(Box::new(Preview {
                    saved,
                    document,
                    crop,
                    intent: None,
                    inspection: Some(inspection),
                })));
            }
            _ => Err(Error::new("Tool unavailable for this connection")),
        };
        result.map(Work::Done)
    }
    fn validate(&mut self, args: &Value) -> Result<Value> {
        let attempt = (|| -> Result<Value> {
            let document = if let Some(document) = args.get("document") {
                if ["id", "operations", "expectedVersion", "intent"]
                    .iter()
                    .any(|key| args.get(key).is_some())
                {
                    return Err(Error::new(
                        "Send document OR id, expectedVersion and operations.",
                    ));
                }
                design::validate_document(document)?
            } else {
                if ["id", "expectedVersion", "operations"]
                    .iter()
                    .any(|key| args.get(key).is_none())
                {
                    return Err(Error::new(
                        "Send document OR id, expectedVersion and operations.",
                    ));
                }
                let current = self
                    .artifacts
                    .get(&self.request(&json!({"id":args["id"]}), Some("design")))?;
                if !jsjson::strict_equals(&current["version"], &args["expectedVersion"]) {
                    return Err(Error::new(format!(
                        "Design version conflict: expected {}, latest {}. Read again.",
                        args["expectedVersion"], current["version"]
                    )));
                }
                design::apply_operations(
                    &current["document"],
                    &args["operations"],
                    args.get("intent"),
                )?
            };
            if let Some(kit) = document.get("kit") {
                let saved = self.kits.borrow_mut().read(
                    &json!({"chatId":self.caller.chat_id,"id":kit["id"],"version":kit["version"]}),
                )?;
                if saved != *kit {
                    return Err(Error::new("The pinned kit differs from this Project's saved version. Read it with design_kit_read and use that snapshot."));
                }
            }
            if let Err(e) = design::validate_consistency(&document) {
                let mut error = validation_error(&e);
                if e.code == "DESIGN_KIT_DRIFT" {
                    error["diagnostics"] = design::diagnostics(&document)?;
                }
                return Ok(error);
            }
            Ok(
                json!({"valid":true,"document":document,"diagnostics":design::diagnostics(&document)?}),
            )
        })();
        match attempt {
            Ok(value) => Ok(value),
            Err(e) if fatal(&e) => Err(e),
            Err(e) => Ok(validation_error(&e)),
        }
    }
}
fn validation_error(e: &Error) -> Value {
    let mut value = json!({"valid":false,"errors":e.issues.as_deref().cloned().unwrap_or_else(||json!([{"path":[],"message":e.message}]))});
    if !["CONTENT_ERROR", "ENOENT"].contains(&e.code.as_str()) {
        value["code"] = json!(e.code);
    }
    if let Some(d) = e.diagnostics.as_deref() {
        value["diagnostics"] = d.clone();
    }
    value
}
fn concise(e: &Error) -> String {
    if let Some(issues) = e.issues.as_deref().and_then(Value::as_array) {
        issues
            .iter()
            .take(10)
            .map(|i| {
                let path = i["path"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .map(|v| jsjson::property_key(Some(v)))
                            .collect::<Vec<_>>()
                            .join(".")
                    })
                    .unwrap_or_default();
                format!(
                    "{}{}",
                    if path.is_empty() {
                        path
                    } else {
                        format!("{path}: ")
                    },
                    i["message"].as_str().unwrap_or("Invalid Design")
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        e.message.clone()
    }
}

#[cfg(test)]
mod panic_tests;

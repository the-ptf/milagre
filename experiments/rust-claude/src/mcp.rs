//! CLI SDK-server bridge. The host owns its dispatcher, policy, stores and scheduling.
//! No listener, store constructor, independent writer or retry/replay exists here.
use crate::handlers::{cancel_pair, BoxFuture, CancelReason, CancelSignal, McpHandler};
use crate::{McpMessage, SessionOptions};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::io::Write;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::sync::{watch, Semaphore};

/// Public callback failures are deliberately static: never pass an underlying error string here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DispatchError {
    Unavailable,
    Failed,
}
impl DispatchError {
    fn message(self) -> &'static str {
        match self {
            Self::Unavailable => "Host MCP service is unavailable.",
            Self::Failed => "Host MCP request failed.",
        }
    }
}
/// Implement on the owner's worker boundary, wrapping the EXISTING scoped ContentOwner Dispatcher.
/// Return a complete JSON-RPC response, or None for a notification. Do not await a reply to a
/// notification. Dropped/cancelled futures must not enqueue new work or replay committed work.
/// Synchronous storage/schema work belongs on the owner's worker, not the provider's I/O executor.
pub trait McpDispatch: Send + Sync + 'static {
    fn dispatch(&self, frame: Vec<u8>, cancel: CancelSignal) -> BoxFuture<Result<Option<Vec<u8>>, DispatchError>>;
}
pub struct FnDispatch<F>(pub F);
impl<F> McpDispatch for FnDispatch<F>
where
    F: Fn(Vec<u8>, CancelSignal) -> BoxFuture<Result<Option<Vec<u8>>, DispatchError>> + Send + Sync + 'static,
{
    fn dispatch(&self, frame: Vec<u8>, cancel: CancelSignal) -> BoxFuture<Result<Option<Vec<u8>>, DispatchError>> {
        (self.0)(frame, cancel)
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpTool {
    pub name: String,
    pub read_only: bool,
}
#[derive(Debug, Clone)]
pub struct McpLimits {
    pub max_calls: usize,
    pub request_bytes: usize,
    pub reply_bytes: usize,
    pub timeout: Duration,
}
impl Default for McpLimits {
    fn default() -> Self {
        Self { max_calls: 8, request_bytes: 6_000_000 + 64 * 1024, reply_bytes: 32 * 1024 * 1024, timeout: Duration::from_secs(60) }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum RegistrationError {
    #[error("Invalid MCP server name, tool manifest or limits.")]
    Invalid,
    #[error("That MCP server name is already registered.")]
    Duplicate,
    #[error("MCP registration has been revoked.")]
    Revoked,
    #[error("MCP registration conflicts with existing session configuration.")]
    ConfigurationConflict,
}
struct Endpoint {
    generation: u64,
    tools: Vec<McpTool>,
    callback: Arc<dyn McpDispatch>,
    limits: McpLimits,
    calls: Semaphore,
    revoked: watch::Sender<bool>,
}
#[derive(Default)]
struct Registry {
    next: u64,
    servers: BTreeMap<String, Arc<Endpoint>>,
}
/// Registry for independently pinned registrations. A session currently attaches one host handler.
#[derive(Default)]
pub struct InProcessMcp {
    registry: Mutex<Registry>,
}
/// Owner-held lifetime token. Drop revokes only THIS generation, even after the name is reused.
/// Revocation cannot undo a committed write or recall bytes already returned to the CLI transport.
pub struct McpRegistration {
    router: Arc<InProcessMcp>,
    name: String,
    endpoint: Arc<Endpoint>,
}
fn valid_name(name: &str, limit: usize) -> bool {
    !name.is_empty() && name.len() <= limit && name.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
}
impl InProcessMcp {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
    /// tools must be copied from the scoped Dispatcher's provider_manifest(), never tool arguments.
    pub fn register(
        self: &Arc<Self>,
        name: &str,
        tools: Vec<McpTool>,
        callback: Arc<dyn McpDispatch>,
        limits: McpLimits,
    ) -> Result<McpRegistration, RegistrationError> {
        let names: BTreeSet<_> = tools.iter().map(|tool| tool.name.as_str()).collect();
        if !valid_name(name, 64)
            || name.contains("__")
            || tools.len() > 256
            || names.len() != tools.len()
            || tools.iter().any(|tool| !valid_name(&tool.name, 128))
            || limits.max_calls == 0
            || limits.max_calls > 256
            || limits.request_bytes == 0
            || limits.reply_bytes < 1024
            || limits.timeout.is_zero()
        {
            return Err(RegistrationError::Invalid);
        }
        let mut registry = self.registry.lock().unwrap();
        if registry.servers.contains_key(name) {
            return Err(RegistrationError::Duplicate);
        }
        registry.next = registry.next.checked_add(1).ok_or(RegistrationError::Invalid)?;
        let endpoint = Arc::new(Endpoint {
            generation: registry.next,
            tools,
            callback,
            calls: Semaphore::new(limits.max_calls),
            limits,
            revoked: watch::channel(false).0,
        });
        registry.servers.insert(name.into(), endpoint.clone());
        Ok(McpRegistration { router: self.clone(), name: name.into(), endpoint })
    }
    fn current(&self, name: &str, endpoint: &Endpoint) -> bool {
        self.registry.lock().unwrap().servers.get(name).is_some_and(|e| e.generation == endpoint.generation) && !*endpoint.revoked.borrow()
    }
}
impl McpRegistration {
    pub fn generation(&self) -> u64 {
        self.endpoint.generation
    }
    /// Pins this generation. An old CLI can never acquire a replacement registration's grant.
    pub fn handler(&self) -> Arc<dyn McpHandler> {
        Arc::new(PinnedMcp { name: self.name.clone(), endpoint: self.endpoint.clone() })
    }
    pub fn provider_manifest(&self) -> Vec<McpTool> {
        self.endpoint.tools.clone()
    }
    pub fn revoke(&self) {
        let mut registry = self.router.registry.lock().unwrap();
        if registry.servers.get(&self.name).is_some_and(|e| e.generation == self.endpoint.generation) {
            registry.servers.remove(&self.name);
        }
        self.endpoint.revoked.send_replace(true);
    }
    /// Adds only this server. Conflicts fail before any options are changed. Other servers,
    /// permissions and settings remain caller-owned. No handshake cache bypasses host revocation.
    pub fn attach(&self, options: &mut SessionOptions) -> Result<(), RegistrationError> {
        if !self.router.current(&self.name, &self.endpoint) {
            return Err(RegistrationError::Revoked);
        }
        let handler = self.handler();
        let prefix = format!("mcp__{}__", self.name);
        let reserved = ["sdkMcpServers", "sdkMcpServerManifests", "sdkMcpServerManifestsOrigin", "sdkMcpServerConfigs"];
        if options.launch.mcp_servers.contains_key(&self.name)
            || options.init.sdk_mcp_servers.contains(&self.name)
            || options.mcp.is_some()
            || options.launch.allowed_tools.iter().any(|t| t.starts_with(&prefix))
            || reserved.iter().any(|key| options.init.extra.contains_key(*key))
        {
            return Err(RegistrationError::ConfigurationConflict);
        }
        options.launch.mcp_servers.insert(self.name.clone(), json!({"type":"sdk","name":self.name}));
        options.init.sdk_mcp_servers.push(self.name.clone());
        options
            .launch
            .allowed_tools
            .extend(self.endpoint.tools.iter().filter(|tool| tool.read_only).map(|tool| format!("{prefix}{}", tool.name)));
        options.mcp = Some(handler);
        Ok(())
    }
}
impl Drop for McpRegistration {
    fn drop(&mut self) {
        self.revoke();
    }
}
fn rpc_error(id: Value, code: i32, message: &'static str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}
/// A bounded writer refuses growth before allocation, including JSON escaping expansion.
fn encode(value: &Value, limit: usize) -> Option<Vec<u8>> {
    struct Bounded {
        bytes: Vec<u8>,
        limit: usize,
    }
    impl Write for Bounded {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > self.limit.saturating_sub(self.bytes.len()) {
                return Err(std::io::Error::other("limit"));
            }
            self.bytes.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut output = Bounded { bytes: Vec::new(), limit };
    serde_json::to_writer(&mut output, value).ok()?;
    Some(output.bytes)
}
struct Caught(BoxFuture<Result<Option<Vec<u8>>, DispatchError>>);
impl Future for Caught {
    type Output = Result<Option<Vec<u8>>, DispatchError>;
    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        catch_unwind(AssertUnwindSafe(|| self.0.as_mut().poll(cx))).unwrap_or(Poll::Ready(Err(DispatchError::Failed)))
    }
}
fn checked_reply(mut reply: Value, request: &Value, endpoint: &Endpoint) -> Option<Value> {
    // An invalid JSON-RPC request may have no recoverable id (the owner returns null).
    let invalid_request = reply["error"]["code"] == -32600 && reply.get("id") == Some(&Value::Null);
    if reply["jsonrpc"] != "2.0"
        || (!invalid_request && reply.get("id") != request.get("id"))
        || (reply.get("result").is_some() == reply.get("error").is_some())
    {
        return None;
    }
    if reply.get("error").is_some() {
        if !reply["error"]["code"].is_i64() || !reply["error"]["message"].is_string() {
            return None;
        }
    } else if request["method"] == "tools/list" {
        if reply["result"].get("nextCursor").is_some() {
            return None;
        }
        let tools = reply["result"]["tools"].as_array_mut()?;
        if tools.len() != endpoint.tools.len() {
            return None;
        }
        let mut seen = BTreeSet::new();
        for tool in tools {
            let name = tool["name"].as_str()?.to_owned();
            let expected = endpoint.tools.iter().find(|t| t.name == name)?;
            if !seen.insert(name) || tool["annotations"]["readOnlyHint"].as_bool() != Some(expected.read_only) {
                return None;
            }
            let object = tool.as_object_mut()?;
            let meta = object.entry("_meta").or_insert_with(|| json!({})).as_object_mut()?;
            meta.insert("anthropic/alwaysLoad".into(), true.into());
        }
    }
    encode(&reply, endpoint.limits.reply_bytes)?;
    Some(reply)
}
struct PinnedMcp {
    name: String,
    endpoint: Arc<Endpoint>,
}
struct CancelOnDrop(crate::handlers::CancelTrigger, bool);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if self.1 {
            self.0.fire(CancelReason::Closed);
        }
    }
}
impl McpHandler for PinnedMcp {
    fn message(&self, message: McpMessage, mut cancel: CancelSignal) -> BoxFuture<Result<Option<Value>, String>> {
        // Capture immutable generation NOW, not after the caller's future starts polling.
        let endpoint = (message.server_name == self.name).then(|| self.endpoint.clone());
        Box::pin(async move {
            let id = message.message.get("id").cloned().unwrap_or(Value::Null);
            let notification =
                message.message["jsonrpc"] == "2.0" && message.message["method"].is_string() && message.message.get("id").is_none();
            let answer = |value| Ok(if notification { None } else { Some(value) });
            let Some(endpoint) = endpoint else {
                return answer(rpc_error(id, -32601, "MCP server is not registered."));
            };
            let mut revoked = endpoint.revoked.subscribe();
            if *revoked.borrow() {
                return answer(rpc_error(id, -32000, "MCP registration was revoked."));
            }
            if cancel.reason().is_some() {
                return answer(rpc_error(id, -32000, "MCP request was cancelled."));
            }
            // Inbound RPC responses require no further RPC reply, and are not host requests.
            if message.message.get("method").is_none()
                && message.message.get("id").is_some()
                && (message.message.get("result").is_some() || message.message.get("error").is_some())
            {
                return Ok(None);
            }
            let Ok(_permit) = endpoint.calls.try_acquire() else {
                return answer(rpc_error(id, -32000, "Too many MCP calls in flight."));
            };
            let Some(frame) = encode(&message.message, endpoint.limits.request_bytes) else {
                return answer(rpc_error(id, -32000, "MCP request exceeds the bridge byte limit."));
            };
            let (trigger, signal) = cancel_pair();
            let mut cancellation = CancelOnDrop(trigger, true);
            let work = catch_unwind(AssertUnwindSafe(|| endpoint.callback.dispatch(frame, signal)));
            let work = match work {
                Ok(work) => Caught(work),
                Err(_) => return answer(rpc_error(id, -32603, DispatchError::Failed.message())),
            };
            let reply = tokio::select! { biased;
                reason = cancel.cancelled() => { cancellation.0.fire(reason); return answer(rpc_error(id, -32000, "MCP request was cancelled.")); }
                _ = revoked.changed() => { cancellation.0.fire(CancelReason::Closed); return answer(rpc_error(id, -32000, "MCP registration was revoked.")); }
                _ = tokio::time::sleep(endpoint.limits.timeout) => { cancellation.0.fire(CancelReason::Closed); return answer(rpc_error(id, -32000, "MCP request timed out; execution may have committed.")); }
                result = work => result,
            };
            if *revoked.borrow() {
                return answer(rpc_error(id, -32000, "MCP registration was revoked."));
            }
            if cancel.reason().is_some() {
                return answer(rpc_error(id, -32000, "MCP request was cancelled."));
            }
            cancellation.1 = false;
            if notification {
                return Ok(None);
            }
            match reply {
                Err(error) => answer(rpc_error(id, -32603, error.message())),
                Ok(Some(bytes)) if bytes.len() <= endpoint.limits.reply_bytes => {
                    match serde_json::from_slice(&bytes).ok().and_then(|reply| checked_reply(reply, &message.message, &endpoint)) {
                        Some(reply) => Ok(Some(reply)),
                        None => answer(rpc_error(id, -32603, "Host MCP returned an invalid response.")),
                    }
                }
                Ok(Some(_)) => answer(rpc_error(id, -32000, "MCP reply exceeds the bridge byte limit.")),
                Ok(None) => answer(rpc_error(id, -32603, "Host MCP returned no response to a request.")),
            }
        })
    }
}

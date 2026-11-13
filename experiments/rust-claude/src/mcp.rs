//! CLI SDK-server bridge. The host owns its dispatcher, policy, stores and scheduling.
//! No listener, store constructor, independent writer or retry/replay exists here.
use crate::handlers::{cancel_pair, BoxFuture, CancelReason, CancelSignal, McpHandler};
use crate::raw_mcp::{McpReply, RawMcpReply};
use crate::{McpMessage, SessionOptions};
use serde_json::value::RawValue;
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
/// Mutation evidence, not permission to retry. A receipt without evidence is always Uncertain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeliveryState {
    NotAttempted,
    Committed,
    Uncertain,
}
impl DeliveryState {
    fn name(self) -> &'static str {
        match self {
            Self::NotAttempted => "not_attempted",
            Self::Committed => "committed",
            Self::Uncertain => "uncertain",
        }
    }
}
/// Implement by mapping the owner's AcceptedCall receipt. Methods must be nonblocking.
/// cancel must atomically cancel queued work before reporting NotAttempted.
pub trait DispatchReceipt: Send + Sync + 'static {
    fn cancel(&self) -> DeliveryState;
    fn status(&self) -> DeliveryState;
}
pub struct DispatchCall {
    pub response: BoxFuture<Result<Option<Vec<u8>>, DispatchError>>,
    pub receipt: Option<Arc<dyn DispatchReceipt>>,
}
/// Implement on the owner's worker boundary, wrapping the EXISTING scoped ContentOwner Dispatcher.
/// Return a complete JSON-RPC response, or None for a notification. Do not await a reply to a
/// notification. Dropped/cancelled futures must not enqueue new work or replay committed work.
/// Synchronous storage/schema work belongs on the owner's worker, not the provider's I/O executor.
pub trait McpDispatch: Send + Sync + 'static {
    fn dispatch(&self, frame: Vec<u8>, cancel: CancelSignal) -> BoxFuture<Result<Option<Vec<u8>>, DispatchError>>;
    fn start(&self, frame: Vec<u8>, cancel: CancelSignal) -> DispatchCall {
        DispatchCall { response: self.dispatch(frame, cancel), receipt: None }
    }
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
    /// Reservations cover callbacks and queued replies until the stdin write completes.
    pub inflight_reply_bytes: usize,
    pub timeout: Duration,
}
impl Default for McpLimits {
    fn default() -> Self {
        Self {
            max_calls: 8,
            request_bytes: 6_000_000 + 64 * 1024,
            reply_bytes: 4 * 1024 * 1024,
            inflight_reply_bytes: 32 * 1024 * 1024,
            timeout: Duration::from_secs(60),
        }
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
    replies: Arc<Semaphore>,
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
            || limits.reply_bytes > (u32::MAX as usize) / 2
            || limits.inflight_reply_bytes < limits.reply_bytes.saturating_mul(2)
            || limits.inflight_reply_bytes > Semaphore::MAX_PERMITS
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
            replies: Arc::new(Semaphore::new(limits.inflight_reply_bytes)),
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
fn rpc_error(id: Value, code: i32, message: &'static str, delivery: DeliveryState) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message,"data":{"delivery":delivery.name(),"retry":"never_automatically"}}})
}
/// A bounded writer refuses growth before allocation, including JSON escaping expansion.
fn encode(value: &(impl serde::Serialize + ?Sized), limit: usize) -> Option<Vec<u8>> {
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
// Only protocol object fields are decoded; nested content/schema values remain borrowed.
// Bound these small indexes independently of the raw byte budget.
fn raw_fields(bytes: &[u8]) -> Option<BTreeMap<String, &RawValue>> {
    struct Fields;
    impl<'de> serde::de::Visitor<'de> for Fields {
        type Value = BTreeMap<String, &'de RawValue>;
        fn expecting(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            out.write_str("bounded MCP object")
        }
        fn visit_map<M: serde::de::MapAccess<'de>>(self, mut map: M) -> Result<Self::Value, M::Error> {
            let mut fields = BTreeMap::new();
            while let Some((key, value)) = map.next_entry::<String, &RawValue>()? {
                if fields.len() >= 64 || key.len() > 256 || fields.insert(key, value).is_some() {
                    return Err(serde::de::Error::custom("MCP object field limit or duplicate"));
                }
            }
            Ok(fields)
        }
    }
    let mut parser = serde_json::Deserializer::from_slice(bytes);
    let fields = serde::Deserializer::deserialize_map(&mut parser, Fields).ok()?;
    parser.end().ok()?;
    Some(fields)
}
fn raw_tools(bytes: &str) -> Option<Vec<&RawValue>> {
    struct Tools;
    impl<'de> serde::de::Visitor<'de> for Tools {
        type Value = Vec<&'de RawValue>;
        fn expecting(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            out.write_str("bounded MCP tools")
        }
        fn visit_seq<S: serde::de::SeqAccess<'de>>(self, mut seq: S) -> Result<Self::Value, S::Error> {
            let mut tools = Vec::new();
            while let Some(tool) = seq.next_element::<&RawValue>()? {
                if tools.len() >= 256 {
                    return Err(serde::de::Error::custom("MCP tool limit"));
                }
                tools.push(tool);
            }
            Ok(tools)
        }
    }
    let mut parser = serde_json::Deserializer::from_str(bytes);
    let tools = serde::Deserializer::deserialize_seq(&mut parser, Tools).ok()?;
    parser.end().ok()?;
    Some(tools)
}
// Borrow opaque JSON subtrees. Content strings never pass through Rust String decoding.
fn checked_reply(bytes: Vec<u8>, request: &Value, endpoint: &Endpoint) -> Option<RawMcpReply> {
    type RawMap<'a> = BTreeMap<String, &'a RawValue>;
    let reply = raw_fields(&bytes)?;
    if serde_json::from_str::<String>(reply.get("jsonrpc")?.get()).ok()? != "2.0" {
        return None;
    }
    let id: Value = serde_json::from_str(reply.get("id")?.get()).ok()?;
    let error = match reply.get("error") {
        Some(raw) => Some(raw_fields(raw.get().as_bytes())?),
        None => None,
    };
    if reply.contains_key("result") == error.is_some() {
        return None;
    }
    let invalid_request = error.as_ref().and_then(|e| e.get("code")).is_some_and(|c| c.get() == "-32600") && id.is_null();
    if !invalid_request && request.get("id") != Some(&id) {
        return None;
    }
    if let Some(error) = error {
        serde_json::from_str::<i64>(error.get("code")?.get()).ok()?;
        if !error.get("message")?.get().starts_with('"') {
            return None;
        }
    } else if request["method"] == "tools/list" {
        let result = raw_fields(reply.get("result")?.get().as_bytes())?;
        if result.contains_key("nextCursor") {
            return None;
        }
        let tools = raw_tools(result.get("tools")?.get())?;
        if tools.len() != endpoint.tools.len() {
            return None;
        }
        let mut seen = BTreeSet::new();
        // Validate only protocol fields, then serialize all replacements in ONE bounded pass.
        // Schemas, descriptions and content remain borrowed RawValue, including surrogate escapes.
        struct Replace<'a, 'b, T> {
            fields: &'b RawMap<'a>,
            key: &'static str,
            value: &'b T,
        }
        impl<T: serde::Serialize> serde::Serialize for Replace<'_, '_, T> {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                use serde::ser::SerializeMap;
                let mut map = serializer.serialize_map(None)?;
                for (key, value) in self.fields {
                    if key != self.key {
                        map.serialize_entry(key, value)?;
                    }
                }
                map.serialize_entry(self.key, self.value)?;
                map.end()
            }
        }
        struct Tool<'a> {
            fields: RawMap<'a>,
            meta: RawMap<'a>,
        }
        impl serde::Serialize for Tool<'_> {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                let meta = Replace { fields: &self.meta, key: "anthropic/alwaysLoad", value: &true };
                Replace { fields: &self.fields, key: "_meta", value: &meta }.serialize(serializer)
            }
        }
        let mut annotated = Vec::with_capacity(tools.len());
        for tool in tools {
            let fields = raw_fields(tool.get().as_bytes())?;
            let name: String = serde_json::from_str(fields.get("name")?.get()).ok()?;
            let expected = endpoint.tools.iter().find(|t| t.name == name)?;
            let annotations = raw_fields(fields.get("annotations")?.get().as_bytes())?;
            if !seen.insert(name) || serde_json::from_str::<bool>(annotations.get("readOnlyHint")?.get()).ok()? != expected.read_only {
                return None;
            }
            let meta: RawMap<'_> = match fields.get("_meta") {
                Some(raw) => raw_fields(raw.get().as_bytes())?,
                None => BTreeMap::new(),
            };
            annotated.push(Tool { fields, meta });
        }
        let result = Replace { fields: &result, key: "tools", value: &annotated };
        let reply = Replace { fields: &reply, key: "result", value: &result };
        return RawMcpReply::from_bytes(encode(&reply, endpoint.limits.reply_bytes)?).ok();
    }
    RawMcpReply::from_bytes(bytes).ok()
}
struct PinnedMcp {
    name: String,
    endpoint: Arc<Endpoint>,
}
struct CancelOnDrop {
    trigger: crate::handlers::CancelTrigger,
    armed: bool,
    receipt: Option<Arc<dyn DispatchReceipt>>,
}
impl CancelOnDrop {
    fn cancel(&self, reason: CancelReason) -> DeliveryState {
        self.trigger.fire(reason);
        self.receipt.as_ref().and_then(|r| catch_unwind(AssertUnwindSafe(|| r.cancel())).ok()).unwrap_or(DeliveryState::Uncertain)
    }
}
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if self.armed {
            self.cancel(CancelReason::Closed);
        }
    }
}
impl McpHandler for PinnedMcp {
    fn message(&self, message: McpMessage, cancel: CancelSignal) -> BoxFuture<Result<Option<Value>, String>> {
        let work = self.wire_message(message, cancel);
        Box::pin(async move {
            match work.await? {
                Some(McpReply::Json(value)) => Ok(Some(value)),
                Some(McpReply::Raw(raw)) => raw.into_value().map(Some).map_err(str::to_owned),
                None => Ok(None),
            }
        })
    }
    fn wire_message(&self, message: McpMessage, mut cancel: CancelSignal) -> BoxFuture<Result<Option<McpReply>, String>> {
        // Capture immutable generation NOW, not after the caller's future starts polling.
        let endpoint = (message.server_name == self.name).then(|| self.endpoint.clone());
        Box::pin(async move {
            let id = message.message.get("id").cloned().unwrap_or(Value::Null);
            let notification =
                message.message["jsonrpc"] == "2.0" && message.message["method"].is_string() && message.message.get("id").is_none();
            let answer = |value| Ok(if notification { None } else { Some(McpReply::Json(value)) });
            let Some(endpoint) = endpoint else {
                return answer(rpc_error(id, -32601, "MCP server is not registered.", DeliveryState::NotAttempted));
            };
            let mut revoked = endpoint.revoked.subscribe();
            if *revoked.borrow() {
                return answer(rpc_error(id, -32000, "MCP registration was revoked.", DeliveryState::NotAttempted));
            }
            if cancel.reason().is_some() {
                return answer(rpc_error(id, -32000, "MCP request was cancelled.", DeliveryState::NotAttempted));
            }
            // Inbound RPC responses require no further RPC reply, and are not host requests.
            if message.message.get("method").is_none()
                && message.message.get("id").is_some()
                && (message.message.get("result").is_some() || message.message.get("error").is_some())
            {
                return Ok(None);
            }
            let Ok(_permit) = endpoint.calls.try_acquire() else {
                return answer(rpc_error(id, -32000, "Too many MCP calls in flight.", DeliveryState::NotAttempted));
            };
            let Some(frame) = encode(&message.message, endpoint.limits.request_bytes) else {
                return answer(rpc_error(id, -32000, "MCP request exceeds the bridge byte limit.", DeliveryState::NotAttempted));
            };
            let Ok(reservation) = endpoint.replies.clone().try_acquire_many_owned((endpoint.limits.reply_bytes * 2) as u32) else {
                return answer(rpc_error(id, -32000, "MCP reply memory capacity reached.", DeliveryState::NotAttempted));
            };
            let (trigger, signal) = cancel_pair();
            let mut cancellation = CancelOnDrop { trigger, armed: true, receipt: None };
            let work = catch_unwind(AssertUnwindSafe(|| endpoint.callback.start(frame, signal)));
            let work = match work {
                Ok(work) => {
                    cancellation.receipt = work.receipt;
                    Caught(work.response)
                }
                Err(_) => return answer(rpc_error(id, -32603, DispatchError::Failed.message(), DeliveryState::Uncertain)),
            };
            let reply = tokio::select! { biased;
                reason = cancel.cancelled() => { let state = cancellation.cancel(reason); return answer(rpc_error(id, -32000, "MCP request was cancelled.", state)); }
                _ = revoked.changed() => { let state = cancellation.cancel(CancelReason::Closed); return answer(rpc_error(id, -32000, "MCP registration was revoked.", state)); }
                _ = tokio::time::sleep(endpoint.limits.timeout) => { let state = cancellation.cancel(CancelReason::Closed); return answer(rpc_error(id, -32000, "MCP request timed out; execution may have committed.", state)); }
                result = work => result,
            };
            if *revoked.borrow() {
                let state = cancellation.cancel(CancelReason::Closed);
                return answer(rpc_error(id, -32000, "MCP registration was revoked.", state));
            }
            if let Some(reason) = cancel.reason() {
                let state = cancellation.cancel(reason);
                return answer(rpc_error(id, -32000, "MCP request was cancelled.", state));
            }
            if notification {
                cancellation.armed = reply.is_err();
                return Ok(None);
            }
            let error = |code, message| rpc_error(id.clone(), code, message, cancellation.cancel(CancelReason::Closed));
            match reply {
                Err(error) => answer(rpc_error(id, -32603, error.message(), cancellation.cancel(CancelReason::Closed))),
                Ok(Some(bytes)) if bytes.len() <= endpoint.limits.reply_bytes => match checked_reply(bytes, &message.message, &endpoint) {
                    Some(mut raw) => {
                        cancellation.armed = false;
                        raw.reservation = Some(reservation);
                        Ok(Some(McpReply::Raw(raw)))
                    }
                    None => answer(error(-32603, "Host MCP returned an invalid response.")),
                },
                Ok(Some(_)) => answer(error(-32000, "MCP reply exceeds the bridge byte limit.")),
                Ok(None) => answer(error(-32603, "Host MCP returned no response to a request.")),
            }
        })
    }
}

#[cfg(test)]
mod wire_tests {
    use super::*;
    fn message(id: i32) -> McpMessage {
        McpMessage {
            request_id: format!("r{id}"),
            server_name: "host".into(),
            message: json!({"jsonrpc":"2.0","id":id,"method":"tools/call"}),
            raw: Value::Null,
        }
    }
    #[tokio::test]
    async fn reply_reservation_outlives_callback_and_framing_until_written_or_dropped() {
        let registry = InProcessMcp::new();
        let callback = Arc::new(FnDispatch(|frame: Vec<u8>, _| {
            Box::pin(async move {
                let request: Value = serde_json::from_slice(&frame).unwrap();
                Ok(Some(serde_json::to_vec(&json!({"jsonrpc":"2.0","id":request["id"],"result":{"text":"x".repeat(700)}})).unwrap()))
            }) as BoxFuture<_>
        }));
        let registration = registry
            .register("host", vec![], callback, McpLimits { reply_bytes: 1024, inflight_reply_bytes: 2048, ..Default::default() })
            .unwrap();
        let handler = registration.handler();
        let (_trigger, signal) = cancel_pair();
        let raw = match handler.wire_message(message(1), signal.clone()).await.unwrap().unwrap() {
            McpReply::Raw(raw) => raw,
            _ => panic!("raw expected"),
        };
        assert_eq!(registration.endpoint.replies.available_permits(), 0);
        let blocked = handler.wire_message(message(2), signal.clone()).await.unwrap().unwrap();
        let McpReply::Json(blocked) = blocked else { panic!("bounded admission expected") };
        assert_eq!(blocked["error"]["data"]["delivery"], "not_attempted");
        assert_eq!(blocked["error"]["message"], "MCP reply memory capacity reached.");
        let frame = raw.frame("outer", 4096).unwrap();
        assert_eq!(registration.endpoint.replies.available_permits(), 0);
        assert!(frame.bytes.len() > 700);
        drop(frame);
        assert_eq!(registration.endpoint.replies.available_permits(), 2048);
        let reply = handler.wire_message(message(3), signal).await.unwrap().unwrap();
        drop(reply);
        assert_eq!(registration.endpoint.replies.available_permits(), 2048);
    }
    #[test]
    fn raw_list_metadata_keeps_opaque_surrogates_while_setting_load_hint() {
        let registry = InProcessMcp::new();
        let callback = Arc::new(FnDispatch(|_, _| Box::pin(async { Ok(None) }) as BoxFuture<_>));
        let registration =
            registry.register("host", vec![McpTool { name: "read".into(), read_only: true }], callback, McpLimits::default()).unwrap();
        let bytes=br#"{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"read","description":"\ud800","inputSchema":{"type":"object","properties":{"\udfff":{"type":"string"}}},"annotations":{"readOnlyHint":true},"_meta":{"anthropic/alwaysLoad":false,"opaque":"\udfff"}}]}}"#.to_vec();
        let raw = checked_reply(bytes, &json!({"id":1,"method":"tools/list"}), &registration.endpoint).unwrap();
        let framed = raw.frame("outer", 4096).unwrap();
        let text = String::from_utf8(framed.bytes).unwrap();
        assert!(text.contains(r#""description":"\ud800""#));
        assert!(text.contains(r#""opaque":"\udfff""#));
        assert!(text.contains(r#""anthropic/alwaysLoad":true"#));
        assert!(!text.contains(r#""anthropic/alwaysLoad":false"#));
    }
}

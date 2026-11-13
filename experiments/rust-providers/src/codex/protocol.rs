//! Wire shapes of `codex app-server`: newline-delimited JSON over stdio, shaped like JSON-RPC 2.0
//! without the `"jsonrpc"` field (same contract as packages/core/src/agents/codex-rpc.cjs):
//!
//! ```text
//! request       { id, method, params }    sent by either side
//! response      { id, result } | { id, error: { code, message, data? } }
//! notification  { method, params }
//! ```
//!
//! The protocol is marked experimental by Codex, so everything past the envelope stays raw
//! [`serde_json::Value`]; typed helpers read fields defensively and never reject unknown ones.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fmt;

/// A JSON-RPC id. Milagre sends integers; Codex sends its own server-request ids as strings
/// (`"srv-1"`) or integers, and echoes ours back unchanged.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RequestId {
    Int(i64),
    Str(String),
}

impl RequestId {
    /// Reads an id from a JSON value. Numbers outside i64 and other scalars keep their JSON text.
    pub fn from_value(value: &Value) -> Option<RequestId> {
        match value {
            Value::Number(n) => Some(n.as_i64().map(RequestId::Int).unwrap_or_else(|| RequestId::Str(n.to_string()))),
            Value::String(s) => Some(RequestId::Str(s.clone())),
            Value::Null => None,
            other => Some(RequestId::Str(other.to_string())),
        }
    }

    pub fn to_value(&self) -> Value {
        match self {
            RequestId::Int(n) => Value::from(*n),
            RequestId::Str(s) => Value::from(s.clone()),
        }
    }
}

impl fmt::Display for RequestId {
    /// Same text as JavaScript's `String(id)`, which Milagre uses as the permission/question request id.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RequestId::Int(n) => write!(f, "{n}"),
            RequestId::Str(s) => f.write_str(s),
        }
    }
}

impl From<i64> for RequestId {
    fn from(n: i64) -> Self {
        RequestId::Int(n)
    }
}

impl From<&str> for RequestId {
    fn from(s: &str) -> Self {
        RequestId::Str(s.to_string())
    }
}

/// The `error` member of a response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WireError {
    pub code: i64,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

/// One frame from Codex, classified with the same precedence as codex-rpc.cjs `handleLine`:
/// `method` + `id` is a server request, `method` alone a notification, anything else a response.
#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    Request {
        id: RequestId,
        method: String,
        params: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
    Response {
        id: RequestId,
        outcome: Result<Value, WireError>,
    },
    /// Valid JSON that is none of the above (no method and no usable id, or not an object).
    Invalid {
        reason: &'static str,
    },
}

/// Classifies a parsed frame. `params` defaults to `{}` and a response's `result` to `{}`, as in Node.
pub fn classify(message: &Value) -> Incoming {
    let Some(object) = message.as_object() else {
        return Incoming::Invalid { reason: "frame is not a JSON object" };
    };
    let params = || object.get("params").filter(|p| !p.is_null()).cloned().unwrap_or_else(empty_object);
    let method = object.get("method").and_then(Value::as_str).filter(|m| !m.is_empty());
    if let Some(method) = method {
        // Node checks `message.id !== undefined`: an explicit null id still makes it a request, but a
        // request we cannot answer is useless, so a null id is treated as a notification here.
        if let Some(id) = object.get("id").and_then(RequestId::from_value) {
            return Incoming::Request { id, method: method.to_string(), params: params() };
        }
        return Incoming::Notification { method: method.to_string(), params: params() };
    }
    let Some(id) = object.get("id").and_then(RequestId::from_value) else {
        return Incoming::Invalid { reason: "frame has neither a method nor an id" };
    };
    // Node rejects when `message.error` is truthy.
    match object.get("error") {
        Some(error) if is_truthy(error) => {
            let code = error.get("code").and_then(Value::as_i64).unwrap_or(0);
            let message = error.get("message").and_then(Value::as_str).unwrap_or("").to_string();
            let data = error.get("data").cloned();
            Incoming::Response { id, outcome: Err(WireError { code, message, data }) }
        }
        _ => Incoming::Response { id, outcome: Ok(object.get("result").filter(|r| !r.is_null()).cloned().unwrap_or_else(empty_object)) },
    }
}

fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

pub fn empty_object() -> Value {
    Value::Object(Map::new())
}

/// Outgoing frames, serialized exactly as codex-rpc.cjs writes them.
pub fn request_frame(id: i64, method: &str, params: &Value) -> Value {
    serde_json::json!({ "id": id, "method": method, "params": params })
}

/// `{ method }` when there are no params (as `rpc.notify("initialized")`), else `{ method, params }`.
pub fn notification_frame(method: &str, params: Option<&Value>) -> Value {
    match params {
        Some(params) => serde_json::json!({ "method": method, "params": params }),
        None => serde_json::json!({ "method": method }),
    }
}

pub fn response_frame(id: &RequestId, result: &Value) -> Value {
    serde_json::json!({ "id": id.to_value(), "result": result })
}

pub fn error_frame(id: &RequestId, code: i64, message: &str) -> Value {
    serde_json::json!({ "id": id.to_value(), "error": { "code": code, "message": message } })
}

/// JSON-RPC "method not found", what Milagre answers to server requests it doesn't support.
pub const METHOD_NOT_FOUND: i64 = -32601;

/// Method names Milagre's Codex adapter uses today (codex-provider.cjs, codex-rpc.cjs, events.cjs).
pub mod methods {
    // Client -> Codex requests.
    pub const INITIALIZE: &str = "initialize";
    pub const ACCOUNT_READ: &str = "account/read";
    pub const CONFIG_READ: &str = "config/read";
    pub const MODEL_LIST: &str = "model/list";
    pub const THREAD_START: &str = "thread/start";
    pub const THREAD_RESUME: &str = "thread/resume";
    pub const THREAD_UNARCHIVE: &str = "thread/unarchive";
    pub const THREAD_READ: &str = "thread/read";
    pub const THREAD_TURNS_LIST: &str = "thread/turns/list";
    pub const TURN_START: &str = "turn/start";
    pub const TURN_STEER: &str = "turn/steer";
    pub const TURN_INTERRUPT: &str = "turn/interrupt";
    // Client -> Codex notifications.
    pub const INITIALIZED: &str = "initialized";
    // Codex -> client notifications Milagre reads.
    pub const TURN_STARTED: &str = "turn/started";
    pub const TURN_COMPLETED: &str = "turn/completed";
    pub const ITEM_STARTED: &str = "item/started";
    pub const ITEM_COMPLETED: &str = "item/completed";
    pub const AGENT_MESSAGE_DELTA: &str = "item/agentMessage/delta";
    pub const COMMAND_OUTPUT_DELTA: &str = "item/commandExecution/outputDelta";
    pub const SERVER_REQUEST_RESOLVED: &str = "serverRequest/resolved";
    pub const THREAD_STATUS_CHANGED: &str = "thread/status/changed";
    pub const ERROR: &str = "error";
    // Codex -> client server requests.
    pub const COMMAND_APPROVAL: &str = "item/commandExecution/requestApproval";
    pub const FILE_CHANGE_APPROVAL: &str = "item/fileChange/requestApproval";
    pub const PERMISSIONS_APPROVAL: &str = "item/permissions/requestApproval";
    pub const REQUEST_USER_INPUT: &str = "item/tool/requestUserInput";
    pub const MCP_ELICITATION: &str = "mcpServer/elicitation/request";
}

/// `clientInfo` of `initialize`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClientInfo {
    pub name: String,
    pub title: String,
    pub version: String,
}

impl ClientInfo {
    pub fn milagre(version: impl Into<String>) -> Self {
        ClientInfo { name: "milagre".into(), title: "Milagre".into(), version: version.into() }
    }
}

/// `initialize` params. `capabilities` is `null` for Chats and `{ experimentalApi: true }` for
/// analysis advisors (codex-provider.cjs `start`).
pub fn initialize_params(client: &ClientInfo, experimental_api: bool) -> Value {
    serde_json::json!({
        "clientInfo": client,
        "capabilities": if experimental_api { serde_json::json!({ "experimentalApi": true }) } else { Value::Null },
    })
}

/// Milagre permission modes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PermissionMode {
    Ask,
    Auto,
    Full,
}

impl PermissionMode {
    pub fn parse(mode: &str) -> Option<Self> {
        match mode {
            "ask" => Some(PermissionMode::Ask),
            "auto" => Some(PermissionMode::Auto),
            "full" => Some(PermissionMode::Full),
            _ => None,
        }
    }
}

/// Codex's approval and sandbox policy for a turn. Port of `codexPolicy` in codex-provider.cjs.
#[derive(Debug, Clone, PartialEq)]
pub struct CodexPolicy {
    pub approval_policy: &'static str,
    /// The thread-level sandbox name (`thread/start`'s `sandbox`).
    pub sandbox: &'static str,
    /// The turn-level policy object (`turn/start`'s `sandboxPolicy`).
    pub sandbox_policy: Value,
}

/// Ask asks before any command Codex doesn't already trust, Auto only when Codex wants to leave the
/// workspace sandbox, Full never asks. `guarded` (a babysit Run) makes Full ask about untrusted
/// commands; `read_only` (a wake's turn) runs the strictest policy whatever the mode.
pub fn codex_policy(mode: PermissionMode, cwd: &str, workspace_roots: &[String], guarded: bool, read_only: bool) -> CodexPolicy {
    if read_only {
        return CodexPolicy {
            approval_policy: "untrusted",
            sandbox: "read-only",
            sandbox_policy: serde_json::json!({ "type": "readOnly", "networkAccess": false }),
        };
    }
    if mode == PermissionMode::Full {
        return CodexPolicy {
            approval_policy: if guarded { "untrusted" } else { "never" },
            sandbox: "danger-full-access",
            sandbox_policy: serde_json::json!({ "type": "dangerFullAccess" }),
        };
    }
    // `[...new Set([cwd, ...workspaceRoots])]`: first occurrence wins, order kept.
    let mut roots: Vec<&str> = Vec::new();
    for root in std::iter::once(cwd).chain(workspace_roots.iter().map(String::as_str)) {
        if !roots.contains(&root) {
            roots.push(root);
        }
    }
    CodexPolicy {
        approval_policy: if mode == PermissionMode::Auto { "on-request" } else { "untrusted" },
        sandbox: "workspace-write",
        sandbox_policy: serde_json::json!({
            "type": "workspaceWrite",
            "writableRoots": roots,
            "networkAccess": false,
            "excludeTmpdirEnvVar": false,
            "excludeSlashTmp": false,
        }),
    }
}

/// Per-thread config Milagre always sends (codex-provider.cjs `THREAD_CONFIG`).
pub fn thread_config() -> Value {
    serde_json::json!({ "features": { "default_mode_request_user_input": true, "send_message_to_user_async": false } })
}

/// One `turn/start` input block. Port of `turnInput`.
pub fn text_input(text: &str) -> Value {
    serde_json::json!({ "type": "text", "text": text, "text_elements": [] })
}

pub fn local_image_input(path: &str) -> Value {
    serde_json::json!({ "type": "localImage", "path": path })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn classifies_like_node() {
        assert_eq!(
            classify(&json!({ "id": "srv-1", "method": "item/tool/requestUserInput" })),
            Incoming::Request { id: "srv-1".into(), method: "item/tool/requestUserInput".into(), params: json!({}) }
        );
        assert_eq!(
            classify(&json!({ "method": "turn/started", "params": { "a": 1 } })),
            Incoming::Notification { method: "turn/started".into(), params: json!({ "a": 1 }) }
        );
        assert_eq!(classify(&json!({ "id": 3, "result": null })), Incoming::Response { id: 3.into(), outcome: Ok(json!({})) });
        assert_eq!(
            classify(&json!({ "id": 3, "error": { "code": -32601, "message": "nope" } })),
            Incoming::Response { id: 3.into(), outcome: Err(WireError { code: -32601, message: "nope".into(), data: None }) }
        );
        // A falsy error is ignored, as `if (message.error)` does.
        assert_eq!(classify(&json!({ "id": 4, "error": null, "result": 1 })), Incoming::Response { id: 4.into(), outcome: Ok(json!(1)) });
        assert!(matches!(classify(&json!([1])), Incoming::Invalid { .. }));
        assert!(matches!(classify(&json!({ "result": 1 })), Incoming::Invalid { .. }));
    }

    #[test]
    fn ids_print_as_javascript_string() {
        assert_eq!(RequestId::from_value(&json!(7)).unwrap().to_string(), "7");
        assert_eq!(RequestId::from_value(&json!("srv-1")).unwrap().to_string(), "srv-1");
        assert_eq!(RequestId::from_value(&json!(null)), None);
    }

    #[test]
    fn frames_match_node_writer() {
        assert_eq!(notification_frame("initialized", None).to_string(), r#"{"method":"initialized"}"#);
        assert_eq!(
            error_frame(&"srv-9".into(), METHOD_NOT_FOUND, "x"),
            json!({ "id": "srv-9", "error": { "code": -32601, "message": "x" } })
        );
    }
}

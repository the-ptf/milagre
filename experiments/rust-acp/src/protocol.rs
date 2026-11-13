//! ACP JSON-RPC envelopes. Numeric IDs round-trip without floating-point conversion or digit loss.
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fmt;

/// A JSON-RPC id. Milagre sends integers; ACP sends its own server-request ids as strings
/// (`"srv-1"`) or integers, and echoes ours back unchanged.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RequestId {
    Int(i64),
    Str(String),
    Number(serde_json::Number),
}

impl RequestId {
    /// Reads an id from a JSON value. Numbers outside i64 retain all digits as numbers, never strings or floats. Serde may normalize exponent spelling.
    pub fn from_value(value: &Value) -> Option<RequestId> {
        match value {
            Value::Number(n) => {
                canonical_number(&n.to_string())?;
                Some(n.as_i64().map(RequestId::Int).unwrap_or_else(|| RequestId::Number(n.clone())))
            }
            Value::String(s) => Some(RequestId::Str(s.clone())),
            Value::Null => None,
            _ => None,
        }
    }

    pub fn to_value(&self) -> Value {
        match self {
            RequestId::Int(n) => Value::from(*n),
            RequestId::Str(s) => Value::from(s.clone()),
            RequestId::Number(n) => Value::Number(n.clone()),
        }
    }
}

// A numeric ID's value, not its spelling, is its identity. Normalize without floats or allocating
// zeros proportional to the exponent. Absurd/unrepresentable exponents fail closed at ingestion.
fn canonical_number(raw: &str) -> Option<String> {
    let (coefficient, exponent) = match raw.find(['e', 'E']) {
        Some(at) => (&raw[..at], raw[at + 1..].parse::<i64>().ok()?),
        None => (raw, 0),
    };
    let negative = coefficient.starts_with('-');
    let coefficient = coefficient.strip_prefix('-').unwrap_or(coefficient);
    let fraction = coefficient.find('.').map(|at| coefficient.len() - at - 1).unwrap_or(0);
    let digits = coefficient.replace('.', "");
    let significant = digits.trim_start_matches('0');
    if significant.is_empty() {
        return Some("0".into());
    }
    let trimmed = significant.trim_end_matches('0');
    let exponent = exponent.checked_sub(fraction as i64)?.checked_add((significant.len() - trimmed.len()) as i64)?;
    Some(format!("{}{trimmed}e{exponent}", if negative { "-" } else { "" }))
}
impl RequestId {
    fn numeric_key(&self) -> Option<String> {
        match self {
            Self::Int(n) => canonical_number(&n.to_string()),
            Self::Number(n) => canonical_number(&n.to_string()).or_else(|| Some(n.to_string())),
            Self::Str(_) => None,
        }
    }
    pub(crate) fn integer(&self) -> Option<i64> {
        let key = self.numeric_key()?;
        if key == "0" {
            return Some(0);
        }
        let (coefficient, exponent) = key.split_once('e')?;
        let exponent = exponent.parse::<u32>().ok()?;
        coefficient.parse::<i64>().ok()?.checked_mul(10i64.checked_pow(exponent)?)
    }
}
impl PartialEq for RequestId {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Str(a), Self::Str(b)) => a == b,
            (Self::Str(_), _) | (_, Self::Str(_)) => false,
            _ => self.numeric_key() == other.numeric_key(),
        }
    }
}
impl Eq for RequestId {}
impl std::hash::Hash for RequestId {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        match self {
            Self::Str(s) => {
                0u8.hash(state);
                s.hash(state);
            }
            _ => {
                1u8.hash(state);
                self.numeric_key().hash(state);
            }
        }
    }
}

impl fmt::Display for RequestId {
    /// Same text as JavaScript's `String(id)`, which Milagre uses as the permission/question request id.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RequestId::Int(n) => write!(f, "{n}"),
            RequestId::Str(s) => f.write_str(s),
            RequestId::Number(n) => write!(f, "{n}"),
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

/// One frame from ACP, classified with the same precedence as acp-rpc.cjs `handleLine`:
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
    let method = object.get("method").and_then(Value::as_str);
    if let Some(method) = method {
        // ACP treats an explicit null id as a notification. Invalid non-null IDs are refused.
        if object.get("id").is_some_and(|id| !id.is_null() && RequestId::from_value(id).is_none()) {
            return Incoming::Invalid { reason: "invalid request id" };
        }
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

pub const METHOD_NOT_FOUND: i64 = -32601;
pub fn request_frame(id: i64, method: &str, params: &Value) -> Value {
    serde_json::json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})
}
pub fn notification_frame(method: &str, params: Option<&Value>) -> Value {
    match params {
        Some(params) => serde_json::json!({"jsonrpc":"2.0","method":method,"params":params}),
        None => serde_json::json!({"jsonrpc":"2.0","method":method}),
    }
}
pub fn response_frame(id: &RequestId, result: &Value) -> Value {
    serde_json::json!({"jsonrpc":"2.0","id":id.to_value(),"result":result})
}
pub fn error_frame(id: &RequestId, code: i64, message: &str) -> Value {
    serde_json::json!({"jsonrpc":"2.0","id":id.to_value(),"error":{"code":code,"message":message}})
}
pub fn initialize(version: &str) -> Value {
    serde_json::json!({"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false},"clientInfo":{"name":"milagre","title":"Milagre","version":version}})
}
pub fn authenticate(method_id: &str) -> Value {
    serde_json::json!({"methodId":method_id})
}
pub fn session(cwd: &str, mcp_servers: &[Value], id: Option<&str>) -> Value {
    let mut value = serde_json::json!({"cwd":cwd,"mcpServers":mcp_servers});
    if let Some(id) = id {
        value["sessionId"] = id.into();
    }
    value
}
pub fn prompt(session_id: &str, blocks: &[Value]) -> Value {
    serde_json::json!({"sessionId":session_id,"prompt":blocks})
}
pub fn cancel(session_id: &str) -> Value {
    serde_json::json!({"sessionId":session_id})
}

#[derive(Debug, Clone, Copy)]
pub enum Decision {
    Allow,
    AllowForChat,
    Deny,
    Cancelled,
}
/// Pure Node pickOption/outcome mapping. This is not an authorization decision.
pub fn permission_outcome(options: &[Value], decision: Decision, once: bool) -> Value {
    let kinds: &[&str] = match (decision, once) {
        (Decision::Allow | Decision::AllowForChat, true) => &["allow_once"],
        (Decision::Allow, false) => &["allow_once", "allow_always"],
        (Decision::AllowForChat, false) => &["allow_always", "allow_once"],
        (Decision::Deny, _) => &["reject_once", "reject_always"],
        _ => &[],
    };
    let option = kinds.iter().find_map(|kind| options.iter().find(|o| o["kind"] == *kind));
    match option.and_then(|o| o.get("optionId")).filter(|id| id.is_string()) {
        Some(id) => serde_json::json!({"outcome":{"outcome":"selected","optionId":id}}),
        None => serde_json::json!({"outcome":{"outcome":"cancelled"}}),
    }
}

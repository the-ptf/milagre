//! The stream-json control protocol envelopes, as documented by the public SDK type declarations
//! (`SDKControlRequest`, `SDKControlResponse`, `SDKControlCancelRequest` in
//! `@anthropic-ai/claude-agent-sdk` 0.3.288 `sdk.d.ts`) and implemented by the public Python SDK
//! (`_internal/query.py`). Every typed view keeps the frame it came from in `raw`, untouched.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

pub const CONTROL_REQUEST: &str = "control_request";
pub const CONTROL_RESPONSE: &str = "control_response";
pub const CONTROL_CANCEL_REQUEST: &str = "control_cancel_request";
pub const KEEP_ALIVE: &str = "keep_alive";

/// One parsed stdout object, by how the transport must route it.
#[derive(Debug, Clone, PartialEq)]
pub enum Inbound {
    /// The reply to a control request this side sent.
    Response(ControlResponse),
    /// A request the CLI sends this side (`can_use_tool`, `hook_callback`, `mcp_message`, ...).
    Request(IncomingRequest),
    /// The CLI withdrew one of its own requests: stop waiting and send no reply.
    Cancel { request_id: String, raw: Value },
    /// Liveness only; the SDKs drop it.
    KeepAlive(Value),
    /// Everything else (system, assistant, user, stream_event, result, ...): forwarded raw.
    Message(Value),
    /// A control frame missing its required fields.
    Malformed { reason: String, raw: Value },
}

#[derive(Debug, Clone, PartialEq)]
pub struct ControlResponse {
    pub request_id: String,
    /// `Ok(payload)` for `subtype: "success"` (payload `{}` when absent), `Err(message)` for `"error"`.
    pub outcome: Result<Value, String>,
    /// The whole frame, including envelope-level fields such as `pending_permission_requests`.
    pub raw: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct IncomingRequest {
    pub request_id: String,
    pub subtype: String,
    /// The inner `request` object.
    pub request: Value,
    /// The whole frame.
    pub raw: Value,
}

fn str_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

pub fn classify(value: Value) -> Inbound {
    let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
    match kind {
        CONTROL_RESPONSE => {
            let response = value.get("response").cloned().unwrap_or(Value::Null);
            let Some(request_id) = str_field(&response, "request_id") else {
                return Inbound::Malformed { reason: "control_response without response.request_id".into(), raw: value };
            };
            let outcome = match response.get("subtype").and_then(Value::as_str) {
                Some("success") => Ok(match response.get("response") {
                    Some(payload @ Value::Object(_)) => payload.clone(),
                    _ => Value::Object(Map::new()),
                }),
                Some("error") => Err(str_field(&response, "error").unwrap_or_else(|| "Unknown error".into())),
                _ => return Inbound::Malformed { reason: "control_response with unknown subtype".into(), raw: value },
            };
            Inbound::Response(ControlResponse { request_id, outcome, raw: value })
        }
        CONTROL_REQUEST => {
            let Some(request_id) = str_field(&value, "request_id") else {
                return Inbound::Malformed { reason: "control_request without request_id".into(), raw: value };
            };
            let request = value.get("request").cloned().unwrap_or(Value::Null);
            let Some(subtype) = str_field(&request, "subtype") else {
                return Inbound::Malformed { reason: "control_request without request.subtype".into(), raw: value };
            };
            Inbound::Request(IncomingRequest { request_id, subtype, request, raw: value })
        }
        CONTROL_CANCEL_REQUEST => match str_field(&value, "request_id") {
            Some(request_id) => Inbound::Cancel { request_id, raw: value },
            None => Inbound::Malformed { reason: "control_cancel_request without request_id".into(), raw: value },
        },
        KEEP_ALIVE => Inbound::KeepAlive(value),
        _ => Inbound::Message(value),
    }
}

pub fn control_request(request_id: &str, request: Value) -> Value {
    json!({ "type": CONTROL_REQUEST, "request_id": request_id, "request": request })
}

pub fn success_response(request_id: &str, payload: Value) -> Value {
    json!({ "type": CONTROL_RESPONSE, "response": { "subtype": "success", "request_id": request_id, "response": payload } })
}

pub fn error_response(request_id: &str, error: &str) -> Value {
    json!({ "type": CONTROL_RESPONSE, "response": { "subtype": "error", "request_id": request_id, "error": error } })
}

pub fn cancel_request(request_id: &str) -> Value {
    json!({ "type": CONTROL_CANCEL_REQUEST, "request_id": request_id })
}

/// `can_use_tool` (`SDKControlPermissionRequest`). AskUserQuestion arrives through this request too.
#[derive(Debug, Clone, PartialEq)]
pub struct PermissionRequest {
    /// The control request id. The TS SDK hands it to canUseTool as `options.requestId`, which Milagre
    /// uses as the card's id.
    pub request_id: String,
    pub tool_name: String,
    pub input: Value,
    pub tool_use_id: Option<String>,
    pub agent_id: Option<String>,
    /// `permission_suggestions` (PermissionUpdate[]), raw.
    pub suggestions: Vec<Value>,
    pub blocked_path: Option<String>,
    pub decision_reason: Option<String>,
    pub decision_reason_type: Option<String>,
    pub title: Option<String>,
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub suppress_always_allow_rule: bool,
    pub default_to_no: bool,
    pub requires_user_interaction: bool,
    /// The inner request object, every field kept (mcp_server, matched_ask_rule, classifier_approvable, ...).
    pub raw: Value,
}

impl PermissionRequest {
    pub fn from_request(request_id: &str, request: &Value) -> Result<Self, String> {
        let tool_name = str_field(request, "tool_name").ok_or("can_use_tool without tool_name")?;
        let flag = |key: &str| request.get(key).and_then(Value::as_bool).unwrap_or(false);
        Ok(Self {
            request_id: request_id.to_owned(),
            tool_name,
            input: request.get("input").cloned().unwrap_or_else(|| Value::Object(Map::new())),
            tool_use_id: str_field(request, "tool_use_id"),
            agent_id: str_field(request, "agent_id"),
            suggestions: request.get("permission_suggestions").and_then(Value::as_array).cloned().unwrap_or_default(),
            blocked_path: str_field(request, "blocked_path"),
            decision_reason: str_field(request, "decision_reason"),
            decision_reason_type: str_field(request, "decision_reason_type"),
            title: str_field(request, "title"),
            display_name: str_field(request, "display_name"),
            description: str_field(request, "description"),
            suppress_always_allow_rule: flag("suppress_always_allow_rule"),
            default_to_no: flag("default_to_no"),
            requires_user_interaction: flag("requires_user_interaction"),
            raw: request.clone(),
        })
    }

    pub fn is_question(&self) -> bool {
        self.tool_name == ASK_USER_QUESTION
    }
}

pub const ASK_USER_QUESTION: &str = "AskUserQuestion";

/// The answer to `can_use_tool` (`PermissionResult`), serialized in the wire's camelCase.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "behavior", rename_all = "lowercase")]
pub enum PermissionResult {
    Allow {
        #[serde(rename = "updatedInput", skip_serializing_if = "Option::is_none")]
        updated_input: Option<Value>,
        #[serde(rename = "updatedPermissions", skip_serializing_if = "Option::is_none")]
        updated_permissions: Option<Vec<Value>>,
    },
    Deny {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        interrupt: Option<bool>,
    },
}

impl PermissionResult {
    /// Wire payload. An allow without `updatedInput` sends the original input back, as both SDKs do.
    pub fn to_payload(&self, original_input: &Value) -> Value {
        let mut value = serde_json::to_value(self).expect("PermissionResult serializes");
        if let (PermissionResult::Allow { updated_input: None, .. }, Value::Object(map)) = (self, &mut value) {
            map.insert("updatedInput".into(), original_input.clone());
        }
        value
    }
}

/// `hook_callback` (`SDKHookCallbackRequest`).
#[derive(Debug, Clone, PartialEq)]
pub struct HookCallback {
    pub request_id: String,
    pub callback_id: String,
    /// `HookInput`, raw (hook_event_name, tool_name, tool_input, session_id, ...).
    pub input: Value,
    pub tool_use_id: Option<String>,
    pub raw: Value,
}

impl HookCallback {
    pub fn from_request(request_id: &str, request: &Value) -> Result<Self, String> {
        Ok(Self {
            request_id: request_id.to_owned(),
            callback_id: str_field(request, "callback_id").ok_or("hook_callback without callback_id")?,
            input: request.get("input").cloned().unwrap_or(Value::Null),
            tool_use_id: str_field(request, "tool_use_id"),
            raw: request.clone(),
        })
    }
}

/// `mcp_message` (`SDKControlMcpMessageRequest`) for an SDK-hosted (in-process) MCP server.
#[derive(Debug, Clone, PartialEq)]
pub struct McpMessage {
    pub request_id: String,
    pub server_name: String,
    /// One MCP JSON-RPC message (request, notification or response).
    pub message: Value,
    pub raw: Value,
}

impl McpMessage {
    pub fn from_request(request_id: &str, request: &Value) -> Result<Self, String> {
        let server_name = str_field(request, "server_name").filter(|name| !name.is_empty());
        let message = request.get("message").filter(|message| message.is_object());
        match (server_name, message) {
            (Some(server_name), Some(message)) => {
                Ok(Self { request_id: request_id.to_owned(), server_name, message: message.clone(), raw: request.clone() })
            }
            _ => Err("Missing server_name or message for MCP request".into()),
        }
    }

    /// The JSON-RPC error the Python SDK answers for an unknown server.
    pub fn unknown_server(&self) -> Value {
        json!({ "jsonrpc": "2.0", "id": self.message.get("id").cloned().unwrap_or(Value::Null),
                "error": { "code": -32601, "message": format!("Server '{}' not found", self.server_name) } })
    }

    pub fn internal_error(&self, message: &str) -> Value {
        json!({ "jsonrpc": "2.0", "id": self.message.get("id").cloned().unwrap_or(Value::Null),
                "error": { "code": -32603, "message": message } })
    }
}

/// The ack a JSON-RPC notification gets: the control request still expects a reply.
pub fn mcp_notification_ack() -> Value {
    json!({ "jsonrpc": "2.0", "result": {} })
}

/// A user message for streaming input. Same shape as Milagre's `userMessage` in claude-provider.cjs.
pub fn user_message(uuid: &str, content: Vec<Value>) -> Value {
    json!({ "type": "user", "uuid": uuid, "message": { "role": "user", "content": content }, "parent_tool_use_id": null })
}

pub fn text_block(text: &str) -> Value {
    json!({ "type": "text", "text": text })
}

pub fn image_block(media_type: &str, base64: &str) -> Value {
    json!({ "type": "image", "source": { "type": "base64", "media_type": media_type, "data": base64 } })
}

/// `type`, `subtype` and `session_id` of a raw message, for routing without losing the rest.
pub fn message_kind(value: &Value) -> (Option<&str>, Option<&str>) {
    (value.get("type").and_then(Value::as_str), value.get("subtype").and_then(Value::as_str))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_control_frames() {
        let ok = classify(json!({"type":"control_response","response":{"subtype":"success","request_id":"r1","response":{"a":1}},"x":2}));
        match ok {
            Inbound::Response(r) => {
                assert_eq!(r.outcome, Ok(json!({"a":1})));
                assert_eq!(r.raw["x"], 2);
            }
            other => panic!("{other:?}"),
        }
        let ok_empty = classify(json!({"type":"control_response","response":{"subtype":"success","request_id":"r1"}}));
        assert!(matches!(ok_empty, Inbound::Response(ControlResponse { outcome: Ok(Value::Object(_)), .. })));
        let err = classify(json!({"type":"control_response","response":{"subtype":"error","request_id":"r2","error":"nope"}}));
        assert!(matches!(err, Inbound::Response(ControlResponse { outcome: Err(ref m), .. }) if m == "nope"));
        assert!(matches!(
            classify(json!({"type":"control_request","request_id":"c","request":{"subtype":"can_use_tool"}})),
            Inbound::Request(_)
        ));
        assert!(matches!(classify(json!({"type":"control_request","request":{"subtype":"x"}})), Inbound::Malformed { .. }));
        assert!(matches!(classify(json!({"type":"control_cancel_request","request_id":"c"})), Inbound::Cancel { .. }));
        assert!(matches!(classify(json!({"type":"keep_alive"})), Inbound::KeepAlive(_)));
        assert!(matches!(classify(json!({"type":"assistant","future_field":1})), Inbound::Message(_)));
    }

    #[test]
    fn permission_result_wire_shape() {
        let input = json!({"command":"ls"});
        let allow = PermissionResult::Allow { updated_input: None, updated_permissions: None };
        assert_eq!(allow.to_payload(&input), json!({"behavior":"allow","updatedInput":{"command":"ls"}}));
        let deny = PermissionResult::Deny { message: "no".into(), interrupt: Some(true) };
        assert_eq!(deny.to_payload(&input), json!({"behavior":"deny","message":"no","interrupt":true}));
        let back: PermissionResult = serde_json::from_value(json!({"behavior":"deny","message":"m"})).unwrap();
        assert_eq!(back, PermissionResult::Deny { message: "m".into(), interrupt: None });
    }

    #[test]
    fn permission_request_keeps_unknown_fields() {
        let req = json!({"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"},"tool_use_id":"t1",
                          "permission_suggestions":[{"type":"addRules"}],"classifier_approvable":false,"future":{"a":1}});
        let parsed = PermissionRequest::from_request("req-1", &req).unwrap();
        assert_eq!(parsed.tool_use_id.as_deref(), Some("t1"));
        assert_eq!(parsed.suggestions.len(), 1);
        assert_eq!(parsed.raw["future"]["a"], 1);
        assert!(PermissionRequest::from_request("x", &json!({})).is_err());
    }
}

//! Codex server requests -> Milagre's `permission-request` / `question-request` shapes, and Milagre's
//! answers -> Codex's replies. Ports of the Codex helpers in packages/core/src/agents/permissions.cjs
//! and questions.cjs. The outputs are plain JSON with the same field names and omissions as Node,
//! so they can be emitted as Milagre events unchanged; tests/conformance.rs checks them against
//! fixtures generated from the Node code.
//!
//! Two inputs Node computes from other modules are injected here: whether a shell command writes to
//! GitHub (babysit-guard.cjs, which decides `allowForChat`) and the set of milagre MCP tools that run
//! without a provider card ([`MILAGRE_UNGATED_TOOLS`] is the current list).

use crate::codex::protocol::RequestId;
use serde_json::{json, Map, Value};
use std::path::Path;

/// permissions.cjs `MAX_TEXT`, counted in UTF-16 code units like JavaScript's `length`.
pub const MAX_TEXT: usize = 20_000;

/// The milagre tools a Codex MCP approval is answered "allow" for without a card
/// (permissions.cjs `PLAN_TOOLS`: plan tools, routine_list, self-gated and own-Chat tools).
pub const MILAGRE_UNGATED_TOOLS: &[&str] = &[
    "tasks_set",
    "task_update",
    "tasks_read",
    "phase_set",
    "routine_list",
    "request_secret",
    "report_milagre_bug",
    "project_add",
    "worktree_link",
    "worktree_remove",
    "chat_set_mode",
    "chat_respond",
    "delegate",
    "desktop_act",
    "desktop_press",
    "desktop_launch",
    "design_show",
    "design_apply",
    "artifact_show",
    "html_render",
    "artifact_resolve_comment",
    "browser_open",
    "browser_resolve_comment",
    "conclude_negotiation",
    "flow_step_output",
];

/// A user's (or the policy's) answer to an approval.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Allow,
    AllowForChat,
    Deny,
    /// The turn stopped before anyone answered.
    Cancelled,
}

impl Decision {
    pub fn parse(decision: &str) -> Option<Self> {
        match decision {
            "allow" => Some(Decision::Allow),
            "allow-for-chat" => Some(Decision::AllowForChat),
            "deny" => Some(Decision::Deny),
            "cancelled" => Some(Decision::Cancelled),
            _ => None,
        }
    }
}

/// permissions.cjs `codexDecision`: the `decision` of a command or file-change approval reply.
pub fn codex_decision(decision: Decision) -> &'static str {
    match decision {
        Decision::Allow => "accept",
        Decision::AllowForChat => "acceptForSession",
        Decision::Deny => "decline",
        Decision::Cancelled => "cancel",
    }
}

/// The full reply to `item/commandExecution/requestApproval` or `item/fileChange/requestApproval`.
pub fn approval_response(decision: Decision) -> Value {
    json!({ "decision": codex_decision(decision) })
}

/// permissions.cjs `codexMcpResponse`: the reply to an MCP-tool elicitation. Never sends Codex's
/// "always" persistence choice.
pub fn mcp_response(decision: Decision) -> Value {
    match decision {
        Decision::Allow => json!({ "action": "accept", "content": {} }),
        Decision::Cancelled => json!({ "action": "cancel", "content": null }),
        _ => json!({ "action": "decline", "content": null }),
    }
}

/// The reply Milagre gives `item/permissions/requestApproval`: no extra sandbox permissions, this turn only.
pub fn no_extra_permissions_response() -> Value {
    json!({ "permissions": {}, "scope": "turn" })
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// permissions.cjs `capText`.
pub fn cap_text(text: &str) -> String {
    if utf16_len(text) <= MAX_TEXT {
        return text.to_string();
    }
    let mut units = 0;
    let mut end = 0;
    for (index, ch) in text.char_indices() {
        if units + ch.len_utf16() > MAX_TEXT {
            break;
        }
        units += ch.len_utf16();
        end = index + ch.len_utf8();
    }
    format!("{}\n… truncated", &text[..end])
}

/// Codex runs commands through the user's login shell: `/bin/zsh -lc 'npm test'` shows as `npm test`.
pub fn unwrap_shell(command: &str) -> String {
    for shell in ["/bin/sh", "/bin/bash", "/bin/zsh", "/usr/bin/sh", "/usr/bin/bash", "/usr/bin/zsh"] {
        let Some(rest) = command.strip_prefix(shell).and_then(|r| r.strip_prefix(" -lc ")) else { continue };
        if let Some(inner) = rest.strip_prefix('\'').and_then(|r| r.strip_suffix('\'')) {
            // `(?:[^']|'\\'')*`: every quote inside must be part of the `'\''` escape.
            if quoted_body_valid(inner) {
                return inner.replace("'\\''", "'");
            }
        }
        // The regex's other branch, `([^ ]+)`, also catches a malformed quoted word.
        if !rest.is_empty() && !rest.contains(' ') {
            return rest.to_string();
        }
    }
    command.to_string()
}

fn quoted_body_valid(inner: &str) -> bool {
    let mut rest = inner;
    while let Some(at) = rest.find('\'') {
        match rest[at..].strip_prefix("'\\''") {
            Some(after) => rest = after,
            None => return false,
        }
    }
    true
}

fn text_field(params: &Value, key: &str) -> Option<String> {
    match params.get(key) {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(other) => Some(other.to_string()),
    }
}

/// `params.itemId ?? undefined` as a JSON value kept as-is (Node keeps its type).
fn passthrough(params: &Value, key: &str) -> Option<Value> {
    params.get(key).filter(|v| !v.is_null()).cloned()
}

fn insert_opt(map: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value {
        map.insert(key.into(), value);
    }
}

/// `item/commandExecution/requestApproval` params -> permission request. `writes_remote` is
/// babysit-guard's "writes to GitHub" check: such a command is never offered "allow for this Chat".
pub fn command_request(id: &RequestId, params: &Value, writes_remote: impl Fn(&str) -> bool) -> Value {
    let host = params.pointer("/networkApprovalContext/host").filter(|h| !h.is_null());
    let raw = match params.get("command") {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    };
    let command = unwrap_shell(&raw);
    let mut map = Map::new();
    map.insert("requestId".into(), id.to_string().into());
    map.insert("kind".into(), "command".into());
    map.insert("tool".into(), "Shell".into());
    let title = match host {
        Some(Value::String(h)) => format!("Allow network access to {h}?"),
        Some(other) => format!("Allow network access to {other}?"),
        None => "Run this command?".into(),
    };
    map.insert("title".into(), title.into());
    map.insert("command".into(), command.clone().into());
    insert_opt(&mut map, "cwd", passthrough(params, "cwd"));
    insert_opt(&mut map, "reason", passthrough(params, "reason"));
    map.insert("allowForChat".into(), (!writes_remote(&command)).into());
    insert_opt(&mut map, "stepId", passthrough(params, "itemId"));
    Value::Object(map)
}

/// Codex sends an added file's content (and a deleted file's old content) with no markers; mark each
/// line as added or removed. Real unified diffs pass through.
fn marked_diff(change: &Value) -> String {
    let diff = change.get("diff").and_then(Value::as_str).unwrap_or("");
    let mark = match change.pointer("/kind/type").and_then(Value::as_str) {
        Some("add") => "+",
        Some("delete") => "-",
        _ => return diff.to_string(),
    };
    let is_unified = diff.split('\n').any(|line| line.starts_with("@@ ") || line.starts_with("--- ") || line.starts_with("diff --git "));
    if diff.is_empty() || is_unified {
        return diff.to_string();
    }
    let mut lines: Vec<&str> = diff.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    let body = lines.iter().map(|line| format!("{mark}{line}")).collect::<Vec<_>>().join("\n");
    if diff.ends_with('\n') {
        body + "\n"
    } else {
        body
    }
}

fn change_path(change: &Value) -> String {
    match change.get("path") {
        Some(Value::String(s)) => s.clone(),
        None | Some(Value::Null) => "undefined".into(),
        Some(other) => other.to_string(),
    }
}

/// permissions.cjs `codexChangesDiff`: each change under a `--- path` header.
pub fn changes_diff(changes: &[Value]) -> String {
    cap_text(&changes.iter().map(|c| format!("--- {}\n{}", change_path(c), marked_diff(c))).collect::<Vec<_>>().join("\n"))
}

/// `item/fileChange/requestApproval` params -> permission request. The request carries no diff;
/// `changes` are the ones the matching `fileChange` item reported in `item/started`.
pub fn file_request(id: &RequestId, params: &Value, changes: &[Value]) -> Value {
    let files: Vec<String> = changes.iter().map(change_path).collect();
    let grant_root = params.get("grantRoot").filter(|g| is_truthy(g));
    let title = if let Some(root) = grant_root {
        format!("Allow writing to {}?", root.as_str().map(str::to_string).unwrap_or_else(|| root.to_string()))
    } else if files.len() == 1 {
        let name = Path::new(&files[0]).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| files[0].clone());
        format!("Edit {name}?")
    } else if !files.is_empty() {
        format!("Edit {} files?", files.len())
    } else {
        "Edit files?".into()
    };
    let mut map = Map::new();
    map.insert("requestId".into(), id.to_string().into());
    map.insert("kind".into(), "edit".into());
    map.insert("tool".into(), "Edit files".into());
    map.insert("title".into(), title.into());
    map.insert("files".into(), json!(files));
    if !changes.is_empty() {
        map.insert("diff".into(), changes_diff(changes).into());
    }
    insert_opt(&mut map, "reason", passthrough(params, "reason"));
    map.insert("allowForChat".into(), true.into());
    insert_opt(&mut map, "stepId", passthrough(params, "itemId"));
    Value::Object(map)
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

/// Codex asks about MCP tool calls through elicitation with an empty form and the tool in `_meta`.
pub fn is_mcp_approval(params: &Value) -> bool {
    let schema = params.get("requestedSchema");
    let properties = schema.and_then(|s| s.get("properties"));
    params.get("mode").and_then(Value::as_str) == Some("form")
        && params.pointer("/_meta/codex_approval_kind").and_then(Value::as_str) == Some("mcp_tool_call")
        && schema.and_then(|s| s.get("type")).and_then(Value::as_str) == Some("object")
        && properties.is_some_and(is_truthy)
        && properties.and_then(Value::as_object).is_some_and(|p| p.is_empty())
        && schema.and_then(|s| s.get("required")).and_then(Value::as_array).is_none_or(|r| r.is_empty())
}

/// `mcpServer/elicitation/request` params -> permission request, or `None` for a form that needs
/// input a permission card cannot collect (Milagre answers those "deny").
pub fn mcp_request(id: &RequestId, params: &Value) -> Option<Value> {
    if !is_mcp_approval(params) {
        return None;
    }
    let server = text_field(params, "serverName").unwrap_or_else(|| "undefined".into());
    let message = params.get("message").and_then(Value::as_str).filter(|m| !m.is_empty());
    let meta = params.get("_meta").cloned().unwrap_or(Value::Null);
    let mut map = Map::new();
    map.insert("requestId".into(), id.to_string().into());
    map.insert("kind".into(), "other".into());
    map.insert("tool".into(), format!("MCP: {server}").into());
    map.insert("title".into(), message.map(str::to_string).unwrap_or_else(|| format!("Use {server}?")).into());
    if let Some(description) = meta.get("tool_description").and_then(Value::as_str) {
        map.insert("description".into(), cap_text(description).into());
    }
    if let Some(tool_params) = meta.get("tool_params") {
        map.insert("detail".into(), cap_text(&pretty_json_like_node(tool_params)).into());
    }
    map.insert("allowForChat".into(), false.into());
    Some(Value::Object(map))
}

/// `JSON.stringify(value, null, 2)`.
fn pretty_json_like_node(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_default()
}

/// The tool a milagre MCP approval is about, from Codex's message
/// `Allow the milagre MCP server to run tool "tasks_set"?`.
pub fn milagre_mcp_tool(params: &Value) -> Option<String> {
    let message = params.get("message").and_then(Value::as_str)?;
    let tool = message.strip_prefix("Allow the milagre MCP server to run tool \"")?.strip_suffix("\"?")?;
    (!tool.is_empty() && !tool.contains('"')).then(|| tool.to_string())
}

/// permissions.cjs `isCodexPlanToolApproval`, with the ungated tool list injected.
pub fn is_ungated_milagre_tool_approval(params: &Value, ungated: &[&str]) -> bool {
    params.get("serverName").and_then(Value::as_str) == Some("milagre")
        && is_mcp_approval(params)
        && milagre_mcp_tool(params).is_some_and(|tool| ungated.contains(&tool.as_str()))
}

fn trimmed(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).map(|s| s.trim().to_string()).unwrap_or_default()
}

fn question_option(raw: &Value) -> Option<Value> {
    let label = trimmed(raw.get("label"));
    if label.is_empty() {
        return None;
    }
    let description = trimmed(raw.get("description"));
    Some(if description.is_empty() { json!({ "label": label }) } else { json!({ "label": label, "description": description }) })
}

/// `item/tool/requestUserInput` params -> question request, or `None` when nothing can be shown
/// (Milagre then answers "cancelled": no answers, which Codex reads as "carry on").
pub fn question_request(id: &RequestId, params: &Value) -> Option<Value> {
    let questions: Vec<Value> = params
        .get("questions")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter_map(|raw| {
            let question_id = trimmed(raw.get("id"));
            let question = trimmed(raw.get("question"));
            if question_id.is_empty() || question.is_empty() {
                return None;
            }
            let options: Vec<Value> =
                raw.get("options").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]).iter().filter_map(question_option).collect();
            let allow_other = raw.get("isOther") == Some(&Value::Bool(true)) || options.is_empty();
            Some(json!({
                "id": question_id,
                "header": trimmed(raw.get("header")),
                "question": question,
                "options": options,
                "multiSelect": false,
                "allowOther": allow_other,
                "secret": raw.get("isSecret") == Some(&Value::Bool(true)),
            }))
        })
        .collect();
    (!questions.is_empty()).then(|| json!({ "requestId": id.to_string(), "questions": questions }))
}

/// How a question ended.
#[derive(Debug, Clone, PartialEq)]
pub enum QuestionOutcome {
    /// Answers per question id: the labels picked and any typed answer.
    Answered(Vec<(String, Vec<String>)>),
    Dismissed,
    Cancelled,
}

/// questions.cjs `codexQuestionResponse`. Anything but answers is `{ answers: {} }`.
pub fn question_response(outcome: &QuestionOutcome) -> Value {
    match outcome {
        QuestionOutcome::Answered(answers) => {
            let map: Map<String, Value> = answers.iter().map(|(id, values)| (id.clone(), json!({ "answers": values }))).collect();
            json!({ "answers": map })
        }
        _ => json!({ "answers": {} }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unwraps_login_shell_like_node() {
        assert_eq!(unwrap_shell("/bin/zsh -lc 'npm test'"), "npm test");
        assert_eq!(unwrap_shell("/bin/zsh -lc ls"), "ls");
        assert_eq!(unwrap_shell("/usr/bin/bash -lc 'echo '\\''hi'\\'''"), "echo 'hi'");
        assert_eq!(unwrap_shell("/bin/zsh -lc 'a'b'"), "'a'b'");
        assert_eq!(unwrap_shell("/bin/fish -lc ls"), "/bin/fish -lc ls");
        assert_eq!(unwrap_shell("/bin/zsh -lc ls -la"), "/bin/zsh -lc ls -la");
    }

    #[test]
    fn caps_in_utf16_units() {
        let long = "é".repeat(MAX_TEXT + 1);
        let capped = cap_text(&long);
        assert!(capped.ends_with("\n… truncated"));
        assert_eq!(capped.chars().filter(|c| *c == 'é').count(), MAX_TEXT);
    }

    #[test]
    fn mcp_tool_from_message() {
        let params = json!({ "message": "Allow the milagre MCP server to run tool \"tasks_set\"?" });
        assert_eq!(milagre_mcp_tool(&params).as_deref(), Some("tasks_set"));
    }
}

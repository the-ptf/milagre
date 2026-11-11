//! Milagre's current Claude message shapes, ported from `packages/core/src/agents/permissions.cjs`
//! (`claudeRequest`, `claudeResult`), `questions.cjs` (`claudeQuestionRequest`, `claudeQuestionResult`,
//! `PendingQuestions.answer`) and `claude-provider.cjs` (`CLAUDE_MODES`, `nativeMode`, `userMessage`).
//! `tests/conformance.rs` checks them against fixtures generated from the Node code.
//!
//! The Node functions receive the TS SDK's canUseTool `options`; here they take the wire
//! `can_use_tool` request. The field mapping (`request_id` -> `options.requestId`, `tool_use_id` ->
//! `toolUseID`, `display_name` -> `displayName`, `decision_reason` -> `decisionReason`, `blocked_path`
//! -> `blockedPath`, `permission_suggestions` -> `suggestions`, `suppress_always_allow_rule` ->
//! `suppressAlwaysAllowRule`) follows the public `CanUseTool` and `SDKControlPermissionRequest` types.

use serde_json::{json, Map, Value};

use crate::protocol::{PermissionRequest, PermissionResult};

pub const DENIED_MESSAGE: &str = "Denied in Milagre";
pub const CANCELLED_MESSAGE: &str = "The turn was cancelled in Milagre.";
pub const DISMISSED_MESSAGE: &str =
    "The user closed the question without picking an answer. If they sent a message instead, follow it; otherwise carry on without the answer, or ask in your reply if you can't.";
pub const UNSHOWN_MESSAGE: &str = "Milagre couldn't show this question. Ask it in your reply instead.";
const MAX_TEXT: usize = 20_000;
const EDIT_TOOLS: [&str; 4] = ["Edit", "MultiEdit", "Write", "NotebookEdit"];

/// Milagre permission mode -> Claude Code permission mode (`CLAUDE_MODES`).
pub fn claude_mode(milagre_mode: &str) -> &'static str {
    match milagre_mode {
        "auto" => "acceptEdits",
        "full" => "bypassPermissions",
        _ => "default",
    }
}

/// `nativeMode`: an advisor reads only (`dontAsk`); a wake's escalation turn runs in `default`.
pub fn native_mode(milagre_mode: &str, analysis_only: bool, escalation: bool) -> &'static str {
    if analysis_only {
        "dontAsk"
    } else if escalation {
        "default"
    } else {
        claude_mode(milagre_mode)
    }
}

/// JS `String(value)` for the shapes tool inputs carry.
fn js_string(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Array(items)) => {
            items.iter().map(|item| if item.is_null() { String::new() } else { js_string(Some(item)) }).collect::<Vec<_>>().join(",")
        }
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// `value ?? fallback` then String(): null and missing fall through.
fn first_present<'a>(input: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|key| input.get(*key).filter(|value| !value.is_null()))
}

/// `capText`, counting UTF-16 code units as JS `length`/`slice` do.
fn cap_text(text: String) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() <= MAX_TEXT {
        return text;
    }
    format!("{}\n… truncated", String::from_utf16_lossy(&units[..MAX_TEXT]))
}

fn prefix_lines(text: &str, prefix: &str) -> String {
    text.split('\n').map(|line| format!("{prefix}{line}")).collect::<Vec<_>>().join("\n")
}

fn replaced(old: Option<&Value>, new: Option<&Value>) -> String {
    format!("{}\n{}", prefix_lines(&js_string(old), "-"), prefix_lines(&js_string(new), "+"))
}

fn edit_diff(tool_name: &str, input: &Value) -> String {
    let text = match tool_name {
        "Edit" => replaced(input.get("old_string"), input.get("new_string")),
        "MultiEdit" => input
            .get("edits")
            .and_then(Value::as_array)
            .map(|edits| {
                edits.iter().map(|edit| replaced(edit.get("old_string"), edit.get("new_string"))).collect::<Vec<_>>().join("\n@@\n")
            })
            .unwrap_or_default(),
        "Write" => prefix_lines(&js_string(input.get("content")), "+"),
        _ => prefix_lines(&js_string(input.get("new_source")), "+"),
    };
    cap_text(text)
}

/// Node `path.basename` (POSIX): the last segment, trailing slashes ignored.
fn basename(file: &str) -> &str {
    file.trim_end_matches('/').rsplit('/').next().unwrap_or("")
}

fn non_empty(value: &Option<String>) -> Option<String> {
    value.clone().filter(|text| !text.is_empty())
}

/// `claudeRequest`: the `permission-request` event payload for a `can_use_tool` request.
pub fn permission_card(request: &PermissionRequest) -> Value {
    let tool_name = request.tool_name.as_str();
    let input = &request.input;
    let mut card = Map::new();
    let request_id =
        if request.request_id.is_empty() { request.tool_use_id.clone().unwrap_or_default() } else { request.request_id.clone() };
    card.insert("requestId".into(), request_id.into());
    card.insert("tool".into(), non_empty(&request.display_name).unwrap_or_else(|| tool_name.into()).into());
    if let Some(description) = non_empty(&request.description) {
        card.insert("description".into(), description.into());
    }
    let reason = non_empty(&request.decision_reason)
        .or_else(|| non_empty(&request.blocked_path).map(|path| format!("Reaches outside this chat's folder: {path}")));
    if let Some(reason) = reason {
        card.insert("reason".into(), reason.into());
    }
    card.insert("allowForChat".into(), (!request.suggestions.is_empty() && !request.suppress_always_allow_rule).into());
    if let Some(step) = non_empty(&request.tool_use_id) {
        card.insert("stepId".into(), step.into());
    }
    let title = non_empty(&request.title);
    if tool_name == "Bash" {
        card.insert("kind".into(), "command".into());
        card.insert("title".into(), title.unwrap_or_else(|| "Run this command?".into()).into());
        card.insert("command".into(), js_string(input.get("command")).into());
    } else if EDIT_TOOLS.contains(&tool_name) {
        let file = js_string(first_present(input, &["file_path", "notebook_path"]));
        let verb = if tool_name == "Write" { "Write" } else { "Edit" };
        let name = match basename(&file) {
            "" => "a file",
            name => name,
        };
        card.insert("kind".into(), "edit".into());
        card.insert("title".into(), title.unwrap_or_else(|| format!("{verb} {name}?")).into());
        card.insert("files".into(), if file.is_empty() { json!([]) } else { json!([file]) });
        card.insert("diff".into(), edit_diff(tool_name, input).into());
    } else {
        let name = mcp_name(tool_name).map(|(server, tool)| format!("{tool} from {server}")).unwrap_or_else(|| tool_name.into());
        card.insert("kind".into(), "other".into());
        card.insert("title".into(), title.unwrap_or_else(|| format!("Use {name}?")).into());
        card.insert("detail".into(), cap_text(serde_json::to_string_pretty(input).unwrap_or_default()).into());
    }
    Value::Object(card)
}

/// `/^mcp__(.+?)__(.+)$/`: the shortest non-empty server name followed by `__` and a non-empty tool.
fn mcp_name(tool_name: &str) -> Option<(&str, &str)> {
    let rest = tool_name.strip_prefix("mcp__")?;
    // The server takes at least one character.
    let mut from = rest.chars().next()?.len_utf8();
    while from < rest.len() {
        let index = from + rest[from..].find("__")?;
        let tool = &rest[index + 2..];
        if !tool.is_empty() {
            return Some((&rest[..index], tool));
        }
        from = index + 1;
        while !rest.is_char_boundary(from) {
            from += 1;
        }
    }
    None
}

/// The user's decision on a permission card.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Allow,
    AllowForChat,
    Deny,
    Cancelled,
}

impl Decision {
    pub fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "allow" => Self::Allow,
            "allow-for-chat" => Self::AllowForChat,
            "deny" => Self::Deny,
            "cancelled" => Self::Cancelled,
            _ => return None,
        })
    }
}

/// `claudeResult`. Chat-wide rules stay in the session (`destination: "session"`).
pub fn permission_result(decision: Decision, input: &Value, suggestions: &[Value]) -> PermissionResult {
    match decision {
        Decision::Allow => PermissionResult::Allow { updated_input: Some(input.clone()), updated_permissions: None },
        Decision::AllowForChat => PermissionResult::Allow {
            updated_input: Some(input.clone()),
            updated_permissions: Some(
                suggestions
                    .iter()
                    .map(|update| {
                        let mut update = update.as_object().cloned().unwrap_or_default();
                        update.insert("destination".into(), "session".into());
                        Value::Object(update)
                    })
                    .collect(),
            ),
        },
        Decision::Cancelled => PermissionResult::Deny { message: CANCELLED_MESSAGE.into(), interrupt: Some(true) },
        Decision::Deny => PermissionResult::Deny { message: DENIED_MESSAGE.into(), interrupt: None },
    }
}

fn text(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).map(|text| text.trim().to_owned()).unwrap_or_default()
}

fn list(value: Option<&Value>) -> &[Value] {
    value.and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

/// `claudeQuestionRequest`: the `question-request` payload for AskUserQuestion, `None` when Milagre
/// can't show it (no questions, or one without text).
pub fn question_card(request: &PermissionRequest) -> Option<Value> {
    let questions: Vec<Value> = list(request.input.get("questions"))
        .iter()
        .enumerate()
        .map(|(index, raw)| {
            let options: Vec<Value> = list(raw.get("options"))
                .iter()
                .filter_map(|option| {
                    let label = text(option.get("label"));
                    if label.is_empty() {
                        return None;
                    }
                    let description = text(option.get("description"));
                    Some(if description.is_empty() {
                        json!({ "label": label })
                    } else {
                        json!({ "label": label, "description": description })
                    })
                })
                .collect();
            json!({
                "id": index.to_string(),
                "header": text(raw.get("header")),
                "question": text(raw.get("question")),
                "options": options,
                "multiSelect": raw.get("multiSelect") == Some(&Value::Bool(true)),
                "allowOther": true,
                "secret": false,
            })
        })
        .collect();
    if questions.is_empty() || questions.iter().any(|question| question["question"] == "") {
        return None;
    }
    let request_id =
        if request.request_id.is_empty() { request.tool_use_id.clone().unwrap_or_default() } else { request.request_id.clone() };
    Some(json!({ "requestId": request_id, "questions": questions }))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuestionOutcome {
    Answered,
    Dismissed,
    Cancelled,
    Unshown,
}

/// `claudeQuestionResult`: answers keyed by question text, several picks joined with ", ".
/// `answers` maps question ids ("0", "1", ...) to the picked labels and typed text.
pub fn question_result(outcome: QuestionOutcome, input: &Value, answers: &Map<String, Value>) -> PermissionResult {
    match outcome {
        QuestionOutcome::Answered => {
            let mut given = Map::new();
            for (index, question) in list(input.get("questions")).iter().enumerate() {
                let picked: Vec<String> = answers
                    .get(&index.to_string())
                    .and_then(Value::as_array)
                    .map(|values| values.iter().map(|value| js_string(Some(value))).collect())
                    .unwrap_or_default();
                if !picked.is_empty() {
                    given.insert(js_string(question.get("question")), picked.join(", ").into());
                }
            }
            let mut updated = input.as_object().cloned().unwrap_or_default();
            updated.insert("answers".into(), Value::Object(given));
            PermissionResult::Allow { updated_input: Some(Value::Object(updated)), updated_permissions: None }
        }
        QuestionOutcome::Cancelled => PermissionResult::Deny { message: CANCELLED_MESSAGE.into(), interrupt: Some(true) },
        QuestionOutcome::Unshown => PermissionResult::Deny { message: UNSHOWN_MESSAGE.into(), interrupt: None },
        QuestionOutcome::Dismissed => PermissionResult::Deny { message: DISMISSED_MESSAGE.into(), interrupt: None },
    }
}

/// `PendingQuestions.answer`: answers to questions the card didn't ask, and blank answers, are dropped;
/// nothing left means the question was dismissed.
pub fn settle_answers(card: &Value, answers: &Map<String, Value>) -> (QuestionOutcome, Map<String, Value>) {
    let ids: Vec<&str> = list(card.get("questions")).iter().filter_map(|question| question.get("id").and_then(Value::as_str)).collect();
    let mut kept = Map::new();
    for (id, values) in answers {
        let values: Vec<Value> =
            list(Some(values)).iter().filter_map(Value::as_str).map(str::trim).filter(|value| !value.is_empty()).map(Value::from).collect();
        if ids.contains(&id.as_str()) && !values.is_empty() {
            kept.insert(id.clone(), Value::Array(values));
        }
    }
    if kept.is_empty() {
        (QuestionOutcome::Dismissed, kept)
    } else {
        (QuestionOutcome::Answered, kept)
    }
}

/// One part of a prompt, already ordered (Milagre's `promptImageBlocks` decides the order).
#[derive(Debug, Clone, PartialEq)]
pub enum PromptPart {
    Text(String),
    Image { mime: String, base64: String },
}

/// `userMessage`'s content blocks.
pub fn user_content(parts: &[PromptPart]) -> Vec<Value> {
    parts
        .iter()
        .map(|part| match part {
            PromptPart::Text(text) => crate::protocol::text_block(text),
            PromptPart::Image { mime, base64 } => crate::protocol::image_block(mime, base64),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_names_split_like_the_lazy_regex() {
        assert_eq!(mcp_name("mcp__milagre__chat_stop"), Some(("milagre", "chat_stop")));
        assert_eq!(mcp_name("mcp__a__b__c"), Some(("a", "b__c")));
        assert_eq!(mcp_name("mcp_____x"), Some(("_", "x")));
        assert_eq!(mcp_name("mcp____x"), None);
        assert_eq!(mcp_name("mcp__é__t"), Some(("é", "t")));
        assert_eq!(mcp_name("mcp__a__"), None);
        assert_eq!(mcp_name("Bash"), None);
    }

    #[test]
    fn modes() {
        assert_eq!(claude_mode("ask"), "default");
        assert_eq!(claude_mode("auto"), "acceptEdits");
        assert_eq!(claude_mode("full"), "bypassPermissions");
        assert_eq!(native_mode("full", true, false), "dontAsk");
        assert_eq!(native_mode("full", false, true), "default");
    }

    #[test]
    fn settle_drops_unknown_and_blank() {
        let card = json!({"questions":[{"id":"0"},{"id":"1"}]});
        let answers = json!({"0":["  a "," "],"1":[" "],"9":["x"]});
        let (outcome, kept) = settle_answers(&card, answers.as_object().unwrap());
        assert_eq!(outcome, QuestionOutcome::Answered);
        assert_eq!(Value::Object(kept), json!({"0":["a"]}));
        let (outcome, _) = settle_answers(&card, json!({"1":[""]}).as_object().unwrap());
        assert_eq!(outcome, QuestionOutcome::Dismissed);
    }
}

//! Codex subagents (child threads) as Milagre `subagent-update` events. Port of the Codex half of
//! packages/core/src/agents/subagents.cjs (`codexSubagents`, `update`, `settleSubagents`,
//! `backgroundTasks` for the empty set), `addProgress` from packages/shared/src/subagent-glance.mjs
//! and `codexPlanTasks` from tasks.cjs. Agents are kept as JSON objects so their shape follows the
//! wire contract exactly.

use crate::codex::events::CodexEventState;
use crate::codex::js::{js_string, strict_eq, truthy};
use crate::codex::steps::{cap_output, codex_step};
use serde_json::{json, Map, Value};

/// `subagentActive`: initializing, running or waiting.
pub fn active(agent: &Value) -> bool {
    matches!(agent.get("status").and_then(Value::as_str), Some("initializing" | "running" | "waiting"))
}

/// A patch field; `None` is JavaScript's `undefined` (the key is spread but holds nothing).
pub type Patch = Vec<(&'static str, Option<Value>)>;

/// subagents.cjs `update`: merges a patch and an optional transcript row into the agent and returns
/// its `subagent-update` event.
pub fn update(state: &mut CodexEventState, id: &str, patch: Patch, entry: Option<Map<String, Value>>) -> Value {
    let previous = state.subagents.get(id).cloned();
    let row = entry.filter(|e| truthy(e.get("text"))).map(|mut e| {
        let text = js_string(e.get("text"));
        e.insert("text".into(), cap_output(&text).into());
        e
    });
    let previous_row = row.as_ref().and_then(|row| {
        previous.as_ref()?.get("transcript")?.as_array()?.iter().find(|item| strict_eq(item.get("id"), row.get("id"))).cloned()
    });
    let same_row = match &row {
        None => true,
        Some(row) => {
            previous_row.as_ref().is_some_and(|p| strict_eq(p.get("kind"), row.get("kind")) && strict_eq(p.get("text"), row.get("text")))
        }
    };
    if let Some(previous) = &previous {
        if same_row && patch.iter().all(|(key, value)| strict_eq(previous.get(*key), value.as_ref())) {
            return json!({ "type": "subagent-update", "agent": previous });
        }
    }
    let time = state.now();
    let mut agent = Map::new();
    agent.insert("id".into(), id.into());
    agent.insert("title".into(), "Subagent".into());
    agent.insert("status".into(), "running".into());
    agent.insert("startedAt".into(), time.into());
    agent.insert("transcript".into(), json!([]));
    if let Some(Value::Object(previous)) = &previous {
        for (key, value) in previous {
            agent.insert(key.clone(), value.clone());
        }
    }
    for (key, value) in patch {
        match value {
            Some(value) => {
                agent.insert(key.into(), value);
            }
            None => {
                agent.remove(key);
            }
        }
    }
    agent.insert("updatedAt".into(), time.into());
    if let Some(row) = row.filter(|_| !same_row) {
        let row_id = row.get("id").cloned();
        let mut transcript: Vec<Value> = agent
            .get("transcript")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter(|item| !strict_eq(item.get("id"), row_id.as_ref())).cloned().collect())
            .unwrap_or_default();
        let row = Value::Object(row);
        transcript.push(row.clone());
        let skip = transcript.len().saturating_sub(100);
        agent.insert("transcript".into(), Value::Array(transcript.split_off(skip)));
        if previous_row.is_none() {
            let progress = add_progress(agent.get("progress"), &row);
            agent.insert("progress".into(), progress);
        }
    }
    let agent = Value::Object(agent);
    let mut agent = agent;
    if !active(&agent) {
        if agent.get("endedAt").is_none_or(Value::is_null) {
            agent["endedAt"] = time.into();
        }
    } else if let Some(map) = agent.as_object_mut() {
        map.remove("endedAt");
    }
    state.subagents.insert(id.to_string(), agent.clone());
    json!({ "type": "subagent-update", "agent": agent })
}

fn image_file(text: &str) -> bool {
    // /\.(png|jpe?g|gif|webp|heic|svg|bmp|tiff?)\b/i
    let lower = text.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    for (index, _) in lower.match_indices('.') {
        let rest = &lower[index + 1..];
        for ext in ["png", "jpeg", "jpg", "gif", "webp", "heic", "svg", "bmp", "tiff", "tif"] {
            if rest.starts_with(ext) {
                let after = index + 1 + ext.len();
                let boundary = after >= bytes.len() || !(bytes[after].is_ascii_alphanumeric() || bytes[after] == b'_');
                if boundary {
                    return true;
                }
            }
        }
    }
    false
}

fn kind_of_title(title: &str) -> &'static str {
    if title.starts_with("Ran ") {
        "shell"
    } else if title.starts_with("Read ") || title.starts_with("Viewed ") {
        if image_file(title.split('\n').next().unwrap_or("")) {
            "image"
        } else {
            "read"
        }
    } else if ["Edited ", "Wrote ", "Created ", "Deleted "].iter().any(|p| title.starts_with(p)) {
        "edit"
    } else if ["Searched", "Found files", "Listed files"].iter().any(|p| title.starts_with(p)) {
        "search"
    } else {
        "other"
    }
}

/// subagent-glance.mjs `toolCategory`.
pub fn tool_category(kind: Option<&str>, text: &str) -> &'static str {
    let resolved = kind.unwrap_or_else(|| kind_of_title(text));
    match resolved {
        "shell" => "commands",
        "image" => "images",
        "read" if image_file(text.split('\n').next().unwrap_or("")) => "images",
        "read" => "reads",
        "search" => "searches",
        "edit" => "edits",
        _ => "other",
    }
}

/// subagent-glance.mjs `firstSentence`.
pub fn first_sentence(text: &str) -> String {
    let line = text.split('\n').map(strip_list_mark).map(|part| part.trim().to_string()).find(|part| !part.is_empty()).unwrap_or_default();
    let plain = line.replace("**", "").replace("__", "").replace('`', "");
    let chars: Vec<(usize, char)> = plain.char_indices().collect();
    for (pos, (index, ch)) in chars.iter().enumerate() {
        if matches!(ch, '.' | '!' | '?') {
            let next = chars.get(pos + 1).map(|(_, c)| *c);
            if next.is_none_or(char::is_whitespace) {
                return plain[..index + ch.len_utf8()].trim().to_string();
            }
        }
    }
    plain.trim().to_string()
}

/// `^\s*(#{1,6}\s+|[-*>]\s+|\d+\.\s+)` removed.
fn strip_list_mark(part: &str) -> &str {
    let rest = part.trim_start();
    let strip_ws = |s: &'_ str| -> Option<usize> {
        let trimmed = s.trim_start();
        (trimmed.len() < s.len()).then_some(s.len() - trimmed.len())
    };
    let hashes = rest.chars().take_while(|c| *c == '#').count();
    if (1..=6).contains(&hashes) {
        if let Some(ws) = strip_ws(&rest[hashes..]) {
            return &rest[hashes + ws..];
        }
    }
    if rest.starts_with(['-', '*', '>']) {
        if let Some(ws) = strip_ws(&rest[1..]) {
            return &rest[1 + ws..];
        }
    }
    let digits = rest.chars().take_while(char::is_ascii_digit).count();
    if digits > 0 && rest[digits..].starts_with('.') {
        if let Some(ws) = strip_ws(&rest[digits + 1..]) {
            return &rest[digits + 1 + ws..];
        }
    }
    part
}

/// subagent-glance.mjs `addProgress`.
pub fn add_progress(progress: Option<&Value>, entry: &Value) -> Value {
    let mut current = progress.filter(|p| !p.is_null()).cloned().unwrap_or_else(|| json!({ "steps": 0, "tools": {} }));
    let id = entry.get("id").and_then(Value::as_str).unwrap_or("");
    let kind = entry.get("kind").and_then(Value::as_str);
    let text = entry.get("text").and_then(Value::as_str).unwrap_or("");
    if kind == Some("tool") && !id.starts_with("result:") {
        let category = tool_category(entry.get("tool").and_then(Value::as_str), text);
        let count = current.pointer(&format!("/tools/{category}")).and_then(Value::as_f64).unwrap_or(0.0) + 1.0;
        let mut tools = current.get("tools").cloned().unwrap_or(json!({}));
        tools[category] = crate::codex::steps::number(count);
        current["tools"] = tools;
        return current;
    }
    if kind == Some("message") && id != "result" && id != "summary" && !text.trim().is_empty() {
        let steps = current.get("steps").and_then(Value::as_f64).unwrap_or(0.0) + 1.0;
        current["steps"] = crate::codex::steps::number(steps);
        current["said"] = first_sentence(text).into();
    }
    current
}

/// tasks.cjs `codexPlanTasks`: `[{ step, status }]` -> `[{ id, content, status }]`.
pub fn codex_plan_tasks(plan: Option<&Value>) -> Option<Value> {
    let plan = plan?.as_array()?;
    let tasks: Vec<Value> = plan
        .iter()
        .enumerate()
        .filter_map(|(index, item)| {
            let content = item.get("step").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())?;
            let status = match item.get("status").and_then(Value::as_str) {
                Some("inProgress") => "in_progress",
                Some(s @ ("pending" | "in_progress" | "completed")) => s,
                _ => "pending",
            };
            Some(json!({ "id": index.to_string(), "content": content, "status": status }))
        })
        .collect();
    Some(Value::Array(tasks))
}

fn codex_status(status: Option<&str>) -> &'static str {
    match status {
        Some("pendingInit") => "initializing",
        Some("running") => "running",
        Some("interrupted") | Some("shutdown") => "cancelled",
        Some("completed") => "completed",
        Some("errored") => "failed",
        _ => "unknown",
    }
}

fn entry(pairs: &[(&str, Value)]) -> Map<String, Value> {
    pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
}

/// subagents.cjs `codexSubagents`.
pub fn codex_subagents(method: &str, params: &Value, state: &mut CodexEventState) -> Vec<Value> {
    let item = params.get("item").filter(|i| !i.is_null());
    let thread = params.get("threadId").and_then(Value::as_str).filter(|s| !s.is_empty());
    let foreign = match (thread, state.thread_id.as_deref().filter(|s| !s.is_empty())) {
        (Some(thread), Some(own)) => thread != own,
        _ => false,
    };
    if foreign && !state.subagents.contains_key(thread.unwrap_or_default()) {
        return vec![];
    }
    if !foreign {
        if let (Some(current), Some(turn)) =
            (state.turn_id.as_deref().filter(|s| !s.is_empty()), params.get("turnId").and_then(Value::as_str).filter(|s| !s.is_empty()))
        {
            if current != turn {
                return vec![];
            }
        }
    }
    let thread = thread.unwrap_or_default().to_string();
    let item_type = item.and_then(|i| i.get("type")).and_then(Value::as_str);
    let started_or_completed = matches!(method, "item/started" | "item/completed");
    let mut events = Vec::new();
    if let (Some(item), Some("subAgentActivity"), true) = (item, item_type, started_or_completed) {
        let target = item.get("agentThreadId").and_then(Value::as_str);
        let sender = foreign.then(|| thread.clone());
        let kind = item.get("kind");
        let owner_thread = params
            .get("threadId")
            .filter(|t| !t.is_null())
            .map(|t| js_string(Some(t)))
            .unwrap_or_else(|| js_string(state.thread_id.as_ref().map(|s| Value::from(s.as_str())).as_ref()));
        let id = format!("activity:{owner_thread}:{}:{}", js_string(item.get("id")), js_string(kind));
        if state.subagent_activity_ids.contains(&id) {
            return vec![];
        }
        if kind.and_then(Value::as_str) == Some("interacted") {
            let to_id = target.filter(|t| Some(*t) != state.thread_id.as_deref()).map(str::to_string);
            let owner = to_id.clone().or(sender);
            if !owner.as_deref().is_some_and(|o| state.subagents.contains_key(o)) {
                return vec![];
            }
            state.subagent_activity_ids.insert(id);
            if let Some(to_id) = to_id {
                let until = state.now() + 10_000;
                state.subagent_recheck_until.insert(to_id, until);
            }
        } else if let Some(target) = target.filter(|t| !t.is_empty() && Some(*t) != state.thread_id.as_deref()) {
            state.subagent_activity_ids.insert(id);
            let status = match kind.and_then(Value::as_str) {
                Some("started") => "running",
                Some("interrupted") => "cancelled",
                Some("completed") => "completed",
                _ => "unknown",
            };
            let title = item.get("agentPath").filter(|p| truthy(Some(p))).cloned().unwrap_or_else(|| "Subagent".into());
            let mut patch: Patch = vec![("title", Some(title)), ("status", Some(status.into()))];
            if foreign && kind.and_then(Value::as_str) == Some("started") {
                patch.push(("parentId", Some(thread.clone().into())));
            }
            events.push(update(state, target, patch, None));
        }
    }
    if foreign && method == "thread/status/changed" {
        let status_type = params.pointer("/status/type").and_then(Value::as_str);
        let status = match status_type {
            Some("active") => {
                let waiting = params
                    .pointer("/status/activeFlags")
                    .and_then(Value::as_array)
                    .is_some_and(|flags| flags.iter().any(|f| matches!(f.as_str(), Some("waitingOnApproval" | "waitingOnUserInput"))));
                Some(if waiting { "waiting" } else { "running" })
            }
            Some("systemError") => Some("failed"),
            Some("notLoaded") => Some("unknown"),
            _ => None,
        };
        let recorded = state.subagents.get(&thread).and_then(|a| a.get("status")).and_then(Value::as_str);
        let unloaded_terminal = status_type == Some("notLoaded") && matches!(recorded, Some("completed" | "failed" | "cancelled"));
        if let Some(status) = status.filter(|_| !unloaded_terminal) {
            events.push(update(state, &thread, vec![("status", Some(status.into()))], None));
        }
    }
    if let (Some(item), Some("collabAgentToolCall"), true) = (item, item_type, started_or_completed) {
        let tool = item.get("tool").and_then(Value::as_str);
        for id in item.get("receiverThreadIds").and_then(Value::as_array).cloned().unwrap_or_default() {
            let id = js_string(Some(&id));
            if Some(id.as_str()) == state.thread_id.as_deref() {
                continue;
            }
            let status = item.get("agentsStates").and_then(|s| s.get(&id)).filter(|s| truthy(Some(s))).cloned();
            if !state.subagents.contains_key(&id) && status.is_none() && tool != Some("spawnAgent") {
                continue;
            }
            let mut patch: Patch = Vec::new();
            if foreign && tool == Some("spawnAgent") {
                patch.push(("parentId", Some(thread.clone().into())));
            }
            if tool == Some("spawnAgent") {
                let prompt = item.get("prompt");
                let first = prompt
                    .and_then(Value::as_str)
                    .map(|p| crate::codex::js::slice_utf16_start(p.split('\n').next().unwrap_or(""), 120).to_string());
                let title = first.filter(|t| !t.is_empty()).unwrap_or_else(|| "Subagent".into());
                patch.push(("title", Some(title.into())));
                patch.push(("prompt", prompt.cloned()));
            }
            if let Some(status) = &status {
                patch.push(("status", Some(codex_status(status.get("status").and_then(Value::as_str)).into())));
            }
            let row = status
                .as_ref()
                .and_then(|s| s.get("message"))
                .filter(|m| truthy(Some(m)))
                .map(|m| entry(&[("id", "result".into()), ("kind", "message".into()), ("text", m.clone())]));
            events.push(update(state, &id, patch, row));
        }
        if !foreign && tool == Some("wait") {
            events.push(json!({ "type": "subagents-waiting", "waiting": method == "item/started" }));
        }
    }
    if foreign && method == "item/started" {
        if let Some(item) = item {
            let activity = codex_step(item).and_then(|s| s.get("title").cloned()).or_else(|| match item_type {
                Some("reasoning") => Some("Thinking".into()),
                Some("agentMessage") => Some("Responding".into()),
                _ => None,
            });
            if let Some(activity) = activity {
                events.push(update(state, &thread, vec![("latestActivity", Some(activity))], None));
            }
        }
    }
    if foreign && method == "item/completed" {
        if let Some(item) = item {
            let step = codex_step(item);
            let text = match item_type {
                Some("agentMessage") => item.get("text").filter(|t| truthy(Some(t))).map(|t| js_string(Some(t))).unwrap_or_default(),
                Some("reasoning") => item
                    .get("summary")
                    .and_then(Value::as_array)
                    .map(|parts| parts.iter().map(|p| crate::codex::js::js_string_or_empty(Some(p))).collect::<Vec<_>>().join("\n"))
                    .unwrap_or_default(),
                _ => match &step {
                    Some(step) => [step.get("title"), item.get("aggregatedOutput")]
                        .into_iter()
                        .filter(|v| truthy(*v))
                        .map(js_string)
                        .collect::<Vec<_>>()
                        .join("\n"),
                    None => String::new(),
                },
            };
            if !text.is_empty() {
                let activity =
                    step.as_ref().and_then(|s| s.get("title")).filter(|t| truthy(Some(t))).cloned().unwrap_or_else(|| "Responding".into());
                let mut row = entry(&[
                    ("id", item.get("id").cloned().unwrap_or(Value::Null)),
                    ("kind", if step.is_some() { "tool" } else { "message" }.into()),
                    ("text", text.into()),
                ]);
                if let Some(step) = &step {
                    row.insert("tool".into(), step.get("kind").cloned().unwrap_or(Value::Null));
                }
                events.push(update(state, &thread, vec![("latestActivity", Some(activity))], Some(row)));
            }
        }
    }
    if foreign && method == "turn/plan/updated" {
        if let Some(tasks) = codex_plan_tasks(params.get("plan")) {
            events.push(update(state, &thread, vec![("tasks", Some(tasks))], None));
        }
    }
    if foreign && method == "turn/started" {
        events.push(update(state, &thread, vec![("status", Some("running".into()))], None));
    }
    if foreign && method == "turn/completed" {
        let status = match params.pointer("/turn/status").and_then(Value::as_str) {
            Some("failed") => "failed",
            Some("interrupted") => "cancelled",
            _ => "completed",
        };
        events.push(update(state, &thread, vec![("status", Some(status.into()))], None));
    }
    events
}

/// subagents.cjs `settleSubagents`: a session that ends leaves no subagent running.
pub fn settle_subagents(state: &mut CodexEventState, status: &str) -> Vec<Value> {
    let running: Vec<String> =
        state.subagents.values().filter(|a| active(a)).filter_map(|a| a.get("id").map(|id| js_string(Some(id)))).collect();
    let mut events: Vec<Value> = running.iter().map(|id| update(state, id, vec![("status", Some(status.into()))], None)).collect();
    // backgroundTasks(state, []): Codex never reports background tasks, so the set is empty unless an
    // earlier Claude-shaped state left some.
    // backgroundTasks reads the clock once even for an empty set; read it too so replays line up.
    let _ = state.now();
    state.background_task_starts.clear();
    let key = "[]".to_string();
    if state.background_tasks_key.as_deref().unwrap_or("[]") != key {
        state.background_tasks_key = Some(key);
        events.push(json!({ "type": "background-tasks", "tasks": [] }));
    }
    events
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sentences() {
        assert_eq!(first_sentence("## Plan. Then more"), "Plan.");
        assert_eq!(first_sentence("\n- **Check** `x` now"), "Check x now");
        assert_eq!(first_sentence("1. Version 1.2 ok! rest"), "Version 1.2 ok!");
    }

    #[test]
    fn categories() {
        assert_eq!(tool_category(Some("read"), "Read `a.png`"), "images");
        assert_eq!(tool_category(None, "Ran `ls`"), "commands");
        assert_eq!(tool_category(None, "Viewed `shot.jpeg`"), "images");
    }
}

//! Claude child and background task lifecycles (`subagents.cjs`). Session state, not turn state:
//! ending a turn clears foreground waits but does not end a background child.
use crate::steps::claude_step;
use crate::tasks::Tasks;
use crate::text::{cap_output, js_string, js_trim, utf16_slice, Obj};
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

#[derive(Clone, Debug)]
pub struct Subagents {
    agents: Map<String, Value>,
    budget: crate::budget::EventBudget,
    max_agents: usize,
    max_snapshot_bytes: usize,
    failed: bool,
    foreground: HashSet<String>,
    tasks: HashMap<String, Tasks>,
    calls: HashMap<String, (String, Value)>,
    results: HashSet<String>,
    task_agents: HashMap<String, String>,
    background: Vec<Value>,
}
impl Default for Subagents {
    fn default() -> Self {
        Self {
            agents: Map::new(),
            foreground: HashSet::new(),
            tasks: HashMap::new(),
            calls: HashMap::new(),
            results: HashSet::new(),
            task_agents: HashMap::new(),
            background: vec![],
            budget: Default::default(),
            max_agents: 128,
            max_snapshot_bytes: 256 * 1024,
            failed: false,
        }
    }
}
fn str_at(value: &Value, field: &str) -> String {
    value.get(field).map(js_string).unwrap_or_else(|| "undefined".into())
}
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64() != Some(0.0),
        _ => true,
    }
}
fn active(agent: &Value) -> bool {
    matches!(agent["status"].as_str(), Some("initializing" | "running" | "waiting"))
}
fn text_content(value: &Value) -> String {
    if let Some(s) = value.as_str() {
        return s.into();
    }
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|b| b.get("text").filter(|v| !v.is_null()).or_else(|| b.get("content")).and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}
static IMAGE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\.(png|jpe?g|gif|webp|heic|svg|bmp|tiff?)(?-u:\b)").unwrap());
static MARKER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*(#{1,6}\s+|[-*>]\s+|[0-9]+\.\s+)").unwrap());
static SENTENCE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[.!?](\s|$)").unwrap());
fn category(row: &Value) -> &'static str {
    let text = row["text"].as_str().unwrap_or_default().split('\n').next().unwrap_or_default();
    let kind = row["tool"].as_str().unwrap_or_else(|| {
        if text.starts_with("Ran ") {
            "shell"
        } else if text.starts_with("Read ") || text.starts_with("Viewed ") {
            "read"
        } else if ["Edited ", "Wrote ", "Created ", "Deleted "].iter().any(|p| text.starts_with(p)) {
            "edit"
        } else if ["Searched", "Found files", "Listed files"].iter().any(|p| text.starts_with(p)) {
            "search"
        } else {
            "other"
        }
    });
    match kind {
        "shell" => "commands",
        "image" => "images",
        "read" if IMAGE.is_match(text) => "images",
        "read" => "reads",
        "edit" => "edits",
        "search" => "searches",
        _ => "other",
    }
}
fn first_sentence(text: &str) -> String {
    let line = text.split('\n').map(|s| MARKER.replace(s, "").trim().to_owned()).find(|s| !s.is_empty()).unwrap_or_default();
    let plain = line.replace("**", "").replace("__", "").replace('`', "");
    match SENTENCE.find(&plain) {
        Some(m) => plain[..m.start() + 1].trim().to_owned(),
        None => plain.trim().to_owned(),
    }
}
fn add_progress(previous: Option<&Value>, row: &Value) -> Value {
    let mut p = previous.cloned().unwrap_or_else(|| json!({"steps":0,"tools":{}}));
    let id = row["id"].as_str().unwrap_or_default();
    if row["kind"] == "tool" && !id.starts_with("result:") {
        let c = category(row);
        let n = p["tools"][c].as_u64().unwrap_or(0);
        p["tools"][c] = json!(n + 1);
    } else if row["kind"] == "message"
        && !["result", "summary"].contains(&id)
        && !js_trim(row["text"].as_str().unwrap_or_default()).is_empty()
    {
        p["steps"] = json!(p["steps"].as_u64().unwrap_or(0) + 1);
        p["said"] = first_sentence(row["text"].as_str().unwrap()).into();
    }
    p
}
/// Retain recent rows first, then shorten display strings. Identity/status/timestamps stay exact.
/// `truncated` is sticky so the reducer never presents an incomplete history as complete.
fn trim_snapshot(agent: &mut Value, limit: usize) -> bool {
    let rows = agent["transcript"].as_array_mut().unwrap();
    let trimmed_rows = rows.len() > 100;
    if trimmed_rows {
        rows.drain(..rows.len() - 100);
    }
    if !trimmed_rows && crate::budget::weight(agent) <= limit {
        return true;
    }
    agent["truncated"] = true.into();
    while crate::budget::weight(agent) > limit && agent["transcript"].as_array().unwrap().len() > 1 {
        agent["transcript"].as_array_mut().unwrap().remove(0);
    }
    loop {
        let excess = crate::budget::weight(agent).saturating_sub(limit);
        if excess == 0 {
            return true;
        }
        let last = agent["transcript"].as_array().unwrap().len().saturating_sub(1);
        let row_text = format!("/transcript/{last}/text");
        let paths = ["/title", "/prompt", "/agentType", "/latestActivity", "/progress/said", row_text.as_str()];
        let longest = paths
            .into_iter()
            .filter_map(|path| agent.pointer(path).and_then(Value::as_str).map(|s| (path, s.len())))
            .filter(|(_, len)| *len > 0)
            .max_by_key(|(_, len)| *len);
        if let Some((path, len)) = longest {
            let text = agent.pointer_mut(path).unwrap().as_str().unwrap();
            let mut keep = len.saturating_sub(excess);
            while !text.is_char_boundary(keep) {
                keep -= 1;
            }
            let short = text[..keep].to_owned();
            *agent.pointer_mut(path).unwrap() = short.into();
            continue;
        }
        // Large task arrays or malformed display metadata cannot consume unbounded retained space.
        let removable = ["tasks", "progress", "prompt", "agentType", "latestActivity", "title"]
            .into_iter()
            .filter_map(|key| agent.get(key).map(|v| (key, crate::budget::weight(v))))
            .max_by_key(|(_, bytes)| *bytes);
        if let Some((key, _)) = removable {
            agent.as_object_mut().unwrap().remove(key);
            continue;
        }
        if !agent["transcript"].as_array().unwrap().is_empty() {
            agent["transcript"] = json!([]);
            continue;
        }
        // Only an oversized identity or a nonsensically small configured budget reaches here.
        return false;
    }
}
impl Subagents {
    pub fn set_limits(&mut self, budget: crate::budget::EventBudget, agents: usize, snapshot_bytes: usize) {
        self.budget = budget;
        self.max_agents = agents;
        self.max_snapshot_bytes = snapshot_bytes;
    }
    fn fail(&mut self) -> crate::budget::BudgetFailure {
        self.failed = true;
        crate::budget::BudgetFailure::Subagents
    }

    fn update(&mut self, id: &str, patch: Value, entry: Option<Value>, now: u64) -> Result<Value, crate::budget::BudgetFailure> {
        if self.failed || (!self.agents.contains_key(id) && self.agents.len() >= self.max_agents) {
            return Err(self.fail());
        }
        let previous = self.agents.get(id);
        let row = entry.filter(|e| truthy(&e["text"])).map(|mut e| {
            e["text"] = cap_output(e["text"].as_str().unwrap_or_default()).into();
            e
        });
        let previous_row = row
            .as_ref()
            .and_then(|r| previous.and_then(|a| a["transcript"].as_array()).and_then(|rows| rows.iter().find(|e| e["id"] == r["id"])));
        let same = row.as_ref().is_none_or(|r| previous_row.is_some_and(|p| p["kind"] == r["kind"] && p["text"] == r["text"]));
        let patch = patch.as_object().unwrap();
        if let Some(previous) = previous {
            if same && patch.iter().all(|(k, v)| previous.get(k) == Some(v)) {
                return Ok(json!({"type":"subagent-update","agent":previous}));
            }
        }
        let mut agent = Obj::new()
            .set("id", id)
            .set("title", "Subagent")
            .set("status", "running")
            .set("startedAt", now)
            .set("transcript", json!([]))
            .merge(previous.and_then(Value::as_object).cloned().unwrap_or_default())
            .merge(patch.clone())
            .set("updatedAt", now)
            .build();
        if let Some(row) = row.filter(|_| !same) {
            if previous_row.is_none() {
                agent["progress"] = add_progress(agent.get("progress"), &row);
            }
            let rows = agent["transcript"].as_array_mut().unwrap();
            rows.retain(|r| r["id"] != row["id"]);
            rows.push(row);
        }
        if active(&agent) {
            agent.as_object_mut().unwrap().remove("endedAt");
        } else if agent.get("endedAt").is_none() {
            agent["endedAt"] = now.into();
        }
        if !trim_snapshot(&mut agent, self.max_snapshot_bytes) {
            return Err(self.fail());
        }
        if agent.get("tasks").is_none() {
            self.tasks.remove(id);
        }
        self.agents.insert(id.into(), agent.clone());
        Ok(json!({"type":"subagent-update","agent":agent}))
    }
    pub fn end_turn(&mut self) {
        self.foreground.clear();
    }
    pub fn settle(&mut self, status: &str, now: u64) -> Vec<Value> {
        crate::budget::public_events(self.settle_bounded(status, now, false))
    }
    pub(crate) fn settle_bounded(&mut self, status: &str, now: u64, compact: bool) -> crate::budget::Mapped {
        let ids: Vec<_> = self.agents.iter().filter(|(_, a)| active(a)).map(|(id, _)| id.clone()).collect();
        let mut events = crate::budget::Batch::new(self.budget);
        for id in ids {
            if compact {
                // Reducers merge by id. Keep the existing transcript; settlement only changes status.
                let agent = self.agents.get_mut(&id).unwrap();
                agent["status"] = status.into();
                agent["updatedAt"] = now.into();
                agent["endedAt"] = now.into();
                if !trim_snapshot(agent, self.max_snapshot_bytes) {
                    events.fail(crate::budget::BudgetFailure::Subagents);
                    break;
                }
                let patch = Obj::new()
                    .set("id", id)
                    .set("status", status)
                    .set("updatedAt", now)
                    .set("endedAt", now)
                    .set("startedAt", agent["startedAt"].clone())
                    .set("title", utf16_slice(agent["title"].as_str().unwrap_or("Subagent"), 0, 200))
                    .set("transcript", json!([]))
                    .opt("background", agent.get("background").cloned())
                    .opt("truncated", agent.get("truncated").cloned())
                    .build();
                events.push(json!({"type":"subagent-update","agent":patch}));
            } else {
                events.push_result(self.update(&id, json!({"status":status}), None, now));
            }
            if events.failed() {
                break;
            }
        }
        events.extend(self.background_tasks(&[], now));
        events.finish()
    }
    fn background_tasks(&mut self, tasks: &[Value], now: u64) -> Vec<Value> {
        let mut next: Vec<_>=tasks.iter().filter(|t|t["task_id"].is_string() && !truthy(&t["ambient"]) && t["task_type"]!="local_agent").take(50).map(|t| {
            let title=utf16_slice(js_trim(t["description"].as_str().unwrap_or_default()),0,200);
            let start=self.background.iter().find(|b|b["id"]==t["task_id"]).map(|b|b["startedAt"].clone()).unwrap_or_else(||now.into());
            json!({"id":t["task_id"],"kind":t["task_type"].as_str().unwrap_or("task"),"title":if title.is_empty(){"Background task"}else{&title},"startedAt":start})
        }).collect();
        next.sort_by(|a, b| {
            a["startedAt"]
                .as_u64()
                .cmp(&b["startedAt"].as_u64())
                .then_with(|| a["id"].as_str().unwrap().encode_utf16().cmp(b["id"].as_str().unwrap().encode_utf16()))
        });
        if next == self.background {
            return vec![];
        }
        self.background = next.clone();
        vec![json!({"type":"background-tasks","tasks":next})]
    }
    pub fn map(&mut self, message: &Value, now: u64) -> Vec<Value> {
        crate::budget::public_events(self.map_bounded(message, now))
    }
    pub(crate) fn map_bounded(&mut self, message: &Value, now: u64) -> crate::budget::Mapped {
        let mut events = crate::budget::Batch::new(self.budget);
        if self.failed {
            return Err(self.fail());
        }
        let parent = message["parent_tool_use_id"].as_str().filter(|s| !s.is_empty());
        let content = message.pointer("/message/content").and_then(Value::as_array);
        if message["type"] == "assistant" {
            for (index, block) in content.into_iter().flatten().enumerate() {
                if events.failed() {
                    break;
                }
                if self.calls.len() + self.results.len() > self.max_agents.saturating_mul(16) {
                    events.fail(self.fail());
                    break;
                }
                let name = block["name"].as_str().unwrap_or_default();
                let id = str_at(block, "id");
                if block["type"] == "tool_use" && ["Agent", "Task"].contains(&name) {
                    let background = parent.is_none() && truthy(&block["input"]["run_in_background"]);
                    if parent.is_none() && !background {
                        self.foreground.insert(id.clone());
                        events.push(json!({"type":"subagents-waiting","waiting":true}));
                    }
                    let input = &block["input"];
                    let patch = Obj::new()
                        .set("title", if truthy(&input["description"]) { input["description"].clone() } else { json!("Subagent") })
                        .opt("prompt", input.get("prompt").cloned())
                        .opt("agentType", input.get("subagent_type").filter(|v| truthy(v)).cloned())
                        .opt("parentId", parent)
                        .opt("background", background.then_some(true))
                        .build();
                    events.push_result(self.update(&id, patch, None, now));
                }
                let Some(parent) = parent.filter(|p| self.agents.contains_key(*p)) else { continue };
                if block["type"] == "tool_use" && ["TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"].contains(&name) {
                    if ["TaskCreate", "TaskList"].contains(&name) {
                        self.calls.insert(id, (parent.into(), block.clone()));
                    } else {
                        self.results.insert(id);
                    }
                    if let Some(tasks) = self.tasks.entry(parent.into()).or_default().apply_tool_use(name, &block["input"]) {
                        events.push_result(self.update(parent, json!({"tasks":tasks}), None, now));
                    }
                    continue;
                }
                let step = (block["type"] == "tool_use").then(|| claude_step(&id, name, &block["input"]));
                let text = match block["type"].as_str() {
                    Some("text") => block["text"].clone(),
                    Some("thinking") => block["thinking"].clone(),
                    _ => step.as_ref().map(|s| s["title"].clone()).unwrap_or(json!("")),
                };
                let prefix = message
                    .get("uuid")
                    .filter(|v| !v.is_null())
                    .or_else(|| message.pointer("/message/id"))
                    .map(js_string)
                    .unwrap_or("undefined".into());
                let block_id = block.get("id").filter(|v| !v.is_null()).map(js_string).unwrap_or_else(|| index.to_string());
                let row = Obj::new()
                    .set("id", format!("{prefix}:{block_id}:{}", str_at(block, "type")))
                    .set("kind", if step.is_some() { "tool" } else { "message" })
                    .set("text", text.clone())
                    .opt("tool", step.as_ref().and_then(|s| s.get("kind")).cloned())
                    .build();
                events.push_result(self.update(
                    parent,
                    json!({"latestActivity":if step.is_some(){text}else{json!("Responding")}}),
                    Some(row),
                    now,
                ));
            }
        }
        if message["type"] == "user" {
            for block in content.into_iter().flatten().filter(|b| b["type"] == "tool_result") {
                if events.failed() {
                    break;
                }
                let id = str_at(block, "tool_use_id");
                if self.agents.contains_key(&id) {
                    if parent.is_none() {
                        self.foreground.remove(&id);
                        events.push(json!({"type":"subagents-waiting","waiting":!self.foreground.is_empty()}));
                    }
                    if message["tool_use_result"]["status"] != "async_launched" {
                        events.push_result(self.update(
                            &id,
                            json!({"status":if truthy(&block["is_error"]){"failed"}else{"completed"},"latestActivity":"Finished"}),
                            Some(json!({"id":"result","kind":"message","text":text_content(&block["content"])})),
                            now,
                        ));
                    }
                }
                if let Some(parent) = parent.filter(|p| self.agents.contains_key(*p)) {
                    if let Some((agent, call)) = self.calls.remove(&id) {
                        let structured = (content.unwrap().iter().filter(|b| b["type"] == "tool_result").count() == 1)
                            .then(|| message.get("tool_use_result"))
                            .flatten();
                        if let Some(tasks) = self.tasks.entry(agent.clone()).or_default().apply_tool_result(&call, block, structured) {
                            events.push_result(self.update(&agent, json!({"tasks":tasks}), None, now));
                        }
                    } else if !self.results.remove(&id) {
                        events.push_result(self.update(
                            parent,
                            json!({}),
                            Some(json!({"id":format!("result:{id}"),"kind":"tool","text":text_content(&block["content"])})),
                            now,
                        ));
                    }
                }
            }
        }
        if message["type"] == "system" && message["subtype"] == "background_tasks_changed" {
            if let Some(tasks) = message["tasks"].as_array() {
                events.extend(self.background_tasks(tasks, now));
            }
        }
        let subtype = message["subtype"].as_str().unwrap_or_default();
        if message["type"] == "system" && subtype.starts_with("task_") {
            let task = str_at(message, "task_id");
            let id = self.task_agents.get(&task).cloned().or_else(|| message.get("tool_use_id").filter(|v| !v.is_null()).map(js_string));
            if !id.as_ref().is_some_and(|id| self.agents.contains_key(id))
                && !(subtype == "task_started" && (message["task_type"] == "local_agent" || truthy(&message["subagent_type"])))
            {
                return events.finish();
            }
            let id = id.unwrap_or(task.clone());
            self.task_agents.insert(task, id.clone());
            let mut patch = Map::new();
            for (source, target) in [("description", "title"), ("prompt", "prompt"), ("subagent_type", "agentType")] {
                if truthy(&message[source]) {
                    patch.insert(target.into(), message[source].clone());
                }
            }
            if subtype == "task_started" {
                patch.insert("status".into(), json!("running"));
            }
            if subtype == "task_progress" {
                if let Some(v) = ["summary", "last_tool_name", "description"].iter().find_map(|k| message.get(k).filter(|v| truthy(v))) {
                    patch.insert("latestActivity".into(), v.clone());
                }
            }
            if subtype == "task_notification" {
                let status = match message["status"].as_str() {
                    Some("completed") => "completed",
                    Some("failed") => "failed",
                    Some("stopped") => "cancelled",
                    _ => "unknown",
                };
                patch.insert("status".into(), json!(status));
                if let Some(summary) = message.get("summary") {
                    patch.insert("latestActivity".into(), summary.clone());
                }
            }
            if subtype == "task_updated" {
                let change = &message["patch"];
                if truthy(&change["is_backgrounded"]) && !self.agents.get(&id).is_some_and(|a| truthy(&a["parentId"])) {
                    patch.insert("background".into(), true.into());
                }
                if truthy(&change["status"]) {
                    let status = match change["status"].as_str() {
                        Some("pending") => "initializing",
                        Some("running") => "running",
                        Some("completed") => "completed",
                        Some("failed") => "failed",
                        Some("killed") => "cancelled",
                        Some("paused") => "waiting",
                        _ => "unknown",
                    };
                    patch.insert("status".into(), json!(status));
                }
                if truthy(&change["description"]) {
                    patch.insert("title".into(), change["description"].clone());
                }
            }
            let row = truthy(&message["summary"]).then(|| json!({"id":"summary","kind":"message","text":message["summary"]}));
            events.push_result(self.update(&id, Value::Object(patch), row, now));
        }
        if self.calls.len() + self.results.len() + self.task_agents.len() > self.max_agents.saturating_mul(16) {
            events.fail(self.fail());
        }
        events.finish()
    }
}

#[cfg(test)]
mod budget_tests {
    use super::*;
    #[test]
    fn oversized_unicode_display_and_task_payloads_stay_bounded() {
        let mut agents = Subagents::default();
        agents.set_limits(Default::default(), 128, 4096);
        for i in 0..20 {
            let event = agents
                .update(
                    "a",
                    json!({"background":true,"title":"😀".repeat(10000),"prompt":"界".repeat(10000),"tasks":[{"content":"x".repeat(10000)}]}),
                    Some(json!({"id":format!("r{i}"),"kind":"tool","text":"😀".repeat(10000)})),
                    i,
                )
                .unwrap();
            assert!(crate::budget::weight(&event["agent"]) <= 4096);
            assert_eq!(event["agent"]["truncated"], true);
            assert_eq!(event["agent"]["status"], "running");
            assert_eq!(event["agent"]["background"], true);
        }
        assert!(!agents.failed);
        assert!(!agents.tasks.contains_key("a"));
        agents.settle_bounded("cancelled", 21, true).unwrap();
        assert!(crate::budget::weight(&agents.agents["a"]) <= 4096);
    }
    #[test]
    fn compact_settlement_merges_to_the_same_child_state() {
        let mut agents = Subagents::default();
        let initial = agents
            .update(
                "a",
                json!({"title":"Review","background":true,"prompt":"Check"}),
                Some(json!({"id":"r1","kind":"tool","text":"result"})),
                1,
            )
            .unwrap();
        let full = agents.clone().settle_bounded("cancelled", 2, false).unwrap();
        let compact = agents.settle_bounded("cancelled", 2, true).unwrap();
        let mut merged = initial["agent"].clone();
        // Node merges rows by id; an empty update leaves existing transcript rows intact.
        for (key, value) in compact[0]["agent"].as_object().unwrap() {
            if key != "transcript" {
                merged[key] = value.clone();
            }
        }
        assert_eq!(merged, full[0]["agent"]);
        assert_eq!(compact[0]["agent"]["background"], true);
        assert!(agents.settle_bounded("cancelled", 3, true).unwrap().is_empty());
    }
}

//! Pure `acp-events.cjs` mapping. No transport, profile, media writes or permission decisions.
//! State snapshots encode Node Maps as ordered `[key,value]` pairs and Sets as ordered arrays.
//! The caller supplies the clock explicitly and owns turn resets, filtering and state budgets.
use crate::events_js as js;
use serde_json::{json, Map, Value};

#[derive(Debug, Clone, Default)]
pub struct AcpEventState {
    fields: Map<String, Value>,
}
impl AcpEventState {
    pub fn new(turn_id: Value) -> Self {
        Self::from_snapshot(json!({"turnId":turn_id,"hasText":false,"textBreak":false,"steps":[],"calls":[],"editDiffs":[]})).unwrap()
    }
    pub fn from_snapshot(value: Value) -> Result<Self, &'static str> {
        let Value::Object(fields) = value else {
            return Err("ACP mapper state must be an object");
        };
        for key in ["calls", "editDiffs"] {
            if let Some(v) = fields.get(key).filter(|v| !v.is_null()) {
                let rows = v.as_array().ok_or("ACP map snapshot must be an array")?;
                let mut seen = std::collections::HashSet::new();
                for row in rows {
                    let pair = row.as_array().filter(|v| v.len() == 2).ok_or("ACP map entries must be pairs")?;
                    let key = pair[0].as_str().ok_or("ACP map keys must be strings")?;
                    if !seen.insert(key) {
                        return Err("Duplicate ACP map key");
                    }
                }
            }
        }
        if let Some(v) = fields.get("steps").filter(|v| !v.is_null()) {
            let rows = v.as_array().ok_or("ACP set snapshot must be an array")?;
            let mut seen = std::collections::HashSet::new();
            for row in rows {
                let key = row.as_str().ok_or("ACP set IDs must be strings")?;
                if !seen.insert(key) {
                    return Err("Duplicate ACP set ID");
                }
            }
        }
        if let Some(thinking) = fields.get("thinking").filter(|v| !v.is_null()) {
            if !thinking.is_object() || !thinking["id"].is_string() || !thinking["text"].is_string() || !thinking["startedAt"].is_number() {
                return Err("ACP thinking snapshot requires id, text and numeric startedAt");
            }
        }
        Ok(Self { fields })
    }
    pub fn snapshot(&self) -> Value {
        Value::Object(self.fields.clone())
    }
    fn get(&self, key: &str) -> Option<&Value> {
        self.fields.get(key)
    }
    fn put(&mut self, key: &str, value: Value) {
        self.fields.insert(key.into(), value);
    }
    fn array(&mut self, key: &str) -> &mut Vec<Value> {
        if self.fields.get(key).is_none_or(Value::is_null) {
            self.put(key, json!([]));
        }
        self.fields.get_mut(key).unwrap().as_array_mut().expect("validated state array")
    }
    fn map_get(&self, key: &str, id: &str) -> Option<&Value> {
        self.get(key)?.as_array()?.iter().find(|v| v[0] == id).map(|v| &v[1])
    }
    fn map_set(&mut self, key: &str, id: &str, value: Value) {
        let rows = self.array(key);
        if let Some(row) = rows.iter_mut().find(|v| v[0] == id) {
            row[1] = value;
        } else {
            rows.push(json!([id, value]));
        }
    }
    fn map_remove(&mut self, key: &str, id: &str) {
        self.array(key).retain(|v| v[0] != id);
    }
}
fn first<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter().find_map(|key| v.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()))
}
pub fn command_of(call: &Value) -> String {
    first(&call["rawInput"], &["CommandLine", "command_line", "commandLine", "command", "cmd"])
        .or_else(|| first(&call["rawOutput"], &["CommandLine", "command_line", "commandLine", "command", "cmd"]))
        .unwrap_or_else(|| if call["kind"] == "execute" { js::text(call.get("title")) } else { "" })
        .into()
}
pub fn cwd_of(call: &Value) -> Option<String> {
    first(&call["rawInput"], &["Cwd", "WorkingDirectory", "working_dir", "workingDir", "cwd"])
        .or_else(|| first(&call["rawOutput"], &["Cwd", "WorkingDirectory", "working_dir", "workingDir", "cwd"]))
        .map(str::to_owned)
}
pub fn diffs_of(call: &Value) -> Vec<Value> {
    call["content"].as_array().into_iter().flatten().filter(|v| v["type"] == "diff" && v["path"].is_string()).cloned().collect()
}
pub fn file_of(call: &Value) -> Option<String> {
    call["locations"]
        .as_array()
        .into_iter()
        .flatten()
        .find_map(|v| v["path"].as_str())
        .map(str::to_owned)
        .or_else(|| diffs_of(call).first().and_then(|d| d["path"].as_str()).map(str::to_owned))
        .or_else(|| {
            first(&call["rawInput"], &["AbsolutePath", "TargetFile", "file_path", "filePath", "path", "File", "file"]).map(str::to_owned)
        })
}
pub fn creates_file(diff: Option<&Value>) -> bool {
    js::truthy(diff)
        && (diff.unwrap().pointer("/_meta/kind") == Some(&json!("add")) || diff.unwrap().get("oldText").is_none_or(Value::is_null))
}
pub fn is_question_call(id: Option<&Value>) -> bool {
    js::string(id.filter(|v| !v.is_null()).or(Some(&json!("")))).starts_with("interaction_")
}
fn normalize(s: &str) -> String {
    s.replace("\r\n", "\n")
}
fn split_lines(v: Option<&Value>) -> Vec<String> {
    let s = normalize(js::text(v));
    let mut lines: Vec<_> = s.split('\n').map(str::to_owned).collect();
    if lines.last().is_some_and(|s| s.is_empty()) {
        lines.pop();
    }
    lines
}
pub fn acp_diff(diff: &Value) -> String {
    let before = if diff.get("oldText").is_none_or(Value::is_null) { vec![] } else { split_lines(diff.get("oldText")) };
    let after = split_lines(diff.get("newText"));
    let mut start = 0;
    while start < before.len() && start < after.len() && before[start] == after[start] {
        start += 1;
    }
    let mut end = 0;
    while end < before.len() - start && end < after.len() - start && before[before.len() - 1 - end] == after[after.len() - 1 - end] {
        end += 1;
    }
    let removed = &before[start..before.len() - end];
    let added = &after[start..after.len() - end];
    let file = js::string(diff.get("path"));
    let mut lines = vec![
        format!("--- {file}"),
        format!("+++ {file}"),
        format!(
            "@@ -{},{} +{},{} @@",
            start + usize::from(!removed.is_empty()),
            removed.len(),
            start + usize::from(!added.is_empty()),
            added.len()
        ),
    ];
    lines.extend(removed.iter().map(|s| format!("-{s}")));
    lines.extend(added.iter().map(|s| format!("+{s}")));
    lines.join("\n")
}
pub fn acp_diff_text(diffs: &[Value]) -> Option<String> {
    (!diffs.is_empty()).then(|| js::cap_text(&diffs.iter().map(acp_diff).collect::<Vec<_>>().join("\n")))
}
fn tool_name(call: &Value) -> String {
    let title = js::trim(js::text(call.get("title")));
    for prefix in ["Running", "Run"] {
        if let Some(rest) = title.strip_prefix(prefix) {
            if rest.chars().next().is_some_and(js::whitespace) {
                let name =
                    rest.trim_start_matches(js::whitespace).strip_suffix('?').unwrap_or_else(|| rest.trim_start_matches(js::whitespace));
                if !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || "_.:-".contains(c)) {
                    return name.into();
                }
            }
        }
    }
    title.into()
}
pub fn acp_step(call: &Value, diffs: Option<&[Value]>) -> Value {
    let own = diffs_of(call);
    let diffs = diffs.unwrap_or(&own);
    let file = file_of(call);
    let kind = call["kind"].as_str().unwrap_or("");
    let mut step = json!({"id":js::string(call.get("toolCallId"))});
    let mut detail = None;
    let mut step_file = None;
    let (kind, title) = match kind {
        "execute" => {
            let command = command_of(call);
            detail = Some(js::cap_output(&format!("$ {command}\n")));
            ("shell", if command.is_empty() { "Ran a command".into() } else { format!("Ran {}", js::code(&command)) })
        }
        "read" => {
            step_file = file.clone();
            (
                "read",
                if let Some(file) = file.as_ref().filter(|s| !s.is_empty()) {
                    format!("Read {}", js::code(js::basename(file)))
                } else {
                    let title = js::text(call.get("title"));
                    if title.is_empty() {
                        "Read a file".into()
                    } else {
                        title.into()
                    }
                },
            )
        }
        "edit" | "delete" | "move" => {
            step_file = file.clone();
            let verb = if kind == "delete" {
                "Deleted"
            } else if kind == "move" {
                "Moved"
            } else if creates_file(diffs.first()) {
                "Created"
            } else if diffs.first().and_then(|v| v.pointer("/_meta/kind")).is_some_and(|v| v == "delete") {
                "Deleted"
            } else {
                "Edited"
            };
            (
                "edit",
                format!("{verb} {}", file.as_ref().filter(|s| !s.is_empty()).map(|s| js::code(js::basename(s))).unwrap_or("a file".into())),
            )
        }
        "search" => (
            "search",
            first(&call["rawInput"], &["Query", "query", "pattern", "Pattern"])
                .map(|q| format!("Searched for {}", js::code(q)))
                .unwrap_or_else(|| {
                    let title = js::text(call.get("title"));
                    if title.is_empty() {
                        "Searched".into()
                    } else {
                        title.into()
                    }
                }),
        ),
        "fetch" => (
            "other",
            first(&call["rawInput"], &["Url", "url", "URL"]).map(|q| format!("Fetched {}", js::code(q))).unwrap_or_else(|| {
                let title = js::text(call.get("title"));
                if title.is_empty() {
                    "Fetched a page".into()
                } else {
                    title.into()
                }
            }),
        ),
        _ => {
            let name = tool_name(call);
            (
                "other",
                if name.is_empty() {
                    "Used a tool".into()
                } else if !js::truthy(call.pointer("/_meta/is_mcp_tool_call")) && name.chars().any(js::whitespace) {
                    name
                } else {
                    format!("Used {}", js::code(&name))
                },
            )
        }
    };
    step["kind"] = kind.into();
    step["title"] = title.into();
    if let Some(v) = detail {
        step["detail"] = v.into();
    }
    if let Some(v) = step_file {
        step["file"] = v.into();
    }
    if let Some(mcp) = call.pointer("/_meta/mcp") {
        if js::truthy(mcp.get("server")) && js::truthy(mcp.get("tool")) {
            step.as_object_mut().unwrap().extend(js::metadata(&mcp["server"], &mcp["tool"], call.get("rawInput")));
        }
    }
    step
}
fn raw_text(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(v) => {
            first(v, &["combinedOutput", "combined_output", "output", "stdout"]).map(str::to_owned).unwrap_or_else(|| js::pretty(v, false))
        }
    }
}
fn content_text(v: &Value) -> String {
    v.as_array()
        .into_iter()
        .flatten()
        .filter(|v| v["type"] == "content" && v["content"]["type"] == "text")
        .filter_map(|v| v["content"].get("text"))
        .filter(|v| js::truthy(Some(v)))
        .map(|v| js::string(Some(v)))
        .collect::<Vec<_>>()
        .join("\n")
}
pub fn acp_step_result(call: &Value, diffs: Option<&[Value]>) -> Value {
    let own = diffs_of(call);
    let diffs = diffs.unwrap_or(&own);
    let code = call["rawOutput"].get("exitCode").filter(|v| !v.is_null()).or_else(|| call["rawOutput"].get("exit_code"));
    let failed = call["status"] == "failed" || code.is_some_and(|v| v.is_number() && js::numeric(Some(v)) != 0.0);
    let status = if failed { "failed" } else { "done" };
    let output = content_text(&call["content"]);
    let output = normalize(&if output.is_empty() { raw_text(call.get("rawOutput")) } else { output });
    let mut end = json!({"id":js::string(call.get("toolCallId")),"status":status});
    if call["kind"] == "execute" {
        end["detail"] = js::cap_output(&format!("$ {}\n{output}", command_of(call))).into();
        return end;
    }
    if failed {
        if !output.is_empty() {
            end["detail"] = js::cap_text(&output).into();
        }
        return end;
    }
    if call["kind"] == "read" {
        return end;
    }
    if matches!(call["kind"].as_str(), Some("edit" | "delete" | "move")) {
        end["title"] = acp_step(call, Some(diffs))["title"].clone();
        if let Some(diff) = acp_diff_text(diffs) {
            end["detail"] = diff.into();
        }
        return end;
    }
    let mcp = call.pointer("/_meta/mcp");
    let heartbeat = if mcp.is_some_and(|v| v.is_object() || v.is_array()) {
        mcp.unwrap()["server"] == "milagre" && mcp.unwrap()["tool"] == "heartbeat_create"
    } else {
        tool_name(call) == "milagre_heartbeat_create"
    };
    if heartbeat {
        let (first, rest) = output.split_once('\n').unwrap_or((&output, ""));
        if let Ok(parsed) = serde_json::from_str::<Value>(first) {
            if let (Some(id), Some(name)) = (parsed["routine"]["id"].as_str().filter(|s| !s.is_empty()), parsed["routine"]["name"].as_str())
            {
                end["routine"] = json!({"id":id,"name":name});
                let detail = js::trim(rest);
                if !detail.is_empty() {
                    end["detail"] = js::cap_text(detail).into();
                }
                return end;
            }
        }
    }
    if !output.is_empty() {
        end["detail"] = js::cap_text(&output).into();
    }
    end
}
pub fn close_thinking(state: &mut AcpEventState, now_ms: i64) -> Vec<Value> {
    let Some(thinking) = state.get("thinking").filter(|v| js::truthy(Some(v))).cloned() else { return vec![] };
    state.put("thinking", Value::Null);
    let duration = now_ms as f64 - js::numeric(thinking.get("startedAt"));
    let seconds = (duration / 1000.0 + 0.5).floor().max(1.0);
    let label = if duration.is_nan() {
        "NaNm NaNs".into()
    } else if seconds < 60.0 {
        format!("{}s", js::number(seconds))
    } else {
        format!("{}m {}s", js::number((seconds / 60.0).floor()), js::number(seconds % 60.0))
    };
    let mut event = json!({"type":"step-completed","id":js::string(thinking.get("id")),"status":"done","title":format!("Thought for {label}"),"durationMs":js::json_number(duration)});
    if js::truthy(thinking.get("text")) {
        event["detail"] = js::cap_text(js::text(thinking.get("text"))).into();
    }
    vec![event]
}
pub fn read_config_options(options: &Value, state: &mut AcpEventState) {
    let Some(options) = options.as_array() else { return };
    for option in options {
        if option["id"] == "model" || option["category"] == "model" {
            if option["currentValue"].is_string() {
                state.put("model", option["currentValue"].clone());
            }
            if let Some(items) = option["options"].as_array() {
                state.put("models", Value::Array(items.iter().filter(|v| v["value"].is_string()).cloned().collect()));
            }
        }
        if (option["id"] == "mode" || option["category"] == "mode") && option["currentValue"].is_string() {
            state.put("mode", option["currentValue"].clone());
        }
        if option["id"] == "autopilot" && option["currentValue"].is_string() {
            state.put("autopilot", option["currentValue"].clone());
        }
    }
    if options.iter().any(|v| v["id"] == "model") {
        if let Some(value) = options.iter().find(|v| v["id"] == "effortLevel").and_then(|v| v.get("currentValue")) {
            state.put("effortLevel", value.clone());
        } else {
            state.fields.remove("effortLevel");
        }
    }
}
pub fn stop_reason_event(reason: &Value, name: &str) -> Value {
    match reason.as_str() {
        Some("cancelled") => json!({"type":"turn-cancelled"}),
        Some("max_tokens") => json!({"type":"turn-failed","message":format!("{name} stopped: the reply reached its length limit.")}),
        Some("max_turn_requests") => {
            json!({"type":"turn-failed","message":format!("{name} stopped: the turn reached its limit of model requests.")})
        }
        Some("refusal") => json!({"type":"turn-failed","message":format!("{name} declined to continue this turn.")}),
        _ => json!({"type":"turn-completed"}),
    }
}
pub fn map_acp_update(update: &Value, state: &mut AcpEventState, now_ms: i64) -> Vec<Value> {
    match update["sessionUpdate"].as_str() {
        Some("agent_message_chunk") => {
            let value = if update["content"]["type"] == "text" { js::text(update["content"].get("text")) } else { "" };
            if value.is_empty() {
                return vec![];
            }
            let mut events = close_thinking(state, now_ms);
            let mut emit = |text: &str, starts: bool| {
                let mut event = json!({"type":"text-delta","text":text});
                if let Some(id) = state.get("turnId") {
                    event["messageId"] = id.clone();
                }
                if starts {
                    event["startsMessage"] = true.into();
                }
                events.push(event);
            };
            if js::truthy(state.get("hasText")) && js::truthy(state.get("textBreak")) {
                emit("\n\n", true);
            }
            emit(value, false);
            state.put("textBreak", false.into());
            state.put("hasText", true.into());
            events
        }
        Some("agent_thought_chunk") => {
            let value = if update["content"]["type"] == "text" { js::text(update["content"].get("text")) } else { "" };
            if value.is_empty() {
                return vec![];
            }
            let mut events = vec![];
            if !js::truthy(state.get("thinking")) {
                let count = match state.get("thinkingCount").filter(|v| !v.is_null()) {
                    Some(Value::String(s)) => json!(format!("{s}1")),
                    v => js::json_number(js::numeric(v.or(Some(&json!(0)))) + 1.0),
                };
                let id = format!("thinking-{}", js::string(Some(&count)));
                state.put("thinkingCount", count);
                state.put("thinking", json!({"id":id,"text":"","startedAt":now_ms}));
                state.put("textBreak", true.into());
                events.push(json!({"type":"step-started","step":{"id":id,"kind":"thinking","title":"Thinking"}}));
            }
            let thinking = state.fields.get_mut("thinking").unwrap();
            let mut text = js::string(thinking.get("text"));
            text.push_str(value);
            thinking["text"] = text.into();
            events.push(json!({"type":"step-output","id":thinking["id"],"text":value}));
            events
        }
        Some("tool_call" | "tool_call_update") => tool_events(update, state, now_ms),
        Some("plan") => {
            let Some(entries) = update["entries"].as_array() else { return vec![] };
            let tasks: Vec<_> = entries
                .iter()
                .enumerate()
                .filter_map(|(i, v)| {
                    let content = js::trim(js::text(v.get("content")));
                    if content.is_empty() {
                        None
                    } else {
                        let status =
                            v["status"].as_str().filter(|s| ["pending", "in_progress", "completed"].contains(s)).unwrap_or("pending");
                        Some(json!({"id":i.to_string(),"content":content,"status":status}))
                    }
                })
                .collect();
            vec![json!({"type":"tasks-updated","tasks":tasks})]
        }
        Some("usage_update") => {
            if update["used"].is_number() && js::numeric(update.get("size")) > 0.0 {
                vec![json!({"type":"context-usage","used":update["used"],"size":update["size"]})]
            } else {
                vec![]
            }
        }
        Some("current_mode_update") => {
            if update["currentModeId"].is_string() {
                state.put("mode", update["currentModeId"].clone());
            }
            vec![]
        }
        Some("config_option_update") => {
            read_config_options(&update["configOptions"], state);
            vec![]
        }
        Some("session_info_update") => {
            if update.pointer("/_meta/kiro/kind") == Some(&json!("turn_completion")) {
                let credits: Vec<_> = update
                    .pointer("/_meta/kiro/promptTurnSummaries")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter(|v| v["unit"] == "credit" && v["usage"].is_number() && js::numeric(v.get("usage")).is_finite())
                    .collect();
                if !credits.is_empty() {
                    state.put("turnCredits", js::json_number(credits.iter().map(|v| js::numeric(v.get("usage"))).sum()));
                }
            }
            vec![]
        }
        _ => vec![],
    }
}
fn tool_events(update: &Value, state: &mut AcpEventState, now_ms: i64) -> Vec<Value> {
    let id = js::string(update.get("toolCallId").filter(|v| !v.is_null()).or(Some(&json!(""))));
    if id.is_empty() || id.starts_with("interaction_") {
        return vec![];
    }
    for key in ["calls", "steps", "editDiffs"] {
        state.array(key);
    }
    let previous = state.map_get("calls", &id).cloned().unwrap_or(json!({}));
    let mut call = js::entries(&previous);
    for (key, value) in js::entries(update) {
        if key != "sessionUpdate" {
            call.insert(key, value);
        }
    }
    if js::truthy(update.get("rawInput")) && js::truthy(previous.get("rawInput")) {
        let mut input = js::entries(&previous["rawInput"]);
        input.extend(js::entries(&update["rawInput"]));
        call.insert("rawInput".into(), Value::Object(input));
    }
    let call = Value::Object(call);
    state.map_set("calls", &id, call.clone());
    let status = call.get("status").filter(|v| !v.is_null()).cloned().unwrap_or(json!("in_progress"));
    let own = diffs_of(&call);
    if status == "pending" {
        for diff in &own {
            let path = diff["path"].as_str().unwrap();
            state.map_set("editDiffs", path, Value::Array(own.iter().filter(|v| v["path"] == path).cloned().collect()));
        }
        return vec![];
    }
    let file = file_of(&call);
    let diffs = if !own.is_empty() {
        own.clone()
    } else {
        file.as_ref()
            .filter(|s| !s.is_empty())
            .and_then(|f| state.map_get("editDiffs", f))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    let mut events = close_thinking(state, now_ms);
    state.put("textBreak", true.into());
    let started = state.array("steps").iter().any(|v| v == &id);
    if status == "completed" || status == "failed" {
        state.map_remove("calls", &id);
        if let Some(file) = file.as_ref().filter(|s| !s.is_empty() && own.is_empty()) {
            state.map_remove("editDiffs", file);
        }
        if !started && status == "failed" && raw_text(call.get("rawOutput")).to_ascii_lowercase().contains("approved but never executed") {
            return vec![];
        }
        if started {
            state.array("steps").retain(|v| v != &id);
        } else {
            events.push(json!({"type":"step-started","step":acp_step(&call,Some(&diffs))}));
        }
        let mut end = json!({"type":"step-completed"});
        end.as_object_mut().unwrap().extend(acp_step_result(&call, Some(&diffs)).as_object().unwrap().clone());
        events.push(end);
    } else if !started {
        state.array("steps").push(id.into());
        events.push(json!({"type":"step-started","step":acp_step(&call,Some(&diffs))}));
    }
    events
}

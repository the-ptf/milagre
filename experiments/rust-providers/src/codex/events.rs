//! codex app-server notifications -> Milagre agent events (the `AgentEvent` contract in
//! @milagre/shared/model). Port of `mapCodexNotification` and the Codex messages in
//! packages/core/src/agents/events.cjs. Events are JSON with the same fields as Node, e.g.
//! `{ type: "text-delta", messageId, text, startsMessage? }`, `{ type: "step-started", step }`,
//! `{ type: "step-completed", id, status, … }`, `{ type: "context-usage", used, size }`,
//! `{ type: "turn-failed", message, notice?, login?, limit? }`, `{ type: "subagent-update", agent }`.
//!
//! Exactly one terminal event (`turn-completed`, `turn-failed`, `turn-cancelled`) ends a turn;
//! [`is_terminal`] tells them apart.

use crate::codex::js::{iso_from_millis, js_string, slice_utf16_start, strict_eq, truthy, utf16_len};
use crate::codex::steps::{codex_step, codex_step_result, number, thinking_end, thinking_step};
use crate::codex::subagents::{codex_plan_tasks, codex_subagents};
use indexmap::{IndexMap, IndexSet};
use serde_json::{json, Map, Value};

pub const RESUME_FAILED_MESSAGE: &str =
    "Couldn't resume this chat's earlier agent session; it may have been deleted. Send your message again to continue in a fresh session.";

/// The mapper's state for one session: what events.cjs keeps on `CodexSession.state`.
pub struct CodexEventState {
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub last_item_id: Option<Value>,
    pub has_text: bool,
    /// Tool and thinking steps started and not yet completed.
    pub steps: IndexSet<String>,
    pub thinking_starts: IndexMap<String, f64>,
    pub compactions: IndexMap<String, String>,
    pub async_messages: Vec<Value>,
    pub rate_limits: Option<Value>,
    /// From `account/read`: a 401 means "log in" only where OpenAI auth is required.
    pub requires_openai_auth: Option<bool>,
    /// Subagents by thread id, as `subagent-update` agent objects.
    pub subagents: IndexMap<String, Value>,
    pub subagent_activity_ids: IndexSet<String>,
    pub subagent_recheck_until: IndexMap<String, i64>,
    pub background_task_starts: IndexMap<String, i64>,
    pub background_tasks_key: Option<String>,
    clock: Box<dyn FnMut() -> i64 + Send>,
}

impl Default for CodexEventState {
    fn default() -> Self {
        CodexEventState {
            thread_id: None,
            turn_id: None,
            last_item_id: None,
            has_text: false,
            steps: IndexSet::new(),
            thinking_starts: IndexMap::new(),
            compactions: IndexMap::new(),
            async_messages: Vec::new(),
            rate_limits: None,
            requires_openai_auth: None,
            subagents: IndexMap::new(),
            subagent_activity_ids: IndexSet::new(),
            subagent_recheck_until: IndexMap::new(),
            background_task_starts: IndexMap::new(),
            background_tasks_key: None,
            clock: Box::new(system_millis),
        }
    }
}

pub fn system_millis() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

impl CodexEventState {
    pub fn new(thread_id: Option<String>) -> Self {
        CodexEventState { thread_id, ..Default::default() }
    }

    /// Replaces the clock (milliseconds since the epoch), for tests and replays.
    pub fn set_clock(&mut self, clock: impl FnMut() -> i64 + Send + 'static) {
        self.clock = Box::new(clock);
    }

    pub fn now(&mut self) -> i64 {
        (self.clock)()
    }

    /// Clears what a turn leaves behind (codex-provider.cjs `finishTurn`): steps still open never
    /// complete, and thinking starts are forgotten.
    pub fn end_turn(&mut self) {
        self.steps.clear();
        self.thinking_starts.clear();
    }

    /// State for a new turn (codex-provider.cjs `startTurn`).
    pub fn start_turn(&mut self) {
        self.turn_id = None;
        self.last_item_id = None;
        self.has_text = false;
        self.async_messages.clear();
    }

    /// Whether any subagent is marked for a recheck after an interaction (until a time in the future).
    pub fn recheck_pending(&mut self) -> bool {
        let now = self.now();
        self.subagent_recheck_until.values().any(|until| *until > now)
    }

    /// The tagged-JSON form used by the conformance fixtures (`{ $map: [[k, v]] }`, `{ $set: [...] }`).
    pub fn to_snapshot(&self) -> Value {
        let mut map = Map::new();
        let opt = |v: &Option<String>| v.clone().map(Value::from).unwrap_or(Value::Null);
        map.insert("threadId".into(), opt(&self.thread_id));
        map.insert("turnId".into(), opt(&self.turn_id));
        map.insert("lastItemId".into(), self.last_item_id.clone().unwrap_or(Value::Null));
        map.insert("hasText".into(), self.has_text.into());
        map.insert("steps".into(), set(self.steps.iter().cloned().map(Value::from)));
        map.insert("thinkingStarts".into(), tagged_map(self.thinking_starts.iter().map(|(k, v)| (k.clone(), number(*v)))));
        map.insert("compactions".into(), tagged_map(self.compactions.iter().map(|(k, v)| (k.clone(), v.clone().into()))));
        map.insert("asyncMessages".into(), set(self.async_messages.iter().cloned()));
        if let Some(limits) = &self.rate_limits {
            map.insert("rateLimits".into(), limits.clone());
        }
        if let Some(required) = self.requires_openai_auth {
            map.insert("requiresOpenaiAuth".into(), required.into());
        }
        map.insert("subagents".into(), tagged_map(self.subagents.iter().map(|(k, v)| (k.clone(), v.clone()))));
        map.insert("subagentActivityIds".into(), set(self.subagent_activity_ids.iter().cloned().map(Value::from)));
        map.insert("subagentRecheckUntil".into(), tagged_map(self.subagent_recheck_until.iter().map(|(k, v)| (k.clone(), (*v).into()))));
        map.insert("backgroundTaskStarts".into(), tagged_map(self.background_task_starts.iter().map(|(k, v)| (k.clone(), (*v).into()))));
        if let Some(key) = &self.background_tasks_key {
            map.insert("backgroundTasksKey".into(), key.clone().into());
        }
        Value::Object(map)
    }

    /// Reads [`CodexEventState::to_snapshot`]'s form (missing fields are empty).
    pub fn from_snapshot(snapshot: &Value) -> Self {
        let text = |key: &str| snapshot.get(key).and_then(Value::as_str).map(str::to_string);
        let entries = |key: &str| -> Vec<(String, Value)> {
            snapshot
                .get(key)
                .and_then(|m| m.get("$map"))
                .and_then(Value::as_array)
                .map(|pairs| {
                    pairs
                        .iter()
                        .filter_map(|pair| Some((js_string(Some(pair.get(0)?)), pair.get(1).cloned().unwrap_or(Value::Null))))
                        .collect()
                })
                .unwrap_or_default()
        };
        let members = |key: &str| -> Vec<Value> {
            snapshot.get(key).and_then(|s| s.get("$set")).and_then(Value::as_array).cloned().unwrap_or_default()
        };
        CodexEventState {
            thread_id: text("threadId"),
            turn_id: text("turnId"),
            last_item_id: snapshot.get("lastItemId").filter(|v| !v.is_null()).cloned(),
            has_text: snapshot.get("hasText") == Some(&Value::Bool(true)),
            steps: members("steps").iter().map(|v| js_string(Some(v))).collect(),
            thinking_starts: entries("thinkingStarts").into_iter().map(|(k, v)| (k, v.as_f64().unwrap_or(0.0))).collect(),
            compactions: entries("compactions").into_iter().map(|(k, v)| (k, js_string(Some(&v)))).collect(),
            async_messages: members("asyncMessages"),
            rate_limits: snapshot.get("rateLimits").cloned(),
            requires_openai_auth: snapshot.get("requiresOpenaiAuth").and_then(Value::as_bool),
            subagents: entries("subagents").into_iter().collect(),
            subagent_activity_ids: members("subagentActivityIds").iter().map(|v| js_string(Some(v))).collect(),
            subagent_recheck_until: entries("subagentRecheckUntil").into_iter().map(|(k, v)| (k, v.as_i64().unwrap_or(0))).collect(),
            background_task_starts: entries("backgroundTaskStarts").into_iter().map(|(k, v)| (k, v.as_i64().unwrap_or(0))).collect(),
            background_tasks_key: text("backgroundTasksKey"),
            clock: Box::new(system_millis),
        }
    }
}

fn set(values: impl Iterator<Item = Value>) -> Value {
    json!({ "$set": values.collect::<Vec<_>>() })
}

fn tagged_map(entries: impl Iterator<Item = (String, Value)>) -> Value {
    json!({ "$map": entries.map(|(k, v)| json!([k, v])).collect::<Vec<_>>() })
}

/// `isTurnEnd`: the events that end a turn.
pub fn is_terminal(event: &Value) -> bool {
    matches!(event.get("type").and_then(Value::as_str), Some("turn-completed" | "turn-failed" | "turn-cancelled"))
}

/// A turn failure made of one of Milagre's own messages (`notice: true`), with extra fields.
pub fn failed_with(message: &str, extra: &[(&str, Value)]) -> Value {
    let mut map = Map::new();
    map.insert("type".into(), "turn-failed".into());
    map.insert("message".into(), message.into());
    map.insert("notice".into(), true.into());
    for (key, value) in extra {
        map.insert(key.to_string(), value.clone());
    }
    Value::Object(map)
}

pub fn login_message() -> String {
    "Codex isn't logged in. Run `codex login` in a terminal, then send your message again.".into()
}

pub fn missing_cli_message() -> String {
    let install = if cfg!(windows) {
        "irm https://chatgpt.com/codex/install.ps1 | iex"
    } else {
        "curl -fsSL https://chatgpt.com/codex/install.sh | sh"
    };
    format!("Milagre couldn't find Codex. Install it with `{install}`, then send your message again.")
}

/// events.cjs `readLastLine`: the last non-empty line without ANSI colours and a log line's prefix.
pub fn read_last_line(text: &str) -> (String, bool) {
    let stripped = strip_ansi(text);
    let raw = stripped.split('\n').map(str::trim).rfind(|l| !l.is_empty()).unwrap_or("").to_string();
    let (line, logged) = match log_prefix_len(&raw) {
        Some(len) => (raw[len..].to_string(), true),
        None => (raw, false),
    };
    let line = if utf16_len(&line) > 300 { format!("{}…", slice_utf16_start(&line, 299)) } else { line };
    (line, logged)
}

fn strip_ansi(text: &str) -> String {
    // /\x1b\[[0-9;]*m/g
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("\x1b[") {
        let after = &rest[at + 2..];
        let params = after.chars().take_while(|c| c.is_ascii_digit() || *c == ';').count();
        if after[params..].starts_with('m') {
            out.push_str(&rest[..at]);
            rest = &after[params + 1..];
        } else {
            out.push_str(&rest[..at + 2]);
            rest = after;
        }
    }
    out.push_str(rest);
    out
}

/// Length of `^(?:\d{4}-\d\d-\d\dT[\d:.]+Z?\s+)?(?:TRACE|DEBUG|INFO|WARN|ERROR)(?:\s+|$)(?:[\w.-]+(?:::[\w.-]+)*:(?:\s+|$))?`.
fn log_prefix_len(line: &str) -> Option<usize> {
    let bytes = line.as_bytes();
    let ws = |from: usize| bytes[from..].iter().take_while(|b| b.is_ascii_whitespace()).count();
    let mut pos = 0;
    // Optional timestamp.
    let ts = (|| {
        let digits = |range: std::ops::Range<usize>| bytes.get(range).is_some_and(|s| s.iter().all(u8::is_ascii_digit));
        if !(digits(0..4)
            && bytes.get(4) == Some(&b'-')
            && digits(5..7)
            && bytes.get(7) == Some(&b'-')
            && digits(8..10)
            && bytes.get(10) == Some(&b'T'))
        {
            return None;
        }
        let mut p = 11;
        let body = bytes[p..].iter().take_while(|b| b.is_ascii_digit() || **b == b':' || **b == b'.').count();
        if body == 0 {
            return None;
        }
        p += body;
        if bytes.get(p) == Some(&b'Z') {
            p += 1;
        }
        let w = ws(p);
        (w > 0).then_some(p + w)
    })();
    if let Some(p) = ts {
        pos = p;
    }
    let level = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR"].iter().find(|l| line[pos..].starts_with(*l))?;
    pos += level.len();
    let w = ws(pos);
    if w == 0 && pos != bytes.len() {
        return None;
    }
    pos += w;
    // Optional module path ending in ':'.
    let word = |b: &u8| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'.' || *b == b'-';
    let mut p = pos;
    let first = bytes[p..].iter().take_while(|b| word(b)).count();
    if first > 0 {
        p += first;
        loop {
            if bytes[p..].starts_with(b"::") {
                let next = bytes[p + 2..].iter().take_while(|b| word(b)).count();
                if next > 0 {
                    p += 2 + next;
                    continue;
                }
            }
            break;
        }
        if bytes.get(p) == Some(&b':') {
            let after = p + 1;
            let w = ws(after);
            if w > 0 || after == bytes.len() {
                pos = after + w;
            }
        }
    }
    Some(pos)
}

fn without_period(text: &str) -> &str {
    text.strip_suffix('.').unwrap_or(text)
}

/// events.cjs `crashMessage("codex", detail, { signal })`. `signal` is a name such as "SIGKILL".
pub fn crash_message(detail: &str, signal: Option<&str>) -> String {
    let (line, _) = read_last_line(detail);
    let reason = match signal {
        Some(signal) if !signal.is_empty() && line.is_empty() => format!("Codex exited with signal {signal}"),
        _ => line,
    };
    if reason.is_empty() {
        "Codex stopped unexpectedly. Send your message again to continue this chat.".into()
    } else {
        format!("Codex stopped unexpectedly: {}. Send your message again to continue this chat.", without_period(&reason))
    }
}

/// Codex passes some API errors on as raw JSON: `{"type":"error","error":{"message":"…"}}`.
pub fn codex_error_text(error: Option<&Value>) -> String {
    let message = error
        .and_then(|e| e.get("message"))
        .filter(|m| truthy(Some(m)))
        .map(|m| js_string(Some(m)))
        .unwrap_or_else(|| "Codex could not finish this turn.".into());
    match serde_json::from_str::<Value>(&message) {
        Ok(parsed) => parsed.pointer("/error/message").filter(|m| truthy(Some(m))).map(|m| js_string(Some(m))).unwrap_or(message),
        Err(_) => message,
    }
}

/// A turn Codex couldn't authenticate: codexErrorInfo "unauthorized", or an HTTP failure with status 401.
pub fn codex_unauthorized(error: Option<&Value>) -> bool {
    let Some(info) = error.and_then(|e| e.get("codexErrorInfo")) else { return false };
    match info {
        Value::String(s) => s == "unauthorized",
        Value::Object(map) => map.values().any(|detail| detail.get("httpStatusCode").and_then(Value::as_f64) == Some(401.0)),
        Value::Array(items) => items.iter().any(|detail| detail.get("httpStatusCode").and_then(Value::as_f64) == Some(401.0)),
        _ => false,
    }
}

/// The latest reset among the windows Codex reports full, as an ISO date.
pub fn codex_limit_reset(rate_limits: Option<&Value>) -> Option<String> {
    let full = ["primary", "secondary"].iter().filter_map(|key| rate_limits?.get(*key)).filter(|window| {
        window.get("usedPercent").and_then(Value::as_f64).is_some_and(|p| p >= 100.0)
            && window.get("resetsAt").is_some_and(Value::is_number)
    });
    let latest = full.filter_map(|w| w.get("resetsAt").and_then(Value::as_f64)).fold(0.0_f64, f64::max);
    (latest > 0.0).then(|| iso_from_millis((latest * 1000.0) as i64))
}

fn text_delta(state: &mut CodexEventState, text: &str, starts_message: bool) -> Value {
    state.has_text = true;
    let mut event =
        json!({ "type": "text-delta", "messageId": state.turn_id.clone().map(Value::from).unwrap_or(Value::Null), "text": text });
    if starts_message {
        event["startsMessage"] = true.into();
    }
    event
}

fn str_param<'a>(params: &'a Value, key: &str) -> Option<&'a str> {
    params.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// An item or delta from an earlier turn than the one running.
fn stale_turn(params: &Value, state: &CodexEventState) -> bool {
    matches!((state.turn_id.as_deref().filter(|s| !s.is_empty()), str_param(params, "turnId")), (Some(current), Some(turn)) if current != turn)
}

fn with_type(kind: &str, body: Value) -> Value {
    let mut map = Map::new();
    map.insert("type".into(), kind.into());
    if let Value::Object(fields) = body {
        map.extend(fields);
    }
    Value::Object(map)
}

fn step_events(method: &str, step: Value, item: &Value, state: &mut CodexEventState) -> Vec<Value> {
    let id = js_string(step.get("id"));
    if method == "item/started" {
        if state.steps.contains(&id) {
            return vec![];
        }
        state.steps.insert(id);
        return vec![json!({ "type": "step-started", "step": step })];
    }
    let mut events = Vec::new();
    if !state.steps.shift_remove(&id) {
        events.push(json!({ "type": "step-started", "step": step }));
    }
    events.push(with_type("step-completed", codex_step_result(item)));
    events
}

/// A subagent's design calls are the Chat's designs too: artifact steps named for the subagent.
fn codex_subagent_artifact(method: &str, params: &Value, state: &mut CodexEventState) -> Vec<Value> {
    let Some(item) = params.get("item") else { return vec![] };
    let thread = js_string(params.get("threadId"));
    let tool = (item.get("type").and_then(Value::as_str) == Some("mcpToolCall")
        && item.get("server").and_then(Value::as_str) == Some("milagre"))
    .then(|| item.get("tool").and_then(Value::as_str))
    .flatten();
    if !matches!(method, "item/started" | "item/completed")
        || !state.subagents.contains_key(&thread)
        || !matches!(tool, Some("design_show" | "design_apply" | "artifact_show" | "html_render"))
    {
        return vec![];
    }
    let Some(mut step) = codex_step(item) else { return vec![] };
    step["agent"] = params.get("threadId").cloned().unwrap_or(Value::Null);
    step_events(method, step, item, state)
}

fn codex_reasoning(method: &str, item: &Value, state: &mut CodexEventState) -> Vec<Value> {
    let id = js_string(item.get("id"));
    if method == "item/started" {
        if state.steps.contains(&id) {
            return vec![];
        }
        state.steps.insert(id.clone());
        let now = state.now() as f64;
        state.thinking_starts.insert(id.clone(), now);
        return vec![json!({ "type": "step-started", "step": thinking_step(&id) })];
    }
    let mut events = Vec::new();
    if !state.steps.shift_remove(&id) {
        events.push(json!({ "type": "step-started", "step": thinking_step(&id) }));
    }
    let started = state.thinking_starts.shift_remove(&id);
    let summary = item
        .get("summary")
        .and_then(Value::as_array)
        .map(|parts| parts.iter().filter_map(Value::as_str).filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n\n"))
        .unwrap_or_default();
    let duration = started.map(|start| state.now() as f64 - start);
    events.push(with_type("step-completed", thinking_end(&id, duration, &summary)));
    events
}

/// events.cjs `mapCodexNotification`. Notifications not listed are ignored on purpose (MCP startup,
/// hooks, the running diff); rate limits are only kept for a usage-limit failure's reset time.
pub fn map_codex_notification(method: &str, params: &Value, state: &mut CodexEventState) -> Vec<Value> {
    if method == "account/rateLimits/updated" {
        state.rate_limits = params.get("rateLimits").cloned();
        return vec![];
    }
    let children = codex_subagents(method, params, state);
    if let (Some(thread), Some(own)) = (str_param(params, "threadId"), state.thread_id.as_deref().filter(|s| !s.is_empty())) {
        if thread != own {
            let mut events = children;
            events.extend(codex_subagent_artifact(method, params, state));
            return events;
        }
    }
    if !children.is_empty() {
        return children;
    }
    match method {
        "turn/started" => vec![
            json!({ "type": "turn-started", "turnId": params.pointer("/turn/id").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Null) }),
        ],
        "thread/tokenUsage/updated" => {
            let used = params.pointer("/tokenUsage/last/totalTokens").filter(|v| v.is_number());
            let size = params.pointer("/tokenUsage/modelContextWindow").filter(|v| v.as_f64().is_some_and(|s| s > 0.0));
            match (used, size) {
                (Some(used), Some(size)) => vec![json!({ "type": "context-usage", "used": used, "size": size })],
                _ => vec![],
            }
        }
        "item/started" | "item/completed" if truthy(params.get("item")) => {
            let item = &params["item"];
            if stale_turn(params, state) {
                return vec![];
            }
            let item_type = item.get("type").and_then(Value::as_str);
            if item_type == Some("contextCompaction") {
                let id = js_string(item.get("id"));
                let status = if method == "item/started" { "preparing" } else { "done" };
                let previous = state.compactions.get(&id).map(String::as_str);
                if previous == Some("done") || previous == Some(status) {
                    return vec![];
                }
                state.compactions.insert(id, status.into());
                return vec![if status == "preparing" {
                    json!({ "type": "context-compacting" })
                } else {
                    json!({ "type": "context-compacted", "trigger": "auto" })
                }];
            }
            if item_type == Some("agentMessage") && item.get("delivery").and_then(Value::as_str) == Some("async") {
                if method != "item/completed" || !truthy(item.get("text")) {
                    return vec![];
                }
                let id = item.get("id").cloned().unwrap_or(Value::Null);
                if state.async_messages.iter().any(|seen| strict_eq(Some(seen), Some(&id))) {
                    return vec![];
                }
                state.async_messages.push(id.clone());
                let mut events = Vec::new();
                if state.has_text {
                    events.push(text_delta(state, "\n\n", true));
                }
                state.last_item_id = Some(id);
                events.push(text_delta(state, &js_string(item.get("text")), false));
                return events;
            }
            if item_type == Some("reasoning") {
                return codex_reasoning(method, item, state);
            }
            match codex_step(item) {
                Some(step) => step_events(method, step, item, state),
                None => vec![],
            }
        }
        "item/reasoning/summaryTextDelta" | "item/commandExecution/outputDelta" => {
            let id = js_string(params.get("itemId"));
            if truthy(params.get("delta")) && state.steps.contains(&id) {
                vec![json!({ "type": "step-output", "id": id, "text": params["delta"] })]
            } else {
                vec![]
            }
        }
        "item/reasoning/summaryPartAdded" => {
            let id = js_string(params.get("itemId"));
            if params.get("summaryIndex").and_then(Value::as_f64).is_some_and(|i| i > 0.0) && state.steps.contains(&id) {
                vec![json!({ "type": "step-output", "id": id, "text": "\n\n" })]
            } else {
                vec![]
            }
        }
        "item/agentMessage/delta" if truthy(params.get("delta")) => {
            if stale_turn(params, state) {
                return vec![];
            }
            let mut events = Vec::new();
            if let Some(turn) = params.get("turnId").filter(|t| !t.is_null()) {
                state.turn_id = Some(js_string(Some(turn)));
            }
            let item_id = params.get("itemId").cloned();
            if state.has_text && truthy(state.last_item_id.as_ref()) && !strict_eq(item_id.as_ref(), state.last_item_id.as_ref()) {
                events.push(text_delta(state, "\n\n", true));
            }
            state.last_item_id = item_id;
            events.push(text_delta(state, &js_string(params.get("delta")), false));
            events
        }
        "turn/plan/updated" => {
            if stale_turn(params, state) {
                return vec![];
            }
            match codex_plan_tasks(params.get("plan")) {
                Some(tasks) => vec![json!({ "type": "tasks-updated", "tasks": tasks })],
                None => vec![],
            }
        }
        "turn/completed" => {
            let turn = params.get("turn").filter(|t| !t.is_null()).cloned().unwrap_or(json!({}));
            if let (Some(current), Some(id)) = (state.turn_id.as_deref().filter(|s| !s.is_empty()), str_param(&turn, "id")) {
                if current != id {
                    return vec![];
                }
            }
            let status = turn.get("status").and_then(Value::as_str);
            let error = turn.get("error").filter(|e| !e.is_null());
            if status == Some("interrupted") {
                return vec![json!({ "type": "turn-cancelled" })];
            }
            if status == Some("failed") && error.and_then(|e| e.get("codexErrorInfo")).and_then(Value::as_str) == Some("usageLimitExceeded")
            {
                let mut limit = Map::new();
                limit.insert("provider".into(), "codex".into());
                if let Some(resets) = codex_limit_reset(state.rate_limits.as_ref()) {
                    limit.insert("resetsAt".into(), resets.into());
                }
                return vec![failed_with(&codex_error_text(error), &[("limit", Value::Object(limit))])];
            }
            if status == Some("failed") {
                return vec![if codex_unauthorized(error) && state.requires_openai_auth == Some(true) {
                    failed_with(&login_message(), &[("login", true.into())])
                } else {
                    json!({ "type": "turn-failed", "message": codex_error_text(error) })
                }];
            }
            vec![json!({ "type": "turn-completed" })]
        }
        _ => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn last_lines_drop_log_prefixes() {
        assert_eq!(read_last_line("\x1b[31mfirst\x1b[0m\n\n  boom: model unavailable  \n").0, "boom: model unavailable");
        let (line, logged) = read_last_line("2026-10-02T00:59:00.724526Z ERROR codex_core::tools::router: error=bad");
        assert_eq!((line.as_str(), logged), ("error=bad", true));
        assert_eq!(read_last_line("WARN something").0, "something");
        assert_eq!(read_last_line("ERROR").0, "");
        assert_eq!(read_last_line("ERRORS happen").0, "ERRORS happen");
    }

    #[test]
    fn crash_messages() {
        assert_eq!(
            crash_message("boom: model unavailable\n", None),
            "Codex stopped unexpectedly: boom: model unavailable. Send your message again to continue this chat."
        );
        assert_eq!(
            crash_message("", Some("SIGKILL")),
            "Codex stopped unexpectedly: Codex exited with signal SIGKILL. Send your message again to continue this chat."
        );
        assert_eq!(crash_message("", None), "Codex stopped unexpectedly. Send your message again to continue this chat.");
    }

    #[test]
    fn error_text_unwraps_api_json() {
        let error = json!({ "message": "{\"type\":\"error\",\"status\":400,\"error\":{\"message\":\"Bad input\"}}" });
        assert_eq!(codex_error_text(Some(&error)), "Bad input");
        assert_eq!(codex_error_text(None), "Codex could not finish this turn.");
    }
}

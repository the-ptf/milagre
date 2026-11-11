//! Claude stream-json messages to Milagre `AgentEvent`s, ported from `mapClaudeMessage` and its helpers
//! in `packages/core/src/agents/events.cjs`. Events are JSON values in the `AgentEvent` shapes of
//! `@milagre/shared/model`, so the owner forwards them unchanged.
//!
//! Includes child/background lifecycles (`subagents.cjs`). Read-image persistence is configured
//! separately by the owner. See README for integration boundaries.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{json, Map, Value};

use crate::drafts::Drafts;
use crate::steps::{claude_step, claude_step_result, thinking_end, thinking_step};
use crate::tasks::Tasks;
use crate::text::{js_trim, utf16_len, utf16_slice, Obj};

pub const RESUME_FAILED_MESSAGE: &str =
    "Couldn't resume this chat's earlier agent session; it may have been deleted. Send your message again to continue in a fresh session.";
const CLI_NAME: &str = "Claude Code";

/// Whether an event ends a turn (`isTurnEnd`).
pub fn is_terminal(event: &Value) -> bool {
    matches!(event.get("type").and_then(Value::as_str), Some("turn-completed" | "turn-cancelled" | "turn-failed"))
}

/// `failedWith(message, extra)`: a turn failure made of one of Milagre's own messages.
pub fn failed_with(message: &str, extra: Map<String, Value>) -> Value {
    Obj::new().set("type", "turn-failed").set("message", message).set("notice", true).merge(extra).build()
}

pub fn missing_cli_message() -> String {
    let install = if cfg!(windows) { "irm https://claude.ai/install.ps1 | iex" } else { "curl -fsSL https://claude.ai/install.sh | bash" };
    format!("Milagre couldn't find {CLI_NAME}. Install it with `{install}`, then send your message again.")
}

pub fn login_message() -> String {
    format!("{CLI_NAME} isn't logged in. Run `claude auth login` in a terminal, then send your message again.")
}

fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' && chars.peek() == Some(&'[') {
            let mut probe = chars.clone();
            probe.next();
            let mut consumed = 1;
            let mut ok = false;
            for next in probe.by_ref() {
                consumed += 1;
                if next == 'm' {
                    ok = true;
                    break;
                }
                if !(next.is_ascii_digit() || next == ';') {
                    break;
                }
            }
            if ok {
                for _ in 0..consumed {
                    chars.next();
                }
                continue;
            }
        }
        out.push(c);
    }
    out
}

/// `LOG_PREFIX`: `^(?:\d{4}-\d\d-\d\dT[\d:.]+Z?\s+)?(?:TRACE|DEBUG|INFO|WARN|ERROR)(?:\s+|$)(?:[\w.-]+(?:::[\w.-]+)*:(?:\s+|$))?`.
/// Returns the line without the prefix, or `None` when it is not a log line.
fn strip_log_prefix(line: &str) -> Option<String> {
    let word = |c: char| c.is_alphanumeric() || c == '_' || c == '.' || c == '-';
    let mut rest = line;
    // Optional timestamp: 4 digits, '-', 2, '-', 2, 'T', [\d:.]+, optional Z, whitespace.
    let b = rest.as_bytes();
    let digits = |range: std::ops::Range<usize>| range.clone().all(|i| b.get(i).is_some_and(u8::is_ascii_digit));
    if digits(0..4) && b.get(4) == Some(&b'-') && digits(5..7) && b.get(7) == Some(&b'-') && digits(8..10) && b.get(10) == Some(&b'T') {
        let after = &rest[11..];
        let clock = after.find(|c: char| !(c.is_ascii_digit() || c == ':' || c == '.')).unwrap_or(after.len());
        let mut tail = &after[clock..];
        if clock > 0 {
            tail = tail.strip_prefix('Z').unwrap_or(tail);
            if tail.starts_with(char::is_whitespace) {
                rest = tail.trim_start();
            }
        }
    }
    let level = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR"].into_iter().find(|level| rest.starts_with(level))?;
    rest = &rest[level.len()..];
    if !(rest.is_empty() || rest.starts_with(char::is_whitespace)) {
        return None;
    }
    rest = rest.trim_start();
    // Optional module path: word+ (:: word+)* ':' then whitespace or end.
    let mut at = rest.find(|c: char| !word(c)).unwrap_or(rest.len());
    if at > 0 {
        loop {
            let tail = &rest[at..];
            if let Some(next) = tail.strip_prefix("::") {
                let len = next.find(|c: char| !word(c)).unwrap_or(next.len());
                if len > 0 {
                    at += 2 + len;
                    continue;
                }
            }
            break;
        }
        let tail = &rest[at..];
        if let Some(after) = tail.strip_prefix(':') {
            if after.is_empty() || after.starts_with(char::is_whitespace) {
                rest = after.trim_start();
            }
        }
    }
    Some(rest.to_owned())
}

/// `readLastLine(text).line`: the last non-empty line without colours or a log prefix, capped at 300.
pub fn last_line(text: &str) -> String {
    let clean = strip_ansi(text);
    let raw = clean.split('\n').map(str::trim).rfind(|line| !line.is_empty()).unwrap_or("").to_owned();
    let line = strip_log_prefix(&raw).unwrap_or(raw);
    if utf16_len(&line) > 300 {
        format!("{}…", utf16_slice(&line, 0, 299))
    } else {
        line
    }
}

/// `crashMessage("claude", detail, { signal })`.
pub fn crash_message(detail: &str, signal: Option<&str>) -> String {
    let line = last_line(detail);
    let reason = match signal {
        Some(signal) if line.is_empty() => format!("{CLI_NAME} exited with signal {signal}"),
        _ => line,
    };
    let reason = reason.strip_suffix('.').map(str::to_owned).unwrap_or(reason);
    if reason.is_empty() {
        format!("{CLI_NAME} stopped unexpectedly. Send your message again to continue this chat.")
    } else {
        format!("{CLI_NAME} stopped unexpectedly: {reason}. Send your message again to continue this chat.")
    }
}

fn reset_iso(seconds: Option<&Value>) -> Option<String> {
    let seconds = seconds?.as_f64().filter(|s| *s > 0.0)?;
    let millis = (seconds * 1000.0) as i64;
    Some(iso_from_millis(millis))
}

/// `new Date(ms).toISOString()`.
pub fn iso_from_millis(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (h, m, s, milli) = (rem / 3_600_000, rem / 60_000 % 60, rem / 1000 % 60, rem % 1000);
    // Civil from days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };
    format!("{year:04}-{month:02}-{d:02}T{h:02}:{m:02}:{s:02}.{milli:03}Z")
}

pub type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;

fn system_clock() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[derive(Debug, Clone)]
struct Thinking {
    id: String,
    index: Value,
    text: String,
    started_at: u64,
}

/// The mapper's state (`state` in claude-provider.cjs), owned by one provider session.
#[derive(Clone)]
pub struct ClaudeMapper {
    pub session_id: Option<String>,
    pub turn_id: Option<String>,
    pub has_text: bool,
    pub suggestion_turn_id: Option<String>,
    pub local_command_error: Option<String>,
    auth_failed: bool,
    limit: Option<(Option<String>, Option<String>)>,
    limit_hit: bool,
    compacting: bool,
    context_window: Option<u64>,
    context_used: Option<u64>,
    thinking_count: u64,
    thinking: Option<Thinking>,
    drafts: Drafts,
    subagent_artifacts: HashMap<String, Value>,
    /// Tool calls waiting for their result, by tool_use id.
    pub tools: HashMap<String, Value>,
    tasks: Tasks,
    subagents: crate::subagents::Subagents,
    clock: Clock,
    image_store: Option<Arc<dyn crate::images::ToolImageStore>>,
    budget: crate::budget::EventBudget,
}

impl std::fmt::Debug for ClaudeMapper {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClaudeMapper").field("session_id", &self.session_id).field("turn_id", &self.turn_id).finish_non_exhaustive()
    }
}

impl Default for ClaudeMapper {
    fn default() -> Self {
        Self::new(None)
    }
}

const LOCAL_ENTITIES: [(&str, &str); 5] = [("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&apos;", "'")];

fn decode_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        match LOCAL_ENTITIES.iter().find(|(entity, _)| rest.starts_with(entity)) {
            Some((entity, plain)) => {
                out.push_str(plain);
                rest = &rest[entity.len()..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// `localCommandOutput`: stdout and stderr of a local command, without their wrapper tags.
fn local_command_output(source: &str) -> (String, String) {
    let (mut stdout, mut stderr) = (String::new(), String::new());
    let mut rest = source;
    while let Some(at) = rest.find("<local-command-") {
        let after = &rest[at + "<local-command-".len()..];
        let stream = if after.starts_with("stdout>") {
            "stdout"
        } else if after.starts_with("stderr>") {
            "stderr"
        } else {
            rest = after;
            continue;
        };
        let body = &after[stream.len() + 1..];
        let close = format!("</local-command-{stream}>");
        let Some(end) = body.find(&close) else {
            rest = after;
            continue;
        };
        let clean = js_trim(&strip_ansi(&decode_entities(&body[..end]))).to_owned();
        if !clean.is_empty() {
            let target = if stream == "stdout" { &mut stdout } else { &mut stderr };
            *target = if target.is_empty() { clean } else { format!("{target}\n\n{clean}") };
        }
        rest = &body[end + close.len()..];
    }
    (stdout, stderr)
}

fn is_fence(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.starts_with("```") || trimmed.starts_with("~~~")
}

fn is_rule(line: &str) -> bool {
    let trimmed = line.trim();
    !trimmed.is_empty() && (trimmed.chars().all(|c| c == '=') || trimmed.chars().all(|c| c == '-'))
}

/// `keepLineBreaks`: a line that goes on in the next one ends in a Markdown hard break.
fn keep_line_breaks(text: &str) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut fenced = false;
    lines
        .iter()
        .enumerate()
        .map(|(index, line)| {
            if is_fence(line) {
                fenced = !fenced;
                return line.to_string();
            }
            let Some(next) = lines.get(index + 1) else { return line.to_string() };
            if fenced || line.trim().is_empty() || next.trim().is_empty() {
                return line.to_string();
            }
            if line.trim_end().ends_with('|') || line.ends_with("  ") || next.trim_start().starts_with('|') || is_rule(next) {
                return line.to_string();
            }
            format!("{line}  ")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn num(value: Option<&Value>) -> Option<u64> {
    value.and_then(Value::as_f64).filter(|n| *n >= 0.0).map(|n| n as u64)
}

fn is_top(message: &Value) -> bool {
    message.get("parent_tool_use_id").is_none_or(Value::is_null)
}

impl ClaudeMapper {
    pub fn new(clock: Option<Clock>) -> Self {
        Self {
            session_id: None,
            turn_id: None,
            has_text: false,
            suggestion_turn_id: None,
            local_command_error: None,
            auth_failed: false,
            limit: None,
            limit_hit: false,
            compacting: false,
            context_window: None,
            context_used: None,
            thinking_count: 0,
            thinking: None,
            drafts: Drafts::default(),
            subagent_artifacts: HashMap::new(),
            tools: HashMap::new(),
            tasks: Tasks::default(),
            subagents: Default::default(),
            clock: clock.unwrap_or_else(|| Arc::new(system_clock)),
            image_store: None,
            budget: Default::default(),
        }
    }

    pub fn set_event_limits(&mut self, budget: crate::budget::EventBudget, max_agents: usize, snapshot_bytes: usize) {
        self.budget = budget;
        self.subagents.set_limits(budget, max_agents, snapshot_bytes);
    }

    /// Enable Read-image persistence in an owner-selected store. Unconfigured mappers do no I/O.
    pub fn set_image_store(&mut self, store: Arc<dyn crate::images::ToolImageStore>) {
        self.image_store = Some(store);
    }

    fn now(&self) -> u64 {
        (self.clock)()
    }

    /// What `finishTurn` clears: calls waiting for a result never get one, nor does cut-off thinking.
    pub fn end_turn(&mut self) {
        self.tools.clear();
        self.subagents.end_turn();
        self.thinking = None;
    }

    pub fn settle_subagents(&mut self, status: &str) -> Vec<Value> {
        self.subagents.settle(status, self.now())
    }

    pub(crate) fn settle_compact(&mut self, status: &str) -> crate::budget::Mapped {
        self.subagents.settle_bounded(status, self.now(), true)
    }

    fn text_delta(&mut self, text: &str, starts_message: bool) -> Value {
        self.has_text = true;
        Obj::new()
            .set("type", "text-delta")
            .set("messageId", self.turn_id.clone().map(Value::from).unwrap_or(Value::Null))
            .set("text", text)
            .opt("startsMessage", starts_message.then_some(true))
            .build()
    }

    fn context_usage(&mut self, used: u64) -> Vec<Value> {
        self.context_used = Some(used);
        match self.context_window {
            Some(size) if size > 0 => vec![json!({ "type": "context-usage", "used": used, "size": size })],
            _ => Vec::new(),
        }
    }

    fn local_command(&mut self, message: &Value, source: &str) -> Vec<Value> {
        let (stdout, stderr) = local_command_output(source);
        let failed = !stderr.is_empty() || message.pointer("/local_command_outcome/kind").and_then(Value::as_str) == Some("failed");
        let text = message
            .pointer("/message/content")
            .and_then(Value::as_array)
            .map(|blocks| {
                blocks
                    .iter()
                    .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                    .filter_map(|block| block.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n\n")
            })
            .unwrap_or_default();
        let text = js_trim(&text).to_owned();
        let reply = if !failed {
            if text.is_empty() {
                stdout.clone()
            } else {
                text.clone()
            }
        } else if !stderr.is_empty() {
            stdout.clone()
        } else {
            String::new()
        };
        if failed {
            let error =
                [&stderr, &text, &stdout].into_iter().find(|t| !t.is_empty()).cloned().unwrap_or_else(|| "The command failed.".into());
            self.local_command_error = Some(error);
        }
        if reply.is_empty() {
            return Vec::new();
        }
        let mut events = Vec::new();
        if self.has_text {
            events.push(self.text_delta("\n\n", true));
        }
        events.push(self.text_delta(&keep_line_breaks(&reply), false));
        events
    }

    /// Capture just the matched image work under the session lock; execution happens outside it.
    pub(crate) fn image_jobs(&self, message: &Value) -> Vec<(String, Value, Value, Arc<dyn crate::images::ToolImageStore>)> {
        let Some(store) = &self.image_store else {
            return vec![];
        };
        if message["type"] != "user" || !is_top(message) || truthy(message.get("isReplay")) {
            return vec![];
        }
        let mut seen = std::collections::HashSet::new();
        message
            .pointer("/message/content")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|block| {
                let id = block["tool_use_id"].as_str()?;
                let call = self.tools.get(id)?;
                if block["type"] != "tool_result" || call["name"] != "Read" || !seen.insert(id.to_owned()) {
                    return None;
                }
                Some((id.to_owned(), call.clone(), block.clone(), store.clone()))
            })
            .collect()
    }

    pub fn map(&mut self, message: &Value) -> Vec<Value> {
        crate::budget::public_events(self.map_prepared(message, None))
    }

    /// `mapClaudeMessage(message, state)`.
    pub(crate) fn map_prepared(&mut self, message: &Value, images: Option<&HashMap<String, Vec<Value>>>) -> crate::budget::Mapped {
        let kind = message.get("type").and_then(Value::as_str).unwrap_or("");
        let subtype = message.get("subtype").and_then(Value::as_str);
        let top = is_top(message);
        if kind == "system" && subtype == Some("init") {
            self.suggestion_turn_id = None;
        }
        if kind == "prompt_suggestion" {
            let suggestion = message.get("suggestion").and_then(Value::as_str);
            let same_session = message.get("session_id").and_then(Value::as_str) == self.session_id.as_deref();
            if !top || !same_session || self.suggestion_turn_id.is_none() || suggestion.is_none_or(|s| js_trim(s).is_empty()) {
                return Ok(Vec::new());
            }
            let turn_id = self.suggestion_turn_id.take().unwrap();
            let mut events = crate::budget::Batch::new(self.budget);
            events.push(json!({ "type": "prompt-suggestion", "text": suggestion.unwrap(), "turnId": turn_id }));
            return events.finish();
        }
        let mut events = crate::budget::Batch::new(self.budget);
        events.merge(self.subagents.map_bounded(message, self.now()));
        if events.failed() {
            return events.finish();
        }
        if kind == "assistant" && message.get("error").and_then(Value::as_str) == Some("authentication_failed") {
            self.auth_failed = true;
        }
        if kind == "rate_limit_event" && message.pointer("/rate_limit_info/status").and_then(Value::as_str) == Some("rejected") {
            let info = &message["rate_limit_info"];
            self.limit = Some((info.get("rateLimitType").and_then(Value::as_str).map(str::to_owned), reset_iso(info.get("resetsAt"))));
        }
        if kind == "assistant" && top && message.get("error").and_then(Value::as_str) == Some("rate_limit") {
            self.limit_hit = true;
        }
        if kind == "system" && subtype == Some("init") {
            if let Some(id) = message.get("session_id").and_then(Value::as_str).filter(|id| !id.is_empty()) {
                if self.session_id.as_deref() != Some(id) {
                    self.session_id = Some(id.to_owned());
                    events.push(json!({ "type": "session-started", "nativeId": id }));
                }
            }
        }
        if top
            && kind == "system"
            && subtype == Some("status")
            && message.get("status").and_then(Value::as_str) == Some("compacting")
            && !self.compacting
        {
            self.compacting = true;
            events.push(json!({ "type": "context-compacting" }));
        }
        if top && kind == "system" && subtype == Some("compact_boundary") {
            self.compacting = false;
            let meta = message.get("compact_metadata");
            let before = meta.and_then(|m| m.get("pre_tokens")).filter(|v| v.is_number()).cloned();
            let after = meta.and_then(|m| m.get("post_tokens")).filter(|v| v.is_number()).cloned();
            let trigger = if meta.and_then(|m| m.get("trigger")).and_then(Value::as_str) == Some("manual") { "manual" } else { "auto" };
            events.push(
                Obj::new()
                    .set("type", "context-compacted")
                    .set("trigger", trigger)
                    .opt("before", before)
                    .opt("after", after.clone())
                    .build(),
            );
            if let Some(after) = num(after.as_ref()) {
                events.extend(self.context_usage(after));
            }
        }
        if kind == "assistant" && top {
            if let Some(source) = message.get("local_command_source").and_then(Value::as_str) {
                events.extend(self.local_command(message, source));
            }
        }
        if kind == "assistant" && top {
            if let Some(usage) = message.pointer("/message/usage").filter(|u| !u.is_null()) {
                if message.pointer("/message/model").and_then(Value::as_str) != Some("<synthetic>") {
                    let field = |key: &str| usage.get(key).and_then(Value::as_f64).unwrap_or(0.0);
                    let used = field("input_tokens")
                        + field("cache_read_input_tokens")
                        + field("cache_creation_input_tokens")
                        + field("output_tokens");
                    events.extend(self.context_usage(used as u64));
                }
            }
        }
        if kind == "stream_event" && top {
            let event = message.get("event").cloned().unwrap_or_else(|| json!({}));
            let etype = event.get("type").and_then(Value::as_str).unwrap_or("");
            let block_type = event.pointer("/content_block/type").and_then(Value::as_str);
            if etype == "content_block_start" && block_type == Some("text") && self.has_text {
                events.push(self.text_delta("\n\n", true));
            }
            if etype == "content_block_delta" && event.pointer("/delta/type").and_then(Value::as_str) == Some("text_delta") {
                if let Some(text) = event.pointer("/delta/text").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                    events.push(self.text_delta(text, false));
                }
            }
            if etype == "content_block_start" && matches!(block_type, Some("thinking" | "redacted_thinking")) {
                self.thinking_count += 1;
                let id = format!("thinking-{}", self.thinking_count);
                self.thinking = Some(Thinking {
                    id: id.clone(),
                    index: event.get("index").cloned().unwrap_or(Value::Null),
                    text: String::new(),
                    started_at: self.now(),
                });
                events.push(json!({ "type": "step-started", "step": thinking_step(&id) }));
            }
            let now = self.now();
            events.extend(self.drafts.on_stream_event(&event, now, None));
            let index = event.get("index").cloned().unwrap_or(Value::Null);
            if let Some(thinking) = self.thinking.as_mut().filter(|t| t.index == index) {
                if etype == "content_block_delta" && event.pointer("/delta/type").and_then(Value::as_str) == Some("thinking_delta") {
                    if let Some(piece) = event.pointer("/delta/thinking").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                        thinking.text.push_str(piece);
                        events.push(json!({ "type": "step-output", "id": thinking.id, "text": piece }));
                    }
                }
            }
            if etype == "content_block_stop" && self.thinking.as_ref().is_some_and(|t| t.index == index) {
                let thinking = self.thinking.take().unwrap();
                let mut end = thinking_end(&thinking.id, Some(self.now().saturating_sub(thinking.started_at)), &thinking.text);
                end.as_object_mut().unwrap().insert("type".into(), "step-completed".into());
                events.push(reorder_type(end));
            }
        }
        if kind == "stream_event" && !top {
            let event = message.get("event").cloned().unwrap_or_else(|| json!({}));
            let agent = message["parent_tool_use_id"].as_str().map(str::to_owned);
            let now = self.now();
            events.extend(self.drafts.on_stream_event(&event, now, agent.as_deref()));
        }
        if kind == "assistant" && !top {
            let agent = crate::text::js_string(&message["parent_tool_use_id"]);
            for block in message.pointer("/message/content").and_then(Value::as_array).cloned().unwrap_or_default() {
                if events.failed() {
                    break;
                }
                let name = block.get("name").map(crate::text::js_string).unwrap_or_else(|| "undefined".into());
                if block.get("type").and_then(Value::as_str) != Some("tool_use") || !is_artifact_tool(&name) {
                    continue;
                }
                let id = block.get("id").map(crate::text::js_string).unwrap_or_default();
                self.subagent_artifacts.insert(id.clone(), block.clone());
                let mut step = claude_step(&id, &name, block.get("input").unwrap_or(&Value::Null));
                step["agent"] = agent.clone().into();
                events.push(json!({ "type": "step-started", "step": step }));
            }
        }
        if kind == "user" && !top {
            for block in message.pointer("/message/content").and_then(Value::as_array).cloned().unwrap_or_default() {
                if events.failed() {
                    break;
                }
                if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                    continue;
                }
                let id = block.get("tool_use_id").map(crate::text::js_string).unwrap_or_default();
                if let Some(call) = self.subagent_artifacts.remove(&id) {
                    events.push(step_completed(claude_step_result(&call, &block, None)));
                }
            }
        }
        if kind == "assistant" && top {
            for block in message.pointer("/message/content").and_then(Value::as_array).cloned().unwrap_or_default() {
                if events.failed() {
                    break;
                }
                let name = block.get("name").map(crate::text::js_string).unwrap_or_else(|| "undefined".into());
                if block.get("type").and_then(Value::as_str) != Some("tool_use") || name == "AskUserQuestion" {
                    continue;
                }
                let id = block.get("id").map(crate::text::js_string).unwrap_or_default();
                self.tools.insert(id.clone(), block.clone());
                let input = block.get("input").cloned().unwrap_or(Value::Null);
                events.push(json!({ "type": "step-started", "step": claude_step(&id, &name, &input) }));
                if let Some(tasks) = self.tasks.apply_tool_use(&name, &input) {
                    events.push(json!({ "type": "tasks-updated", "tasks": tasks }));
                }
            }
        }
        if kind == "user" && top {
            if let Some(content) = message.pointer("/message/content").and_then(Value::as_array) {
                let results: Vec<&Value> =
                    content.iter().filter(|block| block.get("type").and_then(Value::as_str) == Some("tool_result")).collect();
                for block in &results {
                    if events.failed() {
                        break;
                    }
                    let id = block.get("tool_use_id").map(crate::text::js_string).unwrap_or_default();
                    let Some(call) = self.tools.remove(&id) else { continue };
                    let structured = if results.len() == 1 { message.get("tool_use_result").filter(|v| !v.is_null()) } else { None };
                    events.push(step_completed(claude_step_result(&call, block, structured)));
                    if !truthy(message.get("isReplay")) {
                        if let Some(store) = &self.image_store {
                            if let Some(images) = images {
                                events.extend(images.get(&id).cloned().unwrap_or_default());
                            } else {
                                events.merge(crate::images::read_images(&call, block, store.as_ref(), self.budget));
                            }
                        }
                    }
                    if let Some(tasks) = self.tasks.apply_tool_result(&call, block, structured) {
                        events.push(json!({ "type": "tasks-updated", "tasks": tasks }));
                    }
                }
            }
        }
        if kind == "result"
            && subtype == Some("success")
            && !truthy(message.get("is_error"))
            && message.get("num_turns").and_then(Value::as_f64) == Some(0.0)
            && !truthy(message.get("result"))
            && message.get("user_message_uuids").and_then(Value::as_array).is_none_or(Vec::is_empty)
        {
            return events.finish();
        }
        if kind == "result" {
            let windows: Vec<u64> = message
                .get("modelUsage")
                .and_then(Value::as_object)
                .map(|usage| usage.values().map(|u| num(u.get("contextWindow")).unwrap_or(0)).collect())
                .unwrap_or_default();
            let window = windows.into_iter().max().unwrap_or(0);
            if window > 0 {
                self.context_window = Some(window);
                if let Some(used) = self.context_used {
                    events.extend(self.context_usage(used));
                }
            }
            let command_error = self.local_command_error.clone();
            let result_text = message.get("result").and_then(Value::as_str).filter(|t| !t.is_empty()).map(str::to_owned);
            if subtype == Some("success") && !truthy(message.get("is_error")) && command_error.is_none() {
                events.push(json!({ "type": "turn-completed" }));
            } else if self.auth_failed {
                events.push(failed_with(&login_message(), [("login".to_owned(), Value::Bool(true))].into_iter().collect()));
            } else if self.limit_hit || self.limit.is_some() {
                let mut limit = Obj::new().set("provider", "claude");
                if let Some((window, resets_at)) = &self.limit {
                    limit = limit.opt("window", window.clone()).opt("resetsAt", resets_at.clone());
                }
                let text = command_error.clone().or(result_text).unwrap_or_else(|| "Claude hit its usage limit.".into());
                events.push(failed_with(&text, [("limit".to_owned(), limit.build())].into_iter().collect()));
            } else {
                let errors = message.get("errors").and_then(Value::as_array).filter(|e| !e.is_empty());
                let text = command_error
                    .or_else(|| {
                        errors.map(|errors| errors.iter().map(|e| crate::text::js_string_or_empty(Some(e))).collect::<Vec<_>>().join("\n"))
                    })
                    .or(result_text)
                    .unwrap_or_else(|| "Claude could not finish this turn.".into());
                events.push(json!({ "type": "turn-failed", "message": text }));
            }
            self.local_command_error = None;
            self.auth_failed = false;
            self.limit_hit = false;
            self.limit = None;
            self.compacting = false;
        }
        events.finish()
    }
}

pub(crate) fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0),
        _ => true,
    }
}

fn is_artifact_tool(name: &str) -> bool {
    matches!(name, "mcp__milagre__design_show" | "mcp__milagre__design_apply" | "mcp__milagre__artifact_show" | "mcp__milagre__html_render")
}

fn reorder_type(value: Value) -> Value {
    let mut map = Map::new();
    let Value::Object(source) = value else { return value };
    map.insert("type".into(), source.get("type").cloned().unwrap_or(Value::Null));
    for (key, item) in source {
        if key != "type" {
            map.insert(key, item);
        }
    }
    Value::Object(map)
}

fn step_completed(result: Value) -> Value {
    let mut map = Map::new();
    map.insert("type".into(), "step-completed".into());
    if let Value::Object(fields) = result {
        map.extend(fields);
    }
    Value::Object(map)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crash_and_last_line() {
        assert_eq!(last_line("one\n\u{1b}[31mtwo\u{1b}[0m\n\n"), "two");
        assert_eq!(last_line("2026-10-02T00:59:00.724526Z ERROR codex_core::tools::router: boom"), "boom");
        assert_eq!(
            crash_message("Claude Code process exited with code 1", None),
            "Claude Code stopped unexpectedly: Claude Code process exited with code 1. Send your message again to continue this chat."
        );
        assert_eq!(
            crash_message("", Some("SIGKILL")),
            "Claude Code stopped unexpectedly: Claude Code exited with signal SIGKILL. Send your message again to continue this chat."
        );
        assert_eq!(iso_from_millis(1_700_000_000_000), "2023-11-14T22:13:20.000Z");
    }

    #[test]
    fn local_command_and_breaks() {
        let (out, err) =
            local_command_output("<local-command-stdout>a &amp; b</local-command-stdout><local-command-stderr> </local-command-stderr>");
        assert_eq!((out.as_str(), err.as_str()), ("a & b", ""));
        assert_eq!(keep_line_breaks("a\nb\n\nc"), "a  \nb\n\nc");
        assert_eq!(keep_line_breaks("```\na\nb\n```"), "```\na\nb\n```");
    }
}

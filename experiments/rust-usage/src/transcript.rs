//! Incremental transcript parser. Fields intentionally mirror Node's version-3 cache.
use crate::util::*;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Entry {
    pub provider: String,
    pub offset: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    pub carry: Value,
    pub sessions: IndexMap<String, Value>,
    pub rows: IndexMap<String, [f64; 6]>,
}
impl Entry {
    pub fn new(provider: &str) -> Self {
        Self { provider: provider.into(), offset: 0, file: None, carry: json!({}), sessions: IndexMap::new(), rows: IndexMap::new() }
    }
    fn known(&mut self, session: &str) -> &mut Value {
        self.sessions.entry(session.into()).or_insert(json!({"cwd":""}))
    }
    fn add(&mut self, hour: i64, model: &str, session: &str, counts: [f64; 5]) {
        let row = self.rows.entry(format!("{hour}\t{model}\t{session}")).or_insert([0.; 6]);
        for i in 0..5 {
            row[i] += counts[i];
        }
        row[5] += 1.;
    }
    /// Only complete lines with the exact Node markers are parsed. The caller retains an incomplete tail.
    pub fn feed(&mut self, buffer: &[u8]) {
        let markers: &[&str] = if self.provider == "claude" {
            &["\"type\":\"assistant\"", "\"type\":\"ai-title\"", "\"type\":\"custom-title\""]
        } else if self.provider == "codex" {
            &["\"token_count\"", "\"type\":\"turn_context\"", "\"type\":\"session_meta\""]
        } else {
            return;
        };
        for line in buffer.split_inclusive(|b| *b == b'\n') {
            if line.last() != Some(&b'\n') {
                continue;
            }
            let text = String::from_utf8_lossy(line);
            if !markers.iter().any(|m| text.contains(m)) {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<Value>(&text) {
                if self.provider == "claude" {
                    self.claude(&v);
                } else {
                    self.codex(&v);
                }
            }
        }
    }
    fn claude(&mut self, p: &Value) {
        if p["type"] == "ai-title" || p["type"] == "custom-title" {
            let title = prompt_title(p.get("customTitle").filter(|v| !v.is_null()).unwrap_or(&p["aiTitle"]));
            let session = text(&p["sessionId"]);
            if title.is_empty() || session.is_empty() {
                return;
            }
            let known = self.known(session);
            if p["type"] == "custom-title" || !truthy(&known["custom"]) {
                known["title"] = json!(title);
            }
            if p["type"] == "custom-title" {
                known["custom"] = json!(true);
            }
            return;
        }
        if p["type"] != "assistant" || !truthy(&p["message"]["usage"]) {
            return;
        }
        let message = &p["message"];
        let key = format!("{}:{}", js_string(&message["id"]), js_string(&p["requestId"]));
        let recent = array(&self.carry["recent"]);
        if key != ":" && recent.iter().any(|v| v == &key) {
            return;
        }
        let mut next = recent.iter().skip(recent.len().saturating_sub(15)).cloned().collect::<Vec<_>>();
        next.push(json!(key));
        self.carry["recent"] = json!(next);
        let model = text(&message["model"]);
        if model.is_empty() || model == "<synthetic>" {
            return;
        }
        let Some(at) = date(&p["timestamp"]) else { return };
        let usage = &message["usage"];
        let counts = [
            positive(&usage["input_tokens"]),
            positive(&usage["cache_read_input_tokens"]),
            positive(&usage["cache_creation_input_tokens"]),
            positive(&usage["output_tokens"]),
            positive(&usage["output_tokens_details"]["thinking_tokens"]),
        ];
        if counts[..4].iter().all(|n| *n == 0.) {
            return;
        }
        let session = p["sessionId"].as_str().unwrap_or(text(&self.carry["session"])).to_owned();
        if !session.is_empty() {
            let known = self.known(&session);
            if !truthy(&known["cwd"]) && p["cwd"].is_string() {
                known["cwd"] = p["cwd"].clone();
            }
            if known.get("milagre").is_none() {
                if let Some(e) = p["entrypoint"].as_str() {
                    known["milagre"] = json!(e.starts_with("sdk"));
                }
            }
        }
        self.add(at.div_euclid(HOUR), model, &session, counts);
    }
    fn codex(&mut self, p: &Value) {
        let payload = &p["payload"];
        if !truthy(payload) {
            return;
        }
        if p["type"] == "session_meta" {
            if truthy(&self.carry["thread"]) {
                return;
            }
            let thread = text(&payload["id"]);
            let parent = text(&payload["source"]["subagent"]["thread_spawn"]["parent_thread_id"]);
            let session = if parent.is_empty() { thread } else { parent };
            let cwd = text(&payload["cwd"]);
            self.carry["thread"] = json!(thread);
            self.carry["session"] = json!(session);
            self.carry["cwd"] = json!(cwd);
            self.carry["startedAt"] = json!(date(&p["timestamp"]).unwrap_or(0));
            if !session.is_empty() {
                self.sessions.entry(session.into()).or_insert(json!({"cwd":cwd,"milagre":payload["originator"]=="milagre"}));
            }
            return;
        }
        if p["type"] == "turn_context" {
            if !text(&payload["model"]).is_empty() {
                self.carry["model"] = payload["model"].clone();
            }
            return;
        }
        if p["type"] != "event_msg" || payload["type"] != "token_count" || !truthy(&payload["info"]) {
            return;
        }
        let Some(at) = date(&p["timestamp"]) else { return };
        let started = self.carry["startedAt"].as_i64().unwrap_or(0);
        if started != 0 && at < started {
            return;
        }
        let total = positive(&payload["info"]["total_token_usage"]["total_tokens"]);
        if total > 0. && total <= positive(&self.carry["total"]) {
            return;
        }
        if total > 0. {
            self.carry["total"] = json!(total);
        }
        let last = &payload["info"]["last_token_usage"];
        let model = text(&self.carry["model"]).to_owned();
        if !truthy(last) || model.is_empty() {
            return;
        }
        let read = positive(&last["cached_input_tokens"]);
        let write = positive(&last["cache_write_input_tokens"]);
        let counts = [
            (positive(&last["input_tokens"]) - read - write).max(0.),
            read,
            write,
            positive(&last["output_tokens"]),
            positive(&last["reasoning_output_tokens"]),
        ];
        if counts[..4].iter().all(|n| *n == 0.) {
            return;
        }
        let session = text(&self.carry["session"]).to_owned();
        self.add(at.div_euclid(HOUR), &model, &session, counts);
    }
    pub fn prune(&mut self, now: i64) {
        let oldest = (now - 400 * 24 * HOUR).div_euclid(HOUR);
        self.rows.retain(|key, _| key.split('\t').next().and_then(|h| h.parse::<i64>().ok()).is_none_or(|h| h >= oldest));
    }
}
pub fn prompt_title(v: &Value) -> String {
    let mut input = text(v).to_owned();
    let tag = regex::Regex::new(r"(?i)<([a-z_-]+)[^>]*>").unwrap();
    // Match each opening tag's corresponding closing tag, as the JS backreference does (not a general HTML parser).
    let mut output = String::new();
    loop {
        let mut found = None;
        for c in tag.captures_iter(&input) {
            let start = c.get(0).unwrap();
            let endtag = format!("</{}>", &c[1]);
            let tail = &input[start.end()..];
            if let Some(end) = tail.to_ascii_lowercase().find(&endtag.to_ascii_lowercase()) {
                found = Some((start.start(), start.end() + end + endtag.len()));
                break;
            }
        }
        if let Some((start, end)) = found {
            output.push_str(&input[..start]);
            output.push(' ');
            input = input[end..].to_owned();
        } else {
            output.push_str(&input);
            break;
        }
    }
    let line = output.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.encode_utf16().count() > 80 {
        format!("{}…", utf16_prefix(&line, 79).trim_end())
    } else {
        line
    }
}
pub fn rows(entries: &IndexMap<String, Entry>) -> Value {
    let mut titles = IndexMap::new();
    let mut milagre = std::collections::HashSet::new();
    for e in entries.values() {
        for (id, known) in &e.sessions {
            if truthy(&known["title"]) {
                titles.entry(id.clone()).or_insert(known["title"].clone());
            }
            if truthy(&known["milagre"]) {
                milagre.insert(id.clone());
            }
        }
    }
    let mut out = Vec::new();
    for e in entries.values() {
        for (key, row) in &e.rows {
            let parts = key.split('\t').collect::<Vec<_>>();
            if parts.len() < 3 {
                continue;
            }
            let s = parts[2];
            out.push(json!({"provider":e.provider,"hour":parts[0].parse::<i64>().unwrap_or(0),"model":parts[1],"session":s,"cwd":e.sessions.get(s).map(|v|text(&v["cwd"])).unwrap_or(""),"title":titles.get(s).cloned().unwrap_or(json!("")),"milagre":milagre.contains(s),"input":row[0],"cacheRead":row[1],"cacheWrite":row[2],"output":row[3],"reasoning":row[4],"requests":row[5]}));
        }
    }
    json!(out)
}

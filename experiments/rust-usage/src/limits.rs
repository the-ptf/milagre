//! Response mapping only. The runtime supplies already-read provider responses; no credentials or transports.
use crate::util::*;
use serde_json::{json, Value};

pub fn provider_result(provider: &str, now: i64, status: &str, windows: Value, message: Option<&str>) -> Value {
    let mut value = json!({"provider":provider,"status":status,"windows":windows,"updatedAt":iso(now)});
    if let Some(message) = message.filter(|s| !s.is_empty()) {
        value["message"] = json!(message);
    }
    value
}
fn window(id: &str, label: &str, short: &str, used: &Value, reset: &Value) -> Option<Value> {
    let percent = used.as_f64()?.clamp(0., 100.);
    Some(json!({"id":id,"label":label,"shortLabel":short,"usedPercent":percent,"resetsAt":reset.as_str()}))
}
pub fn claude_windows(body: &Value) -> Value {
    let mut windows = Vec::new();
    if let Some(limits) = body["limits"].as_array() {
        for limit in limits {
            let meta: (String, String, &str) = match text(&limit["kind"]) {
                "session" => ("session".into(), "Session".into(), "5h"),
                "weekly_all" => ("weekly".into(), "Weekly".into(), "wk"),
                "weekly_scoped" => {
                    let model = text(&limit["scope"]["model"]["display_name"]);
                    if model.is_empty() {
                        continue;
                    }
                    (format!("weekly:{}", model.to_lowercase()), model.into(), "wk")
                }
                _ => continue,
            };
            if let Some(w) = window(&meta.0, &meta.1, meta.2, &limit["percent"], &limit["resets_at"]) {
                windows.push(w);
            }
        }
        windows.sort_by_key(|w| match text(&w["id"]) {
            "session" => 0,
            "weekly" => 1,
            _ => 2,
        });
    } else {
        for (field, id, label, short) in [("five_hour", "session", "Session", "5h"), ("seven_day", "weekly", "Weekly", "wk")] {
            if let Some(w) = window(id, label, short, &body[field]["utilization"], &body[field]["resets_at"]) {
                windows.push(w);
            }
        }
    }
    json!(windows)
}
pub fn codex_windows(body: &Value) -> Value {
    let mut items: Vec<_> = ["primary", "secondary"]
        .iter()
        .map(|key| &body[*key])
        .filter(|item| item["usedPercent"].is_number() && item["windowDurationMins"].as_f64().is_some_and(|m| m > 0. && m.fract() == 0.))
        .collect();
    items.sort_by(|a, b| a["windowDurationMins"].as_f64().partial_cmp(&b["windowDurationMins"].as_f64()).unwrap());
    json!(items
        .into_iter()
        .filter_map(|item| {
            let mins = item["windowDurationMins"].as_f64()?;
            let (id, label, short) = if mins == 300. {
                ("session".into(), "Session".into(), "5h".into())
            } else if mins == 10080. {
                ("weekly".into(), "Weekly".into(), "wk".into())
            } else {
                let short = if mins % 1440. == 0. {
                    format!("{}d", mins / 1440.)
                } else if mins % 60. == 0. {
                    format!("{}h", mins / 60.)
                } else {
                    format!("{mins}m")
                };
                (format!("window:{mins}"), format!("{short} window"), short)
            };
            let reset = item["resetsAt"]
                .as_f64()
                .and_then(|s| chrono::DateTime::from_timestamp_millis((s * 1000.) as i64))
                .map(|d| iso(d.timestamp_millis()));
            window(&id, &label, &short, &item["usedPercent"], &json!(reset))
        })
        .collect::<Vec<_>>())
}
pub fn retry_after_ms(header: &Value, now: i64) -> i64 {
    let s = text(header).trim();
    let wait = if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) {
        s.parse::<f64>().ok().map(|n| n * 1000.)
    } else {
        date_str(s).map(|at| (at - now) as f64)
    };
    wait.filter(|n| *n > 0.).unwrap_or(300_000.).min(1_800_000.) as i64
}
pub fn banked(count: &Value) -> Option<Value> {
    count.as_f64().filter(|n| *n > 0. && n.fract() == 0.).map(|_| count.clone())
}
pub fn with_last_good(mut result: Value, last: &Value, now: i64) -> Value {
    if result["status"] != "error" || last.is_null() {
        return result;
    }
    let windows: Vec<_> = array(&last["windows"]).iter().filter(|w| live(w, now)).cloned().collect();
    if !windows.is_empty() {
        result["windows"] = json!(windows);
        result["updatedAt"] = last["updatedAt"].clone();
        if let Some(n) = banked(&last["bankedResets"]) {
            result["bankedResets"] = n;
        }
    }
    result
}
pub fn gemini_windows(body: &Value) -> Value {
    let groups = body
        .get("groups")
        .filter(|v| !v.is_null())
        .or_else(|| body["quotaSummary"].get("groups"))
        .or_else(|| body["summary"].get("groups"))
        .unwrap_or(&Value::Null);
    let mut result = Vec::new();
    for group in array(groups) {
        let buckets = array(&group["buckets"]);
        let name = group.get("displayName").filter(|v| !v.is_null()).unwrap_or(&group["name"]);
        if !text(name).to_lowercase().contains("gemini")
            && (buckets.is_empty() || !buckets.iter().all(|b| text(&b["bucketId"]).to_lowercase().starts_with("gemini")))
        {
            continue;
        }
        for bucket in buckets {
            if bucket["disabled"] == true {
                continue;
            }
            let id = text(&bucket["bucketId"]).to_lowercase();
            let length = bucket["window"].as_str().unwrap_or_else(|| id.rsplit('-').next().unwrap_or("")).to_lowercase();
            let (id, label, short) = match length.as_str() {
                "5h" => ("gemini:5h", "Gemini 5-hour", "5h"),
                "weekly" => ("gemini:weekly", "Gemini weekly", "wk"),
                _ => continue,
            };
            let Some(fraction) = bucket["remainingFraction"].as_f64() else { continue };
            let reset = if date(&bucket["resetTime"]).is_some() { bucket["resetTime"].clone() } else { Value::Null };
            result.push(window(id, label, short, &json!((1. - fraction) * 100.), &reset).unwrap());
        }
    }
    result.sort_by_key(|w| if w["id"] == "gemini:5h" { 0 } else { 1 });
    json!(result)
}
pub fn parse_kiro_usage(input: &str) -> Value {
    let output = regex::Regex::new("\u{1b}\\[[0-9;]*m").unwrap().replace_all(input, "");
    let re = regex::Regex::new(r"(?i)Credits\s*\(\s*([\d.,]+)\s+of\s+([\d.,]+)[^)]*\)\s*,?\s*([\d.]+)\s*%").unwrap();
    let Some(c) = re.captures(&output) else { return Value::Null };
    let used = c[1].replace(',', "").parse::<f64>().unwrap_or(f64::NAN);
    let total = c[2].replace(',', "").parse::<f64>().unwrap_or(f64::NAN);
    let percent = if total > 0. { used / total * 100. } else { c[3].parse().unwrap_or(f64::NAN) };
    let reset = regex::Regex::new(r"(?i)resets on (\d{4}-\d{2}-\d{2})").unwrap().captures(&output).and_then(|c| date_str(&c[1])).map(iso);
    let mut result = json!({"window":{"id":"kiro:month","label":"Kiro credits","shortLabel":"mo","usedPercent":percent.clamp(0.,100.),"resetsAt":reset,"detail":format!("{} of {} credits",plain(used),plain(total))}});
    if let Some(plan) = regex::Regex::new(r"(?i)Estimated Usage[^|\n]*\|[^|\n]*\|\s*([^\n]+)").unwrap().captures(&output) {
        result["plan"] = json!(plan[1].trim());
    }
    result
}
fn plain(n: f64) -> String {
    let raw = format!("{n:.2}");
    let raw = raw.trim_end_matches('0').trim_end_matches('.');
    let (whole, decimal) = raw.split_once('.').unwrap_or((raw, ""));
    let mut s = String::new();
    for (i, c) in whole.chars().enumerate() {
        if i > 0 && (whole.len() - i) % 3 == 0 {
            s.push(',');
        }
        s.push(c);
    }
    if !decimal.is_empty() {
        s.push('.');
        s.push_str(decimal);
    }
    s
}

/// Decodes an already-read Claude HTTP response. None means JSON decoding failed. Transport/auth stay with the owner.
pub fn claude_response(status: u16, body: Option<&Value>, retry: &Value, now: i64) -> Value {
    let error = |message: &str| provider_result("claude", now, "error", json!([]), Some(message));
    if status == 401 {
        return error("Claude sign-in expired. Running any Claude agent refreshes it.");
    }
    if status == 429 {
        let mut v = error("Claude is rate limiting usage checks.");
        v["retryAfterMs"] = json!(retry_after_ms(retry, now));
        return v;
    }
    if !(200..300).contains(&status) {
        return error(&format!("Claude usage failed (HTTP {status})."));
    }
    let Some(body) = body else { return error("Claude returned an unreadable usage response.") };
    let windows = claude_windows(body);
    if array(&windows).is_empty() {
        error("Claude returned no usage windows.")
    } else {
        provider_result("claude", now, "ok", windows, None)
    }
}

/// Offline Codex app-server protocol state. Drain outgoing JSON lines after start/feed; stop the process once result exists.
#[derive(Default)]
pub struct CodexUsage {
    buffer: Vec<u8>,
    outgoing: Vec<Value>,
    result: Option<Value>,
}
impl CodexUsage {
    pub fn new() -> Self {
        Self {
            outgoing: vec![
                json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"milagre","title":"Milagre","version":"0.1.0"}}}),
            ],
            ..Default::default()
        }
    }
    pub fn outgoing(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.outgoing)
    }
    pub fn result(&self) -> Option<&Value> {
        self.result.as_ref()
    }
    pub fn fail(&mut self, kind: &str, now: i64) {
        if self.result.is_some() {
            return;
        }
        let (status, message) = match kind {
            "missing" => ("unavailable", "Codex CLI not found."),
            "spawn" => ("error", "Codex could not start."),
            "error" => ("error", "Couldn't start Codex."),
            "timeout" => ("error", "Codex usage timed out."),
            _ => ("error", "Codex exited before reporting usage."),
        };
        self.result = Some(provider_result("codex", now, status, json!([]), Some(message)));
    }
    pub fn feed(&mut self, chunk: &[u8], now: i64) {
        if self.result.is_some() {
            return;
        }
        self.buffer.extend_from_slice(chunk);
        while let Some(end) = self.buffer.iter().position(|b| *b == b'\n') {
            let bytes: Vec<_> = self.buffer.drain(..=end).collect();
            let Ok(message) = serde_json::from_slice::<Value>(&bytes) else { continue };
            if self.result.is_some() {
                break;
            }
            let id = message["id"].as_u64();
            if truthy(&message["error"]) && matches!(id, Some(1..=3)) {
                self.result = Some(provider_result("codex", now, "error", json!([]), Some("Codex couldn't read usage.")));
                continue;
            }
            match id {
                Some(1) => {
                    self.outgoing.push(json!({"method":"initialized"}));
                    self.outgoing.push(json!({"id":2,"method":"account/read","params":{}}));
                }
                Some(2) => {
                    let account = &message["result"]["account"];
                    let msg = if !truthy(account) {
                        Some("Not signed in to Codex.")
                    } else if account["type"] != "chatgpt" {
                        Some("Codex plan limits need a ChatGPT sign-in.")
                    } else {
                        None
                    };
                    if let Some(msg) = msg {
                        self.result = Some(provider_result("codex", now, "unavailable", json!([]), Some(msg)));
                    } else {
                        self.outgoing.push(json!({"id":3,"method":"account/rateLimits/read"}));
                    }
                }
                Some(3) => {
                    let windows = codex_windows(&message["result"]["rateLimits"]);
                    let mut v = if array(&windows).is_empty() {
                        provider_result("codex", now, "error", json!([]), Some("Codex returned no usage windows."))
                    } else {
                        provider_result("codex", now, "ok", windows, None)
                    };
                    if v["status"] == "ok" {
                        if let Some(n) = banked(&message["result"]["rateLimitResetCredits"]["availableCount"]) {
                            v["bankedResets"] = n;
                        }
                    }
                    self.result = Some(v);
                }
                _ => {}
            }
        }
    }
}

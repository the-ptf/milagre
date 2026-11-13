use crate::util::*;
use serde_json::{json, Value};
fn rate(v: &Value) -> Option<f64> {
    v.as_f64().filter(|n| *n >= 0.)
}
pub fn slim_prices(catalog: &Value) -> Value {
    let mut models = json!({});
    if let Some(entries) = catalog.as_object() {
        for (name, entry) in entries {
            if name.contains('/') {
                continue;
            }
            if let (Some(input), Some(output)) = (rate(&entry["input_cost_per_token"]), rate(&entry["output_cost_per_token"])) {
                models[name] = json!({"input":input,"output":output,"cacheRead":rate(&entry["cache_read_input_token_cost"]).unwrap_or(input),"cacheWrite":rate(&entry["cache_creation_input_token_cost"]).unwrap_or(input)});
            }
        }
    }
    models
}
pub fn price_of<'a>(models: &'a Value, model: &str) -> Option<&'a Value> {
    if model.is_empty() {
        return None;
    }
    if let Some(v) = models.get(model).filter(|v| truthy(v)) {
        return Some(v);
    }
    let mut bare = model;
    for (i, c) in model.char_indices() {
        if c == '/' || c == '.' {
            let tail = &model[i + 1..];
            if tail.starts_with("claude-")
                || tail.starts_with("gpt-")
                || (tail.starts_with('o') && tail.as_bytes().get(1).is_some_and(u8::is_ascii_digit))
            {
                bare = tail;
            }
        }
    }
    if let Some(v) = models.get(bare).filter(|v| truthy(v)) {
        return Some(v);
    }
    static DATE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"-\d{8}$").unwrap());
    static DASHED_DATE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"-\d{4}-\d{2}-\d{2}$").unwrap());
    let undated = DATE.replace(bare, "");
    let undated = DASHED_DATE.replace(&undated, "");
    models.get(undated.as_ref()).filter(|v| !v.is_null())
}
/// Transport-independent refresh state. Runtime executes a fetch only after begin_refresh returns true.
#[derive(Default)]
pub struct Pricing {
    saved: Option<Value>,
    refreshing: bool,
    failed_at: Option<i64>,
}
impl Pricing {
    pub fn from_json(v: Value) -> Self {
        Self { saved: if v["fetchedAt"].is_string() && v["models"].is_object() { Some(v) } else { None }, ..Default::default() }
    }
    pub fn current(&self) -> Option<&Value> {
        self.saved.as_ref()
    }
    pub fn begin_refresh(&mut self, now: i64) -> bool {
        if self.refreshing || self.failed_at.is_some_and(|at| now - at < 900_000) {
            return false;
        }
        if self.saved.as_ref().is_some_and(|s| date(&s["fetchedAt"]).is_none_or(|at| now - at <= 24 * HOUR)) {
            return false;
        }
        self.refreshing = true;
        true
    }
    pub fn complete(&mut self, catalog: Option<&Value>, now: i64) -> bool {
        self.refreshing = false;
        let models = catalog.map(slim_prices).unwrap_or(json!({}));
        if models.as_object().is_none_or(|m| m.is_empty()) {
            self.failed_at = Some(now);
            return false;
        }
        self.saved = Some(json!({"fetchedAt":iso(now),"models":models}));
        true
    }
    pub fn status(&self, now: i64) -> Value {
        match &self.saved {
            None => json!({"status":if self.refreshing{"loading"}else{"unavailable"}}),
            Some(s) => {
                json!({"status":if date(&s["fetchedAt"]).is_some_and(|at|now-at>48*HOUR){"stale"}else{"ok"},"fetchedAt":s["fetchedAt"]})
            }
        }
    }
}

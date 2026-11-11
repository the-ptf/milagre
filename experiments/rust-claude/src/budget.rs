//! Conservative JSON heap accounting; no serialization buffer is allocated to measure an event.
use serde_json::{json, Value};
pub(crate) fn weight(value: &Value) -> usize {
    let payload = match value {
        Value::String(s) => s.len(),
        Value::Array(a) => a.iter().fold(0usize, |n, v| n.saturating_add(weight(v))),
        Value::Object(o) => o.iter().fold(0usize, |n, (k, v)| n.saturating_add(64 + k.len()).saturating_add(weight(v))),
        _ => 0,
    };
    64usize.saturating_add(payload)
}
pub(crate) fn failure(message: &str) -> Value {
    json!({"type":"turn-failed","code":"claude_event_limit","message":message})
}
pub(crate) fn is_failure(value: &Value) -> bool {
    value["code"] == "claude_event_limit"
}
/// Limits successful mapped output. Overflow returns one small, fixed-shape failure event.
#[derive(Clone, Copy, Debug)]
pub struct EventBudget {
    pub count: usize,
    pub bytes: usize,
}
impl Default for EventBudget {
    fn default() -> Self {
        Self { count: 1024, bytes: 8 * 1024 * 1024 }
    }
}
pub(crate) struct Batch {
    values: Vec<Value>,
    bytes: usize,
    budget: EventBudget,
    failed: bool,
}
impl Batch {
    pub fn new(budget: EventBudget) -> Self {
        Self { values: vec![], bytes: 0, budget, failed: false }
    }
    pub fn push(&mut self, event: Value) {
        if self.failed {
            return;
        }
        let bytes = weight(&event);
        if is_failure(&event) || self.values.len() >= self.budget.count || bytes > self.budget.bytes.saturating_sub(self.bytes) {
            self.failed = true;
            self.values.clear();
            self.values.push(if is_failure(&event) { event } else { failure("Claude mapped output exceeded its event budget.") });
        } else {
            self.bytes += bytes;
            self.values.push(event);
        }
    }
    pub fn extend(&mut self, events: impl IntoIterator<Item = Value>) {
        for event in events {
            self.push(event);
            if self.failed {
                break;
            }
        }
    }
    pub fn failed(&self) -> bool {
        self.failed
    }
    pub fn finish(self) -> Vec<Value> {
        self.values
    }
}

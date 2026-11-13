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
/// Only these internal causes can consume the queue's reserved failure slot.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BudgetFailure {
    Queue,
    Mapped,
    Subagents,
    Images,
}
impl BudgetFailure {
    pub fn event(self) -> Value {
        let message = match self {
            Self::Queue => "Claude session output exceeded its event count or byte budget.",
            Self::Mapped => "Claude mapped output exceeded its event budget.",
            Self::Subagents => "Claude subagent tracking exceeded its count or identity budget.",
            Self::Images => "Claude image work exceeded its event budget.",
        };
        json!({"type":"turn-failed","code":"claude_event_limit","message":message})
    }
}
pub(crate) type Mapped = Result<Vec<Value>, BudgetFailure>;
pub(crate) fn public_events(result: Mapped) -> Vec<Value> {
    result.unwrap_or_else(|failure| vec![failure.event()])
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
    failure: Option<BudgetFailure>,
}
impl Batch {
    pub fn new(budget: EventBudget) -> Self {
        Self { values: vec![], bytes: 0, budget, failure: None }
    }
    pub fn push(&mut self, event: Value) {
        if self.failed() {
            return;
        }
        let bytes = weight(&event);
        if self.values.len() >= self.budget.count || bytes > self.budget.bytes.saturating_sub(self.bytes) {
            self.fail(BudgetFailure::Mapped);
        } else {
            self.bytes += bytes;
            self.values.push(event);
        }
    }
    pub fn fail(&mut self, failure: BudgetFailure) {
        if self.failure.is_none() {
            self.failure = Some(failure);
        }
        self.values.clear();
    }
    pub fn push_result(&mut self, event: Result<Value, BudgetFailure>) {
        match event {
            Ok(event) => self.push(event),
            Err(failure) => self.fail(failure),
        }
    }
    pub fn merge(&mut self, events: Mapped) {
        match events {
            Ok(events) => self.extend(events),
            Err(failure) => self.fail(failure),
        }
    }
    pub fn extend(&mut self, events: impl IntoIterator<Item = Value>) {
        for event in events {
            self.push(event);
            if self.failed() {
                break;
            }
        }
    }
    pub fn failed(&self) -> bool {
        self.failure.is_some()
    }
    pub fn finish(self) -> Mapped {
        match self.failure {
            Some(failure) => Err(failure),
            None => Ok(self.values),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_typed_failures_use_the_reserved_error_shape() {
        for failure in [BudgetFailure::Queue, BudgetFailure::Mapped, BudgetFailure::Subagents, BudgetFailure::Images] {
            assert!(weight(&failure.event()) <= 1024);
        }
        let mut batch = Batch::new(EventBudget::default());
        let ordinary = json!({"code":"claude_event_limit","text":"x".repeat(5000)});
        batch.push(ordinary.clone());
        assert_eq!(batch.finish().unwrap(), [ordinary]);
        let mut batch = Batch::new(EventBudget { count: 1, bytes: 1024 });
        batch.push(json!({"code":"claude_event_limit","text":"x".repeat(5000)}));
        assert_eq!(batch.finish().unwrap_err(), BudgetFailure::Mapped);
    }
}

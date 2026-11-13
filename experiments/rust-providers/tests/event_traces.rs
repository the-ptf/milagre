//! The Rust event mapper replayed against every call the Node suites made to events.cjs
//! `mapCodexNotification` and subagents.cjs `settleSubagents` (scripts/record-codex-traces.cjs ->
//! tests/fixtures/conformance/codex-event-traces.json): same state in, same events and state out.

use milagre_providers::codex::events::{map_codex_notification, CodexEventState};
use milagre_providers::codex::subagents::settle_subagents;
use serde_json::{Map, Value};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

const OWNED: [&str; 14] = [
    "threadId",
    "turnId",
    "lastItemId",
    "hasText",
    "steps",
    "thinkingStarts",
    "compactions",
    "asyncMessages",
    "rateLimits",
    "subagents",
    "subagentActivityIds",
    "subagentRecheckUntil",
    "backgroundTaskStarts",
    "backgroundTasksKey",
];

/// The fields this mapper owns, with "absent", null, false and empty collections treated alike.
fn normalize(snapshot: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    for key in OWNED {
        let Some(value) = snapshot.get(key) else { continue };
        let empty = match value {
            Value::Null | Value::Bool(false) => true,
            Value::Object(map) => ["$map", "$set"].iter().any(|tag| map.get(*tag).and_then(Value::as_array).is_some_and(Vec::is_empty)),
            _ => false,
        };
        if !empty {
            out.insert(key.to_string(), value.clone());
        }
    }
    out
}

#[test]
fn replays_every_recorded_node_call() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/conformance/codex-event-traces.json")).unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert!(cases.len() > 400, "fixture has {} cases", cases.len());
    let mut failures = Vec::new();
    for (index, case) in cases.iter().enumerate() {
        let mut state = CodexEventState::from_snapshot(&case["before"]);
        let clock: Arc<Mutex<VecDeque<i64>>> =
            Arc::new(Mutex::new(case["clock"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap() as i64).collect()));
        let last = Arc::new(Mutex::new(0_i64));
        {
            let (clock, last) = (clock.clone(), last.clone());
            state.set_clock(move || {
                let next = clock.lock().unwrap().pop_front();
                let mut last = last.lock().unwrap();
                if let Some(next) = next {
                    *last = next;
                }
                *last
            });
        }
        let events = match case["fn"].as_str().unwrap() {
            "mapCodexNotification" => map_codex_notification(case["method"].as_str().unwrap(), &case["params"], &mut state),
            "settleSubagents" => settle_subagents(&mut state, case["status"].as_str().unwrap()),
            other => panic!("unknown fn {other}"),
        };
        let expected_events = case["events"].as_array().cloned().unwrap_or_default();
        let after_ok = normalize(&state.to_snapshot()) == normalize(&case["after"]);
        let clock_used = clock.lock().unwrap().is_empty();
        if events != expected_events || !after_ok || !clock_used {
            failures.push(format!(
                "case {index} {} {}\n  params: {}\n  expected: {}\n  actual:   {}\n  state ok: {after_ok}, clock fully read: {clock_used}\n  expected state: {}\n  actual state:   {}",
                case["fn"],
                case["method"],
                case["params"],
                Value::Array(expected_events),
                Value::Array(events),
                Value::Object(normalize(&case["after"])),
                Value::Object(normalize(&state.to_snapshot())),
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} cases differ:\n{}",
        failures.len(),
        cases.len(),
        failures.iter().take(5).cloned().collect::<Vec<_>>().join("\n\n")
    );
}

//! `ClaudeMapper` against `mapClaudeMessage` (events.cjs): each case replays Claude messages in order and
//! compares the events of every message with what the Node mapper produced (scripts/generate-events.cjs).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use milagre_claude::events::ClaudeMapper;
use serde_json::Value;

#[test]
fn mapper_matches_map_claude_message() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/conformance/claude-events.json")).unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert!(cases.len() >= 30);
    let mut failures = Vec::new();
    for case in cases {
        let clock = Arc::new(AtomicU64::new(0));
        let reader = clock.clone();
        let mut mapper = ClaudeMapper::new(Some(Arc::new(move || reader.load(Ordering::SeqCst))));
        mapper.turn_id = Some("turn-1".into());
        let initial = &case["initial"];
        mapper.session_id = initial["sessionId"].as_str().map(str::to_owned);
        mapper.suggestion_turn_id = initial["suggestionTurnId"].as_str().map(str::to_owned);
        for (index, step) in case["steps"].as_array().unwrap().iter().enumerate() {
            clock.store(step["at"].as_u64().unwrap(), Ordering::SeqCst);
            let events = Value::Array(match step["message"]["settle"].as_str() {
                Some(status) => mapper.settle_subagents(status),
                None => mapper.map(&step["message"]),
            });
            if step.get("events").is_some() && events != step["events"] {
                failures.push(format!(
                    "{} step {index}\n  message: {}\n  node:    {}\n  rust:    {}",
                    case["name"], step["message"], step["events"], events
                ));
            }
        }
    }
    assert!(failures.is_empty(), "{} mismatches:\n{}", failures.len(), failures.join("\n"));
}

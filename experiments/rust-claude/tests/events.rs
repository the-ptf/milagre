//! `ClaudeMapper` against `mapClaudeMessage` (events.cjs): each case replays Claude messages in order and
//! Inbound display-surrogate replacement intentionally differs from Node's retained UTF-16 units;
//! `inbound_text.rs` tests that boundary before the Value-based mapper, with its recorded field table.
//! This suite compares the events of every message with what the Node mapper produced (scripts/generate-events.cjs).

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
            let mut events = Value::Array(match step["message"]["settle"].as_str() {
                Some(status) => mapper.settle_subagents(status),
                None => mapper.map(&step["message"]),
            });
            // Intentional bounded-history extension: Node has only a row cap, no byte cap or marker.
            if step.get("events").is_some() && case["name"] == "child-transcript-byte-tail" && index >= 20 {
                let rust = events[0]["agent"]["transcript"].as_array().unwrap();
                let node = step["events"][0]["agent"]["transcript"].as_array().unwrap();
                assert!(!rust.is_empty() && rust.len() < node.len());
                assert_eq!(rust, &node[node.len() - rust.len()..]);
                assert_eq!(events[0]["agent"]["truncated"], true);
                // Check every other field against Node without comparing the deliberately omitted prefix.
                events[0]["agent"]["transcript"] = step["events"][0]["agent"]["transcript"].clone();
            }
            if (case["name"] == "child-transcript-tail" && index >= 101) || (case["name"] == "child-transcript-byte-tail" && index >= 20) {
                for event in events.as_array_mut().unwrap() {
                    if event["type"] == "subagent-update" {
                        assert_eq!(event["agent"]["truncated"], true);
                        event["agent"].as_object_mut().unwrap().remove("truncated");
                    }
                }
            }
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

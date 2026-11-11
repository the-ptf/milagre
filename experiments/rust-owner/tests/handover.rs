//! The handover formatting against Node's own handover.cjs (fixtures/handover-node.cjs over
//! fixtures/handover-cases.json, written by fixtures/make-handover-cases.py): transcripts with sender provenance,
//! tool steps (thinking left out), every divider and unknown or malformed contexts, catching up after an id, titles,
//! Link Chats; cuts at the first message and the tail in UTF-16 (halves of emoji kept); the framed brief with its
//! tags defused; transcript paths; the brief read from a model's reply or the minimal one. Where Node throws, Rust
//! refuses. Unpaired surrogates go both ways.

mod common;

use milagre_owner_store::handover::{
    brief_request, brief_text, cut_transcript, framed_brief, render_transcript, transcript_path,
    Clock, Zone,
};
use milagre_owner_store::jsjson;
use serde_json::{json, Map, Value};

/// `{ "$repeat": text, "$times": n }` and `{ "$concat": [...] }` as handover-node.cjs builds them (in UTF-16, so
/// halves that meet make a pair).
fn build(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(build).collect()),
        Value::Object(map) if map.contains_key("$repeat") => {
            let text = build(&map["$repeat"]);
            let times = map["$times"].as_u64().unwrap() as usize;
            Value::String(jsjson::from_utf16(
                &jsjson::to_utf16(text.as_str().unwrap()).repeat(times),
            ))
        }
        Value::Object(map) if map.contains_key("$concat") => {
            let mut units = Vec::new();
            for part in map["$concat"].as_array().unwrap() {
                units.extend(jsjson::to_utf16(build(part).as_str().unwrap()));
            }
            Value::String(jsjson::from_utf16(&units))
        }
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, item)| (key.clone(), build(item)))
                .collect::<Map<_, _>>(),
        ),
        other => other.clone(),
    }
}

const CLOCK: Clock = Clock {
    zone: Zone::Utc,
    now_ms: 0.0,
};

fn rust(case: &Value) -> Value {
    let field = |key: &str| case.get(key).filter(|value| !jsjson::is_undefined(value));
    let out = match case["op"].as_str().unwrap() {
        "render" => render_transcript(&case["state"], &case["sessionId"], field("after"), &CLOCK)
            .map(|transcript| json!({ "transcript": transcript, "cut": cut_transcript(&transcript) })),
        "cut" => Ok(json!({ "cut": cut_transcript(case["text"].as_str().unwrap()) })),
        "framed" => framed_brief(field("brief")).map(|framed| json!({ "framed": framed })),
        "path" => Ok(json!({ "path": transcript_path(
            case["dir"].as_str().unwrap(),
            case["projectPath"].as_str().unwrap(),
            &case["sessionId"],
        ) })),
        "brief" => {
            let catch_up = field("catchUp").and_then(Value::as_bool).unwrap_or(false);
            let transcript = case["transcript"].as_str().unwrap();
            let model = case.get("reply");
            let reply = model
                .filter(|_| !field("rejects").and_then(Value::as_bool).unwrap_or(false))
                .map(|reply| reply.as_str().unwrap());
            let files = if field("changedFilesFail").is_some() {
                Vec::new()
            } else {
                field("changedFiles").and_then(Value::as_array).cloned().unwrap_or_default()
            };
            let brief = brief_text(field("file"), field("provider"), catch_up, reply, field("lastUserMessage"), &files);
            let asked = model.map_or(Value::Null, |_| {
                let request = brief_request(transcript, catch_up);
                json!({ "system": request.system, "prompt": request.prompt })
            });
            Ok(json!({ "brief": brief, "asked": asked }))
        }
        other => panic!("unknown op {other}"),
    };
    out.unwrap_or_else(|_| json!({ "error": true }))
}

#[test]
fn handover_formatting_matches_node() {
    if common::node().is_none() {
        return;
    }
    let dir = common::crate_dir();
    let cases_file = dir.join("fixtures/handover-cases.json");
    let output = std::process::Command::new("node")
        .env("TZ", "UTC")
        .arg(dir.join("fixtures/handover-node.cjs"))
        .arg(&cases_file)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let expected = jsjson::parse_bytes(&output.stdout).unwrap();
    let cases = jsjson::parse_bytes(&std::fs::read(&cases_file).unwrap()).unwrap();
    let cases = cases.as_array().unwrap();
    let expected = expected.as_array().unwrap();
    assert_eq!(cases.len(), expected.len());
    let mut failures = Vec::new();
    for (index, (case, node)) in cases.iter().zip(expected).enumerate() {
        let rust = rust(&build(case));
        let (rust, node) = (jsjson::to_string(&rust), jsjson::to_string(node));
        if rust != node {
            let at = rust
                .bytes()
                .zip(node.bytes())
                .take_while(|(a, b)| a == b)
                .count();
            let from = at.saturating_sub(80);
            failures.push(format!(
                "case {index} ({}): differs at byte {at}\n  node …{}\n  rust …{}",
                case["op"],
                node.get(from..(at + 120).min(node.len())).unwrap_or(&node),
                rust.get(from..(at + 120).min(rust.len())).unwrap_or(&rust),
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} cases differ:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
    eprintln!("{} handover cases match Node", cases.len());
}

/// A Session looked up by a name every object has (`constructor`, `__proto__`) is refused instead of read through
/// `Object.prototype` (Node would render the prototype's function as a Session).
#[test]
fn a_session_named_like_a_prototype_property_is_refused() {
    for id in ["constructor", "__proto__", "toString"] {
        let state = json!({ "sessions": {}, "messages": [] });
        assert!(
            render_transcript(&state, &json!(id), None, &CLOCK).is_err(),
            "{id}"
        );
    }
    // An own property of that name is read as any other.
    let state = json!({ "sessions": { "constructor": { "title": "Own" } }, "messages": [] });
    let transcript = render_transcript(&state, &json!("constructor"), None, &CLOCK).unwrap();
    assert!(
        transcript.starts_with("# Chat transcript: Own\n"),
        "{transcript}"
    );
}

/// A Routine run with no time takes the clock's (Node reads the computer's clock there).
#[test]
fn a_routine_run_without_a_time_uses_the_clock() {
    let state = json!({
        "sessions": { "1": { "title": "T" } },
        "messages": [{ "session_id": 1, "role": "user", "body": "", "context": { "kind": "routine-run" } }],
    });
    let clock = Clock {
        zone: Zone::Utc,
        now_ms: 13.0 * 3_600_000.0 + 5.0 * 60_000.0,
    };
    let transcript = render_transcript(&state, &json!(1), None, &clock).unwrap();
    assert!(
        transcript.contains("## Heartbeat · 13:05\n"),
        "{transcript}"
    );
}

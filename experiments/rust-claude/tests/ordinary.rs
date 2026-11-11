//! The ordinary three-turn trace recorded from the actual Node SessionManager/ClaudeSession
//! (`tests/fixtures/conformance/claude-ordinary.json`), replayed through the actual Rust session
//! against the fake CLI. The fake child itself asserts argv, the TODO env flag, the private
//! system-prompt and settings file bytes, `initialize`, hook answers and the control order.
mod common;

use common::*;
use milagre_claude::ordinary::{node_trace, OrdinaryLaunch, OrdinaryTurn, SETTING_SOURCES};
use milagre_claude::session::{ClaudeSession, SessionEvents, SessionOptions};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::Duration;

fn skills() -> PathBuf {
    PathBuf::from(oracle()["bundle"]["skillsDir"].as_str().unwrap())
}

fn oracle() -> Value {
    serde_json::from_str(include_str!("fixtures/conformance/claude-ordinary.json")).unwrap()
}

fn script(query: &Value) -> Vec<Value> {
    let mut steps = node_trace::launch_steps(query).unwrap();
    let hooks = node_trace::hook_steps(query).unwrap();
    let turns = node_trace::control_steps(query["controls"].as_array().unwrap(), |index| {
        let mut frames = vec![json!({"emit":{"type":"system","subtype":"init","session_id":"fixture-session"}})];
        if index == 0 {
            frames.extend(hooks.clone());
        }
        frames.push(json!({"emit":{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ordinary reply"}}}}));
        frames.push(json!({"emit":{"type":"result","subtype":"success","num_turns":1,"result":"done"}}));
        frames
    })
    .unwrap();
    steps.extend(turns);
    steps
}

fn session(query: &Value, resume: Option<String>) -> (ClaudeSession, SessionEvents) {
    let (launch, _) = fake("ordinary", Value::Array(script(query)));
    let mut options = SessionOptions::new(launch);
    options.limits = quick_limits();
    options.resume_id = resume;
    let node = &query["options"];
    let hook = &query["subagentStart"]["hookSpecificOutput"]["additionalContext"];
    OrdinaryLaunch {
        system_append: node["systemPrompt"]["append"].as_str().unwrap().into(),
        subagent_context: hook.as_str().unwrap().into(),
        agents: node["agents"].as_object().unwrap().clone(),
        prompt_suggestions: node["promptSuggestions"].as_bool().unwrap(),
        additional_directories: vec![],
        skills_directory: skills(),
    }
    .apply(&mut options)
    .unwrap();
    assert_eq!(node["settingSources"], json!(SETTING_SOURCES));
    ClaudeSession::new(options)
}

async fn turn(session: &ClaudeSession, events: &mut SessionEvents, request: &Value, kinds: &mut Vec<String>) {
    let parsed = OrdinaryTurn::parse(request).unwrap();
    let start = session.start_turn(parsed.request(vec![json!({"type":"text","text":request["prompt"]})])).await.unwrap();
    assert!(start.turn_id.is_some() && !start.steered && !start.cancelled);
    loop {
        let event = tokio::time::timeout(Duration::from_secs(5), events.recv()).await.expect("event timed out").expect("session ended");
        let kind = event["type"].as_str().unwrap().to_owned();
        assert!(kind != "turn-failed" && kind != "turn-cancelled", "{event}");
        if ["turn-started", "session-started", "turn-completed"].contains(&kind.as_str()) {
            kinds.push(kind.clone());
        }
        if kind == "turn-completed" {
            return;
        }
    }
}

#[tokio::test]
async fn ordinary_three_turns_match_node_launch_options_and_control_order() {
    let oracle = oracle();
    let queries = oracle["queries"].as_array().unwrap();
    assert_eq!(queries.len(), 2, "TLDR change starts exactly one more native query");
    let base = &oracle["request"];
    let request = |turn: &Value| {
        let mut request = base.clone();
        for (key, value) in turn.as_object().unwrap() {
            request[key] = value.clone();
        }
        request
    };
    let turns = oracle["turns"].as_array().unwrap();
    let mut kinds = Vec::new();
    let (first, mut events) = session(&queries[0], None);
    turn(&first, &mut events, &request(&turns[0]), &mut kinds).await;
    let pid = first.pid().unwrap();
    // Concise -> Normal reuses the process (Node: same query, outputStyle null).
    turn(&first, &mut events, &request(&turns[1]), &mut kinds).await;
    assert_eq!(first.pid(), Some(pid));
    // TLDR off: the owner closes this session and resumes its native id in a new process.
    let native = first.native_id().unwrap();
    assert_eq!(Some(native.as_str()), queries[1]["options"]["resume"].as_str());
    first.close().await;
    assert!(events.recv().await.is_none());
    let (second, mut events) = session(&queries[1], Some(native));
    turn(&second, &mut events, &request(&turns[2]), &mut kinds).await;
    assert_ne!(second.pid(), Some(pid));
    second.close().await;
    assert_eq!(json!(kinds), oracle["events"]);
}

#[test]
fn every_recorded_node_option_and_control_is_mapped() {
    let oracle = oracle();
    for query in oracle["queries"].as_array().unwrap() {
        node_trace::launch_steps(query).unwrap();
        node_trace::control_steps(query["controls"].as_array().unwrap(), |_| vec![]).unwrap();
        let mut extra = query.clone();
        extra["options"]["mcpServers"] = json!({});
        assert!(node_trace::launch_steps(&extra).unwrap_err().contains("mcpServers"));
        let mut extra = query.clone();
        extra["functions"] = json!(["canUseTool", "spawnClaudeCodeProcess", "stderr"]);
        assert!(node_trace::launch_steps(&extra).is_err());
    }
    assert!(node_trace::control_steps(&[json!({"interrupt": []})], |_| vec![]).is_err());
}

/// Negative controls: one changed byte of the private prompt or settings file, a missing TODO env
/// flag, or a reply-style call in the wrong place fails inside the fake child.
#[tokio::test]
async fn the_fake_child_rejects_changed_prompt_settings_env_and_control_order() {
    let oracle = oracle();
    let query = &oracle["queries"][0];
    let request = {
        let mut request = oracle["request"].clone();
        for (key, value) in oracle["turns"][0].as_object().unwrap() {
            request[key] = value.clone();
        }
        request
    };
    type Mutation = Box<dyn Fn(&mut Value)>;
    let mutations: Vec<Mutation> = vec![
        Box::new(|q| {
            let append = q["options"]["systemPrompt"]["append"].as_str().unwrap().replacen("Milagre", "Milagrf", 1);
            q["options"]["systemPrompt"]["append"] = json!(append);
        }),
        Box::new(|q| q["settingsText"] = json!("{\"fastMode\":true}")),
        Box::new(|q| q["options"]["env"]["CLAUDE_CODE_ENABLE_TODO_TOOLS"] = json!("0")),
        Box::new(|q| {
            let controls = q["controls"].as_array_mut().unwrap();
            controls.swap(0, 1);
        }),
    ];
    for mutate in mutations {
        let mut expected = query.clone();
        mutate(&mut expected);
        let (launch, _) = fake("ordinary-negative", Value::Array(script(&expected)));
        let mut options = SessionOptions::new(launch);
        options.limits = quick_limits();
        let node = &query["options"];
        OrdinaryLaunch {
            system_append: node["systemPrompt"]["append"].as_str().unwrap().into(),
            subagent_context: query["subagentStart"]["hookSpecificOutput"]["additionalContext"].as_str().unwrap().into(),
            agents: node["agents"].as_object().unwrap().clone(),
            prompt_suggestions: true,
            additional_directories: vec![],
            skills_directory: skills(),
        }
        .apply(&mut options)
        .unwrap();
        let (session, mut events) = ClaudeSession::new(options);
        let parsed = OrdinaryTurn::parse(&request).unwrap();
        let _ = session.start_turn(parsed.request(vec![json!({"type":"text","text":request["prompt"]})])).await;
        let failed = loop {
            match tokio::time::timeout(Duration::from_secs(5), events.recv()).await.expect("event timed out") {
                Some(event) if event["type"] == "turn-completed" => break false,
                Some(event) if event["type"] == "turn-failed" => break true,
                Some(_) => continue,
                None => break true,
            }
        };
        assert!(failed, "mutation was not detected by the fake child");
        session.close().await;
    }
}

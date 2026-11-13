//! Permission modes and Project-Chat workspace access against `claude-modes.json`, recorded from the
//! actual Node SessionManager/ClaudeSession and `WorkspaceAccess` (`scripts/generate-session.cjs`).
//! The fake child asserts the launch mode, control order and every `can_use_tool` answer.
mod common;

use common::*;
use milagre_claude::ordinary::{node_trace, OrdinaryLaunch, OrdinaryTurn, ProjectAccess};
use milagre_claude::session::{AccessDecision, AccessPolicy, ClaudeSession, SessionOptions};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

fn oracle() -> Value {
    serde_json::from_str(include_str!("fixtures/conformance/claude-modes.json")).unwrap()
}

/// The fake CLI for the recorded query: launch/initialize checks, then per user message an init,
/// one Bash `can_use_tool` whose answer must equal Node's, a reply and a result.
fn script(oracle: &Value) -> Vec<Value> {
    let query = &oracle["queries"][0];
    let mut steps = node_trace::launch_steps(query).unwrap();
    let permissions = oracle["permissions"].as_array().unwrap().clone();
    steps.extend(
        node_trace::control_steps(query["controls"].as_array().unwrap(), |turn| {
            let p = &permissions[turn];
            let id = p["request"]["requestId"].clone();
            vec![
                json!({"emit":{"type":"system","subtype":"init","session_id":"fixture-session"}}),
                json!({"request":{"id":id,"request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"},"tool_use_id":p["request"]["toolUseID"]}}}),
                json!({"expect":{"type":"control_response","fields":{"/response/request_id":id,"/response/response":p["result"]}}}),
                json!({"emit":{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"mode reply"}}}}),
                json!({"emit":{"type":"result","subtype":"success","num_turns":1,"result":"done"}}),
            ]
        })
        .unwrap(),
    );
    steps
}

#[tokio::test]
async fn full_auto_ask_turns_match_node_launch_controls_cards_and_answers() {
    let oracle = oracle();
    let query = &oracle["queries"][0];
    assert_eq!(oracle["queries"].as_array().unwrap().len(), 1, "mode changes keep one native query");
    let (launch, _) = fake("modes", Value::Array(script(&oracle)));
    let mut options = SessionOptions::new(launch);
    options.limits = quick_limits();
    let node = &query["options"];
    OrdinaryLaunch {
        system_append: node["systemPrompt"]["append"].as_str().unwrap().into(),
        subagent_context: query["subagentStart"]["hookSpecificOutput"]["additionalContext"].as_str().unwrap().into(),
        agents: node["agents"].as_object().unwrap().clone(),
        prompt_suggestions: node["promptSuggestions"].as_bool().unwrap(),
        additional_directories: vec![],
        skills_directory: PathBuf::from(oracle["bundle"]["skillsDir"].as_str().unwrap()),
    }
    .apply(&mut options)
    .unwrap();
    let (session, mut events) = ClaudeSession::new(options);
    let mut cards = Vec::new();
    let mut kinds = Vec::new();
    for turn in oracle["turns"].as_array().unwrap() {
        let mut request = oracle["request"].clone();
        for (key, value) in turn.as_object().unwrap() {
            request[key] = value.clone();
        }
        let parsed = OrdinaryTurn::parse(&request).unwrap();
        let decision = match parsed.permission_mode.as_str() {
            "auto" => "allow",
            _ => "deny",
        };
        session.start_turn(parsed.request(vec![json!({"type":"text","text":request["prompt"]})])).await.unwrap();
        loop {
            let event = tokio::time::timeout(Duration::from_secs(5), events.recv()).await.expect("event timed out").expect("session ended");
            let kind = event["type"].as_str().unwrap().to_owned();
            assert!(kind != "turn-failed" && kind != "turn-cancelled", "{event}");
            if kind == "permission-request" {
                assert!(session.respond_to_permission(event["requestId"].as_str().unwrap(), decision));
            }
            if kind.starts_with("permission-") {
                cards.push(event.clone());
            }
            if ["turn-started", "session-started", "turn-completed"].contains(&kind.as_str()) {
                kinds.push(kind.clone());
            }
            if kind == "turn-completed" {
                break;
            }
        }
    }
    // Full answers without a card; Auto and Ask show Node's card and resolution exactly.
    assert_eq!(json!(cards), oracle["cards"]);
    assert_eq!(json!(kinds), oracle["events"]);
    session.close().await;
}

fn build_layout(root: &Path, layout: &Value) {
    for dir in layout["dirs"].as_array().unwrap() {
        std::fs::create_dir(root.join(dir.as_str().unwrap())).unwrap();
    }
    for file in layout["files"].as_array().unwrap() {
        std::fs::write(root.join(file.as_str().unwrap()), b"x").unwrap();
    }
    for link in layout["links"].as_array().unwrap() {
        std::os::unix::fs::symlink(link[1].as_str().unwrap(), root.join(link[0].as_str().unwrap())).unwrap();
    }
}

#[test]
fn project_workspace_access_matches_node_over_the_same_layout() {
    let oracle = oracle();
    let root = scratch("access");
    build_layout(&root, &oracle["access"]["layout"]);
    let root_text = root.to_str().unwrap();
    let fill = |text: &str| text.replace("<root>", root_text);
    let mut compared = 0;
    for case in oracle["access"]["cases"].as_array().unwrap() {
        let skills = case["skills"].as_str().map(fill).unwrap_or_else(|| format!("{root_text}/skills"));
        let access = ProjectAccess { cwd: root.join("project"), skills_directory: PathBuf::from(skills) };
        let files: Vec<String> = case["files"].as_array().unwrap().iter().map(|f| fill(f.as_str().unwrap())).collect();
        let actual = match access.answer(case["kind"].as_str().unwrap(), &files, case["mode"].as_str().unwrap()) {
            Some(AccessDecision::Allow { learn }) => json!({"decision":"allow","learn":learn}),
            Some(AccessDecision::Deny { message }) => json!({"decision":"deny","message":message}),
            None => Value::Null,
        };
        assert_eq!(actual, case["answer"], "{case}");
        compared += 1;
    }
    assert_eq!(compared, 61);
    std::fs::remove_dir_all(&root).unwrap();
}

/// Through the real permission handler: a Read inside the supplied skills directory is answered at
/// once in Ask (Node `WorkspaceAccess.answer` before any card), including `file_path: null` falling
/// through to `path` as `??` does; a Read outside asks with Node's card.
#[tokio::test]
async fn skills_reads_skip_the_card_in_ask_and_outside_reads_still_ask() {
    let root = scratch("skills-handler");
    std::fs::create_dir(root.join("skills")).unwrap();
    std::fs::write(root.join("skills/doc.md"), b"x").unwrap();
    let inside = root.join("skills/doc.md").to_str().unwrap().to_owned();
    let outside = root.join("elsewhere.md").to_str().unwrap().to_owned();
    let script = json!([
        {"expect":{"subtype":"initialize"}}, {"reply":{}},
        {"expect":{"subtype":"set_max_thinking_tokens"}}, {"reply":{}},
        {"expect":{"type":"user"}},
        {"emit":{"type":"system","subtype":"init","session_id":"s"}},
        {"request":{"id":"r1","request":{"subtype":"can_use_tool","tool_name":"Read","input":{"file_path":inside}}}},
        {"expect":{"type":"control_response","fields":{"/response/request_id":"r1","/response/response":{"behavior":"allow","updatedInput":{"file_path":inside}}}}},
        {"request":{"id":"r2","request":{"subtype":"can_use_tool","tool_name":"Grep","input":{"file_path":null,"path":inside}}}},
        {"expect":{"type":"control_response","fields":{"/response/request_id":"r2","/response/response/behavior":"allow"}}},
        {"request":{"id":"r3","request":{"subtype":"can_use_tool","tool_name":"Read","input":{"file_path":outside}}}},
        {"expect":{"type":"control_response","fields":{"/response/request_id":"r3","/response/response":{"behavior":"deny","message":"Denied in Milagre"}}}},
        {"emit":{"type":"result","subtype":"success","num_turns":1,"result":"done"}}
    ]);
    let (launch, _) = fake("skills-handler", script);
    let mut options = SessionOptions::new(launch);
    options.limits = quick_limits();
    OrdinaryLaunch {
        system_append: "x".into(),
        subagent_context: "y".into(),
        agents: json!({"qa":{"description":"d","prompt":"p"}}).as_object().unwrap().clone(),
        prompt_suggestions: false,
        additional_directories: vec![],
        skills_directory: root.join("skills"),
    }
    .apply(&mut options)
    .unwrap();
    let (session, mut events) = ClaudeSession::new(options);
    let turn = OrdinaryTurn::parse(&json!({"model":"sonnet","permissionMode":"ask"})).unwrap();
    session.start_turn(turn.request(vec![json!({"type":"text","text":"read"})])).await.unwrap();
    let mut cards = Vec::new();
    loop {
        let event = tokio::time::timeout(Duration::from_secs(5), events.recv()).await.expect("event timed out").expect("ended");
        if event["type"] == "permission-request" {
            assert!(session.respond_to_permission(event["requestId"].as_str().unwrap(), "deny"));
            cards.push(event["requestId"].clone());
        }
        assert_ne!(event["type"], "turn-failed", "{event}");
        if event["type"] == "turn-completed" {
            break;
        }
    }
    assert_eq!(cards, [json!("r3")], "only the read outside the skills directory asks");
    session.close().await;
    std::fs::remove_dir_all(&root).unwrap();
}

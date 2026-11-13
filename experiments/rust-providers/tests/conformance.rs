//! The Rust port against fixtures generated from the Node implementation
//! (scripts/generate-conformance.cjs -> tests/fixtures/conformance/codex-contract.json).

use milagre_providers::codex::approvals::{self, Decision, QuestionOutcome};
use milagre_providers::codex::protocol::{classify, codex_policy, Incoming, PermissionMode, RequestId};
use serde_json::{json, Value};

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/conformance/codex-contract.json")).expect("fixture parses")
}

fn id(value: &Value) -> RequestId {
    RequestId::from_value(value).unwrap()
}

fn null_if_none(value: Option<Value>) -> Value {
    value.unwrap_or(Value::Null)
}

#[test]
fn command_requests_match_node() {
    for case in fixture()["commandRequests"].as_array().unwrap() {
        let writes = case["writesRemote"].as_bool().unwrap();
        let actual = approvals::command_request(&id(&case["id"]), &case["params"], |_| writes);
        assert_eq!(actual, case["expected"], "params {}", case["params"]);
    }
}

#[test]
fn file_requests_match_node() {
    for case in fixture()["fileRequests"].as_array().unwrap() {
        let actual = approvals::file_request(&id(&case["id"]), &case["params"], case["changes"].as_array().unwrap());
        assert_eq!(actual, case["expected"], "params {} changes {}", case["params"], case["changes"]);
    }
}

#[test]
fn mcp_requests_match_node() {
    for case in fixture()["mcpRequests"].as_array().unwrap() {
        let actual = null_if_none(approvals::mcp_request(&id(&case["id"]), &case["params"]));
        assert_eq!(actual, case["expected"], "params {}", case["params"]);
    }
}

#[test]
fn ungated_milagre_tools_match_node() {
    for case in fixture()["ungatedApprovals"].as_array().unwrap() {
        let actual = approvals::is_ungated_milagre_tool_approval(&case["params"], approvals::MILAGRE_UNGATED_TOOLS);
        assert_eq!(Value::Bool(actual), case["expected"], "message {}", case["params"]["message"]);
    }
}

#[test]
fn decisions_match_node() {
    for case in fixture()["decisions"].as_array().unwrap() {
        let decision = Decision::parse(case["decision"].as_str().unwrap()).unwrap();
        assert_eq!(json!(approvals::codex_decision(decision)), case["codex"]);
        assert_eq!(approvals::mcp_response(decision), case["mcp"]);
    }
}

#[test]
fn question_requests_and_responses_match_node() {
    let fixture = fixture();
    for case in fixture["questionRequests"].as_array().unwrap() {
        let actual = null_if_none(approvals::question_request(&id(&case["id"]), &case["params"]));
        assert_eq!(actual, case["expected"], "params {}", case["params"]);
    }
    for case in fixture["questionResponses"].as_array().unwrap() {
        let outcome = match case["outcome"].as_str().unwrap() {
            "answered" => QuestionOutcome::Answered(
                case["answers"]
                    .as_object()
                    .unwrap()
                    .iter()
                    .map(|(k, v)| (k.clone(), v.as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_string()).collect()))
                    .collect(),
            ),
            "dismissed" => QuestionOutcome::Dismissed,
            _ => QuestionOutcome::Cancelled,
        };
        assert_eq!(approvals::question_response(&outcome), case["expected"]);
    }
}

#[test]
fn policies_match_node() {
    for case in fixture()["policies"].as_array().unwrap() {
        let roots: Vec<String> = case["roots"].as_array().unwrap().iter().map(|r| r.as_str().unwrap().to_string()).collect();
        let policy = codex_policy(
            PermissionMode::parse(case["mode"].as_str().unwrap()).unwrap(),
            case["cwd"].as_str().unwrap(),
            &roots,
            case["guarded"].as_bool().unwrap(),
            case["readOnly"].as_bool().unwrap(),
        );
        let actual = json!({ "approvalPolicy": policy.approval_policy, "sandbox": policy.sandbox, "sandboxPolicy": policy.sandbox_policy });
        assert_eq!(actual, case["expected"], "case {case}");
    }
}

/// Frames classified as codex-rpc.cjs `handleLine` does, given pending requests 1 (m1), 2 (m2), 3 (m3).
#[test]
fn frames_classify_like_node() {
    for case in fixture()["frames"].as_array().unwrap() {
        let line = case["line"].as_str().unwrap();
        let expected = &case["expected"];
        let actual = match serde_json::from_str::<Value>(line).map(|v| classify(&v)) {
            Err(_) | Ok(Incoming::Invalid { .. }) => json!({ "kind": "ignored" }),
            Ok(Incoming::Request { id, method, params }) => {
                json!({ "kind": "request", "id": id.to_value(), "method": method, "params": params })
            }
            Ok(Incoming::Notification { method, params }) => json!({ "kind": "notification", "method": method, "params": params }),
            Ok(Incoming::Response { id, outcome }) => {
                let method = match &id {
                    RequestId::Int(1) => "m1",
                    RequestId::Int(2) => "m2",
                    RequestId::Int(3) => "m3",
                    // Nobody waits on it: the transport reports it as unmatched, Node ignores it.
                    _ => {
                        assert_eq!(expected, &json!({ "kind": "ignored" }), "line {line}");
                        continue;
                    }
                };
                match outcome {
                    Ok(result) => json!({ "kind": "response", "id": id.to_value(), "result": result }),
                    Err(error) => {
                        let message = if error.message.is_empty() { format!("Codex {method} failed.") } else { error.message };
                        json!({ "kind": "error", "id": id.to_value(), "message": message, "code": error.code })
                    }
                }
            }
        };
        assert_eq!(&actual, expected, "line {line}");
    }
}

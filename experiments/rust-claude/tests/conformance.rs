//! The Rust ports in `milagre_claude::milagre` against fixtures generated from Milagre's Node code
//! (scripts/generate-conformance.cjs). A mismatch means the Rust card or result would differ from
//! what the desktop and phone render today.

use milagre_claude::milagre::{self, Decision, QuestionOutcome};
use milagre_claude::PermissionRequest;
use serde_json::{json, Value};

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/conformance/claude-contract.json")).unwrap()
}

fn parsed(case: &Value) -> PermissionRequest {
    PermissionRequest::from_request(case["request_id"].as_str().unwrap(), &case["request"]).unwrap()
}

#[test]
fn messages_match() {
    let f = fixture();
    assert_eq!(f["messages"]["DENIED_MESSAGE"], milagre::DENIED_MESSAGE);
    assert_eq!(f["messages"]["CANCELLED_MESSAGE"], milagre::CANCELLED_MESSAGE);
    assert_eq!(f["messages"]["DISMISSED_MESSAGE"], milagre::DISMISSED_MESSAGE);
    assert_eq!(f["messages"]["UNSHOWN_MESSAGE"], milagre::UNSHOWN_MESSAGE);
}

#[test]
fn permission_cards_match_claude_request() {
    let f = fixture();
    let cases = f["permissionCards"].as_array().unwrap();
    assert!(cases.len() >= 20);
    for case in cases {
        assert_eq!(milagre::permission_card(&parsed(case)), case["expected"], "case {}", case["name"]);
    }
}

#[test]
fn permission_results_match_claude_result() {
    let f = fixture();
    for case in f["permissionResults"].as_array().unwrap() {
        let decision = Decision::parse(case["decision"].as_str().unwrap()).unwrap();
        let result = milagre::permission_result(decision, &case["input"], case["suggestions"].as_array().unwrap());
        assert_eq!(serde_json::to_value(&result).unwrap(), case["expected"], "decision {} {}", case["decision"], case["suggestions"]);
        // On the wire nothing changes: updatedInput is already explicit.
        assert_eq!(result.to_payload(&json!({"other": true})), case["expected"]);
    }
}

#[test]
fn question_cards_match_claude_question_request() {
    let f = fixture();
    for case in f["questionCards"].as_array().unwrap() {
        let card = milagre::question_card(&parsed(case)).unwrap_or(Value::Null);
        assert_eq!(card, case["expected"], "case {}", case["name"]);
    }
}

#[test]
fn question_results_match_claude_question_result() {
    let f = fixture();
    for case in f["questionResults"].as_array().unwrap() {
        let outcome = match case["outcome"].as_str().unwrap() {
            "answered" => QuestionOutcome::Answered,
            "dismissed" => QuestionOutcome::Dismissed,
            "cancelled" => QuestionOutcome::Cancelled,
            _ => QuestionOutcome::Unshown,
        };
        let result = milagre::question_result(outcome, &case["input"], case["answers"].as_object().unwrap());
        assert_eq!(serde_json::to_value(&result).unwrap(), case["expected"], "case {}", case["name"]);
    }
}

#[test]
fn settled_answers_match_pending_questions() {
    let f = fixture();
    for case in f["settleCases"].as_array().unwrap() {
        let (outcome, answers) = milagre::settle_answers(&case["card"], case["answers"].as_object().unwrap());
        let outcome = match outcome {
            QuestionOutcome::Answered => "answered",
            QuestionOutcome::Dismissed => "dismissed",
            _ => unreachable!(),
        };
        assert_eq!(json!({ "outcome": outcome, "answers": answers }), case["expected"], "case {}", case["name"]);
    }
}

/// `userMessage` in claude-provider.cjs is not exported; its shape is fixed here by hand.
#[test]
fn user_message_shape() {
    let content = milagre::user_content(&[
        milagre::PromptPart::Text("Look at this".into()),
        milagre::PromptPart::Image { mime: "image/png".into(), base64: "AAAA".into() },
    ]);
    assert_eq!(
        milagre_claude::protocol::user_message("u-1", content),
        json!({"type": "user", "uuid": "u-1", "message": {"role": "user", "content": [
            {"type": "text", "text": "Look at this"},
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AAAA"}}
        ]}, "parent_tool_use_id": null})
    );
}

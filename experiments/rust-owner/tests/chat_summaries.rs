//! `summarize_chat` against Node's own `summarizeChat` (packages/shared/src/chat-summary.mjs) over the same messages:
//! titles (trimmed, first line, cut at 200 UTF-16 units inside an emoji), images, notes, the last reply's outcome,
//! models, open handoffs, client ids (last five), Linear cards and the PRs shell steps created or merged.

mod common;

use std::process::Command;

use milagre_owner_store::chat_summaries::summarize_chat;
use milagre_owner_store::message_store::Msg;
use serde_json::{json, Value};

fn shell(detail: &str, status: &str) -> Value {
    json!({ "kind": "shell", "status": status, "title": "sh", "detail": detail })
}

fn cases() -> Vec<Value> {
    let long = format!("{}\u{1F600} tail", "x".repeat(199));
    vec![
        json!([]),
        json!([{ "id": 1, "session_id": 1, "role": "user", "body": "   \n  " }, { "id": 2, "session_id": 1, "role": "user", "body": format!("\t{long}\nsecond") }]),
        json!([
            { "id": 1, "role": "user", "body": "Ship it", "images": "ab", "model": "m1", "clientMessageId": "a" },
            { "id": 2, "role": "assistant", "body": "", "outcome": "completed", "steps": [
                shell("$ gh pr create --fill\nhttps://github.com/acme/app/pull/12", "done"),
                shell("$ gh pr create\nhttps://github.com/acme/app/pull/99", "failed"),
                shell("$ gh pr merge 12 && gh pr merge \"--body\" x 13 -R acme/app; gh pr merge --squash https://github.com/o/r/pull/3", "done"),
                shell("$ gh pr merge feature-branch", "done"),
                shell("$ gh pr merge -R acme/web 21 --squash", "done"),
                shell("gh pr merge 4", "done"),
            ] },
            { "id": 3, "role": "assistant", "body": "note", "context": { "kind": "git-action" }, "outcome": "failed" },
            { "id": 4, "role": "assistant", "body": "", "context": { "kind": "handoff", "status": "preparing" } },
            { "id": 5, "role": "user", "body": "b", "model": "", "clientMessageId": "b" },
        ]),
        json!([
            { "id": 7, "role": "user", "body": "", "context": { "kind": "linear-issue", "key": "ENG-9", "workspace": "" } },
            { "id": 8, "role": "assistant", "steps": { "kind": "shell", "status": "done", "detail": "$ gh pr merge 5 --repo bad/repo/x" } },
            { "id": 9, "role": "assistant", "outcome": 0, "context": { "kind": "handoff", "status": "preparing" }, "clientMessageId": "c" },
        ]),
        json!((1..=8).map(|n| json!({ "id": n, "role": "user", "body": format!("m{n}"), "clientMessageId": format!("id{n}") })).collect::<Vec<_>>()),
    ]
}

#[test]
fn summaries_match_nodes_summarize_chat() {
    let Some(node) = common::node() else { return };
    let module = common::crate_dir().join("../../packages/shared/src/chat-summary.mjs");
    let module = std::fs::canonicalize(module).unwrap();
    let cases = Value::Array(cases());
    let script = format!(
        "import {{ summarizeChat }} from {};\nconst cases = JSON.parse(process.argv[1]);\nprocess.stdout.write(JSON.stringify(cases.map((messages) => summarizeChat(messages))));",
        serde_json::to_string(&format!("file://{}", module.display())).unwrap()
    );
    let output = Command::new(node)
        .args(["--input-type=module", "-e", &script, &cases.to_string()])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let expected =
        milagre_owner_store::jsjson::parse(&String::from_utf8(output.stdout).unwrap()).unwrap();
    let expected = expected.as_array().unwrap().clone();
    assert_eq!(expected.len(), cases.as_array().unwrap().len());
    for (index, (case, expected)) in cases.as_array().unwrap().iter().zip(expected).enumerate() {
        let messages: Vec<_> = case
            .as_array()
            .unwrap()
            .iter()
            .cloned()
            .map(Msg::new)
            .collect();
        let rust = Value::Object(summarize_chat(&messages));
        assert_eq!(rust, expected, "case {index}");
    }
}

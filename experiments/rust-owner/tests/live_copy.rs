//! Opt-in check against a copy of a real Project (see fixtures/node-cases.cjs). Ignored by default: it needs a copy
//! made by hand and Node's recorded answers for it.

use std::path::PathBuf;

use milagre_owner_store::commands::{PageOptions, ProjectReader};
use milagre_owner_store::jsjson;
use milagre_owner_store::{MessageRepository, ProjectRepository, ProjectStore};
use serde_json::Value;

#[test]
#[ignore = "needs MILAGRE_OWNER_COPY and MILAGRE_OWNER_CASES"]
fn live_copy_matches_node() {
    let copy = PathBuf::from(std::env::var("MILAGRE_OWNER_COPY").expect("MILAGRE_OWNER_COPY"));
    let cases: Value = serde_json::from_slice(
        &std::fs::read(std::env::var("MILAGRE_OWNER_CASES").expect("MILAGRE_OWNER_CASES")).unwrap(),
    )
    .unwrap();
    let reader = ProjectReader::new(ProjectStore::new(&copy));
    let placeholder = |text: String| text.replace(&copy.display().to_string(), "<project>");
    let mut failures = Vec::new();
    let mut compared = 0;
    for case in cases["cases"].as_array().unwrap() {
        let args = case["args"].as_array().unwrap();
        let rust = match case["kind"].as_str().unwrap() {
            "state" => jsjson::to_string(&reader.store().read_project_state().unwrap().state),
            "chat:messages" => jsjson::to_string(
                &reader
                    .chat_messages(
                        args[0].as_i64().unwrap(),
                        &PageOptions::from_value(Some(&args[1])),
                    )
                    .unwrap(),
            ),
            "previews" => {
                let chats: Vec<i64> = args[0]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(Value::as_i64)
                    .collect();
                let previews = reader.store().chats().read_chat_previews(&chats).unwrap();
                format!(
                    "[{}]",
                    previews
                        .iter()
                        .map(|preview| preview.to_js_json())
                        .collect::<Vec<_>>()
                        .join(",")
                )
            }
            "chat:send-status" => {
                jsjson::to_string(&reader.send_status(args[0].as_str().unwrap()).unwrap())
            }
            "chat:message" => jsjson::to_string(&reader.chat_message(&args[0]).unwrap()),
            other => panic!("unknown case {other}"),
        };
        let rust = placeholder(rust);
        let node = case["node"].as_str().unwrap();
        compared += 1;
        if rust != node {
            let at = rust
                .bytes()
                .zip(node.bytes())
                .position(|(a, b)| a != b)
                .unwrap_or(rust.len().min(node.len()));
            let from = at.saturating_sub(80);
            failures.push(format!(
                "{} {}: differs at byte {at}\n  node: …{}\n  rust: …{}",
                case["kind"],
                jsjson::to_string(&case["args"])
                    .chars()
                    .take(80)
                    .collect::<String>(),
                &node[from..(at + 120).min(node.len())],
                &rust[from..(at + 120).min(rust.len())]
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {compared} differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
    eprintln!("{compared} live-copy cases match byte for byte");
}

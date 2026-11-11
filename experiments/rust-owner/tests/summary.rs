//! summarizeStep and capOutput against Node's own (fixtures/summary-node.mjs over fixtures/summary-cases.json): test
//! counts, totals, failure reasons, edits, result counts, terminal escapes and carriage returns, JavaScript line ends
//! (U+2028, U+2029) and whitespace, ASCII-only case folding, and UTF-16 slicing.

mod common;

use milagre_owner_store::jsjson;
use milagre_owner_store::tool_activity::{cap_output, summarize_step};
use serde_json::{json, Value};

#[test]
fn summaries_match_node() {
    if common::node().is_none() {
        return;
    }
    let dir = common::crate_dir();
    let cases_file = dir.join("fixtures/summary-cases.json");
    let output = std::process::Command::new("node")
        .arg(dir.join("fixtures/summary-node.mjs"))
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
    let mut failures = Vec::new();
    for (index, (case, node)) in cases
        .as_array()
        .unwrap()
        .iter()
        .zip(expected.as_array().unwrap())
        .enumerate()
    {
        let capped = match case.get("detail") {
            Some(Value::String(detail)) => json!(cap_output(detail)),
            _ => Value::Null,
        };
        let rust = json!({ "summary": Value::Object(summarize_step(case.as_object().unwrap())), "capped": capped });
        if jsjson::to_string(&rust) != jsjson::to_string(node) {
            failures.push(format!(
                "case {index}: node {} rust {}",
                jsjson::to_string(&node["summary"]),
                jsjson::to_string(&rust["summary"])
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    eprintln!(
        "{} summarizeStep cases match Node",
        cases.as_array().unwrap().len()
    );
}

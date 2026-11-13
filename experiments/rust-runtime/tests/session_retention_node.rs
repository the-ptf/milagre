//! Guards for the recorded actual Node SessionManager oracle. These validate source provenance and its explicit
//! synthetic-session decisions, not Rust/native execution equivalence. Regenerate/check fresh Node output with
//! session-retention-node.cjs --check.
use std::path::Path;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn oracle() -> Value {
    serde_json::from_str(include_str!("../fixtures/session-retention-node.json")).unwrap()
}

fn case<'a>(oracle: &'a Value, name: &str) -> &'a Value {
    oracle["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == name)
        .unwrap_or_else(|| panic!("missing oracle case {name}"))
}

fn starts(case: &Value) -> Vec<&Value> {
    case["steps"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|step| step["action"] == "start")
        .collect()
}

#[test]
fn retention_oracle_names_exact_current_node_sources() {
    let oracle = oracle();
    assert_eq!(oracle["schema"], 1);
    assert!(oracle["scope"].as_str().unwrap().contains("synthetic"));
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let sources = oracle["sources"].as_object().unwrap();
    assert_eq!(sources.len(), 9);
    for (source, expected) in sources {
        assert!(
            source.starts_with("packages/")
                || source == "experiments/rust-runtime/fixtures/session-retention-node.cjs"
        );
        assert!(!source.split('/').any(|piece| piece == ".."));
        let bytes = std::fs::read(root.join(source)).unwrap();
        assert_eq!(hex::encode(Sha256::digest(bytes)), expected.as_str().unwrap(),
            "{source} changed: run the explicit Node oracle generator, review its decisions, then --check");
    }
    assert_eq!(oracle["cases"].as_array().unwrap().len(), 15);
    let active: Vec<&str> = oracle["predicate"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["active"] == true)
        .map(|entry| entry["status"].as_str().unwrap())
        .collect();
    assert_eq!(active, ["initializing", "running", "waiting"]);
    for (provider, flags) in oracle["capabilities"].as_object().unwrap() {
        assert_eq!(flags["backgroundSubagents"], provider == "claude");
    }
}

#[test]
fn recorded_child_and_task_retention_defers_both_tldr_directions_until_settlement() {
    let oracle = oracle();
    let off = case(&oracle, "background-retention");
    let turns = starts(off);
    assert_eq!(
        turns
            .iter()
            .map(|turn| turn["snapshot"]["session"].clone())
            .collect::<Vec<_>>(),
        json!([1, 1, 1, 1, 2]).as_array().unwrap().clone()
    );
    assert_eq!(
        turns
            .iter()
            .map(|turn| turn["snapshot"]["tldrEnabled"].clone())
            .collect::<Vec<_>>(),
        json!([true, true, true, true, false])
            .as_array()
            .unwrap()
            .clone()
    );
    assert_eq!(turns[1]["snapshot"]["backgroundWork"], 2);
    assert_eq!(turns[2]["snapshot"]["backgroundTasks"], json!(["task"]));
    assert_eq!(turns[2]["snapshot"]["activeChildren"], json!([]));
    assert_eq!(turns[3]["snapshot"]["backgroundChildren"], json!(["child"]));
    assert_eq!(turns[3]["snapshot"]["backgroundTasks"], json!([]));
    assert_eq!(turns[4]["snapshot"]["resumeId"], "native-1");
    let closed = &off["steps"].as_array().unwrap().last().unwrap()["snapshot"];
    assert_eq!(closed["session"], Value::Null);
    assert_eq!(closed["backgroundWork"], 0);
    assert_eq!(closed["closed"], json!([1, 2]));

    let on = starts(case(&oracle, "background-retention-tldr-on"));
    assert_eq!(
        on.iter()
            .map(|turn| turn["snapshot"]["session"].clone())
            .collect::<Vec<_>>(),
        json!([1, 1, 1, 2]).as_array().unwrap().clone()
    );
    assert_eq!(on[1]["snapshot"]["tldrEnabled"], false);
    assert_eq!(on[2]["snapshot"]["tldrEnabled"], false);
    assert_eq!(on[3]["snapshot"]["tldrEnabled"], true);
    assert_eq!(on[3]["request"]["resumeId"], "stale-request-native");
    assert_eq!(on[3]["snapshot"]["resumeId"], "native-1");
    let foreground = starts(case(&oracle, "foreground-retains-tldr-on"));
    assert_eq!(foreground[1]["snapshot"]["session"], 1);
    assert_eq!(foreground[1]["snapshot"]["backgroundWork"], 0);
    assert_eq!(
        foreground[1]["snapshot"]["activeChildren"],
        json!(["child"])
    );
    assert_eq!(foreground[2]["snapshot"]["session"], 2);
}

#[test]
fn recorded_manager_distinguishes_background_switches_from_foreground_and_stale_events() {
    let oracle = oracle();
    for kind in ["provider", "folder", "workspace"] {
        let foreground = starts(case(&oracle, &format!("foreground-{kind}-switch")));
        assert_eq!(foreground[1]["snapshot"]["session"], 2, "foreground {kind}");
        assert_eq!(foreground[1]["snapshot"]["resumeId"], "request-native");
        let background = starts(case(&oracle, &format!("background-{kind}-switch")));
        assert_eq!(background[1]["snapshot"]["session"], 1, "background {kind}");
        assert_eq!(
            background[1]["result"]["error"].is_string(),
            kind != "workspace"
        );
        assert_eq!(background[2]["snapshot"]["session"], 2);
    }
    let duplicate = &case(&oracle, "duplicates-and-snapshot-replacement")["steps"];
    assert_eq!(duplicate[2]["snapshot"]["activeChildren"], json!(["child"]));
    assert_eq!(
        duplicate[5]["snapshot"]["backgroundTasks"],
        json!(["a", "b"])
    );
    assert_eq!(
        duplicate[6]["snapshot"]["backgroundTasks"],
        json!(["b", "c"])
    );
    assert_eq!(
        duplicate[10]["snapshot"]["activeChildren"],
        json!(["nested"])
    );
    assert_eq!(duplicate[13]["snapshot"]["backgroundWork"], 0);
    let stale = &case(&oracle, "stale-entry-events-ignored")["steps"];
    for index in 3..=5 {
        assert_eq!(stale[index]["snapshot"], stale[2]["snapshot"]);
    }
    assert_eq!(stale[8]["snapshot"], stale[7]["snapshot"]);
    assert_eq!(stale[9]["snapshot"], stale[8]["snapshot"]);
    let partial = case(&oracle, "partial-child-snapshot-boundary");
    assert!(partial["boundaryNote"]
        .as_str()
        .unwrap()
        .contains("not patches"));
    assert_eq!(partial["steps"][3]["snapshot"]["activeChildren"], json!([]));
    assert_eq!(
        partial["steps"][3]["snapshot"]["backgroundChildren"],
        json!(["child"])
    );
    assert!(partial["steps"][4]["result"]["error"].is_string());
}

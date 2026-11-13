//! Parity with the TS: `vectors.json` holds `applyDesignOperations`, `diffDesignDocuments` and the preview
//! controller's `snap` as node computed them (`generate.mjs`) for `cases.json` and edits of every fixture design.
//! Regenerate it after changing either; a mismatch here is this port drifting from the desktop.

use std::collections::HashSet;

use serde_json::{Value, json};

use super::editor::{self, History, Rect};
use super::*;

const VECTORS: &str = include_str!("vectors.json");

fn vectors() -> Value {
    serde_json::from_str(VECTORS).expect("vectors.json is valid JSON")
}

fn list(value: &Value) -> Vec<Value> {
    value.as_array().cloned().unwrap_or_default()
}

/// The first difference between two documents, for a readable failure.
fn first_difference(path: &str, a: &Value, b: &Value) -> Option<String> {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            for key in x.keys().chain(y.keys()) {
                match (x.get(key), y.get(key)) {
                    (Some(p), Some(q)) => {
                        if let Some(d) = first_difference(&format!("{path}.{key}"), p, q) {
                            return Some(d);
                        }
                    }
                    (p, q) => return Some(format!("{path}.{key}: {p:?} vs {q:?}")),
                }
            }
            None
        }
        (Value::Array(x), Value::Array(y)) if x.len() == y.len() => {
            x.iter().zip(y).enumerate().find_map(|(i, (p, q))| first_difference(&format!("{path}[{i}]"), p, q))
        }
        _ if same(a, b) => None,
        _ => Some(format!("{path}: {a} vs {b}")),
    }
}

#[test]
fn operations_match_the_ts() {
    let vectors = vectors();
    let mut failures = Vec::new();
    let all = list(&vectors["apply"]);
    for vector in &all {
        let name = vector["name"].as_str().unwrap();
        let actual = apply(&vector["document"], &list(&vector["operations"]));
        match (&actual, vector.get("result"), vector.get("error")) {
            (Ok(got), Some(want), _) => {
                if let Some(difference) = first_difference("", got, want) {
                    failures.push(format!("{name}: {difference}"));
                }
            }
            (Err(error), Some(_), _) => failures.push(format!("{name}: failed with {error}, the TS succeeds")),
            (Ok(_), None, Some(error)) => failures.push(format!("{name}: succeeded, the TS fails with {error}")),
            (Err(got), None, Some(Value::String(want))) => {
                // The host's own messages match; zod's issue lists are not copied.
                if !want.starts_with('[') && !want.starts_with(got.trim_end_matches('.')) && got != want {
                    failures.push(format!("{name}: \"{got}\", the TS says \"{want}\""));
                }
            }
            _ => failures.push(format!("{name}: malformed vector")),
        }
    }
    assert!(failures.is_empty(), "{} of {} mismatch:\n{}", failures.len(), all.len(), failures.join("\n"));
    assert!(all.len() >= 90, "the vectors cover {} batches", all.len());
}

#[test]
fn diffs_match_the_ts() {
    let vectors = vectors();
    let mut failures = Vec::new();
    let all = list(&vectors["diff"]);
    for vector in &all {
        let name = vector["name"].as_str().unwrap();
        match diff(&vector["before"], &vector["after"]) {
            Ok(got) => {
                if let Some(difference) = first_difference("", &Value::Array(got.clone()), &vector["operations"]) {
                    failures.push(format!("{name}: {difference}"));
                }
                // Applying the diff gives the later document, as the host will.
                if !got.is_empty() {
                    let applied = apply(&vector["before"], &got).map_err(|e| e.to_string());
                    let want = validate(&vector["after"]).unwrap();
                    if applied.as_ref().map(|a| !same(a, &want)).unwrap_or(true) {
                        failures.push(format!("{name}: the diff does not apply back"));
                    }
                }
            }
            Err(error) => failures.push(format!("{name}: {error}")),
        }
    }
    assert!(failures.is_empty(), "{} of {} mismatch:\n{}", failures.len(), all.len(), failures.join("\n"));
    assert!(all.len() >= 40, "the vectors cover {} diffs", all.len());
}

#[test]
fn snapping_matches_the_controller() {
    let vectors = vectors();
    let all = list(&vectors["snap"]);
    let mut failures = Vec::new();
    let mut compared = 0;
    // Each design's entry with its document and boxes comes after its drags.
    for entry in all.iter().filter(|v| v.get("document").is_some()) {
        let design = entry["design"].as_str().unwrap();
        let document = &entry["document"];
        let nodes = nodes_of(document);
        let size = (document["width"].as_f64().unwrap(), document["height"].as_f64().unwrap());
        let bounds: Vec<(String, Rect)> = list(&entry["bounds"])
            .iter()
            .map(|b| {
                let n = |i: usize| b[i].as_f64().unwrap();
                (b[0].as_str().unwrap().to_string(), Rect { x: n(1), y: n(2), width: n(3), height: n(4) })
            })
            .collect();
        for drag in all.iter().filter(|v| v["design"] == design && v.get("target").is_some()) {
            let target = drag["target"].as_str().unwrap();
            let rect = bounds.iter().find(|(id, _)| id == target).unwrap().1;
            let raw = (drag["raw"][0].as_f64().unwrap(), drag["raw"][1].as_f64().unwrap());
            let resizing = drag["resizing"].as_bool().unwrap();
            let excluded = HashSet::from([target.to_string()]);
            let got = editor::drag_step(rect, raw, resizing, false, &excluded, size, &nodes, &bounds);
            let guide = |v: &Value| v.as_f64();
            let want = (drag["dx"].as_f64().unwrap(), drag["dy"].as_f64().unwrap(), guide(&drag["guides"][0]), guide(&drag["guides"][1]));
            // Within a millionth: the boxes' sums round in the last bit differently in places.
            let near = |a: Option<f64>, b: Option<f64>| match (a, b) {
                (Some(a), Some(b)) => (a - b).abs() < 1e-6,
                (a, b) => a == b,
            };
            if !near(Some(got.dx), Some(want.0))
                || !near(Some(got.dy), Some(want.1))
                || !near(got.guides.0, want.2)
                || !near(got.guides.1, want.3)
            {
                failures.push(format!("{design} {target} {raw:?} resize={resizing}: {got:?}, the TS has {want:?}"));
            }
            compared += 1;
        }
    }
    assert!(failures.is_empty(), "{} mismatches:\n{}", failures.len(), failures.join("\n"));
    assert!(compared >= 600, "the vectors cover {compared} drags");
}

fn screen() -> Value {
    json!({
        "schemaVersion": 1, "width": 390, "height": 844,
        "nodes": [
            { "id": "frame", "type": "frame", "x": 20, "y": 40, "width": 350, "height": 300 },
            { "id": "title", "parentId": "frame", "type": "text", "x": 16, "y": 16, "width": 300, "height": 40, "text": "Hi" },
            { "id": "row", "type": "frame", "layout": "horizontal", "x": 0, "y": 400, "width": 390, "height": 80 },
            { "id": "chip", "parentId": "row", "type": "rectangle", "width": 60, "height": 30 },
            { "id": "pinned", "type": "rectangle", "x": 5, "y": 5, "width": 10, "height": 10, "locked": true }
        ]
    })
}

#[test]
fn selection_roots_skip_descendants_of_a_selected_frame() {
    let nodes = nodes_of(&screen());
    let ids = vec!["title".to_string(), "frame".to_string(), "missing".to_string()];
    assert_eq!(editor::selection_roots(&nodes, &ids), vec!["frame".to_string()]);
    assert_eq!(editor::selectable_ids(&nodes, &ids), vec!["title".to_string(), "frame".to_string()]);
}

#[test]
fn auto_layout_children_and_locked_layers_do_not_move() {
    let nodes = nodes_of(&screen());
    assert!(editor::movable(&nodes, "title"));
    assert!(!editor::movable(&nodes, "chip"));
    assert!(!editor::movable(&nodes, "pinned"));
    assert!(editor::move_operations(&nodes, &["chip".into()], 1.0, 0.0).is_empty());
    let ops = editor::move_operations(&nodes, &["title".into()], 10.0, -0.005);
    let next = apply(&screen(), &ops).unwrap();
    let title = nodes_of(&next).into_iter().find(|n| n["id"] == "title").unwrap();
    assert_eq!((title["x"].as_f64(), title["y"].as_f64()), (Some(26.0), Some(16.0)));
}

#[test]
fn new_layers_duplicates_and_deletes_apply() {
    let mut document = screen();
    for (kind, _) in editor::TOOLS {
        document = apply(&document, &[op_insert(editor::new_node(kind, &format!("{kind}-00000001")), None)]).unwrap();
    }
    assert_eq!(nodes_of(&document).len(), 11);
    let mut counter = 0;
    let (ops, roots) = editor::duplicate_operations(&nodes_of(&document), &["frame".into(), "title".into()], |kind| {
        counter += 1;
        format!("{kind}-copy{counter}")
    });
    assert_eq!(ops.len(), 2, "the frame and its child, once");
    let document = apply(&document, &ops).unwrap();
    let copy = nodes_of(&document).into_iter().find(|n| n["id"] == roots[0].as_str()).unwrap();
    assert_eq!(copy["name"], "frame copy");
    assert_eq!(copy["x"].as_f64(), Some(36.0));
    let document = apply(&document, &editor::delete_operations(&nodes_of(&document), &roots)).unwrap();
    assert_eq!(nodes_of(&document).len(), 11);
}

#[test]
fn a_resize_keeps_the_minimum_and_fixes_the_size_modes() {
    let nodes = nodes_of(&screen());
    let rect = Rect { x: 36.0, y: 56.0, width: 300.0, height: 40.0 };
    let ops = editor::drag_operations(&nodes, &[("title".into(), rect)], -400.0, 12.0, true);
    assert_eq!(ops[0]["patch"], json!({ "width": 1, "height": 52, "widthMode": "fixed", "heightMode": "fixed" }));
}

#[test]
fn history_keeps_a_hundred_steps_and_redo_follows_undo() {
    let mut history = History::new(json!(0));
    for step in 1..=120 {
        history.push(json!(step));
    }
    assert_eq!(history.past.len(), History::LIMIT);
    assert_eq!(history.past[0], json!(20));
    assert!(history.undo());
    assert_eq!(history.present, json!(119));
    assert!(history.redo());
    assert_eq!(history.present, json!(120));
    assert!(!history.redo());
    history.undo();
    history.push(json!("new"));
    assert!(!history.can_redo());
}

#[test]
fn layer_rows_nest_and_collapse() {
    let nodes = nodes_of(&screen());
    let rows = editor::layer_rows(&nodes, &HashSet::new());
    let order: Vec<(&str, usize)> = rows.iter().map(|r| (r.id.as_str(), r.depth)).collect();
    assert_eq!(order, vec![("frame", 0), ("title", 1), ("row", 0), ("chip", 1), ("pinned", 0)]);
    let collapsed = editor::layer_rows(&nodes, &HashSet::from(["frame".to_string()]));
    assert_eq!(collapsed.len(), 4);
    assert_eq!(editor::layer_glyph(&rows[1]), "T");
}

#[test]
fn round_coordinate_rounds_halves_up() {
    assert_eq!(editor::round_coordinate(1.005), 1.0);
    assert_eq!(editor::round_coordinate(-2.125), -2.12);
    assert_eq!(editor::round_coordinate(4.56789), 4.57);
}

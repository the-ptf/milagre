//! Parity with the TS: `vectors.json` holds `designLayout`, `designTextLayout` and `designNodeAt` as node computed
//! them (`generate.mjs`) for the documents in `cases.json` and every fixture design. Regenerate it after changing
//! either; a mismatch here is this port drifting from the desktop.

use serde_json::Value;

use super::*;

const VECTORS: &str = include_str!("vectors.json");

fn vectors() -> Vec<Value> {
    let root: Value = serde_json::from_str(VECTORS).expect("vectors.json is valid JSON");
    root["vectors"].as_array().expect("a list of vectors").clone()
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-9
}

/// The number of values each check compares, summed over the vectors (the parity test count in the README).
fn check_all(mut check: impl FnMut(&str, &DesignDocument, &Value, &mut Vec<String>) -> usize) -> usize {
    let mut failures = Vec::new();
    let mut compared = 0;
    for vector in vectors() {
        let name = vector["name"].as_str().unwrap().to_string();
        let document = DesignDocument::from_json(&vector["document"]).unwrap_or_else(|error| panic!("{name}: {error}"));
        compared += check(&name, &document, &vector, &mut failures);
    }
    assert!(failures.is_empty(), "{} mismatches:\n{}", failures.len(), failures.join("\n"));
    compared
}

#[test]
fn layer_bounds_match_the_ts() {
    let compared = check_all(|name, document, vector, failures| {
        let layout = layout(document);
        let expected = vector["bounds"].as_array().unwrap();
        let actual: Vec<(&str, Bounds)> = layout.order.iter().map(|(i, b)| (document.nodes[*i].id.as_str(), *b)).collect();
        if expected.len() != actual.len() {
            failures.push(format!("{name}: {} boxes, the TS has {}", actual.len(), expected.len()));
        }
        for (want, (id, got)) in expected.iter().zip(&actual) {
            let w: Vec<f64> = want.as_array().unwrap()[1..].iter().map(|v| v.as_f64().unwrap()).collect();
            let want_id = want[0].as_str().unwrap();
            if want_id != *id || !close(w[0], got.x) || !close(w[1], got.y) || !close(w[2], got.width) || !close(w[3], got.height) {
                failures.push(format!("{name}: {id} {got:?}, the TS has {want_id} {w:?}"));
            }
        }
        expected.len()
    });
    assert!(compared >= 300, "the vectors cover {compared} boxes");
}

#[test]
fn text_lines_match_the_ts() {
    let compared = check_all(|name, document, vector, failures| {
        let layout = layout(document);
        let mut count = 0;
        for (id, texts) in vector["texts"].as_object().unwrap() {
            let index = document.nodes.iter().position(|n| n.id == *id).unwrap();
            let node = &document.nodes[index];
            let bounds = layout.get(index).unwrap();
            for (which, width) in [("natural", f64::INFINITY), ("boxed", (bounds.width - 2.0 * node.border()).max(1.0))] {
                let want = &texts[which];
                let got = text_layout(node, width);
                let lines: Vec<&str> = want["lines"].as_array().unwrap().iter().map(|l| l.as_str().unwrap()).collect();
                count += 1;
                if lines != got.lines
                    || !close(want["width"].as_f64().unwrap(), got.width)
                    || !close(want["height"].as_f64().unwrap(), got.height)
                    || !close(want["lineHeight"].as_f64().unwrap(), got.line_height)
                {
                    failures.push(format!("{name}: {id} {which} {got:?}, the TS has {want}"));
                }
            }
        }
        count
    });
    assert!(compared >= 100, "the vectors cover {compared} text layouts");
}

#[test]
fn hit_tests_match_the_ts() {
    let compared = check_all(|name, document, vector, failures| {
        let layout = layout(document);
        let hits = vector["hits"].as_array().unwrap();
        for hit in hits {
            let (x, y) = (hit[0].as_f64().unwrap(), hit[1].as_f64().unwrap());
            let want = hit[2].as_str();
            let got = node_at(document, &layout, x, y).map(|i| document.nodes[i].id.as_str());
            if want != got {
                failures.push(format!("{name}: at ({x}, {y}) {got:?}, the TS has {want:?}"));
            }
        }
        hits.len()
    });
    assert!(compared >= 1000, "the vectors cover {compared} points");
}

#[test]
fn kit_resolution_sets_styles_bindings_and_tokens() {
    let vector = vectors().into_iter().find(|v| v["name"] == "kit text styles, bindings and tokens").unwrap();
    let document = DesignDocument::from_json(&vector["document"]).unwrap();
    let heading = document.node("h").unwrap();
    // The style replaces the layer's own size.
    assert_eq!((heading.font_size, heading.font_weight, heading.line_height), (Some(22.0), Some(600.0), Some(1.2)));
    let body = document.node("b").unwrap();
    assert_eq!(body.font_family.as_deref(), Some("Georgia"));
    let card = document.node("card").unwrap();
    assert_eq!((card.padding, card.gap, card.radius), (Some(20.0), Some(6.0), Some(14.0)));
    // The document's own token wins over the kit's colour of the same name.
    assert_eq!(document.color(Some("$ink"), "x"), "#222222");
    assert_eq!(document.color(Some("$surface"), "x"), "#ffffff");
    assert_eq!(document.kit_label(), "Kit · kit v2");
    let missing = serde_json::json!({ "width": 400, "height": 300, "nodes": [{ "id": "t", "type": "text", "width": 1, "height": 1, "textStyle": "body" }] });
    assert!(DesignDocument::from_json(&missing).is_err());
}

#[test]
fn rounding_follows_javascript() {
    // Values from node: `Math.round(v * 1000) / 1000`. Halves go up, also below zero.
    for (value, rounded) in
        [(1.0005, 1.001), (-2.0005, -2.001), (85.0244, 85.024), (-0.0015, -0.001), (-1.2345, -1.234), (0.0625, 0.063), (-0.0625, -0.062)]
    {
        assert_eq!(js_round(value), rounded, "{value}");
    }
}

#[test]
fn visible_lines_keep_a_partly_shown_line() {
    let node = DesignNode { font_size: Some(20.0), line_height: Some(1.0), text: Some("a\nb\nc".into()), ..Default::default() };
    let text = text_layout(&node, f64::INFINITY);
    let bounds = |height| Bounds { x: 0.0, y: 0.0, width: 100.0, height };
    assert_eq!(visible_lines(&node, &bounds(60.0), &text).len(), 3);
    assert_eq!(visible_lines(&node, &bounds(25.0), &text).len(), 2);
    assert_eq!(visible_lines(&node, &bounds(20.0), &text).len(), 1);
}

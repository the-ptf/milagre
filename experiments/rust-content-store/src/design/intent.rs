//! Enforce declared text edits against resolved layers and measured layout.
use super::*;

fn same(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (Some(Value::Number(a)), Some(Value::Number(b))) => a.as_f64() == b.as_f64(),
        (Some(Value::Array(a)), Some(Value::Array(b))) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same(Some(a), Some(b)))
        }
        (Some(Value::Object(a)), Some(Value::Object(b))) => {
            a.len() == b.len() && a.iter().all(|(key, a)| same(Some(a), b.get(key)))
        }
        _ => a == b,
    }
}
fn fail(message: impl Into<String>, path: &[Value]) -> Error {
    let mut error = Error::at(message, path);
    error.code = "DESIGN_INTENT_VIOLATION".into();
    error
}
fn area(a: Option<&Bounds>, b: Option<&Bounds>) -> f64 {
    match (a, b) {
        (Some(a), Some(b)) => {
            (a.x + a.width)
                .min(b.x + b.width)
                .sub(a.x.max(b.x))
                .max(0.0)
                * (a.y + a.height)
                    .min(b.y + b.height)
                    .sub(a.y.max(b.y))
                    .max(0.0)
        }
        _ => 0.0,
    }
}
use std::ops::Sub;

pub(super) fn check(before: &Value, after: &Value, value: &Value) -> Result<()> {
    let intent = schema::parse(&schema::contract()["intent"], value, &[])?;
    let mode = sid(&intent, "mode");
    let text_ids = intent["textIds"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_str().unwrap())
        .collect::<Vec<_>>();
    let layout_ids = intent["layoutIds"]
        .as_array()
        .map(|ids| {
            ids.iter()
                .map(|id| id.as_str().unwrap())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let by_id = nodes(before)
        .iter()
        .map(|node| (node["id"].as_str().unwrap(), node))
        .collect::<BTreeMap<_, _>>();
    if mode == "text-only" && !layout_ids.is_empty() {
        return Err(fail(
            "text-only does not allow layoutIds. Use fit-text when layout changes are intended.",
            &[json!("intent"), json!("layoutIds")],
        ));
    }
    for id in &text_ids {
        if !by_id.get(id).is_some_and(|node| node["type"] == "text") {
            return Err(fail(
                format!("Text target \"{id}\" must be an existing text layer."),
                &[json!("intent"), json!("textIds")],
            ));
        }
    }
    for id in &layout_ids {
        if !by_id.contains_key(id) {
            return Err(fail(
                format!("Layout target \"{id}\" does not exist."),
                &[json!("intent"), json!("layoutIds")],
            ));
        }
    }
    let text_allowed = |node: &Value| {
        text_ids.contains(&node["id"].as_str().unwrap_or_default())
            || node["componentSourceId"]
                .as_str()
                .is_some_and(|id| text_ids.contains(&id))
    };
    let layout_allowed = |node: &Value| {
        if mode != "fit-text" {
            return false;
        }
        if text_allowed(node) {
            return true;
        }
        let mut current = Some(node);
        while let Some(node) = current {
            if layout_ids.contains(&node["id"].as_str().unwrap_or_default()) {
                return true;
            }
            current = node["parentId"]
                .as_str()
                .and_then(|id| by_id.get(id).copied());
        }
        false
    };
    let mut old_meta = before.clone();
    remove(&mut old_meta, "nodes");
    let mut new_meta = after.clone();
    remove(&mut new_meta, "nodes");
    if !same(Some(&old_meta), Some(&new_meta)) {
        return Err(fail(
            "Text intents preserve document size, kit, policy and tokens.",
            &[json!("intent")],
        ));
    }
    if nodes(before).len() != nodes(after).len()
        || nodes(before)
            .iter()
            .zip(nodes(after))
            .any(|(a, b)| a["id"] != b["id"])
    {
        return Err(fail("Text intents preserve layer ids and order; insertion, removal or detaching is outside this intent.", &[json!("nodes")]));
    }
    for (index, node) in nodes(after).iter().enumerate() {
        let id = node["id"].as_str().unwrap();
        let previous = by_id[id];
        let mut seen = BTreeSet::new();
        for field in object(previous).keys().chain(object(node).keys()) {
            if !seen.insert(field) || same(previous.get(field), node.get(field)) {
                continue;
            }
            if field == "text" && text_allowed(previous) {
                continue;
            }
            if [
                "x",
                "y",
                "width",
                "height",
                "widthMode",
                "heightMode",
                "minWidth",
                "minHeight",
            ]
            .contains(&field.as_str())
                && layout_allowed(previous)
            {
                continue;
            }
            return Err(fail(format!("Intent {mode} preserves \"{id}.{field}\". Only declared text and permitted geometry may change."), &[json!("nodes"),json!(index),json!(field)]));
        }
    }
    let old_bounds = layout(before)?;
    let new_bounds = layout(after)?;
    for node in nodes(before) {
        let id = node["id"].as_str().unwrap();
        if same(
            old_bounds.get(id).map(Bounds::value).as_ref(),
            new_bounds.get(id).map(Bounds::value).as_ref(),
        ) || layout_allowed(node)
        {
            continue;
        }
        return Err(fail(format!("Automatic layout moved or resized \"{id}\" outside the intent. Use fit-text with the affected layoutIds when authorized."), &[json!("intent"),json!("layoutIds")]));
    }
    if mode != "fit-text" {
        return Ok(());
    }
    let mut affected_ancestors = BTreeSet::new();
    for node in nodes(before).iter().filter(|node| text_allowed(node)) {
        let mut parent = node["parentId"]
            .as_str()
            .and_then(|id| by_id.get(id).copied());
        while let Some(node) = parent {
            affected_ancestors.insert(node["id"].as_str().unwrap());
            parent = node["parentId"]
                .as_str()
                .and_then(|id| by_id.get(id).copied());
        }
    }
    let texts = nodes(after)
        .iter()
        .filter(|node| node["type"] == "text")
        .collect::<Vec<_>>();
    for (index, a) in texts.iter().enumerate() {
        for b in &texts[index + 1..] {
            if a.get("parentId") != b.get("parentId") || (!layout_allowed(a) && !layout_allowed(b))
            {
                continue;
            }
            let a_id = a["id"].as_str().unwrap();
            let b_id = b["id"].as_str().unwrap();
            if area(new_bounds.get(a_id), new_bounds.get(b_id))
                > area(old_bounds.get(a_id), old_bounds.get(b_id)) + 1.0
            {
                return Err(fail(format!("fit-text creates or increases overlap between text layers \"{a_id}\" and \"{b_id}\". Adjust their geometry in the declared scope."), &[json!("intent"),json!("layoutIds")]));
            }
        }
    }
    let layout_problem = |warning: &&Value| {
        ["clipped-text", "overflow", "off-canvas"]
            .contains(&warning["kind"].as_str().unwrap_or_default())
    };
    let old_diagnostics = diagnostics::checked(before)?;
    let old_problems = old_diagnostics["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .filter(layout_problem)
        .map(|w| (format!("{}:{}", sid(w, "kind"), sid(w, "id")), w))
        .collect::<BTreeMap<_, _>>();
    let diagnostics = diagnostics::checked(after)?;
    let problems = diagnostics["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .filter(layout_problem)
        .filter(|warning| {
            let id = warning["id"].as_str().unwrap();
            let previous = old_problems.get(&format!("{}:{id}", sid(warning, "kind")));
            affected_ancestors.contains(id)
                || by_id.get(id).is_some_and(|node| layout_allowed(node))
                || previous.is_none_or(|previous| {
                    !same(previous.get("measurements"), warning.get("measurements"))
                })
        })
        .collect::<Vec<_>>();
    if !problems.is_empty() {
        let mut error = Error::coded(
            "DESIGN_INTENT_VIOLATION",
            format!(
                "fit-text still has layout problems: {}",
                problems
                    .iter()
                    .take(3)
                    .map(|w| w["message"].as_str().unwrap())
                    .collect::<Vec<_>>()
                    .join(" ")
            ),
        );
        error.issues = Some(Box::new(json!(problems.iter().map(|w|json!({"path":["nodes",nodes(after).iter().position(|n|n["id"]==w["id"]).map(|i|i as i64).unwrap_or(-1)],"message":w["message"]})).collect::<Vec<_>>())));
        error.diagnostics = Some(Box::new(diagnostics));
        return Err(error);
    }
    Ok(())
}

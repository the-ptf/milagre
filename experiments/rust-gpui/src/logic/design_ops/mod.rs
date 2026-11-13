//! The design document's edit operations, ported from `packages/shared/src/design.mjs` as pure logic (WP-55):
//! `validateDesignDocument`, `applyDesignOperations`, `diffDesignDocuments`, and the component helpers from
//! `design-components.mjs`. The design page editor (`workspace/panel/designs/editor/`) changes a document only
//! through these, as the desktop editor does, and saves a version as the operations `diff` returns.
//!
//! Documents and operations stay JSON (`serde_json::Value`) the way the host stores and sends them, so a saved
//! document round-trips with every field the layout does not read. An operation is
//! `{ "op": "update" | "insert" | "delete" | "duplicate" | "detach" | "unset" | "document" | "replace", ... }`.
//!
//! - `schema.rs`: the document, layer and kit shapes (zod's checks), keys in schema order.
//! - `components.rs`: main components and instances (`synchronizeDesignComponents`, create, detach).
//! - `editor.rs`: what the editor builds operations from: selection roots, movability, snapping, new layers,
//!   duplicates, and the undo history.
//!
//! `vectors.json` is the TS run on `cases.json` and the fixture designs (`generate.mjs`); `tests.rs` checks this port
//! against it.

pub mod components;
pub mod editor;
pub mod schema;

#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use serde_json::{Map, Value};

use self::components::{by_id, descendant_ids, instance_root, str_field, synchronize};
use self::schema::Node;

pub use self::components::{create_instance, detach_instance, instance_root_id};

/// A JSON number the way JavaScript writes it: integral values without a fraction.
pub fn num(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9.0e15 { Value::from(value as i64) } else { Value::from(value) }
}

/// Deep equality where `24` and `24.0` are one number, as in JavaScript.
pub fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(a, b)| same(a, b)),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w))),
        _ => a == b,
    }
}

pub fn op_update(id: &str, patch: Map<String, Value>) -> Value {
    serde_json::json!({ "op": "update", "id": id, "patch": patch })
}

pub fn op_insert(node: Value, index: Option<usize>) -> Value {
    match index {
        Some(index) => serde_json::json!({ "op": "insert", "node": node, "index": index }),
        None => serde_json::json!({ "op": "insert", "node": node }),
    }
}

pub fn op_delete(id: &str) -> Value {
    serde_json::json!({ "op": "delete", "id": id })
}

pub fn op_replace(document: Value) -> Value {
    serde_json::json!({ "op": "replace", "document": document })
}

/// The layers of a document, as objects (absent or malformed lists read as empty).
pub fn nodes_of(document: &Value) -> Vec<Node> {
    document.get("nodes").and_then(Value::as_array).map(|n| n.iter().filter_map(|n| n.as_object().cloned()).collect()).unwrap_or_default()
}

fn set_nodes(document: &mut Map<String, Value>, nodes: Vec<Node>) {
    document.insert("nodes".into(), Value::Array(nodes.into_iter().map(Value::Object).collect()));
}

fn lucide() -> &'static HashSet<String> {
    static ICONS: OnceLock<HashSet<String>> = OnceLock::new();
    ICONS.get_or_init(|| {
        // The icon set the Designs canvas draws (written by `design_layout/generate.mjs`).
        match serde_json::from_str::<Value>(include_str!("../../workspace/panel/designs/data/lucide.json")) {
            Ok(Value::Object(map)) => map.keys().cloned().collect(),
            _ => HashSet::new(),
        }
    })
}

/// Whether a design may name this Lucide icon.
pub fn has_icon(name: &str) -> bool {
    lucide().contains(name)
}

/// `resolveDesignKit`: text styles replace a text layer's font fields, bindings set spacing and radius from the kit,
/// and the kit's colours become tokens the document's own override.
fn resolve_kit(document: &mut Map<String, Value>) -> Result<(), String> {
    let kit = document.get("kit").and_then(Value::as_object).cloned();
    let mut nodes = nodes_of(&Value::Object(document.clone()));
    for node in &mut nodes {
        let id = str_field(node, "id").unwrap_or("").to_string();
        let bound = node.get("bindings").and_then(Value::as_object).is_some_and(|b| !b.is_empty());
        let styled = node.get("textStyle").and_then(Value::as_str).is_some_and(|s| !s.is_empty());
        let Some(kit) = &kit else {
            if styled || bound {
                return Err(format!("Layer \"{id}\" needs a design kit for its style bindings."));
            }
            continue;
        };
        if let Some(name) = node.get("textStyle").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string) {
            if str_field(node, "type") != Some("text") {
                return Err(format!("Only text layers can use textStyle: \"{id}\"."));
            }
            let style = kit.get("textStyles").and_then(|s| s.get(&name)).and_then(Value::as_object).ok_or_else(|| {
                format!(
                    "Text style \"{name}\" does not exist in kit \"{}\". Choose a name from kit.textStyles.",
                    kit.get("id").and_then(Value::as_str).unwrap_or("")
                )
            })?;
            for field in ["fontFamily", "fontSize", "fontWeight", "lineHeight"] {
                node.remove(field);
            }
            for (k, v) in style {
                node.insert(k.clone(), v.clone());
            }
        }
        let bindings = node.get("bindings").and_then(Value::as_object).cloned().unwrap_or_default();
        for (field, token) in bindings {
            let table = if field == "radius" { "radii" } else { "spacing" };
            let token = token.as_str().unwrap_or("");
            let value = kit
                .get(table)
                .and_then(|t| t.get(token))
                .ok_or_else(|| format!("Kit token \"{token}\" for {id}.{field} does not exist."))?;
            node.insert(field, value.clone());
        }
    }
    set_nodes(document, nodes);
    if let Some(kit) = &kit {
        let mut tokens = kit.get("colors").and_then(Value::as_object).cloned().unwrap_or_default();
        for (k, v) in document.get("tokens").and_then(Value::as_object).into_iter().flatten() {
            tokens.insert(k.clone(), v.clone());
        }
        document.insert("tokens".into(), Value::Object(tokens));
    }
    Ok(())
}

/// `checkedDesignDocument`: the shape, the kit resolved, unique ids, known tokens and icons, a sound tree, and (once)
/// the component instances regenerated.
fn checked(value: &Value, sync: bool) -> Result<Map<String, Value>, String> {
    let mut document = schema::parse_document(value)?;
    resolve_kit(&mut document)?;
    if Value::Object(document.clone()).to_string().chars().count() > 1_000_000 {
        return Err("A design document is limited to 1,000,000 characters.".into());
    }
    let nodes = nodes_of(&Value::Object(document.clone()));
    let mut seen = HashSet::new();
    for node in &nodes {
        let id = str_field(node, "id").unwrap_or("");
        if !seen.insert(id) {
            return Err(format!("Layer id \"{id}\" is duplicated."));
        }
    }
    let tokens = document.get("tokens").and_then(Value::as_object);
    let check_color = |value: Option<&Value>| -> Result<(), String> {
        if let Some(token) = value.and_then(Value::as_str).and_then(|v| v.strip_prefix('$'))
            && !tokens.is_some_and(|t| t.contains_key(token))
        {
            return Err(format!("Color token \"${token}\" does not exist. Add it to tokens or the pinned kit."));
        }
        Ok(())
    };
    check_color(document.get("background"))?;
    let index = by_id(&nodes);
    for node in &nodes {
        check_color(node.get("fill"))?;
        check_color(node.get("stroke"))?;
        let id = str_field(node, "id").unwrap_or("");
        let kind = str_field(node, "type").unwrap_or("");
        if kind == "icon" {
            let icon =
                str_field(node, "icon").filter(|i| !i.is_empty()).ok_or_else(|| format!("Icon layer \"{id}\" needs an icon name."))?;
            if !has_icon(icon) {
                return Err(format!("Unknown icon \"{icon}\" on layer \"{id}\"."));
            }
            let unsupported: Vec<&str> = ["stroke", "radius", "text", "src"].into_iter().filter(|f| node.contains_key(*f)).collect();
            if !unsupported.is_empty() {
                return Err(format!(
                    "Icon layer \"{id}\" can't use {}. Use fill for its color and strokeWidth for its line weight.",
                    unsupported.join(", ")
                ));
            }
        } else if node.contains_key("icon") {
            return Err(format!("Only icon layers use \"icon\"; \"{id}\" is a {kind}."));
        }
        let mut chain = HashSet::from([id]);
        let mut parent = str_field(node, "parentId");
        while let Some(parent_id) = parent {
            if chain.contains(parent_id) {
                return Err(format!("Layer \"{id}\" has a circular parent."));
            }
            if chain.len() >= 32 {
                return Err("Design layers can nest at most 32 levels.".into());
            }
            chain.insert(parent_id);
            let found = index.get(parent_id).ok_or_else(|| format!("Parent layer \"{parent_id}\" does not exist."))?;
            if str_field(found, "type") != Some("frame") {
                return Err(format!("Parent layer \"{parent_id}\" must be a frame."));
            }
            parent = str_field(found, "parentId");
        }
    }
    if !sync {
        return Ok(document);
    }
    let mut nodes = nodes.clone();
    synchronize(&mut nodes)?;
    set_nodes(&mut document, nodes);
    checked(&Value::Object(document), false)
}

/// `validateDesignDocument`: the document as the host saves it, or why it can't be.
pub fn validate(value: &Value) -> Result<Value, String> {
    checked(value, true).map(Value::Object)
}

fn belongs_to_component(index: &HashMap<&str, &Node>, source: &str, component: &str) -> bool {
    let mut node = index.get(source).copied();
    for _ in 0..32 {
        let Some(current) = node else { return false };
        let Some(parent) = str_field(current, "parentId") else { return false };
        if parent == component {
            return true;
        }
        node = index.get(parent).copied();
    }
    false
}

#[derive(Clone)]
struct Generated {
    instance: String,
    component: String,
    source: String,
}

/// `generatedComponentSources`: the generated layers that may go away when their main layer does.
fn generated_sources(nodes: &[Node]) -> HashMap<String, Generated> {
    let index = by_id(nodes);
    let mut sources = HashMap::new();
    let mut counts: HashMap<(String, String), usize> = HashMap::new();
    for node in nodes {
        let Some(source) = str_field(node, "componentSourceId").filter(|s| !s.is_empty()) else { continue };
        let id = str_field(node, "id").unwrap_or("");
        let Some(instance) = instance_root(&index, id) else { continue };
        let instance_id = str_field(instance, "id").unwrap_or("");
        let component = str_field(instance, "componentId").unwrap_or("");
        if id == instance_id || !index.get(component).is_some_and(|c| c.get("component").and_then(Value::as_bool) == Some(true)) {
            continue;
        }
        if !belongs_to_component(&index, source, component) {
            continue;
        }
        *counts.entry((instance_id.to_string(), source.to_string())).or_default() += 1;
        sources.insert(id.to_string(), Generated { instance: instance_id.into(), component: component.into(), source: source.into() });
    }
    sources.retain(|_, g| counts.get(&(g.instance.clone(), g.source.clone())) == Some(&1));
    sources
}

fn field_list(operation: &Value) -> Vec<String> {
    operation
        .get("fields")
        .and_then(Value::as_array)
        .map(|f| f.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

const INSTANCE_FIELDS: [&str; 7] = ["x", "y", "parentId", "name", "hidden", "locked", "componentValues"];

fn find(nodes: &[Node], id: &str) -> Option<usize> {
    nodes.iter().position(|n| str_field(n, "id") == Some(id))
}

/// `applyDesignOperations` (no edit intent): the document after a batch, checked once at the end so a batch can
/// insert children before their parent.
pub fn apply(document: &Value, operations: &[Value]) -> Result<Value, String> {
    let mut result = checked(document, true)?;
    let mut previous = generated_sources(&nodes_of(&Value::Object(result.clone())));
    if operations.is_empty() || operations.len() > 1000 {
        return Err("A batch has 1 to 1000 operations.".into());
    }
    for operation in operations {
        let op = operation.get("op").and_then(Value::as_str).unwrap_or("");
        let target = operation.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        let mut nodes = nodes_of(&Value::Object(result.clone()));
        let allowed: &[&str] = match op {
            "document" => &["op", "patch"],
            "detach" | "delete" => &["op", "id"],
            "duplicate" => &["op", "id", "newId", "x", "y"],
            "unset" => &["op", "id", "fields"],
            "update" => &["op", "id", "patch"],
            "insert" => &["op", "node", "index"],
            "replace" => &["op", "document"],
            _ => return Err(format!("Unknown operation \"{op}\".")),
        };
        if let Some(key) = operation.as_object().and_then(|o| o.keys().find(|k| !allowed.contains(&k.as_str()))) {
            return Err(format!("Unknown field \"{key}\" in a {op} operation."));
        }
        if matches!(op, "detach" | "delete" | "duplicate" | "unset" | "update") && !schema::valid_id(&target) {
            return Err(format!("Invalid layer id in a {op} operation."));
        }
        match op {
            "document" => {
                let patch = operation.get("patch").and_then(Value::as_object).ok_or("A document operation needs a patch.")?;
                for (key, value) in patch {
                    if key == "nodes" || key == "schemaVersion" {
                        return Err(format!("A document patch cannot change {key}."));
                    }
                    schema::document_field(key, value)?;
                }
                let tokens = if let Some(kit) = patch.get("kit") {
                    let mut tokens = kit.get("colors").and_then(Value::as_object).cloned().unwrap_or_default();
                    tokens.extend(patch.get("tokens").and_then(Value::as_object).cloned().unwrap_or_default());
                    Some(tokens)
                } else if let Some(own) = patch.get("tokens").and_then(Value::as_object) {
                    let mut tokens = result.get("tokens").and_then(Value::as_object).cloned().unwrap_or_default();
                    tokens.extend(own.clone());
                    Some(tokens)
                } else {
                    result.get("tokens").and_then(Value::as_object).cloned()
                };
                for (key, value) in patch {
                    result.insert(key.clone(), value.clone());
                }
                if let Some(tokens) = tokens {
                    result.insert("tokens".into(), Value::Object(tokens));
                }
                continue;
            }
            "detach" => {
                let replaced = detach_instance(&Value::Object(result.clone()), &target)?;
                result = replaced[0]["document"].as_object().cloned().unwrap_or_default();
                continue;
            }
            "duplicate" => {
                let new_id = operation
                    .get("newId")
                    .and_then(Value::as_str)
                    .filter(|i| schema::valid_id(i))
                    .ok_or("A duplicate needs a valid newId.")?;
                for key in ["x", "y"] {
                    if let Some(v) = operation.get(key)
                        && !v.as_f64().is_some_and(|v| (-32000.0..=32000.0).contains(&v))
                    {
                        return Err(format!("Invalid {key} in a duplicate operation."));
                    }
                }
                let root = nodes
                    .iter()
                    .find(|n| str_field(n, "id") == Some(target.as_str()))
                    .ok_or_else(|| format!("Layer \"{target}\" does not exist."))?;
                let index = by_id(&nodes);
                if instance_root(&index, &target).is_some_and(|i| str_field(i, "id") != Some(target.as_str())) {
                    return Err("Duplicate the instance root, or detach it first.".into());
                }
                let ids = descendant_ids(&nodes, &target);
                let copies: Vec<Node> = nodes.iter().filter(|n| ids.contains(str_field(n, "id").unwrap_or(""))).cloned().collect();
                let prefix: String = new_id.chars().take(80).collect();
                let mut names: HashMap<String, String> = HashMap::new();
                let mut count = 0;
                for node in &copies {
                    let id = str_field(node, "id").unwrap_or("").to_string();
                    let name = if id == target {
                        new_id.to_string()
                    } else {
                        count += 1;
                        format!("{prefix}-{count}")
                    };
                    names.insert(id, name);
                }
                let values: HashSet<&String> = names.values().collect();
                if values.len() != names.len() || nodes.iter().any(|n| str_field(n, "id").is_some_and(|id| values.iter().any(|v| *v == id)))
                {
                    return Err("Duplicate layer ids already exist. Choose another newId.".into());
                }
                let (rx, ry) = (root.get("x").and_then(Value::as_f64), root.get("y").and_then(Value::as_f64));
                let rename = |copy: &mut Node, key: &str| {
                    if let Some(v) = str_field(copy, key).and_then(|v| names.get(v)).cloned() {
                        copy.insert(key.into(), Value::String(v));
                    }
                };
                for node in copies {
                    let id = str_field(&node, "id").unwrap_or("").to_string();
                    let mut copy = node.clone();
                    copy.insert("id".into(), Value::String(names[&id].clone()));
                    rename(&mut copy, "parentId");
                    rename(&mut copy, "componentId");
                    rename(&mut copy, "componentSourceId");
                    if let Some(props) = copy.get_mut("componentProperties").and_then(Value::as_object_mut) {
                        for prop in props.values_mut() {
                            if let Some(n) = prop.get("nodeId").and_then(Value::as_str).and_then(|n| names.get(n)).cloned() {
                                prop["nodeId"] = Value::String(n);
                            }
                        }
                    }
                    if id == target {
                        copy.insert("x".into(), operation.get("x").cloned().unwrap_or_else(|| num(rx.unwrap_or(0.0) + 24.0)));
                        copy.insert("y".into(), operation.get("y").cloned().unwrap_or_else(|| num(ry.unwrap_or(0.0) + 24.0)));
                    }
                    nodes.push(copy);
                }
                set_nodes(&mut result, nodes);
                continue;
            }
            "unset" => {
                let fields = field_list(operation);
                if fields.is_empty()
                    || fields.len() > 4
                    || fields.iter().any(|f| !matches!(f.as_str(), "parentId" | "textStyle" | "bindings" | "componentValues"))
                {
                    return Err("Unset names 1 to 4 of parentId, textStyle, bindings, componentValues.".into());
                }
                let at = find(&nodes, &target).ok_or_else(|| format!("Layer \"{target}\" does not exist."))?;
                let index = by_id(&nodes);
                if let Some(instance) = instance_root(&index, &target)
                    && (str_field(instance, "id") != Some(target.as_str())
                        || fields.iter().any(|f| !matches!(f.as_str(), "parentId" | "componentValues")))
                {
                    return Err("Edit the main component or detach this instance.".into());
                }
                for field in &fields {
                    nodes[at].remove(field);
                }
                set_nodes(&mut result, nodes);
                continue;
            }
            "replace" => {
                let mut replacement = operation.get("document").cloned().ok_or("A replace needs a document.")?;
                if replacement.get("consistency").is_none()
                    && let (Some(consistency), Some(object)) = (result.get("consistency").cloned(), replacement.as_object_mut())
                {
                    object.insert("consistency".into(), consistency);
                }
                result = schema::parse_document(&replacement)?;
                previous = generated_sources(&nodes_of(&Value::Object(result.clone())));
                continue;
            }
            "insert" => {
                let node = operation.get("node").ok_or("An insert needs a node.")?;
                if let Some(parent) = node.get("parentId").and_then(Value::as_str)
                    && instance_root(&by_id(&nodes), parent).is_some()
                {
                    return Err("Edit the main component or detach this instance before adding layers.".into());
                }
                let id = node.get("id").and_then(Value::as_str).unwrap_or("");
                if find(&nodes, id).is_some() {
                    return Err(format!("Layer id \"{id}\" already exists."));
                }
                let index = match operation.get("index") {
                    None => nodes.len(),
                    Some(v) => v.as_u64().filter(|i| *i <= 1000).ok_or("Invalid insertion index.")? as usize,
                };
                if index > nodes.len() {
                    return Err("Layer insertion index is past the end of the document.".into());
                }
                nodes.insert(index, schema::parse_node(node)?);
                set_nodes(&mut result, nodes);
                continue;
            }
            _ => {}
        }
        // update or delete
        let at = find(&nodes, &target).ok_or_else(|| format!("Layer \"{target}\" does not exist."))?;
        let patch = if op == "update" {
            let patch = operation.get("patch").ok_or("An update needs a patch.")?;
            schema::check_patch(patch)?;
            patch.as_object().cloned().unwrap_or_default()
        } else {
            Map::new()
        };
        {
            let index = by_id(&nodes);
            if let Some(instance) = instance_root(&index, &target)
                && (str_field(instance, "id") != Some(target.as_str())
                    || (op == "update" && patch.keys().any(|f| !INSTANCE_FIELDS.contains(&f.as_str()))))
            {
                return Err("Edit the main component or detach this instance before changing its layers.".into());
            }
        }
        if op == "update" {
            if let Some(parent) = patch.get("parentId").and_then(Value::as_str)
                && instance_root(&by_id(&nodes), parent).is_some()
            {
                return Err("Edit the main component or detach this instance before moving layers into it.".into());
            }
            let mut next = nodes[at].clone();
            for (k, v) in &patch {
                next.insert(k.clone(), v.clone());
            }
            // An explicit local edit survives kit resolution; a new binding in the same patch stays authoritative.
            if !patch.contains_key("textStyle")
                && ["fontFamily", "fontSize", "fontWeight", "lineHeight"].iter().any(|f| patch.contains_key(*f))
            {
                next.remove("textStyle");
            }
            if !patch.contains_key("bindings")
                && let Some(bindings) = next.get("bindings").and_then(Value::as_object).cloned()
            {
                let kept: Map<String, Value> = bindings.into_iter().filter(|(field, _)| !patch.contains_key(field)).collect();
                if kept.is_empty() {
                    next.remove("bindings");
                } else {
                    next.insert("bindings".into(), Value::Object(kept));
                }
            }
            nodes[at] = next;
        } else {
            let removed = descendant_ids(&nodes, &target);
            nodes.retain(|n| !removed.contains(str_field(n, "id").unwrap_or("")));
        }
        set_nodes(&mut result, nodes);
    }
    let nodes = nodes_of(&Value::Object(result.clone()));
    let index = by_id(&nodes);
    let kept: Vec<Node> = nodes
        .iter()
        .filter(|node| {
            let id = str_field(node, "id").unwrap_or("");
            let Some(before) = previous.get(id) else { return true };
            if Some(before.source.as_str()) != str_field(node, "componentSourceId") {
                return true;
            }
            let instance = instance_root(&index, id);
            let Some(instance) = instance else { return true };
            if str_field(instance, "id") != Some(before.instance.as_str())
                || str_field(instance, "componentId") != Some(before.component.as_str())
                || !index.get(before.component.as_str()).is_some_and(|c| c.get("component").and_then(Value::as_bool) == Some(true))
            {
                return true;
            }
            belongs_to_component(&index, &before.source, &before.component)
        })
        .cloned()
        .collect();
    drop(index);
    set_nodes(&mut result, kept);
    validate(&Value::Object(result))
}

/// `old[field] !== value` after two separate parses: objects and lists are never the same reference.
fn changed(old: Option<&Value>, new: &Value) -> bool {
    match (old, new) {
        (_, Value::Object(_) | Value::Array(_)) => true,
        (Some(old), new) => !same(old, new),
        (None, _) => true,
    }
}

/// `diffDesignDocuments`: the smallest operations from one document to another, or a single `replace` when the
/// layer order, the metadata or a removed field makes small operations unsafe.
pub fn diff(before: &Value, after: &Value) -> Result<Vec<Value>, String> {
    let a = validate(before)?;
    let b = validate(after)?;
    if same(&a, &b) {
        return Ok(Vec::new());
    }
    let replace = || Ok(vec![op_replace(b.clone())]);
    let metadata = |doc: &Value| {
        let mut m = doc.as_object().cloned().unwrap_or_default();
        m.remove("nodes");
        Value::Object(m)
    };
    if !same(&metadata(&a), &metadata(&b)) {
        return replace();
    }
    let (old_nodes, new_nodes) = (nodes_of(&a), nodes_of(&b));
    let (old_by_id, new_by_id) = (by_id(&old_nodes), by_id(&new_nodes));
    let old_order: Vec<&str> = old_nodes.iter().filter_map(|n| str_field(n, "id")).filter(|id| new_by_id.contains_key(id)).collect();
    let new_order: Vec<&str> = new_nodes.iter().filter_map(|n| str_field(n, "id")).filter(|id| old_by_id.contains_key(id)).collect();
    if old_order != new_order {
        return replace();
    }
    // Reparenting a child away from a deleted frame needs a replacement, or the delete would take it along.
    if new_nodes.iter().any(|n| {
        old_by_id
            .get(str_field(n, "id").unwrap_or(""))
            .and_then(|old| str_field(old, "parentId"))
            .is_some_and(|p| !new_by_id.contains_key(p))
    }) {
        return replace();
    }
    let mut operations = Vec::new();
    for node in &old_nodes {
        let id = str_field(node, "id").unwrap_or("");
        if instance_root(&old_by_id, id).is_some_and(|i| str_field(i, "id") != Some(id)) {
            continue;
        }
        if !new_by_id.contains_key(id) && str_field(node, "parentId").is_none_or(|p| new_by_id.contains_key(p)) {
            operations.push(op_delete(id));
        }
    }
    for (index, node) in new_nodes.iter().enumerate() {
        let id = str_field(node, "id").unwrap_or("");
        let instance = instance_root(&new_by_id, id);
        if instance.is_some_and(|i| str_field(i, "id") != Some(id)) {
            continue;
        }
        let Some(old) = old_by_id.get(id) else {
            operations.push(op_insert(Value::Object(node.clone()), Some(index)));
            continue;
        };
        if old.keys().any(|field| !node.contains_key(field)) {
            return replace();
        }
        let patch: Map<String, Value> = node
            .iter()
            .filter(|(field, value)| {
                field.as_str() != "id"
                    && changed(old.get(*field), value)
                    && (instance.is_none() || INSTANCE_FIELDS.contains(&field.as_str()))
            })
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        if !patch.is_empty() {
            operations.push(op_update(id, patch));
        }
    }
    // Keep the exact final document when insertions and deletions change what an index means.
    match apply(&a, &operations) {
        Ok(applied) if same(&applied, &b) => Ok(operations),
        _ => replace(),
    }
}

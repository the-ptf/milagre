//! Main components and their instances (`design-components.mjs`): an instance keeps expanded copies of its main
//! component's layers, regenerated on every validation, so every renderer reads an ordinary tree.

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};

use super::schema::Node;
use super::{op_insert, op_replace};

pub fn str_field<'a>(node: &'a Node, key: &str) -> Option<&'a str> {
    node.get(key).and_then(Value::as_str)
}

fn truthy(node: &Node, key: &str) -> bool {
    match node.get(key) {
        Some(Value::Bool(b)) => *b,
        Some(Value::Null) | None => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

pub fn by_id(nodes: &[Node]) -> HashMap<&str, &Node> {
    nodes.iter().filter_map(|n| Some((str_field(n, "id")?, n))).collect()
}

/// `designInstanceRoot`: the nearest instance root at or above a layer.
pub fn instance_root<'a>(index: &HashMap<&str, &'a Node>, id: &str) -> Option<&'a Node> {
    let mut node = index.get(id).copied();
    for _ in 0..33 {
        let current = node?;
        if truthy(current, "componentId") {
            return Some(current);
        }
        node = str_field(current, "parentId").and_then(|p| index.get(p).copied());
    }
    None
}

pub fn instance_root_id(nodes: &[Node], id: &str) -> Option<String> {
    let index = by_id(nodes);
    instance_root(&index, id).and_then(|n| str_field(n, "id")).map(str::to_string)
}

fn children(nodes: &[Node]) -> HashMap<Option<&str>, Vec<&str>> {
    let mut children: HashMap<Option<&str>, Vec<&str>> = HashMap::new();
    for node in nodes {
        if let Some(id) = str_field(node, "id") {
            children.entry(str_field(node, "parentId")).or_default().push(id);
        }
    }
    children
}

/// A layer and everything under it.
pub fn descendant_ids(nodes: &[Node], root: &str) -> HashSet<String> {
    let children = children(nodes);
    let mut ids = HashSet::from([root.to_string()]);
    let mut pending = vec![root.to_string()];
    while let Some(id) = pending.pop() {
        for child in children.get(&Some(id.as_str())).into_iter().flatten() {
            if ids.insert((*child).to_string()) {
                pending.push((*child).to_string());
            }
        }
    }
    ids
}

/// `instanceChildId`: FNV-1a of the source id, after the instance id.
fn instance_child_id(instance: &str, source: &str) -> String {
    let mut hash: u32 = 2166136261;
    for unit in source.encode_utf16() {
        hash = (hash ^ u32::from(unit)).wrapping_mul(16777619);
    }
    let prefix: String = instance.chars().take(78).collect();
    format!("{prefix}-{hash:x}")
}

/// `synchronizeDesignComponents`: checks the component rules and regenerates every instance's layers.
pub fn synchronize(nodes: &mut Vec<Node>) -> Result<(), String> {
    let snapshot = nodes.clone();
    let index = by_id(&snapshot);
    let components: HashMap<&str, &Node> =
        snapshot.iter().filter(|n| truthy(n, "component")).filter_map(|n| Some((str_field(n, "id")?, n))).collect();
    for node in &snapshot {
        if node.contains_key("componentProperties") && !truthy(node, "component") {
            return Err("Only a main component can expose properties.".into());
        }
        if node.contains_key("componentValues") && !truthy(node, "componentId") {
            return Err("Only an instance can set componentValues.".into());
        }
        if (truthy(node, "component") || truthy(node, "componentId")) && str_field(node, "type") != Some("frame") {
            return Err("A component or instance must be a frame.".into());
        }
        if truthy(node, "component") && truthy(node, "componentId") {
            return Err("An instance cannot also be a main component.".into());
        }
        if let Some(component) = str_field(node, "componentId").filter(|c| !c.is_empty())
            && !components.contains_key(component)
        {
            return Err(format!("Component \"{component}\" does not exist. Detach its instances before deleting it."));
        }
        if truthy(node, "componentId") && truthy(node, "componentSourceId") {
            return Err("An instance root cannot have a component source reference.".into());
        }
        if truthy(node, "componentSourceId") && instance_root(&index, str_field(node, "id").unwrap_or("")).is_none() {
            return Err("A component source reference must belong to an instance.".into());
        }
    }
    for component in components.values() {
        let id = str_field(component, "id").unwrap_or("");
        let ids = descendant_ids(&snapshot, id);
        if snapshot.iter().any(|n| {
            let nid = str_field(n, "id").unwrap_or("");
            nid != id && ids.contains(nid) && (truthy(n, "component") || truthy(n, "componentId"))
        }) {
            return Err("Nested components and instances are not supported inside a main component.".into());
        }
        for (name, property) in component.get("componentProperties").and_then(Value::as_object).into_iter().flatten() {
            let target_id = property.get("nodeId").and_then(Value::as_str).unwrap_or("");
            let target = index.get(target_id);
            let Some(target) = target.filter(|_| ids.contains(target_id)) else {
                return Err(format!("Component property \"{name}\" must target a layer in its main component."));
            };
            let field = property.get("field").and_then(Value::as_str);
            let kind = str_field(target, "type");
            if (field == Some("text") && kind != Some("text")) || (field == Some("icon") && kind != Some("icon")) {
                return Err(format!("Component property \"{name}\" targets an incompatible layer."));
            }
        }
        if instance_root(&index, id).is_some() {
            return Err("A main component cannot live inside an instance.".into());
        }
    }
    let instances: Vec<String> =
        snapshot.iter().filter(|n| truthy(n, "componentId")).filter_map(|n| str_field(n, "id").map(str::to_string)).collect();
    drop(index);
    for instance_id in instances {
        let current = nodes.clone();
        let Some(instance) = current.iter().find(|n| str_field(n, "id") == Some(instance_id.as_str())) else { continue };
        let master_id = str_field(instance, "componentId").unwrap_or("").to_string();
        let Some(master) = current.iter().find(|n| str_field(n, "id") == Some(master_id.as_str()) && truthy(n, "component")) else {
            continue;
        };
        let properties = master.get("componentProperties").and_then(Value::as_object);
        let mut overrides: HashMap<String, Map<String, Value>> = HashMap::new();
        for (name, value) in instance.get("componentValues").and_then(Value::as_object).into_iter().flatten() {
            let Some(property) = properties.and_then(|p| p.get(name)) else {
                return Err(format!(
                    "Unknown component property \"{name}\" on \"{instance_id}\". Use a property exposed by its main component."
                ));
            };
            if let Some(options) = property.get("options").and_then(Value::as_array)
                && !options.iter().any(|o| super::same(o, value))
            {
                let list: Vec<String> = options.iter().map(js_string).collect();
                return Err(format!("Property \"{name}\" must be one of: {}.", list.join(", ")));
            }
            let field = property.get("field").and_then(Value::as_str).unwrap_or("");
            let (expected, ok) = match field {
                "hidden" => ("boolean", value.is_boolean()),
                "opacity" => ("number", value.is_number()),
                _ => ("string", value.is_string()),
            };
            if !ok {
                return Err(format!("Property \"{name}\" needs a {expected}."));
            }
            let target = property.get("nodeId").and_then(Value::as_str).unwrap_or("").to_string();
            overrides.entry(target).or_default().insert(field.to_string(), value.clone());
        }
        let source_ids = descendant_ids(&current, &master_id);
        let source: Vec<&Node> = current.iter().filter(|n| source_ids.contains(str_field(n, "id").unwrap_or(""))).collect();
        let owned_ids = descendant_ids(&current, &instance_id);
        if owned_ids.contains(&master_id) {
            return Err("An instance cannot contain its main component.".into());
        }
        let owned: Vec<&Node> = current.iter().filter(|n| owned_ids.contains(str_field(n, "id").unwrap_or(""))).collect();
        let others = owned.iter().filter(|n| str_field(n, "id") != Some(instance_id.as_str()));
        if others.clone().any(|n| truthy(n, "component") || truthy(n, "componentId")) {
            return Err("Nested component instances are not supported.".into());
        }
        if others.clone().any(|n| !truthy(n, "componentSourceId")) {
            return Err("Edit the main component or detach this instance before adding ordinary layers.".into());
        }
        let mut owned_by_source: HashMap<&str, &Node> = HashMap::new();
        for node in others {
            let source_id = str_field(node, "componentSourceId").unwrap_or("");
            if source_id == master_id || !source_ids.contains(source_id) {
                return Err(format!("Component source \"{source_id}\" does not belong to this instance's main component."));
            }
            if owned_by_source.insert(source_id, node).is_some() {
                return Err(format!("Component source \"{source_id}\" is duplicated in this instance."));
            }
        }
        let mut taken: HashSet<String> =
            current.iter().filter_map(|n| str_field(n, "id")).filter(|id| !owned_ids.contains(*id)).map(str::to_string).collect();
        taken.insert(instance_id.clone());
        let mut names: HashMap<String, String> = HashMap::from([(master_id.clone(), instance_id.clone())]);
        for node in &source {
            let id = str_field(node, "id").unwrap_or("");
            if id == master_id {
                continue;
            }
            let preferred = owned_by_source
                .get(id)
                .and_then(|n| str_field(n, "id"))
                .map(str::to_string)
                .unwrap_or_else(|| instance_child_id(&instance_id, id));
            let (mut unique, mut suffix) = (preferred.clone(), 1);
            while taken.contains(&unique) {
                unique = format!("{preferred}-{suffix}");
                suffix += 1;
            }
            names.insert(id.to_string(), unique.clone());
            taken.insert(unique);
        }
        let expanded: Vec<Node> = source
            .iter()
            .map(|node| {
                let id = str_field(node, "id").unwrap_or("");
                let mut copy = (*node).clone();
                for (k, v) in overrides.get(id).into_iter().flatten() {
                    copy.insert(k.clone(), v.clone());
                }
                copy.insert("id".into(), Value::String(names[id].clone()));
                for key in ["component", "componentId", "componentSourceId", "componentProperties", "componentValues"] {
                    copy.remove(key);
                }
                if id == master_id {
                    copy.remove("parentId");
                    copy.insert("componentId".into(), Value::String(master_id.clone()));
                    if let Some(values) = instance.get("componentValues") {
                        copy.insert("componentValues".into(), values.clone());
                    }
                    let name = str_field(instance, "name")
                        .map(str::to_string)
                        .unwrap_or_else(|| format!("{} instance", str_field(master, "name").unwrap_or("Component")));
                    copy.insert("name".into(), Value::String(name));
                    copy.insert("x".into(), instance.get("x").cloned().unwrap_or(Value::from(0)));
                    copy.insert("y".into(), instance.get("y").cloned().unwrap_or(Value::from(0)));
                    if let Some(parent) = instance.get("parentId") {
                        copy.insert("parentId".into(), parent.clone());
                    }
                    copy.remove("hidden");
                    copy.remove("locked");
                    if let Some(hidden) = overrides.get(&master_id).and_then(|o| o.get("hidden")) {
                        copy.insert("hidden".into(), hidden.clone());
                    }
                    if let Some(hidden) = instance.get("hidden") {
                        copy.insert("hidden".into(), hidden.clone());
                    }
                    if let Some(locked) = instance.get("locked") {
                        copy.insert("locked".into(), locked.clone());
                    }
                } else {
                    let parent = str_field(node, "parentId").and_then(|p| names.get(p)).cloned();
                    match parent {
                        Some(parent) => copy.insert("parentId".into(), Value::String(parent)),
                        None => copy.remove("parentId"),
                    };
                    copy.insert("componentSourceId".into(), Value::String(id.to_string()));
                }
                copy
            })
            .collect();
        let at = current.iter().position(|n| str_field(n, "id") == Some(instance_id.as_str())).unwrap_or(0);
        let insertion = current.iter().take(at).filter(|n| !owned_ids.contains(str_field(n, "id").unwrap_or(""))).count();
        let mut next: Vec<Node> = current.into_iter().filter(|n| !owned_ids.contains(str_field(n, "id").unwrap_or(""))).collect();
        next.splice(insertion..insertion, expanded);
        *nodes = next;
    }
    if nodes.len() > 1000 {
        return Err("Expanded component instances exceed the 1000 layer limit.".into());
    }
    Ok(())
}

/// `String(value)` for a property option in an error message.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// `createDesignInstance`: the insert that places a new instance of a main component.
pub fn create_instance(document: &Value, component: &str, instance: &str, x: Option<f64>, y: Option<f64>) -> Result<Vec<Value>, String> {
    let nodes = super::nodes_of(document);
    let master = nodes
        .iter()
        .find(|n| str_field(n, "id") == Some(component) && truthy(n, "component") && str_field(n, "type") == Some("frame"))
        .ok_or_else(|| format!("Component \"{component}\" does not exist."))?;
    if nodes.iter().any(|n| str_field(n, "id") == Some(instance)) {
        return Err(format!("Layer id \"{instance}\" already exists."));
    }
    let coordinate = |key: &str| master.get(key).and_then(Value::as_f64).unwrap_or(0.0) + 24.0;
    let mut node = Map::new();
    node.insert("id".into(), instance.into());
    node.insert("type".into(), "frame".into());
    node.insert("componentId".into(), component.into());
    node.insert("width".into(), master.get("width").cloned().unwrap_or(Value::from(1)));
    node.insert("height".into(), master.get("height").cloned().unwrap_or(Value::from(1)));
    node.insert("x".into(), super::num(x.unwrap_or_else(|| coordinate("x"))));
    node.insert("y".into(), super::num(y.unwrap_or_else(|| coordinate("y"))));
    node.insert("name".into(), format!("{} instance", str_field(master, "name").unwrap_or("Component")).into());
    Ok(vec![op_insert(Value::Object(node), None)])
}

/// `detachDesignInstance`: a replacement where the instance and its layers no longer follow the main component.
pub fn detach_instance(document: &Value, instance: &str) -> Result<Vec<Value>, String> {
    let nodes = super::nodes_of(document);
    if !nodes.iter().any(|n| str_field(n, "id") == Some(instance) && truthy(n, "componentId")) {
        return Err("Select a linked instance to detach it.".into());
    }
    let owned = descendant_ids(&nodes, instance);
    let mut next = document.clone();
    next["nodes"] = Value::Array(
        nodes
            .into_iter()
            .map(|mut node| {
                if owned.contains(str_field(&node, "id").unwrap_or("")) {
                    node.remove("componentId");
                    node.remove("componentSourceId");
                    node.remove("componentValues");
                }
                Value::Object(node)
            })
            .collect(),
    );
    Ok(vec![op_replace(next)])
}

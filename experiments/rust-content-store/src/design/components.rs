use super::*;

pub fn instance(document: &Value, id: &str) -> Option<Value> {
    let mut current = id.to_owned();
    for _ in 0..33 {
        let node = nodes(document).iter().find(|node| node["id"] == current)?;
        if yes(node, "componentId") {
            return Some(node.clone());
        }
        current = sid(node, "parentId");
    }
    None
}
pub fn descendants(document: &Value, id: &str) -> BTreeSet<String> {
    let mut ids = BTreeSet::from([id.to_owned()]);
    loop {
        let before = ids.len();
        for node in nodes(document) {
            if ids.contains(&sid(node, "parentId")) {
                ids.insert(sid(node, "id"));
            }
        }
        if before == ids.len() {
            return ids;
        }
    }
}
fn child_id(instance: &str, source: &str) -> String {
    // Both IDs are ASCII by schema, so JS charCodeAt and bytes are identical.
    let hash = source.bytes().fold(2166136261u32, |hash, byte| {
        (hash ^ u32::from(byte)).wrapping_mul(16777619)
    });
    format!("{}-{hash:x}", &instance[..instance.len().min(78)])
}
pub fn belongs(document: &Value, source: &str, component: &str) -> bool {
    let mut id = source.to_owned();
    for _ in 0..32 {
        let Some(node) = nodes(document).iter().find(|node| node["id"] == id) else {
            return false;
        };
        if node["parentId"] == component {
            return true;
        }
        id = sid(node, "parentId");
    }
    false
}
pub fn sources(document: &Value) -> BTreeMap<String, (String, String, String)> {
    let mut result = BTreeMap::new();
    let mut counts = BTreeMap::new();
    for node in nodes(document) {
        if !yes(node, "componentSourceId") {
            continue;
        }
        let id = sid(node, "id");
        let Some(root) = instance(document, &id) else {
            continue;
        };
        let source = sid(node, "componentSourceId");
        let master = sid(&root, "componentId");
        if root["id"] == id
            || !nodes(document)
                .iter()
                .any(|node| node["id"] == master && yes(node, "component"))
            || !belongs(document, &source, &master)
        {
            continue;
        }
        let root = sid(&root, "id");
        *counts.entry((root.clone(), source.clone())).or_insert(0) += 1;
        result.insert(id, (root, master, source));
    }
    result.retain(|_, (root, _, source)| counts[&(root.clone(), source.clone())] == 1);
    result
}
pub fn detach(document: &mut Value, id: &str) -> Result<()> {
    if !nodes(document)
        .iter()
        .any(|node| node["id"] == id && yes(node, "componentId"))
    {
        return Err(error("Select a linked instance to detach it."));
    }
    let ids = descendants(document, id);
    for node in document["nodes"].as_array_mut().unwrap() {
        if ids.contains(&sid(node, "id")) {
            for field in ["componentId", "componentSourceId", "componentValues"] {
                remove(node, field);
            }
        }
    }
    Ok(())
}
pub fn synchronize(mut document: Value) -> Result<Value> {
    let by_id = nodes(&document)
        .iter()
        .map(|node| (sid(node, "id"), node.clone()))
        .collect::<BTreeMap<_, _>>();
    let masters = nodes(&document)
        .iter()
        .filter(|node| yes(node, "component"))
        .map(|node| (sid(node, "id"), node.clone()))
        .collect::<BTreeMap<_, _>>();
    for node in nodes(&document) {
        if yes(node, "componentProperties") && !yes(node, "component") {
            return Err(error("Only a main component can expose properties."));
        }
        if yes(node, "componentValues") && !yes(node, "componentId") {
            return Err(error("Only an instance can set componentValues."));
        }
        if (yes(node, "component") || yes(node, "componentId")) && node["type"] != "frame" {
            return Err(error("A component or instance must be a frame."));
        }
        if yes(node, "component") && yes(node, "componentId") {
            return Err(error("An instance cannot also be a main component."));
        }
        if yes(node, "componentId") && !masters.contains_key(&sid(node, "componentId")) {
            return Err(error(format!(
                "Component \"{}\" does not exist. Detach its instances before deleting it.",
                sid(node, "componentId")
            )));
        }
        if yes(node, "componentId") && yes(node, "componentSourceId") {
            return Err(error(
                "An instance root cannot have a component source reference.",
            ));
        }
        if yes(node, "componentSourceId") && instance(&document, &sid(node, "id")).is_none() {
            return Err(error(
                "A component source reference must belong to an instance.",
            ));
        }
    }
    // Original layer order is observable in first validation errors.
    for master in nodes(&document)
        .iter()
        .filter(|node| yes(node, "component"))
    {
        let id = sid(master, "id");
        let ids = descendants(&document, &id);
        if nodes(&document).iter().any(|node| {
            node["id"] != id
                && ids.contains(&sid(node, "id"))
                && (yes(node, "component") || yes(node, "componentId"))
        }) {
            return Err(error(
                "Nested components and instances are not supported inside a main component.",
            ));
        }
        if let Some(properties) = master["componentProperties"].as_object() {
            for (name, property) in properties {
                let target = by_id.get(&sid(property, "nodeId"));
                if !ids.contains(&sid(property, "nodeId")) || target.is_none() {
                    return Err(error(format!(
                        "Component property \"{name}\" must target a layer in its main component."
                    )));
                }
                let target = target.unwrap();
                if property["field"] == "text" && target["type"] != "text"
                    || property["field"] == "icon" && target["type"] != "icon"
                {
                    return Err(error(format!(
                        "Component property \"{name}\" targets an incompatible layer."
                    )));
                }
            }
        }
        if instance(&document, &id).is_some() {
            return Err(error("A main component cannot live inside an instance."));
        }
    }
    let instances = nodes(&document)
        .iter()
        .filter(|node| yes(node, "componentId"))
        .cloned()
        .collect::<Vec<_>>();
    for root in instances {
        let id = sid(&root, "id");
        let master = &masters[&sid(&root, "componentId")];
        let mut overrides: BTreeMap<String, Value> = BTreeMap::new();
        if let Some(values) = root["componentValues"].as_object() {
            for (name, value) in values {
                let at = nodes(&document)
                    .iter()
                    .position(|node| node["id"] == id)
                    .unwrap();
                let path = vec![
                    json!("nodes"),
                    json!(at),
                    json!("componentValues"),
                    json!(name),
                ];
                let property=master["componentProperties"].get(name).ok_or_else(||Error::at(format!("Unknown component property \"{name}\" on \"{id}\". Use a property exposed by its main component."),&path))?;
                if let Some(options) = property["options"].as_array() {
                    if !options.iter().any(|option| {
                        option == value
                            || option.is_number()
                                && value.is_number()
                                && option.as_f64() == value.as_f64()
                    }) {
                        let choices = options
                            .iter()
                            .map(|value| {
                                value
                                    .as_str()
                                    .map(utf8)
                                    .unwrap_or_else(|| jsjson::to_string(value))
                            })
                            .collect::<Vec<_>>()
                            .join(", ");
                        return Err(Error::at(
                            format!("Property \"{name}\" must be one of: {choices}."),
                            &path,
                        ));
                    }
                }
                let field = sid(property, "field");
                let expected = if field == "hidden" {
                    "boolean"
                } else if field == "opacity" {
                    "number"
                } else {
                    "string"
                };
                if !match expected {
                    "boolean" => value.is_boolean(),
                    "number" => value.is_number(),
                    _ => value.is_string(),
                } {
                    return Err(error(format!("Property \"{name}\" needs a {expected}.")));
                }
                overrides
                    .entry(sid(property, "nodeId"))
                    .or_insert(json!({}))[field] = value.clone();
            }
        }
        let source_ids = descendants(&document, &sid(master, "id"));
        let source = nodes(&document)
            .iter()
            .filter(|node| source_ids.contains(&sid(node, "id")))
            .cloned()
            .collect::<Vec<_>>();
        let owned_ids = descendants(&document, &id);
        if owned_ids.contains(&sid(master, "id")) {
            return Err(error("An instance cannot contain its main component."));
        }
        let owned = nodes(&document)
            .iter()
            .filter(|node| owned_ids.contains(&sid(node, "id")))
            .collect::<Vec<_>>();
        if owned
            .iter()
            .any(|node| node["id"] != id && (yes(node, "component") || yes(node, "componentId")))
        {
            return Err(error("Nested component instances are not supported."));
        }
        if owned
            .iter()
            .any(|node| node["id"] != id && !yes(node, "componentSourceId"))
        {
            return Err(error(
                "Edit the main component or detach this instance before adding ordinary layers.",
            ));
        }
        let mut owned_by_source = BTreeMap::new();
        for node in &owned {
            if node["id"] == id {
                continue;
            }
            let reference = sid(node, "componentSourceId");
            if reference == master["id"] || !source_ids.contains(&reference) {
                return Err(error(format!("Component source \"{reference}\" does not belong to this instance's main component.")));
            }
            if owned_by_source
                .insert(reference.clone(), sid(node, "id"))
                .is_some()
            {
                return Err(error(format!(
                    "Component source \"{reference}\" is duplicated in this instance."
                )));
            }
        }
        let mut taken = nodes(&document)
            .iter()
            .filter(|node| !owned_ids.contains(&sid(node, "id")))
            .map(|node| sid(node, "id"))
            .collect::<BTreeSet<_>>();
        taken.insert(id.clone());
        let mut names = BTreeMap::from([(sid(master, "id"), id.clone())]);
        for node in &source {
            let source_id = sid(node, "id");
            if source_id == master["id"] {
                continue;
            }
            let preferred = owned_by_source
                .get(&source_id)
                .cloned()
                .unwrap_or_else(|| child_id(&id, &source_id));
            let mut unique = preferred.clone();
            let mut suffix = 1;
            while taken.contains(&unique) {
                unique = format!("{preferred}-{suffix}");
                suffix += 1;
            }
            taken.insert(unique.clone());
            names.insert(source_id, unique);
        }
        let expanded = source
            .iter()
            .map(|node| {
                let source_id = sid(node, "id");
                let mut copy = node.clone();
                if let Some(patch) = overrides.get(&source_id) {
                    merge(&mut copy, patch);
                }
                copy["id"] = json!(names[&source_id]);
                for field in [
                    "component",
                    "componentId",
                    "componentSourceId",
                    "componentProperties",
                    "componentValues",
                ] {
                    remove(&mut copy, field);
                }
                if source_id == master["id"] {
                    remove(&mut copy, "parentId");
                    copy["componentId"] = master["id"].clone();
                    if let Some(values) = root.get("componentValues") {
                        copy["componentValues"] = values.clone();
                    }
                    copy["name"] = root.get("name").cloned().unwrap_or_else(|| {
                        json!(format!(
                            "{} instance",
                            master["name"].as_str().unwrap_or("Component")
                        ))
                    });
                    copy["x"] = root.get("x").cloned().unwrap_or(json!(0));
                    copy["y"] = root.get("y").cloned().unwrap_or(json!(0));
                    if let Some(parent) = root.get("parentId") {
                        copy["parentId"] = parent.clone();
                    }
                    remove(&mut copy, "hidden");
                    remove(&mut copy, "locked");
                    if let Some(value) = overrides
                        .get(&source_id)
                        .and_then(|patch| patch.get("hidden"))
                    {
                        copy["hidden"] = value.clone();
                    }
                    for field in ["hidden", "locked"] {
                        if let Some(value) = root.get(field) {
                            copy[field] = value.clone();
                        }
                    }
                } else {
                    copy["parentId"] = json!(names[&sid(node, "parentId")]);
                    copy["componentSourceId"] = node["id"].clone();
                }
                copy
            })
            .collect::<Vec<_>>();
        let at = nodes(&document)
            .iter()
            .position(|node| node["id"] == id)
            .unwrap();
        let insertion = nodes(&document)
            .iter()
            .take(at)
            .filter(|node| !owned_ids.contains(&sid(node, "id")))
            .count();
        let layers = document["nodes"].as_array_mut().unwrap();
        layers.retain(|node| !owned_ids.contains(&sid(node, "id")));
        layers.splice(insertion..insertion, expanded);
    }
    if nodes(&document).len() > 1000 {
        return Err(error(
            "Expanded component instances exceed the 1000 layer limit.",
        ));
    }
    Ok(document)
}

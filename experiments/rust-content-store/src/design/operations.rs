use super::*;

/// Apply one atomic batch to a clone. Layout-aware `intent` is deliberately
/// rejected until the Rust font/layout diagnostic engine exists.
pub fn apply_operations(
    document: &Value,
    operations: &Value,
    intent: Option<&Value>,
) -> Result<Value> {
    if intent.is_some() {
        return Err(Error::coded(
            "UNSUPPORTED_DESIGN_INTENT",
            "Layout-aware Design edit intent requires the existing design layout engine.",
        ));
    }
    let mut result = validate_document(document)?;
    let mut previous = components::sources(&result);
    let list = operations
        .as_array()
        .filter(|list| !list.is_empty() && list.len() <= 1000)
        .ok_or_else(|| Error::at("Use between 1 and 1000 Design operations.", &[]))?;
    let mut parsed = Vec::new();
    for (index, operation) in list.iter().enumerate() {
        let path = [json!(index)];
        let tag = sid(operation, "op");
        let schema = schema::contract()["operation"]["oneOf"]
            .as_array()
            .unwrap()
            .iter()
            .find(|schema| schema["properties"]["op"]["const"] == tag)
            .ok_or_else(|| Error::at("Unknown Design operation.", &child(&path, "op")))?;
        let operation = schema::parse(schema, operation, &path)?;
        match tag.as_str() {
            "document" => refine_document(&operation["patch"], &child(&path, "patch"))?,
            "replace" => refine_document(&operation["document"], &child(&path, "document"))?,
            "update" => refine_node(&operation["patch"], &child(&path, "patch"))?,
            "insert" => refine_node(&operation["node"], &child(&path, "node"))?,
            _ => {}
        }
        parsed.push(operation);
    }
    for operation in parsed {
        let tag = sid(&operation, "op");
        let id = sid(&operation, "id");
        match tag.as_str() {
            "document" => {
                let patch = &operation["patch"];
                let tokens = if let Some(kit) = patch.get("kit") {
                    let mut tokens = kit["colors"].clone();
                    if let Some(overlay) = patch.get("tokens") {
                        merge(&mut tokens, overlay);
                    }
                    Some(tokens)
                } else if let Some(overlay) = patch.get("tokens") {
                    let mut tokens = result.get("tokens").cloned().unwrap_or(json!({}));
                    merge(&mut tokens, overlay);
                    Some(tokens)
                } else {
                    result.get("tokens").cloned()
                };
                merge(&mut result, patch);
                if let Some(tokens) = tokens {
                    result["tokens"] = tokens;
                }
                continue;
            }
            "detach" => {
                components::detach(&mut result, &id)?;
                continue;
            }
            "replace" => {
                let consistency = result.get("consistency").cloned();
                result = operation["document"].clone();
                if !yes(&result, "consistency") {
                    if let Some(consistency) = consistency {
                        result["consistency"] = consistency;
                    }
                }
                previous = components::sources(&result);
                continue;
            }
            "insert" => {
                let node = &operation["node"];
                let parent = sid(node, "parentId");
                if !parent.is_empty() && components::instance(&result, &parent).is_some() {
                    return Err(error(
                        "Edit the main component or detach this instance before adding layers.",
                    ));
                }
                let id = sid(node, "id");
                if nodes(&result).iter().any(|node| node["id"] == id) {
                    return Err(error(format!("Layer id \"{id}\" already exists.")));
                }
                let index = operation["index"]
                    .as_f64()
                    .map(|n| n as usize)
                    .unwrap_or(nodes(&result).len());
                if index > nodes(&result).len() {
                    return Err(error(
                        "Layer insertion index is past the end of the document.",
                    ));
                }
                result["nodes"]
                    .as_array_mut()
                    .unwrap()
                    .insert(index, node.clone());
                continue;
            }
            _ => {}
        }
        let index = nodes(&result)
            .iter()
            .position(|node| node["id"] == id)
            .ok_or_else(|| error(format!("Layer \"{id}\" does not exist.")))?;
        let instance = components::instance(&result, &id);
        if tag == "duplicate" {
            if instance.as_ref().is_some_and(|root| root["id"] != id) {
                return Err(error("Duplicate the instance root, or detach it first."));
            }
            let ids = components::descendants(&result, &id);
            let copies = nodes(&result)
                .iter()
                .filter(|node| ids.contains(&sid(node, "id")))
                .cloned()
                .collect::<Vec<_>>();
            let new_id = sid(&operation, "newId");
            let mut copy_index = 0;
            let names = copies
                .iter()
                .map(|node| {
                    let source = sid(node, "id");
                    let name = if source == id {
                        new_id.clone()
                    } else {
                        copy_index += 1;
                        format!("{}-{copy_index}", &new_id[..new_id.len().min(80)])
                    };
                    (source, name)
                })
                .collect::<BTreeMap<_, _>>();
            if names.values().collect::<BTreeSet<_>>().len() != names.len()
                || nodes(&result)
                    .iter()
                    .any(|node| names.values().any(|name| name == &sid(node, "id")))
            {
                return Err(error(
                    "Duplicate layer ids already exist. Choose another newId.",
                ));
            }
            for node in copies {
                let mut copy = node.clone();
                copy["id"] = json!(names[&sid(&node, "id")]);
                for field in ["parentId", "componentId", "componentSourceId"] {
                    if let Some(name) = names.get(&sid(&copy, field)) {
                        copy[field] = json!(name);
                    }
                }
                if let Some(properties) = copy
                    .get_mut("componentProperties")
                    .and_then(Value::as_object_mut)
                {
                    for property in properties.values_mut() {
                        if let Some(name) = names.get(&sid(property, "nodeId")) {
                            property["nodeId"] = json!(name);
                        }
                    }
                }
                if node["id"] == id {
                    for field in ["x", "y"] {
                        copy[field] = operation
                            .get(field)
                            .cloned()
                            .unwrap_or_else(|| json!(node[field].as_f64().unwrap_or(0.0) + 24.0));
                    }
                }
                result["nodes"].as_array_mut().unwrap().push(copy);
            }
            continue;
        }
        if tag == "unset" {
            let fields = operation["fields"].as_array().unwrap();
            if instance.as_ref().is_some_and(|root| {
                root["id"] != id
                    || fields
                        .iter()
                        .any(|field| field != "parentId" && field != "componentValues")
            }) {
                return Err(error("Edit the main component or detach this instance."));
            }
            for field in fields {
                remove(&mut result["nodes"][index], field.as_str().unwrap());
            }
            continue;
        }
        if instance.as_ref().is_some_and(|root| {
            root["id"] != id
                || tag == "update"
                    && object(&operation["patch"]).keys().any(|field| {
                        ![
                            "x",
                            "y",
                            "parentId",
                            "name",
                            "hidden",
                            "locked",
                            "componentValues",
                        ]
                        .contains(&field.as_str())
                    })
        }) {
            return Err(error(
                "Edit the main component or detach this instance before changing its layers.",
            ));
        }
        if tag == "update" {
            let patch = &operation["patch"];
            let parent = sid(patch, "parentId");
            if !parent.is_empty() && components::instance(&result, &parent).is_some() {
                return Err(error(
                    "Edit the main component or detach this instance before moving layers into it.",
                ));
            }
            let mut next = result["nodes"][index].clone();
            merge(&mut next, patch);
            if !has(patch, "textStyle")
                && ["fontFamily", "fontSize", "fontWeight", "lineHeight"]
                    .iter()
                    .any(|field| has(patch, field))
            {
                remove(&mut next, "textStyle");
            }
            if has(&next, "bindings") && !has(patch, "bindings") {
                let bindings = next["bindings"].as_object_mut().unwrap();
                bindings.retain(|field, _| !has(patch, field));
                if bindings.is_empty() {
                    remove(&mut next, "bindings");
                }
            }
            result["nodes"][index] = next;
        } else {
            let removed = components::descendants(&result, &id);
            result["nodes"]
                .as_array_mut()
                .unwrap()
                .retain(|node| !removed.contains(&sid(node, "id")));
        }
    }
    let removed = nodes(&result)
        .iter()
        .filter(|node| {
            let Some((root, master, source)) = previous.get(&sid(node, "id")) else {
                return false;
            };
            if node["componentSourceId"] != *source {
                return false;
            }
            let Some(instance) = components::instance(&result, &sid(node, "id")) else {
                return false;
            };
            if instance["id"] != *root
                || instance["componentId"] != *master
                || !nodes(&result)
                    .iter()
                    .any(|node| node["id"] == *master && yes(node, "component"))
            {
                return false;
            }
            !components::belongs(&result, source, master)
        })
        .map(|node| sid(node, "id"))
        .collect::<BTreeSet<_>>();
    result["nodes"]
        .as_array_mut()
        .unwrap()
        .retain(|node| !removed.contains(&sid(node, "id")));
    validate_document(&result)
}

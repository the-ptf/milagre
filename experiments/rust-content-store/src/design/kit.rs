use super::*;

pub fn resolve(document: &mut Value) -> Result<()> {
    let kit = document.get("kit").cloned();
    for (index, node) in document["nodes"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .enumerate()
    {
        let id = sid(node, "id");
        if (yes(node, "textStyle")
            || node["bindings"]
                .as_object()
                .is_some_and(|map| !map.is_empty()))
            && kit.is_none()
        {
            return Err(Error::at(
                format!("Layer \"{id}\" needs a design kit for its style bindings."),
                &[json!("nodes"), json!(index), json!("textStyle")],
            ));
        }
        if let Some(name) = node.get("textStyle").and_then(Value::as_str) {
            if node["type"] != "text" {
                return Err(error(format!(
                    "Only text layers can use textStyle: \"{id}\"."
                )));
            }
            let kit = kit.as_ref().unwrap();
            let style=kit["textStyles"].get(name).ok_or_else(||Error::at(format!("Text style \"{name}\" does not exist in kit \"{}\". Choose a name from kit.textStyles.",sid(kit,"id")),&[json!("nodes"),json!(index),json!("textStyle")]))?;
            for field in ["fontFamily", "fontSize", "fontWeight", "lineHeight"] {
                remove(node, field);
            }
            merge(node, style);
        }
        if let Some(bindings) = node.get("bindings").cloned() {
            for (field, token) in object(&bindings) {
                let values = &kit.as_ref().unwrap()[if field == "radius" {
                    "radii"
                } else {
                    "spacing"
                }];
                let name = token.as_str().unwrap();
                let value = values.get(name).ok_or_else(|| {
                    Error::at(
                        format!("Kit token \"{name}\" for {id}.{field} does not exist."),
                        &[
                            json!("nodes"),
                            json!(index),
                            json!("bindings"),
                            json!(field),
                        ],
                    )
                })?;
                node[field] = value.clone();
            }
        }
    }
    if let Some(kit) = kit {
        let mut colors = kit["colors"].clone();
        if let Some(tokens) = document.get("tokens") {
            merge(&mut colors, tokens);
        }
        document["tokens"] = colors;
    }
    Ok(())
}
fn typography(node: &Value) -> Value {
    json!({"fontFamily":node["fontFamily"].as_str().unwrap_or("Inter, Arial, sans-serif").split(',').map(|part|trim(part).to_lowercase()).collect::<Vec<_>>().join(","),"fontSize":node.get("fontSize").unwrap_or(&json!(16)),"fontWeight":node.get("fontWeight").unwrap_or(&json!(400)),"lineHeight":node.get("lineHeight").unwrap_or(&json!(1.35))})
}
fn fill(node: &Value) -> &str {
    match node["type"].as_str().unwrap() {
        "text" | "icon" => "#202720",
        "frame" => "transparent",
        "image" if yes(node, "src") => "transparent",
        _ => "#d8ded8",
    }
}
pub(super) fn equivalent(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| equivalent(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, a)| b.get(key).is_some_and(|b| equivalent(a, b)))
        }
        _ => a == b,
    }
}
/// Enforce strict kit consistency on a validated source document before saving.
/// Advisory documents remain editable and retain their policy and exceptions.
pub fn validate_consistency(document: &Value) -> Result<()> {
    if document["consistency"]["mode"] != "strict" {
        return Ok(());
    }
    let Some(kit) = document.get("kit") else {
        return Err(Error::at("Strict consistency requires a pinned project kit. Read design_kit_read and set document.kit.",&[json!("kit")]));
    };
    for field in ["colors", "textStyles", "spacing", "radii"] {
        if object(&kit[field]).is_empty() {
            return Err(Error::at(
                format!("Strict consistency requires at least one {field} entry in the kit."),
                &[json!("kit"), json!(field)],
            ));
        }
    }
    let issues = warnings(document)
        .into_iter()
        .filter(|warning| warning["kind"] == "kit-drift")
        .map(|warning| json!({"path":warning["path"],"message":warning["message"]}))
        .collect::<Vec<_>>();
    if !issues.is_empty() {
        let mut error = Error::coded(
            "DESIGN_KIT_DRIFT",
            format!(
                "Strict kit consistency: {} violation(s). {}",
                issues.len(),
                issues
                    .iter()
                    .take(5)
                    .map(|issue| issue["message"].as_str().unwrap())
                    .collect::<Vec<_>>()
                    .join(" ")
            ),
        );
        error.issues = Some(Box::new(json!(issues)));
        return Err(error);
    }
    Ok(())
}

pub(super) fn warnings(document: &Value) -> Vec<Value> {
    let Some(kit) = document.get("kit") else {
        return vec![];
    };
    let mut warnings = Vec::new();
    let mut add = |node_id: &str, field: &str, value: Value, message: String| {
        let exception = document["consistency"]["exceptions"]
            .as_array()
            .and_then(|exceptions| {
                exceptions.iter().find(|e| {
                    e["nodeId"] == node_id && e["field"] == field && equivalent(&e["value"], &value)
                })
            });
        let path = if node_id == "$document" {
            field.split('.').map(|part| json!(part)).collect::<Vec<_>>()
        } else {
            vec![
                json!("nodes"),
                json!(nodes(document)
                    .iter()
                    .position(|node| node["id"] == node_id)
                    .unwrap()),
                json!(field),
            ]
        };
        warnings.push(json!({"id":node_id,"field":field,"actual":value,"path":path,"kind":if exception.is_some(){"kit-exception"}else{"kit-drift"},"message":if let Some(exception)=exception {format!("{message} Exception: {}",exception["reason"].as_str().unwrap())}else{message}}));
    };
    let label = format!("{} v{}", sid(kit, "id"), jsjson::to_string(&kit["version"]));
    for (name, expected) in object(&kit["colors"]) {
        let value = document["tokens"].get(name).unwrap_or(expected);
        if colors::key(value.as_str().unwrap()) != colors::key(expected.as_str().unwrap()) {
            add(
                "$document",
                &format!("tokens.{name}"),
                value.clone(),
                format!("Color token \"{name}\" overrides kit {label}. Restore the kit color."),
            );
        }
    }
    let palette = object(&kit["colors"])
        .values()
        .map(|value| colors::key(value.as_str().unwrap()).unwrap())
        .collect::<Vec<_>>();
    let resolved = |value: &str| {
        if let Some(name) = value.strip_prefix('$') {
            sid(&document["tokens"], name)
        } else {
            value.to_owned()
        }
    };
    let outside = |value: &str| {
        let value = resolved(value);
        let paint = colors::key(&value);
        !palette.is_empty()
            && paint.is_some_and(|paint| {
                paint.0 != "none" && paint.1 != 0.0 && !palette.contains(&paint)
            })
    };
    let background = document["background"].as_str().unwrap_or("#ffffff");
    if outside(background) {
        add(
            "$document",
            "background",
            json!(resolved(background)),
            format!("Document background uses a color outside kit {label}. Use a palette color."),
        );
    }
    let styles = object(&kit["textStyles"])
        .values()
        .map(typography)
        .collect::<Vec<_>>();
    let by_id = nodes(document)
        .iter()
        .map(|node| (sid(node, "id"), node))
        .collect::<BTreeMap<_, _>>();
    for node in nodes(document) {
        let mut ancestor = Some(node);
        let mut hidden = false;
        for _ in 0..33 {
            let Some(node) = ancestor else {
                break;
            };
            if yes(node, "hidden") {
                hidden = true;
                break;
            }
            ancestor = by_id.get(&sid(node, "parentId")).copied();
        }
        if hidden {
            continue;
        }
        let id = sid(node, "id");
        for field in ["fill", "stroke"] {
            let value = node[field]
                .as_str()
                .or_else(|| (field == "fill").then(|| fill(node)));
            if let Some(value) = value.filter(|value| outside(value)) {
                add(
                    &id,
                    field,
                    json!(resolved(value)),
                    format!("{id}.{field} uses a color outside kit {label}. Use a palette color."),
                );
            }
        }
        for field in ["gap", "padding", "radius", "minWidth", "minHeight"] {
            if ["minWidth", "minHeight"].contains(&field) && !yes(&node["bindings"], field) {
                continue;
            }
            let Some(value) = node.get(field) else {
                continue;
            };
            let values = object(
                &kit[if field == "radius" {
                    "radii"
                } else {
                    "spacing"
                }],
            );
            if value.as_f64() != Some(0.0)
                && !values.is_empty()
                && !values.values().any(|item| equivalent(item, value))
            {
                add(
                    &id,
                    field,
                    value.clone(),
                    format!("{id}.{field} is outside kit {label}. Bind an existing token."),
                );
            }
        }
        if node["type"] == "text"
            && !styles.is_empty()
            && !styles
                .iter()
                .any(|style| equivalent(style, &typography(node)))
        {
            add(&id,"typography",typography(node),format!("Text \"{id}\" does not match a text style from kit {label}. Set textStyle to a kit style."));
        }
    }
    warnings
}

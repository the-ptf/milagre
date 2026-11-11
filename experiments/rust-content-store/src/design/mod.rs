//! Structured Design source validation and batched edits, without a renderer.
//! Operations return a new document; callers must render it and enforce pinned-kit
//! authority before persisting a source/preview revision.
mod colors;
mod components;
mod kit;
mod kits;
mod layout;
pub use kits::{validate_kit, DesignKits, ProjectForChat};
pub use layout::{layout, Bounds};
mod operations;
mod render;
pub use render::{render_html, render_html_with_options};
mod schema;
mod store;
pub use store::{KitReader, PreparedDesign, Renderer};

use crate::{
    validation::{trim, utf8},
    Error, Result,
};
use milagre_owner_store::jsjson;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};

/// Check strict consistency on a structurally valid Design source.
pub fn validate_consistency(document: &Value) -> Result<()> {
    kit::validate_consistency(&validate_document(document)?)
}
pub use operations::apply_operations;

fn child(path: &[Value], key: impl Into<Value>) -> Vec<Value> {
    schema::child(path, key.into())
}
fn object(value: &Value) -> &Map<String, Value> {
    value.as_object().expect("validated Design object")
}
fn nodes(value: &Value) -> &[Value] {
    value["nodes"].as_array().expect("validated Design nodes")
}
fn sid(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_owned()
}
fn has(value: &Value, key: &str) -> bool {
    value.get(key).is_some()
}
fn yes(value: &Value, key: &str) -> bool {
    jsjson::truthy(value.get(key))
}
fn remove(value: &mut Value, key: &str) {
    value.as_object_mut().unwrap().shift_remove(key);
}
fn merge(target: &mut Value, patch: &Value) {
    for (k, v) in object(patch) {
        target[k] = v.clone();
    }
}
fn error(message: impl Into<String>) -> Error {
    Error::new(message)
}

/// Parse the saved schema, resolve kit bindings, check the tree, and expand linked
/// components exactly as ordinary saved layers. No layout or font loading occurs.
pub fn validate_document(input: &Value) -> Result<Value> {
    checked(input, true)
}
fn checked(input: &Value, synchronize: bool) -> Result<Value> {
    let mut document = schema::parse(&schema::contract()["document"], input, &[])?;
    refine_document(&document, &[])?;
    kit::resolve(&mut document)?;
    if jsjson::to_string(&document).encode_utf16().count() > 1_000_000 {
        return Err(error(
            "A design document is limited to 1,000,000 characters.",
        ));
    }
    let mut by_id = BTreeMap::new();
    for node in nodes(&document) {
        let id = sid(node, "id");
        if by_id.insert(id.clone(), node).is_some() {
            return Err(error(format!("Layer id \"{id}\" is duplicated.")));
        }
    }
    let check_color = |value: Option<&Value>, path: &[Value]| -> Result<()> {
        if let Some(value) = value
            .and_then(Value::as_str)
            .filter(|value| value.starts_with('$'))
        {
            if document["tokens"].get(&value[1..]).is_none() {
                return Err(Error::at(format!("Color token \"{value}\" does not exist. Add it to tokens or the pinned kit."),path));
            }
        }
        Ok(())
    };
    check_color(document.get("background"), &[json!("background")])?;
    for (index, node) in nodes(&document).iter().enumerate() {
        let id = sid(node, "id");
        for field in ["fill", "stroke"] {
            check_color(
                node.get(field),
                &[json!("nodes"), json!(index), json!(field)],
            )?;
        }
        if node["type"] == "icon" {
            let name = sid(node, "icon");
            if name.is_empty() {
                return Err(error(format!("Icon layer \"{id}\" needs an icon name.")));
            }
            if !schema::contract()["icons"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item == &name)
            {
                return Err(error(format!(
                    "Unknown icon \"{name}\" on layer \"{id}\". Did you mean {}?",
                    icon_suggestions(&name).join(", ")
                )));
            }
            let unsupported = ["stroke", "radius", "text", "src"]
                .into_iter()
                .filter(|field| has(node, field))
                .collect::<Vec<_>>();
            if !unsupported.is_empty() {
                return Err(error(format!("Icon layer \"{id}\" can't use {}. Use fill for its color and strokeWidth for its line weight.",unsupported.join(", "))));
            }
        } else if has(node, "icon") {
            return Err(error(format!(
                "Only icon layers use \"icon\"; \"{id}\" is a {}.",
                sid(node, "type")
            )));
        }
        let mut seen = BTreeSet::from([id.clone()]);
        let mut parent = node.get("parentId");
        while let Some(parent_id) = parent.and_then(Value::as_str) {
            if seen.contains(parent_id) {
                return Err(error(format!("Layer \"{id}\" has a circular parent.")));
            }
            if seen.len() >= 32 {
                return Err(error("Design layers can nest at most 32 levels."));
            }
            seen.insert(parent_id.to_owned());
            let node = by_id
                .get(parent_id)
                .ok_or_else(|| error(format!("Parent layer \"{parent_id}\" does not exist.")))?;
            if node["type"] != "frame" {
                return Err(error(format!(
                    "Parent layer \"{parent_id}\" must be a frame."
                )));
            }
            parent = node.get("parentId");
        }
    }
    if synchronize {
        checked(&components::synchronize(document)?, false)
    } else {
        Ok(document)
    }
}
fn icon_suggestions(name: &str) -> Vec<String> {
    let a = jsjson::to_utf16(name);
    let mut ranked = schema::contract()["icons"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| {
            let name = value.as_str().unwrap();
            let b = jsjson::to_utf16(name);
            let mut row = (0..=b.len()).collect::<Vec<_>>();
            for (i, ac) in a.iter().enumerate() {
                let mut previous = row[0];
                row[0] = i + 1;
                for (j, bc) in b.iter().enumerate() {
                    let current = row[j + 1];
                    row[j + 1] = (current + 1)
                        .min(row[j] + 1)
                        .min(previous + usize::from(ac != bc));
                    previous = current;
                }
            }
            (row[b.len()], name.to_owned())
        })
        .collect::<Vec<_>>();
    // Lucide names contain only ASCII lowercase letters, digits and dashes.
    ranked.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    ranked.into_iter().take(3).map(|(_, name)| name).collect()
}
fn color(value: &Value, reference: bool, path: &[Value]) -> Result<()> {
    let value = value.as_str().unwrap();
    let token = reference
        && regex::Regex::new(r"^\$[a-zA-Z][a-zA-Z0-9_.-]{0,95}$")
            .unwrap()
            .is_match(value);
    if !token && colors::paint(value).is_none() {
        return Err(Error::at("Use a valid CSS color.", path));
    }
    Ok(())
}
fn font(value: &Value, path: &[Value]) -> Result<()> {
    let regex = regex::Regex::new(r"^[\p{L}\p{N} ._-]+$").unwrap();
    if !value
        .as_str()
        .unwrap()
        .split(',')
        .all(|part| !trim(part).is_empty() && regex.is_match(part))
    {
        return Err(Error::at(
            "Use non-empty font family names separated by commas.",
            path,
        ));
    }
    Ok(())
}
fn refine_node(node: &Value, path: &[Value]) -> Result<()> {
    for field in ["fill", "stroke"] {
        if let Some(value) = node.get(field) {
            color(value, true, &child(path, field))?;
        }
    }
    if let Some(value) = node.get("fontFamily") {
        font(value, &child(path, "fontFamily"))?;
    }
    if let Some(value) = node.get("src") {
        let value = value.as_str().unwrap();
        let https = value
            .get(..8)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("https://"))
            && value.get(8..).is_some_and(|rest| {
                !rest.is_empty()
                    && rest.chars().all(|c| {
                        !crate::validation::whitespace(c) && !['<', '>', '"', '\''].contains(&c)
                    })
            });
        if !https
            && !regex::Regex::new(r"^data:image/(?:png|jpeg|webp|gif|avif);base64,[a-zA-Z0-9+/=]+$")
                .unwrap()
                .is_match(value)
        {
            return Err(Error::at(
                "Images need an HTTPS URL or an inline PNG, JPEG, WebP, GIF or AVIF.",
                &child(path, "src"),
            ));
        }
    }
    Ok(())
}
fn refine_document(document: &Value, path: &[Value]) -> Result<()> {
    if let Some(value) = document.get("background") {
        color(value, true, &child(path, "background"))?;
    }
    if let Some(tokens) = document.get("tokens") {
        if object(tokens).len() > 200 {
            return Err(Error::at(
                "Use at most 200 color tokens.",
                &child(path, "tokens"),
            ));
        }
        for (name, value) in object(tokens) {
            color(value, false, &child(&child(path, "tokens"), name.clone()))?;
        }
    }
    if let Some(kit) = document.get("kit") {
        for (field, limit) in [
            ("colors", 200),
            ("textStyles", 100),
            ("spacing", 100),
            ("radii", 100),
            ("components", 30),
        ] {
            if let Some(map) = kit.get(field) {
                if object(map).len() > limit {
                    return Err(Error::at(
                        format!("Use at most {limit} entries."),
                        &child(&child(path, "kit"), field),
                    ));
                }
                if field == "colors" {
                    for (name, value) in object(map) {
                        color(
                            value,
                            false,
                            &child(&child(&child(path, "kit"), field), name.clone()),
                        )?;
                    }
                }
                if field == "textStyles" {
                    for (name, value) in object(map) {
                        if let Some(family) = value.get("fontFamily") {
                            font(
                                family,
                                &child(
                                    &child(&child(&child(path, "kit"), field), name.clone()),
                                    "fontFamily",
                                ),
                            )?;
                        }
                    }
                }
            }
        }
    }
    if let Some(layers) = document["nodes"].as_array() {
        for (index, node) in layers.iter().enumerate() {
            refine_node(node, &child(&child(path, "nodes"), json!(index)))?;
        }
    }
    Ok(())
}

//! The saved document's shape (`designDocumentSchema`, `nodeSchema`, `designKitSchema` in `design.mjs` and
//! `design-kit.mjs`), checked on JSON the way zod parses it: unknown fields are errors, optional fields may be absent
//! but never `null`, numbers keep their ranges. A parsed document is a copy with its keys in the schema's order.
//!
//! The messages say what is wrong in the host's words where the host writes its own (`Error(...)`); where zod writes
//! the message, this names the field and the rule instead of copying zod's JSON issue list.

use serde_json::{Map, Value};

use crate::logic::design_layout::paint;

pub type Node = Map<String, Value>;

/// Node fields in `nodeSchema` order.
pub const NODE_FIELDS: [&str; 39] = [
    "id",
    "name",
    "type",
    "parentId",
    "x",
    "y",
    "width",
    "height",
    "widthMode",
    "heightMode",
    "minWidth",
    "minHeight",
    "fill",
    "stroke",
    "strokeWidth",
    "radius",
    "opacity",
    "text",
    "fontSize",
    "fontFamily",
    "fontWeight",
    "lineHeight",
    "textAlign",
    "src",
    "icon",
    "layout",
    "gap",
    "padding",
    "align",
    "justify",
    "hidden",
    "locked",
    "component",
    "componentId",
    "textStyle",
    "bindings",
    "componentProperties",
    "componentValues",
    "componentSourceId",
];

/// Document fields in `designDocumentSchema` order.
pub const DOCUMENT_FIELDS: [&str; 8] = ["schemaVersion", "width", "height", "background", "kit", "consistency", "tokens", "nodes"];

/// `^[a-zA-Z][a-zA-Z0-9_.-]{0,95}$`: a layer id, token, text style or kit key.
pub fn valid_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 96
        && bytes[0].is_ascii_alphabetic()
        && bytes[1..].iter().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}

/// `validDesignFontFamily`: comma-separated family names of letters, digits, spaces, dots, underscores and dashes.
pub fn valid_font_family(value: &str) -> bool {
    value.split(',').all(|family| {
        !family.trim().is_empty() && family.chars().all(|c| c.is_alphabetic() || c.is_numeric() || matches!(c, ' ' | '.' | '_' | '-'))
    })
}

/// A literal CSS colour (`designPaint` accepts it) of at most 100 characters.
pub fn literal_color(value: &str) -> bool {
    value.chars().count() <= 100 && paint(value).is_some()
}

/// A literal colour or a `$token` reference.
pub fn color(value: &str) -> bool {
    match value.strip_prefix('$') {
        Some(token) => valid_id(token),
        None => literal_color(value),
    }
}

/// An HTTPS URL or an inline PNG, JPEG, WebP, GIF or AVIF.
pub fn valid_src(value: &str) -> bool {
    if value.chars().count() > 500_000 {
        return false;
    }
    if value.len() > 8 && value[..8].eq_ignore_ascii_case("https://") {
        let rest = &value[8..];
        return !rest.is_empty() && !rest.chars().any(|c| c.is_whitespace() || matches!(c, '<' | '>' | '"' | '\''));
    }
    let Some(rest) = value.strip_prefix("data:image/") else { return false };
    let Some((kind, data)) = rest.split_once(";base64,") else { return false };
    matches!(kind, "png" | "jpeg" | "webp" | "gif" | "avif")
        && !data.is_empty()
        && data.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='))
}

fn number_in(value: &Value, min: f64, max: f64, int: bool) -> bool {
    value.as_f64().is_some_and(|v| v.is_finite() && v >= min && v <= max && (!int || v.fract() == 0.0))
}

fn string_max(value: &Value, max: usize) -> bool {
    value.as_str().is_some_and(|s| s.encode_utf16().count() <= max)
}

fn one_of(value: &Value, options: &[&str]) -> bool {
    value.as_str().is_some_and(|s| options.contains(&s))
}

/// Checks one node field's value; `Err` names the rule it breaks.
fn node_field(key: &str, value: &Value) -> Result<(), String> {
    let ok = match key {
        "id" | "parentId" | "componentId" | "textStyle" | "componentSourceId" => value.as_str().is_some_and(valid_id),
        "name" => string_max(value, 160),
        "type" => one_of(value, &["frame", "text", "rectangle", "ellipse", "image", "icon"]),
        "x" | "y" => number_in(value, -32000.0, 32000.0, false),
        "width" | "height" => number_in(value, 1.0, 16000.0, false),
        "widthMode" | "heightMode" => one_of(value, &["fixed", "hug", "fill"]),
        "minWidth" | "minHeight" => number_in(value, 0.0, 16000.0, false),
        "fill" | "stroke" => value.as_str().is_some_and(color),
        "strokeWidth" | "radius" | "gap" | "padding" => number_in(value, 0.0, 2000.0, false),
        "opacity" => number_in(value, 0.0, 1.0, false),
        "text" => string_max(value, 20000),
        "fontSize" => number_in(value, 1.0, 1000.0, false),
        "fontFamily" => value.as_str().is_some_and(|s| s.encode_utf16().count() <= 160 && valid_font_family(s)),
        "fontWeight" => number_in(value, 100.0, 900.0, true),
        "lineHeight" => number_in(value, 0.5, 5.0, false),
        "textAlign" => one_of(value, &["left", "center", "right"]),
        "src" => value.as_str().is_some_and(valid_src),
        "icon" => string_max(value, 64),
        "layout" => one_of(value, &["free", "horizontal", "vertical"]),
        "align" => one_of(value, &["start", "center", "end"]),
        "justify" => one_of(value, &["start", "center", "end", "space-between"]),
        "hidden" | "locked" | "component" => value.is_boolean(),
        "bindings" => value.as_object().is_some_and(|b| {
            b.iter().all(|(k, v)| {
                matches!(k.as_str(), "padding" | "gap" | "minWidth" | "minHeight" | "radius") && v.as_str().is_some_and(valid_id)
            })
        }),
        "componentProperties" => value.as_object().is_some_and(|props| {
            props.iter().all(|(name, prop)| {
                valid_id(name)
                    && prop.as_object().is_some_and(|p| {
                        p.keys().all(|k| matches!(k.as_str(), "nodeId" | "field" | "options"))
                            && p.get("nodeId").and_then(Value::as_str).is_some_and(valid_id)
                            && p.get("field").is_some_and(|f| one_of(f, &["text", "icon", "hidden", "fill", "opacity"]))
                            && p.get("options")
                                .is_none_or(|o| o.as_array().is_some_and(|o| (1..=20).contains(&o.len()) && o.iter().all(property_value)))
                    })
            })
        }),
        "componentValues" => value.as_object().is_some_and(|values| values.iter().all(|(k, v)| valid_id(k) && property_value(v))),
        _ => return Err(format!("Unknown layer field \"{key}\".")),
    };
    if ok { Ok(()) } else { Err(format!("Invalid {key}.")) }
}

fn property_value(value: &Value) -> bool {
    match value {
        Value::String(s) => s.encode_utf16().count() <= 20000,
        Value::Bool(_) => true,
        Value::Number(n) => n.as_f64().is_some_and(f64::is_finite),
        _ => false,
    }
}

/// `nodeSchema.parse`: a copy of the layer with its fields in schema order.
pub fn parse_node(value: &Value) -> Result<Node, String> {
    let object = value.as_object().ok_or("A layer is a JSON object.")?;
    let label = object.get("id").and_then(Value::as_str).unwrap_or("?");
    for (key, field) in object {
        node_field(key, field).map_err(|error| format!("Layer \"{label}\": {error}"))?;
    }
    for required in ["id", "type", "width", "height"] {
        if !object.contains_key(required) {
            return Err(format!("Layer \"{label}\" needs {required}."));
        }
    }
    Ok(ordered(object, &NODE_FIELDS))
}

/// A patch of node fields (`nodeSchema.omit({ id }).partial().strict()`).
pub fn check_patch(patch: &Value) -> Result<(), String> {
    let object = patch.as_object().ok_or("A patch is a JSON object.")?;
    for (key, value) in object {
        if key == "id" {
            return Err("A patch cannot change a layer's id.".into());
        }
        node_field(key, value)?;
    }
    Ok(())
}

fn ordered(object: &Map<String, Value>, order: &[&str]) -> Map<String, Value> {
    let mut out = Map::new();
    for key in order {
        if let Some(value) = object.get(*key) {
            out.insert((*key).to_string(), value.clone());
        }
    }
    out
}

fn check_map(value: &Value, max: usize, check: impl Fn(&Value) -> bool) -> bool {
    value.as_object().is_some_and(|m| m.len() <= max && m.iter().all(|(k, v)| valid_id(k) && check(v)))
}

fn check_kit(value: &Value) -> Result<(), String> {
    let kit = value.as_object().ok_or("A kit is a JSON object.")?;
    let allowed = ["id", "version", "title", "colors", "textStyles", "spacing", "radii", "components", "references"];
    if let Some(key) = kit.keys().find(|k| !allowed.contains(&k.as_str())) {
        return Err(format!("Unknown kit field \"{key}\"."));
    }
    let text_style = |v: &Value| {
        v.as_object().is_some_and(|s| {
            s.keys().all(|k| matches!(k.as_str(), "fontFamily" | "fontSize" | "fontWeight" | "lineHeight"))
                && s.get("fontSize").is_some_and(|f| number_in(f, 1.0, 1000.0, false))
                && s.get("fontFamily").is_none_or(|f| f.as_str().is_some_and(|f| f.encode_utf16().count() <= 160 && valid_font_family(f)))
                && s.get("fontWeight").is_none_or(|f| number_in(f, 100.0, 900.0, true))
                && s.get("lineHeight").is_none_or(|f| number_in(f, 0.5, 5.0, false))
        })
    };
    let spacing = |v: &Value| number_in(v, 0.0, 2000.0, false);
    let ok = kit.get("id").and_then(Value::as_str).is_some_and(valid_id)
        && kit.get("version").is_some_and(|v| number_in(v, 1.0, f64::MAX, true))
        && kit.get("title").and_then(Value::as_str).is_some_and(|t| (1..=120).contains(&t.encode_utf16().count()))
        && kit.get("colors").is_some_and(|c| check_map(c, 200, |v| v.as_str().is_some_and(literal_color)))
        && kit.get("textStyles").is_some_and(|t| check_map(t, 100, text_style))
        && kit.get("spacing").is_some_and(|s| check_map(s, 100, spacing))
        && kit.get("radii").is_some_and(|r| check_map(r, 100, spacing))
        && kit.get("components").is_none_or(|c| {
            check_map(c, 30, |v| v.as_array().is_some_and(|a| (1..=200).contains(&a.len()) && a.iter().all(Value::is_object)))
        })
        && kit.get("references").is_none_or(|r| r.as_array().is_some_and(|r| r.len() <= 20));
    if ok { Ok(()) } else { Err("Invalid design kit.".into()) }
}

fn check_consistency(value: &Value) -> Result<(), String> {
    let ok = value.as_object().is_some_and(|c| {
        c.keys().all(|k| k == "mode" || k == "exceptions")
            && c.get("mode").is_some_and(|m| one_of(m, &["advisory", "strict"]))
            && c.get("exceptions").is_none_or(|e| e.as_array().is_some_and(|e| e.len() <= 100 && e.iter().all(Value::is_object)))
    });
    if ok { Ok(()) } else { Err("Invalid consistency.".into()) }
}

/// Checks one document-level field (`designDocumentSchema` without `nodes`).
pub fn document_field(key: &str, value: &Value) -> Result<(), String> {
    let ok = match key {
        "schemaVersion" => value.as_f64() == Some(1.0),
        "width" | "height" => number_in(value, 240.0, 3840.0, true),
        "background" => value.as_str().is_some_and(color),
        "kit" => return check_kit(value),
        "consistency" => return check_consistency(value),
        "tokens" => check_map(value, 200, |v| v.as_str().is_some_and(literal_color)),
        _ => return Err(format!("Unknown document field \"{key}\".")),
    };
    if ok { Ok(()) } else { Err(format!("Invalid {key}.")) }
}

/// `designDocumentSchema.parse`: a copy of the document with its fields and its layers' fields in schema order.
pub fn parse_document(value: &Value) -> Result<Map<String, Value>, String> {
    let object = value.as_object().ok_or("A design document is a JSON object.")?;
    for (key, field) in object {
        if key != "nodes" {
            document_field(key, field)?;
        }
    }
    for required in ["schemaVersion", "width", "height", "nodes"] {
        if !object.contains_key(required) {
            return Err(format!("A design document needs {required}."));
        }
    }
    let nodes = object["nodes"].as_array().ok_or("A design document's nodes are a list.")?;
    if nodes.len() > 1000 {
        return Err("A design document has at most 1000 layers.".into());
    }
    let mut document = ordered(object, &DOCUMENT_FIELDS);
    document.insert("nodes".into(), Value::Array(nodes.iter().map(|n| parse_node(n).map(Value::Object)).collect::<Result<_, _>>()?));
    Ok(document)
}

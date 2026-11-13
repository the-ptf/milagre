//! Interpret the generated Zod input contract. Unsupported schema words fail closed.
use milagre_owner_store::jsjson;
use regex::Regex;
use serde_json::{json, Map, Value};

pub fn parse(schema: &Value, input: &Value) -> Result<Value, String> {
    let mut errors = Vec::new();
    let value = visit(schema, Some(input), "", &mut errors, 0);
    if errors.is_empty() {
        Ok(value)
    } else {
        Err(format!("Invalid arguments: {}", errors.join("; ")))
    }
}
fn visit(
    s: &Value,
    v: Option<&Value>,
    path: &str,
    errors: &mut Vec<String>,
    depth: usize,
) -> Value {
    let at = if path.is_empty() { "input" } else { path };
    let fail = |errors: &mut Vec<String>, message: String| errors.push(format!("{at} {message}"));
    if depth > 80 {
        fail(errors, "Input nesting is too deep".into());
        return Value::Null;
    }
    for key in s.as_object().into_iter().flatten().map(|(k, _)| k.as_str()) {
        if ![
            "$schema",
            "type",
            "properties",
            "required",
            "additionalProperties",
            "propertyNames",
            "items",
            "minimum",
            "maximum",
            "exclusiveMinimum",
            "exclusiveMaximum",
            "minLength",
            "maxLength",
            "minItems",
            "maxItems",
            "pattern",
            "const",
            "enum",
            "anyOf",
            "oneOf",
            "description",
            "x-object-mode",
        ]
        .contains(&key)
        {
            fail(errors, format!("Unsupported input schema: {key}"));
            return Value::Null;
        }
    }
    if let Some(options) = s
        .get("anyOf")
        .or_else(|| s.get("oneOf"))
        .and_then(Value::as_array)
    {
        for option in options {
            let mut attempt = Vec::new();
            let result = visit(option, v, path, &mut attempt, depth + 1);
            if attempt.is_empty() {
                return result;
            }
        }
        fail(errors, "Invalid input".into());
        return Value::Null;
    }
    if let Some(expected) = s.get("const") {
        if v != Some(expected) {
            fail(
                errors,
                format!("Invalid input: expected {}", jsjson::to_string(expected)),
            );
            return Value::Null;
        }
    }
    if let Some(options) = s["enum"].as_array() {
        if !v.is_some_and(|v| options.contains(v)) {
            fail(
                errors,
                format!(
                    "Invalid option: expected one of {}",
                    options
                        .iter()
                        .map(jsjson::to_string)
                        .collect::<Vec<_>>()
                        .join("|")
                ),
            );
            return Value::Null;
        }
    }
    let received = match v {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::String(_)) => "string",
        Some(Value::Number(_)) => "number",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    };
    let ty = s["type"].as_str();
    let valid = match ty {
        None => true,
        Some("string") => received == "string",
        Some("number" | "integer") => received == "number",
        Some("object") => received == "object",
        Some("array") => received == "array",
        Some("boolean") => received == "boolean",
        Some("null") => received == "null",
        _ => false,
    };
    if !valid {
        fail(
            errors,
            format!(
                "Invalid input: expected {}, received {received}",
                if ty == Some("object") && s.get("propertyNames").is_some() {
                    "record"
                } else if ty == Some("integer") {
                    "number"
                } else {
                    ty.unwrap_or("value")
                }
            ),
        );
        return Value::Null;
    }
    if ty == Some("integer") && v.and_then(Value::as_f64).is_some_and(|n| n.fract() != 0.0) {
        fail(
            errors,
            "Invalid input: expected int, received number".into(),
        );
        return Value::Null;
    }
    let Some(v) = v else {
        return Value::Null;
    };
    if ty == Some("integer") {
        if let Some(n) = v.as_f64().filter(|n| n.abs() > 9_007_199_254_740_991.0) {
            fail(
                errors,
                format!(
                    "{}: expected int to be {}9007199254740991",
                    if n > 0.0 { "Too big" } else { "Too small" },
                    if n > 0.0 { "<=" } else { ">=-" }
                ),
            );
            return Value::Null;
        }
    }
    if let Some(text) = v.as_str() {
        let units = jsjson::to_utf16(text);
        let length = std::char::decode_utf16(units).count();
        for (key, comparison, word) in [
            ("minLength", true, "Too small"),
            ("maxLength", false, "Too big"),
        ] {
            if let Some(n) = s[key].as_u64() {
                if if comparison {
                    length < n as usize
                } else {
                    length > n as usize
                } {
                    fail(
                        errors,
                        format!(
                            "{word}: expected string to have {}{n} characters",
                            if comparison { ">=" } else { "<=" }
                        ),
                    );
                }
            }
        }
        if let Some(pattern) = s["pattern"].as_str() {
            match Regex::new(pattern) {
                Ok(pattern) if pattern.is_match(text) => {}
                _ => fail(
                    errors,
                    format!("Invalid string: must match pattern /{pattern}/"),
                ),
            }
        }
    }
    if let Some(n) = v.as_f64() {
        for (key, low, inclusive) in [
            ("minimum", true, true),
            ("maximum", false, true),
            ("exclusiveMinimum", true, false),
            ("exclusiveMaximum", false, false),
        ] {
            if let Some(limit) = s[key].as_f64() {
                let wrong = if low {
                    if inclusive {
                        n < limit
                    } else {
                        n <= limit
                    }
                } else if inclusive {
                    n > limit
                } else {
                    n >= limit
                };
                if wrong {
                    fail(
                        errors,
                        format!(
                            "{}: expected number to be {}{}{}",
                            if low { "Too small" } else { "Too big" },
                            if low { ">" } else { "<" },
                            if inclusive { "=" } else { "" },
                            jsjson::to_string(&s[key])
                        ),
                    );
                }
            }
        }
    }
    if let Some(items) = v.as_array() {
        for (key, low) in [("minItems", true), ("maxItems", false)] {
            if let Some(n) = s[key].as_u64() {
                if if low {
                    items.len() < n as usize
                } else {
                    items.len() > n as usize
                } {
                    fail(
                        errors,
                        format!(
                            "{}: expected array to have {}{n} items",
                            if low { "Too small" } else { "Too big" },
                            if low { ">=" } else { "<=" }
                        ),
                    );
                }
            }
        }
        return Value::Array(
            items
                .iter()
                .enumerate()
                .map(|(i, v)| {
                    visit(
                        &s["items"],
                        Some(v),
                        &join(path, &i.to_string()),
                        errors,
                        depth + 1,
                    )
                })
                .collect(),
        );
    }
    if let Some(object) = v.as_object() {
        let mut out = Map::new();
        let properties = s["properties"].as_object();
        if let Some(properties) = properties {
            for (key, schema) in properties {
                let required = s["required"]
                    .as_array()
                    .is_some_and(|a| a.contains(&json!(key)));
                if object.contains_key(key) || required {
                    out.insert(
                        key.clone(),
                        visit(schema, object.get(key), &join(path, key), errors, depth + 1),
                    );
                }
            }
        }
        let extra = object
            .keys()
            .filter(|key| !properties.is_some_and(|p| p.contains_key(*key)))
            .collect::<Vec<_>>();
        if s["x-object-mode"] == "strict" && !extra.is_empty() {
            fail(
                errors,
                format!(
                    "Unrecognized key{}: {}",
                    if extra.len() > 1 { "s" } else { "" },
                    extra
                        .iter()
                        .map(|k| jsjson::to_string(&json!(k)))
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            );
        }
        for key in extra {
            if let Some(key_schema) = s.get("propertyNames") {
                let mut key_errors = Vec::new();
                visit(
                    key_schema,
                    Some(&json!(key)),
                    &join(path, key),
                    &mut key_errors,
                    depth + 1,
                );
                if !key_errors.is_empty() {
                    errors.push(format!("{} Invalid key in record", join(path, key)));
                    continue;
                }
            }

            if let Some(schema) = s.get("additionalProperties").filter(|v| v.is_object()) {
                out.insert(
                    key.clone(),
                    visit(schema, object.get(key), &join(path, key), errors, depth + 1),
                );
            } else if s["x-object-mode"] == "passthrough" || s["additionalProperties"] == true {
                out.insert(key.clone(), object[key].clone());
            }
        }
        return Value::Object(out);
    }
    v.clone()
}
fn join(path: &str, part: &str) -> String {
    if path.is_empty() {
        part.into()
    } else {
        format!("{path}.{part}")
    }
}

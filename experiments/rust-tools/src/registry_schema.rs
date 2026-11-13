//! Strict, deliberately small JSON-schema subset for registered host handlers.
//! Unsupported assertions fail registration instead of being silently ignored.
use crate::*;
fn invalid(message: &str) -> Error {
    Error::coded("HOST_SCHEMA", message)
}
pub(crate) fn check(schema: &Value, depth: usize) -> Result<()> {
    let object = schema
        .as_object()
        .ok_or_else(|| invalid("Registered tool schema must be an object."))?;
    if depth > 32
        || object.keys().any(|key| {
            !matches!(
                key.as_str(),
                "type"
                    | "properties"
                    | "required"
                    | "additionalProperties"
                    | "items"
                    | "enum"
                    | "minLength"
                    | "maxLength"
                    | "minimum"
                    | "maximum"
                    | "minItems"
                    | "maxItems"
                    | "description"
                    | "title"
            )
        })
    {
        return Err(invalid("Unsupported registered tool schema assertion."));
    }
    match schema["type"].as_str() {
        Some("object") => {
            if schema["additionalProperties"] != false || !schema["properties"].is_object() {
                return Err(invalid(
                    "Registered object schemas must declare properties and forbid extra fields.",
                ));
            }
            let properties = schema["properties"].as_object().unwrap();
            for value in properties.values() {
                check(value, depth + 1)?;
            }
            if let Some(required) = schema.get("required") {
                let required = required
                    .as_array()
                    .ok_or_else(|| invalid("Invalid required fields."))?;
                let mut seen = BTreeSet::new();
                for field in required {
                    let name = field
                        .as_str()
                        .ok_or_else(|| invalid("Invalid required field."))?;
                    if !properties.contains_key(name) || !seen.insert(name) {
                        return Err(invalid("Unknown or duplicate required field."));
                    }
                }
            }
        }
        Some("array") => check(&schema["items"], depth + 1)?,
        Some("string" | "number" | "integer" | "boolean" | "null") => {}
        _ => return Err(invalid("Unsupported registered schema type.")),
    }
    if let Some(values) = schema.get("enum") {
        if !values.is_array() || values.as_array().unwrap().is_empty() {
            return Err(invalid("Invalid registered enum."));
        }
    }
    for name in ["minLength", "maxLength", "minItems", "maxItems"] {
        if schema.get(name).is_some_and(|n| n.as_u64().is_none()) {
            return Err(invalid("Invalid registered schema bound."));
        }
    }
    for name in ["minimum", "maximum"] {
        if schema.get(name).is_some_and(|n| n.as_f64().is_none()) {
            return Err(invalid("Invalid registered numeric bound."));
        }
    }
    Ok(())
}
pub(crate) fn validate(schema: &Value, value: &Value) -> Result<()> {
    if schema
        .get("enum")
        .is_some_and(|values| !values.as_array().unwrap().contains(value))
    {
        return Err(invalid("Registered tool argument is outside its enum."));
    }
    match schema["type"].as_str().unwrap() {
        "object" => {
            let object = value.as_object().ok_or_else(|| {
                invalid("Registered tool arguments must match their object schema.")
            })?;
            let properties = schema["properties"].as_object().unwrap();
            if let Some(required) = schema["required"].as_array() {
                if required
                    .iter()
                    .any(|key| !object.contains_key(key.as_str().unwrap()))
                {
                    return Err(invalid("Missing required registered tool argument."));
                }
            }
            for (key, value) in object {
                let child = properties
                    .get(key)
                    .ok_or_else(|| invalid("Unexpected registered tool argument."))?;
                validate(child, value)?;
            }
        }
        "array" => {
            let values = value
                .as_array()
                .ok_or_else(|| invalid("Registered tool argument must be an array."))?;
            bound(schema, values.len(), "minItems", "maxItems")?;
            for value in values {
                validate(&schema["items"], value)?;
            }
        }
        "string" => {
            let value = value
                .as_str()
                .ok_or_else(|| invalid("Registered tool argument must be a string."))?;
            bound(schema, value.chars().count(), "minLength", "maxLength")?;
        }
        "number" | "integer" => {
            let number = value
                .as_f64()
                .ok_or_else(|| invalid("Registered tool argument must be numeric."))?;
            if schema["type"] == "integer" && number.fract() != 0.0
                || schema["minimum"].as_f64().is_some_and(|v| number < v)
                || schema["maximum"].as_f64().is_some_and(|v| number > v)
            {
                return Err(invalid("Registered tool number is outside its schema."));
            }
        }
        "boolean" if value.is_boolean() => {}
        "null" if value.is_null() => {}
        _ => return Err(invalid("Registered tool argument has the wrong type.")),
    }
    Ok(())
}
fn bound(schema: &Value, length: usize, min: &str, max: &str) -> Result<()> {
    if schema[min].as_u64().is_some_and(|n| length < (n as usize))
        || schema[max].as_u64().is_some_and(|n| length > (n as usize))
    {
        Err(invalid(
            "Registered tool argument exceeds its schema bound.",
        ))
    } else {
        Ok(())
    }
}

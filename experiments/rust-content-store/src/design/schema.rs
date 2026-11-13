//! The structural contract is generated from the production Zod schemas. The small
//! interpreter deliberately accepts only the keywords used by that snapshot.
use super::*;
use std::sync::OnceLock;

pub fn contract() -> &'static Value {
    static CONTRACT: OnceLock<Value> = OnceLock::new();
    CONTRACT.get_or_init(|| {
        serde_json::from_str(include_str!("contract.json")).expect("Design schema snapshot")
    })
}

pub fn parse(schema: &Value, input: &Value, path: &[Value]) -> Result<Value> {
    let fail = |message: &str| Error::at(message, path);
    for key in schema
        .as_object()
        .ok_or_else(|| fail("Invalid schema snapshot."))?
        .keys()
    {
        if ![
            "$schema",
            "type",
            "properties",
            "required",
            "additionalProperties",
            "const",
            "minimum",
            "maximum",
            "exclusiveMinimum",
            "anyOf",
            "oneOf",
            "maxLength",
            "minLength",
            "pattern",
            "propertyNames",
            "minItems",
            "maxItems",
            "items",
            "enum",
            "description",
        ]
        .contains(&key.as_str())
        {
            return Err(Error::coded(
                "UNSUPPORTED_DESIGN_SCHEMA",
                format!("Unsupported Design schema keyword: {key}"),
            ));
        }
    }
    if let Some(choices) = schema
        .get("oneOf")
        .or_else(|| schema.get("anyOf"))
        .and_then(Value::as_array)
    {
        let mut first = None;
        for choice in choices {
            match parse(choice, input, path) {
                Ok(value) => return Ok(value),
                Err(error) => {
                    if first.is_none() {
                        first = Some(error);
                    }
                }
            }
        }
        return Err(first.unwrap_or_else(|| fail("No matching Design value type.")));
    }
    if schema
        .get("const")
        .is_some_and(|value| !jsjson::strict_equals(value, input))
        || schema["enum"].as_array().is_some_and(|values| {
            !values
                .iter()
                .any(|value| jsjson::strict_equals(value, input))
        })
    {
        return Err(fail("Invalid Design enum or literal value."));
    }
    match schema["type"].as_str() {
        Some("object") => {
            let values = input
                .as_object()
                .ok_or_else(|| fail("Expected a Design object."))?;
            let mut output = Map::new();
            if let Some(required) = schema["required"].as_array() {
                for key in required {
                    if !values.contains_key(key.as_str().unwrap()) {
                        return Err(Error::at(
                            "Required Design field is missing.",
                            &child(path, key.clone()),
                        ));
                    }
                }
            }
            if let Some(properties) = schema["properties"].as_object() {
                // Zod emits known fields in schema order, including after updates.
                for (key, subschema) in properties {
                    if let Some(value) = values.get(key) {
                        output.insert(
                            key.clone(),
                            parse(subschema, value, &child(path, json!(key)))?,
                        );
                    }
                }
            }
            for (key, value) in values {
                if schema["properties"].get(key).is_some() {
                    continue;
                }
                let at = child(path, json!(key));
                if schema["additionalProperties"] == false {
                    return Err(Error::at("Unrecognized Design field.", &at));
                }
                if let Some(names) = schema.get("propertyNames") {
                    parse(names, &json!(key), &at)?;
                }
                output.insert(
                    key.clone(),
                    match schema.get("additionalProperties").filter(|v| v.is_object()) {
                        Some(subschema) => parse(subschema, value, &at)?,
                        None => value.clone(),
                    },
                );
            }
            Ok(Value::Object(output))
        }
        Some("array") => {
            let values = input
                .as_array()
                .ok_or_else(|| fail("Expected a Design array."))?;
            bounds(values.len() as f64, schema, "minItems", "maxItems", path)?;
            Ok(Value::Array(
                values
                    .iter()
                    .enumerate()
                    .map(|(index, value)| {
                        parse(&schema["items"], value, &child(path, json!(index)))
                    })
                    .collect::<Result<_>>()?,
            ))
        }
        Some("string") => {
            let raw = input
                .as_str()
                .ok_or_else(|| fail("Expected a Design string."))?;
            // This is the sole transform in the saved Zod schemas.
            let value = if path.last() == Some(&json!("reason"))
                && path.len() >= 3
                && path[path.len() - 3] == "exceptions"
                && path[path.len() - 2].is_number()
            {
                trim(raw)
            } else {
                raw
            };
            bounds(
                char::decode_utf16(jsjson::to_utf16(value)).count() as f64,
                schema,
                "minLength",
                "maxLength",
                path,
            )?;
            if let Some(pattern) = schema["pattern"].as_str() {
                if !regex::Regex::new(pattern)
                    .expect("generated schema pattern")
                    .is_match(value)
                {
                    return Err(fail("Invalid Design identifier."));
                }
            }
            Ok(json!(value))
        }
        Some("number" | "integer") => {
            let number = input
                .as_f64()
                .filter(|number| number.is_finite())
                .ok_or_else(|| fail("Expected a finite Design number."))?;
            if schema["type"] == "integer"
                && (number.fract() != 0.0 || number.abs() > 9_007_199_254_740_991.0)
            {
                return Err(fail("Expected a safe Design integer."));
            }
            bounds(number, schema, "minimum", "maximum", path)?;
            if schema["exclusiveMinimum"]
                .as_f64()
                .is_some_and(|minimum| number <= minimum)
            {
                return Err(fail("Design number is below its minimum."));
            }
            Ok(input.clone())
        }
        Some("boolean") if input.is_boolean() => Ok(input.clone()),
        Some("boolean") => Err(fail("Expected a Design boolean.")),
        None => Ok(input.clone()),
        _ => Err(Error::coded(
            "UNSUPPORTED_DESIGN_SCHEMA",
            "Unsupported Design schema type.",
        )),
    }
}
fn bounds(value: f64, schema: &Value, min: &str, max: &str, path: &[Value]) -> Result<()> {
    if schema[min].as_f64().is_some_and(|limit| value < limit)
        || schema[max].as_f64().is_some_and(|limit| value > limit)
    {
        return Err(Error::at("Design value exceeds its allowed range.", path));
    }
    Ok(())
}
pub fn child(path: &[Value], key: Value) -> Vec<Value> {
    let mut path = path.to_vec();
    path.push(key);
    path
}

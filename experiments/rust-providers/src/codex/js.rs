//! Small JavaScript semantics the ported mappers depend on: UTF-16 lengths and slices, `String(x)`,
//! truthiness, strict equality, `path.basename`, `JSON.stringify(x, replacer, 2)` and ISO dates.

use serde_json::{Map, Value};

pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text.slice(0, units)` in UTF-16 code units. A surrogate pair cut in half is dropped (Rust can't
/// hold a lone surrogate).
pub fn slice_utf16_start(text: &str, units: usize) -> &str {
    let mut count = 0;
    for (index, ch) in text.char_indices() {
        if count + ch.len_utf16() > units {
            return &text[..index];
        }
        count += ch.len_utf16();
    }
    text
}

/// `text.slice(-units)` in UTF-16 code units.
pub fn slice_utf16_end(text: &str, units: usize) -> &str {
    let mut count = 0;
    for (index, ch) in text.char_indices().rev() {
        if count + ch.len_utf16() > units {
            return &text[index + ch.len_utf8()..];
        }
        count += ch.len_utf16();
    }
    text
}

/// JavaScript truthiness of a JSON value (`undefined` is `None`).
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `a === b` for JSON values: objects and arrays are never equal (distinct references).
pub fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(x)), Some(Value::Bool(y))) => x == y,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        (Some(Value::String(x)), Some(Value::String(y))) => x == y,
        _ => false,
    }
}

/// JavaScript's number-to-string for the common cases.
pub fn number_text(n: &serde_json::Number) -> String {
    if let Some(i) = n.as_i64() {
        return i.to_string();
    }
    if let Some(u) = n.as_u64() {
        return u.to_string();
    }
    let f = n.as_f64().unwrap_or(0.0);
    if f.fract() == 0.0 && f.abs() < 1e21 {
        format!("{f:.0}")
    } else {
        f.to_string()
    }
}

/// `String(value)`; `None` (undefined) is "undefined".
pub fn js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => number_text(n),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_string(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// `String(value ?? "")`.
pub fn js_string_or_empty(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        other => js_string(other),
    }
}

/// The string at `key` when it is a non-empty string (`typeof x === "string" && x`).
pub fn nonempty_str<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// Node's posix `path.basename`.
pub fn basename(file: &str) -> String {
    let trimmed = file.trim_end_matches('/');
    if trimmed.is_empty() {
        return String::new();
    }
    trimmed.rsplit('/').next().unwrap_or(trimmed).to_string()
}

/// `JSON.stringify(value, null, 2)`, optionally replacing values whose key matches `redact`.
pub fn stringify_pretty(value: &Value, redact: Option<&dyn Fn(&str) -> bool>) -> String {
    let mut out = String::new();
    write_value(&mut out, value, 0, redact);
    out
}

fn write_value(out: &mut String, value: &Value, depth: usize, redact: Option<&dyn Fn(&str) -> bool>) {
    match value {
        Value::Array(items) if !items.is_empty() => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                newline(out, depth + 1);
                // The replacer sees array indices as keys too.
                let replaced = redact.is_some_and(|r| r(&index.to_string()));
                if replaced {
                    out.push_str("\"[redacted]\"");
                } else {
                    write_value(out, item, depth + 1, redact);
                }
            }
            newline(out, depth);
            out.push(']');
        }
        Value::Object(map) if !map.is_empty() => {
            out.push('{');
            for (index, (key, item)) in map.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                newline(out, depth + 1);
                out.push_str(&serde_json::to_string(key).unwrap_or_default());
                out.push_str(": ");
                if redact.is_some_and(|r| r(key)) {
                    out.push_str("\"[redacted]\"");
                } else {
                    write_value(out, item, depth + 1, redact);
                }
            }
            newline(out, depth);
            out.push('}');
        }
        Value::Number(n) => out.push_str(&number_text(n)),
        other => out.push_str(&serde_json::to_string(other).unwrap_or_default()),
    }
}

fn newline(out: &mut String, depth: usize) {
    out.push('\n');
    for _ in 0..depth {
        out.push_str("  ");
    }
}

/// `new Date(ms).toISOString()`.
pub fn iso_from_millis(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (h, m, s, milli) = (rem / 3_600_000, rem / 60_000 % 60, rem / 1000 % 60, rem % 1000);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };
    format!("{year:04}-{month:02}-{d:02}T{h:02}:{m:02}:{s:02}.{milli:03}Z")
}

/// Builds a JSON object from `(key, value)` pairs, dropping `None` (JavaScript's `compact`).
pub fn compact<const N: usize>(pairs: [(&str, Option<Value>); N]) -> Value {
    let mut map = Map::new();
    for (key, value) in pairs {
        if let Some(value) = value {
            map.insert(key.to_string(), value);
        }
    }
    Value::Object(map)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn utf16_slices() {
        assert_eq!(slice_utf16_start("a😀b", 2), "a");
        assert_eq!(slice_utf16_start("a😀b", 3), "a😀");
        assert_eq!(slice_utf16_end("a😀b", 2), "b");
        assert_eq!(slice_utf16_end("a😀b", 3), "😀b");
    }

    #[test]
    fn stringify_matches_json_stringify() {
        let value = json!({ "a": [1, { "b": null }], "c": {}, "d": [], "token": "x", "n": 1.5 });
        let redact = |k: &str| k == "token";
        assert_eq!(
            stringify_pretty(&value, Some(&redact)),
            "{\n  \"a\": [\n    1,\n    {\n      \"b\": null\n    }\n  ],\n  \"c\": {},\n  \"d\": [],\n  \"token\": \"[redacted]\",\n  \"n\": 1.5\n}"
        );
    }

    #[test]
    fn iso_dates() {
        assert_eq!(iso_from_millis(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_from_millis(1_767_225_600_000), "2026-01-01T00:00:00.000Z");
        assert_eq!(iso_from_millis(1_709_164_800_123), "2024-02-29T00:00:00.123Z");
    }

    #[test]
    fn basenames() {
        assert_eq!(basename("/repo/a.txt"), "a.txt");
        assert_eq!(basename("/repo/dir/"), "dir");
        assert_eq!(basename("/"), "");
        assert_eq!(basename("a"), "a");
    }
}

//! JavaScript string semantics the Node code relies on: lengths and slices count UTF-16 code units,
//! `trim` strips whitespace, `String(value)` stringifies, `JSON.stringify(value, replacer, 2)` pretty-prints.

use serde_json::{Map, Value};

pub const MAX_TEXT: usize = 20_000;
pub const MAX_OUTPUT: usize = 20_000;

pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text.slice(start, end)` in UTF-16 units (a split surrogate becomes U+FFFD).
pub fn utf16_slice(text: &str, start: usize, end: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    let end = end.min(units.len());
    let start = start.min(end);
    String::from_utf16_lossy(&units[start..end])
}

/// `capText` (permissions.cjs): keep the start.
pub fn cap_text(text: &str) -> String {
    if utf16_len(text) > MAX_TEXT {
        format!("{}\n… truncated", utf16_slice(text, 0, MAX_TEXT))
    } else {
        text.to_owned()
    }
}

/// `capOutput` (agent-runs.mjs): command output keeps its end.
pub fn cap_output(text: &str) -> String {
    let length = utf16_len(text);
    if length > MAX_OUTPUT {
        format!("… truncated\n{}", utf16_slice(text, length - MAX_OUTPUT, length))
    } else {
        text.to_owned()
    }
}

/// JS `String(value)`; `undefined` and `null` handled by the caller where `??` applies.
pub fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::String(text) => text.clone(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => js_number(number),
        Value::Array(items) => {
            items.iter().map(|item| if item.is_null() { String::new() } else { js_string(item) }).collect::<Vec<_>>().join(",")
        }
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `String(value ?? "")`.
pub fn js_string_or_empty(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => js_string(value),
    }
}

fn js_number(number: &serde_json::Number) -> String {
    if let Some(float) = number.as_f64().filter(|_| number.is_f64()) {
        if float.fract() == 0.0 && float.abs() < 1e21 {
            return format!("{}", float as i64);
        }
    }
    number.to_string()
}

/// JS `trim()` for the whitespace the inputs carry (also strips U+FEFF, as JS does).
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// Node `path.basename` (POSIX).
pub fn basename(file: &str) -> &str {
    file.trim_end_matches('/').rsplit('/').next().unwrap_or("")
}

/// Text shown as code in a title (steps.cjs `code`): one line of at most `max` characters, no backticks.
pub fn code(value: Option<&Value>, max: usize) -> String {
    let raw = js_string_or_empty(value);
    let replaced = js_trim(&raw).replace('`', "'");
    let flat = replaced.split(char::is_whitespace).filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ");
    // JS `\s+` -> " " keeps nothing at the ends because the text was trimmed first.
    let shown = if utf16_len(&flat) > max { format!("{}…", utf16_slice(&flat, 0, max - 1)) } else { flat };
    format!("`{shown}`")
}

/// `JSON.stringify(value, null, 2)` (numbers as JS prints them).
pub fn pretty(value: &Value) -> String {
    let mut out = String::new();
    write_pretty(value, 0, &mut out);
    out
}

fn write_pretty(value: &Value, depth: usize, out: &mut String) {
    let pad = |depth: usize| "  ".repeat(depth);
    match value {
        Value::Array(items) if items.is_empty() => out.push_str("[]"),
        Value::Object(map) if map.is_empty() => out.push_str("{}"),
        Value::Array(items) => {
            out.push_str("[\n");
            for (index, item) in items.iter().enumerate() {
                out.push_str(&pad(depth + 1));
                write_pretty(item, depth + 1, out);
                if index + 1 < items.len() {
                    out.push(',');
                }
                out.push('\n');
            }
            out.push_str(&pad(depth));
            out.push(']');
        }
        Value::Object(map) => {
            out.push_str("{\n");
            for (index, (key, item)) in map.iter().enumerate() {
                out.push_str(&pad(depth + 1));
                out.push_str(&serde_json::to_string(key).unwrap());
                out.push_str(": ");
                write_pretty(item, depth + 1, out);
                if index + 1 < map.len() {
                    out.push(',');
                }
                out.push('\n');
            }
            out.push_str(&pad(depth));
            out.push('}');
        }
        Value::Number(number) => out.push_str(&js_number(number)),
        other => out.push_str(&serde_json::to_string(other).unwrap()),
    }
}

/// A copy with the values of keys matching `redact` replaced by `"[redacted]"`, at any depth.
pub fn redacted(value: &Value, redact: &dyn Fn(&str) -> bool) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, item)| (key.clone(), if redact(key) { Value::String("[redacted]".into()) } else { redacted(item, redact) }))
                .collect::<Map<String, Value>>(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(|item| redacted(item, redact)).collect()),
        other => other.clone(),
    }
}

/// Builds a JSON object, leaving out `None` fields (`compact` in the Node code).
#[derive(Default)]
pub struct Obj(pub Map<String, Value>);

impl Obj {
    pub fn new() -> Self {
        Self(Map::new())
    }
    pub fn set(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.0.insert(key.into(), value.into());
        self
    }
    pub fn opt(mut self, key: &str, value: Option<impl Into<Value>>) -> Self {
        if let Some(value) = value {
            self.0.insert(key.into(), value.into());
        }
        self
    }
    pub fn merge(mut self, other: Map<String, Value>) -> Self {
        for (key, value) in other {
            self.0.insert(key, value);
        }
        self
    }
    pub fn build(self) -> Value {
        Value::Object(self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn js_like() {
        assert_eq!(code(Some(&json!("  npm   test `x` ")), 80), "`npm test 'x'`");
        assert_eq!(code(Some(&json!("a".repeat(100))), 80), format!("`{}…`", "a".repeat(79)));
        assert_eq!(code(None, 80), "``");
        assert_eq!(code(Some(&json!(5)), 80), "`5`");
        assert_eq!(pretty(&json!({"a":[1,2.5,{}],"b":{}})), "{\n  \"a\": [\n    1,\n    2.5,\n    {}\n  ],\n  \"b\": {}\n}");
        assert_eq!(basename("/a/b.txt"), "b.txt");
        assert_eq!(basename("/a/dir/"), "dir");
        assert_eq!(cap_output(&"x".repeat(20_001)).len(), "… truncated\n".len() + 20_000);
    }
}

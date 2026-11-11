//! JSON text exactly as Node's `JSON.stringify` writes it for a value `JSON.parse` read.
//!
//! The daemon answers commands with `JSON.stringify` of JavaScript objects, so a Rust owner that keeps the result
//! contracts byte-compatible has to follow JavaScript's rules, which differ from serde_json's in three places:
//!
//! - **Key order.** JavaScript objects list integer-like keys ("0".."4294967294", canonical) first, ascending, then the
//!   other keys in insertion order. `{"10":…,"9":…,"a":…}` parsed and written again comes out `{"9":…,"10":…,"a":…}`.
//!   Sessions and worktrees are keyed by number, so this shows in every state.
//! - **Numbers.** Every number is an IEEE double printed with ECMAScript `Number::toString` (`1e+21`, `1e-7`,
//!   `0.000001`, `-0` as `0`), and integers beyond 2^53 lose precision as JavaScript's do.
//! - **Strings.** Escapes are `\" \\ \b \f \n \r \t` and `\u00xx` (lower-case) for other control characters, nothing
//!   else. Lone UTF-16 surrogates, which JavaScript strings can hold, cannot exist in a Rust `String` (see README).

use serde_json::{Map, Number, Value};

/// `JSON.stringify(value)` for a value made of what `JSON.parse` returns.
pub fn to_string(value: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, value);
    out
}

fn write_value(out: &mut String, value: &Value) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => out.push_str(&number_to_js(number)),
        Value::String(text) => write_string(out, text),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_value(out, item);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            for (index, (key, item)) in js_entries(map).into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_string(out, key);
                out.push(':');
                write_value(out, item);
            }
            out.push('}');
        }
    }
}

/// An object's entries in JavaScript's own-property order.
pub fn js_entries(map: &Map<String, Value>) -> Vec<(&String, &Value)> {
    let mut indexed: Vec<(u32, &String, &Value)> = Vec::new();
    let mut named: Vec<(&String, &Value)> = Vec::new();
    for (key, value) in map {
        match array_index(key) {
            Some(index) => indexed.push((index, key, value)),
            None => named.push((key, value)),
        }
    }
    indexed.sort_by_key(|(index, _, _)| *index);
    indexed
        .into_iter()
        .map(|(_, key, value)| (key, value))
        .chain(named)
        .collect()
}

/// The array index a property key names (ECMAScript CanonicalNumericIndexString for 0..2^32-2), if it is one.
pub fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || key.len() > 10 || !key.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    if key.len() > 1 && key.starts_with('0') {
        return None;
    }
    let value: u64 = key.parse().ok()?;
    (value < u32::MAX as u64).then_some(value as u32)
}

fn write_string(out: &mut String, text: &str) {
    out.push('"');
    for character in text.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            control if (control as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", control as u32))
            }
            other => out.push(other),
        }
    }
    out.push('"');
}

/// The double JavaScript holds for a JSON number.
pub fn as_f64(number: &Number) -> f64 {
    if let Some(value) = number.as_i64() {
        value as f64
    } else if let Some(value) = number.as_u64() {
        value as f64
    } else {
        number.as_f64().unwrap_or(f64::NAN)
    }
}

fn number_to_js(number: &Number) -> String {
    const SAFE: i64 = 1 << 53;
    if let Some(value) = number.as_i64() {
        if (-SAFE..=SAFE).contains(&value) {
            return value.to_string();
        }
    }
    if let Some(value) = number.as_u64() {
        if value <= SAFE as u64 {
            return value.to_string();
        }
    }
    f64_to_js(as_f64(number))
}

/// ECMAScript `Number::toString(x)` (radix 10). JSON writes NaN and infinities as `null`.
pub fn f64_to_js(value: f64) -> String {
    if !value.is_finite() {
        return "null".into();
    }
    if value == 0.0 {
        return "0".into();
    }
    if value < 0.0 {
        return format!("-{}", f64_to_js(-value));
    }
    // Rust's `{:e}` prints the shortest digits that round-trip, as ECMAScript requires: "d.ddde±x".
    let formatted = format!("{value:e}");
    let (mantissa, exponent) = formatted.split_once('e').expect("exponent format");
    let digits: String = mantissa
        .chars()
        .filter(|character| *character != '.')
        .collect();
    let k = digits.len() as i32;
    let n = exponent.parse::<i32>().expect("exponent") + 1;
    if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let sign = if e < 0 { '-' } else { '+' };
        if k == 1 {
            format!("{digits}e{sign}{}", e.abs())
        } else {
            format!("{}.{}e{sign}{}", &digits[..1], &digits[1..], e.abs())
        }
    }
}

/// JavaScript `a === b` for values `JSON.parse` returns: objects and arrays are never equal (distinct references).
pub fn strict_equals(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Null, Value::Null) => true,
        (Value::Bool(x), Value::Bool(y)) => x == y,
        (Value::Number(x), Value::Number(y)) => as_f64(x) == as_f64(y),
        (Value::String(x), Value::String(y)) => x == y,
        _ => false,
    }
}

/// JavaScript truthiness of a parsed value; `None` stands for `undefined`.
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => {
            let value = as_f64(number);
            value != 0.0 && !value.is_nan()
        }
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

/// `String(value)` as a property key, for lookups like `details[step.id]`; `None` is `undefined`.
pub fn property_key(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(number)) => {
            let text = number_to_js(number);
            if text == "null" {
                "NaN".into()
            } else {
                text
            }
        }
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => property_key(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// A JSON number from a double, as JavaScript would hold it (integers stay integers when exact).
pub fn number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() <= (1u64 << 53) as f64 {
        Value::from(value as i64)
    } else {
        Number::from_f64(value)
            .map(Value::Number)
            .unwrap_or(Value::Null)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numbers_follow_ecmascript() {
        for (value, expected) in [
            (0.1, "0.1"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (1e-7, "1e-7"),
            (0.000001, "0.000001"),
            (-2.5, "-2.5"),
            (123456789.125, "123456789.125"),
            (1.5e-10, "1.5e-10"),
            (2.0, "2"),
            (-0.0, "0"),
            (1794312000000.0, "1794312000000"),
        ] {
            assert_eq!(f64_to_js(value), expected, "{value}");
        }
        assert_eq!(to_string(&json!(9007199254740993u64)), "9007199254740992");
    }

    #[test]
    fn integer_keys_come_first() {
        let value: Value = serde_json::from_str(
            r#"{"b":1,"10":2,"9":3,"01":4,"a":5,"4294967295":6,"4294967294":7}"#,
        )
        .unwrap();
        assert_eq!(
            to_string(&value),
            r#"{"9":3,"10":2,"4294967294":7,"b":1,"01":4,"a":5,"4294967295":6}"#
        );
    }

    #[test]
    fn strings_escape_like_json_stringify() {
        assert_eq!(
            to_string(&json!("a\"b\\c\u{1}\u{1f}\n\t\u{7f}é\u{1F600}/")),
            "\"a\\\"b\\\\c\\u0001\\u001f\\n\\t\u{7f}é\u{1F600}/\""
        );
    }
}

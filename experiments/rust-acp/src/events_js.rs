//! JavaScript presentation semantics for the ACP mapper, separate from lossless transport IDs.
use serde_json::{Map, Value};
pub fn text(v: Option<&Value>) -> &str {
    v.and_then(Value::as_str).unwrap_or("")
}
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(v)) => *v,
        Some(Value::String(v)) => !v.is_empty(),
        Some(Value::Number(v)) => v.as_f64().is_some_and(|v| v != 0.0 && !v.is_nan()),
        _ => true,
    }
}
pub fn whitespace(c: char) -> bool {
    matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
pub fn trim(s: &str) -> &str {
    s.trim_matches(whitespace)
}
pub fn units(s: &str) -> usize {
    s.encode_utf16().count()
}
// Rust strings cannot contain lone surrogates. Boundary fragments are omitted, explicitly
// documented/tested separately from the exact Node-parity corpus.
pub fn head(s: &str, n: usize) -> &str {
    let mut count = 0;
    for (i, c) in s.char_indices() {
        if count + c.len_utf16() > n {
            return &s[..i];
        }
        count += c.len_utf16();
    }
    s
}
pub fn tail(s: &str, n: usize) -> &str {
    let mut count = 0;
    for (i, c) in s.char_indices().rev() {
        if count + c.len_utf16() > n {
            return &s[i + c.len_utf8()..];
        }
        count += c.len_utf16();
    }
    s
}
pub fn cap_text(s: &str) -> String {
    if units(s) > 20_000 {
        format!("{}\n… truncated", head(s, 20_000))
    } else {
        s.into()
    }
}
pub fn cap_output(s: &str) -> String {
    if units(s) > 20_000 {
        format!("… truncated\n{}", tail(s, 20_000))
    } else {
        s.into()
    }
}
pub fn code(s: &str) -> String {
    let flat = trim(s).replace('`', "'").split(whitespace).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ");
    format!("`{}`", if units(&flat) > 80 { format!("{}…", head(&flat, 79)) } else { flat })
}
pub fn basename(s: &str) -> &str {
    s.trim_end_matches('/').rsplit('/').next().unwrap_or("")
}
pub fn number(v: f64) -> String {
    if v.is_nan() {
        return "NaN".into();
    }
    if v.is_infinite() {
        return if v.is_sign_negative() { "-Infinity" } else { "Infinity" }.into();
    }
    if v == 0.0 {
        return "0".into();
    }
    let negative = v < 0.0;
    let raw = v.abs().to_string();
    let (coeff, exponent) = raw.split_once('e').map(|(a, b)| (a, b.parse::<i32>().unwrap())).unwrap_or((&raw, 0));
    let decimal = coeff.find('.').unwrap_or(coeff.len()) as i32;
    let all = coeff.replace('.', "");
    let leading = all.len() - all.trim_start_matches('0').len();
    let digits = all.trim_start_matches('0').trim_end_matches('0');
    let position = decimal + exponent - leading as i32;
    let out = if position > 0 && position <= 21 {
        let p = position as usize;
        if p >= digits.len() {
            format!("{digits}{}", "0".repeat(p - digits.len()))
        } else {
            format!("{}.{}", &digits[..p], &digits[p..])
        }
    } else if position <= 0 && position > -6 {
        format!("0.{}{digits}", "0".repeat((-position) as usize))
    } else {
        let exp = position - 1;
        format!(
            "{}{}e{}{exp}",
            &digits[..1],
            if digits.len() > 1 { format!(".{}", &digits[1..]) } else { String::new() },
            if exp >= 0 { "+" } else { "" }
        )
    };
    if negative {
        format!("-{out}")
    } else {
        out
    }
}
pub fn string(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => number(n.as_f64().unwrap_or(f64::INFINITY)),
        Some(Value::Array(a)) => a.iter().map(|v| if v.is_null() { String::new() } else { string(Some(v)) }).collect::<Vec<_>>().join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}
pub fn numeric(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::INFINITY),
        Some(v) => {
            let s = string(Some(v));
            let s = trim(&s);
            if s.is_empty() {
                0.0
            } else if s == "Infinity" || s == "+Infinity" {
                f64::INFINITY
            } else if s == "-Infinity" {
                f64::NEG_INFINITY
            } else if s.starts_with("0x")
                || s.starts_with("0X")
                || s.starts_with("0b")
                || s.starts_with("0B")
                || s.starts_with("0o")
                || s.starts_with("0O")
            {
                let radix = match s.as_bytes()[1] {
                    b'x' | b'X' => 16,
                    b'b' | b'B' => 2,
                    _ => 8,
                };
                if s.len() == 2 {
                    return f64::NAN;
                }
                s[2..].chars().try_fold(0.0, |sum, c| c.to_digit(radix).map(|digit| sum * radix as f64 + digit as f64)).unwrap_or(f64::NAN)
            } else if s.chars().all(|c| c.is_ascii_digit() || matches!(c, '+' | '-' | '.' | 'e' | 'E')) {
                s.parse().unwrap_or(f64::NAN)
            } else {
                f64::NAN
            }
        }
    }
}
pub fn json_number(n: f64) -> Value {
    if !n.is_finite() {
        Value::Null
    } else {
        serde_json::from_str(&number(n)).unwrap()
    }
}
pub fn entries(v: &Value) -> Map<String, Value> {
    match v {
        Value::Object(m) => m.clone(),
        Value::Array(a) => a.iter().enumerate().map(|(i, v)| (i.to_string(), v.clone())).collect(),
        Value::String(s) => s.chars().enumerate().map(|(i, c)| (i.to_string(), Value::String(c.to_string()))).collect(),
        _ => Map::new(),
    }
}
fn secret(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    ["password", "secret", "token", "authorization", "credential", "apikey", "api_key", "api-key"].iter().any(|p| k.contains(p))
}
pub fn pretty(v: &Value, redact: bool) -> String {
    fn write(v: &Value, out: &mut String, depth: usize, redact: bool) {
        let indent = |out: &mut String, d: usize| {
            out.push('\n');
            out.push_str(&"  ".repeat(d));
        };
        match v {
            Value::Object(m) if !m.is_empty() => {
                out.push('{');
                let mut fields: Vec<_> = m.iter().collect();
                fields.sort_by_key(|(key, _)| {
                    key.parse::<u32>().ok().filter(|n| *n < u32::MAX && n.to_string() == **key).map(|n| (0, n)).unwrap_or((1, 0))
                });
                for (i, (key, value)) in fields.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    indent(out, depth + 1);
                    out.push_str(&serde_json::to_string(key).unwrap());
                    out.push_str(": ");
                    if redact && secret(key) {
                        out.push_str("\"[redacted]\"");
                    } else {
                        write(value, out, depth + 1, redact);
                    }
                }
                indent(out, depth);
                out.push('}');
            }
            Value::Array(a) if !a.is_empty() => {
                out.push('[');
                for (i, v) in a.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    indent(out, depth + 1);
                    write(v, out, depth + 1, redact);
                }
                indent(out, depth);
                out.push(']');
            }
            Value::Number(n) => {
                let n = n.as_f64().unwrap_or(f64::INFINITY);
                out.push_str(&if n.is_finite() { number(n) } else { "null".into() });
            }
            _ => out.push_str(&serde_json::to_string(v).unwrap()),
        }
    }
    let mut out = String::new();
    write(v, &mut out, 0, redact);
    out
}
pub fn metadata(server: &Value, name: &Value, input: Option<&Value>) -> Map<String, Value> {
    let mut source = serde_json::json!({"name":head(&string(Some(name)),160)});
    if truthy(Some(server)) {
        source["server"] = head(&string(Some(server)), 160).into();
    }
    let mut result = Map::new();
    result.insert("source".into(), source);
    let skip = name.as_str().is_some_and(|n| ["design_show", "design_apply", "artifact_show", "html_render", "html_preview"].contains(&n));
    if let Some(input) = input.filter(|v| !v.is_null() && !skip) {
        let mut args = pretty(input, true);
        if units(&args) > 4000 {
            args = format!("{}\n… input truncated", head(&args, 4000));
        }
        if args != "{}" && !args.is_empty() {
            result.insert("input".into(), args.into());
        }
    }
    result
}

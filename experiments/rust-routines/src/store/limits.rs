use super::{jsjson, refuse, Result};
use serde_json::Value;

pub const BYTES: usize = 4 * 1024 * 1024;
pub const NODES: usize = 131072;
pub const DEPTH: usize = 32;
pub const STRING: usize = 16 * 1024;
pub const ROUTINES: usize = 64;
pub const RUNS: usize = 4096;
pub const TOMBSTONES: usize = 4096;

/// Lexical resource preflight, not a second JSON parser. Keys do not count as
/// values. Malformed syntax is subsequently refused by the pinned parser.
fn preflight(text: &str) -> Result<()> {
    if text.len() > BYTES {
        return refuse("serialized input exceeds 4 MiB");
    }
    let b = text.as_bytes();
    let mut at = 0;
    let mut nodes = 0;
    // Some(true): object awaiting a key; Some(false): object value; None: array.
    let mut stack: Vec<Option<bool>> = Vec::new();
    while at < b.len() {
        match b[at] {
            b' ' | b'\r' | b'\n' | b'\t' => at += 1,
            b'{' | b'[' => {
                nodes += 1;
                stack.push(if b[at] == b'{' { Some(true) } else { None });
                if stack.len() > DEPTH {
                    return refuse("JSON depth exceeds 32");
                }
                at += 1;
            }
            b'}' | b']' => {
                stack.pop();
                at += 1;
            }
            b':' => {
                if let Some(Some(key)) = stack.last_mut() {
                    *key = false;
                }
                at += 1;
            }
            b',' => {
                if let Some(Some(key)) = stack.last_mut() {
                    *key = true;
                }
                at += 1;
            }
            b'"' => {
                if stack.last() != Some(&Some(true)) {
                    nodes += 1;
                }
                at += 1;
                while at < b.len() {
                    if b[at] == b'"' {
                        at += 1;
                        break;
                    }
                    if b[at] == b'\\' {
                        at += 1;
                    }
                    at += 1;
                }
            }
            _ => {
                nodes += 1;
                let start = at;
                while at < b.len()
                    && !matches!(
                        b[at],
                        b' ' | b'\r' | b'\n' | b'\t' | b',' | b']' | b'}' | b':' | b'[' | b'{'
                    )
                {
                    at += 1;
                }
                if start == at {
                    at += 1;
                }
                if matches!(b[start], b'-' | b'0'..=b'9') {
                    if let Ok(number) = text[start..at].parse::<f64>() {
                        if !number.is_finite() {
                            return refuse("non-finite JSON number");
                        }
                    }
                }
            }
        }
        if nodes > NODES {
            return refuse("JSON value nodes exceed 131072");
        }
    }
    Ok(())
}

pub fn decode(text: &str) -> Result<Value> {
    preflight(text)?;
    jsjson::parse(text).map_err(|_| super::Error::Refused("invalid JSON".into()))
}
pub fn parse(text: &str) -> Result<Value> {
    let value = decode(text)?;
    values(&[&value])?;
    Ok(value)
}

/// A heap bound is not claimed. The lexical check bounds parser depth/node work;
/// these checks bound retained trees before cloning and aggregate publication.
pub fn values(values: &[&Value]) -> Result<()> {
    fn visit(v: &Value, depth: usize, nodes: &mut usize) -> Result<()> {
        *nodes += 1;
        if *nodes > NODES {
            return refuse("JSON value nodes exceed 131072");
        }
        if matches!(v, Value::Object(_) | Value::Array(_)) && depth >= DEPTH {
            return refuse("JSON depth exceeds 32");
        }
        match v {
            Value::String(s) if s.len() > STRING => {
                return refuse("metadata string exceeds 16 KiB")
            }
            Value::Array(a) => {
                for v in a {
                    visit(v, depth + 1, nodes)?;
                }
            }
            Value::Object(o) => {
                for (k, v) in o {
                    if k.len() > STRING {
                        return refuse("metadata key exceeds 16 KiB");
                    }
                    visit(v, depth + 1, nodes)?;
                }
            }
            _ => (),
        }
        Ok(())
    }
    let mut nodes = 0;
    for value in values {
        visit(value, 0, &mut nodes)?;
    }
    Ok(())
}

pub fn image(value: &Value) -> Result<String> {
    values(&[value])?;
    let bytes = jsjson::to_string(value);
    if bytes.len() > BYTES {
        return refuse("serialized state exceeds 4 MiB");
    }
    Ok(bytes)
}

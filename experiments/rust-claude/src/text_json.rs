//! Compatibility fallback for valid JSON containing lone UTF-16 surrogates in display text.
//! Opaque identifiers, object keys, tool arguments and unknown fields are never normalized.
use serde_json::{value::RawValue, Map, Value};
enum At {
    Key(String),
    Index,
}
fn display_text(path: &[At]) -> bool {
    const PATHS: &[&[&str]] = &[
        &["event", "delta", "text"],
        &["event", "delta", "thinking"],
        &["event", "content_block", "text"],
        &["event", "content_block", "thinking"],
        &["message", "content"],
        &["message", "content", "*", "text"],
        &["message", "content", "*", "thinking"],
        &["message", "content", "*", "content"],
        &["message", "content", "*", "content", "*", "text"],
        &["result"],
        &["errors", "*"],
        &["tool_use_result", "stdout"],
        &["tool_use_result", "stderr"],
        &["tool_use_result", "output"],
        &["tool_use_result", "content"],
        &["tool_use_result", "file", "content"],
    ];
    PATHS.iter().any(|expected| {
        path.len() == expected.len()
            && path.iter().zip(*expected).all(|(actual, want)| match actual {
                At::Key(key) => *want != "*" && key == want,
                At::Index => *want == "*",
            })
    })
}
/// Preserve escape spelling and valid pairs. A literal escaped backslash never starts a Unicode escape.
fn repair_string(raw: &str) -> String {
    let mut bytes = raw.as_bytes().to_vec();
    let mut at = 1;
    fn unit(bytes: &[u8], at: usize) -> Option<u16> {
        if bytes.get(at..at + 2)? != b"\\u" {
            return None;
        }
        u16::from_str_radix(std::str::from_utf8(bytes.get(at + 2..at + 6)?).ok()?, 16).ok()
    }
    while at + 1 < bytes.len() {
        if bytes[at] != b'\\' {
            at += 1;
            continue;
        }
        let Some(value) = unit(&bytes, at) else {
            at += 2;
            continue;
        };
        if (0xd800..=0xdbff).contains(&value) && unit(&bytes, at + 6).is_some_and(|low| (0xdc00..=0xdfff).contains(&low)) {
            at += 12;
            continue;
        }
        if (0xd800..=0xdfff).contains(&value) {
            bytes[at..at + 6].copy_from_slice(b"\\ufffd");
        }
        at += 6;
    }
    // Input was validated UTF-8 JSON; only equal-length ASCII escape sequences were changed.
    String::from_utf8(bytes).expect("validated JSON string")
}
pub(crate) fn parse(text: &str) -> Result<(Value, usize), String> {
    // RawValue validates the whole syntax/depth, allowing JSON's lone surrogate escape syntax.
    let raw: &RawValue = serde_json::from_str(text).map_err(|_| "invalid JSON syntax".to_owned())?;
    let mut replacements = 0;
    let value = normalize(raw, &mut vec![], &mut replacements, 0)?;
    Ok((value, replacements))
}
fn normalize(raw: &RawValue, path: &mut Vec<At>, replacements: &mut usize, depth: usize) -> Result<Value, String> {
    if depth >= 128 {
        return Err("JSON nesting limit".into());
    }
    if raw.get().starts_with('"') {
        return match serde_json::from_str::<String>(raw.get()) {
            Ok(text) => Ok(text.into()),
            Err(_) if display_text(path) => {
                let text = serde_json::from_str::<String>(&repair_string(raw.get())).map_err(|_| "invalid display text".to_owned())?;
                *replacements += 1;
                Ok(text.into())
            }
            Err(_) => Err("invalid UTF-16 in opaque or unsupported field".into()),
        };
    }
    struct Container<'a> {
        path: &'a mut Vec<At>,
        replacements: &'a mut usize,
        depth: usize,
    }
    impl<'de> serde::de::Visitor<'de> for Container<'_> {
        type Value = Value;
        fn expecting(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            out.write_str("valid JSON container")
        }
        fn visit_map<M: serde::de::MapAccess<'de>>(self, mut map: M) -> Result<Value, M::Error> {
            let mut result = Map::new();
            // String keys use serde's strict UTF-8 representation. Distinct invalid keys never alias.
            while let Some(key) = map.next_key::<String>()? {
                let raw = map.next_value::<&RawValue>()?;
                self.path.push(At::Key(key.clone()));
                let value = normalize(raw, self.path, self.replacements, self.depth + 1).map_err(serde::de::Error::custom)?;
                self.path.pop();
                result.insert(key, value);
            }
            Ok(Value::Object(result))
        }
        fn visit_seq<S: serde::de::SeqAccess<'de>>(self, mut seq: S) -> Result<Value, S::Error> {
            let mut result = Vec::new();
            while let Some(raw) = seq.next_element::<&RawValue>()? {
                self.path.push(At::Index);
                let value = normalize(raw, self.path, self.replacements, self.depth + 1).map_err(serde::de::Error::custom)?;
                self.path.pop();
                result.push(value);
            }
            Ok(Value::Array(result))
        }
    }
    let mut parser = serde_json::Deserializer::from_str(raw.get());
    let visitor = Container { path, replacements, depth };
    match raw.get().as_bytes().first() {
        Some(b'{') => serde::Deserializer::deserialize_map(&mut parser, visitor).map_err(|_| "invalid opaque key or field".into()),
        Some(b'[') => serde::Deserializer::deserialize_seq(&mut parser, visitor).map_err(|_| "invalid opaque field".into()),
        _ => serde_json::from_str(raw.get()).map_err(|_| "invalid JSON value".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repairs_only_allowlisted_text_without_aliasing_real_unicode() {
        let (value, count) =
            parse(r#"{"result":"\ud800\ud800\udfff\udfff \udbff\udffe \ue000 \uf8ff \\ud800","session_id":"valid"}"#).unwrap();
        assert_eq!(count, 1);
        assert_eq!(value["result"], "\u{fffd}\u{103ff}\u{fffd} \u{10fffe} \u{e000} \u{f8ff} \\ud800");
        for raw in [
            r#"{"result":"\ud800","request_id":"x\ud800"}"#,
            r#"{"result":"\ud800","request_id":"x\udfff"}"#,
            r#"{"result":"\ud800","unknown":"\udfff"}"#,
            r#"{"result":"\ud800","\ud800":0}"#,
            r#"{"result":"\ud800","input":{"text":"\udfff"}}"#,
        ] {
            assert!(parse(raw).is_err(), "{raw}");
        }
    }
    #[test]
    fn nesting_and_syntax_are_bounded() {
        let deep = format!(r#"{{"result":"\ud800","nested":{}{}}}"#, "[".repeat(129), "]".repeat(129));
        assert!(parse(&deep).is_err());
        for raw in [r#"{"result":"\ud800"} trailing"#, r#"{"result":"\ud800\x"}"#, r#"{"result":"\ud800",}"#] {
            assert!(parse(raw).is_err());
        }
        assert!(crate::frame::parse_line(b"{\"session_id\":\"\xff\"}").is_err());
    }
}

//! Compatibility fallback for valid JSON containing lone UTF-16 surrogates in display text.
//! Opaque identifiers, object keys, tool arguments and unknown fields are never normalized.
use serde_json::{value::RawValue, Map, Value};
enum At {
    Key(String),
    Index,
}
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
    &["tool_use_result", "content", "*", "text"],
    &["tool_use_result", "structuredPatch", "*", "lines", "*"],
    &["tool_use_result", "oldString"],
    &["tool_use_result", "newString"],
    &["tool_use_result", "tasks", "*", "subject"],
    &["event", "content_block", "content", "*", "text"],
    &["description"],
    &["summary"],
    &["suggestion"],
    &["error"],
    &["patch", "description"],
    &["tasks", "*", "description"],
];
fn display_text(path: &[At]) -> bool {
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
// Ordinary valid frames retain Limits.max_frame_bytes. Compatibility work is more constrained:
// borrowed RawValue rescans child slices, so bound both input and cumulative subtree lengths.
const MAX_FALLBACK_BYTES: usize = 1024 * 1024;
const MAX_SCAN_BYTES: usize = 8 * 1024 * 1024;
#[derive(Default)]
struct Work {
    scanned: usize,
    replacements: usize,
    failure: Option<String>,
}
impl Work {
    fn fail(&mut self, path: &[At], reason: &str) -> String {
        self.failure.get_or_insert_with(|| format!("{reason} at {}", diagnostic_path(path))).clone()
    }
    fn charge(&mut self, bytes: usize, path: &[At]) -> Result<(), String> {
        if bytes > MAX_SCAN_BYTES.saturating_sub(self.scanned) {
            return Err(self.fail(path, "display-text fallback scan budget exceeded"));
        }
        self.scanned += bytes;
        Ok(())
    }
}
fn diagnostic_path(path: &[At]) -> String {
    let mut out = String::new();
    for item in path {
        // Only fixed protocol labels may appear. User-controlled keys are never diagnostic content.
        let label = match item {
            At::Index => "*",
            At::Key(key)
                if PATHS.iter().flat_map(|path| path.iter()).any(|part| *part == key)
                    || ["request", "request_id", "session_id", "input", "tool_use_id", "id", "name", "type", "partial_json"]
                        .contains(&key.as_str()) =>
            {
                key
            }
            At::Key(_) => "<field>",
        };
        if out.len() + label.len() + 1 > 256 {
            out.push_str("/...");
            break;
        }
        out.push('/');
        out.push_str(label);
    }
    if out.is_empty() {
        out.push('/');
    }
    out
}
pub(crate) fn parse(text: &str) -> Result<(Value, usize), String> {
    if text.len() > MAX_FALLBACK_BYTES {
        return Err("display-text fallback input exceeds 1048576 bytes at /".into());
    }
    let raw: &RawValue = serde_json::from_str(text).map_err(|_| "invalid JSON syntax at /".to_owned())?;
    let mut work = Work::default();
    work.charge(text.len(), &[])?;
    let value = normalize(raw, &mut vec![], &mut work, 0)?;
    Ok((value, work.replacements))
}
fn normalize(raw: &RawValue, path: &mut Vec<At>, work: &mut Work, depth: usize) -> Result<Value, String> {
    if depth >= 128 {
        return Err(work.fail(path, "JSON nesting limit"));
    }
    work.charge(raw.get().len(), path)?;
    if raw.get().starts_with('"') {
        return match serde_json::from_str::<String>(raw.get()) {
            Ok(text) => Ok(text.into()),
            Err(_) if display_text(path) => {
                let text =
                    serde_json::from_str::<String>(&repair_string(raw.get())).map_err(|_| work.fail(path, "invalid display text"))?;
                work.replacements += 1;
                Ok(text.into())
            }
            Err(_) => Err(work.fail(path, "invalid UTF-16 in opaque or unsupported field")),
        };
    }
    struct Container<'a> {
        path: &'a mut Vec<At>,
        work: &'a mut Work,
        depth: usize,
    }
    impl<'de> serde::de::Visitor<'de> for Container<'_> {
        type Value = Value;
        fn expecting(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            out.write_str("valid JSON container")
        }
        fn visit_map<M: serde::de::MapAccess<'de>>(self, mut map: M) -> Result<Value, M::Error> {
            let mut result = Map::new();
            while let Some(key) =
                map.next_key::<String>().map_err(|_| serde::de::Error::custom(self.work.fail(self.path, "invalid object key")))?
            {
                let raw = map.next_value::<&RawValue>()?;
                self.path.push(At::Key(key.clone()));
                let value = normalize(raw, self.path, self.work, self.depth + 1).map_err(serde::de::Error::custom)?;
                self.path.pop();
                result.insert(key, value);
            }
            Ok(Value::Object(result))
        }
        fn visit_seq<S: serde::de::SeqAccess<'de>>(self, mut seq: S) -> Result<Value, S::Error> {
            let mut result = Vec::new();
            while let Some(raw) = seq.next_element::<&RawValue>()? {
                self.path.push(At::Index);
                let value = normalize(raw, self.path, self.work, self.depth + 1).map_err(serde::de::Error::custom)?;
                self.path.pop();
                result.push(value);
            }
            Ok(Value::Array(result))
        }
    }
    let mut parser = serde_json::Deserializer::from_str(raw.get());
    let visitor = Container { path, work, depth };
    let result = match raw.get().as_bytes().first() {
        Some(b'{') => serde::Deserializer::deserialize_map(&mut parser, visitor),
        Some(b'[') => serde::Deserializer::deserialize_seq(&mut parser, visitor),
        _ => serde_json::from_str(raw.get()),
    };
    result.map_err(|_| work.fail(path, "invalid JSON value"))
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
    #[test]
    fn every_display_path_repairs_and_recorded_fields_have_an_explicit_policy() {
        for path in PATHS {
            let make = |leaf: Value| {
                path.iter().rev().fold(leaf, |value, part| {
                    if *part == "*" {
                        Value::Array(vec![value])
                    } else {
                        let mut map = Map::new();
                        map.insert((*part).into(), value);
                        Value::Object(map)
                    }
                })
            };
            let input = serde_json::to_string(&make(Value::String("SURROGATE".into()))).unwrap().replace("SURROGATE", "\\ud800");
            let (actual, count) = parse(&input).unwrap();
            assert_eq!(count, 1, "{path:?}");
            assert_eq!(actual, make(Value::String("\u{fffd}".into())));
        }
        let table: Value = serde_json::from_str(include_str!("../tests/fixtures/conformance/inbound-string-fields.json")).unwrap();
        let fields = table["fields"].as_object().unwrap();
        fn walk(value: &Value, path: &mut Vec<At>, fields: &Map<String, Value>) {
            match value {
                Value::String(_) => {
                    let pointer = path
                        .iter()
                        .map(|p| match p {
                            At::Key(k) => format!("/{k}"),
                            At::Index => "/*".into(),
                        })
                        .collect::<String>();
                    let recorded = fields.get(&pointer).unwrap_or_else(|| panic!("unclassified Node fixture field {pointer}"));
                    assert_eq!(recorded.as_str().unwrap(), if display_text(path) { "display" } else { "strict" }, "{pointer}");
                }
                Value::Array(items) => {
                    for item in items {
                        path.push(At::Index);
                        walk(item, path, fields);
                        path.pop();
                    }
                }
                Value::Object(items) => {
                    for (key, item) in items {
                        path.push(At::Key(key.clone()));
                        walk(item, path, fields);
                        path.pop();
                    }
                }
                _ => {}
            }
        }
        let fixture: Value = serde_json::from_str(include_str!("../tests/fixtures/conformance/claude-events.json")).unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            for step in case["steps"].as_array().unwrap() {
                walk(&step["message"], &mut vec![], fields);
            }
        }
    }
    #[test]
    fn strict_failures_report_only_bounded_schema_paths() {
        let error = parse(
            r#"{"result":"\ud800","type":"control_request","request_id":"valid","request":{"input":{"secret-key":"private-value\udfff"}}}"#,
        )
        .unwrap_err();
        assert_eq!(error, "invalid UTF-16 in opaque or unsupported field at /request/input/<field>");
        assert!(!error.contains("secret-key") && !error.contains("private-value"));
        let key = parse(r#"{"result":"\ud800","message":{"private-key\ud800":0}}"#).unwrap_err();
        assert_eq!(key, "invalid object key at /message");
    }
    #[test]
    fn fallback_input_and_cumulative_scan_limits_are_deterministic() {
        let prefix = r#"{"result":"\ud800","nested":""#;
        let input = format!("{prefix}{}\"}}", "x".repeat(MAX_FALLBACK_BYTES - prefix.len() - 2));
        assert_eq!(input.len(), MAX_FALLBACK_BYTES);
        assert!(parse(&input).is_ok());
        assert!(parse(&(input + " ")).unwrap_err().contains("input exceeds"));
        let deep =
            format!(r#"{{"result":"\ud800","nested":{}"{}"{}}}"#, "[".repeat(40), "x".repeat(MAX_FALLBACK_BYTES - 128), "]".repeat(40));
        assert!(deep.len() <= MAX_FALLBACK_BYTES);
        assert!(parse(&deep).unwrap_err().contains("scan budget exceeded"));
        let mut work = Work::default();
        work.charge(MAX_SCAN_BYTES, &[]).unwrap();
        assert!(work.charge(1, &[]).is_err());
        assert_eq!(work.scanned, MAX_SCAN_BYTES);
    }
}

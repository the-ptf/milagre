//! Production text transforms. No paths are opened here.
use crate::{AccountError, Result};
use regex::Regex;
use serde_json::{json, Map, Value};
use std::{collections::BTreeSet, sync::LazyLock};
const BAD: &str = "Synthetic account configuration could not be parsed.";
const WS: &str = r"[\t\n\r\x0b\x0c \u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]";
pub(crate) fn claude_settings(text: &str) -> Result<String> {
    let mut value: Value = serde_json::from_str(text).map_err(|_| {
        AccountError(
            "Claude settings could not be read. Fix settings.json before adding an account.",
        )
    })?;
    if value.is_null() {
        return Err(AccountError(BAD));
    }
    if let Some(object) = value.as_object_mut() {
        object.shift_remove("apiKeyHelper");
    }
    stringify(&value, false)
}
pub(crate) fn codex_config(text: &str, source_dir: &str) -> Result<String> {
    static TABLE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(&format!(r"^{WS}*\[")).expect("constant regex"));
    static CREDENTIALS: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(&format!(
            r"^{WS}*cli_auth_credentials_store{WS}*=[^\r\n\u{{2028}}\u{{2029}}]*\n?"
        ))
        .expect("constant regex")
    });
    static SQLITE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(&format!(r"^{WS}*sqlite_home{WS}*=")).expect("constant regex"));
    let split = js_line_starts(text)
        .find(|at| TABLE.is_match(&text[*at..]))
        .unwrap_or(text.len());
    let prefix = &text[..split];
    let mut head = String::new();
    let mut end = 0;
    for at in js_line_starts(prefix) {
        if at < end {
            continue;
        }
        if let Some(found) = CREDENTIALS.find(&prefix[at..]) {
            head.push_str(&prefix[end..at]);
            end = at + found.end();
        }
    }
    head.push_str(&prefix[end..]);
    let sqlite = if js_line_starts(&head).any(|at| SQLITE.is_match(&head[at..])) {
        String::new()
    } else {
        format!(
            "sqlite_home = {}\n",
            serde_json::to_string(source_dir).map_err(|_| AccountError(BAD))?
        )
    };
    Ok(format!(
        "{sqlite}cli_auth_credentials_store = \"file\"\n{head}{}",
        &text[split..]
    ))
}
// JavaScript /m anchors include CR, U+2028 and U+2029 as well as LF. Rust regex /m uses LF.
fn js_line_starts(text: &str) -> impl Iterator<Item = usize> + '_ {
    std::iter::once(0).chain(text.char_indices().filter_map(|(i, c)| {
        matches!(c, '\r' | '\n' | '\u{2028}' | '\u{2029}').then_some(i + c.len_utf8())
    }))
}
#[derive(Clone, Default)]
pub(crate) struct McpOutput {
    pub target: Option<String>,
    pub record: Option<String>,
}
fn recorded(text: Option<&str>) -> Vec<Value> {
    text.and_then(|s| serde_json::from_str::<Value>(s).ok())
        .and_then(|v| v.get("names").and_then(Value::as_array).cloned())
        .unwrap_or_default()
}
// delete object[name] uses JS property-key conversion, even for malformed record entries.
fn property_key(value: &Value) -> Result<String> {
    match value {
        Value::String(s) => Ok(s.clone()),
        Value::Object(_) => Ok("[object Object]".into()),
        Value::Array(a) => a
            .iter()
            .map(|v| {
                if v.is_null() {
                    Ok(String::new())
                } else {
                    property_key(v)
                }
            })
            .collect::<Result<Vec<_>>>()
            .map(|a| a.join(",")),
        _ => stringify(value, false),
    }
}
fn record(names: impl IntoIterator<Item = String>) -> Result<String> {
    let mut names: Vec<_> = names.into_iter().collect();
    names.sort_by_cached_key(|s| s.encode_utf16().collect::<Vec<_>>());
    Ok(format!("{}\n", stringify(&json!({"names":names}), false)?))
}
pub(crate) fn inherit_claude(
    source: Option<&str>,
    target: Option<&str>,
    previous: Option<&str>,
) -> Result<McpOutput> {
    let (Some(source), Some(target)) = (source, target) else {
        return Ok(McpOutput::default());
    };
    let source: Value = serde_json::from_str(source).map_err(|_| AccountError(BAD))?;
    let mut value: Value = serde_json::from_str(target).map_err(|_| AccountError(BAD))?;
    if !source.is_object() || !value.is_object() {
        return Ok(McpOutput::default());
    }
    let before = stringify(&value, true)?;
    let empty = Map::new();
    let servers = source
        .get("mcpServers")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    if let Some(current) = value.get_mut("mcpServers").and_then(Value::as_object_mut) {
        for name in recorded(previous) {
            // Set membership is type-sensitive; deletion then coerces its key.
            if name.as_str().is_none_or(|name| !servers.contains_key(name)) {
                let name = property_key(&name)?;
                current.shift_remove(&name);
            }
        }
    }
    if !servers.is_empty() {
        if !value["mcpServers"].is_object() {
            value["mcpServers"] = json!({});
        }
        for (name, server) in servers {
            value["mcpServers"][name] = server.clone();
        }
    }
    if let Some(projects) = source.get("projects").and_then(Value::as_object) {
        for (project, settings) in projects {
            let Some(servers) = settings
                .get("mcpServers")
                .and_then(Value::as_object)
                .filter(|m| !m.is_empty())
            else {
                continue;
            };
            if !value["projects"].is_object() {
                value["projects"] = json!({});
            }
            // Node assignment to an absent __proto__ changes the object's prototype, which
            // JSON.stringify omits. Preserve those persisted bytes without creating prototypes.
            if project == "__proto__" && value["projects"].get(project).is_none() {
                continue;
            }
            if !value["projects"][project].is_object() {
                value["projects"][project] = json!({});
            }
            if !value["projects"][project]["mcpServers"].is_object() {
                value["projects"][project]["mcpServers"] = json!({});
            }
            for (name, server) in servers {
                value["projects"][project]["mcpServers"][name] = server.clone();
            }
        }
    }
    let next = stringify(&value, true)?;
    Ok(McpOutput {
        target: (next != before).then_some(next),
        record: Some(record(servers.keys().cloned())?),
    })
}
struct Section {
    server: Option<String>,
    lines: Vec<String>,
}
fn sections(text: &str) -> Vec<Section> {
    static HEADER: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(&format!(r"^{WS}*\[")).expect("constant regex"));
    static SERVER: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(&format!(r#"^{WS}*\[{WS}*mcp_servers{WS}*\.{WS}*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+){WS}*(?:\.[^\]]*)?\]{WS}*(?:#[^\r\n\u{{2028}}\u{{2029}}]*)?$"#)).expect("constant regex")
    });
    let mut result = Vec::new();
    let mut current = Section {
        server: None,
        lines: Vec::new(),
    };
    for line in text.split('\n') {
        if HEADER.is_match(line) {
            result.push(current);
            let checked = line.strip_suffix('\r').unwrap_or(line);
            let server = SERVER.captures(checked).and_then(|c| c.get(1)).map(|m| {
                let name = m.as_str();
                if name.starts_with(['\'', '"']) {
                    name[1..name.len() - 1].to_owned()
                } else {
                    name.to_owned()
                }
            });
            current = Section {
                server,
                lines: Vec::new(),
            };
        }
        current.lines.push(line.to_owned());
    }
    result.push(current);
    result
}
pub(crate) fn inherit_codex(
    source: Option<&str>,
    target: Option<&str>,
    previous: Option<&str>,
) -> Result<McpOutput> {
    let (Some(source), Some(target)) = (source, target) else {
        return Ok(McpOutput::default());
    };
    let inherited: Vec<_> = sections(source)
        .into_iter()
        .filter(|s| s.server.as_ref().is_some_and(|name| !name.is_empty()))
        .collect();
    let names: BTreeSet<_> = inherited.iter().filter_map(|s| s.server.clone()).collect();
    let recorded = recorded(previous);
    let remove_unowned = recorded.iter().any(Value::is_null);
    let has_removed = recorded
        .iter()
        .any(|v| v.as_str().is_none_or(|s| !names.contains(s)));
    let removed: BTreeSet<_> = recorded
        .iter()
        .filter_map(Value::as_str)
        .filter(|name| !names.contains(*name))
        .map(str::to_owned)
        .collect();
    if inherited.is_empty() && !has_removed {
        return Ok(McpOutput::default());
    }
    let kept: Vec<_> = sections(target)
        .into_iter()
        .filter(|s| {
            s.server.as_ref().map_or(!remove_unowned, |n| {
                !names.contains(n) && !removed.contains(n)
            })
        })
        .collect();
    let body = format!(
        "{}\n",
        kept.iter()
            .map(|s| s.lines.join("\n"))
            .collect::<Vec<_>>()
            .join("\n")
            .trim_end_matches('\n')
    );
    let added = inherited
        .iter()
        .map(|s| format!("{}\n", s.lines.join("\n").trim_end_matches('\n')))
        .collect::<Vec<_>>()
        .join("\n");
    let next = if inherited.is_empty() {
        body
    } else {
        format!("{body}\n{added}")
    };
    Ok(McpOutput {
        target: (next != target).then_some(next),
        record: Some(record(names)?),
    })
}
// JSON.stringify ordering/number formatting, including unknown fields in Claude files.
fn stringify(value: &Value, pretty: bool) -> Result<String> {
    fn write(value: &Value, pretty: bool, depth: usize, out: &mut String) -> Result<()> {
        if depth > 100 {
            return Err(AccountError(BAD));
        }
        match value {
            Value::Null => out.push_str("null"),
            Value::Bool(v) => out.push_str(if *v { "true" } else { "false" }),
            Value::Number(v) => {
                let n = v.as_f64().ok_or(AccountError(BAD))?;
                if !n.is_finite() {
                    return Err(AccountError(BAD));
                }
                out.push_str(ryu_js::Buffer::new().format_finite(n));
            }
            Value::String(v) => {
                out.push_str(&serde_json::to_string(v).map_err(|_| AccountError(BAD))?)
            }
            Value::Array(values) => {
                out.push('[');
                for (i, v) in values.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    if pretty {
                        out.push('\n');
                        out.push_str(&"  ".repeat(depth + 1));
                    }
                    write(v, pretty, depth + 1, out)?;
                }
                if pretty && !values.is_empty() {
                    out.push('\n');
                    out.push_str(&"  ".repeat(depth));
                }
                out.push(']');
            }
            Value::Object(values) => {
                let mut entries: Vec<_> = values.iter().enumerate().collect();
                entries.sort_by_key(|(i, (key, _))| {
                    let n = key
                        .parse::<u32>()
                        .ok()
                        .filter(|n| *n < u32::MAX && n.to_string() == **key);
                    (n.is_none(), n.unwrap_or_default(), *i)
                });
                out.push('{');
                for (i, (_, (key, v))) in entries.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    if pretty {
                        out.push('\n');
                        out.push_str(&"  ".repeat(depth + 1));
                    }
                    out.push_str(&serde_json::to_string(key).map_err(|_| AccountError(BAD))?);
                    out.push(':');
                    if pretty {
                        out.push(' ');
                    }
                    write(v, pretty, depth + 1, out)?;
                }
                if pretty && !entries.is_empty() {
                    out.push('\n');
                    out.push_str(&"  ".repeat(depth));
                }
                out.push('}');
            }
        }
        Ok(())
    }
    let mut out = String::new();
    write(value, pretty, 0, &mut out)?;
    Ok(out)
}

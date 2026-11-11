//! Codex items -> Milagre tool steps. Port of the Codex half of packages/core/src/agents/steps.cjs,
//! plus `toolMetadata` (packages/shared/src/tool-activity.mjs) and `capOutput` (agent-runs.mjs).
//!
//! A step starts as `{ id, kind, title, detail?, file?, source?, input? }` and ends as
//! `{ id, status, title?, detail?, file?, artifact?, routine?, note?, durationMs? }`.

use crate::codex::approvals::{cap_text, changes_diff, unwrap_shell};
use crate::codex::js::{basename, js_string, js_string_or_empty, slice_utf16_end, slice_utf16_start, stringify_pretty, truthy, utf16_len};
use serde_json::{json, Map, Value};

/// agent-runs.mjs `MAX_OUTPUT`.
pub const MAX_OUTPUT: usize = 20_000;
const INPUT_LIMIT: usize = 4000;

/// Command output keeps its end, where results and errors are.
pub fn cap_output(text: &str) -> String {
    if utf16_len(text) > MAX_OUTPUT {
        format!("… truncated\n{}", slice_utf16_end(text, MAX_OUTPUT))
    } else {
        text.to_string()
    }
}

/// Text shown as code in a title: one line of at most `max` UTF-16 units, no backticks of its own.
pub fn code(text: &str, max: usize) -> String {
    let flat = text.trim().replace('`', "'").split_whitespace().collect::<Vec<_>>().join(" ");
    let flat = if utf16_len(&flat) > max { format!("{}…", slice_utf16_start(&flat, max - 1)) } else { flat };
    format!("`{flat}`")
}

fn code80(value: Option<&Value>) -> String {
    code(&js_string_or_empty(value), 80)
}

fn file_name(file: Option<&Value>) -> String {
    if truthy(file) {
        code(&basename(&js_string(file)), 80)
    } else {
        "a file".into()
    }
}

/// A step's file: a non-empty string, or nothing.
fn file_path(file: Option<&Value>) -> Option<Value> {
    file.and_then(Value::as_str).filter(|s| !s.is_empty()).map(Value::from)
}

fn is_secret_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    ["password", "secret", "token", "authorization", "credential", "apikey", "api_key", "api-key"].iter().any(|word| lower.contains(word))
}

/// tool-activity.mjs `toolMetadata`: `{ source: { name, server? }, input? }` with secrets redacted.
pub fn tool_metadata(server: Option<&Value>, name: Option<&Value>, input: Option<&Value>) -> Map<String, Value> {
    let name = js_string(name);
    let mut source = Map::new();
    source.insert("name".into(), slice_utf16_start(&name, 160).into());
    if truthy(server) {
        source.insert("server".into(), slice_utf16_start(&js_string(server), 160).into());
    }
    let mut metadata = Map::new();
    metadata.insert("source".into(), Value::Object(source));
    let skip = ["design_show", "design_apply", "artifact_show", "html_render", "html_preview"].contains(&name.as_str());
    if let Some(input) = input.filter(|i| !i.is_null()) {
        if !skip {
            let mut args = stringify_pretty(input, Some(&is_secret_key));
            if utf16_len(&args) > INPUT_LIMIT {
                args = format!("{}\n… input truncated", slice_utf16_start(&args, INPUT_LIMIT));
            }
            if args != "{}" && !args.is_empty() {
                metadata.insert("input".into(), args.into());
            }
        }
    }
    metadata
}

fn is_artifact_tool(server: Option<&Value>, tool: Option<&str>) -> bool {
    server.and_then(Value::as_str) == Some("milagre")
        && matches!(tool, Some("design_show" | "design_apply" | "artifact_show" | "html_render"))
}

fn artifact_title(title: Option<&Value>, tool: &str) -> String {
    let verb = if tool == "design_apply" { "Edited" } else { "Showed" };
    let text = if truthy(title) {
        js_string(title)
    } else if tool == "artifact_show" {
        "an artifact".into()
    } else {
        "a design".into()
    };
    format!("{verb} {}", code(&text, 80))
}

fn is_resolve_tool(server: Option<&Value>, tool: Option<&str>) -> bool {
    server.and_then(Value::as_str) == Some("milagre") && matches!(tool, Some("artifact_resolve_comment" | "browser_resolve_comment"))
}

fn resolved_title(tool: &str) -> &'static str {
    if tool == "browser_resolve_comment" {
        "Resolved a page comment"
    } else {
        "Resolved a design comment"
    }
}

const ROUTINE_TOOLS: [&str; 6] =
    ["routine_list", "heartbeat_create", "routine_create", "routine_update", "routine_delete", "routine_run_now"];

fn routine_title(server: Option<&Value>, tool: Option<&str>, input: Option<&Value>) -> Option<String> {
    let tool = tool?;
    if server.and_then(Value::as_str) != Some("milagre") || !ROUTINE_TOOLS.contains(&tool) {
        return None;
    }
    let name = input.and_then(|i| i.get("name")).and_then(Value::as_str).filter(|n| !n.is_empty());
    Some(match tool {
        "heartbeat_create" => name.map(|n| format!("Set Heartbeat \"{n}\"")).unwrap_or_else(|| "Set a Heartbeat".into()),
        "routine_create" => name.map(|n| format!("Set Routine \"{n}\"")).unwrap_or_else(|| "Set a Routine".into()),
        "routine_delete" => "Stopped a Routine".into(),
        _ => "Checked Routines".into(),
    })
}

/// The artifact a finished design tool made, from the first line of its result.
pub fn artifact_ref(text: &str) -> Option<Value> {
    let first = text.split('\n').next().unwrap_or("");
    let parsed: Value = serde_json::from_str(first).ok()?;
    let id = parsed.get("id")?.as_str()?;
    let version = parsed.get("version").filter(|v| v.as_f64().is_some_and(|f| f.fract() == 0.0 && f.is_finite()))?;
    let title = parsed.get("title")?.as_str()?;
    let mut map = Map::new();
    map.insert("id".into(), id.into());
    map.insert("version".into(), version.clone());
    map.insert("title".into(), title.into());
    if parsed.get("inline") == Some(&Value::Bool(true)) {
        map.insert("inline".into(), true.into());
        if let Some(height) = parsed.get("height").filter(|h| h.as_f64().is_some_and(|f| f.fract() == 0.0 && (24.0..=2000.0).contains(&f)))
        {
            map.insert("height".into(), height.clone());
        }
    }
    if let Some(format) = parsed.get("format").and_then(Value::as_str).filter(|f| matches!(*f, "design" | "html")) {
        map.insert("format".into(), format.into());
    }
    if let Some(group) = parsed.get("group").and_then(Value::as_str).filter(|g| !g.is_empty()) {
        map.insert("group".into(), group.into());
    }
    Some(Value::Object(map))
}

/// The Heartbeat a finished heartbeat_create set: `(routine, detail)`.
fn routine_ref(text: &str) -> Option<(Value, Option<String>)> {
    let mut lines = text.split('\n');
    let first = lines.next().unwrap_or("");
    let parsed: Value = serde_json::from_str(first).ok()?;
    let routine = parsed.get("routine")?;
    let id = routine.get("id")?.as_str().filter(|s| !s.is_empty())?;
    let name = routine.get("name")?.as_str()?;
    let rest = lines.collect::<Vec<_>>().join("\n");
    let rest = rest.trim();
    Some((json!({ "id": id, "name": name }), (!rest.is_empty()).then(|| rest.to_string())))
}

pub fn thinking_step(id: &str) -> Value {
    json!({ "id": id, "kind": "thinking", "title": "Thinking" })
}

/// "Thought for 4s", "Thought for 1m 5s"; "Thought" when the start wasn't seen.
pub fn thinking_end(id: &str, duration_ms: Option<f64>, text: &str) -> Value {
    let mut map = Map::new();
    map.insert("id".into(), id.into());
    map.insert("status".into(), "done".into());
    map.insert(
        "title".into(),
        duration_ms.map(|ms| format!("Thought for {}", format_duration(ms))).unwrap_or_else(|| "Thought".into()).into(),
    );
    if !text.is_empty() {
        map.insert("detail".into(), cap_text(text).into());
    }
    if let Some(ms) = duration_ms {
        map.insert("durationMs".into(), number(ms));
    }
    Value::Object(map)
}

pub fn number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9.0e15 {
        Value::from(value as i64)
    } else {
        Value::from(value)
    }
}

pub fn format_duration(ms: f64) -> String {
    let seconds = (ms / 1000.0).round().max(1.0) as i64;
    if seconds < 60 {
        format!("{seconds}s")
    } else {
        format!("{}m {}s", seconds / 60, seconds % 60)
    }
}

fn command_action(item: &Value) -> Option<&Value> {
    let actions = item.get("commandActions").and_then(Value::as_array)?;
    (actions.len() == 1 && actions[0].get("type").and_then(Value::as_str) != Some("unknown")).then(|| &actions[0])
}

fn change_title(changes: &[Value]) -> String {
    if changes.len() != 1 {
        return if changes.is_empty() { "Edited files".into() } else { format!("Edited {} files", changes.len()) };
    }
    let verb = match changes[0].pointer("/kind/type").and_then(Value::as_str) {
        Some("add") => "Created",
        Some("delete") => "Deleted",
        _ => "Edited",
    };
    format!("{verb} {}", file_name(changes[0].get("path")))
}

fn web_search_title(item: &Value) -> String {
    let action = item.get("action").cloned().unwrap_or(json!({}));
    let action_type = action.get("type").and_then(Value::as_str);
    let url = action.get("url").filter(|u| truthy(Some(u)));
    if action_type == Some("openPage") && url.is_some() {
        return format!("Opened {}", code80(url));
    }
    if action_type == Some("findInPage") && url.is_some() {
        let pattern = action.get("pattern").filter(|p| truthy(Some(p)));
        return format!("Searched {}{}", code80(url), pattern.map(|p| format!(" for {}", code80(Some(p)))).unwrap_or_default());
    }
    let query = [item.get("query"), action.get("query"), action.pointer("/queries/0")].into_iter().flatten().find(|q| truthy(Some(q)));
    match query {
        Some(query) => format!("Searched the web for {}", code80(Some(query))),
        None => "Searched the web".into(),
    }
}

fn web_results(results: Option<&Value>) -> Option<String> {
    let results = results?.as_array()?;
    let lines: Vec<String> = results
        .iter()
        .map(|result| {
            ["title", "url"]
                .iter()
                .filter_map(|key| result.get(*key).and_then(Value::as_str).filter(|s| !s.is_empty()))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .filter(|line| !line.is_empty())
        .collect();
    (!lines.is_empty()).then(|| cap_text(&lines.join("\n\n")))
}

fn changes_of(item: &Value) -> Vec<Value> {
    item.get("changes").and_then(Value::as_array).cloned().unwrap_or_default()
}

/// codex `item/started` item -> step, or `None` for items that aren't tool calls.
pub fn codex_step(item: &Value) -> Option<Value> {
    let item_type = item.get("type").and_then(Value::as_str)?;
    let metadata = if matches!(item_type, "mcpToolCall" | "dynamicToolCall") {
        tool_metadata(item.get("server"), item.get("tool"), item.get("arguments"))
    } else {
        Map::new()
    };
    let id = js_string(item.get("id"));
    let step = |kind: &str, title: String, detail: Option<String>, file: Option<&Value>| {
        let mut map = Map::new();
        map.insert("id".into(), id.clone().into());
        map.insert("kind".into(), kind.into());
        map.insert("title".into(), title.into());
        if let Some(detail) = detail {
            map.insert("detail".into(), detail.into());
        }
        if let Some(file) = file_path(file) {
            map.insert("file".into(), file);
        }
        for (key, value) in &metadata {
            map.insert(key.clone(), value.clone());
        }
        Value::Object(map)
    };
    let tool = item.get("tool").and_then(Value::as_str);
    let server = item.get("server");
    Some(match item_type {
        "commandExecution" => {
            let command = unwrap_shell(&js_string_or_empty(item.get("command")));
            let detail = Some(cap_output(&format!("$ {command}\n")));
            match command_action(item) {
                Some(action) if action.get("type").and_then(Value::as_str) == Some("read") => {
                    let name = action.get("name").filter(|n| truthy(Some(n))).map(|n| js_string(Some(n))).unwrap_or_else(|| {
                        basename(&match action.get("path").filter(|p| !p.is_null()) {
                            Some(p) => js_string(Some(p)),
                            None => command.clone(),
                        })
                    });
                    step("read", format!("Read {}", code(&name, 80)), detail, action.get("path"))
                }
                Some(action) if action.get("type").and_then(Value::as_str) == Some("search") => {
                    let path = action.get("path").filter(|p| truthy(Some(p)));
                    let title = match action.get("query").filter(|q| truthy(Some(q))) {
                        Some(query) => format!(
                            "Searched for {}{}",
                            code80(Some(query)),
                            path.map(|p| format!(" in {}", code80(Some(p)))).unwrap_or_default()
                        ),
                        None => format!("Searched {}", path.map(|p| code80(Some(p))).unwrap_or_else(|| code(&command, 80))),
                    };
                    step("search", title, detail, None)
                }
                Some(action) if action.get("type").and_then(Value::as_str) == Some("listFiles") => {
                    let title = match action.get("path").filter(|p| truthy(Some(p))) {
                        Some(path) => format!("Listed files in {}", code80(Some(path))),
                        None => "Listed files".into(),
                    };
                    step("search", title, detail, None)
                }
                _ => step("shell", format!("Ran {}", code(&command, 80)), detail, None),
            }
        }
        "fileChange" => {
            let changes = changes_of(item);
            let file = (changes.len() == 1).then(|| changes[0].get("path")).flatten();
            step("edit", change_title(&changes), None, file)
        }
        "mcpToolCall" => {
            let arguments = item.get("arguments");
            if is_artifact_tool(server, tool) {
                let mut value =
                    step("artifact", artifact_title(arguments.and_then(|a| a.get("title")), tool.unwrap_or_default()), None, None);
                value["tool"] = tool.unwrap_or_default().into();
                value
            } else if is_resolve_tool(server, tool) {
                let note = arguments.and_then(|a| a.get("note")).filter(|n| !n.is_null()).map(|n| js_string(Some(n)));
                step("other", resolved_title(tool.unwrap_or_default()).into(), note, None)
            } else {
                let title = routine_title(server, tool, arguments)
                    .unwrap_or_else(|| format!("Used {} from {}", code80(item.get("tool")), js_string(server)));
                step("other", title, None, None)
            }
        }
        "dynamicToolCall" => step("other", format!("Used {}", code80(item.get("tool"))), None, None),
        "webSearch" => step("search", web_search_title(item), None, None),
        "imageView" => step("image", format!("Viewed {}", file_name(item.get("path"))), None, item.get("path")),
        "imageGeneration" => step("image", "Generating an image".into(), None, None),
        "contextCompaction" => step("other", "Compacting context".into(), None, None),
        _ => return None,
    })
}

fn blocks_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .map(|block| match block.get("type").and_then(Value::as_str) {
                Some("text") => js_string_or_empty(block.get("text")),
                Some(kind) if !kind.is_empty() => format!("[{kind}]"),
                _ => String::new(),
            })
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn end(id: &str, status: &str, extra: Vec<(&str, Option<Value>)>) -> Value {
    let mut map = Map::new();
    map.insert("id".into(), id.into());
    map.insert("status".into(), status.into());
    for (key, value) in extra {
        if let Some(value) = value {
            map.insert(key.into(), value);
        }
    }
    Value::Object(map)
}

fn status_is(item: &Value, status: &str) -> bool {
    item.get("status").and_then(Value::as_str) == Some(status)
}

/// codex `item/completed` item -> the end of its step.
pub fn codex_step_result(item: &Value) -> Value {
    let id = js_string(item.get("id"));
    let tool = item.get("tool").and_then(Value::as_str);
    let server = item.get("server");
    match item.get("type").and_then(Value::as_str) {
        Some("commandExecution") => {
            let exit_code = item.get("exitCode").filter(|c| !c.is_null()).and_then(Value::as_f64).unwrap_or(0.0);
            let failed = !status_is(item, "completed") || exit_code != 0.0;
            let status = if failed { "failed" } else { "done" };
            if !failed && command_action(item).and_then(|a| a.get("type")).and_then(Value::as_str) == Some("read") {
                return end(&id, status, vec![]);
            }
            let output =
                if status_is(item, "declined") { "Declined.".to_string() } else { js_string_or_empty(item.get("aggregatedOutput")) };
            let command = unwrap_shell(&js_string_or_empty(item.get("command")));
            end(&id, status, vec![("detail", Some(cap_output(&format!("$ {command}\n{output}")).into()))])
        }
        Some("fileChange") => {
            let changes = changes_of(item);
            let status = if status_is(item, "completed") { "done" } else { "failed" };
            let detail = (!changes.is_empty()).then(|| changes_diff(&changes).into());
            end(&id, status, vec![("title", Some(change_title(&changes).into())), ("detail", detail)])
        }
        Some("mcpToolCall") => {
            let done = status_is(item, "completed") && !truthy(item.get("error"));
            let text = blocks_text(item.pointer("/result/content"));
            if done && is_artifact_tool(server, tool) {
                let artifact = artifact_ref(&text);
                let title = artifact.as_ref().map(|a| artifact_title(a.get("title"), tool.unwrap_or_default()).into());
                return end(&id, "done", vec![("artifact", artifact), ("title", title)]);
            }
            if done && is_resolve_tool(server, tool) {
                let note = item.pointer("/arguments/note").filter(|n| !n.is_null()).cloned();
                return end(&id, "done", vec![("detail", note)]);
            }
            if done && server.and_then(Value::as_str) == Some("milagre") && tool == Some("heartbeat_create") {
                if let Some((routine, detail)) = routine_ref(&text) {
                    return end(&id, "done", vec![("routine", Some(routine)), ("detail", detail.map(|d| cap_text(&d).into()))]);
                }
            }
            let message = item.pointer("/error/message").filter(|m| !m.is_null()).map(|m| js_string(Some(m))).unwrap_or(text);
            let detail = cap_text(&message);
            end(&id, if done { "done" } else { "failed" }, vec![("detail", (!detail.is_empty()).then(|| detail.into()))])
        }
        Some("dynamicToolCall") => {
            let text = item
                .get("contentItems")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|c| c.get("text").and_then(Value::as_str))
                        .filter(|t| !t.is_empty())
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default();
            let ok = status_is(item, "completed") && item.get("success") != Some(&Value::Bool(false));
            end(&id, if ok { "done" } else { "failed" }, vec![("detail", (!text.is_empty()).then(|| cap_text(&text).into()))])
        }
        Some("webSearch") => end(
            &id,
            "done",
            vec![("title", Some(web_search_title(item).into())), ("detail", web_results(item.get("results")).map(Value::from))],
        ),
        Some("imageView") => {
            end(&id, if status_is(item, "failed") { "failed" } else { "done" }, vec![("file", file_path(item.get("path")))])
        }
        Some("imageGeneration") => {
            let failed =
                status_is(item, "failed") || truthy(item.get("failure")) || (!truthy(item.get("savedPath")) && !truthy(item.get("result")));
            let note = (item.pointer("/failure/type").and_then(Value::as_str) == Some("usageLimitExceeded"))
                .then(|| Value::from("image limit reached"));
            let detail = item.get("revisedPrompt").filter(|p| truthy(Some(p))).map(|p| cap_text(&js_string(Some(p))).into());
            end(
                &id,
                if failed { "failed" } else { "done" },
                vec![
                    ("title", Some(if failed { "Couldn't generate an image" } else { "Generated an image" }.into())),
                    ("note", note),
                    ("detail", detail),
                    ("file", file_path(item.get("savedPath"))),
                ],
            )
        }
        Some("contextCompaction") => end(&id, "done", vec![("title", Some("Compacted context".into()))]),
        _ => end(&id, if status_is(item, "failed") { "failed" } else { "done" }, vec![]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_flattens_and_truncates() {
        assert_eq!(code("  npm   test\n--watch ", 80), "`npm test --watch`");
        assert_eq!(code("a`b", 80), "`a'b`");
        assert_eq!(code(&"x".repeat(100), 80), format!("`{}…`", "x".repeat(79)));
    }

    #[test]
    fn durations() {
        assert_eq!(format_duration(400.0), "1s");
        assert_eq!(format_duration(4_000.0), "4s");
        assert_eq!(format_duration(65_000.0), "1m 5s");
    }
}

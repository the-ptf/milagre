//! Claude tool steps and thinking steps, ported from `packages/core/src/agents/steps.cjs` (`claudeStep`,
//! `claudeStepResult`, `thinkingStep`, `thinkingEnd`) and `@milagre/shared/tool-activity` (`toolMetadata`).

use serde_json::{Map, Value};

use crate::text::{basename, cap_output, cap_text, code, js_string_or_empty, js_trim, pretty, redacted, utf16_len, utf16_slice, Obj};

const INPUT_LIMIT: usize = 4000;
const ROUTINE_TOOLS: [&str; 6] =
    ["routine_list", "heartbeat_create", "routine_create", "routine_update", "routine_delete", "routine_run_now"];
const ARTIFACT_TOOLS: [&str; 4] = ["design_show", "design_apply", "artifact_show", "html_render"];

/// `/^mcp__(.+?)__(.+)$/`.
pub fn mcp_name(tool_name: &str) -> Option<(&str, &str)> {
    let rest = tool_name.strip_prefix("mcp__")?;
    let mut from = rest.chars().next()?.len_utf8();
    while from < rest.len() {
        let index = from + rest[from..].find("__")?;
        let tool = &rest[index + 2..];
        if !tool.is_empty() {
            return Some((&rest[..index], tool));
        }
        from = index + 1;
        while !rest.is_char_boundary(from) {
            from += 1;
        }
    }
    None
}

fn is_secret(key: &str) -> bool {
    let lower = key.to_lowercase();
    ["password", "secret", "token", "authorization", "credential"].iter().any(|word| lower.contains(word))
        || lower.contains("apikey")
        || lower.contains("api_key")
        || lower.contains("api-key")
}

/// `toolMetadata(server, name, input)`: the tool's identity and a bounded, redacted preview of its input.
pub fn tool_metadata(server: &str, name: &str, input: Option<&Value>) -> Map<String, Value> {
    let mut source = Map::new();
    source.insert("name".into(), utf16_slice(name, 0, 160).into());
    if !server.is_empty() {
        source.insert("server".into(), utf16_slice(server, 0, 160).into());
    }
    let mut out = Map::new();
    out.insert("source".into(), Value::Object(source));
    let skip = ["design_show", "design_apply", "artifact_show", "html_render", "html_preview"].contains(&name);
    if let Some(input) = input.filter(|input| !input.is_null() && !skip) {
        let mut args = pretty(&redacted(input, &is_secret));
        if utf16_len(&args) > INPUT_LIMIT {
            args = format!("{}\n… input truncated", utf16_slice(&args, 0, INPUT_LIMIT));
        }
        if args != "{}" {
            out.insert("input".into(), args.into());
        }
    }
    out
}

fn file_path(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).filter(|file| !file.is_empty()).map(str::to_owned)
}

fn file_name(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => "a file".into(),
        Some(value) => {
            let text = crate::text::js_string(value);
            if text.is_empty() {
                "a file".into()
            } else {
                code(Some(&Value::String(basename(&text).to_owned())), 80)
            }
        }
    }
}

/// `input.a ?? input.b`.
fn either<'a>(input: &'a Value, a: &str, b: &str) -> Option<&'a Value> {
    input.get(a).filter(|value| !value.is_null()).or_else(|| input.get(b).filter(|value| !value.is_null()))
}

fn artifact_title(title: Option<&str>, tool: &str) -> String {
    let fallback = if tool == "artifact_show" { "an artifact" } else { "a design" };
    let shown = title.filter(|title| !title.is_empty()).unwrap_or(fallback);
    format!("{} {}", if tool == "design_apply" { "Edited" } else { "Showed" }, code(Some(&Value::String(shown.into())), 80))
}

fn routine_title(server: &str, tool: &str, input: &Value) -> Option<String> {
    if server != "milagre" || !ROUTINE_TOOLS.contains(&tool) {
        return None;
    }
    let name = input.get("name").and_then(Value::as_str).filter(|name| !name.is_empty());
    Some(match tool {
        "heartbeat_create" => name.map(|name| format!("Set Heartbeat \"{name}\"")).unwrap_or_else(|| "Set a Heartbeat".into()),
        "routine_create" => name.map(|name| format!("Set Routine \"{name}\"")).unwrap_or_else(|| "Set a Routine".into()),
        "routine_delete" => "Stopped a Routine".into(),
        _ => "Checked Routines".into(),
    })
}

/// `claudeStep(id, name, input)`: the step a tool_use block starts.
pub fn claude_step(id: &str, name: &str, input: &Value) -> Value {
    let empty = Value::Object(Map::new());
    let input = if input.is_null() { &empty } else { input };
    let mcp = mcp_name(name);
    let metadata = mcp.map(|(server, tool)| tool_metadata(server, tool, Some(input))).unwrap_or_default();
    let step = |kind: &str, title: String, detail: Option<String>, file: Option<String>| {
        Obj::new()
            .set("id", id)
            .set("kind", kind)
            .set("title", title)
            .opt("detail", detail)
            .opt("file", file)
            .merge(metadata.clone())
            .build()
    };
    let get = |key: &str| input.get(key);
    match name {
        "Bash" => step(
            "shell",
            format!("Ran {}", code(get("command"), 80)),
            Some(cap_output(&format!("$ {}\n", js_string_or_empty(get("command"))))),
            None,
        ),
        "Read" => step("read", format!("Read {}", file_name(get("file_path"))), None, file_path(get("file_path"))),
        "Edit" | "MultiEdit" | "NotebookEdit" => {
            let file = either(input, "file_path", "notebook_path");
            step("edit", format!("Edited {}", file_name(file)), None, file_path(file))
        }
        "Write" => step("edit", format!("Wrote {}", file_name(get("file_path"))), None, file_path(get("file_path"))),
        "Grep" => {
            let path = get("path").filter(|path| truthy(path));
            let scope = path.map(|path| format!(" in {}", code(Some(path), 80))).unwrap_or_default();
            step("search", format!("Searched for {}{scope}", code(get("pattern"), 80)), None, None)
        }
        "Glob" => step("search", format!("Found files matching {}", code(get("pattern"), 80)), None, None),
        "WebSearch" => step("search", format!("Searched the web for {}", code(get("query"), 80)), None, None),
        "WebFetch" => step("other", format!("Fetched {}", code(get("url"), 80)), None, None),
        "Agent" | "Task" => step("other", format!("Ran an agent: {}", description(input)), None, None),
        "TodoWrite" => step("other", "Updated the to-do list".into(), None, None),
        _ => match mcp {
            Some((server, tool)) if server == "milagre" && ARTIFACT_TOOLS.contains(&tool) => {
                let mut value = step("artifact", artifact_title(get("title").and_then(Value::as_str), tool), None, None);
                value["tool"] = tool.into();
                value
            }
            Some((server, tool)) if server == "milagre" && (tool == "artifact_resolve_comment" || tool == "browser_resolve_comment") => {
                let title = if tool == "browser_resolve_comment" { "Resolved a page comment" } else { "Resolved a design comment" };
                let mut value = step("other", title.into(), None, None);
                if let Some(note) = get("note").filter(|note| !note.is_null()) {
                    // Passed through as given, as steps.cjs does (key order is not significant).
                    value["detail"] = note.clone();
                }
                value
            }
            Some((server, tool)) => match routine_title(server, tool, input) {
                Some(title) => step("other", title, None, None),
                None => step("other", format!("Used {} from {server}", code(Some(&Value::String(tool.into())), 80)), None, None),
            },
            None => step("other", format!("Used {name}"), None, None),
        },
    }
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::String(text) => !text.is_empty(),
        Value::Number(number) => number.as_f64().map(|n| n != 0.0).unwrap_or(true),
        _ => true,
    }
}

fn description(input: &Value) -> String {
    input.get("description").filter(|d| truthy(d)).map(crate::text::js_string).unwrap_or_else(|| "a subtask".into())
}

/// A tool result's content as text (`blocksText`).
pub fn blocks_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .map(|block| match block.get("type").and_then(Value::as_str) {
                Some("text") => block.get("text").map(js_string_or_undefined).unwrap_or_default(),
                Some(kind) => format!("[{kind}]"),
                None => match block.get("type") {
                    Some(other) if truthy(other) => format!("[{}]", crate::text::js_string(other)),
                    _ => String::new(),
                },
            })
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn js_string_or_undefined(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        other => crate::text::js_string(other),
    }
}

/// The artifact a finished design tool made, from the first line of its result.
fn artifact_ref(text: &str) -> Option<Value> {
    let first = text.split('\n').next().unwrap_or("");
    let parsed: Value = serde_json::from_str(first).ok()?;
    let id = parsed.get("id")?.as_str()?;
    let version = parsed.get("version").filter(|v| is_integer(v))?.clone();
    let title = parsed.get("title")?.as_str()?;
    let mut obj = Obj::new().set("id", id).set("version", version).set("title", title);
    if parsed.get("inline") == Some(&Value::Bool(true)) {
        obj = obj.set("inline", true);
        if parsed.get("height").filter(|h| is_integer(h)).and_then(Value::as_f64).is_some_and(|h| (24.0..=2000.0).contains(&h)) {
            obj = obj.set("height", parsed["height"].clone());
        }
    }
    if let Some(format) = parsed.get("format").and_then(Value::as_str).filter(|f| *f == "design" || *f == "html") {
        obj = obj.set("format", format);
    }
    if let Some(group) = parsed.get("group").and_then(Value::as_str).filter(|g| !g.is_empty()) {
        obj = obj.set("group", group);
    }
    Some(obj.build())
}

fn is_integer(value: &Value) -> bool {
    value.as_f64().map(|n| n.fract() == 0.0 && n.is_finite()).unwrap_or(false)
}

fn routine_ref(text: &str) -> Option<(Value, Option<String>)> {
    let mut lines = text.split('\n');
    let first = lines.next().unwrap_or("");
    let parsed: Value = serde_json::from_str(first).ok()?;
    let routine = parsed.get("routine")?;
    let id = routine.get("id")?.as_str().filter(|id| !id.is_empty())?;
    let name = routine.get("name")?.as_str()?;
    let rest = lines.collect::<Vec<_>>().join("\n");
    let detail = js_trim(&rest);
    Some((Obj::new().set("id", id).set("name", name).build(), (!detail.is_empty()).then(|| detail.to_owned())))
}

fn patch_diff(structured: Option<&Value>) -> Option<String> {
    let hunks = structured?.get("structuredPatch")?.as_array().filter(|hunks| !hunks.is_empty())?;
    let text = hunks
        .iter()
        .map(|hunk| {
            let field = |key: &str| hunk.get(key).map(crate::text::js_string).unwrap_or_else(|| "undefined".into());
            let mut lines =
                vec![format!("@@ -{},{} +{},{} @@", field("oldStart"), field("oldLines"), field("newStart"), field("newLines"))];
            if let Some(body) = hunk.get("lines").and_then(Value::as_array) {
                lines.extend(body.iter().map(crate::text::js_string));
            }
            lines.join("\n")
        })
        .collect::<Vec<_>>()
        .join("\n");
    Some(cap_text(&text))
}

/// `claudeStepResult(call, block, structured)`: the end of the step a tool_result closes.
pub fn claude_step_result(call: &Value, block: &Value, structured: Option<&Value>) -> Value {
    let name = call.get("name").and_then(Value::as_str).unwrap_or("");
    let empty = Value::Object(Map::new());
    let input = call.get("input").filter(|input| !input.is_null()).unwrap_or(&empty);
    let failed = block.get("is_error") == Some(&Value::Bool(true));
    let text = blocks_text(block.get("content"));
    let id = call.get("id").map(crate::text::js_string).unwrap_or_default();
    let end = |extra: Obj| Obj::new().set("id", id.clone()).set("status", if failed { "failed" } else { "done" }).merge(extra.0).build();
    let detail_of = |text: &str| (!text.is_empty()).then(|| cap_text(text));
    if name == "Bash" {
        return end(Obj::new().set("detail", cap_output(&format!("$ {}\n{text}", js_string_or_empty(input.get("command"))))));
    }
    if failed {
        return end(Obj::new().opt("detail", detail_of(&text)));
    }
    let safe_count = |value: Option<&Value>| {
        value.filter(|v| is_integer(v)).and_then(Value::as_f64).filter(|n| *n >= 0.0 && *n <= 9_007_199_254_740_991.0)
    };
    if name == "Read" {
        let lines = safe_count(structured.and_then(|s| s.get("file")).and_then(|f| f.get("numLines")));
        return end(Obj::new().opt("summary", lines.map(|n| format!("{} lines", n as u64))));
    }
    if name == "Grep" {
        if let Some(matches) = safe_count(structured.and_then(|s| s.get("numMatches"))) {
            return end(Obj::new().opt("detail", detail_of(&text)).set("summary", format!("{} matches", matches as u64)));
        }
    }
    if let Some((_, tool)) = mcp_name(name).filter(|(server, tool)| *server == "milagre" && ARTIFACT_TOOLS.contains(tool)) {
        let artifact = artifact_ref(&text);
        let title = artifact.as_ref().map(|artifact| artifact_title(artifact.get("title").and_then(Value::as_str), tool));
        return end(Obj::new().opt("artifact", artifact).opt("title", title));
    }
    if name == "mcp__milagre__artifact_resolve_comment" || name == "mcp__milagre__browser_resolve_comment" {
        return end(Obj::new().opt("detail", input.get("note").filter(|n| !n.is_null()).cloned()));
    }
    if name == "mcp__milagre__heartbeat_create" {
        if let Some((routine, detail)) = routine_ref(&text) {
            return end(Obj::new().set("routine", routine).opt("detail", detail.map(|d| cap_text(&d))));
        }
    }
    if matches!(name, "Edit" | "MultiEdit" | "NotebookEdit" | "Write") {
        let detail = patch_diff(structured).unwrap_or_else(|| crate::milagre::edit_diff(name, input));
        return end(Obj::new().set("detail", detail));
    }
    if matches!(name, "Agent" | "Task") {
        if structured.and_then(|s| s.get("status")).and_then(Value::as_str) == Some("async_launched") {
            return end(Obj::new().set("title", format!("Started an agent: {}", description(input))));
        }
        if let Some(content) = structured.and_then(|s| s.get("content")).filter(|c| c.is_array()) {
            let text = cap_text(&blocks_text(Some(content)));
            return end(Obj::new().opt("detail", (!text.is_empty()).then_some(text)));
        }
    }
    if name == "TodoWrite" {
        if let Some(todos) = input.get("todos").and_then(Value::as_array) {
            let lines: Vec<String> = todos
                .iter()
                .map(|todo| {
                    let mark = match todo.get("status").and_then(Value::as_str) {
                        Some("completed") => "[x]",
                        Some("in_progress") => "[~]",
                        _ => "[ ]",
                    };
                    let content = match todo.get("content") {
                        None => "undefined".into(),
                        Some(value) => crate::text::js_string(value),
                    };
                    format!("{mark} {content}")
                })
                .collect();
            return end(Obj::new().set("detail", lines.join("\n")));
        }
    }
    end(Obj::new().opt("detail", detail_of(&text)))
}

pub fn thinking_step(id: &str) -> Value {
    Obj::new().set("id", id).set("kind", "thinking").set("title", "Thinking").build()
}

/// "Thought for 4s", "Thought for 1m 5s".
pub fn thinking_end(id: &str, duration_ms: Option<u64>, text: &str) -> Value {
    let title = match duration_ms {
        None => "Thought".to_owned(),
        Some(ms) => format!("Thought for {}", format_duration(ms)),
    };
    Obj::new()
        .set("id", id)
        .set("status", "done")
        .set("title", title)
        .opt("detail", (!text.is_empty()).then(|| cap_text(text)))
        .opt("durationMs", duration_ms)
        .build()
}

fn format_duration(ms: u64) -> String {
    // JS Math.round: halves round up.
    let seconds = ((ms as f64 / 1000.0) + 0.5).floor().max(1.0) as u64;
    if seconds < 60 {
        format!("{seconds}s")
    } else {
        format!("{}m {}s", seconds / 60, seconds % 60)
    }
}

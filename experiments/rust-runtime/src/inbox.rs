//! Saved, idle Chat inbox projection. Active background ownership requires the future live owner.
use milagre_owner_store::jsjson;
use milagre_owner_wire::{RpcError, RpcResult};
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;

pub fn snapshot(scopes: &[Value]) -> RpcResult {
    let mut agents = Vec::new();
    for scope in scopes {
        let Some(sessions) = scope["state"]["sessions"].as_object() else {
            continue;
        };
        for (_, session) in jsjson::js_entries(sessions) {
            if jsjson::truthy(session.get("archived")) {
                continue;
            }
            // Do not invent live run/background status from saved files. Those scopes need an owner.
            if session["backgroundTasks"]
                .as_array()
                .is_some_and(|a| !a.is_empty())
                || session["subagents"].as_array().is_some_and(|a| {
                    a.iter().any(|agent| {
                        jsjson::truthy(agent.get("background"))
                            || agent["source"] == "milagre-advisor"
                    })
                })
            {
                return Err(RpcError::new("UNSUPPORTED_LIVE_INBOX", "Background Chat activity needs the live Rust owner; saved completion inbox reads are available"));
            }
            let status = session["summary"]["lastOutcome"].as_str().unwrap_or("");
            if !jsjson::truthy(session.get("unread")) || !matches!(status, "completed" | "failed") {
                continue;
            }
            if session["routine"]["hidden"] == true && status != "failed" {
                continue;
            }
            let path = scope["path"].as_str().unwrap();
            let id = jsjson::property_key(session.get("id"));
            let mut item = Map::new();
            item.insert("key".into(), json!(format!("{path}#{id}")));
            item.insert("projectPath".into(), scope["path"].clone());
            item.insert("project".into(), scope["name"].clone());
            if let Some(title) = title(session) {
                item.insert("title".into(), title);
            }
            if let Some(provider) = session.get("provider") {
                item.insert("provider".into(), provider.clone());
            }
            item.insert("status".into(), json!(status));
            item.insert(
                "at".into(),
                session["summary"]
                    .get("lastAt")
                    .filter(|at| !at.is_null())
                    .cloned()
                    .unwrap_or(json!(0)),
            );
            let preview = scope["state"]["messages"]
                .as_array()
                .and_then(|messages| {
                    messages.iter().rev().find(|message| {
                        message["role"] == "assistant"
                            && jsjson::strict_equals(&message["session_id"], &session["id"])
                    })
                })
                .and_then(|message| message["body"].as_str())
                .map(|body| cut(body, 240))
                .filter(|body| !body.is_empty())
                .unwrap_or_else(|| {
                    if status == "failed" {
                        "The turn failed. Open the Chat for details."
                    } else {
                        "The agent finished its turn. Open the Chat to review the result."
                    }
                    .into()
                });
            item.insert("preview".into(), json!(preview));
            agents.push(Value::Object(item));
        }
    }
    let mut items = agents.clone();
    items.sort_by(|a, b| {
        b["at"]
            .as_f64()
            .unwrap_or(0.0)
            .total_cmp(&a["at"].as_f64().unwrap_or(0.0))
            // Fixture scope paths and Chat identities are ASCII. Locale collation for arbitrary names is deferred.
            .then_with(|| a["key"].as_str().cmp(&b["key"].as_str()))
    });
    Ok(json!({"agents":agents,"items":items}))
}
fn whitespace(c: char) -> bool {
    matches!(c, '\u{9}'..='\u{d}' | '\u{20}' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
fn cut(text: &str, count: usize) -> String {
    let mut units = jsjson::to_utf16(text);
    units.truncate(count);
    jsjson::from_utf16(&units)
}
fn title(session: &Value) -> Option<Value> {
    for field in ["title", "generatedTitle"] {
        if let Some(text) = session[field]
            .as_str()
            .map(|s| s.trim_matches(whitespace))
            .filter(|s| !s.is_empty())
        {
            return Some(json!(text));
        }
    }
    let line = if session.get("summary").is_some_and(|s| !s.is_null()) {
        prompt_title(
            session["summary"]["titleLine"].as_str().unwrap_or(""),
            session["summary"].get("titleImages"),
        )
    } else {
        String::new()
    };
    if line.is_empty() {
        session.get("agent_name").cloned()
    } else if jsjson::utf16_len(&line) > 60 {
        Some(json!(format!("{}…", cut(&line, 57))))
    } else {
        Some(json!(line))
    }
}
fn prompt_title(line: &str, images: Option<&Value>) -> String {
    let mut found = BTreeSet::new();
    let mut output = String::new();
    let mut remaining = line;
    while let Some(index) = remaining.find("[Image #") {
        output.push_str(&remaining[..index]);
        remaining = &remaining[index..];
        let digits = remaining[8..]
            .bytes()
            .take_while(u8::is_ascii_digit)
            .count();
        let number = &remaining[8..8 + digits];
        let valid = !number.is_empty()
            && !number.starts_with('0')
            && remaining[8 + digits..].starts_with(']');
        if valid {
            let index = number.parse::<f64>().unwrap_or(f64::INFINITY);
            let has_image = images.is_none()
                || images
                    .and_then(Value::as_f64)
                    .is_some_and(|count| index <= count);
            if has_image {
                found.insert(index.to_bits());
                remaining = &remaining[9 + digits..];
                continue;
            }
        }
        output.push('[');
        remaining = &remaining[1..];
    }
    output.push_str(remaining);
    let output = output
        .split(whitespace)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if !output.is_empty() || found.is_empty() {
        output
    } else if found.len() == 1 {
        "Image".into()
    } else {
        format!("{} images", found.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn javascript_title_whitespace_images_and_utf16_boundary() {
        assert_eq!(
            prompt_title(" \u{feff}[Image #1] [Image #2] ", None),
            "2 images"
        );
        assert_eq!(
            prompt_title("[Image #1] [Image #2]", Some(&json!(1))),
            "[Image #2]"
        );
        assert_eq!(
            prompt_title("[Image #0] [Image #01] [Image #1]", None),
            "[Image #0] [Image #01]"
        );
        assert_eq!(
            title(&json!({"summary":{"titleLine":format!("{}🦀more", "a".repeat(56))}}))
                .unwrap()
                .as_str()
                .map(jsjson::to_utf16)
                .unwrap()[56],
            0xd83e
        );
        assert!(
            jsjson::to_string(&json!(cut(&format!("{}🦀", "a".repeat(239)), 240)))
                .ends_with("\\ud83e\"")
        );
    }
}

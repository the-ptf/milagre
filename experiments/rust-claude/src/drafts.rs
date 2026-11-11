//! Live drafts of Milagre design tool inputs, ported from `packages/core/src/agents/design-drafts.cjs`.
//! Claude streams a tool call's input as `input_json_delta` pieces; for `design_show` / `design_apply`
//! they go out as `step-draft` events at most every `DRAFT_MS`, and at the block's end.

use std::collections::HashMap;

use serde_json::Value;

use crate::text::{utf16_len, Obj};

pub const DRAFT_MS: u64 = 120;

#[derive(Debug, Clone)]
struct Draft {
    id: String,
    tool: String,
    sent: usize,
    pending: String,
    at: u64,
    agent: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Drafts(HashMap<String, Draft>);

fn key(agent: Option<&str>, index: &Value) -> String {
    let index = crate::text::js_string(index);
    match agent {
        Some(agent) => format!("{agent}:{index}"),
        None => index,
    }
}

fn flush(draft: &mut Draft, now: u64, done: bool) -> Vec<Value> {
    if draft.pending.is_empty() && !done {
        return Vec::new();
    }
    let event = Obj::new()
        .set("type", "step-draft")
        .set("id", draft.id.clone())
        .set("tool", draft.tool.clone())
        .set("offset", draft.sent)
        .set("text", draft.pending.clone())
        .opt("done", done.then_some(true))
        .opt("agent", draft.agent.clone())
        .build();
    draft.sent += utf16_len(&draft.pending);
    draft.pending.clear();
    draft.at = now;
    vec![event]
}

impl Drafts {
    /// `claudeDesignDrafts(event, state, agent)`.
    pub fn on_stream_event(&mut self, event: &Value, now: u64, agent: Option<&str>) -> Vec<Value> {
        let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
        let index = event.get("index").cloned().unwrap_or(Value::Null);
        if kind == "message_start" {
            self.0.retain(|_, draft| draft.agent.as_deref() != agent);
            return Vec::new();
        }
        if kind == "content_block_start" && event.pointer("/content_block/type").and_then(Value::as_str) == Some("tool_use") {
            let block = &event["content_block"];
            let name = block.get("name").map(crate::text::js_string).unwrap_or_default();
            let tool = match name.as_str() {
                "mcp__milagre__design_show" => "design_show",
                "mcp__milagre__design_apply" => "design_apply",
                _ => return Vec::new(),
            };
            let Some(id) = block.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()) else { return Vec::new() };
            let draft =
                Draft { id: id.into(), tool: tool.into(), sent: 0, pending: String::new(), at: now, agent: agent.map(str::to_owned) };
            self.0.insert(key(agent, &index), draft);
            return vec![Obj::new()
                .set("type", "step-draft")
                .set("id", id)
                .set("tool", tool)
                .set("offset", 0)
                .set("text", "")
                .opt("agent", agent.map(str::to_owned))
                .build()];
        }
        let slot = key(agent, &index);
        let Some(draft) = self.0.get_mut(&slot) else { return Vec::new() };
        if kind == "content_block_delta" && event.pointer("/delta/type").and_then(Value::as_str) == Some("input_json_delta") {
            if let Some(piece) = event.pointer("/delta/partial_json").and_then(Value::as_str) {
                draft.pending.push_str(piece);
                return if now.saturating_sub(draft.at) >= DRAFT_MS { flush(draft, now, false) } else { Vec::new() };
            }
        }
        if kind == "content_block_stop" {
            let mut draft = self.0.remove(&slot).unwrap();
            return flush(&mut draft, now, true);
        }
        Vec::new()
    }
}

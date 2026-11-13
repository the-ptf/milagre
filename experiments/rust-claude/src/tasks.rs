//! The agent's to-do list, ported from `packages/core/src/agents/tasks.cjs` (Claude parts): TodoWrite
//! replaces the list, TaskCreate / TaskUpdate / TaskList change it one call at a time. The list lives
//! for the provider session, in creation order. Each helper returns the whole list to emit, or `None`.

use serde_json::Value;

use crate::text::{js_string, js_trim, Obj};

#[derive(Debug, Clone, Default)]
pub struct Tasks(Vec<(String, Value)>);

fn text(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).map(|text| js_trim(text).to_owned()).unwrap_or_default()
}

fn status(value: Option<&Value>) -> &'static str {
    match value.and_then(Value::as_str) {
        Some("in_progress") => "in_progress",
        Some("completed") => "completed",
        _ => "pending",
    }
}

fn task(id: &str, content: &str, state: Option<&Value>, active_form: Option<&Value>) -> Value {
    let form = text(active_form);
    Obj::new()
        .set("id", id)
        .set("content", content)
        .opt("activeForm", (!form.is_empty()).then_some(form))
        .set("status", status(state))
        .build()
}

/// `String(value)` for ids (`String(undefined)` is "undefined").
fn id_of(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(value) => js_string(value),
    }
}

impl Tasks {
    pub fn list(&self) -> Vec<Value> {
        self.0.iter().map(|(_, task)| task.clone()).collect()
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    fn get(&self, id: &str) -> Option<&Value> {
        self.0.iter().find(|(key, _)| key == id).map(|(_, task)| task)
    }

    fn set(&mut self, id: String, task: Value) {
        match self.0.iter_mut().find(|(key, _)| *key == id) {
            Some(entry) => entry.1 = task,
            None => self.0.push((id, task)),
        }
    }

    fn replace(&mut self, list: Vec<Value>) -> Vec<Value> {
        self.0.clear();
        for task in list {
            let id = task["id"].as_str().unwrap_or_default().to_owned();
            self.set(id, task);
        }
        self.list()
    }

    /// `applyToolUse`: a tool call in a top-level assistant message.
    pub fn apply_tool_use(&mut self, name: &str, input: &Value) -> Option<Vec<Value>> {
        if name == "TodoWrite" {
            let todos = input.get("todos")?.as_array()?;
            let list = todos
                .iter()
                .enumerate()
                .filter_map(|(index, todo)| {
                    let content = text(todo.get("content"));
                    (!content.is_empty()).then(|| task(&index.to_string(), &content, todo.get("status"), todo.get("activeForm")))
                })
                .collect();
            return Some(self.replace(list));
        }
        if name != "TaskUpdate" {
            return None;
        }
        let id = match input.get("taskId") {
            None | Some(Value::Null) => String::new(),
            Some(value) => js_string(value),
        };
        let current = self.get(&id)?.clone();
        if input.get("status").and_then(Value::as_str) == Some("deleted") {
            self.0.retain(|(key, _)| *key != id);
            return Some(self.list());
        }
        let subject = text(input.get("subject"));
        let content = if subject.is_empty() { current["content"].as_str().unwrap_or_default().to_owned() } else { subject };
        let form = text(input.get("activeForm"));
        let form = if form.is_empty() { current.get("activeForm").cloned() } else { Some(Value::String(form)) };
        let state = input.get("status").filter(|status| !status.is_null()).cloned().or_else(|| current.get("status").cloned());
        self.set(id.clone(), task(&id, &content, state.as_ref(), form.as_ref()));
        Some(self.list())
    }

    /// `applyToolResult`: the result of TaskCreate or TaskList.
    pub fn apply_tool_result(&mut self, call: &Value, block: &Value, structured: Option<&Value>) -> Option<Vec<Value>> {
        if block.get("is_error").is_some_and(|flag| !matches!(flag, Value::Null | Value::Bool(false))) {
            return None;
        }
        let name = call.get("name").and_then(Value::as_str).unwrap_or("");
        if name == "TaskList" {
            let items = structured?.get("tasks")?.as_array()?;
            let list = items
                .iter()
                .filter_map(|item| {
                    let subject = text(item.get("subject"));
                    if subject.is_empty() {
                        return None;
                    }
                    let id = id_of(item.get("id"));
                    let known = self.get(&id).and_then(|task| task.get("activeForm")).cloned();
                    Some(task(&id, &subject, item.get("status"), known.as_ref()))
                })
                .collect();
            return Some(self.replace(list));
        }
        if name != "TaskCreate" {
            return None;
        }
        let input = call.get("input");
        let subject = text(input.and_then(|input| input.get("subject")));
        if subject.is_empty() {
            return None;
        }
        let id = created_id(structured, block).unwrap_or_else(|| format!("task-{}", self.len() + 1));
        self.set(id.clone(), task(&id, &subject, None, input.and_then(|input| input.get("activeForm"))));
        Some(self.list())
    }
}

/// The id TaskCreate gave a task: from its structured result, else from "Task #3 created successfully".
fn created_id(structured: Option<&Value>, block: &Value) -> Option<String> {
    if let Some(id) = structured.and_then(|s| s.get("task")).and_then(|task| task.get("id")) {
        return Some(js_string(id));
    }
    let body = match block.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => {
            parts.iter().map(|part| part.get("text").and_then(Value::as_str).unwrap_or("").to_owned()).collect::<Vec<_>>().join("\n")
        }
        _ => String::new(),
    };
    // `/#(\w+)/`: the first `#` followed by a word character.
    body.match_indices('#').find_map(|(at, _)| {
        let id: String = body[at + 1..].chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
        (!id.is_empty()).then_some(id)
    })
}

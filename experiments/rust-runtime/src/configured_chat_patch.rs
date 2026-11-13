//! Bounded dedicated-Project metadata edits. Pins in current UI are device-local;
//! legacy persisted pins remain wire-compatible, while `kept` only keeps Run Chats.
use milagre_owner_store::{jsjson, tool_activity::js_trim};
use milagre_owner_wire::RpcError;
use serde_json::{json, Map, Value};

pub(crate) struct Patch {
    fields: Map<String, Value>,
    keep: bool,
    pub done: bool,
}
fn invalid() -> RpcError {
    RpcError::new("INVALID_CHAT_PATCH", "Supported Chat edits: unread, title, done, archived:false, kept:true, legacy pinned/pin_order")
}
impl Patch {
    pub(crate) fn parse(value: &Value, now: i64) -> Result<Self, RpcError> {
        let input = value
            .as_object()
            .filter(|p| !p.is_empty() && p.len() <= 7)
            .ok_or_else(invalid)?;
        let mut fields = Map::new();
        for (key, value) in input {
            match key.as_str() {
                "unread" | "done" | "pinned" if value.is_boolean() => {}
                "title"
                    if value
                        .as_str()
                        .is_some_and(|s| jsjson::utf16_len(s) <= 16_384) => {}
                "archived" if value == false => {}
                "kept" if value == true => {}
                "pin_order" if value.as_f64().is_some_and(f64::is_finite) => {}
                _ => return Err(invalid()),
            }
            if !matches!(key.as_str(), "done" | "kept") {
                fields.insert(key.clone(), value.clone());
            }
        }
        let done = input.get("done") == Some(&json!(true));
        if done {
            fields.insert("done_at".into(), json!(now));
        } else if input.get("done") == Some(&json!(false))
            || input.get("archived") == Some(&json!(false))
        {
            fields.insert("done_at".into(), json!(false));
        }
        let keep = input.get("kept") == Some(&json!(true))
            || input.get("pinned") == Some(&json!(true))
            || input.get("archived") == Some(&json!(false))
            || input
                .get("title")
                .and_then(Value::as_str)
                .is_some_and(|s| !js_trim(s).is_empty());
        Ok(Self {
            fields,
            keep,
            done: done && now != 0,
        })
    }
    pub(crate) fn apply(&self, session: &Map<String, Value>) -> Map<String, Value> {
        let mut next = session.clone();
        for (field, value) in &self.fields {
            if value == false || value.as_str() == Some("") {
                next.shift_remove(field);
            } else {
                next.insert(field.clone(), value.clone());
            }
        }
        // Same condition as runtime.cjs keepRunChat/withRunChatsHidden. This does
        // not create routine metadata or make non-Run Chats into Run Chats.
        if self.keep
            && next
                .get("routine")
                .and_then(|r| r.get("runId"))
                .is_some_and(Value::is_string)
        {
            if let Some(routine) = next.get_mut("routine").and_then(Value::as_object_mut) {
                if routine.get("hidden") != Some(&json!(false)) {
                    routine.insert("hidden".into(), json!(false));
                }
            }
        }
        next
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};
    #[test]
    fn metadata_results_and_done_callbacks_match_actual_node_handlers() {
        let scope = "/synthetic/dedicated";
        let seed = json!({"next_id":20,"sessions":{"1":{"id":1,"unread":true,"routine":{"runId":"run-a","hidden":true},"summary":{"count":2,"lastAt":7}},"2":{"id":2,"routine":{"runId":"run-b"}}},"messages":[{"id":10,"session_id":1,"body":"retained"}]});
        let patches = vec![
            json!({"title":"New name"}),
            json!({"title":""}),
            json!({"unread":false}),
            json!({"done":true,"unread":false}),
            json!({"done":false}),
            json!({"pinned":true,"pin_order":-1.25}),
            json!({"pinned":false,"pin_order":0}),
            json!({"archived":false}),
            json!({"title":"\u{feff} \n"}),
            json!({"title":"\u{85}"}),
            json!({"kept":true}),
            json!({"done":true}),
            json!({"title":"Unicode 😀"}),
            json!({"unread":true}),
        ];
        let operations:Vec<Value>=patches.into_iter().enumerate().map(|(i,patch)|json!({"id":if i==8||i==9||i==10{2}else{1},"now":if i==11{0}else{1000+i as i64},"patch":patch})).collect();
        let mut node = Command::new("node")
            .arg(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("fixtures/chat-patch-node.cjs"),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        serde_json::to_writer(
            node.stdin.as_mut().unwrap(),
            &json!({"scope":scope,"state":seed,"operations":operations}),
        )
        .unwrap();
        node.stdin.take();
        let output = node.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let oracle: Value = serde_json::from_slice(&output.stdout).unwrap();
        let mut state = seed;
        let mut done = Vec::new();
        for (i, operation) in operations.iter().enumerate() {
            let patch =
                Patch::parse(&operation["patch"], operation["now"].as_i64().unwrap()).unwrap();
            let id = operation["id"].as_u64().unwrap().to_string();
            if patch.done {
                done.push(format!("{scope}#{id}"));
            }
            let old = state["sessions"][&id].as_object().unwrap();
            state["sessions"][&id] = Value::Object(patch.apply(old));
            assert_eq!(
                jsjson::to_string(&json!({"state":state,"done":done})),
                jsjson::to_string(&oracle["observations"][i]),
                "step{i}"
            );
        }
        assert_eq!(
            state["messages"],
            json!([{"id":10,"session_id":1,"body":"retained"}])
        );
        assert_eq!(state["sessions"]["1"]["summary"]["lastAt"], 7);
    }
    #[test]
    fn unsupported_fields_and_invalid_shapes_refuse_before_application() {
        for value in [
            json!({}),
            json!(null),
            json!({"done_at":123}),
            json!({"archived":true}),
            json!({"kept":false}),
            json!({"title":null}),
            json!({"pin_order":null}),
            json!({"model":"foreign"}),
            json!({"unread":true,"cwd":"/foreign"}),
            json!({"title":"a".repeat(16_385)}),
        ] {
            assert!(Patch::parse(&value, 100).is_err(), "{value}");
        }
    }
}

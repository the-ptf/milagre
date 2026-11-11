//! Runtime conformance: every trace of fixtures/runtime-traces.json runs through the real Node ProjectStates under
//! mocked timers (fixtures/runtime-node.cjs) and through the Rust `ProjectStates` on a clock the test moves, from the
//! same seeded Project. Each step's answer (the state's message ids, unloaded Chats, save status and a hash of the
//! whole state; message patches; save and unload events; read command results; disk snapshots) must match.

mod common;

use std::path::{Path, PathBuf};

use milagre_owner_store::isolation::{Isolation, Policy};
use milagre_owner_store::jsjson::{self, strict_equals};
use milagre_owner_store::message_store::{Msg, ProjectState};
use milagre_owner_store::states::{Event, ProjectStates, Timing};
use serde_json::{json, Map, Value};

fn scope(project: &Path) -> Value {
    Value::String(project.display().to_string())
}

fn change(state: &ProjectState, spec: &Value) -> Option<ProjectState> {
    let list = state.message_list();
    match spec["kind"].as_str().unwrap() {
        "none" => None,
        "append" => {
            let mut next = list.to_vec();
            next.extend(
                spec["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .cloned()
                    .map(Msg::new),
            );
            Some(state.with_messages(next))
        }
        "edit" => Some(
            state.with_messages(
                list.iter()
                    .map(|message| {
                        if message
                            .get("id")
                            .is_some_and(|id| strict_equals(id, &spec["id"]))
                        {
                            let mut fields = message.value().as_object().unwrap().clone();
                            for (key, value) in spec["patch"].as_object().unwrap() {
                                fields.insert(key.clone(), value.clone());
                            }
                            Msg::new(Value::Object(fields))
                        } else {
                            message.clone()
                        }
                    })
                    .collect(),
            ),
        ),
        "remove" => {
            let ids = spec["ids"].as_array().unwrap();
            Some(
                state.with_messages(
                    list.iter()
                        .filter(|message| {
                            !ids.iter().any(|id| {
                                message
                                    .get("id")
                                    .is_some_and(|known| strict_equals(known, id))
                            })
                        })
                        .cloned()
                        .collect(),
                ),
            )
        }
        "session" => {
            let mut sessions = state.sessions().cloned().unwrap_or_default();
            let id = spec["id"].as_str().unwrap().to_string();
            if spec["value"].is_null() {
                sessions.shift_remove(&id);
            } else {
                sessions.insert(id, spec["value"].clone());
            }
            Some(state.with_field("sessions", Value::Object(sessions)))
        }
        "field" => Some(state.with_field(spec["key"].as_str().unwrap(), spec["value"].clone())),
        other => panic!("unknown change {other}"),
    }
}

struct Run {
    isolation: Isolation,
    project: PathBuf,
    states: ProjectStates,
}

impl Run {
    fn clean(&self, text: &str) -> String {
        common::normalize(text, &self.project)
    }

    /// Save errors name the folder: compare them with it replaced.
    fn clean_value(&self, value: Value) -> Value {
        if value.is_null() {
            return value;
        }
        jsjson::parse(&self.clean(&jsjson::to_string(&value))).unwrap()
    }

    fn view(&self, state: Option<&ProjectState>) -> Map<String, Value> {
        let mut out = Map::new();
        let ids: Vec<Value> = state
            .map(|state| {
                state
                    .message_list()
                    .iter()
                    .map(|m| m.get("id").cloned().unwrap_or(Value::Null))
                    .collect()
            })
            .unwrap_or_default();
        out.insert("ids".into(), Value::Array(ids));
        out.insert(
            "unloaded".into(),
            json!(state
                .map(|state| state.unloaded.iter().copied().collect::<Vec<_>>())
                .unwrap_or_default()),
        );
        let persistence = state
            .and_then(|state| state.rest.get("persistence").cloned())
            .unwrap_or(Value::Null);
        out.insert("persistence".into(), self.clean_value(persistence));
        let text = state
            .map(|state| jsjson::to_string(&state.to_value()))
            .unwrap_or_else(|| "undefined".into());
        out.insert(
            "hash".into(),
            Value::String(common::sha256(&self.clean(&text))),
        );
        out
    }

    fn events(&mut self) -> Value {
        let events = self.states.take_events();
        Value::Array(
            events
                .into_iter()
                .map(|event| match event {
                    Event::Saved { report, .. } => json!({ "saved": report.to_value() }),
                    Event::SaveFailed { error, .. } => json!({ "failed": self.clean(&error) }),
                    Event::Persistence { persistence, .. } => json!({ "persistence": self.clean_value(persistence.unwrap_or(Value::Null)) }),
                    Event::Unloaded { .. } => json!({ "unloaded": true }),
                })
                .collect(),
        )
    }

    fn fresh(&mut self) {
        self.states =
            ProjectStates::new(self.isolation.clone(), Timing::default(), self.states.now());
    }

    fn attempt(&self, result: milagre_owner_store::Result<Value>) -> Value {
        result.unwrap_or_else(|error| json!({ "error": self.clean(&error.to_string()) }))
    }

    fn step(&mut self, step: &Value) -> Value {
        let project = self.project.clone();
        let p = project.as_path();
        match step["op"].as_str().unwrap() {
            "open" => {
                let state = self.states.get(p).unwrap();
                Value::Object(self.view(Some(&state)))
            }
            "load" => {
                let chats: Vec<i64> = step["chats"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(Value::as_i64)
                    .collect();
                let state = self.states.load(p, &chats).unwrap();
                Value::Object(self.view(Some(&state)))
            }
            "update" => {
                let previous = self.states.current(p);
                let chats: Option<Vec<i64>> = step.get("chats").map(|chats| {
                    chats
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter_map(Value::as_i64)
                        .collect()
                });
                let persist = step.get("persist").and_then(Value::as_bool).unwrap_or(true);
                let spec = step["change"].clone();
                match self
                    .states
                    .update(p, chats.as_deref(), persist, |state| change(state, &spec))
                {
                    Err(error) => json!({ "error": self.clean(&error.to_string()) }),
                    Ok((state, changed)) => {
                        let patch = ProjectStates::message_changes_from(previous.as_ref(), &state);
                        let changed_list: Vec<Value> = patch["changed"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|item| json!({ "id": item["message"]["id"], "after": item["after"], "hash": common::sha256(&jsjson::to_string(&item["message"])) }))
                            .collect();
                        let mut out = Map::new();
                        out.insert("changed".into(), Value::Bool(changed));
                        out.extend(self.view(Some(&state)));
                        out.insert(
                            "patch".into(),
                            json!({ "changed": changed_list, "removed": patch["removed"] }),
                        );
                        Value::Object(out)
                    }
                }
            }
            "advance" => {
                let to = self.states.now() + step["ms"].as_i64().unwrap();
                self.states.advance(to);
                let mut out = Map::new();
                out.insert("events".into(), self.events());
                let current = self.states.current(p);
                out.extend(self.view(current.as_ref()));
                Value::Object(out)
            }
            "flush" => {
                let outcome = self.states.flush(Some(p)).map(|_| Value::Null);
                let result = self.attempt(outcome);
                json!({ "result": result, "events": self.events() })
            }
            "retry" => {
                let outcome = self.states.retry(p).map(|_| Value::Null);
                let result = self.attempt(outcome);
                let mut out = Map::new();
                out.insert("result".into(), result);
                out.insert("events".into(), self.events());
                let current = self.states.current(p);
                out.extend(self.view(current.as_ref()));
                Value::Object(out)
            }
            "busy" => {
                self.states
                    .set_busy(
                        p,
                        step["chat"].as_i64().unwrap(),
                        step["value"].as_bool().unwrap(),
                    )
                    .unwrap();
                Value::Null
            }
            "block" => {
                let file = p.join(".milagre/coordination.json");
                std::fs::rename(&file, p.join(".milagre/coordination.json.blocked")).unwrap();
                std::fs::create_dir(&file).unwrap();
                Value::Null
            }
            "unblock" => {
                let file = p.join(".milagre/coordination.json");
                std::fs::remove_dir(&file).unwrap();
                std::fs::rename(p.join(".milagre/coordination.json.blocked"), &file).unwrap();
                Value::Null
            }
            "crash" => {
                let now = self.states.now();
                let states = std::mem::replace(
                    &mut self.states,
                    ProjectStates::new(self.isolation.clone(), Timing::default(), now),
                );
                states.abandon().unwrap();
                Value::Null
            }
            "close" => {
                let outcome = self.states.close().map(|_| Value::Null);
                let failed = outcome.is_err();
                let result = self.attempt(outcome);
                let mut out = Map::new();
                out.insert("result".into(), result);
                out.insert("events".into(), self.events());
                if failed {
                    // Kept as Node keeps it: closed, dirty, its lock still held.
                    assert!(
                        p.join(".milagre/runtime.lock").is_dir(),
                        "a failed close released the lock"
                    );
                    let current = self.states.current(p);
                    out.extend(self.view(current.as_ref()));
                } else {
                    assert!(
                        !p.join(".milagre/runtime.lock").exists(),
                        "a successful close kept the lock"
                    );
                    self.fresh();
                }
                Value::Object(out)
            }
            // The read commands go through `call`, the boundary a wire server dispatches to, with the daemon's arguments.
            "chatMessages" => {
                let args = [
                    scope(p),
                    step["chat"].clone(),
                    step.get("options").cloned().unwrap_or(Value::Null),
                ];
                let result = self.states.call("chat:messages", &args);
                self.attempt(result)
            }
            "chatMessage" => {
                let result = self
                    .states
                    .call("chat:message", &[scope(p), step["id"].clone()]);
                self.attempt(result)
            }
            "allMessages" => {
                let with_state = step.get("withState") == Some(&Value::Bool(true));
                let options = json!({ "marks": step.get("marks") == Some(&Value::Bool(true)), "withState": with_state });
                let result = self
                    .states
                    .call("chat:all-messages", &[scope(p), options])
                    .map(|mut out| {
                        if with_state {
                            let hash =
                                common::sha256(&self.clean(&jsjson::to_string(&out["state"])));
                            out["state"] = Value::String(hash);
                        }
                        out
                    });
                self.attempt(result)
            }
            "search" => {
                let options =
                    json!({ "limit": step.get("limit").and_then(Value::as_u64).unwrap_or(200) });
                let result = self
                    .states
                    .call("chat:search", &[scope(p), step["query"].clone(), options]);
                self.attempt(result)
            }
            "subagent" => {
                let result = self.states.call(
                    "chat:subagent",
                    &[scope(p), step["chat"].clone(), step["agent"].clone()],
                );
                self.attempt(result)
            }
            "sendStatus" => {
                let result = self
                    .states
                    .call("chat:send-status", &[scope(p), step["id"].clone()]);
                self.attempt(result)
            }
            "inboxValue" => {
                let result = self.states.inbox(p);
                self.attempt(result)
            }
            "whole" => {
                let result = self.states.whole_state(p).map(|whole| {
                    let ids: Vec<Value> = whole["messages"].as_array().unwrap().iter().map(|m| m["id"].clone()).collect();
                    json!({ "ids": ids, "hash": common::sha256(&self.clean(&jsjson::to_string(&whole))) })
                });
                self.attempt(result)
            }
            "snapshot" => jsjson::parse(&common::snapshot(p)).unwrap(),
            other => panic!("unknown step {other}"),
        }
    }
}

#[test]
fn rust_runtime_matches_node_project_states() {
    if common::node().is_none() {
        return;
    }
    let traces_file = common::crate_dir().join("fixtures/runtime-traces.json");
    let driver = common::crate_dir().join("fixtures/runtime-node.cjs");
    let traces = jsjson::parse_bytes(&std::fs::read(&traces_file).unwrap()).unwrap();
    let mut failures = Vec::new();
    let mut compared = 0;
    for trace in traces.as_array().unwrap() {
        let name = trace["name"].as_str().unwrap();
        let base = tempfile::tempdir().unwrap();
        let seeded = base.path().join("seed/project");
        let node_dir = base.path().join("node/project");
        let node = |args: &[&str]| {
            let output = std::process::Command::new("node")
                .arg(&driver)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{name}: node {args:?}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            output.stdout
        };
        node(&[
            "seed",
            traces_file.to_str().unwrap(),
            name,
            seeded.to_str().unwrap(),
        ]);
        common::copy_tree(&seeded, &node_dir);
        let isolation = Isolation::create(&base.path().join("rust"), &Policy::system()).unwrap();
        let project = isolation.project(Path::new("project")).unwrap();
        common::copy_tree(&seeded, &project);
        let lines: Vec<Value> = String::from_utf8(node(&[
            "run",
            traces_file.to_str().unwrap(),
            name,
            node_dir.to_str().unwrap(),
        ]))
        .unwrap()
        .lines()
        .map(|line| jsjson::parse(line).unwrap())
        .collect();
        let steps = trace["steps"].as_array().unwrap();
        assert_eq!(
            lines.len(),
            steps.len(),
            "{name}: Node ran {} of {} steps",
            lines.len(),
            steps.len()
        );
        let start = trace["start"].as_i64().unwrap();
        let mut run = Run {
            states: ProjectStates::new(isolation.clone(), Timing::default(), start),
            isolation,
            project,
        };
        for (index, (step, node)) in steps.iter().zip(&lines).enumerate() {
            let rust = jsjson::to_string(&run.step(step));
            let expected =
                String::from_utf16(&jsjson::to_utf16(node["result"].as_str().unwrap())).unwrap();
            compared += 1;
            if rust != expected {
                let at = rust
                    .bytes()
                    .zip(expected.bytes())
                    .position(|(a, b)| a != b)
                    .unwrap_or(0);
                let from = at.saturating_sub(120);
                failures.push(format!(
                    "{name} step {index} ({}):\n  node: …{}\n  rust: …{}",
                    step["op"].as_str().unwrap(),
                    expected
                        .get(from..(at + 200).min(expected.len()))
                        .unwrap_or(&expected),
                    rust.get(from..(at + 200).min(rust.len())).unwrap_or(&rust)
                ));
            }
        }
        run.states.close().unwrap();
        assert!(
            !run.project.join(".milagre/runtime.lock").exists(),
            "{name}: lock left behind"
        );
    }
    assert!(
        failures.is_empty(),
        "{} of {compared} steps differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
    eprintln!("{compared} runtime trace steps match Node's ProjectStates");
}

#[test]
fn the_command_boundary_refuses_what_it_does_not_serve() {
    let base = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(&base.path().join("copies"), &Policy::default()).unwrap();
    let project = isolation.project(Path::new("p")).unwrap();
    std::fs::create_dir_all(project.join(".milagre")).unwrap();
    std::fs::write(
        project.join(".milagre/coordination.json"),
        r#"{"next_id":1,"sessions":{},"messages":[]}"#,
    )
    .unwrap();
    let mut states = ProjectStates::new(isolation, Timing::default(), 0);
    // Not open yet: refused like the daemon refuses a Project it hasn't opened.
    let error = states
        .call("chat:search", &[scope(&project), json!("x")])
        .unwrap_err()
        .to_string();
    assert_eq!(error, "Open the Project before reading its messages.");
    assert_eq!(
        states
            .call("chat:send-status", &[scope(&project), json!("x")])
            .unwrap_err()
            .to_string(),
        "Choose an open Chat and message identity."
    );
    states.get(&project).unwrap();
    assert_eq!(
        states
            .call("chat:search", &[scope(&project), json!("x")])
            .unwrap(),
        json!([])
    );
    assert_eq!(
        states
            .call("chat:send-status", &[scope(&project), json!("")])
            .unwrap_err()
            .to_string(),
        "Choose an open Chat and message identity."
    );
    assert!(states
        .call("project:delete", &[scope(&project)])
        .unwrap_err()
        .to_string()
        .contains("isn't served"));
    // A path outside the isolation is never opened, read or written.
    let outside = base.path().join("outside");
    assert!(states.get(&outside).is_err());
    assert!(!outside.exists());
    states.close().unwrap();
    assert!(!project.join(".milagre/runtime.lock").exists());
}

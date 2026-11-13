//! Writer conformance: every scenario of fixtures/writer-scenarios.json runs twice, once through the real Node writers
//! (fixtures/writer-node.cjs) and once through `OwnedProject` in an isolated copy. After every step both folders are
//! snapshotted by the same Node code (file modes and content hashes, every chats.db row with column types, and Node's
//! own read of the result) and the step's answer (save report, error, receipt) is compared. Any difference fails.

mod common;

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use milagre_owner_store::isolation::{Isolation, Policy};
use milagre_owner_store::jsjson::{self, strict_equals};
use milagre_owner_store::write::{ProjectStateWriter, SaveOptions};
use milagre_owner_store::{MessageRepository, OwnedProject, StoreError};
use serde_json::{json, Value};

fn normalize(message: &str, dir: &Path) -> String {
    let real = std::fs::canonicalize(dir).unwrap();
    let mut text = message
        .replace(&real.display().to_string(), "<project>")
        .replace(&dir.display().to_string(), "<project>");
    // coordination.json.<pid>.<n>.tmp
    let pattern = "coordination.json.";
    let mut out = String::new();
    while let Some(at) = text.find(pattern) {
        out.push_str(&text[..at + pattern.len()]);
        let rest = &text[at + pattern.len()..];
        let digits = |text: &str| text.bytes().take_while(u8::is_ascii_digit).count();
        let first = digits(rest);
        let second = if first > 0 && rest[first..].starts_with('.') {
            digits(&rest[first + 1..])
        } else {
            0
        };
        if second > 0 && rest[first + 1 + second..].starts_with(".tmp") {
            out.push_str("<tmp>");
            text = rest[first + 1 + second + 4..].to_string();
        } else {
            text = rest.to_string();
        }
    }
    out.push_str(&text);
    out
}

/// The state steps of writer-node.cjs `apply`, in Rust.
fn apply(state: &Value, step: &Value) -> Option<Value> {
    let mut state = state.clone();
    let messages = |state: &mut Value| -> Vec<Value> {
        state["messages"].as_array().cloned().unwrap_or_default()
    };
    match step["op"].as_str().unwrap() {
        "set" => return Some(step["state"].clone()),
        "append" => {
            let mut list = messages(&mut state);
            list.extend(step["messages"].as_array().unwrap().iter().cloned());
            state["messages"] = Value::Array(list);
        }
        "remove" => {
            let ids = step["ids"].as_array().unwrap();
            let list: Vec<Value> = messages(&mut state)
                .into_iter()
                .filter(|message| {
                    !ids.iter().any(|id| {
                        strict_equals(id, message.get("id").unwrap_or(&Value::Bool(false)))
                    })
                })
                .collect();
            state["messages"] = Value::Array(list);
        }
        "update" => {
            let list = messages(&mut state)
                .into_iter()
                .map(|message| {
                    if message
                        .get("id")
                        .is_some_and(|id| strict_equals(id, &step["id"]))
                    {
                        let mut fields = message.as_object().unwrap().clone();
                        for (key, value) in step["patch"].as_object().unwrap() {
                            fields.insert(key.clone(), value.clone());
                        }
                        Value::Object(fields)
                    } else {
                        message
                    }
                })
                .collect();
            state["messages"] = Value::Array(list);
        }
        "move" => {
            let mut list = messages(&mut state);
            let at = list
                .iter()
                .position(|message| {
                    message
                        .get("id")
                        .is_some_and(|id| strict_equals(id, &step["id"]))
                })
                .unwrap();
            let moving = list.remove(at);
            let to = (step["to"].as_u64().unwrap() as usize).min(list.len());
            list.insert(to, moving);
            state["messages"] = Value::Array(list);
        }
        "session" => {
            let sessions = state["sessions"].as_object_mut().unwrap();
            let id = step["id"].as_str().unwrap().to_string();
            if step["value"].is_null() {
                sessions.shift_remove(&id);
            } else {
                sessions.insert(id, step["value"].clone());
            }
        }
        "patch" => {
            state[step["key"].as_str().unwrap()] = step["value"].clone();
        }
        _ => return None,
    }
    Some(state)
}

struct RustRun {
    isolation: Isolation,
    project: PathBuf,
    owner: Option<OwnedProject>,
    state: Value,
}

impl RustRun {
    fn owner(&mut self) -> &mut OwnedProject {
        self.owner.as_mut().unwrap()
    }

    fn save(&mut self, step: &Value) -> Result<Value, StoreError> {
        let unloaded: BTreeSet<i64> = step
            .get("unloaded")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_i64)
            .collect();
        let mut saving = self.state.clone();
        if !unloaded.is_empty() {
            let kept: Vec<Value> = saving["messages"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|message| {
                    !message
                        .get("session_id")
                        .and_then(Value::as_i64)
                        .is_some_and(|chat| unloaded.contains(&chat))
                })
                .cloned()
                .collect();
            saving["messages"] = Value::Array(kept);
        }
        let options = SaveOptions {
            durable: step
                .get("durable")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            unloaded,
            sweep_min_age: Duration::ZERO,
            now: None,
        };
        self.owner()
            .save_project_state(&saving, &options)
            .map(|report| report.to_value())
    }

    /// writer-node.cjs `settle`: carry the saved (compacted) messages forward.
    fn settle(&mut self) {
        let Some(saved) = self.owner.as_ref().unwrap().saved_rows() else {
            return;
        };
        if let Some(Value::Array(messages)) = self.state.get("messages") {
            let carried = messages
                .iter()
                .map(|message| {
                    let key = jsjson::to_string(message.get("id").unwrap_or(&Value::Null));
                    saved
                        .get(&key)
                        .map(|row| row.message.clone())
                        .unwrap_or_else(|| message.clone())
                })
                .collect();
            self.state["messages"] = Value::Array(carried);
        }
    }

    fn step(&mut self, step: &Value) -> Value {
        if let Some(next) = apply(&self.state, step) {
            self.state = next;
            return Value::Null;
        }
        let file = self.project.join(".milagre/coordination.json");
        match step["op"].as_str().unwrap() {
            "save" => {
                let report = self
                    .save(step)
                    .unwrap_or_else(|error| panic!("Rust save failed: {error}"));
                self.settle();
                report
            }
            "saveExpectFail" => match self.save(step) {
                Ok(_) => json!({ "unexpected": "saved" }),
                Err(error) => json!({ "error": normalize(&error.to_string(), &self.project) }),
            },
            "saveCrashBeforeRename" => {
                let before = std::fs::read(&file).ok();
                let report = self.save(step).unwrap();
                let written = std::fs::read(&file).unwrap();
                match before {
                    Some(bytes) => std::fs::write(&file, bytes).unwrap(),
                    None => std::fs::remove_file(&file).unwrap(),
                }
                std::fs::write(
                    self.project.join(".milagre/coordination.json.99999.1.tmp"),
                    written,
                )
                .unwrap();
                report
            }
            "read" => {
                self.state = self.owner().load().unwrap().state;
                Value::Null
            }
            "restart" => {
                self.owner.take().unwrap().release().unwrap();
                self.owner =
                    Some(OwnedProject::open(&self.isolation, &self.project, None).unwrap());
                Value::Null
            }
            "blockState" => {
                std::fs::rename(
                    &file,
                    self.project.join(".milagre/coordination.json.blocked"),
                )
                .unwrap();
                std::fs::create_dir(&file).unwrap();
                Value::Null
            }
            "unblockState" => {
                std::fs::remove_dir(&file).unwrap();
                std::fs::rename(
                    self.project.join(".milagre/coordination.json.blocked"),
                    &file,
                )
                .unwrap();
                Value::Null
            }
            "sendStatus" => self
                .owner()
                .send_status(step["clientMessageId"].as_str().unwrap())
                .unwrap(),
            "hotJournal" => {
                common::run_node(&["crash-mid-transaction", self.project.to_str().unwrap()]);
                Value::Null
            }
            other => panic!("unknown step {other}"),
        }
    }
}

#[test]
fn rust_writes_what_node_writes() {
    if common::node().is_none() {
        return;
    }
    let scenarios_file = common::crate_dir().join("fixtures/writer-scenarios.json");
    let scenarios = jsjson::parse_bytes(&std::fs::read(&scenarios_file).unwrap()).unwrap();
    let mut compared = 0;
    let mut failures = Vec::new();
    for scenario in scenarios.as_array().unwrap() {
        let name = scenario["name"].as_str().unwrap();
        let base = tempfile::tempdir().unwrap();
        let node_dir = base.path().join("node/project");
        std::fs::create_dir_all(&node_dir).unwrap();
        let isolation = Isolation::create(&base.path().join("rust"), &Policy::system()).unwrap();
        let project = isolation.project(Path::new("project")).unwrap();
        if let Some(setup) = scenario.get("setup").and_then(Value::as_str) {
            let source = common::crate_dir().join("fixtures/.projects").join(setup);
            common::copy_tree(&source, &node_dir);
            common::copy_tree(&source, &project);
        }
        let output = common::run_node(&[
            "run",
            scenarios_file.to_str().unwrap(),
            name,
            node_dir.to_str().unwrap(),
        ]);
        let node_lines: Vec<Value> = String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .map(|line| jsjson::parse(line).unwrap())
            .collect();
        let steps = scenario["steps"].as_array().unwrap();
        assert_eq!(
            node_lines.len(),
            steps.len(),
            "{name}: Node ran {} of {} steps",
            node_lines.len(),
            steps.len()
        );
        let owner = OwnedProject::open(&isolation, &project, None).unwrap();
        let mut run = RustRun {
            isolation: isolation.clone(),
            project: project.clone(),
            owner: Some(owner),
            state: Value::Null,
        };
        let mut previous = common::snapshot(&project);
        let mut before_crash: Option<Value> = None;
        for (index, (step, node)) in steps.iter().zip(&node_lines).enumerate() {
            let op = step["op"].as_str().unwrap();
            let result = jsjson::to_string(&run.step(step));
            let snapshot = common::snapshot(&project);
            // A save SQLite refused rolled back: nothing on disk moved.
            if name == "rollback" && op == "saveExpectFail" {
                assert_eq!(
                    snapshot, previous,
                    "{name} step {index}: a failed save changed the disk"
                );
            }
            // A transaction killed mid-way is rolled back by the owner's next open: the rows from before it.
            if op == "hotJournal" {
                before_crash = Some(jsjson::parse(&previous).unwrap()["rows"].clone());
                assert_eq!(
                    jsjson::parse(&snapshot).unwrap()["rows"],
                    json!("hot journal")
                );
                let error = milagre_owner_store::ProjectStore::new(&project)
                    .chats()
                    .read_rows()
                    .unwrap_err();
                assert!(
                    matches!(error, StoreError::HotJournal(_)),
                    "the read-only reader must refuse a hot journal"
                );
            }
            if op == "read" {
                if let Some(rows) = before_crash.take() {
                    assert_eq!(
                        jsjson::parse(&snapshot).unwrap()["rows"],
                        rows,
                        "{name}: recovery lost or kept torn rows"
                    );
                }
            }
            previous = snapshot.clone();
            // The recorded strings are JSON text whose unpaired surrogates are escaped, so they decode to plain text.
            let decode = |value: &Value| {
                String::from_utf16(&jsjson::to_utf16(value.as_str().unwrap())).unwrap()
            };
            let label = format!("{name} step {index} ({})", step["op"].as_str().unwrap());
            compared += 1;
            if result != decode(&node["result"]) {
                failures.push(format!(
                    "{label}: answer\n  node: {}\n  rust: {result}",
                    decode(&node["result"])
                ));
            }
            let node_snapshot = decode(&node["snapshot"]);
            if snapshot != node_snapshot {
                let (a, b): (Value, Value) = (
                    jsjson::parse(&node_snapshot).unwrap(),
                    jsjson::parse(&snapshot).unwrap(),
                );
                let mut detail = Vec::new();
                for key in ["files", "rows", "read"] {
                    if a[key] != b[key] {
                        let (x, y) = (jsjson::to_string(&a[key]), jsjson::to_string(&b[key]));
                        let at = x
                            .bytes()
                            .zip(y.bytes())
                            .position(|(p, q)| p != q)
                            .unwrap_or(0);
                        let from = at.saturating_sub(150);
                        detail.push(format!(
                            "  {key}:\n    node: …{}\n    rust: …{}",
                            x.get(from..(at + 250).min(x.len())).unwrap_or(&x),
                            y.get(from..(at + 250).min(y.len())).unwrap_or(&y)
                        ));
                    }
                }
                failures.push(format!("{label}: disk differs\n{}", detail.join("\n")));
            }
        }
        run.owner.take().unwrap().release().unwrap();
        assert!(
            !project.join(".milagre/runtime.lock").exists(),
            "{name}: lock left behind"
        );
    }
    assert!(
        failures.is_empty(),
        "{} of {compared} steps differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
    eprintln!("{compared} scenario steps: Rust answers and disk match Node");
}

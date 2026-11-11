//! Replays tests/fixtures/conformance.json, recorded from packages/core/src/terminals.cjs by
//! scripts/generate-conformance.cjs, against the Rust owner: every command result, error message, PTY call and event,
//! plus shell discovery, the shell environment and UTF-8 decoding.

mod common;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::{resolver, worktree, Events, FakeSpawner};
use milagre_terminals::shell::{terminal_environment, terminal_shell, terminal_shells, ShellOption, ShellProbe};
use milagre_terminals::utf8::Utf8Stream;
use milagre_terminals::wire::{self, CommandContext};
use milagre_terminals::{Limits, ShellCommand, TerminalEvent, Terminals, TerminalsOptions};
use serde_json::{json, Value};

fn fixture() -> Value {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/conformance.json")).unwrap();
    expand(serde_json::from_str(&text).unwrap())
}

/// Undoes the generator's `{ "$runs": [[text, count], ...] }` compaction.
fn expand(value: Value) -> Value {
    match value {
        Value::Object(map) if map.len() == 1 && map.contains_key("$runs") => {
            let mut text = String::new();
            for run in map["$runs"].as_array().unwrap() {
                text.push_str(&run[0].as_str().unwrap().repeat(run[1].as_u64().unwrap() as usize));
            }
            Value::String(text)
        }
        Value::Object(map) => Value::Object(map.into_iter().map(|(k, v)| (k, expand(v))).collect()),
        Value::Array(items) => Value::Array(items.into_iter().map(expand).collect()),
        other => other,
    }
}

struct Scenario {
    _base: tempfile::TempDir,
    folders: Vec<(&'static str, String)>,
    base: String,
    ids: Vec<String>,
}

impl Scenario {
    fn tokenize(&self, value: &Value) -> Value {
        let mut text = value.to_string();
        for (index, id) in self.ids.iter().enumerate() {
            text = text.replace(id.as_str(), &format!("$T{index}"));
        }
        for (token, folder) in &self.folders {
            text = text.replace(&json_inner(folder), token);
        }
        text = text.replace(&json_inner(&self.base), "$BASE");
        serde_json::from_str(&text).unwrap()
    }

    fn untokenize(&self, value: &Value) -> Value {
        let mut text = value.to_string();
        for (index, id) in self.ids.iter().enumerate() {
            text = text.replace(&format!("\"$T{index}\""), &Value::String(id.clone()).to_string());
        }
        for (token, folder) in &self.folders {
            text = text.replace(token, &json_inner(folder));
        }
        serde_json::from_str(&text).unwrap()
    }
}

fn json_inner(text: &str) -> String {
    let quoted = Value::String(text.to_owned()).to_string();
    quoted[1..quoted.len() - 1].to_owned()
}

fn event_json(event: &TerminalEvent) -> Option<Value> {
    match event {
        TerminalEvent::Changed { chat_id } => Some(json!(["changed", chat_id])),
        TerminalEvent::ShellsChanged => Some(json!(["shells"])),
        TerminalEvent::PreferencesChanged => Some(json!(["preferences"])),
        TerminalEvent::Exited { .. } => None,
    }
}

async fn run_scenario(scenario: &Value) {
    let name = scenario["name"].as_str().unwrap();
    let options = &scenario["options"];
    let base_dir = tempfile::tempdir().unwrap();
    let base = base_dir.path().canonicalize().unwrap();
    let folder = |name: &str| base.join(name);
    for name in ["first", "second", "outside"] {
        std::fs::create_dir(folder(name)).unwrap();
    }
    let mut chats = HashMap::new();
    chats.insert("/p#1".to_owned(), vec![worktree(&folder("first"), Some("one"))]);
    chats.insert("link:abc#2".to_owned(), vec![worktree(&folder("first"), Some("api")), worktree(&folder("second"), Some("web"))]);
    chats.insert("link:abc#3".to_owned(), vec![worktree(&folder("second"), None)]);
    chats.insert("/p#empty".to_owned(), vec![]);
    chats.insert("/p#gone".to_owned(), vec![worktree(&folder("missing"), Some("gone"))]);
    let resolve = resolver(chats);

    let available: Arc<Mutex<Vec<ShellOption>>> = Arc::new(Mutex::new(match options.get("availableShells") {
        Some(list) => serde_json::from_value(list.clone()).unwrap(),
        None => vec![ShellOption { file: "/bin/zsh".into(), label: "zsh".into() }],
    }));
    let shell: ShellCommand = match options.get("shell") {
        Some(shell) => serde_json::from_value(shell.clone()).unwrap(),
        None => ShellCommand { file: "/bin/zsh".into(), args: vec!["-l".into()] },
    };
    let settings_file = options.get("settings").map(|_| base.join("data").join("terminal-settings.json"));
    let spawner = Arc::new(FakeSpawner::default());
    let events = Events::default();
    let mut limits = Limits { read_wait: Duration::from_millis(20), title_poll: Duration::from_secs(3600), ..Limits::default() };
    let limit = |key: &str| options.get(key).and_then(Value::as_u64).map(|n| n as usize);
    if let Some(n) = limit("maxBufferChars") {
        limits.max_buffer_chars = n;
    }
    if let Some(n) = limit("maxBufferLines") {
        limits.max_buffer_lines = n;
    }
    if let Some(n) = limit("maxPerChat") {
        limits.max_per_chat = n;
    }
    if let Some(n) = limit("maxTotal") {
        limits.max_total = n;
    }
    let make = || {
        let mut o = TerminalsOptions::new(resolve.clone());
        o.spawner = spawner.clone();
        let shell = shell.clone();
        o.shell = Arc::new(move || shell.clone());
        let available = available.clone();
        o.available_shells = Arc::new(move || available.lock().unwrap().clone());
        o.environment = Arc::new(|| {
            BTreeMap::from([("TERM".to_owned(), "xterm-256color".to_owned()), ("PATH".to_owned(), "/usr/bin:/bin".to_owned())])
        });
        o.settings_file = settings_file.clone();
        o.on_event = events.sink();
        o.limits = limits.clone();
        o.now = Arc::new(|| 1000);
        Terminals::new(o).unwrap()
    };
    let mut terminals = make();
    let mut state = Scenario {
        folders: vec![
            ("$FIRST", folder("first").to_string_lossy().into_owned()),
            ("$SECOND", folder("second").to_string_lossy().into_owned()),
            ("$OUTSIDE", folder("outside").to_string_lossy().into_owned()),
        ],
        base: base.to_string_lossy().into_owned(),
        ids: vec![],
        _base: base_dir,
    };
    let context = CommandContext { client_id: Some("conformance".into()) };
    let ops = scenario["ops"].as_array().unwrap();
    let expected = scenario["results"].as_array().unwrap();
    assert_eq!(ops.len(), expected.len());
    for (index, (op, expected)) in ops.iter().zip(expected).enumerate() {
        events.take();
        let pty = || spawner.pty(op["pty"].as_u64().unwrap() as usize);
        let result: Option<Value> = match op["op"].as_str().unwrap() {
            "call" => {
                let command = op["command"].as_str().unwrap();
                let request = state.untokenize(op.get("request").unwrap_or(&Value::Null));
                Some(match wire::handle(&terminals, command, &request, &context).await {
                    Ok(value) => {
                        if command == "terminal:open" {
                            state.ids.push(value["id"].as_str().unwrap().to_owned());
                        }
                        json!({ "ok": state.tokenize(&value) })
                    }
                    Err(error) => json!({ "error": state.tokenize(&Value::String(error.0)) }),
                })
            }
            "emit" => {
                pty().emit(op["text"].as_str().unwrap());
                None
            }
            "exit" => {
                pty().exit();
                None
            }
            "process" => {
                pty().set_process(op["name"].as_str().unwrap());
                None
            }
            "closeChat" => {
                terminals.close_chat(op["chat"].as_str().unwrap());
                None
            }
            "shells" => Some(json!({ "ok": terminals.shells() })),
            "dispose" => {
                terminals.dispose(Duration::from_secs(1)).await;
                None
            }
            "removeShells" => {
                available.lock().unwrap().clear();
                None
            }
            "restart" => {
                terminals.dispose(Duration::from_secs(1)).await;
                terminals = make();
                None
            }
            "settings" => {
                let text = std::fs::read_to_string(settings_file.as_ref().unwrap()).unwrap();
                Some(json!({ "ok": serde_json::from_str::<Value>(&text).unwrap() }))
            }
            "state" => {
                let pty = pty();
                let r = &pty.request;
                Some(json!({ "ok": state.tokenize(&json!({
                    "file": r.file, "args": r.args, "cwd": r.cwd.to_string_lossy(), "cols": r.cols, "rows": r.rows, "name": r.name,
                    "env": r.env, "written": pty.written(), "sizes": pty.sizes().iter().map(|(c, r)| json!([c, r])).collect::<Vec<_>>(),
                    "killed": pty.killed(),
                })) }))
            }
            other => panic!("unknown op {other}"),
        };
        let got_events: Vec<Value> = events.take().iter().filter_map(event_json).collect();
        let got = json!({ "result": result, "events": state.tokenize(&Value::Array(got_events)) });
        assert_eq!(got, *expected, "scenario {name:?}, op {index}: {op}");
    }
    terminals.dispose(Duration::from_secs(1)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn owner_matches_node() {
    let fixture = fixture();
    let scenarios = fixture["owner"].as_array().unwrap();
    assert!(scenarios.len() >= 17);
    for scenario in scenarios {
        run_scenario(scenario).await;
    }
}

fn probe(input: &Value) -> ShellProbe {
    let platform = serde_json::from_value(match input["platform"].as_str().unwrap() {
        "darwin" | "linux" | "win32" => input["platform"].clone(),
        _ => json!("other"),
    })
    .unwrap();
    let env: HashMap<String, String> = serde_json::from_value(input["env"].clone()).unwrap();
    let files: HashSet<String> = serde_json::from_value(input["exists"].clone()).unwrap();
    let user_shell = input.get("userShell").cloned().unwrap_or(Value::Null);
    let read_shells = input.get("readShells").cloned().unwrap_or(json!(""));
    let realpath: HashMap<String, String> = input.get("realpath").map(|m| serde_json::from_value(m.clone()).unwrap()).unwrap_or_default();
    ShellProbe {
        platform,
        env,
        exists: Arc::new(move |file| files.contains(file)),
        user_shell: Arc::new(move || user_shell.as_str().map(str::to_owned)),
        read_shells: Arc::new(move || read_shells.as_str().map(str::to_owned)),
        realpath: Arc::new(move |file| Some(realpath.get(file).cloned().unwrap_or_else(|| file.to_owned()))),
    }
}

#[test]
fn shell_discovery_matches_node() {
    let fixture = fixture();
    for case in fixture["shells"].as_array().unwrap() {
        let probe = probe(&case["input"]);
        assert_eq!(serde_json::to_value(terminal_shell(&probe)).unwrap(), case["shell"], "{}", case["input"]);
        assert_eq!(serde_json::to_value(terminal_shells(&probe)).unwrap(), case["shells"], "{}", case["input"]);
    }
}

#[test]
fn environment_matches_node() {
    let fixture = fixture();
    assert_eq!(fixture["hostPlatform"] == "win32", cfg!(windows), "the fixture's LANG rule follows its host");
    for case in fixture["environment"].as_array().unwrap() {
        let env: BTreeMap<String, String> = serde_json::from_value(case["input"].clone()).unwrap();
        let expected: BTreeMap<String, String> = serde_json::from_value(case["output"].clone()).unwrap();
        assert_eq!(terminal_environment(env, cfg!(windows)), expected, "{}", case["input"]);
    }
}

#[test]
fn utf8_decoding_matches_node_string_decoder() {
    let fixture = fixture();
    for case in fixture["decoder"].as_array().unwrap() {
        let mut decoder = Utf8Stream::new();
        let chunks: Vec<Vec<u8>> = serde_json::from_value(case["chunks"].clone()).unwrap();
        let outputs: Vec<String> = chunks.iter().map(|chunk| decoder.decode(chunk)).collect();
        assert_eq!(json!(outputs), case["outputs"], "{}", case["chunks"]);
        assert_eq!(json!(decoder.finish()), case["end"], "{}", case["chunks"]);
    }
}

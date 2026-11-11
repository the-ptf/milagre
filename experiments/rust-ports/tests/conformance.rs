//! Replays tests/fixtures/conformance.json, recorded from packages/core/src/agents/ports.cjs by
//! scripts/generate-conformance.cjs: listings, ownership, every watcher command/signal/publish, and the exact
//! PowerShell invocations Windows uses.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use milagre_ports::exec::{powershell_environment, windows_invocation, windows_script};
use milagre_ports::{
    chat_ports, chat_processes, parse_lsof, parse_ps, parse_task_outputs, ChatPorts, Groups, PortWatcher, PortWatcherOptions, Roots, Signal,
};
use serde_json::{json, Value};

fn fixture() -> Value {
    serde_json::from_str(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/conformance.json")).unwrap())
        .unwrap()
}

fn sorted_groups(groups: &Groups) -> Value {
    let mut out = serde_json::Map::new();
    let mut chats: Vec<_> = groups.keys().collect();
    chats.sort();
    for chat in chats {
        let mut pids: Vec<i64> = groups[chat].iter().copied().collect();
        pids.sort_unstable();
        out.insert(chat.clone(), json!(pids));
    }
    Value::Object(out)
}

fn roots(value: &Value) -> Roots {
    serde_json::from_value(value.clone()).unwrap()
}

#[test]
fn listings_parse_as_in_node() {
    let fixture = fixture();
    for case in fixture["ps"].as_array().unwrap() {
        assert_eq!(serde_json::to_value(parse_ps(case["input"].as_str().unwrap())).unwrap(), case["rows"], "{}", case["input"]);
    }
    for case in fixture["lsof"].as_array().unwrap() {
        assert_eq!(serde_json::to_value(parse_lsof(case["input"].as_str().unwrap())).unwrap(), case["rows"], "{}", case["input"]);
    }
    for case in fixture["tasks"].as_array().unwrap() {
        let tasks: HashMap<String, String> =
            parse_task_outputs(case["input"].as_str().unwrap()).into_iter().map(|(k, v)| (k.to_string(), v)).collect();
        assert_eq!(serde_json::to_value(tasks).unwrap(), case["tasks"], "{}", case["input"]);
    }
}

#[test]
fn ownership_matches_node() {
    let fixture = fixture();
    for sequence in fixture["ownership"].as_array().unwrap() {
        let mut groups = Groups::new();
        for (index, (step, expected)) in
            sequence["steps"].as_array().unwrap().iter().zip(sequence["results"].as_array().unwrap()).enumerate()
        {
            let processes = parse_ps(step["ps"].as_str().unwrap());
            let by_chat = chat_processes(&processes, &roots(&step["roots"]), &mut groups);
            let pgid: HashMap<i64, i64> = processes.iter().map(|row| (row.pid, row.pgid)).collect();
            let tasks = parse_task_outputs(step.get("tasks").and_then(Value::as_str).unwrap_or(""));
            let ports = chat_ports(&parse_lsof(step["lsof"].as_str().unwrap()), &by_chat, |pid| {
                tasks.get(&pid).or_else(|| pgid.get(&pid).and_then(|g| tasks.get(g))).cloned()
            });
            let by_chat: serde_json::Map<String, Value> = by_chat
                .into_iter()
                .map(|(chat, pids)| {
                    let mut pids: Vec<i64> = pids.into_iter().collect();
                    pids.sort_unstable();
                    (chat, json!(pids))
                })
                .collect();
            let got = json!({ "byChat": by_chat, "groups": sorted_groups(&groups), "ports": ports });
            assert_eq!(got, *expected, "{} step {index}", sequence["name"]);
        }
    }
}

#[derive(Default)]
struct Script {
    state: serde_json::Map<String, Value>,
    calls: Vec<Value>,
    kills: Vec<Value>,
    trees: Vec<Value>,
    published: Vec<Value>,
}

impl Script {
    fn get(&self, key: &str) -> Value {
        self.state.get(key).cloned().unwrap_or(Value::Null)
    }
    fn die(&mut self) {
        self.state.insert("alive".into(), json!(false));
        if let Some(Value::Object(after)) = self.state.get("afterKill").cloned() {
            for (k, v) in after {
                self.state.insert(k, v);
            }
        }
    }
}

async fn run_watcher(scenario: &Value) {
    let name = scenario["name"].as_str().unwrap();
    let options = &scenario["options"];
    let script = Arc::new(Mutex::new(Script::default()));
    {
        let mut s = script.lock().unwrap();
        for (k, v) in json!({ "ps": "", "lsof": "", "tasks": "", "roots": {}, "now": 0, "alive": true, "termKills": true, "termFails": false, "afterKill": null })
            .as_object()
            .unwrap()
        {
            s.state.insert(k.clone(), v.clone());
        }
    }
    let s = script.clone();
    let roots_fn: Arc<dyn Fn() -> Roots + Send + Sync> = Arc::new(move || roots(&s.lock().unwrap().get("roots")));
    let s = script.clone();
    let publish: Arc<dyn Fn(&ChatPorts) + Send + Sync> =
        Arc::new(move |ports| s.lock().unwrap().published.push(serde_json::to_value(ports).unwrap()));
    let mut o = PortWatcherOptions::new(roots_fn, publish);
    o.windows = options.get("windows").and_then(Value::as_bool).unwrap_or(false);
    o.poll = std::time::Duration::from_secs(3600);
    o.idle_poll = std::time::Duration::from_secs(3600);
    o.grace = std::time::Duration::ZERO;
    o.lsof_max_age_ms = options.get("lsofMaxAgeMs").and_then(Value::as_i64).unwrap_or(10_000);
    let s = script.clone();
    o.now = Arc::new(move || s.lock().unwrap().get("now").as_i64().unwrap());
    let s = script.clone();
    o.exec = Arc::new(move |command: String, args: Vec<String>| {
        let s = s.clone();
        Box::pin(async move {
            let mut s = s.lock().unwrap();
            s.calls.push(json!([command, args]));
            let key = if command == "ps" {
                "ps"
            } else if args.iter().any(|a| a == "-d") {
                "tasks"
            } else {
                "lsof"
            };
            s.get(key).as_str().unwrap_or("").to_owned()
        })
    });
    let s = script.clone();
    o.kill = Arc::new(move |target, signal| {
        let mut s = s.lock().unwrap();
        s.kills.push(json!([target, signal.node_name()]));
        match signal {
            Signal::Term => {
                if s.get("termFails") == json!(true) {
                    return false;
                }
                if s.get("termKills") == json!(true) {
                    s.die();
                }
                true
            }
            Signal::Kill => {
                s.die();
                true
            }
            Signal::Probe => s.get("alive") == json!(true),
        }
    });
    let s = script.clone();
    o.stop_windows_tree = Some(Arc::new(move |pid, started| {
        let mut guard = s.lock().unwrap();
        guard.trees.push(json!([pid, started]));
        guard.die();
        Box::pin(async { true })
    }));
    let s = script.clone();
    o.identity = Arc::new(move |pid| {
        parse_ps(s.lock().unwrap().get("ps").as_str().unwrap_or(""))
            .into_iter()
            .find(|row| row.pid == pid)
            .map(|row| milagre_ports::ProcessIdentity { ppid: row.ppid, pgid: row.pgid, started_at: format!("fixture-{pid}") })
    });
    let watcher = PortWatcher::new(o);
    for (index, (step, expected)) in scenario["steps"].as_array().unwrap().iter().zip(scenario["results"].as_array().unwrap()).enumerate() {
        {
            let mut s = script.lock().unwrap();
            s.calls.clear();
            s.kills.clear();
            s.trees.clear();
            s.published.clear();
            if let Some(Value::Object(set)) = step.get("set") {
                for (k, v) in set {
                    s.state.insert(k.clone(), v.clone());
                }
            }
        }
        let mut result = Value::Null;
        if let Some(fresh) = step.get("poll") {
            watcher.poll(fresh.as_bool().unwrap()).await;
        }
        if let Some(stop) = step.get("stop") {
            result = json!(watcher.stop_port(stop[0].as_str().unwrap(), stop[1].as_i64().unwrap()).await);
        }
        if step.get("close").is_some() {
            watcher.close();
        }
        let s = script.lock().unwrap();
        let got = json!({
            "calls": s.calls, "kills": s.kills, "trees": s.trees, "published": s.published,
            "snapshot": watcher.snapshot(), "groups": sorted_groups(&watcher.groups()), "result": result,
        });
        let mut expected = expected.clone();
        // Intentional correction to Node: every accepted Unix stop first bypasses the listener cache.
        // These scenarios have unchanged listings before Stop, so the first poll is the exact expected prefix.
        if !options.get("windows").and_then(Value::as_bool).unwrap_or(false)
            && step.get("stop").is_some()
            && !expected["kills"].as_array().unwrap().is_empty()
        {
            let mut calls = scenario["results"][1]["calls"].as_array().unwrap().clone();
            calls.extend(expected["calls"].as_array().unwrap().clone());
            expected["calls"] = json!(calls);
            // In this case afterKill removed both listener and leader. No signal 0 against a dead identity.
            if name == "stopping a port stops its command's group, and only a listed pid" {
                expected["kills"] = json!([[-110, "SIGTERM"]]);
            }
        }
        assert_eq!(got, expected, "{name}, step {index}: {step}");
    }
    watcher.close();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_watcher_matches_node() {
    let fixture = fixture();
    let scenarios = fixture["watcher"].as_array().unwrap();
    assert!(scenarios.len() >= 12);
    for scenario in scenarios {
        run_watcher(scenario).await;
    }
}

#[test]
fn windows_commands_match_node() {
    let fixture = fixture();
    for case in fixture["windowsCommands"].as_array().unwrap() {
        let args: Vec<String> = serde_json::from_value(case["args"].clone()).unwrap();
        let root = case["systemRoot"].as_str();
        let started: Vec<Value> = match windows_script(case["command"].as_str().unwrap(), &args) {
            Some(script) => {
                let (file, args) = windows_invocation(&script, root);
                let env = powershell_environment([("PSModulePath".to_owned(), "C:\\user".to_owned())], root);
                let module_path = env.iter().find(|(k, _)| k == "PSModulePath").map(|(_, v)| v.clone());
                vec![json!({ "file": file, "args": args, "psModulePath": module_path, "maxBuffer": 8 * 1024 * 1024, "timeout": 10_000 })]
            }
            None => vec![],
        };
        assert_eq!(json!(started), case["started"], "{}", case["args"]);
    }
}

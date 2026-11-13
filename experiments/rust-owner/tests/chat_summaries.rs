//! `summarize_chat` against Node's own `summarizeChat` (packages/shared/src/chat-summary.mjs) over the same messages:
//! titles (trimmed, first line, cut at 200 UTF-16 units inside an emoji), images, notes, the last reply's outcome,
//! models, open handoffs, client ids (last five), Linear cards and the PRs shell steps created or merged.

mod common;

use std::process::Command;

use milagre_owner_store::chat_summaries::summarize_chat;
use milagre_owner_store::message_store::Msg;
use serde_json::{json, Value};

fn shell(detail: &str, status: &str) -> Value {
    json!({ "kind": "shell", "status": status, "title": "sh", "detail": detail })
}

fn cases() -> Vec<Value> {
    let long = format!("{}\u{1F600} tail", "x".repeat(199));
    vec![
        json!([]),
        json!([{ "id": 1, "session_id": 1, "role": "user", "body": "   \n  " }, { "id": 2, "session_id": 1, "role": "user", "body": format!("\t{long}\nsecond") }]),
        json!([
            { "id": 1, "role": "user", "body": "Ship it", "images": "ab", "model": "m1", "clientMessageId": "a" },
            { "id": 2, "role": "assistant", "body": "", "outcome": "completed", "steps": [
                shell("$ gh pr create --fill\nhttps://github.com/acme/app/pull/12", "done"),
                shell("$ gh pr create\nhttps://github.com/acme/app/pull/99", "failed"),
                shell("$ gh pr merge 12 && gh pr merge \"--body\" x 13 -R acme/app; gh pr merge --squash https://github.com/o/r/pull/3", "done"),
                shell("$ gh pr merge feature-branch", "done"),
                shell("$ gh pr merge -R acme/web 21 --squash", "done"),
                shell("gh pr merge 4", "done"),
            ] },
            { "id": 3, "role": "assistant", "body": "note", "context": { "kind": "git-action" }, "outcome": "failed" },
            { "id": 4, "role": "assistant", "body": "", "context": { "kind": "handoff", "status": "preparing" } },
            { "id": 5, "role": "user", "body": "b", "model": "", "clientMessageId": "b" },
        ]),
        json!([
            { "id": 7, "role": "user", "body": "", "context": { "kind": "linear-issue", "key": "ENG-9", "workspace": "" } },
            { "id": 8, "role": "assistant", "steps": { "kind": "shell", "status": "done", "detail": "$ gh pr merge 5 --repo bad/repo/x" } },
            { "id": 9, "role": "assistant", "outcome": 0, "context": { "kind": "handoff", "status": "preparing" }, "clientMessageId": "c" },
        ]),
        json!((1..=8).map(|n| json!({ "id": n, "role": "user", "body": format!("m{n}"), "clientMessageId": format!("id{n}") })).collect::<Vec<_>>()),
    ]
}

#[test]
fn summaries_match_nodes_summarize_chat() {
    let Some(node) = common::node() else { return };
    let module = common::crate_dir().join("../../packages/shared/src/chat-summary.mjs");
    let module = std::fs::canonicalize(module).unwrap();
    let cases = Value::Array(cases());
    let script = format!(
        "import {{ summarizeChat }} from {};\nconst cases = JSON.parse(process.argv[1]);\nprocess.stdout.write(JSON.stringify(cases.map((messages) => summarizeChat(messages))));",
        serde_json::to_string(&format!("file://{}", module.display())).unwrap()
    );
    let output = Command::new(node)
        .args(["--input-type=module", "-e", &script, &cases.to_string()])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let expected =
        milagre_owner_store::jsjson::parse(&String::from_utf8(output.stdout).unwrap()).unwrap();
    let expected = expected.as_array().unwrap().clone();
    assert_eq!(expected.len(), cases.as_array().unwrap().len());
    for (index, (case, expected)) in cases.as_array().unwrap().iter().zip(expected).enumerate() {
        let messages: Vec<_> = case
            .as_array()
            .unwrap()
            .iter()
            .cloned()
            .map(Msg::new)
            .collect();
        let rust = Value::Object(summarize_chat(&messages));
        assert_eq!(rust, expected, "case {index}");
    }
}

/// Measurement (not a pass/fail check; run with `--release -- --ignored --nocapture`): 900 loaded Chats, 45,000 steps,
/// a 4 KB unrelated subagent transcript on every session. Times `with_chat_summaries` for the first read, a kept change
/// that appends one message to one Chat (its summary changes), a kept change that leaves the messages as they were
/// (`next_id` only), and an unchanged state.
#[test]
#[ignore]
fn measure_summary_overhead() {
    use milagre_owner_store::chat_summaries::with_chat_summaries;
    use milagre_owner_store::message_store::ProjectState;
    use std::sync::Arc;
    use std::time::Instant;
    let chats = 900;
    let mut sessions = serde_json::Map::new();
    let mut messages = Vec::new();
    let mut id = 1;
    for chat in 1..=chats {
        sessions.insert(
            chat.to_string(),
            json!({ "id": chat, "title": format!("Chat {chat}"),
                "subagents": [{ "id": "a", "transcript": [{ "id": "e", "kind": "tool", "text": "t".repeat(4096) }] }] }),
        );
        for turn in 0..2 {
            messages.push(json!({ "id": id, "session_id": chat, "role": "user", "body": format!("question {turn} in chat {chat}"), "clientMessageId": format!("c{id}") }));
            id += 1;
            let steps: Vec<Value> = (0..25)
                .map(|step| json!({ "id": format!("s{step}"), "kind": "shell", "status": "done", "title": "ls", "detail": format!("$ ls\n{}", "x".repeat(200)) }))
                .collect();
            messages.push(json!({ "id": id, "session_id": chat, "role": "assistant", "body": "done ".repeat(40), "outcome": "completed", "steps": steps }));
            id += 1;
        }
    }
    let state = ProjectState::from_value(
        &json!({ "next_id": id, "sessions": sessions, "messages": messages }),
    );
    let steps: usize = state
        .message_list()
        .iter()
        .map(|m| {
            m.value()
                .get("steps")
                .and_then(Value::as_array)
                .map_or(0, Vec::len)
        })
        .sum();
    println!(
        "chats {chats}, messages {}, steps {steps}",
        state.message_list().len()
    );
    let time = |label: &str, runs: usize, mut work: Box<dyn FnMut() -> ProjectState>| {
        let mut samples: Vec<f64> = (0..runs)
            .map(|_| {
                let started = Instant::now();
                let out = work();
                let elapsed = started.elapsed().as_secs_f64() * 1000.0;
                drop(out);
                elapsed
            })
            .collect();
        samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
        println!(
            "{label:<34} median {:>8.3} ms  min {:>8.3} ms",
            samples[runs / 2],
            samples[0]
        );
    };
    let read = with_chat_summaries(state.clone(), None, 0);
    let base = read.clone();
    time(
        "first read (no previous)",
        9,
        Box::new(move || with_chat_summaries(state.clone(), None, 0)),
    );
    let previous = base.clone();
    let mut appended = previous.message_list().to_vec();
    appended.push(milagre_owner_store::message_store::Msg::new(json!({ "id": id, "session_id": 450, "role": "user", "body": "one more", "clientMessageId": "new" })));
    let next = previous.with_messages(appended);
    let (p, n) = (previous.clone(), next.clone());
    time(
        "append one message to one Chat",
        31,
        Box::new(move || with_chat_summaries(n.clone(), Some(&p), 1)),
    );
    let mut bumped = previous.clone();
    Arc::make_mut(&mut bumped.rest).insert("next_id".into(), json!(id + 1));
    let p = previous.clone();
    time(
        "same messages, next_id changed",
        31,
        Box::new(move || with_chat_summaries(bumped.clone(), Some(&p), 1)),
    );
    let p = previous.clone();
    time(
        "copy of the state's other keys",
        31,
        Box::new(move || {
            let mut copy = p.clone();
            Arc::make_mut(&mut copy.rest);
            copy
        }),
    );
    let p = previous.clone();
    let same = previous.clone();
    time(
        "unchanged state",
        31,
        Box::new(move || with_chat_summaries(same.clone(), Some(&p), 1)),
    );
    drop(read);
}

/// Review cases, as JSON text (so lone surrogates reach both sides as they are): images as a list, JavaScript
/// whitespace (` `, ` `, `﻿`, `\r\n`) around titles, `gh pr create`, PR URL lines ending in `\r` or a
/// space, handoff ids `0` and `null`, a missing role, numeric and string client ids, unmatched quotes and `--repo=value`
/// in `gh pr merge`, the same PR number in two commands, and a lone surrogate in a title, a ref and a body.
const EDGE_CASES: &str = r#"[
  [{"id": 1, "role": "user", "body": " ﻿  Title here\r\nnext", "images": [{"p": 1}, {"p": 2}]}],
  [{"id": 2, "body": "  no role, so it can name the Chat  "}, {"id": 3, "role": "assistant", "outcome": "completed"}],
  [{"id": 4, "role": "assistant", "steps": [
    {"kind": "shell", "status": "done", "detail": "$ gh pr create\nhttps://github.com/a/b/pull/1\r"},
    {"kind": "shell", "status": "done", "detail": "$ gh pr create\nhttps://github.com/a/b/pull/2 \nhttps://github.com/a/b/pull/3\r\n"},
    {"kind": "shell", "status": "done", "detail": "$ gh pr merge \"unterminated 5"},
    {"kind": "shell", "status": "done", "detail": "$ gh pr merge --repo=a/b 6"},
    {"kind": "shell", "status": "done", "detail": "$ gh pr merge 3; gh pr merge -R c/d 3"}
  ]}],
  [{"id": 5, "role": "assistant", "context": {"kind": "handoff", "status": "preparing"}, "clientMessageId": 7},
   {"id": 0, "role": "assistant", "context": {"kind": "handoff", "status": "preparing"}, "clientMessageId": "x"}],
  [{"id": 6, "role": "assistant", "context": {"kind": "handoff", "status": "preparing"}},
   {"id": null, "role": "assistant", "context": {"kind": "handoff", "status": "preparing"}, "clientMessageId": 0}],
  [{"id": 7, "role": "user", "body": "\ud83d broken title \udc00", "clientMessageId": "c\ud800"},
   {"id": 8, "role": "assistant", "body": "\udfff", "outcome": "done\ud800", "steps": [
     {"kind": "shell", "status": "done", "detail": "$ gh pr merge https://github.com/a/b/pull/9 \ud800"}]}]
]"#;

#[test]
fn edge_case_summaries_match_node() {
    let Some(node) = common::node() else { return };
    let module = std::fs::canonicalize(
        common::crate_dir().join("../../packages/shared/src/chat-summary.mjs"),
    )
    .unwrap();
    let script = format!(
        "import {{ summarizeChat }} from {};\nconst cases = JSON.parse(process.argv[1]);\nprocess.stdout.write(JSON.stringify(cases.map((messages) => summarizeChat(messages))));",
        serde_json::to_string(&format!("file://{}", module.display())).unwrap()
    );
    let output = Command::new(node)
        .args(["--input-type=module", "-e", &script, EDGE_CASES])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let expected =
        milagre_owner_store::jsjson::parse(&String::from_utf8(output.stdout).unwrap()).unwrap();
    let cases = milagre_owner_store::jsjson::parse(EDGE_CASES).unwrap();
    for (index, (case, expected)) in cases
        .as_array()
        .unwrap()
        .iter()
        .zip(expected.as_array().unwrap())
        .enumerate()
    {
        let messages: Vec<_> = case
            .as_array()
            .unwrap()
            .iter()
            .cloned()
            .map(Msg::new)
            .collect();
        assert_eq!(
            &Value::Object(summarize_chat(&messages)),
            expected,
            "edge case {index}"
        );
    }
}

/// Sequences of changes through `with_chat_summaries` and Node's real `withChatSummaries`
/// (fixtures/summaries-node.cjs), made the same way on both sides (unchanged messages and sessions shared), compared
/// session by session after every step: a reply's outcome flipping with the same count and last id, an edit keeping
/// both, messages removed (an undo), a Chat created, then given its first message with a session copy without its
/// summary (the old one read from the previous state), a Link line, an equal copy of the sessions, an unloaded Chat
/// that never had a summary (it stays without), and one losing its summary while unloaded (kept from before).
const SEQUENCES: &str = r#"[
  {"seed": {"next_id": 10, "sessions": {"1": {"id": 1}, "2": {"id": 2, "title": "two"}},
            "messages": [{"id": 1, "session_id": 1, "role": "user", "body": "First"},
                         {"id": 2, "session_id": 1, "role": "assistant", "body": "ok", "outcome": "completed"},
                         {"id": 3, "session_id": 2, "role": "user", "body": "Second"}]},
   "steps": [
     {"at": 100, "ops": [{"append": [{"id": 4, "session_id": 1, "role": "assistant", "body": "bad", "outcome": "failed"}]}]},
     {"at": 200, "ops": [{"replace": {"id": 4, "message": {"id": 4, "session_id": 1, "role": "assistant", "body": "fixed", "outcome": "completed"}}}]},
     {"at": 300, "ops": [{"replace": {"id": 1, "message": {"id": 1, "session_id": 1, "role": "user", "body": "First, edited"}}}]},
     {"at": 400, "ops": [{"remove": [4]}]},
     {"at": 450, "ops": [{"remove": [1, 2]}]},
     {"at": 500, "ops": [{"session": {"id": "5", "value": {"id": 5, "title": "new"}}}]},
     {"at": 600, "ops": [{"session": {"id": "5", "value": {"id": 5, "title": "new"}}},
                         {"append": [{"id": 5, "session_id": 5, "role": "user", "body": "Hello five", "clientMessageId": "c5"}]}]},
     {"at": 700, "ops": [{"append": [{"id": 6, "session_id": 2, "role": "assistant", "body": "", "context": {"kind": "worktree-linked"}}]}]},
     {"at": 800, "ops": [{"copySessions": true}]},
     {"at": 900, "ops": [{"append": [{"id": 7, "session_id": 5, "role": "assistant", "body": "done", "outcome": "completed"}]}]}
   ]},
  {"seed": {"next_id": 20, "sessions": {"1": {"id": 1}, "3": {"id": 3, "title": "never summarized"},
                                         "4": {"id": 4, "summary": {"count": 2, "lastId": 9, "lastAt": 50}}},
            "messages": [{"id": 1, "session_id": 1, "role": "user", "body": "Loaded"}]},
   "unloaded": [3, 4],
   "steps": [
     {"at": 100, "ops": [{"append": [{"id": 2, "session_id": 1, "role": "assistant", "body": "r", "outcome": "completed"}]}]},
     {"at": 200, "ops": [{"unload": [1]}]},
     {"at": 300, "ops": [{"session": {"id": "1", "value": {"id": 1}}}, {"session": {"id": "4", "value": {"id": 4}}}]},
     {"at": 400, "ops": [{"session": {"id": "3", "value": {"id": 3, "title": "renamed"}}}]}
   ]}
]"#;

#[test]
fn chat_summary_sequences_match_node() {
    use milagre_owner_store::chat_summaries::with_chat_summaries;
    use milagre_owner_store::jsjson;
    use milagre_owner_store::message_store::ProjectState;
    use std::collections::BTreeSet;
    use std::sync::Arc;
    let Some(node) = common::node() else { return };
    let driver = common::crate_dir().join("fixtures/summaries-node.cjs");
    let output = Command::new(node)
        .arg(&driver)
        .arg(SEQUENCES)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let expected = jsjson::parse(&String::from_utf8(output.stdout).unwrap()).unwrap();
    let cases = jsjson::parse(SEQUENCES).unwrap();
    for (index, (case, expected)) in cases
        .as_array()
        .unwrap()
        .iter()
        .zip(expected.as_array().unwrap())
        .enumerate()
    {
        let mut unloaded: BTreeSet<i64> = case["unloaded"]
            .as_array()
            .map_or_else(BTreeSet::new, |ids| {
                ids.iter().filter_map(Value::as_i64).collect()
            });
        let mut seed = ProjectState::from_value(&case["seed"]);
        seed.unloaded = Arc::new(unloaded.clone());
        let mut state = with_chat_summaries(seed, None, 0);
        let mut got = vec![state.rest["sessions"].clone()];
        for step in case["steps"].as_array().unwrap() {
            let mut next = state.clone();
            for op in step["ops"].as_array().unwrap() {
                if let Some(items) = op.get("append").and_then(Value::as_array) {
                    let mut messages = next.message_list().to_vec();
                    messages.extend(items.iter().cloned().map(Msg::new));
                    next = next.with_messages(messages);
                }
                if let Some(ids) = op.get("remove").and_then(Value::as_array) {
                    next = next.with_messages(
                        next.message_list()
                            .to_vec()
                            .into_iter()
                            .filter(|m| !ids.contains(&m.value()["id"]))
                            .collect(),
                    );
                }
                if let Some(edit) = op.get("replace") {
                    let messages = next
                        .message_list()
                        .to_vec()
                        .into_iter()
                        .map(|m| {
                            if m.value()["id"] == edit["id"] {
                                Msg::new(edit["message"].clone())
                            } else {
                                m
                            }
                        })
                        .collect();
                    next = next.with_messages(messages);
                }
                if let Some(session) = op.get("session") {
                    let rest = Arc::make_mut(&mut next.rest);
                    let sessions = rest["sessions"].as_object_mut().unwrap();
                    let id = session["id"].as_str().unwrap().to_string();
                    if session["value"].is_null() {
                        sessions.shift_remove(&id);
                    } else {
                        sessions.insert(id, session["value"].clone());
                    }
                }
                if op.get("copySessions").is_some() {
                    let sessions = next.rest["sessions"].clone();
                    Arc::make_mut(&mut next.rest).insert("sessions".into(), sessions);
                }
                if let Some(chats) = op.get("unload").and_then(Value::as_array) {
                    unloaded.extend(chats.iter().filter_map(Value::as_i64));
                    next = next.with_messages(
                        next.message_list()
                            .to_vec()
                            .into_iter()
                            .filter(|m| !chats.contains(&m.value()["session_id"]))
                            .collect(),
                    );
                }
            }
            next.unloaded = Arc::new(unloaded.clone());
            state = with_chat_summaries(next, Some(&state), step["at"].as_i64().unwrap());
            got.push(state.rest["sessions"].clone());
        }
        let expected = expected.as_array().unwrap();
        assert_eq!(got.len(), expected.len());
        for (step, (rust, node)) in got.iter().zip(expected).enumerate() {
            assert_eq!(rust, node, "sequence {index}, after step {step}");
        }
    }
}

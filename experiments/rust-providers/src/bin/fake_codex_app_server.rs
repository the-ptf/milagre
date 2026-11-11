//! Deterministic stand-in for `codex app-server`, for this crate's tests only. Speaks the same
//! newline-delimited JSON as Codex. Never touches the network, ~/.codex or any credentials.
//!
//! Codex-like methods (`initialize`, `account/read`, `model/list`, `thread/start`, `thread/resume`,
//! `thread/unarchive`, `turn/start`, `turn/steer`, `turn/interrupt`) follow `FAKE_SCENARIO`:
//! reply (default), approval, file-approval, question, withdrawn, mcp-plan, mcp-gated, permissions,
//! stubborn, slow, crash, logged-out, hang-init, unknown-request.
//!
//! Test hooks, whatever the scenario:
//! - `echo { value, delayMs }` answers `{ value }` after the delay, on its own thread (out of order).
//! - `fake/received` answers every frame received so far.
//! - `fake/hang` never answers.
//! - `fake/noise` writes garbage, blank, CRLF and stray-id lines, JSON on stderr, then answers.
//! - `fake/huge { bytes }` writes one line of that many bytes.
//! - `fake/partial { value }` answers without a trailing newline and exits 0.
//! - `fake/stderr { bytes }` writes that much to stderr, then answers.
//! - `fake/exit { code, stderr }` writes stderr and exits.
//! - `fake/close-stdout` answers, closes stdout and keeps running.
//! - `fake/spawn-grandchild` starts `sleep 30` in its process group and answers its pid.
//! - `fake/server-request { id, method, params }` sends a server request; its answer is reported
//!   as a `fake/answered { id, answer }` notification.

use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Clone)]
struct Out(Arc<Mutex<Option<std::io::Stdout>>>);

impl Out {
    fn send(&self, message: &Value) {
        self.raw(&format!("{message}\n"));
    }
    fn raw(&self, text: &str) {
        let mut guard = self.0.lock().unwrap();
        if let Some(out) = guard.as_mut() {
            let _ = out.write_all(text.as_bytes());
            let _ = out.flush();
        }
    }
    fn notify(&self, method: &str, params: Value) {
        self.send(&json!({ "method": method, "params": params }));
    }
    fn reply(&self, id: &Value, result: Value) {
        self.send(&json!({ "id": id, "result": result }));
    }
    fn error(&self, id: &Value, code: i64, message: &str) {
        self.send(&json!({ "id": id, "error": { "code": code, "message": message } }));
    }
}

struct Turn {
    thread: String,
    turn: String,
    /// The server request this turn waits on.
    waiting: Option<Value>,
}

fn main() {
    let scenario = std::env::var("FAKE_SCENARIO").unwrap_or_else(|_| "reply".into());
    if let Ok(file) = std::env::var("FAKE_PID_FILE") {
        let _ = std::fs::write(file, std::process::id().to_string());
    }
    let out = Out(Arc::new(Mutex::new(Some(std::io::stdout()))));
    let received: Arc<Mutex<Vec<Value>>> = Arc::default();
    let mut turn: Option<Turn> = None;
    let mut turns = 0;
    let mut threads = 0;
    let mut child_reads = 0;
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
        received.lock().unwrap().push(message.clone());
        let id = message.get("id").cloned().unwrap_or(Value::Null);
        let params = message.get("params").cloned().unwrap_or(json!({}));
        let Some(method) = message.get("method").and_then(Value::as_str).map(str::to_string) else {
            // A response to one of our server requests.
            let answer = message.get("result").or_else(|| message.get("error")).cloned().unwrap_or(Value::Null);
            if let Some(current) = turn.as_ref().filter(|t| t.waiting.as_ref() == Some(&id)) {
                let text = match answer.get("decision").and_then(Value::as_str) {
                    Some(decision) => format!("decision:{decision}"),
                    None => format!("answer:{answer}"),
                };
                out.notify(
                    "item/agentMessage/delta",
                    json!({ "threadId": current.thread, "turnId": current.turn, "itemId": "msg-1", "delta": text }),
                );
                complete(&out, current, "completed");
                turn = None;
            } else {
                out.notify("fake/answered", json!({ "id": id, "answer": answer }));
            }
            continue;
        };
        match method.as_str() {
            "initialize" if scenario == "hang-init" => {}
            "initialize" => out.reply(&id, json!({ "userAgent": "fake-rust/0.167.0", "platformOs": "test" })),
            "initialized" => {}
            "account/read" if scenario == "logged-out" => out.reply(&id, json!({ "account": null, "requiresOpenaiAuth": true })),
            "account/read" => out.reply(&id, json!({ "account": { "type": "apiKey" }, "requiresOpenaiAuth": true })),
            "model/list" => {
                if params.get("cursor").is_none() {
                    out.reply(&id, json!({ "data": [{ "id": "gpt-fake-1", "hidden": false }], "nextCursor": "page-2" }));
                } else {
                    // A cursor that loops back must not make the client spin.
                    out.reply(&id, json!({ "data": [{ "id": "gpt-fake-2", "hidden": true }], "nextCursor": "page-2" }));
                }
            }
            "thread/start" if scenario == "hang-thread" => {}
            "thread/start" => {
                threads += 1;
                out.reply(&id, json!({ "thread": { "id": format!("thread-{threads}") }, "model": params.get("model") }));
            }
            "thread/resume" => {
                let thread = params.get("threadId").and_then(Value::as_str).unwrap_or_default();
                if thread == "missing" {
                    out.error(&id, -32600, "no rollout found for thread id missing");
                } else {
                    out.reply(&id, json!({ "thread": { "id": thread } }));
                }
            }
            "thread/unarchive" => out.error(&id, -32600, "thread is not archived"),
            // Subagent threads: child-1 runs on the first read and has finished from the second; done-child
            // finished, active-child still runs, old-child's Codex has no thread/turns/list.
            "thread/read" => {
                let thread = params.get("threadId").and_then(Value::as_str).unwrap_or_default().to_string();
                let include = params.get("includeTurns") == Some(&Value::Bool(true));
                let status = match thread.as_str() {
                    "child-1" => {
                        child_reads += 1;
                        if child_reads == 1 {
                            "active"
                        } else {
                            "idle"
                        }
                    }
                    "active-child" => "active",
                    _ => "idle",
                };
                let mut result = json!({ "thread": { "id": thread, "status": { "type": status } } });
                if include && thread == "old-child" {
                    result["thread"]["turns"] = json!([{ "id": "ot-1", "status": "interrupted", "items": [] }]);
                }
                out.reply(&id, result);
            }
            "thread/turns/list" => {
                let thread = params.get("threadId").and_then(Value::as_str).unwrap_or_default();
                let cursor = params.get("cursor").and_then(Value::as_str);
                let finished = child_reads > 1;
                let working = json!({ "type": "agentMessage", "id": "cm-1", "text": "Working on it." });
                let done = json!({ "type": "agentMessage", "id": "cm-2", "text": "Done. Token expiry is 5 minutes." });
                match thread {
                    "old-child" => out.error(&id, -32601, "unknown method thread/turns/list"),
                    "child-1" if cursor.is_some() => out.reply(
                        &id,
                        json!({ "data": [{ "id": "ct-1", "status": "completed", "items": [working, done] }], "nextCursor": null }),
                    ),
                    "child-1" if finished => out.reply(
                        &id,
                        json!({ "data": [{ "id": "ct-1", "status": "completed", "items": [working, done] }], "backwardsCursor": "b1" }),
                    ),
                    "child-1" => out.reply(
                        &id,
                        json!({ "data": [{ "id": "ct-1", "status": "inProgress", "items": [working] }], "backwardsCursor": "b1" }),
                    ),
                    _ => out.reply(&id, json!({ "data": [{ "id": "dt-1", "status": "completed", "items": [] }], "backwardsCursor": null })),
                }
            }
            "turn/start" if scenario == "hang-turn" => {}
            "turn/start" if scenario == "late-start" => {
                turns += 1;
                let thread = params.get("threadId").and_then(Value::as_str).unwrap_or_default().to_string();
                let turn_id = format!("turn-{turns}");
                let out = out.clone();
                if turns == 1 {
                    // Answered after Milagre gave up on it; the abandoned turn then runs to its end.
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(300));
                        out.reply(&id, json!({ "turn": { "id": turn_id, "status": "inProgress" } }));
                        out.notify("turn/started", json!({ "threadId": thread, "turn": { "id": turn_id, "status": "inProgress" } }));
                        out.notify(
                            "item/agentMessage/delta",
                            json!({ "threadId": thread, "turnId": turn_id, "itemId": "old", "delta": "old" }),
                        );
                        out.notify(
                            "turn/completed",
                            json!({ "threadId": thread, "turn": { "id": turn_id, "status": "completed", "items": [], "error": null } }),
                        );
                    });
                } else {
                    turn = Some(Turn { thread: thread.clone(), turn: turn_id.clone(), waiting: None });
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(500));
                        out.reply(&id, json!({ "turn": { "id": turn_id, "status": "inProgress" } }));
                        out.notify("turn/started", json!({ "threadId": thread, "turn": { "id": turn_id, "status": "inProgress" } }));
                    });
                }
            }
            "turn/start" => {
                turns += 1;
                let thread = params.get("threadId").and_then(Value::as_str).unwrap_or_default().to_string();
                let current = Turn { thread: thread.clone(), turn: format!("turn-{turns}"), waiting: None };
                out.reply(&id, json!({ "turn": { "id": current.turn, "status": "inProgress", "items": [], "error": null } }));
                out.notify("turn/started", json!({ "threadId": thread, "turn": { "id": current.turn, "status": "inProgress" } }));
                turn = start_turn(&scenario, &out, current);
            }
            "turn/steer" if scenario == "steer-late" => {
                // The turn ended just before the steer arrived.
                out.error(&id, -32600, "no active turn to steer");
                if let Some(current) = turn.take() {
                    complete(&out, &current, "completed");
                }
            }
            "turn/steer" => match turn.as_ref() {
                Some(current) if params.get("expectedTurnId").and_then(Value::as_str) == Some(current.turn.as_str()) => {
                    out.reply(&id, json!({ "turnId": current.turn }));
                    out.notify(
                        "item/agentMessage/delta",
                        json!({ "threadId": current.thread, "turnId": current.turn, "itemId": "msg-2", "delta": "steered" }),
                    );
                }
                _ => out.error(&id, -32600, "no active turn to steer"),
            },
            "turn/interrupt" if scenario == "stubborn" => {}
            "turn/interrupt" => {
                out.reply(&id, json!({}));
                if let Some(current) = turn.take() {
                    complete(&out, &current, "interrupted");
                }
            }
            "echo" => {
                let out = out.clone();
                let delay = params.get("delayMs").and_then(Value::as_u64).unwrap_or(0);
                let value = params.get("value").cloned().unwrap_or(Value::Null);
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(delay));
                    out.reply(&id, json!({ "value": value }));
                });
            }
            "fake/received" => {
                let frames = received.lock().unwrap().clone();
                out.reply(&id, json!({ "received": frames }));
            }
            "fake/hang" => {}
            "fake/stop-reading" => {
                // Stops reading stdin (this loop) for a while, as a wedged Codex would.
                std::thread::sleep(Duration::from_millis(params.get("ms").and_then(Value::as_u64).unwrap_or(0)));
                out.reply(&id, json!({ "ok": true }));
            }
            "fake/flood" => {
                let count = params.get("count").and_then(Value::as_u64).unwrap_or(0);
                let filler = "z".repeat(params.get("bytes").and_then(Value::as_u64).unwrap_or(10) as usize);
                for n in 0..count {
                    out.notify("fake/flood", json!({ "n": n, "f": filler }));
                }
                out.reply(&id, json!({ "sent": count }));
            }
            "fake/requests" => {
                let count = params.get("count").and_then(Value::as_u64).unwrap_or(0);
                for n in 0..count {
                    out.send(&json!({ "id": format!("flood-{n}"), "method": "item/commandExecution/requestApproval", "params": {} }));
                }
                out.reply(&id, json!({ "sent": count }));
            }
            "fake/noise" => {
                out.raw("this is not json\n\n   \n[1,2]\n{\"neither\":true}\n");
                out.raw("{\"id\":424242,\"result\":{\"stray\":true}}\n");
                out.raw("{\"method\":\"fake/crlf\",\"params\":{\"ok\":true}}\r\n");
                eprintln!("{{\"id\":{id},\"result\":{{\"from\":\"stderr\"}}}}");
                eprintln!("{{\"method\":\"fake/from-stderr\"}}");
                out.reply(&id, json!({ "ok": true }));
            }
            "fake/huge" => {
                let bytes = params.get("bytes").and_then(Value::as_u64).unwrap_or(1024) as usize;
                let filler = "x".repeat(bytes.saturating_sub(40));
                out.raw(&format!("{{\"method\":\"fake/huge\",\"params\":{{\"f\":\"{filler}\"}}}}\n"));
            }
            "fake/partial" => {
                out.raw(&format!("{}", json!({ "id": id, "result": { "value": params.get("value") } })));
                std::process::exit(0);
            }
            "fake/stderr" => {
                let bytes = params.get("bytes").and_then(Value::as_u64).unwrap_or(0) as usize;
                let mut err = std::io::stderr();
                let chunk = "e".repeat(1023) + "\n";
                let mut left = bytes;
                while left > 0 {
                    let n = left.min(chunk.len());
                    let _ = err.write_all(&chunk.as_bytes()[..n]);
                    left -= n;
                }
                let _ = err.write_all(b"stderr tail marker\n");
                out.reply(&id, json!({ "ok": true }));
            }
            "fake/exit" => {
                if let Some(text) = params.get("stderr").and_then(Value::as_str) {
                    eprint!("{text}");
                }
                std::process::exit(params.get("code").and_then(Value::as_i64).unwrap_or(0) as i32);
            }
            "fake/close-stdout" => {
                out.reply(&id, json!({ "ok": true }));
                // Dropping our handle is not enough: Rust's stdout is a global, so close fd 1 itself.
                out.0.lock().unwrap().take();
                close_stdout();
                std::thread::sleep(Duration::from_secs(60));
            }
            "fake/close-stdin" => {
                // Closes its input but keeps running: Milagre can't answer anything any more.
                out.reply(&id, json!({ "ok": true }));
                close_fd(0);
                std::thread::sleep(Duration::from_secs(60));
            }
            "fake/spawn-grandchild" => {
                let child = std::process::Command::new("sleep").arg("30").spawn().expect("sleep");
                out.reply(&id, json!({ "pid": child.id() }));
                std::mem::forget(child);
            }
            "fake/server-request" => {
                out.send(&json!({ "id": params.get("id"), "method": params.get("method"), "params": params.get("params").cloned().unwrap_or(json!({})) }));
                out.reply(&id, json!({ "sent": true }));
            }
            "fake/notify" => {
                out.notify(
                    params.get("method").and_then(Value::as_str).unwrap_or("fake/n"),
                    params.get("params").cloned().unwrap_or(json!({})),
                );
                out.reply(&id, json!({}));
            }
            _ if message.get("id").is_none() => {}
            other => out.error(&id, -32601, &format!("unknown method {other}")),
        }
    }
}

fn complete(out: &Out, turn: &Turn, status: &str) {
    let error = if status == "failed" { json!({ "message": "The model gpt-x is not supported." }) } else { Value::Null };
    out.notify(
        "turn/completed",
        json!({ "threadId": turn.thread, "turn": { "id": turn.turn, "items": [], "status": status, "error": error } }),
    );
}

fn start_turn(scenario: &str, out: &Out, mut turn: Turn) -> Option<Turn> {
    let (thread, turn_id) = (turn.thread.clone(), turn.turn.clone());
    match scenario {
        "approval" => {
            turn.waiting = Some(json!("srv-1"));
            out.send(&json!({ "id": "srv-1", "method": "item/commandExecution/requestApproval", "params": {
                "threadId": thread, "turnId": turn_id, "itemId": "cmd-1", "command": "/bin/zsh -lc 'rm -rf build'", "cwd": "/repo", "reason": "Clean the build" } }));
            Some(turn)
        }
        "file-approval" => {
            turn.waiting = Some(json!(7));
            // FAKE_FILE: the file the edit is about (tests point it at real temporary folders).
            let file = std::env::var("FAKE_FILE").unwrap_or_else(|_| "/repo/notes.txt".into());
            let changes = std::env::var("FAKE_CHANGES")
                .ok()
                .map(|value| serde_json::from_str::<Value>(&value).unwrap())
                .unwrap_or_else(|| json!([{ "path": file, "kind": { "type": "add" }, "diff": "hello\n" }]));
            out.notify(
                "item/started",
                json!({ "threadId": thread, "turnId": turn_id, "item": {
                "type": "fileChange", "id": "patch-1", "status": "inProgress", "changes": changes } }),
            );
            out.send(&json!({ "id": 7, "method": "item/fileChange/requestApproval", "params": { "threadId": thread, "turnId": turn_id, "itemId": "patch-1", "reason": "Write notes" } }));
            Some(turn)
        }
        "question" => {
            turn.waiting = Some(json!("srv-q"));
            out.send(&json!({ "id": "srv-q", "method": "item/tool/requestUserInput", "params": { "threadId": thread, "turnId": turn_id, "itemId": "call-1",
                "questions": [{ "id": "color", "header": "Color", "question": "Which color?", "isOther": true, "isSecret": false,
                    "options": [{ "label": "Red", "description": "Warm" }, { "label": "Green", "description": "Calm" }] }] } }));
            Some(turn)
        }
        "withdrawn" => {
            out.send(&json!({ "id": "srv-1", "method": "item/commandExecution/requestApproval", "params": { "threadId": thread, "turnId": turn_id, "itemId": "cmd-1", "command": "/bin/zsh -lc ls" } }));
            out.notify("serverRequest/resolved", json!({ "threadId": thread, "requestId": "srv-1" }));
            complete(out, &turn, "completed");
            None
        }
        "mcp-plan" | "mcp-gated" => {
            let tool = if scenario == "mcp-plan" { "tasks_set" } else { "design_delete" };
            turn.waiting = Some(json!("srv-mcp"));
            out.send(&json!({ "id": "srv-mcp", "method": "mcpServer/elicitation/request", "params": {
                "threadId": thread, "turnId": turn_id, "serverName": "milagre", "mode": "form",
                "message": format!("Allow the milagre MCP server to run tool \"{tool}\"?"),
                "requestedSchema": { "type": "object", "properties": {} },
                "_meta": { "codex_approval_kind": "mcp_tool_call", "persist": ["session", "always"], "tool_description": "Create an editable design", "tool_params": { "id": "daily-notes" } } } }));
            Some(turn)
        }
        "permissions" => {
            turn.waiting = Some(json!("srv-p"));
            out.send(&json!({ "id": "srv-p", "method": "item/permissions/requestApproval", "params": { "threadId": thread, "turnId": turn_id, "itemId": "perm-1" } }));
            Some(turn)
        }
        "unknown-request" => {
            turn.waiting = Some(json!("srv-u"));
            out.send(&json!({ "id": "srv-u", "method": "item/somethingNew/request", "params": {} }));
            Some(turn)
        }
        "stubborn" | "slow" | "steer-late" => Some(turn),
        "dup-ids" => {
            out.send(&json!({ "id": 5, "method": "item/commandExecution/requestApproval", "params": { "threadId": thread, "turnId": turn_id, "command": "/bin/zsh -lc ls" } }));
            out.send(&json!({ "id": "5", "method": "item/tool/requestUserInput", "params": { "threadId": thread, "turnId": turn_id,
                "questions": [{ "id": "q", "question": "Which?", "options": [{ "label": "A" }] }] } }));
            Some(turn)
        }
        "chatty" => {
            for n in 0..300 {
                out.notify(
                    "item/agentMessage/delta",
                    json!({ "threadId": thread, "turnId": turn_id, "itemId": "msg-1", "delta": format!("{n} ") }),
                );
            }
            complete(out, &turn, "completed");
            None
        }
        "steps" => {
            let command = json!({ "type": "commandExecution", "id": "exec-1", "command": "/bin/zsh -lc 'npm test'", "cwd": "/repo", "status": "inProgress",
                "commandActions": [{ "type": "unknown", "command": "npm test" }], "aggregatedOutput": null, "exitCode": null });
            out.notify("item/started", json!({ "threadId": thread, "turnId": turn_id, "item": command }));
            out.notify(
                "item/commandExecution/outputDelta",
                json!({ "threadId": thread, "turnId": turn_id, "itemId": "exec-1", "delta": "ok 2\n" }),
            );
            let mut done = command.clone();
            done["status"] = "completed".into();
            done["aggregatedOutput"] = "ok 1\nok 2\n".into();
            done["exitCode"] = 0.into();
            out.notify("item/completed", json!({ "threadId": thread, "turnId": turn_id, "item": done }));
            out.notify("item/started", json!({ "threadId": thread, "turnId": turn_id, "item": { "type": "reasoning", "id": "rs-1", "summary": [], "content": [] } }));
            out.notify("item/completed", json!({ "threadId": thread, "turnId": turn_id, "item": { "type": "reasoning", "id": "rs-1", "summary": ["Checked tests"], "content": [] } }));
            out.notify("thread/tokenUsage/updated", json!({ "threadId": thread, "turnId": turn_id, "tokenUsage": { "last": { "totalTokens": 1200 }, "modelContextWindow": 272000 } }));
            out.notify(
                "turn/plan/updated",
                json!({ "threadId": thread, "turnId": turn_id, "plan": [{ "step": "Run tests", "status": "completed" }] }),
            );
            out.notify("item/agentMessage/delta", json!({ "threadId": thread, "turnId": turn_id, "itemId": "msg-1", "delta": "Done" }));
            complete(out, &turn, "completed");
            None
        }
        "subagents" => {
            let spawn = json!({ "type": "collabAgentToolCall", "id": "co-1", "tool": "spawnAgent", "senderThreadId": thread,
                "receiverThreadIds": ["child-1"], "prompt": "Review the auth flow", "agentsStates": {} });
            out.notify("item/started", json!({ "threadId": thread, "turnId": turn_id, "item": spawn }));
            let mut spawned = spawn.clone();
            spawned["agentsStates"] = json!({ "child-1": { "status": "running", "message": null } });
            out.notify("item/completed", json!({ "threadId": thread, "turnId": turn_id, "item": spawned }));
            out.notify("item/agentMessage/delta", json!({ "threadId": thread, "turnId": turn_id, "itemId": "msg-1", "delta": "Spawned" }));
            complete(out, &turn, "completed");
            None
        }
        "unauthorized" => {
            out.notify("turn/completed", json!({ "threadId": thread, "turn": { "id": turn_id, "items": [], "status": "failed",
                "error": { "message": "unexpected status 401 Unauthorized", "codexErrorInfo": { "httpConnectionFailed": { "httpStatusCode": 401 } } } } }));
            None
        }
        "crash" => {
            eprintln!("boom: model unavailable");
            std::process::exit(3);
        }
        "fail" => {
            complete(out, &turn, "failed");
            None
        }
        _ => {
            for delta in ["Hel", "lo"] {
                out.notify("item/agentMessage/delta", json!({ "threadId": thread, "turnId": turn_id, "itemId": "msg-1", "delta": delta }));
            }
            complete(out, &turn, "completed");
            None
        }
    }
}

#[cfg(unix)]
fn close_fd(fd: i32) {
    extern "C" {
        fn close(fd: i32) -> i32;
    }
    // SAFETY: closes one of our own descriptors; nothing uses it afterwards.
    unsafe {
        close(fd);
    }
}

#[cfg(not(unix))]
fn close_fd(_fd: i32) {}

#[cfg(unix)]
fn close_stdout() {
    extern "C" {
        fn close(fd: i32) -> i32;
    }
    // SAFETY: closes our own stdout descriptor; nothing writes to it afterwards.
    unsafe {
        close(1);
    }
}

#[cfg(not(unix))]
fn close_stdout() {}

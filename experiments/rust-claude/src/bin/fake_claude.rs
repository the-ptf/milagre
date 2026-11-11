//! A scripted stand-in for the Claude Code CLI, for the integration tests only.
//!
//! `FAKE_CLAUDE_SCRIPT` names a JSON file holding an array of steps, each an object with one key:
//!   {"emit": <frame>}                  write one JSON line
//!   {"emit_raw": "text"}               write text as is (no newline added)
//!   {"emit_many": {"count": n, "frame": <frame>}}
//!   {"emit_argv": true}                write {"type":"fake_argv","argv":[...],"env":{...}}
//!   {"expect": {"type": t, "subtype": s, "echo": bool}}
//!                                      read the next stdin frame and check it (control_request
//!                                      subtypes are read from `request.subtype`); echo writes
//!                                      {"type":"fake_received","frame":...}
//!   {"expect_none_ms": n}              fail if a stdin frame arrives within n ms
//!   {"reply": <payload>} / {"reply_error": "msg"}
//!                                      answer the last expected control_request
//!   {"reply_to": {"name": n, "payload": p}} / {"reply_error_to": {"name": n, "error": e}}
//!                                      answer a request saved with "as": n in its expect step
//!   {"request": {"id": id, "request": {...}}}
//!   {"cancel": id}                     write control_cancel_request
//!   {"sleep_ms": n}
//!   {"exit": code}
//!   {"close_stdout": true}
//!   {"spawn_grandchild": "/path/pidfile"}  start `sleep 60` in this process group, write its pid
//!   {"ignore_sigterm": true}
//!   {"wait_eof": true}                 read stdin until EOF, then write {"type":"fake_eof"}
//! `FAKE_CLAUDE_NO_STDIN=1` never reads stdin (for backpressure tests); `FAKE_CLAUDE_STDIN_DELAY_MS=n`
//! starts reading it only after n ms.
//!   {"expect_skip": {"type": t}}       read frames, skipping `user` ones, until one of type t; writes
//!                                      {"type":"fake_received","frame":...,"skipped":n}
//! A failed check prints to stderr and exits with status 3. After the last step the fake waits for
//! stdin EOF and exits 0.

use std::io::{BufRead, Write};
use std::sync::mpsc;
use std::time::Duration;

use serde_json::{json, Value};

fn fail(message: String) -> ! {
    eprintln!("fake-claude: {message}");
    std::process::exit(3);
}

struct Out(Option<std::io::Stdout>);

impl Out {
    fn line(&mut self, value: &Value) {
        self.raw(&format!("{value}\n"));
    }

    fn raw(&mut self, text: &str) {
        if let Some(out) = self.0.as_mut() {
            let mut lock = out.lock();
            if lock.write_all(text.as_bytes()).and_then(|_| lock.flush()).is_err() {
                std::process::exit(4);
            }
        }
    }
}

fn main() {
    let path = std::env::var("FAKE_CLAUDE_SCRIPT").unwrap_or_else(|_| fail("FAKE_CLAUDE_SCRIPT is not set".into()));
    let script: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| fail(format!("{path}: {e}"))))
        .unwrap_or_else(|e| fail(format!("bad script: {e}")));

    // stdin lines arrive on a channel so a step can wait with a deadline.
    let (lines_tx, lines) = mpsc::channel::<Option<String>>();
    let read_stdin = std::env::var("FAKE_CLAUDE_NO_STDIN").is_err();
    let delay = std::env::var("FAKE_CLAUDE_STDIN_DELAY_MS").ok().and_then(|ms| ms.parse::<u64>().ok()).unwrap_or(0);
    if read_stdin {
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(delay));
            let stdin = std::io::stdin();
            for line in stdin.lock().lines() {
                match line {
                    Ok(line) => {
                        if lines_tx.send(Some(line)).is_err() {
                            return;
                        }
                    }
                    Err(_) => break,
                }
            }
            let _ = lines_tx.send(None);
        });
    } else {
        std::mem::forget(lines_tx);
    }

    let mut out = Out(Some(std::io::stdout()));
    let mut last: Value = Value::Null;
    let mut saved: std::collections::HashMap<String, Value> = Default::default();
    let mut eof = false;
    eprintln!("fake-claude: started");

    for step in script {
        let (key, arg) = step
            .as_object()
            .and_then(|o| o.iter().next())
            .map(|(k, v)| (k.clone(), v.clone()))
            .unwrap_or_else(|| fail("empty step".into()));
        match key.as_str() {
            "emit" => out.line(&arg),
            "emit_raw" => out.raw(arg.as_str().unwrap_or("")),
            "emit_many" => {
                let count = arg["count"].as_u64().unwrap_or(0);
                for index in 0..count {
                    let mut frame = arg["frame"].clone();
                    frame["index"] = json!(index);
                    out.line(&frame);
                }
            }
            "emit_argv" => {
                let keep = ["CLAUDE_CODE_ENTRYPOINT", "CLAUDECODE", "CLAUDE_CODE_ENABLE_TODO_TOOLS", "PWD", "CLAUDE_AGENT_SDK_VERSION"];
                let env: serde_json::Map<String, Value> =
                    std::env::vars().filter(|(k, _)| keep.contains(&k.as_str())).map(|(k, v)| (k, Value::String(v))).collect();
                let argv: Vec<String> = std::env::args().skip(1).collect();
                out.line(&json!({ "type": "fake_argv", "argv": argv, "env": env, "cwd": std::env::current_dir().ok() }));
            }
            "expect" => {
                let line = match lines.recv() {
                    Ok(Some(line)) => line,
                    _ => fail(format!("expected {arg} but stdin ended")),
                };
                let frame: Value = serde_json::from_str(&line).unwrap_or_else(|e| fail(format!("stdin frame is not JSON ({e}): {line}")));
                if let Some(kind) = arg.get("type").and_then(Value::as_str) {
                    if frame["type"] != kind {
                        fail(format!("expected type {kind}, got {line}"));
                    }
                }
                if let Some(subtype) = arg.get("subtype").and_then(Value::as_str) {
                    let actual =
                        if frame["type"] == "control_request" { &frame["request"]["subtype"] } else { &frame["response"]["subtype"] };
                    if actual != subtype {
                        fail(format!("expected subtype {subtype}, got {line}"));
                    }
                }
                if let Some(fields) = arg.get("fields").and_then(Value::as_object) {
                    for (pointer, expected) in fields {
                        if frame.pointer(pointer) != Some(expected) {
                            fail(format!("expected {pointer} = {expected}, got {frame}"));
                        }
                    }
                }
                if arg.get("echo") == Some(&Value::Bool(true)) {
                    out.line(&json!({ "type": "fake_received", "frame": frame }));
                }
                if let Some(name) = arg.get("as").and_then(Value::as_str) {
                    saved.insert(name.to_owned(), frame.clone());
                }
                last = frame;
            }
            // Match concurrent request/reply lanes in either order. Each expected map holds JSON
            // pointers and their exact values. Host controls are acknowledged automatically.
            "expect_pair" => {
                let mut wanted = arg.as_array().cloned().unwrap_or_default();
                let count = wanted.len();
                for _ in 0..count {
                    let line = lines.recv().ok().flatten().unwrap_or_else(|| fail("stdin ended".into()));
                    let frame: Value = serde_json::from_str(&line).unwrap_or_else(|e| fail(e.to_string()));
                    let index = wanted
                        .iter()
                        .position(|expected| {
                            expected.as_object().unwrap().iter().all(|(pointer, value)| frame.pointer(pointer) == Some(value))
                        })
                        .unwrap_or_else(|| fail(format!("unexpected concurrent frame: {frame}; wanted {wanted:?}")));
                    wanted.remove(index);
                    if frame["type"] == "control_request" {
                        out.line(&json!({"type":"control_response", "response":{"subtype":"success","request_id":frame["request_id"],"response":{}}}));
                    }
                }
            }
            "expect_skip" => {
                let kind = arg["type"].as_str().unwrap_or("");
                let mut skipped = 0;
                loop {
                    let line = match lines.recv() {
                        Ok(Some(line)) => line,
                        _ => fail(format!("stdin ended before a {kind} frame")),
                    };
                    let frame: Value = serde_json::from_str(&line).unwrap_or_else(|e| fail(format!("not JSON ({e})")));
                    if frame["type"] == kind {
                        out.line(&json!({ "type": "fake_received", "frame": frame, "skipped": skipped }));
                        last = frame;
                        break;
                    }
                    if frame["type"] != "user" {
                        fail(format!("expected {kind} or user, got {line}"));
                    }
                    skipped += 1;
                }
            }
            "expect_none_ms" => match lines.recv_timeout(Duration::from_millis(arg.as_u64().unwrap_or(0))) {
                Ok(Some(line)) => fail(format!("expected no frame, got {line}")),
                Ok(None) => eof = true,
                Err(_) => {}
            },
            "reply" | "reply_error" => {
                let id = last["request_id"].as_str().unwrap_or_else(|| fail(format!("{key} without a control_request: {last}"))).to_owned();
                let response = if key == "reply" {
                    json!({ "subtype": "success", "request_id": id, "response": arg })
                } else {
                    json!({ "subtype": "error", "request_id": id, "error": arg })
                };
                out.line(&json!({ "type": "control_response", "response": response }));
            }
            "reply_to" | "reply_error_to" => {
                let name = arg["name"].as_str().unwrap_or("");
                let frame = saved.get(name).unwrap_or_else(|| fail(format!("no saved frame {name}")));
                let id = frame["request_id"].clone();
                let response = if key == "reply_to" {
                    json!({ "subtype": "success", "request_id": id, "response": arg["payload"] })
                } else {
                    json!({ "subtype": "error", "request_id": id, "error": arg["error"] })
                };
                out.line(&json!({ "type": "control_response", "response": response }));
            }
            "request" => out.line(&json!({ "type": "control_request", "request_id": arg["id"], "request": arg["request"] })),
            "cancel" => out.line(&json!({ "type": "control_cancel_request", "request_id": arg })),
            "sleep_ms" => std::thread::sleep(Duration::from_millis(arg.as_u64().unwrap_or(0))),
            "exit" => std::process::exit(arg.as_i64().unwrap_or(0) as i32),
            "close_stdin" => {
                // Use with FAKE_CLAUDE_NO_STDIN=1 so no blocked reader retains the pipe.
                unsafe {
                    libc::close(0);
                }
            }
            "close_stdout" => {
                out.0 = None;
                // SAFETY: closing our own stdout descriptor.
                unsafe {
                    libc::close(1);
                }
            }
            "spawn_grandchild" => {
                let child = std::process::Command::new("sleep")
                    .arg("60")
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .unwrap_or_else(|e| fail(format!("spawn sleep: {e}")));
                if let Some(path) = arg.as_str() {
                    std::fs::write(path, child.id().to_string()).unwrap_or_else(|e| fail(format!("{path}: {e}")));
                }
                out.line(&json!({ "type": "fake_grandchild", "pid": child.id() }));
                std::mem::forget(child);
            }
            "ignore_sigterm" => {
                // SAFETY: setting a signal disposition for this process.
                unsafe {
                    libc::signal(libc::SIGTERM, libc::SIG_IGN);
                }
            }
            "wait_eof" => {
                while !eof {
                    match lines.recv() {
                        Ok(Some(_)) => {}
                        _ => eof = true,
                    }
                }
                out.line(&json!({ "type": "fake_eof" }));
            }
            other => fail(format!("unknown step {other}")),
        }
    }
    while !eof {
        match lines.recv() {
            Ok(Some(_)) => {}
            _ => eof = true,
        }
    }
}

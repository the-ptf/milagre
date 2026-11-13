//! Deterministic ACP fake and transport fault injector. Never accesses profiles or the network.
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;
#[derive(Clone)]
struct Out(Arc<Mutex<Option<std::io::Stdout>>>);

impl Out {
    fn send(&self, message: &Value) {
        let mut message = message.clone();
        message["jsonrpc"] = "2.0".into();
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

fn main() {
    let scenario = std::env::var("FAKE_SCENARIO").unwrap_or_default();
    if let Ok(file) = std::env::var("FAKE_PID_FILE") {
        std::fs::write(file, std::process::id().to_string()).unwrap();
    }
    let out = Out(Arc::new(Mutex::new(Some(std::io::stdout()))));
    let received: Arc<Mutex<Vec<Value>>> = Arc::default();
    let mut prompt = None;
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
        received.lock().unwrap().push(message.clone());
        let id = message.get("id").cloned().unwrap_or(Value::Null);
        let params = message.get("params").cloned().unwrap_or(json!({}));
        let Some(method) = message["method"].as_str() else {
            out.notify("fake/answered", json!({"id":id,"answer":message.get("result").or_else(||message.get("error"))}));
            continue;
        };
        match method {
            "initialize" if scenario=="hang-init"=>{},
            "initialize" => out.reply(&id,json!({"protocolVersion":1,"agentInfo":{"name":"fake-acp"},"agentCapabilities":{"loadSession":true,"sessionCapabilities":{"resume":true}},"authMethods":[{"id":"oauth-personal","name":"Fake"}]})),
            "authenticate"=>out.reply(&id,json!({})),
            "session/new"|"session/resume"|"session/load" if scenario=="logged-out"=>out.error(&id,-32000,"Authentication required"),
            "session/new"|"session/resume"|"session/load"=>out.reply(&id,json!({"sessionId":params.get("sessionId").unwrap_or(&json!("session-1"))})),
            "session/set_mode"|"session/set_config_option"=>out.reply(&id,json!({})),
            "session/prompt"=>{
                if scenario=="slow"||scenario=="stubborn" {prompt=Some(id);continue;}
                out.notify("session/update",json!({"sessionId":params["sessionId"],"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello"}}}));
                out.reply(&id,json!({"stopReason":"end_turn"}));
            },
            "session/cancel"=>{if scenario!="stubborn" {if let Some(id)=prompt.take(){out.reply(&id,json!({"stopReason":"cancelled"}));}}},
            "fake/raw"=>{out.raw(params["line"].as_str().unwrap());out.raw("\n");out.reply(&id,json!({}));},
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
                // Stops reading stdin (this loop) for a while, as a wedged ACP agent would.
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
                    out.send(&json!({ "id": format!("flood-{n}"), "method": "session/request_permission", "params": {} }));
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
            "fake/stderr-long" => {
                eprint!("{}", "x".repeat(params["bytes"].as_u64().unwrap() as usize));
                out.reply(&id,json!({}));
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
                #[cfg(unix)]
                unsafe { libc::close(0); }
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
            _ if message.get("id").is_none()=>{},
            other=>out.error(&id,-32601,&format!("unknown method {other}")),
        }
    }
}
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

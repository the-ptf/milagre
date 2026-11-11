//! The daemon surface for ports, as runtime.cjs registers it. Commands take positional arguments:
//! `agent:ports()` -> every Chat's ports, `chat:ports(chatId)` -> `{ chatId, ports }`,
//! `agent:stop-port(chatId, pid)` -> boolean (the renderer is untrusted: anything malformed is just `false`).
//! Changes go out as the `agent:ports` event with every Chat's ports.

use serde_json::{json, Value};

use crate::owner::ChatPorts;
use crate::watcher::PortWatcher;

pub const COMMANDS: [&str; 3] = ["agent:ports", "chat:ports", "agent:stop-port"];
pub const EVENT: &str = "agent:ports";

/// The `agent:ports` event for a published change.
pub fn event(ports: &ChatPorts) -> (&'static str, Value) {
    (EVENT, serde_json::to_value(ports).expect("ports serialize"))
}

/// `Number.isInteger(value)` as an i64 (None for non-integers and integers beyond i64, which no listed pid matches).
fn integer(value: &Value) -> Option<i64> {
    let number = value.as_number()?;
    number.as_i64().or_else(|| number.as_f64().filter(|f| f.is_finite() && f.fract() == 0.0 && f.abs() < 9.2e18).map(|f| f as i64))
}

fn is_integer(value: &Value) -> bool {
    value.as_number().is_some_and(|n| n.is_i64() || n.is_u64() || n.as_f64().is_some_and(|f| f.is_finite() && f.fract() == 0.0))
}

pub async fn handle(watcher: &PortWatcher, command: &str, args: &[Value]) -> Result<Value, String> {
    match command {
        "agent:ports" => Ok(serde_json::to_value(watcher.snapshot()).expect("ports serialize")),
        "chat:ports" => match args.first() {
            Some(Value::String(chat_id)) if !chat_id.is_empty() => Ok(json!({ "chatId": chat_id, "ports": watcher.chat_ports(chat_id) })),
            _ => Err("A Chat is required to list ports.".into()),
        },
        "agent:stop-port" => match (args.first(), args.get(1)) {
            (Some(Value::String(chat_id)), Some(pid)) if is_integer(pid) => match integer(pid) {
                Some(_) if !watcher.supports_stop() => {
                    Err("Stopping ports on Windows is unsupported without a process-tree stopper.".into())
                }
                Some(pid) => Ok(Value::Bool(watcher.stop_port(chat_id, pid).await)),
                None => Ok(Value::Bool(false)),
            },
            _ => Ok(Value::Bool(false)),
        },
        other => Err(format!("Unknown ports command: {other}")),
    }
}

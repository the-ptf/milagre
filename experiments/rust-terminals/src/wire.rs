//! The daemon command surface for Terminals: `terminal:list|profiles|setShell|open|read|input|resize|close`, as
//! runtime.cjs registers them and command-contracts.json declares them (T49-T55). Requests arrive as JSON and are
//! validated with the Node rules (`Number.isSafeInteger`, `typeof x === "string"`, `== null`), so a Rust owner answers
//! the same requests the same way. Responses serialize to the Node shapes; `resize` and `close` answer `null`.

use serde_json::{json, Value};

use crate::terminals::{OpenRequest, Result, TerminalError, Terminals, MAX_SAFE_INTEGER};

pub const COMMANDS: [&str; 8] = [
    "terminal:list",
    "terminal:profiles",
    "terminal:setShell",
    "terminal:open",
    "terminal:read",
    "terminal:input",
    "terminal:resize",
    "terminal:close",
];

/// Who sent the command. Every Terminal command but `terminal:list` needs an authenticated connection.
#[derive(Clone, Debug, Default)]
pub struct CommandContext {
    pub client_id: Option<String>,
}

/// `Number.isSafeInteger(value)`.
pub fn safe_integer(value: &Value) -> Option<i64> {
    let number = value.as_number()?;
    if let Some(i) = number.as_i64() {
        return (i.unsigned_abs() <= MAX_SAFE_INTEGER).then_some(i);
    }
    if number.as_u64().is_some() {
        return None;
    }
    let f = number.as_f64()?;
    (f.is_finite() && f.fract() == 0.0 && f.abs() <= MAX_SAFE_INTEGER as f64).then_some(f as i64)
}

fn field<'a>(request: &'a Value, key: &str) -> Option<&'a Value> {
    request.as_object()?.get(key)
}

fn string_field<'a>(request: &'a Value, key: &str) -> Option<&'a str> {
    field(request, key)?.as_str()
}

fn chat_id(request: &Value) -> Result<String> {
    match string_field(request, "chatId") {
        Some(chat) if !chat.is_empty() => Ok(chat.to_owned()),
        _ => Err(TerminalError::new("A Chat is required.")),
    }
}

fn to_value<T: serde::Serialize>(value: T) -> Value {
    serde_json::to_value(value).expect("Terminal responses serialize")
}

/// Answers one Terminal command. `Err` carries the message the daemon sends as the command's error.
pub async fn handle(terminals: &Terminals, command: &str, request: &Value, context: &CommandContext) -> Result<Value> {
    if command != "terminal:list" && COMMANDS.contains(&command) && context.client_id.as_deref().is_none_or(str::is_empty) {
        return Err(TerminalError::new("Terminal access requires an authenticated connection"));
    }
    match command {
        "terminal:list" => Ok(to_value(terminals.list(&chat_id(request)?).await?)),
        "terminal:profiles" => Ok(to_value(terminals.profiles().await)),
        "terminal:setShell" => {
            let shell = match field(request, "shell") {
                Some(Value::Null) => None,
                Some(Value::String(file)) => Some(file.clone()),
                _ if terminals.closed() => return Err(TerminalError::new("Terminals are closed.")),
                _ => return Err(TerminalError::new("Choose an installed shell.")),
            };
            Ok(to_value(terminals.set_shell(shell).await?))
        }
        "terminal:open" => {
            let chat_id = chat_id(request)?;
            let cwd = match field(request, "cwd") {
                None | Some(Value::Null) => None,
                Some(Value::String(cwd)) => Some(cwd.clone()),
                // Not one of the Chat's Worktree paths, whatever it is.
                Some(_) => Some(String::from("\u{0}")),
            };
            let size = |key| field(request, key).and_then(safe_integer).and_then(|n| u64::try_from(n).ok());
            let open = OpenRequest { chat_id, cwd, cols: size("cols"), rows: size("rows") };
            Ok(to_value(terminals.open(open).await?))
        }
        "terminal:read" => {
            let invalid = || TerminalError::new("Invalid Terminal read.");
            let after = field(request, "after").and_then(safe_integer).filter(|after| *after >= 0).ok_or_else(invalid)? as u64;
            let limit = match field(request, "limit") {
                None => None,
                Some(value) => Some(safe_integer(value).filter(|limit| *limit >= 0).ok_or_else(invalid)? as u64),
            };
            let terminal_id = string_field(request, "terminalId").unwrap_or("");
            Ok(to_value(terminals.read(terminal_id, after, limit).await?))
        }
        "terminal:input" => {
            let terminal_id = string_field(request, "terminalId").unwrap_or("");
            match field(request, "data") {
                Some(Value::String(data)) => Ok(to_value(terminals.input(terminal_id, data).await?)),
                // The Terminal is checked before the data, as in Node.
                _ => {
                    terminals.check(terminal_id)?;
                    Err(TerminalError::new("Invalid Terminal input."))
                }
            }
        }
        "terminal:resize" => {
            let terminal_id = string_field(request, "terminalId").unwrap_or("");
            let size = |key| field(request, key).and_then(safe_integer);
            match (size("cols"), size("rows")) {
                (Some(cols), Some(rows)) if cols >= 0 && rows >= 0 => terminals.resize(terminal_id, cols as u64, rows as u64).await?,
                _ => {
                    // Unknown Terminals fail first; otherwise the size is invalid.
                    terminals.resize(terminal_id, 0, 0).await?;
                }
            }
            Ok(Value::Null)
        }
        "terminal:close" => {
            terminals.close(string_field(request, "terminalId").unwrap_or("")).await?;
            Ok(Value::Null)
        }
        other => Err(TerminalError::new(format!("Unknown Terminal command: {other}"))),
    }
}

/// The JSON shape of a `terminal:changed` event, for owners that forward [`crate::TerminalEvent`]s themselves.
pub fn changed_event(chat_id: &str) -> Value {
    json!({ "chatId": chat_id })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_integers_follow_javascript() {
        assert_eq!(safe_integer(&json!(80)), Some(80));
        assert_eq!(safe_integer(&json!(80.0)), Some(80));
        assert_eq!(safe_integer(&json!(80.5)), None);
        assert_eq!(safe_integer(&json!(-3)), Some(-3));
        assert_eq!(safe_integer(&json!(9007199254740992u64)), None);
        assert_eq!(safe_integer(&json!("80")), None);
        assert_eq!(safe_integer(&Value::Null), None);
    }
}

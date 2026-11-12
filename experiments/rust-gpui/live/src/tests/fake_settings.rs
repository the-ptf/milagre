//! The fake daemon's Settings commands ([`crate::settings`]), with the Node daemon's answers: `context:settings:*`
//! (`ContextSettings`), `done:settings:*`, `linked:remote-enabled:*` and `device-notes:*` (`{enabled}`),
//! `app-update:auto:*` (`{autoUpdate}`), `app:version`, `app:set-keep-awake`, `keybindings:*` (`{path, rules,
//! issues}`, a command's rules replaced and added last, as `packages/core/src/keybindings.cjs` does), `main-sync:default:*`
//! (`{syncMain}`) and `storage:*` (three idle worktrees; `keep` is refused). A write is refused
//! with `settings["refuse"]` when it is set.

use serde_json::{Value, json};

pub const METHODS: &[&str] = &[
    "app:version",
    "app:set-keep-awake",
    "context:settings:read",
    "context:settings:save",
    "done:settings:read",
    "done:settings:save",
    "linked:remote-enabled:read",
    "linked:remote-enabled:save",
    "device-notes:read",
    "device-notes:save",
    "app-update:auto:read",
    "app-update:auto:save",
    "keybindings:read",
    "keybindings:set-command",
    "keybindings:reset",
    "main-sync:default:read",
    "main-sync:default:save",
    "storage:worktrees",
    "storage:remove-worktree",
];

/// The fake's defaults: not the Node daemon's own, so a test sees they were read.
pub fn defaults() -> Value {
    json!({
        "context": {"buttonThreshold": 60, "autoThreshold": 80, "autoCompact": true, "followUps": "queue"},
        "done": {"retentionHours": 72},
        "remote": true,
        "notes": true,
        "autoUpdate": true,
        "keepAwake": null,
        "keys": default_keys(),
        "syncMain": false,
        "idle": [idle("old", true), idle("dirty", false), idle("keep", true)],
    })
}

/// An idle worktree as `storage:worktrees` lists it (`keep` is refused on removal).
fn idle(title: &str, clean: bool) -> Value {
    let day = 24 * 60 * 60_000i64;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
    json!({"projectPath": "/fake-node/alpha", "projectName": "alpha", "path": format!("/fake/worktrees/{title}"),
        "branch": format!("milagre/{title}"), "title": title, "chats": 1, "lastAt": now - 45 * day, "idleBefore": now - 30 * day,
        "activity": {"worktreeId": 2, "chats": [{"id": 1, "lastAt": now - 45 * day, "lastId": 3, "count": 2}]},
        "bytes": 1.0e9, "status": {"uncommitted": if clean { 0 } else { 2 }, "unpushed": 0, "branch": format!("milagre/{title}"),
        "head": "abc", "removable": clean}})
}

fn default_keys() -> Value {
    json!({"path": "/fake/keybindings.json", "rules": [
        {"key": "mod+n", "command": "chat.new"},
        {"key": "mod+,", "command": "settings.open"},
        {"key": "mod+shift+t", "command": "theme.toggle", "when": "!terminalFocus"}], "issues": []})
}

pub fn call(state: &mut Value, method: &str, args: &Value) -> Result<Value, String> {
    if state.is_null() {
        *state = defaults();
    }
    let arg = &args[0];
    if !method.ends_with(":read")
        && !matches!(method, "app:version" | "storage:worktrees")
        && let Some(message) = state["refuse"].as_str()
    {
        return Err(message.to_owned());
    }
    Ok(match method {
        "app:version" => json!("9.9.9-fake"),
        "app:set-keep-awake" => {
            state["keepAwake"] = json!(arg == true);
            Value::Null
        }
        "context:settings:read" => state["context"].clone(),
        "context:settings:save" => {
            for (key, value) in arg.as_object().ok_or("patch")? {
                state["context"][key] = value.clone();
            }
            state["context"].clone()
        }
        "done:settings:read" => state["done"].clone(),
        "done:settings:save" => {
            state["done"]["retentionHours"] = arg["retentionHours"].clone();
            state["done"].clone()
        }
        "linked:remote-enabled:read" => json!({"enabled": state["remote"]}),
        "linked:remote-enabled:save" => {
            state["remote"] = json!(arg.as_bool().ok_or("Remote delegation enabled must be a boolean.")?);
            json!({"enabled": state["remote"]})
        }
        "device-notes:read" => json!({"enabled": state["notes"]}),
        "device-notes:save" => {
            state["notes"] = json!(arg.as_bool().ok_or("Device notes enabled must be a boolean.")?);
            json!({"enabled": state["notes"]})
        }
        "app-update:auto:read" => json!({"autoUpdate": state["autoUpdate"]}),
        "app-update:auto:save" => {
            state["autoUpdate"] = json!(arg == true);
            json!({"autoUpdate": state["autoUpdate"]})
        }
        "keybindings:read" => state["keys"].clone(),
        "main-sync:default:read" => json!({"syncMain": state["syncMain"]}),
        "main-sync:default:save" => {
            state["syncMain"] = json!(arg == true);
            json!({"syncMain": state["syncMain"]})
        }
        "storage:worktrees" => json!({"worktrees": state["idle"], "measuredAt": null}),
        "storage:remove-worktree" => {
            let path = arg["path"].as_str().ok_or("An absolute worktree path is required.")?.to_owned();
            if path.ends_with("/keep") {
                return Err("It has a running Terminal, so it is kept.".into());
            }
            let list = state["idle"].as_array_mut().ok_or("idle")?;
            list.retain(|item| item["path"] != path.as_str());
            json!({"removed": true, "alreadyRemoved": false, "branch": null, "branchDeleted": false})
        }
        "keybindings:set-command" => {
            let command = arg.as_str().ok_or("command")?.to_owned();
            let rules = state["keys"]["rules"].as_array_mut().ok_or("rules")?;
            rules.retain(|rule| rule["command"] != command.as_str());
            for rule in args[1].as_array().ok_or("rules")? {
                let mut next = json!({"key": rule["key"], "command": command});
                if let Some(when) = rule["when"].as_str() {
                    next["when"] = json!(when);
                }
                rules.push(next);
            }
            state["keys"].clone()
        }
        "keybindings:reset" => {
            state["keys"] = default_keys();
            state["keys"].clone()
        }
        other => return Err(format!("unexpected {other}")),
    })
}

//! The fake daemon's Settings commands ([`crate::settings`]), with the Node daemon's answers: `context:settings:*`
//! (`ContextSettings`), `done:settings:*`, `linked:remote-enabled:*` and `device-notes:*` (`{enabled}`),
//! `app-update:auto:*` (`{autoUpdate}`), `app:version`, `app:set-keep-awake`, `keybindings:*` (`{path, rules,
//! issues}`, a command's rules replaced and added last, as `packages/core/src/keybindings.cjs` does), `main-sync:default:*`
//! (`{syncMain}`) and `storage:*` (three idle worktrees; `keep` is refused). Settings' pages ([`crate::settings`]'s
//! host): `skills:*` (three skills, one hiding another; `gone.md` cannot be read), `linear:*` (one workspace; Connect
//! adds another, as a finished browser sign-in does), `babysit:settings:*` (a patch over `BABYSIT_DEFAULTS`),
//! `phone:*` and `devices:*` (on through the relay, two phones and a computer, one new; Reset makes a new code and
//! forgets every device), `computer:resources:read`, and per Project `main-sync:*`, `project-git:*` (alpha's
//! repository fixes the base branch), `files-to-copy:*` (four ignored files) and `worktree-setup:*`. A write is refused
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
    "skills:list",
    "skills:read",
    "linear:enabled:read",
    "linear:enabled:save",
    "linear:move-to-started:save",
    "linear:status",
    "linear:connect",
    "linear:disconnect",
    "babysit:settings:read",
    "babysit:settings:save",
    "phone:status",
    "phone:set-enabled",
    "phone:set-lan",
    "phone:open-pairing",
    "phone:reset",
    "devices:list",
    "devices:remove",
    "devices:acknowledge",
    "computer:resources:read",
    "main-sync:read",
    "main-sync:save",
    "project-git:read",
    "project-git:save",
    "files-to-copy:read",
    "files-to-copy:preview",
    "files-to-copy:save",
    "worktree-setup:read",
    "worktree-setup:save",
];

/// The reads among [`METHODS`] (no refusal applies).
fn is_read(method: &str) -> bool {
    method.ends_with(":read")
        || matches!(
            method,
            "app:version"
                | "storage:worktrees"
                | "skills:list"
                | "linear:status"
                | "phone:status"
                | "devices:list"
                | "files-to-copy:preview"
        )
}

/// A pairing code: the link and an SVG for it.
fn code(n: u64) -> (String, String) {
    (
        format!("https://relay.milagre.cloud/pair#k=fake{n}"),
        format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 29" width="29" height="29"><rect width="29" height="29" fill="white"/><rect x="2" y="2" width="7" height="7" fill="black"/><rect x="20" y="2" width="7" height="7" fill="black"/><rect x="2" y="20" width="7" height="7" fill="black"/><rect x="{n}" y="12" width="3" height="3" fill="black"/></svg>"#
        ),
    )
}

fn phone(state: &Value) -> Value {
    let enabled = state["phone"]["enabled"] == true;
    let mut status = json!({"enabled": enabled, "state": if enabled { "on" } else { "off" }, "remote": "relay",
        "relay": "online", "lan": {"enabled": state["phone"]["lan"], "addresses": ["192.168.1.40"]}});
    if enabled {
        let (link, svg) = code(state["phone"]["code"].as_u64().unwrap_or(1));
        status["pairingLink"] = json!(link);
        status["computerLink"] = json!(format!("{link}&c=1"));
        status["qrSvg"] = json!(svg);
        status["pairingUntil"] = state["phone"]["until"].clone();
        status["pairingOptions"] = json!([{"id": "automatic", "label": "Automatic", "link": format!("{link}&c=1"), "qrSvg": svg},
            {"id": "relay", "label": "Remote relay", "link": link, "qrSvg": svg}]);
    }
    status
}

fn linear_status(state: &Value) -> Value {
    let workspaces = state["linear"]["workspaces"].clone();
    match workspaces.as_array().and_then(|list| list.first()) {
        Some(first) => {
            json!({"connected": true, "viewer": first["viewer"], "organization": first["organization"], "workspaces": workspaces})
        }
        None => json!({"connected": false, "workspaces": []}),
    }
}

fn workspace(id: &str, name: &str, can_write: bool) -> Value {
    json!({"id": id, "viewer": {"name": "Fake Viewer"}, "organization": {"name": name, "urlKey": id}, "canWrite": can_write})
}

/// A Project's per-path settings (made on first use).
fn project<'a>(state: &'a mut Value, path: &str) -> &'a mut Value {
    if state["projects"][path].is_null() {
        let repository = if path.ends_with("/alpha") { json!({"baseBranch": "develop"}) } else { json!({}) };
        state["projects"][path] = json!({"override": null, "git": {}, "repository": repository, "files": [".env*"],
            "setup": "npm ci"});
    }
    &mut state["projects"][path]
}

fn git(entry: &Value) -> Value {
    let defaults = json!({"template": "", "username": "", "dashesOnly": false, "baseBranch": "", "trackBase": false, "instructions": ""});
    let mut effective = defaults;
    for layer in [&entry["git"], &entry["repository"]] {
        for (key, value) in layer.as_object().into_iter().flatten() {
            effective[key] = value.clone();
        }
    }
    json!({"local": entry["git"], "repository": entry["repository"], "effective": effective})
}

const IGNORED: [&str; 4] = [".env", ".env.local", "config/secrets.json", "node_modules/.cache/x"];

fn files(patterns: &Value) -> Value {
    let list: Vec<String> = patterns.as_array().into_iter().flatten().filter_map(|p| p.as_str().map(str::to_owned)).collect();
    let used: Vec<String> = if list.is_empty() { vec![".env*".into()] } else { list.clone() };
    let matches: Vec<&str> = IGNORED
        .iter()
        .copied()
        .filter(|file| used.iter().any(|p| p.strip_suffix('*').map_or(*file == p.as_str(), |prefix| file.starts_with(prefix))))
        .collect();
    json!({"source": if list.is_empty() { "default" } else { "setting" }, "worktreeInclude": null, "matches": matches, "filesToCopy": list})
}

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
        "linear": {"enabled": true, "moveToStarted": true, "workspaces": [workspace("fake", "Fake Org", true)], "added": 0},
        "babysit": {},
        "phone": {"enabled": true, "lan": true, "code": 1, "until": now_ms() + 9 * 60_000},
        "devices": [
            {"key": "p1", "kind": "phone", "name": "Fake iPhone", "pairedAt": 1, "lastSeen": now_ms(), "route": "relay"},
            {"key": "p2", "kind": "phone", "name": null, "pairedAt": 1, "lastSeen": null, "isNew": true, "route": null},
            {"key": "c1", "kind": "computer", "name": "fake-mini", "pairedAt": 1, "lastSeen": now_ms(), "route": "lan"}],
        "acknowledged": [],
        "projects": {},
    })
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
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
    if !is_read(method)
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
        "skills:list" => {
            let root = arg.as_str().ok_or("projectPath")?;
            let skill = |name: &str, scope: &str, provider: &str, path: String| json!({"name": name, "description": format!("Fake {name} skill."), "path": path, "scope": scope, "provider": provider});
            json!({"skills": [
                    skill("tidy", "workspace", "claude", format!("{root}/.claude/skills/tidy/SKILL.md")),
                    skill("ship", "user", "codex", "/fake-home/.codex/skills/ship/SKILL.md".into()),
                    skill("gone", "user", "claude", "/fake-home/.claude/skills/gone.md".into())],
                "shadowed": [{"name": "tidy", "description": "Older tidy.", "path": "/fake-home/.claude/skills/tidy/SKILL.md",
                    "scope": "user", "provider": "claude", "shadowedBy": format!("{root}/.claude/skills/tidy/SKILL.md")}],
                "warnings": ["/fake-home/.claude/skills/broken/SKILL.md: the description is missing"]})
        }
        "skills:read" => {
            let file = args[1].as_str().ok_or("file")?;
            if file.ends_with("gone.md") {
                return Err("ENOENT: no such file".into());
            }
            json!(format!("---\nname: fake\ndescription: Fake\n---\n\n# Fake skill\n\nRead from {file}.\n"))
        }
        "linear:enabled:read" => json!({"enabled": state["linear"]["enabled"], "moveToStarted": state["linear"]["moveToStarted"]}),
        "linear:enabled:save" => {
            state["linear"]["enabled"] = json!(arg == true);
            json!({"enabled": state["linear"]["enabled"]})
        }
        "linear:move-to-started:save" => {
            state["linear"]["moveToStarted"] = json!(arg == true);
            json!({"moveToStarted": state["linear"]["moveToStarted"]})
        }
        "linear:status" => linear_status(state),
        "linear:connect" => {
            if arg["window"] != false {
                return Err("Only the browser sign-in is expected.".into());
            }
            let n = state["linear"]["added"].as_u64().unwrap_or(0) + 1;
            state["linear"]["added"] = json!(n);
            let added = workspace(&format!("added-{n}"), &format!("Added Org {n}"), true);
            state["linear"]["workspaces"].as_array_mut().ok_or("workspaces")?.push(added);
            linear_status(state)
        }
        "linear:disconnect" => {
            let id = arg["workspace"].as_str().ok_or("workspace")?.to_owned();
            state["linear"]["workspaces"].as_array_mut().ok_or("workspaces")?.retain(|w| w["id"] != id.as_str());
            linear_status(state)
        }
        "babysit:settings:read" => state["babysit"].clone(),
        "babysit:settings:save" => {
            for (key, value) in arg.as_object().ok_or("patch")? {
                state["babysit"][key] = value.clone();
            }
            state["babysit"].clone()
        }
        "phone:status" => phone(state),
        "phone:set-enabled" => {
            state["phone"]["enabled"] = json!(arg == true);
            phone(state)
        }
        "phone:set-lan" => {
            state["phone"]["lan"] = json!(arg == true);
            phone(state)
        }
        "phone:open-pairing" => {
            state["phone"]["until"] = json!(now_ms() + 10 * 60_000);
            phone(state)
        }
        "phone:reset" => {
            state["phone"]["code"] = json!(state["phone"]["code"].as_u64().unwrap_or(1) + 1);
            state["devices"] = json!([]);
            phone(state)
        }
        "devices:list" => state["devices"].clone(),
        "devices:remove" => {
            let key = arg.as_str().ok_or("key")?.to_owned();
            state["devices"].as_array_mut().ok_or("devices")?.retain(|d| d["key"] != key.as_str());
            state["devices"].clone()
        }
        "devices:acknowledge" => {
            for key in arg.as_array().ok_or("keys")? {
                state["acknowledged"].as_array_mut().ok_or("acknowledged")?.push(key.clone());
                for device in state["devices"].as_array_mut().ok_or("devices")? {
                    if device["key"] == *key {
                        device["isNew"] = json!(false);
                    }
                }
            }
            Value::Null
        }
        "computer:resources:read" => json!({
            "memory": {"total": 32.0e9, "available": 20.0e9, "milagre": 2.5e9, "parts": [{"kind": "claude", "bytes": 1.5e9, "count": 2}, {"kind": "app", "bytes": 1.0e9, "count": 0}]},
            "disk": {"total": 1.0e12, "available": 4.0e11, "milagre": 3.0e10, "measuredAt": 1, "measuring": false,
                "parts": [{"kind": "worktrees", "bytes": 2.0e10, "count": 3}, {"kind": "speech", "bytes": 1.0e10, "count": 0}]}}),
        "main-sync:read" | "main-sync:save" => {
            let path = arg.as_str().ok_or("projectPath")?.to_owned();
            let default = state["syncMain"] == true;
            let entry = project(state, &path);
            if method == "main-sync:save" {
                if !(args[1].is_null() || args[1].is_boolean()) {
                    return Err("override".into());
                }
                entry["override"] = args[1].clone();
            }
            json!({"branch": "main", "override": entry["override"], "defaultValue": default, "enabled": entry["override"].as_bool().unwrap_or(default),
                "last": {"at": now_ms() - 60_000, "outcome": "up-to-date", "branch": "main"}})
        }
        "project-git:read" => git(project(state, arg.as_str().ok_or("projectPath")?)),
        "project-git:save" => {
            let entry = project(state, arg.as_str().ok_or("projectPath")?);
            entry["git"] = args[1].clone();
            git(entry)
        }
        "files-to-copy:read" => files(&project(state, arg.as_str().ok_or("projectPath")?)["files"].clone()),
        "files-to-copy:preview" => files(&args[1]),
        "files-to-copy:save" => {
            let entry = project(state, arg.as_str().ok_or("projectPath")?);
            entry["files"] = args[1].clone();
            files(&args[1])
        }
        "worktree-setup:read" | "worktree-setup:save" => {
            let entry = project(state, arg.as_str().ok_or("projectPath")?);
            if method == "worktree-setup:save" {
                entry["setup"] = json!(args[1].as_str().ok_or("command")?.trim());
            }
            let command = entry["setup"].as_str().unwrap_or_default().to_owned();
            json!({"setupCommand": command, "source": if command.is_empty() { "none" } else { "setting" },
                "command": if command.is_empty() { Value::Null } else { json!(command) }})
        }
        other => return Err(format!("unexpected {other}")),
    })
}

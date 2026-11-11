//! Native window services and an isolated preference overlay.
//! Electron remains the owner of its preferences while both apps coexist.
use serde_json::{json, Map, Value};
use std::{fs, path::PathBuf, sync::Mutex};
use tauri::{AppHandle, Manager};

pub struct Preferences(Mutex<Map<String, Value>>);
fn profile() -> Result<PathBuf, Value> {
    Ok(
        PathBuf::from(std::env::var("HOME").map_err(|e| error(&e.to_string()))?)
            .join("Library/Application Support/Milagre"),
    )
}
fn overlay() -> Result<PathBuf, Value> {
    Ok(profile()?
        .with_file_name("com.milagre.rust-poc")
        .join("preferences.json"))
}
fn error(message: &str) -> Value {
    json!({"code":"NATIVE_ERROR","message":message})
}
fn read_map(path: &PathBuf) -> Result<Map<String, Value>, Value> {
    match fs::read_to_string(path) {
        Ok(text) => {
            let mut values: Map<String, Value> = match serde_json::from_str(&text) {
                Ok(values) => values,
                Err(parse_error) => {
                    // Only quarantine our own overlay. Electron retains ownership of its file.
                    if overlay().is_ok_and(|own| own == *path) {
                        let quarantine =
                            path.with_extension(format!("corrupt-{}", std::process::id()));
                        fs::rename(path, quarantine).map_err(|e| error(&e.to_string()))?;
                    }
                    eprintln!("Preferences unreadable; using defaults: {parse_error}");
                    Map::new()
                }
            };
            values.retain(|_, value| value.is_string() || value.is_null());
            Ok(values)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
        Err(e) => Err(error(&e.to_string())),
    }
}
fn prune_inherited(overrides: &mut Map<String, Value>, base: &Map<String, Value>) {
    overrides.retain(|key, value| base.get(key) != Some(value));
}
fn save_overlay(values: &Map<String, Value>) -> Result<(), Value> {
    let file = overlay()?;
    fs::create_dir_all(file.parent().unwrap()).map_err(|e| error(&e.to_string()))?;
    static NEXT_TEMP: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let temp = file.with_extension(format!(
        "{}-{}.tmp",
        std::process::id(),
        NEXT_TEMP.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut writer = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temp)
        .map_err(|e| error(&e.to_string()))?;
    writer
        .write_all(serde_json::to_string(values).unwrap().as_bytes())
        .map_err(|e| error(&e.to_string()))?;
    writer.sync_all().map_err(|e| error(&e.to_string()))?;
    drop(writer);
    if let Err(e) = fs::rename(&temp, file) {
        let _ = fs::remove_file(temp);
        return Err(error(&e.to_string()));
    }
    Ok(())
}
impl Preferences {
    pub fn new() -> Result<Self, Value> {
        let mut values = read_map(&overlay()?)?;
        let base = read_map(&profile()?.join("preferences.json"))?;
        let before = values.len();
        prune_inherited(&mut values, &base);
        if values.len() != before {
            save_overlay(&values)?;
        }
        Ok(Self(Mutex::new(values)))
    }
    pub fn read(&self) -> Result<Value, Value> {
        let mut values = read_map(&profile()?.join("preferences.json"))?;
        let mut overrides = self
            .0
            .lock()
            .map_err(|_| error("Preferences lock poisoned"))?;
        let before = overrides.len();
        prune_inherited(&mut overrides, &values);
        if overrides.len() != before {
            save_overlay(&overrides)?;
        }
        values.extend(overrides.clone());
        Ok(Value::Object(values))
    }
    pub fn write(&self, key: String, value: Value) -> Result<(), Value> {
        if !(key.starts_with("milagre-")
            || key.starts_with("milagre.")
            || key.starts_with("milagre:"))
            || !(value.is_string() || value.is_null())
        {
            return Err(error("Invalid preference"));
        }
        let mut values = self
            .0
            .lock()
            .map_err(|_| error("Preferences lock poisoned"))?;
        let mut next = values.clone();
        let base = read_map(&profile()?.join("preferences.json"))?;
        if base.get(&key) == Some(&value) {
            next.remove(&key);
        } else {
            next.insert(key, value);
        }
        prune_inherited(&mut next, &base);
        save_overlay(&next)?;
        *values = next;
        Ok(())
    }
}

fn background() -> bool {
    std::env::var("MILAGRE_BACKGROUND").is_ok_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes"
        )
    })
}

fn electron_desktop_running() -> bool {
    // Both shells receive the same owner events. During coexistence the installed
    // Electron desktop keeps system-notification ownership, avoiding two chimes.
    use objc2_app_kit::NSRunningApplication;
    use objc2_foundation::NSString;
    !NSRunningApplication::runningApplicationsWithBundleIdentifier(&NSString::from_str(
        "com.milagre.app",
    ))
    .is_empty()
}

#[derive(Clone)]
struct Editor {
    id: &'static str,
    name: &'static str,
    app: Option<PathBuf>,
    cli: Option<PathBuf>,
    goto_flag: bool,
}
const EDITORS: &[(&str, &str, &str, &str, &str, bool)] = &[
    (
        "cursor",
        "Cursor",
        "Cursor.app",
        "cursor",
        "Contents/Resources/app/bin/cursor",
        true,
    ),
    (
        "vscode",
        "Visual Studio Code",
        "Visual Studio Code.app",
        "code",
        "Contents/Resources/app/bin/code",
        true,
    ),
    ("zed", "Zed", "Zed.app", "zed", "Contents/MacOS/cli", false),
    (
        "windsurf",
        "Windsurf",
        "Windsurf.app",
        "windsurf",
        "Contents/Resources/app/bin/windsurf",
        true,
    ),
    (
        "vscodium",
        "VSCodium",
        "VSCodium.app",
        "codium",
        "Contents/Resources/app/bin/codium",
        true,
    ),
    (
        "sublime",
        "Sublime Text",
        "Sublime Text.app",
        "subl",
        "Contents/SharedSupport/bin/subl",
        false,
    ),
];
fn executable(path: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}
fn detect_editors() -> Vec<Editor> {
    let home = PathBuf::from(std::env::var("HOME").unwrap_or_default());
    let mut paths: Vec<PathBuf> =
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .filter(|p| p.is_absolute())
            .collect();
    // Finder launches have a small PATH. Standard Homebrew/local CLI installations remain discoverable.
    for path in [
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        home.join(".local/bin"),
    ] {
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    EDITORS
        .iter()
        .filter_map(|&(id, name, bundle, command, bundle_cli, goto_flag)| {
            let app = [PathBuf::from("/Applications"), home.join("Applications")]
                .iter()
                .map(|dir| dir.join(bundle))
                .find(|path| path.is_dir());
            let cli = paths
                .iter()
                .map(|dir| dir.join(command))
                .find(|path| executable(path))
                .or_else(|| {
                    app.as_ref()
                        .map(|path| path.join(bundle_cli))
                        .filter(|path| executable(path))
                });
            (app.is_some() || cli.is_some()).then_some(Editor {
                id,
                name,
                app,
                cli,
                goto_flag,
            })
        })
        .collect()
}

fn run_command(mut command: std::process::Command, capture: bool) -> Result<Vec<u8>, Value> {
    use std::io::Read;
    use std::process::Stdio;
    use std::time::{Duration, Instant};
    let mut child = command
        .stdin(Stdio::null())
        .stdout(if capture {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| error(&e.to_string()))?;
    let reader = child.stdout.take().map(|mut output| {
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let mut chunk = [0; 8192];
            while let Ok(n) = output.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                if bytes.len() < 65536 {
                    bytes.extend_from_slice(&chunk[..n.min(65536 - bytes.len())]);
                }
            }
            let _ = sender.send(bytes);
        });
        receiver
    });
    let until = Instant::now() + Duration::from_secs(10);
    let result = loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                break if status.success() {
                    Ok(())
                } else {
                    Err(error("The application could not open the requested item"))
                }
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(error(&e.to_string()));
            }
            Ok(None) if Instant::now() >= until => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(error("The native command timed out"));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
        }
    };
    let bytes = reader
        .and_then(|receiver| receiver.recv_timeout(Duration::from_millis(500)).ok())
        .unwrap_or_default();
    result.map(|()| bytes)
}

fn git_root(root: &std::path::Path) -> Result<(), Value> {
    let mut command = std::process::Command::new("/usr/bin/git");
    command
        .arg("-C")
        .arg(root)
        .args(["rev-parse", "--show-toplevel"]);
    let output = run_command(command, true)?;
    let top = PathBuf::from(String::from_utf8_lossy(&output).trim());
    if fs::canonicalize(top).ok().as_deref() != Some(root) {
        return Err(error("That folder isn't a project"));
    }
    Ok(())
}
async fn checked_root(app: &AppHandle, root: &str) -> Result<(PathBuf, Vec<PathBuf>), Value> {
    if !std::path::Path::new(root).is_absolute() {
        return Err(error("That folder isn't a project"));
    }
    let root = fs::canonicalize(root).map_err(|_| error("That folder isn't a project"))?;
    let transport = app.state::<crate::transport::Transport>();
    let owned = transport
        .internal_call(
            "link:workspace-roots".into(),
            json!([root.to_string_lossy()]),
        )
        .await;
    if let Ok(Value::Array(roots)) = owned {
        let roots = roots
            .iter()
            .filter_map(|v| v.as_str())
            .map(fs::canonicalize)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| error("A linked Worktree no longer exists"))?;
        return Ok((root, roots));
    }
    let candidate = root.clone();
    if tauri::async_runtime::spawn_blocking(move || git_root(&candidate))
        .await
        .map_err(|e| error(&e.to_string()))?
        .is_ok()
    {
        return Ok((root, Vec::new()));
    }
    let roots = transport
        .internal_call("project:plain-root".into(), json!([root.to_string_lossy()]))
        .await?;
    if !roots.is_array() {
        return Err(error("That folder isn't a project"));
    }
    Ok((root, Vec::new()))
}
fn resolve_inside(
    root: &std::path::Path,
    requested: Option<&str>,
    extra: &[PathBuf],
) -> Result<PathBuf, Value> {
    let requested = requested.unwrap_or("");
    if requested.contains('\0') {
        return Err(error("File not found"));
    }
    let real = fs::canonicalize(root.join(requested)).map_err(|_| error("File not found"))?;
    if !real.starts_with(root) && !extra.iter().any(|other| real.starts_with(other)) {
        return Err(error("That path is outside the project"));
    }
    Ok(real)
}
fn open_editor(
    root: PathBuf,
    target: PathBuf,
    id: Option<String>,
    line: Option<u64>,
) -> Result<(), Value> {
    if background() {
        return Ok(());
    }
    let editors = detect_editors();
    let editor = editors
        .iter()
        .find(|e| Some(e.id) == id.as_deref())
        .or_else(|| editors.first())
        .ok_or_else(|| error("No editor found"))?;
    let mut command = if let (Some(cli), Some(line)) =
        (&editor.cli, line.filter(|n| *n > 0 && !target.is_dir()))
    {
        let mut command = std::process::Command::new(cli);
        if editor.goto_flag {
            command.arg("-g");
        }
        command.arg(format!("{}:{line}", target.display()));
        command
    } else if let Some(app) = &editor.app {
        let mut command = std::process::Command::new("/usr/bin/open");
        command.arg("-a").arg(app).arg(&target);
        command
    } else {
        let mut command = std::process::Command::new(editor.cli.as_ref().unwrap());
        command.arg(&target);
        command
    };
    command.current_dir(root);
    run_command(command, false)
        .map(|_| ())
        .map_err(|_| error(&format!("Couldn't open {}", editor.name)))
}
fn editor_result(result: Result<(), Value>) -> Value {
    match result {
        Ok(()) => json!({"ok":true,"value":null}),
        Err(e) => json!({"ok":false,"error":{"code":"EDITOR_OPEN","message":e["message"]}}),
    }
}
async fn check_skill_file(
    app: &AppHandle,
    project: &Value,
    file: &Value,
) -> Result<PathBuf, Value> {
    let file = file
        .as_str()
        .ok_or_else(|| error("That skill is no longer there. Reload the list."))?;
    let catalog = app
        .state::<crate::transport::Transport>()
        .call("skills:list".into(), json!([project]))
        .await?;
    let listed = ["skills", "shadowed"].iter().any(|key| {
        catalog[*key]
            .as_array()
            .is_some_and(|skills| skills.iter().any(|skill| skill["path"] == file))
    });
    if !listed {
        return Err(error("That skill is no longer there. Reload the list."));
    }
    let lexical = PathBuf::from(file);
    if !lexical.is_absolute() {
        return Err(error("That skill has no absolute path"));
    }
    let root = fs::canonicalize(lexical.parent().ok_or_else(|| error("File not found"))?)
        .map_err(|_| error("File not found"))?;
    resolve_inside(
        &root,
        lexical.file_name().and_then(|name| name.to_str()),
        &[],
    )
}

pub fn install(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder.plugin(tauri_plugin_notification::init())
}
pub fn start_notifications(app: &AppHandle) {
    notifications::start(app);
}

mod notifications {
    use super::*;
    use std::collections::{HashMap, HashSet, VecDeque};
    use tauri::{Emitter, Listener};
    use tauri_plugin_notification::NotificationExt;

    #[derive(Clone)]
    struct Schedule {
        days: HashSet<u32>,
        start: u32,
        end: u32,
        zone: String,
    }
    fn minutes(value: &Value) -> Option<u32> {
        let value = value.as_str()?;
        let bytes = value.as_bytes();
        if bytes.len() != 5
            || bytes[2] != b':'
            || !bytes
                .iter()
                .enumerate()
                .all(|(i, b)| i == 2 || b.is_ascii_digit())
        {
            return None;
        }
        let hour = value[..2].parse::<u32>().ok()?;
        let minute = value[3..].parse::<u32>().ok()?;
        (hour < 24 && minute < 60).then_some(hour * 60 + minute)
    }
    impl Schedule {
        fn parse(value: &Value) -> Result<Option<Self>, Value> {
            if value.is_null() {
                return Ok(None);
            }
            let days = value["days"]
                .as_array()
                .filter(|d| !d.is_empty() && d.len() <= 7)
                .ok_or_else(|| error("Invalid notification schedule"))?;
            let days = days
                .iter()
                .map(|d| {
                    d.as_u64()
                        .filter(|n| *n < 7)
                        .map(|n| n as u32)
                        .ok_or_else(|| error("Invalid notification day"))
                })
                .collect::<Result<HashSet<_>, _>>()?;
            let start =
                minutes(&value["start"]).ok_or_else(|| error("Invalid notification start time"))?;
            let end = minutes(&value["end"])
                .filter(|end| *end != start)
                .ok_or_else(|| error("Invalid notification end time"))?;
            let zone = value["timeZone"]
                .as_str()
                .filter(|z| {
                    !z.is_empty()
                        && z.len() <= 100
                        && !z.starts_with('/')
                        && !z.split('/').any(|p| p == ".." || p == ".")
                        && z.bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"/_+-".contains(&b))
                })
                .ok_or_else(|| error("Invalid notification timezone"))?;
            let directory = fs::canonicalize("/usr/share/zoneinfo")
                .map_err(|_| error("System timezone database unavailable"))?;
            let file = fs::canonicalize(directory.join(zone))
                .map_err(|_| error("Invalid notification timezone"))?;
            if !file.starts_with(directory) || !file.is_file() {
                return Err(error("Invalid notification timezone"));
            }
            Ok(Some(Self {
                days,
                start,
                end,
                zone: zone.to_string(),
            }))
        }
        fn at(&self, day: u32, time: u32) -> bool {
            if self.start < self.end {
                self.days.contains(&day) && time >= self.start && time < self.end
            } else {
                (self.days.contains(&day) && time >= self.start)
                    || (self.days.contains(&((day + 6) % 7)) && time < self.end)
            }
        }
        fn now(&self) -> bool {
            let mut command = std::process::Command::new("/bin/date");
            command.env("TZ", &self.zone).arg("+%w:%H:%M");
            let Ok(output) = run_command(command, true) else {
                return false;
            };
            let value = String::from_utf8_lossy(&output);
            let parts = value
                .trim()
                .split(':')
                .map(str::parse::<u32>)
                .collect::<Result<Vec<_>, _>>();
            parts.is_ok_and(|v| v.len() == 3 && self.at(v[0], v[1] * 60 + v[2]))
        }
    }
    #[derive(Clone, Debug, PartialEq)]
    struct Completion {
        failed: bool,
        body: String,
    }
    #[derive(Default)]
    struct Activity {
        running: bool,
        ended: bool,
        failed: bool,
        requests: HashSet<String>,
        agents: HashSet<String>,
        tasks: HashSet<String>,
        preview: String,
        end: Option<Completion>,
    }
    impl Activity {
        fn status(&self) -> u8 {
            if self.running {
                1
            } else if self.failed {
                3
            } else if !self.agents.is_empty() || !self.tasks.is_empty() {
                2
            } else {
                0
            }
        }
        fn observe(&mut self, event: &Value) -> Option<Completion> {
            let kind = event["type"].as_str().unwrap_or("");
            let terminal = matches!(kind, "turn-completed" | "turn-failed" | "turn-cancelled");
            if terminal && !self.running && !self.ended {
                self.running = true
            }
            let previous = self.status();
            match kind {
                "turn-started" | "message-sent" => {
                    self.running = true;
                    self.ended = false;
                    self.failed = false;
                    self.end = None;
                    self.preview.clear();
                }
                "answers-sent" => self.preview.clear(),
                "text-delta" if self.running => {
                    if event["startsMessage"] == true {
                        self.preview.clear()
                    }
                    self.preview.push_str(event["text"].as_str().unwrap_or(""));
                    self.preview = self.preview.chars().take(4096).collect();
                }
                "permission-request" | "question-request" => {
                    if self.running {
                        if let Some(id) = event["requestId"].as_str() {
                            self.requests.insert(id.to_string());
                        }
                    }
                }
                "permission-resolved" | "question-resolved" => {
                    if let Some(id) = event["requestId"].as_str() {
                        self.requests.remove(id);
                    }
                }
                "subagent-update" => {
                    let agent = &event["agent"];
                    if agent["background"] == true || agent["source"] == "milagre-advisor" {
                        if let Some(id) = agent["id"].as_str() {
                            if matches!(
                                agent["status"].as_str(),
                                Some("initializing" | "running" | "waiting")
                            ) {
                                self.agents.insert(id.to_string());
                            } else {
                                self.agents.remove(id);
                            }
                        }
                    }
                }
                "background-tasks" => {
                    self.tasks = event["tasks"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|t| t["kind"] != "local_bash")
                        .filter_map(|t| t["id"].as_str().map(str::to_string))
                        .collect()
                }
                _ if terminal => {
                    self.running = false;
                    self.ended = true;
                    self.requests.clear();
                    self.failed = kind == "turn-failed";
                    self.end = if kind == "turn-cancelled" || event["quiet"] == true {
                        None
                    } else {
                        Some(Completion {
                            failed: self.failed,
                            body: if self.failed {
                                event["message"]
                                    .as_str()
                                    .unwrap_or("Turn failed.")
                                    .to_string()
                            } else if self.preview.is_empty() {
                                "Turn completed.".into()
                            } else {
                                self.preview.clone()
                            },
                        })
                    };
                    self.preview.clear();
                }
                _ => {}
            }
            let next = self.status();
            if previous != next && matches!(previous, 1 | 2) && matches!(next, 0 | 3) {
                self.end.take()
            } else {
                None
            }
        }
    }
    pub struct Notifier {
        waiting: bool,
        completion: bool,
        chime: String,
        schedule: Option<Schedule>,
        active: Option<String>,
        hidden: HashSet<String>,
        unread: HashSet<String>,
        badge: bool,
        chats: HashMap<String, Activity>,
        order: VecDeque<String>,
        completed: HashMap<String, Completion>,
        asked: HashMap<String, String>,
        shown: HashSet<(String, String)>,
        next_id: i32,
    }
    impl Default for Notifier {
        fn default() -> Self {
            Self {
                waiting: true,
                completion: true,
                chime: "system".into(),
                schedule: None,
                active: None,
                hidden: HashSet::new(),
                unread: HashSet::new(),
                badge: true,
                chats: HashMap::new(),
                order: VecDeque::new(),
                completed: HashMap::new(),
                asked: HashMap::new(),
                shown: HashSet::new(),
                next_id: 0,
            }
        }
    }
    fn capped(value: &str, limit: usize) -> String {
        let text = value.trim();
        if text.chars().count() > limit {
            format!("{}…", text.chars().take(limit - 1).collect::<String>())
        } else {
            text.into()
        }
    }
    fn hidden(app: &AppHandle, state: &Notifier, chat: &str) -> bool {
        let scope = chat.rsplit_once('#').map_or(chat, |pair| pair.0);
        if state.hidden.contains(scope) {
            return true;
        }
        let Ok(values) = app.state::<Preferences>().read() else {
            return false;
        };
        hidden_by_preferences(&values, scope)
    }
    fn hidden_by_preferences(values: &Value, scope: &str) -> bool {
        let list = |key: &str| {
            serde_json::from_str::<Value>(values[key].as_str().unwrap_or("[]"))
                .unwrap_or_default()
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .collect::<Vec<String>>()
        };
        if list("milagre.hiddenRemoteScopes")
            .iter()
            .any(|s| s == scope)
            || list("milagre.hiddenLocalProjects")
                .iter()
                .any(|s| s == scope)
        {
            return true;
        }
        let settings: Value =
            serde_json::from_str(values["milagre-settings"].as_str().unwrap_or("{}"))
                .unwrap_or(Value::Null);
        // Match shared/chat-scopes.mjs: Links carry their computer after the
        // prefix; ordinary local Projects and Links belong to "local".
        let bare = scope.strip_prefix("milagre-link:").unwrap_or(scope);
        let computer = bare
            .split_once('|')
            .map(|pair| pair.0)
            .filter(|id| {
                !id.is_empty()
                    && id.len() <= 64
                    && id
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            })
            .unwrap_or("local");
        settings["otherComputers"] == true
            && list("milagre.hiddenComputers")
                .iter()
                .any(|id| id == computer)
    }
    fn badge(app: &AppHandle) {
        if background() {
            return;
        }
        let state = app.state::<Mutex<Notifier>>();
        let state = state.lock().unwrap();
        let mut chats = state.unread.clone();
        for (chat, activity) in &state.chats {
            if !activity.requests.is_empty() {
                chats.insert(chat.clone());
            }
        }
        let count = if state.badge {
            chats
                .iter()
                .filter(|chat| !hidden(app, &state, chat))
                .count()
        } else {
            0
        };
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_badge_count((count > 0).then_some(count as i64));
        }
    }
    fn show(
        app: &AppHandle,
        chat: String,
        title: String,
        body: String,
        waiting: bool,
    ) -> Result<bool, Value> {
        if background() || electron_desktop_running() {
            return Ok(false);
        }
        let focused = app
            .get_webview_window("main")
            .is_some_and(|w| w.is_focused().unwrap_or(false));
        let (chime, schedule, id) = {
            let state = app.state::<Mutex<Notifier>>();
            let mut state = state.lock().unwrap();
            if hidden(app, &state, &chat)
                || (focused && (waiting || state.active.as_deref() == Some(&chat)))
                || if waiting {
                    !state.waiting
                } else {
                    !state.completion
                }
            {
                return Ok(false);
            }
            state.next_id = state.next_id.wrapping_add(1);
            (state.chime.clone(), state.schedule.clone(), state.next_id)
        };
        if schedule.is_some_and(|s| !s.now()) {
            return Ok(false);
        }
        let title = if title.trim().is_empty() {
            "Milagre Rust".into()
        } else {
            capped(&title, 120)
        };
        let body = capped(&body.split_whitespace().collect::<Vec<_>>().join(" "), 240);
        let mut notice = app
            .notification()
            .builder()
            .id(id)
            .title(title)
            .body(body)
            .extra("chatId", chat);
        if chime != "system" {
            notice = notice.silent();
        }
        notice.show().map_err(|e| error(&e.to_string()))?;
        if chime != "system" {
            let _ = app.emit(
                "native-event",
                json!({"channel":"notification:play-chime","payload":chime}),
            );
        }
        Ok(true)
    }
    fn completed(
        app: &AppHandle,
        chat: String,
        title: String,
        value: Completion,
    ) -> Result<bool, Value> {
        let body = if value.failed {
            format!("Turn failed: {}", value.body)
        } else {
            value.body
        };
        show(app, chat, title, body, false)
    }
    fn event(app: &AppHandle, channel: &str, payload: &Value) {
        if channel == "computers:event" {
            event(
                app,
                payload["channel"].as_str().unwrap_or(""),
                &payload["payload"],
            );
            return;
        }
        if channel == "agent:event" {
            let Some(chat) = payload["chatId"].as_str() else {
                return;
            };
            let input = &payload["event"];
            let pending = {
                let state = app.state::<Mutex<Notifier>>();
                let mut state = state.lock().unwrap();
                if !state.chats.contains_key(chat) {
                    state.order.push_back(chat.to_string());
                    state.chats.insert(chat.to_string(), Activity::default());
                    if state.order.len() > 500 {
                        if let Some(old) = state.order.pop_front() {
                            state.chats.remove(&old);
                            state.completed.remove(&old);
                            state.asked.remove(&old);
                            state.shown.retain(|(id, _)| id != &old);
                        }
                    }
                }
                if matches!(
                    input["type"].as_str(),
                    Some("turn-started" | "turn-cancelled")
                ) {
                    state.completed.remove(chat);
                    state.asked.remove(chat);
                }
                if matches!(
                    input["type"].as_str(),
                    Some("permission-resolved" | "question-resolved")
                ) {
                    state.shown.remove(&(
                        chat.to_string(),
                        input["requestId"].as_str().unwrap_or("").to_string(),
                    ));
                }
                if let Some(value) = state.chats.get_mut(chat).unwrap().observe(input) {
                    if let Some(title) = state.asked.remove(chat) {
                        Some((title, value))
                    } else {
                        state.completed.insert(chat.to_string(), value);
                        None
                    }
                } else {
                    None
                }
            };
            if let Some((title, value)) = pending {
                let app = app.clone();
                let chat = chat.to_string();
                tauri::async_runtime::spawn_blocking(move || {
                    let _ = completed(&app, chat, title, value);
                });
            }
            badge(app);
        } else if channel == "notification:waiting" {
            let Some(chat) = payload["chatId"].as_str() else {
                return;
            };
            let Some(request) = payload["requestId"].as_str() else {
                return;
            };
            let key = (chat.to_string(), request.to_string());
            {
                let state = app.state::<Mutex<Notifier>>();
                let mut state = state.lock().unwrap();
                if !state
                    .chats
                    .get(chat)
                    .is_some_and(|c| c.requests.contains(request))
                    || !state.shown.insert(key.clone())
                {
                    return;
                }
            }
            let app = app.clone();
            let chat = chat.to_string();
            let title = payload["title"]
                .as_str()
                .unwrap_or("Milagre Rust")
                .to_string();
            let body = payload["body"]
                .as_str()
                .unwrap_or("Needs your input")
                .to_string();
            tauri::async_runtime::spawn_blocking(move || {
                if !show(&app, chat, title, body, true).unwrap_or(false) {
                    app.state::<Mutex<Notifier>>()
                        .lock()
                        .unwrap()
                        .shown
                        .remove(&key);
                }
            });
        }
    }
    pub fn start(app: &AppHandle) {
        if !app.manage(Mutex::new(Notifier::default())) {
            return;
        }
        let events = app.clone();
        app.listen("daemon-event", move |message| {
            if let Ok(value) = serde_json::from_str::<Value>(message.payload()) {
                event(
                    &events,
                    value["channel"].as_str().unwrap_or(""),
                    &value["payload"],
                );
            }
        });
        let click = app.clone();
        let _ = app.notification().on_action(move |action| {
            if background() || action.action_id() != "tap" {
                return;
            }
            if let Some(chat) = action
                .notification()
                .and_then(|n| n.extra().get("chatId"))
                .and_then(Value::as_str)
            {
                if let Some(window) = click.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = window.emit(
                        "native-event",
                        json!({"channel":"notification:open-chat","payload":chat}),
                    );
                }
            }
        });
    }
    pub async fn invoke(
        app: &AppHandle,
        method: &str,
        args: &Value,
    ) -> Option<Result<Value, Value>> {
        if !matches!(
            method,
            "settings:notify-when-waiting"
                | "settings:notification-chime"
                | "settings:notification-schedule"
                | "notification:state"
                | "notification:completed"
        ) {
            return None;
        }
        start(app);
        let result = async {
            if method == "notification:completed" {
                let Some(chat) = args[0]["chatId"].as_str() else {
                    return Ok(json!(false));
                };
                let title = args[0]["title"].as_str().unwrap_or("").to_string();
                let value = {
                    let state = app.state::<Mutex<Notifier>>();
                    let mut state = state.lock().unwrap();
                    let value = state.completed.remove(chat);
                    if value.is_none() && state.chats.get(chat).is_some_and(|c| c.status() == 2) {
                        state.asked.insert(chat.to_string(), title.clone());
                    }
                    value
                };
                let Some(value) = value else {
                    return Ok(json!(false));
                };
                let app = app.clone();
                let chat = chat.to_string();
                return tauri::async_runtime::spawn_blocking(move || {
                    completed(&app, chat, title, value).map(Value::Bool)
                })
                .await
                .map_err(|e| error(&e.to_string()))?;
            }
            {
                let state = app.state::<Mutex<Notifier>>();
                let mut state = state.lock().unwrap();
                match method {
                    "settings:notify-when-waiting" => state.waiting = args[0] == true,
                    "settings:notification-chime" => {
                        state.chime = match args[0].as_str() {
                            Some(
                                v @ ("miracle" | "faaah" | "bombastic-side-eye" | "vine-boom"
                                | "metal-pipe" | "bruh" | "emotional-damage"),
                            ) => v.to_string(),
                            _ => "system".into(),
                        }
                    }
                    "settings:notification-schedule" => state.schedule = Schedule::parse(&args[0])?,
                    "notification:state" => {
                        let input = &args[0];
                        state.active = input["activeChatId"].as_str().map(str::to_string);
                        state.completion = input["notifyOnCompletion"] != false;
                        state.badge = input["showDockBadge"] != false;
                        if let Some(path) = input["projectPath"].as_str() {
                            let prefix = format!("{path}#");
                            state.unread.retain(|id| !id.starts_with(&prefix));
                            state.unread.extend(
                                input["unread"]
                                    .as_array()
                                    .into_iter()
                                    .flatten()
                                    .filter_map(Value::as_str)
                                    .filter(|id| id.starts_with(&prefix))
                                    .map(str::to_string),
                            );
                        }
                        if let Some(scopes) = input["hidden"].as_array() {
                            state.hidden = scopes
                                .iter()
                                .filter_map(Value::as_str)
                                .map(str::to_string)
                                .collect();
                        }
                    }
                    _ => {}
                }
            };
            badge(app);
            Ok(Value::Null)
        }
        .await;
        Some(result)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn hidden_computers_include_local_and_qualified_links() {
            let values = json!({
                "milagre-settings": "{\"otherComputers\":true}",
                "milagre.hiddenComputers": "[\"local\",\"peer-1\",7,null,\"\"]"
            });
            for scope in [
                "/project",
                "milagre-link:abc",
                "peer-1|/project",
                "milagre-link:peer-1|abc",
                "invalid_computer|/project",
            ] {
                assert!(hidden_by_preferences(&values, scope), "not hidden: {scope}");
            }
            assert!(!hidden_by_preferences(&values, "peer-2|/project"));
            assert!(!hidden_by_preferences(&values, "milagre-link:peer-2|abc"));
            let mut disabled = values;
            disabled["milagre-settings"] = json!("{\"otherComputers\":false}");
            assert!(!hidden_by_preferences(&disabled, "/project"));
            assert!(!hidden_by_preferences(&disabled, "peer-1|/project"));
            disabled["milagre.hiddenRemoteScopes"] = json!("[null,\"peer-2|/hidden\",7]");
            assert!(hidden_by_preferences(&disabled, "peer-2|/hidden"));
        }
        #[test]
        fn inherited_preferences_do_not_shadow_future_electron_changes() {
            let mut overrides = serde_json::from_value::<Map<String, Value>>(
                json!({"milagre-theme":"dark","milagre-sidebar":"wide"}),
            )
            .unwrap();
            let base = serde_json::from_value::<Map<String, Value>>(
                json!({"milagre-theme":"dark","milagre-sidebar":"narrow"}),
            )
            .unwrap();
            prune_inherited(&mut overrides, &base);
            assert!(!overrides.contains_key("milagre-theme"));
            assert_eq!(overrides["milagre-sidebar"], "wide");
            let mut changed = base;
            changed.insert("milagre-theme".into(), json!("light"));
            changed.extend(overrides);
            assert_eq!(changed["milagre-theme"], "light");
        }

        #[test]
        fn overnight_schedule_belongs_to_the_start_day() {
            let s = Schedule {
                days: HashSet::from([5]),
                start: 22 * 60,
                end: 6 * 60,
                zone: "UTC".into(),
            };
            assert!(s.at(5, 23 * 60));
            assert!(s.at(6, 5 * 60));
            assert!(!s.at(6, 6 * 60));
            assert!(!s.at(5, 5 * 60));
        }
        #[test]
        fn schedule_validates_zone_paths_and_times() {
            assert!(Schedule::parse(
                &json!({"days":[1],"start":"09:00","end":"17:00","timeZone":"UTC"})
            )
            .unwrap()
            .is_some());
            for zone in ["../../etc/passwd", "/etc/passwd", "Not/AZone"] {
                assert!(Schedule::parse(
                    &json!({"days":[1],"start":"09:00","end":"17:00","timeZone":zone})
                )
                .is_err());
            }
            assert_eq!(minutes(&json!("25:00")), None);
            assert_eq!(minutes(&json!("9:00")), None);
        }
        #[test]
        fn background_work_defers_completion_and_shell_servers_do_not() {
            let mut a = Activity::default();
            a.observe(&json!({"type":"turn-started"}));
            a.observe(
                &json!({"type":"background-tasks","tasks":[{"id":"task","kind":"local_workflow"}]}),
            );
            assert_eq!(a.observe(&json!({"type":"turn-completed"})), None);
            assert_eq!(a.status(), 2);
            assert_eq!(
                a.observe(&json!({"type":"background-tasks","tasks":[]}))
                    .unwrap()
                    .body,
                "Turn completed."
            );
            let mut b = Activity::default();
            b.observe(&json!({"type":"turn-started"}));
            b.observe(
                &json!({"type":"background-tasks","tasks":[{"id":"server","kind":"local_bash"}]}),
            );
            assert!(b.observe(&json!({"type":"turn-completed"})).is_some());
        }
        #[test]
        fn cancellation_and_quiet_turns_never_notify() {
            for ending in [
                json!({"type":"turn-cancelled"}),
                json!({"type":"turn-completed","quiet":true}),
            ] {
                let mut a = Activity::default();
                a.observe(&json!({"type":"turn-started"}));
                assert!(a.observe(&ending).is_none());
            }
        }
        #[test]
        fn unicode_notification_text_has_safe_limits() {
            assert_eq!(capped("🦀🦀🦀", 2), "🦀…");
            assert_eq!(capped(" hello ", 120), "hello");
        }
    }
}

pub async fn invoke(app: AppHandle, method: String, args: Value) -> Result<Value, Value> {
    if let Some(result) = crate::images::invoke(&app, &method, &args).await {
        return result;
    }
    if let Some(result) = crate::downloads::invoke(&app, &method, &args).await {
        return result;
    }
    if let Some(result) = notifications::invoke(&app, &method, &args).await {
        return result;
    }
    if let Some(result) = crate::content::invoke(&app, &method, &args) {
        return result;
    }
    match method.as_str() {
        "app:launch-arguments" => {
            let opened = fs::read_to_string(profile()?.join("recent-projects.json"))
                .ok()
                .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                .is_some_and(|value| value.as_array().is_some_and(|list| !list.is_empty()));
            Ok(json!([
                "--milagre-window-controls=leading",
                format!("--milagre-opened-projects-before={}", u8::from(opened))
            ]))
        }
        "shortcuts:set" => crate::shortcuts::set(&app, &args[0]),
        "runtime:connection" => Ok(app
            .state::<crate::transport::Transport>()
            .connection_state()),
        "app:version" => Ok(json!("0.1.0-rust-local")),
        "update:state" | "update:check" => {
            Ok(json!({"status":"unavailable","version":null,"progress":0}))
        }
        "update:channel" => Ok(json!("stable")),
        "settings:window-background" => {
            if let Some(color) = args[0].as_str() {
                if let Ok(color) = color.parse::<tauri::window::Color>() {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.set_background_color(Some(color));
                    }
                }
            }
            Ok(Value::Null)
        }
        // Keep-awake belongs to the shared owner daemon (ADR-0003).
        "linear:connect" => {
            if background() {
                return Err(
                    json!({"code":"CAPABILITY_UNAVAILABLE","message":"Linear sign-in opens a browser and is unavailable in background mode."}),
                );
            }
            // This shell has no Electron OAuth window. The owner already implements the same PKCE
            // callback flow through the system browser when window=false.
            app.state::<crate::transport::Transport>()
                .call("linear:connect".into(), json!([{"window":false}]))
                .await
        }
        "app:set-keep-awake" => {
            app.state::<crate::transport::Transport>()
                .call(method, json!([args[0] == true]))
                .await
        }
        "app:open-keybindings-file" => {
            let state = app
                .state::<crate::transport::Transport>()
                .call("keybindings:read".into(), json!([]))
                .await?;
            let path = state["path"]
                .as_str()
                .ok_or_else(|| error("The host did not return its keybindings path"))?;
            let path = fs::canonicalize(path).map_err(|e| error(&e.to_string()))?;
            if !background() {
                tauri::async_runtime::spawn_blocking(move || {
                    let mut command = std::process::Command::new("/usr/bin/open");
                    command.arg(path);
                    run_command(command, false)
                })
                .await
                .map_err(|e| error(&e.to_string()))??;
            }
            Ok(Value::Null)
        }
        // These optional Electron surfaces are not started in this build.
        "app:terminal-focused" => {
            crate::lifecycle::terminal_focused(&app, args[0] == true);
            Ok(Value::Null)
        }
        "app:retry-quit" => {
            app.exit(0);
            Ok(Value::Null)
        }
        "settings:floating-inbox" | "browser-panel:pages" => Ok(json!(false)),
        "floating-inbox:is-open" => Ok(json!(false)),
        "floating-inbox:selected" => Ok(Value::Null),
        "app:dictation-status" => Ok(json!([])),
        "editor:list" => Ok(Value::Array(
            detect_editors()
                .iter()
                .map(|e| json!({"id":e.id,"name":e.name}))
                .collect(),
        )),
        "editor:open" => {
            let request = &args[0];
            let result = async {
                let root = request["root"]
                    .as_str()
                    .ok_or_else(|| error("File not found"))?;
                let (root, extra) = checked_root(&app, root).await?;
                if !request["path"].is_null() && !request["path"].is_string() {
                    return Err(error("File not found"));
                }
                let target = resolve_inside(&root, request["path"].as_str(), &extra)?;
                let editor = request["editor"].as_str().map(str::to_string);
                let line = request["line"].as_u64();
                tauri::async_runtime::spawn_blocking(move || {
                    open_editor(root, target, editor, line)
                })
                .await
                .map_err(|e| error(&e.to_string()))?
            }
            .await;
            Ok(editor_result(result))
        }
        "skills:open" => {
            let request = &args[0];
            let file = check_skill_file(&app, &request["projectPath"], &request["file"]).await?;
            let root = file
                .parent()
                .ok_or_else(|| error("File not found"))?
                .to_path_buf();
            let editor = request["editor"].as_str().map(str::to_string);
            let result =
                tauri::async_runtime::spawn_blocking(move || open_editor(root, file, editor, None))
                    .await
                    .map_err(|e| error(&e.to_string()))?;
            Ok(editor_result(result))
        }
        "skills:reveal" => {
            let file = check_skill_file(&app, &args[0], &args[1]).await?;
            if !background() {
                tauri::async_runtime::spawn_blocking(move || {
                    let mut command = std::process::Command::new("/usr/bin/open");
                    command.arg("-R").arg(file);
                    run_command(command, false)
                })
                .await
                .map_err(|e| error(&e.to_string()))??;
            }
            Ok(Value::Null)
        }
        "window:start-drag" => {
            if !background() {
                app.get_webview_window("main")
                    .ok_or_else(|| error("Window unavailable"))?
                    .start_dragging()
                    .map_err(|e| error(&e.to_string()))?;
            }
            Ok(Value::Null)
        }
        "window:toggle-maximize" => {
            if !background() {
                let window = app
                    .get_webview_window("main")
                    .ok_or_else(|| error("Window unavailable"))?;
                if window.is_maximized().map_err(|e| error(&e.to_string()))? {
                    window.unmaximize()
                } else {
                    window.maximize()
                }
                .map_err(|e| error(&e.to_string()))?;
            }
            Ok(Value::Null)
        }
        "shell:open-external" => {
            let url = args[0].as_str().ok_or_else(|| error("Expected URL"))?;
            let parsed = tauri::Url::parse(url).map_err(|e| error(&e.to_string()))?;
            if !["http", "https", "mailto"].contains(&parsed.scheme()) {
                return Err(error("Only web and email links can open externally"));
            }
            if !background() {
                let url = url.to_string();
                tauri::async_runtime::spawn_blocking(move || {
                    let mut command = std::process::Command::new("/usr/bin/open");
                    command.arg(url);
                    run_command(command, false)
                })
                .await
                .map_err(|e| error(&e.to_string()))??;
            }
            Ok(Value::Null)
        }
        "clipboard:write-text" => {
            use std::io::Write;
            let text = args[0].as_str().ok_or_else(|| error("Expected text"))?;
            let mut child = std::process::Command::new("/usr/bin/pbcopy")
                .stdin(std::process::Stdio::piped())
                .spawn()
                .map_err(|e| error(&e.to_string()))?;
            child
                .stdin
                .take()
                .unwrap()
                .write_all(text.as_bytes())
                .map_err(|e| error(&e.to_string()))?;
            if !child.wait().map_err(|e| error(&e.to_string()))?.success() {
                return Err(error("Clipboard write failed"));
            }
            Ok(Value::Null)
        }
        "clipboard:read-text" => {
            let out = std::process::Command::new("/usr/bin/pbpaste")
                .output()
                .map_err(|e| error(&e.to_string()))?;
            if !out.status.success() {
                return Err(error("Clipboard read failed"));
            }
            Ok(json!(String::from_utf8_lossy(&out.stdout)))
        }
        "project:choose-folder" | "project:open" => {
            if background() {
                return Ok(Value::Null);
            }
            let picked =
                tauri::async_runtime::spawn_blocking(|| rfd::FileDialog::new().pick_folder())
                    .await
                    .map_err(|e| error(&e.to_string()))?;
            match picked {
                None => Ok(Value::Null),
                Some(folder) if method == "project:choose-folder" => {
                    Ok(json!(folder.to_string_lossy()))
                }
                Some(folder) => {
                    app.state::<crate::transport::Transport>()
                        .call(
                            "project:open".into(),
                            json!([folder.to_string_lossy(),{"takeNotice":true}]),
                        )
                        .await
                }
            }
        }
        "project:open-at" => {
            app.state::<crate::transport::Transport>()
                .call("project:open".into(), json!([args[0],{"takeNotice":true}]))
                .await
        }
        "project:reveal" => {
            let path = args[0].as_str().ok_or_else(|| error("Expected path"))?;
            let (root, _) = checked_root(&app, path).await?;
            if !background() {
                tauri::async_runtime::spawn_blocking(move || {
                    let mut command = std::process::Command::new("/usr/bin/open");
                    command.arg(root);
                    run_command(command, false)
                })
                .await
                .map_err(|e| error(&e.to_string()))??;
            }
            Ok(Value::Null)
        }
        _ => Err(
            json!({"code":"CAPABILITY_UNAVAILABLE","message":format!("{method} is not available in this Rust migration build.")}),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn editor_paths_reject_symlink_escapes_and_allow_owned_link_roots() {
        use std::os::unix::fs::symlink;
        let base =
            std::env::temp_dir().join(format!("milagre-native-path-test-{}", std::process::id()));
        fs::create_dir_all(base.join("root")).unwrap();
        fs::create_dir_all(base.join("peer")).unwrap();
        fs::write(base.join("root/inside.txt"), "inside").unwrap();
        fs::write(base.join("peer/outside.txt"), "outside").unwrap();
        symlink(base.join("peer"), base.join("root/link")).unwrap();
        let root = fs::canonicalize(base.join("root")).unwrap();
        let peer = fs::canonicalize(base.join("peer")).unwrap();
        assert_eq!(
            resolve_inside(&root, Some("inside.txt"), &[]).unwrap(),
            root.join("inside.txt")
        );
        assert!(resolve_inside(&root, Some("link/outside.txt"), &[]).is_err());
        assert_eq!(
            resolve_inside(&root, Some("link/outside.txt"), std::slice::from_ref(&peer)).unwrap(),
            peer.join("outside.txt")
        );
        assert!(resolve_inside(&root, Some("../peer/outside.txt"), &[]).is_err());
        assert!(resolve_inside(&root, Some("bad\0path"), &[]).is_err());
        fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn editor_wire_result_matches_the_production_bridge() {
        assert_eq!(editor_result(Ok(())), json!({"ok":true,"value":null}));
        assert_eq!(
            editor_result(Err(error("File not found"))),
            json!({"ok":false,"error":{"code":"EDITOR_OPEN","message":"File not found"}})
        );
    }
    #[test]
    fn subprocess_capture_waits_for_output_reader() {
        let mut command = std::process::Command::new("/usr/bin/printf");
        command.arg("test-output");
        assert_eq!(run_command(command, true).unwrap(), b"test-output");
    }
}

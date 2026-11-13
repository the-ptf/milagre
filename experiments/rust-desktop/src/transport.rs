//! One persistent, multiplexed connection to the existing Milagre owner daemon.
//! A disconnect rejects accepted calls. Only establishing the connection is retried.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    io::{BufRead, BufReader, Write},
    os::unix::{fs::MetadataExt, net::UnixStream},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Condvar, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::Emitter;

const MAX_FRAME: usize = 16 * 1024 * 1024;
const MAX_PENDING: usize = 32;
const MAX_PAGES: usize = 1024;
const MAX_PAGED_BYTES: usize = 128 * 1024 * 1024;
const MAX_HELD_EVENTS: usize = 1024;
type Reply = Result<Value, Value>;
type Emit = Arc<dyn Fn(Value) + Send + Sync>;

fn error(code: &str, message: impl Into<String>) -> Value {
    json!({"code":code,"message":message.into()})
}
fn gone() -> Value {
    error("DAEMON_CLOSED", "Connection to Milagre closed. A submitted operation may still be running; check its state before retrying.")
}
fn deadline(method: &str) -> Duration {
    Duration::from_secs(match method {
        "command:run" | "computers:invoke" | "link:delete" => 1800,
        "agent:update-cli" => 1200,
        "computers:add" => 720,
        "artifact:share-page" => 420,
        "git:commit"
        | "git:push"
        | "worktree:create"
        | "worktree:remove"
        | "storage:remove-worktree"
        | "linear:connect" => 330,
        "git:generate" => 180,
        "desktop:invoke" => 130,
        "artifact:revoke-page-share"
        | "artifact:revoke-saved-page-share"
        | "git:open-pr"
        | "storage:worktrees" => 120,
        "mcp:accounts" | "mcp:check" | "mcp:save" | "mcp:saveUrl" | "mcp:remove" | "mcp:signIn"
        | "mcp:definition" => 45,
        _ => 30,
    })
}

/// Exact first arguments of invoke/send calls in the production preload, plus its typed accountAction cases.
/// The parity test below fails when the preload changes without reviewing this renderer boundary.
const RENDERER_COMMANDS: &[&str] = &[
    "accounts:add",
    "accounts:assign",
    "accounts:cancel",
    "accounts:list",
    "accounts:login",
    "accounts:remove",
    "accounts:scope",
    "accounts:scopes",
    "accounts:select",
    "advisor:retry",
    "advisor:stop",
    "agent:answer-question",
    "agent:cli-status",
    "agent:dismiss-suggestion",
    "agent:interrupt",
    "agent:models",
    "agent:ports",
    "agent:provider-updates",
    "agent:respond-permission",
    "agent:set-permission-mode",
    "agent:stop-port",
    "agent:update-cli",
    "app-update:auto:read",
    "app-update:auto:save",
    "app-update:check",
    "app-update:install",
    "app-update:state",
    "app:dictation-cancel",
    "app:dictation-download",
    "app:dictation-open-settings",
    "app:dictation-prepare",
    "app:dictation-remove",
    "app:dictation-status",
    "app:dictation-transcribe",
    "app:host-ready",
    "app:open-keybindings-file",
    "app:retry-quit",
    "app:set-keep-awake",
    "app:terminal-focused",
    "app:version",
    "artifact-preview:register",
    "artifact-preview:release",
    "artifact:add-comments",
    "artifact:all-page-shares",
    "artifact:apply",
    "artifact:asset",
    "artifact:comments",
    "artifact:delete",
    "artifact:get",
    "artifact:list",
    "artifact:page-shares",
    "artifact:revoke-page-share",
    "artifact:revoke-saved-page-share",
    "artifact:share-page",
    "artifact:sharing-status",
    "attachment:preview",
    "attachment:read",
    "attachment:upload",
    "babysit:settings:read",
    "babysit:settings:save",
    "browser-comments:add",
    "browser-comments:list",
    "browser-comments:send-from-page",
    "browser-panel:capture",
    "browser-panel:clear-sign-ins",
    "browser-panel:pages",
    "browser-panel:remote-partition",
    "browser:attach",
    "browser:close",
    "browser:control",
    "browser:detach",
    "browser:frame",
    "browser:input",
    "browser:list",
    "browser:open",
    "browser:status",
    "canvas:link-add",
    "canvas:link-remove",
    "canvas:link-restore",
    "canvas:links",
    "canvas:open-project",
    "canvas:snapshot",
    "canvas:worktree-position",
    "chat:archive-finished-subagents",
    "chat:archive-subagent",
    "chat:delete",
    "chat:detach",
    "chat:git-note",
    "chat:limit-resume",
    "chat:limit-resume:cancel",
    "chat:limit-switch",
    "chat:message",
    "chat:messages",
    "chat:patch",
    "chat:queue-remove",
    "chat:queue-send",
    "chat:reload",
    "chat:resume",
    "chat:runs",
    "chat:search",
    "chat:send",
    "chat:send-status",
    "chat:set-open",
    "chat:subagent",
    "chat:task-output",
    "chats:ensure",
    "chats:home",
    "checkpoint:list",
    "checkpoint:preview",
    "checkpoint:restore",
    "computer-use:frame",
    "computer-use:guide",
    "computer-use:settings:read",
    "computer-use:settings:save",
    "computer-use:status",
    "computer:resources:read",
    "computers:add",
    "computers:cancel-add",
    "computers:invoke",
    "computers:list",
    "computers:note",
    "computers:preview",
    "computers:recall",
    "computers:remember",
    "computers:remove",
    "computers:rename",
    "computers:set-enabled",
    "context:settings:read",
    "context:settings:save",
    "designs:enabled:read",
    "device-notes:read",
    "device-notes:save",
    "devices:acknowledge",
    "devices:allow",
    "devices:deny",
    "devices:list",
    "devices:pending",
    "devices:remove",
    "dictation:context",
    "dictation:polish",
    "done:settings:read",
    "done:settings:save",
    "editor:list",
    "editor:open",
    "files-to-copy:preview",
    "files-to-copy:read",
    "files-to-copy:save",
    "floating-inbox:close",
    "floating-inbox:count",
    "floating-inbox:dock-expanded",
    "floating-inbox:drag-begin",
    "floating-inbox:drag-end",
    "floating-inbox:drag-move",
    "floating-inbox:drag-overlay",
    "floating-inbox:height",
    "floating-inbox:is-open",
    "floating-inbox:open-chat",
    "floating-inbox:placement",
    "floating-inbox:preview",
    "floating-inbox:preview-key",
    "floating-inbox:select",
    "floating-inbox:selected",
    "floating-inbox:settings",
    "floating-inbox:snapshot",
    "floating-inbox:toggle",
    "fs:list-dirs",
    "git:changes",
    "git:commit",
    "git:diff-file",
    "git:diff-files",
    "git:generate",
    "git:history",
    "git:open-pr",
    "git:push",
    "image:copy",
    "image:menu",
    "image:save",
    "keybindings:read",
    "keybindings:reset",
    "keybindings:reset-command",
    "keybindings:set-command",
    "limits:auto-switch:read",
    "limits:auto-switch:save",
    "limits:resume-at-reset:read",
    "limits:resume-at-reset:save",
    "linear:connect",
    "linear:disconnect",
    "linear:enabled:read",
    "linear:enabled:save",
    "linear:issues",
    "linear:move-to-started:save",
    "linear:status",
    "linear:worktree-issues",
    "link:create",
    "link:delete",
    "link:delete-check",
    "link:list",
    "link:open",
    "link:send",
    "link:snapshot",
    "link:update",
    "linked:grant",
    "linked:remote-enabled:read",
    "linked:remote-enabled:save",
    "linked:snapshot",
    "linked:stop-negotiation",
    "local-mcp:create",
    "local-mcp:disableClient",
    "local-mcp:enableClient",
    "local-mcp:revoke",
    "local-mcp:rotate",
    "local-mcp:status",
    "local-mcp:update",
    "main-sync:default:read",
    "main-sync:default:save",
    "main-sync:read",
    "main-sync:save",
    "mcp:accounts",
    "mcp:cancelSignIn",
    "mcp:check",
    "mcp:definition",
    "mcp:remove",
    "mcp:save",
    "mcp:saveUrl",
    "mcp:signIn",
    "mcp:toggle",
    "media:read",
    "notification:completed",
    "notification:state",
    "onboarding:agent-folders",
    "onboarding:clone",
    "onboarding:create",
    "onboarding:init-git",
    "phone:open-pairing",
    "phone:reset",
    "phone:set-enabled",
    "phone:set-lan",
    "phone:status",
    "pr:comment",
    "pr:delete-comment",
    "pr:detail",
    "pr:diff-file",
    "pr:diff-files",
    "pr:image",
    "pr:labels",
    "pr:merge",
    "pr:ready",
    "pr:reply",
    "pr:request-reviewers",
    "pr:resolve-thread",
    "pr:reviewer-candidates",
    "pr:set-labels",
    "pr:submit-review",
    "project-git:read",
    "project-git:save",
    "project:branches",
    "project:choose-folder",
    "project:current",
    "project:files",
    "project:forget",
    "project:image",
    "project:known",
    "project:open",
    "project:open-at",
    "project:position",
    "project:read",
    "project:recent",
    "project:registry",
    "project:reveal",
    "project:set-hidden",
    "project:set-icon",
    "project:switch",
    "pull-requests:open",
    "pull-requests:snapshot",
    "routines:create",
    "routines:delete",
    "routines:enabled:read",
    "routines:flow-act",
    "routines:flow-test",
    "routines:hook",
    "routines:linear-options",
    "routines:list",
    "routines:rotate-hook",
    "routines:run-now",
    "routines:targets",
    "routines:update",
    "runtime:connection",
    "runtime:restart-host",
    "scope:retry-save",
    "settings:floating-inbox",
    "settings:notification-chime",
    "settings:notification-schedule",
    "settings:notify-when-waiting",
    "settings:window-background",
    "simlock:identity",
    "simlock:lease",
    "simlock:models",
    "simlock:release",
    "simlock:settings:read",
    "simlock:settings:save",
    "simulator:attach",
    "simulator:close",
    "simulator:control",
    "simulator:detach",
    "simulator:frame",
    "simulator:input",
    "simulator:list",
    "simulator:offer",
    "simulator:open",
    "simulator:repair",
    "simulator:status",
    "skills:list",
    "skills:open",
    "skills:read",
    "skills:reveal",
    "state:read",
    "storage:remove-worktree",
    "storage:worktrees",
    "terminal:close",
    "terminal:input",
    "terminal:list",
    "terminal:open",
    "terminal:profiles",
    "terminal:read",
    "terminal:resize",
    "terminal:setShell",
    "token-usage:read",
    "triage:prepare",
    "update:channel",
    "update:check",
    "update:install",
    "update:release-notes",
    "update:set-channel",
    "update:state",
    "usage:accounts:cached",
    "usage:accounts:read",
    "usage:cached",
    "usage:read",
    "worktree-setup:read",
    "worktree-setup:save",
    "worktree:create",
    "worktree:link-issue",
    "worktree:pull-request",
    "worktree:pull-requests",
    "worktree:refresh-diffs",
    "worktree:remove",
    "worktree:roots",
    "worktree:status",
    "worktree:unlink-issue",
];
fn allowed(method: &str) -> bool {
    method != "app-update:install" && RENDERER_COMMANDS.binary_search(&method).is_ok()
}
fn internal_allowed(method: &str) -> bool {
    allowed(method)
        || matches!(
            method,
            "daemon:status"
                | "daemon:snapshot"
                | "daemon:focus"
                | "project:snapshot"
                | "link:workspace-roots"
                | "project:plain-root"
        )
}

fn socket_path() -> Result<PathBuf, Value> {
    let home =
        std::env::var("HOME").map_err(|_| error("PROFILE_UNAVAILABLE", "HOME is not set"))?;
    let profile =
        std::fs::canonicalize(PathBuf::from(home).join("Library/Application Support/Milagre"))
            .map_err(|e| {
                error(
                    "PROFILE_UNAVAILABLE",
                    format!("Open the installed Milagre first: {e}"),
                )
            })?;
    let digest = format!(
        "{:x}",
        Sha256::digest(profile.as_os_str().as_encoded_bytes())
    );
    let uid = unsafe { libc::getuid() };
    let directory = PathBuf::from(format!("/tmp/milagre-{uid}"));
    let meta = std::fs::symlink_metadata(&directory)
        .map_err(|e| error("DAEMON_UNAVAILABLE", e.to_string()))?;
    if !meta.is_dir() || meta.uid() != uid || meta.mode() & 0o777 != 0o700 {
        return Err(error(
            "UNSAFE_SOCKET",
            "The daemon socket directory must be owned by you with mode 0700",
        ));
    }
    let path = directory.join(format!("{}.sock", &digest[..24]));
    let meta =
        std::fs::symlink_metadata(&path).map_err(|e| error("DAEMON_UNAVAILABLE", e.to_string()))?;
    use std::os::unix::fs::FileTypeExt;
    if !meta.file_type().is_socket() || meta.uid() != uid {
        return Err(error(
            "UNSAFE_SOCKET",
            "The daemon endpoint must be a socket owned by you",
        ));
    }
    Ok(path)
}

fn read_frame(reader: &mut impl BufRead, limit: usize) -> Reply {
    let mut frame = Vec::new();
    loop {
        let bytes = reader
            .fill_buf()
            .map_err(|e| error("DAEMON_CLOSED", e.to_string()))?;
        if bytes.is_empty() {
            return Err(gone());
        }
        let newline = bytes.iter().position(|b| *b == b'\n');
        let take = newline.unwrap_or(bytes.len());
        if frame.len().saturating_add(take) > limit {
            return Err(error(
                "FRAME_TOO_LARGE",
                "Daemon frame exceeds the size limit",
            ));
        }
        frame.extend_from_slice(&bytes[..take]);
        reader.consume(take + usize::from(newline.is_some()));
        if newline.is_some() {
            break;
        }
    }
    let value: Value = serde_json::from_slice(&frame)
        .map_err(|_| error("INVALID_RESPONSE", "Expected a JSON frame from the daemon"))?;
    if value["v"] != 1 {
        return Err(error(
            "INCOMPATIBLE_PROTOCOL",
            "Incompatible daemon protocol",
        ));
    }
    Ok(value)
}

struct Pending {
    next_id: u64,
    requests: HashMap<u64, mpsc::Sender<Reply>>,
    closed: Option<Value>,
}
struct EventBuffer {
    events: Option<Vec<Value>>,
    bytes: usize,
}
struct Hold {
    events: Vec<Value>,
    bytes: usize,
    reading_chats: HashSet<String>,
}
struct Connection {
    writer: Mutex<UnixStream>,
    pending: Mutex<Pending>,
    available: Condvar,
    events: Mutex<EventBuffer>,
    emit: Emit,
    holds: Mutex<HashMap<String, Hold>>,
    outdated: AtomicBool,
}
impl Connection {
    fn new(socket: UnixStream, emit: Emit) -> Result<Arc<Self>, Value> {
        socket
            .set_write_timeout(Some(Duration::from_secs(5)))
            .map_err(|e| error("DAEMON_CLOSED", e.to_string()))?;
        let reader = socket
            .try_clone()
            .map_err(|e| error("DAEMON_CLOSED", e.to_string()))?;
        let connection = Arc::new(Self {
            writer: Mutex::new(socket),
            pending: Mutex::new(Pending {
                next_id: 0,
                requests: HashMap::new(),
                closed: None,
            }),
            available: Condvar::new(),
            events: Mutex::new(EventBuffer {
                events: Some(Vec::new()),
                bytes: 0,
            }),
            emit,
            holds: Mutex::new(HashMap::new()),
            outdated: AtomicBool::new(false),
        });
        let receiver = connection.clone();
        thread::spawn(move || {
            let mut reader = BufReader::new(reader);
            loop {
                match read_frame(&mut reader, MAX_FRAME) {
                    Ok(frame) => {
                        if let Err(reason) = receiver.receive(frame) {
                            receiver.close(reason);
                            break;
                        }
                    }
                    Err(reason) => {
                        receiver.close(reason);
                        break;
                    }
                }
            }
        });
        Ok(connection)
    }
    fn receive(self: &Arc<Self>, frame: Value) -> Result<(), Value> {
        if let Some(event) = frame.get("event") {
            if !event["channel"].is_string() {
                return Err(error("INVALID_RESPONSE", "Invalid daemon event"));
            }
            let mut buffer = self.events.lock().unwrap();
            if buffer.events.is_some() {
                buffer.bytes += event.to_string().len();
                if buffer.bytes > MAX_FRAME
                    || buffer.events.as_ref().unwrap().len() >= MAX_HELD_EVENTS
                {
                    return Err(error(
                        "EVENT_OVERFLOW",
                        "Too many events while restoring the daemon connection",
                    ));
                }
                buffer.events.as_mut().unwrap().push(event.clone());
            } else {
                self.deliver(event.clone())?;
            }
            return Ok(());
        }
        let id = frame["id"]
            .as_u64()
            .ok_or_else(|| error("INVALID_RESPONSE", "Invalid daemon response ID"))?;
        let request = self.pending.lock().unwrap().requests.remove(&id);
        self.available.notify_all();
        if let Some(request) = request {
            let reply = if let Some(reason) = frame.get("error").filter(|v| !v.is_null()) {
                Err(reason.clone())
            } else {
                Ok(frame)
            };
            let _ = request.send(reply);
        }
        Ok(())
    }
    fn close(&self, reason: Value) {
        let mut pending = self.pending.lock().unwrap();
        if pending.closed.is_some() {
            return;
        }
        pending.closed = Some(reason.clone());
        for (_, sender) in pending.requests.drain() {
            let _ = sender.send(Err(reason.clone()));
        }
        self.available.notify_all();
        drop(pending);
        let _ = self
            .writer
            .lock()
            .unwrap()
            .shutdown(std::net::Shutdown::Both);
    }
    fn closed(&self) -> Option<Value> {
        self.pending.lock().unwrap().closed.clone()
    }
    fn exchange(&self, method: &str, args: Value, expires: Instant) -> Reply {
        let (sender, receiver) = mpsc::channel();
        let id;
        {
            let mut pending = self.pending.lock().unwrap();
            while pending.requests.len() >= MAX_PENDING && pending.closed.is_none() {
                let remaining = expires.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err(error(
                        "ETIMEDOUT",
                        "Timed out waiting for a daemon request slot; command was not sent",
                    ));
                }
                pending = self.available.wait_timeout(pending, remaining).unwrap().0;
            }
            if let Some(reason) = &pending.closed {
                return Err(reason.clone());
            }
            pending.next_id += 1;
            id = pending.next_id;
            pending.requests.insert(id, sender);
        }
        let mut frame = json!({"v":1,"id":id,"method":method,"args":args,"pages":true}).to_string();
        if frame.len() > MAX_FRAME {
            self.pending.lock().unwrap().requests.remove(&id);
            self.available.notify_all();
            return Err(error(
                "FRAME_TOO_LARGE",
                "Request exceeds the daemon frame size limit",
            ));
        }
        frame.push('\n');
        let written = self.writer.lock().unwrap().write_all(frame.as_bytes());
        if let Err(cause) = written {
            self.close(error(
                "DAEMON_CLOSED",
                format!("Daemon write failed; outcome is unknown: {cause}"),
            ));
        }
        match receiver.recv_timeout(expires.saturating_duration_since(Instant::now())) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(gone()),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.pending.lock().unwrap().requests.remove(&id);
                self.available.notify_all();
                Err(error("ETIMEDOUT", format!("Timed out: {method}. It may still be running; check state before retrying.")))
            }
        }
    }
    fn request(&self, method: &str, args: Value) -> Reply {
        let expires = Instant::now() + deadline(method);
        let response = self.exchange(method, args, expires)?;
        if let Some(pages) = response.get("pages") {
            let (page_id, count) = page_manifest(pages, "pageId")?;
            let mut parts = String::new();
            for index in 0..count {
                let frame =
                    self.exchange("daemon:result-page", json!([page_id, index]), expires)?;
                append_page(&mut parts, &frame["result"])?;
            }
            return serde_json::from_str(&parts).map_err(|_| {
                error(
                    "INVALID_RESPONSE",
                    "The daemon's paged result is not valid JSON",
                )
            });
        }
        Ok(response.get("result").cloned().unwrap_or(Value::Null))
    }
    fn deliver(self: &Arc<Self>, event: Value) -> Result<(), Value> {
        let Some(scope) = event_scope(&event) else {
            (self.emit)(event);
            return Ok(());
        };
        let mut holds = self.holds.lock().unwrap();
        if let Some(hold) = holds.get_mut(&scope) {
            let same_chat = event["payload"]["chatId"].as_str().is_some_and(|chat| {
                hold.reading_chats.contains(chat)
                    || hold
                        .events
                        .iter()
                        .any(|item| item["payload"]["chatId"] == chat)
            });
            if !carries_state(&event) && !same_chat {
                (self.emit)(event);
                return Ok(());
            }
            hold.bytes += event.to_string().len();
            if hold.events.len() >= 10_000 || hold.bytes > MAX_FRAME {
                return Err(error(
                    "EVENT_OVERFLOW",
                    "Too many events while reading a large Project state",
                ));
            }
            hold.events.push(event);
            return Ok(());
        }
        if event["payload"]["stateTooLarge"] != true {
            (self.emit)(event);
            return Ok(());
        }
        if holds.len() >= 64 {
            return Err(error(
                "EVENT_OVERFLOW",
                "Too many large Project state reads",
            ));
        }
        holds.insert(
            scope.clone(),
            Hold {
                bytes: event.to_string().len(),
                events: vec![event],
                reading_chats: HashSet::new(),
            },
        );
        let connection = self.clone();
        thread::spawn(move || connection.hydrate(scope));
        Ok(())
    }
    fn hydrate(self: &Arc<Self>, scope: String) {
        // Like runtime-client's deferred release: collect events already queued by the socket reader.
        thread::yield_now();
        loop {
            let batch = {
                let mut holds = self.holds.lock().unwrap();
                if self.closed().is_some() {
                    holds.remove(&scope);
                    return;
                }
                let Some(hold) = holds.get_mut(&scope) else {
                    return;
                };
                if hold.events.is_empty() {
                    holds.remove(&scope);
                    return;
                }
                if !carries_state(&hold.events[0]) {
                    let event = hold.events.remove(0);
                    hold.bytes = hold.bytes.saturating_sub(event.to_string().len());
                    (self.emit)(event);
                    continue;
                }
                hold.bytes = 0;
                // Preserve this Chat's terminal/stream order even while its batch is being reread.
                hold.reading_chats = hold
                    .events
                    .iter()
                    .filter_map(|event| event["payload"]["chatId"].as_str().map(str::to_string))
                    .collect();
                std::mem::take(&mut hold.events)
            };
            let (method, id) = if let Some(id) = scope.strip_prefix("milagre-link:") {
                ("link:snapshot", id)
            } else {
                ("project:snapshot", scope.as_str())
            };
            let state = self.request(method, json!([id])).ok().and_then(|result| {
                result
                    .get("state")
                    .filter(|state| state.is_object())
                    .cloned()
            });
            let mut holds = self.holds.lock().unwrap();
            if self.closed().is_some() || !holds.contains_key(&scope) {
                return;
            }
            for event in hydrated_batch(batch, state.as_ref()) {
                (self.emit)(event);
            }
            holds.get_mut(&scope).unwrap().reading_chats.clear();
        }
    }
    fn release_events(self: &Arc<Self>, snapshot: Option<Value>) {
        // Hold the same lock as the reader so new events cannot overtake the restored snapshot.
        let mut buffer = self.events.lock().unwrap();
        let watermark = snapshot.as_ref().and_then(|v| v["eventSeq"].as_u64());
        if let Some(snapshot) = snapshot {
            (self.emit)(json!({"channel":"runtime:snapshot","payload":snapshot}));
        }
        for event in buffer.events.take().unwrap_or_default() {
            if watermark.is_none()
                || event["seq"]
                    .as_u64()
                    .is_none_or(|seq| seq > watermark.unwrap())
            {
                if let Err(reason) = self.deliver(event) {
                    self.close(reason);
                    break;
                }
            }
        }
        buffer.bytes = 0;
    }
}
fn event_scope(event: &Value) -> Option<String> {
    let payload = &event["payload"];
    if event["channel"] == "link:state" {
        return payload["linkId"]
            .as_str()
            .map(|id| format!("milagre-link:{id}"));
    }
    if event["channel"] == "project:state" {
        return payload["path"].as_str().map(str::to_string);
    }
    if let Some(chat) = payload["chatId"].as_str() {
        return Some(
            chat.rsplit_once('#')
                .map_or(chat, |(scope, _)| scope)
                .to_string(),
        );
    }
    payload["projectPath"].as_str().map(str::to_string)
}
fn carries_state(event: &Value) -> bool {
    event["payload"]["stateTooLarge"] == true || event["payload"]["state"].is_object()
}
fn hydrated_batch(batch: Vec<Value>, state: Option<&Value>) -> Vec<Value> {
    let last = batch.iter().rposition(|event| {
        matches!(
            event["channel"].as_str(),
            Some("project:state" | "link:state")
        )
    });
    batch
        .into_iter()
        .enumerate()
        .filter_map(|(index, mut event)| {
            if !carries_state(&event) {
                return Some(event);
            }
            let state_event = matches!(
                event["channel"].as_str(),
                Some("project:state" | "link:state")
            );
            if state.is_none() && event["payload"]["stateTooLarge"] != true {
                return Some(event);
            }
            if state_event && (state.is_none() || Some(index) != last) {
                return None;
            }
            if let Some(payload) = event["payload"].as_object_mut() {
                payload.remove("stateTooLarge");
                payload.remove("state");
                if let Some(state) = state {
                    payload.insert("state".into(), state.clone());
                }
            }
            Some(event)
        })
        .collect()
}

fn page_manifest(manifest: &Value, id_field: &str) -> Result<(Value, usize), Value> {
    let count = manifest["pageCount"]
        .as_u64()
        .filter(|n| *n > 0 && *n <= MAX_PAGES as u64)
        .ok_or_else(|| error("INVALID_RESPONSE", "The daemon sent an invalid page count"))?;
    // The production Node page store uses positive numeric IDs; paired/newer hosts may use opaque strings.
    let valid_id = manifest[id_field].as_str().is_some_and(|id| !id.is_empty())
        || manifest[id_field]
            .as_u64()
            .is_some_and(|id| id > 0 && id <= 9_007_199_254_740_991);
    if !valid_id {
        return Err(error(
            "INVALID_RESPONSE",
            "The daemon sent an invalid page ID",
        ));
    }
    Ok((manifest[id_field].clone(), count as usize))
}
fn append_page(parts: &mut String, page: &Value) -> Result<(), Value> {
    let text = page
        .as_str()
        .ok_or_else(|| error("INVALID_RESPONSE", "The daemon sent a non-string page"))?;
    if parts.len().saturating_add(text.len()) > MAX_PAGED_BYTES {
        return Err(error(
            "FRAME_TOO_LARGE",
            "The daemon's paged result exceeds the size limit",
        ));
    }
    parts.push_str(text);
    Ok(())
}

#[derive(Default, Clone)]
struct View {
    scope: Option<String>,
    opened: BTreeSet<String>,
    chat: Value,
    focused: bool,
}
impl View {
    fn observe(&mut self, method: &str, args: &Value, result: &Value) {
        if matches!(
            method,
            "project:open"
                | "project:current"
                | "project:switch"
                | "canvas:open-project"
                | "onboarding:create"
                | "onboarding:clone"
                | "onboarding:init-git"
        ) {
            if let Some(path) = result["path"].as_str() {
                self.scope = Some(path.to_string());
                if method != "canvas:open-project" {
                    self.opened.insert(path.to_string());
                }
            }
        }
        if method == "link:open" {
            if let Some(id) = result["link"]["id"].as_str() {
                let scope = format!("milagre-link:{id}");
                self.scope = Some(scope.clone());
                self.opened.insert(scope);
            }
        }
        if method == "link:delete" {
            if let Some(id) = args[0].as_str() {
                self.forget(&format!("milagre-link:{id}"));
            }
        }
        if method == "project:forget" {
            if let Some(path) = args[0].as_str() {
                self.forget(path);
            }
        }
        if method == "chat:set-open" {
            self.chat = args[0].clone();
        }
        if result["state"]["deletedAt"].is_string() {
            if let Some(id) = args[0].as_str() {
                if method == "link:snapshot" {
                    self.forget(&format!("milagre-link:{id}"));
                } else if method == "state:read" && id.starts_with("milagre-link:") {
                    self.forget(id);
                }
            }
        }
    }
    fn observe_event(&mut self, event: &Value) {
        // Deletion can originate in Electron or a phone. Hydrated Link state has the same shape.
        let payload = &event["payload"];
        let deleted = payload["state"]["deletedAt"].is_string()
            || payload["patch"]["v"]["deletedAt"].is_string()
            || payload["patch"]["o"]["deletedAt"]["v"].is_string();
        if event["channel"] == "link:state" && deleted {
            if let Some(id) = event["payload"]["linkId"].as_str() {
                self.forget(&format!("milagre-link:{id}"));
            }
        }
    }
    fn forget(&mut self, scope: &str) {
        self.opened.remove(scope);
        if self.scope.as_deref() == Some(scope) {
            self.scope = None;
            self.chat = Value::Null;
        }
    }
}
struct Shared {
    connected_once: AtomicBool,
    connection: Mutex<Option<Arc<Connection>>>,
    changed: Condvar,
    last_error: Mutex<Value>,
    view: Mutex<View>,
}
#[derive(Clone)]
pub struct Transport {
    shared: Arc<Shared>,
}
impl Transport {
    pub fn connection_state(&self) -> Value {
        let connection = self
            .shared
            .connection
            .lock()
            .unwrap()
            .as_ref()
            .filter(|c| c.closed().is_none())
            .cloned();
        if let Some(connection) = connection {
            connected_state(connection.outdated.load(Ordering::Acquire))
        } else {
            json!({"connected":false,"message":self.shared.last_error.lock().unwrap()["message"]})
        }
    }
    pub async fn call(&self, method: String, args: Value) -> Reply {
        if !allowed(&method) {
            return Err(error(
                "UNSUPPORTED_COMMAND",
                format!("Command is unavailable through the Rust renderer: {method}"),
            ));
        }
        self.dispatch(method, args).await
    }
    pub(crate) async fn internal_call(&self, method: String, args: Value) -> Reply {
        if !internal_allowed(&method) {
            return Err(error(
                "UNSUPPORTED_COMMAND",
                format!("Unknown internal desktop command: {method}"),
            ));
        }
        self.dispatch(method, args).await
    }
    async fn dispatch(&self, method: String, args: Value) -> Reply {
        if !args.is_array() {
            return Err(error("INVALID_REQUEST", "Expected an arguments array"));
        }
        // Focus is local state even while disconnected, and must be restored on the next connection.
        if method == "daemon:focus" {
            self.shared.view.lock().unwrap().focused = args[0]["focused"] == true;
        }
        let transport = self.clone();
        tauri::async_runtime::spawn_blocking(move || transport.call_blocking(&method, args))
            .await
            .map_err(|e| error("TRANSPORT_FAILED", e.to_string()))?
    }
    fn call_blocking(&self, method: &str, args: Value) -> Reply {
        let until = Instant::now() + Duration::from_secs(30);
        let connection = {
            let mut current = self.shared.connection.lock().unwrap();
            loop {
                if let Some(connection) = current.as_ref() {
                    break connection.clone();
                }
                if self.shared.connected_once.load(Ordering::Acquire) {
                    return Err(gone());
                }
                let remaining = until.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err(self.shared.last_error.lock().unwrap().clone());
                }
                current = self
                    .shared
                    .changed
                    .wait_timeout(current, remaining)
                    .unwrap()
                    .0;
            }
        };
        let result = connection.request(method, args.clone())?;
        self.shared
            .view
            .lock()
            .unwrap()
            .observe(method, &args, &result);
        Ok(result)
    }
}

pub fn start(app: tauri::AppHandle) -> Transport {
    start_with_source(app, EndpointSource::Installed)
}
enum EndpointSource {
    Installed,
    #[cfg(feature = "app-fixture")]
    Fixture(Arc<crate::fixture_launch::LaunchContext>),
    #[cfg(feature = "chat-desktop")]
    Chat(Arc<crate::fixture_launch::LaunchContext>),
}
impl EndpointSource {
    fn fixture(&self) -> bool {
        match self {
            Self::Installed => false,
            #[cfg(feature = "app-fixture")]
            Self::Fixture(_) => true,
            #[cfg(feature = "chat-desktop")]
            Self::Chat(_) => true,
        }
    }
    fn connect(&self) -> Result<UnixStream, Value> {
        match self {
            Self::Installed => socket_path().and_then(|path| {
                UnixStream::connect(path).map_err(|e| {
                    error(
                        "DAEMON_UNAVAILABLE",
                        format!("Open the installed Milagre to reconnect: {e}"),
                    )
                })
            }),
            #[cfg(feature = "app-fixture")]
            Self::Fixture(context) => context.connect(),
            #[cfg(feature = "chat-desktop")]
            Self::Chat(context) => context.connect(),
        }
    }
}
#[cfg(feature = "app-fixture")]
#[allow(dead_code)]
pub fn start_fixture(
    app: tauri::AppHandle,
    context: Arc<crate::fixture_launch::LaunchContext>,
) -> Transport {
    start_with_source(app, EndpointSource::Fixture(context))
}
#[cfg(feature = "chat-desktop")]
#[allow(dead_code)]
pub fn start_chat(
    app: tauri::AppHandle,
    context: Arc<crate::fixture_launch::LaunchContext>,
) -> Transport {
    start_with_source(app, EndpointSource::Chat(context))
}
fn start_with_source(app: tauri::AppHandle, source: EndpointSource) -> Transport {
    let shared = Arc::new(Shared {
        connected_once: AtomicBool::new(false),
        connection: Mutex::new(None),
        changed: Condvar::new(),
        last_error: Mutex::new(error(
            "DAEMON_UNAVAILABLE",
            match &source {
                EndpointSource::Installed => "Connecting to the installed Milagre daemon",
                #[cfg(feature = "app-fixture")]
                EndpointSource::Fixture(_) => "Connecting to the owned scripted fixture",
                #[cfg(feature = "chat-desktop")]
                EndpointSource::Chat(_) => "Connecting to the owned Rust Chat runtime",
            },
        )),
        view: Mutex::new(View::default()),
    });
    let observed = Arc::downgrade(&shared);
    let emit: Emit = Arc::new(move |event| {
        if let Some(shared) = observed.upgrade() {
            shared.view.lock().unwrap().observe_event(&event);
        }
        let _ = app.emit("daemon-event", event);
    });
    let transport = Transport {
        shared: shared.clone(),
    };
    thread::spawn(move || supervise(shared, emit, source));
    transport
}
fn supervise(shared: Arc<Shared>, emit: Emit, source: EndpointSource) {
    let mut connected_before = false;
    loop {
        let connected = source
            .connect()
            .and_then(|socket| Connection::new(socket, emit.clone()));
        let reason = match connected {
            Err(reason) => reason,
            Ok(connection) => {
                let ready = if source.fixture() {
                    configure_mode(&connection, &shared, connected_before, true)
                } else {
                    configure(&connection, &shared, connected_before)
                };
                match ready {
                    Err(reason) => {
                        connection.close(reason.clone());
                        reason
                    }
                    Ok(snapshot) => {
                        // Recovery finishes before renderer commands can mutate the new connection.
                        connection.release_events(snapshot);
                        if let Some(reason) = connection.closed() {
                            reason
                        } else {
                            {
                                let mut current = shared.connection.lock().unwrap();
                                *current = Some(connection.clone());
                                shared.connected_once.store(true, Ordering::Release);
                            }
                            shared.changed.notify_all();
                            (emit)(
                                json!({"channel":"runtime:connection","payload":connected_state(connection.outdated.load(Ordering::Acquire))}),
                            );
                            connected_before = true;
                            let mut pending = connection.pending.lock().unwrap();
                            while pending.closed.is_none() {
                                pending = connection.available.wait(pending).unwrap();
                            }
                            let reason = pending.closed.clone().unwrap();
                            drop(pending);
                            *shared.connection.lock().unwrap() = None;
                            reason
                        }
                    }
                }
            }
        };
        *shared.last_error.lock().unwrap() = reason.clone();
        (emit)(
            json!({"channel":"runtime:connection","payload":{"connected":false,"message":reason["message"]}}),
        );
        if source.fixture()
            && matches!(
                reason["code"].as_str(),
                Some("FIXTURE_CHILD_EXITED" | "FIXTURE_ENDPOINT_INVALID")
            )
        {
            shared.changed.notify_all();
            break;
        }
        // This reconnects only. It does not launch, stop, upgrade, or recover locks of the owner daemon.
        thread::sleep(Duration::from_secs(1));
    }
}
fn connected_state(outdated: bool) -> Value {
    if outdated {
        json!({"connected":true,"hostOutdated":true,"message":"Restart Milagre's background host to load large Projects and enable computer management."})
    } else {
        json!({"connected":true})
    }
}
fn capability_set(status: &Value) -> HashSet<String> {
    status["capabilities"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}
fn patch_options(capabilities: &HashSet<String>) -> Option<Value> {
    if capabilities.contains("chat-pages-v1") {
        let mut form = json!({"messages":false});
        if capabilities.contains("subagent-tails-v1") {
            form["transcripts"] = json!(false);
            if capabilities.contains("archived-subagent-summaries-v1") {
                form["archivedSubagents"] = json!(false);
            }
        }
        Some(json!([form]))
    } else if capabilities.contains("state-patches-v1") {
        Some(json!([]))
    } else {
        None
    }
}

fn configure(
    connection: &Connection,
    shared: &Shared,
    reconnect: bool,
) -> Result<Option<Value>, Value> {
    configure_mode(connection, shared, reconnect, false)
}
fn configure_mode(
    connection: &Connection,
    shared: &Shared,
    reconnect: bool,
    fixture: bool,
) -> Result<Option<Value>, Value> {
    let status = connection.request("daemon:status", json!([{ "computerManagement":true }]))?;
    if status["protocolVersion"] != 1 || status["closing"] == true {
        return Err(error(
            "INCOMPATIBLE_HOST",
            "The installed Milagre daemon is closing or uses an incompatible protocol",
        ));
    }
    let capabilities = capability_set(&status);
    connection.outdated.store(
        !capabilities.contains("result-pages-v1")
            || (!fixture && !capabilities.contains("computer-management-v1")),
        Ordering::Release,
    );
    if let Some(args) = patch_options(&capabilities) {
        connection.request("daemon:state-patches", args)?;
    }
    let view = shared.view.lock().unwrap().clone();
    if !reconnect {
        connection.request("daemon:focus", json!([{"focused":view.focused}]))?;
        return Ok(None);
    }
    for scope in view.opened.iter().chain(view.scope.iter()) {
        let (method, id) = if let Some(id) = scope.strip_prefix("milagre-link:") {
            ("link:open", id)
        } else {
            ("project:open", scope.as_str())
        };
        if let Err(reason) = connection.request(method, json!([id])) {
            if connection.closed().is_some()
                || matches!(
                    reason["code"].as_str(),
                    Some(
                        "DAEMON_CLOSED"
                            | "CLOSING"
                            | "UNAUTHORIZED"
                            | "ETIMEDOUT"
                            | "ECONNRESET"
                            | "ECONNABORTED"
                            | "EPIPE"
                            | "FRAME_TOO_LARGE"
                            | "INVALID_REQUEST"
                            | "INVALID_RESPONSE"
                            | "INCOMPATIBLE_PROTOCOL"
                    )
                )
            {
                return Err(reason);
            }
            shared.view.lock().unwrap().forget(scope);
        }
    }
    let view = shared.view.lock().unwrap().clone();
    connection.request("chat:set-open", json!([view.chat]))?;
    connection.request("daemon:focus", json!([{"focused":view.focused}]))?;
    let manifest = connection.request("daemon:snapshot", json!([{ "paged":true }]))?;
    let (id, count) = page_manifest(&manifest, "snapshotId")?;
    let mut parts = String::new();
    for index in 0..count {
        append_page(
            &mut parts,
            &connection.request("daemon:snapshot-page", json!([id, index]))?,
        )?;
    }
    serde_json::from_str(&parts)
        .map(Some)
        .map_err(|_| error("INVALID_RESPONSE", "The daemon snapshot is not valid JSON"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    #[cfg(feature = "app-fixture")]
    #[test]
    fn owned_fixture_uses_real_transport_without_claiming_computer_management() {
        let context = crate::fixture_launch::test_context();
        let connection = Connection::new(context.connect().unwrap(), Arc::new(|_| {})).unwrap();
        let shared = Shared {
            connected_once: AtomicBool::new(false),
            connection: Mutex::new(None),
            changed: Condvar::new(),
            last_error: Mutex::new(Value::Null),
            view: Mutex::new(View::default()),
        };
        configure_mode(&connection, &shared, false, true).unwrap();
        assert!(!connection.outdated.load(Ordering::Acquire));
        let status = connection.request("daemon:status", json!([])).unwrap();
        assert!(!capability_set(&status).contains("computer-management-v1"));
        let project = connection.request("project:current", json!([])).unwrap();
        assert_eq!(project["path"], context.project().to_str().unwrap());
        connection.request("chat:runs", json!([])).unwrap();
        connection.close(gone());
        context.request_quit().unwrap();
    }
    fn receive_event(receiver: &mpsc::Receiver<Value>) -> Value {
        receiver.recv_timeout(Duration::from_secs(3)).unwrap()
    }
    fn respond(writer: &mut UnixStream, request: &Value, result: Value) {
        writeln!(
            writer,
            "{}",
            json!({"v":1,"id":request["id"],"result":result})
        )
        .unwrap();
    }
    #[test]
    fn renderer_allowlist_matches_preload_calls_exactly() {
        let preload = include_str!("../../../apps/desktop/electron/preload.cjs");
        let calls =
            regex::Regex::new(r#"\b(?:invoke|send)\(\s*"([a-zA-Z][a-zA-Z0-9:-]+)""#).unwrap();
        let mut expected: BTreeSet<String> = calls
            .captures_iter(preload)
            .map(|capture| capture[1].to_string())
            .collect();
        for action in ["add", "select", "login", "cancel", "remove"] {
            expected.insert(format!("accounts:{action}"));
        }
        assert_eq!(
            RENDERER_COMMANDS,
            expected.iter().map(String::as_str).collect::<Vec<_>>()
        );
        for method in ["project:plain-root", "link:workspace-roots", "daemon:focus"] {
            assert!(internal_allowed(method));
            assert!(!allowed(method));
        }
        assert!(!internal_allowed("daemon:stop"));
        assert!(!internal_allowed("desktop:invoke"));
    }
    #[test]
    fn state_patch_options_only_opt_into_advertised_capabilities() {
        let options = |caps: Value| patch_options(&capability_set(&json!({"capabilities":caps})));
        assert_eq!(options(json!([])), None);
        assert_eq!(options(json!(["state-patches-v1"])), Some(json!([])));
        assert_eq!(
            options(json!(["chat-pages-v1"])),
            Some(json!([{"messages":false}]))
        );
        assert_eq!(
            options(json!(["chat-pages-v1", "archived-subagent-summaries-v1"])),
            Some(json!([{"messages":false}]))
        );
        assert_eq!(
            options(json!(["chat-pages-v1", "subagent-tails-v1"])),
            Some(json!([{"messages":false,"transcripts":false}]))
        );
        assert_eq!(
            options(json!([
                "chat-pages-v1",
                "subagent-tails-v1",
                "archived-subagent-summaries-v1"
            ])),
            Some(json!([{"messages":false,"transcripts":false,"archivedSubagents":false}]))
        );
    }
    #[test]
    fn link_view_is_remembered_and_forgotten_after_remote_deletion() {
        let mut view = View::default();
        view.observe("project:open", &json!(["/one"]), &json!({"path":"/one"}));
        view.observe("link:open", &json!(["abc"]), &json!({"link":{"id":"abc"}}));
        view.observe(
            "chat:set-open",
            &json!(["milagre-link:abc#chat"]),
            &Value::Null,
        );
        assert_eq!(view.scope.as_deref(), Some("milagre-link:abc"));
        assert_eq!(view.opened.len(), 2);
        view.observe_event(&json!({"channel":"link:state","payload":{"linkId":"abc","state":{"deletedAt":"2026-11-10T00:00:00Z"}}}));
        assert_eq!(view.scope, None);
        assert_eq!(view.chat, Value::Null);
        assert_eq!(view.opened, BTreeSet::from(["/one".to_string()]));
        view.observe("link:open", &json!(["abc"]), &json!({"link":{"id":"abc"}}));
        view.observe_event(&json!({"channel":"link:state","payload":{"linkId":"abc","patch":{"o":{"deletedAt":{"v":"2026-11-10T00:00:00Z"}}}}}));
        assert_eq!(view.scope, None);
        view.observe("link:open", &json!(["abc"]), &json!({"link":{"id":"abc"}}));
        view.observe(
            "state:read",
            &json!(["milagre-link:abc"]),
            &json!({"state":{"deletedAt":"2026-11-10T00:00:00Z"}}),
        );
        assert_eq!(view.scope, None);
    }
    #[test]
    fn hydration_coalesces_states_and_keeps_terminal_events_on_read_failure() {
        let state_a =
            json!({"channel":"project:state","payload":{"path":"/p","stateTooLarge":true},"seq":1});
        let terminal = json!({"channel":"agent:done","payload":{"chatId":"/p#a","stateTooLarge":true,"reason":"done"},"seq":2});
        let state_b =
            json!({"channel":"project:state","payload":{"path":"/p","state":{"old":true}},"seq":3});
        let batch = vec![state_a.clone(), terminal.clone(), state_b.clone()];
        let state = json!({"saved":true});
        let hydrated = hydrated_batch(batch.clone(), Some(&state));
        assert_eq!(hydrated.len(), 2);
        assert_eq!(hydrated[0]["seq"], 2);
        assert_eq!(hydrated[1]["seq"], 3);
        for event in &hydrated {
            assert_eq!(event["payload"]["state"], state);
            assert!(event["payload"].get("stateTooLarge").is_none());
        }
        let failed = hydrated_batch(batch, None);
        assert_eq!(failed.len(), 2);
        assert_eq!(
            failed[0]["payload"],
            json!({"chatId":"/p#a","reason":"done"})
        );
        assert_eq!(failed[1], state_b);
    }
    #[test]
    fn oversized_link_state_is_read_in_pages_without_blocking_other_streams() {
        let (client, server) = UnixStream::pair().unwrap();
        server
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let (sender, receiver) = mpsc::channel();
        let connection = Connection::new(
            client,
            Arc::new(move |event| {
                sender.send(event).unwrap();
            }),
        )
        .unwrap();
        connection.release_events(None);
        connection.deliver(json!({"channel":"agent:done","payload":{"chatId":"milagre-link:abc#one","stateTooLarge":true},"seq":1})).unwrap();
        let mut writer = server.try_clone().unwrap();
        let mut reader = BufReader::new(server);
        let snapshot = read_frame(&mut reader, MAX_FRAME).unwrap();
        assert_eq!(snapshot["method"], "link:snapshot");
        assert_eq!(snapshot["args"], json!(["abc"]));
        // Same Chat stays behind the terminal state even while its snapshot request is in flight.
        connection.deliver(json!({"channel":"agent:stream","payload":{"chatId":"milagre-link:abc#one"},"seq":2})).unwrap();
        connection.deliver(json!({"channel":"agent:stream","payload":{"chatId":"milagre-link:abc#two"},"seq":3})).unwrap();
        connection
            .deliver(
                json!({"channel":"project:state","payload":{"path":"/other","state":{}},"seq":4}),
            )
            .unwrap();
        assert_eq!(receive_event(&receiver)["seq"], 3);
        assert_eq!(receive_event(&receiver)["seq"], 4);
        assert!(receiver.try_recv().is_err());
        writeln!(
            writer,
            "{}",
            json!({"v":1,"id":snapshot["id"],"pages":{"pageId":"page","pageCount":2}})
        )
        .unwrap();
        for (index, text) in ["{\"state\":{\"saved\":", "true}}"].into_iter().enumerate() {
            let request = read_frame(&mut reader, MAX_FRAME).unwrap();
            assert_eq!(request["method"], "daemon:result-page");
            assert_eq!(request["args"], json!(["page", index]));
            respond(&mut writer, &request, json!(text));
        }
        let terminal = receive_event(&receiver);
        assert_eq!(terminal["seq"], 1);
        assert_eq!(terminal["payload"]["state"], json!({"saved":true}));
        assert!(terminal["payload"].get("stateTooLarge").is_none());
        assert_eq!(receive_event(&receiver)["seq"], 2);
        connection.close(gone());
    }
    #[test]
    fn disconnected_hydration_never_releases_stale_state() {
        let (client, server) = UnixStream::pair().unwrap();
        server
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let (sender, receiver) = mpsc::channel();
        let connection = Connection::new(
            client,
            Arc::new(move |event| {
                sender.send(event).unwrap();
            }),
        )
        .unwrap();
        connection.release_events(None);
        connection
            .deliver(
                json!({"channel":"project:state","payload":{"path":"/p","stateTooLarge":true}}),
            )
            .unwrap();
        let mut reader = BufReader::new(server);
        assert_eq!(
            read_frame(&mut reader, MAX_FRAME).unwrap()["method"],
            "project:snapshot"
        );
        connection.close(gone());
        assert!(receiver.recv_timeout(Duration::from_millis(100)).is_err());
    }
    #[test]
    fn reconnect_restores_links_chat_focus_and_marks_old_hosts() {
        let (client, server) = UnixStream::pair().unwrap();
        server
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let connection = Connection::new(client, Arc::new(|_| {})).unwrap();
        let configuring = connection.clone();
        let configured = thread::spawn(move || {
            let shared = Shared {
                connected_once: AtomicBool::new(true),
                connection: Mutex::new(None),
                changed: Condvar::new(),
                last_error: Mutex::new(Value::Null),
                view: Mutex::new(View {
                    scope: Some("milagre-link:abc".into()),
                    opened: BTreeSet::from(["/p".into(), "milagre-link:abc".into()]),
                    chat: json!("milagre-link:abc#one"),
                    focused: true,
                }),
            };
            configure(&configuring, &shared, true)
        });
        let mut writer = server.try_clone().unwrap();
        let mut reader = BufReader::new(server);
        let status = read_frame(&mut reader, MAX_FRAME).unwrap();
        assert_eq!(status["method"], "daemon:status");
        respond(
            &mut writer,
            &status,
            json!({"protocolVersion":1,"capabilities":["chat-pages-v1"]}),
        );
        for (method, args, result) in [
            (
                "daemon:state-patches",
                json!([{"messages":false}]),
                Value::Null,
            ),
            ("project:open", json!(["/p"]), Value::Null),
            ("link:open", json!(["abc"]), Value::Null),
            ("link:open", json!(["abc"]), Value::Null),
            (
                "chat:set-open",
                json!(["milagre-link:abc#one"]),
                Value::Null,
            ),
            ("daemon:focus", json!([{"focused":true}]), Value::Null),
            (
                "daemon:snapshot",
                json!([{"paged":true}]),
                json!({"snapshotId":29,"pageCount":1}),
            ),
            (
                "daemon:snapshot-page",
                json!([29, 0]),
                json!("{\"eventSeq\":9}"),
            ),
        ] {
            let request = read_frame(&mut reader, MAX_FRAME).unwrap();
            assert_eq!(request["method"], method);
            assert_eq!(request["args"], args);
            respond(&mut writer, &request, result);
        }
        assert_eq!(
            configured.join().unwrap().unwrap(),
            Some(json!({"eventSeq":9}))
        );
        assert_eq!(
            connected_state(connection.outdated.load(Ordering::Acquire))["hostOutdated"],
            true
        );
        connection.close(gone());
    }
    #[test]
    fn frames_are_bounded_and_validate_protocol() {
        let mut input = Cursor::new(b"{\"v\":1,\"id\":7,\"result\":42}\n{\"v\":2}\n");
        assert_eq!(read_frame(&mut input, 100).unwrap()["result"], 42);
        assert_eq!(
            read_frame(&mut input, 100).unwrap_err()["code"],
            "INCOMPATIBLE_PROTOCOL"
        );
        assert_eq!(
            read_frame(&mut Cursor::new(b"123456"), 5).unwrap_err()["code"],
            "FRAME_TOO_LARGE"
        );
        assert_eq!(
            read_frame(&mut Cursor::new(b""), 5).unwrap_err()["code"],
            "DAEMON_CLOSED"
        );
    }
    #[test]
    fn lifecycle_and_unrecognized_methods_are_not_renderer_commands() {
        for method in [
            "daemon:stop",
            "daemon:flush",
            "daemon:authenticate",
            "desktop:register",
            "desktop:respond",
            "app-update:install",
            "made-up:method",
            "command:run",
            "desktop:invoke",
            "project:snapshot",
            "link:workspace-roots",
            "project:plain-root",
            "daemon:status",
            "daemon:snapshot",
            "daemon:focus",
        ] {
            assert!(!allowed(method), "{method}");
        }
        for method in [
            "chat:send",
            "chat:messages",
            "project:switch",
            "artifact:get",
            "terminal:input",
        ] {
            assert!(allowed(method), "{method}");
        }
    }
    #[test]
    fn page_manifests_and_contents_are_validated() {
        for field in ["pageId", "snapshotId"] {
            assert_eq!(
                page_manifest(&json!({field:17,"pageCount":2}), field).unwrap(),
                (json!(17), 2)
            );
            for id in [
                json!(0),
                json!(-1),
                json!(1.5),
                json!(9_007_199_254_740_992_u64),
                json!(null),
                json!(true),
                json!(""),
            ] {
                assert!(page_manifest(&json!({field:id,"pageCount":1}), field).is_err());
            }
        }
        assert_eq!(
            page_manifest(&json!({"pageId":"x","pageCount":2}), "pageId")
                .unwrap()
                .1,
            2
        );
        for count in [json!(0), json!(1025), json!(-1), json!(1.5), json!("2")] {
            assert!(page_manifest(&json!({"pageId":"x","pageCount":count}), "pageId").is_err());
        }
        assert!(append_page(&mut String::new(), &json!({})).is_err());
    }
    #[test]
    fn multiplexes_out_of_order_errors_events_and_pages() {
        let (client, server) = UnixStream::pair().unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let collected = events.clone();
        let connection =
            Connection::new(client, Arc::new(move |e| collected.lock().unwrap().push(e))).unwrap();
        connection.release_events(None);
        let first = connection.clone();
        let a = thread::spawn(move || first.request("first", json!([])));
        let second = connection.clone();
        let b = thread::spawn(move || second.request("second", json!([])));
        let mut writer = server.try_clone().unwrap();
        let mut reader = BufReader::new(server);
        let one = read_frame(&mut reader, MAX_FRAME).unwrap();
        let two = read_frame(&mut reader, MAX_FRAME).unwrap();
        let requests = [one, two];
        let aid = requests.iter().find(|r| r["method"] == "first").unwrap()["id"].clone();
        let bid = requests.iter().find(|r| r["method"] == "second").unwrap()["id"].clone();
        writeln!(
            writer,
            "{}",
            json!({"v":1,"id":bid,"error":{"code":"DENIED","message":"No","detail":123}})
        )
        .unwrap();
        writeln!(
            writer,
            "{}",
            json!({"v":1,"event":{"channel":"project:state","payload":{"path":"x"},"seq":8}})
        )
        .unwrap();
        writeln!(
            writer,
            "{}",
            json!({"v":1,"id":aid,"pages":{"pageId":17,"pageCount":2}})
        )
        .unwrap();
        for (index, part) in ["{\"answer\":", "42}"].iter().enumerate() {
            let request = read_frame(&mut reader, MAX_FRAME).unwrap();
            assert_eq!(request["method"], "daemon:result-page");
            assert_eq!(request["args"], json!([17, index]));
            writeln!(
                writer,
                "{}",
                json!({"v":1,"id":request["id"],"result":part})
            )
            .unwrap();
        }
        assert_eq!(a.join().unwrap().unwrap(), json!({"answer":42}));
        assert_eq!(
            b.join().unwrap().unwrap_err(),
            json!({"code":"DENIED","message":"No","detail":123})
        );
        assert_eq!(events.lock().unwrap()[0]["seq"], 8);
        connection.close(gone());
    }
    #[test]
    fn disconnect_fails_pending_calls_without_replay() {
        let (client, server) = UnixStream::pair().unwrap();
        let connection = Connection::new(client, Arc::new(|_| {})).unwrap();
        let caller = connection.clone();
        let call = thread::spawn(move || caller.request("chat:send", json!([{"body":"one"}])));
        let mut server = BufReader::new(server);
        assert_eq!(
            read_frame(&mut server, MAX_FRAME).unwrap()["method"],
            "chat:send"
        );
        drop(server);
        assert_eq!(call.join().unwrap().unwrap_err()["code"], "DAEMON_CLOSED");
        assert_eq!(
            connection.request("chat:send", json!([])).unwrap_err()["code"],
            "DAEMON_CLOSED"
        );
    }
    #[test]
    fn snapshot_precedes_only_events_newer_than_watermark() {
        let (client, _server) = UnixStream::pair().unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let collected = events.clone();
        let connection =
            Connection::new(client, Arc::new(move |e| collected.lock().unwrap().push(e))).unwrap();
        for seq in [4, 5, 6] {
            connection
                .receive(json!({"v":1,"event":{"channel":"project:state","payload":{},"seq":seq}}))
                .unwrap();
        }
        connection.release_events(Some(json!({"eventSeq":5})));
        let got = events.lock().unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0]["channel"], "runtime:snapshot");
        assert_eq!(got[1]["seq"], 6);
        connection.close(gone());
    }
    #[test]
    #[ignore = "reads the currently running installed Milagre daemon"]
    fn live_owner_reads_renderer_startup_and_chat_pages() {
        let connection = Connection::new(
            UnixStream::connect(socket_path().unwrap()).unwrap(),
            Arc::new(|_| {}),
        )
        .unwrap();
        let shared = Shared {
            connected_once: AtomicBool::new(false),
            connection: Mutex::new(None),
            changed: Condvar::new(),
            last_error: Mutex::new(Value::Null),
            view: Mutex::new(View::default()),
        };
        configure(&connection, &shared, false).unwrap();
        connection.release_events(None);
        let recent = connection.request("project:recent", json!([])).unwrap();
        let path = recent
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["hidden"] != true)
            .unwrap()["path"]
            .clone();
        let project = connection.request("project:read", json!([path])).unwrap();
        assert!(project["state"]["sessions"].is_object());
        assert_eq!(project["state"]["messagesInChats"], true);
        if let Some(chat) = project["state"]["sessions"]
            .as_object()
            .unwrap()
            .values()
            .next()
        {
            let page = connection
                .request("chat:messages", json!([path,chat["id"],{"limit":5}]))
                .unwrap();
            assert!(page["messages"].is_array());
        }
        connection.close(gone());
    }
}

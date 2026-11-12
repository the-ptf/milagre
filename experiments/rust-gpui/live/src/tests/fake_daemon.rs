//! A fake Node daemon for the Node-daemon mode's tests: protocol 1 on the socket path the real daemon derives from a
//! throwaway data folder (`/tmp/milagre-<uid>/<sha256(dir)[..24]>.sock`, as `apps/daemon/src/bootstrap.cjs` does and
//! the client's own tests use), so `InstalledOwner::adopt_profile` adopts it through the public path. The installed
//! Milagre's socket is a different file in the same folder and is never touched.
//!
//! It serves what the Preview calls, with the shapes the Node daemon sends (`daemon:status` with `desktop-commands-v1`, listing
//! `project:open` and `daemon:snapshot` only to `{commands: true}`, paged snapshots, `project:known`, `chat:messages`, the Chat, sidebar, terminal and Git
//! methods) and pushes `project:state` / `agent:event` frames to every connection, numbered globally. Every request is
//! logged with the connection it came on, so a test can assert what was (and was not) asked: no `project:open` at
//! all, no `project:read` of a Project the daemon has not loaded until the person opens it, no `daemon:snapshot` on
//! a Terminal's connection. `project:read [path, {state:false}]` loads a Project (it joins later snapshots), as the
//! Node daemon's `readProject` does; `agent:models` answers [`World::models`].
//!
//! A send's body picks its turn: `[approve]` waits on a permission request, `[ask]` on a question, `[hold]` streams
//! until interrupted, anything else replies at once.

use std::collections::BTreeMap;
use std::io::{BufRead as _, BufReader, Write as _};
use std::os::unix::fs::PermissionsExt as _;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde_json::{Value, json};

/// What `daemon:status []` lists. The desktop's own commands ([`DESKTOP`]) are added only to `daemon:status
/// [{commands: true}]`, as the Node daemon does (`desktop-commands-v1`, the client's two-step handshake).
const METHODS: &[&str] = &[
    "project:known",
    "project:read",
    "project:current",
    "state:read",
    "chat:runs",
    "chat:messages",
    "daemon:snapshot-page",
    "daemon:result-page",
    "chat:send",
    "chat:send-status",
    "agent:models",
    "agent:ports",
    "pull-requests:snapshot",
    "accounts:list",
    "usage:cached",
    "usage:accounts:cached",
    "agent:interrupt",
    "agent:respond-permission",
    "agent:answer-question",
    "agent:set-permission-mode",
    "chat:queue-send",
    "chat:queue-remove",
    "chat:patch",
    "terminal:list",
    "terminal:profiles",
    "terminal:open",
    "terminal:read",
    "terminal:input",
    "terminal:resize",
    "terminal:close",
    "git:changes",
    "git:history",
    "git:diff-files",
    "git:diff-file",
    // The sidebar's other writes (`sidebar_writes`).
    "chat:delete",
    "worktree:roots",
    "canvas:links",
    "canvas:link-add",
    "canvas:link-remove",
    "canvas:link-restore",
    "linked:grant",
    "worktree:status",
    "worktree:remove",
    "chat:reload",
    "chat:detach",
    "worktree:unlink-issue",
    "project:set-hidden",
    "project:recent",
];

/// The desktop's own commands, listed only to a client asking `daemon:status [{commands: true}]`.
const DESKTOP: &[&str] = &["project:open", "daemon:snapshot"];

/// A Chat: id, title, messages as (role, body).
pub type ChatSpec<'a> = (u64, &'a str, Vec<(&'a str, &'a str)>);
/// A Project: path, name, loaded this run, its Chats.
pub type ProjectSpec<'a> = (&'a str, &'a str, bool, Vec<ChatSpec<'a>>);

pub struct Project {
    pub name: String,
    /// In the daemon's snapshot (loaded this run).
    pub loaded: bool,
    pub sessions: BTreeMap<u64, Value>,
    pub messages: BTreeMap<u64, Vec<Value>>,
    /// Hidden from the sidebar (`project:set-hidden`).
    pub hidden: bool,
}

#[derive(Default)]
pub struct World {
    pub known: Vec<String>,
    pub projects: BTreeMap<String, Project>,
    pub runs: serde_json::Map<String, Value>,
    pub runs_seq: u64,
    pub event_seq: u64,
    next_message: u64,
    next_request: u64,
    /// Every request: method and args.
    pub log: Vec<(String, Value)>,
    /// Every request's connection (numbered from 1 in the order they connected) and method, parallel to `log`.
    pub connections: Vec<(u64, String)>,
    next_connection: u64,
    /// `agent:models`' answer.
    pub models: Value,
    /// Methods `daemon:status` leaves out even to `{commands: true}` (a daemon that does not serve them).
    pub unlisted: Vec<String>,
    /// `agent:ports`' answer (every Chat's ports by Chat key).
    pub ports: Value,
    /// `usage:cached`'s answer (null: no providers).
    pub usage: Value,
    /// `pull-requests:snapshot`'s answer, by Project path.
    pub prs: BTreeMap<String, Value>,
    /// Worktrees Milagre made, by Project path: id, folder and base (Worktree 1 is the Project's own folder).
    pub worktrees: BTreeMap<String, Vec<(u64, String, String)>>,
    /// `worktree:roots`' answer.
    pub roots: Vec<String>,
    /// `worktree:status`' answer, by folder.
    pub statuses: BTreeMap<String, Value>,
    /// `worktree:remove` refuses with this.
    pub remove_error: Option<String>,
    /// The canvas Links (`canvas:links`), as the daemon lists them.
    pub links: Vec<Value>,
    next_link: u64,
    /// `linked:grant`s: Chat key and Link id.
    pub grants: Vec<(String, String)>,
    /// Pending turns by Chat key: what finishes them.
    pending: BTreeMap<String, Pending>,
    terminals: BTreeMap<String, String>,
    snapshots: BTreeMap<String, String>,
    writers: Vec<Arc<Mutex<UnixStream>>>,
}

#[derive(Clone)]
enum Pending {
    Permission(String),
    Question(String),
    Hold,
}

fn now() -> i64 {
    crate::transcript::now_ms()
}

impl World {
    /// A world with Projects (`path`, `name`, loaded) and their Chats (`id`, `title`, messages as (role, body)).
    pub fn with(projects: Vec<ProjectSpec<'_>>) -> Self {
        let mut world = World {
            next_message: 100,
            models: json!({
                "claude": [{"id":"claude-opus-5-5","name":"Opus 5.5","recommended":true},{"id":"claude-sonnet-5","recommended":true}],
                "codex": [{"id":"gpt-5.5","recommended":false},{"id":"gpt-6.1-sol","name":"GPT-6.1-Sol","recommended":true,"efforts":["low","medium","high"]}],
                "antigravity": [],
                "kiro": null,
            }),
            ..World::default()
        };
        for (path, name, loaded, chats) in projects {
            world.known.push(path.to_owned());
            let mut project =
                Project { name: name.to_owned(), loaded, sessions: BTreeMap::new(), messages: BTreeMap::new(), hidden: false };
            for (id, title, messages) in chats {
                project.sessions.insert(id, json!({"id":id,"worktree_id":1,"agent_name":"fake","provider":"codex","title":title,"permissionMode":"auto","summary":{"count":0}}));
                let list: Vec<Value> = messages
                    .into_iter()
                    .map(|(role, body)| {
                        world.next_message += 1;
                        json!({"id":world.next_message,"session_id":id,"body":body,"role":role,"model":"gpt-5.5","images":[]})
                    })
                    .collect();
                project.messages.insert(id, list);
            }
            world.projects.insert(path.to_owned(), project);
        }
        let paths: Vec<String> = world.projects.keys().cloned().collect();
        for path in paths {
            let ids: Vec<u64> = world.projects[&path].sessions.keys().copied().collect();
            for id in ids {
                world.summarize(&path, id);
            }
        }
        world
    }

    fn summarize(&mut self, path: &str, id: u64) {
        let project = self.projects.get_mut(path).expect("project");
        let messages = project.messages.get(&id).cloned().unwrap_or_default();
        let at = 1_700_000_000_000i64 + (id as i64) * 1000 + messages.len() as i64;
        let session = project.sessions.get_mut(&id).expect("chat");
        session["summary"] = json!({
            "count": messages.len(),
            "lastAt": at,
            "firstAt": at,
            "lastModel": messages.iter().rev().find_map(|m| m["model"].as_str()).unwrap_or("gpt-5.5"),
            "titleLine": messages.first().map(|m| m["body"].clone()).unwrap_or(Value::Null),
        });
    }

    fn state(&self, path: &str) -> Value {
        let project = &self.projects[path];
        let sessions: serde_json::Map<String, Value> = project.sessions.iter().map(|(id, s)| (id.to_string(), s.clone())).collect();
        let mut worktrees = serde_json::Map::new();
        worktrees.insert("1".into(), json!({"id":1,"path":path,"name":project.name,"project_id":1}));
        for (id, folder, base) in self.worktrees.get(path).into_iter().flatten() {
            worktrees.insert(id.to_string(), json!({"id":id,"path":folder,"name":format!("w{id}"),"project_id":1,"base":base}));
        }
        json!({
            "next_id": project.sessions.keys().max().copied().unwrap_or(0) + 1,
            "worktrees": worktrees,
            "sessions": sessions,
            "messages": [],
            "projects": {"1": {"id":1,"name":project.name}},
            "tasks": {},
        })
    }

    /// `project:recent`: every known Project, a hidden one marked.
    fn recent(&self) -> Value {
        Value::Array(
            self.known
                .iter()
                .map(|p| {
                    let project = &self.projects[p];
                    if project.hidden { json!({"path":p,"name":project.name,"hidden":true}) } else { json!({"path":p,"name":project.name}) }
                })
                .collect(),
        )
    }

    fn snapshot(&self) -> Value {
        let projects: Vec<Value> = self
            .known
            .iter()
            .filter(|path| self.projects[*path].loaded)
            .map(|path| json!({"path":path,"name":self.projects[path].name,"state":self.state(path)}))
            .collect();
        json!({"projects":projects,"links":[],"runs":{"runs":self.runs,"seq":self.runs_seq},"ports":{},"eventSeq":self.event_seq})
    }

    pub fn emit(&mut self, channel: &str, payload: Value) {
        self.event_seq += 1;
        let frame = json!({"v":1,"event":{"channel":channel,"payload":payload,"seq":self.event_seq}}).to_string();
        self.writers.retain(|writer| writeln!(writer.lock().unwrap(), "{frame}").is_ok());
    }

    fn emit_state(&mut self, path: &str) {
        let state = self.state(path);
        self.emit("project:state", json!({"path":path,"state":state}));
    }

    fn agent(&mut self, key: &str, event: Value) {
        self.runs_seq += 1;
        let seq = self.runs_seq;
        self.emit("agent:event", json!({"chatId":key,"event":event,"seq":seq}));
    }

    fn split(key: &str) -> (String, u64) {
        let (path, id) = key.rsplit_once('#').expect("a Chat key");
        (path.to_owned(), id.parse().expect("a Chat id"))
    }

    fn finish(&mut self, key: &str, reply: &str, outcome: &str) {
        let (path, id) = Self::split(key);
        self.next_message += 1;
        let model = self.runs.get(key).and_then(|run| run["model"].as_str()).unwrap_or("gpt-5.5").to_owned();
        let message = json!({"id":self.next_message,"session_id":id,"body":reply,"role":"assistant","model":model,"outcome":outcome});
        self.projects.get_mut(&path).unwrap().messages.entry(id).or_default().push(message);
        self.summarize(&path, id);
        self.pending.remove(key);
        self.runs.remove(key);
        self.emit_state(&path);
        let kind = if outcome == "cancelled" { "turn-cancelled" } else { "turn-completed" };
        self.agent(key, json!({"type":kind}));
    }

    fn send(&mut self, request: &Value) -> Result<Value, String> {
        let path = request["projectPath"].as_str().ok_or("projectPath")?.to_owned();
        let body = request["body"].as_str().ok_or("body")?.to_owned();
        let model = request["model"].as_str().ok_or("model")?.to_owned();
        let provider = request["provider"].as_str().ok_or("provider")?.to_owned();
        let project = self.projects.get_mut(&path).ok_or("Open this project in Milagre first.")?;
        let id = match request["sessionId"].as_u64() {
            Some(id) if project.sessions.contains_key(&id) => {
                // Another provider: the daemon switches the Chat (or hands it off) on this send.
                project.sessions.get_mut(&id).unwrap()["provider"] = json!(provider);
                id
            }
            Some(_) => return Err("No such Chat".into()),
            None => {
                let id = project.sessions.keys().max().copied().unwrap_or(0) + 1;
                project.sessions.insert(id, json!({"id":id,"worktree_id":1,"agent_name":"fake","provider":provider,"summary":{"count":0}}));
                id
            }
        };
        self.next_message += 1;
        let message = json!({"id":self.next_message,"session_id":id,"body":body,"role":"user","model":model,"images":[],"clientMessageId":request["clientMessageId"]});
        let project = self.projects.get_mut(&path).unwrap();
        project.messages.entry(id).or_default().push(message);
        self.summarize(&path, id);
        let key = format!("{path}#{id}");
        self.emit_state(&path);
        self.runs
            .insert(key.clone(), json!({"text":"","model":model,"startedAt":now(),"steps":[],"approvals":[],"questions":[],"answered":{}}));
        self.agent(&key, json!({"type":"message-sent","model":model,"permissionMode":request["permissionMode"]}));
        self.agent(&key, json!({"type":"turn-started","turnId":format!("t{}", self.next_message)}));
        self.next_request += 1;
        let n = self.next_request;
        if body.contains("[approve]") {
            let request_id = format!("perm-{n}");
            self.pending.insert(key.clone(), Pending::Permission(request_id.clone()));
            self.agent(&key, json!({"type":"permission-request","requestId":request_id,"kind":"command","tool":"Bash","title":"Run printf","command":"printf ok","allowForChat":true}));
            // The daemon's own notice to desktops (`server.cjs`), what Electron's notifier shows.
            self.emit("notification:waiting", json!({"chatId":key,"requestId":request_id,"title":"Needs approval","body":"Run printf"}));
        } else if body.contains("[ask]") {
            let request_id = format!("q-{n}");
            self.pending.insert(key.clone(), Pending::Question(request_id.clone()));
            self.agent(&key, json!({"type":"question-request","requestId":request_id,"questions":[{"id":"pick","header":"Pick","question":"Which one?","options":[{"label":"A"},{"label":"B"}],"multiSelect":false}]}));
        } else if body.contains("[hold]") {
            self.pending.insert(key.clone(), Pending::Hold);
            self.agent(&key, json!({"type":"text-delta","text":"Working"}));
        } else {
            let reply = format!("{provider} {model} replied to: {body}");
            self.agent(&key, json!({"type":"text-delta","text":reply}));
            self.finish(&key, &reply, "completed");
        }
        Ok(json!({"sessionId":id,"clientMessageId":request["clientMessageId"],"status":"accepted"}))
    }

    fn call(&mut self, method: &str, args: &Value, data_dir: &Path, pid: u32) -> Result<Value, String> {
        let arg = &args[0];
        Ok(match method {
            "daemon:status" => {
                let desktop = arg["commands"] == true;
                let methods: Vec<&str> = METHODS
                    .iter()
                    .chain(if desktop { DESKTOP } else { &[] })
                    .copied()
                    .filter(|m| !self.unlisted.iter().any(|u| u == m))
                    .collect();
                json!({"pid":pid,"protocolVersion":1,"closing":false,"version":"fake-node","dataDir":data_dir,
                    "capabilities":["desktop-v1","desktop-commands-v1","snapshot-pages-v1","result-pages-v1"],
                    "methods":methods})
            }
            "project:known" => Value::Array(self.known.iter().map(|p| json!({"path":p,"name":self.projects[p].name})).collect()),
            "daemon:snapshot" => {
                let id = format!("snap-{}", self.snapshots.len() + 1);
                self.snapshots.insert(id.clone(), self.snapshot().to_string());
                json!({"snapshotId":id,"pageCount":1,"eventSeq":self.event_seq})
            }
            "daemon:snapshot-page" => Value::String(self.snapshots.get(arg.as_str().ok_or("snapshot id")?).ok_or("no snapshot")?.clone()),
            "project:read" if args[1]["state"] == false => {
                // `readProject`: the Project loads (Worktrees reconciled, Chats resumed) and joins later snapshots.
                let path = arg.as_str().ok_or("path")?;
                let project = self.projects.get_mut(path).ok_or("Open this project in Milagre first.")?;
                project.loaded = true;
                json!({"path":path,"name":project.name,"version":1,"epoch":"fake"})
            }
            "project:open" if !self.projects.contains_key(arg.as_str().ok_or("path")?) => {
                // A folder opened for the first time (Add Project): registered, first in the recent list, loaded.
                let path = arg.as_str().ok_or("path")?.to_owned();
                let name = path.rsplit('/').next().unwrap_or_default().to_owned();
                let project =
                    Project { name: name.clone(), loaded: true, sessions: BTreeMap::new(), messages: BTreeMap::new(), hidden: false };
                self.projects.insert(path.clone(), project);
                self.known.insert(0, path.clone());
                json!({"path":path,"name":name,"state":self.state(&path),"version":1,"epoch":"fake"})
            }
            "project:recent" => self.recent(),
            "project:set-hidden" => {
                let path = arg.as_str().ok_or("path")?;
                self.projects.get_mut(path).ok_or("That folder is not one of Milagre's Projects.")?.hidden = args[1] == true;
                self.recent()
            }
            "chat:delete" => {
                let (path, id) = (arg.as_str().ok_or("project")?.to_owned(), args[1].as_u64().ok_or("chat")?);
                let project = self.projects.get_mut(&path).ok_or("No such Project")?;
                project.sessions.remove(&id).ok_or("No such Chat")?;
                project.messages.remove(&id);
                self.emit_state(&path);
                Value::Null
            }
            "worktree:roots" => json!(self.roots),
            "canvas:links" => json!(self.links),
            "canvas:link-add" => {
                let (a, b) = (arg.clone(), args[1].clone());
                if a["project_id"].as_str().is_none() || b["project_id"].as_str().is_none() {
                    return Err("Expected two Link ends".into());
                }
                self.next_link += 1;
                let link = json!({"id": format!("fake-link-{}", self.next_link), "a": a, "b": b, "created_at": "2026-11-12T00:00:00.000Z"});
                self.links.push(link.clone());
                self.emit("canvas:links-changed", json!({"links": self.links}));
                link
            }
            "canvas:link-remove" => {
                let id = arg.as_str().ok_or("id")?;
                let before = self.links.len();
                self.links.retain(|l| l["id"] != id);
                if self.links.len() == before {
                    return Err("No such Link".into());
                }
                self.emit("canvas:links-changed", json!({"links": self.links}));
                Value::Null
            }
            "canvas:link-restore" => {
                for key in ["id", "a", "b", "created_at"] {
                    if arg.get(key).is_none() {
                        return Err(format!("the Link needs {key}"));
                    }
                }
                self.links.push(arg.clone());
                self.emit("canvas:links-changed", json!({"links": self.links}));
                Value::Null
            }
            "linked:grant" => {
                let (chat, link) = (arg.as_str().ok_or("chatId")?, args[1].as_str().ok_or("linkId")?);
                if !self.links.iter().any(|l| l["id"] == link) {
                    return Err("No such Link".into());
                }
                self.grants.push((chat.to_owned(), link.to_owned()));
                Value::Null
            }
            "worktree:status" => {
                let folder = arg.as_str().ok_or("path")?;
                args[1].as_str().ok_or("base")?;
                self.statuses.get(folder).cloned().ok_or("not a worktree")?
            }
            "worktree:remove" => {
                let folder = arg.as_str().ok_or("path")?.to_owned();
                let path = args[1]["projectPath"].as_str().ok_or("projectPath")?.to_owned();
                if let Some(error) = &self.remove_error {
                    return Err(error.clone());
                }
                let list = self.worktrees.get_mut(&path).ok_or("No such Project")?;
                let ix = list.iter().position(|(_, f, _)| *f == folder).ok_or("not a worktree")?;
                let (id, _, _) = list.remove(ix);
                // The Worktree goes with its Chats.
                let project = self.projects.get_mut(&path).unwrap();
                let gone: Vec<u64> = project.sessions.iter().filter(|(_, s)| s["worktree_id"] == id).map(|(k, _)| *k).collect();
                for chat in gone {
                    project.sessions.remove(&chat);
                    project.messages.remove(&chat);
                }
                self.emit_state(&path);
                json!({"removed": true})
            }
            "chat:reload" => {
                let (path, id) = Self::split(arg.as_str().ok_or("chatId")?);
                self.projects.get(&path).and_then(|p| p.sessions.get(&id)).ok_or("No such Chat")?;
                Value::Null
            }
            "chat:detach" => {
                let (path, id) = (arg.as_str().ok_or("project")?.to_owned(), args[1].as_u64().ok_or("chat")?);
                let session = self.projects.get_mut(&path).and_then(|p| p.sessions.get_mut(&id)).ok_or("No such Chat")?;
                session.as_object_mut().unwrap().remove("parent");
                self.emit_state(&path);
                Value::String("Detached.".into())
            }
            "worktree:unlink-issue" => {
                let path = arg["projectPath"].as_str().ok_or("projectPath")?.to_owned();
                arg["worktreeId"].as_u64().ok_or("worktreeId")?;
                let state = self.state(&path);
                json!({"project":{"path":path,"state":state}})
            }
            "project:read" | "project:open" => {
                let path = arg.as_str().ok_or("path")?;
                let name = self.projects.get(path).ok_or("Open this project in Milagre first.")?.name.clone();
                json!({"path":path,"name":name,"state":self.state(path),"version":1,"epoch":"fake"})
            }
            "agent:models" => {
                let path = arg.as_str().ok_or("path")?;
                if !self.projects.get(path).is_some_and(|p| p.loaded) {
                    return Err("Open this project in Milagre first.".into());
                }
                self.models.clone()
            }
            "agent:ports" => {
                if self.ports.is_null() {
                    json!({})
                } else {
                    self.ports.clone()
                }
            }
            "pull-requests:snapshot" => {
                let path = arg.as_str().ok_or("path")?;
                self.prs.get(path).cloned().unwrap_or_else(|| json!({"worktrees":{},"chats":{},"pending":false}))
            }
            "usage:cached" => {
                // `validateAccountScope`: a scope the daemon does not know is refused.
                if let Some(scope) = arg.as_str()
                    && !self.projects.contains_key(scope)
                {
                    return Err("Project or Link is no longer available. Refresh and choose another.".into());
                }
                if self.usage.is_null() { json!({"providers":[]}) } else { self.usage.clone() }
            }
            "usage:accounts:cached" => {
                if self.usage.is_null() {
                    json!({"providers":[]})
                } else {
                    self.usage.clone()
                }
            }
            "accounts:list" => json!({"providers":[
                {"provider":"claude","selectedId":"default","installed":true,"accounts":[
                    {"id":"default","provider":"claude","label":"Connected CLI account","state":"ready","email":"me@example.com","plan":"Max"},
                    {"id":"work","provider":"claude","label":"Work","state":"signed-out"}]},
                {"provider":"kiro","selectedId":"default","installed":false,"accounts":[]}]}),
            "chat:runs" => json!({"runs":self.runs,"seq":self.runs_seq}),
            "chat:messages" => {
                let (path, id) = (arg.as_str().ok_or("scope")?, args[1].as_u64().ok_or("chat")?);
                let messages = self.projects.get(path).and_then(|p| p.messages.get(&id)).cloned().unwrap_or_default();
                json!({"messages":messages,"hasMore":false,"total":messages.len()})
            }
            "chat:send" => self.send(arg)?,
            "agent:respond-permission" => {
                let key = arg["chatId"].as_str().ok_or("chatId")?.to_owned();
                let request = arg["requestId"].as_str().ok_or("requestId")?.to_owned();
                match self.pending.get(&key) {
                    Some(Pending::Permission(id)) if *id == request => {}
                    _ => return Err("No such request".into()),
                }
                self.agent(&key, json!({"type":"permission-resolved","requestId":request,"decision":arg["decision"]}));
                let reply = format!("Allowed ({})", arg["decision"].as_str().unwrap_or_default());
                self.agent(&key, json!({"type":"text-delta","text":reply}));
                self.finish(&key, &reply, "completed");
                Value::Bool(true)
            }
            "agent:answer-question" => {
                let key = arg["chatId"].as_str().ok_or("chatId")?.to_owned();
                let request = arg["requestId"].as_str().ok_or("requestId")?.to_owned();
                match self.pending.get(&key) {
                    Some(Pending::Question(id)) if *id == request => {}
                    _ => return Err("No such question".into()),
                }
                self.agent(&key, json!({"type":"question-resolved","requestId":request}));
                let reply = format!("Answered {}", arg["answers"]);
                self.finish(&key, &reply, "completed");
                Value::Null
            }
            "agent:interrupt" => {
                let key = arg.as_str().ok_or("key")?.to_owned();
                if matches!(self.pending.get(&key), Some(Pending::Hold)) {
                    self.finish(&key, "Working", "cancelled");
                }
                Value::Null
            }
            "agent:set-permission-mode" | "chat:queue-send" | "chat:queue-remove" => Value::Null,
            "chat:patch" => {
                let (path, id, patch) = (arg.as_str().ok_or("project")?.to_owned(), args[1].as_u64().ok_or("chat")?, &args[2]);
                let session = self.projects.get_mut(&path).and_then(|p| p.sessions.get_mut(&id)).ok_or("No such Chat")?;
                if let Some(title) = patch["title"].as_str() {
                    session["title"] = json!(title);
                }
                if let Some(unread) = patch["unread"].as_bool() {
                    session["unread"] = json!(unread);
                }
                if let Some(archived) = patch["archived"].as_bool() {
                    session["archived"] = json!(archived);
                }
                if patch["kept"] == true {
                    session["kept"] = json!(true);
                }
                match patch["done"].as_bool() {
                    Some(true) => session["done_at"] = json!(now()),
                    Some(false) => {
                        session.as_object_mut().unwrap().remove("done_at");
                    }
                    None => {}
                }
                self.emit_state(&path);
                Value::Null
            }
            "terminal:profiles" => json!({"defaultShell":"/bin/fake-sh"}),
            "terminal:list" => json!([]),
            "terminal:open" => {
                // The client takes canonical lowercase UUIDs only.
                let id = format!("00000000-0000-4000-8000-{:012x}", self.terminals.len() + 1);
                self.terminals.insert(id.clone(), "fake-sh$ ".into());
                json!({"id":id})
            }
            "terminal:input" => {
                let id = arg["terminalId"].as_str().ok_or("terminalId")?;
                let data = arg["data"].as_str().ok_or("data")?;
                let screen = self.terminals.get_mut(id).ok_or("No such Terminal")?;
                // The fake shell echoes what it is sent, with "\r" as a new line.
                screen.push_str(&data.replace('\r', "\r\n"));
                Value::Null
            }
            "terminal:resize" | "terminal:close" => Value::Null,
            "terminal:read" => {
                let id = arg["terminalId"].as_str().ok_or("terminalId")?;
                let after = arg["after"].as_u64().unwrap_or(0) as usize;
                let screen = self.terminals.get(id).ok_or("No such Terminal")?;
                let data: String = screen.chars().skip(after).collect();
                json!({"data":data,"offset":screen.chars().count(),"reset":false,"ended":false})
            }
            "git:diff-files" => {
                json!({"isRepo":true,"base":"main","files":[{"path":"src/fake.rs","status":"modified","added":2,"removed":1}]})
            }
            "git:diff-file" => json!({"patch":"@@ -1 +1,2 @@\n-old\n+new\n+line\n"}),
            "git:history" => json!({"isRepo":true,"branch":"main","base":"main","commits":[],"hasMore":false}),
            "git:changes" => json!({"isRepo":true}),
            other => return Err(format!("unexpected {other}")),
        })
    }
}

/// A running fake daemon: its data folder, socket and world.
pub struct FakeDaemon {
    pub socket: PathBuf,
    pub world: Arc<Mutex<World>>,
    stop: Arc<(Mutex<bool>, Condvar)>,
}

/// The socket path the Node daemon derives from a data folder.
pub fn socket_for(data: &Path) -> PathBuf {
    let uid = unsafe { libc::getuid() };
    let directory = PathBuf::from(format!("/tmp/milagre-{uid}"));
    if !directory.exists() {
        std::fs::create_dir(&directory).unwrap();
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    // SHA-256 of the folder's path bytes (no newline), as the daemon's bootstrap hashes it.
    let mut shasum = std::process::Command::new("/usr/bin/shasum")
        .args(["-a", "256"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    shasum.stdin.take().unwrap().write_all(data.as_os_str().as_encoded_bytes()).unwrap();
    let digest = String::from_utf8(shasum.wait_with_output().unwrap().stdout).unwrap();
    directory.join(format!("{}.sock", &digest[..24]))
}

/// A new, canonical, private data folder for a fake daemon (never Milagre's own).
pub fn data_folder(name: &str) -> PathBuf {
    let base = std::env::temp_dir().join(format!("gpui-fake-daemon-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    let data = std::fs::canonicalize(&base).unwrap();
    assert!(!data.ends_with("Library/Application Support/Milagre"), "never the installed Milagre's data folder");
    data
}

impl FakeDaemon {
    /// Serves `world` for `data` in this process (the daemon's PID is this test's).
    pub fn start(data: &Path, world: World) -> FakeDaemon {
        let socket = socket_for(data);
        let _ = std::fs::remove_file(&socket);
        let listener = UnixListener::bind(&socket).unwrap();
        listener.set_nonblocking(true).unwrap();
        let world = Arc::new(Mutex::new(world));
        let stop = Arc::new((Mutex::new(false), Condvar::new()));
        let (shared, stopped, dir) = (world.clone(), stop.clone(), data.to_owned());
        std::thread::spawn(move || serve(listener, shared, stopped, dir));
        FakeDaemon { socket, world, stop }
    }

    pub fn log(&self) -> Vec<(String, Value)> {
        self.world.lock().unwrap().log.clone()
    }

    pub fn methods(&self) -> Vec<String> {
        self.log().into_iter().map(|(method, _)| method).collect()
    }

    /// Every request's connection and method.
    pub fn connections(&self) -> Vec<(u64, String)> {
        self.world.lock().unwrap().connections.clone()
    }

    pub fn world(&self) -> std::sync::MutexGuard<'_, World> {
        self.world.lock().unwrap()
    }

    /// Stops listening and closes every connection, as a quitting daemon does; the socket file goes.
    pub fn stop(&self) {
        *self.stop.0.lock().unwrap() = true;
        self.stop.1.notify_all();
        for writer in self.world.lock().unwrap().writers.drain(..) {
            let _ = writer.lock().unwrap().shutdown(std::net::Shutdown::Both);
        }
        let _ = std::fs::remove_file(&self.socket);
    }
}

impl Drop for FakeDaemon {
    fn drop(&mut self) {
        self.stop();
    }
}

fn serve(listener: UnixListener, world: Arc<Mutex<World>>, stop: Arc<(Mutex<bool>, Condvar)>, data: PathBuf) {
    let pid = std::process::id();
    loop {
        if *stop.0.lock().unwrap() {
            return;
        }
        match listener.accept() {
            Ok((stream, _)) => {
                stream.set_nonblocking(false).unwrap();
                let (world, stop, data) = (world.clone(), stop.clone(), data.clone());
                std::thread::spawn(move || connection(stream, world, stop, data, pid));
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(5)),
            Err(_) => return,
        }
    }
}

fn connection(stream: UnixStream, world: Arc<Mutex<World>>, stop: Arc<(Mutex<bool>, Condvar)>, data: PathBuf, pid: u32) {
    let writer = Arc::new(Mutex::new(stream.try_clone().unwrap()));
    let number = {
        let mut world = world.lock().unwrap();
        world.writers.push(writer.clone());
        world.next_connection += 1;
        world.next_connection
    };
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    while reader.read_line(&mut line).unwrap_or(0) > 0 {
        if *stop.0.lock().unwrap() {
            return;
        }
        let frame: Value = serde_json::from_str(&line).expect("a JSON request");
        line.clear();
        let (id, method, args) = (frame["id"].clone(), frame["method"].as_str().unwrap_or_default().to_owned(), frame["args"].clone());
        // Held under the world's lock, so the reply is written after the events this request emitted.
        let reply = {
            let mut world = world.lock().unwrap();
            world.log.push((method.clone(), args.clone()));
            world.connections.push((number, method.clone()));
            let reply = world.call(&method, &args, &data, pid);
            // An idle Terminal read waits a little, as the daemon's long poll does (outside the world's lock).
            if method == "terminal:read" && reply.as_ref().is_ok_and(|r| r["data"] == "") {
                drop(world);
                std::thread::sleep(Duration::from_millis(20));
            }
            match reply {
                Ok(result) => json!({"v":1,"id":id,"result":result}),
                Err(message) => json!({"v":1,"id":id,"error":{"code":"FAKE_REFUSED","message":message}}),
            }
        };
        if writeln!(writer.lock().unwrap(), "{reply}").is_err() {
            return;
        }
    }
}

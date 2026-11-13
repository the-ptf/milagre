//! Dedicated Project terminal owner. Real PTYs, explicit roots, no ambient shell/profile discovery.
//! Reads run outside the Chat actor so a long poll cannot hold the publication lock.
use milagre_owner_store::{jsjson, ownership::RootPin};
use milagre_owner_wire::{RpcError, RpcResult};
use milagre_terminals::{
    wire, Cleanup, PtyOutput, PtyProcess, PtySpawner, ShellCommand, ShellOption, SpawnRequest,
    Terminals, TerminalsOptions, UnixPtySpawner, Worktree,
};
use serde_json::Value;
use std::{
    collections::{BTreeMap, VecDeque},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

pub(crate) type Check = Arc<dyn Fn() -> Result<(), RpcError> + Send + Sync>;
fn refused(message: impl Into<String>) -> RpcError {
    RpcError::new("TERMINAL_SCOPE", message.into())
}
fn pending() -> RpcError {
    RpcError::new("QUIT_PENDING", "Terminal process cleanup is still pending")
}
#[derive(Default)]
struct Events {
    queue: VecDeque<(String, Value)>,
    overflow: bool,
}
impl Events {
    fn put(&mut self, channel: &str, payload: Value) {
        if self
            .queue
            .iter()
            .any(|(c, p)| c == channel && p == &payload)
        {
            return;
        }
        if self.queue.len() == 128 {
            self.overflow = true;
            return;
        }
        self.queue.push_back((channel.into(), payload));
    }
}
#[derive(Default)]
struct Tracking {
    children: Mutex<Vec<Arc<dyn PtyProcess>>>,
}
impl Tracking {
    fn drained(&self) -> bool {
        let mut children = self.children.lock().unwrap();
        children.retain(|p| !p.cleaned());
        children.is_empty()
    }
}
struct Tracked(Arc<dyn PtyProcess>);
impl PtyProcess for Tracked {
    fn pid(&self) -> Option<u32> {
        self.0.pid()
    }
    fn process(&self) -> String {
        self.0.process()
    }
    fn write(&self, data: &str) -> Result<(), String> {
        self.0.write(data)
    }
    fn resize(&self, c: u16, r: u16) -> Result<(), String> {
        self.0.resize(c, r)
    }
    fn kill(&self) {
        self.0.kill()
    }
    fn cleaned(&self) -> bool {
        self.0.cleaned()
    }
}
struct Spawner {
    tracking: Arc<Tracking>,
}
impl PtySpawner for Spawner {
    fn spawn(
        &self,
        mut request: SpawnRequest,
        output: Arc<dyn PtyOutput>,
    ) -> Result<Box<dyn PtyProcess>, String> {
        if request.file != "/bin/sh" {
            return Err(
                "Only the explicitly installed /bin/sh terminal profile is available".into(),
            );
        }
        request.args.clear();
        let mut children = self.tracking.children.lock().unwrap();
        children.retain(|p| !p.cleaned());
        if children.len() >= 64 {
            return Err("Terminal cleanup capacity is full".into());
        }
        let process: Arc<dyn PtyProcess> = Arc::from(
            UnixPtySpawner {
                cleanup: Cleanup::Tree,
                ..UnixPtySpawner::default()
            }
            .spawn(request, output)?,
        );
        children.push(process.clone());
        Ok(Box::new(Tracked(process)))
    }
}
#[derive(Clone)]
struct Grant {
    worktree: Worktree,
    token: u64,
}
struct Authority {
    ready: bool,
    chats: BTreeMap<String, Grant>,
    next_token: u64,
}
pub(crate) struct Invocation {
    generation: Arc<Generation>,
    method: String,
    args: Vec<Value>,
    grant: Option<(String, u64)>,
}
impl Invocation {
    pub(crate) fn invoke(self, client: u64) -> RpcResult {
        self.generation
            .invoke(&self.method, &self.args, client, self.grant.as_ref())
    }
}
pub(crate) struct Generation {
    // Only short calls hold this gate. A read releases it before long-polling and rechecks afterwards.
    gate: Mutex<()>,
    authority: Arc<Mutex<Authority>>,
    terminals: Terminals,
    tracking: Arc<Tracking>,
    ids: Mutex<BTreeMap<String, (String, u64)>>,
    runtime: Arc<tokio::runtime::Runtime>,
    check: Check,
}
impl Generation {
    fn invoke(
        &self,
        method: &str,
        args: &[Value],
        client: u64,
        grant: Option<&(String, u64)>,
    ) -> RpcResult {
        let gate = self.gate.lock().unwrap();
        (self.check)()?;
        self.validate(grant)?;
        let mut value = Value::Array(args.to_vec());
        if method == "terminal:input" {
            if let Some(Value::String(text)) = value.get_mut(0).and_then(|arg| arg.get_mut("data"))
            {
                *text = jsjson::js_string(&jsjson::to_sqlite_text(text));
            }
        }
        let value: Value = serde_json::from_str(&jsjson::to_string(&value))
            .map_err(|_| refused("Terminal identities require valid Unicode"))?;
        let arg = value.get(0).unwrap_or(&Value::Null);
        if matches!(method, "terminal:open" | "terminal:list") {
            let chat = arg["chatId"].as_str().unwrap_or("");
            if !self.authority.lock().unwrap().chats.contains_key(chat) {
                return Err(refused("Choose a current Chat in the dedicated Project"));
            }
        }
        let context = wire::CommandContext {
            client_id: Some(client.to_string()),
        };
        if method == "terminal:read" {
            drop(gate);
            let result =
                self.runtime
                    .block_on(wire::handle(&self.terminals, method, arg, &context));
            let _gate = self.gate.lock().unwrap();
            (self.check)()?;
            self.validate(grant)?;
            result.map_err(|e| RpcError::new("COMMAND_FAILED", e.to_string()))
        } else {
            let result = self
                .runtime
                .block_on(wire::handle(&self.terminals, method, arg, &context))
                .map_err(|e| RpcError::new("COMMAND_FAILED", e.to_string()))?;
            if method == "terminal:open" {
                let (chat, token) =
                    grant.ok_or_else(|| refused("Missing Chat membership ticket"))?;
                let mut ids = self.ids.lock().unwrap();
                ids.retain(|id, _| self.terminals.check(id).is_ok());
                ids.insert(
                    result["id"]
                        .as_str()
                        .ok_or_else(|| refused("Missing Terminal identity"))?
                        .into(),
                    (chat.clone(), *token),
                );
            }
            Ok(result)
        }
    }
    fn validate(&self, grant: Option<&(String, u64)>) -> Result<(), RpcError> {
        let auth = self.authority.lock().unwrap();
        if !auth.ready {
            return Err(refused("This terminal generation is closed"));
        }
        if let Some((chat, token)) = grant {
            if !auth.chats.get(chat).is_some_and(|g| g.token == *token) {
                return Err(refused("The captured Chat membership was revoked"));
            }
        }
        Ok(())
    }
    fn revoke(&self) {
        let _gate = self.gate.lock().unwrap();
        self.authority.lock().unwrap().ready = false;
        self.runtime
            .block_on(self.terminals.dispose(Duration::ZERO));
    }
}
pub(crate) struct ConfiguredTerminals {
    project: PathBuf,
    pin: Arc<RootPin>,
    check: Check,
    runtime: Arc<tokio::runtime::Runtime>,
    generation: Mutex<Option<Arc<Generation>>>,
    events: Arc<Mutex<Events>>,
}
impl ConfiguredTerminals {
    pub(crate) fn new(project: PathBuf, check: Check) -> Result<Self, RpcError> {
        let pin = Arc::new(RootPin::take(&project).map_err(|e| refused(e.to_string()))?);
        let selected = check;
        let pinned = pin.clone();
        let check: Check = Arc::new(move || {
            selected()?;
            pinned.check().map_err(refused)
        });
        let runtime = Arc::new(
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()?,
        );
        Ok(Self {
            project,
            pin,
            check,
            runtime,
            generation: Mutex::new(None),
            events: Arc::new(Mutex::new(Events::default())),
        })
    }
    fn make_generation(
        &self,
        chats: BTreeMap<String, Worktree>,
    ) -> Result<Arc<Generation>, RpcError> {
        let mut next_token = 0;
        let chats = chats
            .into_iter()
            .map(|(key, worktree)| {
                next_token += 1;
                (
                    key,
                    Grant {
                        worktree,
                        token: next_token,
                    },
                )
            })
            .collect();
        let authority = Arc::new(Mutex::new(Authority {
            ready: true,
            chats,
            next_token,
        }));
        let resolve = authority.clone();
        let mut options = TerminalsOptions::new(Arc::new(move |chat| {
            let result = {
                let a = resolve.lock().unwrap();
                if !a.ready {
                    Err("Terminal generation closed".into())
                } else {
                    a.chats
                        .get(&chat)
                        .map(|g| vec![g.worktree.clone()])
                        .ok_or_else(|| "Choose a current Chat in this Project".into())
                }
            };
            Box::pin(async move { result })
        }));
        let tracking = Arc::new(Tracking::default());
        options.spawner = Arc::new(Spawner {
            tracking: tracking.clone(),
        });
        options.shell = Arc::new(|| ShellCommand {
            file: "/bin/sh".into(),
            args: vec![],
        });
        options.available_shells = Arc::new(|| {
            vec![ShellOption {
                file: "/bin/sh".into(),
                label: "sh (dedicated Project)".into(),
            }]
        });
        options.environment = Arc::new(|| {
            BTreeMap::from([
                ("PATH".into(), "/usr/bin:/bin".into()),
                ("TERM".into(), "xterm-256color".into()),
                ("LANG".into(), "en_US.UTF-8".into()),
                ("PS1".into(), "rust> ".into()),
            ])
        });
        let events = self.events.clone();
        options.on_event = Arc::new(move |event| {
            if let Some((channel, payload)) = event.wire() {
                events.lock().unwrap().put(channel, payload);
            }
        });
        Ok(Arc::new(Generation {
            gate: Mutex::new(()),
            authority,
            terminals: Terminals::new(options).map_err(|e| refused(e.to_string()))?,
            tracking,
            ids: Mutex::new(BTreeMap::new()),
            runtime: self.runtime.clone(),
            check: self.check.clone(),
        }))
    }
    pub(crate) fn before_open(&self) -> Result<(), RpcError> {
        if let Some(g) = self.generation.lock().unwrap().as_ref() {
            if !g.authority.lock().unwrap().ready && !g.tracking.drained() {
                return Err(pending());
            }
        }
        Ok(())
    }
    pub(crate) fn reopen(&self, state: &Value) -> Result<(), RpcError> {
        self.before_open()?;
        {
            let mut current = self.generation.lock().unwrap();
            if current
                .as_ref()
                .is_some_and(|g| !g.authority.lock().unwrap().ready)
            {
                *current = None;
            }
        }
        self.refresh(state)
    }
    pub(crate) fn refresh(&self, state: &Value) -> Result<(), RpcError> {
        (self.check)()?;
        self.pin.check().map_err(refused)?;
        let sessions = state["sessions"]
            .as_object()
            .ok_or_else(|| refused("Missing owned Chat membership"))?;
        let worktrees = state["worktrees"]
            .as_object()
            .ok_or_else(|| refused("Missing owned Worktree membership"))?;
        let mut chats = BTreeMap::new();
        for (key, session) in sessions {
            let valid_id = session["id"]
                .as_f64()
                .is_some_and(|n| n >= 1.0 && n.fract() == 0.0 && n <= 9_007_199_254_740_991.0);
            if !valid_id || jsjson::property_key(session.get("id")) != *key {
                return Err(refused("Invalid owned Chat identity"));
            }
            if jsjson::truthy(session.get("archived"))
                || jsjson::truthy(session.get("formerWorktree"))
                || jsjson::truthy(session.get("workspacePath"))
            {
                continue;
            }
            let Some(worktree) = worktrees.get(&jsjson::property_key(session.get("worktree_id")))
            else {
                continue;
            };
            if !jsjson::strict_equals(&worktree["id"], &session["worktree_id"])
                || worktree["path"].as_str() != self.project.to_str()
                || jsjson::truthy(worktree.get("sharedChat"))
            {
                continue;
            }
            chats.insert(
                format!("{}#{key}", self.project.display()),
                Worktree {
                    path: self.project.to_string_lossy().into(),
                    label: Some("Rust Chat".into()),
                },
            );
        }
        let mut current = self.generation.lock().unwrap();
        if let Some(g) = current.as_ref() {
            let _gate = g.gate.lock().unwrap();
            let mut auth = g.authority.lock().unwrap();
            if auth.ready {
                let removed: Vec<_> = auth
                    .chats
                    .keys()
                    .filter(|key| !chats.contains_key(*key))
                    .cloned()
                    .collect();
                let mut next = BTreeMap::new();
                for (key, worktree) in chats {
                    let token = match auth.chats.get(&key) {
                        Some(old) if old.worktree == worktree => old.token,
                        _ => {
                            auth.next_token = auth
                                .next_token
                                .checked_add(1)
                                .ok_or_else(|| refused("Terminal grant identities exhausted"))?;
                            auth.next_token
                        }
                    };
                    next.insert(key, Grant { worktree, token });
                }
                auth.chats = next;
                drop(auth);
                for chat in removed {
                    g.terminals.close_chat(&chat);
                }
                return Ok(());
            }
            drop(auth);
            return Ok(());
        }
        *current = Some(self.make_generation(chats)?);
        Ok(())
    }
    pub(crate) fn capture(&self, method: &str, args: &[Value]) -> Result<Invocation, RpcError> {
        let generation = self
            .generation
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| refused("Terminal owner is not ready"))?;
        let grant = if matches!(method, "terminal:open" | "terminal:list") {
            let chat = args
                .first()
                .and_then(|v| v["chatId"].as_str())
                .unwrap_or("");
            let auth = generation.authority.lock().unwrap();
            let g = auth
                .chats
                .get(chat)
                .ok_or_else(|| refused("Choose a current Chat in the dedicated Project"))?;
            Some((chat.to_string(), g.token))
        } else {
            args.first()
                .and_then(|v| v["terminalId"].as_str())
                .and_then(|id| generation.ids.lock().unwrap().get(id).cloned())
        };
        generation.validate(grant.as_ref())?;
        Ok(Invocation {
            generation,
            method: method.into(),
            args: args.to_vec(),
            grant,
        })
    }
    pub(crate) fn stop(&self) -> bool {
        let current = self.generation.lock().unwrap();
        if let Some(g) = current.as_ref() {
            g.revoke();
            g.tracking.drained()
        } else {
            true
        }
    }
    pub(crate) fn drain_before_owner_drop(&self) {
        while !self.stop() {
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    pub(crate) fn events(&self) -> Result<Vec<(String, Value)>, RpcError> {
        let mut events = self.events.lock().unwrap();
        if events.overflow {
            return Err(RpcError::new(
                "TERMINAL_EVENT_OVERFLOW",
                "Terminal event queue overflowed",
            ));
        }
        Ok(events.queue.drain(..).collect())
    }
}
impl Drop for ConfiguredTerminals {
    fn drop(&mut self) {
        self.drain_before_owner_drop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::Instant;
    fn setup() -> (
        milagre_owner_wire::IsolatedProfile,
        Arc<ConfiguredTerminals>,
        Value,
    ) {
        let profile = milagre_owner_wire::IsolatedProfile::create().unwrap();
        let project = profile.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let state = json!({"sessions":{"1":{"id":1,"worktree_id":1}},"worktrees":{"1":{"id":1,"path":project}}});
        let service = Arc::new(ConfiguredTerminals::new(project, Arc::new(|| Ok(()))).unwrap());
        service.refresh(&state).unwrap();
        (profile, service, state)
    }
    fn invoke(service: &ConfiguredTerminals, method: &str, arg: Value) -> Value {
        service.capture(method, &[arg]).unwrap().invoke(1).unwrap()
    }
    fn output(service: &ConfiguredTerminals, id: &str, needle: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let read = invoke(service, "terminal:read", json!({"terminalId":id,"after":0}));
            if read["data"].as_str().unwrap().contains(needle) {
                return read;
            }
            assert!(Instant::now() < deadline, "missing {needle}: {read}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    #[test]
    fn real_pty_input_output_resize_catchup_and_actual_cleanup() {
        let (_profile, service, state) = setup();
        let chat = format!("{}#1", service.project.display());
        let profiles = invoke(&service, "terminal:profiles", json!({}));
        assert_eq!(profiles["defaultShell"], "/bin/sh");
        let opened = invoke(
            &service,
            "terminal:open",
            json!({"chatId":chat,"cols":80,"rows":24}),
        );
        let id = opened["id"].as_str().unwrap();
        assert_eq!(opened["cwd"], state["worktrees"]["1"]["path"]);
        // The desired output is octal-encoded in the echoed command, so echo alone cannot pass.
        invoke(
            &service,
            "terminal:input",
            json!({"terminalId":id,"data":"printf '\\162\\165\\163\\164\\055\\160\\164\\171\\055\\157\\153\\012'\n"}),
        );
        let read = output(&service, id, "rust-pty-ok\r\n");
        assert!(!read["ended"].as_bool().unwrap());
        let catchup = service
            .capture("terminal:read", &[json!({"terminalId":id,"after":0})])
            .unwrap()
            .invoke(77)
            .unwrap();
        assert!(catchup["data"]
            .as_str()
            .unwrap()
            .contains("rust-pty-ok\r\n"));
        invoke(
            &service,
            "terminal:resize",
            json!({"terminalId":id,"cols":120,"rows":42}),
        );
        let listed = invoke(&service, "terminal:list", json!({"chatId":chat}));
        assert_eq!(listed["terminals"][0]["cols"], 120);
        assert_eq!(listed["terminals"][0]["rows"], 42);
        invoke(&service, "terminal:close", json!({"terminalId":id}));
        let deadline = Instant::now() + Duration::from_secs(5);
        while !service.stop() {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(service
            .generation
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .tracking
            .drained());
        assert!(service
            .events()
            .unwrap()
            .iter()
            .any(|(c, _)| c == "terminal:changed"));
    }
    #[test]
    fn revoked_membership_and_generation_tickets_never_revive() {
        let (_profile, service, state) = setup();
        let chat = format!("{}#1", service.project.display());
        let args = [json!({"chatId":chat})];
        let removed = service.capture("terminal:open", &args).unwrap();
        let mut empty = state.clone();
        empty["sessions"] = json!({});
        service.refresh(&empty).unwrap();
        service.refresh(&state).unwrap();
        assert_eq!(removed.invoke(1).unwrap_err().code, "TERMINAL_SCOPE");
        let old = service.capture("terminal:open", &args).unwrap();
        assert!(service.stop());
        service.reopen(&state).unwrap();
        assert_eq!(old.invoke(1).unwrap_err().code, "TERMINAL_SCOPE");
        assert!(service
            .generation
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .tracking
            .drained());
    }
    #[test]
    fn foreign_chat_worktree_and_replaced_root_refuse_without_spawn() {
        let (_profile, service, mut state) = setup();
        assert!(service
            .capture("terminal:open", &[json!({"chatId":"/foreign#1"})])
            .is_err());
        assert!(service
            .capture(
                "terminal:list",
                &[json!({"chatId":format!("{}#999",service.project.display())})]
            )
            .is_err());
        state["worktrees"]["1"]["path"] = json!("/tmp");
        service.refresh(&state).unwrap();
        assert!(service
            .capture(
                "terminal:open",
                &[json!({"chatId":format!("{}#1",service.project.display())})]
            )
            .is_err());
        let moved = service.project.with_file_name("moved");
        std::fs::rename(&service.project, &moved).unwrap();
        std::fs::create_dir(&service.project).unwrap();
        assert!(service
            .capture("terminal:profiles", &[json!({})])
            .unwrap()
            .invoke(1)
            .is_err());
        assert!(service
            .generation
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .tracking
            .drained());
    }
}

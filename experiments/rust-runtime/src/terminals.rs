//! Real PTYs admitted only for Chats in fresh fixture copies. This is not an OS command sandbox.
use crate::ReadBackend;
use milagre_owner_store::jsjson;
use milagre_owner_wire::{EventSink, RpcError, RpcResult};
use milagre_ports::{with_terminal_shells, PortWatcher, PortWatcherOptions, Roots};
use milagre_terminals::{
    wire, Cleanup, PtyOutput, PtyProcess, PtySpawner, ShellCommand, ShellOption, SpawnRequest,
    Terminals, TerminalsOptions, UnixPtySpawner, Worktree,
};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, Weak},
    time::Duration,
};

pub type TerminalEvents = Arc<Mutex<Option<EventSink>>>;
pub struct TerminalService {
    terminals: Terminals,
    ports: Option<Arc<PortWatcher>>,
    runtime: tokio::runtime::Runtime,
}
/// A test-profile shell policy, not a fake PTY: no login rc files, inherited environment, or other executables.
struct FixtureSpawner;
impl PtySpawner for FixtureSpawner {
    fn spawn(
        &self,
        mut request: SpawnRequest,
        output: Arc<dyn PtyOutput>,
    ) -> Result<Box<dyn PtyProcess>, String> {
        if request.file != "/bin/sh" {
            return Err("The isolated terminal fixture only permits /bin/sh".into());
        }
        request.args.clear();
        UnixPtySpawner {
            cleanup: Cleanup::Tree,
            ..UnixPtySpawner::default()
        }
        .spawn(request, output)
    }
}
impl TerminalService {
    pub fn new(
        backend: Arc<dyn ReadBackend>,
        events: TerminalEvents,
        with_ports: bool,
    ) -> Result<Self, RpcError> {
        let resolve = Arc::new(move |chat: String| {
            let backend = backend.clone();
            Box::pin(async move {
                let (scope, id) = chat.rsplit_once('#').ok_or("A Chat is required.")?;
                let info = backend
                    .projects()
                    .into_iter()
                    .find(|project| project.path == scope)
                    .ok_or("Only copied fixture Chats can open a Terminal.")?;
                // read state validates the sealed copy before resolving a directory. Persisted Worktree
                // paths can name a real machine's folders; this fixture never follows any of them.
                let state = backend.state(scope).map_err(|error| error.message)?;
                let session = state["sessions"]
                    .get(id)
                    .ok_or("That Chat no longer exists.")?;
                if jsjson::truthy(session.get("archived")) {
                    return Err("That Chat is archived.".into());
                }
                if jsjson::property_key(session.get("id")) != id {
                    return Err("A Chat is required.".into());
                }
                Ok(vec![Worktree {
                    path: scope.into(),
                    label: Some(info.name),
                }])
            }) as milagre_terminals::BoxFuture<Result<Vec<Worktree>, String>>
        });
        let mut options = TerminalsOptions::new(resolve);
        options.spawner = Arc::new(FixtureSpawner);
        options.shell = Arc::new(|| ShellCommand {
            file: "/bin/sh".into(),
            args: vec![],
        });
        options.available_shells = Arc::new(|| {
            vec![ShellOption {
                file: "/bin/sh".into(),
                label: "sh (isolated fixture)".into(),
            }]
        });
        options.environment = Arc::new(|| {
            BTreeMap::from([
                ("PATH".into(), "/usr/bin:/bin".into()),
                ("PS1".into(), "fixture> ".into()),
                ("TERM".into(), "xterm-256color".into()),
                ("LANG".into(), "en_US.UTF-8".into()),
            ])
        });
        let watcher: Arc<Mutex<Weak<PortWatcher>>> = Arc::new(Mutex::new(Weak::new()));
        let notify_watcher = watcher.clone();
        let port_events = events.clone();
        // Shell preferences stay in memory. No settings file is read from or saved to the installed profile.
        options.on_event = Arc::new(move |event| {
            if event == milagre_terminals::TerminalEvent::ShellsChanged {
                if let Some(watcher) = notify_watcher.lock().unwrap().upgrade() {
                    watcher.wake();
                }
            }
            if let Some((channel, payload)) = event.wire() {
                if let Some(sink) = events.lock().unwrap().as_ref() {
                    let _ = sink.emit(channel, payload);
                }
            }
        });
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()?;
        let terminals = Terminals::new(options)
            .map_err(|error| RpcError::new("COMMAND_FAILED", error.to_string()))?;
        let ports = if with_ports {
            let roots = terminals.clone();
            let running = terminals.clone();
            let signals = terminals.clone();
            let mut options = PortWatcherOptions::new(
                Arc::new(move || with_terminal_shells(Roots::new(), roots.shells())),
                Arc::new(move |ports| {
                    let (channel, value) = milagre_ports::wire::event(ports);
                    if let (Some(sink), Ok(payload)) = (
                        port_events.lock().unwrap().as_ref(),
                        jsjson::parse(&value.to_string()),
                    ) {
                        let _ = sink.emit(channel, payload);
                    }
                }),
            );
            options.is_running = Arc::new(move || running.size() > 0);
            options.kill = Arc::new(move |target, signal| {
                crate::ports::scoped_signal(&signals, target, signal)
            });
            let ports = Arc::new(PortWatcher::with_runtime(options, runtime.handle().clone()));
            *watcher.lock().unwrap() = Arc::downgrade(&ports);
            Some(ports)
        } else {
            None
        };
        Ok(Self {
            terminals,
            ports,
            runtime,
        })
    }
    pub fn invoke(&self, method: &str, args: &[Value], client_id: u64) -> RpcResult {
        let mut args = Value::Array(args.to_vec());
        // node-pty writes data as UTF-8, replacing lone UTF-16 units. Other strings
        // are identities/paths: never collapse a lone unit onto another valid identity.
        if method == "terminal:input" {
            if let Some(data) = args.get_mut(0).and_then(|arg| arg.get_mut("data")) {
                if let Some(text) = data.as_str() {
                    *data = Value::String(jsjson::js_string(&jsjson::to_sqlite_text(text)));
                }
            }
        }
        let args = ordinary_arguments(&args)?;
        let args = args.as_array().expect("array converted above");
        self.runtime
            .block_on(wire::handle(
                &self.terminals,
                method,
                args.first().unwrap_or(&Value::Null),
                &wire::CommandContext {
                    client_id: Some(client_id.to_string()),
                },
            ))
            .map_err(|error| RpcError::new("COMMAND_FAILED", error.to_string()))
            // Terminal text is ordinary Unicode, not the storage reader's internal UTF-16 representation.
            // Import it through the domain decoder before Handler::encode_result serializes it.
            .and_then(|value| {
                jsjson::parse(&value.to_string())
                    .map_err(|error| RpcError::new("INVALID_RESPONSE", error))
            })
    }
    pub fn invoke_ports(&self, method: &str, args: &[Value]) -> RpcResult {
        let args = ordinary_arguments(&Value::Array(args.to_vec()))?;
        let args = args.as_array().expect("array converted above");
        let ports = self.ports.as_ref().ok_or_else(|| {
            RpcError::new(
                "UNSUPPORTED_SERVICE",
                "Ports require the isolated owned runtime",
            )
        })?;
        self.runtime
            .block_on(milagre_ports::wire::handle(ports, method, args))
            .map_err(|error| RpcError::new("COMMAND_FAILED", error))
            .and_then(|value| {
                jsjson::parse(&value.to_string())
                    .map_err(|error| RpcError::new("INVALID_RESPONSE", error))
            })
    }
    pub fn has_ports(&self) -> bool {
        self.ports.is_some()
    }
    pub fn ports_snapshot(&self) -> RpcResult {
        let Some(ports) = &self.ports else {
            return Ok(serde_json::json!({}));
        };
        let value = serde_json::to_value(ports.snapshot())
            .map_err(|error| RpcError::new("INVALID_RESPONSE", error.to_string()))?;
        jsjson::parse(&value.to_string()).map_err(|error| RpcError::new("INVALID_RESPONSE", error))
    }
    pub fn shutdown(&self) {
        if let Some(ports) = &self.ports {
            ports.close();
        }
        self.runtime
            .block_on(self.terminals.dispose(Duration::from_secs(3)));
    }
}
impl Drop for TerminalService {
    fn drop(&mut self) {
        self.shutdown();
    }
}

// Decode literal marker characters once for Unicode-only native service crates.
// serde rejects actual lone surrogates rather than conflating them with replacement characters.
fn ordinary_arguments(args: &Value) -> RpcResult {
    serde_json::from_str(&jsjson::to_string(args)).map_err(|_| {
        RpcError::new(
            "UNSUPPORTED_UTF16_IDENTITY",
            "Native terminal and port identities must contain valid Unicode",
        )
    })
}

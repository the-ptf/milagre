//! The Terminal owner: `createTerminals` from packages/core/src/terminals.cjs.
//!
//! A Terminal is an interactive shell the user opened in a Chat (GLOSSARY.md, ADR-0008). The owner keeps its PTY, so
//! it outlives any viewer: viewers come and go through `read` long-polls, and dropping one (a closed window, a phone
//! that went away mid-read) changes nothing for the shell. Output stays in memory only. Every viewer may type; the PTY
//! takes the size of whichever viewer typed or resized last.
//!
//! Error messages, limits, defaults and validation are the Node ones, so the wire layer ([`crate::wire`]) can answer
//! exactly as the daemon does today.

use std::collections::BTreeMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Condvar, Mutex, OnceLock, Weak};
use std::time::Duration;

use serde::Serialize;
use tokio::sync::watch;

use crate::buffer::{self, OutputBuffer, MAX_BUFFER_CHARS, MAX_BUFFER_LINES, MIN_READ_LIMIT};
use crate::paths::host_basename;
use crate::shell::{self, ShellCommand, ShellOption, ShellProbe, TERMINAL_TYPE, UNIX_SHELLS};
use crate::spawn::{ExitInfo, PtyOutput, PtyProcess, PtySpawner, SpawnRequest};

pub const MAX_INPUT: usize = 64 * 1024;
pub const READ_WAIT: Duration = Duration::from_millis(8000);
pub const TITLE_POLL: Duration = Duration::from_millis(1500);
pub const MAX_PER_CHAT: usize = 12;
pub const MAX_TOTAL: usize = 64;
pub const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// A failed Terminal command. The message is what the daemon sends back as the command's error.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TerminalError(pub String);

impl TerminalError {
    pub fn new(message: impl Into<String>) -> Self {
        TerminalError(message.into())
    }
}

impl std::fmt::Display for TerminalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for TerminalError {}

pub type Result<T> = std::result::Result<T, TerminalError>;

/// One of a Chat's Worktrees a Terminal may open in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Worktree {
    pub path: String,
    /// Shown on the Terminal; the folder name when absent.
    pub label: Option<String>,
}

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;
/// Resolves a Chat's Worktrees, or fails with the message to show (the Chat doesn't exist or is archived).
pub type ResolveChat = Arc<dyn Fn(String) -> BoxFuture<std::result::Result<Vec<Worktree>, String>> + Send + Sync>;

/// What the owner reports. `Changed` and `PreferencesChanged` are the daemon's `terminal:changed` and
/// `terminal:preferences-changed` events ([`TerminalEvent::wire`]); `ShellsChanged` feeds the port watcher
/// (`ports.wake()`); `Exited` is additional (Node has no per-Terminal exit event) and never goes on the wire.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TerminalEvent {
    Changed { chat_id: String },
    ShellsChanged,
    PreferencesChanged,
    Exited { terminal_id: String, chat_id: String, exit: ExitInfo },
}

impl TerminalEvent {
    /// The daemon event name and payload, for the events that are on the wire.
    pub fn wire(&self) -> Option<(&'static str, serde_json::Value)> {
        match self {
            TerminalEvent::Changed { chat_id } => Some(("terminal:changed", serde_json::json!({ "chatId": chat_id }))),
            TerminalEvent::PreferencesChanged => Some(("terminal:preferences-changed", serde_json::json!({}))),
            _ => None,
        }
    }
}

/// `info(terminal)`: what `terminal:list`, `terminal:open` and `terminal:read` return about a Terminal.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub id: String,
    pub chat_id: String,
    pub title: String,
    pub cwd: String,
    pub label: String,
    pub busy: bool,
    pub cols: u16,
    pub rows: u16,
    pub created_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TerminalList {
    pub terminals: Vec<TerminalInfo>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ReadResult {
    pub offset: u64,
    pub data: String,
    pub reset: bool,
    pub ended: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal: Option<TerminalInfo>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profiles {
    pub shells: Vec<ShellOption>,
    pub default_shell: String,
    pub selected_shell: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct InputResult {
    pub accepted: bool,
}

/// `terminal:open`. `cols`/`rows` outside 2..=1000 / 1..=500 (or missing) fall back to 80x24, as in Node.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OpenRequest {
    pub chat_id: String,
    pub cwd: Option<String>,
    pub cols: Option<u64>,
    pub rows: Option<u64>,
}

#[derive(Clone, Debug)]
pub struct Limits {
    /// Kept output, in UTF-16 code units (JavaScript string length), like Node's `maxBufferChars`.
    pub max_buffer_chars: usize,
    pub max_buffer_lines: usize,
    pub read_wait: Duration,
    pub title_poll: Duration,
    pub max_per_chat: usize,
    pub max_total: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            max_buffer_chars: MAX_BUFFER_CHARS,
            max_buffer_lines: MAX_BUFFER_LINES,
            read_wait: READ_WAIT,
            title_poll: TITLE_POLL,
            max_per_chat: MAX_PER_CHAT,
            max_total: MAX_TOTAL,
        }
    }
}

/// `createTerminals(options)`. [`TerminalsOptions::new`] gives the real system: the user's shell, this process's
/// environment, real PTYs. Every field can be replaced, as in the Node tests.
#[derive(Clone)]
pub struct TerminalsOptions {
    pub resolve_chat: ResolveChat,
    pub spawner: Arc<dyn PtySpawner>,
    pub shell: Arc<dyn Fn() -> ShellCommand + Send + Sync>,
    pub available_shells: Arc<dyn Fn() -> Vec<ShellOption> + Send + Sync>,
    /// `terminal-settings.json` in the data directory. None keeps the shell choice in memory only.
    pub settings_file: Option<PathBuf>,
    pub environment: Arc<dyn Fn() -> BTreeMap<String, String> + Send + Sync>,
    pub on_event: Arc<dyn Fn(TerminalEvent) + Send + Sync>,
    pub limits: Limits,
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
}

impl TerminalsOptions {
    pub fn new(resolve_chat: ResolveChat) -> Self {
        #[cfg(unix)]
        let spawner: Arc<dyn PtySpawner> = Arc::new(crate::unix_pty::UnixPtySpawner::default());
        #[cfg(not(unix))]
        let spawner: Arc<dyn PtySpawner> = Arc::new(crate::spawn::UnsupportedSpawner);
        TerminalsOptions {
            resolve_chat,
            spawner,
            shell: Arc::new(|| shell::terminal_shell(&ShellProbe::system())),
            available_shells: Arc::new(|| shell::terminal_shells(&ShellProbe::system())),
            settings_file: None,
            environment: Arc::new(shell::system_terminal_environment),
            on_event: Arc::new(|_| {}),
            limits: Limits::default(),
            now: Arc::new(|| std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)),
        }
    }
}

struct TerminalState {
    buffer: OutputBuffer,
    cols: u16,
    rows: u16,
    exited: bool,
    title: String,
}

struct Terminal {
    id: String,
    chat_id: String,
    shell: String,
    cwd: String,
    label: String,
    created_at: i64,
    pty: OnceLock<Box<dyn PtyProcess>>,
    state: Mutex<TerminalState>,
    /// Bumped on every wake: new output, a title change, the end.
    version: watch::Sender<u64>,
}

impl Terminal {
    fn wake(&self) {
        self.version.send_modify(|version| *version += 1);
    }

    fn process(&self) -> String {
        self.pty.get().map(|pty| pty.process()).unwrap_or_default()
    }

    fn shell_name(&self) -> String {
        shell::strip_exe(host_basename(&self.shell)).to_lowercase()
    }

    /// On Windows node-pty answers with the terminal type it was given, and has no call for the program in front.
    fn foreground_unknown(&self, process: &str) -> bool {
        process == TERMINAL_TYPE
    }

    fn foreground_of(&self, process: &str) -> String {
        if self.foreground_unknown(process) {
            return self.shell_name();
        }
        let name = host_basename(process);
        let name = name.strip_prefix('-').unwrap_or(name);
        if name.is_empty() {
            self.shell_name()
        } else {
            name.to_owned()
        }
    }

    fn foreground(&self) -> String {
        self.foreground_of(&self.process())
    }

    /// A shell waiting at its prompt is in front of its own Terminal; it may report another shell's name (macOS's
    /// /bin/sh runs bash), and a shell started inside the Terminal is a prompt too.
    fn idle(&self, name: &str) -> bool {
        let plain = shell::strip_exe(name).to_lowercase();
        plain == self.shell_name() || UNIX_SHELLS.contains(&plain.as_str()) || ["pwsh", "powershell", "cmd"].contains(&plain.as_str())
    }

    fn info(&self) -> TerminalInfo {
        let (exited, saved_title, cols, rows) = {
            let state = self.state.lock().unwrap();
            (state.exited, state.title.clone(), state.cols, state.rows)
        };
        let process = if exited { String::new() } else { self.process() };
        let title = if exited { saved_title } else { self.foreground_of(&process) };
        // Unknown counts as busy: closing a Terminal asks first rather than end a command nobody can see.
        let busy = !exited && (self.foreground_unknown(&process) || !self.idle(&title));
        TerminalInfo {
            id: self.id.clone(),
            chat_id: self.chat_id.clone(),
            title,
            cwd: self.cwd.clone(),
            label: self.label.clone(),
            busy,
            cols,
            rows,
            created_at: self.created_at,
        }
    }
}

struct State {
    /// Insertion order, as a JavaScript Map lists them.
    terminals: Vec<Arc<Terminal>>,
    closed: bool,
    selected_shell: Option<String>,
}

struct Inner {
    options: TerminalsOptions,
    state: Mutex<State>,
    poller: Mutex<Option<std::thread::JoinHandle<()>>>,
    poll_stop: Arc<(Mutex<bool>, Condvar)>,
}

impl Inner {
    fn emit(&self, event: TerminalEvent) {
        (self.options.on_event)(event);
    }

    fn get(&self, id: &str) -> Option<Arc<Terminal>> {
        if !valid_id(id) {
            return None;
        }
        self.state.lock().unwrap().terminals.iter().find(|terminal| terminal.id == id).cloned()
    }

    fn contains(&self, terminal: &Arc<Terminal>) -> bool {
        self.state.lock().unwrap().terminals.iter().any(|other| Arc::ptr_eq(other, terminal))
    }

    fn finish(&self, terminal: &Arc<Terminal>) {
        {
            let mut state = self.state.lock().unwrap();
            let Some(index) = state.terminals.iter().position(|other| Arc::ptr_eq(other, terminal)) else { return };
            state.terminals.remove(index);
        }
        terminal.wake();
        self.emit(TerminalEvent::Changed { chat_id: terminal.chat_id.clone() });
        self.emit(TerminalEvent::ShellsChanged);
    }

    fn kill(&self, terminal: &Arc<Terminal>) {
        {
            let mut state = terminal.state.lock().unwrap();
            if state.exited {
                return;
            }
            state.exited = true;
        }
        if let Some(pty) = terminal.pty.get() {
            pty.kill();
        }
        self.finish(terminal);
    }

    fn profiles(&self) -> Profiles {
        let shells = (self.options.available_shells)();
        let selected = self.state.lock().unwrap().selected_shell.clone();
        let selected_shell = selected.filter(|file| shells.iter().any(|item| &item.file == file));
        Profiles { shells, default_shell: (self.options.shell)().file, selected_shell }
    }

    fn poll_titles(self: &Arc<Self>) {
        let mut poller = self.poller.lock().unwrap();
        if poller.is_some() {
            return;
        }
        let weak = Arc::downgrade(self);
        let stop = self.poll_stop.clone();
        let interval = self.options.limits.title_poll;
        *poller = std::thread::Builder::new().name("milagre-terminal-titles".into()).spawn(move || title_loop(weak, stop, interval)).ok();
    }

    fn stop_polling(&self) {
        let (lock, signal) = &*self.poll_stop;
        *lock.lock().unwrap() = true;
        signal.notify_all();
        let handle = self.poller.lock().unwrap().take();
        if let Some(handle) = handle {
            if handle.thread().id() != std::thread::current().id() {
                let _ = handle.join();
            }
        }
    }
}

fn title_loop(inner: Weak<Inner>, stop: Arc<(Mutex<bool>, Condvar)>, interval: Duration) {
    loop {
        {
            let (lock, signal) = &*stop;
            let stopped = lock.lock().unwrap();
            let (stopped, _) = signal.wait_timeout_while(stopped, interval, |stopped| !*stopped).unwrap();
            if *stopped {
                return;
            }
        }
        let Some(inner) = inner.upgrade() else { return };
        let terminals = {
            let state = inner.state.lock().unwrap();
            if state.closed {
                return;
            }
            state.terminals.clone()
        };
        let mut changed: Vec<String> = Vec::new();
        for terminal in terminals {
            if terminal.state.lock().unwrap().exited {
                continue;
            }
            let title = terminal.foreground();
            let different = {
                let mut state = terminal.state.lock().unwrap();
                let different = !state.exited && state.title != title;
                if different {
                    state.title = title;
                }
                different
            };
            if different {
                terminal.wake();
                if !changed.contains(&terminal.chat_id) {
                    changed.push(terminal.chat_id.clone());
                }
            }
        }
        for chat_id in changed {
            inner.emit(TerminalEvent::Changed { chat_id });
        }
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        // The owner is going away without dispose(): its shells must not outlive it.
        let terminals = std::mem::take(&mut self.state.get_mut().unwrap().terminals);
        for terminal in terminals {
            terminal.state.lock().unwrap().exited = true;
            if let Some(pty) = terminal.pty.get() {
                pty.kill();
            }
            terminal.wake();
        }
        let (lock, signal) = &*self.poll_stop;
        *lock.lock().unwrap() = true;
        signal.notify_all();
    }
}

/// Where a PTY's output and exit land. It holds the Terminal weakly: once the owner lets a Terminal go, late output
/// from a dying shell goes nowhere.
struct Sink {
    terminal: Weak<Terminal>,
    inner: Weak<Inner>,
}

impl PtyOutput for Sink {
    fn data(&self, text: &str) {
        let Some(terminal) = self.terminal.upgrade() else { return };
        if terminal.state.lock().unwrap().buffer.append_str(text) {
            terminal.wake();
        }
    }

    fn exit(&self, exit: ExitInfo) {
        let Some(terminal) = self.terminal.upgrade() else { return };
        terminal.state.lock().unwrap().exited = true;
        let Some(inner) = self.inner.upgrade() else {
            terminal.wake();
            return;
        };
        let was_open = inner.contains(&terminal);
        inner.finish(&terminal);
        terminal.wake();
        if was_open {
            inner.emit(TerminalEvent::Exited { terminal_id: terminal.id.clone(), chat_id: terminal.chat_id.clone(), exit });
        }
    }
}

fn valid_id(id: &str) -> bool {
    id.len() == 36 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-')
}

fn require_chat_id(chat_id: &str) -> Result<()> {
    if chat_id.is_empty() {
        Err(TerminalError::new("A Chat is required."))
    } else {
        Ok(())
    }
}

/// The Terminal owner. Cloning shares one owner; Terminals end when [`Terminals::dispose`] runs or the last clone is
/// dropped, never when a viewer goes away.
#[derive(Clone)]
pub struct Terminals {
    inner: Arc<Inner>,
}

impl Terminals {
    /// Reads the saved shell choice; a missing or malformed settings file is no choice, any other read error fails.
    pub fn new(options: TerminalsOptions) -> Result<Self> {
        let mut selected_shell = None;
        if let Some(file) = &options.settings_file {
            match std::fs::read_to_string(file) {
                Ok(text) => {
                    if let Ok(serde_json::Value::Object(saved)) = serde_json::from_str::<serde_json::Value>(&text) {
                        if let Some(serde_json::Value::String(shell)) = saved.get("shell") {
                            selected_shell = Some(shell.clone());
                        }
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(TerminalError::new(error.to_string())),
            }
        }
        Ok(Terminals {
            inner: Arc::new(Inner {
                options,
                state: Mutex::new(State { terminals: Vec::new(), closed: false, selected_shell }),
                poller: Mutex::new(None),
                poll_stop: Arc::new((Mutex::new(false), Condvar::new())),
            }),
        })
    }

    fn ensure_open(&self) -> Result<()> {
        if self.inner.state.lock().unwrap().closed {
            Err(TerminalError::new("Terminals are closed."))
        } else {
            Ok(())
        }
    }

    fn find(&self, terminal_id: &str) -> Result<Arc<Terminal>> {
        self.ensure_open()?;
        self.inner.get(terminal_id).ok_or_else(|| TerminalError::new("This Terminal has ended."))
    }

    /// True after [`Terminals::dispose`].
    pub fn closed(&self) -> bool {
        self.inner.state.lock().unwrap().closed
    }

    /// Fails as a command on this Terminal would: closed owner, or a Terminal that ended.
    pub fn check(&self, terminal_id: &str) -> Result<()> {
        self.find(terminal_id).map(|_| ())
    }

    pub async fn profiles(&self) -> Profiles {
        self.inner.profiles()
    }

    /// Chooses the shell new Terminals open (None for automatic). Only an installed shell is accepted.
    pub async fn set_shell(&self, shell: Option<String>) -> Result<Profiles> {
        self.ensure_open()?;
        if let Some(file) = &shell {
            if !(self.inner.options.available_shells)().iter().any(|item| &item.file == file) {
                return Err(TerminalError::new("Choose an installed shell."));
            }
        }
        if let Some(settings) = &self.inner.options.settings_file {
            save_settings(settings, shell.as_deref()).map_err(|error| TerminalError::new(error.to_string()))?;
        }
        self.inner.state.lock().unwrap().selected_shell = shell;
        self.inner.emit(TerminalEvent::PreferencesChanged);
        Ok(self.inner.profiles())
    }

    pub async fn list(&self, chat_id: &str) -> Result<TerminalList> {
        require_chat_id(chat_id)?;
        let terminals = {
            let state = self.inner.state.lock().unwrap();
            if state.closed {
                return Err(TerminalError::new("Terminals are closed."));
            }
            state.terminals.iter().filter(|terminal| terminal.chat_id == chat_id).cloned().collect::<Vec<_>>()
        };
        Ok(TerminalList { terminals: terminals.iter().map(|terminal| terminal.info()).collect() })
    }

    /// Opens a Terminal in one of the Chat's Worktrees: `cwd` when given and it is one of them, otherwise the first.
    pub async fn open(&self, request: OpenRequest) -> Result<TerminalInfo> {
        require_chat_id(&request.chat_id)?;
        self.ensure_open()?;
        let worktrees = (self.inner.options.resolve_chat)(request.chat_id.clone()).await.map_err(TerminalError)?;
        if worktrees.is_empty() {
            return Err(TerminalError::new("This Chat has no Worktree to open a Terminal in."));
        }
        let chosen = match &request.cwd {
            None => worktrees.first(),
            Some(cwd) => worktrees.iter().find(|worktree| &worktree.path == cwd),
        };
        let chosen = chosen.ok_or_else(|| TerminalError::new("Choose one of this Chat's Worktrees."))?.clone();
        if !Path::new(&chosen.path).exists() {
            return Err(TerminalError::new(format!("{} no longer exists.", chosen.path)));
        }
        let limits = &self.inner.options.limits;
        let cols = request.cols.filter(|cols| (2..=1000).contains(cols)).unwrap_or(80) as u16;
        let rows = request.rows.filter(|rows| (1..=500).contains(rows)).unwrap_or(24) as u16;

        let terminal = {
            let mut state = self.inner.state.lock().unwrap();
            // Node checks this only before resolving the Chat; a dispose during that wait must not leave a shell.
            if state.closed {
                return Err(TerminalError::new("Terminals are closed."));
            }
            let mine = state.terminals.iter().filter(|terminal| terminal.chat_id == request.chat_id).count();
            if mine >= limits.max_per_chat {
                return Err(TerminalError::new(format!("A Chat can have at most {} Terminals. Close one first.", limits.max_per_chat)));
            }
            if state.terminals.len() >= limits.max_total {
                return Err(TerminalError::new("Too many Terminals are open on this computer. Close one first."));
            }
            let chosen_shell = state
                .selected_shell
                .as_ref()
                .and_then(|selected| (self.inner.options.available_shells)().into_iter().find(|item| &item.file == selected));
            let command = match chosen_shell {
                Some(item) => {
                    let plain = shell::strip_exe(&item.file).len() != item.file.len() || host_basename(&item.file) == "elvish";
                    ShellCommand { args: if plain { vec![] } else { vec!["-l".into()] }, file: item.file }
                }
                None => (self.inner.options.shell)(),
            };
            let mut env = (self.inner.options.environment)();
            if shell::strip_exe(&command.file).len() == command.file.len() {
                env.insert("SHELL".into(), command.file.clone());
            }
            let terminal = Arc::new(Terminal {
                id: uuid::Uuid::new_v4().to_string(),
                chat_id: request.chat_id.clone(),
                shell: command.file.clone(),
                cwd: chosen.path.clone(),
                label: chosen.label.clone().unwrap_or_else(|| host_basename(&chosen.path).to_owned()),
                created_at: (self.inner.options.now)(),
                pty: OnceLock::new(),
                state: Mutex::new(TerminalState {
                    buffer: OutputBuffer::new(limits.max_buffer_chars, limits.max_buffer_lines),
                    cols,
                    rows,
                    exited: false,
                    title: String::new(),
                }),
                version: watch::channel(0).0,
            });
            let sink = Arc::new(Sink { terminal: Arc::downgrade(&terminal), inner: Arc::downgrade(&self.inner) });
            let spawn = SpawnRequest {
                file: command.file,
                args: command.args,
                cwd: PathBuf::from(&chosen.path),
                env,
                cols,
                rows,
                name: TERMINAL_TYPE.into(),
            };
            let pty = self.inner.options.spawner.spawn(spawn, sink).map_err(TerminalError)?;
            let _ = terminal.pty.set(pty);
            let title = terminal.foreground();
            terminal.state.lock().unwrap().title = title;
            state.terminals.push(terminal.clone());
            terminal
        };
        // A shell that ended before it was listed (a bad profile, `exit` in .zprofile) ends its Terminal now.
        if terminal.state.lock().unwrap().exited {
            self.inner.finish(&terminal);
        }
        self.inner.poll_titles();
        self.inner.emit(TerminalEvent::Changed { chat_id: request.chat_id.clone() });
        self.inner.emit(TerminalEvent::ShellsChanged);
        Ok(terminal.info())
    }

    /// Long-polls for output after `after`, the offset a viewer already has (UTF-16 units). `reset` means the viewer
    /// fell behind the kept output (or is new) and gets all of it; `ended` means the shell exited. `limit` (at least
    /// 4096) caps one read: the oldest part of what follows `after`, or the newest of a reset. Dropping the returned
    /// future (a viewer that went away) leaves the Terminal as it was.
    pub async fn read(&self, terminal_id: &str, after: u64, limit: Option<u64>) -> Result<ReadResult> {
        if after > MAX_SAFE_INTEGER {
            return Err(TerminalError::new("Invalid Terminal read."));
        }
        if let Some(limit) = limit {
            if limit < MIN_READ_LIMIT as u64 || limit > MAX_SAFE_INTEGER {
                return Err(TerminalError::new("Invalid Terminal read."));
            }
        }
        let closed = self.inner.state.lock().unwrap().closed;
        let terminal = if closed { None } else { self.inner.get(terminal_id) };
        let Some(terminal) = terminal else {
            return Ok(ReadResult { offset: after, data: String::new(), reset: false, ended: true, terminal: None });
        };
        let mut changes = terminal.version.subscribe();
        let waits = {
            let state = terminal.state.lock().unwrap();
            after == state.buffer.end() && !state.exited
        };
        if waits {
            let _ = tokio::time::timeout(self.inner.options.limits.read_wait, changes.changed()).await;
        }
        let limit = limit.map(|limit| usize::try_from(limit).unwrap_or(usize::MAX));
        let (slice, exited) = {
            let state = terminal.state.lock().unwrap();
            (state.buffer.read(after, limit), state.exited)
        };
        let ended = !slice.more && (exited || !self.inner.contains(&terminal));
        Ok(ReadResult {
            offset: slice.offset,
            data: buffer::to_string(&slice.data),
            reset: slice.reset,
            ended,
            terminal: Some(terminal.info()),
        })
    }

    /// Types into the shell. Input over 64 Ki UTF-16 units is refused; a Terminal whose shell ended accepts nothing.
    pub async fn input(&self, terminal_id: &str, data: &str) -> Result<InputResult> {
        let terminal = self.find(terminal_id)?;
        if buffer::utf16_len(data) > MAX_INPUT {
            return Err(TerminalError::new("Invalid Terminal input."));
        }
        if terminal.state.lock().unwrap().exited {
            return Ok(InputResult { accepted: false });
        }
        if let Some(pty) = terminal.pty.get() {
            pty.write(data).map_err(TerminalError)?;
        }
        Ok(InputResult { accepted: true })
    }

    /// Resizes the PTY (2..=1000 columns, 1..=500 rows). The same size again does nothing.
    pub async fn resize(&self, terminal_id: &str, cols: u64, rows: u64) -> Result<()> {
        let terminal = self.find(terminal_id)?;
        if !(2..=1000).contains(&cols) || !(1..=500).contains(&rows) {
            return Err(TerminalError::new("Invalid Terminal size."));
        }
        let (cols, rows) = (cols as u16, rows as u16);
        {
            let mut state = terminal.state.lock().unwrap();
            if state.exited || (state.cols == cols && state.rows == rows) {
                return Ok(());
            }
            state.cols = cols;
            state.rows = rows;
        }
        if let Some(pty) = terminal.pty.get() {
            // The shell is exiting when this fails.
            let _ = pty.resize(cols, rows);
        }
        Ok(())
    }

    pub async fn close(&self, terminal_id: &str) -> Result<()> {
        let terminal = self.find(terminal_id)?;
        self.inner.kill(&terminal);
        Ok(())
    }

    /// Ends every Terminal of a Chat, when it is archived.
    pub fn close_chat(&self, chat_id: &str) {
        let terminals: Vec<_> = self.inner.state.lock().unwrap().terminals.iter().filter(|t| t.chat_id == chat_id).cloned().collect();
        for terminal in terminals {
            self.inner.kill(&terminal);
        }
    }

    /// Each Chat's running shell pids, so ports their commands open count as the Chat's. First-opened Chat first.
    pub fn shells(&self) -> Vec<(String, Vec<u32>)> {
        let terminals = self.inner.state.lock().unwrap().terminals.clone();
        let mut result: Vec<(String, Vec<u32>)> = Vec::new();
        for terminal in terminals {
            if terminal.state.lock().unwrap().exited {
                continue;
            }
            let Some(pid) = terminal.pty.get().and_then(|pty| pty.pid()).filter(|pid| *pid != 0) else { continue };
            match result.iter_mut().find(|(chat, _)| chat == &terminal.chat_id) {
                Some((_, pids)) => pids.push(pid),
                None => result.push((terminal.chat_id.clone(), vec![pid])),
            }
        }
        result
    }

    /// Open Terminals (the host counts them as running work).
    pub fn size(&self) -> usize {
        self.inner.state.lock().unwrap().terminals.len()
    }

    /// Ends every Terminal, answers their pending reads and refuses further commands. Waits up to `wait` for the PTY
    /// layer to finish stopping what the shells started (SIGKILL after its grace), so the owner never exits first.
    pub async fn dispose(&self, wait: Duration) {
        let terminals = {
            let state = self.inner.state.lock().unwrap();
            if state.closed {
                return;
            }
            state.terminals.clone()
        };
        let mut stopping = Vec::new();
        for terminal in &terminals {
            self.inner.kill(terminal);
            stopping.push(terminal.clone());
        }
        self.inner.state.lock().unwrap().closed = true;
        self.inner.stop_polling();
        let deadline = tokio::time::Instant::now() + wait;
        while tokio::time::Instant::now() < deadline && stopping.iter().any(|t| t.pty.get().is_some_and(|pty| !pty.cleaned())) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

fn save_settings(file: &Path, shell: Option<&str>) -> std::io::Result<()> {
    if let Some(folder) = file.parent() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            std::fs::DirBuilder::new().recursive(true).mode(0o700).create(folder)?;
        }
        #[cfg(not(unix))]
        std::fs::create_dir_all(folder)?;
    }
    let temporary = PathBuf::from(format!("{}.{}.tmp", file.display(), uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        use std::io::Write;
        let mut handle = options.open(&temporary)?;
        handle.write_all(serde_json::json!({ "shell": shell }).to_string().as_bytes())?;
        drop(handle);
        std::fs::rename(&temporary, file)
    })();
    let _ = std::fs::remove_file(&temporary);
    result
}

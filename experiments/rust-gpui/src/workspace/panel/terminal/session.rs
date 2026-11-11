//! One Terminal's emulator and shell: an `alacritty_terminal` [`Term`] (grid, scrollback, VT parser) fed by its own
//! PTY thread, which runs the user's login shell in the Worktree. This is the experiment's local stand-in for the
//! host's `terminal:*` API (`core/terminals.cjs`); the view only talks to [`Session`].

use std::borrow::Cow;
use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use alacritty_terminal::event::{Event, EventListener, WindowSize};
use alacritty_terminal::event_loop::{EventLoop, Msg, Notifier};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::sync::FairMutex;
use alacritty_terminal::term::{Config, Term};
use alacritty_terminal::tty::{self, Options, Shell};

/// xterm.js's `scrollback` in `terminal-sessions.ts`, and the host's 10,000 lines.
pub const SCROLLBACK: usize = 10_000;

/// A grid size in cells.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GridSize {
    pub cols: usize,
    pub lines: usize,
}

impl Dimensions for GridSize {
    fn total_lines(&self) -> usize {
        self.lines
    }

    fn screen_lines(&self) -> usize {
        self.lines
    }

    fn columns(&self) -> usize {
        self.cols
    }
}

/// Sends the emulator's events to the view. Wakeups are coalesced: one waits in the channel until the view has
/// drawn, however much output the PTY thread parses meanwhile.
#[derive(Clone)]
pub struct Listener {
    tx: async_channel::Sender<Event>,
    wake_pending: Arc<AtomicBool>,
}

impl EventListener for Listener {
    fn send_event(&self, event: Event) {
        if matches!(event, Event::Wakeup) && self.wake_pending.swap(true, Ordering::AcqRel) {
            return;
        }
        let _ = self.tx.try_send(event);
    }
}

/// What was sent to a session with no shell.
#[derive(Default, Debug)]
pub struct Record {
    pub input: Vec<u8>,
    pub sizes: Vec<GridSize>,
}

pub struct Session {
    pub term: Arc<FairMutex<Term<Listener>>>,
    /// The PTY thread's mailbox; `None` for a session with no shell (tests).
    pty: Option<Notifier>,
    pub events: async_channel::Receiver<Event>,
    /// What a session with no shell was sent: bytes and PTY sizes (what the tests check).
    pub record: Arc<Mutex<Record>>,
    wake_pending: Arc<AtomicBool>,
    /// The program the shell runs as, for the tab's title until the shell sets one.
    pub shell_name: String,
}

/// What to run: the login shell (alacritty's default, `login -flp $USER $SHELL` on macOS) unless the environment
/// names another (`MILAGRE_GPUI_TERMINAL_SHELL="/bin/bash --noprofile --norc"`, used by snapshots for a fast start).
fn shell_from_env() -> Option<Shell> {
    let value = std::env::var("MILAGRE_GPUI_TERMINAL_SHELL").ok().filter(|v| !v.trim().is_empty())?;
    let mut parts = value.split_whitespace().map(str::to_string);
    let program = parts.next()?;
    Some(Shell::new(program, parts.collect()))
}

fn shell_name(shell: Option<&str>) -> String {
    let path = shell.map(str::to_string).or_else(|| std::env::var("SHELL").ok()).unwrap_or_else(|| "zsh".into());
    Path::new(&path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or(path)
}

fn channel() -> (Listener, async_channel::Receiver<Event>, Arc<AtomicBool>) {
    let (tx, rx) = async_channel::unbounded();
    let wake_pending = Arc::new(AtomicBool::new(false));
    (Listener { tx, wake_pending: wake_pending.clone() }, rx, wake_pending)
}

fn config() -> Config {
    Config { scrolling_history: SCROLLBACK, ..Config::default() }
}

impl Session {
    /// Starts a shell in `cwd` on a new PTY of `size`.
    pub fn spawn(cwd: &Path, size: GridSize, cell: (u16, u16)) -> io::Result<Self> {
        let (listener, events, wake_pending) = channel();
        let term = Arc::new(FairMutex::new(Term::new(config(), &size, listener.clone())));
        let shell = shell_from_env();
        let program = std::env::var("MILAGRE_GPUI_TERMINAL_SHELL").ok();
        let name = shell_name(shell.as_ref().and(program.as_deref()).and_then(|s| s.split_whitespace().next()));
        let env = HashMap::from([
            ("TERM".to_string(), "xterm-256color".to_string()),
            ("COLORTERM".to_string(), "truecolor".to_string()),
            ("TERM_PROGRAM".to_string(), "Milagre".to_string()),
        ]);
        let options = Options { shell, working_directory: Some(cwd.to_path_buf()), drain_on_exit: true, env };
        let pty = tty::new(&options, window_size(size, cell), 0)?;
        let event_loop = EventLoop::new(term.clone(), listener, pty, true, false)?;
        let notifier = Notifier(event_loop.channel());
        event_loop.spawn();
        Ok(Self { term, pty: Some(notifier), events, record: Arc::default(), wake_pending, shell_name: name })
    }

    /// An emulator with no shell: what the headless tests drive with [`Session::feed`].
    pub fn detached(size: GridSize) -> Self {
        let (listener, events, wake_pending) = channel();
        let term = Arc::new(FairMutex::new(Term::new(config(), &size, listener)));
        Self { term, pty: None, events, record: Arc::default(), wake_pending, shell_name: shell_name(None) }
    }

    pub fn has_shell(&self) -> bool {
        self.pty.is_some()
    }

    /// Bytes for the program in front (typing, a paste, a reply the emulator owes it).
    pub fn write(&self, bytes: impl Into<Cow<'static, [u8]>>) {
        match &self.pty {
            Some(pty) => {
                let _ = pty.0.send(Msg::Input(bytes.into()));
            }
            None => self.record.lock().unwrap_or_else(|e| e.into_inner()).input.extend_from_slice(&bytes.into()),
        }
    }

    /// Tells the PTY its new size (the grid has already reflowed).
    pub fn resize_pty(&self, size: GridSize, cell: (u16, u16)) {
        match &self.pty {
            Some(pty) => {
                let _ = pty.0.send(Msg::Resize(window_size(size, cell)));
            }
            None => self.record.lock().unwrap_or_else(|e| e.into_inner()).sizes.push(size),
        }
    }

    /// The view has drawn: the next output wakes it again.
    pub fn woke(&self) {
        self.wake_pending.store(false, Ordering::Release);
    }

    /// Parses `bytes` as if the shell had written them (a session without a shell; tests and fixtures).
    pub fn feed(&self, bytes: &[u8]) {
        let mut parser: alacritty_terminal::vte::ansi::Processor = alacritty_terminal::vte::ansi::Processor::new();
        let mut term = self.term.lock();
        parser.advance(&mut *term, bytes);
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        if let Some(pty) = &self.pty {
            let _ = pty.0.send(Msg::Shutdown);
        }
    }
}

fn window_size(size: GridSize, (cell_width, cell_height): (u16, u16)) -> WindowSize {
    WindowSize { num_lines: size.lines as u16, num_cols: size.cols as u16, cell_width, cell_height }
}

/// Where a new Terminal starts: `MILAGRE_GPUI_TERMINAL_CWD`, else the Git worktree the app runs in (the nearest
/// folder up from the current one with a `.git`), else the home folder.
pub fn default_cwd() -> PathBuf {
    if let Some(dir) = std::env::var_os("MILAGRE_GPUI_TERMINAL_CWD").map(PathBuf::from).filter(|p| p.is_dir()) {
        return dir;
    }
    let here = std::env::current_dir().unwrap_or_default();
    here.ancestors()
        .find(|dir| dir.join(".git").exists())
        .map(Path::to_path_buf)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
        .unwrap_or(here)
}

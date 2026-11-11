//! The PTY boundary, shaped after the node-pty object terminals.cjs uses (`spawn`, `onData`, `onExit`, `write`,
//! `resize`, `kill`, `pid`, `process`). The real implementation is [`crate::unix_pty::UnixPtySpawner`]; tests inject
//! their own, as the Node tests inject `fakePty`.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

/// What a Terminal asks the PTY layer to start.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpawnRequest {
    pub file: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    /// The complete environment: nothing else is inherited.
    pub env: BTreeMap<String, String>,
    pub cols: u16,
    pub rows: u16,
    /// The terminal type (`name` in node-pty).
    pub name: String,
}

/// How a shell ended. `signal` is the signal's name when one ended it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExitInfo {
    pub exit_code: u32,
    pub signal: Option<String>,
}

/// Where a PTY delivers decoded output and its single exit.
pub trait PtyOutput: Send + Sync {
    fn data(&self, text: &str);
    fn exit(&self, info: ExitInfo);
}

/// One running PTY. Every method may be called after the shell exited.
pub trait PtyProcess: Send + Sync {
    fn pid(&self) -> Option<u32>;
    /// The program in front, as node-pty's `process`: the foreground process group's name, or the shell file.
    fn process(&self) -> String;
    /// Queues input; writes reach the shell in call order.
    fn write(&self, data: &str) -> Result<(), String>;
    fn resize(&self, cols: u16, rows: u16) -> Result<(), String>;
    /// Hangs the Terminal up (and stops what it started, per the spawner's cleanup policy).
    fn kill(&self);
    /// True once nothing this PTY started is left to stop. Fakes are always clean.
    fn cleaned(&self) -> bool {
        true
    }
}

pub trait PtySpawner: Send + Sync {
    fn spawn(&self, request: SpawnRequest, output: Arc<dyn PtyOutput>) -> Result<Box<dyn PtyProcess>, String>;
}

/// Used where no real PTY layer exists for the platform yet.
pub struct UnsupportedSpawner;

impl PtySpawner for UnsupportedSpawner {
    fn spawn(&self, _request: SpawnRequest, _output: Arc<dyn PtyOutput>) -> Result<Box<dyn PtyProcess>, String> {
        Err("Terminals are not available on this platform yet.".into())
    }
}

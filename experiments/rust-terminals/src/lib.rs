//! Milagre's Terminal owner in Rust: a port of packages/core/src/terminals.cjs (node-pty 1.1.0) for the backend
//! migration. Library only: nothing here binds a socket, reads Milagre's data directory or replaces the Node daemon.
//! An owner integration constructs [`Terminals`], routes the `terminal:*` commands through [`wire::handle`] and
//! forwards [`TerminalEvent::wire`] events.

pub mod buffer;
pub mod paths;
pub mod shell;
pub mod spawn;
pub mod terminals;
#[cfg(unix)]
pub mod unix_pty;
pub mod utf8;
pub mod wire;

pub use shell::{terminal_environment, terminal_shell, terminal_shells, Platform, ShellCommand, ShellOption, ShellProbe};
pub use spawn::{ExitInfo, PtyOutput, PtyProcess, PtySpawner, SpawnRequest};
pub use terminals::{
    BoxFuture, InputResult, Limits, OpenRequest, Profiles, ReadResult, ResolveChat, TerminalError, TerminalEvent, TerminalInfo,
    TerminalList, Terminals, TerminalsOptions, Worktree,
};
#[cfg(unix)]
pub use unix_pty::{Cleanup, UnixPtySpawner};

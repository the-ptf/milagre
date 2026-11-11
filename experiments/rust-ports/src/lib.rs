//! Milagre's port watcher in Rust: a port of packages/core/src/agents/ports.cjs for the backend migration. It finds
//! the TCP ports each Chat's commands listen on (an agent's command shells, execution agents, Terminal shells and
//! what they started), publishes changes, and stops a listed port's command on request. Library only: nothing is
//! wired into the daemon. Pair with milagre-terminals through [`owner::with_terminal_shells`].

pub mod exec;
pub mod owner;
pub mod parse;
pub mod watcher;
pub mod wire;

pub use owner::{chat_ports, chat_processes, with_terminal_shells, ChatPorts, Groups, Port, Root, Roots};
pub use parse::{parse_lsof, parse_ps, parse_task_outputs, Listener, ProcessRow};
pub use watcher::{Kill, PortWatcher, PortWatcherOptions, Signal, StopWindowsTree};

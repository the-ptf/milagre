//! Claude Code CLI transport for Milagre's Rust backend.
//!
//! Speaks the CLI's documented stream-json control protocol directly (no Node SDK sidecar): bounded
//! NDJSON framing ([`frame`]), control envelopes ([`protocol`]), launch arguments and `initialize`
//! ([`launch`]), owner handler interfaces ([`handlers`]), the process client ([`client`]) and ports of
//! Milagre's current Claude card/result shapes ([`milagre`]). See README.md for sources and gaps.

pub mod client;
pub mod frame;
pub mod handlers;
pub mod launch;
pub mod milagre;
pub mod process;
pub mod protocol;

pub use client::{ClaudeClient, ClaudeEvent, ClientError, ControlReply, Diagnostic, EventStream, ExitInfo, ExitReason, Limits};
pub use handlers::{
    BoxFuture, CancelReason, CancelSignal, Handlers, HookHandler, McpHandler, OtherRequestHandler, PermissionHandler, QuestionHandler,
};
pub use launch::{HookMatcher, InitializeOptions, LaunchOptions, SystemPrompt};
pub use protocol::{HookCallback, McpMessage, PermissionRequest, PermissionResult};

//! Claude Code CLI transport for Milagre's Rust backend.
//!
//! Speaks the CLI's documented stream-json control protocol directly (no Node SDK sidecar): bounded
//! NDJSON framing ([`frame`]), control envelopes ([`protocol`]), launch arguments and `initialize`
//! ([`launch`]), owner handler interfaces ([`handlers`]), the process client ([`client`]), Milagre
//! card/result shapes ([`milagre`]), the event mapper ([`events`]) and Chat session ([`session`]).
//! See README.md for sources, conformance coverage and remaining integration gaps.

mod budget;
pub use budget::EventBudget;

pub mod client;
pub mod drafts;
pub mod events;
pub mod frame;
pub mod handlers;
pub mod images;
pub mod launch;
pub mod milagre;
pub mod process;
pub mod protocol;
pub mod session;
pub mod steps;
pub mod subagents;
pub mod tasks;
pub mod text;

pub use client::{ClaudeClient, ClaudeEvent, ClientError, ControlReply, Diagnostic, EventStream, ExitInfo, ExitReason, Limits};
pub use handlers::{
    BoxFuture, CancelReason, CancelSignal, Handlers, HookHandler, McpHandler, OtherRequestHandler, PermissionHandler, QuestionHandler,
};
pub use launch::{HookMatcher, InitializeOptions, LaunchOptions, SystemPrompt};
pub use protocol::{HookCallback, McpMessage, PermissionRequest, PermissionResult};

pub use events::ClaudeMapper;
pub use session::{
    AccessDecision, AccessPolicy, ClaudeSession, PreToolUseGuard, SessionError, SessionEvents, SessionOptions, TurnRequest, TurnStart,
};

pub use images::{FileImageStore, ToolImageStore};

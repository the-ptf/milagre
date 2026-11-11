//! Codex (`codex app-server`) provider adapter.

pub mod approvals;
pub mod client;
pub mod protocol;
pub mod rpc;
pub mod session;

pub use client::{AccountStatus, CodexClient, ConnectError, ConnectOptions, ResumeError};
pub use protocol::{codex_policy, ClientInfo, CodexPolicy, Incoming, PermissionMode, RequestId};
pub use rpc::{
    CodexRpc, Diagnostic, ExitInfo, ExitReason, Limits, Notification, RpcError, RpcStats, ServerEvent, ServerRequest, SpawnError,
    SpawnOptions,
};
pub use session::{CodexSession, SessionError, SessionEvent, SessionOptions, ThreadSettings, TurnEnd, TurnSettings};

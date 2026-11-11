//! ACP process/protocol and pure event mapping foundation. No runtime adapter, permission policy or account bootstrap.
pub mod client;
pub mod events;
mod events_js;
pub mod launch;
pub mod protocol;
pub mod queue;
pub mod rpc;
pub use protocol::RequestId;
pub use rpc::{AcpRpc, Diagnostic, ExitInfo, ExitReason, Limits, RpcError, ServerEvent, SpawnError, SpawnOptions};

#[cfg(feature = "fake-session")]
pub mod session;

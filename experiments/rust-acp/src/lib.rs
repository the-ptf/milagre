//! ACP process/protocol foundation. No runtime adapter, permission policy or account bootstrap.
pub mod client;
pub mod launch;
pub mod protocol;
pub mod queue;
pub mod rpc;
pub use protocol::RequestId;
pub use rpc::{AcpRpc, Diagnostic, ExitInfo, ExitReason, Limits, RpcError, ServerEvent, SpawnError, SpawnOptions};

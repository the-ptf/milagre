//! Explicit protocol calls. No automatic login, policy, model selection, MCP downgrade or resume
//! retry. Notifications and server requests are returned raw through the transport event stream.
use crate::queue::EventReceiver;
use crate::{protocol, AcpRpc, RpcError, ServerEvent, SpawnError, SpawnOptions};
use serde_json::Value;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Clone)]
pub struct AcpClient {
    rpc: AcpRpc,
    prompting: Arc<Mutex<PromptState>>,
}
#[derive(Debug, thiserror::Error)]
pub enum ConnectError {
    #[error(transparent)]
    Spawn(#[from] SpawnError),
    #[error(transparent)]
    Rpc(#[from] RpcError),
    #[error("ACP protocol version 1 was not negotiated.")]
    Version,
}
impl AcpClient {
    /// Initializes with host filesystem/terminal capabilities disabled. Does not authenticate.
    /// Cancelling initialization drops the last RPC handle and kills the child process group.
    pub async fn connect(options: SpawnOptions, version: &str) -> Result<(Self, Value, EventReceiver<ServerEvent>), ConnectError> {
        let (rpc, events) = AcpRpc::spawn(options)?;
        let init = rpc.request_with_timeout("initialize", protocol::initialize(version), Some(Duration::from_secs(120))).await?;
        if init["protocolVersion"] != 1 {
            return Err(ConnectError::Version);
        }
        Ok((Self { rpc, prompting: Arc::new(Mutex::new(PromptState::default())) }, init, events))
    }
    pub fn rpc(&self) -> &AcpRpc {
        &self.rpc
    }
    /// Explicit opt-in protocol request only. No URL opening or credential/profile handling.
    pub async fn authenticate(&self, method_id: &str, timeout: Duration) -> Result<Value, RpcError> {
        self.rpc.request_with_timeout("authenticate", protocol::authenticate(method_id), Some(timeout)).await
    }
    pub async fn new_session(&self, cwd: &str, mcp: &[Value]) -> Result<Value, RpcError> {
        self.rpc.request_with_timeout("session/new", protocol::session(cwd, mcp, None), Some(Duration::from_secs(120))).await
    }
    pub async fn load_session(&self, id: &str, cwd: &str, mcp: &[Value]) -> Result<Value, RpcError> {
        self.rpc.request_with_timeout("session/load", protocol::session(cwd, mcp, Some(id)), Some(Duration::from_secs(120))).await
    }
    pub async fn resume_session(&self, id: &str, cwd: &str, mcp: &[Value]) -> Result<Value, RpcError> {
        self.rpc.request_with_timeout("session/resume", protocol::session(cwd, mcp, Some(id)), Some(Duration::from_secs(120))).await
    }
    /// A prompt lasts until its response. Dropping this future kills the process: this foundation
    /// has no turn owner to finish cancellation safely. At most one prompt per client/process.
    pub async fn prompt(&self, id: &str, blocks: &[Value]) -> Result<Value, RpcError> {
        {
            let mut state = self.prompting.lock().unwrap();
            if state.active || state.cancelling {
                return Err(RpcError::PromptActive);
            }
            state.active = true;
        }
        let mut guard = PromptGuard { client: self, finished: false };
        let result = self.rpc.request_with_timeout("session/prompt", protocol::prompt(id, blocks), None).await;
        guard.finished = true;
        result
    }
    /// Notification only: caller must continue draining updates/permissions and await prompt.
    /// Use cancel_and_wait for a bounded fallback when the agent ignores cancellation.
    pub async fn cancel(&self, id: &str) -> Result<(), RpcError> {
        self.rpc.notify("session/cancel", Some(protocol::cancel(id))).await
    }
    pub async fn cancel_and_wait(&self, id: &str, grace: Duration) -> Result<(), RpcError> {
        {
            let mut state = self.prompting.lock().unwrap();
            if state.cancelling {
                return Err(RpcError::PromptActive);
            }
            if !state.active {
                return Ok(());
            }
            state.cancelling = true;
        }
        let mut guard = CancelGuard { client: self, finished: false };
        let cancellation = async {
            self.cancel(id).await?;
            while self.prompting.lock().unwrap().active {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            Ok(())
        };
        let result = match tokio::time::timeout(grace, cancellation).await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => {
                self.rpc.abort();
                Err(error)
            }
            Err(_) => {
                self.rpc.abort();
                Err(RpcError::Timeout { method: "session/cancel".into(), after: grace })
            }
        };
        guard.finished = true;
        result
    }

    pub async fn set_config(&self, id: &str, config_id: &str, value: &str) -> Result<Value, RpcError> {
        self.rpc
            .request_with_timeout(
                "session/set_config_option",
                serde_json::json!({"sessionId":id,"configId":config_id,"value":value}),
                Some(Duration::from_secs(15)),
            )
            .await
    }
    pub async fn set_mode(&self, id: &str, mode: &str) -> Result<Value, RpcError> {
        self.rpc
            .request_with_timeout("session/set_mode", serde_json::json!({"sessionId":id,"modeId":mode}), Some(Duration::from_secs(15)))
            .await
    }
}
struct PromptGuard<'a> {
    client: &'a AcpClient,
    finished: bool,
}
impl Drop for PromptGuard<'_> {
    fn drop(&mut self) {
        if !self.finished {
            self.client.rpc.abort();
        }
        self.client.prompting.lock().unwrap().active = false;
    }
}

#[derive(Default)]
struct PromptState {
    active: bool,
    cancelling: bool,
}
struct CancelGuard<'a> {
    client: &'a AcpClient,
    finished: bool,
}
impl Drop for CancelGuard<'_> {
    fn drop(&mut self) {
        if !self.finished {
            self.client.rpc.abort();
        }
        self.client.prompting.lock().unwrap().cancelling = false;
    }
}

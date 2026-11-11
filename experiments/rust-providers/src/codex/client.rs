//! Typed requests on top of [`CodexRpc`]: the `initialize` handshake and the app-server methods
//! Milagre calls, with codex-provider.cjs's timeouts and fallbacks. Results stay raw JSON.

use crate::codex::protocol::{self, methods, ClientInfo};
use crate::codex::rpc::{CodexRpc, ExitInfo, RpcError, ServerEvent, SpawnError, SpawnOptions};
use crate::queue::EventReceiver;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::time::Duration;

/// codex-provider.cjs `ACCOUNT_TIMEOUT_MS`.
pub const ACCOUNT_TIMEOUT: Duration = Duration::from_secs(8);
/// turn/start's timeout in codex-provider.cjs.
pub const TURN_START_TIMEOUT: Duration = Duration::from_secs(90);
/// Pages `model/list` may return before Milagre stops following cursors.
pub const MAX_MODEL_PAGES: usize = 50;

#[derive(Debug, Clone)]
pub struct ConnectOptions {
    pub spawn: SpawnOptions,
    pub client: ClientInfo,
    /// `capabilities: { experimentalApi: true }` (analysis advisors) instead of `null`.
    pub experimental_api: bool,
    /// `None` waits for `initialize` until Codex exits (Chats use the 30 s default).
    pub initialize_timeout: Option<Duration>,
}

impl ConnectOptions {
    pub fn new(spawn: SpawnOptions, client_version: impl Into<String>) -> Self {
        ConnectOptions {
            spawn,
            client: ClientInfo::milagre(client_version),
            experimental_api: false,
            initialize_timeout: Some(crate::codex::rpc::DEFAULT_REQUEST_TIMEOUT),
        }
    }
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum ConnectError {
    #[error(transparent)]
    Spawn(#[from] SpawnError),
    /// `initialize` failed; the process has been stopped.
    #[error("{error}")]
    Initialize { error: RpcError, exit: Option<ExitInfo> },
}

/// What `account/read` says about login, without any account identity. Milagre never needs the
/// email or plan here, so they are not kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AccountStatus {
    pub has_account: bool,
    pub requires_openai_auth: bool,
}

impl AccountStatus {
    /// No account while OpenAI auth is required: `codex login` is needed.
    pub fn login_required(&self) -> bool {
        !self.has_account && self.requires_openai_auth
    }
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum ResumeError {
    /// Codex itself refused the resume and the unarchive retry (codex-provider.cjs `resumeFailed`).
    #[error("Codex could not resume thread {thread_id}.")]
    ResumeFailed { thread_id: String, first: RpcError, second: RpcError },
    /// A timeout or exit: the saved thread id is still good.
    #[error(transparent)]
    Rpc(RpcError),
}

/// A connected, initialized app-server.
#[derive(Clone)]
pub struct CodexClient {
    rpc: CodexRpc,
    initialize: Value,
}

impl CodexClient {
    /// Spawns Codex, sends `initialize` and then the `initialized` notification. On failure the
    /// process is stopped before returning.
    pub async fn connect(options: ConnectOptions) -> Result<(CodexClient, EventReceiver<ServerEvent>), ConnectError> {
        let (rpc, events) = CodexRpc::spawn(options.spawn)?;
        let params = protocol::initialize_params(&options.client, options.experimental_api);
        let initialize = match rpc.request_with_timeout(methods::INITIALIZE, params, options.initialize_timeout).await {
            Ok(result) => result,
            Err(error) => {
                let exit = rpc.close().await;
                return Err(ConnectError::Initialize { error, exit: Some(exit) });
            }
        };
        if let Err(error) = rpc.notify(methods::INITIALIZED, None).await {
            let exit = rpc.close().await;
            return Err(ConnectError::Initialize { error, exit: Some(exit) });
        }
        Ok((CodexClient { rpc, initialize }, events))
    }

    pub fn rpc(&self) -> &CodexRpc {
        &self.rpc
    }

    /// `initialize`'s result as Codex sent it (`userAgent`, …).
    pub fn initialize_result(&self) -> &Value {
        &self.initialize
    }

    pub async fn close(&self) -> ExitInfo {
        self.rpc.close().await
    }

    /// `account/read` with `refreshToken: false`. `None` when Codex can't answer in time: a Codex
    /// that can't say is not held up (codex-provider.cjs `checkLogin`).
    pub async fn account_status(&self) -> Option<AccountStatus> {
        let status =
            self.rpc.request_with_timeout(methods::ACCOUNT_READ, json!({ "refreshToken": false }), Some(ACCOUNT_TIMEOUT)).await.ok()?;
        Some(AccountStatus {
            has_account: status.get("account").is_some_and(|a| !a.is_null()),
            requires_openai_auth: status.get("requiresOpenaiAuth") == Some(&Value::Bool(true)),
        })
    }

    /// Every `model/list` page, following `nextCursor`, raw. Stops on a repeated cursor or after
    /// [`MAX_MODEL_PAGES`] pages.
    pub async fn list_models(&self) -> Result<Vec<Value>, RpcError> {
        let mut models = Vec::new();
        let mut cursor: Option<String> = None;
        let mut seen = HashSet::new();
        for _ in 0..MAX_MODEL_PAGES {
            let params = match &cursor {
                Some(cursor) => json!({ "cursor": cursor }),
                None => json!({}),
            };
            let page = self.rpc.request(methods::MODEL_LIST, params).await?;
            models.extend(page.get("data").and_then(Value::as_array).cloned().unwrap_or_default());
            match page.get("nextCursor").and_then(Value::as_str) {
                Some(next) if seen.insert(next.to_string()) => cursor = Some(next.to_string()),
                _ => break,
            }
        }
        Ok(models)
    }

    /// `config/read` for a cwd.
    pub async fn read_config(&self, cwd: &str) -> Result<Value, RpcError> {
        self.rpc.request(methods::CONFIG_READ, json!({ "cwd": cwd })).await
    }

    /// `thread/start` without a time limit: Codex answers only after watching every skill folder,
    /// which a busy fseventsd stretched past a minute. Fails when Codex exits.
    pub async fn thread_start(&self, params: Value) -> Result<Value, RpcError> {
        self.rpc.request_with_timeout(methods::THREAD_START, params, None).await
    }

    /// `thread/resume`; when Codex refuses, `thread/unarchive` then one more resume. Timeouts and
    /// exits are returned as-is so the caller keeps the saved id.
    pub async fn thread_resume(&self, thread_id: &str, params: Value) -> Result<Value, ResumeError> {
        let mut params = params;
        if let Some(object) = params.as_object_mut() {
            object.insert("threadId".into(), thread_id.into());
        }
        let first = match self.rpc.request_with_timeout(methods::THREAD_RESUME, params.clone(), None).await {
            Ok(result) => return Ok(result),
            Err(error) if error.is_server_error() => error,
            Err(error) => return Err(ResumeError::Rpc(error)),
        };
        let retry = async {
            self.rpc.request(methods::THREAD_UNARCHIVE, json!({ "threadId": thread_id })).await?;
            self.rpc.request_with_timeout(methods::THREAD_RESUME, params, None).await
        };
        match retry.await {
            Ok(result) => Ok(result),
            Err(second) if second.is_server_error() => Err(ResumeError::ResumeFailed { thread_id: thread_id.into(), first, second }),
            Err(error) => Err(ResumeError::Rpc(error)),
        }
    }

    pub async fn thread_read(&self, thread_id: &str, include_turns: bool) -> Result<Value, RpcError> {
        let params = if include_turns { json!({ "threadId": thread_id, "includeTurns": true }) } else { json!({ "threadId": thread_id }) };
        self.rpc.request_with_timeout(methods::THREAD_READ, params, Some(Duration::from_secs(5))).await
    }

    /// `thread/turns/list` (5 s), e.g. `{ threadId, limit, sortDirection, itemsView, cursor? }`.
    pub async fn thread_turns_list(&self, params: Value) -> Result<Value, RpcError> {
        self.rpc.request_with_timeout(methods::THREAD_TURNS_LIST, params, Some(Duration::from_secs(5))).await
    }

    /// `turn/start`, 90 s limit. Returns the whole result (`{ turn: { id, … } }`).
    pub async fn turn_start(&self, params: Value) -> Result<Value, RpcError> {
        self.rpc.request_with_timeout(methods::TURN_START, params, Some(TURN_START_TIMEOUT)).await
    }

    pub async fn turn_steer(&self, thread_id: &str, expected_turn_id: &str, input: Vec<Value>) -> Result<Value, RpcError> {
        self.rpc.request(methods::TURN_STEER, json!({ "threadId": thread_id, "expectedTurnId": expected_turn_id, "input": input })).await
    }

    pub async fn turn_interrupt(&self, thread_id: &str, turn_id: &str, timeout: Duration) -> Result<Value, RpcError> {
        self.rpc.request_with_timeout(methods::TURN_INTERRUPT, json!({ "threadId": thread_id, "turnId": turn_id }), Some(timeout)).await
    }
}

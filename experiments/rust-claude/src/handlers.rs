//! Owner-side handlers for the requests the CLI sends this side.
//!
//! Each handler runs on its own task, so a permission card the user takes minutes to answer never
//! blocks the stream. The CLI may withdraw a request (`control_cancel_request`), the process may exit,
//! or the client may close: the handler's [`CancelSignal`] fires, its eventual reply is discarded and
//! nothing is written for it.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::Value;
use tokio::sync::watch;

use crate::protocol::{HookCallback, McpMessage, PermissionRequest, PermissionResult};

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

/// Why a request stopped needing an answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CancelReason {
    /// The CLI sent `control_cancel_request` (e.g. the turn was interrupted).
    Withdrawn,
    /// The CLI process ended.
    Exited,
    /// The owner called close() or kill(); no further reply should be sent.
    Closed,
}

/// Fires once when the request no longer needs an answer.
#[derive(Debug, Clone)]
pub struct CancelSignal(watch::Receiver<Option<CancelReason>>);

#[derive(Debug)]
pub(crate) struct CancelTrigger(watch::Sender<Option<CancelReason>>);

pub(crate) fn cancel_pair() -> (CancelTrigger, CancelSignal) {
    let (tx, rx) = watch::channel(None);
    (CancelTrigger(tx), CancelSignal(rx))
}

impl CancelTrigger {
    pub(crate) fn fire(&self, reason: CancelReason) {
        self.0.send_if_modified(|current| {
            if current.is_some() {
                return false;
            }
            *current = Some(reason);
            true
        });
    }
}

impl CancelSignal {
    pub fn reason(&self) -> Option<CancelReason> {
        *self.0.borrow()
    }

    /// Resolves when the request is cancelled (never, if it is answered first and the signal outlives it).
    pub async fn cancelled(&mut self) -> CancelReason {
        loop {
            if let Some(reason) = *self.0.borrow_and_update() {
                return reason;
            }
            if self.0.changed().await.is_err() {
                // Trigger dropped without firing: the request was settled; wait forever.
                std::future::pending::<()>().await;
            }
        }
    }
}

/// `can_use_tool` for every tool except AskUserQuestion (when a [`QuestionHandler`] is set).
/// `Err` becomes a control error response; the CLI then treats the tool call as failed.
pub trait PermissionHandler: Send + Sync + 'static {
    fn can_use_tool(&self, request: PermissionRequest, cancel: CancelSignal) -> BoxFuture<Result<PermissionResult, String>>;
}

/// AskUserQuestion, which reaches `can_use_tool` in every permission mode. The answers go back as an
/// allow with `updatedInput.answers` (see `milagre::question_result`).
pub trait QuestionHandler: Send + Sync + 'static {
    fn ask(&self, request: PermissionRequest, cancel: CancelSignal) -> BoxFuture<Result<PermissionResult, String>>;
}

/// `hook_callback`: the returned object is the hook output (`hookSpecificOutput`, `continue`, ...).
pub trait HookHandler: Send + Sync + 'static {
    fn call(&self, callback: HookCallback, cancel: CancelSignal) -> BoxFuture<Result<Value, String>>;
}

/// `mcp_message` for in-process MCP servers. Return the JSON-RPC reply, or `None` for a notification or
/// response (the transport then acks with an empty result, as the Python SDK does).
pub trait McpHandler: Send + Sync + 'static {
    fn message(&self, message: McpMessage, cancel: CancelSignal) -> BoxFuture<Result<Option<Value>, String>>;
}

/// Any other CLI-originated request (`elicitation`, `request_user_dialog`, future subtypes).
/// `Ok(Some(payload))` replies success, `Err` replies error, `Ok(None)` sends nothing: required for a
/// `request_user_dialog` kind this host did not declare (an error reply would be discarded anyway, and
/// a success would be a real settlement).
pub trait OtherRequestHandler: Send + Sync + 'static {
    fn request(&self, subtype: String, request: Value, cancel: CancelSignal) -> BoxFuture<Result<Option<Value>, String>>;
}

/// The owner's handlers. Missing ones answer as the Python SDK does: an error for `can_use_tool` and
/// `hook_callback`, a JSON-RPC "not found" for `mcp_message`, an error for unknown subtypes, and no
/// reply for `request_user_dialog`.
#[derive(Clone, Default)]
pub struct Handlers {
    pub permissions: Option<Arc<dyn PermissionHandler>>,
    pub questions: Option<Arc<dyn QuestionHandler>>,
    pub hooks: Option<Arc<dyn HookHandler>>,
    pub mcp: Option<Arc<dyn McpHandler>>,
    pub other: Option<Arc<dyn OtherRequestHandler>>,
}

/// Closure adapters, for tests and small owners.
pub struct FnPermission<F>(pub F);
impl<F> PermissionHandler for FnPermission<F>
where
    F: Fn(PermissionRequest, CancelSignal) -> BoxFuture<Result<PermissionResult, String>> + Send + Sync + 'static,
{
    fn can_use_tool(&self, request: PermissionRequest, cancel: CancelSignal) -> BoxFuture<Result<PermissionResult, String>> {
        (self.0)(request, cancel)
    }
}

pub struct FnQuestion<F>(pub F);
impl<F> QuestionHandler for FnQuestion<F>
where
    F: Fn(PermissionRequest, CancelSignal) -> BoxFuture<Result<PermissionResult, String>> + Send + Sync + 'static,
{
    fn ask(&self, request: PermissionRequest, cancel: CancelSignal) -> BoxFuture<Result<PermissionResult, String>> {
        (self.0)(request, cancel)
    }
}

pub struct FnHook<F>(pub F);
impl<F> HookHandler for FnHook<F>
where
    F: Fn(HookCallback, CancelSignal) -> BoxFuture<Result<Value, String>> + Send + Sync + 'static,
{
    fn call(&self, callback: HookCallback, cancel: CancelSignal) -> BoxFuture<Result<Value, String>> {
        (self.0)(callback, cancel)
    }
}

pub struct FnMcp<F>(pub F);
impl<F> McpHandler for FnMcp<F>
where
    F: Fn(McpMessage, CancelSignal) -> BoxFuture<Result<Option<Value>, String>> + Send + Sync + 'static,
{
    fn message(&self, message: McpMessage, cancel: CancelSignal) -> BoxFuture<Result<Option<Value>, String>> {
        (self.0)(message, cancel)
    }
}

pub struct FnOther<F>(pub F);
impl<F> OtherRequestHandler for FnOther<F>
where
    F: Fn(String, Value, CancelSignal) -> BoxFuture<Result<Option<Value>, String>> + Send + Sync + 'static,
{
    fn request(&self, subtype: String, request: Value, cancel: CancelSignal) -> BoxFuture<Result<Option<Value>, String>> {
        (self.0)(subtype, request, cancel)
    }
}

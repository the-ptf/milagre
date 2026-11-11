//! Cancellation observes an accepted operation; it never replays a mutation.
use crate::*;
use tokio::sync::oneshot;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CallPhase {
    Queued,
    Running,
    CancelledBeforeStart,
    Finished,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MutationOutcome {
    NotAttempted,
    Committed,
    Uncertain,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CallStatus {
    pub phase: CallPhase,
    pub mutation: MutationOutcome,
    pub cancelled: bool,
}
/// Retain this before awaiting when the owner needs cancellation evidence. It
/// contains no request arguments, content, reply, credentials or caller identity.
#[derive(Clone)]
pub struct CallReceipt(Arc<Mutex<CallStatus>>);
impl CallReceipt {
    pub(crate) fn new() -> Self {
        Self(Arc::new(Mutex::new(CallStatus {
            phase: CallPhase::Queued,
            mutation: MutationOutcome::NotAttempted,
            cancelled: false,
        })))
    }
    pub fn status(&self) -> CallStatus {
        *self.0.lock().unwrap_or_else(|p| p.into_inner())
    }
    pub fn cancel(&self) -> CallStatus {
        let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        state.cancelled = true;
        if state.phase == CallPhase::Queued {
            state.phase = CallPhase::CancelledBeforeStart;
        }
        *state
    }
    pub(crate) fn begin(&self, mutating: bool) -> Result<()> {
        let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if state.phase == CallPhase::CancelledBeforeStart {
            return Err(Error::coded(
                "CALL_CANCELLED",
                "Tool call cancelled before storage execution; no mutation was attempted.",
            ));
        }
        state.phase = CallPhase::Running;
        if mutating {
            state.mutation = MutationOutcome::Uncertain;
        }
        Ok(())
    }
    pub(crate) fn committed(&self) {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).mutation = MutationOutcome::Committed;
    }
    pub(crate) fn finish(&self) {
        let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if state.phase != CallPhase::CancelledBeforeStart {
            state.phase = CallPhase::Finished;
        }
    }
}
/// Dropping this skips work that has not entered storage. Once storage execution
/// begins, it runs to completion under the same owner lane. Retain receipt() to
/// observe that outcome; cancellation is never proof that a write did not commit.
pub struct AcceptedCall {
    pub(crate) receipt: CallReceipt,
    pub(crate) reply: oneshot::Receiver<Value>,
}
impl AcceptedCall {
    pub fn receipt(&self) -> CallReceipt {
        self.receipt.clone()
    }
    pub fn cancel(&self) -> CallStatus {
        self.receipt.cancel()
    }
    pub async fn wait(mut self) -> Value {
        match (&mut self.reply).await {
            Ok(value)=>value,
            Err(_)=>tool_error("Tool worker stopped without a reply. Inspect its receipt and saved state; do not replay the mutation."),
        }
    }
}
impl Drop for AcceptedCall {
    fn drop(&mut self) {
        if self.receipt.status().phase != CallPhase::Finished {
            self.receipt.cancel();
        }
    }
}

pub(crate) struct CancelOnDrop(pub CallReceipt);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if self.0.status().phase != CallPhase::Finished {
            self.0.cancel();
        }
    }
}

//! Explicit GitHub reads outside the serial actor, on the wire server's retained
//! handler lane. One active operation, no queue; actor admission and acceptance
//! bracket every read. Shutdown revokes the selection before checking drainage.
use milagre_owner_wire::{RpcError, RpcResult};
use milagre_pr_details::{CapturedContext, DetailsReader, GithubSelectionOwner, ServiceError};
use serde_json::Value;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};
pub(crate) const METHODS: &[&str] = &["pr:detail"];
fn convert(e: ServiceError) -> RpcError {
    RpcError::new(e.code, e.message)
}
pub(crate) struct ConfiguredPrDetails {
    owner: GithubSelectionOwner,
    reader: DetailsReader,
    active: AtomicUsize,
    stopped: Mutex<bool>,
}
impl ConfiguredPrDetails {
    pub(crate) fn new(context: CapturedContext) -> Result<Arc<Self>, RpcError> {
        let owner = GithubSelectionOwner::capture(context).map_err(convert)?;
        let reader = owner.reader().map_err(convert)?;
        Ok(Arc::new(Self {
            owner,
            reader,
            active: AtomicUsize::new(0),
            stopped: Mutex::new(false),
        }))
    }
    pub(crate) fn check(&self) -> Result<(), RpcError> {
        self.reader.validate_selection().map_err(convert)
    }
    pub(crate) fn invoke(&self, args: &[Value]) -> RpcResult {
        self.check()?;
        {
            let stopped = self.stopped.lock().map_err(|_| {
                RpcError::new("PR_SELECTION_REVOKED", "GitHub admission is unavailable")
            })?;
            if *stopped {
                return Err(RpcError::new(
                    "PR_SELECTION_REVOKED",
                    "The GitHub selection was closed",
                ));
            }
            self.active
                .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
                .map_err(|_| {
                    RpcError::new("PR_READ_BUSY", "Another GitHub detail read is active")
                })?;
        }
        struct Active<'a>(&'a AtomicUsize);
        impl Drop for Active<'_> {
            fn drop(&mut self) {
                self.0.store(0, Ordering::Release);
            }
        }
        let _active = Active(&self.active);
        self.reader.invoke(args).map_err(convert)
    }
    pub(crate) fn stop(&self) -> bool {
        match self.stopped.lock() {
            Ok(mut stopped) => {
                *stopped = true;
                self.owner.close();
            }
            Err(_) => {
                self.owner.close();
                return false;
            }
        }
        let monitor = self.reader.monitor();
        self.active.load(Ordering::Acquire) == 0
            && monitor.active_children() == 0
            && !monitor.cleanup_retained()
    }
    pub(crate) fn revoke(&self) {
        let _ = self.stop();
    }
    pub(crate) fn drain_before_owner_drop(&self) {
        while !self.stop() {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
}

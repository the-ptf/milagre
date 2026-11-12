//! Explicitly granted remote PR detail reads for one owned Project connection.
use super::*;
#[derive(Clone)]
pub struct PrDetailsReads {
    handle: Weak<Handle>,
}
impl Client {
    pub(crate) fn owned_pr_details_for(
        &self,
        authority: &Arc<Authority>,
    ) -> Result<PrDetailsReads> {
        if self.handle.stop.load(Ordering::Acquire) {
            return Err(Error::Disconnected);
        }
        if !Weak::ptr_eq(&self.handle.authority, &Arc::downgrade(authority)) {
            return Err(Error::InvalidScope);
        }
        Ok(PrDetailsReads {
            handle: Arc::downgrade(&self.handle),
        })
    }
}
impl PrDetailsReads {
    /// Requires a connection-opened Project and the daemon's explicit GitHub
    /// capability. No account, host, repository, cwd or arbitrary query is exposed.
    pub async fn detail(&self, number: u64) -> Result<Value> {
        if number == 0 || number > 9_007_199_254_740_991 {
            return Err(input("number", "Expected a positive safe PR number"));
        }
        let handle = self.handle.upgrade().ok_or(Error::Disconnected)?;
        if handle.stop.load(Ordering::Acquire) {
            return Err(Error::Disconnected);
        }
        if !handle.opened_view.load(Ordering::Acquire) {
            return Err(Error::ViewNotOpened);
        }
        let client = Client { handle };
        let args = json!([{"cwd":client.handle.project,"number":number}]);
        let (reply, wait) = reply::channel();
        client.submit(Kind::Call {
            method: "pr:detail",
            args,
            reply,
        })?;
        drop(client); // Waiting must not keep the connection or runtime owner alive.
        wait.await
    }
}

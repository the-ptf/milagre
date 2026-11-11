//! Opt-in cooperative same-UID macOS native fixture. This is not immutable-descriptor
//! execution, production authority, a fallback, or the account/owner host binding.
//! The exact sibling native artifact is the only source; no path/environment API exists.
mod core;
pub use core::{CancelHandle, Error, Execution, FixtureCase, Progress, Report};

/// One independent fixture process, owned by a standard-library worker through reap.
/// Dropping this observer requests cancellation and never abandons the child.
/// ```compile_fail
/// use milagre_acp::private_copy::MacOsPrivateCopyFixture;
/// let fixture = MacOsPrivateCopyFixture::from_path("/tmp/provider");
/// ```
pub struct MacOsPrivateCopyFixture {
    observer: core::Observer,
}
impl MacOsPrivateCopyFixture {
    pub fn start(case: FixtureCase, text: &str) -> Result<Self, Error> {
        Ok(Self { observer: core::automatic(case, text)? })
    }
    pub fn cancel(&self) {
        self.observer.cancel_handle().cancel();
    }
    /// Independently usable while the single observer is waiting. Dropping this
    /// capability does not cancel; dropping the fixture observer still does.
    pub fn cancel_handle(&self) -> CancelHandle {
        self.observer.cancel_handle()
    }
    /// Compatibility snapshot of the first/current report. For subsequent cleanup
    /// changes, use next_progress, which consumes each revision only once.
    pub async fn wait(&mut self) -> Report {
        self.observer.wait().await
    }
    /// One bounded cumulative snapshot per changed revision; None after the final
    /// snapshot. A mutable borrow permits one waiter, including wait().
    pub async fn next_progress(&mut self) -> Option<Progress> {
        self.observer.next().await
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests;

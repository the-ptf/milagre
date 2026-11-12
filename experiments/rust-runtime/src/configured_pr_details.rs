//! Explicit GitHub reads outside the serial actor, on the wire server's retained
//! handler lane. The reader joins concurrent reads of one PR number and queues a few
//! others; actor admission and acceptance bracket every read. A shutdown pauses reads
//! (cancelling the running child) before checking drainage and resumes them if that
//! shutdown is refused; only dropping the owner closes the selection for good.
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
    /// First step of a request, before the actor's own check: see `DetailsReader::admit`.
    pub(crate) fn admit(&self) -> Result<(), RpcError> {
        self.reader.admit().map_err(convert)
    }
    pub(crate) fn check(&self) -> Result<(), RpcError> {
        self.reader.validate_selection().map_err(convert)
    }
    /// `gone` reports that this request's client disconnected: the caller stops
    /// waiting, and the child is killed when nobody else waits for the same read.
    pub(crate) fn invoke(&self, args: &[Value], gone: &dyn Fn() -> bool) -> RpcResult {
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
            // Counted under the same lock `close` takes, so a closing runtime never
            // misses a read that was admitted just before it.
            self.active.fetch_add(1, Ordering::AcqRel);
        }
        struct Active<'a>(&'a AtomicUsize);
        impl Drop for Active<'_> {
            fn drop(&mut self) {
                self.0.fetch_sub(1, Ordering::AcqRel);
            }
        }
        let _active = Active(&self.active);
        self.reader.invoke_cancellable(args, gone).map_err(convert)
    }
    fn drained(&self) -> bool {
        let monitor = self.reader.monitor();
        self.active.load(Ordering::Acquire) == 0
            && monitor.active_children() == 0
            && !monitor.cleanup_retained()
    }
    /// Cancel running reads and refuse new ones until `resume`. Never closes the
    /// selection, so a quit that is then refused leaves the service working.
    pub(crate) fn pause(&self) {
        self.reader.pause();
    }
    pub(crate) fn resume(&self) {
        if !self.stopped.lock().is_ok_and(|stopped| *stopped) {
            self.reader.resume();
        }
    }
    /// Pause, then report whether every read and child has drained.
    pub(crate) fn stop(&self) -> bool {
        self.pause();
        self.drained()
    }
    /// The Project is gone or the owner is dropping: close the selection for good.
    pub(crate) fn revoke(&self) {
        self.close();
    }
    fn close(&self) {
        if let Ok(mut stopped) = self.stopped.lock() {
            *stopped = true;
        }
        self.reader.pause();
        self.owner.close();
    }
    pub(crate) fn drain_before_owner_drop(&self) {
        self.close();
        while !self.drained() {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use milagre_owner_wire::IsolatedProfile;
    use serde_json::json;
    use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf};

    const ANSWER: &str = r#"{"data":{"viewer":{"login":"alice"},"repository":{"pullRequest":{"number":12,"state":"CLOSED","files":{"nodes":[],"pageInfo":{"hasNextPage":false}}}}}}"#;

    fn service() -> (IsolatedProfile, Arc<ConfiguredPrDetails>, PathBuf) {
        let profile = IsolatedProfile::create().unwrap();
        let root = profile.path().to_owned();
        let dirs = ["project", "home", "account"].map(|name| {
            let path = root.join(name);
            fs::create_dir(&path).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            path
        });
        for name in ["hosts.yml", "config.yml"] {
            let path = dirs[2].join(name);
            fs::write(&path, "synthetic\n").unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        }
        let program = root.join("gh");
        fs::write(&program, format!("#!/bin/sh\necho '{ANSWER}'\n")).unwrap();
        fs::set_permissions(&program, fs::Permissions::from_mode(0o700)).unwrap();
        let service = ConfiguredPrDetails::new(CapturedContext {
            project: dirs[0].clone(),
            program,
            home: dirs[1].clone(),
            config_directory: dirs[2].clone(),
            owner: "example".into(),
            repository: "repo".into(),
            account_login: "alice".into(),
            path: "/usr/bin:/bin".into(),
            computer_label: "this computer".into(),
            lifetime: Arc::new(()),
            check: Arc::new(|| Ok(())),
            local_commits: None,
        })
        .unwrap();
        (profile, service, dirs[0].clone())
    }
    fn read(service: &ConfiguredPrDetails, project: &PathBuf) -> RpcResult {
        service.invoke(&[json!({"cwd":project,"number":12})], &|| false)
    }

    #[test]
    fn a_refused_quit_resumes_reads_but_a_closed_service_stays_closed() {
        let (_profile, service, project) = service();
        assert_eq!(read(&service, &project).unwrap()["ok"], true);
        // The quit's own steps pause reads and report drainage.
        assert!(service.stop());
        assert_eq!(
            read(&service, &project).unwrap_err().code,
            "PR_SELECTION_REVOKED"
        );
        // The quit was refused: the selection was never closed, so reads work again.
        service.resume();
        assert_eq!(read(&service, &project).unwrap()["ok"], true);
        // A closed service does not come back, resume or not.
        service.revoke();
        service.resume();
        assert_eq!(
            read(&service, &project).unwrap_err().code,
            "PR_SELECTION_REVOKED"
        );
    }
}

//! The data side of the update card (G-24, O-16; `update:*` and `app:version`). Fixture only: there is no update feed
//! and no network yet. `UpdateMachine` is the state `update:state` carries, moved by the same events the main process
//! raises; `UpdateNotice::set_state` takes `machine.state()`. A real feed (WP-56's open decision) drives the same events.

use crate::notices::model::{AppUpdate, UpdateStatus};

/// `app:version`: the package version, plus the commit the bundle was built from when `scripts/bundle-macos.sh` set
/// `MILAGRE_GPUI_SHA` for the build.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppVersion {
    pub version: &'static str,
    pub build: Option<&'static str>,
}

impl AppVersion {
    pub const fn current() -> Self {
        Self { version: env!("CARGO_PKG_VERSION"), build: option_env!("MILAGRE_GPUI_SHA") }
    }

    /// "0.1.0 (0b10316e)", or just the version outside a packaged build.
    pub fn display(&self) -> String {
        match self.build {
            Some(build) => format!("{} ({build})", self.version),
            None => self.version.to_string(),
        }
    }
}

/// The updater's state machine. Events that do not fit the current state are ignored, as the main process does.
#[derive(Clone, Debug, PartialEq)]
pub struct UpdateMachine {
    state: AppUpdate,
}

impl Default for UpdateMachine {
    fn default() -> Self {
        Self { state: AppUpdate::new(UpdateStatus::Idle) }
    }
}

impl UpdateMachine {
    pub fn state(&self) -> &AppUpdate {
        &self.state
    }

    pub fn set_auto(&mut self, auto: bool) {
        self.state.auto = auto;
    }

    /// `update:check`.
    pub fn check(&mut self) {
        if matches!(self.state.status, UpdateStatus::Idle | UpdateStatus::UpToDate | UpdateStatus::Error) {
            self.state = AppUpdate { auto: self.state.auto, ..AppUpdate::new(UpdateStatus::Checking) };
        }
    }

    /// The check found nothing newer.
    pub fn up_to_date(&mut self) {
        if self.state.status == UpdateStatus::Checking {
            self.state = AppUpdate { auto: self.state.auto, ..AppUpdate::new(UpdateStatus::UpToDate) };
        }
    }

    /// The check found `version`: the download starts.
    pub fn found(&mut self, version: &str) {
        if self.state.status == UpdateStatus::Checking {
            self.state = AppUpdate { auto: self.state.auto, ..AppUpdate::new(UpdateStatus::Downloading).with_version(version) };
        }
    }

    /// Download progress, 0 to 100, never going backwards.
    pub fn progress(&mut self, percent: f32) {
        if self.state.downloading() {
            self.state.progress = percent.clamp(0.0, 100.0).max(self.state.progress);
        }
    }

    /// The download finished and verified.
    pub fn downloaded(&mut self) {
        if self.state.downloading() {
            self.state.status = UpdateStatus::Downloaded;
            self.state.progress = 100.0;
        }
    }

    /// `update:install`: only a downloaded update installs.
    pub fn install(&mut self) -> bool {
        let ready = self.state.ready();
        if ready {
            self.state.status = UpdateStatus::Installing;
        }
        ready
    }

    /// A step failed. The version stays, so the card can name it and "Try again" works.
    pub fn fail(&mut self, message: &str) {
        if !matches!(self.state.status, UpdateStatus::Idle | UpdateStatus::UpToDate | UpdateStatus::Unavailable) {
            self.state.status = UpdateStatus::Error;
            self.state.error = Some(message.to_string());
        }
    }

    /// "Try again": a failed update goes back to downloading its version (or checking, without one).
    pub fn retry(&mut self) {
        if !self.state.failed() {
            return;
        }
        let auto = self.state.auto;
        self.state = match self.state.version.clone() {
            Some(version) => AppUpdate { auto, ..AppUpdate::new(UpdateStatus::Downloading).with_version(&version) },
            None => AppUpdate { auto, ..AppUpdate::new(UpdateStatus::Checking) },
        };
    }

    /// Updates cannot run here (a development build): the card stays hidden.
    pub fn unavailable(&mut self) {
        self.state = AppUpdate::new(UpdateStatus::Unavailable);
    }
}

/// The fixture feed: the whole path a real update takes, in the order the notice shows it.
pub fn fixture_run(version: &str) -> Vec<AppUpdate> {
    let mut machine = UpdateMachine::default();
    let mut seen = vec![machine.state().clone()];
    machine.check();
    seen.push(machine.state().clone());
    machine.found(version);
    seen.push(machine.state().clone());
    for percent in [25.0, 60.0, 90.0] {
        machine.progress(percent);
        seen.push(machine.state().clone());
    }
    machine.downloaded();
    seen.push(machine.state().clone());
    machine.install();
    seen.push(machine.state().clone());
    seen
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn happy_path_runs_in_order() {
        let statuses: Vec<_> = fixture_run("0.2.0").iter().map(|state| state.status).collect();
        use UpdateStatus::*;
        assert_eq!(statuses, [Idle, Checking, Downloading, Downloading, Downloading, Downloading, Downloaded, Installing]);
    }

    #[test]
    fn progress_never_goes_back_and_install_needs_a_download() {
        let mut machine = UpdateMachine::default();
        assert!(!machine.install());
        machine.check();
        machine.found("0.2.0");
        machine.progress(60.0);
        machine.progress(30.0);
        assert_eq!(machine.state().percent(), 60);
        assert!(!machine.install());
        machine.downloaded();
        assert!(machine.install());
        assert!(machine.state().installing());
    }

    #[test]
    fn failure_keeps_the_version_and_retry_downloads_again() {
        let mut machine = UpdateMachine::default();
        machine.set_auto(true);
        machine.check();
        machine.found("0.2.0");
        machine.fail("disk full");
        assert!(machine.state().failed());
        assert_eq!(machine.state().version_str(), "0.2.0");
        machine.retry();
        assert!(machine.state().downloading());
        assert!(machine.state().auto);
    }

    #[test]
    fn a_failure_with_nothing_running_is_ignored() {
        let mut machine = UpdateMachine::default();
        machine.fail("nope");
        assert_eq!(machine.state().status, UpdateStatus::Idle);
        machine.check();
        machine.up_to_date();
        assert_eq!(machine.state().status, UpdateStatus::UpToDate);
    }

    #[test]
    fn a_downloaded_update_opens_the_card_once_per_version() {
        use crate::notices::model::Presentation;
        let mut machine = UpdateMachine::default();
        machine.check();
        machine.found("0.2.0");
        machine.downloaded();
        let mut presentation = Presentation::default();
        assert!(presentation.observe(machine.state()));
        assert!(presentation.is_open(machine.state()));
        assert!(!presentation.observe(machine.state()));
    }

    #[test]
    fn version_display_names_the_build() {
        assert_eq!(AppVersion { version: "0.1.0", build: Some("abc1234") }.display(), "0.1.0 (abc1234)");
        assert_eq!(AppVersion { version: "0.1.0", build: None }.display(), "0.1.0");
        assert!(!AppVersion::current().version.is_empty());
    }
}

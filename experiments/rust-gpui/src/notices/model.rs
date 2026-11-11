//! What the notices show and the words they use. After `packages/shared/src/app-update.ts` (`AppUpdateState`,
//! `AUTO_UPDATE_WAITING`), `UpdateNotice.tsx`, `ProviderUpdateNotice.tsx`, `PersistenceNotice.tsx` and the host
//! connection `App.tsx` reads (`runtime:connection`).

use crate::data::Provider;

/// `AppUpdateState.status`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpdateStatus {
    Idle,
    Checking,
    UpToDate,
    Downloading,
    Downloaded,
    Installing,
    Error,
    Unavailable,
}

/// `AppUpdateState` (`update:*`).
#[derive(Clone, Debug, PartialEq)]
pub struct AppUpdate {
    pub status: UpdateStatus,
    pub version: Option<String>,
    /// 0 to 100.
    pub progress: f32,
    pub error: Option<String>,
    /// Auto update is on: a downloaded update installs by itself once nothing runs.
    pub auto: bool,
}

impl AppUpdate {
    pub fn new(status: UpdateStatus) -> Self {
        Self { status, version: None, progress: 0.0, error: None, auto: false }
    }

    pub fn with_version(mut self, version: &str) -> Self {
        self.version = Some(version.to_string());
        self
    }

    pub fn ready(&self) -> bool {
        self.status == UpdateStatus::Downloaded
    }

    pub fn installing(&self) -> bool {
        self.status == UpdateStatus::Installing
    }

    pub fn downloading(&self) -> bool {
        self.status == UpdateStatus::Downloading
    }

    pub fn failed(&self) -> bool {
        self.status == UpdateStatus::Error
    }

    pub fn version_str(&self) -> &str {
        self.version.as_deref().unwrap_or("")
    }

    /// Whole percent, 0 to 100.
    pub fn percent(&self) -> u32 {
        self.progress.clamp(0.0, 100.0).round() as u32
    }

    /// The card's title and the pill's text.
    pub fn title(&self) -> &'static str {
        match self.status {
            UpdateStatus::Installing => "Restarting Milagre",
            UpdateStatus::Downloaded => "Update available",
            UpdateStatus::Downloading => "Downloading update",
            UpdateStatus::Error => "Update failed",
            UpdateStatus::Checking => "Checking for updates",
            _ => "Up to date",
        }
    }

    /// The pill's text: the download shows its percent.
    pub fn pill_text(&self) -> String {
        if self.downloading() { format!("Downloading update \u{b7} {}%", self.percent()) } else { self.title().to_string() }
    }

    /// The card's first line.
    pub fn description(&self) -> String {
        match self.status {
            UpdateStatus::Downloaded => {
                let version = if self.version_str().is_empty() { "The update".to_string() } else { format!("v{}", self.version_str()) };
                format!("{version} is ready to install.")
            }
            UpdateStatus::Installing => "Saving your work and restarting with the new version.".into(),
            UpdateStatus::Downloading => "You can keep working while Milagre downloads the update.".into(),
            UpdateStatus::UpToDate => "You have the latest version of Milagre.".into(),
            UpdateStatus::Checking => "Looking for a newer version of Milagre.".into(),
            _ => "The update could not finish.".into(),
        }
    }

    /// The card's second line, only for a downloaded update.
    pub fn restart_note(&self) -> Option<&'static str> {
        self.ready().then_some(if self.auto { AUTO_UPDATE_WAITING } else { "Restarting Milagre will stop running agents." })
    }
}

/// `AUTO_UPDATE_WAITING`.
pub const AUTO_UPDATE_WAITING: &str =
    "Auto update is on: Milagre restarts by itself once no Chat or Routine is running and the Mac sits unused.";

/// One `UpdateNotice` presentation (`presentation` in the component): which version the card opened for, whether it
/// is open, and whether it was dismissed to Settings.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Presentation {
    pub version: String,
    pub open: bool,
    pub dismissed: bool,
}

impl Presentation {
    /// A downloaded update, or a failed one that names a version, opens its card once per version.
    pub fn observe(&mut self, state: &AppUpdate) -> bool {
        let opens = state.ready() || (state.failed() && !state.version_str().is_empty());
        if opens && self.version != state.version_str() {
            *self = Presentation { version: state.version_str().to_string(), open: true, dismissed: false };
            return true;
        }
        false
    }

    /// The card is open: asked for, or the update is installing (it cannot be closed then).
    pub fn is_open(&self, state: &AppUpdate) -> bool {
        self.open || state.installing()
    }

    /// Whether the notice draws at all, as a pill or as the card.
    pub fn visible(&self, state: &AppUpdate) -> bool {
        let open = self.is_open(state);
        if !open && !state.ready() && !state.installing() && !state.downloading() && !state.failed() {
            return false;
        }
        if self.dismissed && !open && !state.installing() {
            return false;
        }
        !matches!(state.status, UpdateStatus::Idle | UpdateStatus::Unavailable)
    }
}

/// `ProviderUpdate`: a newer CLI of a provider on this computer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderUpdate {
    pub provider: Provider,
    pub version: String,
}

impl ProviderUpdate {
    /// `provider:version`, the key a dismissal is kept under.
    pub fn key(&self) -> String {
        format!("{}:{}", self.provider.id(), self.version)
    }
}

/// `hostConnection` (`runtime:connection`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostConnection {
    pub connected: bool,
    /// A restart of the host was tried and failed.
    pub failed: bool,
    pub host_outdated: bool,
    pub message: Option<String>,
}

impl HostConnection {
    pub fn online() -> Self {
        Self { connected: true, failed: false, host_outdated: false, message: None }
    }
}

/// `UnsavedScope`: a Project whose changes did not reach the disk.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnsavedScope {
    pub scope: String,
    pub name: String,
    /// `persistenceFailureDetail`'s input.
    pub error: String,
    pub code: Option<String>,
    pub saving: bool,
    /// The computer holding it is disconnected.
    pub offline: bool,
}

impl UnsavedScope {
    /// The third line of the card: what to do, from the shared copy.
    pub fn detail(&self) -> String {
        crate::logic::copy::model_copy::persistence_failure_detail(&crate::logic::copy::model_copy::PersistenceFailure {
            error: self.error.clone(),
            code: self.code.clone(),
        })
    }
}

pub const HOST_OUTDATED_DEFAULT: &str = "Restart Milagre's background host to load large projects.";

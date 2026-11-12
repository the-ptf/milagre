//! Additive dedicated-runtime authority. The caller supplies selection, never a socket.
use crate::{launcher, Client, ClientOptions, FixtureEndpoint, Hello, Notifications, Result};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

/// Diagnostics for the exact child owned by this guard. Paths do not mint authority.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OwnedChatInfo {
    pub pid: u32,
    pub project: PathBuf,
    pub data_root: PathBuf,
    pub profile: PathBuf,
    pub socket: PathBuf,
    pub launch_root: PathBuf,
    pub model: String,
    pub account_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OwnedChatCleanup {
    pub temporary: launcher::Cleanup,
    pub data_root: PathBuf,
    pub data_retained: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OwnedChatShutdown {
    Complete(OwnedChatCleanup),
    Pending {
        stop_acknowledged: bool,
        reason: Option<String>,
    },
    Unknown {
        reason: String,
    },
}

/// Owns one fixed-sibling `chat-runtime`, not an independently running daemon.
/// Its private lifecycle worker retains the child and storage on uncertain cleanup.
///
/// ```compile_fail
/// use milagre_daemon_client::OwnedChatGuard;
/// let guard = OwnedChatGuard::from_socket("/tmp/daemon.sock");
/// ```
pub struct OwnedChatGuard {
    pub(crate) authority: Arc<crate::Authority>,
    pub(crate) info: OwnedChatInfo,
    pub(crate) selection: Arc<launcher::owned_chat_launch::Selection>,
}

impl OwnedChatGuard {
    /// Create only a nonexistent dedicated root, with a private explicit launch JSON.
    /// The captured selection is persisted by the runtime. No account is discovered.
    pub async fn create(new_root: &Path, private_launch_manifest: &Path) -> Result<Self> {
        launcher::owned_chat_launch::launch(new_root, Some(private_launch_manifest)).await
    }

    /// Open an existing marked root using its captured account/model configuration.
    pub async fn open(marked_root: &Path) -> Result<Self> {
        launcher::owned_chat_launch::launch(marked_root, None).await
    }

    /// Mint actions only for this exact guard and connection. It retains no Client.
    pub fn chat_actions(&self, client: &Client) -> Result<crate::ChatActions> {
        client.owned_actions_for(&self.authority, &self.info.model)
    }

    /// The same dedicated owner, exact connection, and explicit Project view.
    /// Terminal actions neither create another PTY service nor keep a Client alive.
    pub fn terminal_actions(&self, client: &Client) -> Result<crate::TerminalActions> {
        client.owned_terminals_for(&self.authority)
    }

    /// Read Git state only in this exact connection's captured dedicated Project.
    pub fn git_reads(&self, client: &Client) -> Result<crate::GitReads> {
        client.owned_git_for(&self.authority)
    }
    /// Separate remote-read capability, available only when the backend launch
    /// explicitly grants a GitHub selection. It retains no Client or owner.
    pub fn pr_details(&self, client: &Client) -> Result<crate::PrDetailsReads> {
        client.owned_pr_details_for(&self.authority)
    }

    /// Bounded metadata actions for this exact connection; frontend pins stay local.
    pub fn sidebar_actions(&self, client: &Client) -> Result<crate::SidebarActions> {
        client.owned_sidebar_for(&self.authority)
    }

    pub fn info(&self) -> &OwnedChatInfo {
        &self.info
    }
    pub fn project(&self) -> &str {
        &self.authority.project
    }

    /// Explicit connection/reconnection to this same child. Never launches or attaches.
    pub async fn connect(&self, options: ClientOptions) -> Result<(Client, Hello, Notifications)> {
        Client::connect(
            FixtureEndpoint {
                authority: self.authority.clone(),
            },
            options,
        )
        .await
    }

    /// Bounded cleanup observation. Persistent data is never removed by this client.
    /// Pending/Unknown do not release the child or permit a replacement owner.
    pub async fn shutdown(&self) -> Result<OwnedChatShutdown> {
        let result = self
            .authority
            .launcher
            .as_ref()
            .expect("owned launcher")
            .shutdown()
            .await?;
        Ok(match result {
            launcher::ShutdownReport::Complete(temporary) => {
                OwnedChatShutdown::Complete(OwnedChatCleanup {
                    temporary,
                    data_root: self.info.data_root.clone(),
                    data_retained: self.selection.check().is_ok(),
                })
            }
            launcher::ShutdownReport::Pending {
                stop_acknowledged,
                reason,
            } => OwnedChatShutdown::Pending {
                stop_acknowledged,
                reason,
            },
            launcher::ShutdownReport::Unknown { reason } => OwnedChatShutdown::Unknown { reason },
        })
    }
}

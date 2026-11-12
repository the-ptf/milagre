//! Read facade for one explicitly owned app fixture. No Tauri, GPUI or caller runtime.
//!
//! [`FixtureGuard::launch`] owns the fixed sibling `app-fixture` on macOS and is
//! the public fixture source of endpoint authority. The off-by-default `owned-chat`
//! feature adds an independently owned persistent dedicated Chat runtime. There is
//! no arbitrary runtime executable or socket constructor. The launcher and protocol have isolated real-daemon and
//! Unix-pair tests, including bounded oversized Project-state hydration. App adoption
//! remains separate.
#![cfg(unix)]

mod client;
mod launcher;
mod notify;
#[cfg(feature = "owned-chat")]
mod owned_chat;
mod protocol;
mod reply;

use serde_json::Value;
use std::{collections::BTreeSet, os::unix::net::UnixStream, sync::Arc, time::Duration};

#[cfg(feature = "owned-chat")]
pub use client::chat_actions::{
    ChatActions, PermissionDecision, PermissionMode, QuestionAnswers, ReplyStyle, SendOptions,
    SendTarget,
};
#[cfg(feature = "owned-chat")]
pub use client::git_reads::{
    GitDiffFileOptions, GitDiffMode, GitDiffOptions, GitHistoryOptions, GitReads,
};
#[cfg(feature = "owned-chat")]
pub use client::sidebar_actions::SidebarActions;
#[cfg(feature = "owned-chat")]
pub use client::terminal_actions::{TerminalActions, TerminalSize};
pub use client::{Client, ScriptedActions};
pub use launcher::{Cleanup, FixtureInfo, ShutdownReport};
pub use notify::Notifications;
#[cfg(feature = "owned-chat")]
pub use owned_chat::{OwnedChatCleanup, OwnedChatGuard, OwnedChatInfo, OwnedChatShutdown};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Debug, PartialEq)]
pub enum Error {
    Disconnected,
    Cancelled,
    Busy,
    TimedOut {
        submitted: bool,
    },
    InvalidScope,
    #[cfg(feature = "owned-chat")]
    ViewNotOpened,
    InvalidInput {
        field: &'static str,
        message: &'static str,
    },
    StaleSnapshot,
    StateTooLarge {
        hydration: Option<Hydration>,
    },
    Capability {
        required: String,
    },
    Protocol {
        message: String,
    },
    Launch {
        code: &'static str,
        message: String,
    },
    Remote {
        code: String,
        message: String,
        payload: Value,
    },
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Remote { code, message, .. } => write!(f, "{code}: {message}"),
            Self::Protocol { message } => f.write_str(message),
            other => write!(f, "{other:?}"),
        }
    }
}
impl std::error::Error for Error {}
fn protocol(message: impl Into<String>) -> Error {
    Error::Protocol {
        message: message.into(),
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Hydration {
    pub scope: String,
    pub method: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Hello {
    pub wire: u32,
    pub capabilities: BTreeSet<String>,
    /// Verified daemon status. This is diagnostic metadata, never launch authority.
    pub owner: Value,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Notice {
    Event {
        wire_seq: u64,
        scope: Option<String>,
        channel: String,
        /// Oversized state is a current deferred read, not historical at `wire_seq`.
        payload: Value,
    },
    Closed(Error),
}

#[derive(Clone, Debug, PartialEq)]
pub struct StateRead {
    pub state: Value,
    pub version: Value,
    pub epoch: Value,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ChatRuns {
    pub runs: Value,
    /// Host run sequence. This is never the global wire event watermark.
    pub seq: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ChatPageOptions {
    pub before: Option<u64>,
    pub turns: Option<u64>,
    pub limit: Option<u64>,
}

/// Raw daemon body preserves all actual chat paging metadata without synthesizing it.
pub type ChatPage = Value;

#[derive(Clone, Debug)]
/// The private receipt cannot be fabricated from public body fields.
/// ```compile_fail
/// use milagre_daemon_client::RuntimeSnapshot;
/// use serde_json::json;
/// let snapshot = RuntimeSnapshot { body: json!({"eventSeq": 10}), event_seq: 10 };
/// ```
pub struct RuntimeSnapshot {
    pub body: Value,
    pub event_seq: u64,
    receipt: SnapshotReceipt,
}
#[derive(Clone, Debug)]
struct SnapshotReceipt {
    connection: u64,
    generation: u64,
    watermark: u64,
}

#[derive(Clone, Debug)]
pub struct ClientOptions {
    pub request_timeout: Duration,
    pub max_frame_bytes: usize,
    pub max_pending: usize,
    pub max_notification_events: usize,
    pub max_notification_bytes: usize,
    pub max_pages: usize,
    pub max_paged_bytes: usize,
}
impl Default for ClientOptions {
    fn default() -> Self {
        Self {
            request_timeout: Duration::from_secs(30),
            max_frame_bytes: 16 * 1024 * 1024,
            max_pending: 32,
            max_notification_events: 1024,
            max_notification_bytes: 16 * 1024 * 1024,
            max_pages: 1024,
            max_paged_bytes: 128 * 1024 * 1024,
        }
    }
}
impl ClientOptions {
    fn validate(&self) -> Result<()> {
        let ceiling = Self::default();
        if self.request_timeout.is_zero() || self.request_timeout > ceiling.request_timeout {
            return Err(protocol("request timeout must be within 1ns..=30s"));
        }
        for (value, max) in [
            (self.max_frame_bytes, ceiling.max_frame_bytes),
            (self.max_pending, ceiling.max_pending),
            (
                self.max_notification_events,
                ceiling.max_notification_events,
            ),
            (self.max_notification_bytes, ceiling.max_notification_bytes),
            (self.max_pages, ceiling.max_pages),
            (self.max_paged_bytes, ceiling.max_paged_bytes),
        ] {
            if value == 0 || value > max {
                return Err(protocol(
                    "client bounds must be positive and cannot exceed defaults",
                ));
            }
        }
        Ok(())
    }
}

struct Authority {
    project: String,
    pid: u32,
    // Private even to external fixture callers. No path, callback or stream constructor is exposed.
    connect: Box<dyn Fn() -> Result<UnixStream> + Send + Sync>,
    launcher: Option<Arc<launcher::Handle>>,
}

/// Retains the exact launched child and generated storage through its lifecycle worker.
/// Only [`Self::launch`] can create public authority; paths are never credentials.
///
/// Arbitrary profile adoption is deliberately unavailable:
/// ```compile_fail
/// use milagre_daemon_client::FixtureGuard;
/// let guard = FixtureGuard::from_path("/tmp/some-profile");
/// ```
pub struct FixtureGuard {
    authority: Arc<Authority>,
}
impl FixtureGuard {
    /// Explicit fixture-only write capability for this exact Client connection.
    /// It opens no view, keeps no Client alive, and cannot target a live provider.
    pub fn scripted_actions(&self, client: &Client) -> Result<ScriptedActions> {
        client.scripted_actions_for(&self.authority)
    }
    /// Spawn only the owned `app-fixture` beside this executable. No path or environment override.
    pub async fn launch() -> Result<Self> {
        launcher::launch(false).await
    }
    /// Fresh fixed fixture with three scripted turns already completed across two Chats.
    /// No caller transcript, command, path or environment can be supplied.
    pub async fn launch_populated() -> Result<Self> {
        launcher::launch(true).await
    }
    pub fn info(&self) -> Option<&FixtureInfo> {
        self.authority.launcher.as_ref().map(|handle| &handle.info)
    }
    /// Bounded wait, not a force-stop. Pending/Unknown retain child and storage ownership.
    pub async fn shutdown(&self) -> Result<ShutdownReport> {
        self.authority
            .launcher
            .as_ref()
            .ok_or_else(|| Error::Capability {
                required: "owned-fixture-launcher".into(),
            })?
            .shutdown()
            .await
    }
    /// Mint another endpoint for an explicit reconnect to this same retained fixture.
    pub fn endpoint(&self) -> FixtureEndpoint {
        FixtureEndpoint {
            authority: self.authority.clone(),
        }
    }
    pub fn project(&self) -> &str {
        &self.authority.project
    }
}

/// Opaque, connection input minted only by an owned fixture guard.
///
/// A socket path cannot manufacture authority:
/// ```compile_fail
/// use milagre_daemon_client::FixtureEndpoint;
/// let endpoint = FixtureEndpoint::from_socket("/tmp/daemon.sock");
/// ```
pub struct FixtureEndpoint {
    authority: Arc<Authority>,
}

#[cfg(test)]
mod tests;

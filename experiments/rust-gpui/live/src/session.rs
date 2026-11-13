//! One connection to the owned runtime, in the agreed order: connect, explicit `project:open`, `runtime_snapshot()`,
//! apply it to the reducer, `accept_snapshot`, and only then the Chat actions and the released events.
//!
//! The guard is the only authority: it launches the fixed sibling `chat-runtime` for a dedicated root (`create` a new
//! one with a private launch manifest, or `open` a marked one), never a socket, profile or production data directory.

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context as _, Result};
use milagre_daemon_client::{ChatActions, Client, ClientOptions, Notifications, OwnedChatGuard, OwnedChatShutdown};

use crate::{LiveStore, Reducer};

/// How the runtime is reached: a new dedicated root with its launch manifest, or an existing marked root.
pub enum Root<'a> {
    Create { root: &'a Path, manifest: &'a Path },
    Open { root: &'a Path },
}

pub async fn launch(root: Root<'_>) -> Result<OwnedChatGuard> {
    Ok(match root {
        Root::Create { root, manifest } => OwnedChatGuard::create(root, manifest).await.context("create the dedicated root")?,
        Root::Open { root } => OwnedChatGuard::open(root).await.context("open the dedicated root")?,
    })
}

pub struct Session {
    pub guard: Arc<OwnedChatGuard>,
    pub client: Client,
    pub actions: ChatActions,
    pub store: LiveStore,
    /// Released events, for the controller's pump (taken once).
    pub notifications: Option<Notifications>,
    /// The owned Project's path (its scope key on this computer).
    pub project: String,
    /// Fixed when the root was created: the composer shows it and cannot change it.
    pub model: String,
    pub account_id: String,
    /// The account's label as the root's saved launch configuration names it (the id when it has none).
    pub account_label: String,
    /// The accepted snapshot's global watermark.
    pub event_seq: u64,
    /// The second connection, for terminal reads only (a read long-polls and would hold every call behind it).
    pub reader: Client,
    /// The Changes panel's typed Git reads on the main connection.
    pub git: milagre_daemon_client::GitReads,
    /// The sidebar's Chat metadata writes (rename, Done, Reopen) on the main connection.
    pub sidebar: milagre_daemon_client::SidebarActions,
    /// The Terminal drawer's host on the runtime's PTYs, over both connections.
    pub terminals: Arc<crate::terminals::LiveTerminals>,
}

impl Session {
    pub async fn connect(guard: Arc<OwnedChatGuard>) -> Result<Session> {
        let (client, _hello, notifications) = guard.connect(ClientOptions::default()).await.context("connect")?;
        let project = guard.project().to_owned();
        client.open_view(&project).await.context("project:open")?;
        let snapshot = client.runtime_snapshot().await.context("runtime snapshot")?;
        let mut reducer = Reducer::default();
        if let Err(error) = reducer.apply_snapshot(&snapshot) {
            let body = snapshot.body["projects"].to_string();
            let shown: String = body.chars().take(6000).collect();
            return Err(error.context(format!("apply the snapshot; its projects: {shown}")));
        }
        client.accept_snapshot(&snapshot).await.context("accept the snapshot")?;
        let actions = guard.chat_actions(&client).context("Chat actions")?;
        let sidebar = guard.sidebar_actions(&client).context("sidebar actions")?;
        let git = guard.git_reads(&client).context("Git reads")?;
        // The reader connection goes through the same order on its own: open, snapshot, apply, accept, drained.
        let (reader, _, reader_notices) = guard.connect(ClientOptions::default()).await.context("connect the terminal reader")?;
        reader.open_view(&project).await.context("project:open (terminal reader)")?;
        let reader_snapshot = reader.runtime_snapshot().await.context("runtime snapshot (terminal reader)")?;
        Reducer::default().apply_snapshot(&reader_snapshot).context("apply the reader's snapshot")?;
        reader.accept_snapshot(&reader_snapshot).await.context("accept the reader's snapshot")?;
        std::thread::Builder::new().name("milagre-terminal-reader-notices".into()).spawn(move || {
            // Kept drained (an unread bounded queue would close the connection); the main connection applies them.
            let mut notices = reader_notices;
            while futures::executor::block_on(notices.next()).is_some() {}
        })?;
        let terminals = Arc::new(
            crate::terminals::LiveTerminals::new(
                project.clone(),
                guard.terminal_actions(&client).context("terminal actions")?,
                guard.terminal_actions(&reader).context("terminal reads")?,
                reader.clone(),
            )
            .await,
        );
        let info = guard.info().clone();
        let account_label = saved_label(&info.data_root).unwrap_or_else(|| info.account_id.clone());
        Ok(Session {
            guard,
            client,
            actions,
            store: LiveStore::new(reducer),
            notifications: Some(notifications),
            project,
            model: info.model,
            account_id: info.account_id,
            account_label,
            event_seq: snapshot.event_seq,
            reader,
            terminals,
            sidebar,
            git,
        })
    }
}

/// Stops the owned runtime: `Pending` is observed again until `budget` runs out; `Unknown` is final (no signal, no
/// replacement owner). Blocks the calling thread; the client's futures need no executor.
pub fn shutdown_blocking(guard: &OwnedChatGuard, budget: Duration) -> Result<OwnedChatShutdown> {
    let until = Instant::now() + budget;
    loop {
        let report = futures::executor::block_on(guard.shutdown())?;
        match report {
            OwnedChatShutdown::Pending { .. } if Instant::now() < until => std::thread::sleep(Duration::from_millis(100)),
            other => return Ok(other),
        }
    }
}

/// `Complete` with exit 0, Stop acknowledged, the temporary profile, socket and launch storage removed and the
/// durable data retained.
pub fn clean(report: &OwnedChatShutdown) -> bool {
    matches!(report, OwnedChatShutdown::Complete(cleanup)
        if cleanup.temporary.exit_code == Some(0)
            && cleanup.temporary.stop_acknowledged
            && cleanup.temporary.profile_removed
            && cleanup.temporary.socket_removed
            && cleanup.temporary.launch_storage_removed
            && cleanup.data_retained)
}

/// `launch.accountLabel` from the root's saved launch configuration (nonsecret metadata the runtime wrote).
fn saved_label(root: &Path) -> Option<String> {
    let bytes = std::fs::read(root.join("rust-chat-runtime.json")).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    value["launch"]["accountLabel"].as_str().map(str::to_owned)
}

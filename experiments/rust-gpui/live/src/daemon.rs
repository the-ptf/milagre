//! Node-daemon mode, the Preview's default: the installed Milagre's running daemon (`InstalledOwner`, client feature
//! `installed-owner`), so the window shows and drives the same Chats as the Electron app and paired phones.
//!
//! The daemon is never launched, stopped, signalled or replaced from here, and there is no shutdown: quitting the
//! Preview only closes its own connections.
//!
//! - One live connection (the "primary"): connect, `daemon:snapshot`, apply, accept, then its released events. Its
//!   snapshot holds every Project the daemon has loaded this run, so the sidebar lists all of their Chats from one
//!   reducer. The daemon leaves a state over a quarter frame out of events (`stateTooLarge`) and the client reads it
//!   again only for its own Project, closing the stream for any other; so the primary is the Project whose state is
//!   largest, and a closed stream is followed by a new [`Daemon::sync`].
//! - No `project:open` for reads (on the Node daemon it registers the Project, moves it to the top of the recent list
//!   and focuses it). Transcripts of other Projects are read on a short connection of that Project, closed after.
//! - Writes ([`Daemon::writer`]): a short connection of the Chat's Project, `project:open` (which the client requires
//!   before any action), the action, then closed. Refused in read-only mode (`--snapshot`, checks).
//! - Projects the daemon knows but has not loaded this run are not listed: their first `project:read` makes the daemon
//!   resume interrupted Chats and sweep Routine Chats, work Electron itself has not asked for.
//!
//! `DAEMON_UNAVAILABLE` (Milagre not running) and `INSTALLED_OWNER_CHANGED` (it restarted) are retried: adoption runs
//! again on every sync and once more on a refused connection.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyhow::{Context as _, Result, anyhow};
use milagre_daemon_client::{
    ChatActions, Client, ClientOptions, Error, GitReads, InstalledOwner, InstalledProject, KnownProject, Notifications, SidebarActions,
    TerminalActions,
};

use crate::Reducer;

pub const UNAVAILABLE: &str = "DAEMON_UNAVAILABLE";
pub const CHANGED: &str = "INSTALLED_OWNER_CHANGED";

/// What the window says while there is no daemon to adopt.
pub const OPEN_MILAGRE_FIRST: &str = "Open Milagre first: this window connects to its daemon as soon as it runs.";

/// The client's typed launch code of `error`, anywhere in its chain.
pub fn code(error: &anyhow::Error) -> Option<&'static str> {
    error.chain().find_map(|cause| match cause.downcast_ref::<Error>() {
        Some(Error::Launch { code, .. }) => Some(*code),
        _ => None,
    })
}

/// Whether the daemon is not there (not running, or its socket went away).
pub fn unavailable(error: &anyhow::Error) -> bool {
    code(error) == Some(UNAVAILABLE) || error.chain().any(|cause| matches!(cause.downcast_ref::<Error>(), Some(Error::Disconnected)))
}

#[derive(Default)]
struct State {
    owner: Option<Arc<InstalledOwner>>,
    known: Vec<KnownProject>,
    /// The live connection's Project and Client.
    primary: Option<(String, Client)>,
    /// The Project the last sync chose (largest state), tried first next time.
    preferred: Option<String>,
}

pub struct Daemon {
    /// `None`: the installed Milagre (`~/Library/Application Support/Milagre`); tests pass a throwaway data folder.
    profile: Option<PathBuf>,
    read_only: bool,
    state: Mutex<State>,
}

/// A new primary connection, applied and accepted.
pub struct Synced {
    pub reducer: Reducer,
    pub notifications: Notifications,
    pub project: String,
    pub pid: u32,
    pub version: String,
}

impl Daemon {
    pub fn new(profile: Option<PathBuf>, read_only: bool) -> Arc<Self> {
        Arc::new(Self { profile, read_only, state: Mutex::new(State::default()) })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Nothing is written to the daemon: no `project:open`, action, terminal or Git read.
    pub fn read_only(&self) -> bool {
        self.read_only
    }

    /// The adopted daemon's PID.
    pub fn pid(&self) -> Option<u32> {
        self.lock().owner.as_ref().map(|owner| owner.info().pid)
    }

    /// The daemon's known Projects (`project:known`), most recently opened first, as of the last sync.
    pub fn known(&self) -> Vec<KnownProject> {
        self.lock().known.clone()
    }

    /// The live connection's Project and Client.
    pub fn primary(&self) -> Option<(String, Client)> {
        self.lock().primary.clone()
    }

    async fn adopt(&self) -> Result<Arc<InstalledOwner>> {
        let owner = match &self.profile {
            Some(profile) => InstalledOwner::adopt_profile(profile).await,
            None => InstalledOwner::adopt().await,
        }
        .context("adopt Milagre's daemon")?;
        let owner = Arc::new(owner);
        self.lock().owner = Some(owner.clone());
        Ok(owner)
    }

    async fn owner(&self) -> Result<Arc<InstalledOwner>> {
        let held = self.lock().owner.clone();
        match held {
            Some(owner) => Ok(owner),
            None => self.adopt().await,
        }
    }

    /// A new connection to `project`, adopting the daemon again once when it restarted.
    pub async fn connect(&self, project: &str) -> Result<(Client, InstalledProject, Notifications)> {
        for attempt in 0..2 {
            let owner = self.owner().await?;
            let installed = owner.project(project).with_context(|| format!("the Project {project}"))?;
            match installed.connect(ClientOptions::default()).await {
                Ok((client, _hello, notifications)) => return Ok((client, installed, notifications)),
                Err(error) if attempt == 0 && matches!(&error, Error::Launch { code: CHANGED, .. } | Error::Disconnected) => {
                    self.lock().owner = None;
                }
                Err(error) => return Err(anyhow::Error::new(error).context(format!("connect to Milagre's daemon for {project}"))),
            }
        }
        unreachable!("the second attempt returns")
    }

    /// A client of `project` for reads: the live one when it is that Project's, else a short connection (closed when
    /// the returned guard drops). Opens no view.
    pub async fn reader(&self, project: &str) -> Result<Lease> {
        if let Some((primary, client)) = self.primary()
            && primary == project
        {
            return Ok(Lease { client, short: None });
        }
        let (client, _, notifications) = self.connect(project).await?;
        Ok(Lease { client: client.clone(), short: Some((client, notifications)) })
    }

    /// A short write connection of `project`: connected and its view opened (`project:open`), closed when dropped.
    pub async fn writer(&self, project: &str) -> Result<Writer> {
        if self.read_only {
            return Err(anyhow!("Read-only: nothing is written to Milagre's daemon in this mode"));
        }
        let (client, installed, notifications) = self.connect(project).await?;
        let writer = Writer { client, installed, _notifications: Some(notifications) };
        writer.client.open_view(project).await.with_context(|| format!("project:open {project}"))?;
        Ok(writer)
    }

    /// A write connection of `project` that stays open (the Terminal drawer's): its view opened, a snapshot taken and
    /// accepted only to release events, and its events drained on a thread of its own (an unread queue would close
    /// it). It still closes when another Project's oversized state arrives; the drawer then says the Terminal stopped.
    pub async fn lasting_writer(&self, project: &str) -> Result<Writer> {
        let mut writer = self.writer(project).await?;
        let snapshot = writer.client.runtime_snapshot().await.context("daemon:snapshot (terminal connection)")?;
        writer.client.accept_snapshot(&snapshot).await.context("accept (terminal connection)")?;
        drop(snapshot);
        let mut notices = writer._notifications.take().expect("a new writer's notifications");
        std::thread::Builder::new()
            .name("milagre-daemon-terminal-notices".into())
            .spawn(move || while futures::executor::block_on(notices.next()).is_some() {})?;
        Ok(writer)
    }

    /// Adopts the daemon (again), lists its Projects and makes a new primary connection: snapshot, apply, accept. The
    /// old primary connection is closed first.
    pub async fn sync(&self) -> Result<Synced> {
        let old = self.lock().primary.take();
        if let Some((_, client)) = old {
            client.disconnect();
        }
        let owner = self.adopt().await?;
        let known = owner.known_projects().await.context("project:known")?;
        let first = {
            let mut state = self.lock();
            state.known = known.clone();
            state.preferred.clone().filter(|p| known.iter().any(|k| &k.path == p))
        };
        let first = first.or_else(|| known.first().map(|k| k.path.clone())).ok_or_else(|| anyhow!("Milagre has no Projects yet"))?;
        let (mut project, (mut client, mut notifications, mut snapshot)) = (first.clone(), self.snapshot(&first).await?);
        // The largest state can only stream on its own Project's connection (see the module doc).
        if let Some(largest) = largest(&snapshot.body)
            && largest != project
            && known.iter().any(|k| k.path == largest)
        {
            client.disconnect();
            project = largest;
            (client, notifications, snapshot) = self.snapshot(&project).await?;
        }
        let mut reducer = Reducer::default();
        reducer.apply_snapshot(&snapshot).context("apply the daemon's snapshot")?;
        client.accept_snapshot(&snapshot).await.context("accept the daemon's snapshot")?;
        let (pid, version) = (owner.info().pid, owner.info().version.clone());
        let mut state = self.lock();
        state.preferred = Some(project.clone());
        state.primary = Some((project.clone(), client));
        Ok(Synced { reducer, notifications, project, pid, version })
    }

    async fn snapshot(&self, project: &str) -> Result<(Client, Notifications, milagre_daemon_client::RuntimeSnapshot)> {
        let (client, _, notifications) = self.connect(project).await?;
        match client.runtime_snapshot().await {
            Ok(snapshot) => Ok((client, notifications, snapshot)),
            Err(error) => {
                client.disconnect();
                Err(anyhow::Error::new(error).context("daemon:snapshot"))
            }
        }
    }

    /// Closes every connection this window holds. The daemon keeps running.
    pub fn disconnect(&self) {
        if let Some((_, client)) = self.lock().primary.take() {
            client.disconnect();
        }
    }
}

/// The Project whose state is largest in a snapshot body (serialized size).
fn largest(body: &serde_json::Value) -> Option<String> {
    body["projects"]
        .as_array()?
        .iter()
        .filter_map(|p| Some((p["path"].as_str()?.to_owned(), serde_json::to_string(&p["state"]).map_or(0, |s| s.len()))))
        .max_by_key(|(_, size)| *size)
        .map(|(path, _)| path)
}

/// A read client: the live connection (left open) or a short one (closed on drop).
pub struct Lease {
    pub client: Client,
    short: Option<(Client, Notifications)>,
}

impl Drop for Lease {
    fn drop(&mut self) {
        if let Some((client, _)) = &self.short {
            client.disconnect();
        }
    }
}

/// A short write connection with its view open. Closed on drop.
pub struct Writer {
    pub client: Client,
    installed: InstalledProject,
    _notifications: Option<Notifications>,
}

impl Writer {
    /// Chat actions for a Chat on `provider` with `model` (`claude`, `codex`, `antigravity` or `kiro`).
    pub fn chat_actions(&self, provider: &str, model: &str) -> Result<ChatActions> {
        self.installed.chat_actions(&self.client, provider, model).context("Chat actions")
    }

    pub fn sidebar(&self) -> Result<SidebarActions> {
        self.installed.sidebar_actions(&self.client).context("sidebar actions")
    }

    pub fn git(&self) -> Result<GitReads> {
        self.installed.git_reads(&self.client).context("Git reads")
    }

    pub fn terminals(&self) -> Result<TerminalActions> {
        self.installed.terminal_actions(&self.client).context("terminal actions")
    }
}

impl Drop for Writer {
    fn drop(&mut self) {
        self.client.disconnect();
    }
}

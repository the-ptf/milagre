//! Node-daemon mode, the Preview's default: the installed Milagre's running daemon (`InstalledOwner`, client feature
//! `installed-owner`), so the window shows and drives the same Chats as the Electron app and paired phones.
//!
//! With Milagre.app closed, the Preview starts that app's own daemon ([`Start::Installed`]: `InstalledOwner::
//! adopt_or_start` with `DaemonLaunch::find_installed_app`, the app's executable in Node mode, detached, in its own
//! session), so it runs without Electron. A running daemon is only adopted: never stopped, signalled or replaced,
//! whatever its version, and there is no shutdown: quitting the Preview only closes its own connections and leaves
//! the daemon (started here or not) running. A read-only window ([`Daemon::read_only`]) never starts one. Without
//! Milagre.app the window says [`INSTALL_MILAGRE`] and still adopts a daemon that runs anyway.
//!
//! - One live connection (the "primary"): connect, `daemon:snapshot`, apply, accept, then its released events. Its
//!   snapshot holds every Project the daemon has loaded this run, so the sidebar lists all of their Chats from one
//!   reducer. The daemon leaves a state over a quarter frame out of events (`stateTooLarge`) and the client reads it
//!   again only for its own Project, closing the stream for any other; so the primary is the Project whose state is
//!   largest, and a closed stream is followed by a new [`Daemon::sync`].
//! - Never `project:open` (on the Node daemon it registers the Project, moves it to the top of the recent list and
//!   focuses it). Every other connection is request-only (`Notifications::discard`: events dropped, no
//!   `daemon:snapshot`) and loads its Project with `Client::load_view` (`project:read [path, {state:false}]`, the read
//!   Electron's every-Project sidebar makes), which the client requires before any action.
//! - Transcripts of other Projects are read on a short request-only connection of that Project, closed after.
//! - Writes ([`Daemon::writer`]): a short request-only connection of the Chat's Project, `load_view`, the action,
//!   then closed. Refused in read-only mode (`--snapshot`, checks). Git reads use the same kind of connection; a
//!   Terminal keeps one open for its reads and writes.
//! - Projects the daemon knows but has not loaded this run get no rows, as in Electron's sidebar: their first
//!   `project:read` makes the daemon reconcile Worktrees and resume Chats a quit stopped, exactly as opening them in
//!   Electron does, so one loads ([`Daemon::load`]) only when the person opens it on purpose, never in the background
//!   and never in read-only mode.
//!
//! `DAEMON_UNAVAILABLE` (Milagre not running) and `INSTALLED_OWNER_CHANGED` (it restarted) are retried: adoption runs
//! again on every sync and once more on a refused connection.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyhow::{Context as _, Result, anyhow};
use milagre_daemon_client::{
    ChatActions, Client, ClientOptions, DaemonLaunch, Error, GitReads, InstalledOwner, InstalledProject, KnownProject, Notifications,
    SidebarActions, TerminalActions,
};

use crate::Reducer;

pub const UNAVAILABLE: &str = "DAEMON_UNAVAILABLE";
pub const CHANGED: &str = "INSTALLED_OWNER_CHANGED";

/// What the window says while there is no daemon to adopt (read-only windows, which never start one).
pub const OPEN_MILAGRE_FIRST: &str = "Open Milagre first: this window connects to its daemon as soon as it runs.";

/// What the window says while Milagre has no Projects (a new install): Add Project in the sidebar makes the first.
pub const NO_PROJECTS: &str = "No Projects yet: add one with Add Project.";

/// Milagre's daemon runs but knows no Project yet (nothing to connect a live stream through).
#[derive(Debug)]
pub struct NoProjects;

impl std::fmt::Display for NoProjects {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Milagre has no Projects yet")
    }
}

impl std::error::Error for NoProjects {}

/// Whether a sync failed only because there is no Project yet.
pub fn no_projects(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| cause.downcast_ref::<NoProjects>().is_some())
}

/// What the window says when there is no daemon and no Milagre.app to start one from.
pub const INSTALL_MILAGRE: &str = "Install Milagre to use this preview: it runs on Milagre's daemon, which this window starts.";

/// Whether and how the Preview starts Milagre's daemon when none runs.
#[derive(Clone, Debug)]
pub enum Start {
    /// Adopt only (read-only windows, tests that need no start).
    Never,
    /// Start the installed Milagre.app's daemon in Node mode (or a test's launch) when none runs.
    Installed(DaemonLaunch),
    /// Milagre.app is not installed (why): adopt only, and say [`INSTALL_MILAGRE`] while there is no daemon.
    Missing(String),
}

impl Start {
    /// The installed Milagre.app, found as the client finds it (`/Applications`, then `~/Applications`).
    pub fn installed_app() -> Start {
        match DaemonLaunch::find_installed_app() {
            Ok(launch) => Start::Installed(launch),
            Err(error) => Start::Missing(error.to_string()),
        }
    }
}

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
    /// The plan usage the sidebar shows: the last `usage:cached` read ([`crate::usage`]).
    usage: milagre_gpui_spike::data::UsageSnapshot,
    /// Paired computers, only while the computer vault is unlocked ([`crate::computers`]).
    computers: Option<milagre_gpui_spike::data::ComputersSnapshot>,
    /// Paired computers' Projects, states and runs, read through `computers:invoke` ([`crate::computers::Remote`]).
    remote: std::collections::HashMap<String, crate::computers::Remote>,
    /// The computers' own request-only connection (Electron's `computers-lane.cjs`): `computers:invoke` holds its
    /// request until the computer answers, so it never takes the window's request slots.
    lane: Option<(Client, std::sync::Arc<InstalledProject>)>,
    /// Each loaded Project's last `pull-requests:snapshot`, for the sidebar's PR chips and hover cards.
    prs: std::collections::HashMap<String, serde_json::Value>,
}

/// How the computer vault is unlocked: the shared client's `InstalledProject::unlock_computers` (Electron's sealed key
/// from the login Keychain), or a test's stand-in for that Keychain read.
pub type Unlocker = std::sync::Arc<dyn Fn() -> std::result::Result<milagre_daemon_client::ComputerUnlock, (String, String)> + Send + Sync>;

pub struct Daemon {
    /// A stand-in for the Keychain unlock (tests); `None` is the real one.
    unlocker: Mutex<Option<Unlocker>>,
    /// `None`: the installed Milagre (`~/Library/Application Support/Milagre`); tests pass a throwaway data folder.
    profile: Option<PathBuf>,
    read_only: bool,
    start: Start,
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
    /// Adopts only: never starts a daemon ([`Start::Never`]).
    pub fn new(profile: Option<PathBuf>, read_only: bool) -> Arc<Self> {
        Self::starting(profile, read_only, Start::Never)
    }

    /// Adopts, and starts the daemon with `start` when none runs (never in read-only mode).
    pub fn starting(profile: Option<PathBuf>, read_only: bool, start: Start) -> Arc<Self> {
        let start = if read_only { Start::Never } else { start };
        Arc::new(Self { unlocker: Mutex::new(None), profile, read_only, start, state: Mutex::new(State::default()) })
    }

    /// Tests: unlock with `unlocker` instead of the login Keychain.
    pub fn set_unlocker(&self, unlocker: Unlocker) {
        *self.unlocker.lock().unwrap_or_else(|p| p.into_inner()) = Some(unlocker);
    }

    /// `computers:vault-status` (the client's typed read) on a short request-only connection of `project`.
    pub async fn vault_status(&self, project: &str) -> Result<serde_json::Value> {
        let (client, installed) = self.request_only(project).await?;
        let status = installed.computers_vault_status(&client).await.context("computers:vault-status");
        client.disconnect();
        status
    }

    /// Unlocks the computer vault where Electron does (launch, every adoption, before `computers:add`, on
    /// `computers:set-enabled(true)`): only when `computers:vault-status` says it is locked, and never in read-only
    /// mode. `VAULT_KEY_MISSING` never writes a key; `KEYCHAIN_UNAVAILABLE` means the Keychain read was refused.
    pub async fn unlock_computers(&self, project: &str) -> Result<crate::computers::Unlock> {
        use crate::computers::Unlock;
        let (client, installed) = self.request_only(project).await?;
        let result = async {
            let status = installed.computers_vault_status(&client).await.context("computers:vault-status")?;
            if status["unlocked"] == true || status["configuredFile"] == true {
                return Ok(Unlock::Done(milagre_daemon_client::ComputerUnlock::AlreadyUnlocked));
            }
            if self.read_only {
                return Ok(Unlock::Locked);
            }
            let seam = self.unlocker.lock().unwrap_or_else(|p| p.into_inner()).clone();
            let outcome = match seam {
                Some(unlock) => unlock(),
                None => installed.unlock_computers(&client).await.map_err(|error| match &error {
                    Error::Launch { code, message } => ((*code).to_owned(), message.clone()),
                    other => (String::new(), other.to_string()),
                }),
            };
            Ok(match outcome {
                Ok(done) => Unlock::Done(done),
                Err((code, message)) => Unlock::Failed { code, message },
            })
        }
        .await;
        client.disconnect();
        result
    }

    /// `computers:invoke [id, method, args]` on the computers' own lane connection, opened on first use (and again
    /// after it fails).
    pub async fn invoke(&self, id: &str, method: &str, args: serde_json::Value) -> Result<serde_json::Value> {
        let lane = self.lock().lane.clone();
        let (client, installed) = match lane {
            Some(lane) => lane,
            None => {
                let project = self.primary().map(|(p, _)| p).or_else(|| self.known().first().map(|k| k.path.clone()));
                let project = project.ok_or_else(|| anyhow!("no Project to open the computers' connection on"))?;
                let (client, installed) = self.request_only(&project).await?;
                let lane = (client, std::sync::Arc::new(installed));
                self.lock().lane = Some(lane.clone());
                lane
            }
        };
        let answer = installed.call(&client, "computers:invoke", serde_json::json!([id, method, args])).await;
        if matches!(answer, Err(Error::Disconnected)) {
            self.lock().lane = None;
        }
        answer.with_context(|| format!("computers:invoke {id} {method}"))
    }

    /// A computers write Electron's window makes (`computers:add`, `computers:set-enabled`, …) on a write connection.
    pub async fn computers_write(&self, method: &str, args: serde_json::Value) -> Result<serde_json::Value> {
        let project = self.primary().map(|(p, _)| p).ok_or_else(|| anyhow!("not connected to Milagre's daemon"))?;
        let writer = self.writer(&project).await?;
        writer.call(method, args).await
    }

    /// A paired computer's last read ([`crate::computers::read_remote`]).
    pub fn remote(&self, id: &str) -> Option<crate::computers::Remote> {
        self.lock().remote.get(id).cloned()
    }

    pub fn set_remote(&self, id: &str, remote: Option<crate::computers::Remote>) {
        let mut state = self.lock();
        match remote {
            Some(remote) => {
                state.remote.insert(id.to_owned(), remote);
            }
            None => {
                state.remote.remove(id);
            }
        }
    }

    /// Milagre.app is missing, so no daemon can be started from here.
    pub fn app_missing(&self) -> bool {
        matches!(self.start, Start::Missing(_))
    }

    /// Whether this window starts the daemon when none runs.
    pub fn starts(&self) -> bool {
        matches!(self.start, Start::Installed(_))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Nothing is written to the daemon, and no Project is loaded: no action, terminal or Git read, no `load_view`.
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

    /// The last `usage:cached` answer (empty before the first), for the sidebar's reloads.
    pub fn usage(&self) -> milagre_gpui_spike::data::UsageSnapshot {
        self.lock().usage.clone()
    }

    pub fn set_usage(&self, usage: milagre_gpui_spike::data::UsageSnapshot) {
        self.lock().usage = usage;
    }

    /// Paired computers while the vault is unlocked; `None` keeps them hidden.
    pub fn computers(&self) -> Option<milagre_gpui_spike::data::ComputersSnapshot> {
        self.lock().computers.clone()
    }

    pub fn set_computers(&self, computers: Option<milagre_gpui_spike::data::ComputersSnapshot>) {
        self.lock().computers = computers;
    }

    /// A Project's last `pull-requests:snapshot` answer (`Null` before the first).
    pub fn prs(&self, project: &str) -> serde_json::Value {
        self.lock().prs.get(project).cloned().unwrap_or_default()
    }

    pub fn set_prs(&self, project: &str, prs: serde_json::Value) {
        self.lock().prs.insert(project.to_owned(), prs);
    }

    /// The live connection's Project and Client.
    pub fn primary(&self) -> Option<(String, Client)> {
        self.lock().primary.clone()
    }

    async fn adopt(&self) -> Result<Arc<InstalledOwner>> {
        let owner = match (&self.start, &self.profile) {
            (Start::Installed(launch), Some(profile)) => {
                InstalledOwner::adopt_or_start_profile(profile, launch).await.context("adopt or start Milagre's daemon")?
            }
            (Start::Installed(launch), None) => InstalledOwner::adopt_or_start(launch).await.context("adopt or start Milagre's daemon")?,
            (_, Some(profile)) => InstalledOwner::adopt_profile(profile).await.context("adopt Milagre's daemon")?,
            (_, None) => InstalledOwner::adopt().await.context("adopt Milagre's daemon")?,
        };
        let owner = Arc::new(owner);
        let mut state = self.lock();
        state.owner = Some(owner.clone());
        // A connection to an earlier daemon is gone with it.
        if let Some((client, _)) = state.lane.take() {
            client.disconnect();
        }
        drop(state);
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

    /// A new request-only connection to `project`: its events are discarded (no `daemon:snapshot` is taken on it).
    async fn request_only(&self, project: &str) -> Result<(Client, InstalledProject)> {
        let (client, installed, notifications) = self.connect(project).await?;
        notifications.discard();
        Ok((client, installed))
    }

    /// A client of `project` for reads: the live one when it is that Project's, else a short request-only connection
    /// (closed when the returned guard drops). Loads nothing.
    pub async fn reader(&self, project: &str) -> Result<Lease> {
        if let Some((primary, client)) = self.primary()
            && primary == project
        {
            return Ok(Lease { client, short: false });
        }
        let (client, _) = self.request_only(project).await?;
        Ok(Lease { client, short: true })
    }

    /// One of [`READS`] (Electron's window's own reads, through the client's `InstalledProject::call`) on a short
    /// request-only connection of `project`, closed after. Loads nothing, writes nothing, so it is allowed in
    /// read-only mode too; anything outside [`READS`] is refused here.
    pub async fn read(&self, project: &str, method: &str, args: serde_json::Value) -> Result<serde_json::Value> {
        if !READS.contains(&method) {
            return Err(anyhow!("{method} is not one of the Preview's reads"));
        }
        let (client, installed) = self.request_only(project).await?;
        let result = installed.call(&client, method, args).await.with_context(|| format!("{method} for {project}"));
        client.disconnect();
        result
    }

    /// Several of [`READS`] in order on one short request-only connection of `project` (a PR's files' patches), each
    /// answer kept apart. Refused whole if any is not one of the reads.
    pub async fn read_many(&self, project: &str, calls: Vec<(&'static str, serde_json::Value)>) -> Result<Vec<Result<serde_json::Value>>> {
        if let Some((method, _)) = calls.iter().find(|(method, _)| !READS.contains(method)) {
            return Err(anyhow!("{method} is not one of the Preview's reads"));
        }
        let (client, installed) = self.request_only(project).await?;
        let mut answers = Vec::with_capacity(calls.len());
        for (method, args) in calls {
            answers.push(installed.call(&client, method, args).await.with_context(|| format!("{method} for {project}")));
        }
        client.disconnect();
        Ok(answers)
    }

    /// A request-only connection of `project` with the Project loaded (`load_view`, never `project:open`), closed
    /// when dropped: the writes', Git reads' and a Terminal's.
    pub async fn writer(&self, project: &str) -> Result<Writer> {
        if self.read_only {
            return Err(anyhow!("Read-only: nothing is written to Milagre's daemon in this mode"));
        }
        let (client, installed) = self.request_only(project).await?;
        let writer = Writer { client, installed };
        writer.client.load_view(project).await.with_context(|| format!("project:read {project}"))?;
        Ok(writer)
    }

    /// Loads an unloaded Project because the person opened it: a request-only connection, `load_view`, closed. The
    /// daemon may reconcile its Worktrees and resume Chats a quit stopped, as when it is opened in Electron. The live
    /// connection's snapshot does not hold it yet, so it is closed ([`Daemon::resync`]) and the next sync lists it.
    /// Refused in read-only mode.
    pub async fn load(&self, project: &str) -> Result<()> {
        if self.read_only {
            return Err(anyhow!("Read-only: no Project is loaded in this mode"));
        }
        if !self.lock().known.iter().any(|known| known.path == project) {
            return Err(anyhow!("{project} is not one of Milagre's Projects"));
        }
        let writer = self.writer(project).await?;
        drop(writer);
        self.resync();
        Ok(())
    }

    /// Closes the live connection: its stream ends and the window syncs again (a new snapshot).
    pub fn resync(&self) {
        if let Some((_, client)) = self.lock().primary.take() {
            client.disconnect();
        }
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
        let first = first.or_else(|| known.first().map(|k| k.path.clone())).ok_or_else(|| anyhow::Error::new(NoProjects))?;
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
        if let Some((client, _)) = self.lock().lane.take() {
            client.disconnect();
        }
    }
}

/// The commands [`Daemon::read`] sends: each only reads (the Node daemon's handlers in `packages/core/src/runtime.cjs`).
pub const READS: &[&str] = &[
    "agent:models",
    "agent:ports",
    "pull-requests:snapshot",
    "accounts:list",
    "usage:cached",
    "usage:accounts:cached",
    "canvas:links",
    "computers:list",
    // The PR panel's reads (`bridge.pr`): `pr:detail` and the labels and reviewers run `gh`; the diffs are local Git.
    "pr:detail",
    "pr:diff-files",
    "pr:diff-file",
    "pr:labels",
    "pr:reviewer-candidates",
    // The usage card's picker and the usage-limit card: a scope's accounts, and whether "Continue at" is offered.
    "accounts:scope",
    "limits:resume-at-reset:read",
    // Settings ([`crate::settings`]): the host-kept settings Electron's Settings reads.
    "app:version",
    "context:settings:read",
    "done:settings:read",
    "linked:remote-enabled:read",
    "device-notes:read",
    "app-update:auto:read",
    "keybindings:read",
    "main-sync:default:read",
    "storage:worktrees",
];

/// The Project whose state is largest in a snapshot body (serialized size).
fn largest(body: &serde_json::Value) -> Option<String> {
    body["projects"]
        .as_array()?
        .iter()
        .filter_map(|p| Some((p["path"].as_str()?.to_owned(), serde_json::to_string(&p["state"]).map_or(0, |s| s.len()))))
        .max_by_key(|(_, size)| *size)
        .map(|(path, _)| path)
}

/// A read client: the live connection (left open) or a short request-only one (closed on drop).
pub struct Lease {
    pub client: Client,
    short: bool,
}

impl Drop for Lease {
    fn drop(&mut self) {
        if self.short {
            self.client.disconnect();
        }
    }
}

/// A request-only connection with its Project loaded. Closed on drop.
pub struct Writer {
    pub client: Client,
    installed: InstalledProject,
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

    /// A command Electron's window sends (`InstalledProject::call`), on this loaded Project's connection: the PR
    /// pill's `chat:send` with its `prAction`, which the daemon checks and words itself.
    pub async fn call(&self, method: &str, args: serde_json::Value) -> Result<serde_json::Value> {
        self.installed.call(&self.client, method, args).await.with_context(|| method.to_owned())
    }

    /// The first recommended model of `provider` in the daemon's catalog for this Project (`agent:models`), for a
    /// Chat with no recorded model. `None` when the catalog recommends none (or has no list for it, as kiro may).
    pub async fn recommended_model(&self, provider: &str) -> Result<Option<String>> {
        let models = self.installed.models(&self.client).await.context("agent:models")?;
        Ok(first_recommended(&models, provider))
    }
}

/// The first `recommended` model id of `provider` in an `agent:models` answer.
pub fn first_recommended(models: &serde_json::Value, provider: &str) -> Option<String> {
    models[provider].as_array()?.iter().find(|m| m["recommended"] == true)?["id"].as_str().map(str::to_owned)
}

impl Drop for Writer {
    fn drop(&mut self) {
        self.client.disconnect();
    }
}

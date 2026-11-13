//! [`LiveController`]: keeps the base crate's views in step with the owned runtime and runs what they ask for.
//!
//! - Reads: the released events go through the bounded reducer ([`LiveStore::pump`]); every new version reloads the
//!   sidebar (`Sidebar::reload`, from [`crate::source::LiveSource`]) and the open Chat's live tail: the streamed reply
//!   (the transcript's own streaming path), the running row, the approval and question cards and the composer's
//!   queue. When the run ends, the Chat's saved messages replace the tail.
//! - Writes: the composer's sink and the sidebar's actions send [`Command`]s; the approval and question cards emit
//!   [`CardDecision`]s. Each becomes one Chat action on this connection: send (a fresh client message id each,
//!   receipts kept), interrupt, respond to a permission (Allow once, Always allow in this Chat → `AllowForChat`, Deny),
//!   answer a question, set the permission mode, send or remove a queued message, mark unread.
//! - A new Project Chat is made by its first send from the empty new-Chat screen; the Chat its receipt names opens.
//! - Attachments (pasted, chosen or dropped images and files) go with `chat:send` on Milagre's daemon; the owned
//!   runtime refuses them.
//! - Not available here, so off or refused: steering (follow-ups queue), compact, Worktree and computer
//!   creation (the sidebar records those calls and sends nothing). On the owned runtime the model is fixed too.
//! - Milagre's daemon: the composer's picker lists the daemon's models (`agent:models`) and an open Chat's chip shows
//!   the model its next send names (picked here, else its last one, else its provider's recommended one); a pick on
//!   an open Chat sticks to it and goes with its next send, which switches or hands off as Electron's picker does.
//!   The side panel's Details tab and the pill row over the composer are built from the reducer's state plus the
//!   daemon's ports and PR poll ([`crate::panels`]).
//!
//! Two backends ([`Backend`]): the owned runtime (one Project, one connection, its model fixed) and Milagre's running
//! Node daemon ([`crate::daemon`], the Preview's default): every Project the daemon has loaded, each Chat on its own
//! provider and model (a Chat with none recorded on its provider's first recommended model, a new Chat on the
//! composer's), each write on a short request-only connection of the Chat's Project (loaded with `load_view`, never
//! `project:open`), and a lost stream (the daemon restarted, quit, or sent another Project's oversized state)
//! followed by a new sync, with "Open Milagre first" while there is no daemon. Projects the daemon knows but has not
//! loaded get no rows (as in Electron); opening one on purpose loads it and syncs again. A daemon that has loaded none
//! (just started, Milagre.app closed) gets its most recently opened Project loaded, as Electron's window opens its
//! current Project on launch; the window shows it "Loading…" meanwhile, and never onboarding. In read-only mode
//! (`--snapshot`) every write, and every load, is refused here, before it reaches a connection.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt as _;
use futures::channel::mpsc::{UnboundedReceiver, UnboundedSender, unbounded};
use gpui::{App, AppContext as _, Context, Entity, Subscription, Task, Window};
use milagre_daemon_client::{ChatActions, Client, GitReads, Notifications, PermissionDecision, SendOptions, SendTarget, SidebarActions};
use milagre_gpui_spike::data::{AgentRun, Data, LOCAL, PageRequest, PermissionMode, Provider, ScopeKey};
use milagre_gpui_spike::workspace::Workspace;
use milagre_gpui_spike::workspace::chat::composer::{ComposerLimits, Delivery};
use milagre_gpui_spike::workspace::chat::running::RunningRow;
use milagre_gpui_spike::workspace::chat::transcript::{ApprovalState, CardDecision, Item};
use milagre_gpui_spike::workspace::preview::PreviewMode;
use milagre_gpui_spike::workspace::sidebar::{Actions, RecordingActions, SidebarEvent, SidebarSeed};
use serde_json::Value;

use crate::LiveStore;
use crate::daemon::Daemon;
use crate::session::Session;
use crate::sinks::{ChatRef, Command, LiveSidebarActions, LiveSink, SinkState, Target, chat_ref, wire_mode};
use crate::source::LiveSource;

/// Where the writes go.
#[derive(Clone)]
pub enum Backend {
    /// The owned runtime: one Project, its connection's actions (model fixed at creation).
    Owned { project: String, client: Client, actions: ChatActions, sidebar: SidebarActions, git: GitReads },
    /// Milagre's running Node daemon.
    Daemon(Arc<Daemon>),
}

type Local<T> = std::pin::Pin<Box<dyn std::future::Future<Output = Result<T, String>>>>;

mod new_chat;

impl Backend {
    /// The one Project a Chat key may name, or `None` for any (the daemon).
    fn only_project(&self) -> Option<&str> {
        match self {
            Backend::Owned { project, .. } => Some(project),
            Backend::Daemon(_) => None,
        }
    }

    fn read_only(&self) -> bool {
        matches!(self, Backend::Daemon(daemon) if daemon.read_only())
    }

    /// Runs `act` on Chat actions for `project` (the daemon: a short write connection, on `provider` and `model`).
    fn with_actions<T: 'static, F: std::future::Future<Output = Result<T, String>> + 'static>(
        &self,
        project: &str,
        model: Option<(Provider, String)>,
        act: impl FnOnce(ChatActions) -> F + 'static,
    ) -> Local<T> {
        match self {
            Backend::Owned { actions, .. } => Box::pin(act(actions.clone())),
            Backend::Daemon(daemon) => {
                let (daemon, project) = (daemon.clone(), project.to_owned());
                Box::pin(async move {
                    let writer = daemon.writer(&project).await.map_err(|e| format!("{e:#}"))?;
                    // Actions other than a send never name a model; any valid pair does for them.
                    let (provider, mut model) = model.unwrap_or((Provider::Claude, "default".into()));
                    // A Chat with no recorded model: its provider's first recommended model in the daemon's catalog.
                    if model.is_empty() {
                        model = writer.recommended_model(provider.id()).await.map_err(|e| format!("{e:#}"))?.ok_or_else(|| {
                            format!("This Chat's model isn't known and Milagre recommends no {} model: nothing was sent", provider.name())
                        })?;
                    }
                    let actions = writer.chat_actions(provider.id(), &model).map_err(|e| format!("{e:#}"))?;
                    let result = act(actions).await;
                    drop(writer);
                    result
                })
            }
        }
    }

    fn with_sidebar<T: 'static, F: std::future::Future<Output = Result<T, String>> + 'static>(
        &self,
        project: &str,
        act: impl FnOnce(SidebarActions) -> F + 'static,
    ) -> Local<T> {
        match self {
            Backend::Owned { sidebar, .. } => Box::pin(act(sidebar.clone())),
            Backend::Daemon(daemon) => {
                let (daemon, project) = (daemon.clone(), project.to_owned());
                Box::pin(async move {
                    let writer = daemon.writer(&project).await.map_err(|e| format!("{e:#}"))?;
                    let sidebar = writer.sidebar().map_err(|e| format!("{e:#}"))?;
                    let result = act(sidebar).await;
                    drop(writer);
                    result
                })
            }
        }
    }

    /// The Project's Changes (the daemon: a short request-only connection that loads the Project first).
    fn read_git(&self, project: &str) -> Local<milagre_gpui_spike::workspace::panel::changes::data::ChangesData> {
        match self {
            Backend::Owned { git, .. } => {
                let git = git.clone();
                Box::pin(async move { crate::git::read(&git).await.map_err(|e| format!("{e:#}")) })
            }
            Backend::Daemon(daemon) => {
                let (daemon, project) = (daemon.clone(), project.to_owned());
                Box::pin(async move {
                    let writer = daemon.writer(&project).await.map_err(|e| format!("{e:#}"))?;
                    let git = writer.git().map_err(|e| format!("{e:#}"))?;
                    let result = crate::git::read(&git).await.map_err(|e| format!("{e:#}"));
                    drop(writer);
                    result
                })
            }
        }
    }
}

/// Runs `work` on a thread of its own and answers on any executor (GPUI's test executor included).
fn off_thread<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> futures::channel::oneshot::Receiver<T> {
    let (sender, receiver) = futures::channel::oneshot::channel();
    std::thread::Builder::new()
        .name("milagre-live-work".into())
        .spawn(move || {
            let _ = sender.send(work());
        })
        .expect("a worker thread");
    receiver
}

/// The daemon's sync (adopt, list, snapshot, apply, accept) off the UI thread: the snapshot can be tens of MB.
async fn sync(daemon: Arc<Daemon>) -> anyhow::Result<crate::daemon::Synced> {
    off_thread(move || futures::executor::block_on(daemon.sync())).await.map_err(|_| anyhow::anyhow!("the sync thread ended"))?
}

/// The Node daemon's part of a live window: its store, its first sync's stream (`None`: no daemon yet) and why not.
pub struct DaemonSession {
    pub daemon: Arc<Daemon>,
    pub store: LiveStore,
    pub notifications: Option<Notifications>,
    /// Why the first sync failed.
    pub error: Option<String>,
    pub terminals: Arc<crate::terminals::LiveTerminals>,
}

impl DaemonSession {
    /// The first sync, before the window opens; a failure (no daemon yet) still opens the window, which retries.
    pub fn start(daemon: Arc<Daemon>) -> DaemonSession {
        let terminals = Arc::new(crate::terminals::LiveTerminals::daemon(daemon.clone()));
        match futures::executor::block_on(daemon.sync()) {
            Ok(synced) => {
                eprintln!("live: Milagre's daemon {} (pid {}), live on {}", synced.version, synced.pid, synced.project);
                DaemonSession {
                    daemon,
                    store: LiveStore::new(synced.reducer),
                    notifications: Some(synced.notifications),
                    error: None,
                    terminals,
                }
            }
            Err(error) => {
                eprintln!("live: no daemon yet: {error:#}");
                let error = Some(notice_for(&daemon, &error));
                DaemonSession { daemon, store: LiveStore::new(crate::Reducer::default()), notifications: None, error, terminals }
            }
        }
    }
}

/// What the sidebar says when a sync failed.
fn notice_for(daemon: &Daemon, error: &anyhow::Error) -> String {
    if crate::daemon::no_projects(error) {
        crate::daemon::NO_PROJECTS.into()
    } else if crate::daemon::unavailable(error) && daemon.app_missing() {
        crate::daemon::DAEMON_MISSING.into()
    } else if daemon.bundled() && matches!(crate::daemon::code(error), Some("DAEMON_START_FAILED" | "DAEMON_START_TIMEOUT" | "UNSAFE_LOG"))
    {
        format!("{} ({error:#})", crate::daemon::BUNDLED_FAILED)
    } else if crate::daemon::unavailable(error) {
        crate::daemon::OPEN_MILAGRE_FIRST.into()
    } else {
        format!("Couldn't reach Milagre's daemon ({error:#}). Retrying.")
    }
}

/// The writes' channel, made before the window so the sidebar's actions exist when it is built.
pub struct Wiring {
    pub commands: UnboundedSender<Command>,
    receiver: UnboundedReceiver<Command>,
    pub recorded: Arc<RecordingActions>,
    /// A Chat's first page read before the window opened (snapshot mode): shown at once instead of read again.
    pub preloaded: Option<(String, milagre_gpui_spike::data::MessagePage)>,
}

/// The app's globals for a live window: `Data` (the live source), the sidebar's actions and its seed (the Chat with
/// the newest activity opens). Call after `app::init` (which installs the fixture) and before opening the window.
pub fn install_globals(session: &Session, cx: &mut App) -> Wiring {
    let (commands, receiver) = unbounded();
    let recorded = Arc::new(RecordingActions::default());
    cx.set_global(Data(Arc::new(LiveSource::new(session.store.clone(), session.client.clone()))));
    cx.set_global(Actions(Arc::new(LiveSidebarActions {
        project: Some(session.project.clone()),
        commands: commands.clone(),
        recorded: recorded.clone(),
    })));
    cx.set_global(SidebarSeed { open_chat: newest_chat(&session.store, Some(&session.project)) });
    // The Terminal drawer opens the runtime's PTYs, not this computer's.
    cx.set_global(milagre_gpui_spike::workspace::panel::terminal::remote::Host(session.terminals.clone()));
    // Everything the runtime does not back is off or labelled (`workspace::preview`).
    cx.set_global(PreviewMode { account: session.account_label.clone().into(), model: session.model.clone().into() });
    Wiring { commands, receiver, recorded, preloaded: None }
}

/// [`install_globals`] for Milagre's daemon: every loaded Project, Routines and the rest off (Preview mode).
pub fn install_daemon_globals(session: &DaemonSession, cx: &mut App) -> Wiring {
    let (commands, receiver) = unbounded();
    let recorded = Arc::new(RecordingActions::default());
    // Pin, Delete, Reload, Filters, Add Project and the other sidebar writes ([`crate::sidebar_writes`]).
    let (writes, hidden) = crate::sidebar_writes::install(session.daemon.read_only(), cx);
    cx.set_global(Data(Arc::new(LiveSource::daemon(session.store.clone(), session.daemon.clone()).with_hidden(hidden))));
    let inner = LiveSidebarActions { project: None, commands: commands.clone(), recorded: recorded.clone() };
    cx.set_global(Actions(Arc::new(crate::sidebar_writes::Router { inner, writes })));
    cx.set_global(SidebarSeed { open_chat: newest_chat(&session.store, None) });
    cx.set_global(milagre_gpui_spike::workspace::panel::terminal::remote::Host(session.terminals.clone()));
    let account = match session.daemon.pid() {
        Some(pid) => format!("Milagre's daemon (pid {pid})"),
        None => "Milagre's daemon".into(),
    };
    let model = if session.daemon.read_only() { "read-only" } else { "each Chat's own model" };
    cx.set_global(PreviewMode { account: account.into(), model: model.into() });
    Wiring { commands, receiver, recorded, preloaded: None }
}

/// The daemon-mode window's startup before it opens, exactly as `main` runs it: Settings' store (the window's
/// `Workspace` would install it only when it opens, after [`crate::prefs::install`] has read the saved Appearance into
/// it), this window's own preferences, then [`install_daemon_globals`]. Call after `app::init`.
/// `electron` is Electron's own `preferences.json`, read once to seed Settings › Notifications.
pub fn install_daemon_app(session: &DaemonSession, prefs: std::path::PathBuf, electron: &std::path::Path, cx: &mut App) -> Wiring {
    if !cx.has_global::<milagre_gpui_spike::settings::SettingsStore>() {
        cx.set_global(milagre_gpui_spike::settings::SettingsStore::default());
    }
    if session.daemon.bundled() {
        cx.global_mut::<milagre_gpui_spike::settings::SettingsStore>().daemon_note = Some(crate::daemon::BUNDLED_NOTE.to_owned());
    }
    crate::prefs::install_with(prefs, electron, session.daemon.read_only(), cx);
    cx.set_global(crate::prefs::ElectronPrefs(electron.to_path_buf()));
    install_daemon_globals(session, cx)
}

/// The listed Chat (it has messages) last active, to open on launch: of `project`, or of any Project.
pub fn newest_chat(store: &LiveStore, project: Option<&str>) -> Option<String> {
    store.read(|reducer| {
        let applied = reducer.state().ok()?;
        applied
            .projects
            .iter()
            .filter(|open| project.is_none_or(|p| open.project.path.as_ref() == p))
            .filter_map(|open| Some((open, open.state.as_ref()?)))
            .flat_map(|(open, state)| {
                state
                    .sessions
                    .values()
                    .filter(|chat| !chat.archived && chat.parent.is_none())
                    .filter(|chat| chat.summary.as_ref().is_some_and(|summary| summary.count > 0))
                    .map(move |chat| {
                        (chat.summary.as_ref().and_then(|summary| summary.last_at).unwrap_or(0), open.project.scope().chat_key(chat.id))
                    })
            })
            .max_by_key(|(at, _)| *at)
            .map(|(_, key)| key)
    })
}

/// The open Chat's live part, past its saved messages.
#[derive(Default)]
struct OpenChat {
    key: String,
    project: String,
    id: u64,
    loaded: bool,
    /// The Chat's message count (its summary) when its messages were read: another count means new saved messages
    /// (a turn this window saw end too fast to stream, or one sent from Milagre or a phone).
    count: Option<usize>,
    /// A run is on screen.
    live: bool,
    /// The streamed reply's item and how much of the run's text it shows (bytes).
    stream: Option<(usize, usize)>,
    /// Approval request id → item.
    approvals: Vec<(String, usize)>,
    /// Question request id → item.
    questions: Vec<(String, usize)>,
    /// The run's activity folds, oldest first: each one's item and the ids of the steps it holds ([`run_folds`]).
    folds: Vec<(usize, Vec<gpui::SharedString>)>,
    /// Steps that have an approval card of their own: they stay out of the folds.
    approval_steps: Vec<gpui::SharedString>,
}

pub struct LiveController {
    workspace: Entity<Workspace>,
    /// The window, to open a Chat without waiting for a frame (a window behind others draws none).
    window: gpui::AnyWindowHandle,
    backend: Backend,
    /// A Git read is in flight; another was asked for meanwhile.
    reading_git: bool,
    git_again: bool,
    /// The Project whose Changes were read last (the daemon reads them per Project, not per Chat).
    git_project: Option<String>,
    store: LiveStore,
    sink: SinkState,
    open: Option<OpenChat>,
    /// A Chat the runtime made for a first send, to open once the sidebar lists it.
    pending_open: Option<String>,
    /// Requests already answered from this window (a programmatic resolve emits a decision too).
    answered: HashSet<String>,
    receipts: Vec<(String, Value)>,
    /// Every permission answer sent: request id and decision.
    decisions: Vec<(String, String)>,
    errors: Vec<String>,
    closed: Option<String>,
    mode: PermissionMode,
    sent: u64,
    /// Writes refused because this window is read-only (none reach a connection).
    refused: Vec<String>,
    /// The sidebar's "Open Milagre first" (or another sync failure) while there is no live connection.
    unavailable: Option<String>,
    syncs: u64,
    /// Projects asked to load (Milagre's daemon) whose Chats have not arrived yet.
    loading: HashSet<String>,
    /// The Project last loaded from its name-only row: its newest Chat opens once it is listed.
    open_loaded: Option<String>,
    preloaded: Option<(String, milagre_gpui_spike::data::MessagePage)>,
    /// Milagre's daemon: a model picked for an open Chat (by Chat key), sent with its next message.
    picked: HashMap<String, (Provider, String)>,
    /// Milagre's daemon: an effort picked for an open Chat (by Chat key).
    picked_effort: HashMap<String, &'static str>,
    /// Milagre's daemon: each Project's `agent:models`, its `pull-requests:snapshot`, and every Chat's ports.
    catalogs: HashMap<String, Value>,
    prs: HashMap<String, Value>,
    ports: Value,
    /// The Project whose catalog the picker shows now.
    catalog_project: Option<String>,
    /// Projects whose reads are in flight, and when each was last read.
    reading_extras: HashSet<String>,
    extras_at: HashMap<String, std::time::Instant>,
    /// The tapped channels received (tests).
    events: Vec<String>,
    /// The last computer-vault read, and the refusal last logged.
    vault: Option<crate::computers::Vault>,
    /// The next computers read unlocks first (launch, every adoption); what the last unlock did.
    unlock_next: bool,
    unlocked: Option<crate::computers::Unlock>,
    /// Paired computers whose Chats changed since their last read, and whether a read is waiting to run.
    remote_dirty: HashSet<String>,
    remote_reading: bool,
    computers_refused: Option<String>,
    /// The Preview's own notifications ([`crate::notify`]), on Milagre's daemon in a writable window.
    notifier: Option<Rc<crate::notify::Notifier>>,
    /// Milagre's daemon: the PR panel's driver ([`crate::pr`]), the PR picked for a Chat (the sidebar's chip), the Chat
    /// whose PR tab opens once it shows, and each Chat's blockers already sent (`updateBlockerDismissals`).
    live_pr: Option<Entity<crate::pr::LivePr>>,
    /// Milagre's daemon: the Designs and Artifact tabs' driver ([`crate::canvas`]), and the tab a snapshot opens on.
    live_canvas: Option<Entity<crate::canvas::LiveCanvas>>,
    canvas_tab: Option<(String, milagre_gpui_spike::workspace::panel::PanelTab)>,
    pr_picks: HashMap<String, u32>,
    pr_tab: Option<String>,
    pr_dismissed: HashMap<String, Vec<String>>,
    /// The PR tab was showing at the last look (the pills follow it).
    pr_shown: bool,
    /// A snapshot opened its Chat with a PR already.
    pr_snapshot_opened: bool,
    /// Milagre's daemon: the accounts writes and the usage-limit card ([`crate::accounts`]).
    accounts: Option<Entity<crate::accounts::LiveAccounts>>,
    /// Ticks the running steps' durations in the live folds once a second while a turn runs.
    fold_clock: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
    _tasks: Vec<Task<()>>,
}

impl LiveController {
    /// Wires a live window on the owned runtime: the composer's sink and limits, the fixed model, the event pump and
    /// the observers.
    pub fn attach(workspace: &Entity<Workspace>, mut session: Session, wiring: Wiring, window: &mut Window, cx: &mut App) -> Entity<Self> {
        let notifications = session.notifications.take().expect("the session's notifications");
        let backend = Backend::Owned {
            project: session.project.clone(),
            client: session.client.clone(),
            actions: session.actions.clone(),
            sidebar: session.sidebar.clone(),
            git: session.git.clone(),
        };
        let model = session.model.clone();
        Self::wire(workspace, backend, session.store.clone(), Stream::Owned(notifications), Some(model), wiring, window, cx)
    }

    /// Wires a live window on Milagre's daemon: as [`Self::attach`], with each Chat's own model, a new Chat's model
    /// from the picker, and a stream that syncs again when it ends.
    pub fn attach_daemon(
        workspace: &Entity<Workspace>,
        session: DaemonSession,
        wiring: Wiring,
        window: &mut Window,
        cx: &mut App,
    ) -> Entity<Self> {
        let DaemonSession { daemon, store, notifications, error, .. } = session;
        let backend = Backend::Daemon(daemon.clone());
        let writes = (daemon.clone(), store.clone());
        let usage_daemon = daemon.clone();
        let controller = Self::wire(workspace, backend, store, Stream::Daemon { daemon, first: notifications }, None, wiring, window, cx);
        crate::sidebar_writes::attach(workspace, writes.0.clone(), writes.1, &controller, cx);
        // The PR panel and the account switcher on the daemon ([`crate::pr`], [`crate::accounts`]).
        let panel = workspace.read(cx).panel.clone();
        let window_handle = controller.read(cx).window;
        let live_pr = cx.new(|cx| crate::pr::LivePr::new(writes.0.clone(), panel.clone(), window_handle, cx));
        let accounts = crate::accounts::LiveAccounts::attach(writes.0.clone(), workspace.clone(), cx);
        controller.update(cx, |c, cx| {
            c._subscriptions.push(cx.observe(&live_pr, |this, _, cx| this.refresh_panels(cx)));
            c._subscriptions.push(cx.observe(&accounts, |this, _, cx| this.refresh_limit_cards(cx)));
            // A tab switch shows or hides the review and Merge pills.
            c._subscriptions.push(cx.observe(&panel, |this, panel, cx| {
                let shown = panel.read(cx).is_open() && panel.read(cx).active() == milagre_gpui_spike::workspace::panel::PanelTab::Pr;
                if this.pr_shown != shown {
                    this.pr_shown = shown;
                    this.refresh_panels(cx);
                }
            }));
            // Evidence snapshots: the Chat with a PR, its PR polls and the PR itself, read before the window opened.
            if let Some(seed) = cx.try_global::<crate::pr::Seed>().cloned() {
                for (project, prs) in &seed.prs {
                    if let Backend::Daemon(daemon) = &c.backend {
                        daemon.set_prs(project, prs.clone());
                    }
                    c.prs.insert(project.clone(), prs.clone());
                }
                c.pr_snapshot_opened = true;
                c.pr_tab = Some(seed.key.clone());
                c.pending_open = Some(seed.key.clone());
                if let Some((cwd, number, answer)) = &seed.detail {
                    live_pr.update(cx, |pr, _| pr.seed(cwd, *number, answer));
                }
            }
            c.live_pr = Some(live_pr);
            // The Designs and Artifact tabs; a snapshot's Chat and its read made before the window opened.
            let canvas = cx.new(|cx| crate::canvas::LiveCanvas::new(writes.0.clone(), panel.clone(), cx));
            if let Some(seed) = cx.try_global::<crate::canvas::Seed>().cloned() {
                canvas.update(cx, |canvas, _| canvas.seed(&seed.key, seed.fetched.clone()));
                c.pending_open = Some(seed.key.clone());
                c.canvas_tab = Some((seed.key.clone(), seed.tab));
            }
            c.live_canvas = Some(canvas);
            let scope = c.open.as_ref().map(|open| open.project.clone());
            accounts.update(cx, |a, cx| a.set_scope(scope, cx));
            c.accounts = Some(accounts);
            c.follow_chat(cx);
            c.refresh_panels(cx);
        });
        // Plan usage (`usage:cached`, read-only) in the sidebar's rows and card, and the limit card under a stopped reply.
        let sidebar = workspace.read(cx).sidebar.clone();
        crate::usage::attach(&sidebar, usage_daemon, cx);
        // Settings' daemon sections ([`crate::settings`]).
        crate::settings::attach(workspace, writes.0.clone(), cx);
        // `milagre://` links opened on this computer ([`crate::deeplinks`]).
        controller.update(cx, |c, cx| {
            let links = cx.spawn(async move |this: gpui::WeakEntity<Self>, cx: &mut gpui::AsyncApp| {
                loop {
                    cx.background_executor().timer(Duration::from_millis(250)).await;
                    for url in crate::deeplinks::take() {
                        if this.update(cx, |this, cx| this.open_link(&url, cx)).is_err() {
                            return;
                        }
                    }
                }
            });
            c._tasks.push(links);
        });
        // Details' Show in Finder and Open in editor, done here (Electron's main process does them; `call()` refuses
        // `editor:open` and `project:reveal`).
        cx.set_global(milagre_gpui_spike::workspace::preview::PreviewOpeners);
        let details = workspace.read(cx).panel.read(cx).details().clone();
        let opener_sidebar = sidebar.clone();
        controller.update(cx, |c, cx| {
            let subscription =
                cx.subscribe(&details, move |_, _, event: &milagre_gpui_spike::workspace::panel::details::DetailsEvent, cx| {
                    if let milagre_gpui_spike::workspace::panel::details::DetailsEvent::Open(request) = event {
                        crate::opener::handle(request, opener_sidebar.clone(), cx);
                    }
                });
            c._subscriptions.push(subscription);
        });
        // This window's own notifications and dock badge (Electron's main process has them); never in read-only mode.
        if !controller.read(cx).backend.read_only() {
            let notifier = Rc::new(crate::notify::Notifier::new(crate::notify::poster(cx), crate::notify::Settings::default()));
            controller.update(cx, |c, cx| c.install_notifier(notifier, cx));
            cx.set_global(milagre_gpui_spike::workspace::preview::PreviewNotifications);
        }
        match error {
            Some(error) => controller.update(cx, |this, cx| this.set_unavailable(Some(error), cx)),
            None => controller.update(cx, |this, cx| this.load_first_when_none_loaded(cx)),
        }
        controller
    }

    #[allow(clippy::too_many_arguments)]
    fn wire(
        workspace: &Entity<Workspace>,
        backend: Backend,
        store: LiveStore,
        stream: Stream,
        fixed_model: Option<String>,
        wiring: Wiring,
        window: &mut Window,
        cx: &mut App,
    ) -> Entity<Self> {
        let Wiring { commands, receiver, preloaded, .. } = wiring;
        let sink = SinkState::default();
        let (chat, sidebar) = workspace.read_with(cx, |w, _| (w.chat.clone(), w.sidebar.clone()));
        let (composer, transcript, pills) = chat.read_with(cx, |c, _| (c.composer.clone(), c.transcript.clone(), c.pills.clone()));
        composer.update(cx, |composer, cx| {
            composer.set_sink(Some(Rc::new(LiveSink { state: sink.clone(), commands: commands.clone() })));
            match &fixed_model {
                Some(model) => {
                    composer.set_limits(ComposerLimits { attachments: false, model_locked: true }, cx);
                    composer.set_model(Provider::Claude, model, model, None, cx);
                }
                // Milagre's daemon: a new Chat picks its model; an open Chat shows (and keeps) its own.
                None => composer.set_limits(ComposerLimits { attachments: true, model_locked: false }, cx),
            }
            // No steering on this runtime: a message during a turn waits in the runtime's queue.
            composer.set_follow_ups(Delivery::Queue, cx);
            composer.set_running(false, cx);
        });
        // The fixture's mid-turn Chat goes: nothing runs until the runtime says so.
        chat.update(cx, |chat, cx| {
            chat.running = None;
            chat.transcript.update(cx, |t, cx| {
                t.set_running_row(false, cx);
                t.set_items(Vec::new(), cx);
            });
            cx.notify();
        });
        if sidebar.read_with(cx, |s, _| s.selected_row().is_none()) {
            workspace.update(cx, |w, cx| w.show_new_chat(window, cx));
        }
        // The live stream's events this controller follows besides the reducer's ([`TAPPED`]).
        let (tap_sender, tap_receiver) = unbounded::<(String, Value)>();
        cx.new(|cx| {
            let mut subscriptions = vec![
                cx.observe(&chat, |this: &mut Self, _, cx| this.follow_chat(cx)),
                // The window switches Chats while it draws, when observers of the column are not called: its event is.
                cx.subscribe(&chat, |this: &mut Self, _, event: &milagre_gpui_spike::workspace::chat::ChatEvent, cx| {
                    if matches!(event, milagre_gpui_spike::workspace::chat::ChatEvent::Switched) {
                        this.follow_chat(cx);
                    }
                }),
                cx.observe(&composer, |this: &mut Self, composer, cx| this.follow_composer(&composer, cx)),
                cx.subscribe(&transcript, |this: &mut Self, _, decision: &CardDecision, cx| this.decide(decision, cx)),
                // The PR pill: the blocker's fix, sent as Electron's pill sends it.
                cx.subscribe(&pills, |this: &mut Self, pills, event: &milagre_gpui_spike::workspace::chat::pills::PillEvent, cx| {
                    use milagre_gpui_spike::workspace::chat::pills::PillEvent;
                    match event {
                        // Merge #N opens the PR panel; a blocker's fix is sent to the Chat.
                        PillEvent::PullRequestAction if pills.read(cx).data().pr_action.as_ref().is_some_and(|a| a.merge) => {
                            this.open_pr_tab(cx)
                        }
                        PillEvent::PullRequestAction => this.run_pr_action(cx),
                        PillEvent::OpenReview => this.open_pr_tab(cx),
                        _ => {}
                    }
                }),
                // A Project listed by name only was opened: Milagre's daemon loads it.
                cx.subscribe(&sidebar, |this: &mut Self, _, event: &SidebarEvent, cx| match event {
                    SidebarEvent::OpenProject(path) => this.load_project(path.to_string(), cx),
                    // The row's PR chip: the Chat opens with that PR in its PR panel (`openRowPullRequest`).
                    SidebarEvent::OpenPullRequest { key, number } => {
                        this.pr_picks.insert(key.to_string(), *number);
                        this.pr_tab = Some(key.to_string());
                        this.follow_chat(cx);
                        this.refresh_panels(cx);
                    }
                    _ => {}
                }),
            ];
            subscriptions.shrink_to_fit();
            let pump = match stream {
                Stream::Owned(notifications) => {
                    let store = store.clone();
                    cx.spawn(async move |this: gpui::WeakEntity<Self>, cx: &mut gpui::AsyncApp| {
                        let mut notifications = notifications;
                        let error = store.pump(&mut notifications).await;
                        let _ = this.update(cx, |this, cx| {
                            this.closed = Some(error.to_string());
                            eprintln!("live: the event stream closed: {error}");
                            cx.notify();
                        });
                    })
                }
                Stream::Daemon { daemon, first } => {
                    let store = store.clone();
                    let tap = tap_sender.clone();
                    cx.spawn(async move |this: gpui::WeakEntity<Self>, cx: &mut gpui::AsyncApp| {
                        let mut notifications = first;
                        let mut wait = Duration::ZERO;
                        loop {
                            if let Some(mut stream) = notifications.take() {
                                let error = pump_tapped(&store, &mut stream, &tap).await;
                                eprintln!("live: the daemon's stream closed ({error}); syncing again");
                                if this.update(cx, |this, cx| this.lost(error.to_string(), cx)).is_err() {
                                    return;
                                }
                                wait = Duration::from_millis(500);
                            }
                            if !wait.is_zero() {
                                let _ = off_thread(move || std::thread::sleep(wait)).await;
                            }
                            match sync(daemon.clone()).await {
                                Ok(synced) => {
                                    eprintln!("live: synced with Milagre's daemon (pid {}), live on {}", synced.pid, synced.project);
                                    store.replace(synced.reducer);
                                    notifications = Some(synced.notifications);
                                    if this.update(cx, |this, cx| this.synced(synced.pid, cx)).is_err() {
                                        return;
                                    }
                                }
                                Err(error) => {
                                    let notice = notice_for(&daemon, &error);
                                    if this.update(cx, |this, cx| this.set_unavailable(Some(notice), cx)).is_err() {
                                        return;
                                    }
                                    wait = (wait * 2).clamp(Duration::from_secs(1), Duration::from_secs(10));
                                }
                            }
                        }
                    })
                }
            };
            let mut versions = store.subscribe().expect("a subscriber slot");
            let follow = cx.spawn(async move |this: gpui::WeakEntity<Self>, cx: &mut gpui::AsyncApp| {
                while versions.next().await.is_some() {
                    if this.update(cx, |this, cx| this.on_store_changed(cx)).is_err() {
                        break;
                    }
                }
            });
            let tapped = cx.spawn(async move |this: gpui::WeakEntity<Self>, cx: &mut gpui::AsyncApp| {
                let mut taps = tap_receiver;
                while let Some((channel, payload)) = taps.next().await {
                    if this.update(cx, |this, cx| this.on_event(&channel, &payload, cx)).is_err() {
                        break;
                    }
                }
            });
            let run = cx.spawn(async move |this: gpui::WeakEntity<Self>, cx: &mut gpui::AsyncApp| {
                let mut receiver = receiver;
                while let Some(command) = receiver.next().await {
                    let Ok(Some(job)) = this.update(cx, |this, cx| this.job(command, cx)) else { continue };
                    let result = job.await;
                    let _ = this.update(cx, |this, cx| this.finished(result, cx));
                }
            });
            let mut this = Self {
                workspace: workspace.clone(),
                window: window.window_handle(),
                backend,
                reading_git: false,
                git_again: false,
                git_project: None,
                store,
                sink,
                open: None,
                fold_clock: None,
                pending_open: None,
                answered: HashSet::new(),
                receipts: Vec::new(),
                decisions: Vec::new(),
                errors: Vec::new(),
                closed: None,
                mode: PermissionMode::Ask,
                sent: 0,
                refused: Vec::new(),
                unavailable: None,
                syncs: 0,
                loading: HashSet::new(),
                open_loaded: None,
                preloaded,
                picked: HashMap::new(),
                picked_effort: HashMap::new(),
                catalogs: HashMap::new(),
                prs: HashMap::new(),
                ports: Value::Null,
                catalog_project: None,
                reading_extras: HashSet::new(),
                extras_at: HashMap::new(),
                events: Vec::new(),
                vault: None,
                unlock_next: true,
                unlocked: None,
                remote_dirty: HashSet::new(),
                remote_reading: false,
                computers_refused: None,
                notifier: None,
                live_pr: None,
                live_canvas: None,
                canvas_tab: None,
                pr_picks: HashMap::new(),
                pr_tab: None,
                pr_dismissed: HashMap::new(),
                pr_shown: false,
                pr_snapshot_opened: false,
                accounts: None,
                _subscriptions: subscriptions,
                _tasks: vec![pump, follow, run, tapped],
            };
            this.follow_chat(cx);
            this.sync_unloaded(cx);
            this.read_accounts(cx);
            this.read_computers(cx);
            this.read_all_prs(cx);
            this.read_project_images(cx);
            this
        })
    }

    // ---- Milagre's daemon: lost, synced, unavailable ----

    fn lost(&mut self, error: String, cx: &mut Context<Self>) {
        self.closed = Some(error);
        cx.notify();
    }

    fn synced(&mut self, pid: u32, cx: &mut Context<Self>) {
        self.syncs += 1;
        self.closed = None;
        self.set_unavailable(None, cx);
        let account: gpui::SharedString = format!("Milagre's daemon (pid {pid})").into();
        let model = cx.try_global::<PreviewMode>().map(|p| p.model.clone()).unwrap_or_default();
        cx.set_global(PreviewMode { account, model });
        // The first sync after a window that opened with no daemon: the newest Chat opens, as on a normal launch.
        let nothing_open = self.open.is_none() && self.workspace.read(cx).sidebar.read(cx).selected_row().is_none();
        // (A Chat already waiting to open, a snapshot's, keeps its place.)
        if nothing_open
            && self.pending_open.is_none()
            && let Some(key) = newest_chat(&self.store, None)
        {
            self.pending_open = Some(key);
        }
        // A daemon that restarted: the open Chat's transcript is read again from it.
        if self.open.is_some() {
            let open = self.open.as_mut().expect("open");
            open.loaded = false;
            self.load(cx);
        }
        self.on_store_changed(cx);
        self.load_first_when_none_loaded(cx);
        self.read_accounts(cx);
        self.unlock_next = true;
        self.read_computers(cx);
        self.read_all_prs(cx);
        self.read_project_images(cx);
        if let Some(accounts) = self.accounts.clone() {
            accounts.update(cx, |a, cx| a.changed(cx));
        }
        if let Some(canvas) = self.live_canvas.clone() {
            canvas.update(cx, |c, cx| c.resynced(cx));
        }
        cx.notify();
    }

    /// Milagre's daemon: one of the live stream's events this controller follows ([`TAPPED`]), as Electron's renderer
    /// follows them: `agent:ports` carries every Chat's ports (the Details tab shows them at once), `pull-requests:changed
    /// {projectPath}` says that Project's PR poll changed (read again if this window shows it), `accounts:changed {}`
    /// that the accounts did (read again). Agent events and waiting notices go to the notifier.
    pub(crate) fn on_event(&mut self, channel: &str, payload: &Value, cx: &mut Context<Self>) {
        match channel {
            "agent:ports" => {
                self.ports = payload.clone();
                self.refresh_panels(cx);
            }
            "pull-requests:changed" => {
                let Some(project) = payload["projectPath"].as_str() else { return };
                let shown = self.prs.contains_key(project) || self.open.as_ref().is_some_and(|open| open.project == project);
                if shown {
                    self.read_prs(project.to_owned(), cx);
                }
                if let Some(live_pr) = self.live_pr.clone() {
                    live_pr.update(cx, |pr, cx| pr.changed(project, cx));
                }
            }
            "accounts:changed" => {
                self.read_accounts(cx);
                if let Some(accounts) = self.accounts.clone() {
                    accounts.update(cx, |a, cx| a.changed(cx));
                }
            }
            // Paired computers: their list changed, one was forgotten, or one of their runtimes sent an event (tagged with
            // its id, its keys qualified): turn ends and waiting notices notify as this Mac's do, and its Chats are read again.
            "computers:changed" => self.read_computers(cx),
            "computers:forgotten" => {
                if let (Backend::Daemon(daemon), Some(id)) = (&self.backend, payload["computerId"].as_str()) {
                    daemon.set_remote(id, None);
                    if let Some(notifier) = &self.notifier {
                        notifier.forget_computer(id);
                    }
                }
                self.read_computers(cx);
            }
            "computers:event" => {
                let (Some(id), Some(inner)) = (payload["computerId"].as_str(), payload["channel"].as_str()) else { return };
                if let Some(notifier) = self.notifier.clone()
                    && matches!(inner, "agent:event" | "notification:waiting")
                {
                    let focused = self.window.update(cx, |_, window, _| window.is_window_active()).unwrap_or(false);
                    notifier.set_view(self.open_key().map(str::to_owned), focused);
                    let daemon = match &self.backend {
                        Backend::Daemon(daemon) => Some(daemon.clone()),
                        Backend::Owned { .. } => None,
                    };
                    let computer = id.to_owned();
                    notifier.event(inner, &payload["payload"], |key| remote_chat_info(daemon.as_deref(), &computer, key));
                }
                if matches!(inner, "project:state" | "agent:event") {
                    self.remote_dirty.insert(id.to_owned());
                    self.read_remote_soon(cx);
                }
            }
            // The sidebar's Links (`canvas:links-changed {links}`).
            "canvas:links-changed" => {
                if let Some(writes) = cx.try_global::<crate::sidebar_writes::Writes>().map(|w| w.0.clone()) {
                    let links = payload["links"].clone();
                    writes.update(cx, |w, cx| w.set_links(&links, cx));
                }
            }
            _ => {}
        }
        if channel == "agent:event"
            && let Some(canvas) = self.live_canvas.clone()
        {
            canvas.update(cx, |c, cx| c.agent_event(payload, cx));
        }
        self.events.push(channel.to_owned());
        if let Some(notifier) = self.notifier.clone()
            && matches!(channel, "agent:event" | "notification:waiting")
        {
            let focused = self.window.update(cx, |_, window, _| window.is_window_active()).unwrap_or(false);
            notifier.set_view(self.open_key().map(str::to_owned), focused);
            let store = self.store.clone();
            let app: &App = cx;
            notifier.event(channel, payload, |key| chat_info(&store, key, app));
        }
    }

    /// A `milagre://` link opened on this computer: a pairing link goes to Add computer (`computers:add [link, {}]`, as
    /// Electron's dialog sends it) while paired computers show; otherwise, or for another link, the sidebar says so.
    pub fn open_link(&mut self, url: &str, cx: &mut Context<Self>) {
        let _ = self.window.update(cx, |_, window, _| window.activate_window());
        cx.activate(true);
        let Backend::Daemon(daemon) = &self.backend else { return };
        let sidebar = self.workspace.read(cx).sidebar.clone();
        let say = |text: String, cx: &mut Context<Self>| sidebar.update(cx, |s, cx| s.set_notice(Some(text.into()), cx));
        let link = match crate::deeplinks::route(url) {
            crate::deeplinks::Route::Pair(link) => link,
            crate::deeplinks::Route::Unknown(why) => return say(why, cx),
        };
        if !cx.has_global::<milagre_gpui_spike::workspace::preview::PreviewComputers>() {
            return say(crate::deeplinks::PAIR_IN_MILAGRE.into(), cx);
        }
        if daemon.read_only() {
            return self.refuse("computers:add".into());
        }
        let Some((project, _)) = daemon.primary() else { return };
        let daemon = daemon.clone();
        let job: Job = Box::pin(async move {
            // Before computers:add, as Electron does: a locked vault answers `{ok: false, code: "keys"}`.
            if let Some(refusal) = daemon.unlock_computers(&project).await.map_err(|e| format!("{e:#}"))?.refusal() {
                return Err(refusal);
            }
            let writer = daemon.writer(&project).await.map_err(|e| format!("{e:#}"))?;
            writer.call("computers:add", serde_json::json!([link, {}])).await.map_err(|e| format!("Couldn't add the computer: {e:#}"))?;
            Ok(None)
        });
        self.spawn_job(job, cx);
    }

    /// Opens a Chat a notification was clicked for, and brings the window forward.
    pub fn open_from_notification(&mut self, key: String, cx: &mut Context<Self>) {
        let _ = self.window.update(cx, |_, window, _| window.activate_window());
        cx.activate(true);
        self.pending_open = Some(key);
        self.on_store_changed(cx);
    }

    /// The Preview's notifier, once installed (Milagre's daemon, writable windows).
    pub fn notifier(&self) -> Option<&Rc<crate::notify::Notifier>> {
        self.notifier.as_ref()
    }

    /// Installs the notifier: Settings › Notifications feed it, its badge follows the unread Chats, and a clicked
    /// notification opens its Chat.
    pub fn install_notifier(&mut self, notifier: Rc<crate::notify::Notifier>, cx: &mut Context<Self>) {
        use gpui::BorrowAppContext as _;
        let settings = crate::notify::from_store(cx.global::<milagre_gpui_spike::settings::SettingsStore>());
        notifier.set_settings(settings);
        let follow = notifier.clone();
        self._subscriptions.push(cx.observe_global::<milagre_gpui_spike::settings::SettingsStore>(move |_, cx| {
            let store = cx.global::<milagre_gpui_spike::settings::SettingsStore>();
            let (settings, played) = (crate::notify::from_store(store), store.last_played_chime.clone());
            if follow.settings() != settings {
                follow.set_settings(settings);
            }
            // Settings' Play button and a newly picked chime: played once.
            if let Some(chime) = played {
                follow.play(&chime);
                cx.update_global::<milagre_gpui_spike::settings::SettingsStore, _>(|store, _| store.last_played_chime = None);
            }
        }));
        let clicks = cx.spawn(async move |this: gpui::WeakEntity<Self>, cx: &mut gpui::AsyncApp| {
            loop {
                cx.background_executor().timer(Duration::from_millis(250)).await;
                for key in crate::notify::take_clicked() {
                    if this.update(cx, |this, cx| this.open_from_notification(key, cx)).is_err() {
                        return;
                    }
                }
            }
        });
        self._tasks.push(clicks);
        self.notifier = Some(notifier);
        self.follow_unread(cx);
    }

    /// The dock badge's unread Chats: the reducer's `unread`, hidden Projects left out.
    fn follow_unread(&mut self, cx: &mut Context<Self>) {
        let Some(notifier) = self.notifier.clone() else { return };
        let unread: HashSet<String> = self.store.read(|reducer| {
            let Ok(applied) = reducer.state() else { return HashSet::new() };
            applied
                .projects
                .iter()
                .filter(|open| !crate::sidebar_writes::is_hidden(cx, &open.project.path))
                .filter_map(|open| Some((open, open.state.as_ref()?)))
                .flat_map(|(open, state)| {
                    state.sessions.values().filter(|c| c.unread && !c.archived).map(move |c| open.project.scope().chat_key(c.id))
                })
                .collect()
        });
        notifier.set_unread(unread);
    }

    /// Milagre's daemon: one Project's PR poll (`pull-requests:snapshot`), after its `pull-requests:changed`.
    fn read_prs(&mut self, project: String, cx: &mut Context<Self>) {
        let Backend::Daemon(daemon) = &self.backend else { return };
        let (daemon, target) = (daemon.clone(), project.clone());
        let read =
            off_thread(move || futures::executor::block_on(daemon.read(&target, "pull-requests:snapshot", serde_json::json!([target]))));
        cx.spawn(async move |this, cx| {
            let Ok(read) = read.await else { return };
            let _ = this.update(cx, |this, cx| match read {
                Ok(prs) => this.store_prs(project, prs, cx),
                Err(error) => this.error(format!("Couldn't read the pull requests: {error:#}")),
            });
        })
        .detach();
    }

    /// A Project's PR poll: the Details tab, the pills and the sidebar's PR chips follow it.
    fn store_prs(&mut self, project: String, prs: Value, cx: &mut Context<Self>) {
        if let Backend::Daemon(daemon) = &self.backend {
            daemon.set_prs(&project, prs.clone());
        }
        let changed = self.prs.get(&project) != Some(&prs);
        self.prs.insert(project, prs);
        if changed {
            let sidebar = self.workspace.read(cx).sidebar.clone();
            sidebar.update(cx, |s, cx| s.reload(cx));
        }
        // Evidence snapshots (`MILAGRE_GPUI_LIVE_PANEL=PR`): the newest Chat with a PR opens on its PR tab.
        if !self.pr_snapshot_opened && std::env::var("MILAGRE_GPUI_LIVE_PANEL").as_deref() == Ok("PR") {
            self.open_newest_with_pr(cx);
        }
        self.refresh_panels(cx);
    }

    /// Opens the newest Chat whose PR poll names a PR, on its PR tab (snapshots).
    fn open_newest_with_pr(&mut self, cx: &mut Context<Self>) {
        if let Some((key, _, _)) = newest_with_pr(&self.store, &self.prs) {
            self.pr_snapshot_opened = true;
            self.pr_tab = Some(key.clone());
            self.pending_open = Some(key);
            self.on_store_changed(cx);
        }
    }

    /// Milagre's daemon: every loaded Project's picture (`project:image`, [`crate::images`]), read once per run as
    /// Electron's `useProjectImages` does; when one arrives the sidebar and the new-Chat picker draw it instead of the
    /// letter. A Project with no picture, or one that fails to read or decode, keeps the letter.
    fn read_project_images(&mut self, cx: &mut Context<Self>) {
        let Backend::Daemon(daemon) = &self.backend else { return };
        let daemon = daemon.clone();
        let loaded: Vec<String> = self.store.read(|reducer| {
            reducer
                .shown()
                .map(|applied| applied.projects.iter().filter(|o| !o.project.is_chats_home()).map(|o| o.project.path.to_string()).collect())
                .unwrap_or_default()
        });
        for project in loaded {
            if !daemon.ask_image(&project) {
                continue;
            }
            let daemon = daemon.clone();
            cx.spawn(async move |this, cx| {
                let path = project.clone();
                let reader = daemon.clone();
                let read = off_thread(move || {
                    let answer = futures::executor::block_on(reader.read(&path, "project:image", serde_json::json!([path])))?;
                    crate::images::resolve(&answer)
                })
                .await;
                let image = match read {
                    Ok(Ok(image)) => image,
                    Ok(Err(error)) => {
                        eprintln!("live: no picture for {project}: {error:#}");
                        None
                    }
                    Err(_) => None,
                };
                let Some(image) = image else { return };
                daemon.set_image(&project, Some(image));
                let _ = this.update(cx, |this, cx| {
                    let sidebar = this.workspace.read(cx).sidebar.clone();
                    sidebar.update(cx, |s, cx| s.reload(cx));
                    this.follow_new_chat(cx);
                    cx.notify();
                });
            })
            .detach();
        }
    }

    /// Milagre's daemon: every loaded Project's PR poll, for the sidebar's PR chips (Electron's sidebar reads each).
    fn read_all_prs(&mut self, cx: &mut Context<Self>) {
        if !matches!(self.backend, Backend::Daemon(_)) {
            return;
        }
        let loaded: Vec<String> = self.store.read(|reducer| {
            reducer
                .state()
                .map(|applied| applied.projects.iter().filter(|o| !o.project.is_chats_home()).map(|o| o.project.path.to_string()).collect())
                .unwrap_or_default()
        });
        for project in loaded {
            self.read_prs(project, cx);
        }
    }

    /// Opens the open Chat's PR tab (the review comments pill, Merge #N).
    fn open_pr_tab(&mut self, cx: &mut Context<Self>) {
        let panel = self.workspace.read(cx).panel.clone();
        panel.update(cx, |panel, cx| panel.activate(milagre_gpui_spike::workspace::panel::PanelTab::Pr, cx));
        self.refresh_panels(cx);
    }

    /// The tapped channels this window received, oldest first (tests).
    pub fn events(&self) -> &[String] {
        &self.events
    }

    /// Milagre's daemon: its paired computers, shown only while its computer vault is unlocked ([`crate::computers`]).
    /// Read once per sync; a refusal is said once in the log and the computers stay hidden.
    fn read_computers(&mut self, cx: &mut Context<Self>) {
        let Backend::Daemon(daemon) = &self.backend else { return };
        let Some((project, _)) = daemon.primary() else { return };
        let daemon = daemon.clone();
        let unlock = std::mem::take(&mut self.unlock_next);
        let read = off_thread({
            let daemon = daemon.clone();
            move || {
                futures::executor::block_on(async {
                    // At launch and after every adoption: unlock as Electron does, only when the vault says it is locked.
                    let unlocked = if unlock { Some(daemon.unlock_computers(&project).await) } else { None };
                    let vault = crate::computers::read(&daemon, &project).await;
                    let mut remotes = Vec::new();
                    if let crate::computers::Vault::Unlocked(snapshot) = &vault {
                        for computer in &snapshot.computers {
                            if computer.state == milagre_gpui_spike::data::ComputerState::Online {
                                remotes.push((computer.id.to_string(), crate::computers::read_remote(&daemon, &computer.id).await.ok()));
                            }
                        }
                    }
                    (unlocked, vault, remotes)
                })
            }
        });
        cx.spawn(async move |this, cx| {
            let Ok((unlocked, vault, remotes)) = read.await else { return };
            let _ = this.update(cx, |this, cx| {
                match unlocked {
                    Some(Ok(outcome)) => {
                        if let Some(notice) = outcome.notice() {
                            eprintln!("live: computers: {notice}");
                            let sidebar = this.workspace.read(cx).sidebar.clone();
                            sidebar.update(cx, |s, cx| s.set_notice(Some(notice.into()), cx));
                        }
                        this.unlocked = Some(outcome);
                    }
                    Some(Err(error)) => this.error(format!("Couldn't unlock the paired computers: {error:#}")),
                    None => {}
                }
                for (id, remote) in remotes {
                    daemon.set_remote(&id, remote);
                }
                let shown = match &vault {
                    crate::computers::Vault::Unlocked(snapshot) => Some(snapshot.clone()),
                    crate::computers::Vault::Locked => None,
                    crate::computers::Vault::Refused(why) => {
                        if this.computers_refused.as_deref() != Some(why.as_str()) {
                            eprintln!("live: computers stay hidden: {why}");
                            this.computers_refused = Some(why.clone());
                        }
                        None
                    }
                };
                daemon.set_computers(shown.clone());
                match shown {
                    Some(snapshot) => cx.set_global(milagre_gpui_spike::workspace::preview::PreviewComputers(snapshot)),
                    None => {
                        if cx.has_global::<milagre_gpui_spike::workspace::preview::PreviewComputers>() {
                            cx.remove_global::<milagre_gpui_spike::workspace::preview::PreviewComputers>();
                        }
                    }
                }
                this.vault = Some(vault);
                let sidebar = this.workspace.read(cx).sidebar.clone();
                sidebar.update(cx, |s, cx| s.reload(cx));
            });
        })
        .detach();
    }

    /// Reads the paired computers whose Chats changed, a second after the first change (their events come in bursts).
    fn read_remote_soon(&mut self, cx: &mut Context<Self>) {
        let Backend::Daemon(daemon) = &self.backend else { return };
        if self.remote_reading {
            return;
        }
        self.remote_reading = true;
        let daemon = daemon.clone();
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_secs(1)).await;
            let Ok(ids) = this.update(cx, |this, _| std::mem::take(&mut this.remote_dirty)) else { return };
            let work = off_thread({
                let daemon = daemon.clone();
                move || {
                    futures::executor::block_on(async {
                        let mut out = Vec::new();
                        for id in ids {
                            out.push((id.clone(), crate::computers::read_remote(&daemon, &id).await.ok()));
                        }
                        out
                    })
                }
            });
            let Ok(read) = work.await else { return };
            let _ = this.update(cx, |this, cx| {
                this.remote_reading = false;
                for (id, remote) in read {
                    if remote.is_some() {
                        daemon.set_remote(&id, remote);
                    }
                }
                let sidebar = this.workspace.read(cx).sidebar.clone();
                sidebar.update(cx, |s, cx| s.reload(cx));
                if !this.remote_dirty.is_empty() {
                    this.read_remote_soon(cx);
                }
            });
        })
        .detach();
    }

    /// What the last unlock did (tests).
    pub fn unlocked(&self) -> Option<&crate::computers::Unlock> {
        self.unlocked.as_ref()
    }

    /// `computers:set-enabled [on]` as Electron's Settings sends it, unlocking first when turning them on.
    pub fn set_computers_enabled(&mut self, on: bool, cx: &mut Context<Self>) {
        let Backend::Daemon(daemon) = &self.backend else { return };
        if daemon.read_only() {
            return self.refuse("computers:set-enabled".into());
        }
        let Some((project, _)) = daemon.primary() else { return };
        let daemon = daemon.clone();
        let job: Job = Box::pin(async move {
            if on {
                daemon.unlock_computers(&project).await.map_err(|e| format!("{e:#}"))?;
            }
            daemon.computers_write("computers:set-enabled", serde_json::json!([on])).await.map_err(|e| format!("{e:#}"))?;
            Ok(None)
        });
        self.spawn_job(job, cx);
    }

    /// What the last computer-vault read found (tests).
    pub fn vault(&self) -> Option<&crate::computers::Vault> {
        self.vault.as_ref()
    }

    /// Milagre's daemon: Settings › Accounts, read once per sync (`accounts:list [false]`, no refresh) on the live
    /// Project's request-only connection; read-only there.
    fn read_accounts(&mut self, cx: &mut Context<Self>) {
        let Backend::Daemon(daemon) = &self.backend else { return };
        let Some((project, _)) = daemon.primary() else { return };
        let daemon = daemon.clone();
        let read = off_thread(move || futures::executor::block_on(daemon.read(&project, "accounts:list", serde_json::json!([false]))));
        cx.spawn(async move |this, cx| {
            let Ok(read) = read.await else { return };
            let _ = this.update(cx, |this, cx| match read {
                Ok(list) => cx.set_global(milagre_gpui_spike::workspace::preview::PreviewAccounts(crate::panels::accounts(&list))),
                Err(error) => this.error(format!("Couldn't read the accounts: {error:#}")),
            });
        })
        .detach();
    }

    /// No daemon (or no sync): the sidebar says so and the composer cannot send; `None` clears it.
    fn set_unavailable(&mut self, notice: Option<String>, cx: &mut Context<Self>) {
        if self.unavailable == notice {
            return;
        }
        self.unavailable = notice.clone();
        let (sidebar, composer) = {
            let w = self.workspace.read(cx);
            (w.sidebar.clone(), w.chat.read(cx).composer.clone())
        };
        sidebar.update(cx, |s, cx| s.set_notice(notice.clone().map(Into::into), cx));
        composer.update(cx, |c, cx| c.set_blocked(notice.is_some(), cx));
        cx.notify();
    }

    /// Why the window cannot reach Milagre's daemon now (`None` once synced).
    pub fn unavailable(&self) -> Option<&str> {
        self.unavailable.as_deref()
    }

    /// Successful syncs after the first (reconnects).
    pub fn syncs(&self) -> u64 {
        self.syncs
    }

    /// Writes this read-only window refused before reaching a connection.
    pub fn refused(&self) -> &[String] {
        &self.refused
    }

    /// Milagre's daemon: the Designs and Artifact tabs' driver.
    pub fn live_canvas(&self) -> Option<&Entity<crate::canvas::LiveCanvas>> {
        self.live_canvas.as_ref()
    }

    /// Milagre's daemon: follows Projects asked to load ([`Self::load_project`]) until their Chats arrive, then opens
    /// the newest. Projects the daemon knows but has not loaded get no rows, as in Electron's sidebar, and nothing loads
    /// one by itself; the sidebar's name-only list stays empty.
    pub(crate) fn sync_unloaded(&mut self, cx: &mut Context<Self>) {
        let Backend::Daemon(daemon) = &self.backend else { return };
        let daemon = daemon.clone();
        let loaded: Vec<String> = self.store.read(|reducer| {
            reducer.state().map(|applied| applied.projects.iter().map(|o| o.project.path.to_string()).collect()).unwrap_or_default()
        });
        self.loading.retain(|path| !loaded.contains(path));
        // A Project being loaded shows by name, "Loading…", until its Chats arrive (the window's loading state on a
        // daemon that has loaded nothing yet).
        let known = daemon.known();
        let rows: Vec<milagre_gpui_spike::workspace::sidebar::UnloadedProject> = known
            .iter()
            .filter(|k| self.loading.contains(&k.path))
            .map(|k| milagre_gpui_spike::workspace::sidebar::UnloadedProject {
                path: k.path.clone().into(),
                name: k.name.clone().into(),
                loading: true,
            })
            .collect();
        let sidebar = self.workspace.read(cx).sidebar.clone();
        sidebar.update(cx, |s, cx| s.set_unloaded_projects(rows, cx));
        if let Some(path) = self.open_loaded.clone()
            && loaded.contains(&path)
        {
            self.open_loaded = None;
            if let Some(key) = newest_chat(&self.store, Some(&path)) {
                self.pending_open = Some(key);
            }
        }
    }

    /// Milagre's daemon after a sync that loaded no Project (it was just started, by this window or by a cold boot,
    /// and Electron has not opened one): the most recently opened known Project is loaded, as Electron's window opens
    /// its current Project on launch, so the window lands on its Chats and newest Chat instead of an empty list.
    /// Nothing when a Project is already loaded or loading, the daemon knows none (the sidebar says "No Projects
    /// yet"), or in read-only mode.
    pub(crate) fn load_first_when_none_loaded(&mut self, cx: &mut Context<Self>) {
        let Backend::Daemon(daemon) = &self.backend else { return };
        if daemon.read_only() || !self.loading.is_empty() {
            return;
        }
        let any_loaded =
            self.store.read(|reducer| reducer.state().is_ok_and(|applied| applied.projects.iter().any(|o| !o.project.is_chats_home())));
        if any_loaded {
            return;
        }
        let Some(first) = daemon.known().first().map(|k| k.path.clone()) else { return };
        eprintln!("live: no Project loaded yet; loading {first}, as Milagre's window opens its current Project");
        self.load_project(first, cx);
    }

    /// A Project the daemon knows but has not loaded, opened on purpose (a future ⌘K search; the sidebar lists no such
    /// rows): loaded on a request-only connection (`load_view`, which may resume its Chats as opening it in Electron
    /// does), then the window syncs again, lists its Chats and opens the newest. Never in read-only mode.
    pub fn load_project(&mut self, path: String, cx: &mut Context<Self>) {
        let Backend::Daemon(daemon) = &self.backend else { return };
        let daemon = daemon.clone();
        if daemon.read_only() {
            self.refuse(format!("load the Project {path}"));
            self.sync_unloaded(cx);
            return;
        }
        if !self.loading.insert(path.clone()) {
            return;
        }
        self.open_loaded = Some(path.clone());
        self.sync_unloaded(cx);
        cx.spawn(async move |this, cx| {
            let target = path.clone();
            let loaded = off_thread(move || futures::executor::block_on(daemon.load(&target))).await;
            let error = match loaded {
                Ok(Ok(())) => {
                    eprintln!("live: loaded {path}; syncing again");
                    return;
                }
                Ok(Err(error)) => format!("Couldn't load {path}: {error:#}"),
                Err(_) => format!("Couldn't load {path}: the load thread ended"),
            };
            let _ = this.update(cx, |this, cx| {
                this.loading.remove(&path);
                this.open_loaded = None;
                let sidebar = this.workspace.read(cx).sidebar.clone();
                sidebar.update(cx, |s, cx| s.set_notice(Some(error.clone().into()), cx));
                this.error(error);
                this.sync_unloaded(cx);
            });
        })
        .detach();
    }

    // ---- What tests and the app read ----

    /// Every send's client message id and the runtime's receipt, oldest first.
    pub fn receipts(&self) -> &[(String, Value)] {
        &self.receipts
    }

    pub fn decisions(&self) -> &[(String, String)] {
        &self.decisions
    }

    /// Reads and clears the errors (a test that provoked one).
    pub fn take_errors(&mut self) -> Vec<String> {
        std::mem::take(&mut self.errors)
    }

    pub fn errors(&self) -> &[String] {
        &self.errors
    }

    /// Why the event stream closed, once it has.
    pub fn closed(&self) -> Option<&str> {
        self.closed.as_deref()
    }

    pub fn open_key(&self) -> Option<&str> {
        self.open.as_ref().map(|open| open.key.as_str())
    }

    pub fn store(&self) -> &LiveStore {
        &self.store
    }

    /// Ends this window's connections (before the runtime is stopped; the daemon keeps running).
    pub fn disconnect(&mut self) {
        match &self.backend {
            Backend::Owned { client, .. } => client.disconnect(),
            Backend::Daemon(daemon) => daemon.disconnect(),
        }
    }

    /// The owned runtime's connection (tests).
    pub fn client(&self) -> &Client {
        match &self.backend {
            Backend::Owned { client, .. } => client,
            Backend::Daemon(_) => panic!("the owned runtime's client"),
        }
    }

    /// The owned runtime's Chat actions (tests).
    pub fn actions(&self) -> &ChatActions {
        match &self.backend {
            Backend::Owned { actions, .. } => actions,
            Backend::Daemon(_) => panic!("the owned runtime's actions"),
        }
    }

    pub fn backend(&self) -> &Backend {
        &self.backend
    }

    // ---- Following the views ----

    fn follow_chat(&mut self, cx: &mut Context<Self>) {
        let chat = self.workspace.read(cx).chat.clone();
        let (key, new_chat) = chat.read_with(cx, |c, _| (c.key().map(str::to_owned), c.is_new_chat()));
        let at = key.as_deref().and_then(|key| chat_ref(self.backend.only_project(), key)).filter(|at| self.has_chat(at));
        let target = match (new_chat, &at) {
            (true, _) => Target::NewChat,
            (false, Some(at)) => Target::Existing(at.clone()),
            (false, None) => Target::None,
        };
        let switched = *self.sink.target.borrow() != target;
        *self.sink.target.borrow_mut() = target;
        if switched && matches!(self.backend, Backend::Daemon(_)) {
            self.follow_model(new_chat, at.as_ref(), cx);
        }
        // A paired computer's Chat: shown (its transcript read through `computers:invoke`), never written to here.
        let remote = (at.is_none() && !new_chat)
            .then(|| {
                let (scope, id) = key.as_deref()?.rsplit_once('#')?;
                let id = id.parse().ok()?;
                scope.contains('|').then(|| ChatRef { project: scope.to_owned(), id })
            })
            .flatten()
            .filter(|remote| self.has_chat(remote));
        let key = if new_chat { None } else { key.filter(|_| at.is_some() || remote.is_some()) };
        if key.as_deref() == self.open_key() {
            return;
        }
        if let Some(at) = &at
            && !new_chat
        {
            self.read_extras(at.project.clone(), false, cx);
        }
        let local = at.is_some();
        self.open = key.zip(at.or(remote)).map(|(key, at)| OpenChat { key, project: at.project, id: at.id, ..OpenChat::default() });
        if let Some(accounts) = self.accounts.clone() {
            let scope = self.open.as_ref().filter(|_| local).map(|open| open.project.clone());
            accounts.update(cx, |a, cx| a.set_scope(scope, cx));
        }
        if self.open.is_some() && !local {
            self.load(cx);
        } else if self.open.is_some() {
            self.load(cx);
            match self.backend {
                Backend::Owned { .. } => self.read_changes(cx),
                // The daemon's Changes are the Project's (its main checkout): read again only for another Project.
                Backend::Daemon(_) if self.git_project.as_deref() != self.open.as_ref().map(|o| o.project.as_str()) => {
                    self.read_changes(cx)
                }
                Backend::Daemon(_) => {}
            }
        }
        self.refresh_panels(cx);
    }

    /// Milagre's daemon: the composer shows the open Chat's own provider and permission mode and the model its next
    /// send names ([`crate::panels::model_for_chat`]: picked here, else its last, else its provider's recommended);
    /// on the new-Chat screen, the picker's choice. The picker stays open: a pick on an open Chat is kept for it.
    fn follow_model(&mut self, new_chat: bool, at: Option<&ChatRef>, cx: &mut Context<Self>) {
        let composer = self.workspace.read(cx).chat.read(cx).composer.clone();
        // Images and files go with `chat:send` as Electron sends them ([`crate::sinks::Attachments`]).
        composer.update(cx, |c, cx| c.set_limits(ComposerLimits { attachments: true, model_locked: false }, cx));
        if new_chat || at.is_none() {
            let model = composer.read(cx).model();
            *self.sink.model.borrow_mut() = (model.0, model.1.to_string());
            return;
        }
        let at = at.expect("a Chat");
        let (provider, last, mode) = self
            .store
            .read(|reducer| {
                let applied = reducer.state().ok()?;
                let chat =
                    applied.projects.iter().find(|o| o.project.path.as_ref() == at.project)?.state.as_ref()?.sessions.get(&at.id)?.clone();
                let provider = Provider::of_session(chat.provider_id.as_deref());
                let run_model = applied.runs.get(&at.key()).map(|run| run.model.to_string()).filter(|m| !m.is_empty());
                let model = chat
                    .summary
                    .as_ref()
                    .and_then(|s| s.last_model.as_ref().map(|m| m.to_string()))
                    .filter(|m| !m.is_empty())
                    .or(run_model);
                Some((provider, model, chat.permission_mode.unwrap_or(PermissionMode::Ask)))
            })
            .unwrap_or((Provider::Claude, None, PermissionMode::Ask));
        let (provider, id, name) = crate::panels::model_for_chat(provider, self.picked.get(&at.key()), last.as_deref());
        // Set before the composer changes, so following it sends no permission-mode write and records no pick.
        self.mode = mode;
        self.sink.mode.set(mode);
        *self.sink.model.borrow_mut() = (provider, id.clone());
        // The effort the chip shows from the start, as Electron's: picked here for this Chat, else Electron's own
        // choice for it (or its last), kept to what the model offers.
        let effort = self.picked_effort.get(&at.key()).map(|effort| effort.to_string()).unwrap_or_else(|| {
            cx.try_global::<crate::prefs::ElectronPrefs>()
                .map_or_else(|| "high".to_owned(), |prefs| crate::prefs::composer_effort(&prefs.0, &at.key()))
        });
        composer.update(cx, |c, cx| {
            c.set_model(provider, &id, &name, None, cx);
            c.settle_effort(Some(&effort), cx);
            c.set_permission_mode(mode, cx);
        });
        self.sink.effort.set(composer.read(cx).effort_id());
    }

    /// Milagre's daemon: the Project's model lists, PR poll and every Chat's ports, read (at most every few seconds
    /// unless `force`) on a short request-only connection; they feed the picker, Details and the pills.
    fn read_extras(&mut self, project: String, force: bool, cx: &mut Context<Self>) {
        let Backend::Daemon(daemon) = &self.backend else { return };
        let fresh = self.extras_at.get(&project).is_some_and(|at| at.elapsed() < Duration::from_secs(5));
        if (fresh && !force) || !self.reading_extras.insert(project.clone()) {
            return;
        }
        self.extras_at.insert(project.clone(), std::time::Instant::now());
        let (daemon, need_models) = (daemon.clone(), !self.catalogs.contains_key(&project));
        let target = project.clone();
        let reads = off_thread(move || {
            futures::executor::block_on(async {
                let models = if need_models { Some(daemon.read(&target, "agent:models", serde_json::json!([target])).await) } else { None };
                let ports = daemon.read(&target, "agent:ports", serde_json::json!([])).await;
                let prs = daemon.read(&target, "pull-requests:snapshot", serde_json::json!([target])).await;
                (models, ports, prs)
            })
        });
        cx.spawn(async move |this, cx| {
            let Ok((models, ports, prs)) = reads.await else { return };
            let _ = this.update(cx, |this, cx| {
                this.reading_extras.remove(&project);
                let mut catalog = false;
                match models {
                    Some(Ok(models)) => {
                        this.catalogs.insert(project.clone(), models);
                        catalog = true;
                    }
                    Some(Err(error)) => this.error(format!("Couldn't read the models: {error:#}")),
                    None => {}
                }
                match ports {
                    Ok(ports) => this.ports = ports,
                    Err(error) => this.error(format!("Couldn't read the ports: {error:#}")),
                }
                match prs {
                    Ok(prs) => {
                        if let Backend::Daemon(daemon) = &this.backend {
                            daemon.set_prs(&project, prs.clone());
                        }
                        let changed = this.prs.get(&project) != Some(&prs);
                        this.prs.insert(project.clone(), prs);
                        if changed {
                            let sidebar = this.workspace.read(cx).sidebar.clone();
                            sidebar.update(cx, |s, cx| s.reload(cx));
                        }
                    }
                    Err(error) => this.error(format!("Couldn't read the pull requests: {error:#}")),
                }
                if catalog {
                    this.catalog_project = None;
                }
                this.refresh_panels(cx);
            });
        })
        .detach();
    }

    /// The model lists of `project` in the picker (once read); the open Chat's chip follows a change.
    fn apply_catalog(&mut self, project: &str, cx: &mut Context<Self>) {
        if self.catalog_project.as_deref() == Some(project) {
            return;
        }
        let Some(models) = self.catalogs.get(project) else { return };
        milagre_gpui_spike::workspace::chat::composer::models::set_reported(Some(crate::panels::catalog(models)));
        self.catalog_project = Some(project.to_owned());
        let target = self.sink.target.borrow().clone();
        if let Target::Existing(at) = target {
            self.follow_model(false, Some(&at), cx);
        }
    }

    /// Milagre's daemon: the PR pill's fix for the open Chat (`pullRequestAction`), sent as Electron's pill sends it:
    /// `chat:send` with `prAction { action, pr, url }` (the daemon checks it and writes the message and the prompt),
    /// on the Chat's provider and model and its permission mode.
    fn run_pr_action(&mut self, cx: &mut Context<Self>) {
        let Backend::Daemon(daemon) = &self.backend else { return };
        let Some((key, project, id)) = self.open.as_ref().map(|o| (o.key.clone(), o.project.clone(), o.id)) else { return };
        let empty = Value::Null;
        let prs = self.prs.get(&project).unwrap_or(&empty);
        let dismissed = self.pr_dismissed.get(&key).cloned().unwrap_or_default();
        let action = self.store.read(|reducer| {
            let applied = reducer.state().ok()?;
            let (open, chat) = crate::panels::find(&applied.projects, &key)?;
            let worktree = open.state.as_ref()?.worktree_of(chat)?;
            let list = crate::panels::chat_pull_requests(prs, worktree.path.as_ref(), chat);
            let (pr, blocker) = milagre_gpui_spike::logic::prs::blockers::pull_request_action(&list, &dismissed)?;
            Some((pr, blocker, chat.worktree_id))
        });
        let Some((pr, blocker, worktree_id)) = action else {
            return self.error("PR action: the pill's PR has no blocker left to fix: nothing was sent".into());
        };
        let Some(number) = pr.number else { return };
        if self.backend.read_only() {
            return self.refuse(format!("PR action {} on #{number}", blocker.key()));
        }
        let context = milagre_gpui_spike::logic::prs::action::pull_request_action_context(blocker.key(), f64::from(number), &pr.url);
        let Some(context) = context else { return self.error(format!("PR #{number}'s action isn't valid: nothing was sent")) };
        // `updateBlockerDismissals`: the pill hides once its fix is asked for, until GitHub says the blocker cleared.
        let next = milagre_gpui_spike::logic::prs::blockers::update_blocker_dismissals(&dismissed, Some(&pr), Some(blocker));
        self.pr_dismissed.insert(key.clone(), next);
        let pills = self.workspace.read(cx).chat.read(cx).pills.clone();
        pills.update(cx, |p, cx| p.clear_pr_action(cx));
        // At once, as Electron's optimistic message: the action card and the running row; the saved message replaces it.
        let card = milagre_gpui_spike::workspace::chat::transcript::cards::PrActionCard {
            blocker: context.action,
            pr: context.pr,
            url: context.url.clone().into(),
            state: None,
        };
        let transcript = self.workspace.read(cx).chat.read(cx).transcript.clone();
        transcript.update(cx, |t, cx| {
            t.push(
                milagre_gpui_spike::workspace::chat::transcript::Item::Card(
                    milagre_gpui_spike::workspace::chat::transcript::cards::Card::PrAction(card),
                ),
                cx,
            );
            t.set_running_row(true, cx);
            t.scroll_to_bottom(cx);
        });
        self.sent += 1;
        let client_id = format!("gpui-{}-{}-{}", std::process::id(), crate::transcript::now_ms(), self.sent);
        let (provider, model) = self.sink.model.borrow().clone();
        let request = serde_json::json!([{
            "projectPath": project,
            "worktreeId": worktree_id,
            "sessionId": id,
            "provider": provider.id(),
            "model": model,
            "body": milagre_gpui_spike::logic::prs::action::pull_request_action_body(&context),
            "clientMessageId": client_id,
            "permissionMode": crate::sinks::wire_name(self.sink.mode.get()),
            "replies": "concise",
            "tldrEnabled": true,
            "prAction": { "action": blocker.key(), "pr": number, "url": pr.url },
        }]);
        let daemon = daemon.clone();
        let job: Job = Box::pin(async move {
            let writer = daemon.writer(&project).await.map_err(|e| format!("Couldn't send the PR action: {e:#}"))?;
            let mut request = request;
            // A Chat with no recorded model: its provider's first recommended one, as a composer send does.
            if request[0]["model"].as_str().is_none_or(str::is_empty) {
                let model = writer
                    .recommended_model(provider.id())
                    .await
                    .map_err(|e| format!("Couldn't send the PR action: {e:#}"))?
                    .ok_or_else(|| format!("Couldn't send the PR action: Milagre recommends no {} model", provider.name()))?;
                request[0]["model"] = Value::String(model);
            }
            let receipt = writer.call("chat:send", request).await.map_err(|e| format!("Couldn't send the PR action: {e:#}"))?;
            drop(writer);
            Ok(Some(Done::Sent { id: client_id, receipt, open: None }))
        });
        self.refresh_panels(cx);
        let key_back = key.clone();
        cx.spawn(async move |this, cx| {
            let result = job.await;
            let _ = this.update(cx, |this, cx| {
                if result.is_err() {
                    // Not sent: the pill comes back, and the transcript shows what was saved.
                    this.pr_dismissed.remove(&key_back);
                    if let Some(open) = this.open.as_mut().filter(|open| open.key == key_back) {
                        open.loaded = false;
                        this.load(cx);
                    }
                    let transcript = this.workspace.read(cx).chat.read(cx).transcript.clone();
                    transcript.update(cx, |t, cx| t.set_running_row(false, cx));
                }
                this.finished(result, cx);
                this.refresh_panels(cx);
            });
        })
        .detach();
    }

    /// Milagre's daemon: the open Chat's Details and pills from the reducer's state and the last reads.
    fn refresh_panels(&mut self, cx: &mut Context<Self>) {
        if !matches!(self.backend, Backend::Daemon(_)) {
            return;
        }
        let Some(open) = self.open.as_ref().map(|open| (open.key.clone(), open.project.clone())) else {
            let pills = self.workspace.read(cx).chat.read(cx).pills.clone();
            pills.update(cx, |p, cx| p.set_live("", Default::default(), cx));
            return;
        };
        let (key, project) = open;
        self.apply_catalog(&project, cx);
        let now = crate::transcript::now_ms();
        let empty = Value::Null;
        let prs = self.prs.get(&project).unwrap_or(&empty).clone();
        let picked = self.pr_picks.get(&key).copied();
        // The PR the panel shows, in the Chat's Worktree folder.
        let shown_pr = self.store.read(|reducer| {
            let applied = reducer.state().ok()?;
            let (open, chat) = crate::panels::find(&applied.projects, &key)?;
            let folder = open.state.as_ref()?.worktree_of(chat)?.path.to_string();
            let number = crate::panels::panel_pull_request(&prs, &folder, chat, picked);
            Some((folder, number))
        });
        let (panel, pills) = {
            let w = self.workspace.read(cx);
            (w.panel.clone(), w.chat.read(cx).pills.clone())
        };
        let built = self.store.read(|reducer| {
            let applied = reducer.state().ok()?;
            crate::panels::details(&applied.projects, &key, &self.ports, &prs, now)
        });
        let Some(details) = built else { return };
        let changed = panel.read(cx).details().read(cx).key() != key || panel.read(cx).details().read(cx).data() != &details;
        if changed {
            panel.update(cx, |panel, cx| panel.set_live_details(key.clone().into(), details, cx));
        }
        if let Some(canvas) = self.live_canvas.clone() {
            canvas.update(cx, |c, cx| c.show(&key, &project, cx));
            if let Some((seeded, tab)) = self.canvas_tab.clone()
                && seeded == key
                && panel.read(cx).visible_tabs().contains(&tab)
            {
                self.canvas_tab = None;
                panel.update(cx, |panel, cx| panel.activate(tab, cx));
            }
        }
        let mut review_comments = 0;
        if let Some(live_pr) = self.live_pr.clone() {
            match &shown_pr {
                Some((folder, number)) => {
                    live_pr.update(cx, |pr, cx| pr.show(&key, &project, folder, *number, cx));
                    let detail = number.and_then(|n| live_pr.read(cx).detail(n));
                    review_comments = detail
                        .filter(|pr| pr.state == milagre_gpui_spike::workspace::panel::pr::model::PullState::Open)
                        .map_or(0, |pr| milagre_gpui_spike::workspace::panel::pr::model::open_threads(&pr).len() as u32);
                }
                None => live_pr.update(cx, |pr, cx| pr.hide(&key, cx)),
            }
            if self.pr_tab.as_deref() == Some(key.as_str()) && shown_pr.as_ref().is_some_and(|(_, n)| n.is_some()) {
                self.pr_tab = None;
                panel.update(cx, |panel, cx| panel.activate(milagre_gpui_spike::workspace::panel::PanelTab::Pr, cx));
            }
        }
        let pr_shown = {
            let panel = panel.read(cx);
            panel.is_open() && panel.active() == milagre_gpui_spike::workspace::panel::PanelTab::Pr
        };
        let inputs =
            crate::panels::PillInputs { dismissed: self.pr_dismissed.get(&key).cloned().unwrap_or_default(), pr_shown, review_comments };
        let pills_data = self.store.read(|reducer| {
            let applied = reducer.state().ok()?;
            crate::panels::pills(&applied.projects, &key, &prs, now, &inputs)
        });
        if let Some(pills_data) = pills_data {
            pills.update(cx, |p, cx| {
                // The PR tab showing hides the PR pills on purpose: at once, not held over like a dropped state.
                if pr_shown {
                    p.clear_pr_action(cx);
                }
                p.set_live(&key, pills_data, cx)
            });
        }
    }

    fn follow_composer(&mut self, composer: &Entity<milagre_gpui_spike::workspace::chat::composer::Composer>, cx: &mut Context<Self>) {
        let (mode, effort, model) = composer.read_with(cx, |c, _| (c.permission_mode(), c.effort_id(), c.model()));
        self.sink.mode.set(mode);
        let changed_effort = self.sink.effort.get() != effort;
        self.sink.effort.set(effort);
        if matches!(self.backend, Backend::Daemon(_)) {
            let target = self.sink.target.borrow().clone();
            // An effort picked on an open Chat stays its own in this window.
            if let (Target::Existing(at), Some(effort), true) = (&target, effort, changed_effort) {
                self.picked_effort.insert(at.key(), effort);
            }
            let model = (model.0, model.1.to_string());
            match target {
                Target::NewChat => *self.sink.model.borrow_mut() = model,
                // A pick on an open Chat: kept for it, and its next send switches to it (or hands off).
                Target::Existing(at) if *self.sink.model.borrow() != model && !model.1.is_empty() => {
                    self.picked.insert(at.key(), model.clone());
                    *self.sink.model.borrow_mut() = model;
                }
                _ => {}
            }
        }
        // The new-Chat screen's pickers follow the Project the heading names.
        self.follow_new_chat(cx);
        if mode != self.mode {
            self.mode = mode;
            let target = self.sink.target.borrow().clone();
            if let Target::Existing(chat) = target {
                if self.backend.read_only() {
                    self.refuse(format!("set the permission mode of {}", chat.key()));
                    return;
                }
                let job = self.backend.with_actions(&chat.project, None, move |actions| async move {
                    actions.set_permission_mode(chat.id, wire_mode(mode)).await.map(|_| None).map_err(|e| e.to_string())
                });
                self.spawn_job(job, cx);
            }
        }
    }

    /// A Chat's saved message count, from its summary.
    fn saved_count(&self, project: &str, id: u64) -> Option<usize> {
        self.store.read(|reducer| {
            let applied = reducer.state().ok()?;
            let open = applied.projects.iter().find(|o| o.project.path.as_ref() == project)?;
            Some(open.state.as_ref()?.sessions.get(&id)?.summary.as_ref()?.count)
        })
    }

    fn has_chat(&self, at: &ChatRef) -> bool {
        // A paired computer's Chat, as last read through `computers:invoke`.
        if let Backend::Daemon(daemon) = &self.backend
            && let Some((computer, _)) = at.project.split_once('|')
        {
            return daemon
                .remote(computer)
                .is_some_and(|remote| remote.states.get(&at.project).is_some_and(|state| state.state.sessions.contains_key(&at.id)));
        }
        self.store.read(|reducer| {
            reducer.state().ok().is_some_and(|applied| {
                applied.projects.iter().any(|open| {
                    open.project.path.as_ref() == at.project && open.state.as_ref().is_some_and(|s| s.sessions.contains_key(&at.id))
                })
            })
        })
    }

    /// Reads the open Chat's saved messages; they replace whatever the transcript shows.
    fn load(&mut self, cx: &mut Context<Self>) {
        let Some(open) = &self.open else { return };
        let (key, project, id) = (open.key.clone(), open.project.clone(), open.id);
        if self.preloaded.as_ref().is_some_and(|(k, _)| *k == key) {
            let (_, page) = self.preloaded.take().expect("preloaded");
            let count = self.saved_count(&project, id);
            self.open = Some(OpenChat { key, project, id, loaded: true, count, ..OpenChat::default() });
            let items = crate::transcript::saved_items(&page);
            let transcript = self.workspace.read(cx).chat.read(cx).transcript.clone();
            transcript.update(cx, |t, cx| t.set_items(items, cx));
            self.sync_tail(cx);
            self.refresh_limit_cards(cx);
            return;
        }
        let Some(source) = cx.try_global::<Data>().map(|data| data.0.clone()) else { return };
        let count = self.saved_count(&project, id);
        let scope = ScopeKey::project(LOCAL, &project);
        let task = cx.spawn(async move |this, cx| {
            let page = source.chat_messages(scope, id, PageRequest::OPEN).await;
            let _ = this.update(cx, |this, cx| match page {
                Ok(page) => {
                    let Some(open) = this.open.as_mut().filter(|open| open.key == key) else { return };
                    *open =
                        OpenChat { key: open.key.clone(), project: open.project.clone(), id, loaded: true, count, ..OpenChat::default() };
                    let items = crate::transcript::saved_items(&page);
                    let transcript = this.workspace.read(cx).chat.read(cx).transcript.clone();
                    transcript.update(cx, |t, cx| t.set_items(items, cx));
                    this.sync_tail(cx);
                    this.refresh_limit_cards(cx);
                }
                Err(error) => this.error(format!("chat:messages {key}: {error:#}")),
            });
        });
        task.detach();
    }

    /// Reads the Worktree's changes for the open Chat's panel (one read at a time; one more if asked meanwhile).
    /// Off in read-only mode: on Milagre's daemon a Git read needs the Project's view opened.
    pub fn read_changes(&mut self, cx: &mut Context<Self>) {
        if self.backend.read_only() {
            return;
        }
        if self.reading_git {
            self.git_again = true;
            return;
        }
        let Some((key, project)) = self.open.as_ref().map(|open| (open.key.clone(), open.project.clone())) else { return };
        self.reading_git = true;
        self.git_project = Some(project.clone());
        let read = self.backend.read_git(&project);
        cx.spawn(async move |this, cx| {
            let data = read.await;
            let _ = this.update(cx, |this, cx| {
                this.reading_git = false;
                match data {
                    Ok(data) => {
                        let panel = this.workspace.read(cx).panel.clone();
                        panel.update(cx, |panel, cx| panel.set_live_changes(key.into(), data, cx));
                    }
                    Err(error) => {
                        this.git_project = None;
                        this.error(format!("Couldn't read the Worktree's changes: {error}"))
                    }
                }
                if std::mem::take(&mut this.git_again) {
                    this.read_changes(cx);
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn on_store_changed(&mut self, cx: &mut Context<Self>) {
        let sidebar = self.workspace.read(cx).sidebar.clone();
        sidebar.update(cx, |sidebar, cx| sidebar.reload(cx));
        self.sync_unloaded(cx);
        // A scheduled continuation, a run starting or ending: what the limit card offers.
        self.refresh_limit_cards(cx);
        if let Some(key) = self.pending_open.clone()
            && sidebar.read(cx).row_keys().contains(&key)
        {
            self.pending_open = None;
            self.workspace.update(cx, |w, cx| w.open_chat_key(&key, cx));
            // The window follows its sidebar when it draws; do it now, so the Chat opens even with no frame.
            if let Some(row) = sidebar.read(cx).selected_row().cloned() {
                let chat = self.workspace.read(cx).chat.clone();
                let _ = self.window.update(cx, |_, window, cx| chat.update(cx, |chat, cx| chat.set_chat(&row, window, cx)));
            }
        }
        self.follow_unread(cx);
        // A Chat that just got its first messages can now be the composer's target.
        self.follow_chat(cx);
        // The new-Chat screen's Projects and Worktrees follow the state too.
        self.follow_new_chat(cx);
        self.sync_tail(cx);
        self.refresh_panels(cx);
    }

    /// The open Chat's run on screen: the streamed text, its cards, the running row and the queue.
    fn sync_tail(&mut self, cx: &mut Context<Self>) {
        let Some(open) = self.open.as_ref().filter(|open| open.loaded) else { return };
        let (key, project, id) = (open.key.clone(), open.project.clone(), open.id);
        let (run, queued, held) = self.store.read(|reducer| {
            let Ok(applied) = reducer.state() else { return (None, Vec::new(), false) };
            let chat = applied
                .projects
                .iter()
                .find(|o| o.project.path.as_ref() == project)
                .and_then(|o| o.state.as_ref())
                .and_then(|s| s.sessions.get(&id));
            (applied.runs.get(&key).cloned(), chat.map(|c| c.queued.clone()).unwrap_or_default(), chat.is_some_and(|c| c.queue_held))
        });
        let chat = self.workspace.read(cx).chat.clone();
        let (composer, transcript) = chat.read_with(cx, |c, _| (c.composer.clone(), c.transcript.clone()));
        composer.update(cx, |c, cx| c.set_queue(queued, held, cx));
        match run {
            Some(run) => self.show_run(&run, cx),
            None if self.open.as_ref().is_some_and(|open| open.live) => {
                let open = self.open.as_mut().expect("open");
                open.live = false;
                if let Some((ix, _)) = open.stream.take() {
                    transcript.update(cx, |t, cx| t.finish_stream(ix, cx));
                }
                self.set_running(None, cx);
                // The saved reply (and its steps) replace the live tail; the turn may have changed the Worktree. Its
                // ports and its PR follow the daemon's `agent:ports` and `pull-requests:changed` events instead.
                self.load(cx);
                self.read_changes(cx);
            }
            None => {
                self.set_running(None, cx);
                // Saved messages this window has not read: read them again.
                let count = self.saved_count(&project, id);
                if count.is_some() && self.open.as_ref().is_some_and(|open| open.count != count) {
                    self.load(cx);
                }
            }
        }
    }

    fn show_run(&mut self, run: &AgentRun, cx: &mut Context<Self>) {
        let started = run.started_at.map(|at| Duration::from_millis((crate::transcript::now_ms() - at).max(0) as u64));
        self.set_running(Some(started.unwrap_or_default()), cx);
        let transcript = self.workspace.read(cx).chat.read(cx).transcript.clone();
        let open = self.open.as_mut().expect("open");
        open.live = true;
        for request in &run.approvals {
            let id = request.request_id.to_string();
            if !open.approvals.iter().any(|(r, _)| *r == id) {
                let item = crate::transcript::approval_item(request, &run.steps);
                if let milagre_gpui_spike::workspace::chat::transcript::Item::Approval(approval) = &item {
                    open.approval_steps.push(approval.step.id.clone());
                }
                let ix = transcript.update(cx, |t, cx| {
                    t.push(item, cx);
                    t.items().len() - 1
                });
                open.approvals.push((id, ix));
            }
        }
        for request in &run.questions {
            let id = request.request_id.to_string();
            if !open.questions.iter().any(|(r, _)| *r == id) {
                let item = crate::transcript::question_item(request);
                let ix = transcript.update(cx, |t, cx| {
                    t.push(item, cx);
                    t.items().len() - 1
                });
                open.questions.push((id, ix));
            }
        }
        // An approval answered elsewhere (or by the agent's end of it) settles as the run recorded it.
        let mut settle = Vec::new();
        for (request, ix) in &open.approvals {
            if run.approvals.iter().any(|r| r.request_id.as_ref() == request) {
                continue;
            }
            let state = match run.answered.get(request.as_str()) {
                Some(milagre_gpui_spike::data::SentAnswer::AllowForChat) => ApprovalState::AlwaysAllowed,
                Some(milagre_gpui_spike::data::SentAnswer::Deny) => ApprovalState::Denied,
                _ => ApprovalState::Allowed,
            };
            settle.push((request.clone(), *ix, state));
        }
        // The run's tool calls as they start, run and end: folds, as Electron's streaming `ActivityBlock`. A fold
        // that opens under new text shows that text first.
        let now = crate::transcript::now_ms();
        let run_text = run.text.to_string();
        for op in crate::transcript::run_folds(&run.steps, &open.folds, &run_text, &open.approval_steps) {
            match op {
                crate::transcript::FoldOp::Join(n, id) => open.folds[n].1.push(id),
                crate::transcript::FoldOp::New(id, text_at) => {
                    let shown = open.stream.map_or(0, |(_, shown)| shown);
                    if text_at > shown && run_text.is_char_boundary(shown) && !run_text[shown..text_at].trim().is_empty() {
                        let ix = match open.stream {
                            Some((ix, _)) => ix,
                            None => transcript.update(cx, |t, cx| t.begin_stream(cx)),
                        };
                        transcript.update(cx, |t, cx| t.stream(ix, &run_text[shown..text_at], cx));
                        open.stream = Some((ix, text_at));
                    }
                    let ix = transcript.update(cx, |t, cx| {
                        t.push(crate::transcript::live_fold(now), cx);
                        t.items().len() - 1
                    });
                    open.folds.push((ix, vec![id]));
                }
            }
        }
        let last = open.folds.len();
        let waiting: Vec<gpui::SharedString> = run.approvals.iter().filter_map(|r| r.step_id.clone()).collect();
        let running = run.steps.iter().any(|step| step.status == milagre_gpui_spike::data::StepStatus::Running);
        for (n, (ix, ids)) in open.folds.iter().enumerate() {
            let entries = crate::transcript::fold_entries(&run.steps, ids);
            let (ix, waiting) = (*ix, waiting.clone());
            transcript.update(cx, |t, cx| t.update_activity(ix, entries, n + 1 == last, waiting, now, cx));
        }
        if running && self.fold_clock.is_none() {
            self.fold_clock = Some(cx.spawn(async move |this, cx| {
                loop {
                    cx.background_executor().timer(Duration::from_secs(1)).await;
                    let Ok(going) = this.update(cx, |this, cx| this.tick_folds(cx)) else { break };
                    if !going {
                        break;
                    }
                }
            }));
        }
        let open = self.open.as_mut().expect("open");
        let text = run.text.to_string();
        let (stream, shown) = match open.stream {
            Some((ix, shown)) => (Some(ix), shown),
            None => (None, 0),
        };
        for (request, ix, state) in settle {
            if self.answered.insert(request) {
                transcript.update(cx, |t, cx| t.resolve(ix, state, cx));
            }
        }
        if text.len() > shown && text.is_char_boundary(shown) {
            let ix = match stream {
                Some(ix) => ix,
                None => transcript.update(cx, |t, cx| t.begin_stream(cx)),
            };
            transcript.update(cx, |t, cx| t.stream(ix, &text[shown..], cx));
            self.open.as_mut().expect("open").stream = Some((ix, text.len()));
        }
    }

    /// One tick of the live folds' clock: running steps count on. False (and the clock stops) once nothing runs.
    fn tick_folds(&mut self, cx: &mut Context<Self>) -> bool {
        let Some(open) = self.open.as_ref().filter(|open| open.live && !open.folds.is_empty()) else {
            self.fold_clock = None;
            return false;
        };
        let transcript = self.workspace.read(cx).chat.read(cx).transcript.clone();
        let now = crate::transcript::now_ms();
        let folds: Vec<usize> = open.folds.iter().map(|(ix, _)| *ix).collect();
        let running = transcript.update(cx, |t, cx| t.tick_activities(&folds, now, cx));
        if !running {
            self.fold_clock = None;
        }
        running
    }

    fn set_running(&mut self, elapsed: Option<Duration>, cx: &mut Context<Self>) {
        let chat = self.workspace.read(cx).chat.clone();
        let shown = chat.read(cx).running.is_some();
        if shown == elapsed.is_some() {
            return;
        }
        chat.update(cx, |chat, cx| {
            chat.running = elapsed.map(|elapsed| cx.new(|_| RunningRow::new(elapsed)));
            let running = chat.running.is_some();
            chat.transcript.update(cx, |t, cx| t.set_running_row(running, cx));
            chat.composer.update(cx, |c, cx| c.set_running(running, cx));
            cx.notify();
        });
    }

    // ---- Writes ----

    /// A write this read-only window does not make: recorded and logged, nothing sent.
    fn refuse(&mut self, what: String) {
        eprintln!("live: read-only, not sent: {what}");
        self.refused.push(what);
    }

    fn decide(&mut self, decision: &CardDecision, cx: &mut Context<Self>) {
        let Some(open) = &self.open else { return };
        let chat = ChatRef { project: open.project.clone(), id: open.id };
        match decision {
            CardDecision::Approval { ix, state } => {
                let Some((request, _)) = open.approvals.iter().find(|(_, at)| at == ix).cloned() else { return };
                if !self.answered.insert(request.clone()) {
                    return;
                }
                let decision = match state {
                    ApprovalState::AlwaysAllowed => PermissionDecision::AllowForChat,
                    ApprovalState::Denied => PermissionDecision::Deny,
                    _ => PermissionDecision::AllowOnce,
                };
                if self.backend.read_only() {
                    return self.refuse(format!("permission {request} {decision:?}"));
                }
                self.decisions.push((request.clone(), format!("{decision:?}")));
                let job = self.backend.with_actions(&chat.project, None, move |actions| async move {
                    match actions.respond_permission(chat.id, &request, decision).await {
                        Ok(Value::Bool(true)) => Ok(None),
                        Ok(other) => Err(format!("permission {request}: the runtime answered {other}")),
                        Err(error) => Err(format!("permission {request}: {error}")),
                    }
                });
                self.spawn_job(job, cx);
            }
            CardDecision::Question { request_id, answers, .. } => {
                let request = request_id.to_string();
                if !self.answered.insert(request.clone()) {
                    return;
                }
                if self.backend.read_only() {
                    return self.refuse(format!("question {request}"));
                }
                let answers = answers.clone().map(|answers| answers.into_iter().collect::<BTreeMap<_, _>>());
                let job = self.backend.with_actions(&chat.project, None, move |actions| async move {
                    actions
                        .answer_question(chat.id, &request, answers, None)
                        .await
                        .map(|_| None)
                        .map_err(|e| format!("question {request}: {e}"))
                });
                self.spawn_job(job, cx);
            }
            CardDecision::LimitSwitch { ix, account_id, label } => {
                let Some(accounts) = self.accounts.clone() else { return };
                let provider = self.limit_provider(*ix, cx).unwrap_or(Provider::Claude);
                let (ix, account_id, label) = (*ix, account_id.clone(), label.clone());
                accounts.update(cx, |a, cx| a.limit_switch(ix, (chat.project, chat.id), provider, account_id, label, cx));
            }
            CardDecision::LimitResume { ix, cancel } => {
                let Some(accounts) = self.accounts.clone() else { return };
                let (source, send_id) = self.store.read(|reducer| {
                    let applied = reducer.state().ok();
                    let chat = applied.as_ref().and_then(|a| crate::panels::find(&a.projects, &open.key)).map(|(_, c)| c.clone());
                    let resume = chat.as_ref().and_then(|c| c.limit_resume.clone());
                    (chat.and_then(|c| c.limit_turn), resume.map(|r| r.send_id.to_string()))
                });
                let ix = *ix;
                let cancel = if *cancel { send_id } else { None };
                let source = source.unwrap_or_default();
                accounts.update(cx, |a, cx| a.limit_resume(ix, (chat.project, chat.id), cancel, source, cx));
            }
            CardDecision::OpenAccounts => crate::accounts::open_settings(&self.workspace, self.window, cx),
        }
    }

    /// The provider of the usage-limit card at item `ix`.
    fn limit_provider(&self, ix: usize, cx: &App) -> Option<Provider> {
        let transcript = self.workspace.read(cx).chat.read(cx).transcript.clone();
        match transcript.read(cx).items().get(ix) {
            Some(Item::Card(milagre_gpui_spike::workspace::chat::transcript::cards::Card::Limit(card))) => Some(card.limit.provider),
            _ => None,
        }
    }

    /// What the open Chat's usage-limit cards may offer (`ChatComposer.tsx`): the `limitTurn` reply's card (else the
    /// last message's), while nothing is sending, with the Project's other accounts and "Continue at" when supported.
    fn limit_info(&self, cx: &App) -> crate::transcript::LimitInfo {
        let Some(open) = &self.open else { return Default::default() };
        let Some(accounts) = self.accounts.as_ref().map(|a| a.read(cx)) else { return Default::default() };
        let chat = self.store.read(|reducer| {
            let applied = reducer.state().ok()?;
            let running = applied.runs.get(&open.key).is_some();
            crate::panels::find(&applied.projects, &open.key).map(|(_, chat)| (chat.clone(), running))
        });
        let Some((chat, running)) = chat else { return Default::default() };
        let transcript = self.workspace.read(cx).chat.read(cx).transcript.clone();
        let last = transcript.read(cx).items().iter().rev().find_map(|item| match item {
            Item::Card(milagre_gpui_spike::workspace::chat::transcript::cards::Card::Limit(card)) => card.message,
            _ => None,
        });
        let limit = transcript.read(cx).items().iter().find_map(|item| match item {
            Item::Card(milagre_gpui_spike::workspace::chat::transcript::cards::Card::Limit(card)) => Some(card.limit.clone()),
            _ => None,
        });
        let interactive = if running { None } else { chat.limit_turn.or(last) };
        let choices =
            limit.map(|limit| crate::accounts::choices(accounts.groups(), &limit, crate::transcript::now_ms())).unwrap_or_default();
        let resume = (accounts.resume_supported() && chat.queued.is_empty()).then_some(chat.limit_turn).flatten();
        crate::transcript::LimitInfo {
            interactive,
            choices,
            pending: chat.limit_resume.as_ref().map(|r| (r.source_message_id, r.at.to_string())),
            resume,
            live: true,
        }
    }

    /// Lays the latest [`Self::limit_info`] over the open Chat's limit cards.
    fn refresh_limit_cards(&mut self, cx: &mut Context<Self>) {
        if self.accounts.is_none() {
            return;
        }
        let info = self.limit_info(cx);
        let transcript = self.workspace.read(cx).chat.read(cx).transcript.clone();
        transcript.update(cx, |t, cx| t.update_limit_cards(|_, card| crate::transcript::apply_limit(card, &info), cx));
    }

    fn spawn_job(&mut self, job: Job, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            let result = job.await;
            let _ = this.update(cx, |this, cx| this.finished(result, cx));
        })
        .detach();
    }

    /// The Project a new Chat starts in: the owned one, or (the daemon) the sidebar's (the selected row's Project,
    /// else the first listed).
    fn new_chat_project(&self, cx: &App) -> Option<String> {
        match &self.backend {
            Backend::Owned { project, .. } => Some(project.clone()),
            Backend::Daemon(_) => {
                let sidebar = self.workspace.read(cx).sidebar.read(cx);
                let at = sidebar.selected_row().and_then(|row| chat_ref(None, &row.key)).map(|at| at.project);
                at.or_else(|| {
                    let name = sidebar.new_chat_project()?;
                    self.store.read(|reducer| {
                        let applied = reducer.state().ok()?;
                        let mut projects = applied.projects.iter().filter(|o| !o.project.is_chats_home());
                        projects.find(|o| o.project.name.as_ref() == name).map(|o| o.project.path.to_string())
                    })
                })
            }
        }
    }

    /// The action a command stands for, ready to run.
    fn job(&mut self, command: Command, cx: &App) -> Option<Job> {
        if self.backend.read_only() {
            self.refuse(format!("{command:?}"));
            return None;
        }
        let backend = self.backend.clone();
        Some(match command {
            // Milagre's daemon: a new Chat goes where the tray says (`new_chat.rs`).
            Command::Send { target: Target::NewChat, text, queue, mode, effort, model, new_chat: Some(choice), attachments }
                if matches!(backend, Backend::Daemon(_)) =>
            {
                return self.new_chat_job(*choice, text, queue, mode, effort, model, attachments, cx);
            }
            Command::Send { attachments, .. } if !attachments.is_empty() && !matches!(backend, Backend::Daemon(_)) => {
                self.error("Attachments are not available on this runtime yet".into());
                return None;
            }
            Command::Send { target: Target::Existing(chat), text, queue, mode, effort, model, attachments, .. }
                if !attachments.is_empty() && !chat.project.contains('|') =>
            {
                // Electron's `chat:send` with its images, files and prompt (the client's send takes text only).
                let Backend::Daemon(daemon) = backend else { return None };
                self.sent += 1;
                let id = format!("gpui-{}-{}-{}", std::process::id(), crate::transcript::now_ms(), self.sent);
                let worktree = self.store.read(|reducer| {
                    let applied = reducer.state().ok()?;
                    let (_, session) = crate::panels::find(&applied.projects, &chat.key())?;
                    Some(session.worktree_id)
                });
                let mut request = serde_json::json!({
                    "projectPath": chat.project,
                    "worktreeId": worktree.unwrap_or(1),
                    "sessionId": chat.id,
                    "provider": model.0.id(),
                    "model": model.1,
                    "body": text,
                    "clientMessageId": id,
                    "permissionMode": crate::sinks::wire_name(mode),
                    "replies": "concise",
                    "tldrEnabled": true,
                    "ultracode": false,
                    "fastMode": false,
                });
                if let Some(effort) = effort {
                    request["effort"] = serde_json::json!(effort);
                }
                if queue {
                    request["delivery"] = serde_json::json!("queue");
                }
                attachments.apply(&mut request, &text);
                let (daemon, provider) = (daemon.clone(), model.0);
                Box::pin(async move {
                    let writer = daemon.writer(&chat.project).await.map_err(|e| format!("{e:#}"))?;
                    if request["model"].as_str().is_none_or(str::is_empty) {
                        let model = writer
                            .recommended_model(provider.id())
                            .await
                            .map_err(|e| format!("{e:#}"))?
                            .ok_or_else(|| format!("Milagre recommends no {} model: nothing was sent", provider.name()))?;
                        request["model"] = Value::String(model);
                    }
                    let receipt = writer.call("chat:send", serde_json::json!([request])).await.map_err(|e| format!("send {id}: {e:#}"))?;
                    drop(writer);
                    Ok(Some(Done::Sent { id, receipt, open: None }))
                })
            }
            Command::Send { target, text, queue, mode, effort, model, .. } => {
                let (project, send_target) = match target {
                    Target::NewChat => match self.new_chat_project(cx) {
                        Some(project) => (project, SendTarget::NewProjectChat),
                        None => {
                            self.error("No Project to start the Chat in: nothing was sent".into());
                            return None;
                        }
                    },
                    // Another computer's Chat is read here; its writes go through Milagre for now.
                    Target::Existing(chat) if chat.project.contains('|') => {
                        self.error("Sending to another computer's Chat isn't in this preview yet: open it in Milagre".into());
                        return None;
                    }
                    Target::Existing(chat) => (chat.project, SendTarget::Existing(chat.id)),
                    Target::None => {
                        self.error("No Chat of this runtime is open: nothing was sent".into());
                        return None;
                    }
                };
                self.sent += 1;
                let id = format!("gpui-{}-{}-{}", std::process::id(), crate::transcript::now_ms(), self.sent);
                let options =
                    SendOptions { permission_mode: wire_mode(mode), effort: effort.map(str::to_owned), queue, ..SendOptions::default() };
                let open_project = project.clone();
                backend.with_actions(&project, Some(model), move |actions| async move {
                    let receipt = actions.send(send_target, &text, &id, options).await.map_err(|e| format!("send {id}: {e}"))?;
                    let open = (send_target == SendTarget::NewProjectChat)
                        .then(|| receipt["sessionId"].as_u64().map(|chat| format!("{open_project}#{chat}")))
                        .flatten();
                    Ok(Some(Done::Sent { id, receipt, open }))
                })
            }
            Command::Interrupt(chat) => backend.with_actions(&chat.project, None, move |actions| async move {
                actions.interrupt(chat.id).await.map(|_| None).map_err(|e| format!("interrupt: {e}"))
            }),
            Command::SendQueuedNow { chat, id } => backend.with_actions(&chat.project, None, move |actions| async move {
                actions.send_queued_now(chat.id, &id).await.map(|_| None).map_err(|e| format!("send queued {id}: {e}"))
            }),
            Command::RemoveQueued { chat, id } => backend.with_actions(&chat.project, None, move |actions| async move {
                actions.remove_queued(chat.id, &id).await.map(|_| None).map_err(|e| format!("remove queued {id}: {e}"))
            }),
            Command::MarkUnread { chat, unread } => backend.with_actions(&chat.project, None, move |actions| async move {
                let what = if unread { "unread" } else { "read" };
                actions
                    .mark_unread(chat.id, unread)
                    .await
                    .map(|_| Some(Done::Sidebar))
                    .map_err(|e| format!("Couldn't mark the Chat {what}: {e}"))
            }),
            Command::MarkDone { chat, done } => backend.with_sidebar(&chat.project, move |sidebar| async move {
                let what = if done { "move the Chat to Done" } else { "reopen the Chat" };
                sidebar.mark_done(chat.id, done).await.map(|_| Some(Done::Sidebar)).map_err(|e| format!("Couldn't {what}: {e}"))
            }),
            Command::Rename { chat, title } => backend.with_sidebar(&chat.project, move |sidebar| async move {
                sidebar.rename(chat.id, &title).await.map(|_| Some(Done::Sidebar)).map_err(|e| format!("Couldn't rename the Chat: {e}"))
            }),
            Command::Refused(message) => {
                self.error(message);
                return None;
            }
        })
    }

    fn finished(&mut self, result: Result<Option<Done>, String>, cx: &mut Context<Self>) {
        match result {
            Ok(Some(Done::Sent { id, receipt, open })) => {
                self.receipts.push((id, receipt));
                if let Some(key) = open {
                    self.pending_open = Some(key);
                    self.on_store_changed(cx);
                }
            }
            Ok(Some(Done::Sidebar)) => {
                let sidebar = self.workspace.read(cx).sidebar.clone();
                sidebar.update(cx, |s, cx| s.set_notice(None, cx));
            }
            Ok(None) => {}
            Err(error) => {
                // A refused or lost write: the rows go back to what the runtime holds, and the sidebar says why.
                let sidebar = self.workspace.read(cx).sidebar.clone();
                sidebar.update(cx, |s, cx| {
                    s.reload(cx);
                    s.set_notice(Some(error.clone().into()), cx);
                });
                self.error(error);
            }
        }
        cx.notify();
    }

    fn error(&mut self, error: String) {
        eprintln!("live: {error}");
        self.errors.push(error);
    }
}

enum Done {
    Sent {
        id: String,
        receipt: Value,
        open: Option<String>,
    },
    /// A sidebar write the runtime took.
    Sidebar,
}

type Job = Local<Option<Done>>;

/// The live stream a window follows.
enum Stream {
    Owned(Notifications),
    /// The daemon's: the first sync's stream (`None` when there was no daemon yet), synced again when it ends.
    Daemon {
        daemon: Arc<Daemon>,
        first: Option<Notifications>,
    },
}

/// The transcript's items as lines (tests and evidence).
pub fn shown_items(items: &[Item]) -> Vec<String> {
    items.iter().map(crate::transcript::describe).collect()
}

/// The live stream's channels the controller follows besides the reducer: Details' ports, the PR poll and the
/// accounts change (Electron's renderer listens to the same), and what the notifier needs.
pub const TAPPED: &[&str] = &[
    "agent:ports",
    "pull-requests:changed",
    "accounts:changed",
    "canvas:links-changed",
    "agent:event",
    "notification:waiting",
    "computers:changed",
    "computers:event",
    "computers:forgotten",
];

/// [`LiveStore::pump`] that also hands the [`TAPPED`] channels' events to `tap` before the reducer applies them.
async fn pump_tapped(store: &LiveStore, notifications: &mut Notifications, tap: &UnboundedSender<(String, Value)>) -> crate::SyncError {
    loop {
        let Some(notice) = notifications.next().await else { return crate::SyncError::Closed(milagre_daemon_client::Error::Disconnected) };
        if let milagre_daemon_client::Notice::Event { channel, payload, .. } = &notice
            && TAPPED.contains(&channel.as_str())
        {
            let _ = tap.unbounded_send((channel.clone(), payload.clone()));
        }
        match store.apply_notice(notice) {
            Ok(_) | Err(crate::SyncError::StaleEvent { .. } | crate::SyncError::OutOfOrder { .. }) => {}
            Err(error) => return error,
        }
    }
}

/// What the notifier shows for a Chat: its title (named, generated, its first line, else its Project's name) and
/// whether its Project is hidden from the sidebar.
/// A paired computer's Chat for a notification: its title from the last read of that computer, else its Project's
/// name, else the computer's.
fn remote_chat_info(daemon: Option<&Daemon>, computer: &str, key: &str) -> crate::notify::ChatInfo {
    let title = daemon.and_then(|daemon| {
        let remote = daemon.remote(computer)?;
        let (scope, id) = key.rsplit_once('#')?;
        let id: u64 = id.parse().ok()?;
        let state = remote.states.get(scope)?;
        let chat = state.state.sessions.get(&id)?;
        chat.title.clone().or_else(|| chat.generated_title.clone()).or_else(|| chat.summary.as_ref().and_then(|s| s.title_line.clone()))
    });
    crate::notify::ChatInfo { title: title.map(|t| t.to_string()).unwrap_or_default(), hidden: false }
}

fn chat_info(store: &LiveStore, key: &str, cx: &App) -> crate::notify::ChatInfo {
    let project = key.rsplit_once('#').map_or(key, |(path, _)| path).to_owned();
    let title = store.read(|reducer| {
        let applied = reducer.state().ok()?;
        let (open, chat) = crate::panels::find(&applied.projects, key)?;
        let title = chat
            .title
            .clone()
            .or_else(|| chat.generated_title.clone())
            .or_else(|| chat.summary.as_ref().and_then(|s| s.title_line.clone()))
            .map(|t| t.to_string())
            .unwrap_or_else(|| open.project.name.to_string());
        Some(title)
    });
    crate::notify::ChatInfo { title: title.unwrap_or_default(), hidden: crate::sidebar_writes::is_hidden(cx, &project) }
}

/// The newest Chat whose PR poll names a PR: its key, Worktree folder and the PR its panel shows.
pub fn newest_with_pr(store: &LiveStore, prs: &HashMap<String, Value>) -> Option<(String, String, u32)> {
    store.read(|reducer| {
        let applied = reducer.state().ok()?;
        applied
            .projects
            .iter()
            .filter_map(|open| Some((open, open.state.as_ref()?, prs.get(open.project.path.as_ref())?)))
            .flat_map(|(open, state, prs)| {
                state.sessions.values().filter(|chat| !chat.archived).filter_map(move |chat| {
                    let folder = state.worktree_of(chat)?.path.to_string();
                    let number = crate::panels::panel_pull_request(prs, &folder, chat, None)?;
                    let at = chat.summary.as_ref().and_then(|s| s.last_at).unwrap_or(0);
                    Some((at, (open.project.scope().chat_key(chat.id), folder, number)))
                })
            })
            .max_by_key(|(at, _)| *at)
            .map(|(_, found)| found)
    })
}

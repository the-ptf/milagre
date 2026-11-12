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
//! - Not available here, so off or refused: attachments, steering (follow-ups queue), compact, switching models,
//!   Worktree and computer creation (the sidebar records those calls and sends nothing).
//!
//! Two backends ([`Backend`]): the owned runtime (one Project, one connection, its model fixed) and Milagre's running
//! Node daemon ([`crate::daemon`], the Preview's default): every Project the daemon has loaded, each Chat on its own
//! provider and model (a new Chat on the composer's), each write on a short connection of the Chat's Project, and a
//! lost stream (the daemon restarted, quit, or sent another Project's oversized state) followed by a new sync, with
//! "Open Milagre first" while there is no daemon. In read-only mode (`--snapshot`) every write is refused here,
//! before it reaches a connection.

use std::collections::{BTreeMap, HashSet};
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
use milagre_gpui_spike::workspace::sidebar::{Actions, RecordingActions, SidebarSeed};
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
                    let (provider, model) = model.unwrap_or((Provider::Claude, "default".into()));
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

    /// The Project's Changes (the daemon: a short connection that has to open the Project's view first).
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
                let error = Some(notice_for(&error));
                DaemonSession { daemon, store: LiveStore::new(crate::Reducer::default()), notifications: None, error, terminals }
            }
        }
    }
}

/// What the sidebar says when a sync failed.
fn notice_for(error: &anyhow::Error) -> String {
    if crate::daemon::unavailable(error) {
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
    cx.set_global(Data(Arc::new(LiveSource::daemon(session.store.clone(), session.daemon.clone()))));
    cx.set_global(Actions(Arc::new(LiveSidebarActions { project: None, commands: commands.clone(), recorded: recorded.clone() })));
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
    preloaded: Option<(String, milagre_gpui_spike::data::MessagePage)>,
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
        let controller = Self::wire(workspace, backend, store, Stream::Daemon { daemon, first: notifications }, None, wiring, window, cx);
        if let Some(error) = error {
            controller.update(cx, |this, cx| this.set_unavailable(Some(error), cx));
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
        let (composer, transcript) = chat.read_with(cx, |c, _| (c.composer.clone(), c.transcript.clone()));
        composer.update(cx, |composer, cx| {
            composer.set_sink(Some(Rc::new(LiveSink { state: sink.clone(), commands: commands.clone() })));
            match &fixed_model {
                Some(model) => {
                    composer.set_limits(ComposerLimits { attachments: false, model_locked: true }, cx);
                    composer.set_model(Provider::Claude, model, model, None, cx);
                }
                // Milagre's daemon: a new Chat picks its model; an open Chat shows (and keeps) its own.
                None => composer.set_limits(ComposerLimits { attachments: false, model_locked: false }, cx),
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
                    cx.spawn(async move |this: gpui::WeakEntity<Self>, cx: &mut gpui::AsyncApp| {
                        let mut notifications = first;
                        let mut wait = Duration::ZERO;
                        loop {
                            if let Some(mut stream) = notifications.take() {
                                let error = store.pump(&mut stream).await;
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
                                    let notice = notice_for(&error);
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
                preloaded,
                _subscriptions: subscriptions,
                _tasks: vec![pump, follow, run],
            };
            this.follow_chat(cx);
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
        if nothing_open && let Some(key) = newest_chat(&self.store, None) {
            self.pending_open = Some(key);
        }
        // A daemon that restarted: the open Chat's transcript is read again from it.
        if self.open.is_some() {
            let open = self.open.as_mut().expect("open");
            open.loaded = false;
            self.load(cx);
        }
        self.on_store_changed(cx);
        cx.notify();
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
        let key = if new_chat { None } else { key.filter(|_| at.is_some()) };
        if key.as_deref() == self.open_key() {
            return;
        }
        self.open = key.zip(at).map(|(key, at)| OpenChat { key, project: at.project, id: at.id, ..OpenChat::default() });
        if self.open.is_some() {
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
    }

    /// Milagre's daemon: the composer shows the open Chat's own provider, model and permission mode (locked: a send
    /// keeps them), or on the new-Chat screen the picker's choice (unlocked).
    fn follow_model(&mut self, new_chat: bool, at: Option<&ChatRef>, cx: &mut Context<Self>) {
        let composer = self.workspace.read(cx).chat.read(cx).composer.clone();
        if new_chat || at.is_none() {
            composer.update(cx, |c, cx| c.set_limits(ComposerLimits { attachments: false, model_locked: false }, cx));
            let model = composer.read(cx).model();
            *self.sink.model.borrow_mut() = (model.0, model.1.to_string());
            return;
        }
        let at = at.expect("a Chat");
        let (provider, model, mode) = self
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
        // Set before the composer changes, so following it sends no permission-mode write.
        self.mode = mode;
        self.sink.mode.set(mode);
        *self.sink.model.borrow_mut() = (provider, model.clone().unwrap_or_default());
        composer.update(cx, |c, cx| {
            let id = model.clone().unwrap_or_default();
            let name = milagre_gpui_spike::workspace::chat::composer::models::find(provider, &id)
                .map(|m| m.name.to_string())
                .unwrap_or_else(|| if id.is_empty() { provider.name().to_owned() } else { id.clone() });
            c.set_model(provider, &id, &name, None, cx);
            c.set_permission_mode(mode, cx);
            c.set_limits(ComposerLimits { attachments: false, model_locked: true }, cx);
        });
    }

    fn follow_composer(&mut self, composer: &Entity<milagre_gpui_spike::workspace::chat::composer::Composer>, cx: &mut Context<Self>) {
        let (mode, effort, model) = composer.read_with(cx, |c, _| (c.permission_mode(), c.effort_id(), c.model()));
        self.sink.mode.set(mode);
        self.sink.effort.set(effort);
        if matches!(self.backend, Backend::Daemon(_)) && *self.sink.target.borrow() == Target::NewChat {
            *self.sink.model.borrow_mut() = (model.0, model.1.to_string());
        }
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
        // A Chat that just got its first messages can now be the composer's target.
        self.follow_chat(cx);
        self.sync_tail(cx);
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
                // The saved reply (and its steps) replace the live tail; the turn may have changed the Worktree.
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
        }
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
            Command::Send { target, text, queue, mode, effort, model } => {
                let (project, send_target) = match target {
                    Target::NewChat => match self.new_chat_project(cx) {
                        Some(project) => (project, SendTarget::NewProjectChat),
                        None => {
                            self.error("No Project to start the Chat in: nothing was sent".into());
                            return None;
                        }
                    },
                    Target::Existing(chat) => (chat.project, SendTarget::Existing(chat.id)),
                    Target::None => {
                        self.error("No Chat of this runtime is open: nothing was sent".into());
                        return None;
                    }
                };
                if matches!(backend, Backend::Daemon(_)) && model.1.is_empty() {
                    self.error("This Chat's model isn't known here: send from Milagre. Nothing was sent".into());
                    return None;
                }
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

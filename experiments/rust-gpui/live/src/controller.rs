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

use std::collections::{BTreeMap, HashSet};
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt as _;
use futures::channel::mpsc::{UnboundedReceiver, UnboundedSender, unbounded};
use gpui::{App, AppContext as _, Context, Entity, Subscription, Task, Window};
use milagre_daemon_client::{ChatActions, Client, PermissionDecision, SendOptions, SendTarget};
use milagre_gpui_spike::data::{AgentRun, Data, LOCAL, PageRequest, PermissionMode, Provider, ScopeKey};
use milagre_gpui_spike::workspace::Workspace;
use milagre_gpui_spike::workspace::chat::composer::{ComposerLimits, Delivery};
use milagre_gpui_spike::workspace::chat::running::RunningRow;
use milagre_gpui_spike::workspace::chat::transcript::{ApprovalState, CardDecision, Item};
use milagre_gpui_spike::workspace::preview::PreviewMode;
use milagre_gpui_spike::workspace::sidebar::{Actions, RecordingActions, SidebarSeed};
use serde_json::Value;

use crate::session::Session;
use crate::sinks::{Command, LiveSidebarActions, LiveSink, SinkState, Target, chat_id, wire_mode};
use crate::source::LiveSource;
use crate::{DaemonAdapter, LiveStore};

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
        project: session.project.clone(),
        commands: commands.clone(),
        recorded: recorded.clone(),
    })));
    cx.set_global(SidebarSeed { open_chat: newest_chat(session) });
    // The Terminal drawer opens the runtime's PTYs, not this computer's.
    cx.set_global(milagre_gpui_spike::workspace::panel::terminal::remote::Host(session.terminals.clone()));
    // Everything the runtime does not back is off or labelled (`workspace::preview`).
    cx.set_global(PreviewMode { account: session.account_label.clone().into(), model: session.model.clone().into() });
    Wiring { commands, receiver, recorded, preloaded: None }
}

/// The listed Chat (it has messages) last active, to open on launch.
pub fn newest_chat(session: &Session) -> Option<String> {
    session.store.read(|reducer| {
        let applied = reducer.state().ok()?;
        let open = applied.projects.iter().find(|open| open.project.path.as_ref() == session.project)?;
        let state = open.state.as_ref()?;
        state
            .sessions
            .values()
            .filter(|chat| chat.summary.as_ref().is_some_and(|summary| summary.count > 0))
            .max_by_key(|chat| chat.summary.as_ref().and_then(|summary| summary.last_at).unwrap_or(0))
            .map(|chat| open.project.scope().chat_key(chat.id))
    })
}

/// The open Chat's live part, past its saved messages.
#[derive(Default)]
struct OpenChat {
    key: String,
    id: u64,
    loaded: bool,
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
    client: Client,
    actions: ChatActions,
    store: LiveStore,
    project: String,
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
    preloaded: Option<(String, milagre_gpui_spike::data::MessagePage)>,
    _subscriptions: Vec<Subscription>,
    _tasks: Vec<Task<()>>,
}

impl LiveController {
    /// Wires a live window: the composer's sink and limits, the fixed model, the event pump and the observers.
    pub fn attach(workspace: &Entity<Workspace>, mut session: Session, wiring: Wiring, window: &mut Window, cx: &mut App) -> Entity<Self> {
        let notifications = session.notifications.take().expect("the session's notifications");
        let Wiring { commands, receiver, preloaded, .. } = wiring;
        let sink = SinkState::default();
        let (chat, sidebar) = workspace.read_with(cx, |w, _| (w.chat.clone(), w.sidebar.clone()));
        let (composer, transcript) = chat.read_with(cx, |c, _| (c.composer.clone(), c.transcript.clone()));
        composer.update(cx, |composer, cx| {
            composer.set_sink(Some(Rc::new(LiveSink { state: sink.clone(), commands: commands.clone() })));
            composer.set_limits(ComposerLimits { attachments: false, model_locked: true }, cx);
            composer.set_model(Provider::Claude, &session.model, &session.model, None, cx);
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
                cx.observe(&composer, |this: &mut Self, composer, cx| this.follow_composer(&composer, cx)),
                cx.subscribe(&transcript, |this: &mut Self, _, decision: &CardDecision, cx| this.decide(decision, cx)),
            ];
            subscriptions.shrink_to_fit();
            let store = session.store.clone();
            let pump = cx.spawn(async move |this: gpui::WeakEntity<Self>, cx: &mut gpui::AsyncApp| {
                let mut notifications = notifications;
                let error = store.pump(&mut notifications).await;
                let _ = this.update(cx, |this, cx| {
                    this.closed = Some(error.to_string());
                    eprintln!("live: the event stream closed: {error}");
                    cx.notify();
                });
            });
            let mut versions = session.store.subscribe().expect("a subscriber slot");
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
                    let Ok(Some(job)) = this.update(cx, |this, _| this.job(command)) else { continue };
                    let result = job.await;
                    let _ = this.update(cx, |this, cx| this.finished(result, cx));
                }
            });
            let mut this = Self {
                workspace: workspace.clone(),
                window: window.window_handle(),
                client: session.client.clone(),
                actions: session.actions.clone(),
                store: session.store.clone(),
                project: session.project.clone(),
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
                preloaded,
                _subscriptions: subscriptions,
                _tasks: vec![pump, follow, run],
            };
            this.follow_chat(cx);
            this
        })
    }

    // ---- What tests and the app read ----

    /// Every send's client message id and the runtime's receipt, oldest first.
    pub fn receipts(&self) -> &[(String, Value)] {
        &self.receipts
    }

    pub fn decisions(&self) -> &[(String, String)] {
        &self.decisions
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

    /// Ends this window's connection (before the runtime is stopped).
    pub fn disconnect(&mut self) {
        self.client.disconnect();
    }

    pub fn client(&self) -> &Client {
        &self.client
    }

    pub fn actions(&self) -> &ChatActions {
        &self.actions
    }

    // ---- Following the views ----

    fn follow_chat(&mut self, cx: &mut Context<Self>) {
        let chat = self.workspace.read(cx).chat.clone();
        let (key, new_chat) = chat.read_with(cx, |c, _| (c.key().map(str::to_owned), c.is_new_chat()));
        let id = key.as_deref().and_then(|key| chat_id(&self.project, key)).filter(|id| self.has_chat(*id));
        self.sink.target.set(match (new_chat, id) {
            (true, _) => Target::NewChat,
            (false, Some(id)) => Target::Existing(id),
            (false, None) => Target::None,
        });
        let key = if new_chat { None } else { key.filter(|_| id.is_some()) };
        if key.as_deref() == self.open_key() {
            return;
        }
        self.open = key.zip(id).map(|(key, id)| OpenChat { key, id, ..OpenChat::default() });
        if self.open.is_some() {
            self.load(cx);
        }
    }

    fn follow_composer(&mut self, composer: &Entity<milagre_gpui_spike::workspace::chat::composer::Composer>, cx: &mut Context<Self>) {
        let (mode, effort) = composer.read_with(cx, |c, _| (c.permission_mode(), c.effort_id()));
        self.sink.mode.set(mode);
        self.sink.effort.set(effort);
        if mode != self.mode {
            self.mode = mode;
            if let Target::Existing(chat) = self.sink.target.get() {
                let actions = self.actions.clone();
                let job = async move { actions.set_permission_mode(chat, wire_mode(mode)).await.map(|_| None).map_err(|e| e.to_string()) };
                self.spawn_job(Box::pin(job), cx);
            }
        }
    }

    fn has_chat(&self, id: u64) -> bool {
        self.store.read(|reducer| {
            reducer.state().ok().is_some_and(|applied| {
                applied.projects.iter().any(|open| {
                    open.project.path.as_ref() == self.project && open.state.as_ref().is_some_and(|s| s.sessions.contains_key(&id))
                })
            })
        })
    }

    /// Reads the open Chat's saved messages; they replace whatever the transcript shows.
    fn load(&mut self, cx: &mut Context<Self>) {
        let Some(open) = &self.open else { return };
        let (key, id) = (open.key.clone(), open.id);
        if self.preloaded.as_ref().is_some_and(|(k, _)| *k == key) {
            let (_, page) = self.preloaded.take().expect("preloaded");
            self.open = Some(OpenChat { key, id, loaded: true, ..OpenChat::default() });
            let items = crate::transcript::saved_items(&page);
            let transcript = self.workspace.read(cx).chat.read(cx).transcript.clone();
            transcript.update(cx, |t, cx| t.set_items(items, cx));
            self.sync_tail(cx);
            return;
        }
        let adapter = DaemonAdapter::new(self.client.clone());
        let scope = ScopeKey::project(LOCAL, &self.project);
        let task = cx.spawn(async move |this, cx| {
            use milagre_gpui_spike::data::DataSource as _;
            let page = adapter.chat_messages(scope, id, PageRequest::OPEN).await;
            let _ = this.update(cx, |this, cx| match page {
                Ok(page) => {
                    let Some(open) = this.open.as_mut().filter(|open| open.key == key) else { return };
                    *open = OpenChat { key: open.key.clone(), id, loaded: true, ..OpenChat::default() };
                    let items = crate::transcript::saved_items(&page);
                    let transcript = this.workspace.read(cx).chat.read(cx).transcript.clone();
                    transcript.update(cx, |t, cx| t.set_items(items, cx));
                    this.sync_tail(cx);
                }
                Err(error) => this.error(format!("chat:messages {key}: {error}")),
            });
        });
        task.detach();
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
        let (key, id) = (open.key.clone(), open.id);
        let (run, queued, held) = self.store.read(|reducer| {
            let Ok(applied) = reducer.state() else { return (None, Vec::new(), false) };
            let chat = applied
                .projects
                .iter()
                .find(|o| o.project.path.as_ref() == self.project)
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
                // The saved reply (and its steps) replace the live tail.
                self.load(cx);
            }
            None => self.set_running(None, cx),
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

    fn decide(&mut self, decision: &CardDecision, cx: &mut Context<Self>) {
        let Some(open) = &self.open else { return };
        let chat = open.id;
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
                self.decisions.push((request.clone(), format!("{decision:?}")));
                let actions = self.actions.clone();
                let job = async move {
                    match actions.respond_permission(chat, &request, decision).await {
                        Ok(Value::Bool(true)) => Ok(None),
                        Ok(other) => Err(format!("permission {request}: the runtime answered {other}")),
                        Err(error) => Err(format!("permission {request}: {error}")),
                    }
                };
                self.spawn_job(Box::pin(job), cx);
            }
            CardDecision::Question { request_id, answers, .. } => {
                let request = request_id.to_string();
                if !self.answered.insert(request.clone()) {
                    return;
                }
                let answers = answers.clone().map(|answers| answers.into_iter().collect::<BTreeMap<_, _>>());
                let actions = self.actions.clone();
                let job = async move {
                    actions
                        .answer_question(chat, &request, answers, None)
                        .await
                        .map(|_| None)
                        .map_err(|e| format!("question {request}: {e}"))
                };
                self.spawn_job(Box::pin(job), cx);
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

    /// The action a command stands for, ready to run.
    fn job(&mut self, command: Command) -> Option<Job> {
        let actions = self.actions.clone();
        Some(match command {
            Command::Send { target, text, queue, mode, effort } => {
                let target = match target {
                    Target::NewChat => SendTarget::NewProjectChat,
                    Target::Existing(id) => SendTarget::Existing(id),
                    Target::None => {
                        self.error("No Chat of this runtime is open: nothing was sent".into());
                        return None;
                    }
                };
                self.sent += 1;
                let id = format!("gpui-{}-{}-{}", std::process::id(), crate::transcript::now_ms(), self.sent);
                let options =
                    SendOptions { permission_mode: wire_mode(mode), effort: effort.map(str::to_owned), queue, ..SendOptions::default() };
                let project = self.project.clone();
                Box::pin(async move {
                    let receipt = actions.send(target, &text, &id, options).await.map_err(|e| format!("send {id}: {e}"))?;
                    let open = (target == SendTarget::NewProjectChat)
                        .then(|| receipt["sessionId"].as_u64().map(|chat| format!("{project}#{chat}")))
                        .flatten();
                    Ok(Some(Done::Sent { id, receipt, open }))
                })
            }
            Command::Interrupt(chat) => {
                Box::pin(async move { actions.interrupt(chat).await.map(|_| None).map_err(|e| format!("interrupt: {e}")) })
            }
            Command::SendQueuedNow { chat, id } => {
                Box::pin(
                    async move { actions.send_queued_now(chat, &id).await.map(|_| None).map_err(|e| format!("send queued {id}: {e}")) },
                )
            }
            Command::RemoveQueued { chat, id } => {
                Box::pin(
                    async move { actions.remove_queued(chat, &id).await.map(|_| None).map_err(|e| format!("remove queued {id}: {e}")) },
                )
            }
            Command::MarkUnread { chat, unread } => {
                Box::pin(async move { actions.mark_unread(chat, unread).await.map(|_| None).map_err(|e| format!("mark unread: {e}")) })
            }
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
            Ok(None) => {}
            Err(error) => self.error(error),
        }
        cx.notify();
    }

    fn error(&mut self, error: String) {
        eprintln!("live: {error}");
        self.errors.push(error);
    }
}

enum Done {
    Sent { id: String, receipt: Value, open: Option<String> },
}

type Job = std::pin::Pin<Box<dyn std::future::Future<Output = Result<Option<Done>, String>>>>;

/// The transcript's items as lines (tests and evidence).
pub fn shown_items(items: &[Item]) -> Vec<String> {
    items.iter().map(crate::transcript::describe).collect()
}

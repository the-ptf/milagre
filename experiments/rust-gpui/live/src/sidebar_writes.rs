//! The sidebar's remaining writes on Milagre's daemon, as Electron makes them (`App.tsx`'s `chatActions`,
//! `lib/archive-flow.ts`, `lib/chat-pins.ts`, `lib/hidden-projects.ts`, `main.cjs`'s `project:open`). Typed client
//! capabilities where they exist (`SidebarActions::restore`), else `InstalledProject::call` with the preload's
//! arguments, each on a short request-only connection of the Chat's Project that loads it first (`load_view`).
//!
//! - Delete (`archiveChat` in `@milagre/shared/archive`): a running turn is stopped (`agent:interrupt`), the Chat is
//!   hidden at once (`chat:patch {archived: true, unread: false}`), and an Undo inside the toast's 6 seconds brings it
//!   back (`chat:patch {archived: false}`). After them, as Electron's `checkArchive` decides: a Worktree Milagre made
//!   (it has a base and lies under one of `worktree:roots []`) that no other Chat uses and that `worktree:status [path,
//!   base]` reports `removable` goes with it (`worktree:remove [path, {force: false, base, projectPath, chatId,
//!   seen}]`, which drops its Chats too; a refusal brings the Chat back and says why); otherwise the conversation goes
//!   (`chat:delete`) and the Worktree stays. A refused delete restores it and says why.
//! - Pin and Unpin are this device's (`milagre.chatPins`): kept in the Preview's own preferences
//!   (`<Preview folder>/sidebar.json`), never on the host, except that pinning a Run Chat its host may still hide
//!   tells it the person took it over (`chat:patch {kept: true}`), as `pinChatHere` does.
//! - Filters: a Project hidden or shown is the host's (`project:set-hidden`, read back from `project:recent`, laid
//!   over the snapshot's Projects by the source); hidden computers and the row's Show fields are this device's, kept
//!   with the pins.
//! - Reload (`chat:reload`), Detach from parent (`chat:detach`), Unlink issue (`worktree:unlink-issue`), Kept.
//! - Links (`SidebarLinks.tsx`): the sidebar's Links are the daemon's (`canvas:links []`, read on each sync and
//!   after every Link write, and followed live through `canvas:links-changed`). "Link with…" makes one
//!   (`canvas:link-add [a, b]`, the ends `{project_id, worktree_path}`), then, as the popover asks, Always allow
//!   (`linked:grant [chatId, linkId]`, the id the daemon gave the new Link) and the ask (`chat:send` with the shown
//!   `body` and the sent `prompt`, on the Chat's provider and model); "Remove Link with…" removes one
//!   (`canvas:link-remove [id]`) and the toast's Undo puts the same one back (`canvas:link-restore [link]`, as the
//!   daemon listed it).
//! - Add Project: the folder dialog, then `project:open [folder, {takeNotice: true}]` (the host registers it and puts
//!   it first among the recent Projects, as Electron's Add Project does); the window then syncs again to list it. The
//!   installed daemon advertises `project:open` only to `daemon:status [{commands: true}]`, which the shared client
//!   asks since 66a7795e; a daemon that still does not list it is refused by the client and the sidebar says so.
//!
//! In read-only mode (`--snapshot`) each of these is refused before a connection, the sidebar goes back to what the
//! daemon holds, nothing is saved and the hidden Projects are not read. The menu offers only Copy branch name then
//! ([`backed`]); this device's saved pins and filters still show.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::StreamExt as _;
use futures::channel::mpsc::{UnboundedReceiver, UnboundedSender, unbounded};
use futures::channel::oneshot;
use gpui::{App, AppContext as _, Context, Entity, Global, PathPromptOptions, Subscription, Task};
use milagre_gpui_spike::data::Chat;
use milagre_gpui_spike::logic::lists::chat_row::{CHAT_ROW_FIELDS, ChatRowShow, DESKTOP_CHAT_ROW_SHOW};
use milagre_gpui_spike::logic::lists::pins::DevicePins;
use milagre_gpui_spike::workspace::Workspace;
use milagre_gpui_spike::workspace::preview::PreviewWrites;
use milagre_gpui_spike::workspace::sidebar::links::{CanvasLink, LinkEnd};
use milagre_gpui_spike::workspace::sidebar::menu::MenuAction;
use milagre_gpui_spike::workspace::sidebar::{ChatPatch, SidebarActions, SidebarCall};
use serde_json::{Value, json};

use crate::LiveStore;
use crate::controller::LiveController;
use crate::daemon::Daemon;
use crate::sinks::{ChatRef, LiveSidebarActions, chat_ref};

/// How long a deleted Chat can still be brought back: the sidebar toast's Undo (`DELETE_UNDO_MS`).
pub const DELETE_UNDO: Duration = Duration::from_millis(6000);

/// The row actions this layer backs beyond the default four; read-only mode only copies a branch name.
pub fn backed(read_only: bool) -> Vec<MenuAction> {
    use MenuAction as A;
    if read_only {
        vec![A::CopyBranch]
    } else {
        vec![A::CopyBranch, A::Reload, A::UnlinkIssue, A::Pin, A::Unpin, A::Detach, A::Delete, A::LinkWith, A::RemoveLink]
    }
}

/// One sidebar write for [`SidebarWrites`].
#[derive(Clone, Debug, PartialEq)]
pub enum Write {
    Archive(ChatRef),
    UndoArchive(ChatRef),
    /// A pin changed (Pin, Unpin, a drag among the pinned rows): this device's choices are saved.
    Pin {
        chat: ChatRef,
        pinned: bool,
    },
    Reload(ChatRef),
    Detach(ChatRef),
    Kept(ChatRef),
    UnlinkIssue(ChatRef),
    SetProjectHidden {
        path: String,
        hidden: bool,
    },
    /// Filters › Computers or Show changed.
    Prefs,
    AddProject,
    /// "Link with…": the Link, then (from the same popover) Always allow and the ask.
    AddLink {
        a: LinkEnd,
        b: LinkEnd,
        grant: Option<String>,
        ask: Option<(String, String, String)>,
    },
    RemoveLink(String),
    RestoreLink(String),
    /// `linked:grant` on its own (an existing Link's id).
    Grant {
        chat: String,
        link: String,
    },
    /// "Link and ask" on its own: the Chat key, the shown body, the sent prompt.
    Ask {
        chat: String,
        body: String,
        prompt: String,
    },
}

/// The Projects hidden from the sidebar: the host's (`project:recent`), laid over the snapshot's Projects, which do
/// not carry it.
#[derive(Default)]
pub struct Hidden(Mutex<HashSet<String>>);

impl Hidden {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashSet<String>> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn contains(&self, path: &str) -> bool {
        self.lock().contains(path)
    }

    pub fn set(&self, path: &str, hidden: bool) {
        if hidden {
            self.lock().insert(path.to_owned());
        } else {
            self.lock().remove(path);
        }
    }

    pub fn replace(&self, paths: HashSet<String>) {
        *self.lock() = paths;
    }

    pub fn paths(&self) -> HashSet<String> {
        self.lock().clone()
    }
}

/// The sidebar's `SidebarActions` on Milagre's daemon: the writes above go to [`SidebarWrites`], every other call
/// (unread, Done, Reopen, Rename and the recorded ones) to the controller's [`LiveSidebarActions`].
pub struct Router {
    pub inner: LiveSidebarActions,
    pub writes: UnboundedSender<Write>,
}

impl SidebarActions for Router {
    fn call(&self, call: SidebarCall) {
        let chat = |key: &str| chat_ref(None, key);
        let write = match &call {
            SidebarCall::Archive { chat: key, .. } => chat(key).map(Write::Archive),
            SidebarCall::UndoArchive { chat: key } => chat(key).map(Write::UndoArchive),
            SidebarCall::Pin { chat: key, order } => chat(key).map(|chat| Write::Pin { chat, pinned: order.is_some() }),
            SidebarCall::Reload { chat: key } => chat(key).map(Write::Reload),
            SidebarCall::UnlinkIssue { chat: key } => chat(key).map(Write::UnlinkIssue),
            SidebarCall::Patch { chat: key, patch: ChatPatch::Detach } => chat(key).map(Write::Detach),
            SidebarCall::Patch { chat: key, patch: ChatPatch::Kept } => chat(key).map(Write::Kept),
            // A Project on this computer (its path); another computer's scope keys are not this daemon's.
            SidebarCall::SetProjectHidden { scope, hidden } if scope.starts_with('/') && !scope.contains('|') => {
                Some(Write::SetProjectHidden { path: scope.clone(), hidden: *hidden })
            }
            SidebarCall::SetComputerHidden { .. } | SidebarCall::SetRowField { .. } => Some(Write::Prefs),
            SidebarCall::AddProject => Some(Write::AddProject),
            SidebarCall::AddLink { a, b } => Some(Write::AddLink { a: a.clone(), b: b.clone(), grant: None, ask: None }),
            SidebarCall::RemoveLink { id } => Some(Write::RemoveLink(id.clone())),
            SidebarCall::RestoreLink { link } => Some(Write::RestoreLink(link.id.clone())),
            SidebarCall::GrantDelegations { chat, link } => Some(Write::Grant { chat: chat.clone(), link: link.clone() }),
            SidebarCall::AskChat { chat, body, prompt } => {
                Some(Write::Ask { chat: chat.clone(), body: body.clone(), prompt: prompt.clone() })
            }
            _ => None,
        };
        match write {
            Some(write) => {
                let _ = self.writes.unbounded_send(write);
            }
            None => self.inner.call(call),
        }
    }
}

/// Where this device's sidebar choices are kept; `None` keeps them in memory only. Tests set it; without it the app
/// uses `<Preview folder>/sidebar.json` (never in tests).
#[derive(Clone)]
pub struct PrefsPath(pub Option<PathBuf>);

impl Global for PrefsPath {}

/// The folder Add Project opens without the dialog (tests).
#[derive(Clone)]
pub struct PickedFolder(pub PathBuf);

impl Global for PickedFolder {}

/// What [`install`] leaves for [`attach`]: the writes' receiver and the hidden Projects.
struct Pending {
    receiver: Mutex<Option<UnboundedReceiver<Write>>>,
    hidden: Arc<Hidden>,
}

struct Installed(Arc<Pending>);

impl Global for Installed {}

/// The window's [`SidebarWrites`], once attached.
#[derive(Clone)]
pub struct Writes(pub Entity<SidebarWrites>);

impl Global for Writes {}

/// Before the window: the channel the [`Router`] sends on, the hidden Projects the source lays over its Projects, and
/// the menu's backed actions ([`PreviewWrites`]).
pub fn install(read_only: bool, cx: &mut App) -> (UnboundedSender<Write>, Arc<Hidden>) {
    let (sender, receiver) = unbounded();
    let hidden = Arc::new(Hidden::default());
    cx.set_global(Installed(Arc::new(Pending { receiver: Mutex::new(Some(receiver)), hidden: hidden.clone() })));
    cx.set_global(PreviewWrites(backed(read_only)));
    (sender, hidden)
}

/// Whether the host hides this Project from the sidebar (as far as this window has read).
pub fn is_hidden(cx: &App, path: &str) -> bool {
    cx.try_global::<Installed>().is_some_and(|installed| installed.0.hidden.contains(path))
}

/// After the controller: runs the writes [`install`]'s channel carries, puts this device's saved choices back on the
/// sidebar and reads the hidden Projects (again after every sync).
pub fn attach(workspace: &Entity<Workspace>, daemon: Arc<Daemon>, store: LiveStore, controller: &Entity<LiveController>, cx: &mut App) {
    let Some(installed) = cx.try_global::<Installed>().map(|installed| installed.0.clone()) else { return };
    let Some(receiver) = installed.receiver.lock().unwrap_or_else(|p| p.into_inner()).take() else { return };
    let prefs = match cx.try_global::<PrefsPath>() {
        Some(path) => path.0.clone(),
        None if cfg!(test) => None,
        None => Some(crate::setup::preview_base().join("sidebar.json")),
    };
    let (workspace, controller) = (workspace.clone(), controller.clone());
    let entity = cx.new(|cx| {
        let run = cx.spawn(async move |this: gpui::WeakEntity<SidebarWrites>, cx: &mut gpui::AsyncApp| {
            let mut receiver = receiver;
            while let Some(write) = receiver.next().await {
                // The Link popover sends its Link, Always allow and ask together: they go as one, so the grant names
                // the id the daemon gives the new Link.
                let mut writes = vec![write];
                if matches!(writes[0], Write::AddLink { .. }) {
                    while let Ok(next) = receiver.try_recv() {
                        let alone = writes.len() == 1;
                        let folded = match (&mut writes[0], next) {
                            (Write::AddLink { grant, .. }, Write::Grant { chat, .. }) if grant.is_none() && alone => {
                                *grant = Some(chat);
                                None
                            }
                            (Write::AddLink { ask, .. }, Write::Ask { chat, body, prompt }) if ask.is_none() && alone => {
                                *ask = Some((chat, body, prompt));
                                None
                            }
                            (_, other) => Some(other),
                        };
                        if let Some(other) = folded {
                            writes.push(other);
                        }
                    }
                }
                for write in writes {
                    if this.update(cx, |this, cx| this.run(write, cx)).is_err() {
                        return;
                    }
                }
            }
        });
        let syncs = cx.observe(&controller, |this: &mut SidebarWrites, controller, cx| {
            let syncs = controller.read(cx).syncs();
            if syncs != this.syncs {
                this.syncs = syncs;
                this.read_hidden(cx);
                this.read_links(cx);
            }
        });
        let mut this = SidebarWrites {
            workspace,
            controller: controller.clone(),
            daemon,
            store,
            hidden: installed.hidden.clone(),
            prefs,
            pending: HashMap::new(),
            links: Vec::new(),
            refused: Vec::new(),
            errors: Vec::new(),
            saved: 0,
            syncs: controller.read(cx).syncs(),
            _run: run,
            _syncs: syncs,
        };
        this.load_prefs(cx);
        this.read_hidden(cx);
        this.read_links(cx);
        this
    });
    cx.set_global(Writes(entity));
}

pub struct SidebarWrites {
    workspace: Entity<Workspace>,
    controller: Entity<LiveController>,
    daemon: Arc<Daemon>,
    store: LiveStore,
    hidden: Arc<Hidden>,
    prefs: Option<PathBuf>,
    /// Deletions waiting out their Undo, by Chat key: the Undo's sender.
    pending: HashMap<String, oneshot::Sender<()>>,
    /// The daemon's Links as it listed them (`canvas:links`), and removed ones an Undo may put back.
    links: Vec<Value>,
    refused: Vec<String>,
    errors: Vec<String>,
    /// How many times this device's choices were saved.
    saved: u64,
    syncs: u64,
    _run: Task<()>,
    _syncs: Subscription,
}

/// A request-only connection of a Project for one write: loaded first (`load_view`) unless `load` is false (a
/// Project not open on the host yet, `project:open` itself), closed when dropped.
struct Connection {
    client: milagre_daemon_client::Client,
    installed: milagre_daemon_client::InstalledProject,
}

impl Connection {
    async fn open(daemon: &Daemon, project: &str, load: bool) -> Result<Self, String> {
        let (client, installed, notifications) = daemon.connect(project).await.map_err(|e| format!("{e:#}"))?;
        notifications.discard();
        let connection = Connection { client, installed };
        if load {
            connection.client.load_view(project).await.map_err(|e| format!("project:read {project}: {e}"))?;
        }
        Ok(connection)
    }

    async fn call(&self, method: &str, args: Value) -> Result<Value, String> {
        self.installed.call(&self.client, method, args).await.map_err(|e| format!("{method}: {e}"))
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        self.client.disconnect();
    }
}

impl SidebarWrites {
    /// Writes refused because the window is read-only (none reached a connection).
    pub fn refused(&self) -> &[String] {
        &self.refused
    }

    /// Writes the host refused or that failed, as the sidebar said them.
    pub fn errors(&self) -> &[String] {
        &self.errors
    }

    /// Deletions still inside their Undo window.
    pub fn undoable(&self) -> usize {
        self.pending.len()
    }

    pub fn hidden_projects(&self) -> HashSet<String> {
        self.hidden.paths()
    }

    pub fn saves(&self) -> u64 {
        self.saved
    }

    fn sidebar(&self, cx: &App) -> Entity<milagre_gpui_spike::workspace::sidebar::Sidebar> {
        self.workspace.read(cx).sidebar.clone()
    }

    /// The sidebar goes back to what the daemon holds (a refused or failed write) and says why.
    fn failed(&mut self, message: String, cx: &mut Context<Self>) {
        eprintln!("live: {message}");
        self.errors.push(message.clone());
        self.sidebar(cx).update(cx, |s, cx| {
            s.reload(cx);
            s.set_notice(Some(message.into()), cx);
        });
    }

    fn notice(&mut self, message: Option<String>, cx: &mut Context<Self>) {
        self.sidebar(cx).update(cx, |s, cx| s.set_notice(message.map(Into::into), cx));
    }

    fn refuse(&mut self, write: &Write, cx: &mut Context<Self>) {
        self.refused.push(format!("{write:?}"));
        self.sidebar(cx).update(cx, |s, cx| {
            s.reload(cx);
            s.set_notice(Some("Read-only: nothing is written to Milagre's daemon in this mode".into()), cx);
        });
    }

    /// A Chat as the reducer holds it.
    fn chat<T>(&self, chat: &ChatRef, read: impl FnOnce(&Chat) -> T) -> Option<T> {
        self.store.read(|reducer| {
            let applied = reducer.state().ok()?;
            let open = applied.projects.iter().find(|open| open.project.path.as_ref() == chat.project)?;
            open.state.as_ref()?.sessions.get(&chat.id).map(read)
        })
    }

    /// The Chat's Worktree as the window holds it (path, base), unless another Chat that isn't archived uses it
    /// (`worktreeShared`): then nothing would be removed.
    fn worktree(&self, chat: &ChatRef) -> Option<CleanupWorktree> {
        self.store.read(|reducer| {
            let applied = reducer.state().ok()?;
            let open = applied.projects.iter().find(|o| o.project.path.as_ref() == chat.project)?;
            let state = open.state.as_ref()?;
            let session = state.chat(chat.id)?;
            let shared =
                state.sessions.values().any(|other| other.id != session.id && other.worktree_id == session.worktree_id && !other.archived);
            let worktree = state.worktree_of(session)?;
            (!shared).then(|| CleanupWorktree { path: worktree.path.to_string(), base: worktree.base.as_ref().map(|b| b.to_string()) })
        })
    }

    fn running(&self, chat: &ChatRef) -> bool {
        self.store.read(|reducer| reducer.state().is_ok_and(|applied| applied.runs.get(&chat.key()).is_some()))
    }

    fn run(&mut self, write: Write, cx: &mut Context<Self>) {
        let read_only = self.daemon.read_only();
        match write {
            // Device-local: kept in memory in read-only mode, never saved there.
            Write::Prefs => self.save_prefs(cx),
            Write::Pin { chat, pinned } => {
                self.save_prefs(cx);
                // `pinChatHere`: a Run Chat its host may still hide is kept once pinned.
                let keeps = pinned && self.chat(&chat, |c| c.routine.as_ref().is_some_and(|r| r.hidden != Some(false))) == Some(true);
                if keeps && !read_only {
                    self.patch(chat, json!({"kept": true}), "Could not keep the Chat", cx);
                }
            }
            write if read_only => self.refuse(&write, cx),
            Write::Archive(chat) => self.archive(chat, cx),
            Write::UndoArchive(chat) => {
                // Inside the window: the archive flow restores it once the hide has landed. After it: gone for good.
                if let Some(undo) = self.pending.remove(&chat.key()) {
                    let _ = undo.send(());
                } else {
                    self.failed("That Chat was deleted already".into(), cx);
                }
            }
            Write::Kept(chat) => self.patch(chat, json!({"kept": true}), "Could not keep the Chat", cx),
            Write::Reload(chat) => {
                let calls = vec![("chat:reload", json!([chat.key()]))];
                self.spawn_write(chat.project, calls, "Could not reload chat", cx, |_, this, cx| {
                    this.notice(Some("Chat reloaded. Your next message starts a fresh agent.".into()), cx);
                });
            }
            Write::Detach(chat) => {
                let calls = vec![("chat:detach", json!([chat.project, chat.id]))];
                self.spawn_write(chat.project, calls, "Could not detach chat", cx, |results, this, cx| {
                    let said = results.last().and_then(|r| r.as_str().map(str::to_owned));
                    this.notice(said, cx);
                });
            }
            Write::UnlinkIssue(chat) => {
                let Some(worktree) = self.chat(&chat, |c| c.worktree_id) else {
                    return self.failed("Could not unlink issue: the Chat is not loaded".into(), cx);
                };
                let calls = vec![("worktree:unlink-issue", json!([{"projectPath": chat.project, "worktreeId": worktree}]))];
                self.spawn_write(chat.project, calls, "Could not unlink issue", cx, |_, this, cx| this.notice(None, cx));
            }
            Write::SetProjectHidden { path, hidden } => self.set_project_hidden(path, hidden, cx),
            Write::AddProject => self.add_project(cx),
            Write::AddLink { a, b, grant, ask } => self.add_link(a, b, grant, ask, cx),
            Write::RemoveLink(id) => {
                let project = self.link_project(&id);
                self.link_write(project, vec![("canvas:link-remove", json!([id]))], "Could not remove the Link", cx);
            }
            Write::RestoreLink(id) => {
                let Some(raw) = self.links.iter().find(|l| l["id"] == id.as_str()).cloned() else {
                    return self.failed("Could not restore the Link: the daemon never listed it".into(), cx);
                };
                let project = self.link_project(&id);
                self.link_write(project, vec![("canvas:link-restore", json!([raw]))], "Could not restore the Link", cx);
            }
            Write::Grant { chat, link } => {
                let Some(at) = chat_ref(None, &chat) else { return };
                self.link_write(Some(at.project), vec![("linked:grant", json!([chat, link]))], "Could not allow Delegations", cx);
            }
            Write::Ask { chat, body, prompt } => self.ask(chat, body, prompt, cx),
        }
    }
}

/// The Links in a `canvas:links` answer, as the sidebar holds them.
pub fn canvas_links(list: &Value) -> Vec<CanvasLink> {
    let end = |v: &Value| {
        Some(LinkEnd { project_id: v["project_id"].as_str()?.to_owned(), worktree_path: v["worktree_path"].as_str().map(str::to_owned) })
    };
    list.as_array()
        .into_iter()
        .flatten()
        .filter_map(|l| Some(CanvasLink { id: l["id"].as_str()?.to_owned(), a: end(&l["a"])?, b: end(&l["b"])? }))
        .collect()
}

fn end_json(end: &LinkEnd) -> Value {
    match &end.worktree_path {
        Some(path) => json!({"project_id": end.project_id, "worktree_path": path}),
        None => json!({"project_id": end.project_id}),
    }
}

impl SidebarWrites {
    /// The daemon's Links into the sidebar (`canvas:links []`, read on the live Project's connection).
    pub(crate) fn read_links(&mut self, cx: &mut Context<Self>) {
        let Some((project, _)) = self.daemon.primary() else { return };
        let daemon = self.daemon.clone();
        cx.spawn(async move |this, cx| {
            let read = daemon.read(&project, "canvas:links", json!([])).await;
            let _ = this.update(cx, |this, cx| match read {
                Ok(list) => this.set_links(&list, cx),
                Err(error) => eprintln!("live: couldn't read the Links: {error:#}"),
            });
        })
        .detach();
    }

    /// A `canvas:links` list (read, answered, or `canvas:links-changed`'s) into the sidebar; removed Links are kept
    /// aside for an Undo.
    pub fn set_links(&mut self, list: &Value, cx: &mut Context<Self>) {
        let Some(items) = list.as_array() else { return };
        for item in items {
            self.links.retain(|known| known["id"] != item["id"]);
        }
        let mut next = items.clone();
        next.extend(std::mem::take(&mut self.links));
        next.truncate(256);
        self.links = next;
        let links = canvas_links(list);
        self.sidebar(cx).update(cx, |s, cx| s.set_links(links, cx));
    }

    /// The Project a Link's write goes through: one of its ends' (both are Projects on this computer).
    fn link_project(&self, id: &str) -> Option<String> {
        self.links.iter().find(|l| l["id"] == id).and_then(|l| l["a"]["project_id"].as_str()).map(str::to_owned)
    }

    /// Link writes on `project`'s connection, then the daemon's Links read again.
    fn link_write(&mut self, project: Option<String>, calls: Vec<(&'static str, Value)>, what: &'static str, cx: &mut Context<Self>) {
        let Some(project) = project.or_else(|| self.daemon.primary().map(|(p, _)| p)) else {
            return self.failed(format!("{what}: no Project to reach Milagre's daemon through"), cx);
        };
        let calls = calls.into_iter().chain([("canvas:links", json!([]))]).collect();
        self.spawn_write(project, calls, what, cx, |results, this, cx| {
            if let Some(list) = results.last() {
                this.set_links(list, cx);
            }
            this.notice(None, cx);
        });
    }

    /// "Link with…": `canvas:link-add`, the Links read again, then Always allow on the new Link's id and the ask.
    fn add_link(&mut self, a: LinkEnd, b: LinkEnd, grant: Option<String>, ask: Option<(String, String, String)>, cx: &mut Context<Self>) {
        let daemon = self.daemon.clone();
        let ask_target = ask.as_ref().and_then(|(chat, _, _)| self.send_target(chat));
        cx.spawn(async move |this, cx| {
            let result = async {
                let connection = Connection::open(&daemon, &a.project_id, true).await?;
                connection.call("canvas:link-add", json!([end_json(&a), end_json(&b)])).await?;
                let list = connection.call("canvas:links", json!([])).await?;
                let id = milagre_gpui_spike::workspace::sidebar::links::find_link(&canvas_links(&list), &a, &b).map(|l| l.id.clone());
                if let (Some(chat), Some(id)) = (&grant, &id) {
                    connection.call("linked:grant", json!([chat, id])).await?;
                }
                if let (Some((chat, body, prompt)), Some(target)) = (&ask, &ask_target) {
                    send_ask(&daemon, chat, body, prompt, target).await?;
                }
                Ok::<_, String>(list)
            }
            .await;
            let _ = this.update(cx, |this, cx| match result {
                Ok(list) => {
                    this.set_links(&list, cx);
                    this.notice(None, cx);
                }
                Err(error) => {
                    this.failed(format!("Could not create the Link: {error}"), cx);
                    this.read_links(cx);
                }
            });
        })
        .detach();
    }

    /// "Link and ask" on its own.
    fn ask(&mut self, chat: String, body: String, prompt: String, cx: &mut Context<Self>) {
        let Some(target) = self.send_target(&chat) else {
            return self.failed("That chat is no longer in its Project.".into(), cx);
        };
        let daemon = self.daemon.clone();
        cx.spawn(async move |this, cx| {
            let result = send_ask(&daemon, &chat, &body, &prompt, &target).await;
            let _ = this.update(cx, |this, cx| match result {
                Ok(()) => this.notice(None, cx),
                Err(error) => this.failed(format!("Could not ask the Chat: {error}"), cx),
            });
        })
        .detach();
    }

    /// What a message to `chat` is sent with (`askLinkedChat`): its Worktree, provider, model and permission mode.
    fn send_target(&self, chat: &str) -> Option<AskTarget> {
        let at = chat_ref(None, chat)?;
        self.store.read(|reducer| {
            let applied = reducer.state().ok()?;
            let (_, session) = crate::panels::find(&applied.projects, chat)?;
            if session.archived {
                return None;
            }
            Some(AskTarget {
                project: at.project.clone(),
                id: at.id,
                worktree: session.worktree_id,
                provider: milagre_gpui_spike::data::Provider::of_session(session.provider_id.as_deref()).id().to_owned(),
                model: session.summary.as_ref().and_then(|s| s.last_model.as_ref()).map(|m| m.to_string()),
                mode: crate::sinks::wire_name(session.permission_mode.unwrap_or(milagre_gpui_spike::data::PermissionMode::Ask)).to_owned(),
            })
        })
    }
}

/// Where "Link and ask" sends.
#[derive(Clone, Debug)]
struct AskTarget {
    project: String,
    id: u64,
    worktree: u64,
    provider: String,
    model: Option<String>,
    mode: String,
}

/// `chat:send` with the shown `body` and the sent `prompt`, on the Chat's provider and model (its last one, else its
/// provider's recommended one).
async fn send_ask(daemon: &Daemon, chat: &str, body: &str, prompt: &str, target: &AskTarget) -> Result<(), String> {
    let writer = daemon.writer(&target.project).await.map_err(|e| format!("{e:#}"))?;
    let model = match &target.model {
        Some(model) => model.clone(),
        None => writer.recommended_model(&target.provider).await.map_err(|e| format!("{e:#}"))?.unwrap_or_default(),
    };
    let client_id = format!("gpui-ask-{}-{}", std::process::id(), crate::transcript::now_ms());
    let request = json!([{
        "projectPath": target.project, "sessionId": target.id, "worktreeId": target.worktree, "body": body, "prompt": prompt,
        "images": [], "files": [], "provider": target.provider, "model": model, "permissionMode": target.mode,
        "clientMessageId": client_id, "replies": "concise", "tldrEnabled": true,
    }]);
    writer.call("chat:send", request).await.map_err(|e| format!("{e:#} ({chat})"))?;
    Ok(())
}

impl SidebarWrites {
    /// Runs `calls` in order on a request-only connection of `project`, loaded first; `done` gets their answers. A
    /// failure stops there, and the sidebar goes back to the daemon's data and says `what` went wrong.
    fn spawn_write(
        &mut self,
        project: String,
        calls: Vec<(&'static str, Value)>,
        what: &'static str,
        cx: &mut Context<Self>,
        done: impl FnOnce(Vec<Value>, &mut Self, &mut Context<Self>) + 'static,
    ) {
        let daemon = self.daemon.clone();
        cx.spawn(async move |this, cx| {
            let result = async {
                let connection = Connection::open(&daemon, &project, true).await?;
                let mut results = Vec::new();
                for (method, args) in calls {
                    results.push(connection.call(method, args).await?);
                }
                Ok::<_, String>(results)
            }
            .await;
            let _ = this.update(cx, |this, cx| match result {
                Ok(results) => done(results, this, cx),
                Err(error) => this.failed(format!("{what}: {error}"), cx),
            });
        })
        .detach();
    }

    /// One `chat:patch` on the Chat's Project.
    fn patch(&mut self, chat: ChatRef, patch: Value, what: &'static str, cx: &mut Context<Self>) {
        let calls = vec![("chat:patch", json!([chat.project, chat.id, patch]))];
        self.spawn_write(chat.project, calls, what, cx, |_, this, cx| this.notice(None, cx));
    }

    /// Delete (`archiveChat` with `HIDE_ONLY`): stop a running turn, hide at once, then wait out the Undo; undone
    /// restores, time up deletes the conversation (the Worktree stays). The window starts with the press, as the
    /// toast does, so an Undo before the host answered the hide still counts.
    fn archive(&mut self, chat: ChatRef, cx: &mut Context<Self>) {
        let key = chat.key();
        if self.pending.contains_key(&key) {
            return;
        }
        let (undo, undone) = oneshot::channel();
        self.pending.insert(key.clone(), undo);
        let (running, daemon) = (self.running(&chat), self.daemon.clone());
        let worktree = self.worktree(&chat);
        let window = cx.background_executor().timer(DELETE_UNDO);
        cx.spawn(async move |this, cx| {
            let hidden = async {
                let connection = Connection::open(&daemon, &chat.project, true).await?;
                // `checkArchive`: only a Worktree Milagre made, that no other Chat uses, and that is safe to remove.
                let plan = plan(&connection, worktree.as_ref()).await;
                if running {
                    // As Stop does; a stop that fails never holds the deletion up.
                    let _ = connection.call("agent:interrupt", json!([key])).await;
                }
                connection.call("chat:patch", json!([chat.project, chat.id, {"archived": true, "unread": false}])).await?;
                Ok::<_, String>(plan)
            }
            .await;
            let removal = match hidden {
                Ok(plan) => plan,
                Err(error) => {
                    let _ = this.update(cx, |this, cx| {
                        this.pending.remove(&key);
                        this.failed(format!("Could not delete Chat: {error}"), cx);
                    });
                    return;
                }
            };
            let undone = match futures::future::select(window, undone).await {
                futures::future::Either::Right((Ok(()), _)) => true,
                // The window closed with the Chat hidden: it stays hidden, as when Electron quits in the window.
                futures::future::Either::Right((Err(_), _)) => return,
                // Time up, unless an Undo landed just as it ran out.
                futures::future::Either::Left(_) => this.update(cx, |this, _| this.pending.remove(&key).is_none()).unwrap_or(false),
            };
            let result = async {
                let connection = Connection::open(&daemon, &chat.project, true).await?;
                if undone {
                    let sidebar = connection.installed.sidebar_actions(&connection.client).map_err(|e| e.to_string())?;
                    sidebar.restore(chat.id).await.map_err(|e| format!("chat:patch: {e}"))?;
                    return Ok(());
                }
                if let Some((worktree, status)) = &removal {
                    let options =
                        json!({"force": false, "base": worktree.base, "projectPath": chat.project, "chatId": key, "seen": status});
                    return match connection.call("worktree:remove", json!([worktree.path, options])).await {
                        Ok(_) => Ok(()),
                        // The Worktree stays, and so does the Chat, brought back with it.
                        Err(error) => {
                            let _ = connection.call("chat:patch", json!([chat.project, chat.id, {"archived": false}])).await;
                            Err(remove_failure(&error))
                        }
                    };
                }
                match connection.call("chat:delete", json!([chat.project, chat.id])).await {
                    Ok(_) => Ok(()),
                    // `destroy` failed: the Chat comes back.
                    Err(error) => {
                        let _ = connection.call("chat:patch", json!([chat.project, chat.id, {"archived": false}])).await;
                        Err(error)
                    }
                }
            }
            .await;
            let _ = this.update(cx, |this, cx| match result {
                Ok(()) => this.notice(None, cx),
                Err(error) if undone => this.failed(format!("Could not restore Chat: {error}"), cx),
                Err(error) if error.starts_with("Couldn't remove the worktree") || error.starts_with("It changed after you checked") => {
                    this.failed(error, cx)
                }
                Err(error) => this.failed(format!("Could not delete Chat: {error}"), cx),
            });
        })
        .detach();
    }

    /// Filters › Projects on this computer: the host's choice (`project:set-hidden`), laid over the sidebar at once
    /// and set to the host's answer; a refusal puts it back.
    fn set_project_hidden(&mut self, path: String, hidden: bool, cx: &mut Context<Self>) {
        let before = self.hidden.contains(&path);
        self.hidden.set(&path, hidden);
        let daemon = self.daemon.clone();
        cx.spawn(async move |this, cx| {
            let result = async {
                // Not loaded first: hiding needs only the Project known, as Electron's Filters does it.
                let connection = Connection::open(&daemon, &path, false).await?;
                connection.call("project:set-hidden", json!([path, hidden])).await
            }
            .await;
            let _ = this.update(cx, |this, cx| {
                match result {
                    Ok(list) => {
                        this.hidden.replace(hidden_in(&list));
                        this.notice(None, cx);
                        this.sidebar(cx).update(cx, |s, cx| s.reload(cx));
                    }
                    Err(error) => {
                        this.hidden.set(&path, before);
                        this.failed(format!("Could not change what the sidebar shows: {error}"), cx);
                    }
                }
                this.controller.update(cx, |c, cx| c.sync_unloaded(cx));
            });
        })
        .detach();
    }

    /// The Projects the host hides (`project:recent`), on any known Project's request-only connection. Not in
    /// read-only mode, which keeps to adoption, the snapshot and transcripts.
    fn read_hidden(&mut self, cx: &mut Context<Self>) {
        if self.daemon.read_only() {
            return;
        }
        let Some(project) = self.daemon.known().first().map(|known| known.path.clone()) else { return };
        let daemon = self.daemon.clone();
        cx.spawn(async move |this, cx| {
            let read = async { Connection::open(&daemon, &project, false).await?.call("project:recent", json!([])).await }.await;
            let _ = this.update(cx, |this, cx| match read {
                Ok(list) => {
                    let paths = hidden_in(&list);
                    if paths != this.hidden.paths() {
                        this.hidden.replace(paths);
                        this.sidebar(cx).update(cx, |s, cx| s.reload(cx));
                        this.controller.update(cx, |c, cx| c.sync_unloaded(cx));
                    }
                }
                Err(error) => eprintln!("live: couldn't read the hidden Projects: {error}"),
            });
        })
        .detach();
    }

    /// Add Project (`project:open` from `main.cjs`): the folder dialog, then the host opens the folder as a Project
    /// (registered, first among the recent ones) and the window syncs again to list it. Cancelling does nothing.
    fn add_project(&mut self, cx: &mut Context<Self>) {
        let picked = cx.try_global::<PickedFolder>().map(|folder| folder.0.clone());
        let prompt = picked.is_none().then(|| {
            cx.prompt_for_paths(PathPromptOptions { files: false, directories: true, multiple: false, prompt: Some("Open project".into()) })
        });
        let daemon = self.daemon.clone();
        cx.spawn(async move |this, cx| {
            let folder = match (picked, prompt) {
                (Some(folder), _) => Some(folder),
                (None, Some(prompt)) => match prompt.await {
                    Ok(Ok(Some(paths))) => paths.into_iter().next(),
                    Ok(Err(error)) => {
                        let _ = this.update(cx, |this, cx| this.failed(format!("Could not open project: {error:#}"), cx));
                        None
                    }
                    _ => None,
                },
                (None, None) => None,
            };
            let Some(folder) = folder.map(|folder| folder.to_string_lossy().into_owned()) else { return };
            let opened = async {
                let connection = Connection::open(&daemon, &folder, false).await?;
                match connection.installed.call(&connection.client, "project:open", json!([folder, {"takeNotice": true}])).await {
                    Ok(value) => Ok(value),
                    // A daemon that does not list `project:open` even to `daemon:status {commands: true}` (older than
                    // the desktop-commands handshake): the client refuses it before a request.
                    Err(milagre_daemon_client::Error::Capability { .. }) => {
                        Err("this Milagre's daemon can't open folders for this preview; add it in Milagre".to_owned())
                    }
                    Err(error) => Err(format!("project:open: {error}")),
                }
            }
            .await;
            let _ = this.update(cx, |this, cx| match opened {
                Ok(_) => {
                    this.notice(None, cx);
                    // The live connection's snapshot does not hold it: the next sync lists it.
                    this.daemon.resync();
                }
                Err(error) => this.failed(format!("Could not open project: {error}"), cx),
            });
        })
        .detach();
    }

    /// Puts this device's saved choices back on the sidebar.
    fn load_prefs(&mut self, cx: &mut Context<Self>) {
        let Some(path) = &self.prefs else { return };
        let Ok(text) = std::fs::read_to_string(path) else { return };
        let Ok(value) = serde_json::from_str::<Value>(&text) else {
            eprintln!("live: {} is not JSON; the sidebar starts without it", path.display());
            return;
        };
        let (pins, computers, show) = parse_prefs(&value);
        self.sidebar(cx).update(cx, |s, cx| s.set_device_prefs(pins, computers, show, cx));
    }

    /// Saves the sidebar's pins, hidden computers and Show fields (never in read-only mode).
    fn save_prefs(&mut self, cx: &mut Context<Self>) {
        if self.daemon.read_only() {
            return;
        }
        let Some(path) = self.prefs.clone() else { return };
        let sidebar = self.sidebar(cx);
        let value = {
            let s = sidebar.read(cx);
            prefs_json(s.device_pins(), &s.hidden_computers(), s.show_fields())
        };
        let written = (|| -> std::io::Result<()> {
            if let Some(folder) = path.parent() {
                std::fs::create_dir_all(folder)?;
            }
            let temporary = path.with_extension("json.tmp");
            std::fs::write(&temporary, serde_json::to_vec_pretty(&value).unwrap_or_default())?;
            std::fs::rename(&temporary, &path)
        })();
        match written {
            Ok(()) => self.saved += 1,
            Err(error) => self.failed(format!("Could not save the sidebar's pins and filters: {error}"), cx),
        }
    }
}

/// The paths a `project:recent` (or `project:set-hidden`) answer marks hidden.
pub fn hidden_in(list: &Value) -> HashSet<String> {
    list.as_array()
        .into_iter()
        .flatten()
        .filter(|project| project["hidden"] == true)
        .filter_map(|project| project["path"].as_str().map(str::to_owned))
        .collect()
}

/// This device's choices as saved: `{chatPins, hiddenComputers, chatRowShow}` (Electron's keys).
pub fn prefs_json(pins: &DevicePins, hidden_computers: &[String], show: ChatRowShow) -> Value {
    let mut computers = hidden_computers.to_vec();
    computers.sort();
    let show: serde_json::Map<String, Value> =
        CHAT_ROW_FIELDS.iter().map(|(field, _)| (field.id().to_owned(), Value::Bool(show.get(*field)))).collect();
    json!({"chatPins": pins, "hiddenComputers": computers, "chatRowShow": show})
}

/// [`prefs_json`] read back; anything missing or malformed falls back to nothing pinned, nothing hidden and the
/// desktop's Show fields.
pub fn parse_prefs(value: &Value) -> (DevicePins, HashSet<String>, ChatRowShow) {
    let pins: DevicePins = serde_json::from_value(value["chatPins"].clone()).unwrap_or_default();
    let computers = value["hiddenComputers"].as_array().into_iter().flatten().filter_map(|c| c.as_str().map(str::to_owned)).collect();
    let mut show = DESKTOP_CHAT_ROW_SHOW;
    for (field, _) in CHAT_ROW_FIELDS {
        if let Some(on) = value["chatRowShow"][field.id()].as_bool() {
            show = milagre_gpui_spike::workspace::sidebar::filters::with_field(show, field, on);
        }
    }
    (pins, computers, show)
}

/// A Chat's Worktree as Delete sees it.
#[derive(Clone, Debug)]
struct CleanupWorktree {
    path: String,
    base: Option<String>,
}

/// A Worktree to remove with its status (`seen`), when `archiveMode` is `remove`: Milagre made it (a base, under one of
/// `worktree:roots []`) and `worktree:status [path, base]` reports it `removable`. Any failed read keeps it.
async fn plan(connection: &Connection, worktree: Option<&CleanupWorktree>) -> Option<(CleanupWorktree, Value)> {
    let worktree = worktree?.clone();
    let base = worktree.base.clone()?;
    let roots = connection.call("worktree:roots", json!([])).await.ok()?;
    let roots: Vec<&str> = roots.as_array()?.iter().filter_map(Value::as_str).collect();
    if !inside_roots(&worktree.path, &roots) {
        return None;
    }
    let status = connection.call("worktree:status", json!([worktree.path, base])).await.ok()?;
    (status["removable"] == true).then_some((worktree, status))
}

/// `isInsideRoots`: a folder under one of the roots Milagre keeps its Worktrees in (not the root itself).
pub fn inside_roots(path: &str, roots: &[&str]) -> bool {
    roots.iter().any(|root| {
        let base = root.trim_end_matches('/');
        !base.is_empty() && path.len() > base.len() + 1 && path.starts_with(&format!("{base}/"))
    })
}

/// `removeFailureNotice`: the Worktree stays and the Chat comes back.
fn remove_failure(error: &str) -> String {
    if error.contains("WORKTREE_CHANGED") {
        // `gitMessage(WORKTREE_CHANGED)`.
        return "It changed after you checked, so the chat and its worktree stay.".into();
    }
    let message = error.trim_start_matches("worktree:remove: ").trim_start_matches("fatal: ").trim().trim_end_matches(['.', ' ']);
    format!("Couldn't remove the worktree: {message}. The chat stays so you can find it.")
}

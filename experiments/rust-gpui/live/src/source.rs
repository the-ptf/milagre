//! [`LiveSource`]: the app's `DataSource` on the owned runtime. The Project, its state and the runs are read from the
//! live reducer (already current: the snapshot plus every released event), so a sidebar reload answers at once and
//! never races the stream. Messages come from the client (`chat:messages`). Everything else this runtime does not
//! serve answers a typed [`NotAvailable`], never made-up data.
//!
//! On Milagre's daemon ([`LiveSource::daemon`]) the reducer holds every Project the daemon has loaded (the primary
//! connection's snapshot); they are listed in `project:known` order. A transcript is read on its own Project's client
//! (`Daemon::reader`, a short request-only connection). Nothing here opens or loads a Project: the ones the daemon
//! knows but has not loaded are the controller's name-only rows, loaded only when the person opens one.

use gpui::SharedString;
use milagre_daemon_client::Client;
use milagre_gpui_spike::data::{
    ChatRuns, ComputerId, ComputersSnapshot, DataFuture, DataSource, LOCAL, MessagePage, OpenProject, PageRequest, Project,
    PullRequestSnapshot, ScopeKey, StateRead, UsageSnapshot, ready,
};

use std::sync::Arc;

use crate::daemon::Daemon;
use crate::{DaemonAdapter, LiveStore, NotAvailable};

#[derive(Clone)]
enum Reads {
    Owned(DaemonAdapter),
    Daemon(Arc<Daemon>),
}

#[derive(Clone)]
pub struct LiveSource {
    store: LiveStore,
    reads: Reads,
    /// Milagre's daemon: the Projects it hides from the sidebar (its snapshot does not say), laid over its Projects.
    hidden: Option<Arc<crate::sidebar_writes::Hidden>>,
}

impl LiveSource {
    pub fn new(store: LiveStore, client: Client) -> Self {
        Self { store, reads: Reads::Owned(DaemonAdapter::new(client)), hidden: None }
    }

    pub fn daemon(store: LiveStore, daemon: Arc<Daemon>) -> Self {
        Self { store, reads: Reads::Daemon(daemon), hidden: None }
    }

    /// The Projects hidden from the sidebar ([`crate::sidebar_writes`]), marked `hidden` on every read.
    pub fn with_hidden(mut self, hidden: Arc<crate::sidebar_writes::Hidden>) -> Self {
        self.hidden = Some(hidden);
        self
    }

    fn projects(&self) -> anyhow::Result<Vec<OpenProject>> {
        // `shown`, not `state`: after the stream closes (a resync, a restart, a state too large) the rows stay as they
        // were until the next sync's snapshot replaces them, rather than emptying for the second or two in between.
        let mut projects = self.store.read(|reducer| reducer.shown().map(|applied| applied.projects.clone()))?;
        if let Reads::Daemon(daemon) = &self.reads {
            // `project:known` order (most recently opened first); a loaded scope it does not name (the Chats home) last.
            let known = daemon.known();
            let rank = |open: &OpenProject| known.iter().position(|k| k.path == open.project.path.as_ref()).unwrap_or(usize::MAX);
            projects.sort_by_key(rank);
        }
        if let Some(hidden) = &self.hidden {
            for open in &mut projects {
                open.project.hidden = hidden.contains(&open.project.path);
            }
        }
        if let Reads::Daemon(daemon) = &self.reads {
            for open in &mut projects {
                open.project.image = daemon.image(&open.project.path);
            }
        }
        Ok(projects)
    }

    fn project(&self, path: &str) -> anyhow::Result<OpenProject> {
        self.projects()?
            .into_iter()
            .find(|open| open.project.path.as_ref() == path)
            .ok_or_else(|| NotAvailable { method: "project:read (a Project this runtime does not own)" }.into())
    }
}

fn not_available<T: Send + 'static>(method: &'static str) -> DataFuture<T> {
    ready(Err(NotAvailable { method }.into()))
}

impl DataSource for LiveSource {
    fn computers(&self) -> DataFuture<ComputersSnapshot> {
        // Milagre's daemon with its computer vault unlocked: its paired computers ([`crate::computers`]). Otherwise
        // this computer only.
        if let Reads::Daemon(daemon) = &self.reads
            && let Some(snapshot) = daemon.computers()
        {
            return ready(Ok(snapshot));
        }
        ready(Ok(ComputersSnapshot { this_mac: "This computer".into(), computers: Vec::new() }))
    }

    fn recent_projects(&self, computer: ComputerId) -> DataFuture<Vec<Project>> {
        if computer.as_ref() != LOCAL {
            // A paired computer's Projects, as last read through `computers:invoke` ([`crate::computers`]).
            return match &self.reads {
                Reads::Daemon(daemon) => ready(Ok(daemon.remote(&computer).map(|r| r.projects).unwrap_or_default())),
                Reads::Owned(_) => ready(Ok(Vec::new())),
            };
        }
        ready(self.projects().map(|projects| projects.into_iter().map(|open| open.project).collect()))
    }

    fn current_project(&self) -> DataFuture<Option<OpenProject>> {
        ready(self.projects().map(|projects| projects.into_iter().next()))
    }

    fn open_project(&self, computer: ComputerId, folder: SharedString) -> DataFuture<OpenProject> {
        match &self.reads {
            Reads::Owned(_) if self.project(&folder).is_err() => not_available("project:open (only the owned Project)"),
            Reads::Owned(adapter) => adapter.open_project(computer, folder),
            // project:open registers, reorders the recent list and focuses: Electron's to do.
            Reads::Daemon(_) => not_available("project:open (Milagre's own window opens Projects)"),
        }
    }

    fn read_project(&self, computer: ComputerId, path: SharedString, with_state: bool) -> DataFuture<OpenProject> {
        if computer.as_ref() != LOCAL {
            return not_available("computers:invoke");
        }
        ready(self.project(&path).map(|mut open| {
            if !with_state {
                open.state = None;
            }
            open
        }))
    }

    fn read_state(&self, scope: ScopeKey) -> DataFuture<StateRead> {
        if scope.computer() != LOCAL {
            if let Reads::Daemon(daemon) = &self.reads
                && let Some(state) = daemon.remote(scope.computer()).and_then(|r| r.states.get(scope.as_str()).cloned())
            {
                return ready(Ok(state));
            }
            return not_available("computers:invoke");
        }
        ready(self.project(scope.as_str()).and_then(|open| {
            let state = open.state.ok_or_else(|| anyhow::anyhow!("the snapshot holds no state for {}", scope.as_str()))?;
            Ok(StateRead { state, stamp: open.stamp })
        }))
    }

    fn chat_runs(&self, computer: ComputerId) -> DataFuture<ChatRuns> {
        if computer.as_ref() != LOCAL {
            return match &self.reads {
                Reads::Daemon(daemon) => ready(Ok(daemon.remote(&computer).map(|r| r.runs).unwrap_or_default())),
                Reads::Owned(_) => ready(Ok(ChatRuns::default())),
            };
        }
        ready(self.store.read(|reducer| reducer.shown().map(|applied| applied.runs.clone())).map_err(Into::into))
    }

    fn chat_messages(&self, scope: ScopeKey, chat: u64, page: PageRequest) -> DataFuture<MessagePage> {
        match &self.reads {
            Reads::Owned(adapter) => adapter.chat_messages(scope, chat, page),
            Reads::Daemon(daemon) => {
                if scope.computer() != LOCAL {
                    // A paired computer's transcript: `computers:invoke [id, "chat:messages", [scope, id, page]]` on the
                    // computers' own connection.
                    let daemon = daemon.clone();
                    return Box::pin(async move {
                        let id = scope.computer().to_owned();
                        let bare = crate::computers::bare(&id, scope.as_str()).to_owned();
                        let mut options = serde_json::Map::new();
                        options.insert("turns".into(), serde_json::json!(page.turns));
                        options.insert("limit".into(), serde_json::json!(page.limit));
                        if let Some(before) = page.before {
                            options.insert("before".into(), serde_json::json!(before));
                        }
                        let body = daemon.invoke(&id, "chat:messages", serde_json::json!([bare, chat, options])).await?;
                        crate::map::message_page(&body)
                    });
                }
                let daemon = daemon.clone();
                Box::pin(async move {
                    let lease = daemon.reader(scope.as_str()).await?;
                    DaemonAdapter::new(lease.client.clone()).chat_messages(scope, chat, page).await
                })
            }
        }
    }

    fn pull_requests(&self, scope: ScopeKey) -> DataFuture<PullRequestSnapshot> {
        match &self.reads {
            // The last `pull-requests:snapshot` the controller read for this Project (the sidebar's PR chips).
            Reads::Daemon(daemon) if scope.computer() == LOCAL => ready(Ok(crate::pr::snapshot(&daemon.prs(scope.as_str())))),
            _ => not_available("pull-requests:snapshot"),
        }
    }

    fn cached_usage(&self, computer: ComputerId) -> DataFuture<UsageSnapshot> {
        match &self.reads {
            // The last `usage:cached` read ([`crate::usage`]), so a sidebar reload never asks the daemon.
            Reads::Daemon(daemon) if computer.as_ref() == LOCAL => ready(Ok(daemon.usage())),
            Reads::Daemon(_) => not_available("computers:invoke"),
            Reads::Owned(_) => not_available("usage:cached"),
        }
    }
}

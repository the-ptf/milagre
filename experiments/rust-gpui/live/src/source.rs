//! [`LiveSource`]: the app's `DataSource` on the owned runtime. The Project, its state and the runs are read from the
//! live reducer (already current: the snapshot plus every released event), so a sidebar reload answers at once and
//! never races the stream. Messages come from the client (`chat:messages`). Everything else this runtime does not
//! serve answers a typed [`NotAvailable`], never made-up data.

use gpui::SharedString;
use milagre_daemon_client::Client;
use milagre_gpui_spike::data::{
    ChatRuns, ComputerId, ComputersSnapshot, DataFuture, DataSource, LOCAL, MessagePage, OpenProject, PageRequest, Project,
    PullRequestSnapshot, ScopeKey, StateRead, UsageSnapshot, ready,
};

use crate::{DaemonAdapter, LiveStore, NotAvailable};

#[derive(Clone)]
pub struct LiveSource {
    store: LiveStore,
    adapter: DaemonAdapter,
}

impl LiveSource {
    pub fn new(store: LiveStore, client: Client) -> Self {
        Self { store, adapter: DaemonAdapter::new(client) }
    }

    fn projects(&self) -> anyhow::Result<Vec<OpenProject>> {
        self.store.read(|reducer| reducer.state().map(|applied| applied.projects.clone())).map_err(Into::into)
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
        // This computer only: the runtime has no other computers.
        ready(Ok(ComputersSnapshot { this_mac: "This computer".into(), computers: Vec::new() }))
    }

    fn recent_projects(&self, computer: ComputerId) -> DataFuture<Vec<Project>> {
        if computer.as_ref() != LOCAL {
            return ready(Ok(Vec::new()));
        }
        ready(self.projects().map(|projects| projects.into_iter().map(|open| open.project).collect()))
    }

    fn current_project(&self) -> DataFuture<Option<OpenProject>> {
        ready(self.projects().map(|projects| projects.into_iter().next()))
    }

    fn open_project(&self, computer: ComputerId, folder: SharedString) -> DataFuture<OpenProject> {
        if self.project(&folder).is_err() {
            return not_available("project:open (only the owned Project)");
        }
        self.adapter.open_project(computer, folder)
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
            return not_available("computers:invoke");
        }
        ready(self.project(scope.as_str()).and_then(|open| {
            let state = open.state.ok_or_else(|| anyhow::anyhow!("the snapshot holds no state for {}", scope.as_str()))?;
            Ok(StateRead { state, stamp: open.stamp })
        }))
    }

    fn chat_runs(&self, computer: ComputerId) -> DataFuture<ChatRuns> {
        if computer.as_ref() != LOCAL {
            return ready(Ok(ChatRuns::default()));
        }
        ready(self.store.read(|reducer| reducer.state().map(|applied| applied.runs.clone())).map_err(Into::into))
    }

    fn chat_messages(&self, scope: ScopeKey, chat: u64, page: PageRequest) -> DataFuture<MessagePage> {
        self.adapter.chat_messages(scope, chat, page)
    }

    fn pull_requests(&self, _scope: ScopeKey) -> DataFuture<PullRequestSnapshot> {
        not_available("pull-requests:snapshot")
    }

    fn cached_usage(&self, _computer: ComputerId) -> DataFuture<UsageSnapshot> {
        not_available("usage:cached")
    }
}

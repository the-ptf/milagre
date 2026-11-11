//! [`DaemonAdapter`]: the GPUI crate's read-only [`DataSource`] over one connected [`Client`].
//!
//! Six reads go to the client (`project:current`, `project:open`, `project:read`, `state:read`, `chat:runs`,
//! `chat:messages`) and their bodies are decoded by [`crate::map`]. The rest of the trait has no client method in
//! this stage and answers [`NotAvailable`]: never fake data. Another computer's id or a qualified scope key is
//! [`NotAvailable`] too (the client has no `computers:invoke`). A client error is passed through whole, as
//! `milagre_daemon_client::Error` inside the `anyhow::Error` (downcast it to tell `StateTooLarge` or `Remote` apart).

use gpui::SharedString;
use milagre_daemon_client::{ChatPageOptions, Client};
use milagre_gpui_spike::data::{
    ChatId, ChatRuns, ComputerId, ComputersSnapshot, DataFuture, DataSource, LOCAL, MessagePage, OpenProject, PageRequest, Project,
    PullRequestSnapshot, ScopeKey, StateRead, UsageSnapshot, ready,
};

use crate::map;

/// A `DataSource` method (or a computer) the shared client does not provide in this stage.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NotAvailable {
    /// The daemon method, or `computers:invoke` for another computer's call.
    pub method: &'static str,
}

impl std::fmt::Display for NotAvailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} is not available in this stage: the shared daemon client does not provide it", self.method)
    }
}

impl std::error::Error for NotAvailable {}

fn not_available<T: Send + 'static>(method: &'static str) -> DataFuture<T> {
    ready(Err(NotAvailable { method }.into()))
}

/// Reads through one connected client. Off by default: nothing in the GPUI app constructs it; a test or a later
/// stage installs it as `data::Data` explicitly.
#[derive(Clone)]
pub struct DaemonAdapter {
    client: Client,
}

impl DaemonAdapter {
    pub fn new(client: Client) -> Self {
        Self { client }
    }

    pub fn client(&self) -> &Client {
        &self.client
    }

    fn local(computer: &str) -> anyhow::Result<()> {
        if computer == LOCAL { Ok(()) } else { Err(NotAvailable { method: "computers:invoke" }.into()) }
    }
}

impl DataSource for DaemonAdapter {
    fn computers(&self) -> DataFuture<ComputersSnapshot> {
        not_available("computers:list")
    }

    fn recent_projects(&self, _computer: ComputerId) -> DataFuture<Vec<Project>> {
        not_available("project:recent")
    }

    fn current_project(&self) -> DataFuture<Option<OpenProject>> {
        let client = self.client.clone();
        Box::pin(async move {
            let body = client.project_current().await?;
            Ok(Some(map::open_project(&body)?))
        })
    }

    fn open_project(&self, computer: ComputerId, folder: SharedString) -> DataFuture<OpenProject> {
        let client = self.client.clone();
        Box::pin(async move {
            Self::local(&computer)?;
            map::open_project(&client.open_view(&folder).await?)
        })
    }

    fn read_project(&self, computer: ComputerId, path: SharedString, with_state: bool) -> DataFuture<OpenProject> {
        let client = self.client.clone();
        Box::pin(async move {
            Self::local(&computer)?;
            let project = map::open_project(&client.project_read(&path, with_state).await?)?;
            if with_state != project.state.is_some() {
                anyhow::bail!("project:read with state {with_state} answered with state {}", project.state.is_some());
            }
            Ok(project)
        })
    }

    fn read_state(&self, scope: ScopeKey) -> DataFuture<StateRead> {
        let client = self.client.clone();
        Box::pin(async move {
            Self::local(scope.computer())?;
            map::state_read(&client.state_read(scope.as_str()).await?)
        })
    }

    fn chat_runs(&self, computer: ComputerId) -> DataFuture<ChatRuns> {
        let client = self.client.clone();
        Box::pin(async move {
            Self::local(&computer)?;
            map::chat_runs(&client.chat_runs().await?)
        })
    }

    fn chat_messages(&self, scope: ScopeKey, chat: ChatId, page: PageRequest) -> DataFuture<MessagePage> {
        let client = self.client.clone();
        Box::pin(async move {
            Self::local(scope.computer())?;
            let options = ChatPageOptions { before: page.before, turns: Some(page.turns as u64), limit: Some(page.limit as u64) };
            map::message_page(&client.chat_messages(scope.as_str(), chat, options).await?)
        })
    }

    fn pull_requests(&self, _scope: ScopeKey) -> DataFuture<PullRequestSnapshot> {
        not_available("pull-requests:snapshot")
    }

    fn cached_usage(&self, _computer: ComputerId) -> DataFuture<UsageSnapshot> {
        not_available("usage:cached")
    }
}

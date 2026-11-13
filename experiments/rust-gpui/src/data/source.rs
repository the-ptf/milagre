//! [`DataSource`]: where the UI's data comes from. Read-only. [`super::FixtureSource`] implements it now; a
//! daemon client's adapter implements it later (the `experiments/rust-daemon-client` crate Chat #10904's team is
//! writing, speaking the protocol of `apps/daemon/src/client.cjs`: newline-framed JSON over the daemon's socket,
//! `{ v, id, method, args, pages }` out, `{ v, id, result | error | pages }` back, events pushed in between).
//!
//! Each method is one daemon method, named in its doc with the TypeScript type of its answer; the adapter decodes
//! that JSON into the domain types (each type's doc names its TypeScript source). A method on another computer goes
//! through `computers:invoke(id, method, args)`: the adapter does that when the `computer` argument is not
//! [`super::LOCAL`] or the scope key is qualified (`<computer>|<path>`), and qualifies the keys of the answer
//! (Chat keys in `chat:runs`) the way `daemon/computer-routing.cjs` does.
//!
//! Numbering, for the state store that will hold these answers (WP-05, `lib/state-events.ts`): every reply that
//! carries a scope's state carries its [`super::StateStamp`] (`version` +1 per send, `epoch` per host run); a
//! `project:state` event's patch applies when its `base` equals the held version in the same epoch, else the scope
//! is read again with [`DataSource::read_state`]. [`super::ChatRuns::seq`] is the runs sequence: an `agent:event`
//! with `seq` at or below it is already in the runs. Events themselves are not part of this trait yet.
//!
//! Every method returns a `Send` future, so a view can run it on GPUI's background executor and come back to the
//! foreground with the result:
//!
//! ```ignore
//! let source = cx.global::<Data>().0.clone();   // Arc<dyn DataSource>
//! cx.spawn(async move |this, cx| {
//!     let read = source.read_state(scope).await?;
//!     this.update(cx, |this, cx| { this.set_state(read.state); cx.notify(); })
//! })
//! .detach();
//! ```
//!
//! Errors are `anyhow::Error` carrying the daemon's message ("Open the Project before reading its messages."),
//! shown to the user as is.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use gpui::{Global, SharedString};

use super::{ChatId, ChatRuns, ComputerId, ComputersSnapshot, MessagePage, OpenProject, PageRequest, Project, PullRequestSnapshot};
use super::{ScopeKey, StateRead, UsageSnapshot};

/// A boxed `Send` future of a daemon call's result.
pub type DataFuture<T> = Pin<Box<dyn Future<Output = anyhow::Result<T>> + Send + 'static>>;

pub trait DataSource: Send + Sync + 'static {
    /// `computers:list` → `ComputersSnapshot`: this Mac's name and the computers it drives. Local only.
    fn computers(&self) -> DataFuture<ComputersSnapshot>;

    /// `project:recent` → `RecentProject[]` on `computer`, most recently opened first, hidden ones included (the
    /// lists leave them out). The Chats home is not in it; it comes from `chats:home`, folded in here as the last
    /// entry with [`super::ProjectKind::ChatsHome`] so a list reads one call per computer.
    fn recent_projects(&self, computer: ComputerId) -> DataFuture<Vec<Project>>;

    /// `project:current` → `OpenProject` with its stamp, or `None` when there is none yet (onboarding): the Project
    /// the window opens on (the last one, or the Chats home). Local only.
    fn current_project(&self) -> DataFuture<Option<OpenProject>>;

    /// `project:open [folder]` on `computer` → `OpenProject` with its stamp: opens a folder as a Project
    /// (registering it and putting it at the top of the recent list) and returns it with its state.
    fn open_project(&self, computer: ComputerId, folder: SharedString) -> DataFuture<OpenProject>;

    /// `project:read [path, { state }]` on `computer` → `OpenProject` with its stamp, or with `with_state: false`
    /// `ProjectRead`: the Project and the number of its last state, without the state.
    fn read_project(&self, computer: ComputerId, path: SharedString, with_state: bool) -> DataFuture<OpenProject>;

    /// `state:read [scope]` → `{ state, version, epoch }`: the whole lean state of an open Project or Link.
    fn read_state(&self, scope: ScopeKey) -> DataFuture<StateRead>;

    /// `chat:runs` on `computer` → `{ runs, seq }`: every turn streaming there, by Chat key.
    fn chat_runs(&self, computer: ComputerId) -> DataFuture<ChatRuns>;

    /// `chat:messages [scope, chatId, { before, turns, limit }]` → `{ messages, hasMore, total }`: one page of a
    /// Chat's messages, oldest first.
    fn chat_messages(&self, scope: ScopeKey, chat: ChatId, page: PageRequest) -> DataFuture<MessagePage>;

    /// `pull-requests:snapshot [projectPath]` → `PullRequestSnapshot`: the PRs the host's poll last found for a
    /// Project's Worktrees and the PRs its Chats name.
    fn pull_requests(&self, scope: ScopeKey) -> DataFuture<PullRequestSnapshot>;

    /// `usage:cached` on `computer` → `UsageSnapshot`: the last plan usage read, without reading again.
    fn cached_usage(&self, computer: ComputerId) -> DataFuture<UsageSnapshot>;
}

/// The app's data source, as a GPUI global (`cx.global::<Data>()`).
#[derive(Clone)]
pub struct Data(pub Arc<dyn DataSource>);

impl Global for Data {}

/// A future that is already done, for sources that answer synchronously (the fixture, tests).
pub fn ready<T: Send + 'static>(value: anyhow::Result<T>) -> DataFuture<T> {
    Box::pin(std::future::ready(value))
}

/// A future polled once: its answer, or the future to run on an executor.
pub enum Polled<T> {
    Ready(anyhow::Result<T>),
    Pending(DataFuture<T>),
}

/// Polls `future` once without an executor. A view uses it to show what a synchronous source (the fixture)
/// answers in its first frame, and spawns the future otherwise.
pub fn poll_once<T>(mut future: DataFuture<T>) -> Polled<T> {
    use std::task::{Context, Poll, Waker};
    match future.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
        Poll::Ready(result) => Polled::Ready(result),
        Poll::Pending => Polled::Pending(future),
    }
}

/// The answer of a future that is ready at once (every [`super::FixtureSource`] future), without an executor.
/// Panics on a future that is still pending: use it only on sources that answer synchronously.
pub fn now<T>(future: DataFuture<T>) -> anyhow::Result<T> {
    match poll_once(future) {
        Polled::Ready(result) => result,
        Polled::Pending(_) => panic!("`data::now` on a future that is not ready: run it on an executor instead"),
    }
}

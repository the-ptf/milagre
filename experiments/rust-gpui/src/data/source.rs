//! [`DataSource`]: where the UI's data comes from. One implementation per backend: [`super::FixtureSource`]
//! now; a client of the local daemon later, speaking the same protocol as the Node client in
//! `apps/daemon/src/client.cjs` (newline-framed JSON over the daemon's socket: `{ v, id, method, args }`
//! out, `{ v, id, result | error | pages }` back, events pushed in between).
//!
//! Each method is one daemon call, named in its doc. Every method returns a `Send` future, so a view can
//! run it on GPUI's background executor and come back to the foreground with the result:
//!
//! ```ignore
//! let source = cx.global::<Data>().0.clone();   // Arc<dyn DataSource>
//! cx.spawn(async move |this, cx| {
//!     let state = source.read_state(scope).await?;
//!     this.update(cx, |this, cx| { this.set_state(state); cx.notify(); })
//! })
//! .detach();
//! ```
//!
//! Errors are `anyhow::Error` carrying the daemon's message ("Open the Project before reading its
//! messages."), shown to the user as is.

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use gpui::Global;

use super::{ChatId, ChatRuns, MessagePage, PageRequest, ProjectSnapshot, ScopeKey, ScopeState};

/// A boxed `Send` future of a daemon call's result.
pub type DataFuture<T> = Pin<Box<dyn Future<Output = anyhow::Result<T>> + Send + 'static>>;

pub trait DataSource: Send + Sync + 'static {
    /// `project:current`: the Project the window opens on (the last one, or the Chats home), or `None`
    /// when there is none yet (onboarding).
    fn current_project(&self) -> DataFuture<Option<ProjectSnapshot>>;

    /// `project:open [folder]`: opens a folder as a Project (registering it and putting it at the top of
    /// the recent list) and returns it with its state.
    fn open_project(&self, folder: PathBuf) -> DataFuture<ProjectSnapshot>;

    /// `state:read [scope]`: the whole state of an open Project or Link.
    fn read_state(&self, scope: ScopeKey) -> DataFuture<ScopeState>;

    /// `project:read [path, { state }]`: a Project this computer knows, with its state unless
    /// `with_state` is false.
    fn read_project(&self, path: PathBuf, with_state: bool) -> DataFuture<ProjectSnapshot>;

    /// `chat:runs`: the Chats running or waiting on the user, on every open scope.
    fn chat_runs(&self) -> DataFuture<ChatRuns>;

    /// `chat:messages [scope, chatId, { before, turns }]`: one page of a Chat's messages, oldest first.
    fn chat_messages(&self, scope: ScopeKey, chat: ChatId, page: PageRequest) -> DataFuture<MessagePage>;
}

/// The app's data source, as a GPUI global (`cx.global::<Data>()`).
#[derive(Clone)]
pub struct Data(pub Arc<dyn DataSource>);

impl Global for Data {}

/// A future that is already done, for sources that answer synchronously (the fixture, tests).
pub fn ready<T: Send + 'static>(value: anyhow::Result<T>) -> DataFuture<T> {
    Box::pin(std::future::ready(value))
}

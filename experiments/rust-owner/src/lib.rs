//! Rust repositories for Milagre's saved Project state: reads byte-compatible with the Node daemon, and the owner's writes
//! for isolated copies only. The first step of moving the owner backend to Rust; no live data is ever written.
//!
//! What it covers (see README.md for the full list and the limits):
//! - [`project`]: `.milagre/coordination.json`, subagent and step-detail sidecars (project-store.cjs, project-content.cjs).
//! - [`chat_db`]: `.milagre/chats.db` message rows, query for query as chat-db.cjs runs them.
//! - [`commands`]: `chat:messages`, `chat:message` and `chat:send-status` answers from saved files (runtime.cjs).
//! - [`ownership`]: what ownership.cjs would decide about a lock, and the Rust owner lock (never takes one over).
//! - [`write`](mod@write): the write contracts of a Rust owner, implemented by [`owner::OwnedProject`].
//! - [`owner`]: writeMessages, saveProjectState and the owner lock, for isolated copies only.
//! - [`isolation`]: the only folders the owner may write in (an explicit marker; Milagre's own folders refused).
//! - [`message_store`]: message-store.cjs lazy Chats over shared (`Arc`) messages, and the daemon's message patches.
//! - [`states`]: project-states.cjs: write-behind, sweeps, the read commands and the `call` command boundary.
//! - [`search`]: message-search.mjs and chatSearch.
//! - [`audit`]: the read-only audit behind the `milagre-owner-store audit` command.
//! - [`jsjson`]: `JSON.parse`/`JSON.stringify`-exact JSON, unpaired surrogates included.

pub mod audit;
pub mod chat_db;
pub mod commands;
pub mod error;
pub mod isolation;
pub mod jsjson;
pub mod message_store;
pub mod owner;
pub mod ownership;
pub mod project;
pub mod search;
pub mod states;
pub mod write;

pub use chat_db::{ChatDb, ChatId, LookupField, MessageRepository, Preview, Row};
pub use commands::{chat_page, PageOptions, ProjectReader};
pub use error::{Result, StoreError};
pub use isolation::{Isolation, Policy};
pub use owner::OwnedProject;
pub use project::{MessageStorage, ProjectRepository, ProjectStateRead, ProjectStore};

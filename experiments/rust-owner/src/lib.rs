//! Read-only Rust repositories for Milagre's saved Project state, the first step of moving the owner backend to Rust.
//!
//! What it covers (see README.md for the full list and the limits):
//! - [`project`]: `.milagre/coordination.json`, subagent and step-detail sidecars (project-store.cjs, project-content.cjs).
//! - [`chat_db`]: `.milagre/chats.db` message rows, query for query as chat-db.cjs runs them.
//! - [`commands`]: `chat:messages`, `chat:message` and `chat:send-status` answers from saved files (runtime.cjs).
//! - [`ownership`]: what ownership.cjs would decide about a lock, without touching it.
//! - [`write`]: the write contracts a later Rust owner implements. Nothing here implements them.
//! - [`audit`]: the read-only audit behind the `milagre-owner-store audit` command.
//! - [`jsjson`]: `JSON.stringify`-exact output, so results match the daemon byte for byte.

pub mod audit;
pub mod chat_db;
pub mod commands;
pub mod error;
pub mod jsjson;
pub mod ownership;
pub mod project;
pub mod write;

pub use chat_db::{ChatDb, ChatId, LookupField, MessageRepository, Preview, Row};
pub use commands::{chat_page, PageOptions, ProjectReader};
pub use error::{Result, StoreError};
pub use project::{MessageStorage, ProjectRepository, ProjectStateRead, ProjectStore};

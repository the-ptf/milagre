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
//! - [`agent_runs`]: agent-runs.mjs: runs and the agent events folded into the state (unported ones refused).
//! - [`tool_activity`]: summarizeStep and capOutput, the facts a finished tool step keeps.
//! - [`changed_files`]: the minimal brief's changed files: hardened `git status` in admitted worktrees only.
//! - [`brief`]: the handoff brief's model boundary (nonblocking, bounded, typed text), and a scripted fake for tests.
//! - [`transcripts`]: handover transcripts written off the actor as bounded, owned jobs (pinned descriptors).
//! - [`handover`]: handover.cjs's pure parts: the transcript, its cut and path, the framed brief and the brief text.
//! - [`chat_host`]: chat-host.cjs sends, receipts, queue and turns, with agents behind the `Provider` trait.
//! - [`audit`]: the read-only audit behind the `milagre-owner-store audit` command.
//! - [`jsjson`]: `JSON.parse`/`JSON.stringify`-exact JSON, unpaired surrogates and `undefined`-valued keys included.

pub mod agent_runs;
pub mod audit;
pub mod brief;
pub mod changed_files;
pub mod chat_db;
pub mod chat_host;
pub mod chat_summaries;
pub mod commands;
pub mod error;
pub mod handover;
mod images;
pub mod isolation;
pub mod jsjson;
pub mod message_store;
pub mod owner;
pub mod ownership;
pub mod project;
pub mod search;
pub mod states;
pub mod tool_activity;
pub mod transcripts;
pub mod write;

pub use chat_db::{ChatDb, ChatId, LookupField, MessageRepository, Preview, Row};
pub use commands::{chat_page, PageOptions, ProjectReader};
pub use error::{Result, StoreError};
pub use isolation::{Isolation, Policy};
pub use owner::OwnedProject;
pub use project::{MessageStorage, ProjectRepository, ProjectStateRead, ProjectStore};

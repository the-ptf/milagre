//! Write-side contracts a later Rust owner implements. **Nothing in this crate implements them**: it never writes a
//! Project, never takes an owner lock and never starts a second writer. The traits pin down what the Node writers do
//! today, so a Rust implementation can be checked against the same fixtures before it is allowed to own real data.
//!
//! Single-writer rule (ADR-0003): only the process holding the owner lock may call any of these, and it must be the
//! only process writing the Project. A comparison run never writes the same Project from Node and Rust.

use std::collections::{BTreeSet, HashMap};
use std::path::Path;

use serde_json::Value;

use crate::chat_db::{ChatId, MessageRepository, Row};
use crate::error::Result;
use crate::project::ProjectRepository;

/// What chats.db holds for the Chats in memory: message id (as JSON text of the id) -> row. message-store.cjs
/// `savedRows`.
pub type SavedRows = HashMap<String, Row>;

/// chat-db.cjs writeMessages options.
#[derive(Clone, Debug, Default)]
pub struct WriteOptions {
    /// `PRAGMA synchronous = FULL` instead of NORMAL.
    pub durable: bool,
    /// Unloaded Chats whose rows stay as they are, whatever `saved` says.
    pub keep: BTreeSet<ChatId>,
    /// Unloaded Chats gone from the state: their rows are deleted.
    pub drop: BTreeSet<ChatId>,
}

/// chat-db.cjs writeMessages stats.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WriteStats {
    pub written: u64,
    pub removed: u64,
    pub renumbered: bool,
}

/// The write half of chats.db, contract of chat-db.cjs writeMessages:
///
/// 1. Opens (creating `.milagre/` and the schema if needed), one `BEGIN … COMMIT` for everything below.
/// 2. `known` = `saved`, or every row's (id, chat, position) read from the table when `saved` is None.
/// 3. Walks `messages` in order. A message keeps its known position while that stays strictly increasing; otherwise
///    it takes `MAX(position) + 1`. A row is upserted (by `id`) only when it is new, its message object changed or its
///    position changed. `client_message_id`, `operation_id` and `session_id` columns mirror the payload.
/// 4. Deletes known rows the messages no longer have, unless their Chat is in `keep`; deletes every row of `drop`.
/// 5. When `MAX(position) != COUNT(*) - 1`, renumbers positions 0..n-1 in (position, id) order (releases before
///    ADR-0009 append at the array's length and rely on it).
/// 6. Returns the next `SavedRows` and stats, and must publish them before any other read of the Project runs.
///
/// Payloads are `JSON.stringify` text ([`crate::jsjson::to_string`]); ids are bound as doubles, as node:sqlite does.
pub trait MessageStoreWriter: MessageRepository {
    fn write_messages(
        &self,
        messages: &[Value],
        saved: Option<&SavedRows>,
        options: &WriteOptions,
    ) -> Result<(SavedRows, WriteStats)>;
}

/// project-store.cjs saveProjectState, for a Rust owner: migrate inline images, compact details and subagent
/// transcripts into content-addressed sidecars, drop suggestions, write messages first, then coordination.json (with
/// `messages` replaced by the chats.db marker) through a temporary file and a rename, then sweep unreferenced sidecars
/// older than a minute. The first save of an inline (pre-chats.db) state copies coordination.json to
/// `coordination.json.before-chats-db` once.
pub trait ProjectStateWriter: ProjectRepository {
    fn save_project_state(&self, state: &Value, durable: bool) -> Result<SaveReport>;
}

/// What saveProjectState resolves with.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SaveReport {
    pub rows_written: u64,
    pub rows_removed: u64,
    pub sidecars_written: bool,
    pub state_bytes: u64,
}

/// ownership.cjs acquireOwnership: `mkdir` the lock (0700) as the atomic decision, take over only a lock whose owner
/// is certainly gone (via a second `<lock>.takeover` directory), write `owner.json` (0600, exclusive) and release by
/// token. A Rust owner must interoperate with Node owners holding the same lock paths.
pub trait OwnerLock {
    type Guard;
    fn acquire(&self, lock: &Path) -> Result<Self::Guard>;
}

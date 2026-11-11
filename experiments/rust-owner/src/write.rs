//! Write-side contracts of a Rust owner, implemented by [`crate::owner::OwnedProject`] for isolated copies only.
//!
//! Single-writer rule (ADR-0003): only the process holding the Project's owner lock may call any of these, and it must
//! be the only process writing the Project. `OwnedProject` can only be made inside an [`crate::isolation::Isolation`]
//! and holds the lock for its lifetime; there is no way to point these at a live profile or Project.

use std::collections::{BTreeSet, HashMap};
use std::path::Path;
use std::time::Duration;

use serde_json::Value;

use crate::chat_db::{ChatId, MessageRepository, Row};
use crate::error::Result;
use crate::project::ProjectRepository;

/// What chats.db holds for the Chats in memory, keyed by the message id as JSON text (`jsjson::to_string(id)`, so
/// `1` and `1.0` are one key as in a JavaScript Map). message-store.cjs `savedRows`.
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

/// The write half of chats.db, chat-db.cjs writeMessages:
///
/// 1. Opens (creating `.milagre/` and the schema if needed), one `BEGIN … COMMIT` for everything below, `ROLLBACK`
///    and the error on any failure.
/// 2. `known` = `saved`, or every row's (id, chat, position) read from the table when `saved` is None.
/// 3. Walks `messages` in order. A message keeps its known position while that stays strictly increasing; otherwise
///    it takes `MAX(position) + 1`. A row is upserted (by `id`) when it is new, its message changed or its position
///    changed. `client_message_id`, `operation_id` and `session_id` columns mirror the payload.
/// 4. Deletes known rows the messages no longer have, unless their Chat is in `keep`; deletes every row of `drop`.
/// 5. When `MAX(position) != COUNT(*) - 1`, renumbers positions 0..n-1 in (position, id) order.
/// 6. Returns the next `SavedRows` (`saved` updated, or only what was written when `saved` was None) and stats.
///
/// Node decides "changed" by object identity, Rust by value: a Node save of an equal but new object rewrites the row
/// with the same bytes, Rust skips it. The database ends the same; `written` can be lower.
pub trait MessageStoreWriter: MessageRepository {
    fn write_messages(
        &mut self,
        messages: &[Value],
        saved: Option<&SavedRows>,
        options: &WriteOptions,
    ) -> Result<(SavedRows, WriteStats)>;
}

/// project-store.cjs saveProjectState options.
#[derive(Clone, Debug)]
pub struct SaveOptions {
    /// Sync the bytes and the rename to disk before returning (and `PRAGMA synchronous = FULL`).
    pub durable: bool,
    /// Chats whose messages the state doesn't hold (message-store.cjs unloadedChats): their rows are kept while
    /// their session exists, deleted when it is gone.
    pub unloaded: BTreeSet<ChatId>,
    /// Unreferenced sidecars younger than this stay (a save in flight may own them). Node's default is a minute.
    pub sweep_min_age: Duration,
    /// The clock sweeps measure age against (Node's `Date.now`); the system clock when None.
    pub now: Option<std::time::SystemTime>,
}

impl Default for SaveOptions {
    fn default() -> Self {
        SaveOptions {
            durable: false,
            unloaded: BTreeSet::new(),
            sweep_min_age: Duration::from_secs(60),
            now: None,
        }
    }
}

/// What saveProjectState resolves with.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SaveReport {
    pub rows_written: u64,
    pub rows_removed: u64,
    pub sidecars_written: bool,
    pub state_bytes: u64,
}

impl SaveReport {
    /// `{ rowsWritten, rowsRemoved, sidecarsWritten, stateBytes }`, Node's shape.
    pub fn to_value(&self) -> Value {
        serde_json::json!({
            "rowsWritten": self.rows_written,
            "rowsRemoved": self.rows_removed,
            "sidecarsWritten": self.sidecars_written,
            "stateBytes": self.state_bytes,
        })
    }
}

/// project-store.cjs saveProjectState: migrate inline images, move long step details and subagent transcripts into
/// content-addressed sidecars, drop suggestions, write messages first, then coordination.json (with `messages`
/// replaced by the chats.db marker) through a temporary file and a rename, then sweep unreferenced sidecars. The first
/// save of a run copies coordination.json to `coordination.json.before-chats-db` once (never over an existing copy).
pub trait ProjectStateWriter: ProjectRepository {
    fn save_project_state(&mut self, state: &Value, options: &SaveOptions) -> Result<SaveReport>;
}

/// ownership.cjs acquireOwnership's lock format: `mkdir` (0700) as the atomic decision, `owner.json` (0600,
/// exclusive) with `{ pid, token, startedAt, processStartedAt, host }`, release by token. Node and Rust owners exclude
/// each other through the same paths. Unlike Node, the Rust implementation never takes a lock over, stale or not.
pub trait OwnerLock {
    type Guard;
    /// Takes `lock` (a path inside `root`) and pins `root`, so the guard never removes anything outside it.
    fn acquire(&self, root: &Path, lock: &Path) -> Result<Self::Guard>;
}

//! Read-only audit of copied Projects: can the Rust readers read them, and what would a Rust owner meet there.
//!
//! Safety rules, enforced here rather than left to the caller:
//! - The directory is given explicitly; there is no default and no discovery of live Projects.
//! - A directory inside Milagre's own data folder is refused (copy what you want to audit out of it first).
//! - A Project whose `.milagre/runtime.lock` names a live owner is refused unless the caller says the lock was copied
//!   along with the files (`allow_copied_lock`): the original may be in use, and this must not run against it.
//! - Every read is read-only: chats.db is opened `mode=ro&immutable=1`, files are only opened for reading. The report
//!   records a fingerprint of every file before and after, and fails if anything changed.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde_json::{json, Map, Value};

use crate::chat_db::{sql_value, ChatId, MessageRepository};
use crate::error::StoreError;
use crate::jsjson;
use crate::ownership::{self, LockState, ProcessProbe};
use crate::project::{MessageStorage, ProjectRepository, ProjectStore};

#[derive(Clone, Debug, Default)]
pub struct AuditOptions {
    pub allow_copied_lock: bool,
    /// Milagre data folders to refuse (default: the platform's, see [`default_data_dirs`]).
    pub data_dirs: Vec<PathBuf>,
}

/// Where Milagre keeps its own state on this computer.
pub fn default_data_dirs() -> Vec<PathBuf> {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return Vec::new();
    };
    vec![
        home.join("Library/Application Support/Milagre"),
        home.join(".config/Milagre"),
        home.join(".milagre/data"),
    ]
}

#[derive(Debug)]
pub enum AuditError {
    NotADirectory(PathBuf),
    InsideDataDir {
        fixture: PathBuf,
        data_dir: PathBuf,
    },
    LiveLock {
        project: PathBuf,
        owner: Option<Value>,
    },
    Changed(Vec<String>),
}

impl std::fmt::Display for AuditError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AuditError::NotADirectory(path) => write!(f, "{} is not a directory.", path.display()),
            AuditError::InsideDataDir { fixture, data_dir } => write!(
                f,
                "{} is inside Milagre's data folder {}. Copy the Projects you want to audit somewhere else and pass that copy.",
                fixture.display(),
                data_dir.display()
            ),
            AuditError::LiveLock { project, owner } => write!(
                f,
                "{} has an owner lock whose process is running ({}). Audit a copy: if this already is one, pass --allow-copied-lock.",
                project.display(),
                owner.as_ref().map(jsjson::to_string).unwrap_or_else(|| "no readable owner record".into())
            ),
            AuditError::Changed(files) => write!(f, "Files changed while auditing (another writer is using this folder): {}", files.join(", ")),
        }
    }
}

impl std::error::Error for AuditError {}

/// The Projects under `root` (itself included): folders with `.milagre/coordination.json` or `.milagre/chats.db`.
pub fn find_projects(root: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let metadata = dir.join(".milagre");
        if metadata.join("coordination.json").is_file() || metadata.join("chats.db").is_file() {
            found.push(dir.clone());
        }
        if depth >= 4 {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if matches!(
                name.as_ref(),
                ".milagre" | ".git" | "node_modules" | "target"
            ) {
                continue;
            }
            if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                stack.push((entry.path(), depth + 1));
            }
        }
    }
    found.sort();
    found
}

/// (size, mtime) of every file under `root`.
fn fingerprint(root: &Path) -> BTreeMap<PathBuf, (u64, Option<SystemTime>)> {
    let mut out = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                stack.push(entry.path());
            } else {
                out.insert(entry.path(), (meta.len(), meta.modified().ok()));
            }
        }
    }
    out
}

fn issue(kind: &str, detail: Value) -> Value {
    json!({ "kind": kind, "detail": detail })
}

fn error_value(error: &StoreError) -> Value {
    let mut map = Map::new();
    map.insert("message".into(), Value::String(error.to_string()));
    if let Some(code) = error.code() {
        map.insert("code".into(), Value::String(code.into()));
    }
    Value::Object(map)
}

fn storage_label(storage: MessageStorage) -> &'static str {
    match storage {
        MessageStorage::ChatsDb => "chats.db",
        MessageStorage::Inline => "inline",
        MessageStorage::Absent => "absent",
    }
}

fn as_chat(value: &Value) -> Option<ChatId> {
    value.as_i64().or_else(|| {
        value
            .as_f64()
            .filter(|number| number.fract() == 0.0)
            .map(|number| number as i64)
    })
}

/// Audits one Project. Never fails: what can't be read is reported.
pub fn audit_project(project: &Path, display: &str, probe: &dyn ProcessProbe) -> Value {
    let store = ProjectStore::new(project);
    let mut issues: Vec<Value> = Vec::new();
    let mut report = Map::new();
    report.insert("project".into(), Value::String(display.into()));
    report.insert(
        "lock".into(),
        Value::String(
            ownership::inspect(&ownership::project_lock(project), probe)
                .label()
                .into(),
        ),
    );

    let read = store.read_project_state();
    let pending_names: Vec<String> = read
        .as_ref()
        .map(|read| {
            read.pending_sidecars
                .iter()
                .map(|(name, _)| name.clone())
                .collect()
        })
        .unwrap_or_default();
    let (state, storage) = match &read {
        Ok(read) => {
            report.insert(
                "storage".into(),
                Value::String(storage_label(read.storage).into()),
            );
            if !read.pending_detail_compaction.is_empty() {
                issues.push(issue(
                    "pending-detail-compaction",
                    json!({ "messages": read.pending_detail_compaction, "note": "Node moves these details to sidecars on its next read; a Rust owner must too." }),
                ));
            }
            (Some(read.state.clone()), Some(read.storage))
        }
        Err(error) => {
            issues.push(issue("state-unreadable", error_value(error)));
            (None, None)
        }
    };

    let sessions: BTreeSet<ChatId> = state
        .as_ref()
        .and_then(|state| state.get("sessions"))
        .and_then(Value::as_object)
        .map(|sessions| {
            sessions
                .values()
                .filter_map(|session| session.get("id").and_then(as_chat))
                .collect()
        })
        .unwrap_or_default();
    report.insert("sessions".into(), Value::from(sessions.len()));

    // Row-level scan of chats.db: columns against payloads, positions, receipts.
    let scan = store.chats().query(|connection| {
        let mut statement = connection.prepare("SELECT id, session_id, position, client_message_id, operation_id, payload FROM messages ORDER BY position, id")?;
        let mut rows = statement.query([])?;
        let mut stats = RowScan::default();
        while let Some(row) = rows.next()? {
            let id = sql_value(row.get_ref(0)?);
            let chat = sql_value(row.get_ref(1)?);
            let position = sql_value(row.get_ref(2)?);
            let client = sql_value(row.get_ref(3)?);
            let operation = sql_value(row.get_ref(4)?);
            let payload: String = row.get(5)?;
            stats.rows += 1;
            match &position {
                Value::Number(number) if number.is_i64() => {
                    let position = number.as_i64().unwrap();
                    if !stats.positions.insert(position) {
                        stats.duplicate_positions.push(position);
                    }
                }
                other => stats.bad_positions.push(other.clone()),
            }
            match as_chat(&chat) {
                Some(chat_id) => *stats.per_chat.entry(chat_id).or_default() += 1,
                None => stats.null_session += 1,
            }
            let message: Value = match serde_json::from_str(&payload) {
                Ok(message) => message,
                Err(error) => {
                    stats.unparsable.push(json!({ "id": id, "error": error.to_string() }));
                    continue;
                }
            };
            let undefined_is_null = |key: &str| message.get(key).cloned().unwrap_or(Value::Null);
            for (column, key, value) in [("id", "id", &id), ("session_id", "session_id", &chat), ("client_message_id", "clientMessageId", &client), ("operation_id", "operationId", &operation)] {
                let expected = undefined_is_null(key);
                if !(jsjson::strict_equals(&expected, value)) {
                    stats.mismatches.push(json!({ "id": id, "column": column, "column_value": value, "payload_value": expected }));
                }
            }
            if let Value::String(client) = &client {
                *stats.client_ids.entry(client.clone()).or_default() += 1;
            }
            if let Some(id) = id.as_f64() {
                stats.max_id = stats.max_id.max(id);
            }
        }
        Ok(stats)
    });
    match scan {
        Ok(Some(stats)) => {
            report.insert("rows".into(), Value::from(stats.rows));
            let chats: BTreeSet<ChatId> = stats.per_chat.keys().copied().collect();
            report.insert("chatsWithRows".into(), Value::from(chats.len()));
            if storage == Some(MessageStorage::Inline) {
                issues.push(issue("chats-db-unused", json!({ "rows": stats.rows, "note": "coordination.json keeps its messages inline; Node ignores chats.db until the next save." })));
            }
            let orphans: Vec<Value> = chats
                .difference(&sessions)
                .map(|chat| json!({ "chat": chat, "rows": stats.per_chat[chat] }))
                .collect();
            if state.is_some() && !orphans.is_empty() {
                issues.push(issue("orphan-chat-rows", json!({ "chats": orphans, "note": "Rows of Chats not in sessions: read back into state.messages, deleted by the next save." })));
            }
            if stats.null_session > 0 {
                issues.push(issue(
                    "rows-without-chat",
                    json!({ "rows": stats.null_session }),
                ));
            }
            if !stats.duplicate_positions.is_empty() {
                issues.push(issue("duplicate-positions", json!({ "positions": stats.duplicate_positions, "note": "findRow orders by position only; ties are unordered." })));
            }
            if !stats.bad_positions.is_empty() {
                issues.push(issue(
                    "non-integer-positions",
                    json!({ "positions": stats.bad_positions }),
                ));
            }
            let contiguous = stats.positions.len() as u64 == stats.rows
                && stats.positions.first().copied().unwrap_or(0) == 0
                && stats.positions.last().copied().unwrap_or(-1) == stats.rows as i64 - 1;
            if stats.rows > 0 && !contiguous {
                issues.push(issue("position-gaps", json!({ "note": "Positions are not 0..n-1; Node renumbers them on its next save, older releases expect them contiguous." })));
            }
            if !stats.unparsable.is_empty() {
                issues.push(issue("unparsable-payloads", Value::Array(stats.unparsable)));
            }
            if !stats.mismatches.is_empty() {
                issues.push(issue(
                    "column-payload-mismatch",
                    Value::Array(stats.mismatches),
                ));
            }
            let repeated: Vec<Value> = stats
                .client_ids
                .iter()
                .filter(|(_, count)| **count > 1)
                .map(|(id, count)| json!({ "clientMessageId": id, "rows": count }))
                .collect();
            if !repeated.is_empty() {
                issues.push(issue("repeated-client-message-ids", json!({ "ids": repeated, "note": "chat:send-status answers with the first in Project order." })));
            }
            if let Some(next) = state
                .as_ref()
                .and_then(|state| state.get("next_id"))
                .and_then(Value::as_f64)
            {
                if stats.max_id >= next {
                    issues.push(issue(
                        "next-id-behind-rows",
                        json!({ "next_id": next, "max_row_id": stats.max_id }),
                    ));
                }
            }
        }
        Ok(None) => {
            if storage == Some(MessageStorage::ChatsDb) {
                issues.push(issue("chats-db-missing", Value::Null));
            }
        }
        Err(error) => issues.push(issue("chats-db-unreadable", error_value(&error))),
    }

    // Sidecars the state points at that can't be read back.
    if let Some(state) = &state {
        let mut missing_details = Vec::new();
        if let Some(Value::Array(messages)) = state.get("messages") {
            for message in messages {
                if let Some(Value::String(name)) = message.get("detailFile") {
                    if !pending_names.contains(name) && store.read_detail_file(name).is_none() {
                        missing_details
                            .push(json!({ "id": message.get("id"), "detailFile": name }));
                    }
                }
            }
        }
        if !missing_details.is_empty() {
            issues.push(issue("detail-sidecars-unreadable", json!({ "messages": missing_details, "note": "chat:message returns these messages without their step details." })));
        }
        let mut missing_transcripts = Vec::new();
        if let Some(Value::Object(sessions)) = state.get("sessions") {
            for (_, session) in jsjson::js_entries(sessions) {
                for agent in session
                    .get("subagents")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    if let Some(files) = agent.get("transcriptFiles") {
                        missing_transcripts.push(json!({ "session": session.get("id"), "agent": agent.get("id"), "transcriptFiles": files }));
                    }
                }
            }
        }
        if !missing_transcripts.is_empty() {
            issues.push(issue(
                "subagent-sidecars-unreadable",
                Value::Array(missing_transcripts),
            ));
        }
        // Every session's messages page and its receipts must be answerable; exercise the command paths once.
        let reader = crate::commands::ProjectReader::new(ProjectStore::new(project));
        let mut failures = Vec::new();
        for chat in &sessions {
            if let Err(error) = reader.chat_messages(*chat, &Default::default()) {
                failures.push(json!({ "command": "chat:messages", "chat": chat, "error": error_value(&error) }));
            }
        }
        if let Err(error) = store
            .chats()
            .read_chat_previews(&sessions.iter().copied().collect::<Vec<_>>())
        {
            failures.push(json!({ "command": "previews", "error": error_value(&error) }));
        }
        if !failures.is_empty() {
            issues.push(issue("command-failures", Value::Array(failures)));
        }
    }

    report.insert("issues".into(), Value::Array(issues));
    Value::Object(report)
}

#[derive(Default)]
struct RowScan {
    rows: u64,
    positions: BTreeSet<i64>,
    duplicate_positions: Vec<i64>,
    bad_positions: Vec<Value>,
    per_chat: BTreeMap<ChatId, u64>,
    null_session: u64,
    unparsable: Vec<Value>,
    mismatches: Vec<Value>,
    client_ids: HashMap<String, u64>,
    max_id: f64,
}

/// Audits every Project under `fixture`. Errors only for the safety refusals above.
pub fn audit(
    fixture: &Path,
    options: &AuditOptions,
    probe: &dyn ProcessProbe,
) -> Result<Value, AuditError> {
    let root = std::fs::canonicalize(fixture)
        .map_err(|_| AuditError::NotADirectory(fixture.to_path_buf()))?;
    if !root.is_dir() {
        return Err(AuditError::NotADirectory(fixture.to_path_buf()));
    }
    let data_dirs = if options.data_dirs.is_empty() {
        default_data_dirs()
    } else {
        options.data_dirs.clone()
    };
    for data_dir in data_dirs {
        let data_dir = std::fs::canonicalize(&data_dir).unwrap_or(data_dir);
        if root.starts_with(&data_dir) {
            return Err(AuditError::InsideDataDir {
                fixture: root,
                data_dir,
            });
        }
    }
    let projects = find_projects(&root);
    for project in &projects {
        if let LockState::Live { owner } =
            ownership::inspect(&ownership::project_lock(project), probe)
        {
            if !options.allow_copied_lock {
                return Err(AuditError::LiveLock {
                    project: project.clone(),
                    owner,
                });
            }
        }
    }
    let before = fingerprint(&root);
    let reports: Vec<Value> = projects
        .iter()
        .map(|project| {
            let display = project
                .strip_prefix(&root)
                .ok()
                .map(|relative| relative.display().to_string())
                .filter(|text| !text.is_empty())
                .unwrap_or_else(|| ".".into());
            audit_project(project, &display, probe)
        })
        .collect();
    let after = fingerprint(&root);
    if before != after {
        let changed = before
            .keys()
            .chain(after.keys())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .filter(|path| before.get(*path) != after.get(*path))
            .map(|path| path.display().to_string())
            .collect();
        return Err(AuditError::Changed(changed));
    }
    let issues: usize = reports
        .iter()
        .map(|report| report["issues"].as_array().map_or(0, Vec::len))
        .sum();
    Ok(
        json!({ "fixture": root.display().to_string(), "sqlite": rusqlite::version(), "projects": reports, "issues": issues, "filesUnchanged": true }),
    )
}

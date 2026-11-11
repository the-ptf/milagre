//! Read-only access to a Project's saved state: `.milagre/coordination.json` with its messages in chats.db (or inline,
//! from before ADR-0007), subagent transcript sidecars and step-detail sidecars. Mirrors `project-store.cjs`
//! readProjectState and `project-content.cjs` hydrateSubagents / withDetails without their writes:
//!
//! - Node's `contentDirectory()` creates `.milagre/subagents` and `.milagre/details` when missing; here a missing
//!   folder reads as missing sidecars, which gives the same result.
//! - Node's readProjectState ends with compactDetails, which moves long step details of old states into new sidecars
//!   (a write). This reader does the same compaction in memory: the state it returns is Node's, byte for byte, and the
//!   sidecars Node would have written are returned in `pending_sidecars` instead of being written (a later Rust owner
//!   persists them before saving a state that points at them). `read_project_state_uncompacted` gives the state before
//!   that step.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::chat_db::{ChatDb, MessageRepository};
use crate::error::{Result, StoreError};
use crate::jsjson;

/// Where a Project's messages live.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MessageStorage {
    /// `messages` is `{ storedIn: "chats.db", format: 2 }`; rows are in chats.db.
    ChatsDb,
    /// `messages` is an array in coordination.json (releases before ADR-0007).
    Inline,
    /// Neither: no `messages` key, or something else.
    Absent,
}

/// What readProjectState returns, without its compaction write.
#[derive(Clone, Debug)]
pub struct ProjectStateRead {
    pub state: Value,
    pub storage: MessageStorage,
    /// Ids of the messages Node's compactDetails rewrites on read (long details of finished steps still inline).
    pub pending_detail_compaction: Vec<Value>,
    /// The details sidecars that compaction writes, `(name, { stepId: detail })`: `state` already points at them, but
    /// they exist only here until a writer persists them (`.milagre/details/<name>`). Empty when nothing is pending.
    pub pending_sidecars: Vec<(String, Map<String, Value>)>,
}

impl ProjectStateRead {
    /// `{ state, pendingDetailCompaction }`, the shape the fixtures record.
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("state".into(), self.state.clone());
        map.insert(
            "pendingDetailCompaction".into(),
            Value::Array(self.pending_detail_compaction.clone()),
        );
        Value::Object(map)
    }
}

/// Read side of Project state. A Rust owner's writer implements `crate::write::ProjectStateWriter` beside it.
pub trait ProjectRepository {
    /// coordination.json as saved, parsed.
    fn read_raw(&self) -> Result<Value>;
    /// readProjectState, with its compaction done in memory (see module docs).
    fn read_project_state(&self) -> Result<ProjectStateRead>;
    /// readProjectState up to (not including) its compaction step; `pending_sidecars` is empty.
    fn read_project_state_uncompacted(&self) -> Result<ProjectStateRead>;
    /// withDetails: a message with its details sidecar read back into its steps; as it is when there's none to read.
    /// `pending` holds sidecars not on disk yet (from [`ProjectStateRead::pending_sidecars`]).
    fn with_details_from(&self, message: &Value, pending: &[(String, Map<String, Value>)])
        -> Value;
    fn with_details(&self, message: &Value) -> Value {
        self.with_details_from(message, &[])
    }
}

#[derive(Clone, Debug)]
pub struct ProjectStore {
    root: PathBuf,
    chats: ChatDb,
}

pub fn state_file(project: &Path) -> PathBuf {
    project.join(".milagre").join("coordination.json")
}

/// chat-db.cjs isMarker.
pub fn is_marker(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Object(map)) if map.get("storedIn") == Some(&Value::String("chats.db".into())))
}

fn is_sidecar_name(name: &str) -> bool {
    name.len() == 69
        && name.ends_with(".json")
        && name[..64]
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// project-content.cjs `inside(root, target)`.
fn inside(root: &Path, target: &Path) -> bool {
    target == root || target.starts_with(root)
}

/// JavaScript's String.prototype.trim whitespace (WhiteSpace + LineTerminator).
fn js_trim(text: &str) -> &str {
    text.trim_matches(|character: char| {
        matches!(
            character,
            '\u{9}'
                | '\u{a}'
                | '\u{b}'
                | '\u{c}'
                | '\u{d}'
                | ' '
                | '\u{a0}'
                | '\u{1680}'
                | '\u{2000}'
                ..='\u{200a}'
                    | '\u{2028}'
                    | '\u{2029}'
                    | '\u{202f}'
                    | '\u{205f}'
                    | '\u{3000}'
                    | '\u{feff}'
        )
    })
}

fn js_space(character: char) -> bool {
    js_trim(character.encode_utf8(&mut [0u8; 4])).is_empty()
}

fn word(character: Option<char>) -> bool {
    matches!(character, Some(c) if c.is_ascii_alphanumeric() || c == '_')
}

/// project-content.cjs PR_COMMAND: /\bgh\s+pr\s+(create|merge)\b/.
pub fn is_pr_command(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    let at = |index: usize| chars.get(index).copied();
    for start in 0..chars.len() {
        if at(start) != Some('g')
            || at(start + 1) != Some('h')
            || (start > 0 && word(at(start - 1)))
        {
            continue;
        }
        let mut index = start + 2;
        let spaces = |mut index: usize| {
            let from = index;
            while at(index).is_some_and(js_space) {
                index += 1;
            }
            (index > from).then_some(index)
        };
        let Some(next) = spaces(index) else { continue };
        index = next;
        if at(index) != Some('p') || at(index + 1) != Some('r') {
            continue;
        }
        let Some(next) = spaces(index + 2) else {
            continue;
        };
        index = next;
        for verb in ["create", "merge"] {
            let verb_chars: Vec<char> = verb.chars().collect();
            if chars.len() >= index + verb_chars.len()
                && chars[index..index + verb_chars.len()] == verb_chars[..]
                && !word(at(index + verb_chars.len()))
            {
                return true;
            }
        }
    }
    false
}

const INLINE_DETAIL: usize = 1024;

impl ProjectStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        let root = root.into();
        ProjectStore {
            chats: ChatDb::new(root.clone()),
            root,
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn chats(&self) -> &ChatDb {
        &self.chats
    }

    /// The real `.milagre/<folder>` when it resolves inside the Project (contentDirectory's checks, without mkdir).
    fn content_directory(&self, folder: &str) -> Option<PathBuf> {
        let root = std::fs::canonicalize(&self.root).ok()?;
        let metadata = root.join(".milagre");
        if !inside(&root, &std::fs::canonicalize(&metadata).ok()?) {
            return None;
        }
        let directory = metadata.join(folder);
        if !inside(&metadata, &std::fs::canonicalize(&directory).ok()?) {
            return None;
        }
        Some(directory)
    }

    /// A content-addressed sidecar's bytes, checked like Node: realpath inside the folder, sha256 matches the name.
    fn read_sidecar(directory: &Path, name: &str) -> Option<Vec<u8>> {
        let file = std::fs::canonicalize(directory.join(name)).ok()?;
        if !inside(directory, &file) {
            return None;
        }
        let bytes = std::fs::read(&file).ok()?;
        (format!("{}.json", sha256_hex(&bytes)) == name).then_some(bytes)
    }

    /// readDetailFile: `{ stepId: detail }` or None when it can't be read (any of Node's throws).
    pub fn read_detail_file(&self, name: &str) -> Option<Map<String, Value>> {
        if !is_sidecar_name(name) {
            return None;
        }
        let directory = self.content_directory("details")?;
        let bytes = Self::read_sidecar(&directory, name)?;
        match serde_json::from_slice::<Value>(&bytes).ok()? {
            Value::Object(map) if map.values().all(Value::is_string) => Some(map),
            _ => None,
        }
    }

    /// withoutSuggestions: suggestions belong to the live provider query and are dropped on read.
    fn without_suggestions(state: &mut Value) {
        let Some(Value::Object(sessions)) = state.get_mut("sessions") else {
            return;
        };
        let any = sessions.values().any(|session| {
            session.get("suggestion").is_some() || session.get("suggestionTurnId").is_some()
        });
        if !any {
            return;
        }
        for session in sessions.values_mut() {
            if let Value::Object(fields) = session {
                fields.shift_remove("suggestion");
                fields.shift_remove("suggestionTurnId");
            }
        }
    }

    /// hydrateSubagents: each subagent's full transcript read back from its sidecars and merged with the compact entry.
    fn hydrate_subagents(&self, state: &mut Value) {
        let mut directory: Option<Option<PathBuf>> = None;
        let Some(Value::Object(sessions)) = state.get_mut("sessions") else {
            return;
        };
        for session in sessions.values_mut() {
            let Some(Value::Array(agents)) = session.get_mut("subagents") else {
                continue;
            };
            for agent in agents.iter_mut() {
                let Value::Object(fields) = agent else {
                    continue;
                };
                let mut refs: Vec<String> = Vec::new();
                let listed = match fields.get("transcriptFiles") {
                    Some(Value::Array(items)) => items.clone(),
                    _ => Vec::new(),
                };
                for candidate in listed.iter().chain(fields.get("transcriptFile")) {
                    if let Value::String(name) = candidate {
                        if is_sidecar_name(name) && !refs.contains(name) {
                            refs.push(name.clone());
                        }
                    }
                }
                if refs.is_empty() {
                    continue;
                }
                let folder = directory
                    .get_or_insert_with(|| self.content_directory("subagents"))
                    .clone();
                // Map keyed by entry id, insertion-ordered; a key set again keeps its place.
                let mut entries: Vec<(String, Value)> = Vec::new();
                let merge = |entries: &mut Vec<(String, Value)>, rows: &[Value]| {
                    for row in rows {
                        let key = jsjson::to_string(row.get("id").unwrap_or(&Value::Null));
                        let compact = jsjson::truthy(row.get("compact"));
                        match entries.iter_mut().find(|(known, _)| *known == key) {
                            Some(entry) if !compact => entry.1 = row.clone(),
                            Some(_) => {}
                            None => entries.push((key, row.clone())),
                        }
                    }
                };
                let mut missing: Vec<Value> = Vec::new();
                for name in &refs {
                    let transcript = folder
                        .as_deref()
                        .and_then(|dir| Self::read_sidecar(dir, name))
                        .and_then(
                            |bytes| match serde_json::from_slice::<Value>(&bytes).ok()? {
                                Value::Array(rows)
                                    if rows.iter().all(|row| {
                                        row.get("id").is_some_and(Value::is_string)
                                            && row.get("text").is_some_and(Value::is_string)
                                            && matches!(
                                                row.get("kind").and_then(Value::as_str),
                                                Some("message" | "tool")
                                            )
                                    }) =>
                                {
                                    Some(rows)
                                }
                                _ => None,
                            },
                        );
                    match transcript {
                        Some(rows) => merge(&mut entries, &rows),
                        None => missing.push(Value::String(name.clone())),
                    }
                }
                if let Some(Value::Array(rows)) = fields.get("transcript") {
                    let rows = rows.clone();
                    merge(&mut entries, &rows);
                }
                fields.insert(
                    "transcript".into(),
                    Value::Array(entries.into_iter().map(|(_, row)| row).collect()),
                );
                fields.shift_remove("transcriptFile");
                if missing.is_empty() {
                    fields.shift_remove("transcriptFiles");
                } else {
                    fields.insert("transcriptFiles".into(), Value::Array(missing));
                }
            }
        }
    }

    /// compactDetails (no `previous`) for one message, in memory: the slimmed message and the sidecar it now points
    /// at, or None when Node leaves the message as it is.
    pub fn compact_message(&self, message: &Value) -> Option<(Value, String, Map<String, Value>)> {
        let Some(Value::Array(steps)) = message.get("steps") else {
            return None;
        };
        let thought = steps
            .iter()
            .rposition(|step| {
                step.get("kind").and_then(Value::as_str) == Some("thinking")
                    && step
                        .get("detail")
                        .and_then(Value::as_str)
                        .is_some_and(|detail| !js_trim(detail).is_empty())
            })
            .map(|index| index as i64)
            .unwrap_or(-1);
        let moves = |index: usize, step: &Value| {
            let Some(detail) = step.get("detail").and_then(Value::as_str) else {
                return false;
            };
            if step.get("status").and_then(Value::as_str) == Some("running") {
                return false;
            }
            let keeps = detail.encode_utf16().count() <= INLINE_DETAIL
                || index as i64 == thought
                || (step.get("kind").and_then(Value::as_str) == Some("shell")
                    && is_pr_command(detail));
            !keeps
        };
        if !steps
            .iter()
            .enumerate()
            .any(|(index, step)| moves(index, step))
        {
            return None;
        }
        // A message saved before with a sidecar keeps what that sidecar holds; one that can't be read stays inline.
        let mut details = match message.get("detailFile") {
            Some(name) if jsjson::truthy(Some(name)) => self.read_detail_file(name.as_str()?)?,
            _ => Map::new(),
        };
        let slim: Vec<Value> = steps
            .iter()
            .enumerate()
            .map(|(index, step)| {
                if !moves(index, step) {
                    return step.clone();
                }
                let mut fields = step.as_object().cloned().unwrap_or_default();
                let detail = fields.shift_remove("detail").unwrap_or(Value::Null);
                details.insert(jsjson::property_key(fields.get("id")), detail);
                fields.insert("hasDetail".into(), Value::Bool(true));
                Value::Object(fields)
            })
            .collect();
        let name = format!(
            "{}.json",
            sha256_hex(jsjson::to_string(&Value::Object(details.clone())).as_bytes())
        );
        let mut compacted = message.as_object().cloned().unwrap_or_default();
        compacted.insert("steps".into(), Value::Array(slim));
        compacted.insert("detailFile".into(), Value::String(name.clone()));
        Some((Value::Object(compacted), name, details))
    }

    /// Applies [`Self::compact_message`] to every message of `read`.
    fn compact_in_memory(&self, read: &mut ProjectStateRead) {
        let Some(Value::Array(messages)) = read.state.get_mut("messages") else {
            return;
        };
        for message in messages.iter_mut() {
            if let Some((compacted, name, details)) = self.compact_message(message) {
                read.pending_detail_compaction
                    .push(message.get("id").cloned().unwrap_or(Value::Null));
                if !read
                    .pending_sidecars
                    .iter()
                    .any(|(known, _)| *known == name)
                {
                    read.pending_sidecars.push((name, details));
                }
                *message = compacted;
            }
        }
    }
}

impl ProjectRepository for ProjectStore {
    fn read_raw(&self) -> Result<Value> {
        let file = state_file(&self.root);
        let text =
            std::fs::read_to_string(&file).map_err(|error| StoreError::io(error, "open", &file))?;
        serde_json::from_str(&text).map_err(|error| StoreError::Json {
            context: file.display().to_string(),
            message: error.to_string(),
        })
    }

    fn read_project_state(&self) -> Result<ProjectStateRead> {
        let mut read = self.read_project_state_uncompacted()?;
        read.pending_detail_compaction.clear();
        self.compact_in_memory(&mut read);
        Ok(read)
    }

    fn read_project_state_uncompacted(&self) -> Result<ProjectStateRead> {
        let mut state = self.read_raw()?;
        Self::without_suggestions(&mut state);
        let storage = if is_marker(state.get("messages")) {
            let rows = self
                .chats
                .read_rows()?
                .ok_or_else(|| StoreError::MissingChatsDb(self.chats.file()))?;
            if let Value::Object(fields) = &mut state {
                fields.insert(
                    "messages".into(),
                    Value::Array(rows.into_iter().map(|row| row.message).collect()),
                );
            }
            MessageStorage::ChatsDb
        } else if state.get("messages").is_some_and(Value::is_array) {
            MessageStorage::Inline
        } else {
            MessageStorage::Absent
        };
        self.hydrate_subagents(&mut state);
        let pending_detail_compaction = match state.get("messages") {
            Some(Value::Array(messages)) => messages
                .iter()
                .filter(|message| self.compact_message(message).is_some())
                .map(|message| message.get("id").cloned().unwrap_or(Value::Null))
                .collect(),
            _ => Vec::new(),
        };
        Ok(ProjectStateRead {
            state,
            storage,
            pending_detail_compaction,
            pending_sidecars: Vec::new(),
        })
    }
    fn with_details_from(
        &self,
        message: &Value,
        pending: &[(String, Map<String, Value>)],
    ) -> Value {
        let Some(name) = message.get("detailFile") else {
            return message.clone();
        };
        if !jsjson::truthy(Some(name)) {
            return message.clone();
        }
        let from_disk = || name.as_str().and_then(|name| self.read_detail_file(name));
        let from_pending = || {
            name.as_str().and_then(|name| {
                pending
                    .iter()
                    .find(|(known, _)| known == name)
                    .map(|(_, details)| details.clone())
            })
        };
        let Some(details) = from_disk().or_else(from_pending) else {
            return message.clone();
        };
        let mut rest = match message {
            Value::Object(fields) => fields.clone(),
            _ => return message.clone(),
        };
        rest.shift_remove("detailFile");
        let steps = match message.get("steps") {
            Some(Value::Array(steps)) => steps.clone(),
            _ => Vec::new(),
        };
        let steps = steps
            .into_iter()
            .map(|step| {
                let Value::Object(mut fields) = step else {
                    return step;
                };
                let has_detail = fields.shift_remove("hasDetail");
                let key = jsjson::property_key(fields.get("id"));
                if let Some(detail @ Value::String(_)) = details.get(&key) {
                    fields.insert("detail".into(), detail.clone());
                } else if jsjson::truthy(has_detail.as_ref()) {
                    fields.insert("hasDetail".into(), has_detail.unwrap());
                }
                Value::Object(fields)
            })
            .collect();
        rest.insert("steps".into(), Value::Array(steps));
        Value::Object(rest)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pr_command_matches_node_regex() {
        for (text, expected) in [
            ("gh pr create --fill", true),
            ("run gh  pr\tmerge 12", true),
            ("ghx pr create", false),
            ("xgh pr create", false),
            ("gh pr created", false),
            ("gh pr merge_now", false),
            ("gh pr view", false),
            ("echo;gh pr merge", true),
            ("gh\u{a0}pr\u{2003}create", true),
        ] {
            assert_eq!(is_pr_command(text), expected, "{text:?}");
        }
    }
}

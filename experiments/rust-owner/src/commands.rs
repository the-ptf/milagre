//! Daemon command results computed from a Project's saved files, for a Project this process does not own.
//!
//! Each function answers what `packages/core/src/runtime.cjs` answers for the same command when the Project's saved
//! files are all there is (no turn running, no send in flight, nothing waiting in the 250 ms write-behind):
//!
//! | Command | Node path | Here |
//! | --- | --- | --- |
//! | `chat:messages` | runtime.cjs, unopened-Project branch: readChatRows + chatPage | [`ProjectReader::chat_messages`] |
//! | `chat:message` | ProjectStates.findMessage("id") + withDetails | [`ProjectReader::chat_message`] |
//! | `chat:send-status` | ChatHost.sendStatus once pendingSends is empty | [`ProjectReader::send_status`] |
//! | inbox previews | message-store.cjs inboxState -> readChatPreviews | [`MessageRepository::read_chat_previews`] |
//!
//! Results are `serde_json::Value`s in the daemon's shapes; write them with [`crate::jsjson::to_string`] for the
//! daemon's exact bytes.

use serde_json::{Map, Value};

use crate::chat_db::{LookupField, MessageRepository};
use crate::error::{Result, StoreError};
use crate::jsjson;
use crate::project::{MessageStorage, ProjectRepository, ProjectStore};

/// `chat:messages` options (command-contracts.json T200). `None` is `undefined`; a JSON `null` coerces like JavaScript.
#[derive(Clone, Debug, Default)]
pub struct PageOptions {
    pub before: Option<Value>,
    pub turns: Option<Value>,
    pub limit: Option<Value>,
}

impl PageOptions {
    pub fn from_value(options: Option<&Value>) -> Self {
        let field = |name: &str| options.and_then(|options| options.get(name)).cloned();
        PageOptions {
            before: field("before"),
            turns: field("turns"),
            limit: field("limit"),
        }
    }
}

/// JavaScript ToNumber for the values a JSON option can hold.
fn to_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(flag) => f64::from(u8::from(*flag)),
        Value::Number(number) => jsjson::as_f64(number),
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                0.0
            } else {
                trimmed.parse().unwrap_or(f64::NAN)
            }
        }
        _ => f64::NAN,
    }
}

/// chat-pages.cjs chatPage: the messages of Chat `chat_id` before `before` (the end without it), back `turns` user
/// messages and at most `limit` messages. `{ messages, hasMore, total }`.
pub fn chat_page(messages: &[Value], chat_id: &Value, options: &PageOptions) -> Value {
    let chat: Vec<&Value> = messages
        .iter()
        .filter(|message| {
            jsjson::strict_equals(
                message.get("session_id").unwrap_or(&Value::Bool(false)),
                chat_id,
            ) && message.get("session_id").is_some()
        })
        .collect();
    let mut end = chat.len();
    if let Some(before) = options.before.as_ref().filter(|before| !before.is_null()) {
        if let Some(at) = chat.iter().position(|message| {
            message
                .get("id")
                .is_some_and(|id| jsjson::strict_equals(id, before))
        }) {
            end = at;
        }
    }
    let turns = options.turns.as_ref().map_or(10.0, to_number);
    let limit = options.limit.as_ref().map_or(75.0, to_number);
    let mut start = end;
    let mut seen = 0.0;
    while start > 0 && ((end - start) as f64) < limit {
        start -= 1;
        if chat[start].get("role").and_then(Value::as_str) == Some("user") {
            seen += 1.0;
            if seen >= turns {
                break;
            }
        }
    }
    let mut result = Map::new();
    result.insert(
        "messages".into(),
        Value::Array(
            chat[start..end]
                .iter()
                .map(|message| (*message).clone())
                .collect(),
        ),
    );
    result.insert("hasMore".into(), Value::Bool(start > 0));
    result.insert("total".into(), Value::from(chat.len()));
    Value::Object(result)
}

/// Command answers for one Project, read from its files only.
pub struct ProjectReader {
    store: ProjectStore,
}

impl ProjectReader {
    pub fn new(store: ProjectStore) -> Self {
        ProjectReader { store }
    }

    pub fn store(&self) -> &ProjectStore {
        &self.store
    }

    /// The Project's messages in its order, from chats.db or coordination.json.
    fn all_messages(&self) -> Result<Vec<Value>> {
        let read = self.store.read_project_state()?;
        Ok(match read.state.get("messages") {
            Some(Value::Array(messages)) => messages.clone(),
            _ => Vec::new(),
        })
    }

    /// The first message (Project order) whose `field` is `value`: findMessage on a state with every Chat on disk. The
    /// message is as saved, before readProjectState's detail compaction.
    pub fn find_message(&self, field: LookupField, value: &Value) -> Result<Option<Value>> {
        if self.store.chats().exists() {
            let raw = self.store.read_raw()?;
            if crate::project::is_marker(raw.get("messages")) {
                return Ok(self
                    .store
                    .chats()
                    .find_row_any(field, value)?
                    .map(|row| row.message));
            }
        }
        // Before the in-memory compaction: callers that need it (chat:message) apply it to the one message found.
        let read = self.store.read_project_state_uncompacted()?;
        let messages = match read.state.get("messages") {
            Some(Value::Array(messages)) => messages.clone(),
            _ => Vec::new(),
        };
        Ok(messages.into_iter().find(|message| {
            message
                .get(field.key())
                .is_some_and(|found| jsjson::strict_equals(found, value))
        }))
    }

    /// `chat:messages(scope, chatId, options)`.
    pub fn chat_messages(&self, chat_id: i64, options: &PageOptions) -> Result<Value> {
        let messages = if self.store.chats().exists() {
            self.store
                .chats()
                .read_chat_rows(&[chat_id])?
                .into_iter()
                .map(|row| row.message)
                .collect()
        } else {
            self.all_messages()?
        };
        Ok(chat_page(&messages, &Value::from(chat_id), options))
    }

    /// `chat:message(scope, id)`.
    pub fn chat_message(&self, id: &Value) -> Result<Value> {
        let message = self
            .find_message(LookupField::Id, id)?
            .ok_or(StoreError::MessageGone)?;
        // The state Node finds it in was compacted on read (readProjectState): do the same in memory, so a detail it
        // moved comes back the way withDetails puts it back.
        match self.store.compact_message(&message) {
            Some((compacted, name, details)) => {
                Ok(self.store.with_details_from(&compacted, &[(name, details)]))
            }
            None => Ok(self.store.with_details(&message)),
        }
    }

    /// `chat:send-status(owner, clientMessageId)`: `{ sessionId }` of the saved message or queued entry, else null.
    pub fn send_status(&self, client_message_id: &str) -> Result<Value> {
        if client_message_id.is_empty() {
            return Err(StoreError::BadSendStatus);
        }
        let value = Value::String(client_message_id.to_string());
        if let Some(message) = self.find_message(LookupField::ClientMessageId, &value)? {
            let mut receipt = Map::new();
            if let Some(session) = message.get("session_id") {
                receipt.insert("sessionId".into(), session.clone());
            }
            return Ok(Value::Object(receipt));
        }
        let raw = self.store.read_raw()?;
        let Some(Value::Object(sessions)) = raw.get("sessions") else {
            return Ok(Value::Null);
        };
        for (_, session) in jsjson::js_entries(sessions) {
            let queued = matches!(session.get("queued"), Some(Value::Array(entries))
                if entries.iter().any(|entry| entry.get("clientMessageId").is_some_and(|found| jsjson::strict_equals(found, &value))));
            if queued {
                let mut receipt = Map::new();
                if let Some(id) = session.get("id") {
                    receipt.insert("sessionId".into(), id.clone());
                }
                return Ok(Value::Object(receipt));
            }
        }
        Ok(Value::Null)
    }

    /// Where the messages are kept.
    pub fn storage(&self) -> Result<MessageStorage> {
        Ok(self.store.read_project_state()?.storage)
    }
}

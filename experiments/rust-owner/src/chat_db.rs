//! Read-only access to `<project>/.milagre/chats.db` (ADR-0007), query for query what `packages/core/src/chat-db.cjs`
//! runs, so rows come back in the same order with the same values.
//!
//! Differences from Node that are deliberate:
//! - The file is opened `mode=ro&immutable=1`: no lock is taken, nothing is created (Node runs `CREATE TABLE IF NOT
//!   EXISTS` on every open), and a live writer is never blocked. A database without the `messages` table reads as
//!   empty, as Node's CREATE would leave it.
//! - A rollback journal or WAL beside the file means the copy was taken mid-transaction; Node would roll it back (a
//!   write). The read is refused instead (`StoreError::HotJournal`).

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use rusqlite::types::ValueRef;
use rusqlite::{params_from_iter, Connection, OpenFlags};
use serde_json::{Map, Value};

use crate::error::{Result, StoreError};
use crate::jsjson;

/// A Chat (session) id. Node passes `[...chats].map(Number)` to SQLite as JSON; ids are integers in practice.
pub type ChatId = i64;

/// `{ message, position, chat }`, chat-db.cjs's row shape.
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub message: Value,
    /// `position`: the Project-wide sort key (increasing, may have gaps).
    pub position: Value,
    /// `session_id`, which may be NULL.
    pub chat: Value,
}

impl Row {
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("message".into(), self.message.clone());
        map.insert("position".into(), self.position.clone());
        map.insert("chat".into(), self.chat.clone());
        Value::Object(map)
    }

    pub fn position_f64(&self) -> f64 {
        match &self.position {
            Value::Number(number) => jsjson::as_f64(number),
            _ => f64::NAN,
        }
    }
}

/// `{ session_id, role: "assistant", body }` of readChatPreviews. The body is kept as UTF-16 because Node cuts it at
/// 240 code units and can leave half a surrogate pair, which `JSON.stringify` then writes as `\udxxx`.
#[derive(Clone, Debug, PartialEq)]
pub struct Preview {
    pub session_id: Value,
    pub body_utf16: Vec<u16>,
}

impl Preview {
    /// The body as Rust text; a lone surrogate (see above) becomes U+FFFD.
    pub fn body_lossy(&self) -> String {
        String::from_utf16_lossy(&self.body_utf16)
    }

    pub fn to_js_json(&self) -> String {
        let mut out = String::from("{\"session_id\":");
        out.push_str(&jsjson::to_string(&self.session_id));
        out.push_str(",\"role\":\"assistant\",\"body\":");
        out.push_str(&utf16_json_string(&self.body_utf16));
        out.push('}');
        out
    }
}

/// `JSON.stringify` of a JavaScript string given as UTF-16 code units (lone surrogates escaped, as Node 12+ does).
pub fn utf16_json_string(units: &[u16]) -> String {
    let mut out = String::from("\"");
    for decoded in char::decode_utf16(units.iter().copied()) {
        match decoded {
            Ok(character) => {
                let mut buffer = [0u8; 4];
                let text = character.encode_utf8(&mut buffer);
                let quoted = jsjson::to_string(&Value::String(text.to_string()));
                out.push_str(&quoted[1..quoted.len() - 1]);
            }
            Err(error) => out.push_str(&format!("\\u{:04x}", error.unpaired_surrogate())),
        }
    }
    out.push('"');
    out
}

/// The fields chat-db.cjs findRow accepts, with their columns.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LookupField {
    Id,
    OperationId,
    ClientMessageId,
}

impl LookupField {
    pub fn parse(field: &str) -> Result<Self> {
        match field {
            "id" => Ok(LookupField::Id),
            "operationId" => Ok(LookupField::OperationId),
            "clientMessageId" => Ok(LookupField::ClientMessageId),
            other => Err(StoreError::BadLookup(other.to_string())),
        }
    }
    fn column(self) -> &'static str {
        match self {
            LookupField::Id => "id",
            LookupField::OperationId => "operation_id",
            LookupField::ClientMessageId => "client_message_id",
        }
    }
    pub fn key(self) -> &'static str {
        match self {
            LookupField::Id => "id",
            LookupField::OperationId => "operationId",
            LookupField::ClientMessageId => "clientMessageId",
        }
    }
}

/// Read side of a Project's message rows. Mirrors chat-db.cjs's exported readers one for one.
pub trait MessageRepository {
    /// readRows: every row in the Project's order; `None` when the Project has no chats.db.
    fn read_rows(&self) -> Result<Option<Vec<Row>>>;
    /// readMessages.
    fn read_messages(&self) -> Result<Option<Vec<Value>>> {
        Ok(self
            .read_rows()?
            .map(|rows| rows.into_iter().map(|row| row.message).collect()))
    }
    /// readChatRows.
    fn read_chat_rows(&self, chats: &[ChatId]) -> Result<Vec<Row>>;
    /// readChatBodies: `{ id, session_id, role, body }` without parsing payloads.
    fn read_chat_bodies(&self, chats: &[ChatId]) -> Result<Vec<Row>>;
    /// readChatPreviews: the last assistant reply of each Chat, cut to 240.
    fn read_chat_previews(&self, chats: &[ChatId]) -> Result<Vec<Preview>>;
    /// readChatMarks: `{ id, session_id, role?, outcome?, clientMessageId? }`.
    fn read_chat_marks(&self, chats: &[ChatId]) -> Result<Vec<Row>>;
    /// readChatRowsContaining: rows whose payload text contains one of `needles`.
    fn read_chat_rows_containing(&self, chats: &[ChatId], needles: &[String]) -> Result<Vec<Row>>;
    /// readPositions: id -> (position, chat), in SQLite's result order (Node returns a Map built from it).
    fn read_positions(&self, ids: &[Value]) -> Result<Vec<(Value, Value, Value)>>;
    /// findRow: the first row (by position) of `chats` whose `field` is `value`.
    fn find_row(&self, chats: &[ChatId], field: LookupField, value: &Value) -> Result<Option<Row>>;
    /// readDetailRefs: the details sidecars the rows of `chats` point at.
    fn read_detail_refs(&self, chats: &[ChatId]) -> Result<BTreeSet<String>>;
}

/// The chats.db of one Project, read-only.
#[derive(Clone, Debug)]
pub struct ChatDb {
    project: PathBuf,
    /// Opened read-write like Node (schema ensured, a hot journal rolled back). Only an owner gets one.
    owned: bool,
}

/// chat-db.cjs SCHEMA, verbatim.
pub(crate) const SCHEMA: &str = "
  CREATE TABLE IF NOT EXISTS messages (
    id NOT NULL UNIQUE,
    session_id INTEGER,
    position INTEGER NOT NULL,
    client_message_id TEXT,
    operation_id TEXT,
    payload TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_session ON messages (session_id, position);
  CREATE INDEX IF NOT EXISTS messages_position ON messages (position);
";

enum Opened {
    Missing,
    Empty,
    Open(Connection),
}

pub fn db_file(project: &Path) -> PathBuf {
    project.join(".milagre").join("chats.db")
}

fn uri_for(file: &Path) -> String {
    let mut uri = String::from("file:");
    for byte in file.to_string_lossy().bytes() {
        if byte.is_ascii_alphanumeric() || b"/-_.~".contains(&byte) {
            uri.push(byte as char);
        } else {
            uri.push_str(&format!("%{byte:02X}"));
        }
    }
    uri.push_str("?mode=ro&immutable=1");
    uri
}

fn chat_list(chats: &[ChatId]) -> String {
    serde_json::to_string(chats).expect("ids serialize")
}

/// A SQLite value as node:sqlite returns it, as JSON.
pub fn sql_value(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(integer) => Value::from(integer),
        ValueRef::Real(real) => jsjson::number(real),
        ValueRef::Text(text) => Value::String(jsjson::js_string(&String::from_utf8_lossy(text))),
        // node:sqlite gives a Uint8Array; JSON.stringify writes it as an index-keyed object.
        ValueRef::Blob(bytes) => Value::Object(
            bytes
                .iter()
                .enumerate()
                .map(|(index, byte)| (index.to_string(), Value::from(*byte)))
                .collect(),
        ),
    }
}

fn parse_payload(payload: &str, id: &Value) -> Result<Value> {
    jsjson::parse(payload).map_err(|message| StoreError::Json {
        context: format!("chats.db row {}", jsjson::to_string(id)),
        message,
    })
}

/// A value bound the way node:sqlite binds a JavaScript value: every number as a double (REAL; an INTEGER column's
/// affinity turns an integral one back into an integer), a string as UTF-8 with unpaired surrogates as U+FFFD, null.
/// Anything else fails as node:sqlite fails (`parameter` counts from 1). node:sqlite reads an object in the first
/// position as named parameters and fails differently; that case is reported the same way here.
pub(crate) fn bind_js(value: &Value, parameter: usize) -> Result<rusqlite::types::Value> {
    Ok(match value {
        Value::Null => rusqlite::types::Value::Null,
        Value::Number(number) => rusqlite::types::Value::Real(jsjson::as_f64(number)),
        Value::String(text) => {
            rusqlite::types::Value::Text(jsjson::to_sqlite_text(text).into_owned())
        }
        _ => {
            return Err(StoreError::Sqlite(format!(
                "Provided value cannot be bound to SQLite parameter {parameter}."
            )))
        }
    })
}

/// SQLite text as node:sqlite returns it: invalid UTF-8 as U+FFFD.
pub(crate) fn text_of(value: ValueRef<'_>) -> Result<String> {
    match value {
        ValueRef::Text(text) | ValueRef::Blob(text) => {
            Ok(String::from_utf8_lossy(text).into_owned())
        }
        other => Err(StoreError::Sqlite(format!(
            "expected text, found {:?}",
            other.data_type()
        ))),
    }
}

impl ChatDb {
    pub fn new(project: impl Into<PathBuf>) -> Self {
        ChatDb {
            project: project.into(),
            owned: false,
        }
    }

    /// The database as its owner opens it (see `owner.rs`): read-write, like Node.
    pub(crate) fn owned(project: impl Into<PathBuf>) -> Self {
        ChatDb {
            project: project.into(),
            owned: true,
        }
    }

    /// Opens (creating `.milagre/` and the file when `create`) read-write with the schema, as chat-db.cjs `open`
    /// does: node:sqlite's defaults, so no busy timeout. Owner only.
    pub(crate) fn open_writable(&self, create: bool) -> Result<Option<Connection>> {
        let file = self.file();
        if create {
            let folder = file.parent().expect("inside .milagre");
            std::fs::create_dir_all(folder)
                .map_err(|error| StoreError::io(error, "mkdir", folder))?;
        } else if !file.exists() {
            return Ok(None);
        }
        let mut flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        if create {
            flags |= OpenFlags::SQLITE_OPEN_CREATE;
        }
        let connection = Connection::open_with_flags(&file, flags)?;
        connection.busy_timeout(std::time::Duration::ZERO)?;
        connection.execute_batch(SCHEMA)?;
        Ok(Some(connection))
    }

    pub fn file(&self) -> PathBuf {
        db_file(&self.project)
    }

    pub fn exists(&self) -> bool {
        self.file().exists()
    }

    fn open(&self) -> Result<Opened> {
        if self.owned {
            return Ok(match self.open_writable(false)? {
                Some(connection) => Opened::Open(connection),
                None => Opened::Missing,
            });
        }
        let file = self.file();
        match std::fs::metadata(&file) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Opened::Missing)
            }
            Err(error) => return Err(StoreError::io(error, "access", &file)),
            Ok(_) => {}
        }
        for suffix in ["-journal", "-wal"] {
            let side = PathBuf::from(format!("{}{suffix}", file.display()));
            if std::fs::metadata(&side)
                .map(|meta| meta.len() > 0)
                .unwrap_or(false)
            {
                return Err(StoreError::HotJournal(file));
            }
        }
        let connection = Connection::open_with_flags(
            uri_for(&file),
            OpenFlags::SQLITE_OPEN_READ_ONLY
                | OpenFlags::SQLITE_OPEN_URI
                | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        let has_table: bool = connection.query_row(
            "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages')",
            [],
            |row| row.get(0),
        )?;
        Ok(if has_table {
            Opened::Open(connection)
        } else {
            Opened::Empty
        })
    }

    /// Runs `work` on the open database; `missing` when there is no file, `empty` when it has no table.
    fn with<T>(
        &self,
        missing: impl FnOnce() -> T,
        empty: impl FnOnce() -> T,
        work: impl FnOnce(&Connection) -> Result<T>,
    ) -> Result<T> {
        match self.open()? {
            Opened::Missing => Ok(missing()),
            Opened::Empty => Ok(empty()),
            Opened::Open(connection) => work(&connection),
        }
    }

    fn payload_rows(
        connection: &Connection,
        sql: &str,
        params: Vec<rusqlite::types::Value>,
    ) -> Result<Vec<Row>> {
        let mut statement = connection.prepare(sql)?;
        let mut rows = statement.query(params_from_iter(params))?;
        let mut out = Vec::new();
        while let Some(row) = rows.next()? {
            let chat = sql_value(row.get_ref(0)?);
            let position = sql_value(row.get_ref(1)?);
            let payload = text_of(row.get_ref(2)?)?;
            out.push(Row {
                message: parse_payload(&payload, &position)?,
                position,
                chat,
            });
        }
        Ok(out)
    }

    /// Every row in the Project's order (not part of chat-db.cjs: findMessage on a state read whole, for a Project this
    /// process hasn't loaded). Ties on position go by id, as readRows orders them.
    pub fn find_row_any(&self, field: LookupField, value: &Value) -> Result<Option<Row>> {
        if value.is_null() {
            return Ok(None);
        }
        let bound = bind_js(value, 1)?;
        self.with(
            || None,
            || None,
            |connection| {
                let sql = format!(
                    "SELECT session_id, position, payload FROM messages WHERE {} = ? ORDER BY position, id LIMIT 1",
                    field.column()
                );
                Ok(Self::payload_rows(connection, &sql, vec![bound])?.into_iter().next())
            },
        )
    }

    /// Distinct non-NULL session ids with rows, ascending.
    pub fn chats_with_rows(&self) -> Result<Vec<ChatId>> {
        self.with(Vec::new, Vec::new, |connection| {
            let mut statement = connection
                .prepare("SELECT DISTINCT session_id FROM messages WHERE session_id IS NOT NULL ORDER BY session_id")?;
            let ids = statement.query_map([], |row| row.get::<_, i64>(0))?.collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(ids)
        })
    }

    /// Runs a read-only query for the audit. The connection is immutable and read-only; a statement that writes fails.
    pub fn query<T>(&self, work: impl FnOnce(&Connection) -> Result<T>) -> Result<Option<T>> {
        match self.open()? {
            Opened::Missing => Ok(None),
            Opened::Empty => {
                let memory = Connection::open_in_memory()?;
                memory.execute_batch(
                    "CREATE TABLE messages (id NOT NULL UNIQUE, session_id INTEGER, position INTEGER NOT NULL, client_message_id TEXT, operation_id TEXT, payload TEXT NOT NULL);",
                )?;
                work(&memory).map(Some)
            }
            Opened::Open(connection) => work(&connection).map(Some),
        }
    }
}

const CHATS: &str = "session_id IN (SELECT value FROM json_each(?))";

impl MessageRepository for ChatDb {
    fn read_rows(&self) -> Result<Option<Vec<Row>>> {
        self.with(
            || None,
            || Some(Vec::new()),
            |connection| {
                Self::payload_rows(
                    connection,
                    "SELECT session_id, position, payload FROM messages ORDER BY position, id",
                    vec![],
                )
                .map(Some)
            },
        )
    }

    fn read_chat_rows(&self, chats: &[ChatId]) -> Result<Vec<Row>> {
        if chats.is_empty() {
            return Ok(Vec::new());
        }
        self.with(Vec::new, Vec::new, |connection| {
            Self::payload_rows(
                connection,
                &format!("SELECT session_id, position, payload FROM messages WHERE {CHATS} ORDER BY position, id"),
                vec![chat_list(chats).into()],
            )
        })
    }

    fn read_chat_bodies(&self, chats: &[ChatId]) -> Result<Vec<Row>> {
        if chats.is_empty() {
            return Ok(Vec::new());
        }
        self.with(Vec::new, Vec::new, |connection| {
            let mut statement = connection.prepare(&format!(
                "SELECT id, session_id, position, json_extract(payload, '$.role') AS role, json_extract(payload, '$.body') AS body FROM messages WHERE {CHATS} ORDER BY position, id"
            ))?;
            let mut rows = statement.query([chat_list(chats)])?;
            let mut out = Vec::new();
            while let Some(row) = rows.next()? {
                let id = sql_value(row.get_ref(0)?);
                let chat = sql_value(row.get_ref(1)?);
                let position = sql_value(row.get_ref(2)?);
                let role = sql_value(row.get_ref(3)?);
                let body = match sql_value(row.get_ref(4)?) {
                    Value::Null => Value::String(String::new()),
                    other => other,
                };
                let mut message = Map::new();
                message.insert("id".into(), id);
                message.insert("session_id".into(), chat.clone());
                message.insert("role".into(), role);
                message.insert("body".into(), body);
                out.push(Row { message: Value::Object(message), position, chat });
            }
            Ok(out)
        })
    }

    fn read_chat_previews(&self, chats: &[ChatId]) -> Result<Vec<Preview>> {
        if chats.is_empty() {
            return Ok(Vec::new());
        }
        self.with(Vec::new, Vec::new, |connection| {
            let mut statement = connection.prepare(
                "SELECT session_id, substr(json_extract(payload, '$.body'), 1, 240) AS body FROM messages WHERE id IN (SELECT (SELECT id FROM messages WHERE session_id = value AND json_extract(payload, '$.role') = 'assistant' ORDER BY position DESC, id DESC LIMIT 1) FROM json_each(?))",
            )?;
            let mut rows = statement.query([chat_list(chats)])?;
            let mut out = Vec::new();
            while let Some(row) = rows.next()? {
                let session_id = sql_value(row.get_ref(0)?);
                // (row.body ?? "").slice(0, 240): a number body (substr of a number is text in SQLite) is text here too.
                let body = match sql_value(row.get_ref(1)?) {
                    Value::Null => String::new(),
                    Value::String(text) => text,
                    other => jsjson::to_string(&other),
                };
                let mut body_utf16: Vec<u16> = jsjson::to_utf16(&body);
                body_utf16.truncate(240);
                out.push(Preview { session_id, body_utf16 });
            }
            Ok(out)
        })
    }

    fn read_chat_marks(&self, chats: &[ChatId]) -> Result<Vec<Row>> {
        if chats.is_empty() {
            return Ok(Vec::new());
        }
        self.with(Vec::new, Vec::new, |connection| {
            let mut statement = connection.prepare(&format!(
                "SELECT id, session_id, position, client_message_id, json_extract(payload, '$.role') AS role, json_extract(payload, '$.outcome') AS outcome FROM messages WHERE {CHATS} ORDER BY position, id"
            ))?;
            let mut rows = statement.query([chat_list(chats)])?;
            let mut out = Vec::new();
            while let Some(row) = rows.next()? {
                let id = sql_value(row.get_ref(0)?);
                let chat = sql_value(row.get_ref(1)?);
                let position = sql_value(row.get_ref(2)?);
                let client = sql_value(row.get_ref(3)?);
                let role = sql_value(row.get_ref(4)?);
                let outcome = sql_value(row.get_ref(5)?);
                // `?? undefined`: a NULL leaves the key out of the JSON.
                let mut message = Map::new();
                message.insert("id".into(), id);
                message.insert("session_id".into(), chat.clone());
                for (key, value) in [("role", role), ("outcome", outcome), ("clientMessageId", client)] {
                    if !value.is_null() {
                        message.insert(key.into(), value);
                    }
                }
                out.push(Row { message: Value::Object(message), position, chat });
            }
            Ok(out)
        })
    }

    fn read_chat_rows_containing(&self, chats: &[ChatId], needles: &[String]) -> Result<Vec<Row>> {
        if chats.is_empty() || needles.is_empty() {
            return Ok(Vec::new());
        }
        self.with(Vec::new, Vec::new, |connection| {
            let any = needles.iter().map(|_| "instr(payload, ?) > 0").collect::<Vec<_>>().join(" OR ");
            let mut params: Vec<rusqlite::types::Value> = vec![chat_list(chats).into()];
            params.extend(needles.iter().map(|needle| rusqlite::types::Value::Text(needle.clone())));
            Self::payload_rows(
                connection,
                &format!("SELECT session_id, position, payload FROM messages WHERE {CHATS} AND ({any}) ORDER BY position, id"),
                params,
            )
        })
    }

    fn read_positions(&self, ids: &[Value]) -> Result<Vec<(Value, Value, Value)>> {
        self.with(Vec::new, Vec::new, |connection| {
            let mut statement = connection
                .prepare("SELECT id, session_id, position FROM messages WHERE id IN (SELECT value FROM json_each(?))")?;
            let list = serde_json::to_string(ids).expect("ids serialize");
            let mut rows = statement.query([list])?;
            let mut out: Vec<(Value, Value, Value)> = Vec::new();
            while let Some(row) = rows.next()? {
                let id = sql_value(row.get_ref(0)?);
                let chat = sql_value(row.get_ref(1)?);
                let position = sql_value(row.get_ref(2)?);
                // new Map(entries): a repeated key keeps its first place and takes the last value.
                match out.iter_mut().find(|(known, _, _)| jsjson::strict_equals(known, &id)) {
                    Some(entry) => *entry = (id, position, chat),
                    None => out.push((id, position, chat)),
                }
            }
            Ok(out)
        })
    }

    fn find_row(&self, chats: &[ChatId], field: LookupField, value: &Value) -> Result<Option<Row>> {
        if chats.is_empty() {
            return Ok(None);
        }
        let bound = bind_js(value, 1)?;
        self.with(
            || None,
            || None,
            |connection| {
                let sql = format!(
                    "SELECT session_id, position, payload FROM messages WHERE {} = ? AND {CHATS} ORDER BY position LIMIT 1",
                    field.column()
                );
                Ok(Self::payload_rows(connection, &sql, vec![bound, chat_list(chats).into()])?.into_iter().next())
            },
        )
    }

    fn read_detail_refs(&self, chats: &[ChatId]) -> Result<BTreeSet<String>> {
        if chats.is_empty() {
            return Ok(BTreeSet::new());
        }
        self.with(BTreeSet::new, BTreeSet::new, |connection| {
            let mut statement = connection.prepare(&format!(
                "SELECT DISTINCT json_extract(payload, '$.detailFile') AS name FROM messages WHERE {CHATS} AND json_extract(payload, '$.detailFile') IS NOT NULL"
            ))?;
            let mut rows = statement.query([chat_list(chats)])?;
            let mut out = BTreeSet::new();
            while let Some(row) = rows.next()? {
                if let ValueRef::Text(name) = row.get_ref(0)? {
                    out.insert(String::from_utf8_lossy(name).into_owned());
                }
            }
            Ok(out)
        })
    }
}

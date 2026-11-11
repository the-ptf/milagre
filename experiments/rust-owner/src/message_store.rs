//! In-memory Project states with lazily loaded Chats: `packages/core/src/message-store.cjs`, ported.
//!
//! Node replaces a Project's state on every change and never changes one in place, so "did this message change" is
//! object identity: a message that didn't change is the same object in the next state. Patches to clients, skipped
//! row writes and the rules for unloading a Chat all rest on that. Here a message is an [`MsgRef`] (`Arc<Msg>`):
//! unchanged messages are the same `Arc` in the next state, and [`Arc::ptr_eq`] is Node's `===`.
//!
//! A Chat is loaded (all its messages in `state.messages`) or unloaded (none; its rows in chats.db are the only copy).
//! The unloaded set travels with each state ([`ProjectState::unloaded`]), as Node tags it on the messages array.
//!
//! Not ported: the whole-state row cache (`rest`, REST_TTL_MS) and the per-state whole copy (`wholes`). They keep
//! object identity stable for whole-state clients between calls (smaller diffs); every answer here is the same
//! without them.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::{Map, Value};

use crate::chat_db::{ChatDb, ChatId, LookupField, MessageRepository, Row};
use crate::error::Result;
use crate::jsjson;

/// One message. Its value never changes; a changed message is a new `Msg`.
#[derive(Debug)]
pub struct Msg {
    value: Value,
    /// message-store.cjs `fromDisk`: read back from chats.db, so a client already has it (not a change).
    from_disk: AtomicBool,
}

pub type MsgRef = Arc<Msg>;

impl Msg {
    pub fn new(value: Value) -> MsgRef {
        Arc::new(Msg {
            value,
            from_disk: AtomicBool::new(false),
        })
    }

    pub(crate) fn read_back(value: Value) -> MsgRef {
        Arc::new(Msg {
            value,
            from_disk: AtomicBool::new(true),
        })
    }

    pub fn value(&self) -> &Value {
        &self.value
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.value.get(key)
    }

    pub fn is_from_disk(&self) -> bool {
        self.from_disk.load(Ordering::Relaxed)
    }

    pub(crate) fn mark_from_disk(&self) {
        self.from_disk.store(true, Ordering::Relaxed);
    }

    /// The JavaScript Map key of this message's id (see [`id_key`]).
    pub fn key(&self) -> String {
        id_key(self.value.get("id"))
    }
}

/// A key of a JavaScript Map keyed by message id: `1` and `1.0` are one key, `"1"` another, `undefined` its own.
pub fn id_key(id: Option<&Value>) -> String {
    match id {
        Some(value) => jsjson::to_string(value),
        None => "\u{0}undefined".into(),
    }
}

/// JavaScript `Number(value)` as a Chat id: None for NaN and non-integers (which name no Chat).
pub fn chat_number(value: Option<&Value>) -> Option<ChatId> {
    let number = match value {
        None => return None,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(flag)) => f64::from(u8::from(*flag)),
        Some(Value::Number(number)) => jsjson::as_f64(number),
        Some(Value::String(text)) => {
            let text = text.trim();
            if text.is_empty() {
                0.0
            } else {
                text.parse::<f64>().ok()?
            }
        }
        _ => return None,
    };
    (number.is_finite() && number.fract() == 0.0).then_some(number as ChatId)
}

/// The Chat a message belongs to, `Number(message.session_id)`.
pub fn chat_of(message: &Msg) -> Option<ChatId> {
    chat_number(message.get("session_id"))
}

/// What chats.db holds for one message of a Chat in memory.
#[derive(Clone, Debug)]
pub struct SavedRow {
    pub msg: MsgRef,
    pub position: Value,
    pub chat: Value,
}

impl SavedRow {
    pub fn position(&self) -> f64 {
        self.position.as_f64().unwrap_or(f64::NAN)
    }
}

/// message-store.cjs savedRows: message id key -> what chats.db holds, for the Chats in memory.
pub type SavedMsgs = HashMap<String, SavedRow>;

/// A Project's state. Cloning is cheap; a change makes a new one sharing what didn't change.
#[derive(Clone, Debug)]
pub struct ProjectState {
    /// Every key but the messages, in their order; `messages` stays as a key (its value is ignored) to keep its place.
    pub rest: Arc<Map<String, Value>>,
    /// `state.messages` when it is an array.
    pub messages: Option<Arc<Vec<MsgRef>>>,
    /// The Chats whose messages this state doesn't hold.
    pub unloaded: Arc<BTreeSet<ChatId>>,
}

impl ProjectState {
    /// A state from a JavaScript-shaped value, every message new.
    pub fn from_value(value: &Value) -> Self {
        let mut rest = value.as_object().cloned().unwrap_or_default();
        let messages = match rest.get("messages") {
            Some(Value::Array(items)) => {
                Some(Arc::new(items.iter().cloned().map(Msg::new).collect()))
            }
            _ => None,
        };
        if messages.is_some() {
            rest.insert("messages".into(), Value::Null);
        }
        ProjectState {
            rest: Arc::new(rest),
            messages,
            unloaded: Arc::new(BTreeSet::new()),
        }
    }

    /// The state as JavaScript holds it (only the messages in memory).
    pub fn to_value(&self) -> Value {
        let mut map = (*self.rest).clone();
        if let Some(messages) = &self.messages {
            map.insert(
                "messages".into(),
                Value::Array(
                    messages
                        .iter()
                        .map(|message| message.value.clone())
                        .collect(),
                ),
            );
        }
        Value::Object(map)
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        if key == "messages" {
            return None;
        }
        self.rest.get(key)
    }

    pub fn sessions(&self) -> Option<&Map<String, Value>> {
        self.rest.get("sessions").and_then(Value::as_object)
    }

    /// `Object.hasOwn(state.sessions, String(chat))`.
    pub fn has_session(&self, chat: ChatId) -> bool {
        self.sessions()
            .is_some_and(|sessions| sessions.contains_key(&chat.to_string()))
    }

    pub fn message_list(&self) -> &[MsgRef] {
        self.messages.as_deref().map(Vec::as_slice).unwrap_or(&[])
    }

    /// This state with other messages (same unloaded set).
    pub fn with_messages(&self, messages: Vec<MsgRef>) -> Self {
        let mut rest = self.rest.clone();
        if !rest.contains_key("messages") {
            Arc::make_mut(&mut rest).insert("messages".into(), Value::Null);
        }
        ProjectState {
            rest,
            messages: Some(Arc::new(messages)),
            unloaded: self.unloaded.clone(),
        }
    }

    /// This state with one top-level key changed (`{ ...state, [key]: value }`).
    pub fn with_field(&self, key: &str, value: Value) -> Self {
        let mut next = self.clone();
        Arc::make_mut(&mut next.rest).insert(key.into(), value);
        next
    }

    pub fn same_messages(&self, other: &ProjectState) -> bool {
        match (&self.messages, &other.messages) {
            (Some(a), Some(b)) => Arc::ptr_eq(a, b),
            (None, None) => true,
            _ => false,
        }
    }
}

/// A row read back from chats.db, as `{ message, position, chat }` with the message marked as read back.
pub(crate) struct DiskRow {
    pub msg: MsgRef,
    pub position: f64,
    pub chat: Value,
}

fn disk_rows(rows: Vec<Row>) -> Vec<DiskRow> {
    rows.into_iter()
        .map(|row| DiskRow {
            position: row.position_f64(),
            chat: row.chat,
            msg: Msg::read_back(row.message),
        })
        .collect()
}

/// The per-Project store of message-store.cjs: the saved rows the writer and the loader share.
#[derive(Default, Debug)]
pub struct MessageStore {
    pub saved: Option<SavedMsgs>,
    /// Some Chat was unloaded and not every one loaded back since.
    pub unloaded: bool,
}

/// readableUnloaded: the unloaded Chats the state still has a session for.
pub fn readable_unloaded(state: &ProjectState) -> BTreeSet<ChatId> {
    if state.unloaded.is_empty() || state.sessions().is_none() {
        return (*state.unloaded).clone();
    }
    state
        .unloaded
        .iter()
        .copied()
        .filter(|chat| state.has_session(*chat))
        .collect()
}

/// positionsOf: where the state's messages sit in chats.db (saved rows, else read), by id key.
fn positions_of(
    db: &ChatDb,
    store: &MessageStore,
    state: &ProjectState,
) -> Result<HashMap<String, f64>> {
    let mut positions = HashMap::new();
    let mut missing = Vec::new();
    for message in state.message_list() {
        let key = message.key();
        match store.saved.as_ref().and_then(|saved| saved.get(&key)) {
            Some(row) => {
                positions.insert(key, row.position());
            }
            None => missing.push(message.get("id").cloned().unwrap_or(Value::Null)),
        }
    }
    if !missing.is_empty() {
        for (id, position, _) in db.read_positions(&missing)? {
            positions.insert(id_key(Some(&id)), position.as_f64().unwrap_or(f64::NAN));
        }
    }
    Ok(positions)
}

fn position_in(positions: &HashMap<String, f64>, message: &Msg) -> f64 {
    positions
        .get(&message.key())
        .copied()
        .unwrap_or(f64::INFINITY)
}

/// mergeRows: each row goes before the first message whose saved position is after its own.
fn merge_rows(
    messages: &[MsgRef],
    rows: &[DiskRow],
    positions: &HashMap<String, f64>,
) -> Vec<MsgRef> {
    let mut merged = Vec::with_capacity(messages.len() + rows.len());
    let mut next = 0;
    for message in messages {
        let at = position_in(positions, message);
        while next < rows.len() && rows[next].position < at {
            merged.push(rows[next].msg.clone());
            next += 1;
        }
        merged.push(message.clone());
    }
    merged.extend(rows[next..].iter().map(|row| row.msg.clone()));
    merged
}

/// rowsOf (without the whole-state cache): the rows of `chats` in the Project's order, marked as read back.
fn rows_of(db: &ChatDb, chats: &BTreeSet<ChatId>) -> Result<Vec<DiskRow>> {
    let list: Vec<ChatId> = chats.iter().copied().collect();
    let mut rows = disk_rows(db.read_chat_rows(&list)?);
    rows.sort_by(|a, b| a.position.total_cmp(&b.position));
    Ok(rows)
}

/// loadChats: the unloaded Chats `chats` read back into the state, in their place.
pub fn load_chats(
    db: &ChatDb,
    store: &mut MessageStore,
    state: &ProjectState,
    chats: &[ChatId],
) -> Result<ProjectState> {
    let live = readable_unloaded(state);
    let wanted: BTreeSet<ChatId> = chats
        .iter()
        .copied()
        .filter(|chat| live.contains(chat))
        .collect();
    if wanted.is_empty() {
        return Ok(state.clone());
    }
    let rows = rows_of(db, &wanted)?;
    let present: HashSet<String> = state
        .message_list()
        .iter()
        .map(|message| message.key())
        .collect();
    let fresh: Vec<DiskRow> = rows
        .into_iter()
        .filter(|row| !present.contains(&row.msg.key()))
        .collect();
    let positions = positions_of(db, store, state)?;
    if let Some(saved) = store.saved.as_mut() {
        for row in &fresh {
            saved.insert(
                row.msg.key(),
                SavedRow {
                    msg: row.msg.clone(),
                    position: jsjson::number(row.position),
                    chat: row.chat.clone(),
                },
            );
        }
    }
    let messages = merge_rows(state.message_list(), &fresh, &positions);
    let remaining: BTreeSet<ChatId> = state
        .unloaded
        .iter()
        .copied()
        .filter(|chat| !wanted.contains(chat))
        .collect();
    if remaining.is_empty() {
        store.unloaded = false;
    }
    let mut next = state.with_messages(messages);
    next.unloaded = Arc::new(remaining);
    Ok(next)
}

/// unloadChats: the state without the Chats of `chats` that chats.db holds exactly as it does.
pub fn unload_chats(
    store: &mut MessageStore,
    state: &ProjectState,
    chats: &BTreeSet<ChatId>,
) -> ProjectState {
    let Some(saved) = store.saved.as_mut() else {
        return state.clone();
    };
    let mut candidates = chats.clone();
    let mut counts: HashMap<ChatId, usize> = HashMap::new();
    for message in state.message_list() {
        let Some(chat) = chat_of(message) else {
            continue;
        };
        if !candidates.contains(&chat) {
            continue;
        }
        if saved
            .get(&message.key())
            .is_some_and(|row| Arc::ptr_eq(&row.msg, message))
        {
            *counts.entry(chat).or_default() += 1;
        } else {
            candidates.remove(&chat);
        }
    }
    let mut rows: HashMap<ChatId, usize> = HashMap::new();
    for row in saved.values() {
        if let Some(chat) = chat_number(Some(&row.chat)).filter(|chat| candidates.contains(chat)) {
            *rows.entry(chat).or_default() += 1;
        }
    }
    let going: BTreeSet<ChatId> = candidates
        .into_iter()
        .filter(|chat| {
            counts
                .get(chat)
                .is_some_and(|count| rows.get(chat) == Some(count))
        })
        .collect();
    if going.is_empty() {
        return state.clone();
    }
    store.unloaded = true;
    let mut kept = Vec::new();
    for message in state.message_list() {
        if chat_of(message).is_some_and(|chat| going.contains(&chat)) {
            if let Some(row) = saved.remove(&message.key()) {
                // Saved as it is: when it comes back, a client already has it.
                row.msg.mark_from_disk();
            }
        } else {
            kept.push(message.clone());
        }
    }
    let mut next = state.with_messages(kept);
    next.unloaded = Arc::new(state.unloaded.iter().copied().chain(going).collect());
    next
}

/// settle: a state a change produced, with any unloaded Chat it touched loaded back. Returns it and the Chats whose
/// messages changed.
pub fn settle(
    db: &ChatDb,
    store: &mut MessageStore,
    previous: Option<&ProjectState>,
    next: ProjectState,
) -> Result<(ProjectState, BTreeSet<ChatId>)> {
    if next.messages.is_none() || previous.is_some_and(|previous| previous.same_messages(&next)) {
        return Ok((next, BTreeSet::new()));
    }
    let unloaded = previous
        .map(|previous| previous.unloaded.clone())
        .unwrap_or_default();
    let before: HashSet<*const Msg> = previous
        .map(|previous| previous.message_list().iter().map(Arc::as_ptr).collect())
        .unwrap_or_default();
    let after: HashSet<*const Msg> = next.message_list().iter().map(Arc::as_ptr).collect();
    let mut touched = BTreeSet::new();
    for message in next.message_list() {
        if !before.contains(&Arc::as_ptr(message)) {
            touched.extend(chat_of(message));
        }
    }
    for message in previous.map(ProjectState::message_list).unwrap_or(&[]) {
        if !after.contains(&Arc::as_ptr(message)) {
            touched.extend(chat_of(message));
        }
    }
    let mut tagged = next;
    tagged.unloaded = unloaded.clone();
    let reached: Vec<ChatId> = touched
        .iter()
        .copied()
        .filter(|chat| unloaded.contains(chat))
        .collect();
    if !reached.is_empty() {
        return Ok((load_chats(db, store, &tagged, &reached)?, touched));
    }
    Ok((tagged, touched))
}

/// allMessages (and the messages of wholeState): every message, unloaded Chats' read back for this call.
pub fn all_messages(
    db: &ChatDb,
    store: &MessageStore,
    state: &ProjectState,
) -> Result<Vec<MsgRef>> {
    let unloaded = readable_unloaded(state);
    if unloaded.is_empty() {
        return Ok(state.message_list().to_vec());
    }
    Ok(merge_rows(
        state.message_list(),
        &rows_of(db, &unloaded)?,
        &positions_of(db, store, state)?,
    ))
}

/// wholeState: the state with every message.
pub fn whole_state(
    db: &ChatDb,
    store: &MessageStore,
    state: &ProjectState,
) -> Result<ProjectState> {
    if readable_unloaded(state).is_empty() {
        return Ok(state.clone());
    }
    Ok(state.with_messages(all_messages(db, store, state)?))
}

/// chatMessages: the messages of `chats`, in the Project's order.
pub fn chat_messages(
    db: &ChatDb,
    store: &MessageStore,
    state: &ProjectState,
    chats: &[ChatId],
) -> Result<Vec<MsgRef>> {
    let wanted: BTreeSet<ChatId> = chats.iter().copied().collect();
    let loaded: Vec<MsgRef> = state
        .message_list()
        .iter()
        .filter(|message| chat_of(message).is_some_and(|chat| wanted.contains(&chat)))
        .cloned()
        .collect();
    let unloaded: BTreeSet<ChatId> = readable_unloaded(state)
        .into_iter()
        .filter(|chat| wanted.contains(chat))
        .collect();
    if unloaded.is_empty() {
        return Ok(loaded);
    }
    let partial = state.with_messages(loaded.clone());
    Ok(merge_rows(
        &loaded,
        &rows_of(db, &unloaded)?,
        &positions_of(db, store, &partial)?,
    ))
}

/// inboxState: the state with bounded assistant previews in place of messages, unloaded Chats' read from chats.db.
pub fn inbox_state(db: &ChatDb, state: &ProjectState) -> Result<Value> {
    let mut chats: Vec<Value> = Vec::new();
    if let Some(sessions) = state.sessions() {
        for (_, session) in jsjson::js_entries(sessions) {
            let outcome = session
                .get("summary")
                .and_then(|summary| summary.get("lastOutcome"))
                .and_then(Value::as_str);
            if !jsjson::truthy(session.get("archived"))
                && jsjson::truthy(session.get("unread"))
                && matches!(outcome, Some("completed" | "failed"))
            {
                chats.push(session.get("id").cloned().unwrap_or(Value::Null));
            }
        }
    }
    let unloaded = readable_unloaded(state);
    let is_unloaded = |chat: &Value| {
        chat.as_f64()
            .is_some_and(|chat| unloaded.iter().any(|known| *known as f64 == chat))
    };
    let mut previews: Vec<Value> = Vec::new();
    for chat in chats.iter().filter(|chat| !is_unloaded(chat)) {
        let last = state.message_list().iter().rev().find(|message| {
            message
                .get("session_id")
                .is_some_and(|session| jsjson::strict_equals(session, chat))
                && message.get("role").and_then(Value::as_str) == Some("assistant")
        });
        if let Some(message) = last {
            // `body?.slice(0, 240) ?? ""`: text is cut at 240 UTF-16 units, a list keeps its first 240 items (Array
            // slice), none is "", and anything else makes Node throw, so the whole call fails the same way (the unread
            // outcome is what selects the Chat, so one malformed reply fails the inbox, as in Node).
            let body = match message.get("body") {
                Some(Value::String(body)) => {
                    let units = jsjson::to_utf16(body);
                    Value::String(jsjson::from_utf16(&units[..units.len().min(240)]))
                }
                None | Some(Value::Null) => Value::String(String::new()),
                Some(Value::Array(items)) => {
                    Value::Array(items.iter().take(240).cloned().collect())
                }
                Some(_) => {
                    return Err(crate::StoreError::Invalid(
                        "body?.slice is not a function".into(),
                    ));
                }
            };
            let mut preview = Map::new();
            preview.insert(
                "session_id".into(),
                message.get("session_id").cloned().unwrap_or(Value::Null),
            );
            preview.insert("role".into(), Value::String("assistant".into()));
            preview.insert("body".into(), body);
            previews.push(Value::Object(preview));
        }
    }
    let wanted: Vec<ChatId> = chats
        .iter()
        .filter(|chat| is_unloaded(chat))
        .filter_map(|chat| chat.as_i64())
        .collect();
    for preview in db.read_chat_previews(&wanted)? {
        let mut item = Map::new();
        item.insert("session_id".into(), preview.session_id.clone());
        item.insert("role".into(), Value::String("assistant".into()));
        item.insert(
            "body".into(),
            Value::String(jsjson::from_utf16(&preview.body_utf16)),
        );
        previews.push(Value::Object(item));
    }
    Ok(state
        .with_messages(previews.into_iter().map(Msg::new).collect())
        .to_value())
}

/// messagesContaining: messages in memory, and unloaded ones whose saved JSON contains a needle.
pub fn messages_containing(
    db: &ChatDb,
    store: &MessageStore,
    state: &ProjectState,
    needles: &[String],
) -> Result<Vec<MsgRef>> {
    let unloaded: Vec<ChatId> = readable_unloaded(state).into_iter().collect();
    if unloaded.is_empty() {
        return Ok(state.message_list().to_vec());
    }
    let rows = disk_rows(db.read_chat_rows_containing(&unloaded, needles)?);
    Ok(merge_rows(
        state.message_list(),
        &rows,
        &positions_of(db, store, state)?,
    ))
}

fn mark(message: &Value) -> Value {
    let mut out = Map::new();
    for key in ["id", "session_id", "role", "outcome", "clientMessageId"] {
        if let Some(value) = message.get(key) {
            out.insert(key.into(), value.clone());
        }
    }
    Value::Object(out)
}

/// messageMarks: `{ id, session_id, role, outcome, clientMessageId }` of every message, in the Project's order.
pub fn message_marks(
    db: &ChatDb,
    store: &MessageStore,
    state: &ProjectState,
) -> Result<Vec<Value>> {
    let loaded: Vec<Value> = state
        .message_list()
        .iter()
        .map(|message| mark(message.value()))
        .collect();
    let unloaded: Vec<ChatId> = readable_unloaded(state).into_iter().collect();
    if unloaded.is_empty() {
        return Ok(loaded);
    }
    let positions = positions_of(db, store, state)?;
    let rows = db.read_chat_marks(&unloaded)?;
    let mut merged = Vec::with_capacity(loaded.len() + rows.len());
    let mut next = 0;
    for (message, item) in state.message_list().iter().zip(loaded) {
        let at = position_in(&positions, message);
        while next < rows.len() && rows[next].position_f64() < at {
            merged.push(rows[next].message.clone());
            next += 1;
        }
        merged.push(item);
    }
    merged.extend(rows[next..].iter().map(|row| row.message.clone()));
    Ok(merged)
}

/// searchableMessages: `{ id, session_id, body }` (whole messages when in memory) of `chats`, all when None.
pub fn searchable_messages(
    db: &ChatDb,
    store: &MessageStore,
    state: &ProjectState,
    chats: Option<&[ChatId]>,
) -> Result<Vec<Value>> {
    let wanted: Option<BTreeSet<ChatId>> = chats.map(|chats| chats.iter().copied().collect());
    let wants = |chat: Option<ChatId>| {
        wanted
            .as_ref()
            .is_none_or(|wanted| chat.is_some_and(|chat| wanted.contains(&chat)))
    };
    let loaded: Vec<MsgRef> = state
        .message_list()
        .iter()
        .filter(|message| wants(chat_of(message)))
        .cloned()
        .collect();
    let unloaded: Vec<ChatId> = readable_unloaded(state)
        .into_iter()
        .filter(|chat| wants(Some(*chat)))
        .collect();
    if unloaded.is_empty() {
        return Ok(loaded
            .iter()
            .map(|message| message.value().clone())
            .collect());
    }
    let rows: Vec<DiskRow> = disk_rows(db.read_chat_bodies(&unloaded)?);
    let positions = positions_of(db, store, &state.with_messages(loaded.clone()))?;
    Ok(merge_rows(&loaded, &rows, &positions)
        .iter()
        .map(|message| message.value().clone())
        .collect())
}

/// findMessage: the first message (Project order) whose `field` is `value`, unloaded Chats looked up in chats.db.
pub fn find_message(
    db: &ChatDb,
    store: &MessageStore,
    state: &ProjectState,
    field: LookupField,
    value: &Value,
) -> Result<Option<MsgRef>> {
    let found = state
        .message_list()
        .iter()
        .find(|message| {
            message
                .get(field.key())
                .is_some_and(|known| jsjson::strict_equals(known, value))
        })
        .cloned();
    let unloaded: Vec<ChatId> = readable_unloaded(state).into_iter().collect();
    if unloaded.is_empty() || value.is_null() {
        return Ok(found);
    }
    let Some(row) = db.find_row(&unloaded, field, value)? else {
        return Ok(found);
    };
    match found {
        Some(found)
            if row.position_f64() >= position_in(&positions_of(db, store, state)?, &found) =>
        {
            Ok(Some(found))
        }
        _ => Ok(Some(Msg::new(row.message))),
    }
}

/// unloadedDetailRefs: the details sidecars the unloaded Chats' rows point at.
pub fn unloaded_detail_refs(db: &ChatDb, state: &ProjectState) -> Result<BTreeSet<String>> {
    db.read_detail_refs(&readable_unloaded(state).into_iter().collect::<Vec<_>>())
}

/// apps/daemon/src/server.cjs messageChanges: what a client without whole states hears of a change. The messages
/// `next` has that `previous` didn't (new or changed, by identity; read-back rows don't count), each with the id of
/// the message before it in its Chat, and the ids it no longer has (a Chat unloaded while its session exists isn't
/// removed). `{ changed: [{ message, after }], removed: [id] }`.
pub fn message_changes(previous: Option<&ProjectState>, next: Option<&ProjectState>) -> Value {
    let empty = || serde_json::json!({ "changed": [], "removed": [] });
    let before_list = previous.map(ProjectState::message_list).unwrap_or(&[]);
    let next_list = next.map(ProjectState::message_list).unwrap_or(&[]);
    if let (Some(previous), Some(next)) = (previous, next) {
        if previous.same_messages(next) {
            return empty();
        }
    }
    let before: HashSet<*const Msg> = before_list.iter().map(Arc::as_ptr).collect();
    let changed: Vec<&MsgRef> = next_list
        .iter()
        .filter(|message| !before.contains(&Arc::as_ptr(message)) && !message.is_from_disk())
        .collect();
    let ids: HashSet<String> = next_list.iter().map(|message| message.key()).collect();
    let kept = |message: &Msg| {
        next.is_some_and(|next| {
            chat_number(message.get("session_id")).is_some_and(|chat| next.unloaded.contains(&chat))
                && next.sessions().is_some_and(|sessions| {
                    sessions.contains_key(&jsjson::property_key(message.get("session_id")))
                })
        })
    };
    let removed: Vec<Value> = before_list
        .iter()
        .filter(|message| !ids.contains(&message.key()) && !kept(message))
        .map(|message| message.get("id").cloned().unwrap_or(Value::Null))
        .collect();
    if changed.is_empty() {
        return serde_json::json!({ "changed": [], "removed": removed });
    }
    // Messages grouped by `session_id` as a Map key (SameValueZero on the raw value).
    let mut chats: HashMap<String, Vec<&MsgRef>> = HashMap::new();
    for message in next_list {
        chats
            .entry(id_key(message.get("session_id")))
            .or_default()
            .push(message);
    }
    let changed: Vec<Value> = changed
        .into_iter()
        .map(|message| {
            let chat = &chats[&id_key(message.get("session_id"))];
            let at = chat
                .iter()
                .position(|item| Arc::ptr_eq(item, message))
                .expect("in its Chat");
            let after = if at == 0 {
                Value::Null
            } else {
                chat[at - 1].get("id").cloned().unwrap_or(Value::Null)
            };
            serde_json::json!({ "message": message.value(), "after": after })
        })
        .collect();
    serde_json::json!({ "changed": changed, "removed": removed })
}

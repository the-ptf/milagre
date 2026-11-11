//! Sending messages and folding turns: the core of `packages/core/src/agents/chat-host.cjs` ChatHost, over
//! [`ProjectStates`] in an isolated copy, with agents behind a [`Provider`] trait.
//!
//! Ported as Node does it:
//!
//! - **Receipts and idempotency.** A send with a `clientMessageId` already saved (or waiting in a queue) answers
//!   `{ sessionId, duplicate }` and starts nothing, checked before the save and again inside it.
//! - **Save, flush, start.** The user message is saved and flushed to disk before the turn starts; a failed flush
//!   takes the message back out. The `message-sent` event opens the run; a provider that fails to start ends it with
//!   `turn-failed`.
//! - **Queue.** A message for a running turn whose provider can't steer, or sent with `delivery: "queue"`, waits in
//!   `session.queued` (saved before it is answered). A completed turn starts the oldest; a cancelled or failed one
//!   holds the queue. Send now (`chat:queue-send`) and Remove (`chat:queue-remove`).
//! - **Events.** `session-started`, `session-reset`, `turn-started`, `text-delta`, `context-usage`,
//!   permission/question requests (shown, see gates), `subagents-waiting` and the three turn ends, which save the
//!   reply, mark the Chat unread unless it is the open one, archive finished subagents and move the queue on.
//! - **Cancel.** `agent:interrupt` asks the provider to stop; its `turn-cancelled` ends the turn.
//!
//! Explicit gates (refused with [`gate`] errors, never approximated): steering a running turn, provider handoffs,
//! compaction, usage-limit continuations and account routing, Routines' messages, wake turns, `canStart`, images,
//! handover briefs, Send now that would steer, answering permissions and questions, and the agent events listed in
//! [`crate::agent_runs::UNSUPPORTED`] (tool steps, subagents, plans, suggestions, compaction progress).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};

use crate::agent_runs::{self, chat_key, is_turn_end, session_of_key, Runs};
use crate::chat_db::LookupField;
use crate::error::{Result, StoreError};
use crate::jsjson;
use crate::message_store::{Msg, MsgRef, ProjectState};
use crate::states::ProjectStates;

/// What each provider can do (shared/provider-capabilities.mjs).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Capabilities {
    pub steer: bool,
    pub compact: bool,
}

pub fn provider_capabilities(provider: Option<&str>) -> Capabilities {
    match provider {
        Some("claude") => Capabilities {
            steer: true,
            compact: true,
        },
        Some("codex") => Capabilities {
            steer: true,
            compact: false,
        },
        _ => Capabilities::default(),
    }
}

/// An agent provider adapter. The host calls it; it answers with events, which the host folds.
///
/// `start_turn` gets the request ChatHost passes SessionManager.startTurn (`{ provider, model, permissionMode,
/// effort, ultracode, fastMode, replies, tldrEnabled, prompt, chatId, cwd, images, resumeId }`, undefined fields left
/// out) and answers what it resolves with (`{ turnId, steered }`), or the error message a failed start rejects with.
/// Events (`{ type, … }` as Node's agent events) are taken with `take_events`, in order, as `(chatId, event)`.
pub trait Provider {
    fn name(&self) -> &str;
    fn start_turn(&mut self, request: &Value) -> std::result::Result<Value, String>;
    fn interrupt(&mut self, chat: &str) -> std::result::Result<(), String>;
    fn take_events(&mut self) -> Vec<(String, Value)>;
}

/// A refused feature: what isn't ported, said as such.
pub fn gate(what: &str) -> StoreError {
    StoreError::Invalid(format!("{what} isn't supported by the Rust owner yet."))
}

/// A scripted provider for tests and conformance: records what it was asked, answers what it is told.
#[derive(Default)]
pub struct MockState {
    pub turns: Vec<Value>,
    pub interrupts: Vec<String>,
    pub events: Vec<(String, Value)>,
    pub fail_next_start: Option<String>,
    pub next_turn: u64,
}

#[derive(Clone)]
pub struct MockProvider {
    name: String,
    pub state: Arc<Mutex<MockState>>,
}

impl MockProvider {
    pub fn new(name: &str) -> Self {
        MockProvider {
            name: name.into(),
            state: Arc::new(Mutex::new(MockState::default())),
        }
    }

    pub fn emit(&self, chat: &str, event: Value) {
        self.state.lock().unwrap().events.push((chat.into(), event));
    }
}

impl Provider for MockProvider {
    fn name(&self) -> &str {
        &self.name
    }
    fn start_turn(&mut self, request: &Value) -> std::result::Result<Value, String> {
        let mut state = self.state.lock().unwrap();
        state.turns.push(request.clone());
        if let Some(error) = state.fail_next_start.take() {
            return Err(error);
        }
        state.next_turn += 1;
        Ok(json!({ "turnId": format!("turn-{}", state.next_turn), "steered": false }))
    }
    fn interrupt(&mut self, chat: &str) -> std::result::Result<(), String> {
        self.state.lock().unwrap().interrupts.push(chat.into());
        Ok(())
    }
    fn take_events(&mut self) -> Vec<(String, Value)> {
        std::mem::take(&mut self.state.lock().unwrap().events)
    }
}

/// What the host told its clients, in order (Node's `publish`, `broadcast`, `nameChat` and queue callbacks).
#[derive(Clone, Debug, PartialEq)]
pub enum Notice {
    Event {
        chat: String,
        event: Value,
        seq: Option<u64>,
        with_state: bool,
    },
    Broadcast {
        project: PathBuf,
    },
    NameChat {
        project: PathBuf,
        session: i64,
    },
    QueueStarted {
        id: String,
        result: Value,
    },
    QueueStartedWithoutSender {
        chat: String,
        id: String,
    },
    QueueRemovedWithoutSender {
        chat: String,
        id: String,
    },
    /// A reply whose images Node would copy into the Project (chat-images.cjs): not ported, said so.
    Gap {
        chat: String,
        what: String,
    },
}

/// What a send answered.
#[derive(Clone, Debug, PartialEq)]
pub struct Sent {
    pub session_id: Value,
    pub duplicate: bool,
    pub queued: bool,
    /// What the provider's start resolved with (`null` when the turn couldn't start); None when nothing started
    /// (a duplicate, or a queued message that waits).
    pub started: Option<Value>,
}

const FORMER_WORKTREE: &str = "This Run's Worktree was removed because the Run left nothing in it. Start a new Chat to continue.";
const PERMISSION_MODES: [&str; 3] = ["ask", "auto", "full"];

fn field<'a>(request: &'a Value, key: &str) -> Option<&'a Value> {
    request.get(key).filter(|value| !value.is_null())
}

fn present(request: &Value, key: &str) -> bool {
    request.get(key).is_some()
}

/// withoutQueued: the session without one queued message; the hold goes with the last one.
fn without_queued(session: &Map<String, Value>, id: &str) -> Map<String, Value> {
    let mut rest = session.clone();
    let queued = rest.shift_remove("queued");
    let held = rest.shift_remove("queueHeld");
    let left: Vec<Value> = queued
        .as_ref()
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|item| item.get("id").and_then(Value::as_str) != Some(id))
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    if left.is_empty() {
        return rest;
    }
    rest.insert("queued".into(), Value::Array(left));
    if jsjson::truthy(held.as_ref()) {
        rest.insert("queueHeld".into(), json!(true));
    }
    rest
}

fn session_value(state: &ProjectState, session: &Value) -> Option<Map<String, Value>> {
    state
        .sessions()?
        .get(&jsjson::property_key(Some(session)))?
        .as_object()
        .cloned()
}

fn session_messages<'a>(
    state: &'a ProjectState,
    session: &'a Value,
) -> impl Iterator<Item = &'a MsgRef> {
    state.message_list().iter().filter(move |message| {
        message
            .get("session_id")
            .is_some_and(|id| jsjson::strict_equals(id, session))
    })
}

/// The ChatHost of one isolated copy's Projects.
pub struct ChatHost {
    pub states: ProjectStates,
    providers: BTreeMap<String, Box<dyn Provider>>,
    runs: Runs,
    seq: u64,
    starting: HashMap<String, String>,
    send_next: HashMap<String, String>,
    queue_waiters: HashSet<String>,
    turns: HashMap<String, Value>,
    /// The Chat shown in a focused window (Node's openChat with isFocused): a turn ending there isn't unread.
    pub open_chat: Option<String>,
    notices: Vec<Notice>,
    ids: Box<dyn FnMut() -> String>,
    /// Chats the states were told are busy (Node's ProjectStates asks ChatHost.isBusy before unloading a Chat).
    busy: HashSet<String>,
}

impl ChatHost {
    pub fn new(states: ProjectStates) -> Self {
        ChatHost {
            states,
            providers: BTreeMap::new(),
            runs: Runs::new(),
            seq: 0,
            starting: HashMap::new(),
            send_next: HashMap::new(),
            queue_waiters: HashSet::new(),
            turns: HashMap::new(),
            open_chat: None,
            notices: Vec::new(),
            ids: Box::new(crate::ownership::random_uuid),
            busy: HashSet::new(),
        }
    }

    /// Queued messages' ids (crypto.randomUUID in Node); tests make them deterministic.
    pub fn set_ids(&mut self, ids: impl FnMut() -> String + 'static) {
        self.ids = Box::new(ids);
    }

    pub fn register(&mut self, provider: Box<dyn Provider>) {
        self.providers.insert(provider.name().to_string(), provider);
    }

    pub fn runs(&self) -> &Runs {
        &self.runs
    }

    pub fn take_notices(&mut self) -> Vec<Notice> {
        std::mem::take(&mut self.notices)
    }

    /// Whether a Chat's turn runs or is about to start.
    pub fn is_busy(&self, chat: &str) -> bool {
        self.runs.contains_key(chat) || self.starting.contains_key(chat)
    }

    fn project_path(project: &str) -> PathBuf {
        PathBuf::from(project)
    }

    /// Keeps the states' busy Chats (never unloaded by a sweep) equal to the Chats with a run.
    fn sync_busy(&mut self) {
        let now: HashSet<String> = self.runs.keys().cloned().collect();
        for chat in now.symmetric_difference(&self.busy) {
            if let Some(session) = session_of_key(chat) {
                let project = Self::project_path(agent_runs::project_of_key(chat));
                let _ = self.states.set_busy(&project, session, now.contains(chat));
            }
        }
        self.busy = now;
    }

    fn broadcast(&mut self, project: &Path) {
        self.notices.push(Notice::Broadcast {
            project: project.to_path_buf(),
        });
    }

    // ---- sending -------------------------------------------------------------------------------------------

    /// The requests this checkpoint refuses rather than approximates.
    fn gates(request: &Value) -> Result<()> {
        if field(request, "images")
            .and_then(Value::as_array)
            .is_some_and(|images| !images.is_empty())
        {
            return Err(gate("Sending images"));
        }
        let context_kind = field(request, "context")
            .and_then(|context| context.get("kind"))
            .and_then(Value::as_str);
        if context_kind == Some("compaction") {
            return Err(gate("Compacting a Chat"));
        }
        if matches!(context_kind, Some("routine-run"))
            || field(request, "context")
                .and_then(|c| c.get("routine"))
                .is_some_and(Value::is_object)
        {
            return Err(gate("A Routine's message"));
        }
        for key in [
            "limitResumeId",
            "limitSwitchToken",
            "queueReleaseToken",
            "expectedAccountId",
            "canStart",
        ] {
            if present(request, key) {
                return Err(gate("Usage-limit continuations and account routing"));
            }
        }
        if present(request, "idleOnly") || present(request, "guard") {
            return Err(gate("A wake's guarded turn"));
        }
        if field(request, "delivery").and_then(Value::as_str) == Some("now") {
            return Err(gate("Sending now (delivery \"now\")"));
        }
        match field(request, "provider") {
            Some(Value::String(_)) => Ok(()),
            _ => Err(StoreError::Invalid(
                "Choose a provider for the message.".into(),
            )),
        }
    }

    /// ChatHost.send / sendMessage.
    pub fn send(&mut self, request: &Value) -> Result<Sent> {
        if let Some(delivery) = request.get("delivery").filter(|value| !value.is_null()) {
            if !matches!(delivery.as_str(), Some("queue" | "now")) {
                return Err(StoreError::Invalid("Invalid message delivery.".into()));
            }
        }
        Self::gates(request)?;
        let project_text = request
            .get("projectPath")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let project = Self::project_path(&project_text);
        let client_id = request
            .get("clientMessageId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_string);
        if let Some(id) = &client_id {
            if let Some(earlier) =
                self.states
                    .find_message(&project, LookupField::ClientMessageId, &json!(id))?
            {
                return Ok(Sent {
                    session_id: earlier.get("session_id").cloned().unwrap_or(Value::Null),
                    duplicate: true,
                    queued: false,
                    started: None,
                });
            }
        }
        let provider = request["provider"].as_str().unwrap().to_string();
        let body = request.get("body").cloned().unwrap_or(Value::Null);
        let model = request.get("model").cloned();
        let from_queue = request
            .get("fromQueue")
            .and_then(Value::as_str)
            .map(str::to_string);
        let request_session = field(request, "sessionId").cloned();
        let chats: Vec<i64> = request_session
            .as_ref()
            .and_then(Value::as_i64)
            .into_iter()
            .collect();
        let now = self.states.now();

        // What the change decides, read after it.
        let mut duplicate: Option<Value> = None;
        let mut queued_entry: Option<Value> = None;
        let mut target: Option<(String, i64, Value, Option<Value>)> = None; // chat, session, cwd, resumeId
        let mut pending: Option<MsgRef> = None;
        let mut original: Option<Map<String, Value>> = None;
        let mut staged: Option<Map<String, Value>> = None;
        let mut run_model = model.clone().unwrap_or(Value::Null);
        let runs = self.runs.clone();
        let starting = self.starting.clone();
        let ids = &mut self.ids;
        let project_key = project_text.clone();

        let saving = self
            .states
            .try_update(&project, Some(&chats), true, |latest| {
                if let Some(id) = &client_id {
                    if let Some(twin) = latest
                        .message_list()
                        .iter()
                        .find(|m| m.get("clientMessageId").and_then(Value::as_str) == Some(id))
                    {
                        duplicate = Some(twin.get("session_id").cloned().unwrap_or(Value::Null));
                        return Ok(None);
                    }
                    if from_queue.is_none() {
                        let queued_twin = latest.sessions().and_then(|sessions| {
                            jsjson::js_entries(sessions)
                                .into_iter()
                                .map(|(_, s)| s)
                                .find(|s| {
                                    s.get("queued").and_then(Value::as_array).is_some_and(|q| {
                                        q.iter().any(|e| {
                                            e.get("clientMessageId").and_then(Value::as_str)
                                                == Some(id)
                                        })
                                    })
                                })
                        });
                        if let Some(twin) = queued_twin {
                            duplicate = Some(twin.get("id").cloned().unwrap_or(Value::Null));
                            return Ok(None);
                        }
                    }
                }
                let mut session = request_session
                    .as_ref()
                    .and_then(|id| session_value(latest, id));
                if request_session.is_some() && session.is_none() {
                    return Err(StoreError::Invalid(
                        "That chat is no longer in the project.".into(),
                    ));
                }
                if session
                    .as_ref()
                    .is_some_and(|s| jsjson::truthy(s.get("formerWorktree")))
                {
                    return Err(StoreError::Invalid(FORMER_WORKTREE.into()));
                }
                if session.as_ref().is_some_and(|s| {
                    s.contains_key("workspacePath") && jsjson::truthy(s.get("workspacePath"))
                }) {
                    return Err(gate("A Link's shared Chat"));
                }
                let worktree_id = session
                    .as_ref()
                    .and_then(|s| s.get("worktree_id").cloned())
                    .or_else(|| request.get("worktreeId").cloned());
                let worktree = latest
                    .get("worktrees")
                    .and_then(Value::as_object)
                    .and_then(|worktrees| {
                        worktrees.get(&jsjson::property_key(worktree_id.as_ref()))
                    })
                    .and_then(Value::as_object)
                    .cloned()
                    .ok_or_else(|| {
                        StoreError::Invalid("That worktree is no longer in the project.".into())
                    })?;
                if jsjson::truthy(worktree.get("sharedChat")) {
                    return Err(StoreError::Invalid(
                        "This Worktree belongs to a shared Link Chat. Open its Link instead."
                            .into(),
                    ));
                }
                let mut with_session = latest.clone();
                if session.is_none() {
                    // starterChat: the Worktree's Chat with no messages yet, else a new one.
                    let existing = latest.sessions().and_then(|sessions| {
                        jsjson::js_entries(sessions)
                            .into_iter()
                            .map(|(_, s)| s)
                            .find(|item| {
                                item.get("worktree_id").is_some_and(|id| {
                                    worktree
                                        .get("id")
                                        .is_some_and(|wid| jsjson::strict_equals(id, wid))
                                }) && !jsjson::truthy(item.get("handoverPending"))
                                    && item.get("handoverDraft").is_none()
                                    && !jsjson::truthy(item.get("routine"))
                                    && !(item
                                        .get("summary")
                                        .and_then(|s| s.get("count"))
                                        .and_then(Value::as_f64)
                                        .unwrap_or(0.0)
                                        > 0.0
                                        || session_messages(
                                            latest,
                                            item.get("id").unwrap_or(&Value::Null),
                                        )
                                        .next()
                                        .is_some())
                            })
                    });
                    session = match existing {
                        Some(existing) => existing.as_object().cloned(),
                        None => {
                            let next_id = latest.get("next_id").cloned().unwrap_or(Value::Null);
                            let mut created = Map::new();
                            created.insert("id".into(), next_id.clone());
                            created.insert(
                                "worktree_id".into(),
                                worktree.get("id").cloned().unwrap_or(Value::Null),
                            );
                            if let Some(name) = worktree.get("name") {
                                created.insert("agent_name".into(), name.clone());
                            }
                            created.insert("status".into(), json!("Created"));
                            with_session = agent_runs::with_session(
                                latest,
                                next_id.as_i64().unwrap_or(0),
                                created.clone(),
                            )
                            .with_field(
                                "next_id",
                                jsjson::number(next_id.as_f64().unwrap_or(f64::NAN) + 1.0),
                            );
                            Some(created)
                        }
                    };
                }
                let mut session = session.expect("found or made");
                let session_id_value = session.get("id").cloned().unwrap_or(Value::Null);
                let session_id = session_id_value
                    .as_i64()
                    .ok_or_else(|| StoreError::Invalid("That chat has no id.".into()))?;
                let first_message = session_messages(latest, &session_id_value).next().is_none();
                if first_message && session.get("handoverDraft").is_some() {
                    return Err(gate("A handed-over Chat's first message (its brief)"));
                }
                let chat = chat_key(&project_key, &session_id_value);
                let before_queue = session.clone();
                if let Some(id) = &from_queue {
                    let has = session
                        .get("queued")
                        .and_then(Value::as_array)
                        .is_some_and(|q| {
                            q.iter()
                                .any(|e| e.get("id").and_then(Value::as_str) == Some(id))
                        });
                    if !has {
                        return Err(StoreError::Invalid(
                            "That queued message was already sent or removed.".into(),
                        ));
                    }
                    if runs.contains_key(&chat) || starting.contains_key(&chat) {
                        return Err(StoreError::Invalid("The chat is busy.".into()));
                    }
                    let mut rest = without_queued(&session, id);
                    rest.shift_remove("queueHeld");
                    session = rest;
                }
                let running_provider = if runs.contains_key(&chat) {
                    Some(
                        session
                            .get("provider")
                            .and_then(Value::as_str)
                            .unwrap_or(&provider)
                            .to_string(),
                    )
                } else {
                    starting.get(&chat).cloned()
                };
                let last_user = session_messages(latest, &session_id_value)
                    .filter(|m| m.get("role").and_then(Value::as_str) == Some("user"))
                    .last();
                let compacting = (runs.contains_key(&chat) || starting.contains_key(&chat))
                    && last_user.is_some_and(|m| {
                        m.get("context")
                            .and_then(|c| c.get("kind"))
                            .and_then(Value::as_str)
                            == Some("compaction")
                    });
                if let Some(running) = &running_provider {
                    if from_queue.is_none() {
                        let queue = request.get("delivery").and_then(Value::as_str)
                            == Some("queue")
                            || compacting
                            || !provider_capabilities(Some(running)).steer;
                        if queue {
                            let mut entry = Map::new();
                            entry.insert("id".into(), Value::String(ids()));
                            entry.insert("body".into(), body.clone());
                            if let Some(files) = field(request, "files")
                                .and_then(Value::as_array)
                                .filter(|files| !files.is_empty())
                            {
                                entry.insert("files".into(), Value::Array(files.clone()));
                            }
                            if let Some(context) = field(request, "context")
                                .filter(|context| jsjson::truthy(Some(context)))
                            {
                                entry.insert("context".into(), context.clone());
                            }
                            if let Some(model) = &model {
                                entry.insert("model".into(), model.clone());
                            }
                            entry.insert("provider".into(), json!(provider));
                            entry.insert("queuedAt".into(), json!(now));
                            if let Some(Value::String(id)) = request.get("clientMessageId") {
                                entry.insert("clientMessageId".into(), json!(id));
                            }
                            if let Some(operation) = field(request, "operationId")
                                .filter(|value| jsjson::truthy(Some(value)))
                            {
                                entry.insert("operationId".into(), operation.clone());
                            }
                            if let Some(prompt) = request.get("prompt") {
                                if !jsjson::strict_equals(prompt, &body) {
                                    entry.insert("prompt".into(), prompt.clone());
                                }
                            }
                            let mut turn = Map::new();
                            for key in [
                                "permissionMode",
                                "effort",
                                "ultracode",
                                "fastMode",
                                "replies",
                                "tldrEnabled",
                            ] {
                                if let Some(value) = request.get(key) {
                                    turn.insert(key.into(), value.clone());
                                }
                            }
                            entry.insert("turn".into(), Value::Object(turn));
                            let mut items = session
                                .get("queued")
                                .and_then(Value::as_array)
                                .cloned()
                                .unwrap_or_default();
                            items.push(Value::Object(entry.clone()));
                            session.insert("queued".into(), Value::Array(items));
                            queued_entry = Some(Value::Object(entry));
                            target = Some((chat, session_id, Value::Null, None));
                            return Ok(Some(agent_runs::with_session(
                                &with_session,
                                session_id,
                                session,
                            )));
                        }
                    }
                }
                if runs.contains_key(&chat) {
                    return Err(gate(
                        "Steering a running turn (send with delivery \"queue\" to queue it)",
                    ));
                }
                // handoffKind: the provider of the chat's last turn, and whether a restore is due.
                let messages: Vec<&MsgRef> =
                    session_messages(&with_session, &session_id_value).collect();
                if !messages.is_empty() {
                    let divider = messages.iter().rev().find(|m| {
                        m.get("context")
                            .and_then(|c| c.get("kind"))
                            .and_then(Value::as_str)
                            == Some("handoff")
                            && m.get("context")
                                .and_then(|c| c.get("status"))
                                .and_then(Value::as_str)
                                != Some("failed")
                    });
                    let last = match divider {
                        Some(divider) => divider
                            .get("context")
                            .and_then(|c| c.get("to"))
                            .and_then(|t| t.get("provider"))
                            .cloned(),
                        None => session.get("provider").cloned(),
                    };
                    let last = last.and_then(|value| value.as_str().map(str::to_string));
                    if let Some(last) = last {
                        if last != provider {
                            return Err(gate("Switching a Chat to another provider (handoff)"));
                        }
                        let replied = messages.iter().any(|m| {
                            m.get("role").and_then(Value::as_str) == Some("assistant")
                                && m.get("outcome").and_then(Value::as_str) == Some("completed")
                        });
                        if replied && !jsjson::truthy(session.get("native_session_id")) {
                            return Err(gate(
                                "Restoring a Chat whose provider session is gone (handoff restore)",
                            ));
                        }
                    }
                }
                original = Some(before_queue);
                run_model = model.clone().unwrap_or(Value::Null);
                let next_id = with_session
                    .get("next_id")
                    .and_then(Value::as_f64)
                    .unwrap_or(f64::NAN);
                let mut message = Map::new();
                message.insert("id".into(), jsjson::number(next_id));
                message.insert("session_id".into(), session_id_value.clone());
                message.insert("body".into(), body.clone());
                message.insert("images".into(), json!([]));
                if let Some(files) = field(request, "files")
                    .and_then(Value::as_array)
                    .filter(|files| !files.is_empty())
                {
                    message.insert("files".into(), Value::Array(files.clone()));
                }
                message.insert(
                    "context".into(),
                    field(request, "context").cloned().unwrap_or(Value::Null),
                );
                if let Some(operation) =
                    field(request, "operationId").filter(|value| jsjson::truthy(Some(value)))
                {
                    message.insert("operationId".into(), operation.clone());
                }
                message.insert("role".into(), json!("user"));
                message.insert("model".into(), run_model.clone());
                if let Some(Value::String(id)) = request.get("clientMessageId") {
                    message.insert("clientMessageId".into(), json!(id));
                }
                let mut next_session = session.clone();
                for key in [
                    "handoverDraft",
                    "resumeTurn",
                    "limitResume",
                    "limitTurn",
                    "suggestion",
                    "suggestionTurnId",
                ] {
                    next_session.shift_remove(key);
                }
                next_session.insert("provider".into(), json!(provider));
                if let Some(mode) = request
                    .get("permissionMode")
                    .and_then(Value::as_str)
                    .filter(|mode| PERMISSION_MODES.contains(mode))
                {
                    next_session.insert("permissionMode".into(), json!(mode));
                }
                let body_text = body.as_str().map(str::trim).unwrap_or("");
                if first_message
                    && !body_text.is_empty()
                    && !jsjson::truthy(session.get("title"))
                    && !jsjson::truthy(session.get("generatedTitle"))
                {
                    next_session.insert("titlePending".into(), json!(true));
                }
                target = Some((
                    chat.clone(),
                    session_id,
                    worktree.get("path").cloned().unwrap_or(Value::Null),
                    next_session.get("native_session_id").cloned(),
                ));
                staged = Some(next_session.clone());
                let msg = Msg::new(Value::Object(message));
                pending = Some(msg.clone());
                let mut list = with_session.message_list().to_vec();
                list.push(msg);
                let next = agent_runs::with_session(&with_session, session_id, next_session)
                    .with_field("next_id", jsjson::number(next_id + 1.0))
                    .with_messages(list);
                Ok(Some(next))
            });
        if let Some((chat, ..)) = &target {
            if staged.is_some() && saving.is_ok() {
                self.starting.insert(chat.clone(), provider.clone());
            }
        }
        saving?;
        if let Some(session) = duplicate {
            return Ok(Sent {
                session_id: session,
                duplicate: true,
                queued: false,
                started: None,
            });
        }
        let (chat, session_id, cwd, resume_id) = target.expect("a send that saved names its Chat");
        if let Some(entry) = queued_entry {
            return self.queue_saved(&project, &chat, session_id, &entry);
        }
        let pending = pending.expect("message saved");
        // Persist the message before its turn starts; a failed flush takes it back out.
        if let Err(error) = self.states.flush(Some(&project)) {
            self.starting.remove(&chat);
            let original = original.unwrap_or_default();
            let staged = staged.unwrap_or_default();
            let pending_id = pending.get("id").cloned();
            let rolled = self
                .states
                .update(&project, Some(&[session_id]), true, |latest| {
                    let mut session = agent_runs_session(latest, session_id)?;
                    for key in [
                        "provider",
                        "titlePending",
                        "handoverDraft",
                        "resumeTurn",
                        "limitResume",
                        "limitTurn",
                        "native_session_id",
                        "native_sessions",
                        "queued",
                        "queueHeld",
                    ] {
                        if session.get(key) != staged.get(key) {
                            continue;
                        }
                        match original.get(key) {
                            Some(value) => {
                                session.insert(key.into(), value.clone());
                            }
                            None => {
                                session.shift_remove(key);
                            }
                        }
                    }
                    let messages = latest
                        .message_list()
                        .iter()
                        .filter(|m| m.get("id") != pending_id.as_ref())
                        .cloned()
                        .collect();
                    Some(
                        agent_runs::with_session(latest, session_id, session)
                            .with_messages(messages),
                    )
                });
            if rolled.is_ok() {
                self.broadcast(&project);
            }
            return Err(error);
        }
        // message-sent: the run opens, the message stays where it was saved.
        let mut runs = std::mem::take(&mut self.runs);
        let mut seq = self.seq;
        let event = {
            let mut event = Map::new();
            event.insert("type".into(), json!("message-sent"));
            event.insert("model".into(), run_model.clone());
            if let Some(mode) = request.get("permissionMode") {
                event.insert("permissionMode".into(), mode.clone());
            }
            Value::Object(event)
        };
        let folded = self
            .states
            .try_update(&project, Some(&[session_id]), true, |latest| {
                let without: Vec<MsgRef> = latest
                    .message_list()
                    .iter()
                    .filter(|m| !Arc::ptr_eq(m, &pending))
                    .cloned()
                    .collect();
                let base = latest.with_messages(without);
                let (sent, next_runs, _) =
                    agent_runs::apply_agent_event(&base, &runs, &project_key, &chat, &event, now)
                        .map_err(|unsupported| gate(&unsupported.0))?;
                runs = next_runs;
                seq += 1;
                let mut list = sent.message_list().to_vec();
                list.push(pending.clone());
                Ok(Some(sent.with_messages(list)))
            });
        self.runs = runs;
        self.seq = seq;
        self.starting.remove(&chat);
        self.sync_busy();
        let (state, _) = folded?;
        self.notices.push(Notice::Event {
            chat: chat.clone(),
            event: event.clone(),
            seq: Some(self.seq),
            with_state: true,
        });
        if session_value(&state, &json!(session_id))
            .is_some_and(|s| jsjson::truthy(s.get("titlePending")))
        {
            self.notices.push(Notice::NameChat {
                project: project.clone(),
                session: session_id,
            });
        }
        let mut turn = Map::new();
        turn.insert("provider".into(), json!(provider));
        turn.insert("model".into(), run_model.clone());
        for key in [
            "permissionMode",
            "effort",
            "ultracode",
            "fastMode",
            "replies",
            "tldrEnabled",
        ] {
            if let Some(value) = request.get(key) {
                turn.insert(key.into(), value.clone());
            }
        }
        let prompt = [request.get("prompt"), Some(&body)]
            .into_iter()
            .flatten()
            .find(|value| jsjson::truthy(Some(value)))
            .cloned()
            .unwrap_or_else(|| json!("Describe the attached images."));
        turn.insert("prompt".into(), prompt);
        self.turns.insert(chat.clone(), Value::Object(turn.clone()));
        let mut start = turn;
        start.insert("chatId".into(), json!(chat));
        start.insert("cwd".into(), cwd);
        start.insert(
            "images".into(),
            request.get("images").cloned().unwrap_or(json!([])),
        );
        if let Some(resume) = resume_id {
            start.insert("resumeId".into(), resume);
        }
        let started = self.start_turn(&chat, &provider, &Value::Object(start));
        Ok(Sent {
            session_id: json!(session_id),
            duplicate: false,
            queued: false,
            started: Some(started),
        })
    }

    /// Starts the provider's turn; a failure ends it in the Chat as Node's `.catch` does.
    fn start_turn(&mut self, chat: &str, provider: &str, request: &Value) -> Value {
        let outcome = match self.providers.get_mut(provider) {
            Some(adapter) => adapter.start_turn(request),
            None => Err(format!(
                "No {provider} provider adapter is registered with the Rust owner."
            )),
        };
        match outcome {
            Ok(result) => result,
            Err(message) => {
                let _ = self.receive(chat, &json!({ "type": "turn-failed", "message": message }));
                Value::Null
            }
        }
    }

    /// queueSaved: the queued message is on disk before anyone hears of it.
    fn queue_saved(
        &mut self,
        project: &Path,
        chat: &str,
        session_id: i64,
        entry: &Value,
    ) -> Result<Sent> {
        let id = entry["id"].as_str().unwrap_or("").to_string();
        if let Err(error) = self.states.flush(Some(project)) {
            let _ = self.states.update(project, Some(&[]), true, |latest| {
                let session = agent_runs_session(latest, session_id)?;
                Some(agent_runs::with_session(
                    latest,
                    session_id,
                    without_queued(&session, &id),
                ))
            });
            self.broadcast(project);
            return Err(error);
        }
        self.broadcast(project);
        self.queue_waiters.insert(id);
        if !self.is_busy(chat) {
            let _ = self.after_turn(chat, &json!({ "type": "turn-completed" }));
        }
        Ok(Sent {
            session_id: json!(session_id),
            duplicate: false,
            queued: true,
            started: None,
        })
    }

    // ---- turns ---------------------------------------------------------------------------------------------

    /// Takes every provider's events, in order, and folds them.
    pub fn pump(&mut self) -> Vec<StoreError> {
        let mut events = Vec::new();
        for provider in self.providers.values_mut() {
            events.extend(provider.take_events());
        }
        events
            .into_iter()
            .filter_map(|(chat, event)| self.receive(&chat, &event).err())
            .collect()
    }

    /// receive: folds one agent event into its Chat's Project, then tells the clients. An event type this
    /// checkpoint doesn't fold is refused, not folded halfway.
    pub fn receive(&mut self, chat: &str, event: &Value) -> Result<()> {
        let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
        if agent_runs::UNSUPPORTED.contains(&kind) {
            return Err(gate(&format!("The agent event \"{kind}\"")));
        }
        let project_text = agent_runs::project_of_key(chat).to_string();
        let project = Self::project_path(&project_text);
        let session_id = session_of_key(chat)
            .ok_or_else(|| StoreError::Invalid(format!("{chat} isn't a Chat.")))?;
        let now = self.states.now();
        let mut runs = std::mem::take(&mut self.runs);
        let mut seq = self.seq;
        let mut event = event.clone();
        let mut added: Vec<MsgRef> = Vec::new();
        let open = self.open_chat.clone();
        let turn = self.turns.get(chat).cloned();
        let mut limit_gap = false;
        let folded = self
            .states
            .try_update(&project, Some(&[session_id]), true, |state| {
                let session_value_id = json!(session_id);
                let last = session_messages(state, &session_value_id)
                    .filter(|m| m.get("role").and_then(Value::as_str) == Some("user"))
                    .last();
                let quiet_compaction = last.is_some_and(|m| {
                    m.get("context")
                        .and_then(|c| c.get("kind"))
                        .and_then(Value::as_str)
                        == Some("compaction")
                        && jsjson::truthy(m.get("context").and_then(|c| c.get("quiet")))
                });
                if is_turn_end(&event) && quiet_compaction {
                    event["quiet"] = json!(true);
                }
                let (next, next_runs, changed) =
                    agent_runs::apply_agent_event(state, &runs, &project_text, chat, &event, now)
                        .map_err(|unsupported| gate(&unsupported.0))?;
                runs = next_runs;
                seq += 1;
                if !changed {
                    return Ok(None);
                }
                let visible = open.as_deref() == Some(chat);
                let archived = session_value(&next, &json!(session_id))
                    .is_some_and(|s| jsjson::truthy(s.get("archived")));
                let unread = is_turn_end(&event)
                    && !jsjson::truthy(event.get("quiet"))
                    && !visible
                    && !archived;
                let next = if unread {
                    agent_runs::patch_unread(&next, session_id)
                } else {
                    next
                };
                let recorded = if is_turn_end(&event) {
                    agent_runs::archive_finished_subagents(&next, session_id)
                } else {
                    next
                };
                if event.get("type").and_then(Value::as_str) == Some("turn-failed")
                    && event
                        .get("limit")
                        .and_then(|limit| limit.get("accountId"))
                        .is_some()
                    && turn.is_some()
                {
                    limit_gap = true;
                }
                let before: HashSet<String> =
                    state.message_list().iter().map(|m| m.key()).collect();
                added = recorded
                    .message_list()
                    .iter()
                    .filter(|m| {
                        !before.contains(&m.key())
                            && m.get("role").and_then(Value::as_str) == Some("assistant")
                    })
                    .cloned()
                    .collect();
                Ok(Some(recorded))
            });
        self.runs = runs;
        self.seq = seq;
        self.sync_busy();
        let (state, changed) = folded?;
        self.notices.push(Notice::Event {
            chat: chat.into(),
            event: event.clone(),
            seq: Some(self.seq),
            with_state: changed,
        });
        if limit_gap {
            self.notices.push(Notice::Gap {
                chat: chat.into(),
                what: "usage-limit continuation (limitTurn)".into(),
            });
        }
        if is_turn_end(&event) {
            let _ = self.after_turn(chat, &event);
        }
        for message in &added {
            if message
                .get("body")
                .and_then(Value::as_str)
                .is_some_and(|body| body.contains("!["))
            {
                self.notices.push(Notice::Gap {
                    chat: chat.into(),
                    what: "reply image capture".into(),
                });
            }
        }
        let _ = state;
        Ok(())
    }

    /// afterTurn: a completed turn starts the next queued message (Send now's pick first); Stop and failures hold
    /// the queue. Automatic compaction is off (Node's default) and can't be turned on here.
    fn after_turn(&mut self, chat: &str, event: &Value) -> Result<()> {
        let project = Self::project_path(agent_runs::project_of_key(chat));
        let session_id = session_of_key(chat).unwrap_or(-1);
        let state = self.states.get(&project)?;
        let session = session_value(&state, &json!(session_id));
        if self.is_busy(chat) {
            return Ok(());
        }
        let next = self.send_next.remove(chat);
        let queued: Vec<Value> = session
            .as_ref()
            .and_then(|s| s.get("queued"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if queued.is_empty() {
            return Ok(());
        }
        let start = |host: &mut ChatHost, id: &str| -> Result<()> {
            if let Err(error) = host.start_queued(chat, id) {
                host.hold_queue(chat)?;
                return Err(error);
            }
            Ok(())
        };
        if let Some(next) = next.filter(|next| {
            queued
                .iter()
                .any(|item| item.get("id").and_then(Value::as_str) == Some(next))
        }) {
            return start(self, &next);
        }
        if session
            .as_ref()
            .is_some_and(|s| jsjson::truthy(s.get("queueHeld")))
        {
            return Ok(());
        }
        if event.get("type").and_then(Value::as_str) == Some("turn-completed") {
            let first = queued[0]
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            return start(self, &first);
        }
        self.hold_queue(chat)
    }

    /// holdQueue.
    fn hold_queue(&mut self, chat: &str) -> Result<()> {
        let project = Self::project_path(agent_runs::project_of_key(chat));
        let session_id = session_of_key(chat).unwrap_or(-1);
        let (_, changed) = self.states.update(&project, Some(&[]), true, |latest| {
            let mut session = agent_runs_session(latest, session_id)?;
            let has = session
                .get("queued")
                .and_then(Value::as_array)
                .is_some_and(|q| !q.is_empty());
            if !has || jsjson::truthy(session.get("queueHeld")) {
                return None;
            }
            session.insert("queueHeld".into(), json!(true));
            Some(agent_runs::with_session(latest, session_id, session))
        })?;
        if changed {
            self.broadcast(&project);
        }
        Ok(())
    }

    /// startQueued: one queued message as the Chat's next turn, through send (which takes it out of the queue in the
    /// same save that adds it to the Chat). False when it is gone or the Chat is busy.
    fn start_queued(&mut self, chat: &str, id: &str) -> Result<bool> {
        if self.is_busy(chat) {
            return Ok(false);
        }
        let project_text = agent_runs::project_of_key(chat).to_string();
        let session_id = session_of_key(chat).unwrap_or(-1);
        let state = self.states.get(&Self::project_path(&project_text))?;
        let Some(entry) = session_value(&state, &json!(session_id))
            .and_then(|s| s.get("queued").and_then(Value::as_array).cloned())
            .and_then(|q| {
                q.into_iter()
                    .find(|e| e.get("id").and_then(Value::as_str) == Some(id))
            })
        else {
            return Ok(false);
        };
        let mut request = entry
            .get("turn")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        for key in ["provider", "model"] {
            if let Some(value) = entry.get(key) {
                request.insert(key.into(), value.clone());
            }
        }
        request.insert("projectPath".into(), json!(project_text));
        request.insert("sessionId".into(), json!(session_id));
        request.insert(
            "body".into(),
            entry.get("body").cloned().unwrap_or(Value::Null),
        );
        request.insert(
            "files".into(),
            entry.get("files").cloned().unwrap_or(json!([])),
        );
        if let Some(context) = entry.get("context").filter(|c| !c.is_null()) {
            request.insert("context".into(), context.clone());
        }
        for key in ["prompt", "clientMessageId", "operationId"] {
            if let Some(value) = entry
                .get(key)
                .filter(|value| key == "prompt" || jsjson::truthy(Some(value)))
            {
                request.insert(key.into(), value.clone());
            }
        }
        if entry
            .get("images")
            .and_then(Value::as_array)
            .is_some_and(|images| !images.is_empty())
        {
            return Err(gate("A queued message's images"));
        }
        request.insert("fromQueue".into(), json!(id));
        let sent = match self.send(&Value::Object(request)) {
            Ok(sent) => sent,
            Err(StoreError::Invalid(message)) if message == "The chat is busy." => {
                return Ok(false)
            }
            Err(error) => return Err(error),
        };
        if self.queue_waiters.remove(id) {
            self.notices.push(Notice::QueueStarted {
                id: id.into(),
                result: sent.started.unwrap_or(Value::Null),
            });
        } else {
            self.notices.push(Notice::QueueStartedWithoutSender {
                chat: chat.into(),
                id: id.into(),
            });
        }
        Ok(true)
    }

    /// chat:queue-send: Send now. A running turn that can't take it is stopped, and it starts once that turn ends.
    pub fn send_queued_now(&mut self, chat: &str, id: &str) -> Result<()> {
        let project = Self::project_path(agent_runs::project_of_key(chat));
        let session_id = session_of_key(chat).unwrap_or(-1);
        let state = self.states.get(&project)?;
        let session = session_value(&state, &json!(session_id));
        let has = session
            .as_ref()
            .and_then(|s| s.get("queued"))
            .and_then(Value::as_array)
            .is_some_and(|q| {
                q.iter()
                    .any(|e| e.get("id").and_then(Value::as_str) == Some(id))
            });
        if !has {
            return Err(StoreError::Invalid(
                "That queued message was already sent or removed.".into(),
            ));
        }
        let provider = session
            .as_ref()
            .and_then(|s| s.get("provider"))
            .and_then(Value::as_str);
        if self.runs.contains_key(chat) && provider_capabilities(provider).steer {
            return Err(gate(
                "Sending a queued message into a running turn that can steer",
            ));
        }
        if self.is_busy(chat) {
            self.send_next.insert(chat.into(), id.into());
            return self.interrupt(chat);
        }
        self.start_queued(chat, id).map(|_| ())
    }

    /// chat:queue-remove: takes a message out of the queue without sending it. False when it was already gone.
    pub fn remove_queued(&mut self, chat: &str, id: &str) -> Result<bool> {
        let project = Self::project_path(agent_runs::project_of_key(chat));
        let session_id = session_of_key(chat).unwrap_or(-1);
        let (_, changed) = self.states.update(&project, Some(&[]), true, |latest| {
            let session = agent_runs_session(latest, session_id)?;
            let present = session
                .get("queued")
                .and_then(Value::as_array)
                .is_some_and(|q| {
                    q.iter()
                        .any(|e| e.get("id").and_then(Value::as_str) == Some(id))
                });
            present
                .then(|| agent_runs::with_session(latest, session_id, without_queued(&session, id)))
        })?;
        if !changed {
            return Ok(false);
        }
        self.states.flush(Some(&project))?;
        self.broadcast(&project);
        if self.send_next.get(chat).map(String::as_str) == Some(id) {
            self.send_next.remove(chat);
        }
        if self.queue_waiters.remove(id) {
            self.notices.push(Notice::QueueStarted { id: id.into(), result: json!({ "turnId": null, "steered": false, "cancelled": true, "removed": true }) });
        } else {
            self.notices.push(Notice::QueueRemovedWithoutSender {
                chat: chat.into(),
                id: id.into(),
            });
        }
        Ok(true)
    }

    /// agent:interrupt: asks the running turn's provider to stop; its `turn-cancelled` ends the turn.
    pub fn interrupt(&mut self, chat: &str) -> Result<()> {
        let provider = self
            .turns
            .get(chat)
            .and_then(|turn| turn.get("provider"))
            .and_then(Value::as_str)
            .map(str::to_string);
        if let Some(adapter) = provider.and_then(|name| self.providers.get_mut(&name)) {
            adapter.interrupt(chat).map_err(StoreError::Invalid)?;
        }
        Ok(())
    }

    /// chat:send-status with nothing in flight (sends here finish before the next call).
    pub fn send_status(&mut self, project: &Path, client_message_id: &Value) -> Result<Value> {
        self.states.send_status(project, client_message_id)
    }

    /// Answering a permission or a question: not ported. The request stays shown in the run until the provider ends it.
    pub fn respond(&mut self, _chat: &str, _request_id: &str, _answer: &Value) -> Result<()> {
        Err(gate("Answering permission requests and questions"))
    }

    /// The command boundary for a wire server, with the daemon's arguments.
    pub fn call(&mut self, method: &str, args: &[Value]) -> Result<Value> {
        let arg = |index: usize| args.get(index).cloned().unwrap_or(Value::Null);
        match method {
            "chat:send" => {
                let request = arg(0);
                let project = request
                    .get("projectPath")
                    .and_then(Value::as_str)
                    .map(PathBuf::from);
                if !project
                    .as_deref()
                    .is_some_and(|project| self.states.has(project))
                {
                    return Err(StoreError::Invalid(
                        "Open the project before sending to its chats.".into(),
                    ));
                }
                let sent = self.send(&request)?;
                Ok(json!({ "sessionId": sent.session_id }))
            }
            "chat:send-status" => {
                let project = arg(0)
                    .as_str()
                    .map(PathBuf::from)
                    .filter(|path| self.states.has(path))
                    .ok_or(StoreError::BadSendStatus)?;
                self.send_status(&project, &arg(1))
            }
            "agent:interrupt" => {
                let chat = arg(0);
                let chat = chat
                    .as_str()
                    .ok_or_else(|| StoreError::Invalid("Choose a Chat.".into()))?;
                self.interrupt(chat).map(|_| Value::Null)
            }
            "chat:queue-send" | "chat:queue-remove" => {
                let chat = arg(0)
                    .as_str()
                    .map(str::to_string)
                    .ok_or_else(|| StoreError::Invalid("Choose a Chat.".into()))?;
                let id = arg(1).as_str().map(str::to_string).ok_or_else(|| {
                    StoreError::Invalid("That queued message isn't valid.".into())
                })?;
                if method == "chat:queue-send" {
                    self.send_queued_now(&chat, &id).map(|_| Value::Null)
                } else {
                    self.remove_queued(&chat, &id).map(Value::Bool)
                }
            }
            "permission:respond" | "question:answer" => {
                Err(gate("Answering permission requests and questions"))
            }
            other => self.states.call(other, args),
        }
    }
}

fn agent_runs_session(state: &ProjectState, session: i64) -> Option<Map<String, Value>> {
    session_value(state, &json!(session))
}

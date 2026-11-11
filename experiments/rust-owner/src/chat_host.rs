//! Sending messages and folding turns: the core of `packages/core/src/agents/chat-host.cjs` ChatHost, over
//! [`ProjectStates`] in an isolated copy, with agents behind a nonblocking, `Send` [`Provider`] trait.
//!
//! Ported as Node does it:
//!
//! - **Receipts and idempotency.** A send with a `clientMessageId` already saved (or waiting in a queue) answers
//!   `{ sessionId, duplicate }` and starts nothing, checked before the save and again inside it.
//! - **Save, flush, start.** The user message is saved and flushed to disk before the turn starts; a failed flush
//!   takes the message back out. The `message-sent` event opens the run; the provider is asked to start without the
//!   host waiting, and a start that fails ends the run with `turn-failed`.
//! - **Queue.** A message for a running turn whose provider can't steer, or sent with `delivery: "queue"`, waits in
//!   `session.queued` (saved before it is answered). A completed turn starts the oldest; a cancelled or failed one
//!   holds the queue. Send now (`chat:queue-send`) and Remove (`chat:queue-remove`).
//! - **Events.** `session-started`, `session-reset`, `turn-started`, `text-delta`, `context-usage`,
//!   permission/question requests and resolutions, `subagents-waiting`, tool steps (stamped and summarized as
//!   ChatHost.fold does), subagent updates (in memory until another change saves), background tasks, plans, native
//!   task lists, prompt suggestions, `answers-sent` and the three turn ends, which save the reply, mark the Chat unread
//!   unless it is the open one, archive finished subagents and move the queue on.
//! - **Answers.** `agent:respond-permission` and `agent:answer-question` through the provider, settled asynchronously.
//! - **Cancel.** `agent:interrupt` asks the provider to stop the running turn; its `turn-cancelled` ends it.
//!
//! Safer than Node where Node can lose a turn: every provider event names the [`TurnId`] whose session sent it, and
//! one of another turn, an older session or a closed Project is dropped; Projects must be named by their states key;
//! runs change only with a kept fold, a failed turn end is kept and retried, interrupts that never end are forced by
//! [`ChatHost::tick`], and failures of the host's own work come back as [`Notice::Failed`].
//!
//! Explicit gates (refused with [`gate`] errors, never approximated): steering a running turn (admission and save are
//! ported behind [`SteeringMode`], whose `Recorded` mode is for conformance and calls no provider), provider handoffs,
//! compaction, usage-limit continuations and account routing, Routines' messages, wake turns, `canStart`, images,
//! handover briefs, Send now that would steer, answers that need unported policy (secrets, bug reports, setup reviews,
//! images, Subchat cards), a turn the agent started by itself, quitting or closing a Project with turns running unless
//! forced, and the agent events listed in [`crate::agent_runs::UNSUPPORTED`] (compaction progress).
//!
//! Answers settle asynchronously ([`AnswerTicket`], [`ProviderEvent::AnswerSettled`]); see PROVIDER-CONTRACT.md.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};

use crate::agent_runs::{self, chat_key, is_turn_end, session_of_key, Runs};
use crate::chat_db::LookupField;
use crate::error::{Result, StoreError};
use crate::jsjson::{self, RawJson};
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

/// The host's name for one turn it asked a provider to start. Every event a provider sends about that turn carries
/// it, so a late event of an earlier turn (a `turn-cancelled` after Send now started the next one) is told apart.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct TurnId(pub u64);

/// Why a provider couldn't do what it was asked. `message` is shown in the Chat (as Node's `Agent error: …`) and must
/// never carry a credential.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderError {
    pub kind: ProviderErrorKind,
    pub message: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderErrorKind {
    /// The CLI or its session is missing (not installed, signed out, session gone).
    Unavailable,
    /// The provider refused the request as given.
    Refused,
    /// The provider took too long.
    Timeout,
    /// The provider's process ended.
    Exited,
    Other,
}

impl ProviderError {
    pub fn new(kind: ProviderErrorKind, message: impl Into<String>) -> Self {
        ProviderError {
            kind,
            message: message.into(),
        }
    }
}

/// What a provider tells the host, taken with [`Provider::take_events`] or handed to [`ChatHost::deliver`].
#[derive(Clone, Debug, PartialEq)]
pub enum ProviderEvent {
    /// The turn started: what SessionManager.startTurn resolves with (`{ turnId, steered }`).
    Started {
        chat: String,
        turn: TurnId,
        result: RawJson,
    },
    /// The turn couldn't start (startTurn rejected); the host ends it with `turn-failed`.
    StartFailed {
        chat: String,
        turn: TurnId,
        error: ProviderError,
    },
    /// One Node agent event (`{ type, … }`). `turn` is the host turn whose session sent it: the turn running for
    /// anything inside a turn (and its end); for Chat-level events between turns (`session-started`, `session-reset`,
    /// `context-usage`, …) the last turn that session ran, which stands for the session's generation. An event of
    /// another turn or an older session is dropped.
    Agent {
        chat: String,
        turn: TurnId,
        event: RawJson,
    },
    /// The provider's process for this Chat ended, after running `turn` (the last turn it ran). Fails that turn if
    /// it still runs; otherwise closes that session, so its late events are dropped. Never touches a newer turn.
    Exited {
        chat: String,
        turn: TurnId,
        error: ProviderError,
    },
    /// How an answer the host handed over (`respond_permission`, `answer_question`) settled. Exactly one per answer;
    /// one the host already settled (deadline, closed session) or never issued is dropped.
    AnswerSettled {
        chat: String,
        answer: AnswerId,
        outcome: AnswerOutcome,
    },
}

/// The host's name for one answer it handed to a provider.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct AnswerId(pub u64);

#[derive(Clone, Debug, PartialEq)]
pub enum AnswerOutcome {
    /// The adapter confirmed the session's transport accepted it (Codex: the reply frame was written; Claude: the
    /// callback resolved). Says nothing about what the agent then does.
    Accepted,
    /// Proven that nothing waited on that request (answered already, withdrawn, or another session).
    NotWaiting,
    /// Proven not delivered: it never reached the session (refused before writing, dropped from the queue unwritten).
    Failed(ProviderError),
    /// It may have reached the session (written, then the pipe broke or the process died before a confirmation).
    /// The answers stay shown, and the same request can't be answered again in that session generation until a later
    /// definitive settlement or the session closes.
    Uncertain(ProviderError),
}

/// What an answer came to, as told in [`Notice::AnswerSettled`] (and [`Notice::AnswerResolved`] later).
#[derive(Clone, Debug, PartialEq)]
pub enum AnswerResult {
    /// Node's `true`: the adapter confirmed the session's transport accepted it (Codex: the reply frame was written;
    /// Claude: the callback resolved). Not that a tool ran.
    Accepted,
    /// Node's `false`: nothing waited; the answers message was taken back.
    NotWaiting,
    /// Proven not delivered: the command rejects with the message; the answers message was taken back.
    Failed(String),
    /// Delivery unknown: the command rejects with code `ANSWER_DELIVERY_UNKNOWN`; the answers message stays.
    Uncertain(String),
}

/// The error code a command rejects with for [`AnswerResult::Uncertain`] and for a retry it blocks
/// ([`StoreError::code`] of `AnswerDeliveryUnknown`).
pub const ANSWER_DELIVERY_UNKNOWN: &str = "ANSWER_DELIVERY_UNKNOWN";

/// What answering returned at once: settled already (`false` when no session could take it), or waiting for its
/// [`Notice::AnswerSettled`]. A wire server keeps the client's reply until then (Node's command awaits the same).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AnswerTicket {
    Settled(bool),
    Pending(AnswerId),
}

/// An answer handed over and not settled yet.
#[derive(Clone, Debug)]
struct PendingAnswer {
    chat: String,
    turn: TurnId,
    request: String,
    /// The answers message to take back unless the session takes them.
    message: Option<f64>,
    due: i64,
}

/// An agent provider adapter: SessionManager for one provider. Every method returns at once (an adapter does its work on
/// its own tasks and reports back through events); none may block the host. `Send`, so the host can live behind a
/// shared lock or move between threads.
///
/// - `start_turn(turn, request)`: begin a turn for `request.chatId` (`{ provider, model, permissionMode, effort,
///   ultracode, fastMode, replies, tldrEnabled, prompt, chatId, cwd, images, resumeId }`, undefined fields left out).
///   `Err` only for a refusal known at once; otherwise `Started` or `StartFailed` follows, then the turn's events.
/// - `interrupt(chat, turn)`: ask that turn to stop; its `turn-cancelled` follows.
/// - `respond_permission` / `answer_question`: hand the user's answer to the session of `turn` (the Chat's latest
///   turn), named `answer` by the host. Enqueue only: `Err` for a refusal known at once (that session is gone), and
///   otherwise exactly one `AnswerSettled { answer }` follows: `Accepted` once the session took it, `NotWaiting` when
///   nothing waited on that request (Node's `false`), `Failed` when handing it over failed after it was queued.
///   Decision is one of `allow`, `allow-for-chat`, `deny`; answers are null or question id -> strings, validated.
/// - `close_chat(chat, turn)`: end the Chat's session of that generation (the one that ran `turn`), and only that one:
///   a newer session started since (Send now) stays. `shutdown()`: end every session.
pub trait Provider: Send {
    fn name(&self) -> &str;
    fn start_turn(
        &mut self,
        turn: TurnId,
        request: &RawJson,
    ) -> std::result::Result<(), ProviderError>;
    fn interrupt(&mut self, chat: &str, turn: TurnId) -> std::result::Result<(), ProviderError>;
    fn respond_permission(
        &mut self,
        chat: &str,
        turn: TurnId,
        answer: AnswerId,
        request_id: &str,
        decision: &str,
    ) -> std::result::Result<(), ProviderError>;
    fn answer_question(
        &mut self,
        chat: &str,
        turn: TurnId,
        answer: AnswerId,
        request_id: &str,
        answers: &RawJson,
    ) -> std::result::Result<(), ProviderError>;
    fn close_chat(&mut self, chat: &str, turn: TurnId) -> std::result::Result<(), ProviderError>;
    fn shutdown(&mut self);
    fn take_events(&mut self) -> Vec<ProviderEvent>;
}

/// A refused feature: what isn't ported, said as such.
pub fn gate(what: &str) -> StoreError {
    StoreError::Invalid(format!("{what} isn't supported by the Rust owner yet."))
}

/// A scripted provider for tests and conformance: records what it was asked, answers what it is told. Starts are
/// answered with events, as a real adapter's would be.
#[derive(Default)]
pub struct MockState {
    pub turns: Vec<Value>,
    pub interrupts: Vec<String>,
    pub events: Vec<ProviderEvent>,
    pub fail_next_start: Option<String>,
    pub fail_next_interrupt: Option<String>,
    pub next_turn: u64,
    /// The last turn started per Chat: what [`MockProvider::emit`] tags events with.
    pub current: HashMap<String, TurnId>,
    pub closed: Vec<String>,
    pub shut_down: bool,
    pub shutdowns: usize,
    /// Answers handed over (`{ chat, requestId, decision }` or `{ chat, requestId, answers }`), in order.
    pub answers: Vec<Value>,
    /// Answers settle `Accepted` unless this is set (then `NotWaiting`).
    pub refuse_answers: bool,
    /// Answers are queued but not settled (for deadline tests).
    pub hold_answers: bool,
    /// The next answer handed over fails after queueing, proven undelivered.
    pub fail_next_answer: Option<String>,
    /// The next answer handed over ends with its delivery unknown.
    pub uncertain_next_answer: Option<String>,
    /// The next start is refused at once (`Err` from `start_turn`).
    pub refuse_next_start: Option<String>,
}

impl MockState {
    fn settle(&mut self, chat: &str, answer: AnswerId) {
        if self.hold_answers {
            return;
        }
        if let Some(message) = self.uncertain_next_answer.take() {
            let outcome =
                AnswerOutcome::Uncertain(ProviderError::new(ProviderErrorKind::Exited, message));
            self.events.push(ProviderEvent::AnswerSettled {
                chat: chat.into(),
                answer,
                outcome,
            });
            return;
        }
        let outcome = match self.fail_next_answer.take() {
            Some(message) => {
                AnswerOutcome::Failed(ProviderError::new(ProviderErrorKind::Exited, message))
            }
            None if self.refuse_answers => AnswerOutcome::NotWaiting,
            None => AnswerOutcome::Accepted,
        };
        self.events.push(ProviderEvent::AnswerSettled {
            chat: chat.into(),
            answer,
            outcome,
        });
    }
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

    /// Another provider name over the same script and records (turn ids keep counting across both).
    pub fn sharing(name: &str, other: &MockProvider) -> Self {
        MockProvider {
            name: name.into(),
            state: other.state.clone(),
        }
    }

    /// An agent event of the Chat's latest turn (`TurnId(0)`, which no host turn has, before any).
    pub fn emit(&self, chat: &str, event: Value) {
        let mut state = self.state.lock().unwrap();
        let turn = state.current.get(chat).copied().unwrap_or(TurnId(0));
        state.events.push(ProviderEvent::Agent {
            chat: chat.into(),
            turn,
            event: RawJson(event),
        });
    }

    /// An agent event tagged with a given turn, such as a late one.
    pub fn emit_for(&self, chat: &str, turn: TurnId, event: Value) {
        self.state
            .lock()
            .unwrap()
            .events
            .push(ProviderEvent::Agent {
                chat: chat.into(),
                turn,
                event: RawJson(event),
            });
    }

    /// The last turn started for a Chat.
    pub fn current(&self, chat: &str) -> Option<TurnId> {
        self.state.lock().unwrap().current.get(chat).copied()
    }

    pub fn push(&self, event: ProviderEvent) {
        self.state.lock().unwrap().events.push(event);
    }
}

impl Provider for MockProvider {
    fn name(&self) -> &str {
        &self.name
    }
    fn start_turn(
        &mut self,
        turn: TurnId,
        request: &RawJson,
    ) -> std::result::Result<(), ProviderError> {
        let request = &request.0;
        let mut state = self.state.lock().unwrap();
        state.turns.push(request.clone());
        if let Some(message) = state.refuse_next_start.take() {
            return Err(ProviderError::new(ProviderErrorKind::Refused, message));
        }
        let chat = request
            .get("chatId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        state.current.insert(chat.clone(), turn);
        let event = match state.fail_next_start.take() {
            Some(message) => ProviderEvent::StartFailed {
                chat,
                turn,
                error: ProviderError::new(ProviderErrorKind::Unavailable, message),
            },
            None => {
                state.next_turn += 1;
                let result =
                    json!({ "turnId": format!("turn-{}", state.next_turn), "steered": false });
                ProviderEvent::Started {
                    chat,
                    turn,
                    result: RawJson(result),
                }
            }
        };
        state.events.push(event);
        Ok(())
    }
    fn interrupt(&mut self, chat: &str, _turn: TurnId) -> std::result::Result<(), ProviderError> {
        let mut state = self.state.lock().unwrap();
        if let Some(message) = state.fail_next_interrupt.take() {
            return Err(ProviderError::new(ProviderErrorKind::Other, message));
        }
        state.interrupts.push(chat.into());
        Ok(())
    }
    fn respond_permission(
        &mut self,
        chat: &str,
        _turn: TurnId,
        answer: AnswerId,
        request_id: &str,
        decision: &str,
    ) -> std::result::Result<(), ProviderError> {
        let mut state = self.state.lock().unwrap();
        state
            .answers
            .push(json!({ "chat": chat, "requestId": request_id, "decision": decision }));
        state.settle(chat, answer);
        Ok(())
    }
    fn answer_question(
        &mut self,
        chat: &str,
        _turn: TurnId,
        answer: AnswerId,
        request_id: &str,
        answers: &RawJson,
    ) -> std::result::Result<(), ProviderError> {
        let mut state = self.state.lock().unwrap();
        state
            .answers
            .push(json!({ "chat": chat, "requestId": request_id, "answers": answers.0 }));
        state.settle(chat, answer);
        Ok(())
    }
    fn close_chat(&mut self, chat: &str, _turn: TurnId) -> std::result::Result<(), ProviderError> {
        self.state.lock().unwrap().closed.push(chat.into());
        Ok(())
    }
    fn shutdown(&mut self) {
        let mut state = self.state.lock().unwrap();
        state.shut_down = true;
        state.shutdowns += 1;
    }
    fn take_events(&mut self) -> Vec<ProviderEvent> {
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
    /// An answer settled: `Ok(true)` taken, `Ok(false)` nothing waited (its message taken back), `Err` it failed
    /// (taken back too). What Node's `agent:respond-permission` / `agent:answer-question` resolve or reject with.
    AnswerSettled {
        chat: String,
        answer: AnswerId,
        result: AnswerResult,
    },
    /// An answer released from an ended turn dropped from the bounded history (the oldest first): a late settlement of
    /// it is no longer taken; its answers message stays as shown. Its delivery stays unknown.
    AnswerForgotten {
        chat: String,
        answer: AnswerId,
    },
    /// A Project's lock was left on disk when the Project was dropped: its root no longer held (moved, replaced, a link
    /// on or above it), so nothing was removed there. An operator removes it. Paths are jsjson-encoded; never a token.
    LockStranded {
        lock: String,
        why: String,
    },
    /// A later definitive settlement of an answer told `Uncertain` before: `Accepted` (it stays), or `NotWaiting` /
    /// `Failed` (its answers message was taken back). The command was answered already; this is for the Chat.
    AnswerResolved {
        chat: String,
        answer: AnswerId,
        result: AnswerResult,
    },
    /// A steering message was admitted and saved: what Node would hand SessionManager.startTurn for the running
    /// `turn` ([`SteeringMode::Recorded`] only; no provider is called).
    SteerRequested {
        chat: String,
        turn: TurnId,
        request: Value,
    },
    /// A turn's start resolved: what Node's `sent.started` resolves with.
    Started {
        chat: String,
        turn: TurnId,
        result: Value,
    },
    /// Work the host did on its own (a queued start, a turn's end, a failed start's `turn-failed`) failed. Node logs
    /// these; here they are told, never dropped. `error` never carries a token.
    Failed {
        chat: String,
        what: String,
        error: String,
    },
}

/// What starting one queued message came to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum QueuedStart {
    Started,
    NotStarted,
    /// Its `clientMessageId` was already in the Chat: it left the queue without a turn.
    AlreadySaved,
}

/// Whether a message for a running turn whose provider can steer is refused or staged. No provider is ever asked to
/// steer yet: the Provider call is a proposal (STEERING-HANDOFF.md) awaiting agreement.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum SteeringMode {
    /// Refused with the "Steering a running turn" gate (production).
    #[default]
    Gated,
    /// Conformance only: admitted and saved as Node does (the running turn's provider and model, the reply so far
    /// split above the message, the run marked steered), then told as `Notice::SteerRequested` with the request Node
    /// hands SessionManager.startTurn. Nothing reaches a provider and nothing settles it.
    Recorded,
}

/// What a send answered.
#[derive(Clone, Debug, PartialEq)]
pub struct Sent {
    pub session_id: Value,
    pub duplicate: bool,
    pub queued: bool,
    /// The message steers the running turn `turn` (only with [`SteeringMode::Recorded`]).
    pub steering: bool,
    /// The turn the provider was asked to start; None when nothing started (a duplicate, a queued message that
    /// waits, or a provider that refused at once, whose `turn-failed` is already folded). Its start resolves later
    /// as [`Notice::Started`], or fails as `turn-failed`.
    pub turn: Option<TurnId>,
}

const FORMER_WORKTREE: &str = "This Run's Worktree was removed because the Run left nothing in it. Start a new Chat to continue.";
const PERMISSION_MODES: [&str; 3] = ["ask", "auto", "full"];
/// Longest answers summary (UTF-16 code units) shown as the user's message: 20 questions of 10,000 plus labels.
pub const MAX_ANSWER_SUMMARY: usize = 210_000;
/// Answers released from ended turns kept for a late definitive settlement (no slot); past this the oldest go.
pub const MAX_HISTORICAL_ANSWERS: usize = 1_024;
/// Default slots for answers on their way plus answers with an unknown delivery (`ChatHost::answer_capacity`).
pub const ANSWER_CAPACITY: usize = 256;
/// The error code a command rejects with when every answer slot is taken ([`StoreError::code`] of `AnswersAtCapacity`).
pub const ANSWERS_AT_CAPACITY: &str = "ANSWERS_AT_CAPACITY";
/// How long a handed-over answer may wait for its settlement before the host fails it.
pub const ANSWER_GRACE_MS: i64 = 30_000;
/// How long an interrupted turn gets to end by itself before the host forces it.
pub const INTERRUPT_GRACE_MS: i64 = 15_000;
/// Notices kept for a client that doesn't take them; past this the oldest are dropped (and counted).
pub const MAX_NOTICES: usize = 10_000;
/// Rounds of events one pump handles before leaving the rest for the next.
pub const MAX_PUMP_ROUNDS: usize = 1_000;
/// permissions.cjs USER_DECISIONS: the only decisions a user's answer may carry.
const USER_DECISIONS: [&str; 3] = ["allow", "allow-for-chat", "deny"];

/// questions.cjs validAnswers: null, or at most 10 question ids each mapped to at most 20 strings of 10,000 code units.
fn valid_answers(answers: Option<&Value>) -> bool {
    match answers {
        Some(Value::Null) => true,
        Some(Value::Object(map)) => {
            map.len() <= 10
                && map.values().all(|values| match values {
                    Value::Array(values) => {
                        values.len() <= 20
                            && values.iter().all(|value| {
                                value
                                    .as_str()
                                    .is_some_and(|text| jsjson::utf16_len(text) <= 10_000)
                            })
                    }
                    _ => false,
                })
        }
        _ => false,
    }
}

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
    /// The turn running per Chat and its provider: what interrupts and stale-event checks go by.
    active: HashMap<String, (TurnId, String)>,
    next_turn: u64,
    /// Steering: gated unless a conformance run records it (see [`SteeringMode`]).
    pub steering: SteeringMode,
    /// The providers were shut down by `shutdown`: a later call only retries closing the states.
    providers_shut_down: bool,
    /// The quit's final save and close succeeded.
    closed: bool,
    /// Completed turns whose queue waited on a quit or close, replayed if the quit is refused.
    deferred: Vec<(String, Value)>,
    /// Set from the start of `shutdown`: no queued message starts and no send is taken.
    quitting: bool,
    /// Projects a `forget` is closing: no queued message starts in them and no send to them is taken.
    closing: HashSet<PathBuf>,
    /// Turn ends whose fold failed (the save or load behind it): kept and tried again, so the run doesn't stay open.
    stuck: BTreeMap<String, (TurnId, Value)>,
    /// Each Chat's latest turn: its session's generation. Chat-level events must name it.
    latest: HashMap<String, TurnId>,
    /// Interrupted turns and when they are forced to end if they haven't (see `tick`).
    deadlines: HashMap<String, (TurnId, i64)>,
    /// How long an interrupted turn may take to end before `tick` forces it (ms of the states clock).
    pub interrupt_grace_ms: i64,
    /// Events a bounded pump left for the next one.
    held_events: Vec<ProviderEvent>,
    /// Notices dropped because nobody took them (the oldest go first past `MAX_NOTICES`).
    dropped_notices: u64,
    next_answer: u64,
    pending_answers: BTreeMap<AnswerId, PendingAnswer>,
    /// Answers told `Uncertain`, kept until a definitive settlement or their session generation closes; each blocks a
    /// retry of its request in that generation and holds a slot of `answer_capacity`.
    uncertain_answers: BTreeMap<AnswerId, PendingAnswer>,
    /// Answers whose turn ended or session closed while their delivery was unknown: no slot, no retry block, kept
    /// (bounded by `answer_history`, oldest dropped and told as `Notice::AnswerForgotten`) only so a late definitive
    /// settlement can resolve them.
    historical_answers: BTreeMap<AnswerId, PendingAnswer>,
    /// How many released answers are kept for a late settlement (default `MAX_HISTORICAL_ANSWERS`), across Chats.
    pub answer_history: usize,
    /// Slots for answers on their way plus answers with an unknown delivery (default `ANSWER_CAPACITY`); at capacity a
    /// new answer is refused before anything is shown or handed over.
    pub answer_capacity: usize,
    /// How long a handed-over answer may wait for its settlement before `tick` settles it `Uncertain` (ms of the states
    /// clock).
    pub answer_grace_ms: i64,
    /// Queued messages whose start is still in flight, by turn: told as `QueueStarted` once it resolves.
    queue_turns: HashMap<TurnId, (String, String)>,
    seq: u64,
    starting: HashMap<String, String>,
    send_next: HashMap<String, String>,
    queue_waiters: HashSet<String>,
    turns: HashMap<String, Value>,
    /// The Chat shown in a focused window (Node's openChat with isFocused): a turn ending there isn't unread.
    pub open_chat: Option<String>,
    notices: std::collections::VecDeque<Notice>,
    ids: Box<dyn FnMut() -> String + Send>,
    /// Chats the states were told are busy (Node's ProjectStates asks ChatHost.isBusy before unloading a Chat).
    busy: HashSet<String>,
}

impl ChatHost {
    pub fn new(states: ProjectStates) -> Self {
        ChatHost {
            states,
            providers: BTreeMap::new(),
            runs: Runs::new(),
            active: HashMap::new(),
            next_turn: 0,
            steering: SteeringMode::Gated,
            deferred: Vec::new(),
            providers_shut_down: false,
            closed: false,
            quitting: false,
            closing: HashSet::new(),
            stuck: BTreeMap::new(),
            latest: HashMap::new(),
            deadlines: HashMap::new(),
            interrupt_grace_ms: INTERRUPT_GRACE_MS,
            held_events: Vec::new(),
            dropped_notices: 0,
            next_answer: 0,
            pending_answers: BTreeMap::new(),
            uncertain_answers: BTreeMap::new(),
            historical_answers: BTreeMap::new(),
            answer_history: MAX_HISTORICAL_ANSWERS,
            answer_capacity: ANSWER_CAPACITY,
            answer_grace_ms: ANSWER_GRACE_MS,
            queue_turns: HashMap::new(),
            seq: 0,
            starting: HashMap::new(),
            send_next: HashMap::new(),
            queue_waiters: HashSet::new(),
            turns: HashMap::new(),
            open_chat: None,
            notices: std::collections::VecDeque::new(),
            ids: Box::new(crate::ownership::random_uuid),
            busy: HashSet::new(),
        }
    }

    /// Queued messages' ids (crypto.randomUUID in Node); tests make them deterministic.
    pub fn set_ids(&mut self, ids: impl FnMut() -> String + Send + 'static) {
        self.ids = Box::new(ids);
    }

    pub fn register(&mut self, provider: Box<dyn Provider>) {
        self.providers.insert(provider.name().to_string(), provider);
    }

    pub fn runs(&self) -> &Runs {
        &self.runs
    }

    /// What the clients would hear since the last take. Notices past `MAX_NOTICES` drop the oldest, and the take
    /// ends with a `Failed` notice that counts them.
    pub fn take_notices(&mut self) -> Vec<Notice> {
        for stranded in self.states.take_stranded() {
            self.notice(Notice::LockStranded {
                lock: jsjson::js_string(&stranded.lock.to_string_lossy()),
                why: jsjson::js_string(&stranded.why),
            });
        }
        let mut notices: Vec<Notice> = std::mem::take(&mut self.notices).into();
        if self.dropped_notices > 0 {
            notices.push(Notice::Failed {
                chat: String::new(),
                what: "telling clients (nobody took the oldest notices)".into(),
                error: format!("{} notices were dropped", self.dropped_notices),
            });
            self.dropped_notices = 0;
        }
        notices
    }

    fn notice(&mut self, notice: Notice) {
        if self.notices.len() >= MAX_NOTICES {
            self.notices.pop_front();
            self.dropped_notices += 1;
        }
        self.notices.push_back(notice);
    }

    /// Whether a Chat's turn runs or is about to start.
    pub fn is_busy(&self, chat: &str) -> bool {
        self.runs.contains_key(chat) || self.starting.contains_key(chat)
    }

    fn project_path(project: &str) -> PathBuf {
        PathBuf::from(project)
    }

    /// The Project of a path a request names, refused unless it is spelled as the states key it: Chat keys, runs and
    /// busy marks are keyed by the text, so `/p/` or `/x/../p` beside `/p` would make one Chat two.
    fn canonical_project(&self, text: &str) -> Result<PathBuf> {
        let key = self.states.canonical(Path::new(text))?;
        if key.to_str() != Some(text) {
            return Err(StoreError::Invalid(format!(
                "{text} isn't how this Project is named; use {}.",
                key.display()
            )));
        }
        Ok(key)
    }

    /// A Chat key's Project and session, refused unless the Project part is canonical (see `canonical_project`).
    fn canonical_chat(&self, chat: &str) -> Result<(PathBuf, i64)> {
        let session = session_of_key(chat)
            .ok_or_else(|| StoreError::Invalid(format!("{chat} isn't a Chat.")))?;
        Ok((
            self.canonical_project(agent_runs::project_of_key(chat))?,
            session,
        ))
    }

    /// Whether a quit has begun and wasn't refused: sends and starts are refused. Stays true after a failed close (see
    /// `shutdown`).
    pub fn is_quitting(&self) -> bool {
        self.quitting
    }

    /// Whether a quit got past the providers but its final save and close failed: the quit isn't finished, and
    /// `shutdown` must be called again (it retries only the save and close). Never drop a host while this is true.
    pub fn close_pending(&self) -> bool {
        self.providers_shut_down && !self.closed
    }

    /// The turn running in a Chat, if any.
    pub fn active_turn(&self, chat: &str) -> Option<TurnId> {
        self.active.get(chat).map(|(turn, _)| *turn)
    }

    /// Keeps the states' busy Chats (never unloaded by a sweep) equal to Node's isBusy: a run, or a turn starting.
    fn sync_busy(&mut self) {
        let now: HashSet<String> = self
            .runs
            .keys()
            .chain(self.starting.keys())
            .chain(self.stuck.keys())
            .cloned()
            .collect();
        for chat in now.symmetric_difference(&self.busy) {
            if let Some(session) = session_of_key(chat) {
                let project = Self::project_path(agent_runs::project_of_key(chat));
                let _ = self.states.set_busy(&project, session, now.contains(chat));
            }
        }
        self.busy = now;
    }

    fn broadcast(&mut self, project: &Path) {
        self.notice(Notice::Broadcast {
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
        let project = self.canonical_project(&project_text)?;
        if self.quitting {
            return Err(StoreError::Invalid(
                "Milagre is quitting; the message wasn't sent.".into(),
            ));
        }
        if self.closing.contains(&project) {
            return Err(StoreError::Invalid(
                "This Project is closing; the message wasn't sent.".into(),
            ));
        }
        // A Project already open here must still be ours before anything is staged in memory.
        if self.states.has(&project) {
            self.states.assert_owned(&project)?;
        }
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
                    steering: false,
                    turn: None,
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
        let steering_mode = self.steering;
        let running_turns: HashSet<String> = self.active.keys().cloned().collect();
        let mut steering = false;
        let mut run_provider = provider.clone();
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
                    // Admitted only into the turn running here (its generation), never while gated.
                    if steering_mode == SteeringMode::Gated || !running_turns.contains(&chat) {
                        return Err(gate(
                            "Steering a running turn (send with delivery \"queue\" to queue it)",
                        ));
                    }
                    steering = true;
                    // A message that steers keeps the running turn's provider and model, whatever was asked for.
                    run_provider = session
                        .get("provider")
                        .and_then(Value::as_str)
                        .unwrap_or(&provider)
                        .to_string();
                    let run_model_now = runs
                        .get(&chat)
                        .and_then(|run| run.get("model"))
                        .filter(|model| jsjson::truthy(Some(model)))
                        .cloned();
                    let last_model = agent_runs::last_user_model(&with_session, session_id);
                    run_model = run_model_now
                        .or_else(|| jsjson::truthy(Some(&last_model)).then_some(last_model))
                        .or_else(|| model.clone())
                        .unwrap_or(Value::Null);
                }
                // handoffKind: the provider of the chat's last turn, and whether a restore is due. A steer never
                // hands off.
                let messages: Vec<&MsgRef> =
                    session_messages(&with_session, &session_id_value).collect();
                if !messages.is_empty() && !steering {
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
                if !steering {
                    run_model = model.clone().unwrap_or(Value::Null);
                }
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
                next_session.insert("provider".into(), json!(run_provider));
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
            if staged.is_some() && saving.is_ok() && !steering {
                self.starting.insert(chat.clone(), provider.clone());
            }
        }
        saving?;
        if let Some(session) = duplicate {
            return Ok(Sent {
                session_id: session,
                duplicate: true,
                queued: false,
                steering: false,
                turn: None,
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
        let mut runs = self.runs.clone();
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
        // By id, as Node does: a save or a lazy load may hand back another copy of the message than `pending`.
        let pending_id = pending.get("id").cloned().unwrap_or(Value::Null);
        let same_id = |m: &MsgRef| {
            m.get("id")
                .is_some_and(|id| jsjson::strict_equals(id, &pending_id))
        };
        let folded = self
            .states
            .try_update(&project, Some(&[session_id]), true, |latest| {
                let saved = latest.message_list().iter().find(|m| same_id(m)).cloned();
                let without: Vec<MsgRef> = latest
                    .message_list()
                    .iter()
                    .filter(|m| !same_id(m))
                    .cloned()
                    .collect();
                let base = latest.with_messages(without);
                let (sent, next_runs, _) =
                    agent_runs::apply_agent_event(&base, &runs, &project_key, &chat, &event, now)
                        .map_err(|unsupported| gate(&unsupported.0))?;
                runs = next_runs;
                seq += 1;
                let mut list = sent.message_list().to_vec();
                list.extend(saved);
                Ok(Some(sent.with_messages(list)))
            });
        self.starting.remove(&chat);
        // The run opens only if its fold was kept: a failed save or load leaves the host as it was.
        if folded.is_ok() {
            self.runs = runs;
            self.seq = seq;
        }
        self.sync_busy();
        let (state, _) = folded?;
        self.notice(Notice::Event {
            chat: chat.clone(),
            event: event.clone(),
            seq: Some(self.seq),
            with_state: true,
        });
        if session_value(&state, &json!(session_id))
            .is_some_and(|s| jsjson::truthy(s.get("titlePending")))
        {
            self.notice(Notice::NameChat {
                project: project.clone(),
                session: session_id,
            });
        }
        let mut turn = Map::new();
        turn.insert("provider".into(), json!(run_provider));
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
        if steering {
            // Recorded only: what Node hands SessionManager.startTurn. The running turn goes on; nothing settles this.
            let running = self
                .active_turn(&chat)
                .expect("admitted into the running turn");
            self.notice(Notice::SteerRequested {
                chat: chat.clone(),
                turn: running,
                request: Value::Object(start),
            });
            return Ok(Sent {
                session_id: json!(session_id),
                duplicate: false,
                queued: false,
                steering: true,
                turn: Some(running),
            });
        }
        let turn = self.start_turn(&chat, &provider, &Value::Object(start));
        Ok(Sent {
            session_id: json!(session_id),
            duplicate: false,
            queued: false,
            steering: false,
            turn,
        })
    }

    /// Asks the provider to start the turn, without waiting for it. A refusal known at once ends it in the Chat as
    /// Node's `.catch` does (and so does a later `StartFailed`); if even that fold fails, the end is kept and retried.
    fn start_turn(&mut self, chat: &str, provider: &str, request: &Value) -> Option<TurnId> {
        self.next_turn += 1;
        let turn = TurnId(self.next_turn);
        self.active
            .insert(chat.to_string(), (turn, provider.to_string()));
        self.latest.insert(chat.to_string(), turn);
        let outcome = match self.providers.get_mut(provider) {
            Some(adapter) => match outbound_request(request) {
                Ok(request) => adapter.start_turn(turn, &request),
                Err(why) => Err(ProviderError::new(ProviderErrorKind::Refused, why)),
            },
            None => Err(ProviderError::new(
                ProviderErrorKind::Unavailable,
                format!("No {provider} provider adapter is registered with the Rust owner."),
            )),
        };
        match outcome {
            Ok(()) => Some(turn),
            Err(error) => {
                self.fail_turn(
                    chat,
                    turn,
                    &jsjson::js_string(&error.message),
                    "a turn that couldn't start",
                );
                None
            }
        }
    }

    /// Ends a turn with `turn-failed` (a start that failed, a provider that exited); a fold that fails is kept.
    fn fail_turn(&mut self, chat: &str, turn: TurnId, message: &str, what: &str) {
        let event = json!({ "type": "turn-failed", "message": message });
        if let Err(error) = self.receive(chat, turn, &event) {
            self.notice(Notice::Failed {
                chat: chat.into(),
                what: format!("ending {what}"),
                error: error.to_string(),
            });
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
            if let Err(error) = self.after_turn(chat, &json!({ "type": "turn-completed" })) {
                self.notice(Notice::Failed {
                    chat: chat.into(),
                    what: "starting the queued message".into(),
                    error: error.to_string(),
                });
            }
        }
        Ok(Sent {
            session_id: json!(session_id),
            duplicate: false,
            queued: true,
            steering: false,
            turn: None,
        })
    }

    // ---- turns ---------------------------------------------------------------------------------------------

    /// Tries kept turn ends again, then takes every provider's events, in order, and handles them, until none are left
    /// (a turn end can start a queued message, whose start answers with more events). Returns what was refused or
    /// failed; each is also left as it was (a refused event folds nothing).
    pub fn pump(&mut self) -> Vec<StoreError> {
        let mut errors = self.retry_stuck();
        for round in 0.. {
            // What a bounded pump left comes first, whether or not a provider sent more since.
            let mut events: Vec<ProviderEvent> = std::mem::take(&mut self.held_events);
            for provider in self.providers.values_mut() {
                events.extend(provider.take_events());
            }
            if events.is_empty() {
                break;
            }
            if round == MAX_PUMP_ROUNDS {
                // Events keep coming (an adapter looping on its own output): stop here, keep them for the next pump.
                self.held_events.extend(events);
                errors.push(StoreError::Invalid(format!(
                    "Providers kept sending events for {MAX_PUMP_ROUNDS} rounds; the rest wait for the next pump."
                )));
                break;
            }
            for event in events {
                if let Err(error) = self.deliver(event) {
                    errors.push(error);
                }
            }
        }
        errors
    }

    /// The runtime's tick, from the one task that owns the host: the clock moves (debounced saves, sweeps), interrupts
    /// past their grace are forced, kept turn ends are tried again, and providers' events are handled. Events are
    /// handled before anything is forced, so an end that came within the grace counts.
    pub fn tick(&mut self, now: i64) -> Vec<StoreError> {
        if now > self.states.now() {
            self.states.advance(now);
        }
        let mut errors = self.pump();
        let overdue: Vec<(String, TurnId)> = self
            .deadlines
            .iter()
            .filter(|(_, (_, at))| *at <= now)
            .map(|(chat, (turn, _))| (chat.clone(), *turn))
            .collect();
        for (chat, turn) in overdue {
            self.deadlines.remove(&chat);
            if self.active_turn(&chat) == Some(turn) {
                self.force_end(
                    &chat,
                    turn,
                    "The agent didn't stop in time, so Milagre ended its turn.",
                );
            }
        }
        errors.extend(self.pump());
        let late: Vec<(AnswerId, String)> = self
            .pending_answers
            .iter()
            .filter(|(_, pending)| pending.due <= now)
            .map(|(answer, pending)| (*answer, pending.chat.clone()))
            .collect();
        for (answer, chat) in late {
            // A deadline proves nothing about delivery: the answer stays, its delivery unknown.
            let error = ProviderError::new(
                ProviderErrorKind::Timeout,
                "The agent hasn't confirmed the answer.",
            );
            let _ = self.settle_answer(&chat, answer, AnswerOutcome::Uncertain(error));
        }
        errors
    }

    /// Folds the turn ends kept after a failed fold again; one that fails again stays kept while its turn runs.
    pub fn retry_stuck(&mut self) -> Vec<StoreError> {
        let stuck: Vec<(String, (TurnId, Value))> =
            std::mem::take(&mut self.stuck).into_iter().collect();
        let mut errors = Vec::new();
        for (chat, (turn, event)) in stuck {
            if let Err(error) = self.receive(&chat, turn, &event) {
                errors.push(error);
            }
        }
        errors
    }

    /// Turn ends kept because their fold failed, by Chat.
    pub fn stuck_ends(&self) -> Vec<String> {
        self.stuck.keys().cloned().collect()
    }

    /// Handles one provider event (pushed by an adapter, or taken by `pump`).
    pub fn deliver(&mut self, event: ProviderEvent) -> Result<()> {
        // Chat keys come back as the adapter got them (raw): into the owner's encoding too.
        let event = match event {
            ProviderEvent::Started { chat, turn, result } => ProviderEvent::Started {
                chat: jsjson::js_string(&chat),
                turn,
                result,
            },
            ProviderEvent::StartFailed { chat, turn, error } => ProviderEvent::StartFailed {
                chat: jsjson::js_string(&chat),
                turn,
                error,
            },
            ProviderEvent::Agent { chat, turn, event } => ProviderEvent::Agent {
                chat: jsjson::js_string(&chat),
                turn,
                event,
            },
            ProviderEvent::Exited { chat, turn, error } => ProviderEvent::Exited {
                chat: jsjson::js_string(&chat),
                turn,
                error,
            },
            ProviderEvent::AnswerSettled {
                chat,
                answer,
                outcome,
            } => ProviderEvent::AnswerSettled {
                chat: jsjson::js_string(&chat),
                answer,
                outcome,
            },
        };
        match event {
            ProviderEvent::Started { chat, turn, result } => {
                if self.active_turn(&chat) != Some(turn) {
                    return Err(StoreError::Invalid(format!(
                        "A late start of turn {} was dropped: it no longer runs in {chat}.",
                        turn.0
                    )));
                }
                let result = result.encode();
                self.notice(Notice::Started {
                    chat,
                    turn,
                    result: result.clone(),
                });
                self.queue_started(turn, result);
                Ok(())
            }
            ProviderEvent::StartFailed { chat, turn, error } => {
                self.queue_started(turn, Value::Null);
                let event =
                    json!({ "type": "turn-failed", "message": jsjson::js_string(&error.message) });
                self.receive(&chat, turn, &event)
            }
            // The one place provider JSON enters the owner's encoding (see jsjson::RawJson).
            ProviderEvent::Agent { chat, turn, event } => {
                self.receive(&chat, turn, &event.into_encoded())
            }
            ProviderEvent::AnswerSettled {
                chat,
                answer,
                outcome,
            } => self.settle_answer(&chat, answer, outcome),
            ProviderEvent::Exited { chat, turn, error } => {
                // That session is gone (whether it ran a turn or idled): its answers first (with its reason), then its
                // turn; a newer turn is untouched.
                self.fail_answers(&chat, Some(turn), &error.message);
                let message = jsjson::js_string(&error.message);
                let mut result = Ok(());
                if self.active_turn(&chat) == Some(turn) {
                    let event = json!({ "type": "turn-failed", "message": message });
                    result = self.receive(&chat, turn, &event);
                }
                if self.latest.get(&chat) == Some(&turn) {
                    self.latest.remove(&chat);
                }
                result
            }
        }
    }

    /// A queued message's start resolved (`null` when it failed or its turn ended first): its sender hears it, or its
    /// Chat does.
    fn queue_started(&mut self, turn: TurnId, result: Value) {
        if let Some((id, chat)) = self.queue_turns.remove(&turn) {
            self.tell_queue_started(&chat, &id, result);
        }
    }

    fn tell_queue_started(&mut self, chat: &str, id: &str, result: Value) {
        if self.queue_waiters.remove(id) {
            self.notice(Notice::QueueStarted {
                id: id.into(),
                result,
            });
        } else {
            self.notice(Notice::QueueStartedWithoutSender {
                chat: chat.into(),
                id: id.into(),
            });
        }
    }

    /// Events Node folds outside a turn too: they must come from the Chat's latest session (its latest turn).
    const CHAT_LEVEL: [&'static str; 8] = [
        "session-started",
        "session-reset",
        "context-usage",
        "subagent-update",
        "background-tasks",
        "plan-updated",
        "tasks-updated",
        "prompt-suggestion",
    ];

    /// receive: folds one agent event into its Chat's Project, then tells the clients. Refused, folding nothing:
    /// - an event type this checkpoint doesn't fold;
    /// - a Chat key that doesn't spell its Project canonically, or a Project that isn't open here (a late event must
    ///   not open, and lock, a Project that was closed);
    /// - a turn event (and a turn end) of any turn but the one running, including when nothing runs (a duplicate
    ///   `turn-cancelled` after `turn-completed` must not hold the queue);
    /// - a Chat-level event of an older session than the Chat's latest turn;
    /// - a turn the agent started by itself.
    ///
    /// A turn end of the running turn whose fold fails is kept and folded again (`pump`, `tick`, `retry_stuck`), so
    /// its run never stays open for good; the queue moves on only when a turn end actually ended a run.
    pub fn receive(&mut self, chat: &str, turn: TurnId, event: &Value) -> Result<()> {
        let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
        let terminal = is_turn_end(event);
        let running = self.active_turn(chat);
        let checked = self.admit(chat, turn, kind, running);
        let folded = checked.and_then(|_| {
            let had_run = self.runs.contains_key(chat);
            self.fold(chat, event)
                .map(|_| had_run && !self.runs.contains_key(chat))
        });
        match &folded {
            Ok(_) if terminal => {
                self.stuck.remove(chat);
                self.active.remove(chat);
                self.deadlines.remove(chat);
                self.queue_started(turn, Value::Null);
                // Its requests ended with it: their answers stop holding slots.
                self.fail_answers(
                    chat,
                    Some(turn),
                    "The turn ended before the agent confirmed the answer.",
                );
            }
            // Kept only while it is still the running turn's end: a stale one is dropped for good.
            Err(_) if terminal && running == Some(turn) => {
                self.stuck.insert(chat.to_string(), (turn, event.clone()));
            }
            _ => {}
        }
        self.sync_busy();
        let ended = folded?;
        if terminal && ended {
            if let Err(error) = self.after_turn(chat, event) {
                self.notice(Notice::Failed {
                    chat: chat.into(),
                    what: "starting the next queued message".into(),
                    error: error.to_string(),
                });
            }
        }
        Ok(())
    }

    /// receive's checks, before anything is folded.
    fn admit(&self, chat: &str, turn: TurnId, kind: &str, running: Option<TurnId>) -> Result<()> {
        if agent_runs::UNSUPPORTED.contains(&kind) {
            return Err(gate(&format!("The agent event \"{kind}\"")));
        }
        let (project, _) = self.canonical_chat(chat)?;
        if !self.states.has(&project) {
            return Err(StoreError::Invalid(format!(
                "A \"{kind}\" for {chat} was dropped: its Project isn't open here."
            )));
        }
        if Self::CHAT_LEVEL.contains(&kind) {
            if self.latest.get(chat) != Some(&turn) {
                return Err(StoreError::Invalid(format!(
                    "A late \"{kind}\" of an older session (turn {}) was dropped for {chat}.",
                    turn.0
                )));
            }
            return Ok(());
        }
        match running {
            Some(running) if running == turn => Ok(()),
            Some(running) => Err(StoreError::Invalid(format!(
                "A late \"{kind}\" of an earlier turn ({}) was dropped: turn {} runs in {chat}.",
                turn.0, running.0
            ))),
            None if kind == "turn-started" && self.latest.get(chat) == Some(&turn) => {
                Err(gate("A turn the agent started by itself"))
            }
            None => Err(StoreError::Invalid(format!(
                "A late \"{kind}\" of turn {} was dropped: nothing runs in {chat}.",
                turn.0
            ))),
        }
    }

    /// Ends a turn whose provider won't (an interrupt past its grace, a forced quit or close): its session is closed
    /// (nonblocking), its turn fails with `message`, and anything that session still sends is dropped. If even the
    /// fold fails, the run is let go in memory (the user message stays saved) and that is told.
    fn force_end(&mut self, chat: &str, turn: TurnId, message: &str) {
        if let Some((_, provider)) = self.active.get(chat).cloned() {
            if let Some(adapter) = self.providers.get_mut(&provider) {
                let closed = outbound_identity(chat).map_err(|error| {
                    ProviderError::new(ProviderErrorKind::Refused, error.to_string())
                });
                if let Err(error) = closed.and_then(|wire| adapter.close_chat(&wire, turn)) {
                    self.notice(Notice::Failed {
                        chat: chat.into(),
                        what: "closing the agent's session".into(),
                        error: jsjson::js_string(&error.message),
                    });
                }
            }
        }
        let event = json!({ "type": "turn-failed", "message": message, "notice": true });
        if let Err(error) = self.receive(chat, turn, &event) {
            self.stuck.remove(chat);
            self.active.remove(chat);
            self.deadlines.remove(chat);
            self.runs.shift_remove(chat);
            self.queue_started(turn, Value::Null);
            self.notice(Notice::Failed {
                chat: chat.into(),
                what: "saving the end of a turn Milagre stopped".into(),
                error: error.to_string(),
            });
        }
        // Only that session's generation: a turn Send now started meanwhile keeps its own.
        if self.latest.get(chat) == Some(&turn) {
            self.latest.remove(chat);
        }
        self.fail_answers(
            chat,
            Some(turn),
            "The agent's session was closed before it took the answer.",
        );
        self.sync_busy();
    }

    /// The fold of `receive`: the state and runs change together, or not at all.
    fn fold(&mut self, chat: &str, event: &Value) -> Result<()> {
        let project_text = agent_runs::project_of_key(chat).to_string();
        let project = Self::project_path(&project_text);
        let session_id = session_of_key(chat)
            .ok_or_else(|| StoreError::Invalid(format!("{chat} isn't a Chat.")))?;
        let now = self.states.now();
        let mut seq = self.seq;
        let mut event = event.clone();
        // ChatHost.fold's stamps read the run as it stands, before the event changes it.
        enrich_step_event(&mut event, &self.runs, chat, now);
        // The fold changes the Chat's run in place. Only an event that can change the state and the run together can
        // fail after the run changed (a save or load behind a changed state): for those, that one run is copied first
        // and put back, in its place, if the change can't be kept.
        let backup = agent_runs::may_change_run_and_state(&event, &self.runs, chat).then(|| {
            (
                self.runs.keys().position(|key| key == chat),
                self.runs.get(chat).cloned(),
            )
        });
        let runs = &mut self.runs;
        let mut added: Vec<MsgRef> = Vec::new();
        let open = self.open_chat.clone();
        let turn = self.turns.get(chat).cloned();
        let mut limit_gap = false;
        let kind = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        // A subagent's progress stays in memory until something else saves (Node's `persist: false`).
        let persist = kind != "subagent-update";
        let folded = self
            .states
            .try_update(&project, Some(&[session_id]), persist, |state| {
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
                let (next, changed) = agent_runs::apply_agent_event_mut(
                    state,
                    runs,
                    &project_text,
                    chat,
                    &event,
                    now,
                )
                .map_err(|unsupported| gate(&unsupported.0))?;
                seq += 1;
                if !changed {
                    return Ok(None);
                }
                let visible = open.as_deref() == Some(chat);
                let archived = next
                    .sessions()
                    .and_then(|sessions| sessions.get(&session_id.to_string()))
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
        if folded.is_err() {
            if let Some((position, run)) = backup {
                match run {
                    Some(run) => match self.runs.get_mut(chat) {
                        Some(current) => *current = run,
                        None => {
                            let at = position.unwrap_or(self.runs.len()).min(self.runs.len());
                            self.runs.shift_insert(at, chat.to_string(), run);
                        }
                    },
                    None => {
                        self.runs.shift_remove(chat);
                    }
                }
            }
        }
        let (state, changed) = folded?;
        self.seq = seq;
        // A subagent update goes out with the merged agent, and without the state.
        let published = if kind == "subagent-update" && changed {
            let mut merged = event.clone();
            let agent = state
                .sessions()
                .and_then(|sessions| sessions.get(&session_id.to_string()))
                .and_then(|session| session.get("subagents").and_then(Value::as_array))
                .and_then(|agents| {
                    agents.iter().find(|agent| {
                        match (
                            agent.get("id"),
                            event.get("agent").and_then(|a| a.get("id")),
                        ) {
                            (Some(a), Some(b)) => jsjson::strict_equals(a, b),
                            (None, None) => true,
                            _ => false,
                        }
                    })
                });
            merged["agent"] = agent.cloned().unwrap_or_else(jsjson::undefined);
            merged
        } else {
            event.clone()
        };
        self.notice(Notice::Event {
            chat: chat.into(),
            event: jsjson::strip_undefined(&published),
            seq: Some(self.seq),
            with_state: changed && kind != "subagent-update",
        });
        if limit_gap {
            self.notice(Notice::Gap {
                chat: chat.into(),
                what: "usage-limit continuation (limitTurn)".into(),
            });
        }
        for message in &added {
            if message
                .get("body")
                .and_then(Value::as_str)
                .is_some_and(|body| body.contains("!["))
            {
                self.notice(Notice::Gap {
                    chat: chat.into(),
                    what: "reply image capture".into(),
                });
            }
        }
        let _ = state;
        Ok(())
    }

    /// afterTurn: a completed turn starts the next queued message (Send now's pick first); Stop and failures hold
    /// the queue. Automatic compaction is off (Node's default) and can't be turned on here. A queued message whose
    /// `clientMessageId` is already in the Chat leaves the queue and the next one is tried (Node would retry it on
    /// every turn end).
    fn after_turn(&mut self, chat: &str, event: &Value) -> Result<()> {
        let project = Self::project_path(agent_runs::project_of_key(chat));
        // Nothing starts under a quit or a closing Project. A completed turn's queue waits, and moves on if the quit is
        // refused; a stopped or failed one holds as it would otherwise, so it doesn't send on its own once reopened.
        if self.quitting || self.closing.contains(&project) {
            self.send_next.remove(chat);
            if event.get("type").and_then(Value::as_str) == Some("turn-completed") {
                self.deferred.push((chat.to_string(), event.clone()));
                return Ok(());
            }
            return self.hold_queue(chat);
        }
        let session_id = session_of_key(chat).unwrap_or(-1);
        let mut next = self.send_next.remove(chat);
        loop {
            if self.is_busy(chat) {
                return Ok(());
            }
            let state = self.states.get(&project)?;
            let session = session_value(&state, &json!(session_id));
            let queued: Vec<Value> = session
                .as_ref()
                .and_then(|s| s.get("queued"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if queued.is_empty() {
                return Ok(());
            }
            let picked = next.take().filter(|next| {
                queued
                    .iter()
                    .any(|item| item.get("id").and_then(Value::as_str) == Some(next))
            });
            let id = match picked {
                Some(id) => id,
                None if session
                    .as_ref()
                    .is_some_and(|s| jsjson::truthy(s.get("queueHeld"))) =>
                {
                    return Ok(())
                }
                None if event.get("type").and_then(Value::as_str) == Some("turn-completed") => {
                    queued[0]
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string()
                }
                None => return self.hold_queue(chat),
            };
            match self.start_queued(chat, &id) {
                Ok(QueuedStart::AlreadySaved) => continue,
                Ok(_) => return Ok(()),
                Err(error) => {
                    self.hold_queue(chat)?;
                    return Err(error);
                }
            }
        }
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
    fn start_queued(&mut self, chat: &str, id: &str) -> Result<QueuedStart> {
        if self.is_busy(chat) {
            return Ok(QueuedStart::NotStarted);
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
            return Ok(QueuedStart::NotStarted);
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
                return Ok(QueuedStart::NotStarted)
            }
            Err(error) => return Err(error),
        };
        if sent.duplicate {
            self.drop_queued(chat, id)?;
            self.tell_queue_started(
                chat,
                id,
                json!({ "turnId": null, "steered": false, "duplicate": true }),
            );
            return Ok(QueuedStart::AlreadySaved);
        }
        match sent.turn {
            Some(turn) => {
                self.queue_turns.insert(turn, (id.into(), chat.into()));
            }
            None => self.tell_queue_started(chat, id, Value::Null),
        }
        Ok(QueuedStart::Started)
    }

    /// Takes a queued message out of the queue (it is already in the Chat) and saves that.
    fn drop_queued(&mut self, chat: &str, id: &str) -> Result<()> {
        let project = Self::project_path(agent_runs::project_of_key(chat));
        let session_id = session_of_key(chat).unwrap_or(-1);
        let (_, changed) = self.states.update(&project, Some(&[]), true, |latest| {
            let session = agent_runs_session(latest, session_id)?;
            Some(agent_runs::with_session(
                latest,
                session_id,
                without_queued(&session, id),
            ))
        })?;
        if changed {
            self.states.flush(Some(&project))?;
            self.broadcast(&project);
        }
        Ok(())
    }

    /// chat:queue-send: Send now. A running turn that can't take it is stopped, and it starts once that turn ends.
    pub fn send_queued_now(&mut self, chat: &str, id: &str) -> Result<()> {
        let (project, _) = self.canonical_chat(chat)?;
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
            // The pick is kept only once the stop was asked for: a failed interrupt must not leave it waiting for
            // whichever turn ends next.
            if !self.active.contains_key(chat) {
                return Err(StoreError::Invalid(
                    "This Chat's turn has nothing to stop yet. Try again once it ends.".into(),
                ));
            }
            self.interrupt(chat)?;
            self.send_next.insert(chat.into(), id.into());
            return Ok(());
        }
        self.start_queued(chat, id).map(|_| ())
    }

    /// chat:queue-remove: takes a message out of the queue without sending it. False when it was already gone.
    pub fn remove_queued(&mut self, chat: &str, id: &str) -> Result<bool> {
        let (project, _) = self.canonical_chat(chat)?;
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
            self.notice(Notice::QueueStarted { id: id.into(), result: json!({ "turnId": null, "steered": false, "cancelled": true, "removed": true }) });
        } else {
            self.notice(Notice::QueueRemovedWithoutSender {
                chat: chat.into(),
                id: id.into(),
            });
        }
        Ok(true)
    }

    /// agent:interrupt: asks the running turn's provider to stop; its `turn-cancelled` ends the turn. Nothing runs:
    /// nothing to do (SessionManager.interrupt without a session).
    pub fn interrupt(&mut self, chat: &str) -> Result<()> {
        self.canonical_chat(chat)?;
        let Some((turn, provider)) = self.active.get(chat).cloned() else {
            return Ok(());
        };
        match self.providers.get_mut(&provider) {
            Some(adapter) => adapter
                .interrupt(&outbound_identity(chat)?, turn)
                .map_err(|error| StoreError::Invalid(jsjson::js_string(&error.message)))?,
            None => {
                return Err(StoreError::Invalid(format!(
                    "No {provider} provider adapter is registered with the Rust owner."
                )))
            }
        }
        // The turn has `interrupt_grace_ms` to end; `tick` forces it past that.
        let due = self.states.now() + self.interrupt_grace_ms;
        self.deadlines
            .entry(chat.to_string())
            .or_insert((turn, due));
        Ok(())
    }

    /// Ends the provider sessions of a Project's Chats (nonblocking), forgetting their generations so whatever they
    /// still send is dropped.
    fn close_sessions(&mut self, key: &Path) {
        let chats: Vec<String> = self
            .latest
            .keys()
            .chain(self.turns.keys())
            .filter(|chat| Path::new(agent_runs::project_of_key(chat)) == key)
            .cloned()
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        for chat in chats {
            let provider = self
                .turns
                .get(&chat)
                .and_then(|turn| turn.get("provider"))
                .and_then(Value::as_str)
                .map(str::to_string);
            let generation = self.latest.get(&chat).copied();
            let adapter = provider.and_then(|name| self.providers.get_mut(&name));
            if let (Some(adapter), Some(generation)) = (adapter, generation) {
                let closed = outbound_identity(&chat).map_err(|error| {
                    ProviderError::new(ProviderErrorKind::Refused, error.to_string())
                });
                if let Err(error) = closed.and_then(|wire| adapter.close_chat(&wire, generation)) {
                    self.notice(Notice::Failed {
                        chat: chat.clone(),
                        what: "closing the agent's session".into(),
                        error: jsjson::js_string(&error.message),
                    });
                }
            }
            self.latest.remove(&chat);
            self.turns.remove(&chat);
            self.send_next.remove(&chat);
            self.fail_answers(
                &chat,
                None,
                "The agent's session was closed before it took the answer.",
            );
        }
    }

    /// Closes one Project here: its Chats' provider sessions are closed first, so a late event can't open it (and take
    /// its lock) again. Refused while a turn runs or starts in it, or a turn end waits to be folded again, unless
    /// `force`, which ends those turns as failed first (see `tick` for the same path after an interrupt).
    pub fn forget(&mut self, project: &Path, force: bool) -> Result<()> {
        let key = self.canonical_project(&project.display().to_string())?;
        let in_project = |chat: &String| Path::new(agent_runs::project_of_key(chat)) == key;
        let busy: Vec<String> = self
            .runs
            .keys()
            .chain(self.starting.keys())
            .chain(self.stuck.keys())
            .chain(self.active.keys())
            .filter(|chat| in_project(chat))
            .cloned()
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        if let Some(chat) = busy.first() {
            if !force {
                return Err(StoreError::Invalid(format!(
                    "{chat} has a turn running; stop it before closing its Project."
                )));
            }
        }
        // While it closes, nothing starts in it: a forced end must not start a Send-now pick or the queue.
        self.closing.insert(key.clone());
        self.send_next.retain(|chat, _| !in_project(chat));
        for chat in &busy {
            if let Some(turn) = self.active_turn(chat) {
                self.force_end(
                    chat,
                    turn,
                    "Milagre closed this Project before the turn ended.",
                );
            }
            self.stuck.remove(chat);
            self.runs.shift_remove(chat);
        }
        self.sync_busy();
        self.close_sessions(&key);
        self.release_waiters(Some(&key));
        let closed = self.states.forget(&key);
        self.closing.remove(&key);
        self.deferred.retain(|(chat, _)| !in_project(chat));
        closed
    }

    /// Senders still waiting on a queued message's start (or a start in flight) hear `null` (Node's "Milagre
    /// restarted first"); the entries stay queued on disk. `project` limits it to one Project.
    fn release_waiters(&mut self, project: Option<&Path>) {
        let in_scope = |chat: &str| {
            project.is_none_or(|key| Path::new(agent_runs::project_of_key(chat)) == key)
        };
        let starting: Vec<(TurnId, String, String)> = self
            .queue_turns
            .iter()
            .filter(|(_, (_, chat))| in_scope(chat))
            .map(|(turn, (id, chat))| (*turn, id.clone(), chat.clone()))
            .collect();
        for (turn, id, chat) in starting {
            self.queue_turns.remove(&turn);
            self.tell_queue_started(&chat, &id, Value::Null);
        }
        let projects: Vec<PathBuf> = match project {
            Some(key) => vec![key.to_path_buf()],
            None => self.states.projects(),
        };
        for key in projects {
            let Some(state) = self.states.current(&key) else {
                continue;
            };
            let Some(sessions) = state.sessions() else {
                continue;
            };
            let mut waiting = Vec::new();
            for (session_id, session) in jsjson::js_entries(sessions) {
                for entry in session
                    .get("queued")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    if let Some(id) = entry
                        .get("id")
                        .and_then(Value::as_str)
                        .filter(|id| self.queue_waiters.contains(*id))
                    {
                        waiting.push((format!("{}#{session_id}", key.display()), id.to_string()));
                    }
                }
            }
            for (chat, id) in waiting {
                self.tell_queue_started(&chat, &id, Value::Null);
            }
        }
        self.deadlines.retain(|chat, _| !in_scope(chat));
    }

    /// Ends the host. Providers' waiting events are handled first. Refused while a turn runs (quit-time suspend and
    /// resume aren't ported) unless `force`, which ends those turns as failed (their replies so far saved). Then every
    /// provider shuts down (nonblocking by the trait's contract) and the states close.
    ///
    /// A close that fails (a save failing) returns its error and leaves the host quitting for good: sends and starts
    /// stay refused, the providers stay shut down (a host never runs again after that; start a new one), and the
    /// states keep their unsaved changes and locks (`ProjectStates::close`). Calling `shutdown` again is the recovery:
    /// it only retries the save and the close, and the quit is complete once it returns `Ok`.
    pub fn shutdown(&mut self, force: bool) -> Result<()> {
        if self.providers_shut_down {
            self.states.close()?;
            self.closed = true;
            return Ok(());
        }
        // From here no queued message starts and no send is taken, not even from the events handled below.
        self.quitting = true;
        let errors = self.pump();
        for error in errors {
            self.notice(Notice::Failed {
                chat: String::new(),
                what: "handling events before quitting".into(),
                error: error.to_string(),
            });
        }
        let running: Vec<String> = self
            .active
            .keys()
            .chain(self.stuck.keys())
            .cloned()
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        if let Some(chat) = running.first() {
            if !force {
                self.quitting = false;
                // The turn ends handled before the refusal move their queues on now.
                for (deferred, event) in std::mem::take(&mut self.deferred) {
                    if let Err(error) = self.after_turn(&deferred, &event) {
                        self.notice(Notice::Failed {
                            chat: deferred.clone(),
                            what: "starting the next queued message".into(),
                            error: error.to_string(),
                        });
                    }
                }
                return Err(gate(&format!(
                    "Quitting while a turn runs in {chat} (suspend and resume)"
                )));
            }
        }
        self.send_next.clear();
        for chat in &running {
            if let Some(turn) = self.active_turn(chat) {
                self.force_end(chat, turn, "Milagre quit before the turn ended.");
            }
            self.stuck.remove(chat);
        }
        for provider in self.providers.values_mut() {
            provider.shutdown();
        }
        self.providers_shut_down = true;
        let waiting: Vec<String> = self
            .pending_answers
            .values()
            .map(|pending| pending.chat.clone())
            .collect();
        for chat in waiting {
            self.fail_answers(
                &chat,
                None,
                "Milagre quit before the agent took the answer.",
            );
        }
        self.release_waiters(None);
        self.latest.clear();
        self.sync_busy();
        self.states.close()?;
        self.closed = true;
        Ok(())
    }

    /// chat:send-status with nothing in flight (sends here finish before the next call).
    pub fn send_status(&mut self, project: &Path, client_message_id: &Value) -> Result<Value> {
        self.states.send_status(project, client_message_id)
    }

    /// The turn an answer belongs to: the one running in the Chat, and its provider. A request lives in its turn's
    /// run (Node drops a run's approvals and questions with it), so with no turn running nothing waits on an answer:
    /// it settles `false` at once, as Node's do.
    fn session_of(&self, chat: &str) -> Option<(TurnId, String)> {
        self.active.get(chat).cloned()
    }

    /// agent:respond-permission (runtime.cjs respondPermission, SessionManager.respondToPermission): the user's
    /// decision handed to the session waiting on it, settling later as [`Notice::AnswerSettled`]; its
    /// `permission-resolved` follows as an agent event. Setup reviews (`setup-review-*`) are refused: Worktree setup
    /// isn't ported.
    pub fn respond_permission(&mut self, request: &Value) -> Result<AnswerTicket> {
        let request_id = request.get("requestId");
        if request_id
            .and_then(Value::as_str)
            .is_some_and(|id| id.starts_with("setup-review-"))
        {
            return Err(gate("Answering a Worktree setup review"));
        }
        let decision = request.get("decision");
        let Some(decision) = decision
            .and_then(Value::as_str)
            .filter(|d| USER_DECISIONS.contains(d))
        else {
            return Err(StoreError::Invalid(format!(
                "Unknown permission decision: {}",
                jsjson::property_key(decision)
            )));
        };
        let chat = request
            .get("chatId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let Some((turn, provider)) = self.session_of(&chat) else {
            return Ok(AnswerTicket::Settled(false));
        };
        let id = jsjson::property_key(request_id);
        self.admit_answer(&chat, turn, &id)?;
        let wire_chat = outbound_identity(&chat)?;
        let wire_id = outbound_identity(&id)?;
        let answer = self.next_answer_id();
        self.provider(&provider)?
            .respond_permission(&wire_chat, turn, answer, &wire_id, decision)
            .map_err(|error| StoreError::Invalid(jsjson::js_string(&error.message)))?;
        self.hold_answer(answer, &chat, turn, &id, None);
        Ok(AnswerTicket::Pending(answer))
    }

    fn next_answer_id(&mut self) -> AnswerId {
        self.next_answer += 1;
        AnswerId(self.next_answer)
    }

    fn hold_answer(
        &mut self,
        answer: AnswerId,
        chat: &str,
        turn: TurnId,
        request: &str,
        message: Option<f64>,
    ) {
        let due = self.states.now() + self.answer_grace_ms;
        self.pending_answers.insert(
            answer,
            PendingAnswer {
                chat: chat.into(),
                turn,
                request: request.into(),
                message,
                due,
            },
        );
    }

    /// Settles a handed-over answer, told as `Notice::AnswerSettled`. `NotWaiting` and `Failed` (proven
    /// undelivered) take its answers message back; `Uncertain` keeps it and keeps the answer to block retries. A later
    /// definitive settlement of an uncertain answer is told as `Notice::AnswerResolved`. Unknown, already settled, or
    /// another Chat's: dropped.
    fn settle_answer(
        &mut self,
        chat: &str,
        answer: AnswerId,
        outcome: AnswerOutcome,
    ) -> Result<()> {
        let message_of = |error: ProviderError| jsjson::js_string(&error.message);
        let result = match outcome {
            AnswerOutcome::Accepted => AnswerResult::Accepted,
            AnswerOutcome::NotWaiting => AnswerResult::NotWaiting,
            AnswerOutcome::Failed(error) => AnswerResult::Failed(message_of(error)),
            AnswerOutcome::Uncertain(error) => AnswerResult::Uncertain(message_of(error)),
        };
        if let Some(pending) = self
            .pending_answers
            .get(&answer)
            .filter(|pending| pending.chat == chat)
            .cloned()
        {
            self.pending_answers.remove(&answer);
            match &result {
                AnswerResult::Uncertain(_) => self.keep_uncertain(answer, pending),
                AnswerResult::Accepted => {}
                _ => self.take_back_or_tell(chat, pending.message),
            }
            self.notice(Notice::AnswerSettled {
                chat: chat.into(),
                answer,
                result,
            });
            return Ok(());
        }
        let kept = self
            .uncertain_answers
            .get(&answer)
            .or_else(|| self.historical_answers.get(&answer))
            .filter(|kept| kept.chat == chat)
            .cloned();
        if let Some(kept) = kept {
            if matches!(result, AnswerResult::Uncertain(_)) {
                return Ok(());
            }
            self.uncertain_answers.remove(&answer);
            self.historical_answers.remove(&answer);
            if result != AnswerResult::Accepted {
                self.take_back_or_tell(chat, kept.message);
            }
            self.notice(Notice::AnswerResolved {
                chat: chat.into(),
                answer,
                result,
            });
            return Ok(());
        }
        Err(StoreError::Invalid(format!(
            "A settlement of answer {} for {chat} was dropped: no such answer waits.",
            answer.0
        )))
    }

    /// Kept until a definitive settlement or its turn ends (or its session closes); never evicted (eviction would let
    /// the same request be answered twice while it lives). Its slot stays taken (see `admit_answer`).
    fn keep_uncertain(&mut self, answer: AnswerId, pending: PendingAnswer) {
        self.uncertain_answers.insert(answer, pending);
    }

    /// Answers holding a slot: on their way, or with an unknown delivery.
    pub fn answers_in_flight(&self) -> usize {
        self.pending_answers.len() + self.uncertain_answers.len()
    }

    /// Whether another answer may be handed over: one per request and generation, and a free slot. Checked before
    /// anything is shown or handed over; the slot is taken when the answer is held.
    fn admit_answer(&self, chat: &str, turn: TurnId, request: &str) -> Result<()> {
        if let Some(why) = self.answer_in_flight(chat, turn, request) {
            return Err(StoreError::AnswerDeliveryUnknown(why.into()));
        }
        if self.answers_in_flight() >= self.answer_capacity {
            return Err(StoreError::AnswersAtCapacity(format!(
                "{} answers are still waiting on the agents; try again once some are settled.",
                self.answers_in_flight()
            )));
        }
        Ok(())
    }

    /// Whether a request already has an answer on its way, or one whose delivery is unknown, in this session generation.
    fn answer_in_flight(&self, chat: &str, turn: TurnId, request: &str) -> Option<&'static str> {
        let same = |pending: &PendingAnswer| {
            pending.chat == chat && pending.turn == turn && pending.request == request
        };
        if self.pending_answers.values().any(same) {
            return Some("An answer to this request is already on its way to the agent.");
        }
        if self.uncertain_answers.values().any(same) {
            return Some("An earlier answer to this request may have reached the agent; it can't be answered again until that's known.");
        }
        None
    }

    /// Releases the answers of a Chat's turns up to `upto` (all of them with None) once their requests can't be
    /// waiting any more: the turn ended (its run, approvals and questions with it), or its session closed (forced end,
    /// `Exited`, close, quit). Answers still on their way settle `Uncertain` (their messages stay); uncertain ones stop
    /// holding a slot and blocking retries. Both move to a bounded history, where a late definitive settlement still
    /// resolves them (taking the message back when it proves nothing was delivered).
    fn fail_answers(&mut self, chat: &str, upto: Option<TurnId>, message: &str) {
        let in_scope = |pending: &PendingAnswer| {
            pending.chat == chat && upto.is_none_or(|upto| pending.turn <= upto)
        };
        let doomed: Vec<AnswerId> = self
            .pending_answers
            .iter()
            .filter(|(_, pending)| in_scope(pending))
            .map(|(answer, _)| *answer)
            .collect();
        for answer in doomed {
            let error = ProviderError::new(ProviderErrorKind::Exited, message);
            let _ = self.settle_answer(chat, answer, AnswerOutcome::Uncertain(error));
        }
        let released: Vec<AnswerId> = self
            .uncertain_answers
            .iter()
            .filter(|(_, kept)| in_scope(kept))
            .map(|(answer, _)| *answer)
            .collect();
        for answer in released {
            let kept = self.uncertain_answers.remove(&answer).expect("present");
            self.historical_answers.insert(answer, kept);
        }
        while self.historical_answers.len() > self.answer_history {
            if let Some((answer, forgotten)) = self.historical_answers.pop_first() {
                self.notice(Notice::AnswerForgotten {
                    chat: forgotten.chat,
                    answer,
                });
            }
        }
    }

    fn provider(&mut self, name: &str) -> Result<&mut Box<dyn Provider>> {
        self.providers.get_mut(name).ok_or_else(|| {
            StoreError::Invalid(format!(
                "No {name} provider adapter is registered with the Rust owner."
            ))
        })
    }

    /// agent:answer-question (runtime.cjs answerQuestion): the answers show in the Chat as the user's message
    /// (`summary`, after the reply so far) before they go to the agent, and are taken back if the agent doesn't take
    /// them. Refused: chat secrets and bug reports (their requests never reach a Chat), images attached to answers,
    /// and a Subchat suggestion card's answer. Subchat escalation bookkeeping isn't ported.
    pub fn answer_question(&mut self, request: &Value) -> Result<AnswerTicket> {
        let request_id = request.get("requestId");
        let id_text = request_id.and_then(Value::as_str);
        if id_text.is_some_and(|id| id.starts_with("milagre-secret-")) {
            return Err(gate("Answering a secret request (chat secrets)"));
        }
        if id_text.is_some_and(|id| id.starts_with("milagre-bug-report-")) {
            return Err(gate("Approving a Milagre bug report"));
        }
        let answers = request.get("answers").cloned();
        if jsjson::truthy(answers.as_ref()) {
            match jsjson::nullish(request.get("images"), None) {
                None => {}
                Some(Value::Object(images)) => {
                    if images.values().any(|attached| !attached.is_array()) {
                        return Err(StoreError::Invalid(
                            "Invalid images for an agent question.".into(),
                        ));
                    }
                    let count: usize = images
                        .values()
                        .filter_map(Value::as_array)
                        .map(Vec::len)
                        .sum();
                    if count > 10 {
                        return Err(StoreError::Invalid(
                            "Attach at most 10 images to your answers.".into(),
                        ));
                    }
                    if count > 0 {
                        return Err(gate("Images attached to answers"));
                    }
                }
                Some(_) => {
                    return Err(StoreError::Invalid(
                        "Invalid images for an agent question.".into(),
                    ))
                }
            }
        }
        if matches!(request.get("suggestionId"), Some(Value::String(_))) {
            return Err(gate("Answering through a Subchat's suggestion card"));
        }
        let chat_value = request.get("chatId");
        let chat = chat_value.and_then(Value::as_str).unwrap_or("").to_string();
        let summary = request
            .get("summary")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());
        // Bounded before anything is shown: the summary becomes a saved message.
        if summary.is_some_and(|summary| jsjson::utf16_len(summary) > MAX_ANSWER_SUMMARY) {
            return Err(StoreError::Invalid(format!(
                "The answers summary is longer than {MAX_ANSWER_SUMMARY} characters."
            )));
        }
        let open = chat_value.is_some_and(Value::is_string)
            && self
                .states
                .has(Path::new(agent_runs::project_of_key(&chat)));
        // One answer per request and session generation while one is on its way or its delivery is unknown: checked
        // before anything is shown.
        let request_key = jsjson::property_key(request_id);
        let given = answers.clone().unwrap_or(Value::Null);
        // What the provider would get is built before anything is shown: an identity it can't receive is refused here,
        // never shown and then taken back.
        let wire = match self.session_of(&chat) {
            Some((turn, _)) => {
                self.admit_answer(&chat, turn, &request_key)?;
                Some((
                    outbound_identity(&chat)?,
                    outbound_identity(&request_key)?,
                    outbound_answers(&given)?,
                ))
            }
            None => None,
        };
        let recorded = match (jsjson::truthy(answers.as_ref()), summary) {
            (true, Some(summary)) if open => {
                match self.record_answers(&chat, summary, request_id, answers.as_ref().unwrap()) {
                    Ok(id) => id,
                    Err(error) => {
                        self.notice(Notice::Failed {
                            chat: chat.clone(),
                            what: "showing the answers".into(),
                            error: error.to_string(),
                        });
                        None
                    }
                }
            }
            _ => None,
        };
        // SessionManager.answerQuestion: only null or a few short strings per question reach a session.
        let handed = if !valid_answers(Some(&given)) || request.get("answers").is_none() {
            Err(StoreError::Invalid(
                "Invalid answers to an agent question.".into(),
            ))
        } else {
            match (self.session_of(&chat), wire) {
                (Some((turn, provider)), Some(wire)) => {
                    let answer = self.next_answer_id();
                    self.provider(&provider)
                        .map(|adapter| (adapter, wire))
                        .and_then(|(adapter, (wire_chat, wire_id, wire_answers))| {
                            adapter
                                .answer_question(&wire_chat, turn, answer, &wire_id, &wire_answers)
                                .map_err(|error| {
                                    StoreError::Invalid(jsjson::js_string(&error.message))
                                })
                        })
                        .map(|_| Some((answer, turn)))
                }
                _ => Ok(None),
            }
        };
        match handed {
            Ok(Some((answer, turn))) => {
                self.hold_answer(answer, &chat, turn, &request_key, recorded);
                Ok(AnswerTicket::Pending(answer))
            }
            Ok(None) => {
                self.take_back_or_tell(&chat, recorded);
                Ok(AnswerTicket::Settled(false))
            }
            // The original error stands; a take-back that fails too is told, not swapped in.
            Err(error) => {
                self.take_back_or_tell(&chat, recorded);
                Err(error)
            }
        }
    }

    /// ChatHost.recordAnswers: the answers message saved after the reply so far, `answers-sent` told before anything
    /// is written, then a flush whose failure stays as save status (tried again). The new message's id.
    fn record_answers(
        &mut self,
        chat: &str,
        body: &str,
        request_id: Option<&Value>,
        answers: &Value,
    ) -> Result<Option<f64>> {
        let (project, session_id) = self.canonical_chat(chat)?;
        let project_text = project.display().to_string();
        let now = self.states.now();
        let mut runs = self.runs.clone();
        let mut seq = self.seq;
        let mut message_id = None;
        let mut added: Vec<MsgRef> = Vec::new();
        let (state, changed) =
            self.states
                .update(&project, Some(&[session_id]), true, |latest| {
                    let request = runs
                        .get(chat)
                        .and_then(|run| run.get("questions"))
                        .and_then(Value::as_array)
                        .and_then(|questions| {
                            questions.iter().find(|item| {
                                match (item.get("requestId"), request_id) {
                                    (Some(a), Some(b)) => jsjson::strict_equals(a, b),
                                    (None, None) => true,
                                    _ => false,
                                }
                            })
                        })
                        .cloned();
                    let answered = agent_runs::answered_questions(request.as_ref(), answers);
                    let (next, next_runs, id) = agent_runs::record_answers(
                        latest,
                        &runs,
                        &project_text,
                        chat,
                        body,
                        answered,
                        now,
                    )?;
                    let before = latest.message_list().len();
                    added = next.message_list()[before..]
                        .iter()
                        .filter(|m| m.get("role").and_then(Value::as_str) == Some("assistant"))
                        .cloned()
                        .collect();
                    runs = next_runs;
                    message_id = Some(id);
                    seq += 1;
                    Some(next)
                })?;
        if !changed || message_id.is_none() {
            return Ok(None);
        }
        self.runs = runs;
        self.seq = seq;
        self.notice(Notice::Event {
            chat: chat.into(),
            event: json!({ "type": "answers-sent" }),
            seq: Some(seq),
            with_state: true,
        });
        if let Err(error) = self.states.flush(Some(&project)) {
            self.notice(Notice::Failed {
                chat: chat.into(),
                what: "saving the answers".into(),
                error: error.to_string(),
            });
        }
        if added.iter().any(|m| {
            m.get("body")
                .and_then(Value::as_str)
                .is_some_and(|body| body.contains("!["))
        }) {
            self.notice(Notice::Gap {
                chat: chat.into(),
                what: "reply image capture".into(),
            });
        }
        let _ = state;
        Ok(message_id)
    }

    /// ChatHost.takeBack: removes a message again, such as answers that never reached the agent.
    fn take_back_or_tell(&mut self, chat: &str, message: Option<f64>) {
        if let Some(id) = message {
            if let Err(error) = self.take_back(chat, id) {
                self.notice(Notice::Failed {
                    chat: chat.into(),
                    what: "taking the answers back".into(),
                    error: error.to_string(),
                });
            }
        }
    }

    fn take_back(&mut self, chat: &str, id: f64) -> Result<()> {
        let (project, session_id) = self.canonical_chat(chat)?;
        // Never opens (and locks) a Project that was closed: its answers message went with it.
        if !self.states.has(&project) {
            return Ok(());
        }
        let (_, changed) = self
            .states
            .update(&project, Some(&[session_id]), true, |latest| {
                let same = |m: &MsgRef| m.get("id").and_then(Value::as_f64) == Some(id);
                latest.message_list().iter().any(same).then(|| {
                    latest.with_messages(
                        latest
                            .message_list()
                            .iter()
                            .filter(|m| !same(m))
                            .cloned()
                            .collect(),
                    )
                })
            })?;
        if changed {
            self.broadcast(&project);
        }
        Ok(())
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
            // Pending: the wire server keeps the client's reply until `Notice::AnswerSettled { answer }`.
            "agent:respond-permission" => self.respond_permission(&arg(0)).map(ticket_value),
            "agent:answer-question" => self.answer_question(&arg(0)).map(ticket_value),
            other => self.states.call(other, args),
        }
    }
}

fn agent_runs_session(state: &ProjectState, session: i64) -> Option<Map<String, Value>> {
    session_value(state, &json!(session))
}

/// ChatHost.fold's stamps on step events, from the run as it stands: a started step keeps the start of an earlier copy
/// of itself (a title update while it waits for approval) and gets its command as `input`; a completed one gets its
/// end, duration and summarizeStep's facts.
fn enrich_step_event(event: &mut Value, runs: &Runs, chat: &str, now: i64) {
    let steps: &[Value] = runs
        .get(chat)
        .and_then(|run| run.get("steps"))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let same = |a: Option<&Value>, b: Option<&Value>| match (jsjson::defined(a), jsjson::defined(b))
    {
        (Some(a), Some(b)) => jsjson::strict_equals(a, b),
        (None, None) => true,
        _ => false,
    };
    match event.get("type").and_then(Value::as_str) {
        Some("step-started") => {
            let Some(step) = event.get("step").and_then(Value::as_object).cloned() else {
                return;
            };
            let started_at = steps
                .iter()
                .find(|known| same(known.get("id"), step.get("id")))
                .and_then(|known| jsjson::nullish(known.get("startedAt"), None).cloned())
                .unwrap_or_else(|| json!(now));
            let kind = step.get("kind").and_then(Value::as_str);
            let command = match step.get("detail") {
                Some(Value::String(detail))
                    if matches!(kind, Some("shell" | "setup"))
                        && detail.starts_with("$ ")
                        && detail.ends_with('\n') =>
                {
                    Some(detail[2..detail.len() - 1].to_string())
                }
                _ => None,
            };
            let input = match command {
                Some(command) if !command.is_empty() && jsjson::utf16_len(&command) <= 4000 => {
                    Some(Value::String(command))
                }
                _ => step.get("input").cloned(),
            };
            let mut stamped = step;
            if let Some(input) = input.filter(|input| jsjson::truthy(Some(input))) {
                stamped.insert("input".into(), input);
            }
            stamped.insert("startedAt".into(), started_at);
            event["step"] = Value::Object(stamped);
        }
        Some("step-completed") => {
            let Some(step) = steps
                .iter()
                .find(|known| same(known.get("id"), event.get("id")))
            else {
                return;
            };
            let mut merged = step.as_object().cloned().unwrap_or_default();
            for (key, value) in event.as_object().into_iter().flatten() {
                merged.insert(key.clone(), value.clone());
            }
            let facts = crate::tool_activity::summarize_step(&merged);
            let duration = match jsjson::nullish(event.get("durationMs"), None) {
                Some(duration) => Some(duration.clone()),
                None => match jsjson::defined(step.get("startedAt")) {
                    None | Some(Value::Null) => None,
                    Some(started) => {
                        let started = match started {
                            Value::Number(number) => jsjson::as_f64(number),
                            Value::Bool(flag) => f64::from(u8::from(*flag)),
                            Value::String(text) => text.trim().parse().unwrap_or(f64::NAN),
                            _ => f64::NAN,
                        };
                        let elapsed = now as f64 - started;
                        Some(jsjson::number(if elapsed.is_nan() {
                            f64::NAN
                        } else {
                            elapsed.max(0.0)
                        }))
                    }
                },
            };
            let object = event.as_object_mut().expect("an event is an object");
            for (key, value) in facts {
                object.insert(key, value);
            }
            object.insert("endedAt".into(), json!(now));
            if let Some(duration) = duration {
                object.insert("durationMs".into(), duration);
            }
        }
        _ => {}
    }
}

/// An answer ticket as the command boundary returns it: the boolean once settled, `{ "pendingAnswer": id }` before.
fn ticket_value(ticket: AnswerTicket) -> Value {
    match ticket {
        AnswerTicket::Settled(accepted) => Value::Bool(accepted),
        AnswerTicket::Pending(answer) => json!({ "pendingAnswer": answer.0 }),
    }
}

/// Why a value can't be handed to an agent: an identity holding an unpaired UTF-16 surrogate.
const IDENTITY_REFUSED: &str =
    "An id, path or model holding an unpaired UTF-16 surrogate can't be handed to an agent.";

/// An identity (a Chat key, a request or question id) as the provider gets it: plain, refused rather than replaced
/// (a replacement could make two different identities equal).
fn outbound_identity(text: &str) -> Result<String> {
    jsjson::decode_text_strict(text).map_err(|_| StoreError::Invalid(IDENTITY_REFUSED.into()))
}

/// How each field of a turn's request reaches a provider (the request ChatHost builds for SessionManager.startTurn).
/// A field with no rule is refused: adding one means deciding which it is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Outbound {
    /// Free text the user wrote: an unpaired surrogate becomes U+FFFD on the way out (the saved text keeps it).
    FreeText,
    /// An identity or a setting (ids, paths, model, enum-like names, flags): decoded exactly, or refused.
    Exact,
    /// Images: none is the only value this checkpoint sends (sending images is gated).
    NoImages,
}

const OUTBOUND_REQUEST: [(&str, Outbound); 13] = [
    ("prompt", Outbound::FreeText),
    ("provider", Outbound::Exact),
    ("model", Outbound::Exact),
    ("permissionMode", Outbound::Exact),
    ("effort", Outbound::Exact),
    ("ultracode", Outbound::Exact),
    ("fastMode", Outbound::Exact),
    // A reply style's name ("concise", claude-provider.cjs applyReplyStyle), not text.
    ("replies", Outbound::Exact),
    ("tldrEnabled", Outbound::Exact),
    ("chatId", Outbound::Exact),
    ("cwd", Outbound::Exact),
    ("resumeId", Outbound::Exact),
    ("images", Outbound::NoImages),
];

/// A turn's request as the provider gets it, field by field (`OUTBOUND_REQUEST`): the prompt lossy, every identity
/// exact or refused, images empty, an unknown field refused.
fn outbound_request(request: &Value) -> std::result::Result<RawJson, String> {
    let Value::Object(map) = request else {
        return Err("A turn's request must be an object.".into());
    };
    let mut out = serde_json::Map::new();
    for (key, value) in map {
        let Some((_, rule)) = OUTBOUND_REQUEST.iter().find(|(name, _)| name == key) else {
            return Err(format!(
                "The turn request field \"{key}\" has no outbound rule."
            ));
        };
        let raw = match (rule, value) {
            (Outbound::FreeText, Value::String(text)) => {
                Value::String(jsjson::decode_text_lossy(text))
            }
            (Outbound::NoImages, Value::Array(images)) if images.is_empty() => json!([]),
            (Outbound::NoImages, _) => {
                return Err("Sending images isn't supported by the Rust owner yet.".into())
            }
            (_, other) => {
                RawJson::decode(other)
                    .map_err(|_| IDENTITY_REFUSED.to_string())?
                    .0
            }
        };
        out.insert(key.clone(), raw);
    }
    Ok(RawJson(Value::Object(out)))
}

/// Answers as the provider gets them: question ids (keys) strict, answer strings (free text) lossy.
fn outbound_answers(answers: &Value) -> Result<RawJson> {
    let Value::Object(map) = answers else {
        return RawJson::decode(answers).map_err(|_| StoreError::Invalid(IDENTITY_REFUSED.into()));
    };
    let mut out = serde_json::Map::new();
    for (question, values) in map {
        let values = match values {
            Value::Array(items) => Value::Array(
                items
                    .iter()
                    .map(|item| match item {
                        Value::String(text) => Ok(Value::String(jsjson::decode_text_lossy(text))),
                        other => RawJson::decode(other).map(|raw| raw.0),
                    })
                    .collect::<std::result::Result<_, _>>()
                    .map_err(|_| StoreError::Invalid(IDENTITY_REFUSED.into()))?,
            ),
            other => {
                RawJson::decode(other)
                    .map_err(|_| StoreError::Invalid(IDENTITY_REFUSED.into()))?
                    .0
            }
        };
        out.insert(outbound_identity(question)?, values);
    }
    Ok(RawJson(Value::Object(out)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_outbound_request_field_has_a_rule() {
        let request = json!({ "provider": "kiro", "model": "m", "prompt": "cut \u{10FFFE}\u{F0000}", "chatId": "/p#1", "cwd": "/wt", "images": [] });
        let raw = outbound_request(&request).unwrap().0;
        assert_eq!(raw["prompt"], json!("cut \u{FFFD}"));
        let unknown = json!({ "prompt": "x", "attachments": ["a"] });
        assert!(outbound_request(&unknown)
            .unwrap_err()
            .contains("\"attachments\" has no outbound rule"));
        let images = json!({ "prompt": "x", "images": [{ "path": "/a.png" }] });
        assert!(outbound_request(&images).unwrap_err().contains("images"));
        let identity = json!({ "prompt": "x", "replies": "concise\u{10FFFE}\u{F0001}" });
        assert_eq!(outbound_request(&identity).unwrap_err(), IDENTITY_REFUSED);
    }
}

//! Live events applied to the reduced state, behind the accepted snapshot barrier.
//!
//! Channels and payloads are the ones the owner actually emits (`experiments/rust-runtime/src/actor.rs`, the same as
//! `packages/core/src/runtime.cjs`):
//!
//! - `project:state` `{ path, state }`: the scope's whole state; it replaces the held one.
//! - `agent:event` `{ chatId, event, seq?, state? }`: `state` (when present) replaces the scope's state, which carries
//!   the Chats' message summaries; `event` folds into the Chat's run as `applyRunEvent` in
//!   `packages/shared/src/agent-runs.mjs` does, unless `seq` is at or below the runs' `seq` (already in the runs).
//!
//! A hydrated event (the client replaced `stateTooLarge` with the current deferred state) is applied the same way: its
//! `state` replaces the scope's, as current catch-up state, not as the state at its `wire_seq`. A `version`/`epoch`
//! is taken only from the payload; when the payload has none, the scope's stamp becomes empty rather than keeping a
//! number that no longer describes the state. Every other channel is counted and kept in the bounded tail, never
//! interpreted. Every collection the live state grows has a bound; crossing one closes the stream with a typed error.

use std::collections::BTreeMap;

use gpui::SharedString;
use milagre_gpui_spike::data::{AgentRun, ChatRuns, ContextUsage, OpenProject, PermissionMode, StepKind, StepStatus};
use serde_json::Value;

use crate::{SyncError, map};

/// `MAX_OUTPUT` in `agent-runs.mjs`: a step's detail keeps its last 20,000 UTF-16 units.
pub const MAX_OUTPUT: usize = 20_000;

/// The bounds of the live state, all hard: 0 admits nothing. Defaults are generous for one owned Project; crossing one
/// is [`SyncError::Bound`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LiveBounds {
    /// Chats with a run at once.
    pub runs: usize,
    /// Bytes of one run's streamed text.
    pub run_text: usize,
    /// Steps in one run.
    pub steps: usize,
    /// Open approvals, and open questions, in one run.
    pub requests: usize,
    /// Distinct channel names and agent event types counted by name. More are counted under one `"(other)"` entry:
    /// the one entry allowed beyond this bound (with 0, every name is counted there).
    pub names: usize,
}

impl Default for LiveBounds {
    fn default() -> Self {
        Self { runs: 256, run_text: 4 * 1024 * 1024, steps: 1024, requests: 64, names: 32 }
    }
}

/// What one released event did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Effect {
    /// The scope whose state the event replaced.
    pub state: Option<String>,
    /// The Chat key whose run changed (started, grew, or ended).
    pub run: Option<String>,
    /// The event's `seq` was at or below the runs' `seq`: already in the runs, so its run part was skipped.
    pub already_in_runs: bool,
    /// Why nothing was applied: an unknown channel, a scope this reducer does not hold, an agent event type the run
    /// fold does not change.
    pub ignored: Option<Ignored>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Ignored {
    Channel(String),
    ForeignScope(String),
    AgentEventType(String),
}

/// Running counts since the snapshot was applied.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Counts {
    pub state_replacements: u64,
    pub run_changes: u64,
    pub already_in_runs: u64,
    pub foreign_scope: u64,
    /// Unknown channels by name (bounded; overflow under `"(other)"`).
    pub unknown_channels: BTreeMap<String, u64>,
    /// Agent event types `applyRunEvent` leaves unchanged, by name (bounded likewise).
    pub unreduced_agent_types: BTreeMap<String, u64>,
}

fn count(map: &mut BTreeMap<String, u64>, name: &str, bound: usize) {
    let key = if map.contains_key(name) || map.len() < bound { name } else { "(other)" };
    *map.entry(key.to_owned()).or_default() += 1;
}

/// The project part of a Chat key `<path>#<id>` (`projectOfKey`).
fn project_of_key(key: &str) -> Option<&str> {
    key.rfind('#').map(|at| &key[..at])
}

fn bound(what: &'static str, limit: usize) -> SyncError {
    SyncError::Bound { what, limit }
}

fn invalid(channel: &str, message: impl std::fmt::Display) -> SyncError {
    SyncError::InvalidEvent { channel: channel.to_owned(), message: message.to_string() }
}

/// The live part of the reduced state: the scopes' states and the runs, folded from released events.
pub(crate) struct Live<'a> {
    pub projects: &'a mut Vec<OpenProject>,
    pub runs: &'a mut ChatRuns,
    pub counts: &'a mut Counts,
    pub bounds: LiveBounds,
}

impl Live<'_> {
    pub fn apply(&mut self, channel: &str, payload: &Value) -> Result<Effect, SyncError> {
        match channel {
            "project:state" => {
                let path = payload["path"].as_str().ok_or_else(|| invalid(channel, "payload.path: expected a string"))?;
                self.replace_state(channel, path, payload)
            }
            "agent:event" => self.agent_event(payload),
            other => {
                count(&mut self.counts.unknown_channels, other, self.bounds.names);
                Ok(Effect { ignored: Some(Ignored::Channel(other.to_owned())), ..Effect::default() })
            }
        }
    }

    fn project(&mut self, path: &str) -> Option<&mut OpenProject> {
        self.projects.iter_mut().find(|open| open.project.path.as_ref() == path)
    }

    /// Replaces `path`'s state with the payload's (`state` required unless the event is an `agent:event`).
    fn replace_state(&mut self, channel: &str, path: &str, payload: &Value) -> Result<Effect, SyncError> {
        if payload["stateTooLarge"] == Value::Bool(true) {
            // The client hydrates these before release; one reaching here is never shown as an empty state.
            return Err(SyncError::StateTooLarge { scope: Some(path.to_owned()), method: None });
        }
        let Some(open) = self.project(path) else {
            self.counts.foreign_scope += 1;
            return Ok(Effect { ignored: Some(Ignored::ForeignScope(path.to_owned())), ..Effect::default() });
        };
        let state = map::scope_state(&payload["state"], "payload.state").map_err(|error| invalid(channel, format!("{error:#}")))?;
        let stamp = map::stamp(payload.get("version").filter(|v| !v.is_null()), payload.get("epoch").filter(|v| !v.is_null()), "payload")
            .map_err(|error| invalid(channel, format!("{error:#}")))?;
        open.state = Some(state);
        open.stamp = stamp;
        self.counts.state_replacements += 1;
        Ok(Effect { state: Some(path.to_owned()), ..Effect::default() })
    }

    fn agent_event(&mut self, payload: &Value) -> Result<Effect, SyncError> {
        const CHANNEL: &str = "agent:event";
        let chat = payload["chatId"].as_str().ok_or_else(|| invalid(CHANNEL, "payload.chatId: expected a string"))?;
        let path = project_of_key(chat).ok_or_else(|| invalid(CHANNEL, format!("payload.chatId {chat:?} is not a Chat key")))?;
        if self.project(path).is_none() {
            self.counts.foreign_scope += 1;
            return Ok(Effect { ignored: Some(Ignored::ForeignScope(path.to_owned())), ..Effect::default() });
        }
        let event = &payload["event"];
        let kind = event["type"].as_str().ok_or_else(|| invalid(CHANNEL, "payload.event.type: expected a string"))?;
        let mut effect = Effect::default();
        if payload["stateTooLarge"] == Value::Bool(true) || payload.get("state").is_some_and(|state| !state.is_null()) {
            effect.state = self.replace_state(CHANNEL, path, payload)?.state;
        }
        let seq = match payload.get("seq") {
            None | Some(Value::Null) => None,
            Some(value) => Some(value.as_u64().ok_or_else(|| invalid(CHANNEL, "payload.seq: expected an unsigned integer"))?),
        };
        if seq.is_some_and(|seq| seq <= self.runs.seq) {
            self.counts.already_in_runs += 1;
            effect.already_in_runs = true;
            return Ok(effect);
        }
        let changed = self.run_event(chat, kind, event)?;
        if let Some(seq) = seq {
            self.runs.seq = self.runs.seq.max(seq);
        }
        if changed {
            self.counts.run_changes += 1;
            effect.run = Some(chat.to_owned());
        } else if effect.state.is_none() {
            count(&mut self.counts.unreduced_agent_types, kind, self.bounds.names);
            effect.ignored = Some(Ignored::AgentEventType(kind.to_owned()));
        }
        Ok(effect)
    }

    fn start(&mut self, chat: &str, model: &str, mode: Option<PermissionMode>) -> Result<(), SyncError> {
        if self.runs.runs.len() >= self.bounds.runs {
            return Err(bound("runs", self.bounds.runs));
        }
        let run = AgentRun { model: model.to_owned().into(), permission_mode: mode, ..AgentRun::default() };
        self.runs.runs.insert(chat.to_owned(), run);
        Ok(())
    }

    /// `applyRunEvent`: true when the run changed.
    fn run_event(&mut self, chat: &str, kind: &str, event: &Value) -> Result<bool, SyncError> {
        let decode = |what: &str, error: anyhow::Error| invalid("agent:event", format!("{kind} {what}: {error:#}"));
        let bounds = self.bounds;
        match kind {
            "message-sent" => {
                let Some(run) = self.runs.runs.get_mut(chat) else {
                    let mode = event["permissionMode"].as_str().and_then(permission_mode);
                    self.start(chat, event["model"].as_str().unwrap_or_default(), mode)?;
                    return Ok(true);
                };
                Ok(split(run))
            }
            "turn-started" => {
                let started = !self.runs.runs.contains_key(chat);
                if started {
                    self.start(chat, "", None)?;
                }
                let run = self.runs.runs.get_mut(chat).expect("started");
                match event["turnId"].as_str() {
                    Some(turn) if run.turn_id.as_deref() != Some(turn) => {
                        run.turn_id = Some(turn.to_owned().into());
                        Ok(true)
                    }
                    _ => Ok(started),
                }
            }
            "turn-completed" | "turn-cancelled" | "turn-failed" => Ok(self.runs.runs.remove(chat).is_some()),
            _ => {
                let Some(run) = self.runs.runs.get_mut(chat) else { return Ok(false) };
                match kind {
                    "permission-request" => {
                        let request = map::permission_request(event, "event").map_err(|e| decode("request", e))?;
                        run.approvals.retain(|item| item.request_id != request.request_id);
                        if run.approvals.len() >= bounds.requests {
                            return Err(bound("approvals", bounds.requests));
                        }
                        run.approvals.push(request);
                        Ok(true)
                    }
                    "question-request" => {
                        let request = map::question_request(event, "event").map_err(|e| decode("request", e))?;
                        run.questions.retain(|item| item.request_id != request.request_id);
                        if run.questions.len() >= bounds.requests {
                            return Err(bound("questions", bounds.requests));
                        }
                        run.questions.push(request);
                        Ok(true)
                    }
                    "permission-resolved" | "question-resolved" => {
                        let id = event["requestId"].as_str().unwrap_or_default();
                        let before = run.approvals.len() + run.questions.len();
                        if kind == "permission-resolved" {
                            run.approvals.retain(|item| item.request_id.as_ref() != id);
                        } else {
                            run.questions.retain(|item| item.request_id.as_ref() != id);
                        }
                        let answered = run.answered.remove(id).is_some();
                        Ok(answered || before != run.approvals.len() + run.questions.len())
                    }
                    "subagents-waiting" => {
                        run.waiting_for_subagents = event["waiting"].as_bool().unwrap_or(false);
                        Ok(true)
                    }
                    "context-usage" => {
                        let (Some(used), Some(size)) = (event["used"].as_f64(), event["size"].as_f64()) else {
                            return Err(invalid("agent:event", "context-usage: used and size must be numbers"));
                        };
                        run.context_usage = Some(ContextUsage { used, size });
                        Ok(true)
                    }
                    "answers-sent" => {
                        if !split(run) {
                            run.split = true;
                        }
                        Ok(true)
                    }
                    "text-delta" => {
                        let text = event["text"].as_str().ok_or_else(|| invalid("agent:event", "text-delta: text must be a string"))?;
                        if run.text.len() + text.len() > bounds.run_text {
                            return Err(bound("run text bytes", bounds.run_text));
                        }
                        run.text = format!("{}{text}", run.text).into();
                        run.waiting_for_subagents = false;
                        Ok(true)
                    }
                    "step-started" => {
                        let mut step = map::step(&event["step"], "event.step").map_err(|e| decode("step", e))?;
                        step.detail = step.detail.map(|detail| cap_output(&detail).into());
                        step.status = StepStatus::Running;
                        step.offset = Some(run.text.encode_utf16().count());
                        run.steps.retain(|item| item.id != step.id);
                        if run.steps.len() >= bounds.steps {
                            return Err(bound("steps", bounds.steps));
                        }
                        run.steps.push(step);
                        Ok(true)
                    }
                    "step-output" => {
                        let id = event["id"].as_str().unwrap_or_default();
                        let text = event["text"].as_str().unwrap_or_default();
                        let Some(step) = run.steps.iter_mut().find(|step| step.id.as_ref() == id && step.status == StepStatus::Running)
                        else {
                            return Ok(false);
                        };
                        step.detail = Some(cap_output(&format!("{}{text}", step.detail.as_deref().unwrap_or_default())).into());
                        Ok(true)
                    }
                    "step-completed" => {
                        let id = event["id"].as_str().unwrap_or_default();
                        let Some(step) = run.steps.iter_mut().find(|step| step.id.as_ref() == id) else { return Ok(false) };
                        let end = map::step(&with_step_fields(event, step), "event").map_err(|e| decode("end", e))?;
                        let streamed = step.detail.take();
                        step.status = end.status;
                        step.title = end.title;
                        let text = |key: &str| event[key].as_str().map(|s| SharedString::from(s.to_owned()));
                        if event.get("note").is_some() {
                            step.note = text("note");
                        }
                        step.detail = text("detail").or(if step.kind == Some(StepKind::Thinking) { streamed } else { None });
                        if event.get("durationMs").is_some() {
                            step.duration_ms = end.duration_ms;
                        }
                        if event.get("endedAt").is_some() {
                            step.ended_at = end.ended_at;
                        }
                        if event.get("summary").is_some() {
                            step.summary = end.summary;
                        }
                        if event.get("error").is_some() {
                            step.error = end.error;
                        }
                        if event.get("file").is_some() {
                            step.file = end.file;
                        }
                        if event.get("artifact").is_some() {
                            step.artifact = end.artifact;
                        }
                        Ok(true)
                    }
                    // `applyRunEvent`'s default: later event types change nothing.
                    _ => Ok(false),
                }
            }
        }
    }
}

/// The end event decoded as a step: its own fields over the held step's id, kind and title.
fn with_step_fields(event: &Value, step: &milagre_gpui_spike::data::ChatStep) -> Value {
    let mut end = event.clone();
    end["id"] = Value::String(step.id.to_string());
    if end.get("title").is_none_or(Value::is_null) {
        end["title"] = Value::String(step.title.to_string());
    }
    if let Some(kind) = step.kind {
        end["kind"] = Value::String(step_kind(kind).into());
    }
    end
}

fn step_kind(kind: StepKind) -> &'static str {
    match kind {
        StepKind::Shell => "shell",
        StepKind::Edit => "edit",
        StepKind::Read => "read",
        StepKind::Search => "search",
        StepKind::Other => "other",
        StepKind::Thinking => "thinking",
        StepKind::Setup => "setup",
        StepKind::Image => "image",
        StepKind::Artifact => "artifact",
    }
}

fn permission_mode(value: &str) -> Option<PermissionMode> {
    Some(match value {
        "ask" => PermissionMode::Ask,
        "auto" => PermissionMode::Auto,
        "full" => PermissionMode::Full,
        _ => return None,
    })
}

/// `splitRun`: a steering message saves the text and finished steps above it; running steps carry on at offset 0.
/// False when there is nothing to save yet (the run is left as it is).
fn split(run: &mut AgentRun) -> bool {
    let finished = run.steps.iter().any(|step| step.status != StepStatus::Running);
    if run.text.trim().is_empty() && !finished {
        return false;
    }
    run.steps.retain(|step| step.status == StepStatus::Running);
    for step in &mut run.steps {
        step.offset = Some(0);
    }
    run.text = SharedString::default();
    run.split = true;
    true
}

/// `capOutput`: the end of the text, at most [`MAX_OUTPUT`] UTF-16 units, after a truncation line.
pub fn cap_output(text: &str) -> String {
    if text.encode_utf16().count() <= MAX_OUTPUT {
        return text.to_owned();
    }
    let mut units = 0;
    let mut start = text.len();
    for (at, ch) in text.char_indices().rev() {
        if units + ch.len_utf16() > MAX_OUTPUT {
            break;
        }
        units += ch.len_utf16();
        start = at;
    }
    format!("… truncated\n{}", &text[start..])
}

//! Agent events folded into a Project's state and the turns streaming in it: `packages/shared/src/agent-runs.mjs`
//! (startRun, applyRunEvent, applyAgentEvent, splitRunForSteer), ported for the events this checkpoint supports.
//!
//! A run is kept as the JavaScript object Node keeps (`{ text, model, startedAt, steps, approvals, questions,
//! answered, permissionMode?, turnId?, contextUsage?, split?, steered? }`), so it can be compared and handed to
//! clients as is. Event types whose folding isn't ported yet are refused with [`Unsupported`]: they are never folded
//! halfway (see the README for the list).

use std::sync::Arc;

use serde_json::{json, Map, Value};

use crate::jsjson;
use crate::message_store::{Msg, ProjectState};
use crate::tool_activity::cap_output;

/// Runs by chat key.
pub type Runs = Map<String, Value>;

/// An event type whose folding the Rust owner doesn't do yet.
#[derive(Debug, Clone, PartialEq)]
pub struct Unsupported(pub String);

/// Event types folded elsewhere in Node that this checkpoint refuses instead of approximating: compaction progress
/// (the compaction divider and its gauge come with compaction itself, which is gated).
pub const UNSUPPORTED: [&str; 2] = ["context-compacting", "context-compacted"];

/// A malformed event of a folded type (Node would throw a TypeError and publish it unfolded): refused.
fn malformed(kind: &str, missing: &str) -> Unsupported {
    Unsupported(format!("A \"{kind}\" event without {missing}"))
}

pub fn is_turn_end(event: &Value) -> bool {
    matches!(
        event.get("type").and_then(Value::as_str),
        Some("turn-completed" | "turn-cancelled" | "turn-failed")
    )
}

/// chatKey for this computer: `${projectPath}#${sessionId}`.
pub fn chat_key(project: &str, session: &Value) -> String {
    format!("{project}#{}", jsjson::property_key(Some(session)))
}

/// sessionIdFromKey: the digits after the last `#`, or None.
pub fn session_of_key(key: &str) -> Option<i64> {
    let (_, digits) = key.rsplit_once('#')?;
    (!digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()))
        .then(|| digits.parse().ok())
        .flatten()
}

/// projectOfKey.
pub fn project_of_key(key: &str) -> &str {
    key.rsplit_once('#').map_or(key, |(project, _)| project)
}

fn chat_in_project(project: &str, key: &str) -> bool {
    session_of_key(key).is_some_and(|session| key == chat_key(project, &Value::from(session)))
}

/// lastUserModel: the model of the chat's last user message, else its summary's.
pub fn last_user_model(state: &ProjectState, session: i64) -> Value {
    let last = state.message_list().iter().rev().find(|message| {
        message
            .get("session_id")
            .is_some_and(|id| id.as_f64() == Some(session as f64))
            && message.get("role").and_then(Value::as_str) == Some("user")
    });
    if let Some(last) = last {
        return last
            .get("model")
            .cloned()
            .unwrap_or(Value::String(String::new()));
    }
    state
        .sessions()
        .and_then(|sessions| sessions.get(&session.to_string()))
        .and_then(|session| session.get("summary"))
        .and_then(|summary| summary.get("lastModel"))
        .cloned()
        .unwrap_or(Value::String(String::new()))
}

/// startRun.
pub fn start_run(
    runs: &Runs,
    chat: &str,
    model: &Value,
    permission_mode: Option<&Value>,
    now: i64,
) -> Runs {
    let mut run = Map::new();
    run.insert("text".into(), json!(""));
    run.insert("model".into(), model.clone());
    run.insert("startedAt".into(), json!(now));
    for key in ["steps", "approvals", "questions"] {
        run.insert(key.into(), json!([]));
    }
    run.insert("answered".into(), json!({}));
    if let Some(mode) = permission_mode.filter(|mode| jsjson::truthy(Some(mode))) {
        run.insert("permissionMode".into(), mode.clone());
    }
    let mut next = runs.clone();
    next.insert(chat.into(), Value::Object(run));
    next
}

/// startRun, in place.
fn start_run_mut(
    runs: &mut Runs,
    chat: &str,
    model: &Value,
    permission_mode: Option<&Value>,
    now: i64,
) {
    let run = start_run(&Runs::new(), chat, model, permission_mode, now);
    let (_, run) = run.into_iter().next().expect("one run");
    runs.insert(chat.into(), run);
}

fn array<'a>(run: &'a Map<String, Value>, key: &str) -> &'a [Value] {
    run.get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn text_of(run: &Map<String, Value>) -> &str {
    run.get("text").and_then(Value::as_str).unwrap_or("")
}

/// splitRun: the run once a steering message splits it, or None with nothing to save yet.
fn split_run(run: &Map<String, Value>) -> Option<Map<String, Value>> {
    let finished = array(run, "steps")
        .iter()
        .filter(|step| step.get("status").and_then(Value::as_str) != Some("running"))
        .count();
    if js_trim(text_of(run)).is_empty() && finished == 0 {
        return None;
    }
    let running: Vec<Value> = array(run, "steps")
        .iter()
        .filter(|step| step.get("status").and_then(Value::as_str) == Some("running"))
        .map(|step| {
            let mut step = step.as_object().cloned().unwrap_or_default();
            step.insert("offset".into(), json!(0));
            Value::Object(step)
        })
        .collect();
    let mut next = run.clone();
    next.insert("text".into(), json!(""));
    next.insert("steps".into(), Value::Array(running));
    next.insert("split".into(), json!(true));
    Some(next)
}

fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| {
        matches!(c, '\u{9}'..='\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
    })
}

fn without_request(list: &[Value], id: Option<&Value>) -> Vec<Value> {
    list.iter()
        .filter(|item| {
            !(item
                .get("requestId")
                .is_some_and(|known| id.is_some_and(|id| jsjson::strict_equals(known, id))))
        })
        .cloned()
        .collect()
}

/// applyRunEvent for the supported events.
pub fn apply_run_event(
    runs: &Runs,
    chat: &str,
    event: &Value,
    model: &Value,
    now: i64,
) -> Result<Runs, Unsupported> {
    let mut next = runs.clone();
    apply_run_event_mut(&mut next, chat, event, model, now)?;
    Ok(next)
}

/// applyRunEvent in place: only the Chat's run changes, and only what the event changes (a streamed delta appends to
/// the text it has). An error leaves `runs` untouched: every check comes before the first change.
pub fn apply_run_event_mut(
    runs: &mut Runs,
    chat: &str,
    event: &Value,
    model: &Value,
    now: i64,
) -> Result<(), Unsupported> {
    let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
    if UNSUPPORTED.contains(&kind) {
        return Err(Unsupported(kind.into()));
    }
    if kind == "step-started" && !event.get("step").is_some_and(Value::is_object) {
        return Err(malformed(kind, "a step"));
    }
    if is_turn_end(event) {
        runs.shift_remove(chat);
        return Ok(());
    }
    let has_run = runs.get(chat).is_some_and(Value::is_object);
    match kind {
        "message-sent" if !has_run => {
            start_run_mut(
                runs,
                chat,
                event.get("model").unwrap_or(&Value::Null),
                event.get("permissionMode"),
                now,
            );
            return Ok(());
        }
        "turn-started" if !has_run => start_run_mut(runs, chat, model, None, now),
        _ if !has_run => return Ok(()),
        _ => {}
    }
    let Some(Value::Object(run)) = runs.get_mut(chat) else {
        return Ok(());
    };
    match kind {
        "message-sent" => {
            if let Some(split) = split_run(run) {
                *run = split;
            }
        }
        "turn-started" => {
            if let Some(turn) = event.get("turnId") {
                if run.get("turnId") != Some(turn) {
                    run.insert("turnId".into(), turn.clone());
                }
            }
        }
        "permission-request" | "question-request" => {
            let list = if kind == "permission-request" {
                "approvals"
            } else {
                "questions"
            };
            let mut request = event.as_object().cloned().unwrap_or_default();
            request.shift_remove("type");
            let mut items = without_request(array(run, list), request.get("requestId"));
            items.push(Value::Object(request));
            run.insert(list.into(), Value::Array(items));
        }
        "permission-resolved" | "question-resolved" => {
            let list = if kind == "permission-resolved" {
                "approvals"
            } else {
                "questions"
            };
            let id = event.get("requestId");
            let items = without_request(array(run, list), id);
            let key = jsjson::property_key(id);
            let answered = run.get("answered").and_then(Value::as_object);
            if items.len() == array(run, list).len()
                && !answered.is_some_and(|answered| answered.contains_key(&key))
            {
                return Ok(());
            }
            let mut answered = answered.cloned().unwrap_or_default();
            answered.shift_remove(&key);
            run.insert(list.into(), Value::Array(items));
            run.insert("answered".into(), Value::Object(answered));
        }
        "subagents-waiting" => {
            run.insert(
                "waitingForSubagents".into(),
                event.get("waiting").cloned().unwrap_or(Value::Null),
            );
        }
        "context-usage" => {
            run.insert(
                "contextUsage".into(),
                json!({ "used": event.get("used"), "size": event.get("size") }),
            );
        }
        "text-delta" => {
            let delta = jsjson::property_key(event.get("text"));
            match run.get_mut("text") {
                Some(Value::String(text)) => text.push_str(&delta),
                _ => {
                    let text = format!("{}{delta}", text_of(run));
                    run.insert("text".into(), Value::String(text));
                }
            }
            if jsjson::truthy(run.get("waitingForSubagents")) {
                run.insert("waitingForSubagents".into(), json!(false));
            }
        }
        "answers-sent" => match split_run(run) {
            Some(split) => *run = split,
            None => {
                run.insert("split".into(), json!(true));
            }
        },
        "step-started" => {
            let step = event
                .get("step")
                .and_then(Value::as_object)
                .expect("checked above");
            step_started_mut(run, step);
        }
        "step-output" => {
            if let Some(step) = step_mut(run, event.get("id")) {
                if step.get("status").and_then(Value::as_str) == Some("running") {
                    let delta = js_text_opt(event.get("text"));
                    match step.get_mut("detail") {
                        Some(Value::String(detail)) => {
                            detail.push_str(&delta);
                            cap_output_in_place(detail);
                        }
                        _ => {
                            let detail = match jsjson::nullish(step.get("detail"), None) {
                                Some(detail) => js_text(detail),
                                None => String::new(),
                            };
                            step.insert(
                                "detail".into(),
                                Value::String(cap_output(&format!("{detail}{delta}"))),
                            );
                        }
                    }
                }
            }
        }
        "step-completed" => {
            if let Some(step) = step_mut(run, event.get("id")) {
                let ended = end_step(step, event);
                *step = ended;
            }
        }
        _ => {}
    }
    Ok(())
}

/// capOutput on a string that grew: its end kept (UTF-16 counted) once it passes `MAX_OUTPUT`.
fn cap_output_in_place(text: &mut String) {
    if text.len() > crate::tool_activity::MAX_OUTPUT {
        let capped = cap_output(text);
        if capped != *text {
            *text = capped;
        }
    }
}

/// The step with `id` (strict equality; a missing id matches a missing id), as updateStep finds it.
fn step_mut<'a>(
    run: &'a mut Map<String, Value>,
    id: Option<&Value>,
) -> Option<&'a mut Map<String, Value>> {
    let Some(Value::Array(steps)) = run.get_mut("steps") else {
        return None;
    };
    steps
        .iter_mut()
        .find(
            |step| match (jsjson::defined(step.get("id")), jsjson::defined(id)) {
                (Some(a), Some(b)) => jsjson::strict_equals(a, b),
                (None, None) => true,
                _ => false,
            },
        )
        .and_then(Value::as_object_mut)
}

/// `String(value)` of a string-like value (strings as they are).
fn js_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => jsjson::property_key(Some(other)),
    }
}

fn js_text_opt(value: Option<&Value>) -> String {
    match jsjson::defined(value) {
        Some(value) => js_text(value),
        None => "undefined".into(),
    }
}

fn is_viewed_image(step: &Value) -> bool {
    step.get("kind").and_then(Value::as_str) == Some("image")
        && step.get("imageOrigin").and_then(Value::as_str) == Some("viewed")
}

/// step-started on a run, in place: the step running at the end of the text so far (a viewed image past the 16th is
/// dropped).
fn step_started_mut(run: &mut Map<String, Value>, started: &Map<String, Value>) {
    let id = started.get("id");
    let same = |step: &Value| match (jsjson::defined(step.get("id")), jsjson::defined(id)) {
        (Some(a), Some(b)) => jsjson::strict_equals(a, b),
        (None, None) => true,
        _ => false,
    };
    let viewed = started.get("kind").and_then(Value::as_str) == Some("image")
        && started.get("imageOrigin").and_then(Value::as_str) == Some("viewed");
    let offset = jsjson::utf16_len(text_of(run));
    let steps = array(run, "steps");
    let existing = steps.iter().position(same);
    let admitted = existing.is_some_and(|at| is_viewed_image(&steps[at]));
    if viewed && !admitted && steps.iter().filter(|step| is_viewed_image(step)).count() >= 16 {
        return;
    }
    let mut step = started.clone();
    if let Some(Value::String(detail)) = jsjson::defined(started.get("detail")) {
        step.insert("detail".into(), Value::String(cap_output(detail)));
    }
    step.insert("status".into(), json!("running"));
    step.insert("offset".into(), json!(offset));
    let step = Value::Object(step);
    if !matches!(run.get("steps"), Some(Value::Array(_))) {
        run.insert("steps".into(), json!([]));
    }
    let Some(Value::Array(steps)) = run.get_mut("steps") else {
        unreachable!("set above")
    };
    match existing {
        Some(at) if viewed => steps[at] = step,
        _ => {
            steps.retain(|item| !same(item));
            steps.push(step);
        }
    }
}

/// endStep: tool completion replaces its output; a missing reasoning summary keeps the one already streamed.
fn end_step(step: &Map<String, Value>, end: &Value) -> Map<String, Value> {
    let mut rest = step.clone();
    let streamed = rest.shift_remove("detail");
    let thinking = rest.get("kind").and_then(Value::as_str) == Some("thinking");
    let detail = match jsjson::nullish(end.get("detail"), None) {
        Some(detail) => Some(detail.clone()),
        None if thinking => streamed.filter(|value| !jsjson::is_undefined(value)),
        None => None,
    };
    let or_undefined = |value: Option<&Value>| value.cloned().unwrap_or_else(jsjson::undefined);
    rest.insert("status".into(), or_undefined(end.get("status")));
    let title = or_undefined(jsjson::nullish(end.get("title"), rest.get("title")));
    rest.insert("title".into(), title);
    if let Some(note) = jsjson::defined(end.get("note")) {
        rest.insert("note".into(), note.clone());
    }
    if let Some(detail) = detail {
        rest.insert("detail".into(), detail);
    }
    for key in [
        "durationMs",
        "endedAt",
        "summary",
        "error",
        "file",
        "artifact",
        "routine",
    ] {
        if let Some(value) = jsjson::defined(end.get(key)) {
            rest.insert(key.into(), value.clone());
        }
    }
    rest
}

/// savedSteps (steps aren't folded yet, so a run carries none; ported for the split and end paths regardless).
fn saved_steps(text: &str, steps: &[Value], close_as: &str, into: &mut Map<String, Value>) {
    if steps.is_empty() {
        return;
    }
    let units = jsjson::utf16_len(text);
    let lead = units
        - jsjson::utf16_len(text.trim_start_matches(|c: char| js_trim(&c.to_string()).is_empty()));
    let length = jsjson::utf16_len(js_trim(text)) as f64;
    let saved = steps
        .iter()
        .map(|step| {
            let mut step = step.as_object().cloned().unwrap_or_default();
            let status = step.get("status").and_then(Value::as_str).unwrap_or("");
            if status == "running" {
                let kind = step.get("kind").and_then(Value::as_str);
                step.insert(
                    "status".into(),
                    json!(if kind == Some("thinking") {
                        "done"
                    } else {
                        close_as
                    }),
                );
            }
            let offset = step
                .get("offset")
                .and_then(Value::as_f64)
                .unwrap_or(units as f64);
            step.insert(
                "offset".into(),
                jsjson::number((offset - lead as f64).max(0.0).min(length)),
            );
            Value::Object(step)
        })
        .collect();
    into.insert("steps".into(), Value::Array(saved));
}

fn reply_body(text: &str, event: &Value, has_steps: bool) -> String {
    let reply = js_trim(text);
    match event.get("type").and_then(Value::as_str) {
        Some("turn-failed") => {
            let message = jsjson::property_key(event.get("message"));
            let failure = if jsjson::truthy(event.get("notice")) {
                message
            } else {
                format!("Agent error: {message}")
            };
            if reply.is_empty() {
                failure
            } else {
                format!("{reply}\n\n{failure}")
            }
        }
        Some("turn-cancelled") => reply.to_string(),
        _ => {
            if !reply.is_empty() {
                reply.to_string()
            } else if has_steps {
                String::new()
            } else {
                "The agent finished without a reply.".into()
            }
        }
    }
}

/// The session `id` of a state, as an object (cloned).
fn session_map(state: &ProjectState, session: i64) -> Option<Map<String, Value>> {
    state
        .sessions()?
        .get(&session.to_string())?
        .as_object()
        .cloned()
}

pub fn with_session(state: &ProjectState, session: i64, value: Map<String, Value>) -> ProjectState {
    let mut sessions = state.sessions().cloned().unwrap_or_default();
    sessions.insert(session.to_string(), Value::Object(value));
    state.with_field("sessions", Value::Object(sessions))
}

fn session_messages(state: &ProjectState, session: i64) -> impl Iterator<Item = &Arc<Msg>> {
    state.message_list().iter().filter(move |message| {
        message.get("session_id").and_then(Value::as_f64) == Some(session as f64)
    })
}

/// pendingCompaction: the compaction request (or divider) of the chat that hasn't reached its boundary.
fn pending_compaction(state: &ProjectState, session: i64) -> Option<Arc<Msg>> {
    let request = session_messages(state, session)
        .filter(|message| {
            message
                .get("context")
                .and_then(|c| c.get("kind"))
                .and_then(Value::as_str)
                == Some("compaction")
        })
        .last()?;
    (request
        .get("context")
        .and_then(|c| c.get("status"))
        .and_then(Value::as_str)
        == Some("preparing"))
    .then(|| request.clone())
}

fn with_context(state: &ProjectState, target: &Arc<Msg>, context: Value) -> ProjectState {
    let messages = state
        .message_list()
        .iter()
        .map(|message| {
            if Arc::ptr_eq(message, target) {
                let mut value = message.value().as_object().cloned().unwrap_or_default();
                value.insert("context".into(), context.clone());
                Msg::new(Value::Object(value))
            } else {
                message.clone()
            }
        })
        .collect();
    state.with_messages(messages)
}

fn append(state: &ProjectState, message: Map<String, Value>, next_id: f64) -> ProjectState {
    let mut messages = state.message_list().to_vec();
    messages.push(Msg::new(Value::Object(message)));
    state
        .with_messages(messages)
        .with_field("next_id", jsjson::number(next_id))
}

/// splitRunForSteer in place: the state with the reply so far saved, and whether it changed; the run is split.
pub fn split_run_for_steer_mut(
    state: &ProjectState,
    runs: &mut Runs,
    project: &str,
    chat: &str,
) -> (ProjectState, bool) {
    let (next, split, changed) = split_message(state, runs, project, chat);
    if let Some(split) = split {
        if let Some(run) = runs.get_mut(chat) {
            *run = Value::Object(split);
        }
    }
    (next, changed)
}

/// splitRunForSteer: the reply so far saved as its own message before a steering message joins the turn.
pub fn split_run_for_steer(
    state: &ProjectState,
    runs: &Runs,
    project: &str,
    chat: &str,
) -> (ProjectState, Runs, bool) {
    let mut next_runs = runs.clone();
    let (next, changed) = split_run_for_steer_mut(state, &mut next_runs, project, chat);
    (next, next_runs, changed)
}

/// The state with the reply so far saved, and the run split, without touching `runs`.
fn split_message(
    state: &ProjectState,
    runs: &Runs,
    project: &str,
    chat: &str,
) -> (ProjectState, Option<Map<String, Value>>, bool) {
    let (next, next_runs, changed) = split_on_copy(state, runs, project, chat);
    let split = changed
        .then(|| next_runs.get(chat).and_then(Value::as_object).cloned())
        .flatten();
    (next, split, changed)
}

fn split_on_copy(
    state: &ProjectState,
    runs: &Runs,
    project: &str,
    chat: &str,
) -> (ProjectState, Runs, bool) {
    let Some(session) = session_of_key(chat) else {
        return (state.clone(), runs.clone(), false);
    };
    let run = runs.get(chat).and_then(Value::as_object);
    if !chat_in_project(project, chat) || session_map(state, session).is_none() || run.is_none() {
        return (state.clone(), runs.clone(), false);
    }
    let run = run.unwrap();
    let Some(split) = split_run(run) else {
        return (state.clone(), runs.clone(), false);
    };
    let finished: Vec<Value> = array(run, "steps")
        .iter()
        .filter(|step| step.get("status").and_then(Value::as_str) != Some("running"))
        .cloned()
        .collect();
    let next_id = state
        .get("next_id")
        .and_then(Value::as_f64)
        .unwrap_or(f64::NAN);
    let mut message = Map::new();
    message.insert("id".into(), jsjson::number(next_id));
    message.insert("session_id".into(), json!(session));
    message.insert("body".into(), json!(js_trim(text_of(run))));
    message.insert("context".into(), Value::Null);
    message.insert("role".into(), json!("assistant"));
    message.insert(
        "model".into(),
        run.get("model").cloned().unwrap_or(Value::Null),
    );
    saved_steps(text_of(run), &finished, "done", &mut message);
    let mut next_runs = runs.clone();
    next_runs.insert(chat.into(), Value::Object(split));
    (append(state, message, next_id + 1.0), next_runs, true)
}

/// applyAgentEvent in place: the state after one event and whether it changed and must be saved; only the Chat's run
/// changes in `runs`. An error leaves `runs` untouched (every check comes before the first change).
pub fn apply_agent_event_mut(
    state: &ProjectState,
    runs: &mut Runs,
    project: &str,
    chat: &str,
    event: &Value,
    now: i64,
) -> Result<(ProjectState, bool), Unsupported> {
    let kind = event
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if UNSUPPORTED.contains(&kind.as_str()) {
        return Err(Unsupported(kind));
    }
    let Some(session_id) = session_of_key(chat) else {
        return Ok((state.clone(), false));
    };
    let has_session = state
        .sessions()
        .and_then(|sessions| sessions.get(&session_id.to_string()))
        .is_some_and(Value::is_object);
    if !has_session || !chat_in_project(project, chat) {
        return Ok((state.clone(), false));
    }
    // Event types folded into the run alone (streamed text, steps' output and ends, usage, requests): the session
    // isn't read or copied.
    if !matches!(
        kind.as_str(),
        "session-started"
            | "session-reset"
            | "message-sent"
            | "prompt-suggestion"
            | "subagent-update"
            | "background-tasks"
            | "plan-updated"
            | "tasks-updated"
            | "step-started"
            | "turn-started"
            | "turn-completed"
            | "turn-cancelled"
            | "turn-failed"
    ) {
        apply_run_event_mut(runs, chat, event, &Value::Null, now)?;
        return Ok((state.clone(), false));
    }
    let mut session = session_map(state, session_id).expect("checked above");
    let mut state = state.clone();
    let has_run = runs.get(chat).is_some_and(Value::is_object);
    let clear = matches!(
        kind.as_str(),
        "message-sent" | "turn-started" | "session-reset"
    );
    let suggestion_changed =
        clear && (session.contains_key("suggestion") || session.contains_key("suggestionTurnId"));
    if suggestion_changed {
        session.shift_remove("suggestion");
        session.shift_remove("suggestionTurnId");
        state = with_session(&state, session_id, session.clone());
    }
    Ok(match kind.as_str() {
        "session-started" => {
            if session.get("native_session_id") == event.get("nativeId") {
                (state, false)
            } else {
                session.insert(
                    "native_session_id".into(),
                    event.get("nativeId").cloned().unwrap_or(Value::Null),
                );
                (with_session(&state, session_id, session), true)
            }
        }
        "session-reset" => {
            if !jsjson::truthy(session.get("native_session_id")) {
                (state, suggestion_changed)
            } else {
                session.shift_remove("native_session_id");
                (with_session(&state, session_id, session), true)
            }
        }
        "message-sent" => {
            if has_run {
                let (next, changed) = split_run_for_steer_mut(&state, runs, project, chat);
                if let Some(Value::Object(current)) = runs.get_mut(chat) {
                    current.insert("steered".into(), json!(true));
                }
                (next, changed || suggestion_changed)
            } else {
                apply_run_event_mut(runs, chat, event, &Value::Null, now)?;
                (state, suggestion_changed)
            }
        }
        "prompt-suggestion" => {
            let text = event.get("text").and_then(Value::as_str);
            let turn = event.get("turnId");
            let suggested = !has_run
                && session.get("provider").and_then(Value::as_str) == Some("claude")
                && jsjson::truthy(turn)
                && matches!((turn, session.get("suggestionTurnId")), (Some(a), Some(b)) if jsjson::strict_equals(a, b))
                && text.is_some_and(|text| !js_trim(text).is_empty());
            if !suggested {
                return Ok((state, false));
            }
            session.insert("suggestion".into(), json!({ "text": text, "turnId": turn }));
            (with_session(&state, session_id, session), true)
        }
        "subagent-update" => {
            let Some(agent) = event.get("agent").and_then(Value::as_object) else {
                return Err(malformed(&kind, "an agent"));
            };
            match subagent_update(&session, agent) {
                Some(next) => (with_session(&state, session_id, next), true),
                None => (state, false),
            }
        }
        "background-tasks" => {
            let tasks = match event.get("tasks") {
                Some(Value::Array(tasks)) => tasks.clone(),
                _ => Vec::new(),
            };
            let previous = jsjson::nullish(session.get("backgroundTasks"), None)
                .cloned()
                .unwrap_or(json!([]));
            if jsjson::to_string(&Value::Array(tasks.clone())) == jsjson::to_string(&previous) {
                return Ok((state, false));
            }
            session.shift_remove("backgroundTasks");
            if !tasks.is_empty() {
                session.insert("backgroundTasks".into(), Value::Array(tasks));
            }
            (with_session(&state, session_id, session), true)
        }
        "plan-updated" => {
            session.shift_remove("plan");
            if let Some(plan) = event.get("plan").filter(|plan| jsjson::truthy(Some(plan))) {
                session.insert("plan".into(), plan.clone());
            }
            (with_session(&state, session_id, session), true)
        }
        "tasks-updated" => {
            let Some(Value::Array(tasks)) = event.get("tasks") else {
                return Err(malformed(&kind, "tasks"));
            };
            match native_plan(session.get("plan"), tasks, now) {
                NativePlan::Same => (state, false),
                plan => {
                    session.shift_remove("plan");
                    if let NativePlan::New(plan) = plan {
                        session.insert("plan".into(), plan);
                    }
                    (with_session(&state, session_id, session), true)
                }
            }
        }
        "step-started" => {
            let Some(step) = event.get("step").and_then(Value::as_object) else {
                return Err(malformed(&kind, "a step"));
            };
            let compaction_step = step
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| id.starts_with("compact-"));
            if compaction_step && pending_compaction(&state, session_id).is_some() {
                return Ok((state, false));
            }
            let steered = runs
                .get(chat)
                .and_then(Value::as_object)
                .is_some_and(|run| {
                    jsjson::truthy(run.get("steered")) && !js_trim(text_of(run)).is_empty()
                });
            if steered {
                let (split_state, changed) = split_run_for_steer_mut(&state, runs, project, chat);
                if let Some(Value::Object(current)) = runs.get_mut(chat) {
                    current.shift_remove("steered");
                }
                apply_run_event_mut(runs, chat, event, &Value::Null, now)?;
                (split_state, changed)
            } else {
                apply_run_event_mut(runs, chat, event, &Value::Null, now)?;
                (state, false)
            }
        }
        "turn-started" => {
            let model = last_user_model(&state, session_id);
            apply_run_event_mut(runs, chat, event, &model, now)?;
            (state, suggestion_changed)
        }
        "turn-completed" | "turn-cancelled" | "turn-failed" => {
            if !has_run {
                return Ok((state, false));
            }
            // The run ends here: taken out (no copy), as applyRunEvent removes it.
            let Some(Value::Object(run)) = runs.shift_remove(chat) else {
                unreachable!("has a run")
            };
            let completed = kind == "turn-completed";
            let suggestion_turn =
                if completed && session.get("provider").and_then(Value::as_str) == Some("claude") {
                    run.get("turnId")
                        .cloned()
                        .filter(|turn| jsjson::truthy(Some(turn)))
                } else {
                    None
                };
            let suggestion_updated = suggestion_turn.is_some()
                || session.contains_key("suggestion")
                || session.contains_key("suggestionTurnId");
            if suggestion_updated {
                session.shift_remove("suggestion");
                session.shift_remove("suggestionTurnId");
                if let Some(turn) = suggestion_turn {
                    session.insert("suggestionTurnId".into(), turn);
                }
                state = with_session(&state, session_id, session.clone());
            }
            let context_usage = run.get("contextUsage").cloned();
            if let Some(usage) = &context_usage {
                let mut with_usage = session.clone();
                with_usage.insert("contextUsage".into(), usage.clone());
                state = with_session(&state, session_id, with_usage);
            }
            let unfinished = pending_compaction(&state, session_id);
            if let Some(request) = &unfinished {
                let mut context = request
                    .get("context")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                context.insert("status".into(), json!("failed"));
                state = with_context(&state, request, Value::Object(context));
            }
            let text = text_of(&run).to_string();
            let steps = array(&run, "steps");
            if completed
                && jsjson::truthy(run.get("split"))
                && js_trim(&text).is_empty()
                && steps.is_empty()
            {
                return Ok((
                    state,
                    context_usage.is_some() || unfinished.is_some() || suggestion_updated,
                ));
            }
            let last_user = session_messages(&state, session_id)
                .filter(|m| m.get("role").and_then(Value::as_str) == Some("user"))
                .last()
                .cloned();
            let compaction_request = last_user.is_some_and(|m| {
                m.get("context")
                    .and_then(|c| c.get("kind"))
                    .and_then(Value::as_str)
                    == Some("compaction")
            });
            if completed && js_trim(&text).is_empty() && steps.is_empty() && compaction_request {
                return Ok((state, true));
            }
            let next_id = state
                .get("next_id")
                .and_then(Value::as_f64)
                .unwrap_or(f64::NAN);
            let mut message = Map::new();
            message.insert("id".into(), jsjson::number(next_id));
            message.insert("session_id".into(), json!(session_id));
            message.insert(
                "body".into(),
                Value::String(reply_body(&text, event, !steps.is_empty())),
            );
            let limit = event
                .get("limit")
                .filter(|_| kind == "turn-failed" && jsjson::truthy(event.get("limit")));
            let context = match limit.and_then(Value::as_object) {
                Some(limit) => {
                    let mut context = Map::new();
                    context.insert("kind".into(), json!("limit"));
                    for (key, value) in limit {
                        context.insert(key.clone(), value.clone());
                    }
                    Value::Object(context)
                }
                None => Value::Null,
            };
            message.insert("context".into(), context);
            message.insert("role".into(), json!("assistant"));
            message.insert(
                "model".into(),
                run.get("model").cloned().unwrap_or(Value::Null),
            );
            let outcome = match kind.as_str() {
                "turn-completed" => "completed",
                "turn-cancelled" => "cancelled",
                _ => "failed",
            };
            message.insert("outcome".into(), json!(outcome));
            if let Some(credits) = event
                .get("credits")
                .filter(|credits| completed && credits.as_f64().is_some_and(f64::is_finite))
            {
                message.insert("credits".into(), credits.clone());
            }
            saved_steps(
                &text,
                steps,
                if completed { "done" } else { "failed" },
                &mut message,
            );
            (append(&state, message, next_id + 1.0), true)
        }
        _ => {
            apply_run_event_mut(runs, chat, event, &Value::Null, now)?;
            (state, false)
        }
    })
}

/// applyAgentEvent: the state and runs after one event, and whether the state changed and must be saved.
pub fn apply_agent_event(
    state: &ProjectState,
    runs: &Runs,
    project: &str,
    chat: &str,
    event: &Value,
    now: i64,
) -> Result<(ProjectState, Runs, bool), Unsupported> {
    let mut next = runs.clone();
    let (state, changed) = apply_agent_event_mut(state, &mut next, project, chat, event, now)?;
    Ok((state, next, changed))
}

/// Event types whose fold may change the saved state and the Chat's run together: the fold keeps a copy of that run
/// to put back if the change can't be kept (`ChatHost::fold`). Every other type changes either the run alone (never
/// failing after it does) or the state alone.
pub fn may_change_run_and_state(event: &Value, runs: &Runs, chat: &str) -> bool {
    match event.get("type").and_then(Value::as_str) {
        Some(
            "message-sent" | "turn-started" | "turn-completed" | "turn-cancelled" | "turn-failed",
        ) => true,
        Some("step-started") => runs
            .get(chat)
            .and_then(Value::as_object)
            .is_some_and(|run| {
                jsjson::truthy(run.get("steered")) && !js_trim(text_of(run)).is_empty()
            }),
        _ => false,
    }
}

/// patchSession for the fields the host sets on a turn's end (`unread`).
pub fn patch_unread(state: &ProjectState, session: i64) -> ProjectState {
    let Some(mut current) = session_map(state, session) else {
        return state.clone();
    };
    if current.get("unread") == Some(&Value::Bool(true)) {
        return state.clone();
    }
    current.insert("unread".into(), json!(true));
    with_session(state, session, current)
}

/// archiveFinishedSubagents with `keepAdvisors`.
pub fn archive_finished_subagents(state: &ProjectState, session: i64) -> ProjectState {
    let Some(mut current) = session_map(state, session) else {
        return state.clone();
    };
    let finished = |agent: &Value| {
        !jsjson::truthy(agent.get("archived"))
            && matches!(
                agent.get("status").and_then(Value::as_str),
                Some("completed" | "failed" | "cancelled")
            )
            && agent.get("source").and_then(Value::as_str) != Some("milagre-advisor")
    };
    let Some(Value::Array(agents)) = current.get("subagents") else {
        return state.clone();
    };
    if !agents.iter().any(finished) {
        return state.clone();
    }
    let agents: Vec<Value> = agents
        .iter()
        .map(|agent| {
            if finished(agent) {
                let mut agent = agent.as_object().cloned().unwrap_or_default();
                agent.insert("archived".into(), json!(true));
                Value::Object(agent)
            } else {
                agent.clone()
            }
        })
        .collect();
    current.insert("subagents".into(), Value::Array(agents));
    with_session(state, session, current)
}

// ---- subagents, plans, answers --------------------------------------------------------------------------------

/// `a === b` for property values that may be missing (`undefined`).
fn same_value(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (jsjson::defined(a), jsjson::defined(b)) {
        (Some(a), Some(b)) => jsjson::strict_equals(a, b),
        (None, None) => true,
        _ => false,
    }
}

/// JavaScript `ToNumber` for the values JSON holds (`undefined` and objects are NaN).
fn to_number(value: Option<&Value>) -> f64 {
    match jsjson::defined(value) {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(flag)) => f64::from(u8::from(*flag)),
        Some(Value::Number(number)) => jsjson::as_f64(number),
        Some(Value::String(text)) => {
            let text = js_trim(text);
            if text.is_empty() {
                0.0
            } else {
                text.parse::<f64>()
                    .ok()
                    .filter(|_| !text.contains(|c: char| c.is_alphabetic() && c != 'e' && c != 'E'))
                    .unwrap_or(f64::NAN)
            }
        }
        Some(_) => f64::NAN,
    }
}

/// JavaScript `a > b`: strings by UTF-16 code units, anything else as numbers.
fn js_greater(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (jsjson::defined(a), jsjson::defined(b)) {
        (Some(Value::String(a)), Some(Value::String(b))) => {
            jsjson::to_utf16(a) > jsjson::to_utf16(b)
        }
        _ => to_number(a) > to_number(b),
    }
}

fn subagent_active(agent: Option<&Value>) -> bool {
    matches!(
        agent
            .and_then(|agent| agent.get("status"))
            .and_then(Value::as_str),
        Some("initializing" | "running" | "waiting")
    )
}

fn has_transcript_tail(agent: Option<&Value>) -> bool {
    matches!(
        agent.and_then(|agent| agent.get("transcriptLength")),
        Some(Value::Number(_))
    )
}

/// The SameValueZero key of a JavaScript Map keyed by a transcript entry's id.
fn map_key(value: Option<&Value>) -> String {
    match jsjson::defined(value) {
        None => "u".into(),
        Some(Value::Null) => "n".into(),
        Some(Value::Bool(flag)) => format!("b{flag}"),
        Some(Value::Number(number)) => format!("#{}", jsjson::f64_to_js(jsjson::as_f64(number))),
        Some(Value::String(text)) => format!("s{text}"),
        // Objects and arrays are distinct references: never one key.
        Some(other) => format!("o{:p}", other as *const Value),
    }
}

/// applyAgentEvent's subagent-update on a session: the session with the agent added or merged, or None for no change.
fn subagent_update(
    session: &Map<String, Value>,
    agent: &Map<String, Value>,
) -> Option<Map<String, Value>> {
    let native = session.get("native_session_id");
    if same_value(agent.get("id"), native) {
        return None;
    }
    let children: Vec<Value> = match jsjson::nullish(session.get("subagents"), None) {
        Some(Value::Array(items)) => items
            .iter()
            .filter(|child| !same_value(child.get("id"), native))
            .cloned()
            .collect(),
        _ => Vec::new(),
    };
    let incoming = Value::Object(agent.clone());
    let previous = children
        .iter()
        .find(|child| same_value(child.get("id"), agent.get("id")))
        .cloned();
    if previous
        .as_ref()
        .is_some_and(|previous| js_greater(previous.get("updatedAt"), agent.get("updatedAt")))
    {
        return None;
    }
    let tail = has_transcript_tail(Some(&incoming)) || has_transcript_tail(previous.as_ref());
    let mut merged = match &previous {
        None => agent.clone(),
        Some(previous) => {
            let old = previous.as_object().cloned().unwrap_or_default();
            let mut next = old.clone();
            for (key, value) in agent {
                next.insert(key.clone(), value.clone());
            }
            let undefined_or =
                |value: Option<&Value>| value.cloned().unwrap_or_else(jsjson::undefined);
            let archived = if jsjson::truthy(old.get("archived")) {
                json!(!(!subagent_active(Some(previous)) && subagent_active(Some(&incoming))))
            } else {
                undefined_or(old.get("archived"))
            };
            next.insert("archived".into(), archived);
            let title = if agent.get("title").and_then(Value::as_str) == Some("Subagent") {
                old.get("title")
            } else {
                agent.get("title")
            };
            next.insert("title".into(), undefined_or(title));
            for key in ["prompt", "parentId"] {
                next.insert(
                    key.into(),
                    undefined_or(jsjson::nullish(agent.get(key), None).or(old.get(key))),
                );
            }
            let started = to_number(old.get("startedAt")).min(to_number(agent.get("startedAt")));
            let started = if to_number(old.get("startedAt")).is_nan()
                || to_number(agent.get("startedAt")).is_nan()
            {
                f64::NAN
            } else {
                started
            };
            next.insert("startedAt".into(), jsjson::number(started));
            let transcript =
                if agent.get("source").and_then(Value::as_str) == Some("milagre-advisor") || tail {
                    undefined_or(agent.get("transcript"))
                } else {
                    let mut entries: indexmap_like::Ordered = indexmap_like::Ordered::default();
                    for list in [old.get("transcript"), agent.get("transcript")] {
                        if let Some(Value::Array(items)) = list {
                            for entry in items {
                                entries.insert(map_key(entry.get("id")), entry.clone());
                            }
                        }
                    }
                    let all = entries.values();
                    Value::Array(all[all.len().saturating_sub(100)..].to_vec())
                };
            next.insert("transcript".into(), transcript);
            for key in ["transcriptLength", "endedAt", "detailsOnDemand"] {
                next.insert(key.into(), undefined_or(agent.get(key)));
            }
            next
        }
    };
    for key in ["transcriptLength", "endedAt", "detailsOnDemand"] {
        if merged.get(key).is_none_or(jsjson::is_undefined) {
            merged.shift_remove(key);
        }
    }
    let merged = Value::Object(merged);
    let subagents: Vec<Value> = if previous.is_some() {
        children
            .iter()
            .map(|child| {
                if same_value(child.get("id"), merged.get("id")) {
                    merged.clone()
                } else {
                    child.clone()
                }
            })
            .collect()
    } else {
        children
            .into_iter()
            .chain(std::iter::once(merged))
            .collect()
    };
    let mut next = session.clone();
    next.insert("subagents".into(), Value::Array(subagents));
    Some(next)
}

/// A JavaScript Map's insertion order with replaced values, for the transcript merge.
mod indexmap_like {
    use serde_json::Value;

    #[derive(Default)]
    pub struct Ordered {
        keys: Vec<String>,
        values: std::collections::HashMap<String, Value>,
    }

    impl Ordered {
        pub fn insert(&mut self, key: String, value: Value) {
            if !self.values.contains_key(&key) {
                self.keys.push(key.clone());
            }
            self.values.insert(key, value);
        }

        pub fn values(&self) -> Vec<Value> {
            self.keys
                .iter()
                .map(|key| self.values[key].clone())
                .collect()
        }
    }
}

/// What nativePlan decided.
enum NativePlan {
    /// The plan as it is (Milagre's tools own it, or the same list again): no change.
    Same,
    /// No tasks and no phases: the plan goes.
    Clear,
    New(Value),
}

/// nativePlan (shared/chat-plan.mjs): a provider's own flat todo list as the plan, unless Milagre's tools own it.
fn native_plan(plan: Option<&Value>, tasks: &[Value], now: i64) -> NativePlan {
    let plan = jsjson::defined(plan).filter(|plan| !plan.is_null());
    let source = plan
        .and_then(|plan| plan.get("source"))
        .and_then(Value::as_str);
    if source == Some("milagre") {
        return NativePlan::Same;
    }
    let phases = plan
        .and_then(|plan| jsjson::nullish(plan.get("phases"), None))
        .cloned()
        .unwrap_or(json!([]));
    let no_phases = phases.as_array().is_some_and(Vec::is_empty);
    if tasks.is_empty() && no_phases {
        // `undefined === session.plan` is no change only when there was no plan.
        return if plan.is_none() {
            NativePlan::Same
        } else {
            NativePlan::Clear
        };
    }
    let undefined_or = |value: Option<&Value>| value.cloned().unwrap_or_else(jsjson::undefined);
    let mapped: Vec<Value> = tasks
        .iter()
        .map(|task| {
            let mut item = Map::new();
            item.insert("id".into(), undefined_or(task.get("id")));
            item.insert("title".into(), undefined_or(task.get("content")));
            if let Some(form) = task
                .get("activeForm")
                .filter(|form| jsjson::truthy(Some(form)))
            {
                item.insert("activeForm".into(), form.clone());
            }
            item.insert("status".into(), undefined_or(task.get("status")));
            Value::Object(item)
        })
        .collect();
    if source == Some("native") {
        if let Some(Value::Array(known)) = plan.and_then(|plan| plan.get("tasks")) {
            let same = known.len() == mapped.len()
                && known.iter().zip(&mapped).all(|(a, b)| {
                    ["id", "title", "activeForm", "status"]
                        .iter()
                        .all(|key| same_value(a.get(*key), b.get(*key)))
                });
            if same {
                return NativePlan::Same;
            }
        }
    }
    NativePlan::New(
        json!({ "source": "native", "tasks": mapped, "phases": phases, "updatedAt": now }),
    )
}

/// answeredQuestions: each answered question of the request with what was answered (a typed secret masked), or None.
pub fn answered_questions(request: Option<&Value>, answers: &Value) -> Option<Value> {
    let request = request.filter(|request| jsjson::truthy(Some(request)))?;
    if !jsjson::truthy(Some(answers)) {
        return None;
    }
    let questions = request.get("questions").and_then(Value::as_array)?;
    let undefined_or = |value: Option<&Value>| value.cloned().unwrap_or_else(jsjson::undefined);
    let answered: Vec<Value> = questions
        .iter()
        .filter_map(|question| {
            let key = jsjson::property_key(question.get("id"));
            let values = match answers.get(&key) {
                Some(Value::Array(values)) if !values.is_empty() => values,
                _ => return None,
            };
            let secret = jsjson::truthy(question.get("secret"));
            let options = question
                .get("options")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let shown: Vec<Value> = values
                .iter()
                .map(|value| {
                    let offered = options.iter().any(|option| {
                        option
                            .get("label")
                            .is_some_and(|label| jsjson::strict_equals(label, value))
                    });
                    if secret && !offered {
                        json!("••••••")
                    } else {
                        value.clone()
                    }
                })
                .collect();
            let mut item = Map::new();
            item.insert("header".into(), undefined_or(question.get("header")));
            item.insert("question".into(), undefined_or(question.get("question")));
            item.insert("answers".into(), Value::Array(shown));
            Some(Value::Object(item))
        })
        .collect();
    (!answered.is_empty()).then_some(Value::Array(answered))
}

/// recordAnswers: the user's answers as their message after the reply so far (split as for a steering message), the
/// run marked split, and the new message's id; None when there's nothing to show.
pub fn record_answers(
    state: &ProjectState,
    runs: &Runs,
    project: &str,
    chat: &str,
    body: &str,
    answered: Option<Value>,
    now: i64,
) -> Option<(ProjectState, Runs, f64)> {
    let session = session_of_key(chat)?;
    let run = runs.get(chat).and_then(Value::as_object)?;
    if !chat_in_project(project, chat) || session_map(state, session).is_none() || body.is_empty() {
        return None;
    }
    let (split, _, _) = split_run_for_steer(state, runs, project, chat);
    let id = split
        .get("next_id")
        .and_then(Value::as_f64)
        .unwrap_or(f64::NAN);
    let mut message = Map::new();
    message.insert("id".into(), jsjson::number(id));
    message.insert("session_id".into(), json!(session));
    message.insert("body".into(), json!(body));
    message.insert("context".into(), Value::Null);
    message.insert("role".into(), json!("user"));
    message.insert(
        "model".into(),
        run.get("model").cloned().unwrap_or(Value::Null),
    );
    if let Some(answered) =
        answered.filter(|answered| answered.as_array().is_some_and(|items| !items.is_empty()))
    {
        message.insert("answered".into(), answered);
    }
    let next_runs = apply_run_event(
        runs,
        chat,
        &json!({ "type": "answers-sent" }),
        &Value::Null,
        now,
    )
    .ok()?;
    Some((append(&split, message, id + 1.0), next_runs, id))
}

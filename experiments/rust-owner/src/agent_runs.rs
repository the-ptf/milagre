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

/// Runs by chat key.
pub type Runs = Map<String, Value>;

/// An event type whose folding the Rust owner doesn't do yet.
#[derive(Debug, Clone, PartialEq)]
pub struct Unsupported(pub String);

/// Event types folded elsewhere in Node that this checkpoint refuses instead of approximating.
pub const UNSUPPORTED: [&str; 11] = [
    "step-started",
    "step-output",
    "step-completed",
    "subagent-update",
    "background-tasks",
    "plan-updated",
    "tasks-updated",
    "prompt-suggestion",
    "context-compacting",
    "context-compacted",
    "answers-sent",
];

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
    let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
    if UNSUPPORTED.contains(&kind) {
        return Err(Unsupported(kind.into()));
    }
    let run = runs.get(chat).and_then(Value::as_object);
    let with = |run: Map<String, Value>| {
        let mut next = runs.clone();
        next.insert(chat.into(), Value::Object(run));
        next
    };
    Ok(match kind {
        "message-sent" => match run {
            None => start_run(
                runs,
                chat,
                event.get("model").unwrap_or(&Value::Null),
                event.get("permissionMode"),
                now,
            ),
            Some(run) => split_run(run).map(with).unwrap_or_else(|| runs.clone()),
        },
        "turn-started" => {
            let next = if run.is_some() {
                runs.clone()
            } else {
                start_run(runs, chat, model, None, now)
            };
            let current = next[chat].as_object().cloned().unwrap_or_default();
            match event.get("turnId") {
                Some(turn) if current.get("turnId") != Some(turn) => {
                    let mut current = current;
                    current.insert("turnId".into(), turn.clone());
                    let mut next = next;
                    next.insert(chat.into(), Value::Object(current));
                    next
                }
                _ => next,
            }
        }
        "permission-request" | "question-request" => {
            let Some(run) = run else {
                return Ok(runs.clone());
            };
            let list = if kind == "permission-request" {
                "approvals"
            } else {
                "questions"
            };
            let mut request = event.as_object().cloned().unwrap_or_default();
            request.shift_remove("type");
            let mut items = without_request(array(run, list), request.get("requestId"));
            items.push(Value::Object(request));
            let mut run = run.clone();
            run.insert(list.into(), Value::Array(items));
            with(run)
        }
        "permission-resolved" | "question-resolved" => {
            let Some(run) = run else {
                return Ok(runs.clone());
            };
            let list = if kind == "permission-resolved" {
                "approvals"
            } else {
                "questions"
            };
            let id = event.get("requestId");
            let items = without_request(array(run, list), id);
            let key = jsjson::property_key(id);
            let answered = run
                .get("answered")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            if items.len() == array(run, list).len() && !answered.contains_key(&key) {
                return Ok(runs.clone());
            }
            let mut answered = answered;
            answered.shift_remove(&key);
            let mut run = run.clone();
            run.insert(list.into(), Value::Array(items));
            run.insert("answered".into(), Value::Object(answered));
            with(run)
        }
        "subagents-waiting" => match run {
            Some(run) => {
                let mut run = run.clone();
                run.insert(
                    "waitingForSubagents".into(),
                    event.get("waiting").cloned().unwrap_or(Value::Null),
                );
                with(run)
            }
            None => runs.clone(),
        },
        "context-usage" => match run {
            Some(run) => {
                let mut run = run.clone();
                run.insert(
                    "contextUsage".into(),
                    json!({ "used": event.get("used"), "size": event.get("size") }),
                );
                with(run)
            }
            None => runs.clone(),
        },
        "text-delta" => match run {
            Some(run) => {
                let mut run = run.clone();
                let text = format!(
                    "{}{}",
                    text_of(&run),
                    jsjson::property_key(event.get("text"))
                );
                run.insert("text".into(), Value::String(text));
                if jsjson::truthy(run.get("waitingForSubagents")) {
                    run.insert("waitingForSubagents".into(), json!(false));
                }
                with(run)
            }
            None => runs.clone(),
        },
        "turn-completed" | "turn-cancelled" | "turn-failed" => {
            let mut next = runs.clone();
            next.shift_remove(chat);
            next
        }
        _ => runs.clone(),
    })
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

/// splitRunForSteer: the reply so far saved as its own message before a steering message joins the turn.
pub fn split_run_for_steer(
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

/// applyAgentEvent: the state and runs after one event, and whether the state changed and must be saved.
pub fn apply_agent_event(
    state: &ProjectState,
    runs: &Runs,
    project: &str,
    chat: &str,
    event: &Value,
    now: i64,
) -> Result<(ProjectState, Runs, bool), Unsupported> {
    let kind = event
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if UNSUPPORTED.contains(&kind.as_str()) {
        return Err(Unsupported(kind));
    }
    let Some(session_id) = session_of_key(chat) else {
        return Ok((state.clone(), runs.clone(), false));
    };
    let Some(mut session) = session_map(state, session_id) else {
        return Ok((state.clone(), runs.clone(), false));
    };
    if !chat_in_project(project, chat) {
        return Ok((state.clone(), runs.clone(), false));
    }
    let mut state = state.clone();
    let run = runs.get(chat).and_then(Value::as_object).cloned();
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
                (state, runs.clone(), false)
            } else {
                session.insert(
                    "native_session_id".into(),
                    event.get("nativeId").cloned().unwrap_or(Value::Null),
                );
                (
                    with_session(&state, session_id, session),
                    runs.clone(),
                    true,
                )
            }
        }
        "session-reset" => {
            if !jsjson::truthy(session.get("native_session_id")) {
                (state, runs.clone(), suggestion_changed)
            } else {
                session.shift_remove("native_session_id");
                (
                    with_session(&state, session_id, session),
                    runs.clone(),
                    true,
                )
            }
        }
        "message-sent" => {
            if run.is_some() {
                let (next, mut next_runs, changed) =
                    split_run_for_steer(&state, runs, project, chat);
                if let Some(Value::Object(current)) = next_runs.get_mut(chat) {
                    current.insert("steered".into(), json!(true));
                }
                (next, next_runs, changed || suggestion_changed)
            } else {
                let next_runs = apply_run_event(runs, chat, event, &Value::Null, now)?;
                (state, next_runs, suggestion_changed)
            }
        }
        "turn-started" => {
            let model = last_user_model(&state, session_id);
            (
                state,
                apply_run_event(runs, chat, event, &model, now)?,
                suggestion_changed,
            )
        }
        "turn-completed" | "turn-cancelled" | "turn-failed" => {
            let Some(run) = run else {
                return Ok((state, runs.clone(), false));
            };
            let remaining = apply_run_event(runs, chat, event, &Value::Null, now)?;
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
            let steps = array(&run, "steps").to_vec();
            if completed
                && jsjson::truthy(run.get("split"))
                && js_trim(&text).is_empty()
                && steps.is_empty()
            {
                return Ok((
                    state,
                    remaining,
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
                return Ok((state, remaining, true));
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
                &steps,
                if completed { "done" } else { "failed" },
                &mut message,
            );
            (append(&state, message, next_id + 1.0), remaining, true)
        }
        _ => {
            let next_runs = apply_run_event(runs, chat, event, &Value::Null, now)?;
            (state, next_runs, false)
        }
    })
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

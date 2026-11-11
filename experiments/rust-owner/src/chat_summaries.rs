//! Each Chat's summary (`session.summary`), kept current in every change that is kept: packages/core/src/
//! chat-summaries.cjs `withChatSummaries` over shared/src/chat-summary.mjs `summarizeChat` (with chat-pull-requests.mjs
//! `pullRequestRefs`). Node runs it in `compactProjectState`, after `compactProjectDetails`, on every change
//! ProjectStates keeps (`ProjectStates::try_update`) and on the state it first reads from disk with no `previous`
//! (`open_slot`), where every Chat's summary is made again from its messages and nothing is stamped (a stale seed
//! such as `count: 0` is corrected there).
//!
//! Only Chats whose messages may have changed, or that have no summary yet, are summarized again. An unloaded Chat
//! (messages not in the state) keeps its summary. `lastAt` and `firstAt` are stamped from the states clock when a Chat
//! gets a message or a reply ends; a Link reaching a Chat (`worktree-linked` lines only) isn't activity.
//!
//! Cost of one kept change (still linear in the loaded messages, as Node's `byChat` is; not "only the Chats touched"):
//! - Messages and the state's other keys the same objects as before: nothing (one pointer check).
//! - Messages the same, other keys changed: a value comparison of the sessions, then nothing unless a Chat has no
//!   summary.
//! - Messages changed: one pointer walk of both lists for their common prefix and suffix (the Chats with a message in
//!   between are the touched ones), one walk of the loaded messages keeping only touched Chats' and summary-less
//!   Chats' (a key built per message), one walk of the previous messages for touched Chats, a pass over every session,
//!   and `summarizeChat` for the touched Chats only. A touched Chat's list is compared with its previous one by
//!   identity, then by value.
//! - Any summary changed: the state's other keys (every session's JSON, unrelated transcripts included) are copied
//!   once, since they live in one shared map; only the changed sessions are rebuilt.
//! - The first read (no previous state): every loaded Chat is summarized.
//!
//! Measured (release build, `tests/chat_summaries.rs` `measure_summary_overhead`: 900 loaded Chats, 3,600 messages,
//! 45,000 steps, a 4 KB transcript on every session, about 3.6 MB of session JSON): appending one message to one Chat
//! about 0.9-1.5 ms (2.2-3.9 ms before the touched-Chat walk and the single copy), of which the copy is about
//! 0.5 ms; the same messages with another key changed about 0.3-0.4 ms; an unchanged state under 1 microsecond (was
//! 0.3 ms); the first read 12-16 ms. Nothing is cached between changes, so nothing is retained.
//!
//! Sessions are compared by value where Node compares the object (`next.sessions === previous.sessions`): the same
//! result unless a change replaced the sessions with an equal copy while a loaded Chat had no summary. After the first
//! read every loaded Chat has one, and taking one away changes the sessions, so that case needs a summary-less loaded
//! Chat that the first read didn't summarize.
//!
//! Deliberate differences, on malformed data only (where Node throws and the whole compaction is skipped): a body that
//! isn't a string doesn't name the Chat, a session that isn't an object is left as is, and `sessions` that isn't an
//! object leaves the state as is.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::{Arc, OnceLock};

use regex::Regex;
use serde_json::{Map, Value};

use crate::jsjson;
use crate::message_store::{MsgRef, ProjectState};
use crate::tool_activity::{js_trim, slice16};

/// JavaScript `\s`, as a character class body.
const JS_SPACE: &str = r"\t\n\x0B\x0C\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}";

fn regex(cell: &'static OnceLock<Regex>, pattern: impl FnOnce() -> String) -> &'static Regex {
    cell.get_or_init(|| Regex::new(&pattern()).expect("a valid pattern"))
}

fn pr_url() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    regex(&CELL, || {
        format!(r"^https?://[^{JS_SPACE}/]+/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/[0-9]+$")
    })
}

fn repo() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    regex(&CELL, || r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$".into())
}

fn creates() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    regex(&CELL, || {
        format!(r"(?-u:\b)gh[{JS_SPACE}]+pr[{JS_SPACE}]+create(?-u:\b)")
    })
}

fn merges() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    regex(&CELL, || {
        format!(r"(?-u:\b)gh[{JS_SPACE}]+pr[{JS_SPACE}]+merge(?-u:\b)([^\n;&|]*)")
    })
}

fn words() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    regex(&CELL, || format!(r#""[^"]*"|'[^']*'|[^{JS_SPACE}]+"#))
}

/// `gh pr merge` flags followed by a value, so the value isn't read as the PR.
const MERGE_VALUE_FLAGS: [&str; 11] = [
    "-t",
    "--subject",
    "-b",
    "--body",
    "-F",
    "--body-file",
    "-A",
    "--author-email",
    "--match-head-commit",
    "-R",
    "--repo",
];

fn context_kind(message: &Value) -> Option<&str> {
    message.get("context")?.as_object()?.get("kind")?.as_str()
}

/// isNote: a line Milagre saved in the chat that isn't a reply.
fn is_note(message: &Value) -> bool {
    matches!(
        context_kind(message),
        Some(
            "git-action" | "worktree-linked" | "reload" | "checkpoint-restore" | "babysit-stopped"
        )
    )
}

/// createdPullRequestUrl: the URL `gh pr create` printed (alone on a line after the command).
fn created_pull_request_url(detail: &str) -> Option<String> {
    let lines: Vec<&str> = detail
        .split('\n')
        .map(js_trim)
        .filter(|line| !line.is_empty())
        .collect();
    let index = lines.iter().rposition(|line| pr_url().is_match(line))?;
    (index > 0).then(|| lines[index].to_string())
}

/// mergedRef: the PR a `gh pr merge` names (a URL, or a number with `--repo`), else nothing.
fn merged_ref(args: &str) -> Option<String> {
    let words: Vec<String> = words()
        .find_iter(args)
        .map(|word| {
            let mut word = word.as_str();
            if let Some(rest) = word.strip_prefix(['\'', '"']) {
                word = rest;
            }
            if let Some(rest) = word.strip_suffix(['\'', '"']) {
                word = rest;
            }
            word.to_string()
        })
        .collect();
    let mut repo_name: Option<&str> = None;
    let mut index = 0;
    while index < words.len() {
        let word = words[index].as_str();
        if word == "-R" || word == "--repo" {
            repo_name = words.get(index + 1).map(String::as_str);
        }
        if MERGE_VALUE_FLAGS.contains(&word) {
            index += 1;
        } else if word.starts_with('-') {
        } else if pr_url().is_match(word) {
            return Some(word.to_string());
        } else if !word.is_empty() && word.bytes().all(|b| b.is_ascii_digit()) {
            return Some(
                match repo_name.filter(|repo_name| repo().is_match(repo_name)) {
                    Some(repo_name) => format!("https://github.com/{repo_name}/pull/{word}"),
                    None => word.to_string(),
                },
            );
        } else {
            return None;
        }
        index += 1;
    }
    None
}

/// pullRequestRefs: the PRs a chat's commands created or merged, in the order they ran.
pub fn pull_request_refs(messages: &[MsgRef]) -> Vec<String> {
    let mut refs: Vec<String> = Vec::new();
    let mut add = |found: Option<String>| {
        if let Some(found) = found {
            if !refs.contains(&found) {
                refs.push(found);
            }
        }
    };
    for message in messages {
        // `flatMap(message => message.steps ?? [])`: a list is spread, anything else is one step.
        let steps: Vec<&Value> = match message.value().get("steps") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(steps)) => steps.iter().collect(),
            Some(other) => vec![other],
        };
        for step in steps {
            let Some(detail) = step.get("detail").and_then(Value::as_str) else {
                continue;
            };
            if step.get("kind").and_then(Value::as_str) != Some("shell")
                || step.get("status").and_then(Value::as_str) != Some("done")
                || !detail.starts_with("$ ")
            {
                continue;
            }
            if creates().is_match(detail) {
                add(created_pull_request_url(detail));
            }
            for found in merges().captures_iter(detail) {
                add(merged_ref(found.get(1).map_or("", |m| m.as_str())));
            }
        }
    }
    let created = refs.clone();
    refs.into_iter()
        .filter(|found| {
            !found.bytes().all(|b| b.is_ascii_digit())
                || !created
                    .iter()
                    .any(|other| other.ends_with(&format!("/pull/{found}")))
        })
        .collect()
}

/// summarizeChat: the summary of a Chat whose messages, in the Project's order, are `messages`.
pub fn summarize_chat(messages: &[MsgRef]) -> Map<String, Value> {
    let value = |message: &MsgRef| message.value().clone();
    let role = |message: &MsgRef| message.value().get("role").cloned();
    let input = messages.iter().find(|message| {
        role(message) != Some(Value::String("assistant".into()))
            && message
                .value()
                .get("body")
                .and_then(Value::as_str)
                .is_some_and(|body| !js_trim(body).is_empty())
    });
    let last_reply = messages.iter().rev().find(|message| {
        role(message) == Some(Value::String("assistant".into())) && !is_note(message.value())
    });
    let last_model = messages.iter().rev().find_map(|message| {
        let message = message.value();
        (message.get("role").and_then(Value::as_str) == Some("user")
            && jsjson::truthy(message.get("model")))
        .then(|| message["model"].clone())
    });
    let open_handoff = messages.iter().rev().find_map(|message| {
        let message = message.value();
        let context = message.get("context")?.as_object()?;
        (context.get("kind").and_then(Value::as_str) == Some("handoff")
            && context.get("status").and_then(Value::as_str) == Some("preparing"))
        .then(|| message.get("id").cloned())
    });
    let mut summary = Map::new();
    summary.insert("count".into(), Value::from(messages.len()));
    if let (Some(first), Some(last)) = (messages.first(), messages.last()) {
        // An id that is missing stays missing (Node's `undefined` isn't written).
        if let Some(id) = first.value().get("id") {
            summary.insert("firstId".into(), id.clone());
        }
        if let Some(id) = last.value().get("id") {
            summary.insert("lastId".into(), id.clone());
        }
    }
    if let Some(input) = input {
        let body = input.value()["body"].as_str().unwrap_or_default();
        let line = js_trim(body).split('\n').next().unwrap_or_default();
        summary.insert(
            "titleLine".into(),
            Value::String(slice16(line, 0, Some(200))),
        );
        let images = match input.value().get("images") {
            Some(Value::Array(images)) => images.len(),
            Some(Value::String(text)) => jsjson::utf16_len(text),
            _ => 0,
        };
        if images > 0 {
            summary.insert("titleImages".into(), Value::from(images));
        }
    }
    if let Some(outcome) = last_reply
        .map(value)
        .and_then(|reply| reply.get("outcome").cloned())
        .filter(|outcome| jsjson::truthy(Some(outcome)))
    {
        summary.insert("lastOutcome".into(), outcome);
    }
    let refs = pull_request_refs(messages);
    if !refs.is_empty() {
        summary.insert(
            "pullRequests".into(),
            Value::Array(refs.into_iter().map(Value::String).collect()),
        );
    }
    if let Some(model) = last_model {
        summary.insert("lastModel".into(), model);
    }
    if let Some(Some(id)) = open_handoff {
        summary.insert("openHandoff".into(), id);
    }
    let sent: Vec<Value> = messages
        .iter()
        .filter_map(|message| {
            let id = message.value().get("clientMessageId")?;
            jsjson::truthy(Some(id)).then(|| id.clone())
        })
        .collect();
    if !sent.is_empty() {
        summary.insert(
            "clientMessageIds".into(),
            Value::Array(sent[sent.len().saturating_sub(5)..].to_vec()),
        );
    }
    if let Some(card) = messages
        .first()
        .and_then(|first| first.value().get("context"))
    {
        if card.get("kind").and_then(Value::as_str) == Some("linear-issue") {
            if let Some(key) = card.get("key").and_then(Value::as_str) {
                summary.insert("linearIssue".into(), Value::String(key.into()));
                if let Some(workspace) = card
                    .get("workspace")
                    .and_then(Value::as_str)
                    .filter(|w| !w.is_empty())
                {
                    summary.insert("linearWorkspace".into(), Value::String(workspace.into()));
                }
            }
        }
    }
    summary
}

/// sameSummary: the same keys with strictly equal values (lists item by item).
fn same_summary(a: Option<&Value>, b: &Map<String, Value>) -> bool {
    let Some(Value::Object(a)) = a else {
        return false;
    };
    a.len() == b.len()
        && a.iter().all(|(key, value)| match (value, b.get(key)) {
            (Value::Array(x), Some(Value::Array(y))) => {
                x.len() == y.len() && x.iter().zip(y).all(|(x, y)| jsjson::strict_equals(x, y))
            }
            (x, Some(y)) => jsjson::strict_equals(x, y),
            (_, None) => false,
        })
}

fn same_message(a: &MsgRef, b: &MsgRef) -> bool {
    Arc::ptr_eq(a, b) || a.value() == b.value()
}

fn same_list(a: &[MsgRef], b: &[MsgRef]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same_message(a, b))
}

/// onlyLinkLines: `list` is `prior` plus `worktree-linked` lines (a Link reaching the Chat isn't activity).
fn only_link_lines(list: &[MsgRef], prior: &[MsgRef]) -> bool {
    list.len() > prior.len()
        && prior.iter().zip(list).all(|(a, b)| same_message(a, b))
        && list[prior.len()..]
            .iter()
            .all(|message| context_kind(message.value()) == Some("worktree-linked"))
}

fn chat_key(message: &MsgRef) -> String {
    jsjson::property_key(message.value().get("session_id"))
}

/// The Chats whose message list may differ between `previous` and `next`: those of the messages between the two
/// lists' common prefix and common suffix (compared by identity). A Chat with no message there has, in both, the same
/// messages (its prefix part, then its suffix part). One pointer walk, nothing kept.
fn touched_chats(previous: &[MsgRef], next: &[MsgRef]) -> HashSet<String> {
    let prefix = previous
        .iter()
        .zip(next)
        .take_while(|(a, b)| Arc::ptr_eq(a, b))
        .count();
    let room = previous.len().min(next.len()) - prefix;
    let suffix = previous
        .iter()
        .rev()
        .zip(next.iter().rev())
        .take(room)
        .take_while(|(a, b)| Arc::ptr_eq(a, b))
        .count();
    previous[prefix..previous.len() - suffix]
        .iter()
        .chain(&next[prefix..next.len() - suffix])
        .map(chat_key)
        .collect()
}

/// Messages by Chat (`String(message.session_id)`), in order, for the Chats `wanted` picks.
fn by_chat(messages: &[MsgRef], wanted: impl Fn(&str) -> bool) -> HashMap<String, Vec<MsgRef>> {
    let mut grouped: HashMap<String, Vec<MsgRef>> = HashMap::new();
    for message in messages {
        let key = chat_key(message);
        if wanted(&key) {
            grouped.entry(key).or_default().push(message.clone());
        }
    }
    grouped
}

/// withChatSummaries: `next` with the summary of every Chat whose messages changed since `previous` brought up to
/// date (every Chat without one, with no `previous`), `now` stamping activity.
pub fn with_chat_summaries(
    next: ProjectState,
    previous: Option<&ProjectState>,
    now: i64,
) -> ProjectState {
    let (Some(messages), Some(Value::Object(sessions))) =
        (next.messages.as_ref(), next.rest.get("sessions"))
    else {
        return next;
    };
    let previous_sessions = previous.and_then(|previous| previous.rest.get("sessions"));
    if let Some(previous) = previous {
        if next.same_messages(previous)
            && (Arc::ptr_eq(&next.rest, &previous.rest)
                || previous_sessions == next.rest.get("sessions"))
        {
            return next;
        }
    }
    let messages_kept = previous.is_some_and(|previous| previous.same_messages(&next));
    let unloaded: &BTreeSet<i64> = &next.unloaded;
    let is_unloaded = |id: &str| id.parse::<i64>().is_ok_and(|chat| unloaded.contains(&chat));
    // Which Chats can have changed (`None`: any, with no previous state to compare with).
    let touched: Option<HashSet<String>> =
        match previous.and_then(|previous| previous.messages.as_ref()) {
            Some(_) if messages_kept => Some(HashSet::new()),
            Some(before) => Some(touched_chats(before, messages)),
            None => None,
        };
    // A Chat's messages are needed if they may have changed or it has no summary yet (and it is loaded).
    let needs_list = |id: &str| {
        !is_unloaded(id)
            && (touched.as_ref().is_none_or(|touched| touched.contains(id))
                || !sessions
                    .get(id)
                    .and_then(|session| session.get("summary"))
                    .is_some_and(|summary| jsjson::truthy(Some(summary))))
    };
    let grouped = by_chat(messages, needs_list);
    let before = previous
        .filter(|_| !messages_kept)
        .and_then(|previous| previous.messages.as_ref())
        .map(|messages| {
            by_chat(messages, |id| {
                touched.as_ref().is_some_and(|touched| touched.contains(id))
            })
        });
    let empty: Vec<MsgRef> = Vec::new();
    let previous_summary = |id: &str| -> Option<Value> {
        previous_sessions?
            .get(id)?
            .get("summary")
            .filter(|s| !s.is_null())
            .cloned()
    };
    // Changed sessions, written into the state once at the end (one copy of its other keys if shared).
    let mut changed: Vec<(String, Value)> = Vec::new();
    for (id, session) in sessions {
        let Value::Object(fields) = session else {
            continue;
        };
        let current = fields
            .get("summary")
            .filter(|summary| jsjson::truthy(Some(summary)));
        if is_unloaded(id) {
            if current.is_none() {
                if let Some(kept) = previous_summary(id).filter(|kept| jsjson::truthy(Some(kept))) {
                    let mut fields = fields.clone();
                    fields.insert("summary".into(), kept);
                    changed.push((id.clone(), Value::Object(fields)));
                }
            }
            continue;
        }
        // Not touched: the same messages as before (by identity), so `sameList` holds.
        let untouched = touched
            .as_ref()
            .is_some_and(|touched| !touched.contains(id.as_str()));
        if current.is_some() && (messages_kept || untouched) {
            continue;
        }
        let list = grouped.get(id).unwrap_or(&empty);
        // An untouched Chat's messages before are the ones it has now.
        let prior = if untouched {
            Some(list)
        } else {
            before
                .as_ref()
                .map(|before| before.get(id).unwrap_or(&empty))
        };
        if current.is_some() && prior.is_some_and(|prior| same_list(list, prior)) {
            continue;
        }
        let mut summary = summarize_chat(list);
        let old = fields
            .get("summary")
            .filter(|summary| !summary.is_null())
            .cloned()
            .or_else(|| previous_summary(id));
        let quiet = prior.is_some_and(|prior| only_link_lines(list, prior));
        let field = |name: &str| -> Value {
            old.as_ref()
                .and_then(|old| old.get(name).cloned())
                .unwrap_or_else(jsjson::undefined)
        };
        let new = |name: &str| summary.get(name).cloned().unwrap_or_else(jsjson::undefined);
        let active = previous.is_some()
            && !quiet
            && if jsjson::truthy(old.as_ref()) {
                !jsjson::strict_equals(&field("count"), &new("count"))
                    || !jsjson::strict_equals(&field("lastId"), &new("lastId"))
                    || !jsjson::strict_equals(&field("lastOutcome"), &new("lastOutcome"))
            } else {
                !list.is_empty()
            };
        let stamp = active.then(|| Value::from(now));
        let last_at = stamp
            .clone()
            .or_else(|| old.as_ref().and_then(|old| old.get("lastAt").cloned()));
        if let Some(last_at) = last_at {
            summary.insert("lastAt".into(), last_at);
        }
        let first_at = if list.is_empty() {
            None
        } else if jsjson::truthy(old.as_ref().and_then(|old| old.get("count"))) {
            old.as_ref().and_then(|old| old.get("firstAt").cloned())
        } else {
            stamp
        };
        if let Some(first_at) = first_at {
            summary.insert("firstAt".into(), first_at);
        }
        if same_summary(fields.get("summary"), &summary) {
            continue;
        }
        let mut fields = fields.clone();
        fields.insert("summary".into(), Value::Object(summary));
        changed.push((id.clone(), Value::Object(fields)));
    }
    if changed.is_empty() {
        return next;
    }
    let mut next = next;
    if let Some(Value::Object(sessions)) = Arc::make_mut(&mut next.rest).get_mut("sessions") {
        for (id, session) in changed {
            sessions.insert(id, session);
        }
    }
    next
}
